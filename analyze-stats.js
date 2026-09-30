#!/usr/bin/env node
'use strict';
// Analyse la distribution des BST des Pokémon ORDINAIRES (hors exceptions) et propose des seuils.
//   node analyze-stats.js
// Méthode : conserver les proportions de raretés du jeu actuel (avant ce système) — sur les
// 902 Pokémon ordinaires : Normal 26,4 % / Peu commun 26,6 % / Rare 32,0 % / Épique 15,0 % —
// en coupant la liste triée des BST aux quantiles correspondants (arrondis à 5).
const fs = require('fs');
const config = require('./stats-config');
const { ROSTER_FILE, STATS_FILE, computeBst } = require('./stats');

const TARGET_SHARES = { commun: 238 / 902, peu_commun: 240 / 902, rare: 289 / 902, epique: 135 / 902 };

const roster = JSON.parse(fs.readFileSync(ROSTER_FILE, 'utf8'));
if (!fs.existsSync(STATS_FILE)) { console.error(`Introuvable : ${STATS_FILE}. Lance d'abord node fetch-stats.js`); process.exit(1); }
const stats = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));

const ordinary = roster
  .filter(r => !config.getSpecialCategory(r.id) && stats[r.id])
  .map(r => ({ ...r, bst: computeBst(stats[r.id]) }))
  .sort((a, b) => a.bst - b.bst);
const n = ordinary.length;
const bsts = ordinary.map(o => o.bst);
const q = p => bsts[Math.min(n - 1, Math.floor(p * n))];
const round5 = v => Math.round(v / 5) * 5;

console.log(`Pokémon ordinaires : ${n} | BST min ${bsts[0]} (${ordinary[0].name}) | max ${bsts[n - 1]} (${ordinary[n - 1].name})`);
console.log(`Médiane ${q(0.5)} | Q1 ${q(0.25)} | Q3 ${q(0.75)} | P90 ${q(0.9)}\n`);

console.log('Histogramme (tranches de 50) :');
const buckets = {};
bsts.forEach(b => { const k = Math.floor(b / 50) * 50; buckets[k] = (buckets[k] || 0) + 1; });
for (const k of Object.keys(buckets).sort((a, b) => a - b)) {
  console.log(`  ${String(k).padStart(3)}-${String(+k + 49).padEnd(3)} ${String(buckets[k]).padStart(4)} ${'#'.repeat(Math.round(buckets[k] / 6))}`);
}

const cut1 = TARGET_SHARES.commun;
const cut2 = cut1 + TARGET_SHARES.peu_commun;
const cut3 = cut2 + TARGET_SHARES.rare;
const suggested = { commun: 0, peu_commun: round5(q(cut1)), rare: round5(q(cut2)), epique: round5(q(cut3)) };

function distribution(th) {
  const d = { commun: 0, peu_commun: 0, rare: 0, epique: 0 };
  const ordered = Object.entries(th).sort((a, b) => b[1] - a[1]);
  bsts.forEach(b => { for (const [cat, min] of ordered) if (b >= min) { d[cat]++; break; } });
  return d;
}
const show = (title, th) => {
  const d = distribution(th);
  console.log(`\n${title} : ${JSON.stringify(th)}`);
  for (const cat of Object.keys(d)) console.log(`  ${config.CATEGORY_LABELS[cat].padEnd(11)} ${String(d[cat]).padStart(4)} (${(d[cat] / n * 100).toFixed(1)} %, cible ${(TARGET_SHARES[cat] * 100).toFixed(1)} %)`);
};
show('Seuils actuels (stats-config.js)', config.CATEGORY_THRESHOLDS);
show('Seuils proposés', suggested);

const near = (min) => ordinary.filter(o => Math.abs(o.bst - min) <= 5).map(o => `${o.name}(${o.bst})`);
console.log('\nPokémon à ±5 BST des seuils proposés (cas limites) :');
for (const cat of ['peu_commun', 'rare', 'epique']) console.log(`  ${cat} ≥ ${suggested[cat]} : ${near(suggested[cat]).join(', ') || '—'}`);

console.log('\nÀ coller dans stats-config.js :');
console.log(`const CATEGORY_THRESHOLDS = { commun: 0, peu_commun: ${suggested.peu_commun}, rare: ${suggested.rare}, epique: ${suggested.epique} };`);
console.log('const THRESHOLDS_CALIBRATED = true;');
