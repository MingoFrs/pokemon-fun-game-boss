'use strict';
// =====================================================================
// ÉCHAUFFEMENT SIMULÉ de la Mouche : parties contre un joueur simulé, avec les vraies fonctions de tirage.
// Même code en production (server.js) et dans fly-validate.js (qui le calibre) : ce qui est validé est ce qui tourne.
//   draw()  -> [haut, bas]  (objets de buildRewardOption : pokemonId, shiny, basePoints, finalPoints...)
//   bst     -> { [pokemonId]: BST }  (le joueur simulé estime la valeur d'après le BST, PAS les points réels)
// Le joueur simulé : valeur perçue = BST × (1 + bruit gaussien σ) × (shiny ? ×SHINY : 1).
// =====================================================================
const defaultConfig = require('./fly-config');
const { mulberry32, outcomeFor } = require('./fly-value-policy');

function gauss(rng) { return Math.sqrt(-2 * Math.log(1 - rng())) * Math.cos(2 * Math.PI * rng()); }

// kind : 'noisy' (BST bruité, défaut) | 'mixed' (1 tour sur 2 au hasard) | 'random'
function simulatedHumanPick(opts, bst, rng, { noise = defaultConfig.WARMUP_HUMAN_NOISE, kind = 'noisy', shiny = defaultConfig.SHINY_POINTS_MULTIPLIER } = {}) {
  if (kind === 'random') return rng() < 0.5 ? 0 : 1;
  const perceived = o => (bst[o.pokemonId] || 0) * (1 + noise * gauss(rng)) * (o.shiny ? shiny : 1);
  const informed = perceived(opts[1]) > perceived(opts[0]) ? 1 : 0;
  return kind === 'mixed' && rng() < 0.5 ? (rng() < 0.5 ? 0 : 1) : informed;
}

// Une partie complète contre le joueur simulé. learn=true : échauffement (apprend, compté à part) ;
// learn=false : évaluation figée. Retourne 'win' | 'loss' | 'draw' (point de vue de la Mouche).
function playSimulatedGame({ policy, draw, typesById = {}, bst, rng, config = defaultConfig, learn = true, human = {} }) {
  let fly = 0, hum = 0;
  const traj = [];
  for (let turn = 1; turn <= config.TURNS; turn++) {
    const opts = draw();
    const obs = {
      turn, ownScore: fly, oppScore: hum,
      options: opts.map(o => ({ pokemonId: o.pokemonId, shiny: !!o.shiny, types: typesById[o.pokemonId] || [] }))
    };
    const d = policy.choose(obs);
    const mine = opts[d.index];
    policy.observe(d, { basePoints: mine.basePoints, finalPoints: mine.finalPoints });
    traj.push(d);
    fly += mine.finalPoints;
    hum += opts[simulatedHumanPick(opts, bst, rng, { noise: config.WARMUP_HUMAN_NOISE, shiny: config.SHINY_POINTS_MULTIPLIER, ...human })].finalPoints;
  }
  const result = outcomeFor(fly, hum);
  if (learn) policy.learn(traj, 0, { result, simulated: true });
  return result;
}

// Échauffement : `games` parties simulées (défaut : WARMUP_GAMES). Retourne { games, winRate }.
function runWarmup({ policy, draw, typesById, bst, config = defaultConfig, games = config.WARMUP_GAMES, seed }) {
  const rng = mulberry32(seed === undefined ? (Date.now() ^ (Math.random() * 0x7fffffff)) : seed);
  let pts = 0;
  for (let g = 0; g < games; g++) {
    const r = playSimulatedGame({ policy, draw, typesById, bst, rng, config, learn: true });
    pts += r === 'win' ? 1 : r === 'draw' ? 0.5 : 0;
  }
  return { games, winRate: games ? pts / games : null };
}

module.exports = { runWarmup, playSimulatedGame, simulatedHumanPick };
