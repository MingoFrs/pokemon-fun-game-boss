#!/usr/bin/env node
'use strict';
// Tests du client du mode 'fly' dans un DOM simulé : index.html + client.js + fly-client.js réels,
// socket factice (aucun réseau). Nécessite jsdom, NON ajouté au projet :
//   npm i --no-save jsdom        puis        node test-fly-client.js
// Sans jsdom, le test est ignoré (code de sortie 0).
const fs = require('fs');
const path = require('path');
const assert = require('assert');

let JSDOM;
try { ({ JSDOM } = require('jsdom')); }
catch (e) { console.log('test-fly-client : jsdom absent -> ignoré (npm i --no-save jsdom)'); process.exit(0); }

const pub = fs.existsSync(path.join(__dirname, 'public', 'index.html')) ? path.join(__dirname, 'public') : __dirname;
const read = f => fs.readFileSync(path.join(pub, f), 'utf8');
let pass = 0, fail = 0;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

function boot() {
  const html = read('index.html').replace(/<script[^>]*src="[^"]*"[^>]*><\/script>/g, '');
  const dom = new JSDOM(html, { url: 'http://localhost/', runScripts: 'dangerously', pretendToBeVisual: true });
  const w = dom.window;
  const handlers = {}, emitted = [], fetched = [];
  const socket = {
    id: 'sock1', connected: true,
    on(ev, fn) { (handlers[ev] = handlers[ev] || []).push(fn); return this; },
    emit(ev, ...a) { emitted.push({ ev, a }); }, off() {}, once() {}, io: { on() {} }
  };
  let statsResponse = { name: 'La Mouche', generation: 1, brain: { gamesPlayed: 0, flyWins: 0, humanityWins: 0, draws: 0, winRate: null, warmupGames: 210 }, global: { gamesPlayed: 0, flyWins: 0, humanityWins: 0, draws: 0, winRate: null }, recent: [] };
  w.io = () => socket;
  w.fetch = (url) => { fetched.push(url); return Promise.resolve({ ok: true, json: async () => statsResponse }); };
  w.matchMedia = w.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
  w.HTMLMediaElement.prototype.play = () => Promise.resolve();
  w.HTMLMediaElement.prototype.pause = () => {};
  w.scrollTo = () => {};
  w.AudioContext = w.webkitAudioContext = function () { return { createGain: () => ({ gain: {}, connect() {} }), createOscillator: () => ({ connect() {}, start() {}, stop() {}, frequency: {}, type: '' }), destination: {}, currentTime: 0, resume() {} }; };
  const errors = [];
  w.addEventListener('error', e => errors.push(e.message));
  const run = code => { const s = w.document.createElement('script'); s.textContent = code; w.document.body.appendChild(s); };
  run(read('client.js'));
  run(read('fly-client.js'));
  const $ = id => w.document.getElementById(id);
  const hidden = id => $(id).classList.contains('screen--hidden');
  const fire = (ev, payload) => (handlers[ev] || []).forEach(fn => fn(payload));
  return { w, $, hidden, fire, emitted, fetched, errors, handlers, setStats: s => { statsResponse = s; } };
}

const mon = (name, extra = {}) => ({ name, sprite: `/${name}.png`, shiny: false, shinySprite: null, ...extra });
const route = Array.from({ length: 6 }, (_, i) => ({ turn: i + 1, status: i === 0 ? 'current' : 'upcoming' }));
const startedPayload = (stats) => ({
  gameId: 'ABCD', status: 'playing', turn: 1, maxTurns: 6, route, boss: null, difficulty: null, gameMode: 'fly', adminId: null,
  players: [{ id: 'sock1', name: 'Moi', score: 0, team: [] }], fly: stats
});
const stats = (o = {}) => ({
  name: 'La Mouche', generation: 1,
  brain: { gamesPlayed: 12, flyWins: 7, humanityWins: 4, draws: 1, winRate: 7 / 12, warmupGames: 210, ...(o.brain || {}) },
  global: { gamesPlayed: 12, flyWins: 7, humanityWins: 4, draws: 1, winRate: 7 / 12, ...(o.global || {}) },
  recent: ['W', 'L', 'W', 'W', 'D', 'L', 'W', 'W', 'W', 'L', 'W', 'W'], ...Object.fromEntries(Object.entries(o).filter(([k]) => !['brain', 'global'].includes(k)))
});
const entry = (turn, o = {}) => ({
  turn, choice: 'HAUT', pokemon: mon('Pikachu'), rarity: 'rare', basePoints: 500,
  effect: { name: 'Motivé', multiplier: 1.1 }, pointsGained: 550, score: 550, ...o
});
const finishedPayload = (o = {}) => ({
  boss: null, difficulty: null, gameMode: 'fly', adminId: null, route,
  players: [{ id: 'sock1', name: 'Moi', score: 2000, team: [], typeBonus: null, result: 'victory' }],
  fly: {
    name: 'La Mouche', score: 1800, team: [], result: 'loss', humanResult: 'victory', counted: true, stats: stats({ brain: { gamesPlayed: 13, flyWins: 8, winRate: 8 / 13 }, global: { gamesPlayed: 13, flyWins: 8 } }),
    turns: Array.from({ length: 6 }, (_, i) => ({ ...entry(i + 1), humanChoice: i % 2 ? 'BAS' : 'HAUT', humanPointsGained: 300 })), ...o
  }
});

test('Le bouton du lobby existe et envoie set_game_mode', () => {
  const c = boot();
  const btn = c.w.document.querySelector('.gamemode-btn[data-mode="fly"]');
  assert.ok(btn && /Mouche/.test(btn.textContent));
  c.fire('connect');   // myId = socket.id (l'hôte seul peut changer de mode)
  c.fire('game_created', { gameId: 'ABCD', players: [{ id: 'sock1', name: 'Moi' }], hostId: 'sock1', difficulty: 'medium', gameMode: 'normal' });
  btn.click();
  assert.strictEqual(JSON.stringify(c.emitted.filter(e => e.ev === 'set_game_mode')), JSON.stringify([{ ev: 'set_game_mode', a: [{ mode: 'fly' }] }]));
});
test('Lobby en mode fly : difficulté masquée, aide affichée, stats globales chargées', async () => {
  const c = boot(); c.setStats(stats());
  c.fire('game_created', { gameId: 'ABCD', players: [{ id: 'sock1', name: 'Moi' }], hostId: 'sock1', difficulty: 'medium', gameMode: 'fly' });
  assert.ok(c.w.document.querySelector('.difficulty-panel').classList.contains('screen--hidden'));
  assert.ok(/La Mouche/.test(c.$('gamemode-hint').textContent) && !c.hidden('gamemode-hint'));
  assert.ok(c.fetched.includes('/api/fly/stats'));
  await new Promise(r => setTimeout(r, 20));
  assert.ok(/Humanité 4/.test(c.$('fly-lobby-stats').textContent) && /Mouche 7/.test(c.$('fly-lobby-stats').textContent));
  assert.ok(c.$('fly-lobby-stats').querySelector('svg.fly-curve'));
  // repasser en mode normal : tout redevient normal
  c.fire('game_created', { gameId: 'ABCD', players: [{ id: 'sock1', name: 'Moi' }], hostId: 'sock1', difficulty: 'medium', gameMode: 'normal' });
  assert.ok(!c.w.document.querySelector('.difficulty-panel').classList.contains('screen--hidden'));
  assert.ok(c.hidden('fly-lobby-stats'));
});
test('game_started fly : écran de jeu, carte Mouche, boss masqué, bannière, stats', () => {
  const c = boot();
  c.fire('game_started', startedPayload(stats()));
  assert.strictEqual(c.errors.length, 0, c.errors.join('|'));
  assert.ok(!c.hidden('screen-game'));
  assert.ok(c.w.document.body.classList.contains('fly-mode'));
  assert.ok(!c.hidden('fly-card'));
  assert.ok(/hésite/.test(c.$('fly-card-status').textContent));
  assert.strictEqual(c.$('game-matchup-opp-name').textContent, 'La Mouche 🪰');
  assert.ok(/Génération 1/.test(c.$('fly-card-meta').textContent) && /12 parties vécues, taux de victoire 58 %/.test(c.$('fly-card-meta').textContent), c.$('fly-card-meta').textContent);
  assert.ok(/Échauffement : 210 parties simulées/.test(c.$('fly-card-stats').textContent));
  assert.ok(!/appris/i.test(c.$('fly-card').textContent));
  assert.ok(/Humanité 4/.test(c.$('fly-card-stats').textContent));
  assert.strictEqual(c.$('fly-score-value').textContent, '0');
  assert.ok(c.hidden('screen-fly-finished') && c.hidden('screen-finished'));
});
test('Tour : ton choix -> « la Mouche hésite » ; révélation -> score, équipe, panneau ; tour suivant -> panneau masqué', () => {
  const c = boot();
  c.fire('game_started', startedPayload(stats()));
  c.fire('fly_thinking', { turn: 1 });
  c.fire('turn_options', { haut: mon('A'), bas: mon('B') });
  c.fire('choice_result', { pokemon: mon('A'), rarity: 'commun', basePoints: 300, effect: { name: 'Neutre', multiplier: 1 }, pointsGained: 300, score: 300, team: [] });
  assert.strictEqual(c.$('turn-status').textContent, 'La Mouche hésite…');
  assert.ok(c.$('fly-reveal-panel').classList.contains('fly-reveal--hidden'));
  c.fire('fly_choice_revealed', entry(1, { pokemon: mon('Pikachu'), score: 550 }));
  assert.strictEqual(c.$('fly-score-value').textContent, '550');
  assert.strictEqual(c.$('fly-score-popup').textContent, '+550');
  assert.strictEqual(c.$('fly-team').children.length, 1);
  assert.ok(!c.$('fly-reveal-panel').classList.contains('fly-reveal--hidden'));
  assert.strictEqual(c.$('fly-reveal-name').textContent, 'PIKACHU');
  assert.strictEqual(c.$('fly-reveal-choice').textContent, '🔼 HAUT');
  assert.ok(/a choisi/.test(c.$('fly-card-status').textContent) && c.$('turn-status').textContent === 'La Mouche a choisi.');
  c.fire('turn_options', { haut: mon('C'), bas: mon('D') });
  assert.ok(c.$('fly-reveal-panel').classList.contains('fly-reveal--hidden'));
  c.fire('fly_thinking', { turn: 2 });
  assert.ok(/hésite/.test(c.$('fly-card-status').textContent));
});
test('Shiny : sprite shiny et mention du bonus', () => {
  const c = boot(); c.fire('game_started', startedPayload(stats()));
  c.fire('fly_choice_revealed', entry(1, { pokemon: mon('Mew', { shiny: true, shinySprite: '/mew-shiny.png' }) }));
  assert.ok(c.$('fly-reveal-sprite').src.endsWith('/mew-shiny.png'));
  assert.ok(/Shiny/.test(c.$('fly-reveal-effect').textContent) && /✨/.test(c.$('fly-reveal-name').textContent));
});
test('Fin de partie : écran dédié, résultat, 6 tours, « N parties vécues, taux de victoire X % » (chiffres réels), stats + courbe', () => {
  const c = boot(); c.fire('game_started', startedPayload(stats()));
  c.fire('game_finished', finishedPayload());
  assert.strictEqual(c.errors.length, 0, c.errors.join('|'));
  assert.ok(!c.hidden('screen-fly-finished'));
  assert.ok(c.hidden('screen-finished') && c.hidden('screen-game'));
  assert.ok(/VICTOIRE/.test(c.$('fly-finished-outcome').textContent));
  assert.strictEqual(c.$('fly-finished-me').textContent, '2000 PTS');
  assert.strictEqual(c.$('fly-finished-fly').textContent, '1800 PTS');
  assert.strictEqual(c.$('fly-finished-turns').children.length, 6);
  assert.strictEqual(c.$('fly-finished-learned').textContent, 'La Mouche — génération 1 : 13 parties vécues, taux de victoire 62 %.');
  assert.ok(!/appris/i.test(c.$('screen-fly-finished').textContent));
  assert.ok(/Humanité 4/.test(c.$('fly-finished-stats').textContent) && /Génération 1 : 13 parties vécues, taux de victoire 62 %/.test(c.$('fly-finished-stats').textContent));
  assert.ok(c.$('fly-finished-stats').querySelector('polyline'));
  assert.ok(!c.hidden('fly-btn-replay'));
  c.$('fly-btn-replay').click();
  assert.ok(c.emitted.some(e => e.ev === 'play_again'));
});
test('Défaite, nul et partie non comptée dans les statistiques', () => {
  const c = boot(); c.fire('game_started', startedPayload(stats()));
  const p = finishedPayload({ counted: false }); p.players[0].result = 'defeat';
  c.fire('game_finished', p);
  assert.ok(/DÉFAITE/.test(c.$('fly-finished-outcome').textContent));
  assert.ok(/n'est pas comptée dans ses statistiques/.test(c.$('fly-finished-learned').textContent));
  const q = finishedPayload(); q.players[0].result = 'participation';
  c.fire('game_finished', q);
  assert.ok(/ÉGALITÉ/.test(c.$('fly-finished-outcome').textContent));
});
test('Reconnexion (fly_state) : équipe, score, dernier choix révélé restaurés', () => {
  const c = boot(); c.fire('game_started', { ...startedPayload(undefined), turn: 2 });
  c.fire('fly_state', { stats: stats(), score: 1100, team: [], history: [entry(1), entry(2, { pokemon: mon('Salamèche') })], thinking: false, finished: false });
  assert.strictEqual(c.$('fly-team').children.length, 2);
  assert.strictEqual(c.$('fly-score-value').textContent, '1100');
  assert.ok(!c.$('fly-reveal-panel').classList.contains('fly-reveal--hidden'));
  c.fire('fly_state', { stats: stats(), score: 550, team: [], history: [entry(1)], thinking: true, finished: false });
  assert.ok(c.$('fly-reveal-panel').classList.contains('fly-reveal--hidden'));
  assert.ok(/hésite/.test(c.$('fly-card-status').textContent));
});
test('Reprise après coup d\'une partie terminée (sans détail) : écran neutre sans erreur', async () => {
  const c = boot(); c.setStats(stats());
  c.fire('rejoin_success', { gameId: 'ABCD', status: 'finished', gameMode: 'fly', hostId: 'sock1', players: [{ id: 'sock1', name: 'Moi', score: 900, team: [] }], boss: null, chatMessages: [] });
  assert.strictEqual(c.errors.length, 0, c.errors.join('|'));
  assert.ok(!c.hidden('screen-fly-finished'));
  assert.strictEqual(c.$('fly-finished-outcome').textContent, 'Partie terminée.');
  await new Promise(r => setTimeout(r, 20));
  assert.ok(/Humanité/.test(c.$('fly-finished-stats').textContent));
});
test('Un autre mode ensuite : l\'interface fly disparaît, le mode normal fonctionne comme avant', () => {
  const c = boot(); c.fire('game_started', startedPayload(stats()));
  c.fire('game_started', {
    gameId: 'EFGH', status: 'playing', turn: 1, maxTurns: 6, route, gameMode: 'normal', adminId: null,
    boss: { id: 150, name: 'Mewtwo', sprite: '/mewtwo.png', requiredPoints: 2500, types: ['psychic'], difficulty: 'medium' },
    players: [{ id: 'sock1', name: 'Moi', score: 0, team: [] }]
  });
  assert.ok(!c.w.document.body.classList.contains('fly-mode'));
  assert.ok(c.hidden('fly-card'));
  assert.strictEqual(c.$('boss-name').textContent, 'MEWTWO');
  assert.strictEqual(c.$('boss-target-value').textContent, '2500');
  assert.strictEqual(c.errors.length, 0, c.errors.join('|'));
});
test('Après une partie à boss, une partie fly n\'affiche aucun résidu de boss / de type', () => {
  const c = boot();
  c.fire('connect');
  c.fire('game_started', {
    gameId: 'E', status: 'playing', turn: 1, maxTurns: 6, route, gameMode: 'normal', adminId: null,
    boss: { id: 150, name: 'Mewtwo', sprite: '/m.png', requiredPoints: 2500, types: ['psychic'], weaknesses: [{ type: 'ghost', multiplier: 2 }], counterType: 'ghost',
      typeRules: { weakness: { enabled: true, multiplierX2: 1.25, multiplierX4: 1.5 }, affinity: { enabled: true, tiers: [{ min: 2, rate: 0.05 }] } }, difficulty: 'medium' },
    players: [{ id: 'sock1', name: 'Moi', score: 0, team: [] }]
  });
  assert.ok(!c.hidden('boss-types'));
  c.fire('game_started', startedPayload(stats()));
  c.fire('game_updated', { status: 'playing', turn: 1, maxTurns: 6, route, players: [{ id: 'sock1', name: 'Moi', score: 0, team: [], typeBonus: { weakness: 5, affinity: { counterType: 'ghost', count: 2, rate: 0.05, bonus: 3, nextTier: null }, total: 8 } }] });
  assert.ok(c.hidden('type-bonus-panel') && c.hidden('boss-weak') && c.hidden('boss-types'), 'résidu de boss / de type visible en fly');
  assert.strictEqual(c.errors.length, 0, c.errors.join('|'));
});
test('Sécurité : noms venant du serveur affichés en texte, jamais interprétés comme HTML', () => {
  const c = boot(); c.fire('game_started', startedPayload(stats()));
  const evil = '<img src=x onerror="window.__pwn=1">';
  c.fire('fly_choice_revealed', entry(1, { pokemon: mon(evil) }));
  c.fire('game_finished', finishedPayload({ turns: Array.from({ length: 6 }, (_, i) => ({ ...entry(i + 1, { pokemon: mon(evil) }), humanChoice: 'HAUT', humanPointsGained: 1 })) }));
  assert.ok(!c.w.document.querySelector('img[onerror]'));
  assert.strictEqual(c.w.__pwn, undefined);
});
test('Courbe : taux lissé correct (W=1, D=0,5, L=0), pas de courbe sous 5 parties', () => {
  const c = boot();
  const r = c.w.FlyUI.rollingRates(['W', 'L', 'D', 'W']);
  assert.deepStrictEqual(r, [1, 0.5, 0.5, 0.625]);
  const long = c.w.FlyUI.rollingRates(Array(30).fill('W').concat(Array(20).fill('L')));
  assert.strictEqual(long[29], 1); assert.strictEqual(long[49], 0);
  const box = c.w.document.createElement('div');
  c.w.FlyUI.renderStats(box, stats({ recent: ['W', 'L', 'W'] }));
  assert.ok(!box.querySelector('svg'));
  c.w.FlyUI.renderStats(box, stats({ brain: { gamesPlayed: 0, flyWins: 0, humanityWins: 0, draws: 0, winRate: null }, global: { gamesPlayed: 0, flyWins: 0, humanityWins: 0, draws: 0, winRate: null }, recent: [] }));
  assert.ok(/débute/.test(box.textContent));
});
test('Après un reset admin : génération +1 et « aucune partie vécue », « Humanité X – Mouche Y » inchangé, courbe conservée', () => {
  const c = boot();
  const before = stats();
  const after = stats({ brain: { gamesPlayed: 0, flyWins: 0, humanityWins: 0, draws: 0, winRate: null } });
  after.generation = 2;
  c.w.FlyUI.renderStats(c.$('fly-lobby-stats'), before);
  const scoreBefore = c.$('fly-lobby-stats').querySelector('.fly-stats__score').textContent;
  c.w.FlyUI.renderStats(c.$('fly-lobby-stats'), after);
  assert.strictEqual(c.$('fly-lobby-stats').querySelector('.fly-stats__score').textContent, scoreBefore);
  assert.ok(/Génération 2 : aucune partie vécue/.test(c.$('fly-lobby-stats').textContent));
  assert.ok(c.$('fly-lobby-stats').querySelector('polyline'));
  c.fire('game_started', startedPayload(after));
  assert.ok(/Génération 2 · aucune partie vécue/.test(c.$('fly-card-meta').textContent), c.$('fly-card-meta').textContent);
});
test('Le client n\'émet rien sur la Mouche : seulement play_again / leave_game ; aucune décision lisible', () => {
  const src = read('fly-client.js');
  const emits = [...src.matchAll(/socket\.emit\('([a-z_]+)'/g)].map(m => m[1]).sort();
  assert.deepStrictEqual(emits, ['leave_game', 'play_again']);
  assert.ok(!/probs|weights|phis|baseline|trajectory/.test(src));
});
test('client.js est strictement inchangé par le patch', () => {
  const orig = '/mnt/user-data/uploads/client.js';
  if (fs.existsSync(orig)) assert.strictEqual(read('client.js'), fs.readFileSync(orig, 'utf8'));
});

(async () => {
  for (const { name, fn } of tests) {
    try { await fn(); pass++; console.log(`  ✔ ${name}`); }
    catch (e) { fail++; console.log(`  ✘ ${name}\n      ${(e && e.message || e).toString().split('\n')[0]}`); }
  }
  console.log(`\n${pass} réussi(s), ${fail} échec(s)`);
  process.exit(fail ? 1 : 0);
})();
