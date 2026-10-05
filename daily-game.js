'use strict';
/* DÉFI QUOTIDIEN — Route du Boss
 *
 * Module autonome (aucune partie/lobby) : même boss + mêmes 6 tours (2 options chacun) pour
 * tous les joueurs, générés UNE fois par jour (fuseau Europe/Paris) avec un RNG à graine.
 * Solo, sans objet de départ, sans événement rare, sans pity, sans bonus de type :
 * score = somme des points des Pokémon choisis, victoire si score >= objectif du boss.
 *
 * - COMPTE OBLIGATOIRE : 1 seul essai par jour et par compte (table Supabase `daily_scores`,
 *   cf. daily.sql). Victoire OU défaite, tout essai terminé entre au classement du jour.
 * - Invité, ou table indisponible : défi refusé (jamais d'essai non classé rejouable).
 * - Chaque choix est persisté (colonne `choices`) : un redémarrage serveur ne perd rien,
 *   l'essai reprend exactement au même tour.
 * - Un essai dont le socket se coupe reste reprenable RESUME_GRACE_MS ; passé ce délai
 *   (ou "Abandonner"), il est clos avec le score atteint et classé (anti-contournement).
 * - Le client ne reçoit JAMAIS les points avant d'avoir choisi (comme turn_options).
 *
 * Branchement : registerDaily({ io, app, supabase, createAuthClient, deps }) — voir server.js.
 */

const MAX_TURNS = 6;
const TZ = 'Europe/Paris';
const RESUME_GRACE_MS = 90000;
const STORE_RETRY_MS = 60000;
const BOARD_SIZE = 50;
const BOARD_FETCH_LIMIT = 5000;
const GEN_ATTEMPTS = 200;
// Difficulté par jour de semaine (0 = dimanche). "extreme" exclu : injouable sans objets/bonus.
const GROUP_BY_WEEKDAY = ['easy', 'medium', 'medium', 'hard', 'medium', 'hard', 'hard'];

// ---------- Date (Paris) ----------
const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const timeFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });

function dayKey(date = new Date()) {
  return dayFmt.format(date); // YYYY-MM-DD
}

function msUntilReset(date = new Date()) {
  const [h, m, s] = timeFmt.format(date).split(':').map(Number);
  return Math.max(1000, 86400000 - ((h * 60 + m) * 60 + s) * 1000);
}

// ---------- RNG à graine ----------
function hashSeed(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Remplace Math.random le temps d'un appel SYNCHRONE (aucun autre code ne peut s'intercaler).
function withSeededRandom(seed, fn) {
  const original = Math.random;
  Math.random = mulberry32(seed);
  try { return fn(); } finally { Math.random = original; }
}

function registerDaily({ io, app, supabase, createAuthClient, deps }) {
  const { pickRandomBoss, pickPlayerTurnOptions, xpParticipation = 10, xpVictoryBonus = 20 } = deps;

  const dailyCache = new Map(); // day -> { boss, turns, maxScore, minScore }
  const runs = new Map();        // socket.id -> run
  const runsByUser = new Map();  // userId -> run (essai classé en cours)
  let storeDisabledUntil = 0;

  // ---------- Génération du jour ----------
  function buildDaily(day) {
    if (dailyCache.has(day)) return dailyCache.get(day);
    const weekday = new Date(day + 'T12:00:00Z').getUTCDay();
    const group = GROUP_BY_WEEKDAY[weekday];

    let chosen = null;
    let fallback = null;
    for (let attempt = 0; attempt < GEN_ATTEMPTS && !chosen; attempt++) {
      const cand = withSeededRandom(hashSeed(`rdb-daily-v1|${day}|${attempt}`), () => {
        const boss = { ...pickRandomBoss(group) };
        const turns = Array.from({ length: MAX_TURNS }, () => pickPlayerTurnOptions(false, 0, undefined, undefined, 'normal'));
        return { boss, turns };
      });
      cand.maxScore = cand.turns.reduce((s, t) => s + Math.max(t.haut.finalPoints, t.bas.finalPoints), 0);
      cand.minScore = cand.turns.reduce((s, t) => s + Math.min(t.haut.finalPoints, t.bas.finalPoints), 0);
      // Journée valable : victoire atteignable (marge 5 %) ET non garantie (le pire chemin perd).
      if (cand.maxScore >= cand.boss.requiredPoints * 1.05 && cand.minScore < cand.boss.requiredPoints) chosen = cand;
      else if (!fallback || cand.maxScore > fallback.maxScore) fallback = cand;
    }
    const daily = chosen || fallback;
    daily.group = group;

    dailyCache.set(day, daily);
    for (const k of dailyCache.keys()) if (k < day && dailyCache.size > 3) dailyCache.delete(k);
    return daily;
  }

  const publicBoss = (daily) => ({
    id: daily.boss.id, name: daily.boss.name, sprite: daily.boss.sprite,
    requiredPoints: daily.boss.requiredPoints, group: daily.group
  });
  const publicSide = (r) => ({ name: r.name, sprite: r.sprite, shiny: r.shiny, shinySprite: r.shinySprite });
  const publicOptions = (daily, turn) => {
    const t = daily.turns[turn - 1];
    return { haut: publicSide(t.haut), bas: publicSide(t.bas) };
  };
  const teamMon = (r) => ({
    name: r.name, sprite: r.sprite, shiny: !!r.shiny, shinySprite: r.shinySprite || null,
    rarity: r.rarity, points: r.finalPoints
  });

  // ---------- Stockage Supabase (dégradation gracieuse) ----------
  const storeUsable = () => !!supabase && Date.now() >= storeDisabledUntil;
  function noteStoreError(err) {
    console.error('[daily] stockage indisponible :', err && err.message);
    if (err && (err.code === '42P01' || /daily_scores/.test(err.message || ''))) {
      console.error('[daily] table daily_scores absente : exécuter daily.sql dans Supabase.');
    }
    storeDisabledUntil = Date.now() + STORE_RETRY_MS;
  }

  async function authUser(accessToken) {
    if (!accessToken || !createAuthClient) return null;
    try {
      const { data: { user } } = await createAuthClient().auth.getUser(accessToken);
      return user || null;
    } catch (e) { return null; }
  }

  async function getRow(day, userId) {
    const { data, error } = await supabase.from('daily_scores').select('*').eq('day', day).eq('user_id', userId).limit(1);
    if (error) throw error;
    return data && data[0] ? data[0] : null;
  }

  async function fetchBoardRows(day) {
    const { data, error } = await supabase.from('daily_scores')
      .select('user_id, score, duration_ms, victory')
      .eq('day', day).eq('finished', true)
      .order('score', { ascending: false }).order('duration_ms', { ascending: true })
      .limit(BOARD_FETCH_LIMIT);
    if (error) throw error;
    return data || [];
  }

  async function computeRank(day, userId) {
    const rows = await fetchBoardRows(day);
    const idx = rows.findIndex(r => r.user_id === userId);
    return { rank: idx >= 0 ? idx + 1 : null, total: rows.length };
  }

  async function grantXp(userId, amount) {
    const { data } = await supabase.from('profiles').select('xp').eq('id', userId).limit(1);
    const current = data && data[0] ? (data[0].xp || 0) : 0;
    await supabase.from('profiles').update({ xp: current + amount }).eq('id', userId);
  }

  // ---------- Essai ----------
  function buildFinal(run, extra) {
    const required = run.daily.boss.requiredPoints;
    return {
      day: run.day,
      score: run.score,
      required,
      victory: run.score >= required,
      team: run.team,
      choices: run.choices.slice(),
      bestPossible: run.daily.maxScore,
      ranked: run.ranked,
      guest: !run.userId,
      rank: null, total: null, xpGained: 0,
      ...extra
    };
  }

  function stateFor(run) {
    const base = {
      phase: run.phase,
      day: run.day,
      boss: publicBoss(run.daily),
      maxTurns: MAX_TURNS,
      turn: run.turn,
      score: run.score,
      team: run.team,
      ranked: run.ranked,
      guest: !run.userId
    };
    if (run.phase === 'choice') base.options = publicOptions(run.daily, run.turn);
    if (run.phase === 'reveal') base.lastResult = { ...run.lastResult, last: run.turn >= MAX_TURNS };
    if (run.phase === 'finished') base.final = run.final;
    return base;
  }

  async function finishRun(run, reason, silent) {
    if (run.finished || run.finishing) return;
    run.finishing = true;
    clearTimeout(run.graceTimer);

    const durationMs = Date.now() - run.startedAt;
    const extra = {};
    if (run.ranked && run.userId) {
      const victory = run.score >= run.daily.boss.requiredPoints;
      try {
        const { error } = await supabase.from('daily_scores').update({
          score: run.score, duration_ms: durationMs, victory, team: run.team, finished: true
        }).eq('day', run.day).eq('user_id', run.userId);
        if (error) throw error;
        if (reason === 'completed') {
          extra.xpGained = xpParticipation + (victory ? xpVictoryBonus : 0);
          try { await grantXp(run.userId, extra.xpGained); } catch (e) { extra.xpGained = 0; }
        }
        const r = await computeRank(run.day, run.userId);
        extra.rank = r.rank; extra.total = r.total;
      } catch (err) {
        noteStoreError(err);
      }
    }

    run.final = buildFinal(run, extra);
    run.phase = 'finished';
    run.finished = true;
    if (run.socketId) runs.delete(run.socketId);
    if (run.userId && runsByUser.get(run.userId) === run) runsByUser.delete(run.userId);
    if (!silent && run.socketId) io.to(run.socketId).emit('daily_finished', run.final);
  }

  function buildRun(day, daily, userId, socketId, choices) {
    const run = {
      day, daily, userId, ranked: true, socketId,
      turn: 1, score: 0, team: [], choices: [], phase: 'choice', lastResult: null,
      startedAt: Date.now(), finished: false, finishing: false, graceTimer: null
    };
    for (const c of choices) {
      const r = daily.turns[run.choices.length][c === 'HAUT' ? 'haut' : 'bas'];
      run.score += r.finalPoints;
      run.team.push(teamMon(r));
      run.choices.push(c);
    }
    run.turn = Math.min(run.choices.length + 1, MAX_TURNS);
    return run;
  }

  function emitPlayed(socket, day, daily, row, rank) {
    socket.emit('daily_state', {
      phase: 'finished', day, boss: publicBoss(daily), maxTurns: MAX_TURNS, turn: MAX_TURNS,
      score: row.score || 0, team: row.team || [], ranked: true, guest: false, played: true,
      final: {
        day, score: row.score || 0, required: daily.boss.requiredPoints, victory: !!row.victory,
        team: row.team || [], choices: Array.isArray(row.choices) ? row.choices : [],
        bestPossible: daily.maxScore, ranked: true, guest: false,
        rank: rank.rank, total: rank.total, xpGained: 0
      }
    });
  }

  async function handleStart(socket, accessToken) {
    const day = dayKey();
    const daily = buildDaily(day);
    const user = await authUser(accessToken);

    if (!user) {
      socket.emit('daily_error', 'Connecte-toi pour jouer au défi quotidien (1 essai par compte).');
      return;
    }

    // Reprise d'un essai encore en mémoire (coupure réseau, onglet rechargé).
    const live = runsByUser.get(user.id);
    if (live && live.day === day && !live.finished && !live.finishing) {
      clearTimeout(live.graceTimer);
      if (live.socketId && live.socketId !== socket.id) runs.delete(live.socketId);
      live.socketId = socket.id;
      runs.set(socket.id, live);
      socket.emit('daily_state', stateFor(live));
      return;
    }
    runs.delete(socket.id);

    if (!storeUsable()) {
      socket.emit('daily_error', 'Défi indisponible pour le moment.');
      return;
    }

    let row = await getRow(day, user.id);
    if (row && row.finished) {
      emitPlayed(socket, day, daily, row, await computeRank(day, user.id));
      return;
    }
    if (!row) {
      // ignoreDuplicates : deux démarrages simultanés ne peuvent pas réinitialiser un essai.
      const { error } = await supabase.from('daily_scores').upsert({
        day, user_id: user.id, score: null, duration_ms: null, victory: null, team: null,
        choices: [], finished: false, started_at: new Date().toISOString()
      }, { onConflict: 'day,user_id', ignoreDuplicates: true });
      if (error) throw error;
      row = await getRow(day, user.id);
      if (row && row.finished) {
        emitPlayed(socket, day, daily, row, await computeRank(day, user.id));
        return;
      }
    }

    // Essai interrompu (redémarrage serveur) : on rejoue les choix déjà persistés.
    const saved = Array.isArray(row && row.choices)
      ? row.choices.filter(c => c === 'HAUT' || c === 'BAS').slice(0, MAX_TURNS) : [];
    const run = buildRun(day, daily, user.id, socket.id, saved);
    runs.set(socket.id, run);
    runsByUser.set(user.id, run);

    if (saved.length >= MAX_TURNS) {
      await finishRun(run, 'completed', true);
      emitPlayed(socket, day, daily, { score: run.final.score, team: run.final.team, victory: run.final.victory, choices: run.final.choices }, { rank: run.final.rank, total: run.final.total });
      return;
    }
    socket.emit('daily_state', stateFor(run));
  }

  io.on('connection', (socket) => {
    socket.on('daily_start', async ({ accessToken } = {}) => {
      try { await handleStart(socket, accessToken); }
      catch (err) {
        if (supabase) noteStoreError(err);
        socket.emit('daily_error', 'Défi indisponible, réessaie.');
      }
    });

    socket.on('daily_choice', ({ choice } = {}) => {
      const run = runs.get(socket.id);
      if (!run || run.phase !== 'choice') return;
      if (choice !== 'HAUT' && choice !== 'BAS') return;
      const reward = run.daily.turns[run.turn - 1][choice === 'HAUT' ? 'haut' : 'bas'];
      run.score += reward.finalPoints;
      run.team.push(teamMon(reward));
      run.choices.push(choice);
      run.phase = 'reveal';
      run.lastResult = {
        turn: run.turn,
        choice,
        pokemon: { name: reward.name, sprite: reward.sprite, shiny: !!reward.shiny, shinySprite: reward.shinySprite || null },
        rarity: reward.rarity,
        basePoints: reward.basePoints,
        effect: { name: reward.effectName, multiplier: reward.multiplier },
        pointsGained: reward.finalPoints,
        score: run.score
      };
      socket.emit('daily_result', { ...run.lastResult, last: run.turn >= MAX_TURNS });
      if (run.ranked && run.userId && supabase) {
        supabase.from('daily_scores')
          .update({ choices: run.choices, score: run.score, team: run.team })
          .eq('day', run.day).eq('user_id', run.userId)
          .then(({ error }) => { if (error) noteStoreError(error); }, noteStoreError);
      }
    });

    socket.on('daily_next', async () => {
      const run = runs.get(socket.id);
      if (!run || run.phase !== 'reveal') return;
      if (run.turn >= MAX_TURNS) {
        run.phase = 'finishing'; // verrou synchrone : un double clic ne clôt pas deux fois
        await finishRun(run, 'completed', false);
        return;
      }
      run.turn += 1;
      run.phase = 'choice';
      socket.emit('daily_turn', { turn: run.turn, score: run.score, options: publicOptions(run.daily, run.turn) });
    });

    // "Abandonner" : clôt l'essai avec le score actuel (classé) ou le jette (invité).
    socket.on('daily_quit', async () => {
      const run = runs.get(socket.id);
      if (!run) return;
      if (run.ranked) await finishRun(run, 'abandon', true);
      else runs.delete(socket.id);
    });

    socket.on('disconnect', () => {
      const run = runs.get(socket.id);
      if (!run || run.finished) return;
      runs.delete(socket.id);
      if (!run.ranked || !run.userId) return; // invité : rien à conserver
      run.socketId = null;
      clearTimeout(run.graceTimer);
      run.graceTimer = setTimeout(() => finishRun(run, 'abandon', true), RESUME_GRACE_MS);
    });
  });

  // ---------- HTTP ----------
  app.post('/api/daily/info', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const day = dayKey();
      const daily = buildDaily(day);
      const out = {
        day, boss: publicBoss(daily), maxTurns: MAX_TURNS, msUntilReset: msUntilReset(),
        rankingAvailable: storeUsable(), participants: null, mine: null
      };
      if (storeUsable()) {
        try {
          const { count, error } = await supabase.from('daily_scores')
            .select('user_id', { count: 'exact', head: true }).eq('day', day).eq('finished', true);
          if (error) throw error;
          out.participants = count || 0;
          const user = await authUser((req.body || {}).accessToken);
          if (user) {
            const row = await getRow(day, user.id);
            if (row) {
              out.mine = { started: true, finished: !!row.finished, score: row.score, victory: row.victory };
              if (row.finished) out.mine.rank = (await computeRank(day, user.id)).rank;
            }
          }
        } catch (err) { noteStoreError(err); out.rankingAvailable = false; }
      }
      res.json(out);
    } catch (err) {
      console.error('[daily] info', err && err.message);
      res.status(500).json({ error: 'Défi indisponible.' });
    }
  });

  app.post('/api/daily/leaderboard', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const day = dayKey();
    if (!storeUsable()) { res.json({ day, available: false, leaderboard: [], total: 0, me: null }); return; }
    try {
      const user = await authUser((req.body || {}).accessToken);
      const rows = await fetchBoardRows(day);
      const top = rows.slice(0, BOARD_SIZE);
      const ids = top.map(r => r.user_id);
      const profiles = {};
      if (ids.length) {
        const { data, error } = await supabase.from('profiles').select('id, pseudo, avatar').in('id', ids);
        if (error) throw error;
        (data || []).forEach(p => { profiles[p.id] = p; });
      }
      const leaderboard = top.map((r, i) => ({
        rank: i + 1,
        pseudo: (profiles[r.user_id] && profiles[r.user_id].pseudo) || 'Dresseur',
        avatar: (profiles[r.user_id] && profiles[r.user_id].avatar) || null,
        score: r.score || 0,
        victory: !!r.victory,
        durationMs: r.duration_ms,
        isSelf: !!user && r.user_id === user.id
      }));
      let me = null;
      if (user) {
        const idx = rows.findIndex(r => r.user_id === user.id);
        if (idx >= 0) me = { rank: idx + 1, score: rows[idx].score || 0, victory: !!rows[idx].victory };
      }
      res.json({ day, available: true, leaderboard, total: rows.length, me });
    } catch (err) {
      noteStoreError(err);
      res.json({ day, available: false, leaderboard: [], total: 0, me: null });
    }
  });

  return { buildDaily, dayKey };
}

module.exports = { registerDaily, _test: { hashSeed, mulberry32, withSeededRandom, dayKey, msUntilReset, MAX_TURNS } };
