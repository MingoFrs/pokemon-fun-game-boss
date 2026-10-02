'use strict';
// =====================================================================
// MODE 'fly' (Humanité vs Mouche) — AFFICHAGE UNIQUEMENT.
// Chargé AVANT client.js ; client.js appelle FlyClient.init(ctx) en dernière ligne.
// Le client ne calcule rien : il montre ce que le serveur envoie (fly_thinking, fly_choice_revealed,
// fly_state, game_started.fly, game_finished.fly) et ne reçoit JAMAIS probabilités / poids / décision.
// Aucun événement n'est émis vers le serveur depuis ce fichier.
// =====================================================================
(function () {
  const SVG_FLY = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">'
    + '<g fill="#bfe8ff" fill-opacity=".38" stroke="#bfe8ff" stroke-opacity=".8" stroke-width="1.2">'
    + '<ellipse cx="20" cy="37" rx="6.5" ry="16" transform="rotate(30 20 37)"/>'
    + '<ellipse cx="44" cy="37" rx="6.5" ry="16" transform="rotate(-30 44 37)"/></g>'
    + '<path d="M26 33l-9 5M26 38l-10 8M38 33l9 5M38 38l10 8" stroke="#b6e35a" stroke-width="1.6" stroke-linecap="round" fill="none"/>'
    + '<ellipse cx="32" cy="42" rx="8" ry="13" fill="#2f4a35" stroke="#b6e35a" stroke-width="1.6"/>'
    + '<path d="M24.5 40h15M24.5 46h15" stroke="#b6e35a" stroke-opacity=".55" stroke-width="1.4"/>'
    + '<ellipse cx="32" cy="30" rx="7" ry="6" fill="#2f4a35" stroke="#b6e35a" stroke-width="1.6"/>'
    + '<circle cx="32" cy="20" r="6" fill="#2f4a35" stroke="#b6e35a" stroke-width="1.6"/>'
    + '<circle cx="27.8" cy="19" r="3" fill="#e8615d"/><circle cx="36.2" cy="19" r="3" fill="#e8615d"/></svg>';
  const FLY_ICON = 'data:image/svg+xml;utf8,' + encodeURIComponent(SVG_FLY);

  const CURVE_WINDOW = 20;                       // moyenne glissante de la courbe (parties)
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const CHOICE_LABEL = { HAUT: '🔼 HAUT', BAS: '🔽 BAS' };
  const OUTCOME = {
    victory: { text: 'VICTOIRE !', cls: 'finished-outcome--victory' },
    defeat: { text: 'DÉFAITE', cls: 'finished-outcome--defeat' },
    participation: { text: 'ÉGALITÉ', cls: '' }
  };

  let ctx = null;
  const el = {};
  const state = { active: false, maxTurns: 6, score: 0, team: [], scoreRaf: 0, statsToken: 0 };

  const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const reducedMotion = () =>
    document.documentElement.classList.contains('reduce-motion') ||
    !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const percent = r => (typeof r === 'number' && Number.isFinite(r) ? `${Math.round(r * 100)} %` : '—');

  // ---------------------------------------------------------------- Lobby
  function renderLobbyStats(stats) {
    el.lobbyGames.textContent = stats ? String(num(stats.gamesPlayed)) : '—';
    el.lobbyRate.textContent = stats ? percent(stats.winRate) : '—';
    el.lobbyGen.textContent = stats ? String(num(stats.generation)) : '—';
    el.lobbyNote.classList.toggle('screen--hidden', !!stats);
  }

  function loadLobbyStats() {
    const token = ++state.statsToken;
    renderLobbyStats(null);
    fetch('/api/fly/stats', { cache: 'no-store' })
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then(stats => { if (token === state.statsToken) renderLobbyStats(stats); })
      .catch(() => { if (token === state.statsToken) renderLobbyStats(null); });
  }

  function onLobbyMode(mode) {
    if (!ctx) return;
    const isFly = mode === 'fly';
    el.lobbyCard.classList.toggle('screen--hidden', !isFly);
    if (isFly) loadLobbyStats();
  }

  // ---------------------------------------------------------------- Partie
  function renderTeam(team, animateLast) {
    el.team.innerHTML = '';
    for (let i = 0; i < state.maxTurns; i++) {
      const slot = document.createElement('div');
      slot.className = 'team-slot';
      const mon = team[i];
      if (mon) {
        const img = document.createElement('img');
        img.src = ctx.pokemonSprite(mon);
        img.alt = mon.name;
        img.title = mon.shiny ? `${mon.name} ✨` : mon.name;
        if (mon.shiny) { img.onerror = () => { img.src = mon.sprite; }; slot.classList.add('team-slot--shiny'); }
        slot.appendChild(img);
        if (animateLast && i === team.length - 1) slot.classList.add('team-slot--new');
      }
      el.team.appendChild(slot);
    }
  }

  function setScore(value) {
    cancelAnimationFrame(state.scoreRaf);
    state.score = value;
    el.score.textContent = String(value);
  }

  function animateScore(target, delta) {
    cancelAnimationFrame(state.scoreRaf);
    const from = num(Number(el.score.textContent));
    if (delta) {
      el.popup.textContent = `${delta > 0 ? '+' : ''}${delta}`;
      el.popup.classList.toggle('my-score-popup--negative', delta < 0);
      el.popup.classList.remove('my-score-popup--play');
      el.score.classList.remove('my-score-value--pulse');
      void el.popup.offsetWidth;                                  // relance l'animation
      el.popup.classList.add('my-score-popup--play');
      el.score.classList.add('my-score-value--pulse');
    }
    state.score = target;
    if (reducedMotion() || from === target) { el.score.textContent = String(target); return; }
    const t0 = performance.now();
    const duration = 700;
    const step = now => {
      const k = Math.min(1, (now - t0) / duration);
      const eased = 1 - Math.pow(1 - k, 3);
      el.score.textContent = String(Math.round(from + (target - from) * eased));
      if (k < 1) state.scoreRaf = requestAnimationFrame(step);
    };
    state.scoreRaf = requestAnimationFrame(step);
  }

  function clearChoiceBadges() {
    [ctx.choiceHaut, ctx.choiceBas].forEach(btn => btn.classList.remove('choice-card--fly'));
  }

  function setStatus(text, thinking) {
    el.status.textContent = text;
    const dots = document.createElement('span');
    dots.className = 'fly-dots';
    dots.setAttribute('aria-hidden', 'true');
    dots.innerHTML = '<i></i><i></i><i></i>';
    if (thinking) el.status.appendChild(dots);
    el.panel.classList.toggle('fly-panel--thinking', !!thinking);
  }

  function setThinking() {
    el.reveal.classList.add('result-panel--hidden');
    el.reveal.classList.remove('result-panel--animate');
    el.reveal.removeAttribute('data-rarity');
    clearChoiceBadges();
    setStatus('La Mouche hésite', true);
  }

  function showReveal(entry, animate) {
    const mon = entry.pokemon || {};
    el.reveal.dataset.rarity = entry.rarity || 'commun';
    el.reveal.classList.toggle('result-panel--shiny', !!mon.shiny);
    el.revealChoice.textContent = CHOICE_LABEL[entry.choice] || '';
    el.revealRarity.textContent = ctx.rarityLabels[entry.rarity] || '';
    el.revealSprite.src = ctx.pokemonSprite(mon);
    el.revealSprite.onerror = mon.shiny ? () => { el.revealSprite.src = mon.sprite; } : null;
    el.revealName.textContent = mon.shiny ? `✨ ${String(mon.name).toUpperCase()}` : String(mon.name).toUpperCase();
    el.revealBase.textContent = String(num(entry.basePoints));
    const eff = entry.effect || { name: '—', multiplier: 1 };
    el.revealEffect.textContent = mon.shiny
      ? `${eff.name} ×${ctx.formatMultiplier(eff.multiplier)} · Shiny ×${ctx.shinyMultiplier}`
      : `${eff.name} ×${ctx.formatMultiplier(eff.multiplier)}`;
    el.revealEffect.classList.toggle('result-effect--bonus', eff.multiplier >= 1);
    el.revealEffect.classList.toggle('result-effect--malus', eff.multiplier < 1);
    el.revealPoints.textContent = String(num(entry.pointsGained));
    el.reveal.classList.remove('result-panel--hidden');
    el.reveal.classList.remove('result-panel--animate');
    if (animate) { void el.reveal.offsetWidth; el.reveal.classList.add('result-panel--animate'); }

    clearChoiceBadges();
    const btn = entry.choice === 'HAUT' ? ctx.choiceHaut : entry.choice === 'BAS' ? ctx.choiceBas : null;
    if (btn) btn.classList.add('choice-card--fly');
    setStatus(`La Mouche a choisi ${entry.choice}`, false);
  }

  function renderGeneration(stats) {
    el.gen.textContent = stats && stats.generation ? `Génération ${stats.generation}` : '';
  }

  function setOpponentBanner() {
    const m = ctx.matchup;
    m.oppName.textContent = 'La Mouche';
    m.oppAvatar.src = FLY_ICON;
    m.oppAvatar.classList.remove('screen--hidden');
  }

  // publicState du serveur : { stats, score, team, history, thinking, finished }
  function applyState(s) {
    if (!s || !state.active) return;
    renderGeneration(s.stats);
    setScore(num(s.score));
    state.team = Array.isArray(s.team) ? s.team.slice() : [];
    renderTeam(state.team, false);
    const history = Array.isArray(s.history) ? s.history : [];
    if (s.thinking || !history.length) setThinking();
    else showReveal(history[history.length - 1], false);
  }

  // payload = game_started (fly = stats publiques) ou rejoin_success (fly = publicState)
  function onGameStarted(payload) {
    if (!ctx) return;
    state.active = true;
    state.maxTurns = Number(payload && payload.maxTurns) || 6;
    state.team = [];
    ctx.screenGame.classList.add('screen--fly');
    el.panel.classList.remove('screen--hidden');
    setOpponentBanner();
    const fly = payload && payload.fly;
    setScore(0);
    renderTeam([], false);
    renderGeneration(fly && (fly.stats || fly));
    setThinking();
    if (fly && fly.stats) applyState(fly);        // reprise après reconnexion
  }

  // ---------------------------------------------------------------- Fin de partie
  // Moyenne glissante du taux de victoire de la Mouche (nul = 0,5) sur les dernières parties.
  function rollingRates(recent) {
    const pts = recent.map(c => (c === 'W' ? 1 : c === 'D' ? 0.5 : 0));
    return pts.map((_, i) => {
      const win = pts.slice(Math.max(0, i + 1 - CURVE_WINDOW), i + 1);
      return win.reduce((s, x) => s + x, 0) / win.length;
    });
  }

  function svgEl(name, attrs) {
    const n = document.createElementNS(SVG_NS, name);
    Object.keys(attrs || {}).forEach(k => n.setAttribute(k, attrs[k]));
    return n;
  }

  function renderCurve(recent) {
    const box = el.curve;
    box.innerHTML = '';
    const list = Array.isArray(recent) ? recent.filter(c => c === 'W' || c === 'L' || c === 'D') : [];
    if (list.length < 2) {
      const p = document.createElement('p');
      p.className = 'fly-curve__empty';
      p.textContent = 'Pas encore assez de parties pour tracer la courbe.';
      box.appendChild(p);
      return;
    }
    const rates = rollingRates(list);
    const W = 320, H = 130, L = 34, R = 12, T = 12, B = 14;
    const x = i => L + (i / (rates.length - 1)) * (W - L - R);
    const y = v => T + (1 - v) * (H - T - B);
    const svg = svgEl('svg', {
      viewBox: `0 0 ${W} ${H}`, class: 'fly-curve__svg', role: 'img',
      'aria-label': `Taux de victoire de la Mouche sur les ${list.length} dernières parties : `
        + `${percent(rates[0])} au début, ${percent(rates[rates.length - 1])} actuellement.`
    });
    [1, 0.5, 0].forEach(v => {
      svg.appendChild(svgEl('line', { x1: L, x2: W - R, y1: y(v), y2: y(v), class: v === 0.5 ? 'fly-curve__mid' : 'fly-curve__grid' }));
      const t = svgEl('text', { x: L - 6, y: y(v) + 3.5, class: 'fly-curve__tick', 'text-anchor': 'end' });
      t.textContent = `${Math.round(v * 100)} %`;
      svg.appendChild(t);
    });
    const pts = rates.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
    svg.appendChild(svgEl('polygon', { points: `${x(0).toFixed(1)},${y(0)} ${pts} ${x(rates.length - 1).toFixed(1)},${y(0)}`, class: 'fly-curve__area' }));
    svg.appendChild(svgEl('polyline', { points: pts, class: 'fly-curve__line' }));
    svg.appendChild(svgEl('circle', { cx: x(rates.length - 1), cy: y(rates[rates.length - 1]), r: 3.5, class: 'fly-curve__dot' }));
    box.appendChild(svg);
    const cap = document.createElement('p');
    cap.className = 'fly-curve__caption';
    cap.textContent = `Victoires de la Mouche, ${list.length} dernières parties (moyenne sur ${Math.min(CURVE_WINDOW, list.length)}).`;
    box.appendChild(cap);
  }

  function renderTurns(turns) {
    el.turns.innerHTML = '';
    turns.forEach(t => {
      const mine = typeof t.humanPointsGained === 'number' ? t.humanPointsGained : null;
      const hers = num(t.pointsGained);
      const li = document.createElement('li');
      li.className = 'fly-turn';

      const side = (label, choice, points, won, mon) => {
        const d = document.createElement('div');
        d.className = 'fly-turn__side' + (won ? ' fly-turn__side--won' : '');
        if (mon) {
          const img = document.createElement('img');
          img.src = ctx.pokemonSprite(mon);
          img.alt = mon.name;
          img.title = mon.shiny ? `${mon.name} ✨` : mon.name;
          if (mon.shiny) img.onerror = () => { img.src = mon.sprite; };
          d.appendChild(img);
        }
        const p = document.createElement('p');
        p.className = 'fly-turn__who';
        p.textContent = label;
        const c = document.createElement('p');
        c.className = 'fly-turn__what';
        c.textContent = `${choice ? CHOICE_LABEL[choice] || choice : '—'} · ${points === null ? '—' : `${points} PTS`}`;
        const box = document.createElement('div');
        box.appendChild(p); box.appendChild(c);
        d.appendChild(box);
        return d;
      };

      const n = document.createElement('span');
      n.className = 'fly-turn__n';
      n.textContent = `Tour ${t.turn}`;
      li.appendChild(n);
      li.appendChild(side('Toi', t.humanChoice, mine, mine !== null && mine > hers, null));
      li.appendChild(side('La Mouche', t.choice, hers, mine !== null && hers > mine, t.pokemon));
      el.turns.appendChild(li);
    });
  }

  // Reconstruit un résumé minimal depuis rejoin_success (publicState) : pas de choix humains ni d'apprentissage.
  function fromRejoin(fly, me) {
    const pub = fly || {};
    const flyScore = num(pub.score);
    const mine = me ? num(me.score) : 0;
    const result = flyScore > mine ? 'win' : flyScore < mine ? 'loss' : 'draw';
    return {
      score: flyScore, team: Array.isArray(pub.team) ? pub.team : [], result,
      humanResult: { win: 'defeat', loss: 'victory', draw: 'participation' }[result],
      turns: Array.isArray(pub.history) ? pub.history : [], learned: null, stats: pub.stats || null
    };
  }

  function onGameFinished({ players, fly, fromRejoin: rejoined }) {
    if (!ctx) return;
    const me = (players || []).find(p => p.id === ctx.getMyId()) || (players || [])[0] || null;
    const f = rejoined ? fromRejoin(fly, me) : (fly || fromRejoin(null, me));
    const humanResult = (me && me.result) || f.humanResult || 'participation';
    const out = OUTCOME[humanResult] || OUTCOME.participation;
    const stats = f.stats || {};

    ctx.finishedOutcome.textContent = out.text;
    ctx.finishedOutcome.classList.toggle('finished-outcome--victory', humanResult === 'victory');
    ctx.finishedOutcome.classList.toggle('finished-outcome--defeat', humanResult === 'defeat');
    if (humanResult === 'victory') ctx.sounds.victory(); else if (humanResult === 'defeat') ctx.sounds.defeat();

    el.humanScore.textContent = String(me ? num(me.score) : 0);
    el.flyScore.textContent = String(num(f.score));
    el.duelHuman.classList.toggle('fly-duel__side--won', humanResult === 'victory');
    el.duelFly.classList.toggle('fly-duel__side--won', humanResult === 'defeat');

    if (f.learned === true) {
      el.learned.textContent = 'Elle a appris de cette partie.';
      el.learnedSub.textContent = stats.generation ? `Génération ${stats.generation} · ${num(stats.gamesPlayed)} parties jouées` : '';
    } else if (f.learned === false) {
      el.learned.textContent = 'Cette partie n’a pas servi à entraîner la Mouche.';
      el.learnedSub.textContent = '';
    } else {
      el.learned.textContent = '';
      el.learnedSub.textContent = '';
    }
    el.learnedBox.classList.toggle('screen--hidden', !el.learned.textContent);

    const hasStats = typeof stats.gamesPlayed === 'number';
    el.tally.classList.toggle('screen--hidden', !hasStats);
    if (hasStats) {
      el.tallyHuman.textContent = String(num(stats.humanityWins));
      el.tallyFly.textContent = String(num(stats.flyWins));
      const d = num(stats.draws);
      el.tallyDraws.textContent = d ? `${d} ${d > 1 ? 'égalités' : 'égalité'}` : '';
    }
    renderCurve(stats.recent);

    ctx.renderFinishedTeam((me && me.team) || [], el.humanTeam);
    ctx.renderFinishedTeam(f.team || [], el.flyTeam);
    renderTurns(Array.isArray(f.turns) ? f.turns : []);

    el.classicGrid.classList.add('screen--hidden');
    el.finished.classList.remove('screen--hidden');
    ctx.screenFinished.classList.add('screen--fly');
    ctx.updateReplayControls();
    ctx.showScreen(ctx.screenFinished);
  }

  // ---------------------------------------------------------------- Remise à zéro (resetGameUI)
  function reset() {
    if (!ctx) return;
    state.active = false;
    cancelAnimationFrame(state.scoreRaf);
    ctx.screenGame.classList.remove('screen--fly');
    ctx.screenFinished.classList.remove('screen--fly');
    el.panel.classList.add('screen--hidden');
    el.panel.classList.remove('fly-panel--thinking');
    el.reveal.classList.add('result-panel--hidden');
    el.reveal.classList.remove('result-panel--animate');
    el.reveal.removeAttribute('data-rarity');
    el.team.innerHTML = '';
    el.score.textContent = '0';
    el.status.textContent = '';
    clearChoiceBadges();
    el.finished.classList.add('screen--hidden');
    el.classicGrid.classList.remove('screen--hidden');
    el.curve.innerHTML = '';
    el.turns.innerHTML = '';
    el.humanTeam.innerHTML = '';
    el.flyTeam.innerHTML = '';
  }

  // ---------------------------------------------------------------- Branchement
  function init(c) {
    ctx = c;
    const ids = {
      lobbyCard: 'fly-lobby-card', lobbyGames: 'fly-lobby-games', lobbyRate: 'fly-lobby-rate', lobbyGen: 'fly-lobby-gen',
      lobbyNote: 'fly-lobby-note', lobbyIcon: 'fly-lobby-icon',
      panel: 'fly-panel', panelIcon: 'fly-panel-icon', gen: 'fly-panel-gen', score: 'fly-score-value', popup: 'fly-score-popup',
      status: 'fly-status', team: 'fly-team-slots',
      reveal: 'fly-reveal-panel', revealChoice: 'fly-reveal-choice', revealRarity: 'fly-reveal-rarity', revealSprite: 'fly-reveal-sprite',
      revealName: 'fly-reveal-name', revealBase: 'fly-reveal-base', revealEffect: 'fly-reveal-effect', revealPoints: 'fly-reveal-points',
      classicGrid: 'finished-grid-classic', finished: 'fly-finished', duelHuman: 'fly-duel-human', duelFly: 'fly-duel-fly',
      duelFlyIcon: 'fly-duel-icon', humanScore: 'fly-finished-human-score', flyScore: 'fly-finished-fly-score',
      learnedBox: 'fly-learned-box', learned: 'fly-learned', learnedSub: 'fly-learned-sub',
      tally: 'fly-tally', tallyHuman: 'fly-tally-human', tallyFly: 'fly-tally-fly', tallyDraws: 'fly-tally-draws',
      curve: 'fly-curve', humanTeam: 'fly-finished-human-team', flyTeam: 'fly-finished-fly-team', turns: 'fly-finished-turns'
    };
    Object.keys(ids).forEach(k => { el[k] = document.getElementById(ids[k]); });
    el.lobbyIcon.src = FLY_ICON;
    el.panelIcon.src = FLY_ICON;
    el.duelFlyIcon.src = FLY_ICON;

    ctx.socket.on('fly_thinking', () => { if (state.active) setThinking(); });
    ctx.socket.on('fly_choice_revealed', payload => {
      if (!state.active || !payload) return;
      state.team = state.team.concat([payload.pokemon]).slice(0, state.maxTurns);
      renderTeam(state.team, true);
      showReveal(payload, true);
      animateScore(num(payload.score), num(payload.pointsGained));
      ctx.sounds.reveal();
    });
    ctx.socket.on('fly_state', applyState);
  }

  window.FlyClient = { init, reset, onLobbyMode, onGameStarted, onGameFinished, FLY_ICON };
})();
