#!/usr/bin/env node
'use strict';
// =====================================================================
// Récupère la table d'efficacité OFFICIELLE des types depuis PokéAPI -> data/type-chart.json
//   node fetch-types.js
//   node fetch-types.js --out=chemin.json
// Une requête type/{name} par type (18). La table n'est JAMAIS saisie à la main : elle est
// construite à partir de damage_relations (double_damage_from / half_damage_from /
// no_damage_from) ; tout couple absent = ×1.
// Format : { "generatedFrom": "...", "types": [...18], "chart": { attaquant: { défenseur: facteur } } }
// =====================================================================
const fs = require('fs');
const path = require('path');
const { TYPE_ORDER } = require('./boss-mechanics-config');

const API = process.env.POKEAPI_TYPE_BASE || 'https://pokeapi.co/api/v2/type';
const OUT_FILE = path.resolve((process.argv.find(a => a.startsWith('--out=')) || '').replace('--out=', '') ||
  path.join(__dirname, 'data', 'type-chart.json'));
const MAX_RETRIES = 5;
const TIMEOUT_MS = 15000;

if (typeof fetch !== 'function') { console.error('Node >= 18 requis (fetch natif absent).'); process.exit(1); }

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchJson(url) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'pokemon-game-fetch-types' } });
      if (res.status === 404) throw Object.assign(new Error('404 introuvable'), { fatal: true });
      if (res.status === 429 || res.status >= 500) {
        throw Object.assign(new Error(`HTTP ${res.status}`), { wait: (parseInt(res.headers.get('retry-after'), 10) || 0) * 1000 });
      }
      if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { fatal: true });
      return await res.json();
    } catch (err) {
      lastErr = err;
      if (err.fatal || attempt === MAX_RETRIES) break;
      await sleep(err.wait || 500 * 2 ** (attempt - 1));
    } finally { clearTimeout(timer); }
  }
  throw lastErr;
}

// Construit la table à partir des réponses type/{name} (pure : testable sans réseau).
// responses : { [typeName]: json PokéAPI }.
function buildChart(responses, types = TYPE_ORDER) {
  const chart = {};
  for (const atk of types) { chart[atk] = {}; for (const def of types) chart[atk][def] = 1; }
  for (const def of types) {
    const rel = responses[def] && responses[def].damage_relations;
    if (!rel) throw new Error(`damage_relations manquant pour "${def}"`);
    // damage_relations de `def` = ce qu'il SUBIT : attaquants qui lui font ×2 / ×0.5 / ×0.
    const apply = (list, factor) => (list || []).forEach(t => { if (chart[t.name]) chart[t.name][def] = factor; });
    apply(rel.double_damage_from, 2);
    apply(rel.half_damage_from, 0.5);
    apply(rel.no_damage_from, 0);
  }
  return chart;
}

async function main() {
  const responses = {};
  let done = 0;
  for (const name of TYPE_ORDER) {
    responses[name] = await fetchJson(`${API}/${name}`);
    process.stdout.write(`\r  ${++done}/${TYPE_ORDER.length} types   `);
  }
  process.stdout.write('\n');
  const chart = buildChart(responses);
  const out = { generatedFrom: 'PokeAPI type/{name} damage_relations', types: TYPE_ORDER, chart };
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  const tmp = `${OUT_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(out, null, 2));
  fs.renameSync(tmp, OUT_FILE);
  const cells = TYPE_ORDER.length ** 2;
  console.log(`Sauvegardé : ${OUT_FILE} (${TYPE_ORDER.length} types, ${cells} couples).`);
  console.log('✔ Étape suivante : node test-boss.js');
}

module.exports = { buildChart };
if (require.main === module) main().catch(err => { console.error('Erreur fatale :', err.message); process.exit(1); });
