'use strict';
// =====================================================================
// MOTEUR DE POINTS (serveur uniquement — le client ne calcule jamais rien)
//   Base Stats officielles -> BST -> catégorie -> multiplicateur -> basePoints
// La catégorie est déterminée avec le BST ORIGINAL, avant tout multiplicateur.
// Aucune Base Stat n'est écrite en dur : elles viennent de data/pokemon-stats.json
// (généré par `node fetch-stats.js` depuis PokéAPI).
// =====================================================================
const fs = require('fs');
const path = require('path');
const defaultConfig = require('./stats-config');

const STAT_KEYS = ['hp', 'attack', 'defense', 'specialAttack', 'specialDefense', 'speed'];

// BST = somme des 6 Base Stats (lève une erreur si une stat manque ou est invalide).
function computeBst(stats) {
  let sum = 0;
  for (const key of STAT_KEYS) {
    const v = stats && stats[key];
    if (!Number.isInteger(v) || v <= 0) throw new Error(`Base Stat invalide "${key}" : ${v}`);
    sum += v;
  }
  return sum;
}

// Catégorie d'un Pokémon ordinaire selon son BST : seuils inclusifs, du plus haut au plus bas.
// Les seuils sont TOUJOURS passés explicitement (jamais lus en global) pour rester injectables.
function categoryByBst(bst, thresholds) {
  const ordered = Object.entries(thresholds).sort((a, b) => b[1] - a[1]);
  for (const [cat, min] of ordered) if (bst >= min) return cat;
  return 'commun';
}

// Méga -> Ultra-Chimère -> Fabuleux -> Légendaire -> Semi-légendaire -> sinon seuils de BST.
function getCategory(id, bst, config = defaultConfig) {
  return config.getSpecialCategory(id) || categoryByBst(bst, config.CATEGORY_THRESHOLDS);
}

// Arrondi unique pour tout le jeu.
function computeBasePoints(bst, category, config = defaultConfig) {
  const multiplier = config.CATEGORY_MULTIPLIERS[category];
  if (typeof multiplier !== 'number') throw new Error(`Multiplicateur inconnu pour la catégorie "${category}"`);
  return Math.round(bst * multiplier);
}

// Construit toutes les entrées { id, name, stats, bst, rarity, multiplier, basePoints }.
// roster : [{ id, name }] — stats : { [id]: { hp, attack, ... } }
function buildEntries(roster, stats, config = defaultConfig) {
  const missing = roster.filter(r => !stats[r.id]).map(r => r.id);
  if (missing.length) {
    throw new Error(
      `Base Stats manquantes pour ${missing.length} Pokémon (ex. ${missing.slice(0, 8).join(', ')}). ` +
      'Lance `node fetch-stats.js` pour compléter data/pokemon-stats.json.'
    );
  }
  return roster.map(({ id, name }) => {
    const s = stats[id];
    const bst = computeBst(s);
    const rarity = getCategory(id, bst, config);
    return {
      id, name,
      stats: Object.fromEntries(STAT_KEYS.map(k => [k, s[k]])),
      bst,
      rarity,
      multiplier: config.CATEGORY_MULTIPLIERS[rarity],
      basePoints: computeBasePoints(bst, rarity, config)
    };
  });
}

function loadJson(file, hint) {
  if (!fs.existsSync(file)) throw new Error(`Fichier introuvable : ${file}. ${hint}`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

const ROSTER_FILE = path.join(__dirname, 'data', 'pokemon-roster.json');
const STATS_FILE = process.env.POKEMON_STATS_FILE || path.join(__dirname, 'data', 'pokemon-stats.json');

// Charge roster + stats depuis le disque et construit les entrées.
function loadEntries(config = defaultConfig) {
  const roster = loadJson(ROSTER_FILE, 'Le roster (id + nom) est versionné avec le projet.');
  const stats = loadJson(STATS_FILE, 'Lance `node fetch-stats.js` pour le générer.');
  return buildEntries(roster, stats, config);
}

module.exports = {
  STAT_KEYS, ROSTER_FILE, STATS_FILE,
  computeBst, categoryByBst, getCategory, computeBasePoints, buildEntries, loadEntries
};