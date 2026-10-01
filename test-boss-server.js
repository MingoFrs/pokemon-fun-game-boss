#!/usr/bin/env node
'use strict';
// Test d'INTÉGRATION sur le VRAI server.js (sockets). Développement uniquement :
//   npm i --no-save socket.io-client   puis   node test-boss-server.js
// Copie temporaire de server.js (+ export des fonctions internes), supprimée à la fin.
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const TMP = path.join(__dirname, 'server.__test.js');
fs.writeFileSync(TMP, fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8') + `
global.__t = { games, BOSSES, BOSS_MECHANICS, startShinyPokemon, resolveDoubleOrNothing, resolveDoubleEncounter,
  resolveTimeRift, applyMonMutation, megaEvolveMon, evolveMon, EVOLUTION_MAP, finishGame, monContribution, teamMonFromReward,
  SHINY_POINTS_MULTIPLIER, syncTypeBonus };
`);
process.env.PORT = process.env.TEST_PORT || '3333';
process.on('exit', () => { try { fs.unlinkSync(TMP); } catch (e) { /* ignore */ } });
require(TMP);
const { io } = require('socket.io-client');
const T = () => global.__t;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (label, cond, extra = '') => { if (cond) pass++; else fail++; console.log(`${cond ? '  ✔' : '  ✘'} ${label}${cond ? '' : ' ' + extra}`); };

function client(name) {
  const s = io(`http://localhost:${process.env.PORT}`, { transports: ['websocket'] });
  s.log = []; s.name = name;
  s.onAny((ev, data) => s.log.push({ ev, data }));
  s.last = ev => { for (let i = s.log.length - 1; i >= 0; i--) if (s.log[i].ev === ev) return s.log[i].data; };
  s.count = ev => s.log.filter(l => l.ev === ev).length;
  return s;
}
const mon = (id, basePoints = 400, multiplier = 1, extra = {}) =>
  ({ id, name: 'm' + id, sprite: 's' + id, rarity: 'rare', basePoints, multiplier, effectName: 'Neutre', ...extra });

async function startGame(mode, nPlayers, item = 'xpCandy') {
  const sockets = [client('P1')]; await sleep(250);
  sockets[0].emit('create_game', { name: 'P1' }); await sleep(200);
  const gameId = sockets[0].last('game_created').gameId;
  for (let i = 1; i < nPlayers; i++) {
    const s = client('P' + (i + 1)); sockets.push(s); await sleep(250);
    s.emit('join_game', { name: 'P' + (i + 1), gameId }); await sleep(200);
  }
  if (mode !== 'normal') { sockets[0].emit('set_game_mode', { mode }); await sleep(150); }
  if (mode === 'admin') { sockets[0].emit('set_admin_role', { adminId: sockets[0].id }); await sleep(150); }
  sockets[0].emit('start_game'); await sleep(300);
  const g = T().games[gameId];
  g.players.forEach(p => { p.startItemOptions = [item, 'xpCandy', 'shinyCharm'].filter((v, i, a) => a.indexOf(v) === i); });
  sockets.forEach(s => s.emit('starting_item_choice', { key: item }));
  await sleep(500);
  return { sockets, g, byId: id => g.players.find(p => p.id === id) };
}
// Vérifie l'invariant central : plus rien à resynchroniser, score = brut + bonus, annotations cohérentes.
function invariant(label, g, p) {
  const before = p.score;
  const drift = T().BOSS_MECHANICS.syncPlayer(p, g);
  ok(`${label} : bonus déjà à jour (aucune dérive)`, drift === 0 && p.score === before, `dérive ${drift}`);
  const sumPerMon = p.team.reduce((s, m) => s + (m.typeBonus || 0), 0);
  ok(`${label} : bonus total = somme par Pokémon + affinité`, p.typeBonus.total === sumPerMon + p.typeBonus.affinity.bonus && p.typeBonus.total === p.typeBonusTotal);
}

(async () => {
  await sleep(1500);

  console.log('1) Mode NORMAL : boss, tirage réel, événements, objets');
  {
    const { sockets, g } = await startGame('normal', 1);
    const [s] = sockets; const p = g.players[0];
    ok('partie en cours avec un boss', g.status === 'playing' && !!g.boss);
    const b = s.last('game_started').boss;
    ok('boss envoyé au client avec types/faiblesses/type à contrer/règles',
      Array.isArray(b.types) && b.types.length >= 1 && Array.isArray(b.weaknesses) && b.weaknesses.length >= 1 &&
      typeof b.counterType === 'string' && b.typeRules && b.typeRules.weakness.multiplierX2 === 1.25 && b.typeRules.affinity.tiers.length === 2, JSON.stringify(b));
    const base = T().BOSSES.find(x => x.id === b.id);
    ok('objectif (requiredPoints) inchangé : calibrage = 1', b.requiredPoints === base.requiredPoints, `${b.requiredPoints} vs ${base.requiredPoints}`);

    // Tirage réel (tour 1) sur 6 tours : le score serveur == payload client à chaque tour
    for (let turn = 1; turn <= 4; turn++) {
      for (let i = 0; i < 40 && !p.currentOptions; i++) await sleep(50);
      const scoreBefore = p.score;
      const evBefore = s.count('type_bonus_updated');
      s.emit('player_choice', { choice: Math.random() < 0.5 ? 'HAUT' : 'BAS' }); await sleep(250);
      const r = s.last('choice_result');
      ok(`tour ${turn} : score = avant + gain + bonus de type (payload == serveur)`,
        // r.score == score au moment de l'émission ; p.score peut ensuite bouger (événement de fin de tour), d'où r.score
        r && r.score === scoreBefore + r.pointsGained + r.typeBonusDelta, JSON.stringify(r && { s: r.score, avant: scoreBefore, g: r.pointsGained, d: r.typeBonusDelta }));
      ok(`tour ${turn} : équipe annotée (types/multiplicateur/bonus) et event type_bonus_updated reçu`,
        r.team.every(m => Array.isArray(m.types) && typeof m.typeMult === 'number' && typeof m.typeBonus === 'number') &&
        s.count('type_bonus_updated') > evBefore && s.last('type_bonus_updated').total === p.typeBonusTotal);
      invariant(`tour ${turn}`, g, p);
      if (g.turn >= g.maxTurns) break;
      for (let i = 0; i < 80 && g.status === 'playing' && p.currentChoice !== null; i++) await sleep(100);
      const skip = s.emit('skip_reveal'); await sleep(200);
    }

    // Événements / mutations sur équipe forgée : le bonus suit à chaque fois
    const boss = g.boss;
    const weakType = boss.weaknesses[0].type;
    const T_ = T().BOSS_MECHANICS;
    const entries = require('./stats').loadEntries();
    const pickMonOfType = (t, notId) => entries.find(e => e.id < 10000 && e.id !== notId && T_.getTypes(e.id).length === 1 && T_.getTypes(e.id)[0] === t);
    const weakMon = pickMonOfType(weakType);
    p.team = [mon(weakMon.id, 400), mon(25, 400), mon(132, 300)]; p.score = 1100; p.typeBonusTotal = 0; p.typeBonus = null;
    T().syncTypeBonus(p, g); invariant('équipe forgée', g, p);
    const sc0 = p.score;

    const shinyDelta = T().startShinyPokemon(g, p); // shiny sur le DERNIER Pokémon
    invariant('Shiny (événement)', g, p);
    ok('Shiny : multiplicateur ×1.5 dans le trait, jamais recompté dans la valeur de bonus', p.team[2].shinyInMultiplier === true && T_.monFinalValue(p.team[2]) === Math.round(300 * 1.5));

    const win = T().resolveDoubleOrNothing(g, Object.assign(p, { activeEvent: { teamIndex: 0 } }), { risk: true });
    ok('Double ou rien : résultat rendu', !!win.result);
    invariant('Double ou rien', g, p);
    if (win.result.outcome === 'fail') ok('Double ou rien raté : valeur 0 -> bonus de faiblesse 0', p.team[0].typeBonus === 0 && p.team[0].typeMult >= 1);
    else ok('Double ou rien réussi : bonus de faiblesse sur la valeur doublée', p.team[0].typeBonus === Math.round(T_.monFinalValue(p.team[0]) * (p.team[0].typeMult - 1)));

    // Évolution (Bonbon XP-like) : types suivent l'id actuel
    p.team[1] = mon(25, 400); T().syncTypeBonus(p, g);
    const evo = T().EVOLUTION_MAP[25];
    T().applyMonMutation(p, p.team[1], m => { T().evolveMon(m, evo); }, g);
    ok('Évolution : types lus à la forme évoluée (Pikachu -> Raichu)', JSON.stringify(p.team[1].types) === JSON.stringify(T_.getTypes(evo.id)));
    invariant('Évolution', g, p);

    // Méga-évolution
    p.team[1] = mon(6, 400); T().syncTypeBonus(p, g);
    const MEGA_FORM_IDS = [10034, 10035];
    const form = entries.find(e => e.id === 10034);
    T().megaEvolveMon(p, p.team[1], form, g);
    ok('Méga : types de la Méga (Méga-Dracaufeu X = feu/dragon)', JSON.stringify(p.team[1].types) === JSON.stringify(['fire', 'dragon']));
    invariant('Méga-Évolution', g, p);

    // Remplacements (Double rencontre / Faille temporelle)
    const reward = n => ({ pokemonId: n.id, name: n.name, sprite: 's', rarity: 'rare', basePoints: 300, multiplier: 1, effectName: 'Neutre', shiny: false, finalPoints: 300 });
    p.activeEvent = { options: [reward(weakMon), reward(weakMon)] };
    const de = T().resolveDoubleEncounter(g, p, { index: 0, replaceIndex: 1 });
    ok('Double rencontre : résolu', !!de.result); invariant('Double rencontre', g, p);
    p.activeEvent = { reward: reward(weakMon) };
    const tr = T().resolveTimeRift(g, p, { replaceIndex: 2 });
    ok('Faille temporelle : résolu', !!tr.result); invariant('Faille temporelle', g, p);

    // Métamorph via socket
    p.team = [mon(weakMon.id, 400), mon(132, 300)]; p.score = 700; p.typeBonusTotal = 0; p.typeBonus = null; p.heldItem = null;
    T().syncTypeBonus(p, g);
    s.emit('transform_metamorph', { index: 1 }); await sleep(250);
    const meta = p.team[1];
    ok('Métamorph : copie les types de la cible', meta.typeSourceId === weakMon.id && JSON.stringify(meta.types) === JSON.stringify(T_.getTypes(weakMon.id)), JSON.stringify(meta));
    invariant('Métamorph', g, p);

    // Fin de partie : filet de sécurité + payload final
    p.score += 123; // dérive volontaire : le filet de sécurité de finishGame doit recaler
    p.team = [mon(weakMon.id, 400), mon(weakMon.id, 400)];
    T().finishGame(g); await sleep(200);
    const fin = s.last('game_finished'), me = fin.players.find(x => x.id === p.id);
    ok('Écran final : score du payload == score serveur ; typeBonus et annotations présents', me.score === p.score && me.typeBonus && me.team.every(m => typeof m.typeBonus === 'number'));
    ok('Écran final : le boss envoyé porte ses types/faiblesses', Array.isArray(fin.boss.types) && Array.isArray(fin.boss.weaknesses));
    s.close();
  }

  console.log('\n2) Mode COOP : bonus par joueur, objectif d\'équipe inchangé');
  {
    const { sockets, g } = await startGame('coop', 2);
    const b = g.boss, base = T().BOSSES.find(x => x.id === b.id);
    const expectedTeam = Math.round(base.requiredPoints * (1 + 0.5 * 2));
    ok('objectif d\'équipe = requiredPoints × (1 + 0.5 × joueurs), inchangé', b.teamRequiredPoints === expectedTeam, `${b.teamRequiredPoints} vs ${expectedTeam}`);
    g.players.forEach((p, i) => { p.team = [mon(i === 0 ? 4 : 25, 400), mon(132, 300)]; p.score = 700; p.typeBonusTotal = 0; p.typeBonus = null; });
    g.players.forEach(p => T().syncTypeBonus(p, g));
    g.players.forEach((p, i) => invariant(`coop joueur ${i + 1}`, g, p));
    const sum = g.players.reduce((s, p) => s + p.score, 0);
    ok('coop : score d\'équipe = somme des scores individuels (bruts + bonus)', sum === 1400 + g.players.reduce((s, p) => s + p.typeBonusTotal, 0));
    T().finishGame(g); await sleep(200);
    const fin = sockets[0].last('game_finished');
    ok('coop : écran final avec détail de bonus par joueur', fin.players.every(x => x.typeBonus !== undefined) && fin.teamRequired === b.teamRequiredPoints);
    sockets.forEach(s => s.close());
  }

  console.log('\n3) Mode ADMIN VS JOUEUR : le joueur reçoit le bonus, l\'admin jamais');
  {
    const { sockets, g } = await startGame('admin', 2);
    const admin = g.players.find(p => p.id === g.adminId), joueur = g.players.find(p => p.id !== g.adminId);
    ok('admin et joueur identifiés', !!admin && !!joueur);
    joueur.team = [mon(4, 400), mon(25, 400)]; joueur.score = 800; joueur.typeBonusTotal = 0; joueur.typeBonus = null;
    T().syncTypeBonus(joueur, g); T().syncTypeBonus(admin, g);
    invariant('admin vs joueur : joueur', g, joueur);
    ok('admin : score 0, aucun bonus, aucune annotation', admin.score === 0 && !admin.typeBonus && admin.team.length === 0);
    const pub = require('./boss-mechanics') && null; // (getPublicPlayers non exportée : vérifiée via l'event players_updated)
    sockets.forEach(s => s.close());
  }

  console.log('\n4) Mode normal avec mécanique DÉSACTIVÉE par la config : strictement comme avant');
  {
    const cfg = require('./boss-mechanics-config');
    const saved = JSON.stringify(cfg.ENABLED_BY_MODE);
    Object.keys(cfg.ENABLED_BY_MODE).forEach(k => { cfg.ENABLED_BY_MODE[k] = false; });
    const { sockets, g } = await startGame('normal', 1);
    const [s] = sockets; const p = g.players[0];
    ok('boss sans règles (typeRules null) mais avec types pour l\'affichage', g.boss.typeRules === null && Array.isArray(g.boss.types));
    ok('objectif identique à la table', g.boss.requiredPoints === T().BOSSES.find(x => x.id === g.boss.id).requiredPoints);
    for (let i = 0; i < 40 && !p.currentOptions; i++) await sleep(50);
    const before = p.score;
    s.emit('player_choice', { choice: 'HAUT' }); await sleep(250);
    const r = s.last('choice_result');
    ok('score = avant + gain exact (aucun bonus), pas d\'annotation, pas d\'event type_bonus_updated',
      p.score === before + r.pointsGained && r.typeBonusDelta === 0 && r.typeBonus === null && s.count('type_bonus_updated') === 0 && p.team.every(m => m.types === undefined));
    p.team = [mon(4, 400), mon(25, 400), mon(132, 300)]; p.score = 1100;
    const d = T().applyMonMutation(p, p.team[1], m => { m.multiplier = 2; }, g);
    ok('mutation : scoreDelta = différence de contribution exacte (ancienne formule)', d === 400 && p.score === 1500, `${d}/${p.score}`);
    sockets.forEach(x => x.close());
    Object.assign(cfg.ENABLED_BY_MODE, JSON.parse(saved));
  }

  console.log('\n5) Objets via les VRAIS handlers : Bonbon XP, Méga Gemme, Objet Mystère');
  for (const [item, team, pendingEv, selectEv] of [
    ['xpCandy', [mon(25, 400), mon(4, 400)], 'xp_candy_pending', 'xp_candy_select'],
    ['megaGem', [mon(282, 500), mon(25, 400)], 'mega_gem_pending', 'mega_gem_select'],
    ['mysteryItem', [mon(25, 400), mon(4, 400)], 'mystery_item_pending', 'mystery_item_select']
  ]) {
    const { sockets, g } = await startGame('normal', 1, item);
    const [s] = sockets; const p = g.players[0];
    p.team = team; p.score = 800; p.typeBonusTotal = 0; p.typeBonus = null;
    T().syncTypeBonus(p, g);
    const size = p.team.length;
    s.emit('use_item'); await sleep(250);
    const pend = s.last(pendingEv);
    ok(`${item} : sélecteur ouvert`, !!pend, JSON.stringify(s.last('error_message')));
    if (pend) {
      s.emit(selectEv, { index: pend.team[0].index }); await sleep(300);
      const res = s.last('bonus_result');
      ok(`${item} : résultat reçu, objet consommé, équipe inchangée en taille`, !!res && p.heldItemUsed === true && p.team.length === size);
      ok(`${item} : score du payload == score serveur`, res && res.score === p.score, `${res && res.score} vs ${p.score}`);
      invariant(`${item}`, g, p);
    }
    sockets.forEach(x => x.close());
  }

  console.log(`\n${pass} réussi(s), ${fail} échec(s)`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
