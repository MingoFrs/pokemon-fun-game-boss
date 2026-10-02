#!/usr/bin/env python3
# Patch server.js : branche le mode 'fly' (Humanité vs Mouche).
#   python3 patch-server-fly.py [chemin/server.js]      (défaut : ./server.js)
# Chaque remplacement exige EXACTEMENT 1 occurrence : sinon abandon, rien n'est écrit.
# Sauvegarde automatique : server.js.bak-fly. Idempotent : refuse de repatcher.
import sys, shutil

path = sys.argv[1] if len(sys.argv) > 1 else 'server.js'
src = open(path, encoding='utf-8').read()
if 'FLY.begin(game)' in src:
    sys.exit('Déjà patché (FLY.begin trouvé). Rien à faire.')

patches = []   # (nom de la fonction touchée, ancre exacte, remplacement)
def P(where, old, new): patches.append((where, old, new))

# 1. Constante des modes
P("GAME_MODES",
  "const GAME_MODES = ['normal', 'admin', 'guess', 'auction', 'coop'];",
  "const GAME_MODES = ['normal', 'admin', 'guess', 'auction', 'coop', 'fly'];")

# 2. Succès : les parties fly n'entrent jamais dans les succès / séries / records
P("buildAchievementContext",
  "function buildAchievementContext(rows) {\n  const ctx = {",
  "function buildAchievementContext(allRows) {\n  const rows = allRows.filter(r => r.game_mode !== 'fly'); // mode fly : jamais dans les succès\n  const ctx = {")

# 3. Persistance : une partie fly n'est JAMAIS sauvegardée (timers, décision en attente ; abandon au redémarrage)
P("persistGame",
  "async function persistGame(game) {\n  if (!supabase || game.status !== 'playing') return;",
  "async function persistGame(game) {\n  if (!supabase || game.status !== 'playing' || game.gameMode === 'fly') return;")

# 4. SIGTERM : laisse finir les écritures du cerveau
P("process.on('SIGTERM')",
  "    await Promise.all(Object.values(games).map(persistGame));\n  }\n  process.exit(0);",
  "    await Promise.all(Object.values(games).map(persistGame));\n  }\n  try { await flyBrain.flush(); } catch (e) { /* cerveau : meilleur effort */ }\n  process.exit(0);")

# 5. Tour : tirage + décision de la Mouche
P("startTurnForPlayers",
  "function startTurnForPlayers(game) {\n  if (game.gameMode === 'admin') {",
  "function startTurnForPlayers(game) {\n  if (game.gameMode === 'fly') {\n    FLY.startTurn(game);\n    return;\n  }\n  if (game.gameMode === 'admin') {")

# 6. Fin de partie : branche fly AVANT tout calcul de bonus de type / boss
P("finishGame",
  "function finishGame(game) {\n  // Filet de sécurité : score final",
  "function finishGame(game) {\n  if (game.gameMode === 'fly') {\n    // Aucun boss, aucun bonus de type, aucun objectif : cf. fly-game.js\n    game.status = 'finished';\n    game.route[game.route.length - 1].status = 'done';\n    FLY.finish(game);\n    return;\n  }\n  // Filet de sécurité : score final")

# 7. Transition de tour : attendre la révélation du choix de la Mouche
P("maybeScheduleTurnTransition",
  "  if (game.turnTimer) return; // déjà planifié, ne pas doubler\n",
  "  if (game.turnTimer) return; // déjà planifié, ne pas doubler\n  if (game.gameMode === 'fly' && !(game.fly && game.fly.revealed)) return; // la Mouche n'a pas encore révélé son choix\n")

# 8. Fin de tour humain : événements rares désactivés en fly, déclenche l'hésitation puis la révélation
P("finalizePlayerTurn",
  "function finalizePlayerTurn(game, player) {\n  broadcastGameUpdated(game);\n",
  "function finalizePlayerTurn(game, player) {\n  broadcastGameUpdated(game);\n  if (game.gameMode === 'fly') {\n    // Événements rares désactivés (comme en admin, dans un premier temps)\n    FLY.onHumanChose(game);\n    maybeScheduleTurnTransition(game);\n    return;\n  }\n")

# 9. Abandon / suppression de partie : plus de timer, AUCUN apprentissage
P("finalizePlayerRemoval",
  "    clearSpectators(game, gameId);\n    delete games[gameId];\n    deletePersistedGame(gameId);\n    return;",
  "    clearSpectators(game, gameId);\n    FLY.dispose(game); // mode fly : abandon = aucun apprentissage\n    delete games[gameId];\n    deletePersistedGame(gameId);\n    return;")
P("play_again",
  "    if (oldGame.turnTimer) clearTimeout(oldGame.turnTimer); // filet de sécurité",
  "    FLY.dispose(oldGame);\n    if (oldGame.turnTimer) clearTimeout(oldGame.turnTimer); // filet de sécurité")

# 10. join_game : ni spectateur ni 2e joueur en mode fly (vérifié AVANT de quitter une autre partie)
P("join_game",
  "    if (game.status !== 'waiting') {\n      // Partie déjà démarrée : mode spectateur, tous modes confondus. Un spectateur",
  "    if (game.gameMode === 'fly' && socket.data.gameId !== id) {\n      socket.emit('error_message', 'Cette partie est un duel Humanité vs Mouche : elle ne peut pas être rejointe.');\n      return;\n    }\n    if (game.status !== 'waiting') {\n      // Partie déjà démarrée : mode spectateur, tous modes confondus. Un spectateur")

# 11. set_game_mode : 'fly' uniquement seul dans le lobby
P("set_game_mode",
  "    if (!GAME_MODES.includes(mode)) {\n      socket.emit('error_message', 'Mode de jeu invalide.');\n      return;\n    }\n",
  "    if (!GAME_MODES.includes(mode)) {\n      socket.emit('error_message', 'Mode de jeu invalide.');\n      return;\n    }\n    if (mode === 'fly' && game.players.length !== 1) {\n      socket.emit('error_message', 'Humanité vs Mouche se joue seul : retire les autres joueurs du lobby.');\n      return;\n    }\n")

# 12. start_game : validation + démarrage direct (sans choix d'objet)
P("start_game (validation)",
  "    if (game.gameMode === 'coop' && game.players.length < 2) {\n      socket.emit('error_message', 'Le mode Coop nécessite au moins 2 joueurs.');\n      return;\n    }\n",
  "    if (game.gameMode === 'coop' && game.players.length < 2) {\n      socket.emit('error_message', 'Le mode Coop nécessite au moins 2 joueurs.');\n      return;\n    }\n    if (game.gameMode === 'fly' && (game.players.length !== 1 || (game.spectators && game.spectators.length > 0))) {\n      socket.emit('error_message', 'Humanité vs Mouche : 1 seul joueur, sans spectateur.');\n      return;\n    }\n")
P("start_game (démarrage)",
  "    if (game.gameMode === 'admin') {\n      beginRouteGameplay(game, gameId);\n      return;\n    }\n",
  "    if (game.gameMode === 'fly') {\n      FLY.begin(game); // pas d'objet de départ, pas de boss, pas de persistance\n      return;\n    }\n    if (game.gameMode === 'admin') {\n      beginRouteGameplay(game, gameId);\n      return;\n    }\n")

# 13. player_choice : aucun bonus de type en fly (garde explicite en plus de l'absence de boss)
P("player_choice",
  "    const typeBonusDelta = syncTypeBonus(player, game);",
  "    const typeBonusDelta = game.gameMode === 'fly' ? 0 : syncTypeBonus(player, game);")

# 14. Métamorph : sa transformation modifierait le score sans équivalent pour la Mouche -> refusée en fly
P("transform_metamorph",
  "  socket.on('transform_metamorph', ({ index } = {}) => {\n    const gameId = socket.data.gameId;\n    const game = games[gameId];\n",
  "  socket.on('transform_metamorph', ({ index } = {}) => {\n    const gameId = socket.data.gameId;\n    const game = games[gameId];\n    if (game && game.gameMode === 'fly') {\n      socket.emit('error_message', 'Indisponible dans ce mode.');\n      return;\n    }\n")

# 15. rejoin_game : état de la Mouche renvoyé au joueur qui se reconnecte
P("rejoin_game",
  "      chatMessages: game.chatMessages\n    });\n\n    // Mode \"auction\" : renvoie le lot en cours",
  "      chatMessages: game.chatMessages,\n      fly: game.gameMode === 'fly' ? FLY.publicState(game) : undefined\n    });\n    if (game.gameMode === 'fly') FLY.resyncTurn(game, socket.id);\n\n    // Mode \"auction\" : renvoie le lot en cours")

# 16. Initialisation (cerveau, routes admin, XP plafonnée, partie) juste avant le démarrage du serveur
P("démarrage serveur",
  "const PORT = process.env.PORT || 3000;\n",
  """// ---- MODE 'fly' (Humanité vs Mouche) : cerveau partagé, XP plafonnée, déroulement de partie ----
const { createBrainStore } = require('./fly-brain-store');
const { registerFlyAdminRoutes } = require('./fly-admin-routes');
const { createFlyGame } = require('./fly-game');
const { createFlyXp } = require('./fly-xp');
const flyBrain = createBrainStore({ supabase });
registerFlyAdminRoutes(app, { store: flyBrain });
const FLY = createFlyGame({
  io, store: flyBrain,
  recordFlyResult: createFlyXp({ supabase, createAuthClient, xpParticipation: XP_PARTICIPATION, xpVictoryBonus: XP_VICTORY_BONUS }),
  deps: {
    pickPlayerTurnOptions: (...a) => pickPlayerTurnOptions(...a),
    teamMonFromReward: r => teamMonFromReward(r),
    buildRoute: () => buildRoute(),
    getPublicPlayers: g => getPublicPlayers(g),
    maybeScheduleTurnTransition: g => maybeScheduleTurnTransition(g)
  }
});

const PORT = process.env.PORT || 3000;
""")
P("démarrage serveur (chargement)",
  "loadPersistedGames()\n  .catch(",
  "Promise.all([loadPersistedGames(), flyBrain.load().catch(err => console.error('[fly] chargement du cerveau', err.message))])\n  .catch(")

# ---- Application (tout ou rien) ----
out = src
for where, old, new in patches:
    n = out.count(old)
    if n != 1:
        sys.exit(f"ÉCHEC [{where}] : ancre trouvée {n} fois (attendu 1). Aucun fichier modifié.")
    out = out.replace(old, new)

shutil.copyfile(path, path + '.bak-fly')
open(path, 'w', encoding='utf-8').write(out)
print(f"OK : {len(patches)} remplacements appliqués dans {path} (sauvegarde : {path}.bak-fly)")
for where, _, _ in patches:
    print('  -', where)
