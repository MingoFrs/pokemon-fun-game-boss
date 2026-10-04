#!/usr/bin/env node
'use strict';
// Validation du modèle « valeur par Pokémon » (la Mouche n'observe que identité + shiny + types).
//   node fly-validate.js [--policy value|mushroom] [--compare] [--seeds 12] [--eval 2000] [--max 6400] [--opp noisy|random|mixed] [--noise 0.15]
//                        [--types] [--set CLE=val,...] [--proxy] [--thresholds 330,450,520] [--server server.js]
// - Données : stats.loadEntries() du projet (lancé depuis la racine) ; sinon --proxy (PokeAPI, catégories approchées).
// - Tirages : les VRAIES fonctions de server.js (effets, shiny, RARITY_TABLE) via fly-real-env.js.
// - Joueur simulé : valeur perçue = BST × (1 + bruit gaussien σ) × (shiny ? ×1.5 : 1), PAS les points réels.
// - Marge d'erreur : IC 95 % sur les graines (chaque graine = entraînement indépendant, évaluation sur les mêmes tirages).
// - Calibration : nombre de parties d'échauffement pour ~50 % contre le joueur simulé -> WARMUP_GAMES.
const path = require('path');
const baseCfg = require('./fly-config');
const { ValuePolicy, mulberry32 } = require('./fly-value-policy');
const { MushroomPolicy } = require('./fly-mushroom-policy');
const { createRealDraws, loadProjectEntries } = require('./fly-real-env');
const { playSimulatedGame, simulatedHumanPick } = require('./fly-warmup');

const args = process.argv.slice(2);
const has = n => args.includes('--' + n);
const val = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
// --set CLE=valeur,CLE=valeur : surcharge de fly-config.js pour cette exécution (balayage de paramètres)
val('set', '').split(',').filter(Boolean).forEach(kv => { const [k, v] = kv.split('='); baseCfg[k] = v === 'true' ? true : v === 'false' ? false : (Number.isNaN(Number(v)) ? v : Number(v)); });
const POLICY = val('policy', 'value');
const makePolicy = (name, cfg, seed) => (name === 'mushroom' ? new MushroomPolicy({ config: cfg, seed }) : new ValuePolicy({ config: cfg, seed }));
const SEEDS = Number(val('seeds', 12)), EVAL = Number(val('eval', 2000)), MAX = Number(val('max', 6400));
const OPP = val('opp', 'noisy'), NOISE = Number(val('noise', baseCfg.WARMUP_HUMAN_NOISE));
const SERVER = path.resolve(val('server', 'server.js'));
const MILESTONES = [0, 10, 25, 50, 100, 150, 200, 250, 300, 400, 600, 800, 1600, 3200, 6400, 12800].filter(m => m <= MAX);
const GAMES_PER_DAY = Number(val('per-day', 10));

let data, source;
if (has('proxy')) {
  const th = val('thresholds', '330,450,520').split(',').map(Number);
  data = require('./fly-proxy-data').loadProxyEntries({ thresholds: th });
  source = `PROXY PokeAPI (stats + types réels ; seuils ${th.join('/')} supposés, listes d'exceptions reconstruites)`;
} else {
  data = loadProjectEntries(process.cwd());
  source = 'données du projet (stats.loadEntries + data/pokemon-stats.json)';
}
const bst = {}; data.entries.forEach(e => { bst[e.id] = e.bst; });
const gauss = rng => Math.sqrt(-2 * Math.log(1 - rng())) * Math.cos(2 * Math.PI * rng());

const humanPick = (opts, rng) => simulatedHumanPick(opts, bst, rng, { noise: NOISE, kind: OPP });

// Une partie complète = EXACTEMENT le code de l'échauffement de production (fly-warmup.js).
function playGame(policy, draws, rng, mode, cfg) {
  const r = playSimulatedGame({ policy, draw: () => draws.drawOptions(), typesById: data.typesById, bst, rng, config: cfg, learn: mode === 'train', human: { noise: NOISE, kind: OPP } });
  return r === 'win' ? 1 : r === 'draw' ? 0.5 : 0;
}

function runSeed(seed, useTypes, policyName = POLICY) {
  const cfg = { ...baseCfg, VALUE_USE_TYPES: useTypes };
  const policy = makePolicy(policyName, cfg, seed * 7 + 1);
  const trainRng = mulberry32(seed * 1009 + 3), trainHum = mulberry32(seed * 1013 + 5);
  const trainDraws = createRealDraws({ serverFile: SERVER, entries: data.entries, rng: trainRng, categoryOrder: data.categoryOrder, legendaryGroup: data.legendaryGroup });
  const out = []; let done = 0;
  for (const m of MILESTONES) {
    for (; done < m; done++) playGame(policy, trainDraws, trainHum, 'train', cfg);
    // évaluation figée : mêmes tirages / mêmes humains simulés pour toutes les variantes d'une même graine
    const er = mulberry32(900000 + seed), eh = mulberry32(910000 + seed);
    const ed = createRealDraws({ serverFile: SERVER, entries: data.entries, rng: er, categoryOrder: data.categoryOrder, legendaryGroup: data.legendaryGroup });
    let s = 0; for (let g = 0; g < EVAL; g++) s += playGame(policy, ed, eh, 'eval', cfg);
    out.push(s / EVAL);
  }
  return out;
}

// Références (sans apprentissage) : Mouche aléatoire / Mouche qui connaît le BST exact (plafond).
function reference(kind, seed) {
  const cfg = baseCfg;
  const er = mulberry32(900000 + seed), eh = mulberry32(910000 + seed);
  const ed = createRealDraws({ serverFile: SERVER, entries: data.entries, rng: er, categoryOrder: data.categoryOrder, legendaryGroup: data.legendaryGroup });
  let s = 0;
  for (let g = 0; g < 4000; g++) {
    let fly = 0, hum = 0;
    for (let t = 0; t < cfg.TURNS; t++) {
      const o = ed.drawOptions();
      const exact = x => bst[x.pokemonId] * (x.shiny ? 1.5 : 1);
      const i = kind === 'random' ? (er() < 0.5 ? 0 : 1) : (exact(o[1]) > exact(o[0]) ? 1 : 0);
      fly += o[i].finalPoints; hum += o[humanPick(o, eh)].finalPoints;
    }
    s += fly > hum ? 1 : fly === hum ? 0.5 : 0;
  }
  return s / 4000;
}

const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
const sd = a => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / Math.max(1, a.length - 1)); };
const ci = a => 1.96 * sd(a) / Math.sqrt(a.length);
const pc = x => (100 * x).toFixed(1).padStart(5);

console.log(`Source : ${source}`);
console.log(`Entrées : ${data.entries.length} Pokémon | tirages : vraies fonctions de ${path.basename(SERVER)} | adversaire simulé : ${OPP}${OPP === 'random' ? '' : ` (BST bruité σ=${NOISE})`}`);
console.log(`${SEEDS} graines, évaluation ${EVAL} parties/jalon, IC 95 %\n`);

const refs = { random: mean(Array.from({ length: 4 }, (_, i) => reference('random', i + 1))), exact: mean(Array.from({ length: 4 }, (_, i) => reference('exact', i + 1))) };
console.log(`Références : Mouche aléatoire ${pc(refs.random)} % | Mouche qui connaît le BST exact (plafond) ${pc(refs.exact)} %\n`);

if (has('compare')) {
  // Comparaison appariée : même graine, mêmes tirages d'entraînement et d'évaluation, même joueur simulé, même exploration.
  const t0 = Date.now();
  const A = Array.from({ length: SEEDS }, (_, s) => runSeed(s + 1, false, 'value'));
  const B = Array.from({ length: SEEDS }, (_, s) => runSeed(s + 1, false, 'mushroom'));
  console.log(`--- Comparaison valeur par Pokémon (tableau) vs corps pédonculé (${((Date.now() - t0) / 1000).toFixed(0)} s) ---`);
  console.log('parties | tableau (±IC95)  | corps pédonculé (±IC95) | différence appariée  corps pédonculé − tableau (IC95)');
  const diffs = [];
  MILESTONES.forEach((m, i) => {
    const a = A.map(r => r[i]), b = B.map(r => r[i]), d = b.map((x, k) => 100 * (x - a[k]));
    const lo = mean(d) - 1.96 * sd(d) / Math.sqrt(d.length), hi = mean(d) + 1.96 * sd(d) / Math.sqrt(d.length);
    diffs.push({ m, d: mean(d), lo, hi });
    console.log(`${String(m).padStart(6)}  | ${pc(mean(a))} ± ${(100 * ci(a)).toFixed(1).padStart(3)}    | ${pc(mean(b))} ± ${(100 * ci(b)).toFixed(1).padStart(3)}           | ${mean(d).toFixed(2).padStart(6)}  [${lo.toFixed(2)} ; ${hi.toFixed(2)}] ${lo > 0 ? '← meilleur' : hi < 0 ? '← moins bon' : ''}`);
  });
  const cross = c => crossing(MILESTONES.map((_, i) => mean(c.map(r => r[i]))), 0.5);
  console.log(`\nÉchauffement pour ~50 % : tableau ≈ ${cross(A)} | corps pédonculé ≈ ${cross(B)} parties`);
  const W0 = cross(B) ?? 0;
  const post = diffs.filter(x => x.m >= W0);
  console.log(`Différence moyenne après ${W0} parties (régime de fonctionnement) : ${mean(post.map(x => x.d)).toFixed(2)} points ; plateau tableau ${pc(Math.max(...MILESTONES.map((_, i) => mean(A.map(r => r[i])))))} %, corps pédonculé ${pc(Math.max(...MILESTONES.map((_, i) => mean(B.map(r => r[i])))))} %.`);
  process.exit(0);
}

const variants = has('types') ? [false, true] : [false];
const results = {};
for (const useTypes of variants) {
  const t0 = Date.now();
  results[useTypes] = Array.from({ length: SEEDS }, (_, s) => runSeed(s + 1, useTypes));
  console.log(`--- Modèle ${useTypes ? 'AVEC' : 'SANS'} types (${((Date.now() - t0) / 1000).toFixed(0)} s) ---`);
  console.log('parties d\'échauffement | victoires de la Mouche (moyenne ± IC95)  | jours à 10 parties/jour');
  MILESTONES.forEach((m, i) => {
    const col = results[useTypes].map(r => r[i]);
    console.log(`${String(m).padStart(10)}           | ${pc(mean(col))} % ± ${(100 * ci(col)).toFixed(1).padStart(4)}   (min ${pc(Math.min(...col))}, max ${pc(Math.max(...col))}) | ${(m / GAMES_PER_DAY).toFixed(1)} j`);
  });
  console.log();
}

// Calibration : première valeur de l'échauffement où la moyenne atteint 50 % (interpolation linéaire entre jalons).
function crossing(curve, target) {
  for (let i = 1; i < curve.length; i++) {
    if (curve[i] >= target && curve[i - 1] < target) {
      const f = (target - curve[i - 1]) / (curve[i] - curve[i - 1]);
      return Math.round(MILESTONES[i - 1] + f * (MILESTONES[i] - MILESTONES[i - 1]));
    }
  }
  return curve[0] >= target ? 0 : null;
}
const base = results[false];
const meanCurve = MILESTONES.map((_, i) => mean(base.map(r => r[i])));
const perSeed = base.map(r => crossing(r, 0.5)).filter(x => x !== null).sort((a, b) => a - b);
const W = crossing(meanCurve, 0.5);
console.log(`CALIBRATION (~50 %) : WARMUP_GAMES ≈ ${W === null ? 'non atteint' : W} (médiane par graine ${perSeed.length ? perSeed[Math.floor(perSeed.length / 2)] : '—'}, ` +
  `min ${perSeed[0] ?? '—'}, max ${perSeed[perSeed.length - 1] ?? '—'}, ${perSeed.length}/${SEEDS} graines atteignent 50 %)`);
const plateau = Math.max(...meanCurve);
const t90 = MILESTONES[meanCurve.findIndex(x => x >= refs.random + 0.9 * (plateau - refs.random))];
console.log(`Plateau ≈ ${pc(plateau)} % (plafond théorique ${pc(refs.exact)} %). 90 % du chemin plancher→plateau dès ~${t90} parties ` +
  `(≈ ${(t90 / GAMES_PER_DAY).toFixed(0)} jours à ${GAMES_PER_DAY} parties/jour).`);

if (has('types')) {
  // Verdict : seul compte le régime de fonctionnement, c'est-à-dire APRÈS l'échauffement (jalons >= WARMUP calibré).
  // Un gain avant l'échauffement ne sert à rien en production ; un gain/une perte se juge par graine (appariée).
  console.log('\nGAIN DES TYPES (différence appariée par graine, avec − sans, en points de %) :');
  MILESTONES.forEach((m, i) => {
    const diff = results[true].map((r, sd_) => 100 * (r[i] - results[false][sd_][i]));
    const lo = mean(diff) - 1.96 * sd(diff) / Math.sqrt(diff.length), hi = mean(diff) + 1.96 * sd(diff) / Math.sqrt(diff.length);
    console.log(`${String(m).padStart(10)} parties : ${mean(diff).toFixed(2).padStart(6)}  IC95 [${lo.toFixed(2)} ; ${hi.toFixed(2)}] ${lo > 0 ? '← gain' : hi < 0 ? '← perte' : ''}${W !== null && m < W ? '  (avant l\'échauffement : ignoré)' : ''}`);
  });
  const idx = MILESTONES.map((m, i) => i).filter(i => W === null || MILESTONES[i] >= W);
  const perSeedGain = results[true].map((r, s_) => 100 * mean(idx.map(i => r[i] - results[false][s_][i])));
  const g = mean(perSeedGain), half = ci(perSeedGain);
  console.log(`\nGain moyen après l'échauffement (jalons >= ${W ?? 0}) : ${g.toFixed(2)} points ± ${half.toFixed(2)} (IC95).`);
  console.log(g - half > 0 ? 'Verdict : gain démontré -> VALUE_USE_TYPES: true.' : 'Verdict : aucun gain démontré en régime de fonctionnement -> garder VALUE_USE_TYPES: false.');
}
