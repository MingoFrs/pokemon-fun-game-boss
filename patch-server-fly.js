#!/usr/bin/env node
'use strict';
// Patch de server.js pour le mode 'fly' (Humanité vs Mouche).
//   node patch-server-fly.js [chemin/server.js]        (défaut : ./server.js)
// - Chaque remplacement exige EXACTEMENT 1 occurrence : sinon abandon, RIEN n'est écrit.
// - Sauvegarde : server.js.bak-fly (jamais écrasée si elle existe déjà). Idempotent : refuse de repatcher.
// - Fins de ligne (LF ou CRLF) préservées.
// - Si une ancienne version (v1) de ce patch est déjà appliquée, seul le bloc d'initialisation est remplacé.
const fs = require('fs');

const file = process.argv[2] || 'server.js';
if (!fs.existsSync(file)) { console.error(`Fichier introuvable : ${file}`); process.exit(1); }
const raw = fs.readFileSync(file, 'utf8');
const eol = raw.includes('\r\n') ? '\r\n' : '\n';
const src = raw.replace(/\r\n/g, '\n');

const MARK_V1 = 'FLY.begin(game)';
const MARK_V2 = "require('./fly-warmup')";
const PORT = 'const PORT = process.env.PORT || 3000;\n';
const INIT_START = "// ---- MODE 'fly' (Humanité vs Mouche)";
const INIT_BLOCK = `// ---- MODE 'fly' (Humanité vs Mouche) : cerveau partagé, échauffement, XP plafonnée, déroulement de partie ----
const { createBrainStore } = require('./fly-brain-store');
const { registerFlyAdminRoutes } = require('./fly-admin-routes');
const { createFlyGame } = require('./fly-game');
const { createFlyXp } = require('./fly-xp');
const { runWarmup } = require('./fly-warmup');
const flyDraw = () => { const o = pickPlayerTurnOptions(false, 0, undefined, undefined, 'fly'); return [o.haut, o.bas]; };
const flyGetTypes = id => { try { return BOSS_MECHANICS.getTypes(id); } catch (e) { return []; } }; // simple lecture : aucun bonus de type
const flyBst = {};
const flyTypes = {};
Object.values(POKEMON_POOLS).flat().forEach(p => { flyBst[p.id] = p.bst; flyTypes[p.id] = flyGetTypes(p.id); });
const flyBrain = createBrainStore({
  supabase,
  warmup: policy => runWarmup({ policy, draw: flyDraw, bst: flyBst, typesById: flyTypes }) // parties simulées sur tout cerveau neuf
});
registerFlyAdminRoutes(app, { store: flyBrain });
app.get('/api/fly/stats', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(flyBrain.getPublicStats()); // génération, parties vécues, score global, courbe : jamais de valeurs apprises
});
const FLY = createFlyGame({
  io, store: flyBrain,
  recordFlyResult: createFlyXp({ supabase, createAuthClient, xpParticipation: XP_PARTICIPATION, xpVictoryBonus: XP_VICTORY_BONUS }),
  deps: {
    pickPlayerTurnOptions: (...a) => pickPlayerTurnOptions(...a),
    teamMonFromReward: r => teamMonFromReward(r),
    buildRoute: () => buildRoute(),
    getPublicPlayers: g => getPublicPlayers(g),
    maybeScheduleTurnTransition: g => maybeScheduleTurnTransition(g),
    getTypes: flyGetTypes
  }
});

const PORT = process.env.PORT || 3000;
`;

const EDITS = [
  {
    where: "GAME_MODES",
    old: `const GAME_MODES = ['normal', 'admin', 'guess', 'auction', 'coop'];`,
    new: `const GAME_MODES = ['normal', 'admin', 'guess', 'auction', 'coop', 'fly'];`
  },
  {
    where: "buildAchievementContext",
    old: `function buildAchievementContext(rows) {
  const ctx = {`,
    new: `function buildAchievementContext(allRows) {
  const rows = allRows.filter(r => r.game_mode !== 'fly'); // mode fly : jamais dans les succès
  const ctx = {`
  },
  {
    where: "persistGame",
    old: `async function persistGame(game) {
  if (!supabase || game.status !== 'playing') return;`,
    new: `async function persistGame(game) {
  if (!supabase || game.status !== 'playing' || game.gameMode === 'fly') return;`
  },
  {
    where: "process.on('SIGTERM')",
    old: `    await Promise.all(Object.values(games).map(persistGame));
  }
  process.exit(0);`,
    new: `    await Promise.all(Object.values(games).map(persistGame));
  }
  try { await flyBrain.flush(); } catch (e) { /* cerveau : meilleur effort */ }
  process.exit(0);`
  },
  {
    where: "startTurnForPlayers",
    old: `function startTurnForPlayers(game) {
  if (game.gameMode === 'admin') {`,
    new: `function startTurnForPlayers(game) {
  if (game.gameMode === 'fly') {
    FLY.startTurn(game);
    return;
  }
  if (game.gameMode === 'admin') {`
  },
  {
    where: "finishGame",
    old: `function finishGame(game) {
  // Filet de sécurité : score final`,
    new: `function finishGame(game) {
  if (game.gameMode === 'fly') {
    // Aucun boss, aucun bonus de type, aucun objectif : cf. fly-game.js
    game.status = 'finished';
    game.route[game.route.length - 1].status = 'done';
    FLY.finish(game);
    return;
  }
  // Filet de sécurité : score final`
  },
  {
    where: "maybeScheduleTurnTransition",
    old: `  if (game.turnTimer) return; // déjà planifié, ne pas doubler
`,
    new: `  if (game.turnTimer) return; // déjà planifié, ne pas doubler
  if (game.gameMode === 'fly' && !(game.fly && game.fly.revealed)) return; // la Mouche n'a pas encore révélé son choix
`
  },
  {
    where: "finalizePlayerTurn",
    old: `function finalizePlayerTurn(game, player) {
  broadcastGameUpdated(game);
`,
    new: `function finalizePlayerTurn(game, player) {
  broadcastGameUpdated(game);
  if (game.gameMode === 'fly') {
    // Événements rares désactivés (comme en admin, dans un premier temps)
    FLY.onHumanChose(game);
    maybeScheduleTurnTransition(game);
    return;
  }
`
  },
  {
    where: "finalizePlayerRemoval",
    old: `    clearSpectators(game, gameId);
    delete games[gameId];
    deletePersistedGame(gameId);
    return;`,
    new: `    clearSpectators(game, gameId);
    FLY.dispose(game); // mode fly : abandon = aucun apprentissage
    delete games[gameId];
    deletePersistedGame(gameId);
    return;`
  },
  {
    where: "play_again",
    old: `    if (oldGame.turnTimer) clearTimeout(oldGame.turnTimer); // filet de sécurité`,
    new: `    FLY.dispose(oldGame);
    if (oldGame.turnTimer) clearTimeout(oldGame.turnTimer); // filet de sécurité`
  },
  {
    where: "join_game",
    old: `    if (game.status !== 'waiting') {
      // Partie déjà démarrée : mode spectateur, tous modes confondus. Un spectateur`,
    new: `    if (game.gameMode === 'fly' && socket.data.gameId !== id) {
      socket.emit('error_message', 'Cette partie est un duel Humanité vs Mouche : elle ne peut pas être rejointe.');
      return;
    }
    if (game.status !== 'waiting') {
      // Partie déjà démarrée : mode spectateur, tous modes confondus. Un spectateur`
  },
  {
    where: "set_game_mode",
    old: `    if (!GAME_MODES.includes(mode)) {
      socket.emit('error_message', 'Mode de jeu invalide.');
      return;
    }
`,
    new: `    if (!GAME_MODES.includes(mode)) {
      socket.emit('error_message', 'Mode de jeu invalide.');
      return;
    }
    if (mode === 'fly' && game.players.length !== 1) {
      socket.emit('error_message', 'Humanité vs Mouche se joue seul : retire les autres joueurs du lobby.');
      return;
    }
`
  },
  {
    where: "start_game (validation)",
    old: `    if (game.gameMode === 'coop' && game.players.length < 2) {
      socket.emit('error_message', 'Le mode Coop nécessite au moins 2 joueurs.');
      return;
    }
`,
    new: `    if (game.gameMode === 'coop' && game.players.length < 2) {
      socket.emit('error_message', 'Le mode Coop nécessite au moins 2 joueurs.');
      return;
    }
    if (game.gameMode === 'fly' && (game.players.length !== 1 || (game.spectators && game.spectators.length > 0))) {
      socket.emit('error_message', 'Humanité vs Mouche : 1 seul joueur, sans spectateur.');
      return;
    }
`
  },
  {
    where: "start_game (démarrage)",
    old: `    if (game.gameMode === 'admin') {
      beginRouteGameplay(game, gameId);
      return;
    }
`,
    new: `    if (game.gameMode === 'fly') {
      FLY.begin(game); // pas d'objet de départ, pas de boss, pas de persistance
      return;
    }
    if (game.gameMode === 'admin') {
      beginRouteGameplay(game, gameId);
      return;
    }
`
  },
  {
    where: "player_choice",
    old: `    const typeBonusDelta = syncTypeBonus(player, game);`,
    new: `    const typeBonusDelta = game.gameMode === 'fly' ? 0 : syncTypeBonus(player, game);`
  },
  {
    where: "transform_metamorph",
    old: `  socket.on('transform_metamorph', ({ index } = {}) => {
    const gameId = socket.data.gameId;
    const game = games[gameId];
`,
    new: `  socket.on('transform_metamorph', ({ index } = {}) => {
    const gameId = socket.data.gameId;
    const game = games[gameId];
    if (game && game.gameMode === 'fly') {
      socket.emit('error_message', 'Indisponible dans ce mode.');
      return;
    }
`
  },
  {
    where: "rejoin_game",
    old: `      chatMessages: game.chatMessages
    });

    // Mode "auction" : renvoie le lot en cours`,
    new: `      chatMessages: game.chatMessages,
      fly: game.gameMode === 'fly' ? FLY.publicState(game) : undefined
    });
    if (game.gameMode === 'fly') FLY.resyncTurn(game, socket.id);

    // Mode "auction" : renvoie le lot en cours`
  },
  {
    where: "démarrage serveur (chargement)",
    old: `loadPersistedGames()
  .catch(`,
    new: `Promise.all([loadPersistedGames(), flyBrain.load().catch(err => console.error('[fly] chargement du cerveau', err.message))])
  .catch(`
  }
];

function fail(msg) { console.error(`ÉCHEC : ${msg}\nAucun fichier modifié.`); process.exit(1); }

if (src.includes(MARK_V2)) { console.log('Déjà à jour (fly-warmup trouvé). Rien à faire.'); process.exit(0); }

let out = src;
const applied = [];
if (src.includes(MARK_V1)) {
  // Mise à niveau : l'ancien patch est présent ; seul le bloc d'initialisation change.
  const i = src.indexOf(INIT_START), j = src.indexOf(PORT);
  if (i < 0 || j < i || src.indexOf(INIT_START, i + 1) >= 0 || src.indexOf(PORT, j + 1) >= 0) {
    fail("ancien patch détecté mais son bloc d'initialisation est introuvable ou modifié à la main. Restaure server.js.bak-fly (ou ton commit) puis relance.");
  }
  out = src.slice(0, i) + INIT_BLOCK + src.slice(j + PORT.length);
  applied.push("bloc d'initialisation (mise à niveau)");
} else {
  for (const e of EDITS) {
    const n = out.split(e.old).length - 1;
    if (n !== 1) fail(`[${e.where}] ancre trouvée ${n} fois (attendu 1). server.js a-t-il changé depuis la livraison ?`);
    out = out.replace(e.old, () => e.new);
    applied.push(e.where);
  }
  const n = out.split(PORT).length - 1;
  if (n !== 1) fail(`[démarrage serveur] ancre « ${PORT.trim()} » trouvée ${n} fois (attendu 1).`);
  out = out.replace(PORT, () => INIT_BLOCK);
  applied.push("bloc d'initialisation");
}

const backup = file + '.bak-fly';
if (!fs.existsSync(backup)) fs.writeFileSync(backup, raw);
fs.writeFileSync(file, out.replace(/\n/g, eol));
console.log(`OK : ${applied.length} modification(s) dans ${file} (sauvegarde : ${backup}, fins de ligne ${eol === '\r\n' ? 'CRLF' : 'LF'} conservées)`);
applied.forEach(a => console.log('  -', a));
