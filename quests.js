'use strict';
/* QUÊTES JOURNALIÈRES — 3 quêtes par jour (Europe/Paris), les mêmes pour tout le monde.
 *
 * - Choix déterministe : graine = jour → 1 quête "volume", 1 "performance", 1 "chance".
 * - Progression CALCULÉE à la demande depuis game_history (parties classées du jour) et
 *   daily_scores (défi quotidien) : aucune table de compteurs, donc rien qui puisse diverger.
 * - Récompense XP réclamée à la main (POST /api/quests/claim) ; table `daily_quest_claims`
 *   (clé primaire user_id+day+quest_key) = anti-doublon atomique, même avec plusieurs instances.
 * - Bonus « 3 quêtes » : +BONUS_XP quand les 3 quêtes du jour sont terminées.
 * - Parties à modificateurs (hors-classement) : absentes de game_history, donc ne comptent pas.
 */

const BONUS_KEY = 'bonus_all';
const BONUS_XP = 30;
const HISTORY_WINDOW_MS = 36 * 3600 * 1000; // couvre largement un jour Paris (DST compris)

const RARITY_ORDER = ['commun', 'peu_commun', 'rare', 'epique', 'pseudo_legendaire', 'mega', 'legendaire', 'fabuleux', 'ultra_chimere'];
const rank = r => RARITY_ORDER.indexOf(r);
const isRareUp = m => m && rank(m.rarity) >= rank('rare');
const isLegendUp = m => m && rank(m.rarity) >= rank('legendaire');
const teamOf = row => (Array.isArray(row.team) ? row.team : []);

// progress(rows, ctx) → nombre (plafonné à `target` par l'appelant).
const QUESTS = [
  // --- volume ---
  { key: 'play_2', cat: 'volume', title: 'Termine 2 parties', target: 2, xp: 15, progress: rows => rows.length },
  { key: 'play_3', cat: 'volume', title: 'Termine 3 parties', target: 3, xp: 25, progress: rows => rows.length },
  { key: 'win_1', cat: 'volume', title: 'Remporte 1 victoire', target: 1, xp: 20, progress: rows => rows.filter(r => r.result === 'victory').length },
  { key: 'win_2', cat: 'volume', title: 'Remporte 2 victoires', target: 2, xp: 35, progress: rows => rows.filter(r => r.result === 'victory').length },
  // --- performance ---
  { key: 'score_3000', cat: 'perf', title: 'Atteins 3 000 pts dans une partie', target: 3000, xp: 25, progress: rows => Math.max(0, ...rows.map(r => r.score || 0)) },
  { key: 'score_4000', cat: 'perf', title: 'Atteins 4 000 pts dans une partie', target: 4000, xp: 40, progress: rows => Math.max(0, ...rows.map(r => r.score || 0)) },
  { key: 'hard_win', cat: 'perf', title: 'Bats un boss difficile ou extrême', target: 1, xp: 45, progress: rows => rows.filter(r => r.result === 'victory' && (r.difficulty === 'hard' || r.difficulty === 'extreme')).length },
  { key: 'daily_play', cat: 'perf', title: 'Termine le défi quotidien', target: 1, xp: 20, progress: (rows, ctx) => (ctx.dailyFinished ? 1 : 0) },
  // --- chance ---
  { key: 'shiny_1', cat: 'luck', title: 'Obtiens un Pokémon chromatique', target: 1, xp: 40, progress: rows => rows.reduce((n, r) => n + teamOf(r).filter(m => m && m.shiny).length, 0) },
  { key: 'rare_3', cat: 'luck', title: 'Réunis 3 Pokémon rares ou mieux dans une équipe', target: 3, xp: 30, progress: rows => Math.max(0, ...rows.map(r => teamOf(r).filter(isRareUp).length)) },
  { key: 'mega_1', cat: 'luck', title: 'Obtiens une Méga-Évolution', target: 1, xp: 35, progress: rows => rows.reduce((n, r) => n + teamOf(r).filter(m => m && m.rarity === 'mega').length, 0) },
  { key: 'legend_1', cat: 'luck', title: 'Obtiens un Pokémon légendaire ou mieux', target: 1, xp: 40, progress: rows => rows.reduce((n, r) => n + teamOf(r).filter(isLegendUp).length, 0) }
];
const CATS = ['volume', 'perf', 'luck'];
const BY_KEY = Object.fromEntries(QUESTS.map(q => [q.key, q]));

// ---------- Utilitaires ----------
function hashStr(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
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
function questsForDay(day) {
  const rnd = mulberry32(hashStr('rdb-quests:' + day));
  return CATS.map(cat => {
    const pool = QUESTS.filter(q => q.cat === cat);
    return pool[Math.floor(rnd() * pool.length)];
  });
}

const timeFmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
function msUntilParisMidnight(now = new Date()) {
  const [h, m, s] = timeFmt.format(now).split(':').map(Number);
  return Math.max(1000, (86400 - (h * 3600 + m * 60 + s)) * 1000);
}

function registerQuests({ app, supabase, createAuthClient, dayKey }) {
  const enabled = !!(supabase && createAuthClient && typeof dayKey === 'function');
  if (!enabled) console.warn('[quêtes] Supabase indisponible : quêtes en lecture seule (invités).');

  async function authUser(accessToken) {
    if (!accessToken || !createAuthClient) return null;
    try {
      const { data: { user } } = await createAuthClient().auth.getUser(accessToken);
      return user || null;
    } catch (e) { return null; }
  }

  // Parties classées du jour Paris + défi quotidien terminé + récompenses déjà réclamées.
  async function loadState(userId, day) {
    const since = new Date(Date.now() - HISTORY_WINDOW_MS).toISOString();
    const [hist, daily, claims] = await Promise.all([
      supabase.from('game_history').select('result, score, difficulty, team, created_at').eq('user_id', userId).gte('created_at', since),
      supabase.from('daily_scores').select('day').eq('user_id', userId).eq('day', day).eq('finished', true).limit(1),
      supabase.from('daily_quest_claims').select('quest_key').eq('user_id', userId).eq('day', day)
    ]);
    if (hist.error) throw hist.error;
    if (daily.error) throw daily.error;
    if (claims.error) throw claims.error;
    const rows = (hist.data || []).filter(r => dayKey(new Date(r.created_at)) === day);
    return {
      rows,
      ctx: { dailyFinished: !!(daily.data && daily.data.length) },
      claimed: new Set((claims.data || []).map(c => c.quest_key))
    };
  }

  function buildView(day, state) {
    const list = questsForDay(day).map(q => {
      const raw = state ? q.progress(state.rows, state.ctx) : 0;
      const progress = Math.min(q.target, Math.max(0, raw));
      return {
        key: q.key, title: q.title, target: q.target, xp: q.xp,
        progress, done: progress >= q.target,
        claimed: !!(state && state.claimed.has(q.key))
      };
    });
    const allDone = list.every(q => q.done);
    return {
      day, msUntilReset: msUntilParisMidnight(),
      quests: list,
      bonus: { key: BONUS_KEY, title: 'Les 3 quêtes du jour', xp: BONUS_XP, done: allDone, claimed: !!(state && state.claimed.has(BONUS_KEY)) }
    };
  }

  app.post('/api/quests', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const day = dayKey();
    try {
      const user = enabled ? await authUser((req.body || {}).accessToken) : null;
      if (!user) { res.json({ ...buildView(day, null), guest: true }); return; }
      res.json({ ...buildView(day, await loadState(user.id, day)), guest: false });
    } catch (err) {
      console.error('[quêtes] lecture :', err && (err.message || err.code));
      res.json({ ...buildView(day, null), guest: true, unavailable: true });
    }
  });

  app.post('/api/quests/claim', async (req, res) => {
    if (!enabled) { res.status(503).json({ error: 'Quêtes indisponibles.' }); return; }
    const day = dayKey();
    try {
      const { accessToken, questKey } = req.body || {};
      const user = await authUser(accessToken);
      if (!user) { res.status(401).json({ error: 'Connexion requise.' }); return; }
      if (typeof questKey !== 'string') { res.status(400).json({ error: 'Quête invalide.' }); return; }

      const view = buildView(day, await loadState(user.id, day));
      const target = questKey === BONUS_KEY ? view.bonus : view.quests.find(q => q.key === questKey);
      if (!target) { res.status(400).json({ error: "Cette quête n'est pas active aujourd'hui." }); return; }
      if (!target.done) { res.status(409).json({ error: 'Quête non terminée.' }); return; }
      if (target.claimed) { res.status(409).json({ error: 'Récompense déjà réclamée.' }); return; }
      if (questKey === BONUS_KEY && !view.quests.every(q => q.claimed || q.done)) { res.status(409).json({ error: 'Quêtes non terminées.' }); return; }

      // Réservation atomique : la clé primaire refuse un second claim (double clic, 2 onglets...).
      const { error: insErr } = await supabase.from('daily_quest_claims')
        .insert({ user_id: user.id, day, quest_key: questKey, xp: target.xp });
      if (insErr) {
        if (insErr.code === '23505') { res.status(409).json({ error: 'Récompense déjà réclamée.' }); return; }
        throw insErr;
      }
      const { data: profile } = await supabase.from('profiles').select('xp').eq('id', user.id).single();
      const newXp = (profile ? (profile.xp || 0) : 0) + target.xp;
      const { error: xpErr } = await supabase.from('profiles').update({ xp: newXp }).eq('id', user.id);
      if (xpErr) {
        // XP non créditée : on libère la réservation pour permettre un nouvel essai.
        await supabase.from('daily_quest_claims').delete().eq('user_id', user.id).eq('day', day).eq('quest_key', questKey);
        throw xpErr;
      }
      res.json({ ok: true, xp: target.xp, totalXp: newXp });
    } catch (err) {
      console.error('[quêtes] réclamation :', err && (err.message || err.code));
      res.status(500).json({ error: 'Réclamation impossible.' });
    }
  });

  return { questsForDay, QUESTS };
}

module.exports = { registerQuests, questsForDay, QUESTS, _test: { BY_KEY, msUntilParisMidnight } };
