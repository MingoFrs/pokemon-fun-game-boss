'use strict';
// =====================================================================
// MODE "QUIZ POKÉMON" (gameMode === 'quiz')
//
// N questions (5 / 10 / 15). Chaque question est de l'un des trois types activés par l'hôte :
//   🕶️ silhouette : "Qui est ce Pokémon ?"       🧬 types : "Quel Pokémon a ces types ?"
//   📊 stats : "Quel Pokémon a ces stats de base ?"
// 4 réponses possibles, UNE seule tentative par joueur. Le plus rapide marque le plus :
//   100 pts + jusqu'à 100 pts de bonus de vitesse (temps restant), +25 pts pour la bonne réponse la
//   plus rapide, -25 pts si on répond après l'indice (qui apparaît à mi-temps). Mauvaise réponse ou
//   pas de réponse : 0 pt.
//
// Module isolé (même logique que statdraft-game.js) : état dans game.quiz, événements "quiz_*",
// timers hors de l'objet partie (WeakMap), jamais persisté. Clés de joueur : sid (qzSid), jamais le
// socket.id (qui change à la reconnexion).
//
// ANTI-TRICHE : la bonne réponse n'est JAMAIS envoyée avant la révélation. Les images de silhouette
// passent par une adresse OPAQUE (/api/quiz/image/<jeton aléatoire>, valable le temps de la question)
// pour ne pas révéler le numéro du Pokémon dans l'URL. Limite assumée : l'image elle-même (colorée)
// est servie telle quelle et la silhouette est appliquée par CSS côté navigateur.
// =====================================================================
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { loadStatsTable, STAT_KEYS } = require('./statdraft-game');

const KINDS = ['silhouette', 'types', 'stats'];
const KIND_INFO = {
  silhouette: { label: 'Silhouettes', icon: '🕶️', prompt: 'Qui est ce Pokémon ?' },
  types: { label: 'Types', icon: '🧬', prompt: 'Quel Pokémon a ces types ?' },
  stats: { label: 'Stats', icon: '📊', prompt: 'Quel Pokémon a ces stats de base ?' }
};
const ROUNDS_OPTIONS = [5, 10, 15];
const DEFAULT_ROUNDS = 10;
const OPTIONS_COUNT = 4;
const TIMING = { countdownMs: 3000, questionMs: 15000, blitzMs: 8000, revealMs: 4500, imageGraceMs: 20000 };
const BASE_POINTS = 100;
const SPEED_BONUS = 100;
const FIRST_BONUS = 25;
const HINT_PENALTY = 25;
const NOHINT_MULT = 1.25;
const STREAK_STEP = 0.1;
const STREAK_CAP = 5;
const WRONG_PENALTY = 50;
const BOT_ACCURACY = 0.4; // un bot connaît la réponse 4 fois sur 10, sinon il répond au hasard
const MIN_POOL = 30;

const MODIFIERS = [
  { key: 'blitz', icon: '⏱️', label: 'Éclair', description: `${TIMING.blitzMs / 1000} secondes par question au lieu de ${TIMING.questionMs / 1000}.` },
  { key: 'nohint', icon: '🙈', label: 'Sans indice', description: `Plus aucun indice en cours de question, mais tous les points ×${NOHINT_MULT}.`.replace('.', ',') },
  { key: 'streak', icon: '🔥', label: 'Série', description: `+${STREAK_STEP * 100} % de points par bonne réponse consécutive (jusqu'à +${STREAK_STEP * STREAK_CAP * 100} %).` },
  { key: 'penalty', icon: '⚠️', label: 'Pénalité', description: `Une mauvaise réponse fait perdre ${WRONG_PENALTY} points (ne pas répondre ne coûte rien).` },
  { key: 'kanto', icon: '🗺️', label: 'Kanto', description: 'Seulement les 151 premiers Pokémon.' }
];
const MODIFIER_KEYS = MODIFIERS.map(m => m.key);

const GEN_LIMITS = [151, 251, 386, 493, 649, 721, 809, 905, 1025];
const generationOf = id => { const i = GEN_LIMITS.findIndex(l => id <= l); return i === -1 ? 9 : i + 1; };

function randomInt(n) { return Math.floor(Math.random() * n); }
function sample(arr, n, excludeSet) {
  const src = excludeSet ? arr.filter(x => !excludeSet.has(x.id)) : arr.slice();
  const out = [];
  while (out.length < n && src.length) out.push(src.splice(randomInt(src.length), 1)[0]);
  return out;
}
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = randomInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

function createQuiz({ io, app, games, supabase, createAuthClient, pool, entries, getTypes, spriteUrl, spritesDir, dataDir, xpParticipation, xpVictoryBonus, broadcastPlayers, log }) {
  const say = log || console;
  const timers = new WeakMap();   // partie -> { nom: timeout }
  const images = new Map();       // jeton opaque -> { id, expiresAt }

  // ---- données ----
  const seen = new Set();
  const base = (pool || []).filter(p => p && Number.isInteger(p.id) && p.id < 10000 && p.name && !seen.has(p.id) && seen.add(p.id));
  const stats = loadStatsTable(base, entries || [], dataDir);
  const typesOf = id => { try { return (getTypes && getTypes(id)) || []; } catch (e) { return []; } };
  const typeMap = new Map(base.map(m => [m.id, typesOf(m.id)]));
  const typeKey = id => (typeMap.get(id) || []).slice().sort().join('/');
  const hasSprite = id => { try { return fs.existsSync(path.join(spritesDir, `${id}.webp`)); } catch (e) { return false; } };
  const spriteSet = new Set(spritesDir ? base.filter(m => hasSprite(m.id)).map(m => m.id) : []);
  const nameOf = new Map(base.map(m => [m.id, m.name]));
  const bstOf = id => (stats.has(id) ? STAT_KEYS.reduce((s, k) => s + stats.get(id)[k], 0) : null);

  const kindPools = {
    silhouette: base.filter(m => spriteSet.has(m.id)),
    types: base.filter(m => (typeMap.get(m.id) || []).length > 0),
    stats: base.filter(m => stats.has(m.id))
  };
  const availableKinds = KINDS.filter(k => kindPools[k].length >= MIN_POOL);
  const ready = availableKinds.length > 0;
  if (!ready) {
    say.error('[quiz] ⚠ Aucune catégorie de question exploitable (sprites, types ou stats introuvables). Mode désactivé.');
  } else {
    say.log(`[quiz] catégories disponibles : ${availableKinds.map(k => `${k} (${kindPools[k].length})`).join(', ')}`);
    KINDS.filter(k => !availableKinds.includes(k)).forEach(k => say.warn && say.warn(`[quiz] catégorie "${k}" indisponible (données manquantes).`));
  }

  // ---- timers ----
  function clearTimers(game) {
    const t = timers.get(game);
    if (t) Object.values(t).forEach(x => clearTimeout(x));
    timers.delete(game);
  }
  function setTimer(game, name, ms, fn) {
    let t = timers.get(game);
    if (!t) { t = {}; timers.set(game, t); }
    if (t[name]) clearTimeout(t[name]);
    const quiz = game.quiz;
    t[name] = setTimeout(() => {
      delete t[name];
      if (games[game.id] !== game || game.quiz !== quiz || game.status !== 'playing') return; // timer périmé
      try { fn(); } catch (err) { say.error('[quiz] timer', err); }
    }, ms);
  }

  // ---- helpers ----
  const hasMod = (quiz, key) => quiz.cfg.mods.includes(key);
  const toPlayer = (player, event, payload) => { if (player && player.id) io.to(player.id).emit(event, payload); };
  const playerBySid = (game, sid) => game.players.find(p => p.qzSid === sid) || null;

  function ensureConfig(game) {
    if (!game.qzCfg || typeof game.qzCfg !== 'object') game.qzCfg = { kinds: [...availableKinds], rounds: DEFAULT_ROUNDS, mods: [] };
    return game.qzCfg;
  }
  function normalizedConfig(game) {
    const c = ensureConfig(game);
    return {
      kinds: KINDS.filter(k => c.kinds.includes(k) && availableKinds.includes(k)),
      rounds: ROUNDS_OPTIONS.includes(c.rounds) ? c.rounds : DEFAULT_ROUNDS,
      mods: MODIFIER_KEYS.filter(k => c.mods.includes(k))
    };
  }
  const configKey = game => JSON.stringify(normalizedConfig(game));

  function publicPlayers(game) {
    const quiz = game.quiz;
    return game.players.filter(p => p.qzSid).map(p => ({
      sid: p.qzSid, name: p.name, avatar: p.avatar, disconnected: !!p.disconnected,
      answered: !!(quiz && quiz.phase === 'question' && quiz.q && quiz.q.answers.has(p.qzSid))
    }));
  }
  function publicScores(game) {
    const quiz = game.quiz;
    return Object.keys(quiz.scores).map(sid => ({ sid, total: quiz.scores[sid].total, streak: quiz.scores[sid].streak, correct: quiz.scores[sid].correct }));
  }
  const emitPlayers = game => io.to(game.id).emit('quiz_players', { players: publicPlayers(game) });

  // ---- questions ----
  function pickKind(quiz) {
    const kinds = quiz.cfg.kinds;
    if (kinds.length === 1) return kinds[0];
    const choices = kinds.filter(k => k !== quiz.lastKind);
    return choices[randomInt(choices.length)];
  }

  function makeQuestion(quiz, round) {
    const kind = pickKind(quiz);
    quiz.lastKind = kind;
    let candidates = kindPools[kind];
    if (hasMod(quiz, 'kanto')) { const k = candidates.filter(m => m.id <= 151); if (k.length >= MIN_POOL) candidates = k; }
    let answer = sample(candidates, 1, quiz.used)[0] || sample(candidates, 1)[0];
    quiz.used.add(answer.id);
    // Distracteurs : jamais ambigus (types : pas la même combinaison de types que la bonne réponse).
    let wrong = candidates.filter(m => m.id !== answer.id && (kind !== 'types' || typeKey(m.id) !== typeKey(answer.id)));
    const distractors = sample(wrong, OPTIONS_COUNT - 1);
    const options = shuffle([answer, ...distractors]);

    const durationMs = hasMod(quiz, 'blitz') ? TIMING.blitzMs : TIMING.questionMs;
    const q = {
      round, kind, answerId: answer.id,
      optionIds: options.map(m => m.id),
      correctIndex: options.findIndex(m => m.id === answer.id),
      durationMs, startedAt: 0, endsAt: 0, hintAt: null, hintShown: false, hintPayload: null,
      answers: new Map(), clue: null, imageToken: null
    };
    if (kind === 'silhouette') {
      const token = crypto.randomBytes(12).toString('hex');
      images.set(token, { id: answer.id, expiresAt: Date.now() + durationMs + TIMING.countdownMs + TIMING.imageGraceMs });
      quiz.tokens.push(token);
      q.imageToken = token;
      q.clue = { image: `/api/quiz/image/${token}` };
      q.hintPayload = { types: typeMap.get(answer.id) };
    } else if (kind === 'types') {
      q.clue = { types: typeMap.get(answer.id) };
      q.hintPayload = { generation: generationOf(answer.id) };
    } else {
      q.clue = { stats: { ...stats.get(answer.id) }, bst: bstOf(answer.id) };
      q.hintPayload = { types: typeMap.get(answer.id) };
    }
    if (!hasMod(quiz, 'nohint')) q.hintAt = durationMs * 0.5;
    pruneImages();
    return q;
  }

  function pruneImages() {
    const now = Date.now();
    for (const [t, e] of images) if (e.expiresAt < now) images.delete(t);
  }

  function questionPayload(game) {
    const quiz = game.quiz;
    const q = quiz.q;
    const now = Date.now();
    return {
      round: quiz.round, rounds: quiz.cfg.rounds,
      kind: q.kind, icon: KIND_INFO[q.kind].icon, prompt: KIND_INFO[q.kind].prompt,
      clue: q.clue,
      options: q.optionIds.map((id, i) => ({ index: i, label: nameOf.get(id) })),
      durationMs: q.durationMs,
      endsInMs: Math.max(0, q.endsAt - now),
      hintInMs: q.hintAt === null ? null : Math.max(0, q.startedAt + q.hintAt - now),
      hint: q.hintShown ? q.hintPayload : null,
      players: publicPlayers(game)
    };
  }

  // ---- déroulement ----
  function startQuestion(game) {
    const quiz = game.quiz;
    quiz.round += 1;
    quiz.q = makeQuestion(quiz, quiz.round);
    const q = quiz.q;
    q.startedAt = Date.now();
    q.endsAt = q.startedAt + q.durationMs;
    quiz.phase = 'question';
    io.to(game.id).emit('quiz_question', questionPayload(game));
    if (q.hintAt !== null) {
      setTimer(game, 'hint', q.hintAt, () => {
        if (quiz.phase !== 'question' || quiz.q !== q) return;
        q.hintShown = true;
        io.to(game.id).emit('quiz_hint', { round: quiz.round, hint: q.hintPayload });
      });
    }
    setTimer(game, 'end', q.durationMs, () => resolveRound(game));
  }

  function maybeResolve(game) {
    const quiz = game.quiz;
    if (!quiz || quiz.phase !== 'question') return;
    const pending = game.players.filter(p => p.qzSid && quiz.scores[p.qzSid] && !p.disconnected && !quiz.q.answers.has(p.qzSid));
    if (pending.length === 0) resolveRound(game);
  }

  // Points d'une réponse (hors bonus "premier") : calculés à la révélation, jamais avant.
  function pointsFor(quiz, q, ans, streakBefore) {
    if (!ans) return 0;
    if (!ans.correct) return hasMod(quiz, 'penalty') ? -WRONG_PENALTY : 0;
    const fraction = Math.min(1, Math.max(0, (q.durationMs - ans.ms) / q.durationMs));
    let p = BASE_POINTS + Math.round(SPEED_BONUS * fraction);
    if (ans.hinted) p -= HINT_PENALTY;
    if (hasMod(quiz, 'nohint')) p = Math.round(p * NOHINT_MULT);
    if (hasMod(quiz, 'streak')) p = Math.round(p * (1 + STREAK_STEP * Math.min(streakBefore, STREAK_CAP)));
    return Math.max(1, p);
  }

  function resolveRound(game) {
    const quiz = game.quiz;
    if (!quiz || quiz.phase !== 'question') return;
    clearTimers(game);
    quiz.phase = 'reveal';
    const q = quiz.q;

    // La bonne réponse la plus rapide gagne un bonus.
    let firstSid = null;
    let firstMs = Infinity;
    q.answers.forEach((a, sid) => { if (a.correct && a.ms < firstMs) { firstMs = a.ms; firstSid = sid; } });

    const results = Object.keys(quiz.scores).map(sid => {
      const s = quiz.scores[sid];
      const ans = q.answers.get(sid) || null;
      let points = pointsFor(quiz, q, ans, s.streak);
      const first = sid === firstSid;
      if (first) points += FIRST_BONUS;
      s.total = Math.max(0, s.total + points);
      if (ans) { s.answered += 1; s.totalMs += ans.ms; }
      if (ans && ans.correct) { s.correct += 1; s.streak += 1; } else s.streak = 0;
      return { sid, choice: ans ? ans.index : null, correct: !!(ans && ans.correct), ms: ans ? ans.ms : null, points, first };
    });

    const last = quiz.round >= quiz.cfg.rounds;
    quiz.lastReveal = {
      round: quiz.round, kind: q.kind,
      answerId: q.answerId, answerName: nameOf.get(q.answerId), sprite: spriteUrl(q.answerId),
      types: typeMap.get(q.answerId), correctIndex: q.correctIndex,
      results, scores: publicScores(game), revealMs: TIMING.revealMs, last
    };
    io.to(game.id).emit('quiz_reveal', quiz.lastReveal);
    setTimer(game, 'next', TIMING.revealMs, () => (last ? finish(game) : startQuestion(game)));
  }

  function finish(game) {
    const quiz = game.quiz;
    clearTimers(game);
    quiz.phase = 'final';
    game.status = 'finished';
    const rows = Object.keys(quiz.scores).map(sid => {
      const s = quiz.scores[sid];
      const owner = playerBySid(game, sid);
      return {
        sid, name: owner ? owner.name : '—', avatar: owner ? owner.avatar : null,
        total: s.total, correct: s.correct, avgMs: s.answered ? Math.round(s.totalMs / s.answered) : null
      };
    });
    rows.sort((a, b) => b.total - a.total || b.correct - a.correct || (a.avgMs ?? Infinity) - (b.avgMs ?? Infinity));
    let rank = 0;
    rows.forEach((r, i) => {
      const prev = rows[i - 1];
      if (i === 0 || r.total !== prev.total || r.correct !== prev.correct) rank = i + 1;
      r.rank = rank;
    });
    quiz.final = {
      rounds: quiz.cfg.rounds, mods: quiz.cfg.mods, kinds: quiz.cfg.kinds, ranked: quiz.ranked,
      results: rows, winners: rows.filter(r => r.rank === 1).map(r => r.sid)
    };
    io.to(game.id).emit('quiz_final', quiz.final);

    // XP : uniquement parties SANS modificateur et avec les réglages par défaut. Bonus de victoire :
    // seulement s'il y a au moins 2 humains (sinon : un humain contre des bots, trop facile à farmer).
    if (quiz.ranked) {
      const humans = game.players.filter(p => !p.isBot);
      game.players.forEach(p => {
        const won = humans.length >= 2 && quiz.final.winners.includes(p.qzSid);
        awardXp(p, xpParticipation + (won ? xpVictoryBonus : 0));
      });
    }
  }

  async function awardXp(player, amount) {
    if (!supabase || !createAuthClient || !player || !player.accountAccessToken) return;
    try {
      const { data: { user } } = await createAuthClient().auth.getUser(player.accountAccessToken);
      if (!user) return;
      const { data: profile } = await supabase.from('profiles').select('xp').eq('id', user.id).single();
      await supabase.from('profiles').update({ xp: (profile ? (profile.xp || 0) : 0) + amount }).eq('id', user.id);
    } catch (err) {
      say.error('[quiz] échec XP', err.message);
    }
  }

  // ---- API serveur ----
  function validateStart(game) {
    if (!ready) return 'Quiz Pokémon indisponible : données introuvables (voir les logs serveur).';
    if (!game.players.length) return 'Aucun joueur.';
    if (!normalizedConfig(game).kinds.length) return 'Active au moins un type de question.';
    return null;
  }

  function begin(game) {
    const cfg = normalizedConfig(game);
    const quiz = {
      cfg, round: 0, phase: 'countdown', q: null,
      ranked: cfg.mods.length === 0 && cfg.rounds === DEFAULT_ROUNDS,
      scores: {}, used: new Set(), tokens: [], lastKind: null, lastReveal: null, final: null, countdownEndsAt: Date.now() + TIMING.countdownMs
    };
    game.players.forEach((p, i) => {
      p.qzSid = `p${i + 1}`;
      quiz.scores[p.qzSid] = { total: 0, streak: 0, correct: 0, answered: 0, totalMs: 0 };
    });
    game.quiz = quiz;
    game.status = 'playing';
    game.players.forEach(p => {
      toPlayer(p, 'quiz_started', { gameId: game.id, meSid: p.qzSid, hostId: game.hostId, config: { ...cfg, ranked: quiz.ranked }, players: publicPlayers(game) });
    });
    io.to(game.id).emit('quiz_countdown', { ms: TIMING.countdownMs });
    setTimer(game, 'countdown', TIMING.countdownMs, () => startQuestion(game));
  }

  function snapshotFor(game, player) {
    const quiz = game.quiz;
    const mine = quiz.q && quiz.q.answers.get(player.qzSid);
    return {
      gameId: game.id, status: game.status, hostId: game.hostId,
      meSid: player.qzSid, config: { ...quiz.cfg, ranked: quiz.ranked },
      phase: quiz.phase, round: quiz.round, rounds: quiz.cfg.rounds,
      players: publicPlayers(game), scores: publicScores(game),
      countdownMs: quiz.phase === 'countdown' ? Math.max(0, quiz.countdownEndsAt - Date.now()) : 0,
      question: quiz.phase === 'question' ? questionPayload(game) : null,
      myAnswer: quiz.phase === 'question' && mine ? { index: mine.index } : null, // jamais la correction
      lastReveal: quiz.phase === 'reveal' ? quiz.lastReveal : null,
      final: quiz.final
    };
  }

  function resync(game, socket, player) {
    if (!game.quiz || game.status === 'waiting') return;
    socket.emit('quiz_state', snapshotFor(game, player));
  }

  function syncLobby(game, socket) {
    const payload = { config: normalizedConfig(game) };
    if (socket) socket.emit('quiz_config_updated', payload);
    else io.to(game.id).emit('quiz_config_updated', payload);
  }

  function carry(oldGame, newGame) {
    newGame.qzCfg = oldGame.qzCfg ? { kinds: [...oldGame.qzCfg.kinds], rounds: oldGame.qzCfg.rounds, mods: [...oldGame.qzCfg.mods] } : undefined;
  }

  function dispose(game) {
    clearTimers(game);
    if (game.quiz && game.quiz.tokens) game.quiz.tokens.forEach(t => images.delete(t));
    game.quiz = null;
  }

  function broadcastPresence(game) {
    if (!game.quiz || game.status === 'waiting') {
      if (game.status === 'waiting' && broadcastPlayers) broadcastPlayers(game);
      return;
    }
    emitPlayers(game);
    maybeResolve(game);
  }

  function onPlayerRemoved(game, leaving) {
    const quiz = game.quiz;
    if (!quiz || quiz.phase === 'final') return;
    if (leaving.qzSid) delete quiz.scores[leaving.qzSid];
    emitPlayers(game);
    if (quiz.phase === 'question') maybeResolve(game);
  }

  // Coup d'un joueur simulé (cf. matchmaking-bots.js) : il connaît la réponse avec BOT_ACCURACY de chances,
  // sinon il répond au hasard. Joué ensuite via le vrai handler 'quiz_answer'.
  function botMove(game, player) {
    const quiz = game.quiz;
    if (!quiz || game.status !== 'playing' || quiz.phase !== 'question' || !player.qzSid) return null;
    if (!quiz.scores[player.qzSid] || quiz.q.answers.has(player.qzSid)) return null;
    const index = Math.random() < BOT_ACCURACY ? quiz.q.correctIndex : randomInt(OPTIONS_COUNT);
    return {
      key: `qz:${quiz.round}`,
      event: 'quiz_answer',
      payload: { index },
      maxDelayMs: Math.max(2500, quiz.q.durationMs - 2500)
    };
  }

  // ---- sockets ----
  function attach(socket) {
    const ctx = () => {
      const game = games[socket.data.gameId];
      if (!game || game.gameMode !== 'quiz') return {};
      const player = game.players.find(p => p.id === socket.id);
      return { game, player };
    };

    socket.on('quiz_set_config', ({ kinds, rounds, modifiers } = {}) => {
      const { game } = ctx();
      if (!game) return;
      if (game.hostId !== socket.id) { socket.emit('error_message', "Seul l'hôte peut régler le quiz."); return; }
      if (game.status !== 'waiting') { socket.emit('error_message', 'Les réglages ne peuvent plus être modifiés.'); return; }
      const okKinds = Array.isArray(kinds) && kinds.length > 0 && kinds.every(k => typeof k === 'string' && availableKinds.includes(k));
      const okMods = Array.isArray(modifiers) && modifiers.length <= MODIFIER_KEYS.length && modifiers.every(k => typeof k === 'string' && MODIFIER_KEYS.includes(k));
      if (!okKinds || !ROUNDS_OPTIONS.includes(rounds) || !okMods) { socket.emit('error_message', 'Réglages du quiz invalides.'); return; }
      game.qzCfg = { kinds: KINDS.filter(k => kinds.includes(k)), rounds, mods: MODIFIER_KEYS.filter(k => modifiers.includes(k)) };
      syncLobby(game);
    });

    socket.on('quiz_answer', ({ index } = {}) => {
      const { game, player } = ctx();
      if (!game || !player || !game.quiz || game.status !== 'playing') return;
      const quiz = game.quiz;
      if (quiz.phase !== 'question' || !player.qzSid || !quiz.scores[player.qzSid]) return;
      if (!Number.isInteger(index) || index < 0 || index >= OPTIONS_COUNT) return;
      const q = quiz.q;
      if (q.answers.has(player.qzSid)) return; // une seule tentative
      const now = Date.now();
      if (now > q.endsAt) return;
      q.answers.set(player.qzSid, { index, ms: now - q.startedAt, correct: index === q.correctIndex, hinted: q.hintShown });
      toPlayer(player, 'quiz_answer_ok', { index }); // accusé SANS la correction : elle n'arrive qu'à la révélation
      emitPlayers(game);
      maybeResolve(game);
    });
  }
  io.on('connection', attach);

  // ---- routes ----
  if (app) {
    app.get('/api/quiz/config', (req, res) => {
      res.set('Cache-Control', 'no-store');
      res.json({
        ready, kinds: availableKinds.map(k => ({ key: k, ...KIND_INFO[k] })), rounds: ROUNDS_OPTIONS, defaultRounds: DEFAULT_ROUNDS,
        modifiers: MODIFIERS
      });
    });
    // Image de silhouette : adresse opaque, valable le temps de la question (jamais l'id dans l'URL).
    app.get('/api/quiz/image/:token', (req, res) => {
      const entry = images.get(String(req.params.token));
      if (!entry || entry.expiresAt < Date.now() || !spritesDir) { res.status(404).end(); return; }
      res.set('Cache-Control', 'no-store');
      res.type('image/webp');
      res.sendFile(path.join(spritesDir, `${entry.id}.webp`), err => { if (err && !res.headersSent) res.status(404).end(); });
    });
  }

  return {
    ready, availableKinds, validateStart, begin, resync, syncLobby, carry, dispose, broadcastPresence, onPlayerRemoved, botMove, configKey,
    _internals: { TIMING, images, generationOf, pointsFor, BASE_POINTS, SPEED_BONUS, FIRST_BONUS, HINT_PENALTY, WRONG_PENALTY, NOHINT_MULT }
  };
}

module.exports = { createQuiz, MODIFIERS, KINDS, ROUNDS_OPTIONS };
