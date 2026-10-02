#!/usr/bin/env node
'use strict';
// Tests du mode 'fly'.  node test-fly.js
// ÉTAPE 1 : agent (décisions, apprentissage, récompense, observation, config, non-régression boss).
// ÉTAPE 2 : persistance, snapshots, reset/restauration, admin (faux Supabase). À ajouter à l'étape 3 : plafond XP,
// abandon côté serveur, aucun accès client aux décisions, branchement server.js.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const cfg = require('./fly-config');
const bossConfig = require('./boss-mechanics-config');
const { createBossMechanics } = require('./boss-mechanics');
const { LinearPolicy, extractFeatures, outcomeFor, bestPossibleScore, computeReward, mulberry32, FEATURE_NAMES } = require('./fly-agent');
const { createEnv, RARITY_TABLE, EFFECTS, SHINY_CHANCE, SHINY_POINTS_MULTIPLIER } = require('./fly-env');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log(`  ✔ ${name}`); }
  catch (e) { fail++; console.log(`  ✘ ${name}\n      ${e.message}`); }
}
const opt = (basePoints, rarity = 'commun', shiny = false) => ({ basePoints, rarity, shiny });
const mkObs = (o = {}) => ({ turn: 1, ownScore: 0, oppScore: 0, options: [opt(400), opt(800, 'epique')], ...o });
// Trajectoire de TURNS décisions où la Mouche choisit toujours l'option la plus chère (index 1 si BAS plus chère).
function mkTraj(policy, pickIndex = 1) {
  return Array.from({ length: cfg.TURNS }, (_, i) => {
    const d = policy.evaluate(mkObs({ turn: i + 1 }));
    return { index: pickIndex, probs: d.probs, phis: d.phis, temperature: d.temperature };
  });
}
const withGames = (policy, n, baseline) => { const s = policy.getState(); s.games_played = n; s.baseline = baseline; policy.setState(s); return policy; };

console.log('A) Configuration');
test('Valeurs numériques valides', () => {
  ['TURNS', 'BASEPOINTS_SCALE', 'GAP_SCALE', 'SCORE_WEIGHT', 'LEARNING_RATE', 'BASELINE_RATE', 'ADVANTAGE_CLIP', 'MAX_STEP_NORM',
    'WEIGHT_DECAY', 'WEIGHT_CLAMP', 'TEMP_START', 'TEMP_FLOOR', 'TEMP_TAU_GAMES', 'SNAPSHOT_EVERY_GAMES', 'SNAPSHOT_KEEP',
    'CURVE_WINDOW_GAMES', 'XP_CAP_PER_24H', 'HESITATION_MS_MIN', 'HESITATION_MS_MAX'].forEach(k =>
    assert.ok(Number.isFinite(cfg[k]) && cfg[k] >= 0, `${k} invalide`));
  assert.ok(cfg.TEMP_FLOOR > 0 && cfg.TEMP_START >= cfg.TEMP_FLOOR);
  assert.ok(cfg.HESITATION_MS_MAX >= cfg.HESITATION_MS_MIN);
  assert.ok(cfg.RESULT_REWARD.win > cfg.RESULT_REWARD.draw && cfg.RESULT_REWARD.draw > cfg.RESULT_REWARD.loss);
});
test("Aucune clé 'fly' dans ENABLED_BY_MODE (mécaniques de boss inactives en fly)", () => {
  assert.ok(!('fly' in bossConfig.ENABLED_BY_MODE));
});
test('Constantes alignées sur server.js (TURNS, shiny, RARITY_TABLE, EFFECTS)', () => {
  const file = path.join(__dirname, 'server.js');
  if (!fs.existsSync(file)) return console.log('      (ignoré : server.js absent)');
  const src = fs.readFileSync(file, 'utf8');
  assert.strictEqual(Number(src.match(/const MAX_TURNS = (\d+)/)[1]), cfg.TURNS);
  assert.strictEqual(Number(src.match(/const SHINY_POINTS_MULTIPLIER = ([\d.]+)/)[1]), cfg.SHINY_POINTS_MULTIPLIER);
  assert.strictEqual(Number(src.match(/const SHINY_CHANCE = ([\d.]+)/)[1]), SHINY_CHANCE);
  assert.strictEqual(SHINY_POINTS_MULTIPLIER, cfg.SHINY_POINTS_MULTIPLIER);
  const eff = [...src.match(/const EFFECTS = \[([\s\S]*?)\];/)[1].matchAll(/name: '([^']+)', multiplier: ([\d.]+), weight: ([\d.]+)/g)]
    .map(m => ({ name: m[1], multiplier: Number(m[2]), weight: Number(m[3]) }));
  assert.deepStrictEqual(eff, EFFECTS);
  const table = src.match(/const RARITY_TABLE = \[([\s\S]*?)\];/)[1];
  const fixed = [...table.matchAll(/\{ rarity: '(\w+)', weight: ([\d.]+) \}/g)].map(m => ({ rarity: m[1], weight: Number(m[2]) }));
  assert.deepStrictEqual(fixed, RARITY_TABLE.slice(0, fixed.length));
  assert.ok(/\.\.\.LEGENDARY_GROUP\.map\(rarity => \(\{ rarity, weight: 0\.01 \}\)\)/.test(table));
  assert.deepStrictEqual(RARITY_TABLE.slice(fixed.length).map(r => r.weight), [0.01, 0.01, 0.01]);
  assert.ok(Math.abs(RARITY_TABLE.reduce((s, r) => s + r.weight, 0) - 1) < 1e-9);
  assert.deepStrictEqual(RARITY_TABLE.map(r => r.rarity), cfg.RARITIES);
});

console.log('\nB) Observation');
test('Features : whitelist stricte (finalPoints, multiplicateur, effet, choix adverse ignorés)', () => {
  const clean = mkObs();
  const dirty = mkObs();
  dirty.options = dirty.options.map((o, i) => ({ ...o, finalPoints: 99999 - i, multiplier: 1.3, effectName: 'Beauty privilege', pokemonId: 7 }));
  dirty.humanChoice = 0; dirty.boss = { id: 1 }; dirty.types = ['fire'];
  assert.deepStrictEqual(extractFeatures(dirty), extractFeatures(clean));
  const p = new LinearPolicy({ seed: 1 });
  assert.deepStrictEqual(p.evaluate(dirty).probs, p.evaluate(clean).probs);
});
test('Observation invalide -> erreur explicite', () => {
  assert.throws(() => extractFeatures(mkObs({ turn: 0 })));
  assert.throws(() => extractFeatures(mkObs({ turn: cfg.TURNS + 1 })));
  assert.throws(() => extractFeatures(mkObs({ options: [opt(1)] })));
  assert.throws(() => extractFeatures(mkObs({ options: [opt(1), opt(1, 'mega')] })), /rarity/);
  assert.throws(() => extractFeatures(mkObs({ ownScore: NaN })));
});
test('Shiny : points visibles × SHINY_POINTS_MULTIPLIER', () => {
  const [a, b] = extractFeatures(mkObs({ options: [opt(600), opt(600, 'commun', true)] }));
  assert.ok(Math.abs(b[0] / a[0] - cfg.SHINY_POINTS_MULTIPLIER) < 1e-9);
});

console.log('\nC) Décisions');
test('Déterministe avec seed', () => {
  const seq = seed => { const p = new LinearPolicy({ seed }); return Array.from({ length: 50 }, (_, i) => p.choose(mkObs({ turn: (i % 6) + 1 })).index).join(''); };
  assert.strictEqual(seq(42), seq(42));
  assert.notStrictEqual(seq(42), seq(43));
});
test('Probabilités valides, politique initiale uniforme', () => {
  const p = new LinearPolicy({ seed: 1 });
  const { probs } = p.evaluate(mkObs());
  assert.ok(Math.abs(probs[0] + probs[1] - 1) < 1e-12);
  assert.ok(Math.abs(probs[0] - 0.5) < 1e-12);
});
test('Température : T(0)=START, décroissante, plancher FLOOR', () => {
  const p = new LinearPolicy({ seed: 1 });
  assert.ok(Math.abs(p.temperature(0) - cfg.TEMP_START) < 1e-12);
  assert.ok(p.temperature(500) < p.temperature(100));
  assert.ok(p.temperature(1e9) >= cfg.TEMP_FLOOR && p.temperature(1e9) < cfg.TEMP_FLOOR + 1e-6);
});
test('Distribution empirique = probabilités (tirage, pas argmax)', () => {
  const p = new LinearPolicy({ seed: 7 });
  const s = p.getState(); s.weights[0] = 1; p.setState(s);
  const { probs } = p.evaluate(mkObs());
  let n1 = 0; const N = 20000;
  for (let i = 0; i < N; i++) n1 += p.choose(mkObs()).index;
  assert.ok(Math.abs(n1 / N - probs[1]) < 0.015, `${n1 / N} vs ${probs[1]}`);
});
test('Décision prise sans le choix humain : choose() ne lit que obs', () => {
  assert.strictEqual(LinearPolicy.prototype.choose.length, 1);
});

console.log('\nD) Récompense');
test('Résultat : victoire / défaite / nul', () => {
  assert.strictEqual(outcomeFor(10, 5), 'win'); assert.strictEqual(outcomeFor(5, 10), 'loss'); assert.strictEqual(outcomeFor(7, 7), 'draw');
});
test('Meilleur score possible = somme des max par tour', () => {
  assert.strictEqual(bestPossibleScore([[1, 5], [9, 2], [3, 3]]), 17);
});
test('Récompense = résultat + SCORE_WEIGHT × score/meilleur', () => {
  const w = computeReward({ flyScore: 800, humanScore: 500, bestPossible: 1000 });
  assert.strictEqual(w.result, 'win');
  assert.ok(Math.abs(w.reward - (cfg.RESULT_REWARD.win + cfg.SCORE_WEIGHT * 0.8)) < 1e-12);
  assert.ok(Math.abs(computeReward({ flyScore: 400, humanScore: 400, bestPossible: 800 }).reward - (cfg.RESULT_REWARD.draw + cfg.SCORE_WEIGHT * 0.5)) < 1e-12);
  assert.strictEqual(computeReward({ flyScore: 5, humanScore: 9, bestPossible: 0 }).ratio, 0);
  assert.strictEqual(computeReward({ flyScore: 2000, humanScore: 9, bestPossible: 1000 }).ratio, 1);
});
test('Anti-empoisonnement : à score égal, un humain nul ne rend pas la victoire plus rentable pour la qualité de jeu', () => {
  const good = computeReward({ flyScore: 900, humanScore: 100, bestPossible: 1000 }).reward;
  const bad = computeReward({ flyScore: 500, humanScore: 100, bestPossible: 1000 }).reward;
  assert.ok(good > bad); // même résultat (victoire) : le meilleur jeu reste mieux récompensé
});

console.log('\nE) Apprentissage');
test('Première partie : baseline initialisée, poids inchangés', () => {
  const p = new LinearPolicy({ seed: 1 });
  const r = p.learn(mkTraj(p), 1.3, { result: 'win' });
  assert.ok(r.learned);
  assert.deepStrictEqual(p.getState().weights, FEATURE_NAMES.map(() => 0));
  assert.strictEqual(p.getState().baseline, 1.3);
  assert.strictEqual(p.getState().games_played, 1);
  assert.strictEqual(p.getState().wins, 1);
});
test('Avantage positif : choisir la grosse option renforce bp (et rar)', () => {
  const p = withGames(new LinearPolicy({ seed: 1 }), 5, 0);
  p.learn(mkTraj(p, 1), 1.5, { result: 'win' });
  const w = p.getState().weights;
  assert.ok(w[0] > 0 && w[1] > 0, `bp=${w[0]} rar=${w[1]}`);
});
test('Avantage négatif : même choix puni -> bp diminue', () => {
  const p = withGames(new LinearPolicy({ seed: 1 }), 5, 0);
  p.learn(mkTraj(p, 1), -1.5, { result: 'loss' });
  assert.ok(p.getState().weights[0] < 0);
});
test('Choisir la petite option avec avantage positif -> bp diminue (symétrie)', () => {
  const p = withGames(new LinearPolicy({ seed: 1 }), 5, 0);
  p.learn(mkTraj(p, 0), 1.5, { result: 'win' });
  assert.ok(p.getState().weights[0] < 0);
});
test('Avantage nul (récompense = baseline) : poids ~ inchangés', () => {
  const p = withGames(new LinearPolicy({ seed: 1 }), 5, 0.7);
  p.learn(mkTraj(p, 1), 0.7);
  assert.ok(p.getState().weights.every(w => Math.abs(w) < 1e-12));
});
test('Mise à jour bornée : norme <= MAX_STEP_NORM, |poids| <= WEIGHT_CLAMP, avantage plafonné', () => {
  const p = withGames(new LinearPolicy({ seed: 1 }), 5, 0);
  const r = p.learn(mkTraj(p, 1), 1e6);
  assert.ok(r.stepNorm <= cfg.MAX_STEP_NORM + 1e-12);
  assert.ok(r.advantage <= cfg.ADVANTAGE_CLIP);
  const s = p.getState(); s.weights = s.weights.map(() => cfg.WEIGHT_CLAMP); p.setState(s);
  p.learn(mkTraj(p, 1), 10);
  assert.ok(p.getState().weights.every(w => Math.abs(w) <= cfg.WEIGHT_CLAMP));
});
test('Partie incomplète / mal formée : AUCUN apprentissage (poids, baseline, compteurs)', () => {
  const p = withGames(new LinearPolicy({ seed: 1 }), 5, 0.2);
  const before = JSON.stringify(p.getState());
  const t = mkTraj(p, 1);
  assert.deepStrictEqual(p.learn(t.slice(0, cfg.TURNS - 1), 1, { result: 'win' }), { learned: false, reason: 'incomplete' });
  assert.strictEqual(p.learn([], 1).reason, 'incomplete');
  assert.strictEqual(p.learn(null, 1).reason, 'malformed');
  assert.strictEqual(p.learn(t.map(d => ({ ...d, index: 2 })), 1).reason, 'malformed');
  assert.strictEqual(p.learn(t, NaN).reason, 'bad_reward');
  assert.strictEqual(JSON.stringify(p.getState()), before);
});
test('Compteurs victoires / défaites / nuls', () => {
  const p = new LinearPolicy({ seed: 1 });
  ['win', 'win', 'loss', 'draw'].forEach(r => p.learn(mkTraj(p), 0, { result: r }));
  const s = p.getState();
  assert.deepStrictEqual([s.games_played, s.wins, s.losses, s.draws], [4, 2, 1, 1]);
});
test('getState / setState : aller-retour exact ; état invalide rejeté', () => {
  const p = new LinearPolicy({ seed: 1 });
  for (let i = 0; i < 20; i++) p.learn(mkTraj(p, i % 2), (i % 3) - 1, { result: 'win' });
  const q = new LinearPolicy({ seed: 2, state: JSON.parse(JSON.stringify(p.getState())) });
  assert.deepStrictEqual(q.getState(), p.getState());
  assert.deepStrictEqual(q.evaluate(mkObs()).probs, p.evaluate(mkObs()).probs);
  const bad = x => assert.throws(() => new LinearPolicy({ state: x }), /invalide/);
  bad({ ...p.getState(), weights: [1, 2] });
  bad({ ...p.getState(), weights: p.getState().weights.map(() => NaN) });
  bad({ ...p.getState(), featureNames: p.getState().featureNames.slice().reverse() });
  bad({ ...p.getState(), games_played: -1 });
  bad({ ...p.getState(), kind: 'neural' });
  bad(null === undefined ? null : { kind: 'linear' });
});
test('getState retourne une copie (modification externe sans effet)', () => {
  const p = new LinearPolicy({ seed: 1 });
  p.getState().weights[0] = 99;
  assert.strictEqual(p.getState().weights[0], 0);
});
test('Convergence : 2500 parties contre aléatoire -> victoire > 85 %', () => {
  const envRng = mulberry32(5), humanRng = mulberry32(6);
  const env = createEnv({ rng: envRng, rarities: cfg.RARITIES, useReal: false });
  const p = new LinearPolicy({ seed: 3 });
  const play = learn => {
    let fly = 0, hum = 0; const traj = [], fin = [];
    for (let turn = 1; turn <= cfg.TURNS; turn++) {
      const o = env.drawOptions(); fin.push([o[0].finalPoints, o[1].finalPoints]);
      const d = p.choose({ turn, ownScore: fly, oppScore: hum, options: o.map(x => ({ basePoints: x.basePoints, rarity: x.rarity, shiny: x.shiny })) });
      traj.push(d); fly += o[d.index].finalPoints; hum += o[humanRng() < 0.5 ? 0 : 1].finalPoints;
    }
    const { reward, result } = computeReward({ flyScore: fly, humanScore: hum, bestPossible: bestPossibleScore(fin) });
    if (learn) p.learn(traj, reward, { result });
    return result;
  };
  for (let i = 0; i < 2500; i++) play(true);
  let w = 0; for (let i = 0; i < 1000; i++) w += play(false) === 'win';
  assert.ok(w / 1000 > 0.85, `victoire ${w / 1000}`);
});

console.log('\nF) Non-régression : mécaniques de boss inactives en mode fly');
{
  const chart = {};
  bossConfig.TYPE_ORDER.forEach(a => { chart[a] = {}; bossConfig.TYPE_ORDER.forEach(d => { chart[a][d] = 1; }); });
  chart.fire.grass = 2;
  const M = createBossMechanics({ typesById: { 1: ['fire'], 2: ['grass'] }, chart, shinyMultiplier: cfg.SHINY_POINTS_MULTIPLIER, poolIds: [1, 2] });
  const mkPlayer = () => ({ id: 'p', score: 1000, team: [{ id: 1, basePoints: 500, multiplier: 1, shiny: false }] });
  test("isEnabled('fly') = false", () => assert.strictEqual(M.isEnabled('fly'), false));
  test("syncPlayer : score et objets strictement inchangés, même avec un boss présent par erreur", () => {
    const p = mkPlayer(), snap = JSON.stringify(p);
    const g = { gameMode: 'fly', boss: { id: 2, types: ['grass'], counterType: 'fire' }, adminId: null, players: [p] };
    assert.strictEqual(M.syncPlayer(p, g), 0);
    assert.strictEqual(JSON.stringify(p), snap);
    assert.strictEqual(M.syncPlayer(p, { gameMode: 'fly', boss: null, players: [p] }), 0);
    assert.strictEqual(JSON.stringify(p), snap);
  });
  test('scaleFor : aucun calibrage de requiredPoints en fly', () => assert.strictEqual(M.scaleFor({ id: 2, difficulty: 'moyen' }, 'fly'), 1));
  test('Contrôle : la même situation en mode normal applique bien le bonus', () => {
    const p = mkPlayer();
    const g = { gameMode: 'normal', boss: { id: 2, types: ['grass'], counterType: 'fire' }, adminId: null, players: [p] };
    assert.ok(M.syncPlayer(p, g) > 0);
  });
}

console.log('\nG) Persistance, snapshots, reset, admin (faux Supabase, aucun réseau)');
const { createBrainStore } = require('./fly-brain-store');
const { registerFlyAdminRoutes } = require('./fly-admin-routes');
const { FakeSupabase, fakeApp, silentLogger } = require('./fly-test-utils');

const asyncTests = [];
const atest = (name, fn) => asyncTests.push({ name, fn });
const tcfg = { ...cfg, SNAPSHOT_EVERY_GAMES: 5, SNAPSHOT_KEEP: 3, SNAPSHOT_KEEP_SAFETY: 5, CURVE_WINDOW_GAMES: 10 };
const newStore = (db, c = tcfg) => createBrainStore({ supabase: db, config: c, logger: silentLogger, makePolicy: () => new LinearPolicy({ config: c, seed: 11 }) });
// Joue une partie complète synthétique via l'API du store (choix + récompense).
function playOne(store, result = 'win', { epoch } = {}) {
  const g = store.beginGame();
  const trajectory = [];
  for (let t = 1; t <= cfg.TURNS; t++) trajectory.push(store.choose(mkObs({ turn: t, ownScore: t * 100, oppScore: t * 90 })));
  return store.recordGame({ epoch: epoch === undefined ? g.epoch : epoch, trajectory, reward: result === 'win' ? 1.5 : result === 'loss' ? -0.5 : 0.4, result });
}
const cleanDb = () => new FakeSupabase();

atest('Démarrage sur base vide : ligne créée, cerveau vierge', async () => {
  const db = cleanDb(), s = newStore(db);
  assert.strictEqual(await s.load(), 'created');
  assert.strictEqual(db.tables.fly_brain.length, 1);
  assert.strictEqual(db.tables.fly_brain[0].games_played, 0);
});
atest('Sauvegarde après partie + rechargement identique (poids, baseline, compteurs, courbe)', async () => {
  const db = cleanDb(), s = newStore(db); await s.load();
  ['win', 'loss', 'draw', 'win', 'win', 'loss', 'win'].forEach(r => playOne(s, r));
  await s.flush();
  const row = db.tables.fly_brain[0];
  assert.strictEqual(row.games_played, 7);
  assert.deepStrictEqual([row.wins, row.losses, row.draws], [4, 2, 1]);
  assert.deepStrictEqual(row.recent_results, ['W', 'L', 'D', 'W', 'W', 'L', 'W']);
  const s2 = newStore(db); assert.strictEqual(await s2.load(), 'loaded');
  assert.deepStrictEqual(s2.policy.getState(), s.policy.getState());
  assert.deepStrictEqual(s2.policy.evaluate(mkObs()).probs, s.policy.evaluate(mkObs()).probs);
  assert.deepStrictEqual(s2.recent, s.recent);
});
atest('Une partie ne déclenche qu\'une écriture coalescée (50 parties synchrones)', async () => {
  const db = cleanDb(), s = newStore(db, { ...tcfg, SNAPSHOT_EVERY_GAMES: 1000 }); await s.load();
  const before = db.writes.fly_brain;
  for (let i = 0; i < 50; i++) playOne(s, 'win');
  await s.flush();
  assert.ok(db.writes.fly_brain - before <= 2, `écritures : ${db.writes.fly_brain - before}`);
  assert.strictEqual(db.tables.fly_brain[0].games_played, 50);
});
atest('Snapshots tous les N parties, seuls les SNAPSHOT_KEEP derniers sont conservés', async () => {
  const db = cleanDb(), s = newStore(db); await s.load();
  for (let i = 0; i < 12; i++) playOne(s, 'win');
  await s.flush();
  assert.deepStrictEqual(db.tables.fly_brain_snapshots.map(r => r.games_played), [5, 10]);
  for (let i = 0; i < 13; i++) playOne(s, 'loss');
  await s.flush();
  assert.deepStrictEqual(db.tables.fly_brain_snapshots.map(r => r.games_played).sort((a, b) => a - b), [15, 20, 25]);
  assert.ok(db.tables.fly_brain_snapshots.every(r => r.reason === 'periodic'));
});
atest('Abandon / partie incomplète : aucun apprentissage, aucune écriture', async () => {
  const db = cleanDb(), s = newStore(db); await s.load();
  const w0 = db.writes.fly_brain, st0 = JSON.stringify(s.policy.getState());
  // L'abandon = le serveur n'appelle PAS recordGame. Et si on l'appelait avec une trajectoire partielle :
  const g = s.beginGame();
  const partial = [s.choose(mkObs({ turn: 1 })), s.choose(mkObs({ turn: 2 }))];
  assert.strictEqual(s.recordGame({ epoch: g.epoch, trajectory: partial, reward: 1, result: 'win' }).reason, 'incomplete');
  await s.flush();
  assert.strictEqual(JSON.stringify(s.policy.getState()), st0);
  assert.strictEqual(db.writes.fly_brain, w0);
  assert.deepStrictEqual(s.recent, []);
});
atest('Parties simultanées : un seul cerveau partagé', async () => {
  const db = cleanDb(), s = newStore(db); await s.load();
  const g1 = s.beginGame(), g2 = s.beginGame(), t1 = [], t2 = [];
  for (let t = 1; t <= cfg.TURNS; t++) { t1.push(s.choose(mkObs({ turn: t }))); t2.push(s.choose(mkObs({ turn: t }))); }
  assert.ok(s.recordGame({ epoch: g1.epoch, trajectory: t1, reward: 1, result: 'win' }).learned);
  assert.ok(s.recordGame({ epoch: g2.epoch, trajectory: t2, reward: -1, result: 'loss' }).learned);
  assert.strictEqual(s.policy.getState().games_played, 2);
});
atest('Reset : snapshot de sécurité, cerveau vierge en mémoire ET en base, parties en cours ignorées', async () => {
  const db = cleanDb(), s = newStore(db); await s.load();
  for (let i = 0; i < 7; i++) playOne(s, 'win');
  await s.flush();
  const inFlight = s.beginGame(), traj = Array.from({ length: cfg.TURNS }, (_, i) => s.choose(mkObs({ turn: i + 1 })));
  const r = await s.reset();
  await s.flush();
  assert.ok(r.ok); assert.strictEqual(r.previousGames, 7);
  assert.strictEqual(s.policy.getState().games_played, 0);
  assert.ok(s.policy.getState().weights.every(w => w === 0));
  assert.strictEqual(db.tables.fly_brain[0].games_played, 0);
  assert.deepStrictEqual(db.tables.fly_brain[0].recent_results, []);
  const safety = db.tables.fly_brain_snapshots.filter(x => x.reason === 'pre_reset');
  assert.strictEqual(safety.length, 1); assert.strictEqual(safety[0].games_played, 7);
  assert.strictEqual(s.recordGame({ epoch: inFlight.epoch, trajectory: traj, reward: 1, result: 'win' }).reason, 'stale_epoch');
  assert.strictEqual(s.policy.getState().games_played, 0);
  assert.ok(playOne(s, 'win').learned);                         // une nouvelle partie apprend normalement
});
atest('Restauration : état exact du snapshot, sauvegarde de sécurité, id inconnu, état invalide refusé', async () => {
  const db = cleanDb(), s = newStore(db); await s.load();
  for (let i = 0; i < 5; i++) playOne(s, i % 2 ? 'loss' : 'win');
  await s.flush();
  const snap = db.tables.fly_brain_snapshots.find(x => x.games_played === 5);
  const at5 = s.policy.getState();
  for (let i = 0; i < 4; i++) playOne(s, 'win');
  await s.flush();
  const r = await s.restoreSnapshot(snap.id);
  await s.flush();
  assert.ok(r.ok); assert.strictEqual(r.restoredGames, 5);
  assert.deepStrictEqual(s.policy.getState(), at5);
  assert.strictEqual(db.tables.fly_brain[0].games_played, 5);
  assert.ok(db.tables.fly_brain_snapshots.some(x => x.reason === 'pre_restore' && x.games_played === 9));
  assert.strictEqual((await s.restoreSnapshot(99999)).reason, 'not_found');
  db.tables.fly_brain_snapshots.find(x => x.id === snap.id).weights.weights = [1, 2];
  const keep = JSON.stringify(s.policy.getState());
  await assert.rejects(() => s.restoreSnapshot(snap.id), /invalide/);
  assert.strictEqual(JSON.stringify(s.policy.getState()), keep);
});
atest('Snapshots de sécurité : SNAPSHOT_KEEP_SAFETY conservés, périodiques intacts', async () => {
  const db = cleanDb(), s = newStore(db); await s.load();
  for (let i = 0; i < 5; i++) playOne(s, 'win');
  for (let i = 0; i < 8; i++) { await s.reset(); playOne(s, 'win'); }
  await s.flush();
  const safety = db.tables.fly_brain_snapshots.filter(x => x.reason !== 'periodic');
  assert.strictEqual(safety.length, tcfg.SNAPSHOT_KEEP_SAFETY);
  assert.ok(db.tables.fly_brain_snapshots.some(x => x.reason === 'periodic' && x.games_played === 5));
});
atest('Panne DB : l\'apprentissage continue en mémoire, la sauvegarde suivante rattrape tout', async () => {
  const db = cleanDb(), s = newStore(db); await s.load();
  playOne(s, 'win'); await s.flush();
  db.failing.add('fly_brain:update');
  playOne(s, 'loss'); await s.flush();
  assert.strictEqual(s.policy.getState().games_played, 2);
  assert.strictEqual(db.tables.fly_brain[0].games_played, 1);
  db.failing.clear();
  playOne(s, 'win'); await s.flush();
  assert.strictEqual(db.tables.fly_brain[0].games_played, 3);
});
atest('Garde anti-régression : un cerveau en base plus avancé n\'est jamais écrasé (reset = écriture forcée)', async () => {
  const db = cleanDb(), s = newStore(db); await s.load();
  db.tables.fly_brain[0].games_played = 999;
  playOne(s, 'win'); await s.flush();
  assert.strictEqual(db.tables.fly_brain[0].games_played, 999);
  assert.strictEqual(s.conflicts, 1);
  await s.reset(); await s.flush();
  assert.strictEqual(db.tables.fly_brain[0].games_played, 0);
});
atest('Ligne invalide / lecture impossible : sauvegarde désactivée, ligne jamais écrasée', async () => {
  const db = cleanDb(); db.tables.fly_brain.push({ id: 1, weights: { kind: 'linear', weights: [1] }, games_played: 3, wins: 1, losses: 1, draws: 1, recent_results: [] });
  const s = newStore(db); assert.strictEqual(await s.load(), 'invalid');
  const snap = JSON.stringify(db.tables.fly_brain[0]);
  playOne(s, 'win'); await s.flush();
  assert.strictEqual(JSON.stringify(db.tables.fly_brain[0]), snap);
  const db2 = cleanDb(); db2.failing.add('fly_brain:select');
  assert.strictEqual(await newStore(db2).load(), 'db_error');
});
atest('Mémoire seule (pas de Supabase) : fonctionne sans erreur', async () => {
  const s = createBrainStore({ supabase: null, config: tcfg, logger: silentLogger });
  assert.strictEqual(await s.load(), 'memory_only');
  assert.ok(playOne(s, 'win').learned);
  assert.ok((await s.reset()).ok);
  await s.flush();
});
atest('Stats publiques : aucun poids / baseline / features ; courbe plafonnée', async () => {
  const db = cleanDb(), s = newStore(db); await s.load();
  for (let i = 0; i < 25; i++) playOne(s, i % 3 === 0 ? 'loss' : 'win');
  const st = s.getPublicStats();
  assert.deepStrictEqual(Object.keys(st).sort(), ['draws', 'flyWins', 'gamesPlayed', 'generation', 'humanityWins', 'name', 'recent', 'winRate']);
  assert.strictEqual(st.recent.length, tcfg.CURVE_WINDOW_GAMES);
  assert.strictEqual(st.gamesPlayed, 25); assert.strictEqual(st.flyWins + st.humanityWins + st.draws, 25);
  assert.ok(Math.abs(st.winRate - st.flyWins / 25) < 1e-12);
  assert.strictEqual(st.generation, 1 + Math.floor(25 / tcfg.GENERATION_EVERY_GAMES));
  assert.ok(!/weights|baseline|phis|probs/.test(JSON.stringify(st)));
  assert.strictEqual(createBrainStore({ config: tcfg, logger: silentLogger }).getPublicStats().winRate, null);
});

const KEY = 'cle-admin-de-test-0123456789';
const H = (k = KEY) => ({ 'x-fly-admin-key': k });
atest('Admin : clé absente ou trop courte -> routes désactivées (404)', async () => {
  for (const key of [undefined, 'court']) {
    const app = fakeApp(), s = newStore(cleanDb());
    assert.strictEqual(registerFlyAdminRoutes(app, { store: s, config: tcfg, adminKey: key, logger: silentLogger }).enabled, false);
    assert.strictEqual((await app.call('POST', '/api/fly/admin/reset', { headers: H(key || ''), body: { confirm: 'RESET' } })).code, 404);
  }
});
atest('Admin : authentification, confirmations, reset et restauration', async () => {
  const db = cleanDb(), s = newStore(db); await s.load();
  for (let i = 0; i < 6; i++) playOne(s, 'win');
  await s.flush();
  const app = fakeApp(); registerFlyAdminRoutes(app, { store: s, config: tcfg, adminKey: KEY, logger: silentLogger });
  assert.strictEqual((await app.call('POST', '/api/fly/admin/reset', { body: { confirm: 'RESET' } })).code, 401);
  assert.strictEqual((await app.call('POST', '/api/fly/admin/reset', { headers: H('mauvaise'), body: { confirm: 'RESET' } })).code, 401);
  assert.strictEqual(s.policy.getState().games_played, 6);
  assert.strictEqual((await app.call('POST', '/api/fly/admin/reset', { headers: H(), body: {} })).code, 400);
  const list = await app.call('GET', '/api/fly/admin/snapshots', { headers: H() });
  assert.strictEqual(list.code, 200); assert.ok(list.body.snapshots.some(x => x.games_played === 5));
  const id = list.body.snapshots.find(x => x.games_played === 5).id;
  assert.strictEqual((await app.call('POST', '/api/fly/admin/restore', { headers: H(), body: { id: '5', confirm: 'RESTORE' } })).code, 400);
  assert.strictEqual((await app.call('POST', '/api/fly/admin/restore', { headers: H(), body: { id: 424242, confirm: 'RESTORE' } })).code, 404);
  const rs = await app.call('POST', '/api/fly/admin/restore', { headers: H(), body: { id, confirm: 'RESTORE' } });
  assert.strictEqual(rs.code, 200); assert.strictEqual(s.policy.getState().games_played, 5);
  const rr = await app.call('POST', '/api/fly/admin/reset', { headers: H(), body: { confirm: 'RESET' } });
  assert.strictEqual(rr.code, 200); assert.strictEqual(s.policy.getState().games_played, 0);
});
atest('Admin : limiteur d\'échecs par IP (429), levé après la fenêtre, autres IP non affectées', async () => {
  let t = 1000; const s = newStore(cleanDb()); await s.load();
  const app = fakeApp(); registerFlyAdminRoutes(app, { store: s, config: tcfg, adminKey: KEY, logger: silentLogger, now: () => t });
  for (let i = 0; i < tcfg.ADMIN_MAX_FAILS; i++) assert.strictEqual((await app.call('GET', '/api/fly/admin/snapshots', { headers: H('x'), ip: '9.9.9.9' })).code, 401);
  assert.strictEqual((await app.call('GET', '/api/fly/admin/snapshots', { headers: H(), ip: '9.9.9.9' })).code, 429);
  assert.strictEqual((await app.call('GET', '/api/fly/admin/snapshots', { headers: H(), ip: '8.8.8.8' })).code, 200);
  t += tcfg.ADMIN_FAIL_WINDOW_MS + 1;
  assert.strictEqual((await app.call('GET', '/api/fly/admin/snapshots', { headers: H(), ip: '9.9.9.9' })).code, 200);
});

console.log('\nH) Déroulement d\'une partie fly (fake io / timers, aucun réseau)');
const { createFlyGame, HUMAN_RESULT } = require('./fly-game');
const { createFlyXp } = require('./fly-xp');

function harness({ storeCfg = tcfg, optionsFn, recordFlyResult = null } = {}) {
  const emits = [], timers = [];
  const io = { to: room => ({ emit: (event, payload) => emits.push({ room, event, payload: JSON.parse(JSON.stringify(payload === undefined ? null : payload)) }) }) };
  const fakeTimers = {
    set: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
    clear: t => { if (t) t.cleared = true; }
  };
  const db = cleanDb(), store = newStore(db, storeCfg);
  const env = createEnv({ rng: mulberry32(99), rarities: cfg.RARITIES, useReal: false });
  const mk = o => ({ ...o, name: `P${o.pokemonId}`, sprite: `s${o.pokemonId}.png`, shinySprite: o.shiny ? `sh${o.pokemonId}.png` : null, effectName: o.effectName });
  const state = { transitionReady: false, transitions: 0 };
  const deps = {
    pickPlayerTurnOptions: (...args) => { state.lastPickArgs = args; if (optionsFn) return optionsFn(); const [h, b] = env.drawOptions(); return { haut: mk(h), bas: mk(b) }; },
    teamMonFromReward: r => ({ id: r.pokemonId, name: r.name, rarity: r.rarity, basePoints: r.basePoints }),
    buildRoute: () => Array.from({ length: cfg.TURNS }, (_, i) => ({ turn: i + 1, status: i === 0 ? 'current' : 'upcoming' })),
    getPublicPlayers: g => g.players.map(p => ({ id: p.id, name: p.name, score: p.score, team: p.team })),
    maybeScheduleTurnTransition: g => { if (g.fly && g.fly.revealed && g.players[0].currentChoice !== null) { state.transitionReady = true; state.transitions++; } }
  };
  const xpCalls = [];
  const FLY = createFlyGame({ io, store, deps, timers: fakeTimers, random: mulberry32(5), logger: silentLogger, config: storeCfg,
    recordFlyResult: recordFlyResult || (async (p, d) => { xpCalls.push(d); }) });
  const human = { id: 'sock1', name: 'Humain', avatar: null, score: 0, team: [], currentChoice: null, currentOptions: null };
  const game = { id: 'ABCD', gameMode: 'fly', status: 'playing', turn: 0, maxTurns: cfg.TURNS, players: [human], boss: null, route: null };
  // Imite player_choice + finalizePlayerTurn + resolveTurnTransition de server.js.
  const humanPlay = choice => {
    const r = human.currentOptions[choice === 'HAUT' ? 'haut' : 'bas'];
    human.currentChoice = choice; human.score += r.finalPoints; human.team.push({ id: r.pokemonId });
    FLY.onHumanChose(game);
    state.transitionReady = false;
  };
  const fireReveal = () => { const t = timers.filter(x => !x.cleared).pop(); t.cleared = true; t.fn(); };
  const nextTurn = () => {
    if (game.turn >= game.maxTurns) { game.status = 'finished'; FLY.finish(game); return; }
    game.turn += 1; human.currentChoice = null; human.currentOptions = null; FLY.startTurn(game);
  };
  const playTurn = choice => { humanPlay(choice); fireReveal(); nextTurn(); };
  const finishedPayload = () => (emits.find(e => e.event === 'game_finished') || {}).payload;
  return { emits, timers, store, db, FLY, game, human, state, xpCalls, humanPlay, fireReveal, nextTurn, playTurn, finishedPayload };
}

atest('Partie complète : 6 tours, résultat cohérent, cerveau entraîné une fois, XP demandée une fois', async () => {
  const h = harness(); h.FLY.begin(h.game);
  for (let t = 1; t <= cfg.TURNS; t++) h.playTurn(t % 2 ? 'HAUT' : 'BAS');
  const fin = h.finishedPayload();
  assert.ok(fin && fin.gameMode === 'fly' && fin.boss === null && fin.fly.turns.length === cfg.TURNS);
  assert.strictEqual(fin.fly.score, fin.fly.turns.reduce((s, x) => s + x.pointsGained, 0));
  assert.strictEqual(fin.players[0].score, h.human.score);
  const expected = fin.fly.score > h.human.score ? 'win' : fin.fly.score < h.human.score ? 'loss' : 'draw';
  assert.strictEqual(fin.fly.result, expected);
  assert.strictEqual(fin.players[0].result, HUMAN_RESULT[expected]);
  assert.strictEqual(fin.fly.learned, true);
  assert.strictEqual(h.store.policy.getState().games_played, 1);
  assert.strictEqual(h.xpCalls.length, 1);
  assert.strictEqual(h.xpCalls[0].result, HUMAN_RESULT[expected]);
  assert.strictEqual(fin.fly.stats.gamesPlayed, 1);
});
atest('Tirage : table du mode normal sans pity/Charme/plancher, même tirage pour les deux', async () => {
  const h = harness(); h.FLY.begin(h.game);
  assert.deepStrictEqual(h.state.lastPickArgs, [false, 0, undefined, undefined, 'fly']);
  const opts = h.human.currentOptions;
  h.humanPlay('HAUT'); h.fireReveal();
  const rev = h.emits.find(e => e.event === 'fly_choice_revealed').payload;
  assert.ok([opts.haut.name, opts.bas.name].includes(rev.pokemon.name));
  assert.strictEqual(rev.basePoints, (rev.pokemon.name === opts.haut.name ? opts.haut : opts.bas).basePoints);
});
atest('La Mouche décide AVANT le choix humain et ne reçoit que l\'observation visible', async () => {
  const h = harness(); const seen = [];
  const orig = h.store.choose; h.store.choose = obs => { seen.push(JSON.parse(JSON.stringify(obs))); return orig(obs); };
  h.FLY.begin(h.game);
  const decided = h.game.fly.decision;
  assert.ok(decided && (decided.index === 0 || decided.index === 1));        // décision déjà prise, humain pas encore joué
  h.humanPlay('BAS');
  assert.strictEqual(h.game.fly.decision, decided);                          // inchangée par le choix humain
  h.fireReveal(); const afterTurn1 = h.human.score; h.nextTurn();
  assert.strictEqual(seen.length, 2);
  seen.forEach(o => {
    assert.deepStrictEqual(Object.keys(o).sort(), ['oppScore', 'options', 'ownScore', 'turn']);
    o.options.forEach(x => assert.deepStrictEqual(Object.keys(x).sort(), ['basePoints', 'rarity', 'shiny']));
  });
  assert.strictEqual(seen[1].oppScore, afterTurn1);                          // score humain d'AVANT le tour courant
  assert.strictEqual(seen[0].oppScore, 0);
});
atest('Aucune fuite avant révélation : événements sans décision, probas, poids ni points cachés', async () => {
  const h = harness(); h.FLY.begin(h.game);
  const before = h.emits.map(e => e.event);
  assert.deepStrictEqual(before, ['game_started', 'your_item', 'turn_options', 'fly_thinking']);
  const txt = JSON.stringify(h.emits);
  assert.ok(!/probs|phis|weights|baseline|temperature|decision|"index"|finalPoints|multiplier|effectName/.test(txt), txt.slice(0, 300));
  const thinking = h.emits.find(e => e.event === 'fly_thinking').payload;
  assert.deepStrictEqual(Object.keys(thinking), ['turn']);
  const opts = h.emits.find(e => e.event === 'turn_options').payload;
  assert.deepStrictEqual(Object.keys(opts.haut).sort(), ['name', 'shiny', 'shinySprite', 'sprite']);
});
atest('Révélation différée : délai d\'hésitation dans [MIN, MAX] ; transition bloquée tant que non révélé', async () => {
  const h = harness(); h.FLY.begin(h.game);
  h.humanPlay('HAUT');
  assert.strictEqual(h.state.transitions, 0);
  assert.strictEqual(h.game.fly.revealed, false);
  const t = h.timers[h.timers.length - 1];
  assert.ok(t.ms >= cfg.HESITATION_MS_MIN && t.ms <= cfg.HESITATION_MS_MAX, `${t.ms}`);
  assert.ok(!h.emits.some(e => e.event === 'fly_choice_revealed'));
  h.fireReveal();
  assert.strictEqual(h.game.fly.revealed, true);
  assert.strictEqual(h.state.transitions, 1);
  // une 2e révélation du même tour est sans effet
  const n = h.emits.filter(e => e.event === 'fly_choice_revealed').length;
  t.fn(); assert.strictEqual(h.emits.filter(e => e.event === 'fly_choice_revealed').length, n);
});
atest('Abandon : timers annulés, plus aucune révélation, AUCUN apprentissage ni XP', async () => {
  const h = harness(); h.FLY.begin(h.game);
  h.playTurn('HAUT'); h.playTurn('BAS'); h.humanPlay('HAUT');
  const pending = h.timers.filter(x => !x.cleared).pop();
  h.FLY.dispose(h.game);
  assert.ok(pending.cleared);
  const nRev = h.emits.filter(e => e.event === 'fly_choice_revealed').length;
  pending.fn();                                                              // même si le timer partait quand même
  assert.strictEqual(h.emits.filter(e => e.event === 'fly_choice_revealed').length, nRev);
  h.FLY.finish(h.game);
  assert.strictEqual(h.finishedPayload(), undefined);
  assert.strictEqual(h.store.policy.getState().games_played, 0);
  assert.strictEqual(h.xpCalls.length, 0);
});
atest('Fin prématurée (partie incomplète) : ni apprentissage ni XP', async () => {
  const h = harness(); h.FLY.begin(h.game);
  h.playTurn('HAUT'); h.playTurn('HAUT'); h.playTurn('BAS');
  h.FLY.finish(h.game);
  assert.strictEqual(h.finishedPayload().fly.learned, false);
  assert.strictEqual(h.store.policy.getState().games_played, 0);
  assert.strictEqual(h.xpCalls.length, 0);
});
atest('Reset du cerveau pendant la partie : la partie ne l\'entraîne pas', async () => {
  const h = harness(); h.FLY.begin(h.game);
  for (let t = 1; t <= 3; t++) h.playTurn('HAUT');
  await h.store.reset();
  for (let t = 4; t <= cfg.TURNS; t++) h.playTurn('HAUT');
  assert.strictEqual(h.finishedPayload().fly.learned, false);
  assert.strictEqual(h.store.policy.getState().games_played, 0);
});
atest('Mapping des résultats : victoire Mouche = défaite humain, nul = participation', async () => {
  assert.deepStrictEqual(HUMAN_RESULT, { win: 'defeat', loss: 'victory', draw: 'participation' });
  for (const [delta, humanResult] of [[0, 'participation'], [1, 'victory'], [-1, 'defeat']]) {
    const h = harness(); h.FLY.begin(h.game);
    for (let t = 1; t < cfg.TURNS; t++) h.playTurn('HAUT');
    h.humanPlay('HAUT'); h.fireReveal();
    h.human.score = h.game.fly.score + delta;
    h.nextTurn();
    assert.strictEqual(h.finishedPayload().players[0].result, humanResult);
  }
});
atest('Aucune mécanique de boss / type en fly : pas de boss, pas de bonus, aucun champ de type', async () => {
  const h = harness(); h.FLY.begin(h.game);
  for (let t = 1; t <= cfg.TURNS; t++) h.playTurn('HAUT');
  assert.strictEqual(h.game.boss, null);
  assert.strictEqual(h.human.typeBonus, undefined);
  const fin = h.finishedPayload();
  assert.strictEqual(fin.boss, null); assert.strictEqual(fin.players[0].typeBonus, null);
  assert.ok(!/weakness|counterType|affinity|typeMult|requiredPoints/.test(JSON.stringify(h.emits)));
});
atest('Décision impossible (observation invalide) : choix aléatoire, partie non entraînante', async () => {
  const mkBad = () => { const o = { pokemonId: 1, name: 'X', sprite: 'x', shiny: false, shinySprite: null, rarity: 'mega', basePoints: 900, effectName: 'Neutre', multiplier: 1, finalPoints: 900 };
    return { haut: o, bas: { ...o, pokemonId: 2, name: 'Y' } }; };
  const h = harness({ optionsFn: mkBad }); h.FLY.begin(h.game);
  for (let t = 1; t <= cfg.TURNS; t++) h.playTurn('HAUT');
  assert.strictEqual(h.finishedPayload().fly.learned, false);
  assert.strictEqual(h.store.policy.getState().games_played, 0);
  assert.strictEqual(h.xpCalls.length, 0);
});
atest('Resynchronisation après reconnexion : état public sans décision en attente', async () => {
  const h = harness(); h.FLY.begin(h.game);
  h.playTurn('HAUT'); h.humanPlay('BAS');
  h.FLY.resyncTurn(h.game, 'newSock');
  const st = h.emits.filter(e => e.event === 'fly_state').pop();
  assert.strictEqual(st.room, 'newSock');
  assert.strictEqual(st.payload.history.length, 1);            // seul le tour 1 est révélé
  assert.strictEqual(st.payload.thinking, true);
  assert.ok(!/probs|phis|weights|decision|"index"/.test(JSON.stringify(st.payload)));
});

console.log('\nI) XP contre la Mouche : plafond glissant 24 h');
const authFor = (valid = true) => () => ({ auth: { getUser: async token => (valid ? { data: { user: { id: token } }, error: null } : { data: { user: null }, error: { message: 'bad' } }) } });
const xpSetup = (extra = {}) => {
  const db = cleanDb(); db.tables.profiles.push({ id: 'u1', xp: 0 }, { id: 'u2', xp: 0 });
  const rec = createFlyXp({ supabase: db, createAuthClient: authFor(), xpParticipation: 10, xpVictoryBonus: 20, logger: silentLogger, ...extra });
  return { db, rec };
};
const acct = id => ({ accountAccessToken: id });
const det = (result = 'victory') => ({ result, score: 100, opponentName: 'La Mouche', team: [] });

atest('XP : invité ou token invalide = rien (ni XP ni historique)', async () => {
  const { db, rec } = xpSetup();
  assert.deepStrictEqual(await rec({ accountAccessToken: null }, det()), { skipped: true });
  const bad = createFlyXp({ supabase: db, createAuthClient: authFor(false), xpParticipation: 10, xpVictoryBonus: 20, logger: silentLogger });
  assert.deepStrictEqual(await bad(acct('u1'), det()), { skipped: true });
  assert.strictEqual(db.tables.game_history.length, 0);
});
atest('XP : participation 10, victoire 30, historique mode fly', async () => {
  const { db, rec } = xpSetup();
  assert.strictEqual((await rec(acct('u1'), det('participation'))).xp, 10);
  assert.strictEqual((await rec(acct('u1'), det('victory'))).xp, 30);
  assert.strictEqual((await rec(acct('u1'), det('defeat'))).xp, 10);
  assert.strictEqual(db.tables.profiles.find(p => p.id === 'u1').xp, 50);
  assert.ok(db.tables.game_history.every(r => r.game_mode === 'fly' && r.user_id === 'u1'));
});
atest(`XP : plafond de ${cfg.XP_CAP_PER_24H} XP / 24 h, partiel puis nul, historique toujours enregistré`, async () => {
  const { db, rec } = xpSetup();
  const got = [];
  for (let i = 0; i < 5; i++) got.push((await rec(acct('u1'), det('victory'))).xp);
  assert.deepStrictEqual(got, [30, 30, 30, 10, 0]);
  assert.strictEqual(db.tables.profiles.find(p => p.id === 'u1').xp, cfg.XP_CAP_PER_24H);
  assert.strictEqual(db.tables.game_history.length, 5);
});
atest('XP : lignes > 24 h, autres modes et autres comptes ignorés par le plafond', async () => {
  const { db, rec } = xpSetup();
  const old = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
  for (let i = 0; i < 6; i++) db.tables.game_history.push({ id: 100 + i, user_id: 'u1', game_mode: 'fly', result: 'victory', created_at: old });
  for (let i = 0; i < 6; i++) db.tables.game_history.push({ id: 200 + i, user_id: 'u1', game_mode: 'normal', result: 'victory', created_at: new Date().toISOString() });
  for (let i = 0; i < 6; i++) db.tables.game_history.push({ id: 300 + i, user_id: 'u2', game_mode: 'fly', result: 'victory', created_at: new Date().toISOString() });
  assert.strictEqual((await rec(acct('u1'), det('victory'))).xp, 30);
});
atest('XP : 6 fins de partie simultanées ne dépassent jamais le plafond', async () => {
  const { db, rec } = xpSetup();
  await Promise.all(Array.from({ length: 6 }, () => rec(acct('u1'), det('victory'))));
  assert.strictEqual(db.tables.profiles.find(p => p.id === 'u1').xp, cfg.XP_CAP_PER_24H);
});
atest('XP : panne DB -> échec silencieux côté serveur, aucun XP accordé, file non bloquée', async () => {
  const { db, rec } = xpSetup();
  db.failing.add('game_history:select');
  await assert.rejects(() => rec(acct('u1'), det('victory')));
  assert.strictEqual(db.tables.profiles.find(p => p.id === 'u1').xp, 0);
  db.failing.clear();
  assert.strictEqual((await rec(acct('u1'), det('victory'))).xp, 30);
});

console.log('\nJ) Branchement de server.js (python3 patch-server-fly.py)');
{
  const file = path.join(__dirname, 'server.js');
  const src = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const patched = src.includes('FLY.begin(game)');
  const fnBody = name => { const i = src.indexOf(`function ${name}(`); return src.slice(i, src.indexOf('\n}\n', i)); };
  test('server.js patché', () => assert.ok(patched, "lance : python3 patch-server-fly.py"));
  if (patched) {
    test("GAME_MODES contient 'fly'", () => assert.ok(/const GAME_MODES = \[[^\]]*'fly'[^\]]*\]/.test(src)));
    test('finishGame : branche fly AVANT tout bonus de type / boss', () => {
      const b = fnBody('finishGame');
      assert.ok(b.indexOf('FLY.finish(game)') > 0 && b.indexOf('FLY.finish(game)') < b.indexOf('syncTypeBonus'));
      assert.ok(b.indexOf("game.gameMode === 'fly'") < b.indexOf('game.boss'));
    });
    test('finalizePlayerTurn : fly sort AVANT les événements rares', () => {
      const b = fnBody('finalizePlayerTurn');
      assert.ok(b.indexOf("'fly'") > 0 && b.indexOf('return;') < b.indexOf('maybeTriggerEvent'));
    });
    test('player_choice : aucun bonus de type en fly', () => assert.ok(src.includes("game.gameMode === 'fly' ? 0 : syncTypeBonus(player, game)")));
    test('Parties fly jamais persistées ; succès : lignes fly ignorées ; Métamorph refusé', () => {
      assert.ok(fnBody('persistGame').includes("game.gameMode === 'fly'"));
      assert.ok(fnBody('buildAchievementContext').includes("r.game_mode !== 'fly'"));
      assert.ok(/transform_metamorph[\s\S]{0,300}gameMode === 'fly'/.test(src));
    });
    test('Abandon : dispose avant suppression de la partie, jamais d\'apprentissage hors finish', () => {
      assert.ok(/FLY\.dispose\(game\);[^\n]*\n\s*delete games\[gameId\]/.test(src));
      assert.ok(/FLY\.dispose\(oldGame\)/.test(src));
      assert.strictEqual((src.match(/flyBrain\.recordGame|\.recordGame\(/g) || []).length, 0);   // seul fly-game.finish() entraîne
    });
    test('Le client ne peut envoyer aucun événement lié à la Mouche (aucun socket.on fly*)', () => {
      assert.ok(!/socket\.on\('fly/.test(src));
      assert.ok(!/fly\.decision|flyBrain\.choose|\.policy\b/.test(src));
    });
    test('GET /api/fly/stats : ne renvoie que getPublicStats (si patch-server-fly-stats.py appliqué)', () => {
      const m = src.match(/app\.get\('\/api\/fly\/stats', \(req, res\) => \{([\s\S]*?)\n\}\);/);
      if (!m) return console.log('      (ignoré : patch-server-fly-stats.py non appliqué)');
      assert.ok(/res\.json\(flyBrain\.getPublicStats\(\)\)/.test(m[1]) && !/policy|weights|getState/.test(m[1]));
    });
    test('Cerveau : chargé au démarrage, flush au SIGTERM, routes admin enregistrées', () => {
      assert.ok(src.includes('flyBrain.load()') && src.includes('flyBrain.flush()') && src.includes('registerFlyAdminRoutes(app'));
    });
  }
  test('debug-fly.js : s\'exécute, affiche poids / features / probabilités ; jamais importé par le serveur ni le client', () => {
    const dbg = path.join(__dirname, 'debug-fly.js');
    if (!fs.existsSync(dbg)) return console.log('      (ignoré : debug-fly.js absent)');
    const out = require('child_process').execFileSync(process.execPath, [dbg, '--draws', '2', '--train', '300', '--synthetic'], { encoding: 'utf8' });
    assert.ok(/POIDS/.test(out) && /features:/.test(out) && /p=\s*\d/.test(out) && /bp\*left/.test(out));
    assert.ok(!/debug-fly/.test(src));
    const cl = path.join(__dirname, 'public', 'client.js');
    if (fs.existsSync(cl)) assert.ok(!/debug-fly/.test(fs.readFileSync(cl, 'utf8')));
  });
  test('fly-game.js : seuls les événements autorisés sont émis, aucun champ interne dans les payloads', () => {
    const g = fs.readFileSync(path.join(__dirname, 'fly-game.js'), 'utf8');
    const events = [...g.matchAll(/\.emit\('([a-z_]+)'/g)].map(m => m[1]);
    assert.deepStrictEqual([...new Set(events)].sort(), ['fly_choice_revealed', 'fly_state', 'fly_thinking', 'game_finished', 'game_started', 'turn_options', 'your_item']);
    g.split('\n').filter(l => l.includes('.emit(')).forEach(l => assert.ok(!/probs|phis|weights|baseline|decision|trajectory|reward/.test(l), l));
  });
}

(async () => {
  for (const { name, fn } of asyncTests) {
    try { await fn(); pass++; console.log(`  ✔ ${name}`); }
    catch (e) { fail++; console.log(`  ✘ ${name}\n      ${e.message}`); }
  }
  console.log(`\n${pass} réussi(s), ${fail} échec(s)`);
  process.exit(fail ? 1 : 0);
})();
