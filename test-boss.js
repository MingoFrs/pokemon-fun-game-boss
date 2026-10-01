#!/usr/bin/env node
'use strict';
// Tests des mécaniques de type des boss.  node test-boss.js
//  A) logique pure, sur un monde SYNTHÉTIQUE (4 types, aucune donnée réelle, aucun réseau)
//  B) données RÉELLES (data/pokemon-stats.json + data/type-chart.json) si présentes
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const baseConfig = require('./boss-mechanics-config');
const { loadTypeData, createBossMechanics } = require('./boss-mechanics');
const { buildChart } = require('./fetch-types');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log(`  ✔ ${name}`); }
  catch (e) { fail++; console.log(`  ✘ ${name}\n      ${e.message}`); }
}
const SHINY = 1.5;
const cfgWith = (patch = {}) => ({
  ...baseConfig,
  ...patch,
  WEAKNESS: { ...baseConfig.WEAKNESS, ...(patch.WEAKNESS || {}), resistance: { ...baseConfig.WEAKNESS.resistance, ...((patch.WEAKNESS || {}).resistance || {}) } },
  AFFINITY: { ...baseConfig.AFFINITY, ...(patch.AFFINITY || {}) },
  ENABLED_BY_MODE: { ...baseConfig.ENABLED_BY_MODE, ...(patch.ENABLED_BY_MODE || {}) }
});
const mon = (id, basePoints = 500, multiplier = 1, extra = {}) => ({ id, name: 'm' + id, basePoints, multiplier, rarity: 'rare', ...extra });
const mkGame = (mode, boss, players, extra = {}) => ({ gameMode: mode, boss, players, ...extra });

// ------------------------------------------------------------------ A) monde synthétique
console.log('A) Logique (monde synthétique)');
const TYPES = ['fire', 'water', 'grass', 'flying'];
const chart = {};
TYPES.forEach(a => { chart[a] = {}; TYPES.forEach(d => { chart[a][d] = 1; }); });
chart.water.fire = 2; chart.fire.grass = 2; chart.grass.water = 2; chart.fire.flying = 2; chart.flying.grass = 2;
chart.fire.water = 0.5; chart.water.grass = 0.5; chart.grass.fire = 0.5; chart.water.water = 0.5;
chart.grass.flying = 0; // un type qui ne touche pas du tout
const typesById = {
  1: ['fire'], 2: ['water'], 3: ['grass'], 4: ['flying'], 5: ['grass', 'flying'], 6: ['fire', 'water'],
  7: ['water', 'grass'],     // double type, deux faiblesses possibles selon le boss
  8: ['fire', 'flying'],     // évolué de 1 (fire -> fire/flying)
  9: ['fire', 'grass'],      // « Méga » fictive de 1 : types différents de la forme normale
  10: ['water'], 11: ['grass'],
  100: ['grass'],            // boss mono-type : faible à fire (×2) et flying (×2)
  101: ['grass', 'flying'],  // boss double : fire ×4 (grass ×2 × flying ×2), flying ×2
  102: ['fire']              // boss : faible à water seulement
};
// pool de référence pour le type « à contrer » : 3x water, 2x flying, 1x fire -> ordre de popularité
const poolIds = [2, 10, 2, 4, 5, 1];
const mech = (patch, extra = {}) => createBossMechanics({ typesById, chart, typeOrder: TYPES, config: cfgWith(patch), shinyMultiplier: SHINY, poolIds, ...extra });
const M = mech();
const describe = (id, difficulty = 'moyen') => ({ id, difficulty, ...M.describeBoss({ id }) });
const B100 = describe(100), B101 = describe(101), B102 = describe(102);

test('Boss simple type : types et faiblesses (×2)', () => {
  assert.deepStrictEqual(B100.types, ['grass']);
  assert.deepStrictEqual(B100.weaknesses.map(w => [w.type, w.multiplier]), [['fire', 2], ['flying', 2]]);
});
test('Boss double type : faiblesse ×4 détectée et classée en premier', () => {
  assert.deepStrictEqual(B101.types, ['grass', 'flying']);
  assert.deepStrictEqual(B101.weaknesses[0], { type: 'fire', multiplier: 4 });
});
test('Type à contrer : la faiblesse ×4 gagne même si une ×2 est plus répandue dans le pool', () => {
  assert.strictEqual(B101.counterType, 'fire'); // fire = 1 Pokémon seulement dans le pool, mais ×4
});
test('Type à contrer sans ×4 : la faiblesse ×2 la plus représentée dans le pool', () => {
  // boss 100 : fire (1 Pokémon) vs flying (2 Pokémon) -> flying
  assert.strictEqual(B100.counterType, 'flying');
});
test('Égalité de représentation -> ordre de TYPE_ORDER (config) ; ici ordre de la liste de types', () => {
  const m = mech({}, { poolIds: [1, 4] }); // 1 fire, 1 flying
  assert.strictEqual(m.describeBoss({ id: 100 }).counterType, 'fire');
});
test('Override manuel du type à contrer par boss', () => {
  const m = mech({ COUNTER_TYPE_OVERRIDES: { 100: 'fire' } });
  assert.strictEqual(m.describeBoss({ id: 100 }).counterType, 'fire');
  assert.throws(() => mech({ COUNTER_TYPE_OVERRIDES: { 100: 'inconnu' } }).describeBoss({ id: 100 }), /type inconnu/);
});
test('Faiblesse ×2 -> ×1.25 ; ×4 -> ×1.5 ; bonus = valeur × (mult − 1)', () => {
  const t = M.evaluateTeam([mon(1, 400), mon(2, 400)], B100, 0).perMon; // 1 = fire (×2 vs boss 100), 2 = water (×1)
  assert.strictEqual(t[0].multiplier, 1.25); assert.strictEqual(t[0].bonus, 100);
  assert.strictEqual(t[1].multiplier, 1); assert.strictEqual(t[1].bonus, 0);
  const t4 = M.evaluateTeam([mon(1, 400)], B101, 0).perMon[0]; // fire ×4 vs boss 101
  assert.strictEqual(t4.multiplier, 1.5); assert.strictEqual(t4.bonus, 200);
});
test('Double type : MEILLEUR bonus, jamais la somme (fire/water vs boss 100 : fire ×2 et water ×1)', () => {
  const r = M.evaluateTeam([mon(7, 400)], B101, 0).perMon[0]; // 7 water/grass vs boss 101 (grass/flying)
  assert.ok([1, 1.25, 1.5].includes(r.multiplier));
  const both = M.evaluateTeam([mon(5, 400)], B100, 0).perMon[0]; // 5 grass/flying : flying ×2 (grass ×1) -> 1.25
  assert.strictEqual(both.multiplier, 1.25);
  // deux types faibles à la fois : fire/flying (8) vs boss 101 -> fire ×4, flying ×2 : on garde ×4, pas 4×2 ni 1.5×1.25
  const dual = M.evaluateTeam([mon(8, 400)], B101, 0).perMon[0];
  assert.strictEqual(dual.effectiveness, 4);
  assert.strictEqual(dual.multiplier, 1.5);
  assert.strictEqual(dual.bonus, 200);
});
test('Valeur finale : trait, shiny inclus ; shiny déjà dans le multiplicateur jamais recompté', () => {
  assert.strictEqual(M.monFinalValue(mon(1, 500, 1.2)), 600);
  assert.strictEqual(M.monFinalValue(mon(1, 500, 1.2, { shiny: true })), 900);
  assert.strictEqual(M.monFinalValue(mon(1, 500, 1.8, { shiny: true, shinyInMultiplier: true })), 900);
  const r = M.evaluateTeam([mon(1, 500, 1.2, { shiny: true })], B100, 0).perMon[0];
  assert.strictEqual(r.value, 900); assert.strictEqual(r.bonus, 225);
});
test('Valeur finale 0 (Double ou rien raté) -> bonus 0', () => {
  const r = M.evaluateTeam([mon(1, 500, 0)], B100, 0).perMon[0];
  assert.strictEqual(r.value, 0); assert.strictEqual(r.bonus, 0);
});
test('Malus de résistance DÉSACTIVÉ par défaut', () => {
  assert.strictEqual(baseConfig.WEAKNESS.resistance.enabled, false);
  const r = M.evaluateTeam([mon(2, 400)], describe(100), 0).perMon[0]; // water vs boss grass : water->grass 0.5
  assert.strictEqual(r.multiplier, 1); assert.strictEqual(r.bonus, 0);
});
test('Malus de résistance activé par la config : ×0.5 et ×0', () => {
  const m = mech({ WEAKNESS: { resistance: { enabled: true, multiplierHalf: 0.9, multiplierImmune: 0.8 } } });
  const bossGrass = { id: 100, difficulty: 'moyen', ...m.describeBoss({ id: 100 }) };
  assert.strictEqual(m.evaluateTeam([mon(2, 400)], bossGrass, 0).perMon[0].multiplier, 0.9);   // water->grass ×0.5
  assert.strictEqual(m.evaluateTeam([mon(2, 400)], bossGrass, 0).perMon[0].bonus, -40);
  const bossFlyer = { id: 4, difficulty: 'moyen', ...m.describeBoss({ id: 4 }) };               // boss flying
  assert.strictEqual(m.evaluateTeam([mon(3, 400)], bossFlyer, 0).perMon[0].multiplier, 0.8);    // grass->flying ×0
});
test('Types suivent l\'ÉVOLUTION (id actuel) : fire -> fire/flying change le bonus', () => {
  const before = M.evaluateTeam([mon(1, 400)], B102, 0).perMon[0];   // boss fire : water le bat ; fire ×1
  const hit = M.evaluateTeam([mon(2, 400)], B102, 0).perMon[0];
  assert.strictEqual(before.multiplier, 1); assert.strictEqual(hit.multiplier, 1.25);
  const m1 = mon(1, 400); const bossGrass = B100;
  const x1 = M.evaluateTeam([m1], bossGrass, 0).perMon[0];
  m1.id = 8; // évolution -> fire/flying (types lus à l'id ACTUEL)
  const x2 = M.evaluateTeam([m1], bossGrass, 0).perMon[0];
  assert.deepStrictEqual(x2.types, ['fire', 'flying']);
  assert.ok(x1.multiplier === 1.25 && x2.multiplier === 1.25 && x2.effectiveness >= x1.effectiveness);
  assert.deepStrictEqual(M.getTypes(mon(1)), ['fire']); assert.deepStrictEqual(M.getTypes(mon(8)), ['fire', 'flying']);
});
test('Méga : types de la forme Méga, pas du Pokémon de base', () => {
  const m = mon(1, 400); // fire
  const base = M.evaluateTeam([m], describe(100), 0).perMon[0];
  m.id = 9; // fire/grass (fictif)
  const mega = M.evaluateTeam([m], B102, 0).perMon[0];
  assert.deepStrictEqual(mega.types, ['fire', 'grass']);
  assert.notDeepStrictEqual(mega.types, base.types);
});
test('Métamorph transformé : copie les types de la cible (typeSourceId)', () => {
  const ditto = mon(2, 400, 1, { typeSourceId: 3 }); // id 2 (water) mais types de 3 (grass)
  assert.deepStrictEqual(M.getTypes(ditto), ['grass']);
  assert.strictEqual(M.evaluateTeam([ditto], B102, 0).perMon[0].multiplier, 1); // grass vs boss fire : neutre/0.5
  assert.strictEqual(M.evaluateTeam([mon(2, 400)], B102, 0).perMon[0].multiplier, 1.25); // water seul : faible
});
test('Affinité : paliers 2 -> +5 %, 3+ -> +10 % du score BRUT, sinon 0', () => {
  // type à contrer du boss 100 = flying
  const fly = () => mon(4, 100), none = () => mon(2, 100);
  const aff = n => M.evaluateTeam([...Array(n).fill(0).map(fly), ...Array(5 - n).fill(0).map(none)], B100, 2000).affinity;
  assert.deepStrictEqual([0, 1, 2, 3, 4, 5].map(n => aff(n).rate), [0, 0, 0.05, 0.10, 0.10, 0.10]);
  assert.strictEqual(aff(2).bonus, 100); assert.strictEqual(aff(3).bonus, 200); assert.strictEqual(aff(1).bonus, 0);
  assert.strictEqual(aff(2).count, 2);
});
test('Affinité : un Pokémon compte si UN de ses deux types est le type à contrer', () => {
  const r = M.evaluateTeam([mon(5), mon(8), mon(2)], B100, 1000).affinity; // 5 grass/flying, 8 fire/flying : 2 flying
  assert.strictEqual(r.count, 2); assert.strictEqual(r.bonus, 50);
});
test('Affinité : prochain palier exposé pour l\'affichage', () => {
  const r = M.evaluateTeam([mon(4)], B100, 0).affinity;
  assert.deepStrictEqual(r.nextTier, { min: 2, rate: 0.05 });
  assert.strictEqual(M.evaluateTeam([mon(4), mon(4), mon(4)], B100, 0).affinity.nextTier, null);
});
test('Paliers d\'affinité configurables (ex. 2 -> 10 %)', () => {
  const m = mech({ AFFINITY: { enabled: true, tiers: [{ min: 2, rate: 0.10 }] } });
  const b = { id: 100, difficulty: 'moyen', ...m.describeBoss({ id: 100 }) };
  assert.strictEqual(m.evaluateTeam([mon(4), mon(4)], b, 1000).affinity.bonus, 100);
});

// --- syncPlayer : intégration au score
const mkPlayer = (team, score, extra = {}) => ({ id: 'p' + Math.random(), team, score, ...extra });
test('syncPlayer : score = brut + bonus ; idempotent ; annote chaque Pokémon', () => {
  const p = mkPlayer([mon(1, 400), mon(2, 400), mon(4, 400)], 1200);
  const game = mkGame('normal', B100, [p]);
  const d1 = M.syncPlayer(p, game);
  // bonus faiblesse : 1 (fire ×2) -> 100 ; 4 (flying ×2) -> 100 ; affinité flying : 1 Pokémon -> 0
  assert.strictEqual(p.typeBonus.weakness, 200); assert.strictEqual(p.typeBonus.affinity.bonus, 0);
  assert.strictEqual(d1, 200); assert.strictEqual(p.score, 1400);
  assert.deepStrictEqual([p.team[0].typeMult, p.team[1].typeMult, p.team[2].typeMult], [1.25, 1, 1.25]);
  assert.strictEqual(M.syncPlayer(p, game), 0); assert.strictEqual(p.score, 1400);
});
test('syncPlayer : l\'affinité repose sur le score BRUT (hors bonus), pas de boucle', () => {
  const p = mkPlayer([mon(4, 400), mon(4, 400)], 2000);
  const game = mkGame('normal', B100, [p]);
  M.syncPlayer(p, game); // brut 2000 ; faiblesse 2×100 ; affinité 5 % de 2000 = 100
  assert.strictEqual(p.typeBonus.affinity.bonus, 100); assert.strictEqual(p.score, 2000 + 200 + 100);
  p.score += 500; M.syncPlayer(p, game); // brut 2500 -> affinité 125
  assert.strictEqual(p.typeBonus.affinity.bonus, 125); assert.strictEqual(p.score, 2500 + 200 + 125);
});
test('syncPlayer : le bonus suit les changements d\'équipe (retrait d\'un Pokémon -> bonus retiré)', () => {
  const p = mkPlayer([mon(4, 400), mon(4, 400), mon(4, 400)], 1000);
  const game = mkGame('normal', B100, [p]);
  M.syncPlayer(p, game); const withThree = p.typeBonus.affinity.rate;
  p.team.pop(); p.score -= 400; M.syncPlayer(p, game);
  assert.strictEqual(withThree, 0.10); assert.strictEqual(p.typeBonus.affinity.rate, 0.05);
  assert.strictEqual(p.score, 600 + 200 + Math.round(600 * 0.05));
});
test('Mécanique désactivée (mode guess/auction, ou toggles off) : score et objets STRICTEMENT inchangés', () => {
  for (const mode of ['guess', 'auction']) {
    const p = mkPlayer([mon(1, 400), mon(4, 400)], 800);
    const snapshot = JSON.stringify(p);
    assert.strictEqual(M.syncPlayer(p, mkGame(mode, B100, [p])), 0);
    assert.strictEqual(JSON.stringify(p), snapshot);
  }
  const off = mech({ WEAKNESS: { enabled: false }, AFFINITY: { enabled: false } });
  const p = mkPlayer([mon(1, 400), mon(4, 400), mon(4, 400)], 800);
  off.syncPlayer(p, mkGame('normal', B100, [p]));
  assert.strictEqual(p.score, 800); assert.strictEqual(p.typeBonus.total, 0);
  const noBoss = mkPlayer([mon(1, 400)], 400);
  assert.strictEqual(M.syncPlayer(noBoss, { gameMode: 'normal', boss: null, players: [noBoss] }), 0);
});
test('Mode désactivable par mode (ENABLED_BY_MODE)', () => {
  const m = mech({ ENABLED_BY_MODE: { coop: false } });
  const p = mkPlayer([mon(1, 400)], 400);
  assert.strictEqual(m.syncPlayer(p, mkGame('coop', B100, [p])), 0); assert.strictEqual(p.score, 400);
  const q = mkPlayer([mon(1, 400)], 400);
  assert.ok(m.syncPlayer(q, mkGame('normal', B100, [q])) > 0);
});
test('Admin vs Joueur : le JOUEUR reçoit le bonus, l\'ADMIN (sans équipe ni score) jamais', () => {
  const admin = { id: 'A', team: [], score: 0 }, joueur = mkPlayer([mon(1, 400), mon(4, 400)], 800);
  const game = mkGame('admin', B100, [admin, joueur], { adminId: 'A' });
  assert.strictEqual(M.syncPlayer(admin, game), 0); assert.strictEqual(admin.score, 0); assert.strictEqual(admin.typeBonus, undefined);
  assert.strictEqual(M.syncPlayer(joueur, game), 200); assert.strictEqual(joueur.score, 1000);
});
test('Coop : bonus appliqué au score de CHAQUE joueur ; objectif d\'équipe non touché par le bonus', () => {
  const a = mkPlayer([mon(1, 400)], 400), b = mkPlayer([mon(4, 400), mon(2, 400)], 800);
  const game = mkGame('coop', B100, [a, b]);
  game.players.forEach(p => M.syncPlayer(p, game));
  assert.strictEqual(a.score, 500); assert.strictEqual(b.score, 900);
  assert.strictEqual(game.players.reduce((s, p) => s + p.score, 0), 1400); // somme d'équipe = bruts + bonus individuels
  assert.strictEqual(B100.requiredPoints, undefined); // l'objectif n'est pas modifié par le calcul de bonus
});
test('Calibrage : facteur 1 par défaut ; difficulté × boss, seulement dans les modes où la mécanique est active', () => {
  assert.strictEqual(M.scaleFor({ id: 100, difficulty: 'moyen' }, 'normal'), 1);
  const m = mech({ SCALE_BY_DIFFICULTY: { moyen: 1.05 }, SCALE_BY_BOSS: { 100: 1.1 }, ENABLED_BY_MODE: { guess: false } });
  assert.ok(Math.abs(m.scaleFor({ id: 100, difficulty: 'moyen' }, 'normal') - 1.155) < 1e-9);
  assert.ok(Math.abs(m.scaleFor({ id: 101, difficulty: 'moyen' }, 'coop') - 1.05) < 1e-9);
  assert.strictEqual(m.scaleFor({ id: 100, difficulty: 'moyen' }, 'guess'), 1);
});
test('Types inconnus -> erreur explicite', () => assert.throws(() => M.getTypes(9999), /Types inconnus/));

console.log('\nA2) Génération de la table d\'efficacité (fetch-types, sans réseau)');
test('buildChart construit ×2 / ×0.5 / ×0 depuis damage_relations ; le reste = ×1', () => {
  const resp = {
    fire: { damage_relations: { double_damage_from: [{ name: 'water' }], half_damage_from: [{ name: 'fire' }, { name: 'grass' }], no_damage_from: [] } },
    water: { damage_relations: { double_damage_from: [{ name: 'grass' }], half_damage_from: [{ name: 'fire' }], no_damage_from: [] } },
    grass: { damage_relations: { double_damage_from: [{ name: 'fire' }], half_damage_from: [{ name: 'water' }], no_damage_from: [{ name: 'flying' }] } },
    flying: { damage_relations: { double_damage_from: [], half_damage_from: [], no_damage_from: [] } }
  };
  const c = buildChart(resp, ['fire', 'water', 'grass', 'flying']);
  assert.strictEqual(c.water.fire, 2); assert.strictEqual(c.fire.fire, 0.5); assert.strictEqual(c.grass.fire, 0.5);
  assert.strictEqual(c.flying.grass, 0); assert.strictEqual(c.fire.flying, 1);
  assert.throws(() => buildChart({}, ['fire']), /manquant/);
});
test('loadTypeData : fichiers absents / types manquants -> erreur claire (le serveur refuse de démarrer)', () => {
  assert.throws(() => loadTypeData({ chartFile: '/nope/type-chart.json' }), /fetch-types\.js/);
  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'boss-'));
  const chartOk = path.join(tmp, 'chart.json'), stats = path.join(tmp, 'stats.json'), roster = path.join(tmp, 'roster.json');
  const t = baseConfig.TYPE_ORDER, full = {};
  t.forEach(a => { full[a] = {}; t.forEach(d => { full[a][d] = 1; }); });
  fs.writeFileSync(chartOk, JSON.stringify({ chart: full }));
  fs.writeFileSync(roster, JSON.stringify([{ id: 1, name: 'a' }, { id: 2, name: 'b' }]));
  fs.writeFileSync(stats, JSON.stringify({ 1: { types: ['fire'] }, 2: { hp: 1 } }));
  assert.throws(() => loadTypeData({ chartFile: chartOk, rosterFile: roster, statsFile: stats }), /Types manquants\/invalides pour 1 Pokémon \(ex\. 2\)/);
  fs.writeFileSync(stats, JSON.stringify({ 1: { types: ['fire'] }, 2: { types: ['water', 'water'] } }));
  assert.throws(() => loadTypeData({ chartFile: chartOk, rosterFile: roster, statsFile: stats }), /Types manquants/);
  fs.writeFileSync(stats, JSON.stringify({ 1: { types: ['fire'] }, 2: { types: ['water', 'dragon'] } }));
  assert.strictEqual(Object.keys(loadTypeData({ chartFile: chartOk, rosterFile: roster, statsFile: stats }).typesById).length, 2);
  const broken = JSON.parse(JSON.stringify(full)); delete broken.fire.water;
  fs.writeFileSync(chartOk, JSON.stringify({ chart: broken }));
  assert.throws(() => loadTypeData({ chartFile: chartOk, rosterFile: roster, statsFile: stats }), /fire -> water/);
});

// ------------------------------------------------------------------ B) données réelles
console.log('\nB) Données réelles');
const statsFile = process.env.POKEMON_STATS_FILE || path.join(__dirname, 'data', 'pokemon-stats.json');
const chartFile = path.join(__dirname, 'data', 'type-chart.json');
if (!fs.existsSync(statsFile) || !fs.existsSync(chartFile)) {
  console.log('  (ignoré : data/pokemon-stats.json ou data/type-chart.json absent — lance node fetch-stats.js et node fetch-types.js)');
} else {
  let real, R, entries;
  try {
    real = loadTypeData();
    entries = require('./stats').loadEntries();
    R = createBossMechanics({ ...real, config: baseConfig, shinyMultiplier: SHINY, poolIds: entries.filter(e => e.id < 10000).map(e => e.id) });
  } catch (e) { console.log('  ✘ chargement : ' + e.message); fail++; }
  if (R) {
    const src = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
    const bosses = [...src.matchAll(/\{ id: (\d+), name: '([^']+)', requiredPoints: (\d+), difficulty: '([^']+)' \}/g)]
      .map(m => ({ id: +m[1], name: m[2], difficulty: m[4] }));
    const info = Object.fromEntries(bosses.map(b => [b.id, { ...b, ...R.describeBoss(b) }]));
    const E = (monId, bossId, base = 500) => R.evaluateTeam([mon(monId, base)], info[bossId], 0).perMon[0];

    test('Table d\'efficacité réelle : faits connus (18 types, 324 couples)', () => {
      const c = real.chart;
      assert.strictEqual(Object.keys(c).length, 18);
      assert.strictEqual(c.fire.grass, 2); assert.strictEqual(c.water.fire, 2); assert.strictEqual(c.electric.ground, 0);
      assert.strictEqual(c.ground.flying, 0); assert.strictEqual(c.normal.ghost, 0); assert.strictEqual(c.fairy.dragon, 2);
      assert.strictEqual(c.dragon.fairy, 0); assert.strictEqual(c.steel.fairy, 2); assert.strictEqual(c.ghost.normal, 0);
      assert.strictEqual(c.ice.dragon, 2); assert.strictEqual(c.fighting.ghost, 0);
    });
    test('Tous les Pokémon du roster (dont Méga) ont 1-2 types valides', () => {
      assert.strictEqual(Object.keys(real.typesById).length, entries.length);
    });
    test('Types réels : Dracaufeu fire/flying, Méga-Dracaufeu X fire/dragon, Méga-Dracaufeu Y fire/flying, Mewtwo psychic', () => {
      assert.deepStrictEqual(R.getTypes(6), ['fire', 'flying']);
      assert.deepStrictEqual(R.getTypes(10034), ['fire', 'dragon']);
      assert.deepStrictEqual(R.getTypes(10035), ['fire', 'flying']);
      assert.deepStrictEqual(R.getTypes(150), ['psychic']);
    });
    test('104 boss : types résolus, jamais sans type à contrer (sauf aucune faiblesse)', () => {
      assert.strictEqual(bosses.length, 104);
      Object.values(info).forEach(b => {
        assert.ok(b.types.length >= 1);
        if (b.weaknesses.length) assert.ok(baseConfig.TYPE_ORDER.includes(b.counterType), `${b.name}: ${b.counterType}`);
        else assert.strictEqual(b.counterType, null);
      });
    });
    test('Boss simple type réel : Kyogre (eau) faible à électrik et plante ; contré par le plus répandu', () => {
      const k = info[382];
      assert.deepStrictEqual(k.types, ['water']);
      assert.deepStrictEqual(k.weaknesses.map(w => w.type).sort(), ['electric', 'grass']);
      const pool = entries.filter(e => e.id < 10000);
      const count = t => pool.filter(e => real.typesById[e.id].includes(t)).length;
      assert.strictEqual(k.counterType, count('grass') >= count('electric') ? 'grass' : 'electric'); // recalcul indépendant
    });
    test('Boss double type réel avec ×4 : Rayquaza (dragon/vol) -> glace ×4, type à contrer = glace', () => {
      const r = info[384];
      assert.deepStrictEqual(r.weaknesses[0], { type: 'ice', multiplier: 4 });
      assert.strictEqual(r.counterType, 'ice');
    });
    test('Boss double type sans ×4 réel : Mewtwo (psy) -> contré par le type le plus représenté parmi bug/ghost/dark', () => {
      const pool = entries.filter(e => e.id < 10000);
      const count = t => pool.filter(e => real.typesById[e.id].includes(t)).length;
      const best = ['bug', 'ghost', 'dark'].sort((a, b) => count(b) - count(a) || baseConfig.TYPE_ORDER.indexOf(a) - baseConfig.TYPE_ORDER.indexOf(b))[0];
      assert.strictEqual(info[150].counterType, best);
    });
    test('Réel ×2 et ×4 : Pokémon glace vs Rayquaza -> ×1.5 ; roche/glace (Aurorus) ne cumule pas ; vol/dragon neutre', () => {
      const ice = entries.find(e => real.typesById[e.id].length === 1 && real.typesById[e.id][0] === 'ice' && e.id < 10000).id;
      assert.strictEqual(E(ice, 384).multiplier, 1.5);
      assert.deepStrictEqual(R.getTypes(699), ['rock', 'ice']);
      const a = E(699, 384); // roche ×2, glace ×4 -> meilleur = ×1.5 (jamais ×1.5 × ×1.25)
      assert.strictEqual(a.multiplier, 1.5); assert.strictEqual(a.bonus, 250);
      const rock = E(universalRock(), 384);
      assert.strictEqual(rock.multiplier, 1.25);
    });
    function universalRock() { return entries.find(e => e.id < 10000 && real.typesById[e.id].length === 1 && real.typesById[e.id][0] === 'rock').id; }
    test('Réel : Méga avec ses PROPRES types — Méga-Dracaufeu X (dragon) frappe Rayquaza à ×2, Dracaufeu (feu/vol) non', () => {
      assert.strictEqual(E(6, 384).multiplier, 1);
      assert.strictEqual(E(10034, 384).multiplier, 1.25);
    });
    test('Réel : évolution qui change les types change le bonus (recherche automatique d\'un cas)', () => {
      const evo = require('fs').readFileSync(path.join(__dirname, 'server.js'), 'utf8').match(/const EVOLVES_FROM = \{([\s\S]*?)\};/);
      let found = null;
      if (evo) {
        const pairs = [...evo[1].matchAll(/(\d+): (\d+)/g)].map(m => [+m[1], +m[2]]); // enfant: parent
        outer: for (const [child, parent] of pairs) {
          if (JSON.stringify(real.typesById[child]) === JSON.stringify(real.typesById[parent])) continue;
          for (const b of Object.values(info)) if (E(child, b.id).multiplier !== E(parent, b.id).multiplier) { found = { child, parent, boss: b.id }; break outer; }
        }
      }
      assert.ok(found, 'aucun cas trouvé');
      assert.notStrictEqual(E(found.child, found.boss).multiplier, E(found.parent, found.boss).multiplier);
    });
    test('Réel : Métamorph transformé en Pokémon eau vs boss feu -> ×1.25 ; non transformé (normal) -> ×1', () => {
      const fireBoss = Object.values(info).find(b => b.types.length === 1 && b.types[0] === 'fire');
      const water = entries.find(e => e.id < 10000 && real.typesById[e.id].length === 1 && real.typesById[e.id][0] === 'water').id;
      assert.deepStrictEqual(R.getTypes(132), ['normal']);
      const plain = R.evaluateTeam([mon(132, 400)], fireBoss, 0).perMon[0];
      const dit = R.evaluateTeam([mon(132, 400, 1, { typeSourceId: water })], fireBoss, 0).perMon[0];
      assert.strictEqual(plain.multiplier, 1); assert.strictEqual(dit.multiplier, 1.25);
    });
    test('Contrôle global : chaque type à contrer a au moins un Pokémon pour l\'incarner dans le pool', () => {
      const pool = entries.filter(e => e.id < 10000);
      Object.values(info).forEach(b => {
        if (b.counterType) assert.ok(pool.some(e => real.typesById[e.id].includes(b.counterType)), b.name);
      });
    });
    test('Contrôle global : multiplicateur toujours dans {1, 1.25, 1.5} pour les 1073 × 104 couples', () => {
      for (const e of entries) for (const b of Object.values(info)) {
        const m = R.evaluateTeam([mon(e.id, 100)], b, 0).perMon[0].multiplier;
        assert.ok(m === 1 || m === 1.25 || m === 1.5, `${e.id}/${b.id}: ${m}`);
      }
    });
  }
}

console.log(`\n${pass} réussi(s), ${fail} échec(s)`);
process.exit(fail ? 1 : 0);
