#!/usr/bin/env node
'use strict';
// Debug du système de points.
//   node debug-stats.js 445            # par id
//   node debug-stats.js carchacrok     # par nom (sans accent/casse, sous-chaîne)
//   node debug-stats.js --category=epique
//   node debug-stats.js --summary      # répartition par catégorie
//   node debug-stats.js --all
const config = require('./stats-config');
const { loadEntries } = require('./stats');

const norm = s => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const entries = loadEntries();
const arg = process.argv[2];

function print(e) {
  const s = e.stats;
  console.log(`${e.name} (#${e.id})`);
  console.log(`BST : ${e.bst}`);
  console.log(`Catégorie : ${config.CATEGORY_LABELS[e.rarity]}`);
  console.log(`Multiplicateur : ×${e.multiplier}`);
  console.log(`PV ${s.hp} | ATK ${s.attack} | DEF ${s.defense} | SPA ${s.specialAttack} | SPD ${s.specialDefense} | SPE ${s.speed}`);
  console.log(`basePoints : ${e.bst} × ${e.multiplier} = ${e.basePoints}\n`);
}

if (!arg) { console.log('Usage : node debug-stats.js <id|nom|--category=x|--summary|--all>'); process.exit(0); }
if (arg === '--summary') {
  if (!config.THRESHOLDS_CALIBRATED) console.log('⚠ Seuils de BST provisoires (cf. analyze-stats.js)\n');
  for (const cat of config.CATEGORY_ORDER) {
    const list = entries.filter(e => e.rarity === cat);
    const bsts = list.map(e => e.bst);
    console.log(`${config.CATEGORY_LABELS[cat].padEnd(16)} ×${String(config.CATEGORY_MULTIPLIERS[cat]).padEnd(5)} ${String(list.length).padStart(4)} Pokémon` +
      (list.length ? ` | BST ${Math.min(...bsts)}–${Math.max(...bsts)}` : ''));
  }
} else if (arg === '--all') entries.forEach(print);
else if (arg.startsWith('--category=')) entries.filter(e => e.rarity === arg.split('=')[1]).forEach(print);
else {
  const found = /^\d+$/.test(arg) ? entries.filter(e => e.id === Number(arg)) : entries.filter(e => norm(e.name).includes(norm(arg)));
  if (!found.length) console.log('Aucun Pokémon trouvé.');
  found.forEach(print);
}
