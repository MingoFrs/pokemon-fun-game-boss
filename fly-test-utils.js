'use strict';
// Outils de test (aucun réseau) : faux client Supabase en mémoire (sous-ensemble utilisé par
// fly-brain-store.js) et faux Express (middlewares + handlers). Utilisés par test-fly.js.

class FakeSupabase {
  constructor() {
    this.tables = { fly_brain: [], fly_brain_snapshots: [], game_history: [], profiles: [] };
    this.nextId = 1;
    this.writes = { fly_brain: 0, fly_brain_snapshots: 0, game_history: 0, profiles: 0 };
    this.failing = new Set();            // ex. 'fly_brain:update', 'fly_brain:select'
  }
  from(table) { return new Query(this, table); }
}

class Query {
  constructor(db, table) {
    Object.assign(this, { db, table, mode: 'select', filters: [], orderBy: null, max: null, patch: null, row: null, one: false });
  }
  select() { if (this.mode !== 'select') this.returning = true; return this; }
  insert(row) { this.mode = 'insert'; this.row = row; return this; }
  update(patch) { this.mode = 'update'; this.patch = patch; return this; }
  delete() { this.mode = 'delete'; return this; }
  eq(k, v) { this.filters.push(r => r[k] === v); return this; }
  neq(k, v) { this.filters.push(r => r[k] !== v); return this; }
  lte(k, v) { this.filters.push(r => r[k] <= v); return this; }
  gte(k, v) { this.filters.push(r => r[k] >= v); return this; }
  in(k, arr) { this.filters.push(r => arr.includes(r[k])); return this; }
  order(k, { ascending = true } = {}) { this.orderBy = { k, ascending }; return this; }
  limit(n) { this.max = n; return this; }
  maybeSingle() { this.one = true; return this; }
  single() { this.one = true; return this; }
  then(resolve, reject) { return Promise.resolve().then(() => this.run()).then(resolve, reject); }

  run() {
    const { db, table, mode } = this;
    if (db.failing.has(`${table}:${mode}`)) return { data: null, error: { message: `échec simulé ${table}:${mode}` } };
    const rows = db.tables[table];
    const clone = x => JSON.parse(JSON.stringify(x));          // sérialisation jsonb
    const match = r => this.filters.every(f => f(r));
    if (mode === 'insert') {
      const row = clone(this.row);
      if (table === 'fly_brain' && rows.some(r => r.id === row.id)) return { data: null, error: { code: '23505', message: 'duplicate key' } };
      if (table === 'fly_brain_snapshots' || table === 'game_history') { row.id = db.nextId++; row.created_at = row.created_at || new Date().toISOString(); }
      rows.push(row); db.writes[table]++;
      return { data: null, error: null };
    }
    if (mode === 'update') {
      const hit = rows.filter(match);
      hit.forEach(r => Object.assign(r, clone(this.patch)));
      if (hit.length) db.writes[table]++;
      return { data: this.returning ? hit.map(r => clone(r)) : null, error: null };
    }
    if (mode === 'delete') {
      const keep = rows.filter(r => !match(r));
      db.tables[table] = keep; db.writes[table]++;
      return { data: null, error: null };
    }
    let out = rows.filter(match).map(clone);
    if (this.orderBy) out.sort((a, b) => (a[this.orderBy.k] - b[this.orderBy.k]) * (this.orderBy.ascending ? 1 : -1));
    if (this.max != null) out = out.slice(0, this.max);
    return { data: this.one ? (out[0] || null) : out, error: null };
  }
}

// Faux Express : enregistre les handlers ; call() exécute la chaîne de middlewares.
function fakeApp() {
  const routes = {};
  const reg = method => (path, ...handlers) => { routes[`${method} ${path}`] = handlers; };
  return {
    get: reg('GET'), post: reg('POST'),
    async call(method, path, { headers = {}, body = {}, ip = '1.2.3.4' } = {}) {
      const handlers = routes[`${method} ${path}`];
      if (!handlers) throw new Error(`route absente : ${method} ${path}`);
      const req = { headers, body, ip };
      return new Promise(resolve => {
        const res = { code: 200, status(c) { this.code = c; return this; }, json(b) { resolve({ code: this.code, body: b }); } };
        (async () => {
          for (let i = 0; i < handlers.length; i++) {
            let nextCalled = false;
            await handlers[i](req, res, () => { nextCalled = true; });
            if (!nextCalled) return;
          }
        })();
      });
    }
  };
}

const silentLogger = { log() {}, warn() {}, error() {} };
module.exports = { FakeSupabase, fakeApp, silentLogger };
