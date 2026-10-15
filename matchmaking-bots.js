'use strict';
// =====================================================================
// MATCHMAKING + FAUX JOUEURS (bots) — pour les joueurs seuls dans un lobby.
//
// Principe : depuis un lobby où il est seul, l'hôte clique sur "Trouver des adversaires".
// Le serveur simule une recherche (quelques secondes), fait "arriver" des joueurs simulés un à un
// dans le lobby, puis lance la partie automatiquement. Les bots jouent AU HASARD.
//
// Les bots passent par EXACTEMENT les mêmes handlers que les humains : chaque bot est un faux socket
// (id, data, on, emit, join, leave) sur lequel on rejoue les listeners 'connection' du serveur. Ils
// rejoignent via 'join_game', jouent via 'player_choice' / 'guess_attempt' / 'auction_bid' / 'sd_pick'...
// => aucune règle dupliquée, mêmes validations que pour un humain, aucune triche possible.
// Les bots ne lisent jamais rien : ils décident à partir de l'état serveur (ils jouent au hasard).
//
// Plus tard : un vrai matchmaking (file d'attente entre humains) pourra remplacer/compléter
// startSearch() sans toucher au reste : les bots ne serviront alors que de remplissage.
// =====================================================================
const crypto = require('crypto');

const TICK_MS = 700;
const FIRST_FOUND_MS = [2000, 4500]; // délai avant le 1er joueur "trouvé"
const NEXT_FOUND_MS = [1200, 3000];  // délai entre deux joueurs trouvés
const READY_DELAY_MS = 1800;         // pause entre "tous trouvés" et le lancement
const RETRY_AFTER_MS = 8000;         // un coup de bot sans effet est retenté (3 fois max)

// Un seul humain + N bots. Délais de réflexion en millisecondes [min, max].
const pickBotCount = () => pickWeighted([1, 2, 3], [3, 4, 3]); // 2 à 4 joueurs au total
const MODE_PLAN = {
  normal:    { bots: pickBotCount, think: [1200, 4500] },
  coop:      { bots: pickBotCount, think: [1200, 4500] },
  statdraft: { bots: pickBotCount, think: [2000, 8000] },
  admin:     { bots: () => 1,      think: [1200, 4500] }, // le bot est l'ADMIN (il observe), l'humain joue
  guess:     { bots: () => 1,      think: [3000, 9000] },
  auction:   { bots: () => 1,      think: [2500, 7000] }
};
// 'fly' (Humanité vs Mouche) se joue seul par conception : jamais de matchmaking.

const BOT_NAMES = [
  'Sacha_59', 'Nina', 'DracoMaster', 'PikaFan', 'Léo', 'Mélodie', 'Rayquaza_X', 'Zoé', 'LeBoss', 'Kaïs',
  'Enzo', 'Manon', 'Hugo', 'Chloé', 'Tom', 'Lina', 'Alex', 'Maëlys', 'Yanis', 'Camille', 'ShadowX',
  'Ondine', 'PierreRoche', 'Sunny', 'Lucas', 'Jade', 'Noah', 'Eva', 'Gabriel', 'Louna', 'Evoli_fan',
  'Ténèbres', 'Mathis', 'Inès', 'Rémi', 'Clara', 'Nolan', 'Anaïs', 'Axel', 'Lola'
];

function rand(min, max) { return min + Math.random() * (max - min); }
function randInt(n) { return Math.floor(Math.random() * n); }
function pick(arr) { return arr[randInt(arr.length)]; }
function pickWeighted(values, weights) {
  const total = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < values.length; i++) {
    r -= weights[i];
    if (r < 0) return values[i];
  }
  return values[values.length - 1];
}

function createMatchmaking({ io, app, games, avatars, auctionMinBid, sd, botLabel, log, timeScale }) {
  const say = log || console;
  const T = ms => ms * (timeScale || 1); // 1 en production ; réduit uniquement par les tests
  const label = botLabel === undefined ? ' 🤖' : botLabel; // '' = bots indiscernables des humains (cf. MATCHMAKING_BOT_LABEL)
  const botSockets = new Map(); // id du bot -> faux socket
  const searches = new Map();   // id de partie -> recherche en cours
  const brains = new WeakMap(); // joueur bot -> { key, dueAt, acted, attempts, actedAt, turns }

  const humansOf = game => game.players.filter(p => !p.isBot);
  const hostSocket = search => io.sockets.sockets.get(search.hostId) || null;

  // ------------------------------------------------------------------
  // Faux socket : même interface que les handlers du serveur attendent.
  // ------------------------------------------------------------------
  function makeBotSocket(id) {
    const handlers = {};
    const sock = {
      id,
      data: {},
      handshake: { address: 'bot', headers: {}, auth: {} },
      connected: true,
      isBot: true,
      on(event, fn) { (handlers[event] = handlers[event] || []).push(fn); return sock; },
      emit() { return true; }, // un bot ne lit rien : tout vient de l'état serveur
      join() {},
      leave() {},
      trigger(event, payload) {
        (handlers[event] || []).forEach(fn => {
          try { fn(payload); } catch (err) { say.error(`[bots:${event}]`, err); }
        });
      }
    };
    // Rejoue les listeners de connexion (hors celui-ci) : le bot reçoit alors tous les handlers réels.
    io.of('/').listeners('connection').filter(fn => fn !== attach).forEach(fn => {
      try { fn(sock); } catch (err) { say.error('[bots] connexion', err); }
    });
    return sock;
  }

  function callHandler(socket, event, payload) {
    if (!socket) return;
    if (typeof socket.trigger === 'function') { socket.trigger(event, payload); return; }
    socket.listeners(event).forEach(fn => fn(payload)); // vrai socket (handlers déjà protégés par io.use)
  }

  function reviveBotSocket(bot, game) {
    const sock = makeBotSocket(bot.id);
    sock.data.gameId = game.id;
    botSockets.set(bot.id, sock);
    return sock;
  }

  function randomIdentity(game) {
    const used = new Set(game.players.map(p => String(p.name).toLowerCase().replace(/\s*🤖$/u, '')));
    const free = BOT_NAMES.filter(n => !used.has(n.toLowerCase()));
    const base = pick(free.length ? free : BOT_NAMES);
    return {
      name: base + label,
      avatar: avatars && avatars.length && Math.random() < 0.85 ? pick(avatars) : null
    };
  }

  // ------------------------------------------------------------------
  // Recherche d'adversaires (simulée)
  // ------------------------------------------------------------------
  const statePayload = (search, state, extra) => ({
    state,
    mode: search.mode,
    total: search.needed + 1,
    found: search.found.map(f => ({ name: f.name, avatar: f.avatar })),
    ...(extra || {})
  });
  const emitHost = (search, state, extra) => io.to(search.hostId).emit('mm_state', statePayload(search, state, extra));

  function clearTimers(search) {
    search.timers.forEach(t => clearTimeout(t));
    search.timers = [];
  }
  function later(search, ms, fn) {
    const t = setTimeout(() => {
      search.timers = search.timers.filter(x => x !== t);
      try { fn(); } catch (err) { say.error('[matchmaking]', err); }
    }, ms);
    search.timers.push(t);
  }

  // La recherche reste valable tant que le lobby est exactement dans l'état où elle a démarré.
  function stillValid(game, search) {
    return !!game
      && searches.get(game.id) === search
      && game.status === 'waiting'
      && game.gameMode === search.mode
      && game.hostId === search.hostId
      && humansOf(game).length === 1
      && game.players.length === 1 + search.found.length;
  }

  // Retire les bots ajoutés pendant la recherche (comme s'ils quittaient le lobby).
  function removeBots(search) {
    search.found.forEach(f => {
      const sock = botSockets.get(f.id);
      if (sock) sock.trigger('leave_game');
      botSockets.delete(f.id);
    });
    search.found = [];
  }

  function abort(search, reason) {
    clearTimers(search);
    searches.delete(search.gameId);
    const game = games[search.gameId];
    if (game && game.status === 'waiting') removeBots(search);
    emitHost(search, 'idle', { reason: reason || null });
  }

  function addBot(game, search) {
    const { name, avatar } = randomIdentity(game);
    const id = 'bot_' + crypto.randomBytes(6).toString('hex');
    const sock = makeBotSocket(id);
    sock.trigger('join_game', { name, gameId: game.id, token: crypto.randomBytes(12).toString('hex'), avatar });
    const player = game.players.find(p => p.id === id);
    if (!player) return false; // join_game a refusé : on n'insiste pas
    player.isBot = true;
    botSockets.set(id, sock);
    search.found.push({ id, name: player.name, avatar: player.avatar });
    return true;
  }

  function step(search) {
    const game = games[search.gameId];
    if (!stillValid(game, search)) { abort(search, 'Recherche interrompue.'); return; }
    if (!addBot(game, search)) { abort(search, "Impossible d'ajouter un adversaire."); return; }
    if (search.found.length < search.needed) {
      emitHost(search, 'searching');
      later(search, T(rand(...NEXT_FOUND_MS)), () => step(search));
      return;
    }
    emitHost(search, 'ready');
    later(search, T(READY_DELAY_MS), () => launch(search));
  }

  function launch(search) {
    const game = games[search.gameId];
    if (!stillValid(game, search)) { abort(search, 'Recherche interrompue.'); return; }
    const host = hostSocket(search);
    if (!host) { abort(search, 'Connexion perdue.'); return; }

    // Réglages propres à chaque mode, passés par les vrais handlers de l'hôte (mêmes validations).
    if (game.gameMode === 'admin') callHandler(host, 'set_admin_role', { adminId: search.found[0].id });
    if (game.gameMode === 'auction' && !game.auctionType) callHandler(host, 'set_auction_type', { auctionType: pick(['complete', 'semi_blind']) });
    callHandler(host, 'start_game');

    if (game.status === 'waiting') { abort(search, 'La partie n\'a pas pu démarrer.'); return; }
    clearTimers(search);
    searches.delete(search.gameId);
    emitHost(search, 'idle', { started: true });
  }

  function startSearch(socket) {
    const game = games[socket.data.gameId];
    if (!game) { socket.emit('error_message', 'Partie introuvable.'); return; }
    if (game.hostId !== socket.id) { socket.emit('error_message', "Seul l'hôte peut lancer la recherche."); return; }
    if (game.status !== 'waiting') { socket.emit('error_message', 'Partie déjà démarrée.'); return; }
    const plan = MODE_PLAN[game.gameMode];
    if (!plan) { socket.emit('error_message', 'Ce mode se joue seul : pas de matchmaking.'); return; }
    if (game.players.length !== 1 || humansOf(game).length !== 1) { socket.emit('error_message', "Le matchmaking est réservé aux joueurs seuls dans leur lobby."); return; }
    if (searches.has(game.id)) return; // déjà en cours : on ignore le double clic

    const search = { gameId: game.id, hostId: socket.id, mode: game.gameMode, needed: plan.bots(), found: [], timers: [] };
    searches.set(game.id, search);
    emitHost(search, 'searching');
    later(search, T(rand(...FIRST_FOUND_MS)), () => step(search));
  }

  function cancelSearch(socket) {
    const game = games[socket.data.gameId];
    const search = game && searches.get(game.id);
    if (!search || search.hostId !== socket.id) return;
    abort(search, null);
  }

  // ------------------------------------------------------------------
  // Cerveau des bots : décisions AU HASARD, déclenchées après un délai aléatoire "de réflexion".
  // Chaque décision a une clé (change quand l'état de la partie change) : un coup n'est joué qu'une
  // fois par clé, et retenté si l'état n'a pas bougé (coup refusé).
  // ------------------------------------------------------------------
  function decideRoute(game, bot, plan) {
    if (game.status === 'item_select') {
      if (bot.heldItem || !Array.isArray(bot.startItemOptions) || !bot.startItemOptions.length) return null;
      return { key: 'item', delay: [1000, 3500], run: () => ({ event: 'starting_item_choice', payload: { key: pick(bot.startItemOptions) } }) };
    }
    if (game.status !== 'playing') return null;
    if (game.gameMode === 'admin' && game.adminId === bot.id) return null; // l'ADMIN observe, il ne joue pas
    if (!bot.currentOptions || bot.currentChoice !== null) return null;
    return { key: `turn:${game.turn}`, delay: plan.think, run: () => ({ event: 'player_choice', payload: { choice: Math.random() < 0.5 ? 'HAUT' : 'BAS' } }) };
  }

  function decideGuess(game, bot, plan) {
    if (game.status !== 'playing' || !Array.isArray(game.guessBoard) || !game.guessBoard.length) return null;
    if (bot.secretPokemonIndex === null) {
      return { key: 'g-secret', delay: [1500, 5000], run: () => ({ event: 'select_secret_pokemon', payload: { index: randInt(game.guessBoard.length) } }) };
    }
    if (game.guessActivePlayerId !== bot.id) return null;
    return {
      key: `g-turn:${game.guessTurnEndsAt}`,
      delay: plan.think,
      run: () => {
        const brain = brains.get(bot);
        const turns = brain.turns++;
        // Plus la partie avance, plus le bot ose tenter une réponse (au hasard, jamais sa propre case).
        if (Math.random() < Math.min(0.5, 0.1 + 0.07 * turns)) {
          const choices = game.guessBoard.map((_, i) => i).filter(i => i !== bot.secretPokemonIndex);
          return { event: 'guess_attempt', payload: { index: pick(choices) } };
        }
        return { event: 'guess_finish_turn', payload: undefined };
      }
    };
  }

  function decideAuction(game, bot, plan) {
    const lot = game.auctionLot;
    if (game.status !== 'playing' || !lot || lot.activePlayerId !== bot.id) return null;
    const STEP = 500_000; // les mises sont des multiples de 0,5 M (cf. auction_bid)
    return {
      key: `auc:${(game.auctionHistory || []).length}:${lot.currentBid}:${lot.currentBidderId}`,
      delay: plan.think,
      run: () => {
        const budget = Number(bot.budget) || 0;
        if (lot.currentBid === null || lot.currentBid === undefined) {
          if (budget < auctionMinBid) return { event: 'auction_bid', payload: { amount: 0 } }; // seul cas où miser 0 est permis
          const room = Math.floor((budget - auctionMinBid) / STEP);
          return { event: 'auction_bid', payload: { amount: auctionMinBid + STEP * randInt(Math.min(8, room) + 1) } };
        }
        const next = (Math.floor(lot.currentBid / STEP) + 1) * STEP;
        if (next > budget || Math.random() < 0.45) return { event: 'auction_pass', payload: undefined };
        const room = Math.floor((budget - next) / STEP);
        return { event: 'auction_bid', payload: { amount: next + STEP * randInt(Math.min(6, room) + 1) } };
      }
    };
  }

  function decide(game, bot) {
    const plan = MODE_PLAN[game.gameMode];
    if (!plan) return null;
    switch (game.gameMode) {
      case 'normal':
      case 'coop':
      case 'admin': return decideRoute(game, bot, plan);
      case 'guess': return decideGuess(game, bot, plan);
      case 'auction': return decideAuction(game, bot, plan);
      case 'statdraft': {
        const move = sd && sd.botMove(game, bot);
        if (!move) return null;
        return { key: move.key, delay: [plan.think[0], Math.max(plan.think[0], Math.min(plan.think[1], move.maxDelayMs))], run: () => ({ event: move.event, payload: move.payload }) };
      }
      default: return null;
    }
  }

  function brainOf(bot) {
    let b = brains.get(bot);
    if (!b) { b = { key: null, dueAt: 0, acted: null, attempts: 0, actedAt: 0, turns: 0 }; brains.set(bot, b); }
    return b;
  }

  function tick() {
    const now = Date.now();
    for (const [id, sock] of botSockets) {
      const g = games[sock.data.gameId];
      if (!g || !g.players.some(p => p.id === id)) botSockets.delete(id);
    }
    for (const search of [...searches.values()]) {
      if (!games[search.gameId]) { clearTimers(search); searches.delete(search.gameId); }
    }
    for (const game of Object.values(games)) {
      if (game.status === 'waiting' || game.status === 'finished') continue;
      for (const bot of game.players) {
        if (!bot.isBot) continue;
        const brain = brainOf(bot);
        const move = decide(game, bot);
        if (!move) { brain.key = null; continue; }
        if (brain.key !== move.key) { // nouvelle décision : on "réfléchit" un temps aléatoire
          brain.key = move.key;
          brain.dueAt = now + T(rand(move.delay[0], move.delay[1]));
          brain.acted = null; brain.attempts = 0;
          continue;
        }
        if (now < brain.dueAt) continue;
        if (brain.acted === move.key && (brain.attempts >= 3 || now - brain.actedAt < T(RETRY_AFTER_MS))) continue;
        brain.acted = move.key; brain.attempts += 1; brain.actedAt = now;
        const sock = botSockets.get(bot.id) || reviveBotSocket(bot, game);
        const { event, payload } = move.run();
        sock.trigger(event, payload);
      }
    }
  }
  setInterval(tick, Math.max(10, T(TICK_MS))).unref();

  // ------------------------------------------------------------------
  // Sockets réels + route de configuration
  // ------------------------------------------------------------------
  function attach(socket) {
    socket.on('mm_search', () => startSearch(socket));
    socket.on('mm_cancel', () => cancelSearch(socket));
  }
  io.on('connection', attach);

  if (app) {
    app.get('/api/matchmaking/config', (req, res) => {
      res.set('Cache-Control', 'no-store');
      res.json({ modes: Object.keys(MODE_PLAN) });
    });
  }

  // Appelé quand une partie est supprimée ou ne contient plus que des bots.
  function dispose(game) {
    const search = searches.get(game.id);
    if (search) { clearTimers(search); searches.delete(game.id); }
    game.players.filter(p => p.isBot).forEach(p => botSockets.delete(p.id));
  }

  return { dispose, _internals: { tick, searches, botSockets, MODE_PLAN } };
}

module.exports = { createMatchmaking, MODE_PLAN };
