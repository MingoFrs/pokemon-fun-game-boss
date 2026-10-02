'use strict';
// =====================================================================
// Environnement de SIMULATION du mode 'fly' (hors serveur) : tirages + joueurs simulés.
// RARITY_TABLE / EFFECTS / SHINY_* sont des COPIES de server.js (test-fly.js vérifie qu'elles
// n'ont pas divergé). Pools : données réelles (stats.loadEntries) si disponibles, sinon synthétiques.
// =====================================================================
const RARITY_TABLE = [
  { rarity: 'commun', weight: 0.39 },
  { rarity: 'peu_commun', weight: 0.26 },
  { rarity: 'rare', weight: 0.17 },
  { rarity: 'epique', weight: 0.11 },
  { rarity: 'pseudo_legendaire', weight: 0.04 },
  { rarity: 'legendaire', weight: 0.01 },
  { rarity: 'fabuleux', weight: 0.01 },
  { rarity: 'ultra_chimere', weight: 0.01 }
];
const EFFECTS = [
  { name: 'Neutre', multiplier: 1.0, weight: 75 },
  { name: 'Salzmann secret technique', multiplier: 1.2, weight: 3.125 },
  { name: 'Beauty privilege', multiplier: 1.3, weight: 3.125 },
  { name: 'Motivé', multiplier: 1.1, weight: 3.125 },
  { name: 'Sous steroïde', multiplier: 1.15, weight: 3.125 },
  { name: 'Sub-5', multiplier: 0.75, weight: 3.125 },
  { name: 'Lagging', multiplier: 0.8, weight: 3.125 },
  { name: 'Skill issues', multiplier: 0.6, weight: 3.125 },
  { name: 'Épine dans le pied', multiplier: 0.7, weight: 3.125 }
];
const SHINY_CHANCE = 0.02;
const SHINY_POINTS_MULTIPLIER = 1.5;

// Pools synthétiques (BST plausibles × multiplicateur de catégorie de stats-config.js).
function syntheticPools(rng) {
  const spec = {
    commun: [200, 330, 1], peu_commun: [330, 450, 1.2], rare: [450, 520, 1.3], epique: [520, 600, 1.35],
    pseudo_legendaire: [600, 600, 1.35], legendaire: [500, 680, 1.5], fabuleux: [600, 600, 1.5], ultra_chimere: [570, 600, 1.5]
  };
  const pools = {};
  let id = 1;
  for (const [r, [lo, hi, mult]] of Object.entries(spec)) {
    pools[r] = Array.from({ length: r === 'commun' || r === 'peu_commun' ? 60 : 25 }, () => ({
      id: id++, rarity: r, basePoints: Math.round((lo + rng() * (hi - lo)) * mult)
    }));
  }
  return pools;
}

function realPools(rarities) {
  try {
    const entries = require('./stats').loadEntries();
    const pools = {};
    rarities.forEach(r => { pools[r] = entries.filter(e => e.rarity === r).map(e => ({ id: e.id, rarity: r, basePoints: e.basePoints })); });
    return rarities.every(r => pools[r].length) ? pools : null;
  } catch (e) { return null; }
}

function weighted(rng, list, key) {
  const total = list.reduce((s, x) => s + x[key], 0);
  let roll = rng() * total;
  for (const x of list) { if (roll < x[key]) return x; roll -= x[key]; }
  return list[list.length - 1];
}

function createEnv({ rng, rarities, useReal = true }) {
  const real = useReal ? realPools(rarities) : null;
  const pools = real || syntheticPools(rng);
  function drawOne() {
    const rarity = weighted(rng, RARITY_TABLE, 'weight').rarity;
    const pool = pools[rarity];
    const p = pool[Math.floor(rng() * pool.length)];
    const effect = weighted(rng, EFFECTS, 'weight');
    const shiny = rng() < SHINY_CHANCE;
    return {
      pokemonId: p.id, rarity, basePoints: p.basePoints, effectName: effect.name, multiplier: effect.multiplier, shiny,
      finalPoints: Math.round(p.basePoints * effect.multiplier * (shiny ? SHINY_POINTS_MULTIPLIER : 1))
    };
  }
  // 2 options HAUT/BAS, jamais le même Pokémon (même garde que pickPlayerTurnOptions).
  function drawOptions() {
    const haut = drawOne();
    let bas = drawOne();
    for (let g = 0; bas.pokemonId === haut.pokemonId && g < 10; g++) bas = drawOne();
    return [haut, bas];
  }
  return { drawOptions, source: real ? 'données réelles' : 'pools synthétiques' };
}

// ---- Joueurs simulés : (options, rng) -> 0 (HAUT) | 1 (BAS) ----
const visibleValue = o => o.basePoints * (o.shiny ? SHINY_POINTS_MULTIPLIER : 1);
const argmaxBy = (opts, f, rng) => (f(opts[0]) === f(opts[1]) ? (rng() < 0.5 ? 0 : 1) : (f(opts[1]) > f(opts[0]) ? 1 : 0));
const HUMAN_POLICIES = {
  random: (opts, rng) => (rng() < 0.5 ? 0 : 1),
  greedy: (opts, rng) => argmaxBy(opts, o => o.finalPoints, rng),            // « prend le plus de points »
  mixed: (opts, rng) => (rng() < 0.5 ? argmaxBy(opts, o => o.finalPoints, rng) : (rng() < 0.5 ? 0 : 1)),
  troll: (opts, rng) => argmaxBy(opts, o => -o.finalPoints, rng)             // empoisonneur : prend le MOINS de points
};
// Références (pas des adversaires) : plafond atteignable par la Mouche compte tenu de ce qu'elle voit.
const REFERENCE_VISIBLE = (opts, rng) => argmaxBy(opts, visibleValue, rng);

module.exports = { createEnv, HUMAN_POLICIES, REFERENCE_VISIBLE, RARITY_TABLE, EFFECTS, SHINY_CHANCE, SHINY_POINTS_MULTIPLIER };
