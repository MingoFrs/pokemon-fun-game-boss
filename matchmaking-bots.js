'use strict';
// =====================================================================
// MATCHMAKING + FAUX JOUEURS (bots) — pour les joueurs seuls dans un lobby.
//
// Principe : depuis un lobby où il est seul, l'hôte clique sur "Trouver des adversaires".
//  1. VRAI MATCHMAKING (30 s) : les lobbies solos qui cherchent la MÊME chose (mode, difficulté,
//     modificateurs) sont regroupés dans le lobby le plus ancien (la "salle"). Le joueur déplacé
//     passe par le vrai handler 'join_game' (identique à rejoindre avec un code).
//  2. Quand la salle est pleine (4 en multi, 2 pour admin/devine/enchères) elle démarre. Avec au
//     moins 2 humains, elle démarre 10 s après la dernière arrivée (ou à la fin des 30 s).
//  3. Si personne n'est venu au bout de 30 s : des bots complètent le lobby un à un, puis la partie
//     se lance toute seule. Les bots jouent AU HASARD.
//
// Les bots passent par EXACTEMENT les mêmes handlers que les humains : chaque bot est un faux socket
// (id, data, on, emit, join, leave) sur lequel on rejoue les listeners 'connection' du serveur. Ils
// rejoignent via 'join_game', jouent via 'player_choice' / 'guess_attempt' / 'auction_bid' / 'sd_pick'...
// => aucune règle dupliquée, mêmes validations que pour un humain, aucune triche possible.
// Les bots ne lisent jamais rien : ils décident à partir de l'état serveur (ils jouent au hasard).
//
// Deux lobbies sont "la même recherche" s'ils ont le même mode, la même difficulté et les mêmes
// modificateurs (cf. keyOf). Le type d'enchères et la durée de tour sont ceux de la salle.
// =====================================================================
const crypto = require('crypto');

const TICK_MS = 700;
const WAIT_MS = 30000;               // attente de VRAIS joueurs avant de passer aux bots
const GROUP_WAIT_MS = 10000;         // avec >= 2 humains : attente max après la dernière arrivée
const FIRST_FOUND_MS = [1500, 3000]; // une fois les 30 s écoulées : délai avant le 1er bot "trouvé"
const NEXT_FOUND_MS = [1000, 2200];  // délai entre deux bots trouvés
const READY_DELAY_MS = 1800;         // pause entre "tous trouvés" et le lancement
const RETRY_AFTER_MS = 8000;         // un coup de bot sans effet est retenté (3 fois max)

// Un seul humain + N bots. Délais de réflexion en millisecondes [min, max].
const pickBotCount = () => pickWeighted([1, 2, 3], [3, 4, 3]); // 2 à 4 joueurs au total
// max = nombre MAXIMUM de joueurs d'une salle ; bots = bots ajoutés à un humain seul ; think = délai de réflexion.
const MODE_PLAN = {
  normal:    { max: 4, bots: pickBotCount, think: [1200, 4500] },
  coop:      { max: 4, bots: pickBotCount, think: [1200, 4500] },
  statdraft: { max: 4, bots: pickBotCount, think: [2000, 8000] },
  quiz:      { max: 6, bots: pickBotCount, think: [2000, 11000] }, // les bots répondent au hasard (40 % de connaissance)
  admin:     { max: 2, bots: () => 1,      think: [1200, 4500] }, // seul : le bot est l'ADMIN (il observe), l'humain joue
  guess:     { max: 2, bots: () => 1,      think: [3000, 9000] },
  auction:   { max: 2, bots: () => 1,      think: [2500, 7000] }
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

function createMatchmaking({ io, app, games, avatars, auctionMinBid, sd, qz, botLabel, log, timeScale }) {
  const say = log || console;
  const T = ms => ms * (timeScale || 1); // 1 en production ; réduit uniquement par les tests
  const label = botLabel === undefined ? ' 🤖' : botLabel; // '' = bots indiscernables des humains (cf. MATCHMAKING_BOT_LABEL)
  const botSockets = new Map(); // id du bot -> faux socket
  const rooms = new Map();      // id de partie (lobby-salle) -> recherche en cours
  const brains = new WeakMap(); // joueur bot -> { key, dueAt, acted, attempts, actedAt, turns }

  const humansOf = game => game.players.filter(p => !p.isBot);
  const keyOf = game => JSON.stringify([
    game.gameMode, game.selectedDifficulty,
    [...(game.modifiers || [])].sort(), [...(game.sdMods || [])].sort(),
    game.gameMode === 'quiz' && qz ? qz.configKey(game) : null // même quiz = mêmes types de questions, même nombre, mêmes modificateurs
  ]);

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
  // Salles de recherche
  //   room = { gameId, mode, key, max, createdAt, endsAt, phase, humanCount, bots[], needed, timers[] }
  //   phase : 'humans' (30 s à chercher de vrais joueurs) -> 'bots' (ajout des bots) -> 'ready' -> lancement
  // L'état "humains présents / hôte" est TOUJOURS relu dans la partie (jamais copié) : un joueur qui
  // part, un nouvel hôte ou un ami arrivé avec le code sont pris en compte sans cas particulier.
  // ------------------------------------------------------------------
  function emitState(room, state, extra) {
    const game = games[room.gameId];
    if (!game) return;
    const now = Date.now();
    humansOf(game).forEach(me => {
      io.to(me.id).emit('mm_state', {
        state: state || (room.phase === 'ready' ? 'ready' : 'searching'),
        phase: room.phase,
        mode: room.mode,
        total: room.phase === 'humans' ? room.max : game.players.length + Math.max(0, room.needed - room.bots.length),
        count: game.players.length,
        found: game.players.filter(q => q.id !== me.id).map(q => ({ name: q.name, avatar: q.avatar, bot: !!q.isBot })),
        endsInMs: room.phase === 'humans' ? Math.max(0, room.endsAt - now) : 0,
        isHost: me.id === game.hostId,
        ...(extra || {})
      });
    });
  }

  function clearTimers(room) {
    room.timers.forEach(t => clearTimeout(t));
    room.timers = [];
  }
  function later(room, ms, fn) {
    const t = setTimeout(() => {
      room.timers = room.timers.filter(x => x !== t);
      try { fn(); } catch (err) { say.error('[matchmaking]', err); }
    }, ms);
    room.timers.push(t);
  }

  // La salle reste valable tant que le lobby est exactement dans l'état où la recherche l'a mis.
  function stillValid(game, room) {
    return !!game
      && rooms.get(game.id) === room
      && game.status === 'waiting'
      && game.gameMode === room.mode
      && keyOf(game) === room.key
      && game.players.filter(p => p.isBot).length === room.bots.length
      && humansOf(game).length >= 1;
  }

  // Retire les bots ajoutés pendant la recherche (comme s'ils quittaient le lobby).
  function removeBots(room) {
    room.bots.forEach(b => {
      const sock = botSockets.get(b.id);
      if (sock) sock.trigger('leave_game');
      botSockets.delete(b.id);
    });
    room.bots = [];
  }

  function finishRoom(room, extra) {
    clearTimers(room);
    rooms.delete(room.gameId);
    const game = games[room.gameId];
    if (game) humansOf(game).forEach(p => io.to(p.id).emit('mm_state', { state: 'idle', mode: room.mode, ...(extra || {}) }));
  }

  function abort(room, reason) {
    const game = games[room.gameId];
    clearTimers(room);
    rooms.delete(room.gameId);
    if (game && game.status === 'waiting') removeBots(room);
    if (game) humansOf(game).forEach(p => io.to(p.id).emit('mm_state', { state: 'idle', mode: room.mode, reason: reason || null }));
  }

  // Calendrier de la phase "humains" : salle pleine -> prête ; >= 2 humains -> 10 s après la dernière
  // arrivée (au plus tard à la fin des 30 s) ; sinon fin des 30 s.
  function reschedule(room) {
    clearTimers(room);
    const n = room.humanCount;
    if (n >= room.max) { becomeReady(room); return; }
    const deadline = room.createdAt + T(WAIT_MS);
    room.endsAt = n >= 2 ? Math.min(deadline, Date.now() + T(GROUP_WAIT_MS)) : deadline;
    later(room, Math.max(0, room.endsAt - Date.now()), () => onDeadline(room));
  }

  function becomeReady(room) {
    clearTimers(room);
    room.phase = 'ready';
    emitState(room, 'ready');
    later(room, T(READY_DELAY_MS), () => launch(room));
  }

  function onDeadline(room) {
    const game = games[room.gameId];
    if (!stillValid(game, room)) { abort(room, 'Recherche interrompue.'); return; }
    if (humansOf(game).length >= 2) { becomeReady(room); return; } // de vrais joueurs ont été trouvés : pas de bots
    room.phase = 'bots';
    room.needed = MODE_PLAN[room.mode].bots();
    emitState(room);
    later(room, T(rand(...FIRST_FOUND_MS)), () => stepBot(room));
  }

  function addBot(game, room) {
    const { name, avatar } = randomIdentity(game);
    const id = 'bot_' + crypto.randomBytes(6).toString('hex');
    const sock = makeBotSocket(id);
    sock.trigger('join_game', { name, gameId: game.id, token: crypto.randomBytes(12).toString('hex'), avatar });
    const player = game.players.find(p => p.id === id);
    if (!player) return false; // join_game a refusé : on n'insiste pas
    player.isBot = true;
    botSockets.set(id, sock);
    room.bots.push({ id, name: player.name, avatar: player.avatar });
    return true;
  }

  function stepBot(room) {
    const game = games[room.gameId];
    if (!stillValid(game, room)) { abort(room, 'Recherche interrompue.'); return; }
    if (!addBot(game, room)) { abort(room, "Impossible d'ajouter un adversaire."); return; }
    if (room.bots.length < room.needed) {
      emitState(room);
      later(room, T(rand(...NEXT_FOUND_MS)), () => stepBot(room));
      return;
    }
    becomeReady(room);
  }

  function launch(room) {
    const game = games[room.gameId];
    if (!stillValid(game, room)) { abort(room, 'Recherche interrompue.'); return; }
    const host = io.sockets.sockets.get(game.hostId);
    if (!host) { abort(room, 'Connexion perdue.'); return; }

    // Réglages propres à chaque mode, passés par les vrais handlers de l'hôte (mêmes validations).
    // Admin : le bot s'il y en a un (l'humain joue), sinon un des deux humains tiré au sort.
    if (game.gameMode === 'admin') {
      const adminId = room.bots.length ? room.bots[0].id : pick(humansOf(game)).id;
      callHandler(host, 'set_admin_role', { adminId });
    }
    if (game.gameMode === 'auction' && !game.auctionType) callHandler(host, 'set_auction_type', { auctionType: pick(['complete', 'semi_blind']) });
    callHandler(host, 'start_game');

    if (game.status === 'waiting') { abort(room, "La partie n'a pas pu démarrer."); return; }
    finishRoom(room, { started: true });
  }

  // Reconcilie la salle avec la réalité du lobby (arrivée/départ d'un humain, y compris via un code).
  function syncRoom(room) {
    const game = games[room.gameId];
    if (!game) { clearTimers(room); rooms.delete(room.gameId); return; }
    const n = humansOf(game).length;
    if (n === room.humanCount) return;
    room.humanCount = n;
    if (room.phase === 'humans') reschedule(room); // recalcule l'échéance (arrivée ou départ d'un humain)
    emitState(room);
  }

  // Déplace un joueur seul dans le lobby d'une salle existante : mêmes règles que rejoindre avec un code
  // ('join_game' quitte lui-même l'ancien lobby, qui est supprimé car il n'avait que ce joueur).
  function joinRoom(room, socket) {
    const source = games[socket.data.gameId];
    const me = source && source.players.find(p => p.id === socket.id);
    if (!me) return;
    callHandler(socket, 'join_game', { name: me.name, gameId: room.gameId, token: me.token, avatar: me.avatar, accessToken: me.accountAccessToken });
    if (socket.data.gameId !== room.gameId) { socket.emit('error_message', 'Impossible de rejoindre la partie trouvée.'); return; }
    syncRoom(room);
  }

  function startSearch(socket) {
    const game = games[socket.data.gameId];
    if (!game) { socket.emit('error_message', 'Partie introuvable.'); return; }
    if (game.hostId !== socket.id) { socket.emit('error_message', "Seul l'hôte peut lancer la recherche."); return; }
    if (game.status !== 'waiting') { socket.emit('error_message', 'Partie déjà démarrée.'); return; }
    const plan = MODE_PLAN[game.gameMode];
    if (!plan) { socket.emit('error_message', 'Ce mode se joue seul : pas de matchmaking.'); return; }
    if (game.players.length !== 1 || humansOf(game).length !== 1) { socket.emit('error_message', "Le matchmaking est réservé aux joueurs seuls dans leur lobby."); return; }
    if (rooms.has(game.id)) return; // déjà en cours : on ignore le double clic

    // 1) Une salle compatible existe déjà : on la rejoint (vrai matchmaking).
    const key = keyOf(game);
    const candidate = [...rooms.values()].find(r =>
      r.key === key && r.phase === 'humans' && r.humanCount < r.max && r.gameId !== game.id && stillValid(games[r.gameId], r));
    if (candidate) { joinRoom(candidate, socket); return; }

    // 2) Sinon, ce lobby devient une salle : 30 s pour trouver de vrais joueurs, puis des bots.
    const room = { gameId: game.id, mode: game.gameMode, key, max: plan.max, createdAt: Date.now(), endsAt: 0, phase: 'humans', humanCount: 1, bots: [], needed: 0, timers: [] };
    rooms.set(game.id, room);
    reschedule(room);
    emitState(room);
  }

  function cancelSearch(socket) {
    const game = games[socket.data.gameId];
    const room = game && rooms.get(game.id);
    if (!room) return;
    if (game.hostId === socket.id) { abort(room, null); return; } // l'hôte annule : les humains déjà réunis restent dans le lobby
    // Un invité qui annule quitte simplement le lobby.
    callHandler(socket, 'leave_game');
    io.to(socket.id).emit('mm_state', { state: 'idle', mode: room.mode, left: true });
    syncRoom(room);
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
      case 'quiz': {
        const move = qz && qz.botMove(game, bot);
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
    for (const room of [...rooms.values()]) {
      const g = games[room.gameId];
      if (!g || !humansOf(g).length) { clearTimers(room); rooms.delete(room.gameId); continue; }
      if (!stillValid(g, room)) { abort(room, 'Recherche interrompue.'); continue; }
      syncRoom(room);
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
    const room = rooms.get(game.id);
    if (room) { clearTimers(room); rooms.delete(game.id); }
    game.players.filter(p => p.isBot).forEach(p => botSockets.delete(p.id));
  }

  return { dispose, _internals: { tick, rooms, botSockets, MODE_PLAN, keyOf } };
}

module.exports = { createMatchmaking, MODE_PLAN };
