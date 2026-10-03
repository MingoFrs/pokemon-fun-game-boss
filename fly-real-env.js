'use strict';
// =====================================================================
// Environnement de validation « réel » : exécute les VRAIES fonctions de tirage de server.js
// (pickPlayerTurnOptions, buildRewardOption, pickRarity, pickEffect, rollShiny, RARITY_TABLE...),
// extraites du texte de server.js et évaluées dans un bac à sable `vm` (aucun serveur démarré,
// Math.random remplacé par un PRNG à graine). Si server.js change, la validation suit.
// Données : stats.loadEntries() + data/pokemon-stats.json (types) si présents ; sinon l'appelant
// fournit des entrées (voir fly-validate.js --proxy).
// =====================================================================
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const DECLS = [
  'SHINY_CHANCE', 'SHINY_POINTS_MULTIPLIER', 'rollShiny', 'RARITY_TABLE', 'MEGA_ADMIN_WEIGHT',
  'SHINY_CHARM_MULTIPLIER', 'SHINY_CHARM_BOOSTED_RARITIES', 'PITY_BOOSTED_RARITIES', 'PITY_GOOD_RARITIES',
  'PITY_MULTIPLIER_BY_LEVEL', 'getPityMultiplier', 'RARITY_ORDER', 'buildWeightedRarityTable', 'pickRarity',
  'EFFECTS', 'EFFECTS_TOTAL_WEIGHT', 'pickEffect', 'randomFrom', 'buildRewardOption', 'pickPlayerTurnOptions'
];

// Extrait une déclaration de premier niveau (function ou const) par comptage de ([{ }].
// Tolère les fins de ligne Windows (CRLF) et refuse toute extraction qui déborderait sur une autre déclaration.
function extractDecl(rawSrc, name) {
  const lines = rawSrc.replace(/\r\n?/g, '\n').split('\n');
  const start = lines.findIndex(l => new RegExp(`^(const|let|function)\\s+${name}\\b`).test(l));
  if (start < 0) throw new Error(`déclaration introuvable dans server.js : ${name}`);
  const isFn = lines[start].startsWith('function');
  let depth = 0, seen = false;
  for (let i = start; i < lines.length; i++) {
    const code = lines[i].replace(/\/\/.*$/, '').trimEnd();
    if (i > start && /^(const|let|var|function|class)\s/.test(lines[i])) {
      throw new Error(`extraction de ${name} : déborde sur la ligne ${i + 1} (« ${lines[i].slice(0, 40)} »). Fin de déclaration non reconnue.`);
    }
    for (const ch of code) {
      if ('([{'.includes(ch)) { depth++; seen = true; }
      else if (')]}'.includes(ch)) depth--;
    }
    if (depth === 0 && (isFn ? seen : /;$/.test(code))) return lines.slice(start, i + 1).join('\n');
  }
  throw new Error(`fin de déclaration introuvable : ${name}`);
}

function buildPools(entries, categoryOrder) {
  const pools = {};
  categoryOrder.forEach(c => { pools[c] = []; });
  for (const e of entries) pools[e.rarity].push({ id: e.id, name: e.name || `#${e.id}`, rarity: e.rarity, sprite: `s${e.id}`, bst: e.bst, basePoints: e.basePoints });
  return pools;
}

// Retourne { drawOptions(), source }. drawOptions() -> [haut, bas] (objets de buildRewardOption, finalPoints inclus).
function createRealDraws({ serverFile, entries, rng, categoryOrder, legendaryGroup = ['legendaire', 'fabuleux', 'ultra_chimere'] }) {
  const src = fs.readFileSync(serverFile, 'utf8').replace(/\r\n?/g, '\n');
  const code = DECLS.map(n => extractDecl(src, n)).join('\n\n');
  const seededMath = Object.create(Math);
  seededMath.random = rng;
  const ctx = vm.createContext({
    Math: seededMath, console, LEGENDARY_GROUP: legendaryGroup, POKEMON_POOLS: buildPools(entries, categoryOrder),
    shinySpriteUrl: id => `sh${id}`
  });
  vm.runInContext(code, ctx, { filename: 'server.js (extraits)' });
  const pick = vm.runInContext('pickPlayerTurnOptions', ctx);
  return {
    drawOptions() {
      const o = pick(false, 0, undefined, undefined, 'fly');      // table du mode normal, sans pity / Charme / plancher
      return [o.haut, o.bas];
    },
    rarityTable: vm.runInContext('RARITY_TABLE', ctx)
  };
}

// Données du projet (chez l'utilisateur). Retourne { entries, typesById } ou lève une erreur claire.
function loadProjectEntries(root = process.cwd()) {
  const statsPath = path.join(root, 'stats.js');
  if (!fs.existsSync(statsPath)) throw new Error('stats.js introuvable (lance depuis la racine du projet, ou utilise --proxy)');
  const engine = require(statsPath);
  const config = require(path.join(root, 'stats-config.js'));
  const entries = engine.loadEntries();
  const statsFile = process.env.POKEMON_STATS_FILE || path.join(root, 'data', 'pokemon-stats.json');
  const raw = JSON.parse(fs.readFileSync(statsFile, 'utf8'));
  const typesById = {};
  entries.forEach(e => { typesById[e.id] = (raw[e.id] && raw[e.id].types) || []; });
  return { entries, typesById, categoryOrder: config.CATEGORY_ORDER, legendaryGroup: config.LEGENDARY_GROUP };
}

module.exports = { createRealDraws, loadProjectEntries, extractDecl, buildPools };
