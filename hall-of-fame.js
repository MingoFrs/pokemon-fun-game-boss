'use strict';
/* HALL OF FAME — meilleures équipes du jour (lecture seule).
 *
 * - Source : game_history (parties CLASSÉES uniquement : les parties à modificateurs n'y sont jamais
 *   écrites ; Miroir, classé mais « modificateur », est en plus exclu via la colonne `modifiers`).
 * - Mode normal (Route du Boss) seulement : seul mode où des équipes sont comparables par score.
 * - 1 entrée par joueur (son meilleur score du jour), top 10.
 * - Jour = jour Europe/Paris (même dayKey que le défi quotidien) ; « aujourd'hui » ou « hier ».
 * - Données publiques minimales : pseudo, avatar, titre, score, difficulté, équipe. Aucun identifiant interne.
 * - Cache mémoire 60 s par jour demandé (route publique, requête Supabase peu coûteuse mais fréquente).
 */

const TOP_N = 10;
const FETCH_LIMIT = 400;
const WINDOW_MS = 72 * 3600 * 1000; // couvre « hier » et « aujourd'hui » quel que soit le fuseau / DST
const CACHE_MS = 60 * 1000;

const cache = new Map(); // day -> { at, payload }

function publicMon(m) {
  return {
    id: m.id,
    name: String(m.name || '?').slice(0, 40),
    sprite: m.sprite || null,
    shiny: !!m.shiny,
    shinySprite: m.shinySprite || null,
    rarity: m.rarity || null,
    effectName: m.effectName || null
  };
}

function registerHallOfFame({ app, supabase, dayKey, titleLabelFor }) {
  const enabled = !!(supabase && typeof dayKey === 'function');
  if (!enabled) console.warn('[hall of fame] Supabase indisponible : désactivé.');

  const dayOffset = (day, n) => {
    const d = new Date(day + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };

  async function build(day) {
    const hit = cache.get(day);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.payload;

    const since = new Date(Date.now() - WINDOW_MS).toISOString();
    const { data, error } = await supabase.from('game_history')
      .select('user_id, score, difficulty, opponent_name, result, team, modifiers, created_at')
      .eq('game_mode', 'normal')
      .gte('created_at', since)
      .not('team', 'is', null)
      .order('score', { ascending: false })
      .limit(FETCH_LIMIT);
    if (error) throw error;

    const best = new Map(); // user_id -> meilleure ligne du jour
    (data || []).forEach(r => {
      if (!Array.isArray(r.team) || !r.team.length) return;
      if (Array.isArray(r.modifiers) && r.modifiers.length) return; // sans modificateur (Miroir inclus)
      if (typeof r.score !== 'number') return;
      if (dayKey(new Date(r.created_at)) !== day) return;
      if (!best.has(r.user_id)) best.set(r.user_id, r); // trié par score décroissant : la 1re est la meilleure
    });
    const rows = Array.from(best.values()).slice(0, TOP_N);

    let profiles = new Map();
    if (rows.length) {
      const { data: profs, error: pErr } = await supabase.from('profiles')
        .select('id, pseudo, avatar, title').in('id', rows.map(r => r.user_id));
      if (pErr) throw pErr;
      profiles = new Map((profs || []).map(p => [p.id, p]));
    }

    const entries = rows.map((r, i) => {
      const p = profiles.get(r.user_id) || {};
      return {
        rank: i + 1,
        pseudo: String(p.pseudo || 'Joueur').slice(0, 24),
        avatar: p.avatar || null,
        titleLabel: titleLabelFor ? titleLabelFor(p.title) : '',
        score: r.score,
        difficulty: r.difficulty || null,
        boss: r.opponent_name || null,
        victory: r.result === 'victory',
        team: r.team.slice(0, 6).map(publicMon)
      };
    });

    const payload = { day, entries };
    cache.set(day, { at: Date.now(), payload });
    if (cache.size > 6) cache.delete(cache.keys().next().value);
    return payload;
  }

  const handler = async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!enabled) { res.json({ day: dayKey(), entries: [], unavailable: true }); return; }
    const scope = String((req.body && req.body.scope) || req.query.scope || 'today');
    const today = dayKey();
    const day = scope === 'yesterday' ? dayOffset(today, -1) : today;
    try {
      res.json({ ...(await build(day)), scope: scope === 'yesterday' ? 'yesterday' : 'today' });
    } catch (err) {
      console.error('[hall of fame] lecture :', err && (err.message || err.code));
      res.json({ day, entries: [], unavailable: true, scope });
    }
  };
  app.get('/api/hall-of-fame', handler);
  app.post('/api/hall-of-fame', handler);

  return { build };
}

module.exports = { registerHallOfFame };
