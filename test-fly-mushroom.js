#!/usr/bin/env node
'use strict';
// Tests du modèle « corps pédonculé » (6a).  node test-fly-mushroom.js
const assert = require('assert');
const cfg = require('./fly-config');
const { MushroomPolicy } = require('./fly-mushroom-policy');
const { ValuePolicy } = require('./fly-value-policy');

let pass = 0, fail = 0;
const test = (name, fn) => { try { fn(); pass++; console.log(`  ✔ ${name}`); } catch (e) { fail++; console.log(`  ✘ ${name}\n      ${e.message}`); } };
const opt = (pokemonId, shiny = false, types = ['fire']) => ({ pokemonId, shiny, types });
const mkObs = (o = {}) => ({ turn: 1, ownScore: 0, oppScore: 0, options: [opt(1), opt(2)], ...o });
function game(p, picks, points, ids) {
  const traj = [];
  for (let t = 1; t <= cfg.TURNS; t++) {
    const a = ids ? ids[t - 1][0] : 10 + t, b = ids ? ids[t - 1][1] : 20 + t;
    const d = p.choose(mkObs({ turn: t, options: [opt(a), opt(b)] }));
    d.index = picks[t - 1]; d.picked = { pokemonId: d.index === 0 ? a : b, shiny: false, types: ['fire'] };
    d.expected = p.readout(p.kcCode(d.picked.pokemonId)).value;
    p.observe(d, { basePoints: points[t - 1], finalPoints: points[t - 1] });
    traj.push(d);
  }
  return traj;
}
const six = x => Array(cfg.TURNS).fill(x);

console.log('Modèle corps pédonculé');
test('Interface identique à ValuePolicy (substituable)', () => {
  ['choose', 'observe', 'learn', 'getState', 'setState', 'evaluate', 'temperature', 'experience'].forEach(m => {
    assert.strictEqual(typeof MushroomPolicy.prototype[m], 'function', m);
    assert.strictEqual(typeof ValuePolicy.prototype[m], 'function', m);
  });
});
test('Observation : whitelist stricte (points, rareté, effet, choix adverse ignorés)', () => {
  const p = new MushroomPolicy({ seed: 1 });
  const dirty = mkObs();
  dirty.options = dirty.options.map(o => ({ ...o, basePoints: 999, rarity: 'legendaire', finalPoints: 1234, multiplier: 1.3 }));
  dirty.humanChoice = 0;
  assert.deepStrictEqual(p.evaluate(dirty), p.evaluate(mkObs()));
  assert.throws(() => p.evaluate(mkObs({ options: [{ shiny: false }, opt(2)] })), /pokemonId/);
});
test('Câblage et codes KC : déterministes, parcimonieux (MB_SPARSITY), propres à chaque Pokémon', () => {
  const a = new MushroomPolicy({ seed: 1 }), b = new MushroomPolicy({ seed: 99 });
  const n = Math.round(cfg.MB_SPARSITY * cfg.MB_KC);
  assert.deepStrictEqual(Array.from(a.kcCode(7)), Array.from(b.kcCode(7)));        // ne dépend pas de la graine de jeu
  assert.strictEqual(a.kcCode(7).length, n);
  assert.strictEqual(new Set(a.kcCode(7)).size, n);
  assert.ok(a.kcCode(7).every(i => i >= 0 && i < cfg.MB_KC));
  assert.strictEqual(a.kcCode(7), a.kcCode(7));                                    // cache
  const common = a.kcCode(7).filter(i => a.kcCode(8).includes(i)).length;
  assert.ok(common < n * 0.5, `chevauchement ${common}/${n}`);                     // codes presque disjoints
});
test('Un code KC ne dépend que de (graine de câblage, identité) : inchangé après apprentissage et cache vidé', () => {
  const p = new MushroomPolicy({ seed: 1 });
  const before = Array.from(p.kcCode(500));
  p.learn(game(p, six(0), six(700)), 0, { result: 'win' });
  p.codes.clear();
  assert.deepStrictEqual(Array.from(p.kcCode(500)), before);
  assert.deepStrictEqual(Array.from(new MushroomPolicy({ seed: 77, state: p.getState() }).kcCode(500)), before);
});
test('Déterministe avec seed ; départ uniforme', () => {
  const seq = s => { const p = new MushroomPolicy({ seed: s }); return Array.from({ length: 40 }, () => p.choose(mkObs()).index).join(''); };
  assert.strictEqual(seq(3), seq(3)); assert.notStrictEqual(seq(3), seq(4));
  assert.ok(Math.abs(new MushroomPolicy({ seed: 1 }).evaluate(mkObs()).probs[0] - 0.5) < 1e-12);
});
test('Apprentissage : le Pokémon qui rapporte plus est préféré ensuite', () => {
  const p = new MushroomPolicy({ seed: 1 });
  for (let k = 0; k < 3; k++) {
    p.learn(game(p, six(0), six(900)), 0, { result: 'win' });
    p.learn(game(p, six(1), six(200)), 0, { result: 'win' });
  }
  const ev = p.evaluate(mkObs({ options: [opt(11), opt(21)] }));
  assert.ok(ev.probs[0] > 0.9, `${ev.probs}`);
  assert.ok(p.estimate(opt(11)) > 700 && p.estimate(opt(21)) < 350, `${p.estimate(opt(11))} ${p.estimate(opt(21))}`);
});
test('Dopamine : positive si mieux qu\'attendu, négative sinon ; renforce l\'approche / l\'évitement', () => {
  const p = new MushroomPolicy({ seed: 1 });
  p.learn(game(p, six(0), six(500)), 0, {});                            // tonus ≈ 500
  const d = p.choose(mkObs({ options: [opt(500), opt(501)] }));
  p.observe(d, { basePoints: 900 }); assert.ok(d.dopamine > 300, `${d.dopamine}`);
  const e = p.choose(mkObs({ options: [opt(502), opt(503)] }));
  p.observe(e, { basePoints: 100 }); assert.ok(e.dopamine < -300, `${e.dopamine}`);
  const before = p.readout(p.kcCode(700));
  const t = game(p, six(0), six(950), Array.from({ length: 6 }, () => [700, 701]));
  p.learn(t, 0, {});
  const after = p.readout(p.kcCode(700));
  assert.ok(after.approach > before.approach && after.value > before.value);
  const q = game(p, six(0), six(0), Array.from({ length: 6 }, () => [710, 711]));
  const b2 = p.readout(p.kcCode(710)); p.learn(q, 0, {});
  const a2 = p.readout(p.kcCode(710));
  assert.ok(a2.avoid > b2.avoid && a2.value < b2.value);
});
test('Shiny : ×SHINY appliqué à la sortie, pas à l\'apprentissage', () => {
  const p = new MushroomPolicy({ seed: 1 });
  p.learn(game(p, six(0), six(500)), 0, {});
  assert.ok(Math.abs(p.estimate(opt(11, true)) / p.estimate(opt(11)) - cfg.SHINY_POINTS_MULTIPLIER) < 1e-9);
});
test('Le signal ne dépend pas de l\'humain : récompense et résultat n\'influencent PAS les poids', () => {
  const run = (reward, result) => { const p = new MushroomPolicy({ seed: 1 }); p.learn(game(p, six(0), [100, 200, 300, 400, 500, 600]), reward, { result }); const s = p.getState(); return JSON.stringify({ w: s.w, bias: s.bias }); };
  assert.strictEqual(run(1.5, 'win'), run(-1, 'loss'));
  assert.strictEqual(run(0, 'draw'), run(99999, 'win'));
});
test('Seuls les Pokémon CHOISIS sont appris (l\'option non choisie n\'est jamais lue)', () => {
  const p = new MushroomPolicy({ seed: 1 });
  p.learn(game(p, six(0), six(900)), 0, {});
  const untouched = p.estimate(opt(21)), bias = p.getState().bias[0];
  assert.ok(Math.abs(untouched - bias) < 150, `${untouched} vs tonus ${bias}`);   // un Pokémon jamais choisi vaut ≈ le tonus (la moyenne)
});
test('Partie incomplète / mal formée / sans résultat observé : AUCUN apprentissage', () => {
  const p = new MushroomPolicy({ seed: 1 });
  const t = game(p, six(0), six(500)), before = JSON.stringify(p.getState());
  assert.strictEqual(p.learn(t.slice(0, 5), 0).reason, 'incomplete');
  assert.strictEqual(p.learn(null, 0).reason, 'malformed');
  assert.strictEqual(p.learn(t.map((d, i) => (i === 3 ? { ...d, outcome: null } : d)), 0).reason, 'malformed');
  assert.strictEqual(JSON.stringify(p.getState()), before);
  assert.throws(() => p.observe(t[0], { basePoints: -5 }), /outcome/);
});
test('Compteurs : parties réelles vs échauffement simulé (à part)', () => {
  const p = new MushroomPolicy({ seed: 1 });
  p.learn(game(p, six(0), six(1)), 0, { result: 'win' });
  p.learn(game(p, six(0), six(1)), 0, { result: 'loss' });
  p.learn(game(p, six(0), six(1)), 0, { simulated: true });
  const s = p.getState();
  assert.deepStrictEqual([s.games_played, s.wins, s.losses, s.draws, s.warmup_games], [2, 1, 1, 0, 1]);
  assert.strictEqual(p.experience(), 3);
});
test('Activité exposée (pour l\'affichage 6c) : KC actifs du Pokémon choisi, approche / évitement ; jamais de probabilités dans activity', () => {
  const p = new MushroomPolicy({ seed: 1 });
  p.learn(game(p, six(0), six(800)), 0, {});
  const d = p.choose(mkObs({ options: [opt(11), opt(21)] }));
  assert.ok(Array.isArray(d.activity.kc) && d.activity.kc.length === Math.round(cfg.MB_SPARSITY * cfg.MB_KC));
  assert.deepStrictEqual(Object.keys(d.activity).sort(), ['approach', 'avoid', 'kc']);
  assert.ok(!/probs|temperature/.test(JSON.stringify(d.activity)));
});
test('État : aller-retour ; structure MB_* modifiée / autre modèle / données corrompues rejetés ; taille bornée', () => {
  const p = new MushroomPolicy({ seed: 1 });
  p.learn(game(p, six(0), [100, 200, 300, 400, 500, 600]), 0, { result: 'win' });
  const st = JSON.parse(JSON.stringify(p.getState()));
  const q = new MushroomPolicy({ seed: 2, state: st });
  assert.deepStrictEqual(q.getState(), p.getState());
  assert.deepStrictEqual(q.evaluate(mkObs()).probs, p.evaluate(mkObs()).probs);
  const bad = x => assert.throws(() => new MushroomPolicy({ state: x }), /invalide/);
  bad({ ...st, structure: { ...st.structure, K: st.structure.K + 1 } });
  bad({ ...st, structure: { ...st.structure, seed: 1 } });
  bad({ ...st, w: st.w.slice(1) });
  bad({ ...st, w: st.w.map(() => NaN) });
  bad({ ...st, kind: 'value' });
  bad({ ...st, games_played: -1 });
  assert.throws(() => new ValuePolicy({ state: st }), /invalide/);                 // un état « mushroom » n'entre pas dans ValuePolicy
  assert.throws(() => new MushroomPolicy({ state: new ValuePolicy({ seed: 1 }).getState() }), /invalide/);
  assert.ok(JSON.stringify(st).length < 100000, `${JSON.stringify(st).length} octets`);
  p.getState().w[0] = 999; assert.notStrictEqual(p.getState().w[0], 999);          // copie défensive
});
console.log(`\n${pass} réussi(s), ${fail} échec(s)`);
process.exit(fail ? 1 : 0);
