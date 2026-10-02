'use strict';
// =====================================================================
// LE CERVEAU PARTAGÉ DE LA MOUCHE : un seul objet pour TOUTES les parties simultanées.
//   - charge / sauvegarde (Supabase, tables fly_brain + fly_brain_snapshots, cf. fly-brain.sql)
//   - snapshots versionnés tous les N parties (SNAPSHOT_KEEP gardés), reset et restauration
//   - « epoch » : toute partie démarrée avant un reset/restauration est ignorée à sa fin
//     (sa trajectoire a été produite par un ancien cerveau)
// Toutes les écritures DB passent par UNE file d'attente (jamais deux en parallèle) ; les sauvegardes
// en attente sont coalescées (seul l'état le plus récent est écrit). Aucun accès DB si supabase = null
// (mode mémoire seule). Aucune dépendance autre que fly-agent / fly-config.
// =====================================================================
const defaultConfig = require('./fly-config');
const { LinearPolicy } = require('./fly-agent');

const RESULT_CHAR = { win: 'W', loss: 'L', draw: 'D' };   // point de vue de la Mouche

function createBrainStore({ supabase = null, config = defaultConfig, makePolicy, logger = console } = {}) {
  const policy = makePolicy ? makePolicy() : new LinearPolicy({ config });
  const store = {
    policy, epoch: 0, recent: [], persistent: false, saveDisabled: false, conflicts: 0
  };
  let tail = Promise.resolve();
  let savePending = null;
  let forceWrite = false;

  function enqueue(fn) {
    const run = tail.then(fn).catch(err => { logger.error('[fly] échec écriture DB :', err && err.message); return { ok: false, error: err }; });
    tail = run;
    return run;
  }

  const payload = () => {
    const s = policy.getState();
    const { games_played, wins, losses, draws } = s;
    const model = { ...s }; delete model.games_played; delete model.wins; delete model.losses; delete model.draws;
    return { weights: model, games_played, wins, losses, draws, recent_results: store.recent.slice(), updated_at: new Date().toISOString() };
  };
  const fromRow = row => ({
    ...row.weights, games_played: row.games_played, wins: row.wins, losses: row.losses, draws: row.draws
  });
  const cleanRecent = arr => (Array.isArray(arr) ? arr.filter(x => x === 'W' || x === 'L' || x === 'D').slice(-config.CURVE_WINDOW_GAMES) : []);

  // ---- Chargement au démarrage ----
  // Retourne 'memory_only' | 'loaded' | 'created' | 'invalid' | 'db_error'. Dans les deux derniers cas,
  // la sauvegarde est DÉSACTIVÉE (on n'écrase jamais une ligne qu'on n'a pas pu lire ou comprendre).
  store.load = async function load() {
    if (!supabase) { logger.warn('[fly] Supabase indisponible : cerveau en mémoire seule (perdu au redémarrage).'); return 'memory_only'; }
    const { data, error } = await supabase.from('fly_brain').select('*').eq('id', 1).maybeSingle();
    if (error) { store.saveDisabled = true; logger.error('[fly] lecture fly_brain impossible, sauvegarde désactivée :', error.message); return 'db_error'; }
    if (!data) {
      const ins = await supabase.from('fly_brain').insert({ id: 1, ...payload() });
      if (ins.error && ins.error.code !== '23505') { store.saveDisabled = true; logger.error('[fly] création fly_brain impossible :', ins.error.message); return 'db_error'; }
      store.persistent = true;
      return 'created';
    }
    try {
      policy.setState(fromRow(data));
    } catch (e) {
      store.saveDisabled = true;
      logger.error('[fly] état du cerveau en base INVALIDE, sauvegarde désactivée (ligne conservée) :', e.message);
      return 'invalid';
    }
    store.recent = cleanRecent(data.recent_results);
    store.persistent = true;
    return 'loaded';
  };

  // ---- Écritures ----
  async function writeCurrent() {
    if (!supabase || store.saveDisabled) return { ok: false, skipped: true };
    const force = forceWrite; forceWrite = false;
    const body = payload();
    let q = supabase.from('fly_brain').update(body).eq('id', 1);
    // Garde anti-régression (2 instances pendant un déploiement) : on n'écrase jamais un cerveau plus avancé.
    if (!force) q = q.lte('games_played', body.games_played);
    const { data, error } = await q.select('id');
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) {
      store.conflicts++;
      logger.warn('[fly] sauvegarde refusée : le cerveau en base est plus avancé (autre instance ?).');
      return { ok: false, conflict: true };
    }
    return { ok: true };
  }

  function requestSave() {
    if (savePending) return savePending;
    savePending = enqueue(async () => { savePending = null; return writeCurrent(); });
    return savePending;
  }

  function enqueueSnapshot(reason, state) {
    return enqueue(async () => {
      if (!supabase || store.saveDisabled) return { ok: false, skipped: true };
      const model = { ...state }; ['games_played', 'wins', 'losses', 'draws'].forEach(k => delete model[k]);
      const ins = await supabase.from('fly_brain_snapshots').insert({
        reason, games_played: state.games_played, wins: state.wins, losses: state.losses, draws: state.draws, weights: model
      });
      if (ins.error) throw new Error(ins.error.message);
      // Purge : périodiques -> SNAPSHOT_KEEP ; sécurité (pre_reset / pre_restore) -> SNAPSHOT_KEEP_SAFETY.
      const periodic = reason === 'periodic';
      let q = supabase.from('fly_brain_snapshots').select('id');
      q = periodic ? q.eq('reason', 'periodic') : q.neq('reason', 'periodic');
      const { data, error } = await q.order('id', { ascending: false });
      if (error) throw new Error(error.message);
      const keep = periodic ? config.SNAPSHOT_KEEP : config.SNAPSHOT_KEEP_SAFETY;
      const old = (data || []).slice(keep).map(r => r.id);
      if (old.length) {
        const del = await supabase.from('fly_brain_snapshots').delete().in('id', old);
        if (del.error) throw new Error(del.error.message);
      }
      return { ok: true, purged: old.length };
    });
  }

  // ---- API de jeu ----
  store.beginGame = () => ({ epoch: store.epoch });
  store.choose = obs => policy.choose(obs);

  // Fin d'une partie COMPLÈTE uniquement (le serveur n'appelle jamais ceci sur abandon).
  store.recordGame = function recordGame({ epoch, trajectory, reward, result }) {
    if (epoch !== store.epoch) return { learned: false, reason: 'stale_epoch' };
    const r = policy.learn(trajectory, reward, { result });
    if (!r.learned) return r;
    store.recent.push(RESULT_CHAR[result] || 'D');
    if (store.recent.length > config.CURVE_WINDOW_GAMES) store.recent.splice(0, store.recent.length - config.CURVE_WINDOW_GAMES);
    const gp = policy.getState().games_played;
    if (gp % config.SNAPSHOT_EVERY_GAMES === 0) enqueueSnapshot('periodic', policy.getState());
    requestSave();
    return { ...r, games_played: gp };
  };

  // ---- Admin ----
  store.reset = async function reset() {
    const before = policy.getState();
    store.epoch++;
    policy.setState(makePolicy ? makePolicy().getState() : LinearPolicy.freshBrain());
    store.recent = [];
    enqueueSnapshot('pre_reset', before);
    forceWrite = true;
    const res = await requestSave();
    return { ok: !!(res && res.ok) || !supabase, previousGames: before.games_played, epoch: store.epoch };
  };

  store.listSnapshots = async function listSnapshots(limit = 100) {
    if (!supabase) return [];
    const { data, error } = await supabase.from('fly_brain_snapshots')
      .select('id, reason, games_played, wins, losses, draws, created_at').order('id', { ascending: false }).limit(limit);
    if (error) throw new Error(error.message);
    return data || [];
  };

  store.restoreSnapshot = async function restoreSnapshot(id) {
    if (!supabase) throw new Error('Supabase indisponible');
    const { data, error } = await supabase.from('fly_brain_snapshots').select('*').eq('id', id).maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return { ok: false, reason: 'not_found' };
    const state = fromRow(data);
    (makePolicy ? makePolicy() : new LinearPolicy({ config })).setState(state);   // valide AVANT toute modification (lève si invalide)
    const before = policy.getState();
    store.epoch++;
    policy.setState(state);
    store.recent = [];
    enqueueSnapshot('pre_restore', before);
    forceWrite = true;
    const res = await requestSave();
    return { ok: !!(res && res.ok), restoredGames: state.games_played, epoch: store.epoch };
  };

  store.flush = () => tail;

  // ---- Stats publiques (jamais de poids ni de baseline) ----
  store.getPublicStats = function getPublicStats() {
    const s = policy.getState();
    return {
      name: config.AGENT_NAME,
      gamesPlayed: s.games_played,
      flyWins: s.wins, humanityWins: s.losses, draws: s.draws,
      winRate: s.games_played ? s.wins / s.games_played : null,
      generation: 1 + Math.floor(s.games_played / config.GENERATION_EVERY_GAMES),
      recent: store.recent.slice()
    };
  };

  return store;
}

module.exports = { createBrainStore };
