// Génère data/statdraft-stats.json : { "<id dex>": { hp, atk, def, spa, spd, spe } } depuis PokéAPI.
// À lancer UNE fois (Node 18+) uniquement si le serveur affiche "[statdraft] Base stats par statistique introuvables".
//   node fetch-statdraft-stats.js
const fs = require('fs');
const path = require('path');

const MAX_ID = 1025;      // espèces de base
const FORM_MIN = 10001;   // formes PokéAPI (Méga incluses) : les ids absents (404) sont simplement ignorés
const FORM_MAX = 10400;
const CONCURRENCY = 8;
const OUT = path.join(__dirname, 'data', 'statdraft-stats.json');
const MAP = { hp: 'hp', attack: 'atk', defense: 'def', 'special-attack': 'spa', 'special-defense': 'spd', speed: 'spe' };

async function getOne(id, attempt = 1) {
  try {
    const res = await fetch(`https://pokeapi.co/api/v2/pokemon/${id}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const out = {};
    json.stats.forEach(s => { if (MAP[s.stat.name]) out[MAP[s.stat.name]] = s.base_stat; });
    if (Object.keys(out).length !== 6) throw new Error('stats incomplètes');
    return out;
  } catch (err) {
    if (String(err.message).includes('404')) return null; // id de forme inexistant
    if (attempt >= 4) { console.warn(`#${id} ignoré (${err.message})`); return null; }
    await new Promise(r => setTimeout(r, 500 * attempt));
    return getOne(id, attempt + 1);
  }
}

(async () => {
  const result = {};
  const ids = [];
  for (let i = 1; i <= MAX_ID; i++) ids.push(i);
  for (let i = FORM_MIN; i <= FORM_MAX; i++) ids.push(i);
  let next = 0;
  let done = 0;
  async function worker() {
    while (next < ids.length) {
      const id = ids[next++];
      const stats = await getOne(id);
      if (stats) result[id] = stats;
      if (++done % 100 === 0) console.log(`${done}/${ids.length}`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(result));
  console.log(`OK : ${Object.keys(result).length} Pokémon -> ${OUT}`);
})();
