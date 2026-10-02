#!/usr/bin/env node
'use strict';
// Debug de la Mouche : poids, features et probabilités de choix sur quelques tirages.
//   node debug-fly.js [--draws 5] [--seed 1] [--train 3000] [--state brain.json] [--synthetic]
// Sans --state, la Mouche est entraînée --train parties contre un joueur « mixte » simulé (0 = cerveau vierge).
// --state : fichier JSON contenant l'état du modèle (colonne weights de fly_brain, + games_played/wins/losses/draws).
const fs = require('fs');
const cfg = require('./fly-config');
const { LinearPolicy, FEATURE_NAMES, mulberry32, bestPossibleScore, computeReward } = require('./fly-agent');
const { createEnv, HUMAN_POLICIES } = require('./fly-env');

const args = process.argv.slice(2);
const num = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? Number(args[i + 1]) : d; };
const str = n => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : null; };
const DRAWS = num('draws', 5), SEED = num('seed', 1), TRAIN = num('train', 3000);

const env = createEnv({ rng: mulberry32(SEED * 31), rarities: cfg.RARITIES, useReal: !args.includes('--synthetic') });
const policy = new LinearPolicy({ seed: SEED });

if (str('state')) {
  policy.setState(JSON.parse(fs.readFileSync(str('state'), 'utf8')));
  console.log(`Cerveau chargé depuis ${str('state')}`);
} else if (TRAIN > 0) {
  const rng = mulberry32(SEED + 7), human = HUMAN_POLICIES.mixed;
  for (let g = 0; g < TRAIN; g++) {
    let fly = 0, hum = 0; const traj = [], fin = [];
    for (let turn = 1; turn <= cfg.TURNS; turn++) {
      const o = env.drawOptions(); fin.push([o[0].finalPoints, o[1].finalPoints]);
      const d = policy.choose({ turn, ownScore: fly, oppScore: hum, options: o.map(x => ({ basePoints: x.basePoints, rarity: x.rarity, shiny: x.shiny })) });
      traj.push(d); fly += o[d.index].finalPoints; hum += o[human(o, rng)].finalPoints;
    }
    const { reward, result } = computeReward({ flyScore: fly, humanScore: hum, bestPossible: bestPossibleScore(fin) });
    policy.learn(traj, reward, { result });
  }
  console.log(`Cerveau entraîné : ${TRAIN} parties simulées vs « mixte » (${env.source})`);
}

const s = policy.getState();
console.log(`\nParties ${s.games_played} | V ${s.wins} · D ${s.losses} · N ${s.draws} | baseline ${s.baseline.toFixed(3)} | T = ${policy.temperature().toFixed(3)}`);
console.log('\nPOIDS');
FEATURE_NAMES.forEach((n, i) => console.log(`  ${n.padEnd(11)} ${s.weights[i].toFixed(3).padStart(8)}`));

console.log(`\nTIRAGES (${DRAWS}) — la Mouche ne voit que basePoints / rareté / shiny / tour / scores`);
const rng = mulberry32(SEED + 99);
let fly = 0, hum = 0;
for (let i = 0; i < DRAWS; i++) {
  const turn = (i % cfg.TURNS) + 1;
  if (turn === 1) { fly = 0; hum = 0; }
  const o = env.drawOptions();
  const obs = { turn, ownScore: fly, oppScore: hum, options: o.map(x => ({ basePoints: x.basePoints, rarity: x.rarity, shiny: x.shiny })) };
  const ev = policy.evaluate(obs);
  const pick = ev.probs[1] > ev.probs[0] ? 1 : 0;
  console.log(`\n#${i + 1}  tour ${turn}  score Mouche ${fly} · humain ${hum}  (T=${ev.temperature.toFixed(2)})`);
  ['HAUT', 'BAS'].forEach((side, k) => {
    const x = o[k];
    console.log(`  ${side}${pick === k ? ' ◀' : '  '} ${x.rarity.padEnd(18)} base ${String(x.basePoints).padStart(4)}${x.shiny ? ' ✨' : '   '}  p=${(ev.probs[k] * 100).toFixed(1).padStart(5)} %   [caché : effet ${x.effectName} ×${x.multiplier} -> ${x.finalPoints}]`);
    console.log('       features: ' + FEATURE_NAMES.map((n, j) => `${n}=${ev.phis[k][j].toFixed(2)}`).join(' '));
  });
  const idx = policy.choose(obs).index;
  fly += o[idx].finalPoints; hum += o[HUMAN_POLICIES.mixed(o, rng)].finalPoints;
}
