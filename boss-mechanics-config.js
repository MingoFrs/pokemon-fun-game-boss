'use strict';
// =====================================================================
// CONFIGURATION CENTRALE DES MÉCANIQUES DE TYPE DES BOSS
// Toute valeur modifiable est ICI, nulle part ailleurs (aucune valeur en dur dans server.js,
// boss-mechanics.js ni le client : celui-ci ne fait qu'afficher ce que le serveur envoie).
// =====================================================================

// Activation par mode de jeu (Guess et Enchères n'ont ni boss ni score : toujours inchangés).
const ENABLED_BY_MODE = {
  normal: true,
  admin: true,   // le bonus s'applique au score du JOUEUR (l'admin n'a ni équipe ni score)
  coop: true,    // bonus appliqué au score de CHAQUE joueur ; l'objectif d'équipe reste dérivé de requiredPoints
  guess: false,
  auction: false
};

// A) FAIBLESSE DU BOSS
//   Un Pokémon dont UN de ses types inflige des dégâts super efficaces au boss gagne :
//     bonus = valeurFinale × (multiplicateur − 1)
//   valeurFinale = round(basePoints × trait × (shiny ? ×SHINY : 1)) — donc 0 si le trait est ×0.
//   Double-type : on retient le MEILLEUR multiplicateur parmi ses types (jamais la somme).
const WEAKNESS = {
  enabled: true,
  multiplierX2: 1.25,  // un de ses types frappe le boss à ×2
  multiplierX4: 1.5,   // un de ses types frappe le boss à ×4
  // Malus de résistance : DÉSACTIVÉ par défaut. Activé, un Pokémon dont le MEILLEUR type
  // frappe le boss à ×0.5 (ou moins) / ×0 est pénalisé.
  resistance: {
    enabled: false,
    multiplierHalf: 0.9,    // meilleure efficacité ×0.5 (ou ×0.25)
    multiplierImmune: 0.8   // meilleure efficacité ×0 (aucun de ses types ne touche le boss)
  }
};

// B) BONUS D'AFFINITÉ D'ÉQUIPE
//   Chaque boss a un type « à contrer ». Nombre de Pokémon de l'équipe possédant ce type
//   (l'un de leurs types suffit) -> bonus = taux × SCORE BRUT du joueur (hors bonus de type).
//   Paliers du plus haut au plus bas : le premier atteint s'applique (pas de cumul).
const AFFINITY = {
  enabled: true,
  tiers: [
    { min: 3, rate: 0.10 },  // 3 Pokémon ou plus : +10 %
    { min: 2, rate: 0.05 }   // 2 Pokémon : +5 %
  ]
};

// Type « à contrer » : faiblesse ×4 du boss si elle existe ; sinon la faiblesse ×2 la plus
// représentée dans le pool de Pokémon du jeu (hors Méga, tirées seulement en Admin vs Joueur).
// Égalité -> ordre de TYPE_ORDER. Override manuel par boss (id de dex -> type) :
//   ex. COUNTER_TYPE_OVERRIDES = { 493: 'fighting' }
const COUNTER_TYPE_OVERRIDES = {};

// Calibrage des objectifs (requiredPoints) À L'ACTIVATION de la mécanique. 1 = aucun changement.
// Facteur global par difficulté + correction optionnelle par boss (id de dex -> facteur),
// multipliés entre eux. Ne sont appliqués QUE dans les modes où la mécanique est active.
// ⚠ Valeurs à renseigner d'après `node simulate-bosses.js` (jamais à la main, jamais au hasard).
const SCALE_BY_DIFFICULTY = {
  facile: 1.065,
  moyen: 1.086,
  difficile: 1.100,
  'extrême': 1      // non calibrable ici : voir choix ci-dessous
};
const SCALE_BY_BOSS = {};   // corrections par boss : à ajouter plus tard si besoin

// Les 18 types officiels (ordre de départage), exclus : unknown / shadow / stellar.
const TYPE_ORDER = [
  'normal', 'fire', 'water', 'electric', 'grass', 'ice', 'fighting', 'poison', 'ground',
  'flying', 'psychic', 'bug', 'rock', 'ghost', 'dragon', 'dark', 'steel', 'fairy'
];

const TYPE_LABELS_FR = {
  normal: 'Normal', fire: 'Feu', water: 'Eau', electric: 'Électrik', grass: 'Plante', ice: 'Glace',
  fighting: 'Combat', poison: 'Poison', ground: 'Sol', flying: 'Vol', psychic: 'Psy', bug: 'Insecte',
  rock: 'Roche', ghost: 'Spectre', dragon: 'Dragon', dark: 'Ténèbres', steel: 'Acier', fairy: 'Fée'
};

module.exports = {
  ENABLED_BY_MODE, WEAKNESS, AFFINITY, COUNTER_TYPE_OVERRIDES,
  SCALE_BY_DIFFICULTY, SCALE_BY_BOSS, TYPE_ORDER, TYPE_LABELS_FR
};
