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
    card: $('daily-card'), cardBoss: $('daily-card-boss'), cardStatus: $('daily-card-status'), cardStreak: $('daily-card-streak'), finalStreak: $('daily-final-streak'),
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
    finalBoard: $('daily-btn-final-board'), finalHome: $('daily-btn-final-home'), finalShare: $('daily-btn-share'),
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
  let lastHeader = null; // { day, boss } affichés
  let lastFinal = null;

  // ---------- Série ----------
  const STREAK_TIERS = [
    { min: 100, label: '👑 Légende' }, { min: 30, label: '💎 Diamant' }, { min: 14, label: '⚡ Éclair' },
    { min: 7, label: '🔥 Flamme' }, { min: 3, label: '✨ Étincelle' }
  ];
  const streakBadge = n => { const t = STREAK_TIERS.find(x => n >= x.min); return t ? t.label : ''; };
  const streakText = n => `🔥 Série : ${n} jour${n > 1 ? 's' : ''}`;

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
    lastHeader = { day, boss };
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
    lastFinal = f;
    const win = !!f.victory;
    el.outcome.textContent = win ? 'VICTOIRE !' : 'DÉFAITE';
    el.outcome.classList.toggle('finished-outcome--victory', win);
    el.outcome.classList.toggle('finished-outcome--defeat', !win);
    el.finalScore.textContent = `${f.score} / ${f.required} PTS`;
    if (f.ranked && f.rank) el.finalRank.textContent = `Rang #${f.rank} sur ${f.total} aujourd'hui`;
    else el.finalRank.textContent = 'Ton score est enregistré au classement du jour.';
    el.finalXp.textContent = f.xpGained ? `+${f.xpGained} XP${f.streakBonus ? ` (dont +${f.streakBonus} de série)` : ''}` : '';
    el.finalXp.classList.toggle('screen--hidden', !f.xpGained);
    if (f.streak > 0) {
      const badge = streakBadge(f.streak);
      el.finalStreak.textContent = `${streakText(f.streak)}${badge ? ' · ' + badge : ''}${f.bestStreak > f.streak ? ` · record ${f.bestStreak}` : ''}`;
      el.finalStreak.classList.remove('screen--hidden');
    } else {
      el.finalStreak.classList.add('screen--hidden');
    }
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
    refreshPushState();
    if (!played) { if (win && typeof playVictorySound === 'function') playVictorySound(); else if (!win && typeof playDefeatSound === 'function') playDefeatSound(); }
    refreshInfo();
  }

  function openShare() {
    if (!lastFinal || !lastHeader || !window.RDBShare) return;
    const f = lastFinal, boss = lastHeader.boss;
    const account = getStoredAccount();
    window.RDBShare.open({
      title: 'Défi du ' + fmtDay(lastHeader.day),
      boss: { name: boss.name, sprite: boss.sprite },
      difficultyKey: boss.group,
      difficultyLabel: DIFFICULTY_LABELS[boss.group] || '',
      victory: !!f.victory,
      score: f.score,
      required: f.required,
      rankLine: (f.rank ? `Rang #${f.rank} sur ${f.total} aujourd'hui` : '') + (f.streak > 1 ? `${f.rank ? ' · ' : ''}🔥 série ${f.streak}` : '') || null,
      choices: f.choices || [],
      team: (f.team || []).map(m => ({ name: m.name, shiny: !!m.shiny, urls: [m.shiny && m.shinySprite ? m.shinySprite : null, m.sprite] })),
      pseudo: (account && account.pseudo) || '',
      url: location.origin
    });
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
        const lvl = document.createElement('span'); lvl.className = 'leaderboard-item__level';
        lvl.textContent = e.victory ? '✅' : '❌'; lvl.title = e.victory ? 'Victoire' : 'Défaite';
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
    el.cardBoss.textContent = `Boss du jour : ${b.name} · ${DIFFICULTY_LABELS[b.group] || ''} · objectif ${b.requiredPoints} PTS. Mêmes Pokémon pour tous, 1 seul essai par compte, victoire ou défaite classée.`;
    const m = info.mine;
    const sk = info.streak;
    if (token() && sk && sk.current > 0) {
      const badge = streakBadge(sk.current);
      el.cardStreak.textContent = `${streakText(sk.current)}${badge ? ' · ' + badge : ''}${sk.best > sk.current ? ` · record ${sk.best}` : ''}${sk.atRisk ? ' · joue avant minuit pour la garder !' : ''}`;
      el.cardStreak.classList.toggle('daily-streak--risk', !!sk.atRisk);
      el.cardStreak.classList.remove('screen--hidden');
    } else {
      el.cardStreak.classList.add('screen--hidden');
    }
    el.btnPlay.disabled = false;
    if (!token()) {
      el.cardStatus.textContent = 'Connecte-toi pour jouer et apparaître au classement.';
      el.btnPlay.textContent = 'Se connecter pour jouer';
    } else if (info.rankingAvailable === false) {
      el.cardStatus.textContent = 'Défi indisponible pour le moment.';
      el.btnPlay.disabled = true;
    } else if (m && m.finished) {
      el.cardStatus.textContent = `✅ Terminé : ${m.score} PTS${m.rank ? ' · #' + m.rank : ''} · prochain défi dans ${fmtCountdown()}`;
      el.btnPlay.textContent = 'Voir mon résultat';
    } else {
      el.cardStatus.textContent = info.participants != null ? `${info.participants} joueur${info.participants > 1 ? 's' : ''} ont terminé aujourd'hui.` : '';
      el.btnPlay.textContent = m && m.started ? 'Reprendre' : 'Jouer';
    }
    refreshPushState();
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
    if (!token()) {
      el.cardStatus.textContent = 'Connecte-toi pour jouer : 1 essai par compte.';
      const open = $('btn-account-open');
      if (open) open.click();
      return;
    }
    el.btnPlay.disabled = true;
    setTimeout(() => { el.btnPlay.disabled = !info || info.rankingAvailable === false; }, 1500);
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
  el.finalShare.addEventListener('click', openShare);
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

  // ---------- Rappels push ----------
  const pushBlocks = [...document.querySelectorAll('[data-push="block"]')];
  const pushToggles = [...document.querySelectorAll('[data-push="toggle"]')];
  const pushHints = [...document.querySelectorAll('[data-push="hint"]')];
  const pushSupported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  let pushCfg = null;      // { enabled, publicKey, hour } (null = pas encore chargé)
  let pushSub = null;
  let pushBusy = false;
  let pushNote = '';
  let pushRebound = false;

  const withTimeout = (p, ms) => Promise.race([p, new Promise(res => setTimeout(() => res(null), ms))]);
  const readyRegistration = () => withTimeout(navigator.serviceWorker.ready, 3000);

  function b64ToUint8(b64) {
    const pad = '='.repeat((4 - (b64.length % 4)) % 4);
    const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(raw, c => c.charCodeAt(0));
  }

  async function loadPushConfig() {
    if (pushCfg) return pushCfg;
    try {
      const res = await fetch('/api/push/key');
      pushCfg = res.ok ? await res.json() : { enabled: false };
    } catch (e) { return { enabled: false }; }
    return pushCfg;
  }

  function renderPush(state, hint) {
    pushBlocks.forEach(b => b.classList.toggle('screen--hidden', state === 'hidden'));
    pushToggles.forEach(t => {
      t.classList.toggle('screen--hidden', state === 'hint');
      t.disabled = pushBusy;
      t.textContent = state === 'on' ? '🔕 Désactiver les rappels' : '🔔 Activer les rappels';
    });
    pushHints.forEach(h => { h.textContent = pushNote || hint || ''; });
  }

  async function refreshPushState() {
    if (!pushBlocks.length) return;
    const cfg = await loadPushConfig();
    if (!cfg.enabled || !token()) { renderPush('hidden'); return; }
    if (!pushSupported) {
      if (isIos && !isStandalone) renderPush('hint', "Rappels sur iPhone : installe d'abord l'app (Partager → Sur l'écran d'accueil).");
      else renderPush('hidden');
      return;
    }
    if (Notification.permission === 'denied') { renderPush('hint', 'Notifications bloquées : autorise-les dans les réglages du navigateur.'); return; }
    try {
      const reg = await readyRegistration();
      pushSub = reg ? await reg.pushManager.getSubscription() : null;
    } catch (e) { pushSub = null; }
    if (pushSub && !pushRebound) { // rattache l'appareil au compte connecté (changement de compte, clés)
      pushRebound = true;
      fetch('/api/push/subscribe', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accessToken: token(), subscription: pushSub.toJSON() })
      }).catch(() => {});
    }
    renderPush(pushSub ? 'on' : 'off', pushSub ? `Rappel chaque jour vers ${cfg.hour} h si tu n'as pas encore joué.` : '');
  }

  async function enablePush() {
    if (pushBusy) return;
    pushBusy = true; pushNote = '';
    renderPush('off');
    try {
      const cfg = await loadPushConfig();
      if (!cfg.enabled) throw new Error('disabled');
      if (await Notification.requestPermission() !== 'granted') return; // le refresh affiche l'indice "bloquées"
      const reg = await readyRegistration();
      if (!reg) throw new Error('sw');
      let sub = await reg.pushManager.getSubscription();
      if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToUint8(cfg.publicKey) });
      const res = await fetch('/api/push/subscribe', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accessToken: token(), subscription: sub.toJSON(), welcome: true })
      });
      if (!res.ok) { await sub.unsubscribe().catch(() => {}); throw new Error('server'); }
      pushRebound = true;
    } catch (err) {
      pushNote = 'Activation impossible, réessaie.';
    } finally {
      pushBusy = false;
      await refreshPushState();
    }
  }

  async function unsubscribeDevice() {
    const reg = pushSupported ? await readyRegistration() : null;
    const sub = reg ? await reg.pushManager.getSubscription() : null;
    if (!sub) return;
    const endpoint = sub.endpoint;
    await sub.unsubscribe().catch(() => {});
    await fetch('/api/push/unsubscribe', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint })
    }).catch(() => {});
  }

  async function disablePush() {
    if (pushBusy) return;
    pushBusy = true; pushNote = '';
    renderPush('on');
    try { await unsubscribeDevice(); } finally { pushBusy = false; pushSub = null; await refreshPushState(); }
  }

  pushToggles.forEach(t => t.addEventListener('click', () => (pushSub ? disablePush() : enablePush())));

  // Clic sur la notification : ouvre directement le défi (fenêtre déjà ouverte ou lien ?daily=1).
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data && e.data.type === 'open-daily' && document.body.dataset.screen === 'home' && token() && !inRun) startDaily();
    });
  }
  (function consumeDailyParam() {
    const params = new URLSearchParams(location.search);
    if (!params.has('daily')) return;
    params.delete('daily');
    const qs = params.toString();
    history.replaceState(null, '', location.pathname + (qs ? '?' + qs : '') + location.hash);
    const go = () => setTimeout(() => { if (document.body.dataset.screen === 'home' && token()) startDaily(); }, 500);
    if (socket.connected) go(); else socket.once('connect', go);
  })();

  // Connexion / déconnexion / renouvellement de session : rafraîchit la carte immédiatement.
  if (typeof window.setStoredAccount === 'function') {
    const originalSetStoredAccount = window.setStoredAccount;
    window.setStoredAccount = function (account) {
      const out = originalSetStoredAccount.apply(this, arguments);
      if (!account) { pushRebound = false; unsubscribeDevice().then(() => { pushSub = null; refreshPushState(); }); }
      setTimeout(refreshInfo, 0);
      return out;
    };
  }

  document.addEventListener('visibilitychange', () => { if (!document.hidden && document.body.dataset.screen === 'home') refreshInfo(); });
  setInterval(() => { if (!document.hidden && document.body.dataset.screen === 'home') refreshInfo(); }, 120000);
  refreshInfo();
})();
