#!/usr/bin/env node
'use strict';
// =====================================================================
// Récupère les Base Stats officielles depuis PokéAPI -> data/pokemon-stats.json
//   node fetch-stats.js                  # récupère ce qui manque (relançable à volonté)
//   node fetch-stats.js --force          # retélécharge tout
//   node fetch-stats.js --only=445,10058 # seulement ces ids
//   node fetch-stats.js --concurrency=4  # requêtes simultanées (défaut 4, max 8)
//   node fetch-stats.js --out=chemin.json
// Requiert Node >= 18 (fetch natif). Les ids viennent de data/pokemon-roster.json ; les
// formes Méga (id >= 10000) sont interrogées directement via pokemon/{id}, donc leurs
// stats sont bien celles de la forme Méga.
// =====================================================================
const fs = require('fs');
const path = require('path');

const API = process.env.POKEAPI_BASE || 'https://pokeapi.co/api/v2/pokemon';
const ROSTER_FILE = path.join(__dirname, 'data', 'pokemon-roster.json');
const STAT_MAP = {
  hp: 'hp', attack: 'attack', defense: 'defense',
  'special-attack': 'specialAttack', 'special-defense': 'specialDefense', speed: 'speed'
};
const MEGA_MIN_ID = 10000;
const MAX_RETRIES = 5;
const TIMEOUT_MS = 15000;
const SAVE_EVERY = 25;

if (typeof fetch !== 'function') {
  console.error('Node >= 18 requis (fetch natif absent).');
  process.exit(1);
}

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v === undefined ? true : v];
}));
const OUT_FILE = path.resolve(args.out || path.join(__dirname, 'data', 'pokemon-stats.json'));
const CONCURRENCY = Math.max(1, Math.min(8, parseInt(args.concurrency, 10) || 4));
const FORCE = Boolean(args.force);

const sleep = ms => new Promise(r => setTimeout(r, ms));

function isValidEntry(e) {
  return e && Object.values(STAT_MAP).every(k => Number.isInteger(e[k]) && e[k] > 0) &&
    e.bst === Object.values(STAT_MAP).reduce((s, k) => s + e[k], 0);
}

// Écriture atomique : le fichier existant n'est jamais laissé à moitié écrit.
function saveAtomic(data) {
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  const tmp = `${OUT_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, OUT_FILE);
}

async function fetchJson(url) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'pokemon-game-fetch-stats' } });
      if (res.status === 404) throw Object.assign(new Error('404 introuvable'), { fatal: true });
      if (res.status === 429 || res.status >= 500) {
        const wait = (parseInt(res.headers.get('retry-after'), 10) || 0) * 1000;
        throw Object.assign(new Error(`HTTP ${res.status}`), { wait });
      }
      if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { fatal: true });
      return await res.json();
    } catch (err) {
      lastErr = err;
      if (err.fatal || attempt === MAX_RETRIES) break;
      await sleep(err.wait || 500 * 2 ** (attempt - 1)); // 0,5 s, 1 s, 2 s, 4 s
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

function parsePokemon(rosterEntry, json) {
  const entry = { id: rosterEntry.id, name: rosterEntry.name, apiName: json.name };
  for (const s of json.stats) {
    const key = STAT_MAP[s.stat.name];
    if (key) entry[key] = s.base_stat;
  }
  entry.bst = Object.values(STAT_MAP).reduce((sum, k) => sum + entry[k], 0);
  if (!isValidEntry(entry)) throw new Error('stats incomplètes dans la réponse');
  return entry;
}

async function main() {
  const roster = JSON.parse(fs.readFileSync(ROSTER_FILE, 'utf8'));
  const only = args.only ? new Set(String(args.only).split(',').map(Number)) : null;
  let existing = {};
  if (fs.existsSync(OUT_FILE)) {
    try { existing = JSON.parse(fs.readFileSync(OUT_FILE, 'utf8')); }
    catch (e) {
      fs.copyFileSync(OUT_FILE, `${OUT_FILE}.corrupt-${Date.now()}`);
      console.warn('Fichier existant illisible : copie de sauvegarde créée, on repart de zéro.');
    }
  }
  const data = { ...existing };
  const todo = roster.filter(r => (!only || only.has(r.id)) && (FORCE || !isValidEntry(data[r.id])));
  console.log(`${roster.length} Pokémon au roster, ${roster.length - todo.length} déjà valides, ${todo.length} à récupérer (concurrence ${CONCURRENCY}).`);
  if (!todo.length) return finish(data, roster, []);

  const failed = [];
  const warnings = [];
  let done = 0;
  let sinceSave = 0;
  let interrupted = false;
  process.on('SIGINT', () => { interrupted = true; console.log('\nInterruption : sauvegarde en cours…'); });

  let cursor = 0;
  async function worker() {
    while (!interrupted && cursor < todo.length) {
      const r = todo[cursor++];
      try {
        const entry = parsePokemon(r, await fetchJson(`${API}/${r.id}`));
        if (r.id >= MEGA_MIN_ID && !/mega/.test(entry.apiName)) warnings.push(`${r.id} ${r.name} -> "${entry.apiName}" n'a pas l'air d'une forme Méga`);
        if (r.id < MEGA_MIN_ID && /mega/.test(entry.apiName)) warnings.push(`${r.id} ${r.name} -> "${entry.apiName}" inattendu`);
        data[r.id] = entry;
      } catch (err) {
        failed.push({ id: r.id, name: r.name, error: err.message });
      }
      done++;
      if (++sinceSave >= SAVE_EVERY) { saveAtomic(data); sinceSave = 0; }
      if (done % 10 === 0 || done === todo.length) {
        process.stdout.write(`\r  ${done}/${todo.length} (${failed.length} échec(s))   `);
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  process.stdout.write('\n');
  warnings.forEach(w => console.warn('⚠', w));
  finish(data, roster, failed);
}

function finish(data, roster, failed) {
  // Tri par id pour un JSON stable.
  const sorted = Object.fromEntries(Object.keys(data).sort((a, b) => a - b).map(k => [k, data[k]]));
  saveAtomic(sorted);
  const missing = roster.filter(r => !isValidEntry(sorted[r.id]));
  console.log(`Sauvegardé : ${OUT_FILE} (${Object.keys(sorted).length} entrées).`);
  if (failed.length) {
    console.error(`${failed.length} échec(s) :`);
    failed.forEach(f => console.error(`  - ${f.id} ${f.name} : ${f.error}`));
  }
  if (missing.length) {
    console.error(`${missing.length} Pokémon du roster sans stats valides. Relance simplement le script.`);
    process.exit(1);
  }
  console.log('✔ Roster complet. Étape suivante : node analyze-stats.js');
}

main().catch(err => { console.error('Erreur fatale :', err.message); process.exit(1); });
