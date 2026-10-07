'use strict';
// =====================================================================
// LE CERVEAU PARTAGÉ DE LA MOUCHE : un seul objet pour TOUTES les parties simultanées.
//   - charge / sauvegarde (Supabase : fly_brain + fly_brain_snapshots, cf. fly-brain-v2.sql)
//   - échauffement simulé sur tout cerveau NEUF (premier démarrage, reset admin) : fonction `warmup` injectée
//   - snapshots périodiques (tous les N parties vécues par le cerveau courant) ; archive avant reset / restauration
//   - « epoch » : toute partie démarrée avant un reset/restauration est ignorée à sa fin
//
// DEUX niveaux de compteurs, volontairement séparés :
//   * CERVEAU courant (génération G) : games_played / wins / losses / draws / warmup_games — repartent de zéro au reset
//   * GLOBAL « Humanité X – Mouche Y » : total_games / total_wins / total_losses / total_draws — ne bougent JAMAIS au reset
// `generation` augmente à chaque reset ou restauration (monotone). La courbe (recent_results) est globale.
//
// Toutes les écritures DB passent par UNE file d'attente ; les sauvegardes en attente sont coalescées.
// Aucun accès DB si supabase = null (mode mémoire seule). Aucune écriture si la ligne en base est illisible.
// =====================================================================
const defaultConfig = require('./fly-config');
const { createPolicy, assertFlyModel } = require('./fly-policy');

const RESULT_CHAR = { win: 'W', loss: 'L', draw: 'D' };   // point de vue de la Mouche
const BRAIN_KEYS = ['games_played', 'wins', 'losses', 'draws'];
const NEW_COLUMNS = ['generation', 'total_games', 'total_wins', 'total_losses', 'total_draws'];

function createBrainStore({ supabase = null, config = defaultConfig, makePolicy, warmup = null, logger = console } = {}) {
  assertFlyModel(config);                       // FLY_MODEL invalide : le démarrage échoue avec un message clair
  const policy = makePolicy ? makePolicy() : createPolicy({ config });
  const store = {
    policy, epoch: 0, generation: 1, recent: [], persistent: false, saveDisabled: false, conflicts: 0,
    totals: { games: 0, wins: 0, losses: 0, draws: 0 }, warmupResult: null
  };
  let tail = Promise.resolve();
  let savePending = null;
  let forceWrite = false;

  function enqueue(fn) {
    const run = tail.then(fn).catch(err => { logger.error('[fly] échec écriture DB :', err && err.message); return { ok: false, error: err }; });
    tail = run;
    return run;
  }
  const freshState = () => (makePolicy ? makePolicy() : createPolicy({ config })).getState();
  const modelOf = s => { const m = { ...s }; BRAIN_KEYS.forEach(k => delete m[k]); return m; };
  const fromRow = row => ({ ...row.weights, games_played: row.games_played, wins: row.wins, losses: row.losses, draws: row.draws });
  const cleanRecent = arr => (Array.isArray(arr) ? arr.filter(x => x === 'W' || x === 'L' || x === 'D').slice(-config.CURVE_WINDOW_GAMES) : []);

  function payload() {
    const s = policy.getState();
    return {
      weights: modelOf(s), games_played: s.games_played, wins: s.wins, losses: s.losses, draws: s.draws,
      generation: store.generation,
      total_games: store.totals.games, total_wins: store.totals.wins, total_losses: store.totals.losses, total_draws: store.totals.draws,
      recent_results: store.recent.slice(), updated_at: new Date().toISOString()
    };
  }

  // Échauffement d'un cerveau NEUF. N'échoue jamais : en cas d'erreur le cerveau reste neuf (jouable, simplement moins bon).
  function runWarmup() {
    store.warmupResult = null;
    if (!warmup || !(config.WARMUP_GAMES > 0)) return;
    try {
      store.warmupResult = warmup(policy) || { games: config.WARMUP_GAMES };
      logger.log(`[fly] échauffement : ${policy.getState().warmup_games} parties simulées (taux de victoire moyen pendant l'échauffement ≈ ${store.warmupResult.winRate == null ? '?' : Math.round(100 * store.warmupResult.winRate)} %).`);
    } catch (e) {
      logger.error('[fly] échauffement impossible, cerveau laissé vierge :', e && e.message);
    }
  }

  // ---- Chargement au démarrage ----
  // Retourne 'memory_only' | 'loaded' | 'created' | 'invalid' | 'schema_outdated' | 'db_error'.
  // Tout statut sauf 'loaded' => cerveau neuf en mémoire => échauffement. Pour 'invalid' / 'schema_outdated' /
  // 'db_error', la sauvegarde est DÉSACTIVÉE : on n'écrase jamais une ligne qu'on n'a pas pu lire ou comprendre.
  // 'db_error' (401 transitoire, réseau) : relectures en arrière-plan ; au succès le cerveau en base est adopté.
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const TRANSIENT = /JWT|future|fetch failed|timeout|ECONN|ETIMEDOUT|EAI_AGAIN|502|503|504|network/i;

  async function readRow(tries = 5) {
    let last;
    for (let i = 0; i < tries; i++) {
      let res;
      try { res = await supabase.from('fly_brain').select('*').eq('id', 1).maybeSingle(); }
      catch (e) { res = { data: null, error: e }; }
      if (!res.error) return res;
      last = res;
      const msg = String(res.error.message || res.error);
      if (!(res.status === 401 || res.status >= 500 || TRANSIENT.test(msg))) return res;   // erreur permanente
      logger.warn(`[fly] lecture fly_brain : échec transitoire (${msg}), tentative ${i + 1}/${tries}`);
      if (i < tries - 1) await sleep(400 * 2 ** i + Math.random() * 200);
    }
    return last;
  }

  // Applique une ligne lue. Retourne 'loaded' | 'schema_outdated' | 'invalid'.
  function applyRow(data) {
    if (!NEW_COLUMNS.every(k => k in data)) return 'schema_outdated';
    try { policy.setState(fromRow(data)); } catch (e) { logger.error('[fly] état du cerveau en base INVALIDE :', e.message); return 'invalid'; }
    store.generation = Math.max(1, data.generation | 0);
    store.totals = { games: data.total_games | 0, wins: data.total_wins | 0, losses: data.total_losses | 0, draws: data.total_draws | 0 };
    store.recent = cleanRecent(data.recent_results);
    store.persistent = true;
    return 'loaded';
  }

  let recoveryTimer = null;
  function scheduleRecovery() {
    if (recoveryTimer || !supabase) return;
    recoveryTimer = setInterval(async () => {
      const { data, error } = await readRow(2);
      if (error) return;                                   // on retentera dans 30 s
      if (!data) return;                                   // ligne absente : laissé au prochain redémarrage
      const st = applyRow(data);
      if (st !== 'loaded') { logger.error(`[fly] récupération impossible (${st}).`); clearInterval(recoveryTimer); recoveryTimer = null; return; }
      store.epoch++;                                       // parties démarrées avec le cerveau provisoire : ignorées à leur fin
      store.saveDisabled = false;
      clearInterval(recoveryTimer); recoveryTimer = null;
      logger.log('[fly] récupération : cerveau relu depuis la base, sauvegarde réactivée.');
    }, 30000);
    if (recoveryTimer.unref) recoveryTimer.unref();
  }

  store.load = async function load() {
    if (!supabase) {
      logger.warn('[fly] Supabase indisponible : cerveau en mémoire seule (perdu au redémarrage).');
      runWarmup();
      return 'memory_only';
    }
    const { data, error } = await readRow();
    if (error) {
      store.saveDisabled = true;
      logger.error('[fly] lecture fly_brain impossible, sauvegarde désactivée (relecture auto toutes les 30 s) :', error.message);
      runWarmup();
      scheduleRecovery();
      return 'db_error';
    }
    if (!data) {
      runWarmup();
      const ins = await supabase.from('fly_brain').insert({ id: 1, ...payload() });
      if (ins.error && ins.error.code !== '23505') {
        store.saveDisabled = true;
        logger.error(`[fly] création fly_brain impossible (${ins.error.message}). As-tu exécuté fly-brain-v2.sql ?`);
        return 'db_error';
      }
      store.persistent = true;
      return 'created';
    }
    const st = applyRow(data);
    if (st === 'loaded') return 'loaded';
    store.saveDisabled = true;
    if (st === 'schema_outdated') logger.error('[fly] schéma fly_brain obsolète (colonnes generation / total_* absentes) : exécute fly-brain-v2.sql. Sauvegarde désactivée.');
    else logger.error('[fly] sauvegarde désactivée (ligne conservée).');
    runWarmup();
    return st;
  };

  // ---- Écritures ----
  async function writeCurrent() {
    if (!supabase || store.saveDisabled) return { ok: false, skipped: true };
    const force = forceWrite; forceWrite = false;
    const body = payload();
    let q = supabase.from('fly_brain').update(body).eq('id', 1);
    // Garde anti-régression (2 instances pendant un déploiement) : jamais d'écrasement d'un cerveau plus avancé.
    // total_games est monotone (il ne baisse jamais, même au reset) : c'est la bonne référence.
    if (!force) q = q.lte('total_games', body.total_games);
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

  function enqueueSnapshot(reason, state, generation) {
    return enqueue(async () => {
      if (!supabase || store.saveDisabled) return { ok: false, skipped: true };
      const ins = await supabase.from('fly_brain_snapshots').insert({
        reason, generation, games_played: state.games_played, wins: state.wins, losses: state.losses, draws: state.draws, weights: modelOf(state)
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
  store.observe = (decision, outcome) => policy.observe(decision, outcome);

  // Fin d'une partie COMPLÈTE uniquement (le serveur n'appelle jamais ceci sur abandon).
  store.recordGame = function recordGame({ epoch, trajectory, result }) {
    if (epoch !== store.epoch) return { learned: false, reason: 'stale_epoch' };
    const r = policy.learn(trajectory, 0, { result });
    if (!r.learned) return r;
    store.totals.games += 1;
    if (result === 'win') store.totals.wins += 1; else if (result === 'loss') store.totals.losses += 1; else store.totals.draws += 1;
    store.recent.push(RESULT_CHAR[result] || 'D');
    if (store.recent.length > config.CURVE_WINDOW_GAMES) store.recent.splice(0, store.recent.length - config.CURVE_WINDOW_GAMES);
    const gp = policy.getState().games_played;
    if (gp % config.SNAPSHOT_EVERY_GAMES === 0) enqueueSnapshot('periodic', policy.getState(), store.generation);
    requestSave();
    return { ...r, games_played: gp };
  };

  // ---- Admin ----
  // Reset : l'ancien cerveau est ARCHIVÉ, un cerveau neuf (+ échauffement) repart de zéro, la génération augmente.
  // Les compteurs globaux « Humanité X – Mouche Y » et la courbe ne bougent pas.
  store.reset = async function reset() {
    const before = policy.getState();
    const oldGeneration = store.generation;
    store.epoch++;
    store.generation++;
    policy.setState(freshState());
    runWarmup();
    enqueueSnapshot('pre_reset', before, oldGeneration);
    forceWrite = true;
    const res = await requestSave();
    return { ok: !!(res && res.ok) || !supabase, previousGames: before.games_played, previousGeneration: oldGeneration, generation: store.generation, epoch: store.epoch };
  };

  store.listSnapshots = async function listSnapshots(limit = 100) {
    if (!supabase) return [];
    const { data, error } = await supabase.from('fly_brain_snapshots')
      .select('id, reason, generation, games_played, wins, losses, draws, created_at').order('id', { ascending: false }).limit(limit);
    if (error) throw new Error(error.message);
    return data || [];
  };

  // Restauration : le cerveau archivé redevient le cerveau courant ; la génération augmente aussi (nouveau cerveau en service).
  store.restoreSnapshot = async function restoreSnapshot(id) {
    if (!supabase) throw new Error('Supabase indisponible');
    const { data, error } = await supabase.from('fly_brain_snapshots').select('*').eq('id', id).maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return { ok: false, reason: 'not_found' };
    const state = fromRow(data);
    (makePolicy ? makePolicy() : createPolicy({ config })).setState(state);   // valide AVANT toute modification (lève si invalide)
    const before = policy.getState();
    const oldGeneration = store.generation;
    store.epoch++;
    store.generation++;
    policy.setState(state);
    enqueueSnapshot('pre_restore', before, oldGeneration);
    forceWrite = true;
    const res = await requestSave();
    return { ok: !!(res && res.ok), restoredGames: state.games_played, generation: store.generation, epoch: store.epoch };
  };

  store.flush = () => tail;

  // ---- Stats publiques (jamais de valeurs apprises ni de table de Pokémon) ----
  store.getPublicStats = function getPublicStats() {
    const s = policy.getState();
    const rate = (w, n) => (n ? w / n : null);
    return {
      name: config.AGENT_NAME,
      generation: store.generation,
      brain: {                                   // cerveau courant (repart de zéro au reset) : parties VÉCUES uniquement
        gamesPlayed: s.games_played, flyWins: s.wins, humanityWins: s.losses, draws: s.draws,
        winRate: rate(s.wins, s.games_played), warmupGames: s.warmup_games
      },
      global: {                                  // « Humanité X – Mouche Y » : toutes générations, jamais remis à zéro
        gamesPlayed: store.totals.games, flyWins: store.totals.wins, humanityWins: store.totals.losses, draws: store.totals.draws,
        winRate: rate(store.totals.wins, store.totals.games)
      },
      recent: store.recent.slice()
    };
  };

  return store;
}

module.exports = { createBrainStore };
