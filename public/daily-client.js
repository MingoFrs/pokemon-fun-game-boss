/* DÉFI QUOTIDIEN — client. Dépend de client.js (socket, showScreen, screenHome,
 * getStoredAccount, avatarUrl, DIFFICULTY_LABELS, playVictorySound/playDefeatSound).
 * Les sprites reçus (daily_state / daily_turn / daily_result / daily_finished) passent par
 * le hook de l'écran de chargement : aucun code de préchargement ici. */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const screenDaily = $('screen-daily');
  if (!screenDaily) return;

  const el = {
    card: $('daily-card'), cardBoss: $('daily-card-boss'), cardStatus: $('daily-card-status'),
    btnPlay: $('btn-daily-play'), btnBoard: $('btn-daily-board'),
    date: $('daily-date'), back: $('daily-btn-back'), error: $('daily-error'),
    bossSprite: $('daily-boss-sprite'), bossName: $('daily-boss-name'), bossTarget: $('daily-target'), bossDiff: $('daily-difficulty'),
    play: $('daily-play'), turn: $('daily-turn'), turnMax: $('daily-turn-max'), score: $('daily-score'),
    choices: $('daily-choices'), btnHaut: $('daily-btn-haut'), btnBas: $('daily-btn-bas'),
    hautSprite: $('daily-haut-sprite'), hautName: $('daily-haut-name'), basSprite: $('daily-bas-sprite'), basName: $('daily-bas-name'),
    result: $('daily-result'), resRarity: $('daily-res-rarity'), resSprite: $('daily-res-sprite'), resName: $('daily-res-name'),
    resBase: $('daily-res-base'), resEffect: $('daily-res-effect'), resPoints: $('daily-res-points'),
    next: $('daily-btn-next'), quit: $('daily-btn-quit'),
    final: $('daily-final'), outcome: $('daily-final-outcome'), finalScore: $('daily-final-score'), finalRank: $('daily-final-rank'),
    finalXp: $('daily-final-xp'), finalBest: $('daily-final-best'), finalTeam: $('daily-final-team'), finalNext: $('daily-final-next'),
    finalBoard: $('daily-btn-final-board'), finalHome: $('daily-btn-final-home'),
    board: $('daily-board'), boardMe: $('daily-board-me'), boardList: $('daily-board-list'), boardBack: $('daily-btn-board-back')
  };

  const RARITY_LABELS = {
    commun: 'Commun', peu_commun: 'Peu commun', rare: 'Rare', epique: 'Épique',
    pseudo_legendaire: 'Semi-légendaire', mega: 'Méga', legendaire: 'Légendaire', fabuleux: 'Fabuleux', ultra_chimere: 'Ultra-chimère'
  };
  const rarityLabel = r => RARITY_LABELS[r] || String(r || '').replace(/_/g, ' ');
  const token = () => { const a = getStoredAccount(); return (a && a.accessToken) || null; };

  let info = null;      // dernier /api/daily/info (+ fetchedAt)
  let inRun = false;    // essai en cours (reprise auto après coupure)
  let ranked = false;
  let finalShown = false;
  let boardPrev = 'home';

  // ---------- Navigation ----------
  function showScreenDaily() {
    document.querySelectorAll('.screen').forEach(s => s.classList.add('screen--hidden'));
    screenDaily.classList.remove('screen--hidden');
    document.body.dataset.screen = 'daily';
    window.scrollTo(0, 0);
  }
  function setView(name) {
    el.play.classList.toggle('screen--hidden', name !== 'play');
    el.final.classList.toggle('screen--hidden', name !== 'final');
    el.board.classList.toggle('screen--hidden', name !== 'board');
  }
  function leaveDaily() {
    screenDaily.classList.add('screen--hidden');
    inRun = false;
    showScreen(screenHome);
    refreshInfo();
  }
  function showError(msg) { el.error.textContent = msg || ''; }

  // ---------- Rendu ----------
  function fmtDay(day) {
    try { return new Date(day + 'T12:00:00').toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' }); }
    catch (e) { return day; }
  }
  function fmtCountdown() {
    if (!info) return '';
    const ms = Math.max(0, info.msUntilReset - (Date.now() - info.fetchedAt));
    const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000);
    return h > 0 ? `${h} h ${String(m).padStart(2, '0')}` : `${Math.max(1, m)} min`;
  }
  function renderHeader(day, boss) {
    el.date.textContent = 'Défi du ' + fmtDay(day);
    el.bossSprite.src = boss.sprite;
    el.bossName.textContent = boss.name.toUpperCase();
    el.bossTarget.textContent = boss.requiredPoints;
    el.bossDiff.textContent = DIFFICULTY_LABELS[boss.group] || '';
  }
  const spriteOf = o => (o.shiny && o.shinySprite) ? o.shinySprite : o.sprite;

  function renderTurn(turn, score, options, maxTurns) {
    el.turn.textContent = turn;
    if (maxTurns) el.turnMax.textContent = maxTurns;
    el.score.textContent = score;
    el.result.classList.add('result-panel--hidden');
    el.choices.classList.remove('screen--hidden');
    [[el.btnHaut, el.hautSprite, el.hautName, options.haut], [el.btnBas, el.basSprite, el.basName, options.bas]].forEach(([btn, img, name, o]) => {
      img.src = spriteOf(o);
      name.textContent = o.name;
      btn.disabled = false;
      btn.classList.remove('choice-card--selected', 'choice-card--rejected');
      btn.classList.toggle('choice-card--shiny', !!o.shiny);
    });
  }

  function renderResult(r, hideChoices) {
    el.turn.textContent = r.turn;
    el.score.textContent = r.score;
    el.btnHaut.disabled = true; el.btnBas.disabled = true;
    if (hideChoices) el.choices.classList.add('screen--hidden');
    else {
      const picked = r.choice === 'HAUT' ? el.btnHaut : el.btnBas, other = r.choice === 'HAUT' ? el.btnBas : el.btnHaut;
      picked.classList.add('choice-card--selected'); other.classList.add('choice-card--rejected');
    }
    el.resRarity.textContent = rarityLabel(r.rarity);
    el.resSprite.src = spriteOf(r.pokemon);
    el.resName.textContent = r.pokemon.name;
    el.resBase.textContent = r.basePoints;
    el.resEffect.textContent = r.effect.multiplier !== 1 ? `${r.effect.name} ×${r.effect.multiplier}` : r.effect.name;
    el.resPoints.textContent = r.pointsGained;
    el.result.classList.toggle('result-panel--shiny', !!r.pokemon.shiny);
    el.result.classList.remove('result-panel--hidden', 'result-panel--animate');
    void el.result.offsetWidth; // relance l'animation de révélation
    el.result.classList.add('result-panel--animate');
    el.next.textContent = r.last ? 'Voir le résultat' : 'Tour suivant';
    el.next.disabled = false;
  }

  function renderFinal(f, played) {
    finalShown = true;
    const win = !!f.victory;
    el.outcome.textContent = win ? 'VICTOIRE !' : 'DÉFAITE';
    el.outcome.classList.toggle('finished-outcome--victory', win);
    el.outcome.classList.toggle('finished-outcome--defeat', !win);
    el.finalScore.textContent = `${f.score} / ${f.required} PTS`;
    if (f.ranked && f.rank) el.finalRank.textContent = `Rang #${f.rank} sur ${f.total} aujourd'hui`;
    else if (f.guest) el.finalRank.textContent = 'Connecte-toi pour apparaître au classement du jour.';
    else el.finalRank.textContent = 'Classement indisponible pour cet essai.';
    el.finalXp.textContent = f.xpGained ? `+${f.xpGained} XP` : '';
    el.finalXp.classList.toggle('screen--hidden', !f.xpGained);
    el.finalBest.textContent = `Score max possible aujourd'hui : ${f.bestPossible} PTS`;
    el.finalTeam.innerHTML = '';
    (f.team || []).forEach(m => {
      const img = document.createElement('img');
      img.className = 'daily-team__sprite' + (m.shiny ? ' daily-team__sprite--shiny' : '');
      img.src = spriteOf(m); img.alt = m.name; img.title = `${m.name} · ${m.points} PTS`;
      el.finalTeam.appendChild(img);
    });
    el.finalNext.textContent = `Prochain défi dans ${fmtCountdown()}`;
    el.finalBoard.disabled = false;
    setView('final');
    if (!played) { if (win && typeof playVictorySound === 'function') playVictorySound(); else if (!win && typeof playDefeatSound === 'function') playDefeatSound(); }
    refreshInfo();
  }

  async function loadBoard() {
    el.boardList.innerHTML = '';
    el.boardMe.textContent = '';
    const msg = t => { const p = document.createElement('p'); p.className = 'leaderboard-empty'; p.textContent = t; el.boardList.appendChild(p); };
    msg('Chargement…');
    try {
      const res = await fetch('/api/daily/leaderboard', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accessToken: token() }) });
      const data = await res.json();
      el.boardList.innerHTML = '';
      if (!res.ok || !data.available) { msg('Classement indisponible pour le moment.'); return; }
      if (!data.leaderboard.length) { msg("Personne n'a encore terminé le défi aujourd'hui."); return; }
      if (data.me) el.boardMe.textContent = `Ton rang : #${data.me.rank} sur ${data.total}`;
      data.leaderboard.forEach(e => {
        const li = document.createElement('li');
        li.className = 'leaderboard-item' + (e.isSelf ? ' leaderboard-item--self' : '') + (e.rank <= 3 ? ' leaderboard-item--top3' : '');
        const rank = document.createElement('span'); rank.className = 'leaderboard-item__rank';
        rank.textContent = e.rank === 1 ? '🥇' : e.rank === 2 ? '🥈' : e.rank === 3 ? '🥉' : String(e.rank);
        const av = document.createElement('img'); av.className = 'leaderboard-item__avatar'; av.alt = '';
        av.src = e.avatar ? avatarUrl(e.avatar) : '';
        const name = document.createElement('span'); name.className = 'leaderboard-item__pseudo'; name.textContent = e.pseudo;
        const lvl = document.createElement('span'); lvl.className = 'leaderboard-item__level'; lvl.textContent = e.victory ? '✅' : '';
        const pts = document.createElement('span'); pts.className = 'leaderboard-item__xp'; pts.textContent = e.score + ' PTS';
        li.append(rank, av, name, lvl, pts);
        el.boardList.appendChild(li);
      });
    } catch (err) {
      el.boardList.innerHTML = '';
      msg('Classement indisponible pour le moment.');
    }
  }

  // ---------- Carte d'accueil ----------
  function renderCard() {
    if (!info) return;
    const b = info.boss;
    el.cardBoss.textContent = `Boss du jour : ${b.name} · ${DIFFICULTY_LABELS[b.group] || ''} · objectif ${b.requiredPoints} PTS. Mêmes Pokémon pour tous, 1 essai par jour.`;
    const m = info.mine;
    if (m && m.finished) {
      el.cardStatus.textContent = `✅ Terminé : ${m.score} PTS${m.rank ? ' · #' + m.rank : ''} · prochain défi dans ${fmtCountdown()}`;
      el.btnPlay.textContent = 'Voir mon résultat';
    } else {
      el.cardStatus.textContent = info.participants != null ? `${info.participants} joueur${info.participants > 1 ? 's' : ''} ont terminé aujourd'hui.` : '';
      el.btnPlay.textContent = m && m.started ? 'Reprendre' : 'Jouer';
    }
  }
  async function refreshInfo() {
    try {
      const res = await fetch('/api/daily/info', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accessToken: token() }) });
      if (!res.ok) throw new Error('http ' + res.status);
      info = await res.json();
      info.fetchedAt = Date.now();
      renderCard();
    } catch (err) {
      el.cardStatus.textContent = 'Défi indisponible pour le moment.';
    }
  }

  // ---------- Actions ----------
  function startDaily() {
    showError('');
    el.btnPlay.disabled = true;
    setTimeout(() => { el.btnPlay.disabled = false; }, 1500);
    socket.emit('daily_start', { accessToken: token() });
  }
  function choose(choice) {
    el.btnHaut.disabled = true; el.btnBas.disabled = true;
    socket.emit('daily_choice', { choice });
  }
  function quit() {
    if (inRun) {
      const msg = ranked ? "Abandonner ? Ton essai du jour sera clos avec le score actuel." : 'Abandonner ? Ta progression sera perdue.';
      if (!window.confirm(msg)) return;
      socket.emit('daily_quit');
    }
    leaveDaily();
  }

  el.btnPlay.addEventListener('click', startDaily);
  el.btnBoard.addEventListener('click', async () => {
    if (!info) await refreshInfo();
    if (!info) return;
    boardPrev = 'home';
    renderHeader(info.day, info.boss);
    showScreenDaily();
    setView('board');
    loadBoard();
  });
  el.btnHaut.addEventListener('click', () => choose('HAUT'));
  el.btnBas.addEventListener('click', () => choose('BAS'));
  el.next.addEventListener('click', () => { el.next.disabled = true; socket.emit('daily_next'); });
  el.quit.addEventListener('click', quit);
  el.back.addEventListener('click', quit);
  el.finalHome.addEventListener('click', leaveDaily);
  el.finalBoard.addEventListener('click', () => { boardPrev = 'final'; setView('board'); loadBoard(); });
  el.boardBack.addEventListener('click', () => { if (boardPrev === 'final' && finalShown) setView('final'); else leaveDaily(); });

  // ---------- Socket ----------
  socket.on('daily_state', (s) => {
    showError('');
    ranked = !!s.ranked;
    showScreenDaily();
    renderHeader(s.day, s.boss);
    el.turnMax.textContent = s.maxTurns;
    if (s.phase === 'finished') {
      inRun = false;
      renderFinal(s.final, !!s.played);
      return;
    }
    inRun = true;
    finalShown = false;
    setView('play');
    if (s.phase === 'choice') renderTurn(s.turn, s.score, s.options, s.maxTurns);
    else if (s.phase === 'reveal') renderResult(s.lastResult, true);
  });
  socket.on('daily_turn', (t) => renderTurn(t.turn, t.score, t.options));
  socket.on('daily_result', (r) => renderResult(r, false));
  socket.on('daily_finished', (f) => { inRun = false; renderFinal(f, false); });
  socket.on('daily_error', (msg) => {
    if (screenDaily.classList.contains('screen--hidden')) { el.cardStatus.textContent = msg; return; }
    showError(msg);
    if (!inRun) leaveDaily();
  });

  // Coupure réseau pendant un essai : reprise automatique (essai classé conservé 90 s côté serveur).
  socket.on('connect', () => {
    if (inRun) socket.emit('daily_start', { accessToken: token() });
    refreshInfo();
  });

  document.addEventListener('visibilitychange', () => { if (!document.hidden && document.body.dataset.screen === 'home') refreshInfo(); });
  setInterval(() => { if (!document.hidden && document.body.dataset.screen === 'home') refreshInfo(); }, 120000);
  refreshInfo();
})();
