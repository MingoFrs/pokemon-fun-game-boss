'use strict';
// =====================================================================
// MODE 'fly' — déroulement d'une partie Humanité vs Mouche (serveur uniquement).
// L'humain reste un joueur NORMAL de game.players (player_choice, rejoin, skip_reveal, play_again
// inchangés). La Mouche vit dans game.fly : jamais dans game.players, jamais sérialisée, jamais envoyée
// au client autrement que via les événements ci-dessous.
//
// Par tour : tirage UNIQUE (pickPlayerTurnOptions, table du mode normal, sans pity / Charme / plancher)
// -> la Mouche DÉCIDE immédiatement (avant tout choix humain) sur ce qu'un humain voit : identité du Pokémon,
//    shiny, types (jamais points de base, rareté, effet ni points finaux)
// -> l'humain choisit -> délai d'hésitation -> choix de la Mouche RÉVÉLÉ ; elle voit alors le résultat de SON
//    choix (base, effet, points) — comme l'humain voit le sien — et le mémorise pour apprendre en fin de partie
// -> transition standard (4 s).
//
// Événements émis au client (room de la partie) :
//   fly_thinking {turn}                       début de tour : « la Mouche hésite… » (aucune info de décision)
//   fly_choice_revealed {turn, choice, pokemon, rarity, basePoints, effect, pointsGained, score}
//   fly_state {…publicState}                  resynchronisation après reconnexion (rejoin_game)
//   game_started / game_finished              mêmes événements que les autres modes + champ `fly`
// Le serveur n'envoie JAMAIS : valeurs apprises, probabilités de choix, décision en attente.
// =====================================================================
const defaultConfig = require('./fly-config');
const { outcomeFor, CHOICES } = require('./fly-value-policy');

const HUMAN_RESULT = { win: 'defeat', loss: 'victory', draw: 'participation' };   // résultat de la Mouche -> de l'humain
const pub = o => ({ name: o.name, sprite: o.sprite, shiny: !!o.shiny, shinySprite: o.shinySprite || null });

function createFlyGame({
  io, store, deps, recordFlyResult = null, config = defaultConfig,
  timers = { set: setTimeout, clear: clearTimeout }, random = Math.random, logger = console
}) {
  // deps : { pickPlayerTurnOptions, teamMonFromReward, buildRoute, getPublicPlayers, maybeScheduleTurnTransition, getTypes }
  const api = {};
  const typesOf = id => { try { return (deps.getTypes && deps.getTypes(id)) || []; } catch (e) { return []; } };

  api.publicState = function publicState(game) {
    const f = game.fly;
    if (!f) return null;
    return {
      stats: store.getPublicStats(),
      score: f.score,
      team: f.team.slice(),
      history: f.history.map(h => ({ ...h })),
      thinking: game.status === 'playing' && !f.revealed,
      finished: f.finished
    };
  };

  api.begin = function begin(game) {
    const human = game.players[0];
    game.status = 'playing';
    game.turn = 1;
    game.route = deps.buildRoute();
    game.boss = null;                      // PAS de boss : aucune mécanique de type / objectif / calibrage
    game.fly = {
      epoch: store.beginGame().epoch, score: 0, team: [], trajectory: [], turnOptions: [], history: [],
      humanHistory: [], humanDone: {}, decision: null, revealed: false, hesitationMs: 0, revealTimer: null,
      finished: false, untrainable: false
    };
    io.to(game.id).emit('game_started', {
      gameId: game.id, status: game.status, turn: game.turn, maxTurns: game.maxTurns, route: game.route,
      boss: null, difficulty: null, gameMode: game.gameMode, adminId: null,
      players: deps.getPublicPlayers(game), fly: store.getPublicStats()
    });
    io.to(human.id).emit('your_item', { item: null, used: false, passive: false });
    api.startTurn(game);
  };

  api.startTurn = function startTurn(game) {
    const f = game.fly;
    if (!f || f.finished) return;
    const human = game.players[0];
    if (!human) return;
    const options = deps.pickPlayerTurnOptions(false, 0, undefined, undefined, config.MODE);
    f.turnOptions[game.turn - 1] = options;
    human.currentOptions = options;
    io.to(human.id).emit('turn_options', { haut: pub(options.haut), bas: pub(options.bas) });

    // DÉCISION PRISE ICI, avant tout choix humain. Observation = ce que verrait un humain : identité, shiny, types.
    const obs = {
      turn: game.turn, ownScore: f.score, oppScore: human.score,
      options: [options.haut, options.bas].map(o => ({ pokemonId: o.pokemonId, shiny: !!o.shiny, types: typesOf(o.pokemonId) }))
    };
    let decision;
    try { decision = store.choose(obs); }
    catch (e) {
      logger.error('[fly] décision impossible, choix aléatoire (partie non utilisée pour l\'apprentissage) :', e.message);
      const index = random() < 0.5 ? 0 : 1;
      decision = { index, choice: CHOICES[index] };
      f.untrainable = true;
    }
    if (decision.picked) f.trajectory.push(decision);
    f.decision = decision;
    f.revealed = false;
    f.hesitationMs = config.HESITATION_MS_MIN + random() * (config.HESITATION_MS_MAX - config.HESITATION_MS_MIN);
    io.to(game.id).emit('fly_thinking', { turn: game.turn });
  };

  // Appelé par finalizePlayerTurn juste après un player_choice VALIDE par le serveur (l'humain a choisi).
  api.onHumanChose = function onHumanChose(game) {
    const f = game.fly;
    const human = game.players[0];
    if (!f || f.finished || !human || f.humanDone[game.turn]) return;
    if (human.currentChoice !== 'HAUT' && human.currentChoice !== 'BAS') return;
    f.humanDone[game.turn] = true;
    const mine = f.turnOptions[game.turn - 1][human.currentChoice === 'HAUT' ? 'haut' : 'bas'];
    f.humanHistory.push({ turn: game.turn, choice: human.currentChoice, pointsGained: mine.finalPoints });
    const turn = game.turn;
    f.revealTimer = timers.set(() => { f.revealTimer = null; reveal(game, turn); }, Math.round(f.hesitationMs));
  };

  function reveal(game, turn) {
    const f = game.fly;
    if (!f || f.finished || game.status !== 'playing' || game.turn !== turn || f.revealed || !f.decision) return;
    const key = f.decision.index === 0 ? 'haut' : 'bas';
    const reward = f.turnOptions[turn - 1][key];
    f.score += reward.finalPoints;
    if (f.team.length < config.TURNS) f.team.push(deps.teamMonFromReward(reward));
    // La Mouche voit le résultat de SON choix (jamais l'option non choisie) : mémorisé pour l'apprentissage de fin de partie.
    if (f.decision.picked) {
      try { store.observe(f.decision, { basePoints: reward.basePoints, finalPoints: reward.finalPoints }); }
      catch (e) { logger.error('[fly] résultat du choix inutilisable (partie non utilisée pour l\'apprentissage) :', e.message); f.untrainable = true; }
    }
    const entry = {
      turn, choice: CHOICES[f.decision.index], pokemon: pub(reward), rarity: reward.rarity, basePoints: reward.basePoints,
      effect: { name: reward.effectName, multiplier: reward.multiplier }, pointsGained: reward.finalPoints
    };
    f.history.push(entry);
    f.revealed = true;
    io.to(game.id).emit('fly_choice_revealed', { ...entry, score: f.score });
    deps.maybeScheduleTurnTransition(game);
  }

  // Fin de partie NORMALE (6 tours joués jusqu'au bout). Met à jour le cerveau et attribue l'XP
  // UNIQUEMENT si la partie est complète. Aucun bonus de type, aucun boss, aucun objectif.
  api.finish = function finish(game) {
    const f = game.fly;
    const human = game.players[0];
    if (!f || f.finished || !human) return;
    f.finished = true;
    if (f.revealTimer) { timers.clear(f.revealTimer); f.revealTimer = null; }
    const T = config.TURNS;
    const complete = f.history.length === T && f.humanHistory.length === T && f.turnOptions.length === T &&
      f.trajectory.length === T && !f.untrainable;

    const result = outcomeFor(f.score, human.score);
    const humanResult = HUMAN_RESULT[result];

    let counted = false;
    if (complete) {
      try { counted = !!store.recordGame({ epoch: f.epoch, trajectory: f.trajectory, result }).learned; }
      catch (e) { logger.error('[fly] mise à jour du cerveau impossible :', e.message); }
      if (recordFlyResult) {
        Promise.resolve(recordFlyResult(human, { result: humanResult, score: human.score, opponentName: config.AGENT_NAME, team: human.team }))
          .catch(e => logger.error('[fly] XP/historique :', e && e.message));
      }
    }

    io.to(game.id).emit('game_finished', {
      boss: null, difficulty: null, gameMode: game.gameMode, adminId: null, route: game.route,
      players: [{
        id: human.id, name: human.name, avatar: human.avatar, score: human.score, team: human.team,
        typeBonus: null, result: humanResult
      }],
      fly: {
        name: config.AGENT_NAME, score: f.score, team: f.team.slice(), result, humanResult,
        turns: f.history.map((h, i) => ({ ...h, humanChoice: f.humanHistory[i] && f.humanHistory[i].choice, humanPointsGained: f.humanHistory[i] && f.humanHistory[i].pointsGained })),
        counted, stats: store.getPublicStats()      // chiffres RÉELS, après cette partie
      }
    });
  };

  // Partie supprimée / abandonnée : AUCUN apprentissage, plus aucun timer.
  api.dispose = function dispose(game) {
    const f = game && game.fly;
    if (!f) return;
    f.finished = true;
    if (f.revealTimer) { timers.clear(f.revealTimer); f.revealTimer = null; }
  };

  api.resyncTurn = function resyncTurn(game, socketId) {
    if (!game.fly) return;
    io.to(socketId).emit('fly_state', api.publicState(game));
  };

  return api;
}

module.exports = { createFlyGame, HUMAN_RESULT };
