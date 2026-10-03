'use strict';
// =====================================================================
// MODE 'fly' (HUMANITÉ vs MOUCHE) — CONFIGURATION CENTRALE
// Toute valeur modifiable est ICI. Aucune valeur en dur dans les autres fichiers.
// NE PAS ajouter de clé 'fly' dans boss-mechanics-config.js (ENABLED_BY_MODE) : absente = désactivée.
// =====================================================================

module.exports = {
  MODE: 'fly',
  AGENT_NAME: 'La Mouche',
  TURNS: 6,                       // = MAX_TURNS de server.js (test-fly.js le vérifie)
  SHINY_POINTS_MULTIPLIER: 1.5,   // = SHINY_POINTS_MULTIPLIER de server.js (public) ; test-fly.js le vérifie
  BASEPOINTS_SCALE: 1000,         // valeurs / échelle avant softmax

  // ---- Modèle « valeur par Pokémon » : la Mouche n'observe que identité + shiny + types ----
  // Après CHAQUE tour, elle voit le résultat de son propre choix (base, effet, points), comme l'humain voit
  // le sien, et met à jour la valeur estimée du Pokémon choisi. Appliqué à la fin d'une partie COMPLÈTE seulement.
  // Le signal (points du Pokémon choisi) ne dépend pas du jeu de l'humain : pas d'« empoisonnement » possible.
  VALUE_OBSERVE: 'base',          // 'base' : points de base affichés ; 'final' : points finaux (bruités par l'effet)
  VALUE_PRIOR_STRENGTH: 0.5,      // poids (en observations) de l'a priori face à la moyenne observée d'un Pokémon
  VALUE_MIN_RATE: 0.05,           // taux de mise à jour minimal (1/n au début) : suit un rééquilibrage du jeu
  VALUE_USE_TYPES: false,         // types = a priori pour les Pokémon jamais vus (validé : aucun gain après échauffement)
  VALUE_TEMP_START: 0.05,         // température d'exploration (échelle : valeur / BASEPOINTS_SCALE)
  VALUE_TEMP_FLOOR: 0.015,
  VALUE_TEMP_TAU: 100,            // en parties d'expérience (réelles + échauffement)

  // ---- Échauffement simulé : parties contre un joueur simulé AVANT d'affronter des humains ----
  // Exécuté sur tout cerveau neuf (premier démarrage, reset admin). Annoncé dans l'UI.
  // 210 ≈ 50 % de victoires contre le joueur simulé (calibré par fly-validate.js sur les données du projet :
  // 202 [min 180, max 216] ; à relancer si stats-config.js ou les tirages changent).
  WARMUP_GAMES: 210,
  WARMUP_HUMAN_NOISE: 0.15,       // joueur simulé : valeur perçue = BST × (1 + bruit gaussien de cet écart-type)

  // ---- Ambiance (cosmétique, serveur uniquement : la décision est prise AVANT le délai) ----
  HESITATION_MS_MIN: 1500,
  HESITATION_MS_MAX: 3500,

  // ---- Persistance ----
  SNAPSHOT_EVERY_GAMES: 200,      // snapshot périodique tous les N parties VÉCUES par le cerveau courant
  SNAPSHOT_KEEP: 20,              // snapshots périodiques conservés
  SNAPSHOT_KEEP_SAFETY: 5,        // archives avant reset / avant restauration conservées
  CURVE_WINDOW_GAMES: 100,        // nb de dernières parties (toutes générations) pour la courbe de la Mouche

  // ---- Anti-farm ----
  XP_CAP_PER_24H: 100,            // XP max par compte et par 24 h contre la Mouche

  // ---- Admin (reset / restauration du cerveau) : clé dans l'env FLY_ADMIN_KEY ----
  ADMIN_KEY_MIN_LENGTH: 16,       // clé plus courte -> routes admin désactivées
  ADMIN_MAX_FAILS: 5,             // échecs d'authentification tolérés par IP...
  ADMIN_FAIL_WINDOW_MS: 900000    // ...sur cette fenêtre (15 min), puis 429
};
