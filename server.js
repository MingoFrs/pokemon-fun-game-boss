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
// SHINY — indépendant de la rareté et de l'effet/trait. 2% de chance qu'un Pokémon
// nouvellement généré soit chromatique ; ses points sont alors multipliés par
// SHINY_POINTS_MULTIPLIER en plus de son effet (cumulatif, jamais à la place). Constante
// UNIQUE et partagée : utilisée à la fois au tirage (buildRewardOption/buildAdminModeOption)
// et par l'événement rare POKÉMON SHINY (qui rend chromatique un Pokémon déjà en équipe) —
// un seul chiffre à ajuster pour tout le jeu, jamais deux mécaniques qui divergent.
// -----------------------------------------------------------------
const SHINY_CHANCE = 0.02;
const SHINY_POINTS_MULTIPLIER = 1.5;

function rollShiny() {
  return Math.random() < SHINY_CHANCE;
}

// -----------------------------------------------------------------
// EASTER EGG — MÉTAMORPH (dex 132). Cliquer sur un Métamorph dans son équipe (cf.
// socket.on('transform_metamorph')) le transforme : il copie le sprite d'un AUTRE
// Pokémon au hasard dans la même équipe et prend 75% de sa valeur actuelle. Le nom
// affiché reste TOUJOURS "Métamorph" (jamais réécrit, c'est tout le principe).
// -----------------------------------------------------------------
const METAMORPH_DEX_ID = 132;
const METAMORPH_TRANSFORM_MULTIPLIER = 0.75;

// -----------------------------------------------------------------
// Pool de Pokémon organisé par rareté.
// Chaque tour, le serveur tire d'abord une rareté (selon RARITY_TABLE),
// puis un Pokémon au hasard dans cette rareté.
// -----------------------------------------------------------------

const COMMON_RAW = [
  { id: 10, name: 'Chenipan', points: 56 },
  { id: 13, name: 'Aspicot', points: 57 },
  { id: 280, name: 'Tarsal', points: 57 },
  { id: 265, name: 'Chenipotte', points: 57 },
  { id: 129, name: 'Magicarpe', points: 60 },
  { id: 194, name: 'Axoloto', points: 68 },
  { id: 161, name: 'Fouinette', points: 70 },
  { id: 261, name: 'Medhyèna', points: 74 },
  { id: 263, name: 'Zigzaton', points: 90 },
  { id: 396, name: 'Étourmi', points: 93 },
  { id: 41, name: 'Nosferapti', points: 94 },
  { id: 399, name: 'Keunotor', points: 96 },
  { id: 16, name: 'Roucool', points: 97 },
  { id: 19, name: 'Rattata', points: 100 },
  { id: 21, name: 'Piafabec', points: 104 },
  { id: 163, name: 'Hoothoot', points: 105 },
  { id: 50, name: 'Taupiqueur', points: 107 },
  { id: 276, name: 'Nirondelle', points: 111 },
  { id: 39, name: 'Rondoudou', points: 112 },
  { id: 29, name: 'Nidoran Femelle', points: 114 },
  { id: 32, name: 'Nidoran Mâle', points: 114 },
  { id: 46, name: 'Paras', points: 123 },
  { id: 23, name: 'Abo', points: 124 },
  { id: 52, name: 'Miaouss', points: 126 },
  { id: 116, name: 'Hypotrempe', points: 130 },
  { id: 37, name: 'Goupix', points: 132 },
  { id: 60, name: 'Ptitard', points: 134 },
  { id: 74, name: 'Racaillou', points: 134 },
  { id: 27, name: 'Sabelette', points: 135 },
  { id: 69, name: 'Chétiflor', points: 135 },
  { id: 56, name: 'Férosinge', points: 136 },
  { id: 48, name: 'Mimitoss', points: 138 },
  { id: 90, name: 'Kokiyas', points: 138 },
  { id: 155, name: 'Héricendre', points: 139 },
  { id: 84, name: 'Doduo', points: 140 },
  { id: 252, name: 'Arcko', points: 140 },
  { id: 4, name: 'Salamèche', points: 141 },
  { id: 255, name: 'Poussifeu', points: 141 },
  { id: 258, name: 'Gobou', points: 142 },
  { id: 7, name: 'Carapuce', points: 143 },
  { id: 158, name: 'Kaiminus', points: 144 },
  { id: 1, name: 'Bulbizarre', points: 146 },
  { id: 43, name: 'Mystherbe', points: 148 },
  { id: 152, name: 'Germignon', points: 148 },
  { id: 35, name: 'Mélofée', points: 149 },
  { id: 54, name: 'Psykokwak', points: 149 },
  { id: 118, name: 'Poissirène', points: 150 },
  { id: 98, name: 'Krabby', points: 151 },
  { id: 88, name: 'Tadmorv', points: 152 },
  { id: 86, name: 'Otaria', points: 152 },
  { id: 102, name: 'Noeunoeuf', points: 152 },
  { id: 100, name: 'Voltorbe', points: 155 },
  { id: 96, name: 'Soporifik', points: 155 },
  { id: 216, name: 'Teddiursa', points: 157 },
  { id: 72, name: 'Tentacool', points: 159 },
  { id: 120, name: 'Stari', points: 162 },
  { id: 109, name: 'Smogo', points: 163 },
  { id: 140, name: 'Kabuto', points: 175 },
  { id: 108, name: 'Excelangue', points: 196 }
];

const UNCOMMON_RAW = [
  { id: 132, name: 'Métamorph', points: 207 },
  { id: 147, name: 'Minidraco', points: 210 },
  { id: 66, name: 'Machoc', points: 213 },
  { id: 79, name: 'Ramoloss', points: 216 },
  { id: 81, name: 'Magnéti', points: 221 },
  { id: 17, name: 'Roucoups', points: 230 },
  { id: 111, name: 'Rhinocorne', points: 230 },
  { id: 58, name: 'Caninos', points: 230 },
  { id: 30, name: 'Nidorina', points: 236 },
  { id: 33, name: 'Nidorino', points: 237 },
  { id: 269, name: 'Papinox', points: 244 },
  { id: 70, name: 'Boustiflor', points: 245 },
  { id: 44, name: 'Ortide', points: 247 },
  { id: 75, name: 'Gravalanch', points: 247 },
  { id: 267, name: 'Charmillon', points: 247 },
  { id: 137, name: 'Porygon', points: 248 },
  { id: 259, name: 'Flobio', points: 250 },
  { id: 51, name: 'Triopikeur', points: 251 },
  { id: 253, name: 'Massko', points: 251 },
  { id: 77, name: 'Ponyta', points: 252 },
  { id: 47, name: 'Parasect', points: 252 },
  { id: 256, name: 'Galifeu', points: 252 },
  { id: 400, name: 'Bibarel', points: 253 },
  { id: 262, name: 'Grahyèna', points: 257 },
  { id: 264, name: 'Linéon', points: 258 },
  { id: 104, name: 'Osselait', points: 261 },
  { id: 24, name: 'Arbok', points: 264 },
  { id: 53, name: 'Persian', points: 266 },
  { id: 42, name: 'Nosferalto', points: 270 },
  { id: 85, name: 'Dodrio', points: 272 },
  { id: 122, name: 'M. Mime', points: 273 },
  { id: 99, name: 'Krabboss', points: 278 },
  { id: 101, name: 'Électrode', points: 281 },
  { id: 121, name: 'Staross', points: 296 }
];

const RARE_RAW = [
  { id: 25, name: 'Pikachu', points: 307 },
  { id: 63, name: 'Abra', points: 312 },
  { id: 92, name: 'Fantominus', points: 313 },
  { id: 133, name: 'Évoli', points: 323 },
  { id: 302, name: 'Ténéfix', points: 364 },
  { id: 303, name: 'Mysdibule', points: 364 },
  { id: 95, name: 'Onix', points: 369 },
  { id: 315, name: 'Rosélia', points: 378 },
  { id: 67, name: 'Machopeur', points: 383 },
  { id: 358, name: 'Éoko', points: 397 },
  { id: 203, name: 'Girafarig', points: 418 },
  { id: 277, name: 'Hélédelle', points: 420 },
  { id: 359, name: 'Absol', points: 426 },
  { id: 82, name: 'Magnéton', points: 427 },
  { id: 18, name: 'Roucarnage', points: 430 },
  { id: 26, name: 'Raichu', points: 435 },
  { id: 45, name: 'Rafflesia', points: 437 },
  { id: 71, name: 'Empiflor', points: 437 },
  { id: 80, name: 'Flagadoss', points: 445 },
  { id: 241, name: 'Écrémeuh', points: 445 },
  { id: 31, name: 'Nidoqueen', points: 448 },
  { id: 34, name: 'Nidoking', points: 450 },
  { id: 78, name: 'Galopa', points: 451 },
  { id: 127, name: 'Scarabrute', points: 451 },
  { id: 123, name: 'Insécateur', points: 452 },
  { id: 55, name: 'Akwakwak', points: 453 },
  { id: 73, name: 'Tentacruel', points: 463 },
  { id: 3, name: 'Florizarre', points: 470 },
  { id: 9, name: 'Tortank', points: 474 },
  { id: 6, name: 'Dracaufeu', points: 478 },
  { id: 130, name: 'Léviator', points: 482 }
];

// NERF (~22.5%, appliqué au point de base, AVANT le multiplicateur bonus/malus) :
// épique / pseudo-légendaire / légendaire uniquement. Commun/peu commun/rare inchangés.
const EPIC_RAW = [
  { id: 113, name: 'Leveinard', points: 495 },
  { id: 778, name: 'Mimiqui', points: 540 },
  { id: 76, name: 'Grolem', points: 557 },
  { id: 398, name: 'Étouraptor', points: 557 },
  { id: 94, name: 'Ectoplasma', points: 581 },
  { id: 68, name: 'Mackogneur', points: 590 },
  { id: 282, name: 'Gardevoir', points: 611 },
  { id: 475, name: 'Gallame', points: 613 },
  { id: 448, name: 'Lucario', points: 622 },
  { id: 254, name: 'Jungko', points: 632 },
  { id: 257, name: 'Braségali', points: 633 },
  { id: 260, name: 'Laggron', points: 640 },
  { id: 131, name: 'Lokhlass', points: 642 },
  { id: 350, name: 'Milobellus', points: 648 },
  { id: 143, name: 'Ronflex', points: 649 },
  { id: 637, name: 'Volcarona', points: 665 }
];

// Vrais pseudo-légendaires (évolution 3 stades, très puissants, mais pas légendaires).
// NERF CIBLÉ (~12%, sur les points déjà nerfés de l'étape précédente) : seuls les Pokémon
// clairement au-dessus de la moyenne de leur propre palier sont concernés.
// Moyenne pseudo-légendaire ≈ 818 → Dragapult (890, +8.8%) est le seul net outlier.
const PSEUDO_LEGENDARY_RAW = [
  { id: 149, name: 'Dracolosse', points: 801 },
  { id: 248, name: 'Tyranocif', points: 801 },
  { id: 373, name: 'Drattak', points: 801 },
  { id: 445, name: 'Carchacrok', points: 802 },
  { id: 376, name: 'Métalosse', points: 802 },
  { id: 635, name: 'Trioxhydre', points: 802 },
  { id: 887, name: 'Dragapult', points: 802 },
  { id: 706, name: 'Muplodocus', points: 802 }
];

// Moyenne légendaire ≈ 1334 → seuls les 5 nettement au-dessus (>+10%) sont nerfés :
// Arceus (1550, +16%), Koraidon/Miraidon (1510, +13%), Zacian/Zamazenta (1475, +11%).
// Necrozma (1435, +7.6%) reste inchangé : pas assez d'écart pour être "clairement" trop fort.
const LEGENDARY_RAW = [
  { id: 144, name: 'Artikodin', points: 952 },
  { id: 145, name: 'Électhor', points: 952 },
  { id: 146, name: 'Sulfura', points: 952 },
  { id: 385, name: 'Jirachi', points: 1014 },
  { id: 386, name: 'Deoxys', points: 1015 },
  { id: 491, name: 'Darkrai', points: 1015 },
  { id: 800, name: 'Necrozma', points: 1015 },
  { id: 807, name: 'Zeraora', points: 1015 },
  { id: 492, name: 'Shaymin', points: 1015 },
  { id: 802, name: 'Marshadow', points: 1016 },
  { id: 151, name: 'Mew', points: 1016 },
  { id: 494, name: 'Victini', points: 1016 },
  { id: 251, name: 'Celebi', points: 1017 },
  { id: 720, name: 'Hoopa', points: 1017 },
  { id: 889, name: 'Zamazenta', points: 1207 },
  { id: 646, name: 'Kyurem', points: 1208 },
  { id: 888, name: 'Zacian', points: 1210 },
  { id: 1008, name: 'Miraidon', points: 1239 },
  { id: 383, name: 'Groudon', points: 1241 },
  { id: 382, name: 'Kyogre', points: 1241 },
  { id: 1007, name: 'Koraidon', points: 1242 },
  { id: 483, name: 'Dialga', points: 1271 },
  { id: 644, name: 'Zekrom', points: 1271 },
  { id: 791, name: 'Solgaleo', points: 1271 },
  { id: 484, name: 'Palkia', points: 1272 },
  { id: 792, name: 'Lunala', points: 1272 },
  { id: 716, name: 'Xerneas', points: 1272 },
  { id: 150, name: 'Mewtwo', points: 1273 },
  { id: 717, name: 'Yveltal', points: 1273 },
  { id: 249, name: 'Lugia', points: 1273 },
  { id: 250, name: 'Ho-Oh', points: 1273 },
  { id: 487, name: 'Giratina', points: 1273 },
  { id: 384, name: 'Rayquaza', points: 1274 },
  { id: 643, name: 'Reshiram', points: 1274 },
  { id: 493, name: 'Arceus', points: 1401 }
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
  1: { id: 3, name: 'Florizarre', points: 470 },
  4: { id: 6, name: 'Dracaufeu', points: 478 },
  7: { id: 9, name: 'Tortank', points: 474 },
  10: { id: 12, name: 'Papilusion', points: 374 },
  13: { id: 15, name: 'Dardargnan', points: 367 },
  16: { id: 18, name: 'Roucarnage', points: 430 },
  17: { id: 18, name: 'Roucarnage', points: 430 },
  19: { id: 20, name: 'Rattatac', points: 387 },
  23: { id: 24, name: 'Arbok', points: 264 },
  27: { id: 28, name: 'Sablaireau', points: 414 },
  29: { id: 31, name: 'Nidoqueen', points: 448 },
  30: { id: 31, name: 'Nidoqueen', points: 448 },
  32: { id: 34, name: 'Nidoking', points: 450 },
  33: { id: 34, name: 'Nidoking', points: 450 },
  35: { id: 36, name: 'Mélodelfe', points: 431 },
  37: { id: 38, name: 'Feunard', points: 588 },
  39: { id: 40, name: 'Grodoudou', points: 396 },
  41: { id: 169, name: 'Nostenfer', points: 640 },
  42: { id: 169, name: 'Nostenfer', points: 640 },
  43: { id: 45, name: 'Rafflesia', points: 437 },
  44: { id: 45, name: 'Rafflesia', points: 437 },
  46: { id: 47, name: 'Parasect', points: 252 },
  48: { id: 49, name: 'Aéromite', points: 414 },
  50: { id: 51, name: 'Triopikeur', points: 251 },
  52: { id: 53, name: 'Persian', points: 266 },
  54: { id: 55, name: 'Akwakwak', points: 453 },
  56: { id: 57, name: 'Colossinge', points: 418 },
  58: { id: 59, name: 'Arcanin', points: 674 },
  60: { id: 62, name: 'Tartard', points: 580 },
  63: { id: 65, name: 'Alakazam', points: 580 },
  66: { id: 68, name: 'Mackogneur', points: 590 },
  67: { id: 68, name: 'Mackogneur', points: 590 },
  69: { id: 71, name: 'Empiflor', points: 437 },
  70: { id: 71, name: 'Empiflor', points: 437 },
  72: { id: 73, name: 'Tentacruel', points: 463 },
  74: { id: 76, name: 'Grolem', points: 557 },
  75: { id: 76, name: 'Grolem', points: 557 },
  77: { id: 78, name: 'Galopa', points: 451 },
  79: { id: 80, name: 'Flagadoss', points: 445 },
  81: { id: 82, name: 'Magnéton', points: 427 },
  84: { id: 85, name: 'Dodrio', points: 272 },
  88: { id: 89, name: 'Grotadmorv', points: 580 },
  92: { id: 94, name: 'Ectoplasma', points: 581 },
  98: { id: 99, name: 'Krabboss', points: 278 },
  100: { id: 101, name: 'Électrode', points: 281 },
  104: { id: 105, name: 'Ossatueur', points: 396 },
  109: { id: 110, name: 'Smogogo', points: 563 },
  111: { id: 112, name: 'Rhinoféros', points: 554 },
  116: { id: 230, name: 'Hyporoi', points: 648 },
  120: { id: 121, name: 'Staross', points: 296 },
  129: { id: 130, name: 'Léviator', points: 482 },
  140: { id: 141, name: 'Kabutops', points: 572 },
  147: { id: 149, name: 'Dracolosse', points: 801 }
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
// extraBoost est optionnel (CROSSED_FATES) : un petit bonus supplémentaire sur les mêmes
// raretés que le pity, cumulable avec pity/Charme mais toujours renormalisé une seule fois.
function buildWeightedRarityTable({ useCharm, pity, floorRarity, extraBoost }) {
  const pityMultiplier = getPityMultiplier(pity);
  const boost = extraBoost || 1;
  let weighted = RARITY_TABLE.map(entry => {
    let weight = entry.weight;
    if (useCharm && SHINY_CHARM_BOOSTED_RARITIES.includes(entry.rarity)) weight *= SHINY_CHARM_MULTIPLIER;
    if (PITY_BOOSTED_RARITIES.includes(entry.rarity)) weight *= pityMultiplier * boost;
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

function pickRarity(useCharm, pity, floorRarity, extraBoost) {
  const table = buildWeightedRarityTable({ useCharm, pity, floorRarity, extraBoost });
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
  { name: 'Salzmann secret technique', multiplier: 1.2, weight: 3.125 },
  { name: 'Beauty privilege', multiplier: 1.3, weight: 3.125 },
  { name: 'Motivé', multiplier: 1.1, weight: 3.125 },
  { name: 'Sous steroïde', multiplier: 1.15, weight: 3.125 },
  { name: 'Sub-5', multiplier: 0.75, weight: 3.125 },
  { name: 'Lagging', multiplier: 0.8, weight: 3.125 },
  { name: 'Skill issues', multiplier: 0.6, weight: 3.125 },
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

// ---- Helpers de mutation d'un Pokémon d'équipe (factorisent un pattern répété par
// tous les événements rares qui modifient un Pokémon existant : talent caché, évolution
// instantanée, double ou rien, shiny, loterie, Bonbon XP, Objet Mystère). ----

// Contribution actuelle d'un Pokémon au score (arrondie, jamais stockée : recalculée
// à chaque fois à partir de basePoints/multiplier, seule source de vérité).
function monContribution(mon) {
  return Math.round(mon.basePoints * mon.multiplier);
}

// Applique une mutation à un Pokémon puis répercute la différence de contribution sur
// le score du joueur. `mutate` reçoit le Pokémon et le modifie en place. Retourne le
// scoreDelta appliqué.
function applyMonMutation(player, mon, mutate) {
  const before = monContribution(mon);
  mutate(mon);
  const after = monContribution(mon);
  const scoreDelta = after - before;
  player.score += scoreDelta;
  return scoreDelta;
}

// Fait évoluer un Pokémon vers sa forme finale (EVOLUTION_MAP). Mutation en place,
// retourne le nom d'origine (utile pour l'affichage "from -> to").
function evolveMon(mon, evolution) {
  const fromName = mon.name;
  mon.id = evolution.id;
  mon.name = evolution.name;
  mon.sprite = spriteUrl(evolution.id);
  // Un Pokémon shiny qui évolue reste shiny : son sprite chromatique doit lui aussi
  // pointer vers la NOUVELLE forme, sinon l'ancien sprite shiny (désormais périmé)
  // continue d'être affiché indéfiniment (pokemonSprite() le préfère à mon.sprite).
  if (mon.shiny) {
    mon.shinySprite = shinySpriteUrl(evolution.id);
  }
  mon.basePoints = evolution.points;
  mon.evolvedFrom = fromName;
  return fromName;
}

// Assigne un trait/effet à un Pokémon. Mutation en place.
function assignEffect(mon, effect) {
  mon.effectName = effect.name;
  mon.multiplier = effect.multiplier;
}

// Construit un Pokémon d'équipe prêt à être poussé dans player.team, à partir d'une
// récompense tirée par buildRewardOption (ou d'un objet de même forme, ex. carte loterie).
// shiny/shinySprite ne sont ajoutés QUE si la récompense est effectivement shiny : garde
// les objets d'équipe non-shiny identiques à avant (mêmes clés qu'avant l'ajout du shiny).
function teamMonFromReward(reward) {
  const mon = {
    id: reward.pokemonId,
    name: reward.name,
    sprite: reward.sprite,
    rarity: reward.rarity,
    basePoints: reward.basePoints,
    effectName: reward.effectName,
    multiplier: reward.multiplier
  };
  if (reward.shiny) {
    mon.shiny = true;
    mon.shinySprite = reward.shinySprite;
  }
  return mon;
}

// Construit une récompense secrète complète (rareté → Pokémon + effet + points calculés).
// floorRarity est optionnel (LUCKY_TURN, TIME_RIFT) ; extraBoost aussi (CROSSED_FATES) :
// undefined pour les deux = comportement inchangé. shiny est tiré ici, indépendamment de
// la rareté/l'effet (cf. SHINY_CHANCE) : s'applique donc à TOUT ce qui appelle cette
// fonction (tirage normal, DOUBLE_ENCOUNTER, MIRROR, TIME_RIFT, LOTTERY).
function buildRewardOption(useCharm, pity, floorRarity, extraBoost) {
  const rarity = pickRarity(useCharm, pity, floorRarity, extraBoost);
  const pokemon = randomFrom(POKEMON_POOLS[rarity]);
  const effect = pickEffect();
  const shiny = rollShiny();
  const finalPoints = Math.round(pokemon.points * effect.multiplier * (shiny ? SHINY_POINTS_MULTIPLIER : 1));

  return {
    pokemonId: pokemon.id,
    name: pokemon.name,
    sprite: pokemon.sprite,
    rarity: pokemon.rarity,
    basePoints: pokemon.points,
    effectName: effect.name,
    multiplier: effect.multiplier,
    shiny,
    shinySprite: shiny ? shinySpriteUrl(pokemon.id) : null,
    finalPoints
  };
}

// Génère les 2 options HAUT/BAS d'un joueur pour un tour (toujours 2 Pokémon distincts).
function pickPlayerTurnOptions(useCharm, pity, floorRarity, extraBoost) {
  const haut = buildRewardOption(useCharm, pity, floorRarity, extraBoost);
  let bas = buildRewardOption(useCharm, pity, floorRarity, extraBoost);

  let guard = 0;
  while (bas.pokemonId === haut.pokemonId && guard < 10) {
    bas = buildRewardOption(useCharm, pity, floorRarity, extraBoost);
    guard += 1;
  }

  return { haut, bas };
}

// -----------------------------------------------------------------
// GAMEMODE "ADMIN VS JOUEUR" — génération des options de tour.
//
// Contrairement au mode normal, chaque option est tirée INDÉPENDAMMENT dans une table
// de raretés dédiée (ADMIN_MODE_RARITY_TABLE), volontairement inclinée vers les raretés
// fortes, mais SANS jamais empêcher deux Pokémon faibles — ou deux légendaires — de se
// retrouver face à face : c'est le principe même du mode (écarts de puissance imprévisibles,
// cf. spec section 7-10). Pas de pity, pas de plancher, pas de Charme Chroma ici : ce mode
// est volontairement chaotique, pas équilibré sur la durée comme le mode normal.
// -----------------------------------------------------------------
const ADMIN_MODE_RARITY_TABLE = [
  { rarity: 'commun', weight: 0.16 },
  { rarity: 'peu_commun', weight: 0.16 },
  { rarity: 'rare', weight: 0.20 },
  { rarity: 'epique', weight: 0.20 },
  { rarity: 'pseudo_legendaire', weight: 0.16 },
  { rarity: 'legendaire', weight: 0.12 }
];

function pickAdminModeRarity() {
  const roll = Math.random();
  let cumulative = 0;
  for (const entry of ADMIN_MODE_RARITY_TABLE) {
    cumulative += entry.weight;
    if (roll < cumulative) return entry.rarity;
  }
  return ADMIN_MODE_RARITY_TABLE[ADMIN_MODE_RARITY_TABLE.length - 1].rarity; // filet de sécurité (arrondis flottants)
}

function buildAdminModeOption() {
  const rarity = pickAdminModeRarity();
  const pokemon = randomFrom(POKEMON_POOLS[rarity]);
  const effect = pickEffect();
  const shiny = rollShiny();
  const finalPoints = Math.round(pokemon.points * effect.multiplier * (shiny ? SHINY_POINTS_MULTIPLIER : 1));

  return {
    pokemonId: pokemon.id,
    name: pokemon.name,
    sprite: pokemon.sprite,
    rarity: pokemon.rarity,
    basePoints: pokemon.points,
    effectName: effect.name,
    multiplier: effect.multiplier,
    shiny,
    shinySprite: shiny ? shinySpriteUrl(pokemon.id) : null,
    finalPoints
  };
}

// Génère les 2 options HAUT/BAS d'une manche en mode ADMIN VS JOUEUR. Tirage totalement
// indépendant pour chaque option (AUCUNE règle "1 seul légendaire max" — cf. spec section
// 10) ; seule contrainte conservée, comme en mode normal : ne jamais proposer deux fois
// le même Pokémon.
function pickAdminModeOptions() {
  const haut = buildAdminModeOption();
  let bas = buildAdminModeOption();

  let guard = 0;
  while (bas.pokemonId === haut.pokemonId && guard < 10) {
    bas = buildAdminModeOption();
    guard += 1;
  }

  return { haut, bas };
}

// -----------------------------------------------------------------
// GAMEMODE "DEVINE LE POKÉMON" — planche partagée + Pokémon secret + tours chronométrés.
//
// Contrairement aux deux autres modes, ici pas de rareté/points/traits : chaque case de
// la planche n'est qu'un Pokémon "identité" (id, nom, sprite). Réutilise POKEMON_POOLS
// tel quel (aucune deuxième base de données) via un échantillonnage stratifié par palier
// de rareté, pour éviter une planche qui ne contiendrait que des Pokémon très similaires.
// -----------------------------------------------------------------
const GUESS_TURN_DURATION_MS = 25000;

// Nombre de cases tirées par palier (somme = 36). Un peu de chaque, jamais tout un
// palier d'un coup : la planche reste variée même si le tirage dans chaque palier est
// aléatoire.
const GUESS_TIER_COUNTS = {
  commun: 10,
  peu_commun: 8,
  rare: 7,
  epique: 6,
  pseudo_legendaire: 3,
  legendaire: 2
};

// Fisher-Yates : mélange correct et non biaisé (contrairement à `sort(() => Math.random())`,
// qui ne produit pas une distribution uniforme).
function shuffleArray(arr) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

// Construit une planche fraîche (36 cases), différente à chaque partie. Le contenu
// entier (planche = quels Pokémon, dans quel ordre) n'est PAS secret : les deux joueurs
// la voient intégralement identique. Seule la case CHOISIE par chacun comme secret l'est.
function buildGuessBoard() {
  const picked = [];
  for (const [tier, count] of Object.entries(GUESS_TIER_COUNTS)) {
    const shuffledTier = shuffleArray(POKEMON_POOLS[tier]);
    picked.push(...shuffledTier.slice(0, count));
  }
  return shuffleArray(picked).map((p, index) => ({
    index,
    id: p.id,
    name: p.name,
    sprite: p.sprite
  }));
}

// Démarre une partie "guess" : nouvelle planche, secrets réinitialisés. Appelé UNIQUEMENT
// par start_game (jamais par play_again directement : la planche précédente ne doit
// jamais être réutilisée, cf. section 20 de la spec).
function startGuessGame(game) {
  game.guessBoard = buildGuessBoard();
  game.guessActivePlayerId = null;
  game.guessTurnEndsAt = null;
  if (game.guessTurnTimer) {
    clearTimeout(game.guessTurnTimer);
    game.guessTurnTimer = null;
  }
  game.guessWinnerId = null;
  game.players.forEach(p => { p.secretPokemonIndex = null; });

  io.to(game.id).emit('guess_game_started', {
    gameId: game.id,
    board: game.guessBoard,
    players: getPublicPlayers(game)
  });
}

function broadcastGuessPlayers(game) {
  io.to(game.id).emit('guess_players_updated', { players: getPublicPlayers(game) });
}

// Démarre le tour de `activePlayerId` : pose le timer serveur (source de vérité, cf.
// section 6 de la spec — jamais confiance dans un timer client) et notifie tout le monde.
function beginGuessTurn(game, activePlayerId) {
  if (game.guessTurnTimer) clearTimeout(game.guessTurnTimer);

  game.guessActivePlayerId = activePlayerId;
  game.guessTurnEndsAt = Date.now() + GUESS_TURN_DURATION_MS;

  io.to(game.id).emit('guess_turn_started', {
    activePlayerId,
    turnEndsAt: game.guessTurnEndsAt
  });

  game.guessTurnTimer = setTimeout(() => advanceGuessTurn(game), GUESS_TURN_DURATION_MS);
}

// Premier tour de la partie, une fois que les DEUX joueurs ont choisi leur secret.
function startGuessTurns(game) {
  const first = randomFrom(game.players);
  beginGuessTurn(game, first.id);
}

// Passe au joueur suivant, que ce soit parce que le temps est écoulé (timer serveur) ou
// que le joueur actif a cliqué sur "Finir le tour" (cf. socket.on('guess_finish_turn')) :
// un seul chemin de code pour les deux déclencheurs, donc aucune divergence possible.
function advanceGuessTurn(game) {
  if (game.status !== 'playing' || game.gameMode !== 'guess') return; // partie déjà finie/rejouée entretemps
  const other = game.players.find(p => p.id !== game.guessActivePlayerId);
  if (!other) return; // adversaire déjà parti : la déconnexion gère la suite (forfait)
  beginGuessTurn(game, other.id);
}

// Victoire normale : un joueur a trouvé le Pokémon secret de l'autre.
function finishGuessGame(game, winnerId, opponentSecretIndex) {
  if (game.guessTurnTimer) {
    clearTimeout(game.guessTurnTimer);
    game.guessTurnTimer = null;
  }
  game.status = 'finished';
  game.guessWinnerId = winnerId;

  const secretMon = game.guessBoard[opponentSecretIndex];
  io.to(game.id).emit('guess_game_over', {
    winnerId,
    reason: 'found',
    secretPokemon: { name: secretMon.name, sprite: secretMon.sprite },
    players: getPublicPlayers(game)
  });
}

// Abandon : l'un des deux quitte en cours de partie (ou de sélection du secret). Comme
// ce mode nécessite strictement 2 joueurs, celui qui reste ne peut de toute façon plus
// continuer normalement — victoire par forfait plutôt qu'un blocage silencieux (même
// principe que finishAdminModeByForfeit).
function finishGuessGameByForfeit(game, leavingPlayer) {
  if (game.guessTurnTimer) {
    clearTimeout(game.guessTurnTimer);
    game.guessTurnTimer = null;
  }
  game.status = 'finished';

  const remaining = game.players[0]; // un seul joueur restant, cf. leaveCurrentGame()/finalizePlayerRemoval()
  game.guessWinnerId = remaining ? remaining.id : null;

  io.to(game.id).emit('guess_game_over', {
    winnerId: game.guessWinnerId,
    reason: 'forfeit',
    secretPokemon: null,
    players: getPublicPlayers(game)
  });
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
    condition: (game, player) => player.team.length > 0 // remplace un Pokémon existant, ou skip
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
    // Un Pokémon déjà chromatique (tiré directement shiny, cf. SHINY_CHANCE) ne peut pas
    // "redevenir" shiny une seconde fois : évite un cumul ×1.5 doublé, narrativement absurde.
    condition: (game, player) => {
      const mon = player.team[player.team.length - 1];
      return !!mon && !mon.shiny;
    }
  },
  {
    id: EVENT_TYPES.DUEL,
    label: 'Duel',
    probability: 0.03,
    scope: 'duo',
    implemented: true,
    condition: (game, player) => !!pickEventOpponent(game, player)
  },
  {
    id: EVENT_TYPES.MIRROR,
    label: 'Miroir',
    probability: 0.02,
    scope: 'duo',
    // Désactivé sur demande (bugs récurrents en jeu réel : équipes à 7 Pokémon
    // constatées malgré les gardes team.length<6 côté serveur — cause exacte non
    // identifiée avec certitude, donc désactivé plutôt que "réparé au hasard").
    // Le code est conservé tel quel (implemented: false) : ne se déclenche plus jamais,
    // réactivable d'un mot en repassant à true une fois la cause trouvée.
    implemented: false,
    // Les deux équipes doivent avoir de la place : sinon l'événement se déclencherait
    // pour ne rien donner à personne (cooldown consommé pour rien).
    condition: (game, player) => player.team.length < 6 && !!pickEventOpponent(game, player, p => p.team.length < 6)
  },
  {
    id: EVENT_TYPES.CROSSED_FATES,
    label: 'Destins croisés',
    probability: 0.02,
    scope: 'duo',
    implemented: true,
    condition: (game, player) => !!pickEventOpponent(game, player)
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
    condition: (game, player) => player.team.length > 0 // remplace un Pokémon existant, ou skip
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
    case EVENT_TYPES.INSTANT_EVOLUTION: return startInstantEvolution(game, player);
    case EVENT_TYPES.SHINY_POKEMON: return startShinyPokemon(game, player);
    case EVENT_TYPES.LUCKY_TURN: return startLuckyTurn(game, player);
    case EVENT_TYPES.LOTTERY: return startLottery(game, player);
    case EVENT_TYPES.TIME_RIFT: return startTimeRift(game, player);
    case EVENT_TYPES.DUEL: return startDuel(game, player);
    case EVENT_TYPES.MIRROR: return startMirror(game, player);
    case EVENT_TYPES.CROSSED_FATES: return startCrossedFates(game, player);
    default: return null;
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
    })),
    team: player.team.map((mon, index) => ({ index, id: mon.id, name: mon.name, sprite: mon.sprite }))
  });
  return player.activeEvent;
}

// Ne grossit JAMAIS l'équipe au-delà de 6 : le joueur choisit un Pokémon parmi les 2
// proposés, PUIS lequel de ses Pokémon actuels il remplace — ou skip entièrement, ce
// qui ne change rien. { skip: true } court-circuite tout le reste.
function resolveDoubleEncounter(game, player, action) {
  if (action && action.skip === true) {
    return { result: { type: EVENT_TYPES.DOUBLE_ENCOUNTER, skipped: true, score: player.score, team: player.team } };
  }

  const options = player.activeEvent.options;
  const optionIndex = action && (action.index === 0 || action.index === 1) ? action.index : null;
  const replaceIndex = action && Number.isInteger(action.replaceIndex) ? action.replaceIndex : null;
  const replacedMon = replaceIndex !== null ? player.team[replaceIndex] : null;
  if (optionIndex === null || !replacedMon) return { error: 'Choix invalide.' };

  const chosen = options[optionIndex];
  const scoreDelta = chosen.finalPoints - monContribution(replacedMon);
  player.team[replaceIndex] = teamMonFromReward(chosen);
  player.score += scoreDelta;

  return {
    result: {
      type: EVENT_TYPES.DOUBLE_ENCOUNTER,
      pokemon: { name: chosen.name, sprite: chosen.sprite },
      rarity: chosen.rarity,
      replacedName: replacedMon.name,
      scoreDelta,
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
    currentPoints: monContribution(mon)
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

  const success = Math.random() < 0.5; // 50/50 côté serveur, jamais le client
  const scoreDelta = applyMonMutation(player, mon, m => { m.multiplier = success ? m.multiplier * 2 : 0; });

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
  if (action && action.skip === true) {
    return { result: { type: EVENT_TYPES.HIDDEN_TALENT, skipped: true, score: player.score, team: player.team } };
  }

  const index = action && Number.isInteger(action.index) ? action.index : null;
  const mon = index !== null ? player.team[index] : null;
  if (!mon) return { error: 'Pokémon invalide.' };

  const newEffect = randomFrom(EFFECTS.filter(e => e.name !== 'Neutre'));
  const scoreDelta = applyMonMutation(player, mon, m => assignEffect(m, newEffect));

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

  let fromName;
  const scoreDelta = applyMonMutation(player, mon, m => { fromName = evolveMon(m, evolution); });

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
// obtenu ce tour, plus un bonus de points (SHINY_POINTS_MULTIPLIER, même constante que le
// tirage direct — cf. plus haut). Instantané : pas d'activeEvent, résolu et annoncé en un
// seul emit. ----
function startShinyPokemon(game, player) {
  const mon = player.team[player.team.length - 1];
  if (!mon) return null;

  const scoreDelta = applyMonMutation(player, mon, m => {
    m.shiny = true;
    m.shinySprite = shinySpriteUrl(m.id);
    m.multiplier = m.multiplier * SHINY_POINTS_MULTIPLIER;
  });

  broadcastGameUpdated(game); // score/équipe changés hors du flux de tour déjà diffusé par finalizePlayerTurn
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
      player.team.push(teamMonFromReward(card.pokemon));
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
      result.scoreDelta = applyMonMutation(player, mon, m => assignEffect(m, card.effect));
      result.pokemonName = mon.name;
      result.sprite = mon.sprite;
      result.effect = { name: card.effect.name, multiplier: card.effect.multiplier };
    }
  } else if (card.kind === 'evolution') {
    const mon = player.team[card.teamIndex];
    const evolution = mon && EVOLUTION_MAP[mon.id];
    if (mon && evolution) {
      let fromName;
      result.scoreDelta = applyMonMutation(player, mon, m => { fromName = evolveMon(m, evolution); });
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

// Ne grossit JAMAIS l'équipe au-delà de 6 : le tirage spécial est proposé, mais le
// joueur doit choisir lequel de ses Pokémon actuels il remplace, ou skip (rien ne change).
function startTimeRift(game, player) {
  const useCharm = player.hasShinyCharm && game.turn >= 5;
  const reward = buildRewardOption(useCharm, player.pity, TIME_RIFT_FLOOR_RARITY);

  player.activeEvent = { type: EVENT_TYPES.TIME_RIFT, reward };

  io.to(player.id).emit('rare_event_start', {
    type: EVENT_TYPES.TIME_RIFT,
    label: 'Faille spatio-temporelle',
    pokemon: { name: reward.name, sprite: reward.sprite, rarity: reward.rarity, finalPoints: reward.finalPoints },
    team: player.team.map((mon, index) => ({ index, id: mon.id, name: mon.name, sprite: mon.sprite }))
  });
  return player.activeEvent;
}

function resolveTimeRift(game, player, action) {
  if (action && action.skip === true) {
    return { result: { type: EVENT_TYPES.TIME_RIFT, skipped: true, score: player.score, team: player.team } };
  }

  const reward = player.activeEvent.reward;
  const replaceIndex = action && Number.isInteger(action.replaceIndex) ? action.replaceIndex : null;
  const replacedMon = replaceIndex !== null ? player.team[replaceIndex] : null;
  if (!replacedMon) return { error: 'Choix invalide.' };

  const scoreDelta = reward.finalPoints - monContribution(replacedMon);
  player.team[replaceIndex] = teamMonFromReward(reward);
  player.score += scoreDelta;

  return {
    result: {
      type: EVENT_TYPES.TIME_RIFT,
      pokemon: { name: reward.name, sprite: reward.sprite },
      rarity: reward.rarity,
      replacedName: replacedMon.name,
      scoreDelta,
      score: player.score,
      team: player.team
    }
  };
}

// -----------------------------------------------------------------
// ÉVÉNEMENTS À DEUX JOUEURS (DUEL, MIRROR, CROSSED_FATES)
//
// Contrairement aux événements solo, ceux-ci concernent deux joueurs de la même partie.
// Le serveur choisit lui-même un adversaire valide ; jamais le client. Seuls les deux
// joueurs concernés sont bloqués le temps de la résolution (activeEvent posé sur les
// deux) — les autres continuent normalement, le flux de tour global n'attend jamais un
// événement (cf. finalizePlayerTurn, qui ne bloque jamais la transition de tour).
// -----------------------------------------------------------------

// Choisit un adversaire valide : un autre joueur de la même partie, qui n'a pas déjà un
// événement actif (jamais interrompre quelqu'un d'autre en pleine résolution). Fonction
// pure (aucun effet de bord) : utilisée à la fois pour vérifier la condition de
// déclenchement et pour le tirage réel au démarrage de l'événement.
function pickEventOpponent(game, player, extraFilter) {
  const candidates = game.players.filter(p =>
    p.id !== player.id && !p.activeEvent && (!extraFilter || extraFilter(p))
  );
  if (candidates.length === 0) return null;
  return randomFrom(candidates);
}

// ---- DUEL : les 2 joueurs choisissent chacun HAUT/BAS. Choix différents -> HAUT bat BAS
// (règle simple et fixe). Choix identiques -> tirage 50/50 côté serveur (règle simple et
// clairement définie, jamais de blocage). Le perdant ne perd RIEN (juste pas de gain) :
// reste amusant, jamais punitif. ----
const DUEL_REWARD_POINTS = 120; // gain raisonnable pour le gagnant, cohérent avec l'échelle de points du jeu

function startDuel(game, player) {
  const opponent = pickEventOpponent(game, player);
  if (!opponent) return null;

  const sharedEvent = {
    type: EVENT_TYPES.DUEL,
    participants: [player.id, opponent.id],
    choices: {}
  };
  player.activeEvent = sharedEvent;
  opponent.activeEvent = sharedEvent;
  opponent.eventCooldown = EVENT_COOLDOWN_TURNS; // l'adversaire entre aussi en cooldown

  [player, opponent].forEach(p => {
    const other = p.id === player.id ? opponent : player;
    io.to(p.id).emit('rare_event_start', {
      type: EVENT_TYPES.DUEL,
      label: 'Duel',
      opponentName: other.name
    });
  });

  return sharedEvent;
}

// Retourné à socket.on('rare_event_action') via resolveEventAction. Contrat spécial :
// { pending: true } tant que l'autre joueur n'a pas encore répondu (rien n'est nettoyé,
// rien n'est diffusé) ; { resultsByPlayer } une fois les deux choix reçus, avec une
// perspective distincte pour chacun (gagnant/perdant) — géré par le handler générique.
function resolveDuel(game, player, action) {
  const shared = player.activeEvent;
  const choice = action && (action.choice === 'HAUT' || action.choice === 'BAS') ? action.choice : null;
  if (!choice) return { error: 'Choix invalide.' };
  if (shared.choices[player.id]) return { error: 'Choix déjà envoyé.' };

  shared.choices[player.id] = choice;

  const [idA, idB] = shared.participants;
  if (!shared.choices[idA] || !shared.choices[idB]) {
    return { pending: true }; // en attente de l'autre joueur
  }

  const playerA = game.players.find(p => p.id === idA);
  const playerB = game.players.find(p => p.id === idB);
  const choiceA = shared.choices[idA];
  const choiceB = shared.choices[idB];

  let winnerId;
  if (choiceA !== choiceB) {
    winnerId = choiceA === 'HAUT' ? idA : idB; // règle fixe : HAUT bat BAS
  } else {
    winnerId = Math.random() < 0.5 ? idA : idB; // égalité de choix -> 50/50 serveur
  }

  if (playerA && winnerId === idA) playerA.score += DUEL_REWARD_POINTS;
  if (playerB && winnerId === idB) playerB.score += DUEL_REWARD_POINTS;

  const resultsByPlayer = {};
  [playerA, playerB].forEach(p => {
    if (!p) return;
    const won = p.id === winnerId;
    resultsByPlayer[p.id] = {
      type: EVENT_TYPES.DUEL,
      won,
      yourChoice: shared.choices[p.id],
      opponentChoice: shared.choices[p.id === idA ? idB : idA],
      pointsGained: won ? DUEL_REWARD_POINTS : 0,
      score: p.score,
      team: p.team
    };
  });

  return { resultsByPlayer };
}

// ---- MIROIR : un seul Pokémon généré, donné TEL QUEL aux deux joueurs (même espèce,
// même rareté, mêmes points, même trait), chacun l'ajoute à sa PROPRE équipe. Instantané. ----
function startMirror(game, player) {
  const opponent = pickEventOpponent(game, player, p => p.team.length < 6);
  if (!opponent || player.team.length >= 6) return null;

  const useCharm = player.hasShinyCharm && game.turn >= 5;
  const reward = buildRewardOption(useCharm, player.pity);

  [player, opponent].forEach(p => {
    p.score += reward.finalPoints;
    if (p.team.length < 6) {
      p.team.push(teamMonFromReward(reward));
    }
  });
  opponent.eventCooldown = EVENT_COOLDOWN_TURNS;

  broadcastGameUpdated(game);
  [player, opponent].forEach(p => {
    const other = p.id === player.id ? opponent : player;
    io.to(p.id).emit('rare_event_result', {
      type: EVENT_TYPES.MIRROR,
      label: 'Miroir',
      opponentName: other.name,
      pokemon: { name: reward.name, sprite: reward.sprite },
      rarity: reward.rarity,
      pointsGained: reward.finalPoints,
      score: p.score,
      team: p.team
    });
  });

  return null; // instantané, rien à résoudre plus tard
}

// ---- DESTINS CROISÉS : lie 2 joueurs. Règle simple et clairement définie, toujours
// positive (jamais punitive, cf. consigne générale des événements) : quand l'un des deux
// termine son PROCHAIN tour, l'AUTRE reçoit un petit bonus de rareté sur son tirage
// suivant (cf. rarityBoost, même mécanisme poids+normalisation que pity/Charme/plancher).
// Instantané au déclenchement ; l'effet lui-même se joue plus tard, passivement, sur les
// tours normaux (cf. applyCrossedFatesLink, appelé depuis finalizePlayerTurn). ----
const CROSSED_FATES_BOOST_MULTIPLIER = 1.25; // petit bonus, volontairement modeste

function startCrossedFates(game, player) {
  const opponent = pickEventOpponent(game, player);
  if (!opponent) return null;

  player.crossedFatesPartner = opponent.id;
  opponent.crossedFatesPartner = player.id;
  opponent.eventCooldown = EVENT_COOLDOWN_TURNS;

  [player, opponent].forEach(p => {
    const other = p.id === player.id ? opponent : player;
    io.to(p.id).emit('rare_event_result', {
      type: EVENT_TYPES.CROSSED_FATES,
      label: 'Destins croisés',
      subtype: 'linked',
      linkedPlayerName: other.name
    });
  });

  return null; // pas d'activeEvent : l'effet se joue passivement sur les prochains tours normaux
}

// Appelé par finalizePlayerTurn pour CE joueur : si son tour qui vient de se résoudre le
// liait à un partenaire (CROSSED_FATES), le partenaire reçoit un petit bonus pour son
// PROCHAIN tirage. Lien consommé immédiatement du côté du joueur qui vient de jouer
// (à usage unique par joueur), que le partenaire soit encore présent ou non.
function applyCrossedFatesLink(game, player) {
  const partnerId = player.crossedFatesPartner;
  if (!partnerId) return;
  player.crossedFatesPartner = null;

  const partner = game.players.find(p => p.id === partnerId);
  if (!partner) return; // le partenaire a quitté entre temps : rien à faire, pas d'erreur

  partner.rarityBoost = CROSSED_FATES_BOOST_MULTIPLIER;
  io.to(partner.id).emit('rare_event_result', {
    type: EVENT_TYPES.CROSSED_FATES,
    label: 'Destins croisés',
    subtype: 'boost_received',
    linkedPlayerName: player.name
  });
}

// Dispatch générique de résolution, appelé par socket.on('rare_event_action').
function resolveEventAction(game, player, action) {
  switch (player.activeEvent.type) {
    case EVENT_TYPES.DOUBLE_ENCOUNTER: return resolveDoubleEncounter(game, player, action);
    case EVENT_TYPES.DOUBLE_OR_NOTHING: return resolveDoubleOrNothing(game, player, action);
    case EVENT_TYPES.HIDDEN_TALENT: return resolveHiddenTalent(game, player, action);
    case EVENT_TYPES.INSTANT_EVOLUTION: return resolveInstantEvolution(game, player, action);
    case EVENT_TYPES.LOTTERY: return resolveLottery(game, player, action);
    case EVENT_TYPES.TIME_RIFT: return resolveTimeRift(game, player, action);
    case EVENT_TYPES.DUEL: return resolveDuel(game, player, action);
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
//   gameMode: "normal" | "admin" (cf. GAME_MODES), choisi dans le lobby, "normal" par défaut,
//   adminId: id du joueur ADMIN si gameMode === "admin", sinon null (choisi par l'hôte,
//            valide uniquement à exactement 2 joueurs — cf. set_admin_role),
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

// -----------------------------------------------------------------
// GAMEMODE "ADMIN VS JOUEUR" — cf. set_game_mode / set_admin_role.
// "normal" = comportement actuel, inchangé. "admin" = à exactement 2 joueurs, l'un
// devient ADMIN (voit tout, ne joue jamais), l'autre JOUEUR (joue normalement, ne voit
// rien de caché). Le champ gameMode est posé ici ; la logique de tour spécifique au
// mode admin sera ajoutée aux étapes suivantes (génération des options, diffusion
// différenciée admin/joueur, interfaces dédiées).
// -----------------------------------------------------------------
const GAME_MODES = ['normal', 'admin', 'guess'];

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sans 0/O/1/I

// -----------------------------------------------------------------
// RECONNEXION — cf. socket.on('rejoin_game').
//
// Chaque joueur a un token stable généré côté CLIENT au premier chargement (stocké en
// localStorage, jamais régénéré tant que le navigateur ne l'efface pas). Contrairement à
// socket.id (qui change à chaque connexion), ce token survit à une coupure réseau/un
// refresh de page : c'est lui qui permet de retrouver et de "rebrancher" le bon joueur
// sur sa nouvelle socket lors d'une reconnexion.
//
// Le comportement diffère selon l'état de la partie au moment de la déconnexion :
// - "waiting" (lobby) ou "finished" : rien à sauver, retrait immédiat (comportement
//   historique, inchangé) — les enjeux sont faibles, autant garder simple.
// - "playing" : le joueur N'EST PAS retiré immédiatement. Il est marqué `disconnected`
//   (les autres voient un badge "hors ligne"), et un délai de grâce démarre. S'il
//   revient dans ce délai (rejoin_game avec le bon token), il reprend exactement sa
//   place (score, équipe, tour en cours) sans rien perdre. Sinon, il est retiré comme
//   d'habitude une fois le délai écoulé (y compris le forfait en mode ADMIN VS JOUEUR).
// -----------------------------------------------------------------
const RECONNECT_GRACE_MS = 45000;

function generateToken() {
  return Array.from({ length: 24 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
}

function generateGameId() {
  let id;
  do {
    id = Array.from({ length: 6 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
  } while (games[id]);
  return id;
}

function makePlayer(id, name, token) {
  return {
    id,
    name,
    token: token || generateToken(), // filet de sécurité si un vieux client n'en envoie pas
    disconnected: false, // cf. RECONNECT_GRACE_MS — true pendant le délai de grâce
    disconnectTimer: null,
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
    rarityFloor: null, // effet différé de LUCKY_TURN : plancher de rareté pour le PROCHAIN tirage, à usage unique
    rarityBoost: null, // petit bonus différé de CROSSED_FATES pour le PROCHAIN tirage, à usage unique
    crossedFatesPartner: null, // id du joueur lié (CROSSED_FATES), consommé au prochain choix de CE joueur
    secretPokemonIndex: null // mode "guess" uniquement : case choisie sur guessBoard, jamais révélée à l'adversaire
  };
}

// Ne renvoie jamais currentOptions au client (secret tant que le choix n'est pas fait).
// Ne renvoie jamais token non plus (secret de reconnexion : seul le joueur concerné le
// connaît, cf. rejoin_success qui le renvoie uniquement à l'intéressé).
function getPublicPlayers(game) {
  return game.players.map(p => ({
    id: p.id,
    name: p.name,
    disconnected: p.disconnected,
    score: p.score,
    team: p.team,
    hasChosen: p.currentChoice !== null,
    secretSelected: p.secretPokemonIndex !== null // mode "guess" : jamais LEQUEL, juste si choisi
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
    p.currentOptions = pickPlayerTurnOptions(useCharm, p.pity, p.rarityFloor || undefined, p.rarityBoost || undefined);
    p.rarityFloor = null; // effet LUCKY_TURN consommé, à usage unique
    p.rarityBoost = null; // effet CROSSED_FATES consommé, à usage unique
    io.to(p.id).emit('turn_options', {
      haut: { name: p.currentOptions.haut.name, sprite: p.currentOptions.haut.sprite, shiny: p.currentOptions.haut.shiny, shinySprite: p.currentOptions.haut.shinySprite },
      bas: { name: p.currentOptions.bas.name, sprite: p.currentOptions.bas.sprite, shiny: p.currentOptions.bas.shiny, shinySprite: p.currentOptions.bas.shinySprite }
    });
  });
}

// Équivalent de assignTurnOptions() pour le mode ADMIN VS JOUEUR : un seul tirage par
// manche (pickAdminModeOptions), stocké sur le JOUEUR (réutilise le champ currentOptions,
// donc player_choice n'a besoin de presque aucune adaptation). Deux payloads DIFFÉRENTS
// envoyés séparément : jamais la même donnée cachée avec un simple flag côté client (cf.
// spec section 5/17) — le serveur ne fait tout simplement pas transiter l'info secrète
// vers la socket du JOUEUR.
//
// admin.currentChoice est mis à une sentinelle ('OBSERVE', jamais une valeur HAUT/BAS
// valide) dès la génération de la manche : l'ADMIN ne joue jamais, mais allReady
// (cf. maybeScheduleTurnTransition) attend currentChoice !== null pour TOUS les joueurs
// présents. Sans cette sentinelle, la manche ne pourrait jamais avancer.
function assignAdminModeOptions(game) {
  const joueur = game.players.find(p => p.id !== game.adminId);
  const admin = game.players.find(p => p.id === game.adminId);
  if (!joueur || !admin) return; // état invalide : ne devrait pas arriver (validé par start_game)

  joueur.currentOptions = pickAdminModeOptions();
  admin.currentChoice = 'OBSERVE';

  io.to(admin.id).emit('admin_view_turn_options', {
    turn: game.turn,
    playerName: joueur.name,
    playerScore: joueur.score,
    haut: { ...joueur.currentOptions.haut },
    bas: { ...joueur.currentOptions.bas }
  });

  io.to(joueur.id).emit('player_turn_hidden', { turn: game.turn });
}

// Démarre un tour pour tous les joueurs. Au tour 4, phase spéciale : on ne révèle
// rien tout de suite, chaque joueur doit d'abord choisir POKÉMON ou BONUS
// (cf. socket.on('special_choice')). Tous les autres tours : flux normal inchangé.
//
// Mode ADMIN VS JOUEUR : décision de gameplay volontaire — pas de tour 4 spécial
// (Bonbon XP / Objet Mystère) dans ce mode. Les 6 tours y sont tous des manches
// identiques (assignAdminModeOptions), y compris le tour 4.
function startTurnForPlayers(game) {
  if (game.gameMode === 'admin') {
    assignAdminModeOptions(game);
    return;
  }
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
    if (p.activeEvent) {
      // Un événement non résolu avant le tour suivant expire : le joueur DOIT en être
      // informé, sinon son overlay reste ouvert indéfiniment (softlock côté client,
      // ses boutons ne feraient plus qu'échouer silencieusement contre un activeEvent nul).
      p.activeEvent = null;
      io.to(p.id).emit('rare_event_cancelled', { reason: 'expired' });
    }
    if (p.eventCooldown > 0) p.eventCooldown -= 1;
  });
  broadcastGameUpdated(game);
  startTurnForPlayers(game);
}

function finishGame(game) {
  game.status = 'finished';
  game.route[game.route.length - 1].status = 'done';

  // Mode ADMIN VS JOUEUR : un seul résultat réel (celui du JOUEUR, seul à avoir un score).
  // L'ADMIN n'a pas sa propre victoire/défaite : la sienne est l'INVERSE de celle du
  // JOUEUR (cf. spec section 20 — JOUEUR gagne = ADMIN perd, et inversement). Sans ce
  // cas particulier, l'ADMIN (score toujours à 0) serait toujours marqué "defeat", même
  // quand le JOUEUR l'emporte.
  const joueur = game.gameMode === 'admin' ? game.players.find(p => p.id !== game.adminId) : null;
  const joueurWon = joueur ? joueur.score >= game.boss.requiredPoints : null;

  const results = game.players.map(p => {
    if (game.gameMode === 'admin' && p.id === game.adminId) {
      return { id: p.id, name: p.name, score: p.score, team: p.team, result: joueurWon ? 'defeat' : 'victory' };
    }
    return {
      id: p.id,
      name: p.name,
      score: p.score,
      team: p.team,
      result: p.score >= game.boss.requiredPoints ? 'victory' : 'defeat'
    };
  });

  io.to(game.id).emit('game_finished', {
    boss: game.boss,
    difficulty: game.selectedDifficulty,
    gameMode: game.gameMode,
    adminId: game.adminId,
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

// Un événement bloque la transition de tour tant qu'il n'est pas résolu, SAUF DUEL :
// DUEL est le seul événement conçu pour ne jamais bloquer les autres joueurs (cf. spec
// multijoueur d'origine — 2 joueurs sur N, les autres continuent normalement). Tous les
// autres événements interactifs (solo) doivent laisser au joueur tout le temps nécessaire :
// un choix en 2 étapes (ex: DOUBLE RENCONTRE) ne tient pas dans les 4s de révélation.
function hasBlockingEvent(player) {
  return !!player.activeEvent && player.activeEvent.type !== EVENT_TYPES.DUEL;
}

// Une fois que tous les joueurs présents ont choisi ET qu'aucun n'a d'événement bloquant
// en cours, laisse ~4s de révélation avant de faire avancer le tour (ou de terminer la
// partie), pour tout le monde en même temps.
function maybeScheduleTurnTransition(game) {
  if (game.status !== 'playing') return;
  if (game.turnTimer) return; // déjà planifié, ne pas doubler

  const allReady = game.players.length > 0 && game.players.every(p => p.currentChoice !== null && !hasBlockingEvent(p));
  if (!allReady) return;

  game.turnTimer = setTimeout(() => resolveTurnTransition(game), REVEAL_DELAY_MS);
}

// Point de sortie commun à la fin d'un tour, que le joueur ait choisi POKÉMON (HAUT/BAS)
// ou BONUS (Bonbon XP / Objet Mystère / Charme Chroma) — un seul chemin de code pour
// diffuser l'état et planifier la transition, évite toute divergence entre les deux flux.
// C'est aussi le point d'accroche des événements rares : tirés pour CE joueur uniquement,
// jamais pour les autres. Le tirage doit précéder la vérification de transition : un
// événement fraîchement déclenché doit pouvoir bloquer le passage au tour suivant tant
// qu'il n'est pas résolu (cf. hasBlockingEvent) — sauf DUEL, jamais bloquant.
//
// Mode ADMIN VS JOUEUR : les événements rares sont désactivés pour l'instant (cf. spec
// section 18). Les événements à deux joueurs (DUEL/MIRROR/CROSSED_FATES) chercheraient
// un "adversaire" via pickEventOpponent — en mode admin, le seul autre joueur présent
// est l'ADMIN, qui n'a ni score ni équipe : les activer sans adaptation lui attribuerait
// à tort des points/Pokémon. À réintroduire, événement par événement, une fois vérifiés
// compatibles avec ce mode.
function finalizePlayerTurn(game, player) {
  broadcastGameUpdated(game);
  if (player && game.gameMode !== 'admin') {
    applyCrossedFatesLink(game, player);
    maybeTriggerEvent(game, player);
  }
  maybeScheduleTurnTransition(game);
}

// Retire réellement un joueur déjà sorti de game.players et gère toutes les conséquences
// (DUEL partagé, suppression de la partie si elle se retrouve vide, réassignation de
// l'hôte, reset du rôle ADMIN en lobby, forfait en mode ADMIN VS JOUEUR, transition de
// tour). Ne dépend d'AUCUNE socket : appelable longtemps après qu'elle a disparu, ce qui
// est exactement le cas quand le délai de grâce de reconnexion expire (cf. RECONNECT_GRACE_MS).
function finalizePlayerRemoval(game, gameId, leavingPlayer) {
  // Événement à deux joueurs (DUEL) : si celui qui part y participait, l'autre ne doit
  // jamais rester bloqué à attendre indéfiniment un choix qui ne viendra plus.
  if (leavingPlayer.activeEvent && Array.isArray(leavingPlayer.activeEvent.participants)) {
    const shared = leavingPlayer.activeEvent;
    shared.participants
      .filter(id => id !== leavingPlayer.id)
      .forEach(id => {
        const partner = game.players.find(p => p.id === id);
        if (partner && partner.activeEvent === shared) {
          partner.activeEvent = null;
          io.to(partner.id).emit('rare_event_cancelled', { type: shared.type });
        }
      });
  }

  if (game.players.length === 0) {
    if (game.turnTimer) clearTimeout(game.turnTimer);
    delete games[gameId];
    return;
  }

  if (game.hostId === leavingPlayer.id) {
    game.hostId = game.players[0].id;
  }

  if (game.status === 'waiting') {
    // L'ADMIN choisi qui quitte le lobby n'a plus de sens : l'hôte doit re-choisir
    // (cf. set_admin_role, qui revalide de toute façon qu'il reste 2 joueurs).
    if (game.adminId === leavingPlayer.id) {
      game.adminId = null;
      io.to(gameId).emit('admin_role_updated', { adminId: null });
    }
    broadcastPlayers(game);
    return;
  }

  // Mode ADMIN VS JOUEUR : la manche est un tirage partagé (cf. assignAdminModeOptions) —
  // si l'ADMIN ou le JOUEUR quitte en cours de partie (pour de bon : délai de grâce déjà
  // écoulé), l'autre ne peut plus jamais recevoir de nouvelle manche (softlock silencieux).
  // Victoire par forfait plutôt que de le laisser bloqué sans explication.
  if (game.status === 'playing' && game.gameMode === 'admin') {
    finishAdminModeByForfeit(game, leavingPlayer);
    return;
  }

  // Mode DEVINE LE POKÉMON : strictement 2 joueurs, aucune continuation possible seul —
  // même principe de victoire par forfait.
  if (game.status === 'playing' && game.gameMode === 'guess') {
    finishGuessGameByForfeit(game, leavingPlayer);
    return;
  }

  broadcastGameUpdated(game);
  maybeScheduleTurnTransition(game);
}

// Départ EXPLICITE (bouton "Quitter", ou nettoyage avant de créer/rejoindre une autre
// partie) : toujours immédiat, jamais de délai de grâce — contrairement à une simple
// déconnexion réseau (cf. handleSocketDisconnect), cliquer sur "Quitter" est un choix
// délibéré, pas un accident dont on pourrait vouloir revenir.
function leaveCurrentGame(socket) {
  const gameId = socket.data.gameId;
  if (!gameId) return;

  const game = games[gameId];
  if (!game) return;

  const leavingPlayer = game.players.find(p => p.id === socket.id);
  if (!leavingPlayer) {
    socket.data.gameId = null;
    return;
  }
  if (leavingPlayer.disconnectTimer) clearTimeout(leavingPlayer.disconnectTimer);

  game.players = game.players.filter(p => p.id !== socket.id);
  socket.leave(gameId);
  socket.data.gameId = null;

  finalizePlayerRemoval(game, gameId, leavingPlayer);
}

// Déconnexion RÉSEAU (perte de connexion, refresh de page, onglet fermé...) : jamais
// distinguable côté serveur d'un abandon volontaire, donc on donne toujours le bénéfice
// du doute si la partie est en cours (cf. RECONNECT_GRACE_MS). En lobby/partie finie,
// les enjeux sont trop faibles pour justifier la complexité : retrait immédiat, comme
// avant.
function handleSocketDisconnect(socket) {
  const gameId = socket.data.gameId;
  if (!gameId) return;

  const game = games[gameId];
  if (!game) {
    socket.data.gameId = null;
    return;
  }

  const player = game.players.find(p => p.id === socket.id);
  if (!player) {
    socket.data.gameId = null;
    return;
  }

  if (game.status !== 'playing') {
    leaveCurrentGame(socket);
    return;
  }

  player.disconnected = true;
  socket.data.gameId = null; // cette socket-ci ne représente plus ce joueur
  broadcastGameUpdated(game); // les autres voient tout de suite le badge "hors ligne"

  player.disconnectTimer = setTimeout(() => {
    game.players = game.players.filter(p => p.token !== player.token);
    finalizePlayerRemoval(game, gameId, player);
  }, RECONNECT_GRACE_MS);
}

// Termine immédiatement une partie ADMIN VS JOUEUR quand l'un des deux quitte en cours
// de jeu : victoire par forfait pour celui qui reste, défaite pour celui qui est parti —
// peu importe le rôle de chacun (contrairement à finishGame(), qui inverse spécifiquement
// le résultat de l'ADMIN par rapport au score du JOUEUR : ici il n'y a pas de "score
// atteint", juste un abandon). leavingPlayer est capturé par leaveCurrentGame() AVANT
// d'être retiré de game.players, sinon son score/équipe finaux seraient perdus.
function finishAdminModeByForfeit(game, leavingPlayer) {
  if (game.turnTimer) {
    clearTimeout(game.turnTimer);
    game.turnTimer = null;
  }
  game.status = 'finished';

  const remaining = game.players[0]; // un seul joueur restant, cf. leaveCurrentGame()
  const results = [leavingPlayer, remaining]
    .filter(Boolean)
    .map(p => ({
      id: p.id,
      name: p.name,
      score: p.score,
      team: p.team,
      result: p.id === leavingPlayer.id ? 'defeat' : 'victory'
    }));

  io.to(game.id).emit('game_finished', {
    boss: game.boss,
    difficulty: game.selectedDifficulty,
    gameMode: game.gameMode,
    adminId: game.adminId,
    reason: 'forfeit',
    route: game.route,
    players: results
  });
}

io.on('connection', (socket) => {
  socket.on('create_game', ({ name, token } = {}) => {
    const trimmed = (name || '').trim();
    if (!trimmed) {
      socket.emit('error_message', 'Pseudo requis.');
      return;
    }

    // Si ce socket était déjà dans une autre partie (ex. retour en arrière du
    // navigateur), on le retire proprement avant d'en créer une nouvelle : sinon son
    // ancienne entrée reste orpheline dans games[oldId], qui n'avance plus jamais.
    leaveCurrentGame(socket);

    const gameId = generateGameId();

    games[gameId] = {
      id: gameId,
      status: 'waiting',
      turn: 0,
      maxTurns: MAX_TURNS,
      hostId: socket.id,
      boss: null, // choisi aléatoirement au démarrage (start_game), identique pour tous les joueurs
      selectedDifficulty: 'medium', // choisi par l'hôte dans le lobby ; défaut = MOYEN
      gameMode: 'normal', // 'normal' | 'admin' | 'guess' — choisi par l'hôte dans le lobby, cf. set_game_mode
      adminId: null, // id du joueur ADMIN si gameMode === 'admin', cf. set_admin_role
      route: buildRoute(),
      turnTimer: null,
      // ---- Mode "guess" (Devine le Pokémon) uniquement, cf. startGuessGame() ----
      guessBoard: null,
      guessActivePlayerId: null,
      guessTurnEndsAt: null,
      guessTurnTimer: null,
      guessWinnerId: null,
      players: [makePlayer(socket.id, trimmed, token)]
    };

    socket.join(gameId);
    socket.data.gameId = gameId;

    socket.emit('game_created', {
      gameId,
      token: games[gameId].players[0].token,
      players: getPublicPlayers(games[gameId]),
      hostId: games[gameId].hostId,
      difficulty: games[gameId].selectedDifficulty,
      gameMode: games[gameId].gameMode,
      adminId: games[gameId].adminId
    });
  });

  socket.on('join_game', ({ name, gameId, token } = {}) => {
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

    // Même précaution que create_game : quitte proprement toute AUTRE partie précédente
    // avant de rejoindre celle-ci. Si c'est déjà cette partie-là, ne pas dupliquer
    // l'entrée joueur : renvoyer simplement l'état actuel.
    if (socket.data.gameId === id) {
      const self = game.players.find(p => p.id === socket.id);
      socket.emit('game_joined', {
        gameId: id,
        token: self ? self.token : token,
        players: getPublicPlayers(game),
        hostId: game.hostId,
        difficulty: game.selectedDifficulty,
        gameMode: game.gameMode,
        adminId: game.adminId
      });
      return;
    }
    if (socket.data.gameId) {
      leaveCurrentGame(socket);
    }

    const newPlayer = makePlayer(socket.id, trimmedName, token);
    game.players.push(newPlayer);

    socket.join(id);
    socket.data.gameId = id;

    socket.emit('game_joined', {
      gameId: id,
      token: newPlayer.token,
      players: getPublicPlayers(game),
      hostId: game.hostId,
      difficulty: game.selectedDifficulty,
      gameMode: game.gameMode,
      adminId: game.adminId
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
    if (game.gameMode === 'admin') {
      if (game.players.length !== 2) {
        socket.emit('error_message', 'Le mode ADMIN VS JOUEUR nécessite exactement 2 joueurs.');
        return;
      }
      if (!game.adminId || !game.players.some(p => p.id === game.adminId)) {
        socket.emit('error_message', "Choisis l'ADMIN avant de démarrer.");
        return;
      }
    }
    if (game.gameMode === 'guess' && game.players.length !== 2) {
      socket.emit('error_message', 'Ce mode nécessite exactement 2 joueurs.');
      return;
    }

    game.status = 'playing';

    // Mode "Devine le Pokémon" : aucun concept de boss/route/équipe/tour-cadeau — flux
    // entièrement différent (planche + secrets + tours chronométrés), isolé dans
    // startGuessGame(). On sort ici avant de toucher aux champs Route du Boss.
    if (game.gameMode === 'guess') {
      game.players.forEach(p => { p.secretPokemonIndex = null; });
      startGuessGame(game);
      return;
    }

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
      p.rarityBoost = null;
      p.crossedFatesPartner = null;
      p.secretPokemonIndex = null;
    });

    io.to(gameId).emit('game_started', {
      gameId: game.id,
      status: game.status,
      turn: game.turn,
      maxTurns: game.maxTurns,
      route: game.route,
      boss: game.boss,
      difficulty: game.selectedDifficulty,
      gameMode: game.gameMode,
      adminId: game.adminId,
      players: getPublicPlayers(game)
    });

    startTurnForPlayers(game);
  });

  // ---------------------------------------------------------------
  // GAMEMODE "DEVINE LE POKÉMON" — sélection du secret + tours chronométrés.
  // ---------------------------------------------------------------

  // Choix du Pokémon secret (une case de guessBoard). Une fois choisi, définitif pour
  // toute la partie (aucun event pour le modifier, cf. spec section 16 anti-cheat).
  socket.on('select_secret_pokemon', ({ index } = {}) => {
    const gameId = socket.data.gameId;
    const game = games[gameId];

    if (!game) {
      socket.emit('error_message', 'Partie introuvable.');
      return;
    }
    if (game.gameMode !== 'guess' || game.status !== 'playing') {
      socket.emit('error_message', "Action invalide.");
      return;
    }
    const player = game.players.find(p => p.id === socket.id);
    if (!player) {
      socket.emit('error_message', 'Tu ne fais pas partie de cette partie.');
      return;
    }
    if (player.secretPokemonIndex !== null) {
      socket.emit('error_message', 'Pokémon secret déjà choisi.');
      return;
    }
    if (!game.guessBoard || !game.guessBoard[index]) {
      socket.emit('error_message', 'Case invalide.');
      return;
    }

    player.secretPokemonIndex = index;

    // Confirmation UNIQUEMENT à l'intéressé (jamais révélé à l'adversaire, même
    // implicitement) : les autres joueurs ne reçoivent qu'un booléen via
    // guess_players_updated (secretSelected), jamais l'index ni le nom.
    socket.emit('secret_selection_confirmed', { index, name: game.guessBoard[index].name });
    broadcastGuessPlayers(game);

    const bothReady = game.players.length === 2 && game.players.every(p => p.secretPokemonIndex !== null);
    if (bothReady) {
      startGuessTurns(game);
    }
  });

  // Le joueur ACTIF termine son tour avant les 25s. Le serveur revérifie que c'est
  // bien son tour : un clic après expiration (course avec le timer serveur) ou d'un
  // spectateur est silencieusement ignoré plutôt que de perturber le timer en cours.
  socket.on('guess_finish_turn', () => {
    const gameId = socket.data.gameId;
    const game = games[gameId];

    if (!game || game.gameMode !== 'guess' || game.status !== 'playing') return;
    if (game.guessActivePlayerId !== socket.id) return;

    advanceGuessTurn(game);
  });

  // Tentative de trouver le Pokémon secret de l'ADVERSAIRE. Comparaison faite
  // EXCLUSIVEMENT côté serveur (jamais confiance au client, cf. spec section 15/16).
  // "Dire ma réponse" engage le tour : la tentative (bonne ou mauvaise) le termine
  // immédiatement, une seule utilisation possible par tour.
  socket.on('guess_attempt', ({ index } = {}) => {
    const gameId = socket.data.gameId;
    const game = games[gameId];

    if (!game) {
      socket.emit('error_message', 'Partie introuvable.');
      return;
    }
    if (game.gameMode !== 'guess' || game.status !== 'playing') {
      socket.emit('error_message', "La partie n'est pas en cours.");
      return;
    }
    if (game.guessActivePlayerId !== socket.id) {
      socket.emit('error_message', "Ce n'est pas ton tour.");
      return;
    }
    const player = game.players.find(p => p.id === socket.id);
    const opponent = game.players.find(p => p.id !== socket.id);
    if (!player || !opponent) {
      socket.emit('error_message', 'Adversaire introuvable.');
      return;
    }
    if (!game.guessBoard || !game.guessBoard[index]) {
      socket.emit('error_message', 'Case invalide.');
      return;
    }

    const correct = index === opponent.secretPokemonIndex;
    const guessedMon = game.guessBoard[index];

    // Diffusé aux DEUX joueurs, y compris en cas d'erreur : dans "Devine le Pokémon",
    // savoir ce que l'adversaire a tenté (et raté) fait partie du jeu de déduction.
    io.to(gameId).emit('guess_attempt_result', {
      by: player.id,
      index,
      name: guessedMon.name,
      correct
    });

    if (correct) {
      finishGuessGame(game, player.id, opponent.secretPokemonIndex);
    } else {
      // "Dire ma réponse" engage TOUJOURS le tour : une tentative (bonne ou mauvaise)
      // le termine immédiatement, jamais de seconde chance dans le même tour. Comme
      // advanceGuessTurn() change game.guessActivePlayerId de façon synchrone avant que
      // ce handler ne rende la main, une éventuelle deuxième tentative envoyée juste
      // après échoue déjà naturellement au contrôle "Ce n'est pas ton tour" plus haut —
      // aucun verrou supplémentaire n'est nécessaire pour garantir l'usage unique.
      advanceGuessTurn(game);
    }
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
    // Ne conserve que les joueurs dont le socket est encore réellement connecté :
    // un joueur resté dans oldGame.players sans socket actif deviendrait un "fantôme"
    // qui ne rejoint jamais le nouveau salon mais y bloquerait "allReady" pour toujours.
    const connectedOldPlayers = oldGame.players.filter(p => io.sockets.sockets.has(p.id));
    // gameMode conservé tel quel (l'hôte peut le changer avant de relancer). adminId
    // conservé UNIQUEMENT s'il désigne toujours un joueur présent dans la nouvelle
    // partie ; sinon l'hôte doit re-choisir (cf. set_admin_role).
    const carriedAdminId = connectedOldPlayers.some(p => p.id === oldGame.adminId) ? oldGame.adminId : null;
    const newGame = {
      id: newGameId,
      status: 'waiting',
      turn: 0,
      maxTurns: MAX_TURNS,
      hostId: oldGame.hostId,
      boss: null,
      selectedDifficulty: oldGame.selectedDifficulty || 'medium', // conservée, modifiable avant le lancement
      gameMode: oldGame.gameMode || 'normal',
      adminId: carriedAdminId,
      route: buildRoute(),
      turnTimer: null,
      guessBoard: null,
      guessActivePlayerId: null,
      guessTurnEndsAt: null,
      guessTurnTimer: null,
      guessWinnerId: null,
      players: connectedOldPlayers.map(p => makePlayer(p.id, p.name, p.token)) // pity remis à 0, token conservé (cf. makePlayer)
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
      difficulty: newGame.selectedDifficulty,
      gameMode: newGame.gameMode,
      adminId: newGame.adminId
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

  // Choix du mode de jeu dans le lobby. Réservé à l'hôte, uniquement avant le lancement.
  // Changer de mode réinitialise systématiquement adminId : un ADMIN choisi pour une
  // configuration précédente n'a plus de sens après un changement de mode (l'hôte doit
  // re-choisir via set_admin_role).
  socket.on('set_game_mode', ({ mode } = {}) => {
    const gameId = socket.data.gameId;
    const game = games[gameId];

    if (!game) {
      socket.emit('error_message', 'Partie introuvable.');
      return;
    }
    if (game.hostId !== socket.id) {
      socket.emit('error_message', "Seul l'hôte peut choisir le mode de jeu.");
      return;
    }
    if (game.status !== 'waiting') {
      socket.emit('error_message', 'Le mode de jeu ne peut plus être modifié.');
      return;
    }
    if (!GAME_MODES.includes(mode)) {
      socket.emit('error_message', 'Mode de jeu invalide.');
      return;
    }

    game.gameMode = mode;
    game.adminId = null;
    io.to(gameId).emit('game_mode_updated', { gameMode: game.gameMode, adminId: game.adminId });
  });

  // Choix du joueur ADMIN dans le lobby (mode "admin" uniquement). Réservé à l'hôte,
  // uniquement avant le lancement, uniquement à exactement 2 joueurs. Le serveur revalide
  // que l'id proposé désigne bien un joueur réellement présent dans la partie — jamais un
  // id arbitraire envoyé par le client.
  socket.on('set_admin_role', ({ adminId } = {}) => {
    const gameId = socket.data.gameId;
    const game = games[gameId];

    if (!game) {
      socket.emit('error_message', 'Partie introuvable.');
      return;
    }
    if (game.hostId !== socket.id) {
      socket.emit('error_message', "Seul l'hôte peut choisir l'ADMIN.");
      return;
    }
    if (game.status !== 'waiting') {
      socket.emit('error_message', "Le rôle ADMIN ne peut plus être modifié.");
      return;
    }
    if (game.gameMode !== 'admin') {
      socket.emit('error_message', "Le mode ADMIN VS JOUEUR n'est pas sélectionné.");
      return;
    }
    if (game.players.length !== 2) {
      socket.emit('error_message', 'Le mode ADMIN VS JOUEUR nécessite exactement 2 joueurs.');
      return;
    }
    if (!game.players.some(p => p.id === adminId)) {
      socket.emit('error_message', 'Joueur invalide.');
      return;
    }

    game.adminId = adminId;
    io.to(gameId).emit('admin_role_updated', { adminId: game.adminId });
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
    if (game.gameMode === 'admin' && socket.id === game.adminId) {
      socket.emit('error_message', "L'ADMIN ne joue pas : il observe uniquement.");
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
    // N'existe pas en mode ADMIN VS JOUEUR : ce mode est volontairement chaotique, sans
    // mécanisme d'équité sur la durée (cf. pickAdminModeOptions).
    if (game.gameMode !== 'admin') {
      player.pity = PITY_GOOD_RARITIES.includes(reward.rarity) ? 0 : (player.pity || 0) + 1;
    }

    player.score += reward.finalPoints;
    if (player.team.length < 6) {
      player.team.push(teamMonFromReward(reward));
    }

    socket.emit('choice_result', {
      pokemon: { name: reward.name, sprite: reward.sprite, shiny: reward.shiny, shinySprite: reward.shinySprite },
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
      player.currentOptions = pickPlayerTurnOptions(false, player.pity, player.rarityFloor || undefined, player.rarityBoost || undefined);
      player.rarityFloor = null; // effet LUCKY_TURN consommé, à usage unique
      player.rarityBoost = null; // effet CROSSED_FATES consommé, à usage unique
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
    if (game.status !== 'playing') {
      socket.emit('error_message', "La partie n'est pas en cours.");
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
    if (game.status !== 'playing') {
      socket.emit('error_message', "La partie n'est pas en cours.");
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

    let fromName;
    const scoreDelta = applyMonMutation(player, mon, m => { fromName = evolveMon(m, evolution); });

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
    if (game.status !== 'playing') {
      socket.emit('error_message', "La partie n'est pas en cours.");
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

    const newEffect = randomFrom(EFFECTS.filter(e => e.name !== 'Neutre'));
    const scoreDelta = applyMonMutation(player, mon, m => assignEffect(m, newEffect));

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
    if (game.status !== 'playing') {
      socket.emit('error_message', "La partie n'est pas en cours.");
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

    if (outcome.pending) {
      // Événement à deux joueurs (DUEL) : ce joueur a répondu, on attend l'autre.
      // Rien à nettoyer ni à diffuser tant que les deux choix ne sont pas là.
      socket.emit('rare_event_waiting', { type: player.activeEvent.type });
      return;
    }

    if (outcome.resultsByPlayer) {
      // Événement à deux joueurs pleinement résolu : chaque participant reçoit SA
      // propre perspective (gagnant/perdant), puis on nettoie l'état des DEUX joueurs.
      Object.entries(outcome.resultsByPlayer).forEach(([playerId, payload]) => {
        const participant = game.players.find(p => p.id === playerId);
        if (participant) participant.activeEvent = null;
        io.to(playerId).emit('rare_event_result', payload);
      });
      broadcastGameUpdated(game);
      maybeScheduleTurnTransition(game);
      return;
    }

    player.activeEvent = null; // résolu : nettoyage systématique avant tout autre traitement
    broadcastGameUpdated(game); // score/équipe changés hors du flux de tour normal -> resynchronise tout le monde
    socket.emit('rare_event_result', outcome.result);
    maybeScheduleTurnTransition(game); // l'événement bloquait peut-être la transition : à re-vérifier maintenant
  });

  // Easter egg : clique sur un Métamorph dans TON équipe -> il copie le sprite d'un
  // autre Pokémon au hasard dans la même équipe et prend 75% de sa valeur actuelle.
  // Rejouable à volonté (re-tire un nouveau membre à chaque clic) : jamais de croissance
  // infinie, toujours borné par 0.75× la valeur d'un membre déjà présent dans l'équipe.
  // Aucun lien avec le tour en cours : peut être cliqué à tout moment pendant la partie.
  socket.on('transform_metamorph', ({ index } = {}) => {
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
    const player = game.players.find(p => p.id === socket.id);
    if (!player) {
      socket.emit('error_message', 'Tu ne fais pas partie de cette partie.');
      return;
    }

    const mon = player.team[index];
    if (!mon || mon.id !== METAMORPH_DEX_ID) {
      socket.emit('error_message', "Ce n'est pas un Métamorph.");
      return;
    }

    const candidates = player.team.filter((m, i) => i !== index);
    if (candidates.length === 0) {
      socket.emit('error_message', "Il faut un autre Pokémon dans l'équipe pour se transformer.");
      return;
    }

    const target = randomFrom(candidates);
    const targetContribution = monContribution(target);
    const scoreDelta = applyMonMutation(player, mon, m => {
      // Sprite normal TOUJOURS celui de la cible (jamais un reliquat de l'ancien Métamorph).
      m.sprite = target.sprite;
      // Le statut shiny doit lui aussi être remplacé par celui de la cible, pas conservé :
      // sinon un Métamorph shiny qui copie un Pokémon normal continuerait à afficher
      // son ANCIEN sprite chromatique (pokemonSprite() le préfère à mon.sprite).
      if (target.shiny && target.shinySprite) {
        m.shiny = true;
        m.shinySprite = target.shinySprite;
      } else {
        m.shiny = false;
        m.shinySprite = null;
      }
      m.basePoints = targetContribution;
      m.multiplier = METAMORPH_TRANSFORM_MULTIPLIER;
      m.effectName = 'Transformé';
      // m.name INTENTIONNELLEMENT jamais réécrit : reste "Métamorph" pour toujours.
    });

    socket.emit('metamorph_transformed', {
      score: player.score,
      scoreDelta,
      team: player.team,
      targetName: target.name,
      sprite: (mon.shiny && mon.shinySprite) ? mon.shinySprite : mon.sprite
    });
    broadcastGameUpdated(game); // score/équipe changés hors du flux de tour -> resynchronise les autres joueurs
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

  // Reconnexion après une coupure réseau/un refresh pendant une partie en cours
  // (cf. RECONNECT_GRACE_MS / handleSocketDisconnect). Le token est la seule preuve
  // d'identité : jamais confiance sur un gameId+pseudo fournis sans le bon token.
  socket.on('rejoin_game', ({ gameId, token } = {}) => {
    const game = games[gameId];
    if (!game) {
      socket.emit('rejoin_failed');
      return;
    }
    const player = game.players.find(p => p.token === token);
    if (!player) {
      socket.emit('rejoin_failed');
      return;
    }

    if (player.disconnectTimer) {
      clearTimeout(player.disconnectTimer);
      player.disconnectTimer = null;
    }
    player.disconnected = false;
    player.id = socket.id; // rebranche ce joueur sur sa nouvelle socket
    socket.join(gameId);
    socket.data.gameId = gameId;

    socket.emit('rejoin_success', {
      gameId: game.id,
      status: game.status,
      turn: game.turn,
      maxTurns: game.maxTurns,
      route: game.route,
      boss: game.boss,
      difficulty: game.selectedDifficulty,
      gameMode: game.gameMode,
      adminId: game.adminId,
      hostId: game.hostId,
      players: getPublicPlayers(game),
      // Mode "guess" uniquement : sans ces champs, le client n'a aucun moyen de
      // reconstruire la planche/le tour en cours après une reconnexion. mySecretIndex
      // est UNIQUEMENT le sien (jamais celui de l'adversaire, cf. getPublicPlayers qui
      // ne renvoie qu'un booléen) — sûr ici car rejoin_success cible ce seul socket.
      guessBoard: game.gameMode === 'guess' ? game.guessBoard : undefined,
      guessActivePlayerId: game.gameMode === 'guess' ? game.guessActivePlayerId : undefined,
      guessTurnEndsAt: game.gameMode === 'guess' ? game.guessTurnEndsAt : undefined,
      mySecretIndex: game.gameMode === 'guess' ? player.secretPokemonIndex : undefined
    });

    // Si une manche est en cours et que ce joueur n'a pas encore choisi, on lui renvoie
    // ses options actuelles (mêmes règles de confidentialité qu'à l'assignation normale).
    // Cas plus rares volontairement non reconstruits ici (tour 4 spécial, événement rare
    // en cours) : le joueur retrouve quand même son score/équipe/tour à jour, et
    // rattrapera l'interactivité complète dès le tour suivant.
    if (game.status === 'playing' && game.gameMode !== 'guess' && player.currentChoice === null) {
      if (game.gameMode === 'admin') {
        const joueur = game.players.find(p => p.id !== game.adminId);
        if (player.id === game.adminId && joueur && joueur.currentOptions) {
          io.to(player.id).emit('admin_view_turn_options', {
            turn: game.turn,
            playerName: joueur.name,
            playerScore: joueur.score,
            haut: { ...joueur.currentOptions.haut },
            bas: { ...joueur.currentOptions.bas }
          });
        } else if (player.id !== game.adminId && player.currentOptions) {
          io.to(player.id).emit('player_turn_hidden', { turn: game.turn });
        }
      } else if (player.currentOptions) {
        io.to(player.id).emit('turn_options', {
          haut: {
            name: player.currentOptions.haut.name,
            sprite: player.currentOptions.haut.sprite,
            shiny: player.currentOptions.haut.shiny,
            shinySprite: player.currentOptions.haut.shinySprite
          },
          bas: {
            name: player.currentOptions.bas.name,
            sprite: player.currentOptions.bas.sprite,
            shiny: player.currentOptions.bas.shiny,
            shinySprite: player.currentOptions.bas.shinySprite
          }
        });
      }
    }

    if (game.gameMode === 'guess') {
      broadcastGuessPlayers(game); // les autres voient le badge "hors ligne" disparaître
    } else {
      broadcastGameUpdated(game);
    }
  });

  socket.on('disconnect', () => {
    handleSocketDisconnect(socket);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Serveur lancé sur http://localhost:${PORT}`);
});