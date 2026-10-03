'use strict';
// =====================================================================
// MODE 'fly' (HUMANITÉ vs MOUCHE) — interface. Chargé APRÈS client.js, qui n'est PAS modifié.
// Le client n'affiche que ce que le serveur envoie : aucune décision, aucun calcul de score ni de
// résultat ici. Les événements reçus : fly_thinking, fly_choice_revealed, fly_state, game_started /
// game_finished (champ `fly`). Les stats globales viennent de GET /api/fly/stats.
// Intégration : les fonctions de client.js (applyGameStarted, applyGameFinished, renderGameMode,
// resetGameUI, showScreen) sont enveloppées ; hors mode 'fly', elles s'exécutent à l'identique.
// =====================================================================
(function () {
  const SMOOTH = 20;                 // fenêtre de lissage de la courbe (parties)
  const MIN_POINTS = 5;              // en dessous, pas de courbe
  const $ = id => document.getElementById(id);

  // ---------- Fonctions pures (testées) ----------
  // Taux de victoire de la Mouche, lissé : victoire = 1, nul = 0,5, défaite = 0.
  function rollingRates(recent, smooth = SMOOTH) {
    const val = { W: 1, D: 0.5, L: 0 };
    return recent.map((_, i) => {
      const slice = recent.slice(Math.max(0, i - smooth + 1), i + 1);
      return slice.reduce((s, r) => s + (val[r] ?? 0), 0) / slice.length;
    });
  }
  const pct = x => `${Math.round(x * 100)} %`;

  // Courbe SVG construite par l'API DOM (aucun innerHTML).
  function buildCurve(recent) {
    const NS = 'http://www.w3.org/2000/svg';
    const W = 220, H = 64, PAD = 4;
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('class', 'fly-curve');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'Taux de victoire de la Mouche sur les dernières parties');
    const mid = document.createElementNS(NS, 'line');
    mid.setAttribute('x1', PAD); mid.setAttribute('x2', W - PAD);
    mid.setAttribute('y1', H / 2); mid.setAttribute('y2', H / 2);
    mid.setAttribute('class', 'fly-curve__mid');
    svg.appendChild(mid);
    const rates = rollingRates(recent);
    const n = rates.length;
    const pts = rates.map((r, i) => {
      const x = PAD + (n === 1 ? 0 : (i / (n - 1)) * (W - 2 * PAD));
      const y = H - PAD - r * (H - 2 * PAD);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });
    const line = document.createElementNS(NS, 'polyline');
    line.setAttribute('points', pts.join(' '));
    line.setAttribute('class', 'fly-curve__line');
    svg.appendChild(line);
    return svg;
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  const plural = (n, one, many) => `${n} ${n > 1 ? many : one}`;
  // « N parties vécues, taux de victoire X % » : cerveau COURANT (repart de zéro au reset), parties réellement jouées.
  function lifeText(stats) {
    const b = stats.brain;
    return b.gamesPlayed ? `${plural(b.gamesPlayed, 'partie vécue', 'parties vécues')}, taux de victoire ${pct(b.winRate)}` : 'aucune partie vécue';
  }

  // Encart : « Humanité X – Mouche Y » (score GLOBAL, jamais remis à zéro), génération courante, échauffement, courbe.
  function renderStats(container, stats) {
    container.innerHTML = '';
    if (!stats || !stats.global || !stats.brain) { container.classList.add('screen--hidden'); return; }
    container.classList.remove('screen--hidden');
    const g = stats.global;
    if (!g.gamesPlayed) {
      container.appendChild(el('p', 'fly-stats__line', 'Aucune partie jouée : la Mouche débute.'));
    } else {
      const score = el('p', 'fly-stats__score');
      score.appendChild(el('span', 'fly-stats__humanity', `Humanité ${g.humanityWins}`));
      score.appendChild(el('span', 'fly-stats__dash', ' – '));
      score.appendChild(el('span', 'fly-stats__fly', `Mouche ${g.flyWins}`));
      container.appendChild(score);
      if (g.draws) container.appendChild(el('p', 'fly-stats__line', plural(g.draws, 'nul', 'nuls')));
    }
    container.appendChild(el('p', 'fly-stats__line', `Génération ${stats.generation} : ${lifeText(stats)}.`));
    if (stats.brain.warmupGames > 0) {
      container.appendChild(el('p', 'fly-stats__line', `Échauffement : ${plural(stats.brain.warmupGames, 'partie simulée', 'parties simulées')} avant ses premiers adversaires.`));
    }
    const recent = Array.isArray(stats.recent) ? stats.recent : [];
    if (recent.length >= MIN_POINTS) {
      container.appendChild(buildCurve(recent));
      container.appendChild(el('p', 'fly-stats__caption', `Taux de victoire de la Mouche — ${recent.length} dernières parties (toutes générations)`));
    }
  }

  // ---------- État local (affichage uniquement) ----------
  let active = false;           // une partie fly est affichée
  let revealedThisTurn = false;
  let lastStats = null;

  const flyCard = $('fly-card');
  const flyMeta = $('fly-card-meta');
  const flyStatus = $('fly-card-status');
  const flyScoreValue = $('fly-score-value');
  const flyScorePopup = $('fly-score-popup');
  const flyTeam = $('fly-team');
  const flyCardStats = $('fly-card-stats');
  const revealPanel = $('fly-reveal-panel');
  const lobbyStats = $('fly-lobby-stats');
  const finishedScreen = $('screen-fly-finished');

  function setStatus(kind, text) {
    flyStatus.textContent = text;
    flyStatus.classList.toggle('fly-card__status--thinking', kind === 'thinking');
  }
  function setMeta(stats) {
    flyMeta.textContent = stats && stats.brain ? `Génération ${stats.generation} · ${lifeText(stats)}` : '';
  }
  function setScore(score, delta) {
    if (delta) {
      flyScorePopup.textContent = `+${delta}`;
      flyScorePopup.classList.remove('my-score-popup--play');
      flyScoreValue.classList.remove('my-score-value--pulse');
      void flyScorePopup.offsetWidth;
      flyScorePopup.classList.add('my-score-popup--play');
      flyScoreValue.classList.add('my-score-value--pulse');
    }
    flyScoreValue.textContent = score;
  }
  function addToTeam(pokemon) {
    const slot = el('div', 'team-slot fly-team__slot');
    const img = document.createElement('img');
    img.src = pokemon.shiny && pokemon.shinySprite ? pokemon.shinySprite : pokemon.sprite;
    img.alt = pokemon.name;
    img.title = pokemon.shiny ? `${pokemon.name} ✨` : pokemon.name;
    slot.appendChild(img);
    flyTeam.appendChild(slot);
  }
  function setBanner() {
    gameMatchupOppNameEl.textContent = 'La Mouche 🪰';
    gameMatchupOppAvatarEl.removeAttribute('src');
    gameMatchupOppAvatarEl.classList.add('screen--hidden');
  }
  function hideReveal() {
    revealPanel.classList.add('fly-reveal--hidden');
    revealPanel.removeAttribute('data-rarity');
  }
  function showReveal(entry) {
    $('fly-reveal-choice').textContent = entry.choice === 'HAUT' ? '🔼 HAUT' : '🔽 BAS';
    $('fly-reveal-rarity').textContent = RARITY_LABELS[entry.rarity] || '';
    const sprite = $('fly-reveal-sprite');
    sprite.src = entry.pokemon.shiny && entry.pokemon.shinySprite ? entry.pokemon.shinySprite : entry.pokemon.sprite;
    sprite.onerror = entry.pokemon.shiny ? () => { sprite.src = entry.pokemon.sprite; } : null;
    $('fly-reveal-name').textContent = entry.pokemon.shiny ? `✨ ${entry.pokemon.name.toUpperCase()}` : entry.pokemon.name.toUpperCase();
    $('fly-reveal-base').textContent = entry.basePoints;
    const shinyTxt = entry.pokemon.shiny ? ` · Shiny ×${SHINY_POINTS_MULTIPLIER}` : '';
    $('fly-reveal-effect').textContent = `${entry.effect.name} ×${formatMultiplier(entry.effect.multiplier)}${shinyTxt}`;
    $('fly-reveal-points').textContent = entry.pointsGained;
    revealPanel.dataset.rarity = entry.rarity || 'commun';
    revealPanel.classList.toggle('fly-reveal--shiny', !!entry.pokemon.shiny);
    revealPanel.classList.remove('fly-reveal--hidden');
    revealPanel.classList.remove('result-panel--animate');
    void revealPanel.offsetWidth;
    revealPanel.classList.add('result-panel--animate');
  }

  function resetFlyUI() {
    active = false;
    revealedThisTurn = false;
    document.body.classList.remove('fly-mode');
    flyCard.classList.add('screen--hidden');
    flyTeam.innerHTML = '';
    flyScoreValue.textContent = '0';
    flyScorePopup.textContent = '';
    flyCardStats.innerHTML = '';
    hideReveal();
    finishedScreen.classList.add('screen--hidden');
  }

  // ---------- Démarrage / reprise ----------
  function startFly(p) {
    resetGameUI();                       // (enveloppée) remet aussi l'UI fly à zéro
    resetChatPanel();
    currentGameMode = 'fly';
    currentAdminId = null;
    currentBossInfo = null;              // jamais de boss : pas de panneau de type résiduel
    typeBonusPanelEl.classList.add('screen--hidden');
    bossWeakEl.classList.add('screen--hidden');
    bossTypesEl.classList.add('screen--hidden');
    coopTeamRequired = null;
    active = true;
    document.body.classList.add('fly-mode');
    myScoreLabelEl.textContent = 'Ton score';
    applyGameState({ status: p.status, turn: p.turn, maxTurns: p.maxTurns, route: p.route, players: p.players });
    flyCard.classList.remove('screen--hidden');
    lastStats = p.fly || lastStats;
    setMeta(lastStats);
    renderStats(flyCardStats, lastStats);
    setScore(0, 0);
    setStatus('thinking', '🪰 La Mouche hésite…');
    setBanner();
    showScreen(screenGame);
  }

  // Resynchronisation (reconnexion) : état PUBLIC déjà révélé, jamais la décision en attente.
  function applyState(st) {
    if (!st || !active) return;
    lastStats = st.stats || lastStats;
    setMeta(lastStats);
    renderStats(flyCardStats, lastStats);
    flyTeam.innerHTML = '';
    st.history.forEach(h => addToTeam(h.pokemon));
    flyScoreValue.textContent = st.score;
    const turnDone = st.history.length >= (parseInt(turnCurrentEl.textContent, 10) || 1);
    revealedThisTurn = turnDone;
    if (turnDone) { showReveal(st.history[st.history.length - 1]); setStatus('done', 'La Mouche a choisi.'); }
    else { hideReveal(); setStatus('thinking', '🪰 La Mouche hésite…'); }
    setBanner();
  }

  // ---------- Fin de partie ----------
  function finishFly(p) {
    currentGameMode = 'fly';
    const me = (p.players || []).find(x => x.id === myId) || (p.players || [])[0];
    const fly = p.fly || null;
    const result = me && me.result;
    const label = result === 'victory' ? 'VICTOIRE ! L\'Humanité l\'emporte.' : result === 'defeat' ? 'DÉFAITE… La Mouche l\'emporte.' : result === 'participation' ? 'ÉGALITÉ.' : 'Partie terminée.';
    const out = $('fly-finished-outcome');
    out.textContent = label;
    out.classList.toggle('finished-outcome--victory', result === 'victory');
    out.classList.toggle('finished-outcome--defeat', result === 'defeat');
    if (result === 'victory') playVictorySound(); else if (result === 'defeat') playDefeatSound();

    $('fly-finished-me').textContent = me ? `${me.score} PTS` : '—';
    $('fly-finished-fly').textContent = fly ? `${fly.score} PTS` : '—';

    const turns = $('fly-finished-turns');
    turns.innerHTML = '';
    (fly && fly.turns ? fly.turns : []).forEach(t => {
      const row = el('div', 'fly-turn');
      row.appendChild(el('span', 'fly-turn__n', `T${t.turn}`));
      const mine = el('span', 'fly-turn__side');
      mine.textContent = `Toi : ${t.humanChoice || '—'} · +${t.humanPointsGained ?? 0}`;
      const hers = el('span', 'fly-turn__side fly-turn__side--fly');
      const img = document.createElement('img');
      img.src = t.pokemon.shiny && t.pokemon.shinySprite ? t.pokemon.shinySprite : t.pokemon.sprite;
      img.alt = '';
      hers.appendChild(img);
      hers.appendChild(document.createTextNode(` Mouche : ${t.choice} · ${t.pokemon.name} · +${t.pointsGained}`));
      row.appendChild(mine); row.appendChild(hers);
      turns.appendChild(row);
    });

    const stats = (fly && fly.stats) || lastStats;
    lastStats = stats;
    const lived = $('fly-finished-learned');           // (id historique de l'élément) : chiffres réels de la Mouche
    if (!fly || !stats || !stats.brain) lived.textContent = '';
    else lived.textContent = `La Mouche — génération ${stats.generation} : ${lifeText(stats)}.` +
      (fly.counted === false ? ' Cette partie n\'est pas comptée dans ses statistiques.' : '');
    renderStats($('fly-finished-stats'), stats);
    if (!fly) refreshLobbyStats($('fly-finished-stats'));   // reprise après coup : stats globales via l'API

    $('fly-btn-replay').classList.remove('screen--hidden');
    showScreen(screenFinished);          // masque tous les autres écrans...
    screenFinished.classList.add('screen--hidden');   // ...puis on remplace par l'écran dédié
    finishedScreen.classList.remove('screen--hidden');
  }

  // ---------- Stats globales (lobby) ----------
  function refreshLobbyStats(target) {
    fetch('/api/fly/stats', { cache: 'no-store' })
      .then(r => (r.ok ? r.json() : null))
      .then(st => { if (st) { lastStats = st; renderStats(target, st); } })
      .catch(() => { target.classList.add('screen--hidden'); });
  }

  // ---------- Enveloppes des fonctions de client.js ----------
  const orig = {
    applyGameStarted: window.applyGameStarted, applyGameFinished: window.applyGameFinished,
    renderGameMode: window.renderGameMode, resetGameUI: window.resetGameUI, showScreen: window.showScreen
  };
  window.applyGameStarted = function (p) {
    if (p && p.gameMode === 'fly') return startFly(p);
    resetFlyUI();
    return orig.applyGameStarted.apply(this, arguments);
  };
  window.applyGameFinished = function (p) {
    if (p && p.gameMode === 'fly') return finishFly(p);
    return orig.applyGameFinished.apply(this, arguments);
  };
  window.renderGameMode = function (mode) {
    const r = orig.renderGameMode.apply(this, arguments);
    const isFly = (mode || 'normal') === 'fly';
    const diff = document.querySelector('.difficulty-panel');
    if (diff) diff.classList.toggle('screen--hidden', isFly);
    if (isFly) {
      gamemodeHintEl.textContent = 'Duel solo : tu affrontes La Mouche, une IA qui apprend après chaque partie. Pas de boss : le meilleur score après 6 tours gagne. Tu dois être seul dans le salon.';
      gamemodeHintEl.classList.remove('screen--hidden');
      refreshLobbyStats(lobbyStats);
    } else {
      lobbyStats.classList.add('screen--hidden');
    }
    return r;
  };
  window.resetGameUI = function () {
    const r = orig.resetGameUI.apply(this, arguments);
    resetFlyUI();
    return r;
  };
  window.showScreen = function (screen) {
    finishedScreen.classList.add('screen--hidden');
    return orig.showScreen.apply(this, arguments);
  };

  // ---------- Événements serveur ----------
  socket.on('fly_thinking', () => {
    if (!active) return;
    revealedThisTurn = false;
    setStatus('thinking', '🪰 La Mouche hésite…');
  });
  socket.on('turn_options', () => { if (active) { hideReveal(); revealedThisTurn = false; } });
  socket.on('choice_result', () => {
    // Ton choix est fait : en attendant la Mouche, le statut du tour le dit clairement.
    if (active && !revealedThisTurn) turnStatusEl.textContent = 'La Mouche hésite…';
  });
  socket.on('fly_choice_revealed', (entry) => {
    if (!active) return;
    revealedThisTurn = true;
    addToTeam(entry.pokemon);
    setScore(entry.score, entry.pointsGained);
    setStatus('done', `La Mouche a choisi ${entry.choice === 'HAUT' ? '🔼 HAUT' : '🔽 BAS'}.`);
    turnStatusEl.textContent = 'La Mouche a choisi.';
    showReveal(entry);
  });
  socket.on('fly_state', applyState);
  socket.on('game_updated', () => { if (active) setBanner(); });

  // ---------- Boutons ----------
  $('fly-btn-replay').addEventListener('click', () => socket.emit('play_again'));
  $('fly-btn-leave').addEventListener('click', () => {
    socket.emit('leave_game');
    rememberActiveGame(null);
    resetGameUI();
    showScreen(screenHome);
  });

  // Exposé pour les tests.
  window.FlyUI = { rollingRates, buildCurve, renderStats, startFly, applyState, finishFly, isActive: () => active };
})();
