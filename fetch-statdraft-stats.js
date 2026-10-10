// Génère data/statdraft-stats.json : { "<id dex>": { hp, atk, def, spa, spd, spe } } depuis PokéAPI.
// À lancer UNE fois (Node 18+) uniquement si le serveur affiche "[statdraft] Base stats par statistique introuvables".
//   node fetch-statdraft-stats.js
const fs = require('fs');
const path = require('path');

const MAX_ID = 1025;      // formes de base uniquement (les Méga, id >= 10000, ne sont pas dans la roulette)
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
    if (attempt >= 4) { console.warn(`#${id} ignoré (${err.message})`); return null; }
    await new Promise(r => setTimeout(r, 500 * attempt));
    return getOne(id, attempt + 1);
  }
}

(async () => {
  const result = {};
  let next = 1;
  let done = 0;
  async function worker() {
    while (next <= MAX_ID) {
      const id = next++;
      const stats = await getOne(id);
      if (stats) result[id] = stats;
      if (++done % 100 === 0) console.log(`${done}/${MAX_ID}`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(result));
  console.log(`OK : ${Object.keys(result).length} Pokémon -> ${OUT}`);
})();
