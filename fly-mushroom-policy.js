'use strict';
// =====================================================================
// LA MOUCHE — modèle « corps pédonculé » (étape 6a). Logique pure, aucune dépendance.
// ADVERSAIRE THÉMATIQUE INSPIRÉ de la structure du corps pédonculé de la drosophile ; ce n'est PAS un vrai
// cerveau de mouche, et le câblage ci-dessous est généré au hasard (le connectome réel viendrait en 6b).
//
//   Pokémon (identité) --PN--> neurones de Kenyon (KC) --synapses apprises--> neurones de sortie (MBON)
//   - PN : chaque Pokémon allume un motif fixe de neurones de projection (pseudo-aléatoire, dérivé de son id).
//   - KC : chaque KC lit MB_CLAWS PN au hasard ; une inhibition globale (type APL) ne garde que les MB_SPARSITY
//          plus actifs -> code parcimonieux, propre à chaque Pokémon.
//   - MBON : valeur = tonus b + somme des synapses KC->MBON des KC actifs. Partie positive = MBON « approche »,
//          partie négative = MBON « évitement » (lecture d'affichage).
//   - Dopamine : après le résultat de SON choix (points observés), δ = points − valeur attendue. Les synapses des
//          KC actifs bougent de MB_RATE × δ / (nb de KC actifs) : δ > 0 renforce l'approche / relâche l'évitement,
//          δ < 0 l'inverse. (Mathématiquement : une règle delta sur un code aléatoire parcimonieux.)
//
// Même interface que ValuePolicy : choose(obs) / observe(decision, outcome) / learn(trajectory, reward, opts) /
// getState / setState / evaluate / temperature / experience. Même observation (identité + shiny + types, types
// inutilisés ici), même signal (indépendant du jeu de l'humain), même exploration (VALUE_TEMP_*).
// =====================================================================
const defaultConfig = require('./fly-config');
const { mulberry32, outcomeFor, CHOICES } = require('./fly-value-policy');

const isNum = x => typeof x === 'number' && Number.isFinite(x);
const R6 = x => Math.round(x * 1e6) / 1e6;

// Hachage entier 32 bits (déterministe) -> [0, 1).
function hash01(a, b, c) {
  let h = Math.imul((a | 0) ^ 0x9E3779B9, 0x85EBCA6B) ^ Math.imul((b | 0) + 0x7F4A7C15, 0xC2B2AE35) ^ Math.imul((c | 0) + 0x165667B1, 0x27D4EB2F);
  h ^= h >>> 15; h = Math.imul(h, 0x2C1B3C6D); h ^= h >>> 12; h = Math.imul(h, 0x297A2D39); h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

function validateObs(obs, cfg) {
  if (!obs || !Number.isInteger(obs.turn) || obs.turn < 1 || obs.turn > cfg.TURNS) throw new Error('obs.turn invalide');
  if (!isNum(obs.ownScore) || !isNum(obs.oppScore)) throw new Error('obs.ownScore/oppScore invalides');
  if (!Array.isArray(obs.options) || obs.options.length !== 2) throw new Error('obs.options : 2 options requises');
  obs.options.forEach(o => { if (!o || !Number.isInteger(o.pokemonId) || o.pokemonId < 1) throw new Error('option.pokemonId invalide'); });
}

class MushroomPolicy {
  constructor({ config = defaultConfig, seed, rng, state } = {}) {
    this.cfg = config;
    this.rng = rng || mulberry32(seed === undefined ? (Date.now() ^ (Math.random() * 0x7fffffff)) : seed);
    this.K = config.MB_KC; this.P = config.MB_PN; this.claws = config.MB_CLAWS;
    this.active = Math.max(1, Math.round(config.MB_SPARSITY * this.K));
    this.conn = this._wire();                       // câblage PN -> KC (fixe, dérivé de MB_STRUCT_SEED)
    this.codes = new Map();                         // cache : id Pokémon -> KC actifs (Int32Array trié)
    this.brain = this._fresh();
    if (state) this.setState(state);
  }

  structure() { return { K: this.K, P: this.P, claws: this.claws, sparsity: this.cfg.MB_SPARSITY, seed: this.cfg.MB_STRUCT_SEED }; }
  _fresh() {
    return { kind: 'mushroom', version: 1, structure: this.structure(), w: new Array(this.K).fill(0), bias: [0, 0], games_played: 0, wins: 0, losses: 0, draws: 0, warmup_games: 0 };
  }
  static freshBrain(config = defaultConfig) { return new MushroomPolicy({ config, seed: 1 })._fresh(); }

  _wire() {
    const rng = mulberry32(this.cfg.MB_STRUCT_SEED), conn = new Int32Array(this.K * this.claws);
    for (let i = 0; i < this.K; i++) {
      const used = new Set();
      for (let c = 0; c < this.claws; c++) { let pn; do { pn = Math.floor(rng() * this.P); } while (used.has(pn)); used.add(pn); conn[i * this.claws + c] = pn; }
    }
    return conn;
  }

  // Code parcimonieux d'un Pokémon : les `active` KC les plus excités (inhibition globale type APL).
  kcCode(id) {
    let code = this.codes.get(id);
    if (code) return code;
    const pn = new Float64Array(this.P);
    for (let j = 0; j < this.P; j++) pn[j] = hash01(this.cfg.MB_STRUCT_SEED, id, j);
    const drive = new Float64Array(this.K);
    for (let i = 0; i < this.K; i++) { let s = 0; for (let c = 0; c < this.claws; c++) s += pn[this.conn[i * this.claws + c]]; drive[i] = s; }
    const order = Array.from({ length: this.K }, (_, i) => i).sort((a, b) => drive[b] - drive[a] || a - b);
    code = Int32Array.from(order.slice(0, this.active).sort((a, b) => a - b));
    this.codes.set(id, code);
    return code;
  }

  experience() { return this.brain.games_played + this.brain.warmup_games; }
  temperature(exp = this.experience()) {
    const c = this.cfg;
    return c.VALUE_TEMP_FLOOR + (c.VALUE_TEMP_START - c.VALUE_TEMP_FLOOR) * Math.exp(-exp / c.VALUE_TEMP_TAU);
  }

  // Lecture des MBON pour un code : { approach, avoid, value } (points de base ; valeur = tonus + approche − évitement).
  readout(code) {
    const w = this.brain.w; let a = 0, v = 0;
    for (let k = 0; k < code.length; k++) { const x = w[code[k]]; if (x > 0) a += x; else v -= x; }
    return { approach: a, avoid: v, value: this.brain.bias[0] + a - v };
  }
  estimate(o) { return this.readout(this.kcCode(o.pokemonId)).value * (o.shiny ? this.cfg.SHINY_POINTS_MULTIPLIER : 1); }

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
    const rd = this.readout(this.kcCode(o.pokemonId));
    return {
      index, choice: CHOICES[index], probs: ev.probs, temperature: ev.temperature,
      picked: { pokemonId: o.pokemonId, shiny: !!o.shiny, types: (o.types || []).slice() }, outcome: null,
      expected: rd.value, activity: { kc: Array.from(this.kcCode(o.pokemonId)), approach: rd.approach, avoid: rd.avoid }
    };
  }

  // Résultat de SON choix (jamais l'option non choisie). Calcule la « dopamine » affichable ; aucune mise à jour ici.
  observe(decision, { basePoints, finalPoints }) {
    const pts = this.cfg.VALUE_OBSERVE === 'final' && isNum(finalPoints) ? finalPoints / (decision.picked.shiny ? this.cfg.SHINY_POINTS_MULTIPLIER : 1) : basePoints;
    if (!isNum(pts) || pts < 0) throw new Error('outcome invalide');
    decision.outcome = { points: pts };
    decision.dopamine = pts - decision.expected;
    return decision;
  }

  // Fin de partie COMPLÈTE : applique, dans l'ordre des tours, la règle dopaminergique. `simulated` : échauffement.
  learn(trajectory, reward, { result, simulated = false } = {}) {
    const c = this.cfg;
    const ok = Array.isArray(trajectory) && trajectory.length === c.TURNS && trajectory.every(d =>
      d && (d.index === 0 || d.index === 1) && d.picked && Number.isInteger(d.picked.pokemonId) &&
      d.outcome && isNum(d.outcome.points) && d.outcome.points >= 0);
    if (!ok) return { learned: false, reason: Array.isArray(trajectory) && trajectory.length !== c.TURNS ? 'incomplete' : 'malformed' };
    const b = this.brain;
    for (const d of trajectory) {
      const y = d.outcome.points;
      b.bias[1] += 1; b.bias[0] += (y - b.bias[0]) * Math.max(1 / b.bias[1], c.VALUE_MIN_RATE);   // tonus = moyenne des points
      const code = this.kcCode(d.picked.pokemonId);
      const delta = y - this.readout(code).value;                                                   // dopamine : écart à l'attendu
      const step = c.MB_RATE * delta / code.length;
      for (let k = 0; k < code.length; k++) b.w[code[k]] += step;
    }
    if (simulated) b.warmup_games += 1;
    else {
      b.games_played += 1;
      if (result === 'win') b.wins += 1; else if (result === 'loss') b.losses += 1; else if (result === 'draw') b.draws += 1;
    }
    return { learned: true };
  }

  getState() {
    const b = this.brain;
    return { ...b, structure: { ...b.structure }, w: b.w.map(R6), bias: [R6(b.bias[0]), b.bias[1]] };
  }

  setState(state) {
    const s = this.structure();
    const ok = state && state.kind === 'mushroom' && state.version === 1 && state.structure &&
      ['K', 'P', 'claws', 'sparsity', 'seed'].every(k => state.structure[k] === s[k]) &&
      Array.isArray(state.w) && state.w.length === this.K && state.w.every(isNum) &&
      Array.isArray(state.bias) && state.bias.length === 2 && isNum(state.bias[0]) && Number.isInteger(state.bias[1]) && state.bias[1] >= 0 &&
      ['games_played', 'wins', 'losses', 'draws', 'warmup_games'].every(k => Number.isInteger(state[k]) && state[k] >= 0);
    if (!ok) throw new Error('État du cerveau invalide (kind/version/structure/poids/compteurs) — structure MB_* modifiée ?');
    this.brain = { ...this._fresh(), ...JSON.parse(JSON.stringify(state)) };
  }
}

module.exports = { MushroomPolicy, hash01, outcomeFor };
