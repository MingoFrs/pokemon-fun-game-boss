'use strict';
// =====================================================================
// LA MOUCHE v2 — politique « valeur par Pokémon ». Logique pure, aucune dépendance.
// Même interface que LinearPolicy : choose(obs) / learn(trajectory, reward, opts) / getState / setState.
//
// obs (SEULEMENT ce que verrait un humain ; tout autre champ est ignoré) :
//   { turn, ownScore, oppScore, options: [ {pokemonId, shiny, types}, {pokemonId, shiny, types} ] }
// Jamais : points de base, rareté, effet, finalPoints, choix adverse.
//
// Apprentissage : après chaque tour, la Mouche observe le résultat de SON propre choix (observe()).
// À la fin d'une partie COMPLÈTE, learn() met à jour la valeur estimée de chaque Pokémon choisi
// (moyenne glissante). Le signal (points du Pokémon choisi) ne dépend PAS du jeu de l'humain :
// un adversaire ne peut pas l'« empoisonner ». victoire/défaite ne servent qu'aux statistiques.
// =====================================================================
const defaultConfig = require('./fly-config');

const CHOICES = ['HAUT', 'BAS'];
const isNum = x => typeof x === 'number' && Number.isFinite(x);

function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function validateObs(obs, cfg) {
  if (!obs || !Number.isInteger(obs.turn) || obs.turn < 1 || obs.turn > cfg.TURNS) throw new Error('obs.turn invalide');
  if (!isNum(obs.ownScore) || !isNum(obs.oppScore)) throw new Error('obs.ownScore/oppScore invalides');
  if (!Array.isArray(obs.options) || obs.options.length !== 2) throw new Error('obs.options : 2 options requises');
  obs.options.forEach(o => {
    if (!o || !Number.isInteger(o.pokemonId) || o.pokemonId < 1) throw new Error('option.pokemonId invalide');
    if (o.types !== undefined && !(Array.isArray(o.types) && o.types.length <= 2 && o.types.every(t => typeof t === 'string'))) throw new Error('option.types invalide');
  });
}

// Résultat d'une partie du point de vue de la Mouche.
function outcomeFor(flyScore, humanScore) {
  if (flyScore > humanScore) return 'win';
  if (flyScore < humanScore) return 'loss';
  return 'draw';
}

class ValuePolicy {
  constructor({ config = defaultConfig, seed, rng, state } = {}) {
    this.cfg = config;
    this.rng = rng || mulberry32(seed === undefined ? (Date.now() ^ (Math.random() * 0x7fffffff)) : seed);
    this.brain = ValuePolicy.freshBrain();
    if (state) this.setState(state);
  }

  static freshBrain() {
    return { kind: 'value', version: 1, ids: {}, types: {}, global: [0, 0], games_played: 0, wins: 0, losses: 0, draws: 0, warmup_games: 0 };
  }

  experience() { return this.brain.games_played + this.brain.warmup_games; }

  temperature(exp = this.experience()) {
    const c = this.cfg;
    return c.VALUE_TEMP_FLOOR + (c.VALUE_TEMP_START - c.VALUE_TEMP_FLOOR) * Math.exp(-exp / c.VALUE_TEMP_TAU);
  }

  // A priori d'un Pokémon : moyenne de ses types (si activé) sinon moyenne globale.
  prior(types) {
    const b = this.brain;
    const g = b.global[0];
    if (!this.cfg.VALUE_USE_TYPES || !types || !types.length) return g;
    const means = types.map(t => (b.types[t] && b.types[t][1] > 0 ? b.types[t][0] : g));
    return means.reduce((s, x) => s + x, 0) / means.length;
  }

  // Valeur estimée (points de base) d'un Pokémon, retrait fait du shiny (appliqué ensuite).
  baseEstimate(o) {
    const e = this.brain.ids[o.pokemonId];
    const p = this.prior(o.types);
    if (!e || e[1] === 0) return p;
    const K = this.cfg.VALUE_PRIOR_STRENGTH;
    return (e[1] * e[0] + K * p) / (e[1] + K);
  }

  estimate(o) { return this.baseEstimate(o) * (o.shiny ? this.cfg.SHINY_POINTS_MULTIPLIER : 1); }

  evaluate(obs, temperature = this.temperature()) {
    validateObs(obs, this.cfg);
    const v = obs.options.map(o => this.estimate(o) / this.cfg.BASEPOINTS_SCALE);
    const m = Math.max(v[0], v[1]);
    const e = v.map(x => Math.exp((x - m) / temperature));
    const z = e[0] + e[1];
    return { values: v, probs: [e[0] / z, e[1] / z], temperature };
  }

  choose(obs, { greedy = false } = {}) {
    const ev = this.evaluate(obs);
    const index = greedy ? (ev.probs[1] > ev.probs[0] ? 1 : 0) : (this.rng() < ev.probs[0] ? 0 : 1);
    const o = obs.options[index];
    return {
      index, choice: CHOICES[index], probs: ev.probs, temperature: ev.temperature,
      picked: { pokemonId: o.pokemonId, shiny: !!o.shiny, types: (o.types || []).slice() }, outcome: null
    };
  }

  // Résultat de SON choix, visible après le tour (jamais l'option non choisie). Aucune mise à jour ici.
  observe(decision, { basePoints, finalPoints }) {
    const pts = this.cfg.VALUE_OBSERVE === 'final' && isNum(finalPoints) ? finalPoints / (decision.picked.shiny ? this.cfg.SHINY_POINTS_MULTIPLIER : 1) : basePoints;
    if (!isNum(pts) || pts < 0) throw new Error('outcome invalide');
    decision.outcome = { points: pts };
    return decision;
  }

  // Fin de partie COMPLÈTE : met à jour les valeurs. `simulated` : échauffement (compté à part).
  learn(trajectory, reward, { result, simulated = false } = {}) {
    const c = this.cfg;
    const ok = Array.isArray(trajectory) && trajectory.length === c.TURNS && trajectory.every(d =>
      d && (d.index === 0 || d.index === 1) && d.picked && Number.isInteger(d.picked.pokemonId) &&
      d.outcome && isNum(d.outcome.points) && d.outcome.points >= 0);
    if (!ok) return { learned: false, reason: Array.isArray(trajectory) && trajectory.length !== c.TURNS ? 'incomplete' : 'malformed' };
    const b = this.brain;
    const upd = (arr, y) => { arr[1] += 1; arr[0] += (y - arr[0]) * Math.max(1 / arr[1], c.VALUE_MIN_RATE); };
    for (const d of trajectory) {
      const y = d.outcome.points;
      const id = d.picked.pokemonId;
      if (!b.ids[id]) b.ids[id] = [0, 0];
      upd(b.ids[id], y);
      upd(b.global, y);
      for (const t of d.picked.types) { if (!b.types[t]) b.types[t] = [0, 0]; upd(b.types[t], y); }
    }
    if (simulated) b.warmup_games += 1;
    else {
      b.games_played += 1;
      if (result === 'win') b.wins += 1; else if (result === 'loss') b.losses += 1; else if (result === 'draw') b.draws += 1;
    }
    return { learned: true };
  }

  getState() { return JSON.parse(JSON.stringify(this.brain)); }

  setState(state) {
    const pairs = o => o && typeof o === 'object' && Object.values(o).every(p => Array.isArray(p) && p.length === 2 && isNum(p[0]) && Number.isInteger(p[1]) && p[1] >= 0);
    const ok = state && state.kind === 'value' && state.version === 1 && pairs(state.ids) && pairs(state.types) &&
      Array.isArray(state.global) && state.global.length === 2 && isNum(state.global[0]) && Number.isInteger(state.global[1]) &&
      ['games_played', 'wins', 'losses', 'draws', 'warmup_games'].every(k => Number.isInteger(state[k]) && state[k] >= 0);
    if (!ok) throw new Error('État du cerveau invalide (kind/version/ids/types/compteurs)');
    this.brain = { ...ValuePolicy.freshBrain(), ...JSON.parse(JSON.stringify(state)) };
  }
}

module.exports = { ValuePolicy, mulberry32, outcomeFor, CHOICES };
