const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------
// Configuration du jeu
// ---------------------------------------------------------------
const MAX_TURNS = 6; // aligné sur les 6 slots d'équipe : chaque tour rapporte 1 Pokémon
const REVEAL_DELAY_MS = 4000; // pause de révélation avant de passer au tour suivant

function spriteUrl(dexId) {
  return `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/${dexId}.png`;
}

function shinySpriteUrl(dexId) {
  return `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/shiny/${dexId}.png`;
}

// -----------------------------------------------------------------
// Pool de Pokémon organisé par rareté.
// Chaque tour, le serveur tire d'abord une rareté (selon RARITY_TABLE),
// puis un Pokémon au hasard dans cette rareté.
// -----------------------------------------------------------------

const COMMON_RAW = [
  { id: 10, name: 'Chenipan', points: 60 },
  { id: 13, name: 'Aspicot', points: 60 },
  { id: 19, name: 'Rattata', points: 70 },
  { id: 21, name: 'Piafabec', points: 80 },
  { id: 129, name: 'Magicarpe', points: 80 },
  { id: 16, name: 'Roucool', points: 90 },
  { id: 23, name: 'Abo', points: 90 },
  { id: 29, name: 'Nidoran Femelle', points: 90 },
  { id: 32, name: 'Nidoran Mâle', points: 90 },
  { id: 41, name: 'Nosferapti', points: 90 },
  { id: 46, name: 'Paras', points: 90 },
  { id: 50, name: 'Taupiqueur', points: 90 },
  { id: 27, name: 'Sabelette', points: 100 },
  { id: 60, name: 'Ptitard', points: 100 },
  { id: 69, name: 'Chétiflor', points: 100 },
  { id: 88, name: 'Tadmorv', points: 110 },
  { id: 98, name: 'Krabby', points: 110 },
  { id: 120, name: 'Stari', points: 110 },
  { id: 43, name: 'Mystherbe', points: 120 },
  { id: 72, name: 'Tentacool', points: 120 },
  { id: 84, name: 'Doduo', points: 130 },
  { id: 100, name: 'Voltorbe', points: 130 },
  { id: 116, name: 'Hypotrempe', points: 130 },
  { id: 37, name: 'Goupix', points: 140 },
  { id: 109, name: 'Smogo', points: 140 },
  { id: 1, name: 'Bulbizarre', points: 150 },
  { id: 4, name: 'Salamèche', points: 150 },
  { id: 7, name: 'Carapuce', points: 150 },
  { id: 39, name: 'Rondoudou', points: 150 },
  { id: 48, name: 'Mimitoss', points: 150 },
  { id: 56, name: 'Férosinge', points: 150 },
  { id: 35, name: 'Mélofée', points: 160 },
  { id: 52, name: 'Miaouss', points: 160 },
  { id: 74, name: 'Racaillou', points: 170 },
  { id: 108, name: 'Excelangue', points: 170 },
  { id: 138, name: 'Kabuto', points: 170 },
  { id: 54, name: 'Psykokwak', points: 190 }
];

const UNCOMMON_RAW = [
  { id: 17, name: 'Roucoups', points: 150 },
  { id: 30, name: 'Nidorina', points: 180 },
  { id: 33, name: 'Nidorino', points: 180 },
  { id: 70, name: 'Boustiflor', points: 190 },
  { id: 77, name: 'Ponyta', points: 200 },
  { id: 111, name: 'Rhinocorne', points: 200 },
  { id: 132, name: 'Métamorph', points: 200 },
  { id: 79, name: 'Ramoloss', points: 210 },
  { id: 51, name: 'Triopikeur', points: 210 },
  { id: 44, name: 'Ortide', points: 220 },
  { id: 47, name: 'Parasect', points: 220 },
  { id: 147, name: 'Minidraco', points: 220 },
  { id: 81, name: 'Magnéti', points: 230 },
  { id: 24, name: 'Arbok', points: 230 },
  { id: 66, name: 'Machoc', points: 240 },
  { id: 104, name: 'Osselait', points: 250 },
  { id: 122, name: 'M. Mime', points: 250 },
  { id: 58, name: 'Caninos', points: 260 },
  { id: 137, name: 'Porygon', points: 260 },
  { id: 42, name: 'Nosferalto', points: 260 },
  { id: 53, name: 'Persian', points: 260 },
  { id: 85, name: 'Dodrio', points: 260 },
  { id: 99, name: 'Krabboss', points: 260 },
  { id: 75, name: 'Gravalanch', points: 280 },
  { id: 101, name: 'Électrode', points: 280 },
  { id: 121, name: 'Staross', points: 280 }
];

const RARE_RAW = [
  { id: 92, name: 'Fantominus', points: 320 },
  { id: 95, name: 'Onix', points: 320 },
  { id: 18, name: 'Roucarnage', points: 300 },
  { id: 63, name: 'Abra', points: 300 },
  { id: 123, name: 'Insécateur', points: 340 },
  { id: 31, name: 'Nidoqueen', points: 340 },
  { id: 45, name: 'Rafflesia', points: 340 },
  { id: 55, name: 'Akwakwak', points: 340 },
  { id: 67, name: 'Machopeur', points: 320 },
  { id: 71, name: 'Empiflor', points: 320 },
  { id: 73, name: 'Tentacruel', points: 340 },
  { id: 78, name: 'Galopa', points: 340 },
  { id: 80, name: 'Flagadoss', points: 340 },
  { id: 82, name: 'Magnéton', points: 340 },
  { id: 34, name: 'Nidoking', points: 360 },
  { id: 127, name: 'Scarabrute', points: 360 },
  { id: 26, name: 'Raichu', points: 380 },
  { id: 3, name: 'Florizarre', points: 380 },
  { id: 133, name: 'Évoli', points: 400 },
  { id: 9, name: 'Tortank', points: 420 },
  { id: 6, name: 'Dracaufeu', points: 440 },
  { id: 25, name: 'Pikachu', points: 480 },
  { id: 130, name: 'Léviator', points: 480 }
];

// NERF (~22.5%, appliqué au point de base, AVANT le multiplicateur bonus/malus) :
// épique / pseudo-légendaire / légendaire uniquement. Commun/peu commun/rare inchangés.
const EPIC_RAW = [
  { id: 68, name: 'Mackogneur', points: 405 },
  { id: 143, name: 'Ronflex', points: 425 },
  { id: 76, name: 'Grolem', points: 435 },
  { id: 131, name: 'Lokhlass', points: 450 },
  { id: 113, name: 'Leveinard', points: 465 },
  { id: 448, name: 'Lucario', points: 505 },
  { id: 282, name: 'Gardevoir', points: 525 },
  { id: 475, name: 'Gallame', points: 545 },
  { id: 637, name: 'Volcarona', points: 580 },
  { id: 778, name: 'Mimiqui', points: 620 }
];

// Vrais pseudo-légendaires (évolution 3 stades, très puissants, mais pas légendaires).
// NERF CIBLÉ (~12%, sur les points déjà nerfés de l'étape précédente) : seuls les Pokémon
// clairement au-dessus de la moyenne de leur propre palier sont concernés.
// Moyenne pseudo-légendaire ≈ 818 → Dragapult (890, +8.8%) est le seul net outlier.
const PSEUDO_LEGENDARY_RAW = [
  { id: 149, name: 'Dracolosse', points: 735 },
  { id: 248, name: 'Tyranocif', points: 775 },
  { id: 445, name: 'Carchacrok', points: 815 },
  { id: 376, name: 'Métalosse', points: 850 },
  { id: 635, name: 'Trioxhydre', points: 850 },
  { id: 887, name: 'Dragapult', points: 785 } // nerfé : 890 -> 785 (~-12%)
];

// Moyenne légendaire ≈ 1334 → seuls les 5 nettement au-dessus (>+10%) sont nerfés :
// Arceus (1550, +16%), Koraidon/Miraidon (1510, +13%), Zacian/Zamazenta (1475, +11%).
// Necrozma (1435, +7.6%) reste inchangé : pas assez d'écart pour être "clairement" trop fort.
const LEGENDARY_RAW = [
  { id: 249, name: 'Lugia', points: 1160 },
  { id: 250, name: 'Ho-Oh', points: 1160 },
  { id: 384, name: 'Rayquaza', points: 1240 },
  { id: 383, name: 'Groudon', points: 1240 },
  { id: 382, name: 'Kyogre', points: 1240 },
  { id: 150, name: 'Mewtwo', points: 1240 },
  { id: 483, name: 'Dialga', points: 1280 },
  { id: 484, name: 'Palkia', points: 1280 },
  { id: 643, name: 'Reshiram', points: 1280 },
  { id: 644, name: 'Zekrom', points: 1280 },
  { id: 487, name: 'Giratina', points: 1320 },
  { id: 646, name: 'Kyurem', points: 1320 },
  { id: 716, name: 'Xerneas', points: 1320 },
  { id: 717, name: 'Yveltal', points: 1320 },
  { id: 791, name: 'Solgaleo', points: 1355 },
  { id: 792, name: 'Lunala', points: 1355 },
  { id: 800, name: 'Necrozma', points: 1435 },
  { id: 888, name: 'Zacian', points: 1300 },     // nerfé : 1475 -> 1300 (~-12%)
  { id: 889, name: 'Zamazenta', points: 1300 },  // nerfé : 1475 -> 1300 (~-12%)
  { id: 1007, name: 'Koraidon', points: 1330 },  // nerfé : 1510 -> 1330 (~-12%)
  { id: 1008, name: 'Miraidon', points: 1330 },  // nerfé : 1510 -> 1330 (~-12%)
  { id: 493, name: 'Arceus', points: 1365 }      // nerfé : 1550 -> 1365 (~-12%)
];

function buildPool(rarity, entries) {
  return entries.map(p => ({ ...p, rarity, sprite: spriteUrl(p.id) }));
}

// -----------------------------------------------------------------
// Évolutions réelles (forme finale) pour le Bonbon XP. Couvre tous les
// Pokémon commun/peu commun/rare de base ou intermédiaires qui ont une
// évolution standard simple (pas d'évolution par échange/objet, pas de
// branches multiples comme Évoli). Les entrées déjà "finales" (Persian,
// Dracaufeu, Grolem, etc.) ne sont volontairement pas dans cette table :
// elles ne sont pas évoluables. Réutilise les points déjà définis dans
// les pools existants quand la forme finale y figure déjà (cohérence).
// -----------------------------------------------------------------
const EVOLUTION_MAP = {
  1: { id: 3, name: 'Florizarre', points: 380 },
  4: { id: 6, name: 'Dracaufeu', points: 440 },
  7: { id: 9, name: 'Tortank', points: 420 },
  10: { id: 12, name: 'Papilusion', points: 280 },
  13: { id: 15, name: 'Dardargnan', points: 280 },
  16: { id: 18, name: 'Roucarnage', points: 300 },
  17: { id: 18, name: 'Roucarnage', points: 300 },
  19: { id: 20, name: 'Rattatac', points: 260 },
  23: { id: 24, name: 'Arbok', points: 230 },
  27: { id: 28, name: 'Sablaireau', points: 260 },
  29: { id: 31, name: 'Nidoqueen', points: 340 },
  30: { id: 31, name: 'Nidoqueen', points: 340 },
  32: { id: 34, name: 'Nidoking', points: 360 },
  33: { id: 34, name: 'Nidoking', points: 360 },
  35: { id: 36, name: 'Mélodelfe', points: 260 },
  37: { id: 38, name: 'Feunard', points: 300 },
  39: { id: 40, name: 'Grodoudou', points: 260 },
  41: { id: 169, name: 'Nostenfer', points: 340 },
  42: { id: 169, name: 'Nostenfer', points: 340 },
  43: { id: 45, name: 'Rafflesia', points: 340 },
  44: { id: 45, name: 'Rafflesia', points: 340 },
  46: { id: 47, name: 'Parasect', points: 220 },
  48: { id: 49, name: 'Aéromite', points: 280 },
  50: { id: 51, name: 'Triopikeur', points: 210 },
  52: { id: 53, name: 'Persian', points: 260 },
  54: { id: 55, name: 'Akwakwak', points: 340 },
  56: { id: 57, name: 'Colossinge', points: 300 },
  58: { id: 59, name: 'Arcanin', points: 400 },
  60: { id: 62, name: 'Tartard', points: 320 },
  63: { id: 65, name: 'Alakazam', points: 460 },
  66: { id: 68, name: 'Mackogneur', points: 405 },
  67: { id: 68, name: 'Mackogneur', points: 405 },
  69: { id: 71, name: 'Empiflor', points: 320 },
  70: { id: 71, name: 'Empiflor', points: 320 },
  72: { id: 73, name: 'Tentacruel', points: 340 },
  74: { id: 76, name: 'Grolem', points: 435 },
  75: { id: 76, name: 'Grolem', points: 435 },
  77: { id: 78, name: 'Galopa', points: 340 },
  79: { id: 80, name: 'Flagadoss', points: 340 },
  81: { id: 82, name: 'Magnéton', points: 340 },
  84: { id: 85, name: 'Dodrio', points: 260 },
  88: { id: 89, name: 'Grotadmorv', points: 300 },
  92: { id: 94, name: 'Ectoplasma', points: 460 },
  98: { id: 99, name: 'Krabboss', points: 260 },
  100: { id: 101, name: 'Électrode', points: 280 },
  104: { id: 105, name: 'Ossatueur', points: 380 },
  109: { id: 110, name: 'Smogogo', points: 280 },
  111: { id: 112, name: 'Rhinoféros', points: 380 },
  116: { id: 230, name: 'Hyporoi', points: 360 },
  120: { id: 121, name: 'Staross', points: 280 },
  129: { id: 130, name: 'Léviator', points: 480 },
  138: { id: 140, name: 'Kabutops', points: 320 },
  147: { id: 149, name: 'Dracolosse', points: 735 }
};

const POKEMON_POOLS = {
  commun: buildPool('commun', COMMON_RAW),
  peu_commun: buildPool('peu_commun', UNCOMMON_RAW),
  rare: buildPool('rare', RARE_RAW),
  epique: buildPool('epique', EPIC_RAW),
  pseudo_legendaire: buildPool('pseudo_legendaire', PSEUDO_LEGENDARY_RAW),
  legendaire: buildPool('legendaire', LEGENDARY_RAW)
};

// Probabilité de tirage de chaque rareté (somme = 1). Commun très fréquent,
// légendaire extrêmement rare, mais assez généreux pour qu'une partie complète
// (6 tours × 2 options) ait de bonnes chances de croiser au moins un Pokémon fort.
const RARITY_TABLE = [
  { rarity: 'commun', weight: 0.39 },
  { rarity: 'peu_commun', weight: 0.26 },
  { rarity: 'rare', weight: 0.17 },
  { rarity: 'epique', weight: 0.09 },
  { rarity: 'pseudo_legendaire', weight: 0.06 },
  { rarity: 'legendaire', weight: 0.03 }
];

// Charme Chroma : les raretés "puissantes" voient leur poids multiplié par ×2.5,
// le reste est renormalisé proportionnellement pour que la somme reste 1 (pas de
// probabilité invalide, pas de garantie absolue non plus).
const SHINY_CHARM_MULTIPLIER = 2.5;
const SHINY_CHARM_BOOSTED_RARITIES = ['epique', 'pseudo_legendaire', 'legendaire'];

// -----------------------------------------------------------------
// Anti-RNG / pity, par joueur. N'accorde JAMAIS de légendaire garanti : réduit
// seulement les séries de malchance extrêmes. "Bonne rareté" = rare et au-dessus
// (même palier que le boost ci-dessous) ; "mauvaise" = commun/peu_commun.
// Progressif comme demandé (0 -> normal, 1 très léger, 2 léger, 3-4 supplémentaire,
// 5+ plus important), plafonné à 5 pour éviter un boost qui grandit indéfiniment.
// -----------------------------------------------------------------
const PITY_BOOSTED_RARITIES = ['rare', 'epique', 'pseudo_legendaire', 'legendaire'];
const PITY_GOOD_RARITIES = PITY_BOOSTED_RARITIES;
const PITY_MULTIPLIER_BY_LEVEL = [1.0, 1.15, 1.35, 1.6, 1.9, 2.3]; // index = pity (0..5, plafonné)

function getPityMultiplier(pity) {
  const level = Math.max(0, Math.min(pity || 0, PITY_MULTIPLIER_BY_LEVEL.length - 1));
  return PITY_MULTIPLIER_BY_LEVEL[level];
}

// Ordre croissant des raretés, utilisé pour appliquer un "plancher" (LUCKY_TURN, TIME_RIFT) :
// tout ce qui est strictement en dessous du plancher voit son poids ramené à 0, puis la
// table est renormalisée — même principe que le boost pity/Charme Chroma, jamais une
// probabilité négative ni une garantie de légendaire (le plancher n'élimine QUE le bas
// de la table, il ne force jamais une seule rareté à 100%).
const RARITY_ORDER = ['commun', 'peu_commun', 'rare', 'epique', 'pseudo_legendaire', 'legendaire'];

// Applique un ou plusieurs boosts multiplicatifs à une table de poids, PUIS
// normalise une seule fois à la fin (jamais de "probabilité × pity × 2.5" brut,
// qui produirait des probabilités absurdes en cas de cumul).
function buildWeightedRarityTable({ useCharm, pity, floorRarity }) {
  const pityMultiplier = getPityMultiplier(pity);
  let weighted = RARITY_TABLE.map(entry => {
    let weight = entry.weight;
    if (useCharm && SHINY_CHARM_BOOSTED_RARITIES.includes(entry.rarity)) weight *= SHINY_CHARM_MULTIPLIER;
    if (PITY_BOOSTED_RARITIES.includes(entry.rarity)) weight *= pityMultiplier;
    return { rarity: entry.rarity, weight };
  });

  if (floorRarity) {
    const floorIndex = RARITY_ORDER.indexOf(floorRarity);
    if (floorIndex > 0) {
      weighted = weighted.map(e => (RARITY_ORDER.indexOf(e.rarity) < floorIndex ? { rarity: e.rarity, weight: 0 } : e));
    }
  }

  const total = weighted.reduce((sum, e) => sum + e.weight, 0);
  return weighted.map(e => ({ rarity: e.rarity, weight: total > 0 ? e.weight / total : 0 }));
}

function pickRarity(useCharm, pity, floorRarity) {
  const table = buildWeightedRarityTable({ useCharm, pity, floorRarity });
  const roll = Math.random();
  let cumulative = 0;
  for (const entry of table) {
    cumulative += entry.weight;
    if (roll < cumulative) return entry.rarity;
  }
  return table[table.length - 1].rarity; // filet de sécurité (arrondis flottants)
}

// Bonus / malus secrets appliqués au tirage d'un Pokémon.
// Multiplicateurs inchangés — seule leur fréquence d'apparition change (poids ci-dessous) :
// ~75% Neutre (aucun modificateur perceptible), ~25% répartis entre les 8 vrais bonus/malus.
const EFFECTS = [
  { name: 'Neutre', multiplier: 1.0, weight: 75 },
  { name: 'Énergétique', multiplier: 1.2, weight: 3.125 },
  { name: 'Chanceux', multiplier: 1.3, weight: 3.125 },
  { name: 'Motivé', multiplier: 1.1, weight: 3.125 },
  { name: 'Concentré', multiplier: 1.15, weight: 3.125 },
  { name: 'Fatigué', multiplier: 0.75, weight: 3.125 },
  { name: 'Poids lourd', multiplier: 0.8, weight: 3.125 },
  { name: 'Malchanceux', multiplier: 0.6, weight: 3.125 },
  { name: 'Épine dans le pied', multiplier: 0.7, weight: 3.125 }
];

const EFFECTS_TOTAL_WEIGHT = EFFECTS.reduce((sum, e) => sum + e.weight, 0);

function pickEffect() {
  let roll = Math.random() * EFFECTS_TOTAL_WEIGHT;
  for (const effect of EFFECTS) {
    if (roll < effect.weight) return effect;
    roll -= effect.weight;
  }
  return EFFECTS[0]; // filet de sécurité (arrondis flottants) -> Neutre
}

// Plusieurs boss légendaires possibles, avec un objectif propre à chacun.
// Cibles calées sur des percentiles de la distribution réelle des scores (choix aveugle,
// RNG pure — cf. simulation) plutôt que sur une moyenne : une équipe faible doit pouvoir
// perdre même contre le boss "facile", et même une excellente RNG (légendaire obtenu) ne
// garantit pas la victoire contre les boss les plus durs.
// Après le rééquilibrage des modificateurs (75% Neutre), seul "facile" était devenu trop
// clément (64.7% de victoire en choix aveugle) : buffé de 1450 -> 1650 (~51%). Les autres
// paliers étaient restés cohérents (moyen 44%, difficile 25%, très difficile 11%, extrême 3%)
// et n'ont pas été touchés.
// Regroupe les 5 paliers existants (facile/moyen/difficile/très difficile/extrême)
// en 4 catégories sélectionnables dans le lobby. Aucun boss supprimé ni renommé.
const DIFFICULTY_TO_GROUP = {
  facile: 'easy',
  moyen: 'medium',
  difficile: 'hard',
  'très difficile': 'hard',
  extrême: 'extreme'
};

// facile ≈ P50 | moyen ≈ P58 | difficile ≈ P77 | très difficile ≈ P90 | extrême ≈ P97
const BOSSES = [
  { id: 249, name: 'Lugia', requiredPoints: 1650, difficulty: 'facile' },
  { id: 250, name: 'Ho-Oh', requiredPoints: 1650, difficulty: 'facile' },
  { id: 384, name: 'Rayquaza', requiredPoints: 1750, difficulty: 'moyen' },
  { id: 383, name: 'Groudon', requiredPoints: 1750, difficulty: 'moyen' },
  { id: 382, name: 'Kyogre', requiredPoints: 1750, difficulty: 'moyen' },
  { id: 483, name: 'Dialga', requiredPoints: 1750, difficulty: 'moyen' },
  { id: 484, name: 'Palkia', requiredPoints: 1750, difficulty: 'moyen' },
  { id: 487, name: 'Giratina', requiredPoints: 2150, difficulty: 'difficile' },
  { id: 643, name: 'Reshiram', requiredPoints: 2150, difficulty: 'difficile' },
  { id: 644, name: 'Zekrom', requiredPoints: 2150, difficulty: 'difficile' },
  { id: 150, name: 'Mewtwo', requiredPoints: 2150, difficulty: 'difficile' },
  { id: 716, name: 'Xerneas', requiredPoints: 2600, difficulty: 'très difficile' },
  { id: 717, name: 'Yveltal', requiredPoints: 2600, difficulty: 'très difficile' },
  { id: 888, name: 'Zacian', requiredPoints: 2600, difficulty: 'très difficile' },
  { id: 889, name: 'Zamazenta', requiredPoints: 2600, difficulty: 'très difficile' },
  { id: 1007, name: 'Koraidon', requiredPoints: 3200, difficulty: 'extrême' },
  { id: 1008, name: 'Miraidon', requiredPoints: 3200, difficulty: 'extrême' },
  { id: 493, name: 'Arceus', requiredPoints: 3200, difficulty: 'extrême' }
].map(b => ({ ...b, group: DIFFICULTY_TO_GROUP[b.difficulty], sprite: spriteUrl(b.id) }));

// 4 groupes de difficulté sélectionnables dans le lobby (feature difficulté du boss).
// "difficile" et "très difficile" sont fusionnés dans le groupe "hard" : aucun boss
// supprimé, ils gardent simplement des objectifs différents (2150 et 2600) au sein
// du même groupe, ce qui est explicitement acceptable.
const BOSS_GROUPS = ['easy', 'medium', 'hard', 'extreme'];

function pickRandomBoss(group) {
  const pool = BOSSES.filter(b => b.group === group);
  return randomFrom(pool.length ? pool : BOSSES); // filet de sécurité si groupe invalide/vide
}

// Bonus du tour 4 spécial. Poids = probabilité d'être PROPOSÉ (parmi les 2 options),
// pas une garantie d'obtention : le joueur choisit ensuite lequel des deux il prend.
const BONUS_WEIGHTS = {
  xpCandy: 35,
  mysteryItem: 35,
  shinyCharm: 30
};

const BONUS_LABELS = {
  xpCandy: 'Bonbon XP',
  mysteryItem: 'Objet Mystère',
  shinyCharm: 'Charme Chroma'
};

function weightedPickKey(entries) {
  const total = entries.reduce((sum, e) => sum + e.weight, 0);
  let roll = Math.random() * total;
  for (const entry of entries) {
    if (roll < entry.weight) return entry.key;
    roll -= entry.weight;
  }
  return entries[entries.length - 1].key;
}

// Bonbon XP n'est proposable que si le joueur a au moins un Pokémon évoluable.
function getAvailableBonusKeys(player) {
  return Object.keys(BONUS_WEIGHTS).filter(key => {
    if (key === 'xpCandy') return player.team.some(mon => EVOLUTION_MAP[mon.id]);
    return true;
  });
}

// Tire 2 bonus DIFFÉRENTS parmi ceux réellement disponibles pour ce joueur.
function pickTwoBonuses(player) {
  const available = getAvailableBonusKeys(player).map(key => ({ key, weight: BONUS_WEIGHTS[key] }));
  const first = weightedPickKey(available);
  const remaining = available.filter(e => e.key !== first);
  const second = weightedPickKey(remaining);
  return [first, second];
}

function randomFrom(list) {
  return list[Math.floor(Math.random() * list.length)];
}

// Construit une récompense secrète complète (rareté → Pokémon + effet + points calculés).
// floorRarity est optionnel (LUCKY_TURN, TIME_RIFT) : undefined = comportement inchangé.
function buildRewardOption(useCharm, pity, floorRarity) {
  const rarity = pickRarity(useCharm, pity, floorRarity);
  const pokemon = randomFrom(POKEMON_POOLS[rarity]);
  const effect = pickEffect();
  const finalPoints = Math.round(pokemon.points * effect.multiplier);

  return {
    pokemonId: pokemon.id,
    name: pokemon.name,
    sprite: pokemon.sprite,
    rarity: pokemon.rarity,
    basePoints: pokemon.points,
    effectName: effect.name,
    multiplier: effect.multiplier,
    finalPoints
  };
}

// Génère les 2 options HAUT/BAS d'un joueur pour un tour (toujours 2 Pokémon distincts).
function pickPlayerTurnOptions(useCharm, pity, floorRarity) {
  const haut = buildRewardOption(useCharm, pity, floorRarity);
  let bas = buildRewardOption(useCharm, pity, floorRarity);

  let guard = 0;
  while (bas.pokemonId === haut.pokemonId && guard < 10) {
    bas = buildRewardOption(useCharm, pity, floorRarity);
    guard += 1;
  }

  return { haut, bas };
}

// -----------------------------------------------------------------
// ÉVÉNEMENTS RARES
//
// Tirés côté serveur UNIQUEMENT, individuellement pour CHAQUE joueur, juste après
// la résolution de son tour (cf. finalizePlayerTurn). Chaque événement est testé
// indépendamment avec sa propre probabilité (pas une table normalisée à 100% comme
// les raretés) : la plupart du temps AUCUN événement ne se déclenche, ce qui est
// volontaire — ce sont des bonus rares, pas un système central du jeu.
//
// "implemented: false" = déclaré (architecture prête) mais jamais tiré tant que le
// handler serveur correspondant n'existe pas. Évite qu'un événement mal terminé se
// déclenche par erreur pendant que les étapes suivantes sont en cours de développement.
// -----------------------------------------------------------------
const EVENT_TYPES = {
  DOUBLE_ENCOUNTER: 'DOUBLE_ENCOUNTER',
  SECOND_CHANCE: 'SECOND_CHANCE',
  DOUBLE_OR_NOTHING: 'DOUBLE_OR_NOTHING',
  INSTANT_EVOLUTION: 'INSTANT_EVOLUTION',
  HIDDEN_TALENT: 'HIDDEN_TALENT',
  SHINY_POKEMON: 'SHINY_POKEMON',
  DUEL: 'DUEL',
  MIRROR: 'MIRROR',
  CROSSED_FATES: 'CROSSED_FATES',
  LUCKY_TURN: 'LUCKY_TURN',
  LOTTERY: 'LOTTERY',
  TIME_RIFT: 'TIME_RIFT'
};

// scope 'solo' = ne concerne que le joueur qui vient de finir son tour.
// scope 'duo'  = nécessite un adversaire (jamais tiré en solo) — étape 4, pas encore implémenté.
const EVENT_DEFINITIONS = [
  {
    id: EVENT_TYPES.DOUBLE_ENCOUNTER,
    label: 'Double rencontre',
    probability: 0.03,
    scope: 'solo',
    implemented: true,
    condition: (game, player) => player.team.length < 6 // il faut une place libre pour le Pokémon gagné
  },
  {
    id: EVENT_TYPES.SECOND_CHANCE,
    label: 'Deuxième chance',
    probability: 0.03,
    scope: 'solo',
    implemented: true,
    condition: (game, player) => !!player.currentOptions && (player.currentChoice === 'HAUT' || player.currentChoice === 'BAS')
  },
  {
    id: EVENT_TYPES.DOUBLE_OR_NOTHING,
    label: 'Double ou rien',
    probability: 0.02,
    scope: 'solo',
    implemented: true,
    condition: (game, player) => player.team.length > 0
  },
  {
    id: EVENT_TYPES.INSTANT_EVOLUTION,
    label: 'Évolution instantanée',
    probability: 0.03,
    scope: 'solo',
    implemented: true,
    condition: (game, player) => player.team.some(mon => EVOLUTION_MAP[mon.id])
  },
  {
    id: EVENT_TYPES.HIDDEN_TALENT,
    label: 'Talent caché',
    probability: 0.03,
    scope: 'solo',
    implemented: true,
    condition: (game, player) => player.team.length > 0
  },
  {
    id: EVENT_TYPES.SHINY_POKEMON,
    label: 'Pokémon shiny',
    probability: 0.02,
    scope: 'solo',
    implemented: true,
    condition: (game, player) => player.team.length > 0
  },
  {
    id: EVENT_TYPES.DUEL,
    label: 'Duel',
    probability: 0.03,
    scope: 'duo',
    implemented: false, // étape 4
    condition: (game) => game.players.length >= 2
  },
  {
    id: EVENT_TYPES.MIRROR,
    label: 'Miroir',
    probability: 0.02,
    scope: 'duo',
    implemented: false, // étape 4
    condition: (game) => game.players.length >= 2
  },
  {
    id: EVENT_TYPES.CROSSED_FATES,
    label: 'Destins croisés',
    probability: 0.02,
    scope: 'duo',
    implemented: false, // étape 4
    condition: (game) => game.players.length >= 2
  },
  {
    id: EVENT_TYPES.LUCKY_TURN,
    label: 'Tour chanceux',
    probability: 0.02,
    scope: 'solo',
    implemented: true,
    condition: (game) => game.turn < game.maxTurns // sinon il n'y a plus de "prochain tirage" à booster
  },
  {
    id: EVENT_TYPES.LOTTERY,
    label: 'Loterie',
    probability: 0.02,
    scope: 'solo',
    implemented: true,
    condition: () => true
  },
  {
    id: EVENT_TYPES.TIME_RIFT,
    label: 'Faille spatio-temporelle',
    probability: 0.01,
    scope: 'solo',
    implemented: true,
    condition: (game, player) => player.team.length < 6
  }
];

// Nombre de tours minimum entre deux événements pour un même joueur (anti-spam).
const EVENT_COOLDOWN_TURNS = 2;

// Tire un événement pour CE joueur uniquement (jamais les autres). Retourne null la
// plupart du temps — c'est volontaire, les événements doivent rester rares. Chaque
// définition est testée indépendamment avec sa propre probabilité ; la première qui
// "réussit" son tirage déclenche l'événement et arrête la boucle (un seul à la fois).
function maybeTriggerEvent(game, player) {
  if (game.status !== 'playing') return null;
  if (player.activeEvent) return null; // déjà un événement en cours -> jamais de cumul
  if (player.eventCooldown > 0) return null; // anti-spam : pas deux événements qui se suivent

  const candidates = EVENT_DEFINITIONS.filter(def =>
    def.implemented &&
    (def.scope === 'solo' || game.players.length >= 2) &&
    def.condition(game, player)
  );

  for (const def of candidates) {
    if (Math.random() < def.probability) {
      return startEvent(game, player, def);
    }
  }
  return null;
}

// Dispatch générique de démarrage. Chaque événement construit son propre
// player.activeEvent (tout ce qu'il faut pour valider la réponse plus tard) et émet
// 'rare_event_start' avec uniquement ce que le client a le droit de voir.
function startEvent(game, player, def) {
  player.eventCooldown = EVENT_COOLDOWN_TURNS;
  switch (def.id) {
    case EVENT_TYPES.DOUBLE_ENCOUNTER: return startDoubleEncounter(game, player);
    case EVENT_TYPES.DOUBLE_OR_NOTHING: return startDoubleOrNothing(game, player);
    case EVENT_TYPES.HIDDEN_TALENT: return startHiddenTalent(game, player);
    case EVENT_TYPES.SECOND_CHANCE: return startSecondChance(game, player);
    case EVENT_TYPES.INSTANT_EVOLUTION: return startInstantEvolution(game, player);
    case EVENT_TYPES.SHINY_POKEMON: return startShinyPokemon(game, player);
    case EVENT_TYPES.LUCKY_TURN: return startLuckyTurn(game, player);
    case EVENT_TYPES.LOTTERY: return startLottery(game, player);
    case EVENT_TYPES.TIME_RIFT: return startTimeRift(game, player);
    default: return null; // événements pas encore implémentés (étape 4 : duo)
  }
}

// ---- DOUBLE RENCONTRE : 2 Pokémon générés, le joueur en garde un, l'autre disparaît. ----
// N'affecte PAS le pity : c'est un tirage bonus hors flux principal, pas un tour normal.
function startDoubleEncounter(game, player) {
  const useCharm = player.hasShinyCharm && game.turn >= 5;
  const optionA = buildRewardOption(useCharm, player.pity);
  let optionB = buildRewardOption(useCharm, player.pity);
  let guard = 0;
  while (optionB.pokemonId === optionA.pokemonId && guard < 10) {
    optionB = buildRewardOption(useCharm, player.pity);
    guard += 1;
  }

  player.activeEvent = { type: EVENT_TYPES.DOUBLE_ENCOUNTER, options: [optionA, optionB] };

  io.to(player.id).emit('rare_event_start', {
    type: EVENT_TYPES.DOUBLE_ENCOUNTER,
    label: 'Double rencontre',
    options: [optionA, optionB].map(o => ({
      name: o.name,
      sprite: o.sprite,
      rarity: o.rarity,
      basePoints: o.basePoints,
      effectName: o.effectName,
      multiplier: o.multiplier,
      finalPoints: o.finalPoints
    }))
  });
  return player.activeEvent;
}

function resolveDoubleEncounter(game, player, action) {
  const options = player.activeEvent.options;
  const index = action && (action.index === 0 || action.index === 1) ? action.index : null;
  if (index === null) return { error: 'Choix invalide.' };

  const chosen = options[index];
  player.score += chosen.finalPoints;
  if (player.team.length < 6) {
    player.team.push({
      id: chosen.pokemonId,
      name: chosen.name,
      sprite: chosen.sprite,
      rarity: chosen.rarity,
      basePoints: chosen.basePoints,
      effectName: chosen.effectName,
      multiplier: chosen.multiplier
    });
  }

  return {
    result: {
      type: EVENT_TYPES.DOUBLE_ENCOUNTER,
      pokemon: { name: chosen.name, sprite: chosen.sprite },
      rarity: chosen.rarity,
      pointsGained: chosen.finalPoints,
      score: player.score,
      team: player.team
    }
  };
}

// ---- DOUBLE OU RIEN : risque le dernier Pokémon obtenu ce tour (×2 ou ×0). ----
function startDoubleOrNothing(game, player) {
  const teamIndex = player.team.length - 1;
  const mon = player.team[teamIndex];
  if (!mon) return null;

  player.activeEvent = { type: EVENT_TYPES.DOUBLE_OR_NOTHING, teamIndex };

  io.to(player.id).emit('rare_event_start', {
    type: EVENT_TYPES.DOUBLE_OR_NOTHING,
    label: 'Double ou rien',
    pokemon: { name: mon.name, sprite: mon.sprite },
    currentPoints: Math.round(mon.basePoints * mon.multiplier)
  });
  return player.activeEvent;
}

function resolveDoubleOrNothing(game, player, action) {
  const teamIndex = player.activeEvent.teamIndex;
  const risk = !!(action && action.risk === true);

  if (!risk) {
    return {
      result: {
        type: EVENT_TYPES.DOUBLE_OR_NOTHING,
        outcome: 'kept',
        scoreDelta: 0,
        score: player.score,
        team: player.team
      }
    };
  }

  const mon = player.team[teamIndex];
  if (!mon) {
    return {
      result: {
        type: EVENT_TYPES.DOUBLE_OR_NOTHING,
        outcome: 'kept',
        scoreDelta: 0,
        score: player.score,
        team: player.team
      }
    };
  }

  const oldContribution = Math.round(mon.basePoints * mon.multiplier);
  const success = Math.random() < 0.5; // 50/50 côté serveur, jamais le client
  mon.multiplier = success ? mon.multiplier * 2 : 0;
  const newContribution = Math.round(mon.basePoints * mon.multiplier);
  const scoreDelta = newContribution - oldContribution;
  player.score += scoreDelta;

  return {
    result: {
      type: EVENT_TYPES.DOUBLE_OR_NOTHING,
      outcome: success ? 'success' : 'fail',
      pokemon: { name: mon.name, sprite: mon.sprite },
      scoreDelta,
      score: player.score,
      team: player.team
    }
  };
}

// ---- TALENT CACHÉ : le joueur choisit un Pokémon de son équipe, le serveur tire le trait. ----
function startHiddenTalent(game, player) {
  if (player.team.length === 0) return null;

  player.activeEvent = { type: EVENT_TYPES.HIDDEN_TALENT };

  io.to(player.id).emit('rare_event_start', {
    type: EVENT_TYPES.HIDDEN_TALENT,
    label: 'Talent caché',
    team: player.team.map((mon, index) => ({ index, id: mon.id, name: mon.name, sprite: mon.sprite }))
  });
  return player.activeEvent;
}

function resolveHiddenTalent(game, player, action) {
  const index = action && Number.isInteger(action.index) ? action.index : null;
  const mon = index !== null ? player.team[index] : null;
  if (!mon) return { error: 'Pokémon invalide.' };

  const oldContribution = Math.round(mon.basePoints * mon.multiplier);
  const newEffect = randomFrom(EFFECTS.filter(e => e.name !== 'Neutre'));
  mon.effectName = newEffect.name;
  mon.multiplier = newEffect.multiplier;
  const newContribution = Math.round(mon.basePoints * mon.multiplier);
  const scoreDelta = newContribution - oldContribution;
  player.score += scoreDelta;

  return {
    result: {
      type: EVENT_TYPES.HIDDEN_TALENT,
      pokemonName: mon.name,
      sprite: mon.sprite,
      effect: { name: newEffect.name, multiplier: newEffect.multiplier },
      scoreDelta,
      score: player.score,
      team: player.team
    }
  };
}

// ---- DEUXIÈME CHANCE : refaire le choix HAUT/BAS de CE tour, le 2e résultat remplace le 1er. ----
// Les deux résultats originaux (player.currentOptions) sont déjà conservés côté serveur
// depuis le tirage du tour ; on les réutilise tels quels, on ne retire rien tant que le
// joueur n'a pas re-choisi. Ne se déclenche que juste après un vrai choix HAUT/BAS (cf.
// condition dans EVENT_DEFINITIONS) : jamais après un tour 4 → BONUS.
function startSecondChance(game, player) {
  if (!player.currentOptions) return null;
  player.activeEvent = { type: EVENT_TYPES.SECOND_CHANCE };
  io.to(player.id).emit('rare_event_start', {
    type: EVENT_TYPES.SECOND_CHANCE,
    label: 'Deuxième chance'
  });
  return player.activeEvent;
}

function resolveSecondChance(game, player, action) {
  const choice = action && (action.choice === 'HAUT' || action.choice === 'BAS') ? action.choice : null;
  if (!choice || !player.currentOptions) return { error: 'Choix invalide.' };

  // Retire la contribution du Pokémon obtenu par le 1er choix (le tout dernier ajouté ce tour).
  const previousMon = player.team[player.team.length - 1];
  let previousPointsRemoved = 0;
  if (previousMon) {
    previousPointsRemoved = Math.round(previousMon.basePoints * previousMon.multiplier);
    player.team.pop();
    player.score -= previousPointsRemoved;
  }

  const reward = player.currentOptions[choice === 'HAUT' ? 'haut' : 'bas'];
  player.score += reward.finalPoints;
  if (player.team.length < 6) {
    player.team.push({
      id: reward.pokemonId,
      name: reward.name,
      sprite: reward.sprite,
      rarity: reward.rarity,
      basePoints: reward.basePoints,
      effectName: reward.effectName,
      multiplier: reward.multiplier
    });
  }

  return {
    result: {
      type: EVENT_TYPES.SECOND_CHANCE,
      pokemon: { name: reward.name, sprite: reward.sprite },
      rarity: reward.rarity,
      pointsGained: reward.finalPoints,
      previousPointsRemoved,
      score: player.score,
      team: player.team
    }
  };
}

// ---- ÉVOLUTION INSTANTANÉE : le joueur choisit un Pokémon évoluable de son équipe. ----
// Réutilise EVOLUTION_MAP tel quel (déjà un mapping direct vers la forme finale, cf. Bonbon XP).
function startInstantEvolution(game, player) {
  const eligible = player.team
    .map((mon, index) => ({ index, mon }))
    .filter(({ mon }) => EVOLUTION_MAP[mon.id]);
  if (eligible.length === 0) return null;

  player.activeEvent = { type: EVENT_TYPES.INSTANT_EVOLUTION };
  io.to(player.id).emit('rare_event_start', {
    type: EVENT_TYPES.INSTANT_EVOLUTION,
    label: 'Évolution instantanée',
    team: eligible.map(({ index, mon }) => ({ index, id: mon.id, name: mon.name, sprite: mon.sprite }))
  });
  return player.activeEvent;
}

function resolveInstantEvolution(game, player, action) {
  const index = action && Number.isInteger(action.index) ? action.index : null;
  const mon = index !== null ? player.team[index] : null;
  const evolution = mon && EVOLUTION_MAP[mon.id];
  if (!mon || !evolution) return { error: 'Ce Pokémon ne peut pas évoluer.' };

  const oldContribution = Math.round(mon.basePoints * mon.multiplier);
  const fromName = mon.name;
  mon.id = evolution.id;
  mon.name = evolution.name;
  mon.sprite = spriteUrl(evolution.id);
  mon.basePoints = evolution.points;
  mon.evolvedFrom = fromName;
  const newContribution = Math.round(mon.basePoints * mon.multiplier);
  const scoreDelta = newContribution - oldContribution;
  player.score += scoreDelta;

  return {
    result: {
      type: EVENT_TYPES.INSTANT_EVOLUTION,
      from: fromName,
      to: mon.name,
      sprite: mon.sprite,
      scoreDelta,
      score: player.score,
      team: player.team
    }
  };
}

// ---- POKÉMON SHINY : aucun choix, aucun nouveau Pokémon — juste un état ajouté sur celui
// obtenu ce tour, plus un léger bonus de points (jamais un multiplicateur qui casse
// l'équilibrage). Instantané : pas d'activeEvent, résolu et annoncé en un seul emit. ----
const SHINY_BONUS_MULTIPLIER = 1.15; // bonus volontairement léger

function startShinyPokemon(game, player) {
  const mon = player.team[player.team.length - 1];
  if (!mon) return null;

  const oldContribution = Math.round(mon.basePoints * mon.multiplier);
  mon.shiny = true;
  mon.shinySprite = shinySpriteUrl(mon.id);
  mon.multiplier = mon.multiplier * SHINY_BONUS_MULTIPLIER;
  const newContribution = Math.round(mon.basePoints * mon.multiplier);
  const scoreDelta = newContribution - oldContribution;
  player.score += scoreDelta;

  io.to(player.id).emit('rare_event_result', {
    type: EVENT_TYPES.SHINY_POKEMON,
    label: 'Pokémon shiny',
    pokemon: { name: mon.name, sprite: mon.sprite, shinySprite: mon.shinySprite },
    scoreDelta,
    score: player.score,
    team: player.team
  });
  return null; // rien à résoudre : pas de choix pour ce joueur (cf. spec)
}

// ---- TOUR CHANCEUX : pose un plancher de rareté pour le PROCHAIN tirage du joueur.
// Effet différé et à usage unique (cf. player.rarityFloor, consommé dans
// assignTurnOptions / special_choice). Ne garantit jamais un légendaire : seule la
// borne basse de la table change (cf. buildWeightedRarityTable), pas de tirage 100% fixe. ----
const LUCKY_TURN_FLOOR_RARITY = 'epique'; // facilement modifiable

function startLuckyTurn(game, player) {
  player.rarityFloor = LUCKY_TURN_FLOOR_RARITY;
  io.to(player.id).emit('rare_event_result', {
    type: EVENT_TYPES.LUCKY_TURN,
    label: 'Tour chanceux',
    floorRarity: LUCKY_TURN_FLOOR_RARITY
  });
  return null; // effet différé, rien à résoudre maintenant
}

// ---- LOTERIE : 3 cartes générées côté serveur (le client ne voit que leur nombre),
// le joueur choisit un index, jamais le contenu. Récompenses variées en réutilisant
// exactement les systèmes existants (Pokémon / points / trait / évolution). ----
const LOTTERY_POINTS_MIN = 150;
const LOTTERY_POINTS_MAX = 350;

function buildLotteryCard(game, player) {
  const kinds = ['pokemon', 'points'];
  if (player.team.length > 0) kinds.push('trait');
  if (player.team.some(mon => EVOLUTION_MAP[mon.id])) kinds.push('evolution');
  const kind = randomFrom(kinds);

  if (kind === 'points') {
    const points = LOTTERY_POINTS_MIN + Math.floor(Math.random() * (LOTTERY_POINTS_MAX - LOTTERY_POINTS_MIN + 1));
    return { kind, points };
  }
  if (kind === 'trait') {
    const teamIndex = Math.floor(Math.random() * player.team.length);
    const effect = randomFrom(EFFECTS.filter(e => e.name !== 'Neutre'));
    return { kind, teamIndex, effect };
  }
  if (kind === 'evolution') {
    const eligible = player.team.map((mon, index) => ({ index, mon })).filter(({ mon }) => EVOLUTION_MAP[mon.id]);
    const pick = randomFrom(eligible);
    return { kind, teamIndex: pick.index };
  }
  // kind === 'pokemon' (toujours disponible, défaut)
  const useCharm = player.hasShinyCharm && game.turn >= 5;
  return { kind: 'pokemon', pokemon: buildRewardOption(useCharm, player.pity) };
}

function startLottery(game, player) {
  const cards = [1, 2, 3].map(() => buildLotteryCard(game, player));
  player.activeEvent = { type: EVENT_TYPES.LOTTERY, cards };
  io.to(player.id).emit('rare_event_start', {
    type: EVENT_TYPES.LOTTERY,
    label: 'Loterie',
    cardCount: cards.length // le client ne connaît QUE le nombre de cartes, jamais leur contenu
  });
  return player.activeEvent;
}

function resolveLottery(game, player, action) {
  const cards = player.activeEvent.cards;
  const index = action && Number.isInteger(action.index) && action.index >= 0 && action.index < cards.length
    ? action.index
    : null;
  if (index === null) return { error: 'Choix invalide.' };

  const card = cards[index];
  const result = { type: EVENT_TYPES.LOTTERY, kind: card.kind };

  if (card.kind === 'pokemon') {
    player.score += card.pokemon.finalPoints;
    if (player.team.length < 6) {
      player.team.push({
        id: card.pokemon.pokemonId,
        name: card.pokemon.name,
        sprite: card.pokemon.sprite,
        rarity: card.pokemon.rarity,
        basePoints: card.pokemon.basePoints,
        effectName: card.pokemon.effectName,
        multiplier: card.pokemon.multiplier
      });
    }
    result.pokemon = { name: card.pokemon.name, sprite: card.pokemon.sprite };
    result.rarity = card.pokemon.rarity;
    result.pointsGained = card.pokemon.finalPoints;
  } else if (card.kind === 'points') {
    player.score += card.points;
    result.pointsGained = card.points;
  } else if (card.kind === 'trait') {
    const mon = player.team[card.teamIndex];
    if (mon) {
      const oldContribution = Math.round(mon.basePoints * mon.multiplier);
      mon.effectName = card.effect.name;
      mon.multiplier = card.effect.multiplier;
      const newContribution = Math.round(mon.basePoints * mon.multiplier);
      result.scoreDelta = newContribution - oldContribution;
      player.score += result.scoreDelta;
      result.pokemonName = mon.name;
      result.sprite = mon.sprite;
      result.effect = { name: card.effect.name, multiplier: card.effect.multiplier };
    }
  } else if (card.kind === 'evolution') {
    const mon = player.team[card.teamIndex];
    const evolution = mon && EVOLUTION_MAP[mon.id];
    if (mon && evolution) {
      const oldContribution = Math.round(mon.basePoints * mon.multiplier);
      const fromName = mon.name;
      mon.id = evolution.id;
      mon.name = evolution.name;
      mon.sprite = spriteUrl(evolution.id);
      mon.basePoints = evolution.points;
      mon.evolvedFrom = fromName;
      const newContribution = Math.round(mon.basePoints * mon.multiplier);
      result.scoreDelta = newContribution - oldContribution;
      player.score += result.scoreDelta;
      result.from = fromName;
      result.to = mon.name;
      result.sprite = mon.sprite;
    }
  }

  result.score = player.score;
  result.team = player.team;
  return { result };
}

// ---- FAILLE SPATIO-TEMPORELLE : table spéciale (plancher pseudo-légendaire), reste un
// tirage RNG normal via le même mécanisme poids+normalisation — jamais 100% légendaire.
// Instantané, comme SHINY_POKEMON/LUCKY_TURN : aucun choix décrit pour cet événement. ----
const TIME_RIFT_FLOOR_RARITY = 'pseudo_legendaire'; // uniquement pseudo-légendaire ou légendaire, jamais garanti lequel

function startTimeRift(game, player) {
  const useCharm = player.hasShinyCharm && game.turn >= 5;
  const reward = buildRewardOption(useCharm, player.pity, TIME_RIFT_FLOOR_RARITY);

  player.score += reward.finalPoints;
  if (player.team.length < 6) {
    player.team.push({
      id: reward.pokemonId,
      name: reward.name,
      sprite: reward.sprite,
      rarity: reward.rarity,
      basePoints: reward.basePoints,
      effectName: reward.effectName,
      multiplier: reward.multiplier
    });
  }

  io.to(player.id).emit('rare_event_result', {
    type: EVENT_TYPES.TIME_RIFT,
    label: 'Faille spatio-temporelle',
    pokemon: { name: reward.name, sprite: reward.sprite },
    rarity: reward.rarity,
    pointsGained: reward.finalPoints,
    score: player.score,
    team: player.team
  });
  return null; // instantané, aucun choix à faire
}

// Dispatch générique de résolution, appelé par socket.on('rare_event_action').
function resolveEventAction(game, player, action) {
  switch (player.activeEvent.type) {
    case EVENT_TYPES.DOUBLE_ENCOUNTER: return resolveDoubleEncounter(game, player, action);
    case EVENT_TYPES.DOUBLE_OR_NOTHING: return resolveDoubleOrNothing(game, player, action);
    case EVENT_TYPES.HIDDEN_TALENT: return resolveHiddenTalent(game, player, action);
    case EVENT_TYPES.SECOND_CHANCE: return resolveSecondChance(game, player, action);
    case EVENT_TYPES.INSTANT_EVOLUTION: return resolveInstantEvolution(game, player, action);
    case EVENT_TYPES.LOTTERY: return resolveLottery(game, player, action);
    default: return { error: "Type d'événement inconnu." };
  }
}

function buildRoute() {
  return Array.from({ length: MAX_TURNS }, (_, i) => ({
    turn: i + 1,
    status: i === 0 ? 'current' : 'upcoming'
  }));
}

// ---------------------------------------------------------------
// État en mémoire. Aucune base de données pour ce MVP.
// games[gameId] = {
//   id, status: "waiting" | "playing" | "finished",
//   turn, maxTurns, hostId,
//   boss: null tant que la partie n'a pas démarré, puis { id, name, sprite, requiredPoints, difficulty }
//         tiré aléatoirement dans BOSSES au moment du start_game (identique pour tous les joueurs),
//   route,
//   turnTimer: setTimeout id | null (pause de révélation entre 2 tours),
//   players: [player]
// }
// player = {
//   id, name, score, team, currentChoice,
//   currentOptions: { haut, bas } (secret, jamais envoyé tel quel au client),
//   hasShinyCharm: bool (Charme Chroma actif, propre au joueur, effet tours 5-6 uniquement),
//   currentBonusOptions: [keyA, keyB] | null (2 bonus proposés au tour 4, secret intermédiaire),
//   pendingBonusKey: 'xpCandy' | 'mysteryItem' | null (bonus choisi, en attente de la cible)
// }
// ---------------------------------------------------------------
const games = {};

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sans 0/O/1/I

function generateGameId() {
  let id;
  do {
    id = Array.from({ length: 6 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
  } while (games[id]);
  return id;
}

function makePlayer(id, name) {
  return {
    id,
    name,
    score: 0,
    team: [],
    currentChoice: null,
    currentOptions: null,
    hasShinyCharm: false,
    currentBonusOptions: null,
    pendingBonusKey: null,
    pity: 0, // compteur anti-RNG individuel, jamais partagé entre joueurs
    activeEvent: null, // événement rare en cours pour CE joueur (jamais 2 à la fois)
    eventCooldown: 0, // nb de tours restants avant qu'un nouvel événement puisse se tirer
    rarityFloor: null // effet différé de LUCKY_TURN : plancher de rareté pour le PROCHAIN tirage, à usage unique
  };
}

// Ne renvoie jamais currentOptions au client (secret tant que le choix n'est pas fait).
function getPublicPlayers(game) {
  return game.players.map(p => ({
    id: p.id,
    name: p.name,
    score: p.score,
    team: p.team,
    hasChosen: p.currentChoice !== null
  }));
}

function broadcastPlayers(game) {
  io.to(game.id).emit('players_updated', {
    players: getPublicPlayers(game),
    hostId: game.hostId
  });
}

function broadcastGameUpdated(game) {
  io.to(game.id).emit('game_updated', {
    status: game.status,
    turn: game.turn,
    maxTurns: game.maxTurns,
    route: game.route,
    players: getPublicPlayers(game),
    hostId: game.hostId
  });
}

// Génère et envoie individuellement à chaque joueur ses 2 choix (sprite + nom uniquement).
// Le Charme Chroma (par joueur) n'améliore les probabilités qu'aux tours 5 et 6.
function assignTurnOptions(game) {
  game.players.forEach(p => {
    const useCharm = p.hasShinyCharm && game.turn >= 5;
    p.currentOptions = pickPlayerTurnOptions(useCharm, p.pity, p.rarityFloor || undefined);
    p.rarityFloor = null; // effet LUCKY_TURN consommé, à usage unique
    io.to(p.id).emit('turn_options', {
      haut: { name: p.currentOptions.haut.name, sprite: p.currentOptions.haut.sprite },
      bas: { name: p.currentOptions.bas.name, sprite: p.currentOptions.bas.sprite }
    });
  });
}

// Démarre un tour pour tous les joueurs. Au tour 4, phase spéciale : on ne révèle
// rien tout de suite, chaque joueur doit d'abord choisir POKÉMON ou BONUS
// (cf. socket.on('special_choice')). Tous les autres tours : flux normal inchangé.
function startTurnForPlayers(game) {
  if (game.turn === 4) {
    game.players.forEach(p => {
      io.to(p.id).emit('advantage_options', {});
    });
  } else {
    assignTurnOptions(game);
  }
}

function advanceTurn(game) {
  game.route[game.turn - 1].status = 'done';
  game.turn += 1;
  game.route[game.turn - 1].status = 'current';
  game.players.forEach(p => {
    p.currentChoice = null;
    p.currentOptions = null;
    p.currentBonusOptions = null;
    p.pendingBonusKey = null;
    p.activeEvent = null; // un événement non résolu avant le tour suivant expire simplement
    if (p.eventCooldown > 0) p.eventCooldown -= 1;
  });
  broadcastGameUpdated(game);
  startTurnForPlayers(game);
}

function finishGame(game) {
  game.status = 'finished';
  game.route[game.route.length - 1].status = 'done';

  const results = game.players.map(p => ({
    id: p.id,
    name: p.name,
    score: p.score,
    team: p.team,
    result: p.score >= game.boss.requiredPoints ? 'victory' : 'defeat'
  }));

  io.to(game.id).emit('game_finished', {
    boss: game.boss,
    difficulty: game.selectedDifficulty,
    route: game.route,
    players: results
  });
}

// Résout la transition de tour (avance ou termine la partie). Appelé soit par le
// timer de révélation (~4s), soit immédiatement par skip_reveal en solo.
function resolveTurnTransition(game) {
  game.turnTimer = null;
  if (game.turn >= game.maxTurns) {
    finishGame(game);
  } else {
    advanceTurn(game);
  }
}

// Une fois que tous les joueurs présents ont choisi, laisse ~4s de révélation
// avant de faire avancer le tour (ou de terminer la partie), pour tout le monde en même temps.
function maybeScheduleTurnTransition(game) {
  if (game.status !== 'playing') return;
  if (game.turnTimer) return; // déjà planifié, ne pas doubler

  const allChosen = game.players.length > 0 && game.players.every(p => p.currentChoice !== null);
  if (!allChosen) return;

  game.turnTimer = setTimeout(() => resolveTurnTransition(game), REVEAL_DELAY_MS);
}

// Point de sortie commun à la fin d'un tour, que le joueur ait choisi POKÉMON (HAUT/BAS)
// ou BONUS (Bonbon XP / Objet Mystère / Charme Chroma) — un seul chemin de code pour
// diffuser l'état et planifier la transition, évite toute divergence entre les deux flux.
// C'est aussi le point d'accroche des événements rares : tirés pour CE joueur uniquement,
// jamais pour les autres, et sans bloquer la progression normale du tour (le timer de
// révélation / passage au tour suivant n'attend pas la résolution d'un événement).
function finalizePlayerTurn(game, player) {
  broadcastGameUpdated(game);
  maybeScheduleTurnTransition(game);
  if (player) maybeTriggerEvent(game, player);
}

function leaveCurrentGame(socket) {
  const gameId = socket.data.gameId;
  if (!gameId) return;

  const game = games[gameId];
  if (!game) return;

  game.players = game.players.filter(p => p.id !== socket.id);
  socket.leave(gameId);
  socket.data.gameId = null;

  if (game.players.length === 0) {
    if (game.turnTimer) clearTimeout(game.turnTimer);
    delete games[gameId];
    return;
  }

  if (game.hostId === socket.id) {
    game.hostId = game.players[0].id;
  }

  if (game.status === 'waiting') {
    broadcastPlayers(game);
    return;
  }

  broadcastGameUpdated(game);
  maybeScheduleTurnTransition(game);
}

io.on('connection', (socket) => {
  socket.on('create_game', ({ name } = {}) => {
    const trimmed = (name || '').trim();
    if (!trimmed) {
      socket.emit('error_message', 'Pseudo requis.');
      return;
    }

    const gameId = generateGameId();

    games[gameId] = {
      id: gameId,
      status: 'waiting',
      turn: 0,
      maxTurns: MAX_TURNS,
      hostId: socket.id,
      boss: null, // choisi aléatoirement au démarrage (start_game), identique pour tous les joueurs
      selectedDifficulty: 'medium', // choisi par l'hôte dans le lobby ; défaut = MOYEN
      route: buildRoute(),
      turnTimer: null,
      players: [makePlayer(socket.id, trimmed)]
    };

    socket.join(gameId);
    socket.data.gameId = gameId;

    socket.emit('game_created', {
      gameId,
      players: getPublicPlayers(games[gameId]),
      hostId: games[gameId].hostId,
      difficulty: games[gameId].selectedDifficulty
    });
  });

  socket.on('join_game', ({ name, gameId } = {}) => {
    const trimmedName = (name || '').trim();
    const id = (gameId || '').trim().toUpperCase();
    const game = games[id];

    if (!trimmedName) {
      socket.emit('error_message', 'Pseudo requis.');
      return;
    }
    if (!game) {
      socket.emit('error_message', 'Partie introuvable.');
      return;
    }
    if (game.status !== 'waiting') {
      socket.emit('error_message', 'Partie déjà commencée.');
      return;
    }

    game.players.push(makePlayer(socket.id, trimmedName));

    socket.join(id);
    socket.data.gameId = id;

    socket.emit('game_joined', {
      gameId: id,
      players: getPublicPlayers(game),
      hostId: game.hostId,
      difficulty: game.selectedDifficulty
    });

    broadcastPlayers(game);
  });

  socket.on('leave_game', () => {
    leaveCurrentGame(socket);
  });

  socket.on('start_game', () => {
    const gameId = socket.data.gameId;
    const game = games[gameId];

    if (!game) {
      socket.emit('error_message', 'Partie introuvable.');
      return;
    }
    if (game.hostId !== socket.id) {
      socket.emit('error_message', "Seul l'hôte peut démarrer la partie.");
      return;
    }
    if (game.status !== 'waiting') {
      socket.emit('error_message', 'Partie déjà démarrée.');
      return;
    }

    game.status = 'playing';
    game.turn = 1;
    game.route = buildRoute();
    game.boss = pickRandomBoss(game.selectedDifficulty || 'medium');
    game.players.forEach(p => {
      p.score = 0;
      p.team = [];
      p.currentChoice = null;
      p.currentOptions = null;
      p.hasShinyCharm = false;
      p.currentBonusOptions = null;
      p.pendingBonusKey = null;
      p.pity = 0; // compteur anti-RNG propre à chaque nouvelle partie
      p.activeEvent = null;
      p.eventCooldown = 0;
      p.rarityFloor = null;
    });

    io.to(gameId).emit('game_started', {
      gameId: game.id,
      status: game.status,
      turn: game.turn,
      maxTurns: game.maxTurns,
      route: game.route,
      boss: game.boss,
      difficulty: game.selectedDifficulty,
      players: getPublicPlayers(game)
    });

    startTurnForPlayers(game);
  });

  // Rejouer avec les mêmes joueurs : crée une partie entièrement neuve (nouveau code,
  // nouveau boss, nouveaux Pokémon/modificateurs, scores/équipes/route à zéro) et déplace
  // uniquement les joueurs encore connectés dans ce nouveau salon. L'ancienne partie est
  // détruite pour éviter toute fuite d'état vers la nouvelle.
  socket.on('play_again', () => {
    const oldGameId = socket.data.gameId;
    const oldGame = games[oldGameId];

    if (!oldGame) {
      socket.emit('error_message', 'Partie introuvable.');
      return;
    }
    if (oldGame.hostId !== socket.id) {
      socket.emit('error_message', "Seul l'hôte peut relancer une partie.");
      return;
    }
    if (oldGame.status !== 'finished') {
      socket.emit('error_message', "La partie n'est pas terminée.");
      return;
    }

    const newGameId = generateGameId();
    const newGame = {
      id: newGameId,
      status: 'waiting',
      turn: 0,
      maxTurns: MAX_TURNS,
      hostId: oldGame.hostId,
      boss: null,
      selectedDifficulty: oldGame.selectedDifficulty || 'medium', // conservée, modifiable avant le lancement
      route: buildRoute(),
      turnTimer: null,
      players: oldGame.players.map(p => makePlayer(p.id, p.name)) // pity remis à 0 (cf. makePlayer)
    };

    games[newGameId] = newGame;

    // Déplace chaque joueur encore connecté de l'ancien salon vers le nouveau.
    newGame.players.forEach(p => {
      const playerSocket = io.sockets.sockets.get(p.id);
      if (playerSocket) {
        playerSocket.leave(oldGameId);
        playerSocket.join(newGameId);
        playerSocket.data.gameId = newGameId;
      }
    });

    delete games[oldGameId];

    io.to(newGameId).emit('game_replayed', {
      gameId: newGameId,
      players: getPublicPlayers(newGame),
      hostId: newGame.hostId,
      difficulty: newGame.selectedDifficulty
    });
  });

  // Choix de la difficulté du boss dans le lobby. Réservé à l'hôte, uniquement avant
  // le lancement. Le client n'envoie qu'une clé parmi BOSS_GROUPS ; le serveur choisit
  // seul le boss final au démarrage (start_game) — jamais de confiance envers le client.
  socket.on('set_difficulty', ({ difficulty } = {}) => {
    const gameId = socket.data.gameId;
    const game = games[gameId];

    if (!game) {
      socket.emit('error_message', 'Partie introuvable.');
      return;
    }
    if (game.hostId !== socket.id) {
      socket.emit('error_message', "Seul l'hôte peut choisir la difficulté.");
      return;
    }
    if (game.status !== 'waiting') {
      socket.emit('error_message', 'La difficulté ne peut plus être modifiée.');
      return;
    }
    if (!BOSS_GROUPS.includes(difficulty)) {
      socket.emit('error_message', 'Difficulté invalide.');
      return;
    }

    game.selectedDifficulty = difficulty;
    io.to(gameId).emit('difficulty_updated', { difficulty: game.selectedDifficulty });
  });

  socket.on('player_choice', ({ choice } = {}) => {
    const gameId = socket.data.gameId;
    const game = games[gameId];

    if (!game) {
      socket.emit('error_message', 'Partie introuvable.');
      return;
    }
    if (game.status !== 'playing') {
      socket.emit('error_message', "La partie n'est pas en cours.");
      return;
    }
    if (choice !== 'HAUT' && choice !== 'BAS') {
      socket.emit('error_message', 'Choix invalide.');
      return;
    }

    const player = game.players.find(p => p.id === socket.id);
    if (!player) {
      socket.emit('error_message', 'Tu ne fais pas partie de cette partie.');
      return;
    }
    if (player.currentChoice !== null) {
      socket.emit('error_message', 'Choix déjà enregistré pour ce tour.');
      return;
    }
    if (!player.currentOptions) {
      socket.emit('error_message', 'Choix pas encore disponible, réessaie.');
      return;
    }

    player.currentChoice = choice;
    const key = choice === 'HAUT' ? 'haut' : 'bas';
    const reward = player.currentOptions[key];

    // Anti-RNG : bonne rareté -> réinitialise le compteur ; mauvaise -> l'incrémente.
    // Basé UNIQUEMENT sur la rareté effectivement obtenue (pas les 2 options générées).
    player.pity = PITY_GOOD_RARITIES.includes(reward.rarity) ? 0 : (player.pity || 0) + 1;

    player.score += reward.finalPoints;
    if (player.team.length < 6) {
      player.team.push({
        id: reward.pokemonId,
        name: reward.name,
        sprite: reward.sprite,
        rarity: reward.rarity,
        basePoints: reward.basePoints,
        effectName: reward.effectName,
        multiplier: reward.multiplier
      });
    }

    socket.emit('choice_result', {
      pokemon: { name: reward.name, sprite: reward.sprite },
      rarity: reward.rarity,
      basePoints: reward.basePoints,
      effect: { name: reward.effectName, multiplier: reward.multiplier },
      pointsGained: reward.finalPoints,
      score: player.score,
      team: player.team
    });

    finalizePlayerTurn(game, player);
  });

  // Tour 4 uniquement : le joueur choisit POKÉMON (flux HAUT/BAS normal, révélé seulement
  // maintenant) ou BONUS (il renonce à son Pokémon du tour, 2 bonus lui sont proposés).
  socket.on('special_choice', ({ mode } = {}) => {
    const gameId = socket.data.gameId;
    const game = games[gameId];

    if (!game) {
      socket.emit('error_message', 'Partie introuvable.');
      return;
    }
    if (game.status !== 'playing') {
      socket.emit('error_message', "La partie n'est pas en cours.");
      return;
    }
    if (game.turn !== 4) {
      socket.emit('error_message', 'Le choix spécial est réservé au tour 4.');
      return;
    }
    if (mode !== 'POKEMON' && mode !== 'BONUS') {
      socket.emit('error_message', 'Mode invalide.');
      return;
    }

    const player = game.players.find(p => p.id === socket.id);
    if (!player) {
      socket.emit('error_message', 'Tu ne fais pas partie de cette partie.');
      return;
    }
    if (player.currentChoice !== null || player.currentOptions || player.currentBonusOptions || player.pendingBonusKey) {
      socket.emit('error_message', 'Choix déjà en cours pour ce tour.');
      return;
    }

    if (mode === 'POKEMON') {
      // Flux identique aux autres tours (charme jamais actif au tour 4, il ne commence qu'au tour 5).
      player.currentOptions = pickPlayerTurnOptions(false, player.pity, player.rarityFloor || undefined);
      player.rarityFloor = null; // effet LUCKY_TURN consommé, à usage unique
      socket.emit('turn_options', {
        haut: { name: player.currentOptions.haut.name, sprite: player.currentOptions.haut.sprite },
        bas: { name: player.currentOptions.bas.name, sprite: player.currentOptions.bas.sprite }
      });
      return;
    }

    // mode === 'BONUS'
    const [keyA, keyB] = pickTwoBonuses(player);
    player.currentBonusOptions = [keyA, keyB];
    socket.emit('bonus_options', {
      bonuses: [keyA, keyB].map(key => ({ key, label: BONUS_LABELS[key] }))
    });
  });

  // Le joueur choisit l'un des deux bonus qui lui ont été proposés. Le serveur vérifie
  // que ce bonus faisait bien partie des deux options tirées pour LUI (jamais de confiance
  // aveugle envers une clé envoyée directement par le client).
  socket.on('bonus_choice', ({ key } = {}) => {
    const gameId = socket.data.gameId;
    const game = games[gameId];

    if (!game) {
      socket.emit('error_message', 'Partie introuvable.');
      return;
    }
    const player = game.players.find(p => p.id === socket.id);
    if (!player) {
      socket.emit('error_message', 'Tu ne fais pas partie de cette partie.');
      return;
    }
    if (!player.currentBonusOptions || !player.currentBonusOptions.includes(key)) {
      socket.emit('error_message', "Ce bonus ne t'a pas été proposé.");
      return;
    }

    if (key === 'shinyCharm') {
      player.hasShinyCharm = true;
      player.currentBonusOptions = null;
      player.currentChoice = 'BONUS';
      socket.emit('bonus_result', {
        type: 'shinyCharm',
        score: player.score,
        team: player.team
      });
      finalizePlayerTurn(game, player);
      return;
    }

    if (key === 'xpCandy') {
      const eligible = player.team
        .map((mon, index) => ({ index, mon }))
        .filter(({ mon }) => EVOLUTION_MAP[mon.id]);
      player.currentBonusOptions = null;
      player.pendingBonusKey = 'xpCandy';
      socket.emit('xp_candy_pending', {
        team: eligible.map(({ index, mon }) => ({ index, id: mon.id, name: mon.name, sprite: mon.sprite }))
      });
      return;
    }

    if (key === 'mysteryItem') {
      player.currentBonusOptions = null;
      player.pendingBonusKey = 'mysteryItem';
      socket.emit('mystery_item_pending', {
        team: player.team.map((mon, index) => ({ index, id: mon.id, name: mon.name, sprite: mon.sprite }))
      });
    }
  });

  // Bonbon XP : le joueur choisit QUEL Pokémon de son équipe évolue jusqu'à sa forme finale.
  socket.on('xp_candy_select', ({ index } = {}) => {
    const gameId = socket.data.gameId;
    const game = games[gameId];

    if (!game) {
      socket.emit('error_message', 'Partie introuvable.');
      return;
    }
    const player = game.players.find(p => p.id === socket.id);
    if (!player) {
      socket.emit('error_message', 'Tu ne fais pas partie de cette partie.');
      return;
    }
    if (player.pendingBonusKey !== 'xpCandy') {
      socket.emit('error_message', 'Aucun Bonbon XP en attente.');
      return;
    }

    const mon = player.team[index];
    const evolution = mon && EVOLUTION_MAP[mon.id];
    if (!mon || !evolution) {
      socket.emit('error_message', 'Ce Pokémon ne peut pas évoluer.');
      return;
    }

    const oldContribution = Math.round(mon.basePoints * mon.multiplier);
    const fromName = mon.name;
    mon.id = evolution.id;
    mon.name = evolution.name;
    mon.sprite = spriteUrl(evolution.id);
    mon.basePoints = evolution.points;
    mon.evolvedFrom = fromName;
    const newContribution = Math.round(mon.basePoints * mon.multiplier);
    const scoreDelta = newContribution - oldContribution;
    player.score += scoreDelta;

    player.pendingBonusKey = null;
    player.currentBonusOptions = null;
    player.currentChoice = 'BONUS';

    socket.emit('bonus_result', {
      type: 'xpCandy',
      from: fromName,
      to: mon.name,
      sprite: mon.sprite,
      scoreDelta,
      score: player.score,
      team: player.team
    });

    finalizePlayerTurn(game, player);
  });

  // Objet Mystère : le joueur choisit QUEL Pokémon reçoit un trait, le trait lui-même
  // est tiré aléatoirement par le serveur (le joueur ne le choisit jamais).
  socket.on('mystery_item_select', ({ index } = {}) => {
    const gameId = socket.data.gameId;
    const game = games[gameId];

    if (!game) {
      socket.emit('error_message', 'Partie introuvable.');
      return;
    }
    const player = game.players.find(p => p.id === socket.id);
    if (!player) {
      socket.emit('error_message', 'Tu ne fais pas partie de cette partie.');
      return;
    }
    if (player.pendingBonusKey !== 'mysteryItem') {
      socket.emit('error_message', 'Aucun Objet Mystère en attente.');
      return;
    }

    const mon = player.team[index];
    if (!mon) {
      socket.emit('error_message', 'Pokémon invalide.');
      return;
    }

    const oldContribution = Math.round(mon.basePoints * mon.multiplier);
    const newEffect = randomFrom(EFFECTS.filter(e => e.name !== 'Neutre'));
    mon.effectName = newEffect.name;
    mon.multiplier = newEffect.multiplier;
    const newContribution = Math.round(mon.basePoints * mon.multiplier);
    const scoreDelta = newContribution - oldContribution;
    player.score += scoreDelta;

    player.pendingBonusKey = null;
    player.currentBonusOptions = null;
    player.currentChoice = 'BONUS';

    socket.emit('bonus_result', {
      type: 'mysteryItem',
      pokemonName: mon.name,
      sprite: mon.sprite,
      effect: { name: newEffect.name, multiplier: newEffect.multiplier },
      scoreDelta,
      score: player.score,
      team: player.team
    });

    finalizePlayerTurn(game, player);
  });

  // Point d'entrée UNIQUE pour répondre à un événement rare, quel qu'il soit (architecture
  // extensible : les futurs événements — étapes 3/4 — n'ajoutent pas de nouvel event Socket.IO,
  // juste un cas dans resolveEventAction). Le serveur ne fait jamais confiance à l'action
  // envoyée : il valide qu'un événement est bien actif pour CE joueur avant tout traitement,
  // et chaque resolveXxx revalide ensuite l'index/le choix par rapport à ce qui a été
  // réellement proposé (jamais une valeur arbitraire envoyée par le client).
  socket.on('rare_event_action', (action = {}) => {
    const gameId = socket.data.gameId;
    const game = games[gameId];

    if (!game) {
      socket.emit('error_message', 'Partie introuvable.');
      return;
    }
    const player = game.players.find(p => p.id === socket.id);
    if (!player) {
      socket.emit('error_message', 'Tu ne fais pas partie de cette partie.');
      return;
    }
    if (!player.activeEvent) {
      socket.emit('error_message', 'Aucun événement en cours.');
      return;
    }

    const outcome = resolveEventAction(game, player, action);

    if (!outcome || outcome.error) {
      socket.emit('error_message', (outcome && outcome.error) || 'Action invalide.');
      return;
    }

    player.activeEvent = null; // résolu : nettoyage systématique avant tout autre traitement
    broadcastGameUpdated(game); // score/équipe changés hors du flux de tour normal -> resynchronise tout le monde
    socket.emit('rare_event_result', outcome.result);
  });

  // Solo uniquement : passe immédiatement la pause de révélation en cours. Le serveur
  // revérifie lui-même qu'il n'y a bien qu'un seul joueur (jamais confiance au client).
  socket.on('skip_reveal', () => {
    const gameId = socket.data.gameId;
    const game = games[gameId];

    if (!game || game.status !== 'playing') return;
    if (game.players.length !== 1) {
      socket.emit('error_message', 'Le skip est réservé au mode solo.');
      return;
    }
    if (!game.turnTimer) return; // rien à sauter pour le moment

    clearTimeout(game.turnTimer);
    resolveTurnTransition(game);
  });

  socket.on('get_game_state', ({ gameId } = {}) => {
    const game = games[gameId];
    if (!game) {
      socket.emit('error_message', 'Partie introuvable.');
      return;
    }
    socket.emit('game_state', {
      gameId: game.id,
      status: game.status,
      turn: game.turn,
      maxTurns: game.maxTurns,
      route: game.route,
      boss: game.boss,
      players: getPublicPlayers(game),
      hostId: game.hostId
    });
  });

  socket.on('disconnect', () => {
    leaveCurrentGame(socket);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Serveur lancé sur http://localhost:${PORT}`);
});