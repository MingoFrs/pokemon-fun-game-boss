'use strict';
// =====================================================================
// Routes admin du cerveau de la Mouche. Clé UNIQUEMENT dans l'env FLY_ADMIN_KEY (jamais dans le code).
//   GET  /api/fly/admin/snapshots                      -> liste des snapshots
//   POST /api/fly/admin/reset    { confirm: "RESET" }   -> snapshot de sécurité puis cerveau vierge
//   POST /api/fly/admin/restore  { id, confirm: "RESTORE" }
// Auth : header  x-fly-admin-key: <clé>   (comparaison à temps constant, limiteur d'échecs par IP).
// Clé absente ou trop courte -> routes désactivées (404). Branchement dans server.js (étape 3) :
//   require('./fly-admin-routes').registerFlyAdminRoutes(app, { store: flyBrain });
// =====================================================================
const crypto = require('crypto');
const defaultConfig = require('./fly-config');

function registerFlyAdminRoutes(app, { store, config = defaultConfig, adminKey = process.env.FLY_ADMIN_KEY, logger = console, now = Date.now }) {
  const enabled = typeof adminKey === 'string' && adminKey.length >= config.ADMIN_KEY_MIN_LENGTH;
  if (!enabled) logger.warn(`[fly] FLY_ADMIN_KEY absente ou < ${config.ADMIN_KEY_MIN_LENGTH} caractères : routes admin désactivées.`);
  const digest = s => crypto.createHash('sha256').update(String(s)).digest();
  const expected = enabled ? digest(adminKey) : null;
  const fails = new Map();   // ip -> [timestamps]

  function guard(req, res, next) {
    if (!enabled) return res.status(404).json({ error: 'Introuvable' });
    const ip = req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
    const recent = (fails.get(ip) || []).filter(t => now() - t < config.ADMIN_FAIL_WINDOW_MS);
    if (recent.length >= config.ADMIN_MAX_FAILS) { fails.set(ip, recent); return res.status(429).json({ error: 'Trop de tentatives' }); }
    const given = req.headers && req.headers['x-fly-admin-key'];
    const ok = typeof given === 'string' && crypto.timingSafeEqual(digest(given), expected);
    if (!ok) { recent.push(now()); fails.set(ip, recent); return res.status(401).json({ error: 'Non autorisé' }); }
    fails.delete(ip);
    return next();
  }

  const wrap = fn => async (req, res) => {
    try { await fn(req, res); }
    catch (e) { logger.error('[fly] route admin :', e.message); res.status(500).json({ error: 'Erreur serveur' }); }
  };

  app.get('/api/fly/admin/snapshots', guard, wrap(async (req, res) => {
    res.json({ snapshots: await store.listSnapshots(), stats: store.getPublicStats() });
  }));

  app.post('/api/fly/admin/reset', guard, wrap(async (req, res) => {
    if (!req.body || req.body.confirm !== 'RESET') return res.status(400).json({ error: 'confirm: "RESET" requis' });
    const r = await store.reset();
    logger.warn(`[fly] cerveau RÉINITIALISÉ (${r.previousGames} parties archivées).`);
    res.json(r);
  }));

  app.post('/api/fly/admin/restore', guard, wrap(async (req, res) => {
    const id = req.body && req.body.id;
    if (!req.body || req.body.confirm !== 'RESTORE' || !Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'id (entier) et confirm: "RESTORE" requis' });
    const r = await store.restoreSnapshot(id);
    if (r.reason === 'not_found') return res.status(404).json({ error: 'Snapshot introuvable' });
    logger.warn(`[fly] cerveau RESTAURÉ depuis le snapshot ${id}.`);
    res.json(r);
  }));

  return { enabled };
}

module.exports = { registerFlyAdminRoutes };
