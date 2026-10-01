#!/usr/bin/env node
'use strict';
// Debug des mécaniques de type des boss.
//   node debug-boss.js rayquaza                   # par nom (sans accent/casse, sous-chaîne) — FR du jeu
//   node debug-boss.js 384                        # par id de dex
//   node debug-boss.js 384 --team=6,10034,699,134 # équipe d'exemple (ids de dex ; défaut : 6 Pokémon variés)
//   node debug-boss.js --list                     # liste des 104 boss avec types et type à contrer
// Lit data/*.json et la liste BOSSES de server.js ; ne démarre PAS le serveur.
const fs = require('fs');
const path = require('path');
const config = require('./boss-mechanics-config');
const { loadTypeData, createBossMechanics } = require('./boss-mechanics');
const stats = require('./stats');

const norm = s => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const args = process.argv.slice(2);
const flags = Object.fromEntries(args.filter(a => a.startsWith('--')).map(a => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v === undefined ? true : v]; }));
const query = args.find(a => !a.startsWith('--'));

let entries, M;
try {
  entries = stats.loadEntries();
  M = createBossMechanics({
    ...loadTypeData(), config, shinyMultiplier: 1.5,
    poolIds: entries.filter(e => e.id < 10000).map(e => e.id)
  });
} catch (e) { console.error('Erreur : ' + e.message); process.exit(1); }

const src = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
const bosses = [...src.matchAll(/\{ id: (\d+), name: '([^']+)', requiredPoints: (\d+), difficulty: '([^']+)' \}/g)]
  .map(m => ({ id: +m[1], name: m[2], difficulty: m[4] }));
const L = t => config.TYPE_LABELS_FR[t] || t;
const byId = Object.fromEntries(entries.map(e => [e.id, e]));

if (flags.list) {
  bosses.forEach(b => { const d = M.describeBoss(b); console.log(`${String(b.id).padStart(4)} ${b.name.padEnd(16)} ${b.difficulty.padEnd(9)} ${d.types.map(L).join('/').padEnd(18)} faiblesses: ${d.weaknesses.map(w => L(w.type) + (w.multiplier >= 4 ? '×4' : '')).join(', ').padEnd(48)} contré par: ${d.counterType ? L(d.counterType) : '—'}`); });
  process.exit(0);
}
if (!query) { console.log('Usage : node debug-boss.js <nom|id> [--team=id,id,...]  |  --list'); process.exit(0); }

const found = /^\d+$/.test(query)
  ? [bosses.find(b => b.id === +query) || (byId[+query] && { id: +query, name: byId[+query].name, difficulty: '(pas un boss du jeu)' })].filter(Boolean)
  : bosses.filter(b => norm(b.name).includes(norm(query)));
if (!found.length) { console.log('Aucun boss trouvé.'); process.exit(0); }

const DEFAULT_TEAM = [6, 134, 445, 700, 130, 248]; // Dracaufeu, Aquali, Carchacrok, Nymphali, Léviator, Tyranocif
const teamIds = typeof flags.team === 'string' ? flags.team.split(',').map(Number) : DEFAULT_TEAM;

for (const b of found) {
  const info = { ...b, ...M.describeBoss(b) };
  console.log(`\n${b.name} (#${b.id}) — ${b.difficulty}`);
  console.log(`Types : ${info.types.map(L).join(' / ')}`);
  console.log(`Faiblesses : ${info.weaknesses.map(w => `${L(w.type)} ×${w.multiplier}`).join(', ') || 'aucune'}`);
  console.log(`Type à contrer : ${info.counterType ? L(info.counterType) : '—'}` +
    (config.COUNTER_TYPE_OVERRIDES[b.id] ? ' (override manuel)' : info.weaknesses.some(w => w.multiplier >= 4) ? ' (faiblesse ×4)' : ' (faiblesse ×2 la plus représentée dans le pool)'));
  console.log(`Calibrage de l'objectif : ×${(M.scaleFor(info, 'normal') ).toFixed(3)} (mode normal)`);

  const team = teamIds.map(id => { const e = byId[id]; if (!e) throw new Error(`Pokémon #${id} inconnu`); return { id, name: e.name, basePoints: e.basePoints, multiplier: 1 }; });
  const raw = team.reduce((s, m) => s + m.basePoints, 0);
  const ev = M.evaluateTeam(team, info, raw);
  console.log(`\nÉquipe d'exemple (score brut ${raw} pts, traits neutres, sans shiny) :`);
  ev.perMon.forEach((m, i) => console.log(`  ${team[i].name.padEnd(16)} ${m.types.map(L).join('/').padEnd(16)} valeur ${String(m.value).padStart(4)}  meilleure efficacité ×${m.effectiveness}  -> bonus ×${m.multiplier} = ${m.bonus >= 0 ? '+' : ''}${m.bonus}`));
  const a = ev.affinity;
  console.log(`  Faiblesses : +${ev.weaknessTotal} pts`);
  console.log(`  Affinité ${a.counterType ? L(a.counterType) : '—'} : ${a.count} Pokémon -> ${a.rate ? '+' + a.rate * 100 + ' % du score brut = +' + a.bonus : 'aucun palier'}${a.nextTier ? ` (prochain palier : ${a.nextTier.min} Pokémon, +${a.nextTier.rate * 100} %)` : ''}`);
  console.log(`  TOTAL bonus de type : +${ev.total} pts -> score ${raw + ev.total}`);
}
