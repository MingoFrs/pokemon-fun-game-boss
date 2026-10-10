'use strict';
// =====================================================================
// MODE "ROULETTE DE STATS" (gameMode === 'statdraft')
//
// Principe : 6 tirages. À chaque tirage, une roulette désigne UN Pokémon (le même pour tous).
// Chaque joueur choisit UNE des 6 stats de base de ce Pokémon : elle remplit la case
// correspondante (PV -> PV, Atq -> Atq, ...) de SA base stats. Une case remplie est définitive.
// Objectif : total des 6 cases >= objectif de la difficulté (500 / 550 / 625 / 700).
//
// Module isolé (même logique que fly-game.js) : état dans game.sd, événements "sd_*", aucun timer
// dans l'objet partie (WeakMap) => rien de non sérialisable. Jamais persisté (cf. persistGame).
// Clés de joueur = token (stable à la reconnexion), jamais socket.id.
// =====================================================================
const fs = require('fs');
const path = require('path');

const STAT_KEYS = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'];
const STAT_LABELS = { hp: 'PV', atk: 'Attaque', def: 'Défense', spa: 'Atq. Spé.', spd: 'Déf. Spé.', spe: 'Vitesse' };
const ROUNDS = STAT_KEYS.length;
const TARGETS = { easy: 500, medium: 550, hard: 625, extreme: 700 }; // cf. game.selectedDifficulty
const TYPES = ['normal', 'fire', 'water', 'electric', 'grass', 'ice', 'fighting', 'poison', 'ground',
  'flying', 'psychic', 'bug', 'rock', 'ghost', 'dragon', 'dark', 'steel', 'fairy'];

const TIMING = { spinMs: 5200, rerollSpinMs: 3000, pickMs: 30000, blitzMs: 10000, revealMs: 4500 };
const REROLLS = 2;          // modificateur "reroll"
const TYPE_MULT = 1.2;      // modificateur "typed"
const SHINY_MULT = 1.15;    // modificateur "shiny"
const SHINY_CHANCE = 0.2;
const FOG_HIDDEN = 3;       // modificateur "fog"
const WHEEL_SIZE = 12;
const JACKPOT_TOP_RATIO = 0.1; // modificateur "jackpot" : dernier tirage dans le top 10 % de BST
const CANDS_PER_ROUND = 1 + REROLLS;

const MODIFIERS = [
  { key: 'reroll', icon: '🔄', label: 'Relances', description: `${REROLLS} relances de roulette par partie : tu changes de Pokémon avant de valider (le suivant est le même pour tous ceux qui relancent).` },
  { key: 'joker', icon: '🃏', label: 'Joker', description: 'Une seule fois : place une stat dans une AUTRE case que la sienne (ex. la Vitesse d\'un Pokémon dans ta case PV).' },
  { key: 'typed', icon: '🎯', label: 'Cases typées', description: `Chaque case reçoit un type au hasard : ×${TYPE_MULT} si le Pokémon tiré a ce type. Découpe tes choix autour des bonus.` },
  { key: 'fog', icon: '🌫️', label: 'Brouillard', description: `${FOG_HIDDEN} stats sur 6 sont cachées à chaque tirage (« ? »). Tu peux quand même les choisir : quitte ou double.` },
  { key: 'blitz', icon: '⏱️', label: 'Éclair', description: `${TIMING.blitzMs / 1000} secondes pour choisir au lieu de ${TIMING.pickMs / 1000}. Sans choix : stat au hasard.` },
  { key: 'jackpot', icon: '💎', label: 'Jackpot final', description: 'Le 6e et dernier tirage est un Pokémon du top 10 % des stats totales : de quoi tout renverser.' },
  { key: 'shiny', icon: '✨', label: 'Chromatique', description: `20 % de chances qu'un Pokémon tiré soit chromatique : toutes ses stats ×${SHINY_MULT}.` },
  { key: 'team', icon: '🧬', label: 'Frankenstein', description: 'Une SEULE base stats pour toute l\'équipe : les joueurs choisissent à tour de rôle (2 joueurs minimum). Victoire commune.' }
];
const MODIFIER_KEYS = MODIFIERS.map(m => m.key);

// ---------------------------------------------------------------------
// Base stats par stat : lecture tolérante (le format exact de data/pokemon-stats.json peut varier).
// Une entrée n'est acceptée que si ses 6 valeurs sont plausibles ET (si le BST est connu) somment au BST.
// ---------------------------------------------------------------------
function statNum(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 1 && n <= 255 ? n : null;
}

function normalizeStats(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (Array.isArray(raw)) {
    if (raw.length === 6 && raw.every(v => typeof v === 'number')) {
      const o = {};
      STAT_KEYS.forEach((k, i) => { o[k] = statNum(raw[i]); });
      return STAT_KEYS.every(k => o[k] !== null) ? o : null;
    }
    const m = {};
    raw.forEach(s => { if (s && s.stat && s.stat.name) m[s.stat.name] = s.base_stat; }); // format PokéAPI brut
    raw = m;
  }
  const pick = (...keys) => {
    for (const k of keys) if (k && raw[k] != null) return statNum(raw[k]);
    return null;
  };
  const hasSpeed = raw.speed != null || raw.spe != null;
  const out = {
    hp: pick('hp', 'HP'),
    atk: pick('atk', 'attack', 'Attack'),
    def: pick('def', 'defense', 'Defense'),
    spa: pick('spa', 'spatk', 'spAtk', 'sp_atk', 'specialAttack', 'special_attack', 'special-attack', 'spAttack'),
    spd: pick('spdef', 'spDef', 'sp_def', 'specialDefense', 'special_defense', 'special-defense', 'spDefense', hasSpeed ? 'spd' : null),
    spe: pick('spe', 'speed', 'Speed')
  };
  return STAT_KEYS.every(k => out[k] !== null) ? out : null;
}

function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}

// Retourne Map(id -> {hp,atk,def,spa,spd,spe}) pour les ids demandés.
function loadStatsTable(pool, entries, dataDir) {
  const bstById = new Map(pool.map(p => [p.id, p.bst]));
  const wanted = new Set(pool.map(p => p.id));
  const accept = (id, raw, table) => {
    if (!wanted.has(id) || table.has(id)) return;
    const stats = normalizeStats(raw);
    if (!stats) return;
    const bst = bstById.get(id);
    const sum = STAT_KEYS.reduce((s, k) => s + stats[k], 0);
    if (Number.isFinite(bst) && sum !== bst) return;
    table.set(id, stats);
  };
  const table = new Map();

  // 1) champs déjà présents sur les entrées chargées par stats.js
  (entries || []).forEach(e => {
    if (!e) return;
    accept(e.id, e.stats || e.baseStats || e.base_stats || e.base || null, table);
  });

  // 2) fichiers JSON du dossier data/
  ['pokemon-stats.json', 'statdraft-stats.json'].forEach(name => {
    if (table.size >= wanted.size * 0.95) return;
    const json = readJsonSafe(path.join(dataDir, name));
    if (!json) return;
    let list = json;
    if (!Array.isArray(json)) {
      list = json.pokemon || json.entries || json.data || json.stats || json;
    }
    if (Array.isArray(list)) {
      list.forEach(item => {
        if (!item || typeof item !== 'object') return;
        const id = Number(item.id ?? item.dex ?? item.pokemonId ?? item.number);
        accept(id, item.stats || item.baseStats || item.base_stats || item, table);
      });
    } else if (list && typeof list === 'object') {
      Object.keys(list).forEach(key => {
        const item = list[key];
        const id = Number(key);
        if (!Number.isInteger(id) || !item || typeof item !== 'object') return;
        accept(id, item.stats || item.baseStats || item.base_stats || item, table);
      });
    }
  });
  return table;
}

// ---------------------------------------------------------------------
function randomInt(n) { return Math.floor(Math.random() * n); }
function sample(arr, n, excludeSet) {
  const src = excludeSet ? arr.filter(x => !excludeSet.has(x)) : arr.slice();
  const out = [];
  while (out.length < n && src.length) out.push(src.splice(randomInt(src.length), 1)[0]);
  return out;
}
const sumSlots = slots => STAT_KEYS.reduce((s, k) => s + (slots[k] ? slots[k].value : 0), 0);
const emptyPub = () => STAT_KEYS.reduce((o, k) => { o[k] = null; return o; }, {});

function createStatDraft({ io, app, games, supabase, createAuthClient, pool, entries, getTypes, spriteUrl, shinySpriteUrl, dataDir, xpParticipation, xpVictoryBonus, broadcastPlayers, log }) {
  const say = log || console;
  const timers = new WeakMap();

  // ---- données ----
  const basePool = (pool || []).filter(p => p && Number.isInteger(p.id) && p.id < 10000);
  const stats = loadStatsTable(basePool, entries || [], dataDir);
  const mons = basePool.filter(p => stats.has(p.id)).map(p => ({
    id: p.id, name: p.name, bst: STAT_KEYS.reduce((s, k) => s + stats.get(p.id)[k], 0)
  }));
  const ready = mons.length >= 100;
  const monById = new Map(mons.map(m => [m.id, m]));
  const jackpotMin = (() => {
    if (!mons.length) return Infinity;
    const sorted = mons.map(m => m.bst).sort((a, b) => b - a);
    return sorted[Math.max(0, Math.ceil(sorted.length * JACKPOT_TOP_RATIO) - 1)];
  })();
  const jackpotPool = mons.filter(m => m.bst >= jackpotMin);
  const typesOf = id => { try { return (getTypes && getTypes(id)) || []; } catch (e) { return []; } };

  if (!ready) {
    say.error(`[statdraft] ⚠ Base stats par statistique introuvables (${mons.length}/${basePool.length} Pokémon exploitables). Mode désactivé. `
      + 'Lance "node fetch-statdraft-stats.js" pour générer data/statdraft-stats.json.');
  } else {
    say.log(`[statdraft] ${mons.length} Pokémon dans la roulette, top 10 % = BST >= ${jackpotMin}.`);
    try {
      const sim = simulate();
      say.log('[statdraft] Calibrage (stratégie simple, sans modificateur) : moyenne ' + sim.avg.toFixed(0)
        + ' | ' + Object.keys(TARGETS).map(d => `${d} ${TARGETS[d]} : ${(sim.pass[d] * 100).toFixed(0)} %`).join(' | '));
    } catch (e) { /* log de calibrage : purement informatif */ }
  }

  // Simulation de calibrage : à chaque tirage, prend la stat la plus au-dessus de la moyenne de sa case.
  function simulate() {
    const mean = {};
    STAT_KEYS.forEach(k => { mean[k] = mons.reduce((s, m) => s + stats.get(m.id)[k], 0) / mons.length; });
    const N = 4000;
    let total = 0;
    const pass = {};
    Object.keys(TARGETS).forEach(d => { pass[d] = 0; });
    for (let g = 0; g < N; g++) {
      const left = new Set(STAT_KEYS);
      let sum = 0;
      for (let r = 0; r < ROUNDS; r++) {
        const st = stats.get(mons[randomInt(mons.length)].id);
        let best = null;
        left.forEach(k => { if (best === null || st[k] - mean[k] > st[best] - mean[best]) best = k; });
        left.delete(best);
        sum += st[best];
      }
      total += sum;
      Object.keys(TARGETS).forEach(d => { if (sum >= TARGETS[d]) pass[d]++; });
    }
    Object.keys(pass).forEach(d => { pass[d] /= N; });
    return { avg: total / N, pass };
  }

  // ---- timers ----
  function clearTimer(game) {
    const t = timers.get(game);
    if (t) clearTimeout(t);
    timers.delete(game);
  }
  function setTimer(game, ms, fn) {
    clearTimer(game);
    const sd = game.sd;
    const t = setTimeout(() => {
      timers.delete(game);
      if (games[game.id] !== game || game.sd !== sd || game.status !== 'playing') return; // timer périmé
      try { fn(); } catch (err) { say.error('[statdraft] timer', err); }
    }, ms);
    timers.set(game, t);
  }

  // ---- helpers d'état ----
  const hasMod = (sd, key) => sd.mods.includes(key);
  const isTeam = sd => hasMod(sd, 'team');
  const playerBySid = (game, sid) => game.players.find(p => p.sdSid === sid) || null;
  const buildKey = (sd, player) => (isTeam(sd) ? 'team' : player.sdSid);
  const buildOf = (game, player) => (game.sd && player ? game.sd.builds[buildKey(game.sd, player)] || null : null);
  const toPlayer = (player, event, payload) => { if (player && player.id) io.to(player.id).emit(event, payload); };

  function chooserSid(game) {
    const sd = game.sd;
    if (!isTeam(sd) || !sd.order.length) return null;
    return sd.order[(sd.round - 1) % sd.order.length];
  }
  // Propriétaires "actifs" ce tirage : en équipe seul le choisisseur du tour, sinon tous les joueurs.
  function activePlayers(game) {
    const sd = game.sd;
    if (isTeam(sd)) {
      const p = playerBySid(game, chooserSid(game));
      return p ? [p] : [];
    }
    return game.players.filter(p => sd.builds[p.sdSid]);
  }
  // Équipe : tout le salon voit la roulette/relance de l'unique build ; sinon, le joueur seul.
  function emitBuildEvent(game, player, event, payload) {
    if (isTeam(game.sd)) io.to(game.id).emit(event, payload);
    else toPlayer(player, event, payload);
  }

  function currentCand(sd, build) { return sd.cands[Math.min(build.candIdx, sd.cands.length - 1)]; }

  function placeValue(sd, cand, statKey, slotKey) {
    let v = stats.get(cand.id)[statKey];
    const bonuses = [];
    if (cand.shiny) { v *= SHINY_MULT; bonuses.push('shiny'); }
    if (sd.slotTypes && cand.types.includes(sd.slotTypes[slotKey])) { v *= TYPE_MULT; bonuses.push('type'); }
    return { value: Math.round(v), base: stats.get(cand.id)[statKey], bonuses };
  }

  function candView(sd, cand) {
    const st = stats.get(cand.id);
    const options = {};
    STAT_KEYS.forEach(k => {
      const hidden = sd.hidden.includes(k);
      const own = placeValue(sd, cand, k, k);
      const bySlot = {};
      STAT_KEYS.forEach(s => { bySlot[s] = hidden ? null : placeValue(sd, cand, k, s).value; });
      options[k] = {
        hidden,
        base: hidden ? null : st[k],
        final: hidden ? null : own.value,
        bonuses: own.bonuses,       // bonus de la case d'origine (type/chromatique), public (types connus)
        finalBySlot: hidden ? null : bySlot
      };
    });
    return { id: cand.id, name: cand.name, sprite: cand.shiny ? shinySpriteUrl(cand.id) : spriteUrl(cand.id), shiny: cand.shiny, types: cand.types, options };
  }

  function makeWheel(cand) {
    const winnerIndex = randomInt(WHEEL_SIZE);
    const decoys = sample(mons.filter(m => m.id !== cand.id), WHEEL_SIZE - 1);
    const items = [];
    let d = 0;
    for (let i = 0; i < WHEEL_SIZE; i++) {
      const m = i === winnerIndex ? cand : decoys[d++];
      items.push({ id: m.id, name: m.name, sprite: spriteUrl(m.id) });
    }
    return { items, winnerIndex };
  }

  function drawCands(game, round) {
    const sd = game.sd;
    const src = (hasMod(sd, 'jackpot') && round === ROUNDS) ? jackpotPool : mons;
    let picked = sample(src, CANDS_PER_ROUND, sd.used);
    if (picked.length < CANDS_PER_ROUND) picked = sample(src, CANDS_PER_ROUND); // pool épuisé (jamais en pratique)
    picked.forEach(m => sd.used.add(m.id));
    return picked.map(m => ({
      id: m.id, name: m.name, types: typesOf(m.id),
      shiny: hasMod(sd, 'shiny') && Math.random() < SHINY_CHANCE
    }));
  }

  // ---- vues publiques ----
  function publicPlayers(game) {
    return game.players.filter(p => p.sdSid).map(p => {
      const b = buildOf(game, p);
      return { sid: p.sdSid, name: p.name, avatar: p.avatar, disconnected: !!p.disconnected, locked: !!(b && b.locked) };
    });
  }
  function publicBuilds(game) {
    const sd = game.sd;
    return Object.keys(sd.builds).map(key => {
      const b = sd.builds[key];
      const owner = key === 'team' ? null : playerBySid(game, key);
      return {
        sid: key,
        name: key === 'team' ? 'Équipe' : (owner ? owner.name : '—'),
        avatar: owner ? owner.avatar : null,
        slots: b.pub,
        total: sumSlots(b.pub)
      };
    });
  }
  function configView(game) {
    const sd = game.sd;
    return {
      target: sd.target, difficulty: sd.difficulty, mods: sd.mods, ranked: sd.ranked, rounds: ROUNDS,
      slotTypes: sd.slotTypes, team: isTeam(sd), typeMult: TYPE_MULT, shinyMult: SHINY_MULT, rerolls: REROLLS
    };
  }
  function myView(game, player) {
    const b = buildOf(game, player);
    if (!b) return null;
    return { slots: b.slots, rerollsLeft: b.rerollsLeft, jokerAvailable: b.jokerAvailable, locked: b.locked };
  }
  const msLeft = sd => Math.max(0, sd.phaseEndsAt - Date.now());

  function roundPayload(game) {
    const sd = game.sd;
    return {
      round: sd.round, rounds: ROUNDS,
      wheel: sd.wheel,
      pokemon: candView(sd, sd.cands[0]),
      hidden: sd.hidden,
      spinMs: TIMING.spinMs,
      pickMs: sd.pickMs,
      chooserSid: chooserSid(game),
      players: publicPlayers(game)
    };
  }

  // ---- déroulement ----
  function startRound(game) {
    const sd = game.sd;
    sd.round += 1;
    sd.phase = 'spin';
    sd.cands = drawCands(game, sd.round);
    sd.hidden = hasMod(sd, 'fog') ? sample(STAT_KEYS, FOG_HIDDEN) : [];
    Object.keys(sd.builds).forEach(k => { sd.builds[k].locked = false; sd.builds[k].candIdx = 0; sd.builds[k].lastPick = null; });
    sd.wheel = makeWheel(sd.cands[0]);
    sd.phaseEndsAt = Date.now() + TIMING.spinMs;
    io.to(game.id).emit('sd_round', roundPayload(game));
    setTimer(game, TIMING.spinMs, () => beginChoosing(game));
  }

  function beginChoosing(game) {
    const sd = game.sd;
    sd.phase = 'choosing';
    sd.phaseEndsAt = Date.now() + sd.pickMs;
    io.to(game.id).emit('sd_choose', { pickMs: sd.pickMs });
    setTimer(game, sd.pickMs, () => resolveRound(game));
    maybeResolve(game); // tous les joueurs actifs déconnectés : inutile d'attendre
  }

  function maybeResolve(game) {
    const sd = game.sd;
    if (!sd || sd.phase !== 'choosing') return;
    const owners = activePlayers(game).filter(p => !p.disconnected);
    const pending = owners.filter(p => { const b = buildOf(game, p); return b && !b.locked; });
    if (pending.length === 0) resolveRound(game);
  }

  function autoPick(game, build) {
    const sd = game.sd;
    const empty = STAT_KEYS.filter(k => !build.slots[k]);
    if (!empty.length) return;
    const key = empty[randomInt(empty.length)];
    applyPick(sd, build, key, key, true);
  }

  function applyPick(sd, build, statKey, slotKey, auto) {
    const cand = currentCand(sd, build);
    const { value, base, bonuses } = placeValue(sd, cand, statKey, slotKey);
    const item = {
      stat: statKey, slot: slotKey, base, value, bonuses,
      cross: statKey !== slotKey,
      auto: !!auto,
      pokemon: { id: cand.id, name: cand.name, sprite: cand.shiny ? shinySpriteUrl(cand.id) : spriteUrl(cand.id), shiny: cand.shiny }
    };
    build.slots[slotKey] = item;
    build.locked = true;
    build.lastPick = item;
    return item;
  }

  function resolveRound(game) {
    const sd = game.sd;
    if (!sd || sd.phase === 'reveal' || sd.phase === 'final') return;
    clearTimer(game);
    Object.keys(sd.builds).forEach(k => {
      const b = sd.builds[k];
      if (!b.lastPick) autoPick(game, b);
    });
    sd.phase = 'reveal';
    const picks = Object.keys(sd.builds).map(key => {
      const b = sd.builds[key];
      b.pub = STAT_KEYS.reduce((o, k) => { o[k] = b.slots[k]; return o; }, {});
      return { sid: key, by: key === 'team' ? chooserSid(game) : key, ...b.lastPick };
    });
    const last = sd.round >= ROUNDS;
    sd.lastReveal = { round: sd.round, picks, builds: publicBuilds(game), revealMs: TIMING.revealMs, last };
    sd.phaseEndsAt = Date.now() + TIMING.revealMs;
    io.to(game.id).emit('sd_reveal', sd.lastReveal);
    setTimer(game, TIMING.revealMs, () => (last ? finish(game) : startRound(game)));
  }

  function finish(game) {
    const sd = game.sd;
    clearTimer(game);
    sd.phase = 'final';
    game.status = 'finished';
    const rows = Object.keys(sd.builds).map(key => {
      const b = sd.builds[key];
      const total = sumSlots(b.slots);
      return { key, total, slots: b.slots };
    });
    rows.sort((a, b) => b.total - a.total);
    let rank = 0;
    rows.forEach((r, i) => { if (i === 0 || r.total !== rows[i - 1].total) rank = i + 1; r.rank = rank; r.success = r.total >= sd.target; });

    const results = rows.map(r => {
      const owner = r.key === 'team' ? null : playerBySid(game, r.key);
      return {
        sid: r.key, name: r.key === 'team' ? 'Équipe' : (owner ? owner.name : '—'), avatar: owner ? owner.avatar : null,
        total: r.total, slots: r.slots, rank: r.rank, success: r.success
      };
    });
    const bestTotal = rows.length ? rows[0].total : 0;
    sd.final = {
      target: sd.target, difficulty: sd.difficulty, mods: sd.mods, team: isTeam(sd), ranked: sd.ranked,
      results,
      winners: results.filter(r => r.success).map(r => r.sid),
      best: results.filter(r => r.total === bestTotal).map(r => r.sid)
    };
    io.to(game.id).emit('sd_final', sd.final);

    // XP : uniquement parties SANS modificateur (même règle que le reste du jeu : modifiée = hors-classement).
    if (sd.ranked) {
      const success = r => (isTeam(sd) ? results[0].success : results.find(x => x.sid === r.sdSid)?.success);
      game.players.forEach(p => {
        const won = !!success(p);
        awardXp(p, xpParticipation + (won ? xpVictoryBonus : 0));
      });
    }
  }

  async function awardXp(player, amount) {
    if (!supabase || !createAuthClient || !player || !player.accountAccessToken) return;
    try {
      const { data: { user } } = await createAuthClient().auth.getUser(player.accountAccessToken);
      if (!user) return;
      const { data: profile } = await supabase.from('profiles').select('xp').eq('id', user.id).single();
      await supabase.from('profiles').update({ xp: (profile ? (profile.xp || 0) : 0) + amount }).eq('id', user.id);
    } catch (err) {
      say.error('[statdraft] échec XP', err.message);
    }
  }

  // ---- API serveur ----
  function ensureConfig(game) {
    if (!Array.isArray(game.sdMods)) game.sdMods = [];
    return game.sdMods;
  }

  function validateStart(game) {
    if (!ready) return 'Roulette de Stats indisponible : base stats par statistique introuvables (voir les logs serveur).';
    if (!game.players.length) return 'Aucun joueur.';
    const mods = ensureConfig(game);
    if (mods.includes('team') && game.players.length < 2) return 'Frankenstein nécessite au moins 2 joueurs.';
    if (!TARGETS[game.selectedDifficulty]) return 'Difficulté invalide.';
    return null;
  }

  function begin(game) {
    const mods = MODIFIER_KEYS.filter(k => ensureConfig(game).includes(k));
    const team = mods.includes('team');
    const sd = {
      mods,
      difficulty: game.selectedDifficulty,
      target: TARGETS[game.selectedDifficulty],
      ranked: mods.length === 0,
      pickMs: mods.includes('blitz') ? TIMING.blitzMs : TIMING.pickMs,
      slotTypes: null,
      round: 0, phase: 'idle',
      builds: {}, order: [], used: new Set(),
      cands: null, hidden: [], wheel: null, phaseEndsAt: 0,
      lastReveal: null, final: null
    };
    if (mods.includes('typed')) {
      const types = sample(TYPES, STAT_KEYS.length);
      sd.slotTypes = {};
      STAT_KEYS.forEach((k, i) => { sd.slotTypes[k] = types[i]; });
    }
    const newBuild = () => ({
      slots: emptyPub(), pub: emptyPub(), rerollsLeft: mods.includes('reroll') ? REROLLS : 0,
      jokerAvailable: mods.includes('joker'), locked: false, candIdx: 0, lastPick: null
    });
    game.players.forEach((p, i) => {
      p.sdSid = `p${i + 1}`;
      sd.order.push(p.sdSid);
      if (!team) sd.builds[p.sdSid] = newBuild();
    });
    if (team) sd.builds.team = newBuild();
    game.sd = sd;
    game.status = 'playing';

    game.players.forEach(p => {
      toPlayer(p, 'sd_started', { gameId: game.id, meSid: p.sdSid, hostId: game.hostId, config: configView(game), players: publicPlayers(game) });
    });
    startRound(game);
  }

  function snapshotFor(game, player) {
    const sd = game.sd;
    const b = buildOf(game, player);
    return {
      gameId: game.id, status: game.status, hostId: game.hostId,
      meSid: player.sdSid, config: configView(game),
      phase: sd.phase, round: sd.round, rounds: ROUNDS,
      players: publicPlayers(game), builds: publicBuilds(game),
      chooserSid: chooserSid(game),
      hidden: sd.hidden,
      pickMs: sd.pickMs,
      msLeft: msLeft(sd),
      wheel: sd.phase === 'spin' ? sd.wheel : null,
      pokemon: sd.cands && b && sd.phase !== 'final' ? candView(sd, currentCand(sd, b)) : null,
      me: myView(game, player),
      lastReveal: sd.phase === 'reveal' ? sd.lastReveal : null,
      final: sd.final
    };
  }

  // Reconnexion : renvoie tout l'état d'écran à CE joueur uniquement.
  function resync(game, socket, player) {
    if (!game.sd || game.status === 'waiting') return;
    socket.emit('sd_state', snapshotFor(game, player));
  }

  // Lobby : modificateurs/config visibles par tous (nouvel arrivant, changement de mode, rejouer).
  function syncLobby(game, socket) {
    const payload = { modifiers: ensureConfig(game) };
    if (socket) socket.emit('sd_modifiers_updated', payload);
    else io.to(game.id).emit('sd_modifiers_updated', payload);
  }

  function carry(oldGame, newGame) {
    newGame.sdMods = Array.isArray(oldGame.sdMods) ? [...oldGame.sdMods] : [];
  }

  function dispose(game) {
    clearTimer(game);
    game.sd = null;
  }

  // Présence (déconnexion/reconnexion) : remplace broadcastGameUpdated() pour ce mode.
  function broadcastPresence(game) {
    if (!game.sd || game.status === 'waiting') {
      if (game.status === 'waiting' && broadcastPlayers) broadcastPlayers(game);
      return;
    }
    io.to(game.id).emit('sd_players', { players: publicPlayers(game), chooserSid: chooserSid(game) });
    maybeResolve(game);
  }

  function onPlayerRemoved(game, leaving) {
    const sd = game.sd;
    if (!sd || sd.phase === 'final') return;
    if (leaving.sdSid) {
      if (!isTeam(sd)) delete sd.builds[leaving.sdSid];
      sd.order = sd.order.filter(sid => sid !== leaving.sdSid);
    }
    io.to(game.id).emit('sd_players', { players: publicPlayers(game), chooserSid: chooserSid(game) });
    if (sd.phase === 'choosing') maybeResolve(game);
  }

  // ---- sockets ----
  function attach(socket) {
    const ctx = () => {
      const game = games[socket.data.gameId];
      if (!game || game.gameMode !== 'statdraft') return {};
      const player = game.players.find(p => p.id === socket.id);
      return { game, player };
    };

    socket.on('sd_set_modifiers', ({ modifiers } = {}) => {
      const { game } = ctx();
      if (!game) return;
      if (game.hostId !== socket.id) { socket.emit('error_message', "Seul l'hôte peut choisir les modificateurs."); return; }
      if (game.status !== 'waiting') { socket.emit('error_message', 'Les modificateurs ne peuvent plus être modifiés.'); return; }
      if (!Array.isArray(modifiers) || modifiers.length > MODIFIER_KEYS.length || !modifiers.every(k => typeof k === 'string' && MODIFIER_KEYS.includes(k))) {
        socket.emit('error_message', 'Modificateur invalide.');
        return;
      }
      game.sdMods = MODIFIER_KEYS.filter(k => modifiers.includes(k));
      syncLobby(game);
    });

    socket.on('sd_pick', ({ stat, slot } = {}) => {
      const { game, player } = ctx();
      if (!game || !player || !game.sd || game.status !== 'playing') return;
      const sd = game.sd;
      if (sd.phase !== 'choosing') { socket.emit('error_message', "Attends la fin de la roulette."); return; }
      if (!STAT_KEYS.includes(stat)) { socket.emit('error_message', 'Stat invalide.'); return; }
      const target = slot === undefined || slot === null ? stat : slot;
      if (!STAT_KEYS.includes(target)) { socket.emit('error_message', 'Case invalide.'); return; }
      if (!activePlayers(game).includes(player)) { socket.emit('error_message', "Ce n'est pas ton tour de choisir."); return; }
      const build = buildOf(game, player);
      if (!build || build.locked) return;
      if (build.slots[target]) { socket.emit('error_message', 'Cette case est déjà remplie.'); return; }
      const cross = target !== stat;
      if (cross) {
        if (!hasMod(sd, 'joker') || !build.jokerAvailable) { socket.emit('error_message', 'Joker indisponible.'); return; }
        build.jokerAvailable = false;
      }
      const item = applyPick(sd, build, stat, target, false);
      toPlayer(player, 'sd_pick_ok', { item, me: myView(game, player) });
      io.to(game.id).emit('sd_players', { players: publicPlayers(game), chooserSid: chooserSid(game) });
      maybeResolve(game);
    });

    socket.on('sd_reroll', () => {
      const { game, player } = ctx();
      if (!game || !player || !game.sd || game.status !== 'playing') return;
      const sd = game.sd;
      if (sd.phase !== 'choosing' || !hasMod(sd, 'reroll')) return;
      if (!activePlayers(game).includes(player)) return;
      const build = buildOf(game, player);
      if (!build || build.locked || build.rerollsLeft <= 0 || build.candIdx >= sd.cands.length - 1) {
        socket.emit('error_message', 'Plus de relance disponible.');
        return;
      }
      build.rerollsLeft -= 1;
      build.candIdx += 1;
      const cand = currentCand(sd, build);
      emitBuildEvent(game, player, 'sd_reroll', {
        round: sd.round,
        wheel: makeWheel(cand),
        pokemon: candView(sd, cand),
        rerollsLeft: build.rerollsLeft,
        spinMs: TIMING.rerollSpinMs
      });
    });
  }
  io.on('connection', attach);

  // ---- route catalogue (lobby) ----
  if (app) {
    app.get('/api/statdraft/config', (req, res) => {
      res.set('Cache-Control', 'no-store');
      res.json({ ready, modifiers: MODIFIERS, targets: TARGETS, statKeys: STAT_KEYS, statLabels: STAT_LABELS, rounds: ROUNDS });
    });
  }

  return { ready, validateStart, begin, resync, syncLobby, carry, dispose, broadcastPresence, onPlayerRemoved, _internals: { normalizeStats, loadStatsTable, placeValue, STAT_KEYS, TARGETS } };
}

module.exports = { createStatDraft, normalizeStats, STAT_KEYS, TARGETS, MODIFIERS };
