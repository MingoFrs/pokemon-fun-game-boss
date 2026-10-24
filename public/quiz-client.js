'use strict';
// =====================================================================
// MODE "QUIZ POKÉMON" — côté client (chargé APRÈS client.js, dont il réutilise les globaux :
// socket, isHost, showScreen, screenHome, renderTypeBadges, avatarUrl, rememberActiveGame...).
// Le client n'affiche que ce que le serveur envoie : la correction n'arrive qu'à la révélation.
// =====================================================================
(function () {
  const STAT_KEYS = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'];
  const STAT_LABELS = { hp: 'PV', atk: 'Attaque', def: 'Défense', spa: 'Atq. Spé.', spd: 'Déf. Spé.', spe: 'Vitesse' };
  const $ = id => document.getElementById(id);

  const el = {
    lobbyPanel: $('qz-lobby-panel'), kinds: $('qz-kinds'), rounds: $('qz-rounds'),
    modOptions: $('qz-mod-options'), modActive: $('qz-mod-active'), modNote: $('qz-mod-note'),
    difficultyPanel: $('difficulty-panel'),
    screen: $('screen-quiz'),
    round: $('qz-round'), myScore: $('qz-my-score'), mods: $('qz-mods'), btnLeave: $('qz-btn-leave'),
    timer: $('qz-timer'), timerBar: $('qz-timer-bar'), timerText: $('qz-timer-text'),
    stage: $('qz-stage'), countdown: $('qz-countdown'),
    card: $('qz-card'), kind: $('qz-kind'), clue: $('qz-clue'), hint: $('qz-hint'), options: $('qz-options'), status: $('qz-status'),
    reveal: $('qz-reveal'), side: $('qz-side'), board: $('qz-board'),
    final: $('qz-final'), finalOutcome: $('qz-final-outcome'), finalList: $('qz-final-list'),
    btnReplay: $('qz-btn-replay'), btnFinalLeave: $('qz-btn-final-leave'), finalWait: $('qz-final-wait')
  };
  if (!el.screen || !el.lobbyPanel) return; // HTML non intégré : le mode reste simplement absent

  const S = {
    catalog: null,                    // { ready, kinds[], rounds[], defaultRounds, modifiers[] }
    cfg: null,                        // réglages du lobby { kinds, rounds, mods }
    meSid: null, config: null, players: [], scores: [],
    phase: 'idle', round: 0, rounds: 10,
    question: null, answered: null,   // index choisi par moi (null = pas encore répondu)
    revealed: false,
    deadline: 0, durationMs: 15000, timerRaf: 0, countdownTimer: 0,
    deltas: {}                        // sid -> points gagnés à la dernière révélation
  };

  const fmtSeconds = ms => `${(ms / 1000).toFixed(1).replace('.', ',')} s`;
  const modInfo = key => (S.catalog ? S.catalog.modifiers.find(m => m.key === key) : null);

  // ------------------------------------------------------------------
  // Lobby
  // ------------------------------------------------------------------
  fetch('/api/quiz/config').then(r => r.json()).then(data => {
    if (data && Array.isArray(data.kinds)) {
      S.catalog = data;
      if (!S.cfg) S.cfg = { kinds: data.kinds.map(k => k.key), rounds: data.defaultRounds, mods: [] };
      renderLobby();
    }
  }).catch(() => { /* lobby fonctionne sans : panneau masqué */ });

  function sendConfig(next) {
    socket.emit('quiz_set_config', { kinds: next.kinds, rounds: next.rounds, modifiers: next.mods });
  }

  function chip(text, active, title, onClick, disabled) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'modifier-chip' + (active ? ' modifier-chip--active' : '');
    btn.title = title || '';
    btn.disabled = !!disabled;
    btn.setAttribute('aria-pressed', String(active));
    btn.textContent = text;
    btn.addEventListener('click', onClick);
    return btn;
  }

  function renderLobby() {
    const on = typeof currentGameMode !== 'undefined' && currentGameMode === 'quiz' && !!S.catalog;
    el.lobbyPanel.classList.toggle('screen--hidden', !on);
    // La difficulté du boss n'a aucun sens pour le quiz : on la masque (et on la rend aux autres modes).
    if (el.difficultyPanel && typeof currentGameMode !== 'undefined') el.difficultyPanel.classList.toggle('screen--hidden', currentGameMode === 'quiz');
    if (!on || !S.cfg) return;
    const host = isHost();
    const cfg = S.cfg;

    el.kinds.innerHTML = '';
    S.catalog.kinds.forEach(k => {
      const active = cfg.kinds.includes(k.key);
      const onlyOne = active && cfg.kinds.length === 1; // au moins un type de question
      el.kinds.appendChild(chip(`${k.icon} ${k.label}`, active, k.prompt, () => {
        if (!isHost() || onlyOne) return;
        sendConfig({ ...cfg, kinds: active ? cfg.kinds.filter(x => x !== k.key) : cfg.kinds.concat(k.key) });
      }, !host));
    });

    el.rounds.innerHTML = '';
    S.catalog.rounds.forEach(n => {
      el.rounds.appendChild(chip(`${n} questions`, cfg.rounds === n, '', () => {
        if (!isHost()) return;
        sendConfig({ ...cfg, rounds: n });
      }, !host));
    });

    el.modOptions.innerHTML = '';
    el.modActive.innerHTML = '';
    S.catalog.modifiers.forEach(m => {
      const active = cfg.mods.includes(m.key);
      el.modOptions.appendChild(chip(`${m.icon} ${m.label}`, active, m.description, () => {
        if (!isHost()) return;
        sendConfig({ ...cfg, mods: active ? cfg.mods.filter(x => x !== m.key) : cfg.mods.concat(m.key) });
      }, !host));
      if (active) {
        const li = document.createElement('li');
        li.textContent = `${m.icon} ${m.label} — ${m.description}`;
        el.modActive.appendChild(li);
      }
    });
    const ranked = cfg.mods.length === 0 && cfg.rounds === S.catalog.defaultRounds;
    el.modNote.textContent = ranked ? '' : 'Partie hors-classement : aucune XP (modificateur ou nombre de questions modifié).';
    el.modNote.classList.toggle('screen--hidden', ranked);

    if (typeof gamemodeHintEl !== 'undefined') {
      gamemodeHintEl.classList.remove('screen--hidden');
      gamemodeHintEl.textContent = 'Silhouettes, types ou stats à deviner : 4 choix, une seule tentative. Le plus rapide marque le plus de points.';
    }
  }

  // Greffes non intrusives sur les rendus du lobby de client.js (chaînées avec les autres modules).
  ['renderGameMode', 'renderDifficulty', 'updateHostControls'].forEach(name => {
    const original = window[name];
    if (typeof original !== 'function') return;
    window[name] = function () {
      const out = original.apply(this, arguments);
      renderLobby();
      return out;
    };
  });

  socket.on('quiz_config_updated', ({ config }) => {
    if (config) S.cfg = { kinds: config.kinds, rounds: config.rounds, mods: config.mods };
    renderLobby();
  });

  // ------------------------------------------------------------------
  // Helpers d'écran
  // ------------------------------------------------------------------
  function avatarEl(avatar, name) {
    const span = document.createElement('span');
    span.className = 'qz-avatar';
    if (avatar && typeof avatarUrl === 'function') {
      const img = document.createElement('img');
      img.src = avatarUrl(avatar);
      img.alt = '';
      span.appendChild(img);
    } else {
      span.textContent = (name || '?').slice(0, 1).toUpperCase();
    }
    return span;
  }
  const nameOf = sid => { const p = S.players.find(x => x.sid === sid); return p ? p.name : '—'; };
  const scoreOf = sid => { const s = S.scores.find(x => x.sid === sid); return s ? s.total : 0; };

  function stopTimer() {
    cancelAnimationFrame(S.timerRaf);
    el.timer.classList.add('screen--hidden');
  }
  function stopCountdown() {
    clearInterval(S.countdownTimer);
    S.countdownTimer = 0;
    el.countdown.classList.add('screen--hidden');
  }

  function startTimer(endsInMs, durationMs) {
    S.durationMs = durationMs;
    S.deadline = Date.now() + endsInMs;
    el.timer.classList.remove('screen--hidden');
    cancelAnimationFrame(S.timerRaf);
    const tick = () => {
      const left = Math.max(0, S.deadline - Date.now());
      el.timerBar.style.width = `${Math.min(100, (left / S.durationMs) * 100)}%`;
      el.timerText.textContent = `${Math.ceil(left / 1000)} s`;
      el.timer.classList.toggle('qz-timer--low', left < 4000);
      if (left > 0 && S.phase === 'question') S.timerRaf = requestAnimationFrame(tick);
    };
    tick();
  }

  function resetUi() {
    stopTimer();
    stopCountdown();
    S.question = null; S.answered = null; S.revealed = false; S.deltas = {};
    el.card.classList.add('screen--hidden');
    el.reveal.classList.add('screen--hidden');
    el.reveal.innerHTML = '';
    el.final.classList.add('screen--hidden');
    el.stage.classList.remove('screen--hidden');
    el.side.classList.remove('screen--hidden');
    el.status.textContent = '';
  }

  function renderTop() {
    el.round.textContent = S.round ? `Question ${S.round} / ${S.rounds}` : 'Quiz Pokémon';
    el.myScore.textContent = String(scoreOf(S.meSid));
    el.mods.innerHTML = '';
    (S.config ? S.config.mods : []).forEach(key => {
      const m = modInfo(key);
      if (!m) return;
      const b = document.createElement('span');
      b.className = 'modifier-badge';
      b.title = m.description;
      b.textContent = `${m.icon} ${m.label}`;
      el.mods.appendChild(b);
    });
  }

  function renderBoard() {
    el.board.innerHTML = '';
    const head = document.createElement('p');
    head.className = 'eyebrow';
    head.textContent = 'Classement';
    el.board.appendChild(head);
    const rows = S.players.map(p => ({ p, total: scoreOf(p.sid), streak: (S.scores.find(x => x.sid === p.sid) || {}).streak || 0 }));
    rows.sort((a, b) => b.total - a.total);
    rows.forEach((r, i) => {
      const row = document.createElement('div');
      row.className = 'qz-row' + (r.p.sid === S.meSid ? ' qz-row--me' : '') + (r.p.disconnected ? ' qz-row--off' : '');
      const rank = document.createElement('span');
      rank.className = 'qz-row__rank';
      rank.textContent = String(i + 1);
      const name = document.createElement('span');
      name.className = 'qz-row__name';
      name.textContent = r.p.name + (r.streak >= 2 ? ` 🔥${r.streak}` : '');
      const state = document.createElement('span');
      state.className = 'qz-row__state';
      if (S.phase === 'question') state.textContent = r.p.answered ? '✅' : '⏳';
      else if (S.phase === 'reveal' && S.deltas[r.p.sid] !== undefined) {
        const d = S.deltas[r.p.sid];
        state.textContent = d > 0 ? `+${d}` : String(d);
        state.classList.add(d > 0 ? 'qz-row__state--gain' : d < 0 ? 'qz-row__state--loss' : 'qz-row__state--zero');
      }
      const pts = document.createElement('strong');
      pts.className = 'qz-row__pts';
      pts.textContent = String(r.total);
      row.append(rank, avatarEl(r.p.avatar, r.p.name), name, state, pts);
      el.board.appendChild(row);
    });
  }

  // ------------------------------------------------------------------
  // Question
  // ------------------------------------------------------------------
  function renderClue(q) {
    el.clue.innerHTML = '';
    el.clue.className = `qz-clue qz-clue--${q.kind}`;
    if (q.kind === 'silhouette') {
      const img = document.createElement('img');
      img.className = 'qz-silhouette qz-silhouette--masked';
      img.src = q.clue.image;
      img.alt = '';
      img.draggable = false;
      el.clue.appendChild(img);
    } else if (q.kind === 'types') {
      const badges = document.createElement('div');
      badges.className = 'type-badges qz-clue__types';
      el.clue.appendChild(badges);
      renderTypeBadges(badges, q.clue.types);
    } else {
      const list = document.createElement('div');
      list.className = 'qz-stats';
      STAT_KEYS.forEach(k => {
        const row = document.createElement('div');
        row.className = 'qz-stat';
        const lab = document.createElement('span');
        lab.textContent = STAT_LABELS[k];
        const bar = document.createElement('span');
        bar.className = 'qz-stat__bar';
        const fill = document.createElement('i');
        fill.style.width = `${Math.min(100, (q.clue.stats[k] / 200) * 100)}%`;
        bar.appendChild(fill);
        const val = document.createElement('strong');
        val.textContent = String(q.clue.stats[k]);
        row.append(lab, bar, val);
        list.appendChild(row);
      });
      const total = document.createElement('p');
      total.className = 'qz-stats__total';
      total.textContent = q.clue.bst ? `Total : ${q.clue.bst}` : '';
      el.clue.append(list, total);
    }
  }

  function showHint(hint) {
    if (!hint) { el.hint.classList.add('screen--hidden'); return; }
    el.hint.classList.remove('screen--hidden');
    el.hint.innerHTML = '';
    const label = document.createElement('span');
    label.textContent = '💡 Indice (−25 pts) : ';
    el.hint.appendChild(label);
    if (hint.types) {
      const badges = document.createElement('span');
      badges.className = 'type-badges qz-hint__types';
      el.hint.appendChild(badges);
      renderTypeBadges(badges, hint.types);
    } else if (hint.generation) {
      const g = document.createElement('strong');
      g.textContent = `génération ${hint.generation}`;
      el.hint.appendChild(g);
    }
  }

  function renderOptions() {
    el.options.innerHTML = '';
    if (!S.question) return;
    S.question.options.forEach(o => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'qz-opt';
      btn.dataset.index = String(o.index);
      const key = document.createElement('span');
      key.className = 'qz-opt__key';
      key.textContent = String(o.index + 1);
      const label = document.createElement('span');
      label.className = 'qz-opt__label';
      label.textContent = o.label;
      btn.append(key, label);
      btn.disabled = S.revealed || S.answered !== null;
      if (S.answered === o.index) btn.classList.add('qz-opt--selected');
      btn.addEventListener('click', () => answer(o.index));
      el.options.appendChild(btn);
    });
  }

  function answer(index) {
    if (S.phase !== 'question' || S.answered !== null || S.revealed) return;
    S.answered = index; // optimiste : le serveur confirme par quiz_answer_ok (ou ignore si trop tard)
    socket.emit('quiz_answer', { index });
    renderOptions();
    renderStatus();
  }

  function renderStatus() {
    if (S.phase === 'question') el.status.textContent = S.answered === null ? 'Choisis vite : une seule tentative !' : 'Réponse enregistrée… (la correction arrive à la fin de la question)';
    else if (S.phase === 'reveal') el.status.textContent = '';
  }

  function showQuestion(q, myAnswer) {
    S.phase = 'question';
    S.question = q;
    S.revealed = false;
    S.answered = myAnswer ? myAnswer.index : null;
    S.deltas = {};
    S.players = q.players;
    stopCountdown();
    el.reveal.classList.add('screen--hidden');
    el.card.classList.remove('screen--hidden');
    el.kind.textContent = `${q.icon} ${q.prompt}`;
    renderClue(q);
    showHint(q.hint);
    renderOptions();
    renderStatus();
    startTimer(q.endsInMs, q.durationMs);
    renderTop();
    renderBoard();
  }

  document.addEventListener('keydown', ev => {
    if (S.phase !== 'question' || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    const t = ev.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (ev.key >= '1' && ev.key <= '4') answer(Number(ev.key) - 1);
  });

  // ------------------------------------------------------------------
  // Révélation
  // ------------------------------------------------------------------
  function showReveal(rev) {
    S.phase = 'reveal';
    S.revealed = true;
    S.scores = rev.scores;
    S.deltas = {};
    rev.results.forEach(r => { S.deltas[r.sid] = r.points; });
    stopTimer();

    // La bonne/mauvaise réponse sur les boutons (si l'écran de question est présent).
    if (S.question) {
      el.options.querySelectorAll('.qz-opt').forEach(btn => {
        const i = Number(btn.dataset.index);
        btn.disabled = true;
        btn.classList.remove('qz-opt--selected');
        if (i === rev.correctIndex) btn.classList.add('qz-opt--correct');
        else if (i === S.answered) btn.classList.add('qz-opt--wrong');
        else btn.classList.add('qz-opt--dim');
      });
      // L'image (silhouette ou non) laisse place au vrai sprite + nom + types.
      el.clue.innerHTML = '';
      el.clue.className = 'qz-clue qz-clue--reveal';
      const img = document.createElement('img');
      img.className = 'qz-silhouette qz-silhouette--revealed';
      img.src = rev.sprite;
      img.alt = rev.answerName;
      const name = document.createElement('p');
      name.className = 'qz-clue__name';
      name.textContent = rev.answerName;
      const badges = document.createElement('div');
      badges.className = 'type-badges qz-clue__types';
      el.clue.append(img, name, badges);
      renderTypeBadges(badges, rev.types);
      el.hint.classList.add('screen--hidden');
    }

    const mine = rev.results.find(r => r.sid === S.meSid);
    if (!mine) el.status.textContent = '';
    else if (mine.choice === null) el.status.textContent = 'Pas de réponse : 0 point.';
    else if (mine.correct) el.status.textContent = `Bonne réponse ! +${mine.points} pts (${fmtSeconds(mine.ms)})${mine.first ? ' ⚡ le plus rapide !' : ''}`;
    else el.status.textContent = mine.points < 0 ? `Raté… ${mine.points} pts` : 'Raté… 0 point.';

    el.reveal.classList.remove('screen--hidden');
    el.reveal.innerHTML = '';
    const head = document.createElement('p');
    head.className = 'eyebrow';
    head.textContent = `Question ${rev.round} : ${rev.answerName}`;
    el.reveal.appendChild(head);
    const sorted = rev.results.slice().sort((a, b) => b.points - a.points || (a.ms ?? Infinity) - (b.ms ?? Infinity));
    sorted.forEach(r => {
      const row = document.createElement('div');
      row.className = 'qz-pick' + (r.sid === S.meSid ? ' qz-pick--me' : '') + (r.correct ? ' qz-pick--ok' : '');
      const who = document.createElement('span');
      who.className = 'qz-pick__who';
      who.textContent = nameOf(r.sid);
      const what = document.createElement('span');
      what.className = 'qz-pick__what';
      if (r.choice === null) what.textContent = '— pas de réponse';
      else what.textContent = `${r.correct ? '✅' : '❌'} ${fmtSeconds(r.ms)}${r.first ? ' ⚡' : ''}`;
      const pts = document.createElement('strong');
      pts.className = 'qz-pick__pts';
      pts.textContent = r.points > 0 ? `+${r.points}` : String(r.points);
      row.append(who, what, pts);
      el.reveal.appendChild(row);
    });
    renderTop();
    renderBoard();
  }

  // ------------------------------------------------------------------
  // Fin de partie
  // ------------------------------------------------------------------
  function renderFinal(fin) {
    S.phase = 'final';
    stopTimer();
    stopCountdown();
    el.stage.classList.add('screen--hidden');
    el.side.classList.add('screen--hidden');
    el.reveal.classList.add('screen--hidden');
    el.final.classList.remove('screen--hidden');
    el.round.textContent = 'Quiz terminé';

    const mine = fin.results.find(r => r.sid === S.meSid);
    const multi = fin.results.length > 1;
    const win = mine && multi && mine.rank === 1;
    el.finalOutcome.className = 'finished-outcome ' + (win ? 'finished-outcome--victory' : 'finished-outcome--defeat');
    if (!mine) el.finalOutcome.textContent = 'Quiz terminé';
    else if (!multi) el.finalOutcome.textContent = `Score final : ${mine.total} pts (${mine.correct}/${fin.rounds} bonnes réponses)`;
    else if (win) el.finalOutcome.textContent = `Victoire ! 🏆 ${mine.total} pts`;
    else el.finalOutcome.textContent = `Tu finis #${mine.rank} avec ${mine.total} pts`;

    el.finalList.innerHTML = '';
    const medals = ['🥇', '🥈', '🥉'];
    fin.results.forEach(r => {
      const row = document.createElement('div');
      row.className = 'qz-result' + (r.rank === 1 && multi ? ' qz-result--win' : '') + (r.sid === S.meSid ? ' qz-result--me' : '');
      const rank = document.createElement('span');
      rank.className = 'qz-result__rank';
      rank.textContent = medals[r.rank - 1] || `#${r.rank}`;
      const name = document.createElement('span');
      name.className = 'qz-result__name';
      name.textContent = r.name;
      const detail = document.createElement('span');
      detail.className = 'qz-result__detail';
      detail.textContent = `${r.correct}/${fin.rounds} · ${r.avgMs === null ? '—' : fmtSeconds(r.avgMs)} en moyenne`;
      const total = document.createElement('strong');
      total.className = 'qz-result__total';
      total.textContent = `${r.total} pts`;
      row.append(rank, avatarEl(r.avatar, r.name), name, detail, total);
      el.finalList.appendChild(row);
    });
    if (!fin.ranked) {
      const note = document.createElement('p');
      note.className = 'modifiers-note';
      note.textContent = 'Partie hors-classement (modificateur ou réglage modifié) : aucune XP.';
      el.finalList.appendChild(note);
    }
    const host = isHost();
    el.btnReplay.classList.toggle('screen--hidden', !host);
    el.finalWait.classList.toggle('screen--hidden', host);
  }

  // ------------------------------------------------------------------
  // Événements serveur
  // ------------------------------------------------------------------
  function runCountdown(ms) {
    stopCountdown();
    const end = Date.now() + ms;
    el.countdown.classList.remove('screen--hidden');
    const tick = () => {
      const left = Math.max(0, end - Date.now());
      el.countdown.textContent = left > 0 ? `Prêts ? ${Math.ceil(left / 1000)}` : 'Go !';
      if (left <= 0) stopCountdown();
    };
    tick();
    S.countdownTimer = setInterval(tick, 200);
  }

  socket.on('quiz_started', (p) => {
    if (typeof isSpectating !== 'undefined' && isSpectating) return;
    resetUi();
    if (typeof resetChatPanel === 'function') resetChatPanel();
    S.meSid = p.meSid; S.config = p.config; S.players = p.players;
    S.scores = p.players.map(x => ({ sid: x.sid, total: 0, streak: 0, correct: 0 }));
    S.round = 0; S.rounds = p.config.rounds; S.phase = 'countdown';
    hostId = p.hostId;
    showScreen(el.screen);
    renderTop();
    renderBoard();
  });

  socket.on('quiz_countdown', ({ ms }) => {
    if (!S.config) return;
    runCountdown(ms);
  });

  socket.on('quiz_question', (q) => {
    if (!S.config) return;
    S.round = q.round; S.rounds = q.rounds;
    showQuestion(q, null);
  });

  socket.on('quiz_hint', ({ hint }) => {
    if (S.phase === 'question') showHint(hint);
  });

  socket.on('quiz_answer_ok', ({ index }) => {
    if (S.phase !== 'question') return;
    S.answered = index;
    renderOptions();
    renderStatus();
  });

  socket.on('quiz_players', ({ players }) => {
    S.players = players;
    if (S.phase === 'final') return;
    renderBoard();
  });

  socket.on('quiz_reveal', (rev) => {
    if (!S.config) return;
    showReveal(rev);
  });

  socket.on('quiz_final', (fin) => {
    if (!S.config) return;
    renderFinal(fin);
  });

  // Reconnexion : reconstruit l'écran depuis l'état complet envoyé par le serveur.
  socket.on('quiz_state', (st) => {
    resetUi();
    S.meSid = st.meSid; S.config = st.config; S.players = st.players; S.scores = st.scores;
    S.round = st.round; S.rounds = st.rounds; S.phase = st.phase;
    hostId = st.hostId;
    showScreen(el.screen);
    renderTop();
    renderBoard();
    if (st.final) { renderFinal(st.final); return; }
    if (st.phase === 'countdown') { runCountdown(st.countdownMs); return; }
    if (st.phase === 'question' && st.question) { showQuestion(st.question, st.myAnswer); return; }
    if (st.phase === 'reveal' && st.lastReveal) { S.question = null; showReveal(st.lastReveal); }
  });

  el.btnLeave.addEventListener('click', () => {
    socket.emit('leave_game');
    if (typeof rememberActiveGame === 'function') rememberActiveGame(null);
    showScreen(screenHome);
  });
  el.btnFinalLeave.addEventListener('click', () => el.btnLeave.click());
  el.btnReplay.addEventListener('click', () => socket.emit('play_again'));
})();
