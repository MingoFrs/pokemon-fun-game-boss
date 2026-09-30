'use strict';
// =====================================================================
// CONFIGURATION CENTRALE DU SYSTÈME DE POINTS
//   Base Stats (PokéAPI) -> BST -> catégorie -> multiplicateur -> basePoints
// Toute valeur modifiable (multiplicateurs, seuils, listes d'exceptions) est ICI, nulle part ailleurs.
// =====================================================================

// Clés internes des catégories. `commun` et `pseudo_legendaire` gardent leur ancienne clé
// (historique Supabase, succès, CSS) : seuls leurs libellés changent (Normal / Semi-légendaire).
const CATEGORY_ORDER = [
  'commun', 'peu_commun', 'rare', 'epique',
  'pseudo_legendaire', 'mega', 'legendaire', 'fabuleux', 'ultra_chimere'
];

const CATEGORY_LABELS = {
  commun: 'Normal',
  peu_commun: 'Peu commun',
  rare: 'Rare',
  epique: 'Épique',
  pseudo_legendaire: 'Semi-légendaire',
  mega: 'Méga-Évolution',
  legendaire: 'Légendaire',
  fabuleux: 'Fabuleux',
  ultra_chimere: 'Ultra-Chimère'
};

// basePoints = Math.round(BST × multiplicateur de la catégorie)
const CATEGORY_MULTIPLIERS = {
  commun: 1.0,
  peu_commun: 1.2,
  rare: 1.3,
  epique: 1.35,
  pseudo_legendaire: 1.35,
  legendaire: 1.5,
  fabuleux: 1.5,
  ultra_chimere: 1.5,
  mega: 1.5
};

// Seuils de BST OFFICIEL (avant multiplicateur) des Pokémon ordinaires.
// Valeur = BST minimum (inclus) pour appartenir à la catégorie.
// ⚠ PROVISOIRES : à recalibrer avec `node analyze-stats.js` une fois data/pokemon-stats.json
// généré (fetch-stats.js), puis passer THRESHOLDS_CALIBRATED à true.
const CATEGORY_THRESHOLDS = {
  commun: 0,
  peu_commun: 320,
  rare: 435,
  epique: 510
};

const THRESHOLDS_CALIBRATED = true;

// ---- Exceptions (jamais classées par BST). Priorité : voir SPECIAL_PRIORITY. ----

// Les Méga-Évolutions sont les formes PokéAPI d'id >= 10000 (Méga-Carchacrok = 10058, etc.).
// Leurs Base Stats sont celles de la forme Méga (fetch-stats.js interroge pokemon/{id} directement).
const MEGA_FORM_ID_MIN = 10000;

// Ultra-Chimères officielles (Necrozma, Cosmog, Cosmovum n'en sont PAS).
const ULTRA_BEAST_IDS = [793, 794, 795, 796, 797, 798, 799, 803, 804, 805, 806];

// Fabuleux officiels.
const MYTHICAL_IDS = [
  151, 251, 385, 386, 489, 490, 491, 492, 493, 494, 647, 648, 649,
  719, 720, 721, 801, 802, 807, 808, 809, 893, 1025
];

// Légendaires officiels (hors Fabuleux et Ultra-Chimères).
const LEGENDARY_IDS = [
  144, 145, 146, 150, 243, 244, 245, 249, 250, 377, 378, 379, 380, 381, 382, 383, 384,
  480, 481, 482, 483, 484, 485, 486, 487, 488, 638, 639, 640, 641, 642, 643, 644, 645, 646,
  716, 717, 718, 772, 773, 785, 786, 787, 788, 789, 790, 791, 792, 800,
  888, 889, 890, 891, 892, 894, 895, 896, 897, 898, 905,
  1001, 1002, 1003, 1004, 1007, 1008, 1014, 1015, 1016, 1017, 1024,
  // Paradoxes classés "légendaire" par l'ancien système du jeu (conservé tel quel ; non
  // officiel : supprime ces 8 ids pour qu'ils repassent au classement par BST).
  1005, 1006, 1009, 1010, 1020, 1021, 1022, 1023
];

// Semi-légendaires (pseudo-légendaires) : lignées à 600 de BST en 3 stades.
const SEMI_LEGENDARY_IDS = [149, 248, 373, 376, 445, 635, 706, 784, 887, 998];

// Ordre de priorité des exceptions (le premier qui correspond gagne). Sinon : classement par BST.
const SPECIAL_PRIORITY = ['mega', 'ultra_chimere', 'fabuleux', 'legendaire', 'pseudo_legendaire'];

// Catégories issues de l'ancien palier "légendaire" : tirage/succès/boss les traitent comme un groupe.
const LEGENDARY_GROUP = ['legendaire', 'fabuleux', 'ultra_chimere'];

const SPECIAL_ID_SETS = {
  ultra_chimere: new Set(ULTRA_BEAST_IDS),
  fabuleux: new Set(MYTHICAL_IDS),
  legendaire: new Set(LEGENDARY_IDS),
  pseudo_legendaire: new Set(SEMI_LEGENDARY_IDS)
};

// Catégorie d'exception d'un id, ou null si Pokémon ordinaire.
function getSpecialCategory(id) {
  for (const cat of SPECIAL_PRIORITY) {
    if (cat === 'mega') { if (id >= MEGA_FORM_ID_MIN) return 'mega'; continue; }
    if (SPECIAL_ID_SETS[cat].has(id)) return cat;
  }
  return null;
}

// Catégorie d'un Pokémon ordinaire selon son BST officiel (seuils inclusifs, du plus haut au plus bas).
function getCategoryByBst(bst) {
  const ordered = Object.entries(CATEGORY_THRESHOLDS).sort((a, b) => b[1] - a[1]);
  for (const [cat, min] of ordered) if (bst >= min) return cat;
  return 'commun';
}

module.exports = {
  CATEGORY_ORDER, CATEGORY_LABELS, CATEGORY_MULTIPLIERS, CATEGORY_THRESHOLDS, THRESHOLDS_CALIBRATED,
  MEGA_FORM_ID_MIN, ULTRA_BEAST_IDS, MYTHICAL_IDS, LEGENDARY_IDS, SEMI_LEGENDARY_IDS,
  SPECIAL_PRIORITY, LEGENDARY_GROUP, getSpecialCategory, getCategoryByBst
};
