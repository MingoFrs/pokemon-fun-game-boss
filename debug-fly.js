#!/usr/bin/env node
'use strict';
// Debug du cerveau de la Mouche (modèle « valeur par Pokémon ») : valeurs apprises, observation et probabilités de
// choix sur quelques tirages RÉELS. Outil LOCAL : jamais importé par server.js ni envoyé au client (test-fly.js vérifie).
//   node debug-fly.js                       cerveau neuf + échauffement (WARMUP_GAMES), depuis la racine du projet
//   node debug-fly.js --state brain.json    cerveau exporté de Supabase (voir ci-dessous), sans échauffement
//   node debug-fly.js --warmup 500 --draws 8 --seed 3 --top 10 [--proxy] [--server server.js]
// Export du cerveau réel (SQL Editor de Supabase) -> enregistrer le résultat dans brain.json :
//   select weights || jsonb_build_object('games_played',games_played,'wins',wins,'losses',losses,'draws',draws) from fly_brain;
const fs = require('fs');
const path = require('path');
const cfg = require('./fly-config');
const { ValuePolicy, mulberry32 } = require('./fly-value-policy');
const { runWarmup } = require('./fly-warmup');
const { createRealDraws, loadProjectEntries } = require('./fly-real-env');

const args = process.argv.slice(2);
const has = n => args.includes('--' + n);
const val = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const SEED = Number(val('seed', 1)), DRAWS = Number(val('draws', 5)), TOP = Number(val('top', 8));
const f1 = x => x.toFixed(1), f3 = x => x.toFixed(3);

const data = has('proxy') ? require('./fly-proxy-data').loadProxyEntries() : loadProjectEntries(process.cwd());
const byId = {}; data.entries.forEach(e => { byId[e.id] = e; });
const bst = {}; data.entries.forEach(e => { bst[e.id] = e.bst; });
const server = path.resolve(val('server', 'server.js'));
const mkDraws = rng => createRealDraws({ serverFile: server, entries: data.entries, rng, categoryOrder: data.categoryOrder, legendaryGroup: data.legendaryGroup });

const policy = new ValuePolicy({ seed: SEED });
let origin;
if (has('state')) { policy.setState(JSON.parse(fs.readFileSync(val('state'), 'utf8'))); origin = `fichier ${val('state')}`; }
else {
  const n = Number(val('warmup', cfg.WARMUP_GAMES));
  const d = mkDraws(mulberry32(SEED * 31 + 1));
  const r = runWarmup({ policy, draw: () => d.drawOptions(), bst, typesById: data.typesById, games: n, seed: SEED });
  origin = `cerveau neuf + ${n} parties d'échauffement simulées (taux de victoire moyen pendant l'échauffement ≈ ${Math.round(100 * r.winRate)} %)`;
}

const s = policy.getState();
console.log(`\n=== CERVEAU : ${origin} ===`);
console.log(`parties vécues ${s.games_played} (victoires Mouche ${s.wins}, Humanité ${s.losses}, nuls ${s.draws}) | échauffement ${s.warmup_games} | ` +
  `température ${f3(policy.temperature())} (plancher ${cfg.VALUE_TEMP_FLOOR}) | moyenne globale ${f1(s.global[0])} pts sur ${s.global[1]} observations`);
const known = Object.entries(s.ids).map(([id, [mean, n]]) => ({ id: Number(id), mean, n, e: byId[id] })).filter(k => k.e);
console.log(`Pokémon connus : ${known.length}/${data.entries.length} | types utilisés comme a priori : ${cfg.VALUE_USE_TYPES ? 'oui' : 'non'}`);
const corr = (() => { const xs = known.map(k => k.mean), ys = known.map(k => k.e.basePoints); const mx = xs.reduce((a, b) => a + b, 0) / xs.length, my = ys.reduce((a, b) => a + b, 0) / ys.length;
  const c = xs.reduce((a, x, i) => a + (x - mx) * (ys[i] - my), 0); return c / Math.sqrt(xs.reduce((a, x) => a + (x - mx) ** 2, 0) * ys.reduce((a, y) => a + (y - my) ** 2, 0)); })();
console.log(`Corrélation valeur apprise / points de base réels (Pokémon connus) : ${Number.isFinite(corr) ? corr.toFixed(3) : 'n/a'}`);
const row = k => `  #${String(k.id).padStart(4)} ${(k.e.name || '').padEnd(14)} ${k.e.rarity.padEnd(17)} appris ${f1(k.mean).padStart(6)} | réel ${String(k.e.basePoints).padStart(4)} | vu ${k.n}×`;
const sorted = known.slice().sort((a, b) => b.mean - a.mean);
console.log(`\nLes ${TOP} Pokémon que la Mouche estime le plus :`); sorted.slice(0, TOP).forEach(k => console.log(row(k)));
console.log(`Les ${TOP} qu'elle estime le moins :`); sorted.slice(-TOP).forEach(k => console.log(row(k)));

console.log(`\n=== ${DRAWS} TIRAGES RÉELS (vraies fonctions de server.js) ===`);
console.log('Observation = identité + shiny + types. Les colonnes « caché » (points, effet) ne sont PAS vues avant le choix.\n');
const d = mkDraws(mulberry32(SEED * 977 + 5));
let agree = 0;
for (let k = 0; k < DRAWS; k++) {
  const o = d.drawOptions();
  const obs = { turn: 1 + (k % cfg.TURNS), ownScore: 0, oppScore: 0, options: o.map(x => ({ pokemonId: x.pokemonId, shiny: x.shiny, types: data.typesById[x.pokemonId] || [] })) };
  const ev = policy.evaluate(obs);
  const pick = ev.probs[1] > ev.probs[0] ? 1 : 0, best = o[1].finalPoints > o[0].finalPoints ? 1 : 0;
  agree += pick === best;
  console.log(`Tirage ${k + 1} (tour ${obs.turn}/${cfg.TURNS}, température ${f3(ev.temperature)})`);
  ['HAUT', 'BAS'].forEach((name, i) => {
    const x = o[i];
    console.log(`  ${name.padEnd(4)} #${String(x.pokemonId).padStart(4)} ${(x.name || '').padEnd(14)}${x.shiny ? '✨' : '  '} types ${(obs.options[i].types || []).join('/').padEnd(16)}` +
      ` | valeur estimée ${f1(ev.values[i] * cfg.BASEPOINTS_SCALE).padStart(6)}  P=${ev.probs[i].toFixed(2)}${i === pick ? '  <- argmax' : '          '}` +
      ` | caché: ${x.rarity} base ${x.basePoints} × ${x.multiplier} (${x.effectName}) = ${x.finalPoints}`);
  });
  console.log();
}
console.log(`L'argmax coïncide avec l'option aux points finaux les plus élevés : ${agree}/${DRAWS} (les effets cachés l'en empêchent parfois).`);
