#!/usr/bin/env node
'use strict';
// Entraîne la Mouche contre des joueurs simulés et trace son taux de victoire.
//   node fly-simulate.js [--games 6000] [--eval 5000] [--seed 1] [--block 500] [--synthetic] [--poison]
// Critère de réussite (exit 1 sinon), par adversaire (random / greedy / mixed), apprentissage coupé :
//   - argmax de la politique apprise >= référence « glouton sur ce que la Mouche voit » − 2 pts (convergence)
//   - politique déployée (tirage softmax, T plancher) >= référence − 5 pts
//   - politique déployée >= taux d'un joueur aléatoire contre ce même adversaire + 5 pts
const cfg = require('./fly-config');
const { LinearPolicy, mulberry32, bestPossibleScore, computeReward, outcomeFor } = require('./fly-agent');
const { createEnv, HUMAN_POLICIES, REFERENCE_VISIBLE } = require('./fly-env');

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf('--' + name); return i >= 0 ? Number(args[i + 1]) : def; };
const GAMES = opt('games', 6000), EVAL = opt('eval', 5000), SEED = opt('seed', 1), BLOCK = opt('block', 500);
const MARGIN_ARGMAX = 0.02;    // qualité de la décision apprise (argmax) vs plafond « glouton-visible »
const MARGIN_DEPLOYED = 0.05;  // idem en jeu réel (tirage softmax à T plancher : coût d'exploration résiduel)

// Une partie complète. flyAgent : { policy, learn } ou { fixed: fn(options, rng) } (référence).
function playGame(env, humanFn, flyAgent, rng, { learn }) {
  let fly = 0, human = 0;
  const traj = [], turnsFinal = [];
  let agree = 0;
  for (let turn = 1; turn <= cfg.TURNS; turn++) {
    const opts = env.drawOptions();
    turnsFinal.push([opts[0].finalPoints, opts[1].finalPoints]);
    // La Mouche ne reçoit QUE la whitelist d'observation ; décision AVANT celle de l'humain.
    let fi;
    if (flyAgent.fixed) fi = flyAgent.fixed(opts, rng);
    else {
      const obs = { turn, ownScore: fly, oppScore: human, options: opts.map(o => ({ basePoints: o.basePoints, rarity: o.rarity, shiny: o.shiny })) };
      const d = flyAgent.policy.choose(obs, { greedy: !!flyAgent.greedyEval });
      traj.push(d); fi = d.index;
      if (REFERENCE_VISIBLE(opts, () => 0.5) === d.index || (opts[0].basePoints * (opts[0].shiny ? 1.5 : 1)) === (opts[1].basePoints * (opts[1].shiny ? 1.5 : 1))) agree++;
    }
    const hi = humanFn(opts, rng);
    fly += opts[fi].finalPoints; human += opts[hi].finalPoints;
  }
  const result = outcomeFor(fly, human);
  if (learn && flyAgent.policy) {
    const { reward } = computeReward({ flyScore: fly, humanScore: human, bestPossible: bestPossibleScore(turnsFinal) }, cfg);
    flyAgent.policy.learn(traj, reward, { result });
  }
  return { result, agree };
}

// Taux de victoire (nul = 0.5) sur n parties.
function winRate(env, humanFn, agent, rng, n, learn) {
  let pts = 0, agree = 0;
  for (let i = 0; i < n; i++) {
    const r = playGame(env, humanFn, agent, rng, { learn });
    pts += r.result === 'win' ? 1 : r.result === 'draw' ? 0.5 : 0;
    agree += r.agree;
  }
  return { rate: pts / n, agreement: agree / (n * cfg.TURNS) };
}

const bar = v => '█'.repeat(Math.round(v * 40)).padEnd(40, '·');
let failed = false;
const env = createEnv({ rng: mulberry32(SEED * 7919), rarities: cfg.RARITIES, useReal: !args.includes('--synthetic') });
console.log(`Source des tirages : ${env.source} | parties d'entraînement ${GAMES}, évaluation ${EVAL}, seed ${SEED}\n`);

for (const name of ['random', 'greedy', 'mixed']) {
  const human = HUMAN_POLICIES[name];
  const rng = mulberry32(SEED * 104729 + name.length);
  const ref = winRate(env, human, { fixed: REFERENCE_VISIBLE }, rng, 20000, false).rate;
  const rnd = winRate(env, human, { fixed: HUMAN_POLICIES.random }, rng, 20000, false).rate;
  const omni = winRate(env, human, { fixed: HUMAN_POLICIES.greedy }, rng, 20000, false).rate;

  const policy = new LinearPolicy({ seed: SEED });
  console.log(`=== Adversaire : ${name} ===  (aléatoire ${(rnd * 100).toFixed(1)}% | glouton-visible ${(ref * 100).toFixed(1)}% | glouton-omniscient ${(omni * 100).toFixed(1)}%)`);
  for (let done = 0; done < GAMES; done += BLOCK) {
    const r = winRate(env, human, { policy }, rng, BLOCK, true);
    console.log(`  parties ${String(done + BLOCK).padStart(6)}  T=${policy.temperature().toFixed(2)}  victoire ${(r.rate * 100).toFixed(1).padStart(5)}%  accord-glouton ${(r.agreement * 100).toFixed(0).padStart(3)}%  ${bar(r.rate)}`);
  }
  const ev = winRate(env, human, { policy }, rng, EVAL, false);
  const evG = winRate(env, human, { policy, greedyEval: true }, rng, EVAL, false);
  console.log(`  (diagnostic argmax : ${(evG.rate * 100).toFixed(1)}%)`);
  const ok = evG.rate >= ref - MARGIN_ARGMAX && ev.rate >= ref - MARGIN_DEPLOYED && ev.rate >= rnd + 0.05;
  if (!ok) failed = true;
  console.log(`  ÉVAL (sans apprentissage) : ${(ev.rate * 100).toFixed(1)}%  accord-glouton ${(ev.agreement * 100).toFixed(0)}%  -> ${ok ? 'OK' : 'ÉCHEC'}`);
  console.log('  poids : ' + policy.getState().weights.map((w, i) => `${require('./fly-agent').FEATURE_NAMES[i]}=${w.toFixed(2)}`).join(' ') + '\n');
}

if (args.includes('--poison')) {
  // 3000 parties contre « random » (sain), puis 1500 contre « troll » (empoisonneur), éval contre « greedy ».
  const rng = mulberry32(SEED + 31337);
  const mk = trollGames => {
    const p = new LinearPolicy({ seed: SEED });
    winRate(env, HUMAN_POLICIES.random, { policy: p }, rng, 3000, true);
    if (trollGames) winRate(env, HUMAN_POLICIES.troll, { policy: p }, rng, trollGames, true);
    return winRate(env, HUMAN_POLICIES.greedy, { policy: p }, rng, EVAL, false).rate;
  };
  const clean = mk(0), poisoned = mk(1500);
  console.log(`=== Empoisonnement ===  éval vs glouton : sans troll ${(clean * 100).toFixed(1)}% | après 1500 parties vs troll ${(poisoned * 100).toFixed(1)}%`);
}

process.exit(failed ? 1 : 0);
