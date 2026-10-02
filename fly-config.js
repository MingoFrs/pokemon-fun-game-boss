'use strict';
// =====================================================================
// MODE 'fly' (HUMANITÉ vs MOUCHE) — CONFIGURATION CENTRALE
// Toute valeur modifiable est ICI. Aucune valeur en dur dans fly-agent.js / server.js / client.
// NE PAS ajouter de clé 'fly' dans boss-mechanics-config.js (ENABLED_BY_MODE) : absente = désactivée.
// =====================================================================

module.exports = {
  MODE: 'fly',
  AGENT_NAME: 'La Mouche',
  TURNS: 6,                       // = MAX_TURNS de server.js (test-fly.js le vérifie)

  // ---- Observation (ce que verrait un humain) ----
  // Raretés tirables avec RARITY_TABLE (pas de 'mega' : réservé au mode admin). Ordre = ordinal.
  RARITIES: ['commun', 'peu_commun', 'rare', 'epique', 'pseudo_legendaire', 'legendaire', 'fabuleux', 'ultra_chimere'],
  SHINY_POINTS_MULTIPLIER: 1.5,   // = SHINY_POINTS_MULTIPLIER de server.js (public) ; test-fly.js le vérifie
  BASEPOINTS_SCALE: 1000,         // basePoints / échelle -> ~[0.2 ; 1.3]
  GAP_SCALE: 1500,                // écart de score normalisé par tanh(écart / GAP_SCALE)

  // ---- Récompense (fin de partie, point de vue de la Mouche) ----
  // R = RESULT_REWARD[résultat] + SCORE_WEIGHT × (score Mouche / meilleur score possible des 6 tirages)
  // Le 2e terme ne dépend que de la qualité des choix de la Mouche, pas du niveau de l'humain :
  // il limite l'« empoisonnement » (un humain qui joue n'importe comment ne peut plus
  // renforcer des choix médiocres via une victoire facile).
  RESULT_REWARD: { win: 1, draw: 0, loss: -1 },
  SCORE_WEIGHT: 1.0,

  // ---- Apprentissage (REINFORCE avec baseline, politique softmax linéaire) ----
  LEARNING_RATE: 0.3,
  BASELINE_RATE: 0.02,            // plancher du taux de la moyenne mobile (1/(n+1) au début)
  ADVANTAGE_CLIP: 2.0,            // |R − baseline| plafonné
  MAX_STEP_NORM: 1.5,             // norme maximale de la mise à jour d'UNE partie
  WEIGHT_DECAY: 0.0002,           // rappel vers 0 à chaque partie
  WEIGHT_CLAMP: 25,               // |poids| maximal

  // ---- Exploration : T(n) = FLOOR + (START − FLOOR) × exp(−n / TAU) ----
  TEMP_START: 2.0,
  TEMP_FLOOR: 0.08,
  TEMP_TAU_GAMES: 1500,

  // ---- Ambiance (cosmétique, serveur uniquement : la décision est prise AVANT le délai) ----
  HESITATION_MS_MIN: 1500,
  HESITATION_MS_MAX: 3500,

  // ---- Persistance (étape 2) ----
  SNAPSHOT_EVERY_GAMES: 200,
  SNAPSHOT_KEEP: 20,
  SNAPSHOT_KEEP_SAFETY: 5,        // snapshots de sécurité (avant reset / avant restauration) conservés
  CURVE_WINDOW_GAMES: 100,        // nb de dernières parties conservées/affichées pour la courbe de la Mouche
  GENERATION_EVERY_GAMES: 200,    // « génération » affichée = 1 + floor(parties / ce nombre)

  // ---- Anti-farm (étape 3) ----
  XP_CAP_PER_24H: 100,            // XP max par compte et par 24 h contre la Mouche

  // ---- Admin (reset / restauration du cerveau) : clé dans l'env FLY_ADMIN_KEY ----
  ADMIN_KEY_MIN_LENGTH: 16,       // clé plus courte -> routes admin désactivées
  ADMIN_MAX_FAILS: 5,             // échecs d'authentification tolérés par IP...
  ADMIN_FAIL_WINDOW_MS: 900000    // ...sur cette fenêtre (15 min), puis 429
};