#!/usr/bin/env node
'use strict';
// Tests du système de points.  node test-stats.js
//  A) logique pure, sur FIXTURES SYNTHÉTIQUES (aucune donnée réelle, aucun réseau)
//  B) cohérence des vraies données si data/pokemon-stats.json existe
const assert = require('assert');
const fs = require('fs');
const config = require('./stats-config');
const engine = require('./stats');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log(`  ✔ ${name}`); }
  catch (e) { fail++; console.log(`  ✘ ${name}\n      ${e.message}`); }
}
const st = (hp, attack, defense, specialAttack, specialDefense, speed) => ({ hp, attack, defense, specialAttack, specialDefense, speed });

console.log('A) Logique (fixtures synthétiques)');
const fx = {
  445: st(108, 130, 95, 80, 85, 102),        // Carchacrok (valeurs données dans la spec) -> 600
  10058: st(108, 170, 115, 120, 95, 92),     // fixture "Méga-Carchacrok" : stats DIFFÉRENTES de la forme normale
  1: st(40, 40, 40, 40, 40, 40),             // BST 240  -> normal
  2: st(70, 70, 70, 70, 70, 70),             // BST 420  -> peu commun
  3: st(80, 80, 80, 80, 80, 80),             // BST 480  -> rare
  4: st(90, 90, 90, 90, 90, 90),             // BST 540  -> épique
  5: st(100, 100, 100, 100, 100, 100),       // BST 600, ordinaire -> épique (jamais légendaire)
  6: st(50, 50, 50, 50, 50, 50),             // BST 300, ordinaire
  144: st(50, 50, 50, 50, 50, 50),           // légendaire à BST 300 -> reste légendaire
  151: st(100, 100, 100, 100, 100, 100),     // fabuleux
  793: st(109, 53, 47, 127, 131, 103),       // ultra-chimère
  800: st(97, 107, 101, 127, 89, 79)         // légendaire (pas UC)
};
const cfg = {
  ...config,
  CATEGORY_THRESHOLDS: { commun: 0, peu_commun: 330, rare: 450, epique: 520 }
};
const roster = Object.keys(fx).map(id => ({ id: Number(id), name: `fx${id}` }));
const by = Object.fromEntries(engine.buildEntries(roster, fx, cfg).map(e => [e.id, e]));

test('BST = somme des 6 stats', () => { assert.strictEqual(by[445].bst, 600); assert.strictEqual(engine.computeBst(fx[10058]), 700); });
test('Carchacrok : semi-légendaire ×1.35 -> 810', () => {
  assert.strictEqual(by[445].rarity, 'pseudo_legendaire');
  assert.strictEqual(by[445].multiplier, 1.35);
  assert.strictEqual(by[445].basePoints, 810);
});
test('Ordinaires classés par BST (bas, moyen, haut, très haut)', () => {
  assert.deepStrictEqual([1, 2, 3, 4].map(i => by[i].rarity), ['commun', 'peu_commun', 'rare', 'epique']);
});
test('Seuils inclusifs (BST = seuil -> catégorie supérieure)', () => {
  const th = cfg.CATEGORY_THRESHOLDS;
  assert.strictEqual(engine.categoryByBst(329, th), 'commun');
  assert.strictEqual(engine.categoryByBst(330, th), 'peu_commun');
  assert.strictEqual(engine.categoryByBst(449, th), 'peu_commun');
  assert.strictEqual(engine.categoryByBst(450, th), 'rare');
  assert.strictEqual(engine.categoryByBst(520, th), 'epique');
});
test('Les seuils injectés sont bien utilisés (indépendant de stats-config.js)', () => {
  const other = { ...cfg, CATEGORY_THRESHOLDS: { commun: 0, peu_commun: 100, rare: 200, epique: 300 } };
  assert.strictEqual(engine.getCategory(9999, 250, other), 'rare');
  assert.strictEqual(engine.getCategory(9999, 250, cfg), 'commun');
  assert.strictEqual(engine.buildEntries([{ id: 1, name: 'x' }], { 1: fx[1] }, other)[0].rarity, 'rare'); // BST 240
});
test('Ordinaire à BST 600 : épique, pas légendaire', () => assert.strictEqual(by[5].rarity, 'epique'));
test('Légendaire à BST faible reste légendaire ×1.5', () => {
  assert.strictEqual(by[144].rarity, 'legendaire');
  assert.strictEqual(by[144].basePoints, 450);
});
test('Fabuleux distinct du légendaire', () => { assert.strictEqual(by[151].rarity, 'fabuleux'); assert.strictEqual(by[151].basePoints, 900); });
test('Ultra-Chimère distincte du légendaire ; Necrozma (800) n\'en est pas une', () => {
  assert.strictEqual(by[793].rarity, 'ultra_chimere');
  assert.strictEqual(by[800].rarity, 'legendaire');
  [789, 790, 800].forEach(id => assert.ok(!config.ULTRA_BEAST_IDS.includes(id)));
});
test('Méga : catégorie mega, ses propres stats, ×1.5 une seule fois', () => {
  assert.strictEqual(by[10058].rarity, 'mega');
  assert.strictEqual(by[10058].bst, 700);
  assert.notStrictEqual(by[10058].bst, by[445].bst);
  assert.strictEqual(by[10058].basePoints, 1050);
});
test('Catégorie calculée sur le BST ORIGINAL (pas le BST multiplié)', () => {
  // BST 440 (seuils fixtures) = peu commun ; 440 × 1.2 = 528 >= 520 : reclassé sur le BST multiplié, il deviendrait épique.
  assert.strictEqual(engine.getCategory(9999, 440, cfg), 'peu_commun');
  const e = engine.buildEntries([{ id: 7, name: 'x' }], { 7: st(70, 70, 70, 70, 70, 90) }, cfg)[0]; // BST 440
  assert.strictEqual(e.bst, 440);
  assert.strictEqual(e.rarity, 'peu_commun');
  assert.strictEqual(e.basePoints, 528);
});
test('Priorité : méga > ultra-chimère > fabuleux > légendaire > semi-légendaire', () => {
  assert.deepStrictEqual(config.SPECIAL_PRIORITY, ['mega', 'ultra_chimere', 'fabuleux', 'legendaire', 'pseudo_legendaire']);
  assert.strictEqual(config.getSpecialCategory(10043), 'mega');
});
test('Aucun id dans deux listes d\'exceptions', () => {
  const all = [...config.ULTRA_BEAST_IDS, ...config.MYTHICAL_IDS, ...config.LEGENDARY_IDS, ...config.SEMI_LEGENDARY_IDS];
  assert.strictEqual(new Set(all).size, all.length);
});
test('Multiplicateurs de la spec', () => {
  assert.deepStrictEqual(config.CATEGORY_MULTIPLIERS, {
    commun: 1, peu_commun: 1.2, rare: 1.3, epique: 1.35, pseudo_legendaire: 1.35,
    legendaire: 1.5, fabuleux: 1.5, ultra_chimere: 1.5, mega: 1.5
  });
  config.CATEGORY_ORDER.forEach(c => assert.strictEqual(typeof config.CATEGORY_MULTIPLIERS[c], 'number'));
});
test('Stat manquante / invalide -> erreur explicite', () => {
  assert.throws(() => engine.computeBst({ hp: 10 }));
  assert.throws(() => engine.buildEntries([{ id: 1, name: 'x' }], {}, cfg), /manquantes/);
});
test('Aucun Pokémon créé : autant d\'entrées que le roster', () => assert.strictEqual(Object.keys(by).length, roster.length));

console.log('\nB) Données réelles');
if (!fs.existsSync(engine.STATS_FILE)) {
  console.log(`  (ignoré : ${engine.STATS_FILE} absent — lance node fetch-stats.js)`);
} else {
  const real = engine.loadEntries();
  const r = Object.fromEntries(real.map(e => [e.id, e]));
  const rosterReal = JSON.parse(fs.readFileSync(engine.ROSTER_FILE, 'utf8'));
  test('Toutes les entrées du roster ont des stats', () => assert.strictEqual(real.length, rosterReal.length));
  test('Ids uniques', () => assert.strictEqual(new Set(real.map(e => e.id)).size, real.length));
  test('Carchacrok (445) : 108/130/95/80/85/102, BST 600, semi-légendaire, 810', () => {
    assert.deepStrictEqual(r[445].stats, st(108, 130, 95, 80, 85, 102));
    assert.strictEqual(r[445].bst, 600);
    assert.strictEqual(r[445].rarity, 'pseudo_legendaire');
    assert.strictEqual(r[445].basePoints, 810);
  });
  test('Toutes les Méga (id >= 10000) : catégorie mega, ×1.5, stats propres', () => {
    real.filter(e => e.id >= 10000).forEach(e => {
      assert.strictEqual(e.rarity, 'mega');
      assert.strictEqual(e.basePoints, Math.round(e.bst * 1.5));
    });
    assert.notStrictEqual(r[10058].bst, r[445].bst, 'Méga-Carchacrok doit avoir des stats différentes de Carchacrok');
  });
  test('Mew fabuleux, Zéroïd ultra-chimère, Necrozma/Cosmog légendaires', () => {
    assert.strictEqual(r[151].rarity, 'fabuleux');
    assert.strictEqual(r[793].rarity, 'ultra_chimere');
    assert.strictEqual(r[800].rarity, 'legendaire');
    assert.strictEqual(r[789].rarity, 'legendaire');
  });
  test('Les 10 semi-légendaires sont semi-légendaires ×1.35', () => {
    config.SEMI_LEGENDARY_IDS.forEach(id => { assert.strictEqual(r[id].rarity, 'pseudo_legendaire'); assert.strictEqual(r[id].multiplier, 1.35); });
  });
  test('basePoints = round(BST × multiplicateur) partout', () => {
    real.forEach(e => assert.strictEqual(e.basePoints, Math.round(e.bst * config.CATEGORY_MULTIPLIERS[e.rarity])));
  });
  test('Chaque catégorie contient au moins un Pokémon', () => {
    config.CATEGORY_ORDER.forEach(c => assert.ok(real.some(e => e.rarity === c), `catégorie vide : ${c}`));
  });
  test('Ordinaires : catégorie monotone avec le BST', () => {
    const ord = real.filter(e => !config.getSpecialCategory(e.id)).sort((a, b) => a.bst - b.bst);
    const rank = c => ['commun', 'peu_commun', 'rare', 'epique'].indexOf(c);
    for (let i = 1; i < ord.length; i++) assert.ok(rank(ord[i].rarity) >= rank(ord[i - 1].rarity));
  });
  if (!config.THRESHOLDS_CALIBRATED) console.log('  ⚠ Seuils de BST encore provisoires : node analyze-stats.js');
}

console.log(`\n${pass} réussi(s), ${fail} échec(s)`);
process.exit(fail ? 1 : 0);