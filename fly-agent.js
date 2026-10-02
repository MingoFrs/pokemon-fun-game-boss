'use strict';
// =====================================================================
// LA MOUCHE — agent d'apprentissage par renforcement (ÉTAPE 1 : politique linéaire).
// Aucune dépendance, aucun accès réseau/DB/socket : logique pure, testable hors serveur.
//
// Interface commune à toutes les politiques (l'étape 2 remplacera seulement l'implémentation) :
//   policy.choose(obs)                -> decision { index, choice, probs, phis, temperature }
//   policy.learn(trajectory, reward)  -> { learned, reason?, advantage, stepNorm }
//   policy.getState() / policy.setState(state)
//
// obs (SEUL ce que verrait un humain ; tout autre champ est ignoré) :
//   { turn (1..TURNS), ownScore, oppScore,
//     options: [ {basePoints, rarity, shiny} (HAUT), {basePoints, rarity, shiny} (BAS) ] }
// Le multiplicateur d'effet, finalPoints et le choix de l'adversaire n'entrent JAMAIS ici.
//
// Algorithme : softmax(score_i / T) sur 2 options, score_i = w · φ_i ; REINFORCE avec baseline
// (moyenne mobile des récompenses) ; récompense unique en fin de partie.
// =====================================================================
const defaultConfig = require('./fly-config');

const CHOICES = ['HAUT', 'BAS'];
const FEATURE_NAMES = [
  'bp', 'rar', 'shiny',
  'bp*left', 'rar*left', 'shiny*left',
  'bp*gap', 'rar*gap', 'shiny*gap'
];

// PRNG déterministe (seed 32 bits).
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

function isNum(x) { return typeof x === 'number' && Number.isFinite(x); }
function clamp(x, lo, hi) { return Math.min(hi, Math.max(lo, x)); }

// ---------------------------------------------------------------------
// Observation -> features (whitelist stricte : seuls ces champs sont lus)
// ---------------------------------------------------------------------
function validateObs(obs, cfg) {
  if (!obs || !Number.isInteger(obs.turn) || obs.turn < 1 || obs.turn > cfg.TURNS) throw new Error('obs.turn invalide');
  if (!isNum(obs.ownScore) || !isNum(obs.oppScore)) throw new Error('obs.ownScore/oppScore invalides');
  if (!Array.isArray(obs.options) || obs.options.length !== 2) throw new Error('obs.options : 2 options requises');
  obs.options.forEach(o => {
    if (!o || !isNum(o.basePoints) || o.basePoints < 0) throw new Error('option.basePoints invalide');
    if (cfg.RARITIES.indexOf(o.rarity) < 0) throw new Error(`option.rarity inconnue : ${o && o.rarity}`);
  });
}

function extractFeatures(obs, cfg = defaultConfig) {
  validateObs(obs, cfg);
  const left = (cfg.TURNS - obs.turn) / (cfg.TURNS - 1);                   // 1 au tour 1, 0 au dernier
  const gap = Math.tanh((obs.ownScore - obs.oppScore) / cfg.GAP_SCALE);    // >0 : la Mouche mène
  return obs.options.map(o => {
    // « bp » = points VISIBLES : basePoints × (shiny ? ×SHINY : 1). Le bonus shiny est public (un humain le connaît) ;
    // le multiplicateur d'effet, lui, est secret et n'apparaît nulle part ici.
    const bp = o.basePoints * (o.shiny ? cfg.SHINY_POINTS_MULTIPLIER : 1) / cfg.BASEPOINTS_SCALE;
    const rar = cfg.RARITIES.indexOf(o.rarity) / (cfg.RARITIES.length - 1);
    const shiny = o.shiny ? 1 : 0;
    return [bp, rar, shiny, bp * left, rar * left, shiny * left, bp * gap, rar * gap, shiny * gap];
  });
}

// ---------------------------------------------------------------------
// Fin de partie : résultat, meilleur score possible, récompense
// ---------------------------------------------------------------------
function outcomeFor(flyScore, humanScore) {
  if (flyScore > humanScore) return 'win';
  if (flyScore < humanScore) return 'loss';
  return 'draw';
}

// turnsFinalPoints : [[finalPointsHAUT, finalPointsBAS] × TURNS] — calculé côté SERVEUR
// à partir des tirages réels ; jamais transmis à la Mouche pendant la partie.
function bestPossibleScore(turnsFinalPoints) {
  return turnsFinalPoints.reduce((s, pair) => s + Math.max(pair[0], pair[1]), 0);
}

function computeReward({ flyScore, humanScore, bestPossible }, cfg = defaultConfig) {
  const result = outcomeFor(flyScore, humanScore);
  const ratio = bestPossible > 0 ? clamp(flyScore / bestPossible, 0, 1) : 0;
  return { result, ratio, reward: cfg.RESULT_REWARD[result] + cfg.SCORE_WEIGHT * ratio };
}

// ---------------------------------------------------------------------
// Politique softmax linéaire + REINFORCE
// ---------------------------------------------------------------------
class LinearPolicy {
  constructor({ config = defaultConfig, seed, rng, state } = {}) {
    this.cfg = config;
    this.rng = rng || mulberry32(seed === undefined ? (Date.now() ^ (Math.random() * 0x7fffffff)) : seed);
    this.brain = LinearPolicy.freshBrain();
    if (state) this.setState(state);
  }

  static freshBrain() {
    return {
      kind: 'linear', featureNames: FEATURE_NAMES.slice(),
      weights: FEATURE_NAMES.map(() => 0), baseline: 0,
      games_played: 0, wins: 0, losses: 0, draws: 0
    };
  }

  // Température d'exploration : décroît avec le nombre de parties APPRISES, plancher TEMP_FLOOR.
  temperature(games = this.brain.games_played) {
    const c = this.cfg;
    return c.TEMP_FLOOR + (c.TEMP_START - c.TEMP_FLOOR) * Math.exp(-games / c.TEMP_TAU_GAMES);
  }

  // Calcul pur (aucun tirage aléatoire, aucun état modifié).
  evaluate(obs, temperature = this.temperature()) {
    const phis = extractFeatures(obs, this.cfg);
    const w = this.brain.weights;
    const logits = phis.map(phi => phi.reduce((s, x, k) => s + x * w[k], 0) / temperature);
    const m = Math.max(...logits);
    const e = logits.map(l => Math.exp(l - m));
    const z = e[0] + e[1];
    return { phis, probs: [e[0] / z, e[1] / z], temperature };
  }

  // Décision : tirage dans la distribution (jamais l'argmax, sauf { greedy: true } pour debug/éval).
  choose(obs, { greedy = false } = {}) {
    const ev = this.evaluate(obs);
    const index = greedy ? (ev.probs[1] > ev.probs[0] ? 1 : 0) : (this.rng() < ev.probs[0] ? 0 : 1);
    return { index, choice: CHOICES[index], probs: ev.probs, phis: ev.phis, temperature: ev.temperature };
  }

  // trajectory : decisions retournées par choose(), une par tour, dans l'ordre.
  // Une partie incomplète / mal formée n'entraîne RIEN (ni poids, ni baseline, ni compteurs).
  learn(trajectory, reward, { result } = {}) {
    const c = this.cfg;
    const F = FEATURE_NAMES.length;
    const ok = Array.isArray(trajectory) && trajectory.length === c.TURNS && trajectory.every(d =>
      d && (d.index === 0 || d.index === 1) && Array.isArray(d.probs) && d.probs.length === 2 &&
      d.probs.every(isNum) && Array.isArray(d.phis) && d.phis.length === 2 &&
      d.phis.every(p => Array.isArray(p) && p.length === F && p.every(isNum)) && isNum(d.temperature) && d.temperature > 0);
    if (!ok) return { learned: false, reason: Array.isArray(trajectory) && trajectory.length !== c.TURNS ? 'incomplete' : 'malformed' };
    if (!isNum(reward)) return { learned: false, reason: 'bad_reward' };

    const b = this.brain;
    const first = b.games_played === 0;
    const advantage = first ? 0 : clamp(reward - b.baseline, -c.ADVANTAGE_CLIP, c.ADVANTAGE_CLIP);

    // ∇ log π(a) = (φ_a − Σ_j p_j φ_j) / T   (probs/T de la décision : exact même politique que le tirage)
    const grad = new Array(F).fill(0);
    for (const d of trajectory) {
      for (let k = 0; k < F; k++) {
        const expected = d.probs[0] * d.phis[0][k] + d.probs[1] * d.phis[1][k];
        grad[k] += (d.phis[d.index][k] - expected) / d.temperature;
      }
    }
    let step = grad.map(g => c.LEARNING_RATE * advantage * g);
    const norm = Math.sqrt(step.reduce((s, x) => s + x * x, 0));
    if (norm > c.MAX_STEP_NORM) step = step.map(x => x * c.MAX_STEP_NORM / norm);
    const stepNorm = Math.min(norm, c.MAX_STEP_NORM);

    b.weights = b.weights.map((w, k) => clamp(w * (1 - c.WEIGHT_DECAY) + step[k], -c.WEIGHT_CLAMP, c.WEIGHT_CLAMP));
    const rate = Math.max(1 / (b.games_played + 1), c.BASELINE_RATE);
    b.baseline += rate * (reward - b.baseline);
    b.games_played += 1;
    if (result === 'win') b.wins += 1; else if (result === 'loss') b.losses += 1; else if (result === 'draw') b.draws += 1;
    return { learned: true, advantage, stepNorm };
  }

  getState() {
    const b = this.brain;
    return { ...b, featureNames: b.featureNames.slice(), weights: b.weights.slice() };
  }

  setState(state) {
    const ok = state && state.kind === 'linear' && Array.isArray(state.featureNames) &&
      state.featureNames.length === FEATURE_NAMES.length && state.featureNames.every((n, i) => n === FEATURE_NAMES[i]) &&
      Array.isArray(state.weights) && state.weights.length === FEATURE_NAMES.length && state.weights.every(isNum) &&
      isNum(state.baseline) && ['games_played', 'wins', 'losses', 'draws'].every(k => Number.isInteger(state[k]) && state[k] >= 0);
    if (!ok) throw new Error('État du cerveau invalide (kind/featureNames/weights/compteurs)');
    this.brain = { ...LinearPolicy.freshBrain(), ...state, featureNames: state.featureNames.slice(), weights: state.weights.slice() };
  }
}

module.exports = {
  LinearPolicy, extractFeatures, outcomeFor, bestPossibleScore, computeReward,
  mulberry32, FEATURE_NAMES, CHOICES
};
