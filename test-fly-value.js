#!/usr/bin/env node
'use strict';
// Tests de la politique « valeur par Pokémon » (v2).  node test-fly-value.js
const assert = require('assert');
const cfg = require('./fly-config');
const { ValuePolicy } = require('./fly-value-policy');

let pass = 0, fail = 0;
const test = (name, fn) => { try { fn(); pass++; console.log(`  ✔ ${name}`); } catch (e) { fail++; console.log(`  ✘ ${name}\n      ${e.message}`); } };
const opt = (pokemonId, shiny = false, types = ['fire']) => ({ pokemonId, shiny, types });
const mkObs = (o = {}) => ({ turn: 1, ownScore: 0, oppScore: 0, options: [opt(1), opt(2)], ...o });
function game(p, picks, points) {            // picks : index choisi par tour ; points : points de base observés
  const traj = [];
  for (let t = 1; t <= cfg.TURNS; t++) {
    const d = p.choose(mkObs({ turn: t, options: [opt(10 + t), opt(20 + t)] }));
    d.index = picks[t - 1]; d.picked = { pokemonId: d.index === 0 ? 10 + t : 20 + t, shiny: false, types: ['fire'] };
    p.observe(d, { basePoints: points[t - 1], finalPoints: points[t - 1] });
    traj.push(d);
  }
  return traj;
}
const sixOf = x => Array(cfg.TURNS).fill(x);

console.log('Politique valeur par Pokémon');
test('Observation : whitelist stricte (points, rareté, effet, choix adverse ignorés)', () => {
  const p = new ValuePolicy({ seed: 1 });
  const clean = mkObs(), dirty = mkObs();
  dirty.options = dirty.options.map(o => ({ ...o, basePoints: 999, rarity: 'legendaire', finalPoints: 1234, multiplier: 1.3, effectName: 'X' }));
  dirty.humanChoice = 0; dirty.boss = { id: 1 };
  assert.deepStrictEqual(p.evaluate(dirty), p.evaluate(clean));
  assert.throws(() => p.evaluate(mkObs({ options: [{ shiny: false }, opt(2)] })), /pokemonId/);
  assert.throws(() => p.evaluate(mkObs({ options: [opt(1), opt(2, false, ['a', 'b', 'c'])] })), /types/);
});
test('Déterministe avec seed ; départ uniforme', () => {
  const seq = s => { const p = new ValuePolicy({ seed: s }); return Array.from({ length: 40 }, () => p.choose(mkObs()).index).join(''); };
  assert.strictEqual(seq(3), seq(3)); assert.notStrictEqual(seq(3), seq(4));
  assert.ok(Math.abs(new ValuePolicy({ seed: 1 }).evaluate(mkObs()).probs[0] - 0.5) < 1e-12);
});
test('Apprentissage : le Pokémon qui rapporte plus est préféré ensuite', () => {
  const p = new ValuePolicy({ seed: 1 });
  p.learn(game(p, sixOf(0), sixOf(900)), 0, { result: 'win' });           // choisit l'id 10+t : 900 pts
  p.learn(game(p, sixOf(1), sixOf(200)), 0, { result: 'win' });           // choisit l'id 20+t : 200 pts
  const ev = p.evaluate(mkObs({ options: [opt(11), opt(21)] }));
  assert.ok(ev.probs[0] > 0.9, `${ev.probs}`);
});
test('Shiny : valeur ×SHINY appliquée à l\'estimation, pas à l\'apprentissage', () => {
  const p = new ValuePolicy({ seed: 1 });
  p.learn(game(p, sixOf(0), sixOf(500)), 0, {});
  const a = p.estimate(opt(11)), b = p.estimate(opt(11, true));
  assert.ok(Math.abs(b / a - cfg.SHINY_POINTS_MULTIPLIER) < 1e-9);
});
test('Le signal ne dépend pas de l\'humain : récompense et résultat n\'influencent PAS les valeurs', () => {
  const run = (reward, result) => { const p = new ValuePolicy({ seed: 1 }); p.learn(game(p, sixOf(0), [100, 200, 300, 400, 500, 600]), reward, { result }); return JSON.stringify({ ids: p.brain.ids, types: p.brain.types, global: p.brain.global }); };
  assert.strictEqual(run(1.5, 'win'), run(-1, 'loss'));
  assert.strictEqual(run(0, 'draw'), run(99999, 'win'));
});
test('Partie incomplète / mal formée / sans résultat observé : AUCUN apprentissage', () => {
  const p = new ValuePolicy({ seed: 1 });
  const t = game(p, sixOf(0), sixOf(500)), before = JSON.stringify(p.getState());
  assert.strictEqual(p.learn(t.slice(0, 5), 0).reason, 'incomplete');
  assert.strictEqual(p.learn(null, 0).reason, 'malformed');
  const noOutcome = t.map((d, i) => (i === 3 ? { ...d, outcome: null } : d));
  assert.strictEqual(p.learn(noOutcome, 0).reason, 'malformed');
  assert.strictEqual(JSON.stringify(p.getState()), before);
  assert.throws(() => p.observe(t[0], { basePoints: -5 }), /outcome/);
  assert.throws(() => p.observe(t[0], { basePoints: NaN }), /outcome/);
});
test('Compteurs : parties réelles vs échauffement simulé (à part)', () => {
  const p = new ValuePolicy({ seed: 1 });
  p.learn(game(p, sixOf(0), sixOf(1)), 0, { result: 'win' });
  p.learn(game(p, sixOf(0), sixOf(1)), 0, { result: 'loss' });
  p.learn(game(p, sixOf(0), sixOf(1)), 0, { simulated: true });
  const s = p.getState();
  assert.deepStrictEqual([s.games_played, s.wins, s.losses, s.draws, s.warmup_games], [2, 1, 1, 0, 1]);
  assert.strictEqual(p.experience(), 3);
});
test('Température : décroît avec l\'expérience (réelle + échauffement), plancher respecté', () => {
  const p = new ValuePolicy({ seed: 1 });
  assert.ok(Math.abs(p.temperature(0) - cfg.VALUE_TEMP_START) < 1e-12);
  assert.ok(p.temperature(300) < p.temperature(50));
  assert.ok(p.temperature(1e9) >= cfg.VALUE_TEMP_FLOOR && p.temperature(1e9) < cfg.VALUE_TEMP_FLOOR + 1e-6);
});
test('Types : a priori pour un Pokémon jamais vu, seulement si VALUE_USE_TYPES', () => {
  const mk = use => new ValuePolicy({ seed: 1, config: { ...cfg, VALUE_USE_TYPES: use } });
  const train = p => { const t = game(p, sixOf(0), sixOf(800)); t.forEach(d => { d.picked.types = ['dragon']; }); p.learn(t, 0, {}); };
  const on = mk(true), off = mk(false); train(on); train(off);
  const unseenDragon = opt(999, false, ['dragon']), unseenOther = opt(998, false, ['bug']);
  assert.ok(on.estimate(unseenDragon) > on.estimate(unseenOther) - 1e-9);
  assert.strictEqual(off.estimate(unseenDragon), off.estimate(unseenOther));
});
test('État : aller-retour exact ; état invalide ou de l\'ancien modèle rejeté ; copie défensive', () => {
  const p = new ValuePolicy({ seed: 1 });
  p.learn(game(p, sixOf(0), [100, 200, 300, 400, 500, 600]), 0, { result: 'win' });
  const q = new ValuePolicy({ seed: 2, state: JSON.parse(JSON.stringify(p.getState())) });
  assert.deepStrictEqual(q.getState(), p.getState());
  assert.deepStrictEqual(q.evaluate(mkObs()).probs, p.evaluate(mkObs()).probs);
  const bad = x => assert.throws(() => new ValuePolicy({ state: x }), /invalide/);
  bad({ ...p.getState(), kind: 'linear' });
  bad({ ...p.getState(), ids: { 1: [NaN, 1] } });
  bad({ ...p.getState(), ids: { 1: [5, -1] } });
  bad({ ...p.getState(), games_played: -1 });
  bad({ kind: 'linear', featureNames: [], weights: [], baseline: 0, games_played: 0, wins: 0, losses: 0, draws: 0 });
  p.getState().ids[11][0] = 99999; assert.notStrictEqual(p.getState().ids[11][0], 99999);
});
test('Taille de l\'état bornée (1025 Pokémon connus < 100 Ko)', () => {
  const p = new ValuePolicy({ seed: 1 });
  for (let i = 1; i <= 1025; i++) p.brain.ids[i] = [Math.random() * 1000, 50];
  assert.ok(JSON.stringify(p.getState()).length < 100000);
});
console.log(`\n${pass} réussi(s), ${fail} échec(s)`);
process.exit(fail ? 1 : 0);
