#!/usr/bin/env node
'use strict';
// =====================================================================
// SIMULATION de l'impact des mécaniques de type sur le taux de victoire des boss, et calcul
// des facteurs de calibrage à reporter dans boss-mechanics-config.js. N'écrit RIEN.
//   node simulate-bosses.js                     # 20 000 parties solo (mode normal)
//   node simulate-bosses.js --n=50000           # plus de parties (plus précis, plus long)
//   node simulate-bosses.js --seed=42           # résultat reproductible
//   node simulate-bosses.js --coop=3            # simule aussi le mode coop à 3 joueurs
//   node simulate-bosses.js --skill=0.7         # le joueur choisit la meilleure option 70 % du temps
//   node simulate-bosses.js --target=0.5        # calibre --skill pour que le win rate actuel de la
//                                               # difficulté --target-difficulty (défaut moyen) soit 50 %
//   node simulate-bosses.js --json=sim.json     # sauvegarde le détail
// Fidélité : charge une COPIE TEMPORAIRE du vrai server.js (supprimée à la fin) et appelle ses
// vraies fonctions de tirage (rareté, pity, effets, shiny) et le VRAI calcul de bonus
// (BOSS_MECHANICS.evaluateTeam) — rien n'est recopié. Tirages par partie : 6 tours, pity actif,
// sans objet de départ ni événements de route (Double ou rien, Shiny event, Méga-Gemme, Bonbon XP,
// Métamorph : non simulés). Niveau du joueur : --skill = probabilité de prendre l'option qui vaut
// le plus de points (0.5 = hasard pur ; un vrai joueur reconnaît les Pokémon). Sans calibrage le
// win rate simulé est bien plus bas que celui d'un vrai joueur : utiliser --target (ou --skill).
// =====================================================================
const fs = require('fs');
const path = require('path');

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v === undefined ? true : v];
}));
const N = Math.max(1000, parseInt(args.n, 10) || 20000);
const COOP = parseInt(args.coop, 10) || 0;
const SEED = args.seed !== undefined ? parseInt(args.seed, 10) : null;
const TARGET = args.target !== undefined ? parseFloat(args.target) : null;
const TARGET_DIFFICULTY = typeof args['target-difficulty'] === 'string' ? args['target-difficulty'] : 'moyen';
let SKILL = args.skill !== undefined ? parseFloat(args.skill) : 0.5;

// PRNG seedé (le serveur utilise Math.random) : résultats reproductibles avec --seed.
if (SEED !== null) {
  let a = SEED >>> 0;
  Math.random = () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const TMP = path.join(__dirname, 'server.__sim.js');
fs.writeFileSync(TMP, fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8') + `
global.__sim = { BOSSES, BOSS_MECHANICS, pickPlayerTurnOptions, teamMonFromReward, PITY_GOOD_RARITIES, MAX_TURNS, computeCoopTeamRequiredPoints };
`);
process.env.PORT = String(20000 + Math.floor(Math.random() * 20000));
process.on('exit', () => { try { fs.unlinkSync(TMP); } catch (e) { /* ignore */ } });
const realLog = console.log;
console.log = () => {}; // coupe le bruit de démarrage du serveur
require(TMP);
console.log = realLog;
const S = global.__sim;
const { BOSSES, BOSS_MECHANICS: MECH } = S;

// ---- 1) Tirages réels : une équipe = 6 tours
function playOneTeam(mode, skill) {
  let pity = 0, raw = 0;
  const team = [];
  for (let turn = 0; turn < S.MAX_TURNS; turn++) {
    const opts = S.pickPlayerTurnOptions(false, pity, undefined, undefined, mode);
    const better = opts.haut.finalPoints >= opts.bas.finalPoints ? opts.haut : opts.bas;
    const worse = better === opts.haut ? opts.bas : opts.haut;
    const reward = Math.random() < skill ? better : worse;
    pity = S.PITY_GOOD_RARITIES.includes(reward.rarity) ? 0 : pity + 1;
    raw += reward.finalPoints;
    team.push(S.teamMonFromReward(reward));
  }
  return { raw, team };
}

const bosses = BOSSES.map(b => ({ ...b, ...MECH.describeBoss(b) }));
const t0 = Date.now();

// Calibrage optionnel du niveau du joueur : win rate ACTUEL (sans mécanique) de la difficulté cible = TARGET.
let skillNote = '';
if (TARGET !== null) {
  const targetIdx = bosses.map((b, i) => i).filter(i => bosses[i].difficulty === TARGET_DIFFICULTY);
  if (!targetIdx.length) { console.error(`Difficulté inconnue : ${TARGET_DIFFICULTY}`); process.exit(1); }
  const meanWR = skill => {
    const raws = Array.from({ length: Math.min(N, 8000) }, () => playOneTeam('normal', skill).raw);
    return targetIdx.reduce((s, bi) => s + raws.filter(r => r >= bosses[bi].requiredPoints).length / raws.length, 0) / targetIdx.length;
  };
  let lo = 0.5, hi = 1;
  if (meanWR(hi) < TARGET) { SKILL = 1; skillNote = `⚠ même un joueur parfait (skill 1) n'atteint pas ${(TARGET * 100).toFixed(0)} % sur « ${TARGET_DIFFICULTY} » sans objets/événements : skill = 1.`; }
  else if (meanWR(lo) >= TARGET) { SKILL = 0.5; skillNote = 'skill = 0.5 (hasard pur) atteint déjà la cible.'; }
  else { for (let k = 0; k < 12; k++) { const mid = (lo + hi) / 2; if (meanWR(mid) < TARGET) lo = mid; else hi = mid; } SKILL = Math.round(((lo + hi) / 2) * 1000) / 1000; skillNote = `skill calibré à ${SKILL} pour viser ${(TARGET * 100).toFixed(0)} % sur « ${TARGET_DIFFICULTY} ».`; }
}
const teams = Array.from({ length: N }, () => playOneTeam('normal', SKILL));
const rawArr = Float64Array.from(teams.map(t => t.raw));

// withBonus[b][i] = score final de la partie i contre le boss b, AVEC mécanique.
const withBonus = bosses.map(b => Float64Array.from(teams.map(t => t.raw + MECH.evaluateTeam(t.team, b, t.raw).total)));
const inflation = bosses.map((b, bi) => withBonus[bi].reduce((s, v, i) => s + v, 0) / rawArr.reduce((s, v) => s + v, 0));

const round10 = v => Math.round(v / 10) * 10; // même arrondi que le serveur
function winRate(arr, threshold) { let w = 0; for (let i = 0; i < arr.length; i++) if (arr[i] >= threshold) w++; return w / arr.length; }
const diffs = [...new Set(bosses.map(b => b.difficulty))];
const idxByDiff = Object.fromEntries(diffs.map(d => [d, bosses.map((b, i) => i).filter(i => bosses[i].difficulty === d)]));

const baseWR = bosses.map(b => winRate(rawArr, b.requiredPoints));
const factorWR = (bossIdxs, f) => bossIdxs.reduce((s, bi) => s + winRate(withBonus[bi], round10(bosses[bi].requiredPoints * f)), 0) / bossIdxs.length;

// ---- 2) Facteur par difficulté : f tel que le win rate MOYEN avec mécanique = win rate MOYEN actuel
const result = { n: N, seed: SEED, skill: SKILL, perDifficulty: {}, perBoss: [] };
for (const d of diffs) {
  const idxs = idxByDiff[d];
  const target = idxs.reduce((s, bi) => s + baseWR[bi], 0) / idxs.length;
  let lo = 0.8, hi = 1.6;
  for (let k = 0; k < 40; k++) { const mid = (lo + hi) / 2; if (factorWR(idxs, mid) > target) lo = mid; else hi = mid; }
  const f = Math.round(((lo + hi) / 2) * 1000) / 1000;
  result.perDifficulty[d] = {
    bosses: idxs.length, baselineWinRate: target, winRateWithMechanicNoCalibration: factorWR(idxs, 1),
    suggestedFactor: f, winRateWithSuggestedFactor: factorWR(idxs, f),
    meanInflation: idxs.reduce((s, bi) => s + inflation[bi], 0) / idxs.length
  };
}

// ---- 3) Correction par boss : facteur individuel qui restitue EXACTEMENT son win rate actuel
bosses.forEach((b, bi) => {
  const f = result.perDifficulty[b.difficulty].suggestedFactor;
  let fb = null;
  if (baseWR[bi] > 0.02 && baseWR[bi] < 0.98) {
    const sorted = Float64Array.from(withBonus[bi]).sort();
    const q = sorted[Math.min(sorted.length - 1, Math.floor((1 - baseWR[bi]) * sorted.length))]; // seuil qui garde baseWR[bi] de victoires
    fb = q / b.requiredPoints;
  }
  result.perBoss.push({
    id: b.id, name: b.name, difficulty: b.difficulty, types: b.types, counterType: b.counterType,
    requiredPoints: b.requiredPoints, baselineWinRate: baseWR[bi], inflation: inflation[bi],
    winRateNoCalibration: winRate(withBonus[bi], b.requiredPoints),
    winRateWithDifficultyFactor: winRate(withBonus[bi], round10(b.requiredPoints * f)),
    individualFactor: fb, suggestedCorrection: fb === null ? null : Math.round((fb / f) * 100) / 100
  });
});

// ---- 4) Coop (optionnel) : somme de COOP équipes vs objectif d'équipe, boss d'attaque non simulé
if (COOP >= 2) {
  const games = Math.floor(N / COOP);
  const coopRaw = [], coopWith = bosses.map(() => new Float64Array(games));
  for (let g = 0; g < games; g++) {
    const grp = teams.slice(g * COOP, (g + 1) * COOP);
    coopRaw.push(grp.reduce((s, t) => s + t.raw, 0));
    bosses.forEach((b, bi) => { coopWith[bi][g] = grp.reduce((s, t) => s + t.raw + MECH.evaluateTeam(t.team, b, t.raw).total, 0); });
  }
  result.coop = { players: COOP, games, perDifficulty: {} };
  for (const d of diffs) {
    const idxs = idxByDiff[d];
    const req = bi => S.computeCoopTeamRequiredPoints({ requiredPoints: round10(bosses[bi].requiredPoints) }, COOP);
    const base = idxs.reduce((s, bi) => s + winRate(Float64Array.from(coopRaw), req(bi)), 0) / idxs.length;
    const wr = f => idxs.reduce((s, bi) => s + winRate(coopWith[bi], S.computeCoopTeamRequiredPoints({ requiredPoints: round10(bosses[bi].requiredPoints * f) }, COOP)), 0) / idxs.length;
    let lo = 0.8, hi = 1.6;
    for (let k = 0; k < 40; k++) { const mid = (lo + hi) / 2; if (wr(mid) > base) lo = mid; else hi = mid; }
    result.coop.perDifficulty[d] = { baselineWinRate: base, winRateWithMechanicNoCalibration: wr(1), suggestedFactor: Math.round(((lo + hi) / 2) * 1000) / 1000 };
  }
}

// ---- Affichage
const pct = v => (v * 100).toFixed(1).padStart(5) + ' %';
console.log(`Simulation : ${N} parties solo (mode normal), ${bosses.length} boss, ${((Date.now() - t0) / 1000).toFixed(1)} s${SEED !== null ? ', seed ' + SEED : ''}`);
console.log(`Niveau du joueur (skill) : ${SKILL}${skillNote ? ' — ' + skillNote : ''}`);
console.log(`Score moyen d'une équipe sans mécanique : ${Math.round(rawArr.reduce((s, v) => s + v, 0) / N)} pts\n`);
console.log('Par difficulté (moyenne sur les boss de la difficulté) :');
console.log('  difficulté  win rate actuel | avec mécanique, facteur 1 | facteur suggéré | win rate avec facteur | inflation du score');
for (const d of diffs) {
  const r = result.perDifficulty[d];
  console.log(`  ${d.padEnd(10)}  ${pct(r.baselineWinRate)}        |  ${pct(r.winRateWithMechanicNoCalibration)}                  |  ${r.suggestedFactor.toFixed(3)}          |  ${pct(r.winRateWithSuggestedFactor)}              |  +${((r.meanInflation - 1) * 100).toFixed(1)} %`);
}
const all = result.perBoss;
const unreliable = diffs.filter(d => result.perDifficulty[d].baselineWinRate < 0.02 || result.perDifficulty[d].baselineWinRate > 0.98);
if (unreliable.length) console.log(`\n⚠ Win rate actuel < 2 % ou > 98 % pour : ${unreliable.join(', ')} — le facteur suggéré y est peu fiable (trop peu de victoires/défaites simulées).`);
const meanBase = all.reduce((s, b) => s + b.baselineWinRate, 0) / all.length;
console.log(`\nWin rate moyen actuel (tous boss) : ${pct(meanBase)}`);
console.log(`Écart individuel après facteur de difficulté (|win rate boss − win rate actuel du boss|) : moyen ${pct(all.reduce((s, b) => s + Math.abs(b.winRateWithDifficultyFactor - b.baselineWinRate), 0) / all.length)}, max ${pct(Math.max(...all.map(b => Math.abs(b.winRateWithDifficultyFactor - b.baselineWinRate))))}`);

const corr = all.filter(b => b.suggestedCorrection !== null && Math.abs(b.suggestedCorrection - 1) >= 0.02).sort((a, b) => Math.abs(b.suggestedCorrection - 1) - Math.abs(a.suggestedCorrection - 1));
console.log(`\nCorrections par boss suggérées (|écart| ≥ 2 %, optionnelles) : ${corr.length} sur ${all.length}`);
corr.slice(0, 12).forEach(b => console.log(`  ${String(b.id).padStart(4)} ${b.name.padEnd(14)} ${b.types.join('/').padEnd(14)} contré par ${String(b.counterType).padEnd(8)} win rate ${pct(b.baselineWinRate)} -> ${pct(b.winRateWithDifficultyFactor)}  correction ×${b.suggestedCorrection.toFixed(2)}`));
if (result.coop) {
  console.log(`\nCoop (${COOP} joueurs, ${result.coop.games} parties ; attaque du boss non simulée) :`);
  for (const d of diffs) { const r = result.coop.perDifficulty[d]; console.log(`  ${d.padEnd(10)} win rate actuel ${pct(r.baselineWinRate)} | avec mécanique facteur 1 ${pct(r.winRateWithMechanicNoCalibration)} | facteur suggéré ${r.suggestedFactor.toFixed(3)}`); }
}
console.log('\nÀ reporter dans boss-mechanics-config.js (APRÈS relecture — rien n\'est appliqué automatiquement) :');
console.log('const SCALE_BY_DIFFICULTY = {');
diffs.forEach(d => console.log(`  ${/^[a-z]+$/.test(d) ? d : `'${d}'`}: ${result.perDifficulty[d].suggestedFactor.toFixed(3)},`));
console.log('};');
console.log('// Optionnel, par boss (id de dex -> facteur multiplicatif en plus du facteur de difficulté) :');
console.log('const SCALE_BY_BOSS = {' + (corr.length ? '\n' + corr.map(b => `  ${b.id}: ${b.suggestedCorrection.toFixed(2)}, // ${b.name}`).join('\n') + '\n' : '') + '};');
if (args.json) { fs.writeFileSync(path.resolve(args.json), JSON.stringify(result, null, 2)); console.log(`\nDétail sauvegardé : ${args.json}`); }
process.exit(0);
