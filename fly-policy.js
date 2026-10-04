'use strict';
// =====================================================================
// Choix du modèle de la Mouche (clé FLY_MODEL de fly-config.js).
// Seul 'value' (valeur par Pokémon) est accepté pour l'instant ; toute autre valeur LÈVE une erreur claire, ce qui fait
// échouer le démarrage du serveur plutôt que de jouer avec un modèle imprévu.
// Interface commune de tout modèle : choose(obs) / observe(decision, outcome) / learn(trajectory, reward, opts) /
// getState() / setState(state) (+ evaluate, temperature, experience).
// =====================================================================
const defaultConfig = require('./fly-config');
const { ValuePolicy } = require('./fly-value-policy');

const SUPPORTED = ['value'];

function assertFlyModel(config = defaultConfig) {
  if (!SUPPORTED.includes(config.FLY_MODEL)) {
    throw new Error(`FLY_MODEL invalide : ${JSON.stringify(config.FLY_MODEL)}. Seule la valeur 'value' est acceptée pour l'instant (fly-config.js).`);
  }
}

function createPolicy({ config = defaultConfig, seed, rng, state } = {}) {
  assertFlyModel(config);
  return new ValuePolicy({ config, seed, rng, state });
}

module.exports = { createPolicy, assertFlyModel, SUPPORTED };
