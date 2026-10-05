#!/usr/bin/env node
'use strict';
// Tests du mode 'fly' (v2 : la Mouche n'observe que identité + shiny + types).  node test-fly.js
// Aucun réseau : faux Supabase, faux io, faux timers. server.js n'est jamais exécuté (lecture statique + extraction
// des fonctions de tirage dans un bac à sable). Voir aussi : test-fly-value.js (politique), test-fly-client.js (client).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const cfg = require('./fly-config');
const bossConfig = require('./boss-mechanics-config');
const { createBossMechanics } = require('./boss-mechanics');
const { ValuePolicy, mulberry32 } = require('./fly-value-policy');
const { createPolicy, assertFlyModel } = require('./fly-policy');
const { createBrainStore } = require('./fly-brain-store');
const { registerFlyAdminRoutes } = require('./fly-admin-routes');
const { createFlyGame, HUMAN_RESULT } = require('./fly-game');
const { createFlyXp } = require('./fly-xp');
const { runWarmup, playSimulatedGame, simulatedHumanPick } = require('./fly-warmup');
const { createRealDraws } = require('./fly-real-env');
const { FakeSupabase, fakeApp, silentLogger } = require('./fly-test-utils');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log(`  ✔ ${name}`); }
  catch (e) { fail++; console.log(`  ✘ ${name}\n      ${e.message}`); }
}
const asyncTests = [];
const atest = (name, fn) => asyncTests.push({ name, fn });

const readServer = () => {
  const file = path.join(__dirname, 'server.js');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').replace(/\r\n?/g, '\n') : null;
};

// ---------- Fixtures ----------
const POKES = Array.from({ length: 60 }, (_, i) => ({ id: i + 1, name: `P${i + 1}`, rarity: ['commun', 'rare', 'epique'][i % 3], base: 200 + ((i * 137) % 700) }));
const EFFECTS_FIX = [['Neutre', 1], ['Motivé', 1.1], ['Sub-5', 0.75], ['Beauty privilege', 1.3]];
const bstFix = Object.fromEntries(POKES.map(p => [p.id, p.base]));
function fakeOption(rng) {
  const p = POKES[Math.floor(rng() * POKES.length)];
  const [effectName, multiplier] = EFFECTS_FIX[Math.floor(rng() * EFFECTS_FIX.length)];
  const shiny = rng() < 0.05;
  return {
    pokemonId: p.id, name: p.name, sprite: `s${p.id}.png`, shiny, shinySprite: shiny ? `sh${p.id}.png` : null, rarity: p.rarity,
    basePoints: p.base, effectName, multiplier, finalPoints: Math.round(p.base * multiplier * (shiny ? 1.5 : 1))
  };
}
function fakePair(rng) {
  const a = fakeOption(rng); let b = fakeOption(rng);
  while (b.pokemonId === a.pokemonId) b = fakeOption(rng);
  return [a, b];
}
const mkObs = (turn = 1, a = 1, b = 2) => ({ turn, ownScore: 0, oppScore: 0, options: [{ pokemonId: a, shiny: false, types: ['fire'] }, { pokemonId: b, shiny: false, types: ['water'] }] });

const tcfg = { ...cfg, SNAPSHOT_EVERY_GAMES: 5, SNAPSHOT_KEEP: 3, SNAPSHOT_KEEP_SAFETY: 5, CURVE_WINDOW_GAMES: 10, WARMUP_GAMES: 20 };
const cleanDb = () => new FakeSupabase();
const makePolicyFor = c => () => new ValuePolicy({ config: c, seed: 11 });
function warmupFor(c, calls) {
  return policy => {
    if (calls) calls.n++;
    const rng = mulberry32(5);
    return runWarmup({ policy, draw: () => fakePair(rng), bst: bstFix, typesById: {}, games: c.WARMUP_GAMES, seed: 3, config: c });
  };
}
const newStore = (db, c = tcfg, { warmup = true, calls } = {}) =>
  createBrainStore({ supabase: db, config: c, logger: silentLogger, makePolicy: makePolicyFor(c), warmup: warmup ? warmupFor(c, calls) : null });
// Partie complète synthétique via l'API du store : choix, résultat observé, fin de partie.
function playOne(store, result = 'win', { epoch } = {}) {
  const g = store.beginGame();
  const trajectory = [];
  for (let t = 1; t <= cfg.TURNS; t++) {
    const d = store.choose(mkObs(t, 10 + t, 20 + t));
    store.observe(d, { basePoints: 300 + t * 10, finalPoints: 300 });
    trajectory.push(d);
  }
  return store.recordGame({ epoch: epoch === undefined ? g.epoch : epoch, trajectory, result });
}

console.log('A) Configuration et alignement sur server.js');
test('Valeurs valides', () => {
  ['TURNS', 'SHINY_POINTS_MULTIPLIER', 'BASEPOINTS_SCALE', 'VALUE_PRIOR_STRENGTH', 'VALUE_MIN_RATE', 'VALUE_TEMP_START', 'VALUE_TEMP_FLOOR',
    'VALUE_TEMP_TAU', 'WARMUP_GAMES', 'WARMUP_HUMAN_NOISE', 'HESITATION_MS_MIN', 'HESITATION_MS_MAX', 'SNAPSHOT_EVERY_GAMES', 'SNAPSHOT_KEEP',
    'SNAPSHOT_KEEP_SAFETY', 'CURVE_WINDOW_GAMES', 'XP_CAP_PER_24H', 'ADMIN_KEY_MIN_LENGTH', 'ADMIN_MAX_FAILS', 'ADMIN_FAIL_WINDOW_MS'].forEach(k =>
    assert.ok(Number.isFinite(cfg[k]) && cfg[k] >= 0, `${k} invalide`));
  assert.ok(cfg.VALUE_TEMP_FLOOR > 0 && cfg.VALUE_TEMP_START >= cfg.VALUE_TEMP_FLOOR);
  assert.ok(cfg.HESITATION_MS_MAX >= cfg.HESITATION_MS_MIN);
  assert.ok(['base', 'final'].includes(cfg.VALUE_OBSERVE));
  assert.strictEqual(cfg.VALUE_USE_TYPES, false);          // validé par fly-validate.js : aucun gain après échauffement
  assert.strictEqual(cfg.WARMUP_GAMES, 210);
});
test("FLY_MODEL : 'value' seule valeur acceptée ; toute autre fait échouer avec un message clair", () => {
  assert.strictEqual(cfg.FLY_MODEL, 'value');
  assert.doesNotThrow(() => assertFlyModel(cfg));
  assert.ok(createPolicy({ config: cfg, seed: 1 }) instanceof ValuePolicy);
  for (const bad of ['mushroom', 'linear', '', undefined, null, 'Value']) {
    assert.throws(() => assertFlyModel({ ...cfg, FLY_MODEL: bad }), /FLY_MODEL invalide.*Seule la valeur 'value'/);
    assert.throws(() => createPolicy({ config: { ...cfg, FLY_MODEL: bad } }), /FLY_MODEL invalide/);
    assert.throws(() => createBrainStore({ config: { ...cfg, FLY_MODEL: bad }, logger: silentLogger }), /FLY_MODEL invalide/);
    assert.throws(() => createBrainStore({ config: { ...cfg, FLY_MODEL: bad }, makePolicy: () => new ValuePolicy({ config: cfg }), logger: silentLogger }), /FLY_MODEL invalide/);
  }
});
test('Magasin sans fabrique de politique : modèle par défaut = ValuePolicy (interface commune)', () => {
  const s = createBrainStore({ config: tcfg, logger: silentLogger });
  assert.ok(s.policy instanceof ValuePolicy);
  ['choose', 'observe', 'learn', 'getState', 'setState'].forEach(m => assert.strictEqual(typeof s.policy[m], 'function', m));
});
test("Aucune clé 'fly' dans ENABLED_BY_MODE (mécaniques de boss inactives en fly)", () => assert.ok(!('fly' in bossConfig.ENABLED_BY_MODE)));
test('TURNS et SHINY_POINTS_MULTIPLIER alignés sur server.js', () => {
  const src = readServer(); if (!src) return console.log('      (ignoré : server.js absent)');
  assert.strictEqual(Number(src.match(/const MAX_TURNS = (\d+)/)[1]), cfg.TURNS);
  assert.strictEqual(Number(src.match(/const SHINY_POINTS_MULTIPLIER = ([\d.]+)/)[1]), cfg.SHINY_POINTS_MULTIPLIER);
});
test('VRAIES fonctions de tirage de server.js : mode fly = table normale, jamais de Méga, deux Pokémon différents', () => {
  const file = path.join(__dirname, 'server.js'); if (!fs.existsSync(file)) return console.log('      (ignoré : server.js absent)');
  const order = ['commun', 'peu_commun', 'rare', 'epique', 'pseudo_legendaire', 'mega', 'legendaire', 'fabuleux', 'ultra_chimere'];
  const entries = []; let id = 1;
  order.forEach(r => { for (let k = 0; k < 4; k++) entries.push({ id: id++, name: `${r}${k}`, rarity: r, bst: 400, basePoints: 500 + k }); });
  const draws = createRealDraws({ serverFile: file, entries, rng: mulberry32(4), categoryOrder: order });
  const count = {}; let n = 0;
  for (let i = 0; i < 6000; i++) {
    const [a, b] = draws.drawOptions();
    assert.notStrictEqual(a.pokemonId, b.pokemonId);
    [a, b].forEach(o => { count[o.rarity] = (count[o.rarity] || 0) + 1; n++; assert.ok(Number.isInteger(o.pokemonId) && Number.isFinite(o.finalPoints)); });
  }
  assert.ok(!count.mega, 'Méga tirée en mode fly');
  draws.rarityTable.filter(r => r.rarity !== 'mega').forEach(r => assert.ok(Math.abs((count[r.rarity] || 0) / n - r.weight) < 0.02, `${r.rarity}`));
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


console.log('\nB) Échauffement simulé');
test('Joueur simulé : sans bruit il prend le plus gros BST (shiny ×1.5), « random » ne dépend pas du BST', () => {
  const rng = mulberry32(1);
  const o = [{ pokemonId: 1, shiny: false }, { pokemonId: 2, shiny: false }];
  assert.strictEqual(simulatedHumanPick(o, { 1: 300, 2: 500 }, rng, { noise: 0 }), 1);
  assert.strictEqual(simulatedHumanPick(o, { 1: 500, 2: 300 }, rng, { noise: 0 }), 0);
  assert.strictEqual(simulatedHumanPick([{ pokemonId: 1, shiny: true }, { pokemonId: 2, shiny: false }], { 1: 400, 2: 500 }, rng, { noise: 0 }), 0);
  let ones = 0; for (let i = 0; i < 4000; i++) ones += simulatedHumanPick(o, { 1: 300, 2: 900 }, rng, { kind: 'random' });
  assert.ok(Math.abs(ones / 4000 - 0.5) < 0.03);
});
test('runWarmup : N parties comptées À PART (warmup_games), aucune partie vécue ni victoire enregistrée', () => {
  const p = new ValuePolicy({ config: tcfg, seed: 1 }), rng = mulberry32(2);
  const r = runWarmup({ policy: p, draw: () => fakePair(rng), bst: bstFix, typesById: {}, games: 30, seed: 4, config: tcfg });
  const s = p.getState();
  assert.strictEqual(r.games, 30);
  assert.deepStrictEqual([s.warmup_games, s.games_played, s.wins, s.losses, s.draws], [30, 0, 0, 0, 0]);
  assert.ok(Object.keys(s.ids).length > 10);
});
test('Échauffement déterministe avec seed ; évaluation figée (learn=false) ne change rien', () => {
  const run = () => { const p = new ValuePolicy({ config: tcfg, seed: 1 }), rng = mulberry32(2); runWarmup({ policy: p, draw: () => fakePair(rng), bst: bstFix, typesById: {}, games: 25, seed: 4, config: tcfg }); return JSON.stringify(p.getState()); };
  assert.strictEqual(run(), run());
  const p = new ValuePolicy({ config: tcfg, seed: 1 }), rng = mulberry32(2), before = JSON.stringify(p.getState());
  playSimulatedGame({ policy: p, draw: () => fakePair(rng), bst: bstFix, rng: mulberry32(3), config: tcfg, learn: false });
  assert.strictEqual(JSON.stringify(p.getState()), before);
});
test('L\'échauffement apprend : 300 parties -> bien meilleure que le hasard contre le joueur simulé', () => {
  const p = new ValuePolicy({ config: tcfg, seed: 1 }), rng = mulberry32(2);
  runWarmup({ policy: p, draw: () => fakePair(rng), bst: bstFix, typesById: {}, games: 300, seed: 4, config: tcfg });
  const evalRate = pol => { const r = mulberry32(77), h = mulberry32(78); let w = 0; for (let g = 0; g < 600; g++) w += playSimulatedGame({ policy: pol, draw: () => fakePair(r), bst: bstFix, rng: h, config: tcfg, learn: false }) === 'win'; return w / 600; };
  assert.ok(evalRate(p) > evalRate(new ValuePolicy({ config: tcfg, seed: 1 })) + 0.15);
});


console.log('\nC) Cerveau : persistance, échauffement, génération, archivage (faux Supabase)');
atest('Base vide : ligne créée, échauffement exécuté UNE fois, génération 1, compteurs à 0', async () => {
  const db = cleanDb(), calls = { n: 0 }, s = newStore(db, tcfg, { calls });
  assert.strictEqual(await s.load(), 'created');
  assert.strictEqual(calls.n, 1);
  const row = db.tables.fly_brain[0];
  assert.deepStrictEqual([row.generation, row.total_games, row.games_played], [1, 0, 0]);
  assert.strictEqual(row.weights.warmup_games, tcfg.WARMUP_GAMES);
  assert.strictEqual(s.getPublicStats().brain.warmupGames, tcfg.WARMUP_GAMES);
});
atest('Redémarrage : cerveau rechargé identique, PAS de nouvel échauffement', async () => {
  const db = cleanDb(), s = newStore(db); await s.load();
  ['win', 'loss', 'draw', 'win', 'win', 'loss', 'win'].forEach(r => playOne(s, r));
  await s.flush();
  const row = db.tables.fly_brain[0];
  assert.deepStrictEqual([row.games_played, row.wins, row.losses, row.draws], [7, 4, 2, 1]);
  assert.deepStrictEqual([row.total_games, row.total_wins, row.total_losses, row.total_draws], [7, 4, 2, 1]);
  assert.deepStrictEqual(row.recent_results, ['W', 'L', 'D', 'W', 'W', 'L', 'W']);
  const calls = { n: 0 }, s2 = newStore(db, tcfg, { calls });
  assert.strictEqual(await s2.load(), 'loaded');
  assert.strictEqual(calls.n, 0);
  assert.deepStrictEqual(s2.policy.getState(), s.policy.getState());
  assert.deepStrictEqual(s2.policy.evaluate(mkObs()).probs, s.policy.evaluate(mkObs()).probs);
  assert.deepStrictEqual(s2.getPublicStats(), s.getPublicStats());
});
atest('Une seule écriture coalescée pour 50 parties synchrones', async () => {
  const db = cleanDb(), s = newStore(db, { ...tcfg, SNAPSHOT_EVERY_GAMES: 1000 }); await s.load();
  const before = db.writes.fly_brain;
  for (let i = 0; i < 50; i++) playOne(s, 'win');
  await s.flush();
  assert.ok(db.writes.fly_brain - before <= 2, `écritures : ${db.writes.fly_brain - before}`);
  assert.strictEqual(db.tables.fly_brain[0].games_played, 50);
});
atest('Snapshots tous les N parties VÉCUES (échauffement exclu), seuls les SNAPSHOT_KEEP derniers conservés', async () => {
  const db = cleanDb(), s = newStore(db); await s.load();
  for (let i = 0; i < 12; i++) playOne(s, 'win');
  await s.flush();
  assert.deepStrictEqual(db.tables.fly_brain_snapshots.map(r => r.games_played), [5, 10]);
  assert.ok(db.tables.fly_brain_snapshots.every(r => r.generation === 1));
  for (let i = 0; i < 13; i++) playOne(s, 'loss');
  await s.flush();
  assert.deepStrictEqual(db.tables.fly_brain_snapshots.map(r => r.games_played).sort((a, b) => a - b), [15, 20, 25]);
  assert.ok(db.tables.fly_brain_snapshots.every(r => r.reason === 'periodic'));
});
atest('Abandon / partie incomplète : AUCUN apprentissage, AUCUNE écriture, aucun compteur', async () => {
  const db = cleanDb(), s = newStore(db); await s.load(); await s.flush();
  const w0 = db.writes.fly_brain, st0 = JSON.stringify(s.policy.getState()), pub0 = JSON.stringify(s.getPublicStats());
  const g = s.beginGame();
  const partial = [s.choose(mkObs(1)), s.choose(mkObs(2))];
  partial.forEach(d => s.observe(d, { basePoints: 300 }));
  assert.strictEqual(s.recordGame({ epoch: g.epoch, trajectory: partial, result: 'win' }).reason, 'incomplete');
  await s.flush();
  assert.strictEqual(JSON.stringify(s.policy.getState()), st0);
  assert.strictEqual(JSON.stringify(s.getPublicStats()), pub0);
  assert.strictEqual(db.writes.fly_brain, w0);
});
atest('Parties simultanées : un seul cerveau partagé', async () => {
  const db = cleanDb(), s = newStore(db); await s.load();
  const g1 = s.beginGame(), g2 = s.beginGame(), t1 = [], t2 = [];
  for (let t = 1; t <= cfg.TURNS; t++) {
    const a = s.choose(mkObs(t, 10 + t, 20 + t)), b = s.choose(mkObs(t, 30 + t, 40 + t));
    s.observe(a, { basePoints: 100 }); s.observe(b, { basePoints: 900 }); t1.push(a); t2.push(b);
  }
  assert.ok(s.recordGame({ epoch: g1.epoch, trajectory: t1, result: 'win' }).learned);
  assert.ok(s.recordGame({ epoch: g2.epoch, trajectory: t2, result: 'loss' }).learned);
  assert.strictEqual(s.getPublicStats().brain.gamesPlayed, 2);
  assert.strictEqual(s.getPublicStats().global.gamesPlayed, 2);
});
atest('RESET : ancien cerveau archivé, génération +1, cerveau neuf + échauffement ; score global ET courbe inchangés', async () => {
  const db = cleanDb(), calls = { n: 0 }, s = newStore(db, tcfg, { calls }); await s.load();
  ['win', 'win', 'loss', 'draw', 'win', 'win', 'loss'].forEach(r => playOne(s, r));
  await s.flush();
  const beforeStats = s.getPublicStats(), beforeState = s.policy.getState();
  assert.strictEqual(beforeStats.generation, 1);
  const inFlight = s.beginGame(), traj = Array.from({ length: cfg.TURNS }, (_, i) => { const d = s.choose(mkObs(i + 1)); s.observe(d, { basePoints: 400 }); return d; });
  const r = await s.reset(); await s.flush();
  assert.ok(r.ok); assert.deepStrictEqual([r.previousGeneration, r.generation, r.previousGames], [1, 2, 7]);
  const after = s.getPublicStats();
  // le score global « Humanité X – Mouche Y » et la courbe ne bougent pas
  assert.deepStrictEqual(after.global, beforeStats.global);
  assert.deepStrictEqual(after.recent, beforeStats.recent);
  assert.strictEqual(after.global.flyWins, 4); assert.strictEqual(after.global.humanityWins, 2);
  // seul le cerveau repart de zéro : parties vécues = 0, valeurs neuves, échauffement refait
  assert.strictEqual(after.generation, 2);
  assert.deepStrictEqual([after.brain.gamesPlayed, after.brain.flyWins, after.brain.humanityWins, after.brain.draws], [0, 0, 0, 0]);
  assert.strictEqual(after.brain.warmupGames, tcfg.WARMUP_GAMES);
  assert.strictEqual(calls.n, 2);
  assert.notDeepStrictEqual(s.policy.getState().ids, beforeState.ids);
  // en base
  const row = db.tables.fly_brain[0];
  assert.deepStrictEqual([row.generation, row.games_played, row.total_games, row.total_wins, row.total_losses, row.total_draws], [2, 0, 7, 4, 2, 1]);
  assert.deepStrictEqual(row.recent_results, beforeStats.recent);
  // archive : l'ancien cerveau complet, étiqueté génération 1
  const arch = db.tables.fly_brain_snapshots.filter(x => x.reason === 'pre_reset');
  assert.strictEqual(arch.length, 1);
  assert.deepStrictEqual([arch[0].generation, arch[0].games_played, arch[0].wins, arch[0].losses, arch[0].draws], [1, 7, 4, 2, 1]);
  assert.deepStrictEqual(arch[0].weights.ids, beforeState.ids);
  // partie en cours pendant le reset : ignorée ; nouvelle partie : apprend
  assert.strictEqual(s.recordGame({ epoch: inFlight.epoch, trajectory: traj, result: 'win' }).reason, 'stale_epoch');
  assert.strictEqual(s.getPublicStats().global.gamesPlayed, 7);
  assert.ok(playOne(s, 'win').learned);
  const final = s.getPublicStats();
  assert.deepStrictEqual([final.brain.gamesPlayed, final.global.gamesPlayed, final.global.flyWins], [1, 8, 5]);
});
atest('Génération monotone : plusieurs resets, compteurs globaux cumulés sur toutes les générations', async () => {
  const db = cleanDb(), s = newStore(db); await s.load();
  for (let g = 1; g <= 3; g++) { playOne(s, 'win'); playOne(s, 'loss'); await s.reset(); }
  await s.flush();
  const st = s.getPublicStats();
  assert.deepStrictEqual([st.generation, st.global.gamesPlayed, st.global.flyWins, st.global.humanityWins, st.brain.gamesPlayed], [4, 6, 3, 3, 0]);
  assert.deepStrictEqual(db.tables.fly_brain_snapshots.filter(x => x.reason === 'pre_reset').map(x => x.generation).sort(), [1, 2, 3]);
});
atest('Restauration : cerveau archivé redevient courant, génération +1, score global inchangé, archive de sécurité', async () => {
  const db = cleanDb(), s = newStore(db); await s.load();
  for (let i = 0; i < 5; i++) playOne(s, i % 2 ? 'loss' : 'win');
  await s.flush();
  const snap = db.tables.fly_brain_snapshots.find(x => x.games_played === 5);
  const at5 = s.policy.getState();
  for (let i = 0; i < 4; i++) playOne(s, 'win');
  await s.flush();
  const globalBefore = s.getPublicStats().global;
  const r = await s.restoreSnapshot(snap.id); await s.flush();
  assert.ok(r.ok); assert.deepStrictEqual([r.restoredGames, r.generation], [5, 2]);
  assert.deepStrictEqual(s.policy.getState(), at5);
  assert.deepStrictEqual(s.getPublicStats().global, globalBefore);
  assert.strictEqual(db.tables.fly_brain[0].games_played, 5);
  assert.ok(db.tables.fly_brain_snapshots.some(x => x.reason === 'pre_restore' && x.games_played === 9 && x.generation === 1));
  assert.strictEqual((await s.restoreSnapshot(99999)).reason, 'not_found');
  db.tables.fly_brain_snapshots.find(x => x.id === snap.id).weights.ids = { 1: [NaN, 'x'] };
  const keep = JSON.stringify(s.policy.getState());
  await assert.rejects(() => s.restoreSnapshot(snap.id), /invalide/);
  assert.strictEqual(JSON.stringify(s.policy.getState()), keep);
});
atest('Archives de sécurité : SNAPSHOT_KEEP_SAFETY conservées, périodiques intactes', async () => {
  const db = cleanDb(), s = newStore(db); await s.load();
  for (let i = 0; i < 5; i++) playOne(s, 'win');
  for (let i = 0; i < 8; i++) { await s.reset(); playOne(s, 'win'); }
  await s.flush();
  assert.strictEqual(db.tables.fly_brain_snapshots.filter(x => x.reason !== 'periodic').length, tcfg.SNAPSHOT_KEEP_SAFETY);
  assert.ok(db.tables.fly_brain_snapshots.some(x => x.reason === 'periodic' && x.games_played === 5));
});
atest('Panne DB : l\'apprentissage continue en mémoire, la sauvegarde suivante rattrape tout', async () => {
  const db = cleanDb(), s = newStore(db); await s.load();
  playOne(s, 'win'); await s.flush();
  db.failing.add('fly_brain:update');
  playOne(s, 'loss'); await s.flush();
  assert.strictEqual(s.getPublicStats().global.gamesPlayed, 2);
  assert.strictEqual(db.tables.fly_brain[0].total_games, 1);
  db.failing.clear();
  playOne(s, 'win'); await s.flush();
  assert.strictEqual(db.tables.fly_brain[0].total_games, 3);
});
atest('Garde anti-régression (total_games monotone) : une base plus avancée n\'est jamais écrasée ; le reset (forcé) reste possible', async () => {
  const db = cleanDb(), s = newStore(db); await s.load();
  db.tables.fly_brain[0].total_games = 999;
  playOne(s, 'win'); await s.flush();
  assert.strictEqual(db.tables.fly_brain[0].total_games, 999);
  assert.strictEqual(s.conflicts, 1);
  await s.reset(); await s.flush();
  assert.strictEqual(db.tables.fly_brain[0].generation, 2);
});
atest('Ligne illisible / schéma obsolète / lecture impossible : sauvegarde désactivée, ligne jamais écrasée', async () => {
  const valid = () => ({ id: 1, weights: { kind: 'value', version: 1, ids: {}, types: {}, global: [0, 0], warmup_games: 0 }, games_played: 0, wins: 0, losses: 0, draws: 0, recent_results: [], generation: 1, total_games: 0, total_wins: 0, total_losses: 0, total_draws: 0 });
  // 1. modèle inconnu (ex. ancien format)
  const db1 = cleanDb(); db1.tables.fly_brain.push({ ...valid(), weights: { kind: 'linear', weights: [1] }, games_played: 3 });
  const s1 = newStore(db1); assert.strictEqual(await s1.load(), 'invalid');
  const snap = JSON.stringify(db1.tables.fly_brain[0]);
  playOne(s1, 'win'); await s1.flush();
  assert.strictEqual(JSON.stringify(db1.tables.fly_brain[0]), snap);
  assert.ok(s1.policy.getState().warmup_games > 0);            // le jeu reste jouable (cerveau neuf en mémoire)
  // 2. colonnes v2 absentes (SQL non exécuté)
  const db2 = cleanDb(); const old = valid(); ['generation', 'total_games', 'total_wins', 'total_losses', 'total_draws'].forEach(k => delete old[k]); db2.tables.fly_brain.push(old);
  const s2 = newStore(db2); assert.strictEqual(await s2.load(), 'schema_outdated');
  const snap2 = JSON.stringify(db2.tables.fly_brain[0]);
  playOne(s2, 'win'); await s2.flush();
  assert.strictEqual(JSON.stringify(db2.tables.fly_brain[0]), snap2);
  // 3. lecture impossible
  const db3 = cleanDb(); db3.failing.add('fly_brain:select');
  assert.strictEqual(await newStore(db3).load(), 'db_error');
});
atest('Mémoire seule (pas de Supabase) : échauffement + parties + reset sans erreur', async () => {
  const calls = { n: 0 }, s = createBrainStore({ supabase: null, config: tcfg, logger: silentLogger, makePolicy: makePolicyFor(tcfg), warmup: warmupFor(tcfg, calls) });
  assert.strictEqual(await s.load(), 'memory_only');
  assert.strictEqual(calls.n, 1);
  assert.ok(playOne(s, 'win').learned);
  assert.ok((await s.reset()).ok);
  assert.strictEqual(calls.n, 2);
  await s.flush();
});
atest('Échauffement qui échoue : le serveur démarre quand même (cerveau vierge, erreur loggée)', async () => {
  const errs = [];
  const s = createBrainStore({ supabase: null, config: tcfg, logger: { log() {}, warn() {}, error: m => errs.push(m) }, makePolicy: makePolicyFor(tcfg), warmup: () => { throw new Error('boum'); } });
  assert.strictEqual(await s.load(), 'memory_only');
  assert.ok(errs.some(m => /échauffement impossible/.test(m)));
  assert.strictEqual(s.getPublicStats().brain.warmupGames, 0);
  assert.ok(playOne(s, 'win').learned);
});
atest('Stats publiques : forme exacte, chiffres réels, aucune valeur apprise ni table de Pokémon', async () => {
  const db = cleanDb(), s = newStore(db); await s.load();
  for (let i = 0; i < 25; i++) playOne(s, i % 3 === 0 ? 'loss' : 'win');
  const st = s.getPublicStats();
  assert.deepStrictEqual(Object.keys(st).sort(), ['brain', 'generation', 'global', 'name', 'recent']);
  assert.deepStrictEqual(Object.keys(st.brain).sort(), ['draws', 'flyWins', 'gamesPlayed', 'humanityWins', 'warmupGames', 'winRate']);
  assert.deepStrictEqual(Object.keys(st.global).sort(), ['draws', 'flyWins', 'gamesPlayed', 'humanityWins', 'winRate']);
  assert.strictEqual(st.recent.length, tcfg.CURVE_WINDOW_GAMES);
  assert.strictEqual(st.brain.gamesPlayed, 25);
  assert.strictEqual(st.brain.flyWins + st.brain.humanityWins + st.brain.draws, 25);
  assert.ok(Math.abs(st.brain.winRate - st.brain.flyWins / 25) < 1e-12);
  assert.ok(!/"ids"|"types"|"global":\[|weights|baseline|probs|values/.test(JSON.stringify(st)));
  assert.strictEqual(createBrainStore({ config: tcfg, logger: silentLogger }).getPublicStats().brain.winRate, null);
});


console.log('\nD) Routes admin (reset / restauration / limiteur)');
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
  assert.ok(rr.body.generation > rr.body.previousGeneration);
  assert.strictEqual(s.getPublicStats().global.gamesPlayed, 6);   // le score global ne bouge pas
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


console.log('\nE) Déroulement d\'une partie fly (faux io / faux timers)');
function harness({ optionsFn, recordFlyResult = null, storeCfg = tcfg, warmup = false } = {}) {
  const emits = [], timers = [];
  const io = { to: room => ({ emit: (event, payload) => emits.push({ room, event, payload: JSON.parse(JSON.stringify(payload === undefined ? null : payload)) }) }) };
  const fakeTimers = {
    set: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
    clear: t => { if (t) t.cleared = true; }
  };
  const db = cleanDb(), store = newStore(db, storeCfg, { warmup });
  const rng = mulberry32(99);
  const state = { transitions: 0, lastPickArgs: null, typeCalls: 0 };
  const deps = {
    pickPlayerTurnOptions: (...args) => { state.lastPickArgs = args; if (optionsFn) return optionsFn(); const [h, b] = fakePair(rng); return { haut: h, bas: b }; },
    teamMonFromReward: r => ({ id: r.pokemonId, name: r.name, rarity: r.rarity, basePoints: r.basePoints }),
    buildRoute: () => Array.from({ length: cfg.TURNS }, (_, i) => ({ turn: i + 1, status: i === 0 ? 'current' : 'upcoming' })),
    getPublicPlayers: g => g.players.map(p => ({ id: p.id, name: p.name, score: p.score, team: p.team })),
    maybeScheduleTurnTransition: g => { if (g.fly && g.fly.revealed && g.players[0].currentChoice !== null) state.transitions++; },
    getTypes: id => { state.typeCalls++; return id % 2 ? ['fire'] : ['water', 'flying']; }
  };
  const xpCalls = [];
  const FLY = createFlyGame({ io, store, deps, timers: fakeTimers, random: mulberry32(5), logger: silentLogger, config: storeCfg,
    recordFlyResult: recordFlyResult || (async (p, d) => { xpCalls.push(d); }) });
  const human = { id: 'sock1', name: 'Humain', avatar: null, score: 0, team: [], currentChoice: null, currentOptions: null };
  const game = { id: 'ABCD', gameMode: 'fly', status: 'playing', turn: 0, maxTurns: cfg.TURNS, players: [human], boss: null, route: null };
  const humanPlay = choice => {                 // imite player_choice + finalizePlayerTurn de server.js
    const r = human.currentOptions[choice === 'HAUT' ? 'haut' : 'bas'];
    human.currentChoice = choice; human.score += r.finalPoints; human.team.push({ id: r.pokemonId });
    FLY.onHumanChose(game);
  };
  const fireReveal = () => { const t = timers.filter(x => !x.cleared).pop(); t.cleared = true; t.fn(); };
  const nextTurn = () => {                      // imite resolveTurnTransition
    if (game.turn >= game.maxTurns) { game.status = 'finished'; FLY.finish(game); return; }
    game.turn += 1; human.currentChoice = null; human.currentOptions = null; FLY.startTurn(game);
  };
  const playTurn = choice => { humanPlay(choice); fireReveal(); nextTurn(); };
  const finishedPayload = () => (emits.find(e => e.event === 'game_finished') || {}).payload;
  return { emits, timers, store, db, FLY, game, human, state, xpCalls, humanPlay, fireReveal, nextTurn, playTurn, finishedPayload };
}

atest('Partie complète : 6 tours, résultat cohérent, cerveau mis à jour UNE fois, XP demandée une fois', async () => {
  const h = harness(); h.FLY.begin(h.game);
  for (let t = 1; t <= cfg.TURNS; t++) h.playTurn(t % 2 ? 'HAUT' : 'BAS');
  const fin = h.finishedPayload();
  assert.ok(fin && fin.gameMode === 'fly' && fin.boss === null && fin.fly.turns.length === cfg.TURNS);
  assert.strictEqual(fin.fly.score, fin.fly.turns.reduce((s, x) => s + x.pointsGained, 0));
  assert.strictEqual(fin.players[0].score, h.human.score);
  const expected = fin.fly.score > h.human.score ? 'win' : fin.fly.score < h.human.score ? 'loss' : 'draw';
  assert.strictEqual(fin.fly.result, expected);
  assert.strictEqual(fin.players[0].result, HUMAN_RESULT[expected]);
  assert.strictEqual(fin.fly.counted, true);
  assert.strictEqual(h.store.policy.getState().games_played, 1);
  assert.strictEqual(h.xpCalls.length, 1);
  assert.strictEqual(h.xpCalls[0].result, HUMAN_RESULT[expected]);
});
atest('Fin de partie : statistiques RÉELLES (parties vécues, taux de victoire), pas de message « elle a appris »', async () => {
  const h = harness();
  h.store.policy.setState({ ...h.store.policy.getState(), games_played: 9, wins: 3, losses: 5, draws: 1 });   // 9 parties vécues avant celle-ci
  h.store.totals = { games: 9, wins: 3, losses: 5, draws: 1 };
  h.FLY.begin(h.game);
  for (let t = 1; t <= cfg.TURNS; t++) h.playTurn('HAUT');
  const f = h.finishedPayload().fly;
  assert.strictEqual(f.stats.brain.gamesPlayed, 10);                       // chiffres APRÈS cette partie
  assert.strictEqual(f.stats.brain.flyWins + f.stats.brain.humanityWins + f.stats.brain.draws, 10);
  assert.strictEqual(f.stats.brain.flyWins, 3 + (f.result === 'win' ? 1 : 0));
  assert.ok(Math.abs(f.stats.brain.winRate - f.stats.brain.flyWins / 10) < 1e-12);
  assert.ok(!('learned' in f));
  assert.ok(!/appris|learn/i.test(JSON.stringify(h.emits)));
});
atest('Tirage : table du mode normal sans pity / Charme / plancher ; même tirage pour les deux', async () => {
  const h = harness(); h.FLY.begin(h.game);
  assert.deepStrictEqual(h.state.lastPickArgs, [false, 0, undefined, undefined, 'fly']);
  const opts = h.human.currentOptions;
  h.humanPlay('HAUT'); h.fireReveal();
  const rev = h.emits.find(e => e.event === 'fly_choice_revealed').payload;
  assert.ok([opts.haut.name, opts.bas.name].includes(rev.pokemon.name));
  assert.strictEqual(rev.basePoints, (rev.pokemon.name === opts.haut.name ? opts.haut : opts.bas).basePoints);
});
atest('OBSERVATION : seulement identité + shiny + types ; décision prise AVANT le choix humain', async () => {
  const h = harness(); const seen = [];
  const orig = h.store.choose; h.store.choose = obs => { seen.push(JSON.parse(JSON.stringify(obs))); return orig(obs); };
  h.FLY.begin(h.game);
  const decided = h.game.fly.decision;
  assert.ok(decided && (decided.index === 0 || decided.index === 1));
  h.humanPlay('BAS');
  assert.strictEqual(h.game.fly.decision, decided);                         // inchangée par le choix humain
  h.fireReveal(); const scoreAfter1 = h.human.score; h.nextTurn();
  assert.strictEqual(seen.length, 2);
  seen.forEach(o => {
    assert.deepStrictEqual(Object.keys(o).sort(), ['oppScore', 'options', 'ownScore', 'turn']);
    o.options.forEach(x => {
      assert.deepStrictEqual(Object.keys(x).sort(), ['pokemonId', 'shiny', 'types']);   // ni points de base, ni rareté, ni effet
      assert.ok(Array.isArray(x.types) && x.types.length >= 1);
    });
  });
  assert.strictEqual(seen[0].oppScore, 0);
  assert.strictEqual(seen[1].oppScore, scoreAfter1);                        // score humain d'AVANT le tour courant
});
atest('Résultat de SON choix mémorisé (jamais l\'option non choisie) ; valeurs apprises seulement à la fin d\'une partie complète', async () => {
  const h = harness(); h.FLY.begin(h.game);
  const picked = [], notPicked = [];
  for (let t = 1; t <= cfg.TURNS; t++) {
    const o = h.human.currentOptions, d = h.game.fly.decision;
    const mine = d.index === 0 ? o.haut : o.bas, other = d.index === 0 ? o.bas : o.haut;
    picked.push(mine); notPicked.push(other);
    h.humanPlay('HAUT'); h.fireReveal();
    assert.strictEqual(h.game.fly.decision.outcome.points, mine.basePoints);        // observé à la révélation
    if (t < cfg.TURNS) {
      assert.strictEqual(Object.keys(h.store.policy.getState().ids).length, 0);     // rien n'est appris en cours de partie
      h.nextTurn();
    }
  }
  h.nextTurn();                                                                      // fin de partie
  const ids = h.store.policy.getState().ids;
  picked.forEach(p => assert.ok(ids[p.pokemonId], `valeur de ${p.pokemonId} apprise`));
  const pickedIds = new Set(picked.map(p => p.pokemonId));
  notPicked.filter(o => !pickedIds.has(o.pokemonId)).forEach(o => assert.ok(!ids[o.pokemonId], `option non choisie ${o.pokemonId} ne doit pas être apprise`));
  const onePick = picked.find(p => picked.filter(q => q.pokemonId === p.pokemonId).length === 1);
  if (onePick) assert.strictEqual(ids[onePick.pokemonId][0], onePick.basePoints);
});
atest('Aucune fuite avant révélation : événements sans décision, valeurs ni probabilités ; options publiques minimales', async () => {
  const h = harness(); h.FLY.begin(h.game);
  assert.deepStrictEqual(h.emits.map(e => e.event), ['game_started', 'your_item', 'turn_options', 'fly_thinking']);
  const txt = JSON.stringify(h.emits);
  assert.ok(!/probs|values|"ids"|weights|baseline|temperature|decision|"index"|finalPoints|multiplier|effectName|basePoints/.test(txt), txt.slice(0, 300));
  assert.deepStrictEqual(Object.keys(h.emits.find(e => e.event === 'fly_thinking').payload), ['turn']);
  const opts = h.emits.find(e => e.event === 'turn_options').payload;
  assert.deepStrictEqual(Object.keys(opts.haut).sort(), ['name', 'shiny', 'shinySprite', 'sprite']);
});
atest('Révélation différée : délai d\'hésitation dans [MIN, MAX] ; transition bloquée tant que non révélé', async () => {
  const h = harness(); h.FLY.begin(h.game);
  h.humanPlay('HAUT');
  assert.strictEqual(h.state.transitions, 0);
  const t = h.timers[h.timers.length - 1];
  assert.ok(t.ms >= cfg.HESITATION_MS_MIN && t.ms <= cfg.HESITATION_MS_MAX, `${t.ms}`);
  assert.ok(!h.emits.some(e => e.event === 'fly_choice_revealed'));
  h.fireReveal();
  assert.strictEqual(h.state.transitions, 1);
  const n = h.emits.filter(e => e.event === 'fly_choice_revealed').length;
  t.fn(); assert.strictEqual(h.emits.filter(e => e.event === 'fly_choice_revealed').length, n);   // une seule révélation par tour
});
atest('Abandon : timers annulés, plus aucune révélation, AUCUN apprentissage, ni compteur, ni XP', async () => {
  const h = harness(); h.FLY.begin(h.game);
  h.playTurn('HAUT'); h.playTurn('BAS'); h.humanPlay('HAUT');
  const pending = h.timers.filter(x => !x.cleared).pop();
  h.FLY.dispose(h.game);
  assert.ok(pending.cleared);
  const nRev = h.emits.filter(e => e.event === 'fly_choice_revealed').length;
  pending.fn();
  assert.strictEqual(h.emits.filter(e => e.event === 'fly_choice_revealed').length, nRev);
  h.FLY.finish(h.game);
  assert.strictEqual(h.finishedPayload(), undefined);
  assert.strictEqual(Object.keys(h.store.policy.getState().ids).length, 0);
  assert.deepStrictEqual([h.store.getPublicStats().brain.gamesPlayed, h.store.getPublicStats().global.gamesPlayed], [0, 0]);
  assert.strictEqual(h.xpCalls.length, 0);
});
atest('Fin prématurée (partie incomplète) : ni apprentissage ni XP', async () => {
  const h = harness(); h.FLY.begin(h.game);
  h.playTurn('HAUT'); h.playTurn('HAUT'); h.playTurn('BAS');
  h.FLY.finish(h.game);
  assert.strictEqual(h.finishedPayload().fly.counted, false);
  assert.strictEqual(h.store.getPublicStats().brain.gamesPlayed, 0);
  assert.strictEqual(h.xpCalls.length, 0);
});
atest('Reset du cerveau PENDANT la partie : la partie n\'est pas comptée, le score global ne bouge pas', async () => {
  const h = harness(); h.FLY.begin(h.game);
  for (let t = 1; t <= 3; t++) h.playTurn('HAUT');
  await h.store.reset();
  for (let t = 4; t <= cfg.TURNS; t++) h.playTurn('HAUT');
  const f = h.finishedPayload().fly;
  assert.strictEqual(f.counted, false);
  assert.strictEqual(f.stats.global.gamesPlayed, 0);
  assert.strictEqual(f.stats.brain.gamesPlayed, 0);
  assert.strictEqual(f.stats.generation, 2);
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
atest('Aucune mécanique de boss / type en fly : pas de boss, pas de bonus, aucun champ de type dans les payloads', async () => {
  const h = harness(); h.FLY.begin(h.game);
  for (let t = 1; t <= cfg.TURNS; t++) h.playTurn('HAUT');
  assert.strictEqual(h.game.boss, null);
  assert.strictEqual(h.human.typeBonus, undefined);
  const fin = h.finishedPayload();
  assert.strictEqual(fin.boss, null); assert.strictEqual(fin.players[0].typeBonus, null);
  assert.ok(!/weakness|counterType|affinity|typeMult|requiredPoints/.test(JSON.stringify(h.emits)));
  assert.ok(h.state.typeCalls > 0);                                          // les types sont lus (observation) sans être appliqués
});
atest('Types illisibles : la partie continue avec types [] ; décision impossible : choix aléatoire, partie non comptée', async () => {
  const h = harness(); h.FLY.begin(h.game);
  const g2 = harness();
  const g2deps = g2.FLY; assert.ok(g2deps);
  // 1. getTypes qui lève : types [] (la Mouche ne s'en sert pas : VALUE_USE_TYPES=false)
  const seen = [];
  const io = { to: () => ({ emit() {} }) };
  const rng = mulberry32(8), db = cleanDb(), store = newStore(db, tcfg, { warmup: false }), o0 = store.choose;
  store.choose = obs => { seen.push(obs); return o0(obs); };
  const FLY = createFlyGame({ io, store, config: tcfg, logger: silentLogger, timers: { set() {}, clear() {} }, deps: {
    pickPlayerTurnOptions: () => { const [a, b] = fakePair(rng); return { haut: a, bas: b }; }, teamMonFromReward: r => r, buildRoute: () => [], getPublicPlayers: () => [],
    maybeScheduleTurnTransition() {}, getTypes: () => { throw new Error('types introuvables'); } } });
  const game = { id: 'X', gameMode: 'fly', status: 'playing', turn: 0, maxTurns: 6, players: [{ id: 's', name: 'H', score: 0, team: [] }] };
  FLY.begin(game);
  assert.deepStrictEqual(seen[0].options.map(o => o.types), [[], []]);
  // 2. observation invalide (identifiant absent) : choix aléatoire, partie non utilisable
  const bad = harness({ optionsFn: () => { const [a, b] = fakePair(mulberry32(3)); return { haut: { ...a, pokemonId: 0 }, bas: b }; } });
  bad.FLY.begin(bad.game);
  for (let t = 1; t <= cfg.TURNS; t++) bad.playTurn('HAUT');
  assert.strictEqual(bad.finishedPayload().fly.counted, false);
  assert.strictEqual(bad.store.getPublicStats().brain.gamesPlayed, 0);
  assert.strictEqual(bad.xpCalls.length, 0);
});
atest('Reconnexion : état public sans décision en attente ni valeurs apprises', async () => {
  const h = harness(); h.FLY.begin(h.game);
  h.playTurn('HAUT'); h.humanPlay('BAS');
  h.FLY.resyncTurn(h.game, 'newSock');
  const st = h.emits.filter(e => e.event === 'fly_state').pop();
  assert.strictEqual(st.room, 'newSock');
  assert.strictEqual(st.payload.history.length, 1);                          // seul le tour 1 est révélé
  assert.strictEqual(st.payload.thinking, true);
  assert.ok(!/probs|values|"ids"|weights|decision|"index"/.test(JSON.stringify(st.payload)));
});
atest('game_started annonce l\'échauffement et la génération (stats publiques)', async () => {
  const h = harness({ warmup: true }); await h.store.load(); h.FLY.begin(h.game);
  const st = h.emits.find(e => e.event === 'game_started').payload.fly;
  assert.deepStrictEqual([st.generation, st.brain.warmupGames, st.brain.gamesPlayed], [1, tcfg.WARMUP_GAMES, 0]);
});

console.log('\nG) XP contre la Mouche : plafond glissant 24 h');
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


console.log('\nH) Branchement de server.js (node patch-server-fly.js)');
{
  const src = readServer() || '';
  const patched = src.includes('FLY.begin(game)') && src.includes("require('./fly-warmup')");
  const fnBody = name => { const i = src.indexOf(`function ${name}(`); return src.slice(i, src.indexOf('\n}\n', i)); };
  test('server.js patché (version courante)', () => assert.ok(patched, 'lance : node patch-server-fly.js'));
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
    test('Abandon : dispose avant suppression de la partie ; seul fly-game.finish() met le cerveau à jour', () => {
      assert.ok(/FLY\.dispose\(game\);[^\n]*\n\s*delete games\[gameId\]/.test(src));
      assert.ok(/FLY\.dispose\(oldGame\)/.test(src));
      assert.strictEqual((src.match(/\.recordGame\(/g) || []).length, 0);
    });
    test('Le client ne peut rien demander sur la Mouche ; le serveur n\'expose ni décision ni valeurs', () => {
      assert.ok(!/socket\.on\('fly/.test(src));
      assert.ok(!/fly\.decision|flyBrain\.choose|\.policy\b/.test(src));
    });
    test('Bloc d\'initialisation : cerveau chargé, échauffement sur les VRAIS tirages, flush au SIGTERM, routes admin et stats', () => {
      assert.ok(src.includes('flyBrain.load()') && src.includes('flyBrain.flush()') && src.includes('registerFlyAdminRoutes(app'));
      assert.ok(/const flyDraw = \(\) => \{ const o = pickPlayerTurnOptions\(false, 0, undefined, undefined, 'fly'\)/.test(src));
      assert.ok(/warmup: policy => runWarmup\(\{ policy, draw: flyDraw, bst: flyBst, typesById: flyTypes \}\)/.test(src));
      const m = src.match(/app\.get\('\/api\/fly\/stats', \(req, res\) => \{([\s\S]*?)\n\}\);/);
      assert.ok(m && /res\.json\(flyBrain\.getPublicStats\(\)\)/.test(m[1]) && !/policy|weights|getState/.test(m[1]));
    });
    test('Identifiants du bloc d\'initialisation tous déclarés dans server.js', () => {
      ['app', 'io', 'supabase', 'createAuthClient', 'XP_PARTICIPATION', 'XP_VICTORY_BONUS', 'BOSS_MECHANICS', 'POKEMON_POOLS', 'pickPlayerTurnOptions',
        'teamMonFromReward', 'buildRoute', 'getPublicPlayers', 'maybeScheduleTurnTransition'].forEach(n =>
        assert.ok(new RegExp(`^(const|let|var|function|async function)\\s+${n}\\b`, 'm').test(src), `${n} non déclaré`));
    });
    test('Types : simple lecture (getTypes), jamais syncTypeBonus dans le bloc fly', () => {
      const i = src.indexOf("// ---- MODE 'fly'"), j = src.indexOf('const PORT = process.env.PORT');
      assert.ok(i > 0 && j > i);
      assert.ok(!/syncTypeBonus|applyBossMechanics|beginRouteGameplay/.test(src.slice(i, j)));
    });
  }
  test('fly-game.js : seuls les événements autorisés sont émis, aucun champ interne dans les payloads', () => {
    const g = fs.readFileSync(path.join(__dirname, 'fly-game.js'), 'utf8');
    const events = [...g.matchAll(/\.emit\('([a-z_]+)'/g)].map(m => m[1]);
    assert.deepStrictEqual([...new Set(events)].sort(), ['fly_choice_revealed', 'fly_state', 'fly_thinking', 'game_finished', 'game_started', 'turn_options', 'your_item']);
    g.split('\n').filter(l => l.includes('.emit(')).forEach(l => assert.ok(!/probs|values|weights|baseline|decision|trajectory|reward\b/.test(l), l));
  });
  test('debug-fly.js : jamais importé par le serveur ni le client ; s\'exécute si les données du projet sont présentes', () => {
    const dbg = path.join(__dirname, 'debug-fly.js');
    if (!fs.existsSync(dbg)) return console.log('      (ignoré : debug-fly.js absent)');
    assert.ok(!/debug-fly/.test(src));
    const cl = path.join(__dirname, 'public', 'client.js');
    if (fs.existsSync(cl)) assert.ok(!/debug-fly/.test(fs.readFileSync(cl, 'utf8')));
    const proxy = process.env.FLY_TEST_PROXY === '1';
    if (!proxy && !(fs.existsSync(path.join(__dirname, 'stats.js')) && src)) return console.log('      (exécution ignorée : stats.js ou server.js absent)');
    const out = require('child_process').execFileSync(process.execPath, [dbg, '--warmup', '40', '--draws', '2', '--top', '2', ...(proxy ? ['--proxy'] : [])], { encoding: 'utf8', cwd: __dirname });
    assert.ok(/CERVEAU/.test(out) && /Tirage 1/.test(out) && /valeur estimée/.test(out) && /caché/.test(out));
  });
}


console.log('\nI) Diagnostic de persistance (check-fly-db.js)');
const { diagnose, hint } = require('./check-fly-db');
function stubSb({ colsErr, row = null, rowErr, snapErr, writeErr, writeEmpty, noUpdate } = {}) {
  const res = v => Promise.resolve(v);
  const err = m => (m ? { message: m } : null);
  return { from: t => ({
    select: cols => ({
      limit: () => res(t === 'fly_brain' && cols.startsWith('generation') ? { data: colsErr ? null : [], error: err(colsErr) } : t === 'fly_brain' ? { data: [], error: null } : { data: snapErr ? null : [], error: err(snapErr) }),
      eq: () => ({ maybeSingle: () => res({ data: rowErr ? null : row, error: err(rowErr) }) })
    }),
    update: () => { if (noUpdate) throw new Error('écriture interdite en mode --no-write'); return { eq: () => ({ select: () => res(writeErr ? { data: null, error: err(writeErr) } : { data: writeEmpty ? [] : [{ id: 1 }], error: null }) }) }; }
  }) };
}
const goodRow = (o = {}) => ({ id: 1, weights: { kind: 'value', version: 1 }, generation: 2, games_played: 5, total_games: 7, total_wins: 4, total_losses: 2, total_draws: 1, updated_at: new Date(Date.now() - 3 * 60000).toISOString(), ...o });
const txt = r => r.lines.join('\n');
atest('Diagnostic : base correcte -> verdict OK, chiffres réels affichés, projet identifié', async () => {
  const r = await diagnose(stubSb({ row: goodRow() }), { host: 'abc.supabase.co' });
  assert.ok(r.ok); assert.deepStrictEqual(r.problems, []);
  assert.ok(/abc\.supabase\.co/.test(txt(r)) && /génération 2/.test(txt(r)) && /Humanité 2 – Mouche 4/.test(txt(r)) && /il y a 3 min/.test(txt(r)) && /écriture possible/.test(txt(r)));
  assert.ok(/VERDICT : la base est correcte/.test(txt(r)));
});
atest('Diagnostic : colonnes v2 absentes -> demande fly-brain-v2.sql + redémarrage', async () => {
  const r = await diagnose(stubSb({ colsErr: 'column fly_brain.generation does not exist', row: goodRow() }));
  assert.ok(!r.ok);
  assert.ok(/fly-brain-v2\.sql/.test(txt(r)) && /REDÉMARRE/.test(txt(r)) && /repart à zéro/.test(txt(r)));
});
atest('Diagnostic : table absente, droits refusés, clé refusée, projet injoignable -> conseil précis', async () => {
  assert.ok(/n'existe pas dans CE projet/.test(hint('relation "public.fly_brain" does not exist')));
  assert.ok(/service_role/.test(hint('permission denied for table fly_brain')));
  assert.ok(/SUPABASE_SECRET_KEY/.test(hint('Invalid API key')));
  assert.ok(/SUPABASE_URL/.test(hint('fetch failed')));
  assert.strictEqual(hint('erreur inconnue'), null);
  const r = await diagnose(stubSb({ colsErr: 'relation "public.fly_brain" does not exist' }));
  assert.ok(!r.ok && /n'existe pas dans CE projet/.test(txt(r)));
});
atest('Diagnostic : écriture refusée ou sans effet -> problème signalé', async () => {
  assert.ok(!(await diagnose(stubSb({ row: goodRow(), writeErr: 'permission denied for table fly_brain' }))).ok);
  const r = await diagnose(stubSb({ row: goodRow(), writeEmpty: true }));
  assert.ok(!r.ok && /aucune ligne/.test(txt(r)));
});
atest('Diagnostic : modèle illisible en base -> commande de suppression ; ligne absente = pas une erreur', async () => {
  const bad = await diagnose(stubSb({ row: goodRow({ weights: { kind: 'linear' } }) }));
  assert.ok(!bad.ok && /delete from fly_brain/.test(txt(bad)));
  const none = await diagnose(stubSb({ row: null }));
  assert.ok(none.ok && /aucune ligne id = 1/.test(txt(none)));
});
atest('Diagnostic : --no-write ne tente aucune écriture ; lecture seule des archives', async () => {
  const r = await diagnose(stubSb({ row: goodRow(), noUpdate: true }), { write: false });
  assert.ok(r.ok && !/écriture possible/.test(txt(r)));
  const s = await diagnose(stubSb({ row: goodRow(), snapErr: 'column fly_brain_snapshots.generation does not exist' }), { write: false });
  assert.ok(!s.ok && /fly-brain-v2\.sql/.test(txt(s)));
});

(async () => {
  for (const { name, fn } of asyncTests) {
    try { await fn(); pass++; console.log(`  ✔ ${name}`); }
    catch (e) { fail++; console.log(`  ✘ ${name}\n      ${e.message}`); }
  }
  console.log(`\n${pass} réussi(s), ${fail} échec(s)`);
  process.exit(fail ? 1 : 0);
})();

