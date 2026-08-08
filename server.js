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
const PSEUDO_LEGENDARY_RAW = [
  { id: 149, name: 'Dracolosse', points: 735 },
  { id: 248, name: 'Tyranocif', points: 775 },
  { id: 445, name: 'Carchacrok', points: 815 },
  { id: 376, name: 'Métalosse', points: 850 },
  { id: 635, name: 'Trioxhydre', points: 850 },
  { id: 887, name: 'Dragapult', points: 890 }
];

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
  { id: 888, name: 'Zacian', points: 1475 },
  { id: 889, name: 'Zamazenta', points: 1475 },
  { id: 1007, name: 'Koraidon', points: 1510 },
  { id: 1008, name: 'Miraidon', points: 1510 },
  { id: 493, name: 'Arceus', points: 1550 }
];

function buildPool(rarity, entries) {
  return entries.map(p => ({ ...p, rarity, sprite: spriteUrl(p.id) }));
}

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

function pickRarity() {
  const roll = Math.random();
  let cumulative = 0;
  for (const entry of RARITY_TABLE) {
    cumulative += entry.weight;
    if (roll < cumulative) return entry.rarity;
  }
  return RARITY_TABLE[RARITY_TABLE.length - 1].rarity; // filet de sécurité (arrondis flottants)
}

// Bonus / malus secrets appliqués au tirage d'un Pokémon.
const EFFECTS = [
  { name: 'Énergétique', multiplier: 1.2 },
  { name: 'Chanceux', multiplier: 1.3 },
  { name: 'Motivé', multiplier: 1.1 },
  { name: 'Concentré', multiplier: 1.15 },
  { name: 'Neutre', multiplier: 1.0 },
  { name: 'Fatigué', multiplier: 0.75 },
  { name: 'Poids lourd', multiplier: 0.8 },
  { name: 'Malchanceux', multiplier: 0.6 },
  { name: 'Épine dans le pied', multiplier: 0.7 }
];

// Plusieurs boss légendaires possibles, avec un objectif propre à chacun.
// Cibles calées sur des percentiles de la distribution réelle des scores (choix aveugle,
// RNG pure — cf. simulation) plutôt que sur une moyenne : une équipe faible doit pouvoir
// perdre même contre le boss "facile", et même une excellente RNG (légendaire obtenu) ne
// garantit pas la victoire contre les boss les plus durs.
// facile ≈ P40 | moyen ≈ P60 | difficile ≈ P78 | très difficile ≈ P90 | extrême ≈ P97
const BOSSES = [
  { id: 249, name: 'Lugia', requiredPoints: 1450, difficulty: 'facile' },
  { id: 250, name: 'Ho-Oh', requiredPoints: 1450, difficulty: 'facile' },
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
].map(b => ({ ...b, sprite: spriteUrl(b.id) }));

function pickRandomBoss() {
  return randomFrom(BOSSES);
}

function randomFrom(list) {
  return list[Math.floor(Math.random() * list.length)];
}

// Construit une récompense secrète complète (rareté → Pokémon + effet + points calculés).
function buildRewardOption() {
  const rarity = pickRarity();
  const pokemon = randomFrom(POKEMON_POOLS[rarity]);
  const effect = randomFrom(EFFECTS);
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
function pickPlayerTurnOptions() {
  const haut = buildRewardOption();
  let bas = buildRewardOption();

  let guard = 0;
  while (bas.pokemonId === haut.pokemonId && guard < 10) {
    bas = buildRewardOption();
    guard += 1;
  }

  return { haut, bas };
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
//   currentOptions: { haut, bas } (secret, jamais envoyé tel quel au client)
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
  return { id, name, score: 0, team: [], currentChoice: null, currentOptions: null };
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
function assignTurnOptions(game) {
  game.players.forEach(p => {
    p.currentOptions = pickPlayerTurnOptions();
    io.to(p.id).emit('turn_options', {
      haut: { name: p.currentOptions.haut.name, sprite: p.currentOptions.haut.sprite },
      bas: { name: p.currentOptions.bas.name, sprite: p.currentOptions.bas.sprite }
    });
  });
}

function advanceTurn(game) {
  game.route[game.turn - 1].status = 'done';
  game.turn += 1;
  game.route[game.turn - 1].status = 'current';
  game.players.forEach(p => { p.currentChoice = null; });
  broadcastGameUpdated(game);
  assignTurnOptions(game);
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
    route: game.route,
    players: results
  });
}

// Une fois que tous les joueurs présents ont choisi, laisse ~4s de révélation
// avant de faire avancer le tour (ou de terminer la partie), pour tout le monde en même temps.
function maybeScheduleTurnTransition(game) {
  if (game.status !== 'playing') return;
  if (game.turnTimer) return; // déjà planifié, ne pas doubler

  const allChosen = game.players.length > 0 && game.players.every(p => p.currentChoice !== null);
  if (!allChosen) return;

  game.turnTimer = setTimeout(() => {
    game.turnTimer = null;
    if (game.turn >= game.maxTurns) {
      finishGame(game);
    } else {
      advanceTurn(game);
    }
  }, REVEAL_DELAY_MS);
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
      route: buildRoute(),
      turnTimer: null,
      players: [makePlayer(socket.id, trimmed)]
    };

    socket.join(gameId);
    socket.data.gameId = gameId;

    socket.emit('game_created', {
      gameId,
      players: getPublicPlayers(games[gameId]),
      hostId: games[gameId].hostId
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
      hostId: game.hostId
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
    game.boss = pickRandomBoss();
    game.players.forEach(p => {
      p.score = 0;
      p.team = [];
      p.currentChoice = null;
      p.currentOptions = null;
    });

    io.to(gameId).emit('game_started', {
      gameId: game.id,
      status: game.status,
      turn: game.turn,
      maxTurns: game.maxTurns,
      route: game.route,
      boss: game.boss,
      players: getPublicPlayers(game)
    });

    assignTurnOptions(game);
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

    player.score += reward.finalPoints;
    if (player.team.length < 6) {
      player.team.push({ id: reward.pokemonId, name: reward.name, sprite: reward.sprite });
    }

    socket.emit('choice_result', {
      pokemon: { name: reward.name, sprite: reward.sprite },
      basePoints: reward.basePoints,
      effect: { name: reward.effectName, multiplier: reward.multiplier },
      pointsGained: reward.finalPoints,
      score: player.score,
      team: player.team
    });

    broadcastGameUpdated(game);
    maybeScheduleTurnTransition(game);
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