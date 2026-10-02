'use strict';
// =====================================================================
// XP + historique d'une partie contre la Mouche, avec PLAFOND glissant sur 24 h (XP_CAP_PER_24H).
// Remplace recordGameResult pour le mode 'fly' (pas de succès : cf. buildAchievementContext qui ignore 'fly').
// - même vérification d'identité que recordGameResult (accessToken -> getUser) ; invité = rien
// - XP déjà obtenue sur 24 h = recalculée depuis game_history (game_mode = 'fly') : aucun compteur à diverger
// - la ligne d'historique est TOUJOURS insérée (elle sert au calcul du plafond), même si l'XP est plafonnée
// - appels sérialisés (une seule fin de partie à la fois) : pas de dépassement du plafond par course
// Fire-and-forget côté appelant ; jamais bloquant pour la fin de partie.
// =====================================================================
const defaultConfig = require('./fly-config');

const DAY_MS = 24 * 60 * 60 * 1000;

function createFlyXp({ supabase, createAuthClient, xpParticipation, xpVictoryBonus, config = defaultConfig, now = Date.now, logger = console }) {
  const xpFor = result => xpParticipation + (result === 'victory' ? xpVictoryBonus : 0);
  let tail = Promise.resolve();

  async function run(player, details) {
    if (!player || !player.accountAccessToken || !supabase || !createAuthClient) return { skipped: true };
    const { data: { user }, error: userError } = await createAuthClient().auth.getUser(player.accountAccessToken);
    if (userError || !user) return { skipped: true };

    const since = new Date(now() - DAY_MS).toISOString();
    const past = await supabase.from('game_history').select('result')
      .eq('user_id', user.id).eq('game_mode', config.MODE).gte('created_at', since);
    if (past.error) throw new Error(past.error.message);
    const used = (past.data || []).reduce((s, r) => s + xpFor(r.result), 0);
    const remaining = Math.max(0, config.XP_CAP_PER_24H - used);
    const full = xpFor(details.result);
    const xp = Math.min(full, remaining);

    if (xp > 0) {
      const { data: profile } = await supabase.from('profiles').select('xp').eq('id', user.id).single();
      const up = await supabase.from('profiles').update({ xp: (profile ? (profile.xp || 0) : 0) + xp }).eq('id', user.id);
      if (up.error) throw new Error(up.error.message);
    }
    const ins = await supabase.from('game_history').insert({
      user_id: user.id, game_mode: config.MODE, result: details.result, score: details.score ?? null,
      opponent_name: details.opponentName ?? null, difficulty: null, team: details.team ?? null
    });
    if (ins.error) throw new Error(ins.error.message);
    return { xp, full, capped: xp < full };
  }

  return function recordFlyResult(player, details) {
    const job = tail.then(() => run(player, details));
    tail = job.catch(err => { logger.error('[fly] échec XP/historique :', err && err.message); });
    return job;
  };
}

module.exports = { createFlyXp };
