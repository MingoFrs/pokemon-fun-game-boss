'use strict';
// =====================================================================
// MODE "ROULETTE DE STATS" — côté client (chargé APRÈS client.js, dont il réutilise les globaux :
// socket, myId, hostId, isHost, showScreen, screenHome, renderTypeBadges, avatarUrl, ...).
// Le client n'affiche que ce que le serveur envoie : aucune règle de jeu décidée ici.
// =====================================================================
(function () {
  const KEYS = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'];
  const LABELS = { hp: 'PV', atk: 'Attaque', def: 'Défense', spa: 'Atq. Spé.', spd: 'Déf. Spé.', spe: 'Vitesse' };
  const DIFF_LABELS = { easy: 'Facile', medium: 'Moyen', hard: 'Difficile', extreme: 'Extrême' };
  const $ = id => document.getElementById(id);

  const el = {
    lobbyPanel: $('sd-lobby-panel'), targets: $('sd-targets'), modOptions: $('sd-mod-options'),
    modActive: $('sd-mod-active'), modNote: $('sd-mod-note'),
    screen: $('screen-statdraft'),
    round: $('sd-round'), targetValue: $('sd-target-value'), mods: $('sd-mods'), btnLeave: $('sd-btn-leave'),
    timer: $('sd-timer'), timerBar: $('sd-timer-bar'), timerText: $('sd-timer-text'),
    stage: $('sd-stage'), wheel: $('sd-wheel'), hub: $('sd-hub'), status: $('sd-status'),
    card: $('sd-card'), cardSprite: $('sd-card-sprite'), cardName: $('sd-card-name'), cardTypes: $('sd-card-types'),
    cardShiny: $('sd-card-shiny'), opts: $('sd-opts'), controls: $('sd-controls'),
    reveal: $('sd-reveal'), build: $('sd-build'), others: $('sd-others'),
    final: $('sd-final'), finalOutcome: $('sd-final-outcome'), finalList: $('sd-final-list'),
    btnReplay: $('sd-btn-replay'), btnFinalLeave: $('sd-btn-final-leave'), finalWait: $('sd-final-wait'),
    side: $('sd-side')
  };
  if (!el.screen || !el.lobbyPanel) return; // HTML non intégré : le mode reste simplement absent

  const S = {
    catalog: null,       // { modifiers, targets, statLabels, ready }
    mods: [],            // modificateurs du lobby
    meSid: null, config: null, players: [], builds: [],
    my: null,            // { slots, rerollsLeft, jokerAvailable, locked }
    round: 0, rounds: 6, phase: 'idle', chooserSid: null,
    pokemon: null, hidden: [],
    spinning: false, spinToken: 0,
    selStat: null, jokerOn: false, targetSlot: null,
    deadline: 0, pickMs: 30000, timerRaf: 0,
    ended: false
  };

  // ------------------------------------------------------------------
  // Lobby
  // ------------------------------------------------------------------
  fetch('/api/statdraft/config').then(r => r.json()).then(data => {
    if (data && Array.isArray(data.modifiers)) { S.catalog = data; renderLobby(); }
  }).catch(() => { /* lobby fonctionne sans : panneau masqué */ });

  function renderLobby() {
    const on = typeof currentGameMode !== 'undefined' && currentGameMode === 'statdraft' && !!S.catalog;
    el.lobbyPanel.classList.toggle('screen--hidden', !on);
    if (!on) return;
    const t = S.catalog.targets;
    el.targets.innerHTML = '';
    Object.keys(DIFF_LABELS).forEach(d => {
      const chip = document.createElement('span');
      chip.className = 'sd-target-chip' + (typeof currentDifficulty !== 'undefined' && currentDifficulty === d ? ' sd-target-chip--on' : '');
      chip.dataset.difficulty = d;
      chip.textContent = `${DIFF_LABELS[d]} : ${t[d]}`;
      el.targets.appendChild(chip);
    });
    el.modOptions.innerHTML = '';
    el.modActive.innerHTML = '';
    const host = isHost();
    S.catalog.modifiers.forEach(m => {
      const active = S.mods.includes(m.key);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'modifier-chip' + (active ? ' modifier-chip--active' : '');
      btn.title = m.description;
      btn.disabled = !host;
      btn.setAttribute('aria-pressed', String(active));
      btn.textContent = `${m.icon} ${m.label}`;
      btn.addEventListener('click', () => {
        if (!isHost()) return;
        const next = active ? S.mods.filter(k => k !== m.key) : S.mods.concat(m.key);
        socket.emit('sd_set_modifiers', { modifiers: next });
      });
      el.modOptions.appendChild(btn);
      if (active) {
        const li = document.createElement('li');
        li.textContent = `${m.icon} ${m.label} — ${m.description}`;
        el.modActive.appendChild(li);
      }
    });
    el.modNote.classList.toggle('screen--hidden', S.mods.length === 0);
    if (typeof gamemodeHintEl !== 'undefined') {
      gamemodeHintEl.classList.remove('screen--hidden');
      const n = typeof lastLobbyPlayers !== 'undefined' ? lastLobbyPlayers.length : 1;
      gamemodeHintEl.textContent = S.mods.includes('team') && n < 2
        ? 'Frankenstein nécessite au moins 2 joueurs.'
        : '6 tirages : les stats du Pokémon sont cachées. Devine sa meilleure stat : elle remplit la case du même nom. Atteins l\'objectif de la difficulté.';
    }
  }

  // Greffes non intrusives sur les rendus du lobby de client.js.
  ['renderGameMode', 'renderDifficulty', 'updateHostControls'].forEach(name => {
    const original = window[name];
    if (typeof original !== 'function') return;
    window[name] = function () {
      const out = original.apply(this, arguments);
      renderLobby();
      return out;
    };
  });

  socket.on('sd_modifiers_updated', ({ modifiers }) => {
    S.mods = Array.isArray(modifiers) ? modifiers : [];
    renderLobby();
  });

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------
  function showSd() {
    showScreen(el.screen);
  }
  function sidName(sid) {
    if (sid === 'team') return 'Équipe';
    const p = S.players.find(x => x.sid === sid);
    return p ? p.name : '—';
  }
  const isMyTurnToPick = () => !S.config || !S.config.team || S.chooserSid === S.meSid;
  const canAct = () => S.phase === 'choosing' && !S.spinning && S.my && !S.my.locked && isMyTurnToPick();
  const total = slots => KEYS.reduce((s, k) => s + (slots && slots[k] ? slots[k].value : 0), 0);
  const modInfo = key => (S.catalog ? S.catalog.modifiers.find(m => m.key === key) : null);

  function avatarEl(avatar, name) {
    const span = document.createElement('span');
    span.className = 'sd-avatar';
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

  function resetUi() {
    S.selStat = null; S.jokerOn = false; S.targetSlot = null; S.pokemon = null; S.hidden = [];
    S.spinning = false; S.spinToken++; S.ended = false;
    el.card.classList.add('screen--hidden');
    el.reveal.classList.add('screen--hidden');
    el.reveal.innerHTML = '';
    el.final.classList.add('screen--hidden');
    el.stage.classList.remove('screen--hidden');
    el.side.classList.remove('screen--hidden');
    el.wheel.innerHTML = '';
    el.wheel.style.transition = 'none';
    el.wheel.style.transform = 'rotate(0deg)';
    el.hub.innerHTML = '<span class="sd-hub__q">?</span>';
    stopTimer();
  }

  function renderTop() {
    el.round.textContent = S.round ? `Tirage ${S.round} / ${S.rounds}` : 'Roulette de Stats';
    el.targetValue.textContent = S.config ? S.config.target : '';
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

  // ------------------------------------------------------------------
  // Timer
  // ------------------------------------------------------------------
  function startTimer(ms, total) {
    S.pickMs = total || ms;
    S.deadline = Date.now() + ms;
    el.timer.classList.remove('screen--hidden');
    cancelAnimationFrame(S.timerRaf);
    const tick = () => {
      const left = Math.max(0, S.deadline - Date.now());
      el.timerBar.style.width = `${Math.min(100, (left / S.pickMs) * 100)}%`;
      el.timerText.textContent = `${Math.ceil(left / 1000)} s`;
      el.timer.classList.toggle('sd-timer--low', left < 6000);
      if (left > 0 && S.phase === 'choosing') S.timerRaf = requestAnimationFrame(tick);
    };
    tick();
  }
  function stopTimer() {
    cancelAnimationFrame(S.timerRaf);
    el.timer.classList.add('screen--hidden');
  }

  // ------------------------------------------------------------------
  // Roulette
  // ------------------------------------------------------------------
  const pointerEl = document.querySelector('#sd-stage .sd-pointer');
  const easeOut = t => 1 - Math.pow(1 - t, 4); // décélération progressive : vitesse visible longtemps, arrêt doux

  function tickPointer() {
    if (!pointerEl) return;
    pointerEl.classList.add('sd-pointer--tick');
    setTimeout(() => pointerEl.classList.remove('sd-pointer--tick'), 70);
  }

  function spinWheel(wheel, ms, done) {
    const token = ++S.spinToken;
    S.spinning = true;
    el.hub.innerHTML = '<span class="sd-hub__q">?</span>';
    el.wheel.innerHTML = '';
    el.wheel.classList.remove('sd-wheel--landed');
    const n = wheel.items.length;
    const step = 360 / n;
    wheel.items.forEach((it, i) => {
      const seg = document.createElement('div');
      seg.className = 'sd-seg';
      seg.style.setProperty('--a', `${i * step}deg`);
      const img = document.createElement('img');
      img.src = it.sprite;
      img.alt = '';
      seg.appendChild(img);
      el.wheel.appendChild(seg);
    });
    const reduce = document.documentElement.classList.contains('reduce-motion');
    // 6 tours + arrêt sur la case gagnante (léger décalage dans la case pour un arrêt naturel).
    const finalRot = 360 * 6 + ((360 - wheel.winnerIndex * step) % 360) + (Math.random() - 0.5) * step * 0.5;
    const dur = reduce ? 0 : Math.max(1500, ms - 600);
    el.wheel.style.transition = 'none';
    el.wheel.style.transform = 'rotate(0deg)';

    let finished = false;
    const land = () => {
      if (finished || token !== S.spinToken) return;
      finished = true;
      el.wheel.style.transform = `rotate(${finalRot}deg)`;
      S.spinning = false;
      const w = wheel.items[wheel.winnerIndex];
      el.hub.innerHTML = '';
      const img = document.createElement('img');
      img.src = w.sprite;
      img.alt = w.name;
      el.hub.appendChild(img);
      el.wheel.classList.add('sd-wheel--landed');
      if (done) done();
    };

    if (reduce) { setTimeout(land, 60); return; }
    const t0 = performance.now();
    let lastSeg = 0;
    let lastTick = 0;
    const frame = () => {
      const now = performance.now();
      if (finished || token !== S.spinToken) return;
      const t = Math.min(1, (now - t0) / dur);
      const rot = finalRot * easeOut(t);
      el.wheel.style.transform = `rotate(${rot}deg)`;
      const segIdx = Math.floor((rot + step / 2) / step);
      if (segIdx !== lastSeg) {
        lastSeg = segIdx;
        if (now - lastTick > 90) { lastTick = now; tickPointer(); } // pas de tic quand ça défile trop vite
      }
      if (t < 1) requestAnimationFrame(frame);
      else land();
    };
    requestAnimationFrame(frame);
    setTimeout(land, dur + 400); // onglet en arrière-plan (rAF suspendu) : on atterrit quand même
  }

  // ------------------------------------------------------------------
  // Carte du Pokémon + choix
  // ------------------------------------------------------------------
  function ownSlotFilled(k) { return !!(S.my && S.my.slots[k]); }
  function emptySlots() { return KEYS.filter(k => !ownSlotFilled(k)); }

  function previewValue(k) {
    const o = S.pokemon && S.pokemon.options[k];
    if (!o || o.hidden) return null;
    if (S.jokerOn && S.targetSlot && o.finalBySlot) return o.finalBySlot[S.targetSlot];
    return o.final;
  }

  function renderCard() {
    const p = S.pokemon;
    if (!p) { el.card.classList.add('screen--hidden'); return; }
    el.card.classList.remove('screen--hidden');
    el.cardSprite.src = p.sprite;
    el.cardSprite.alt = p.name;
    el.cardName.textContent = p.name;
    el.cardShiny.classList.toggle('screen--hidden', !p.shiny);
    el.cardShiny.textContent = p.shiny ? `✨ Chromatique ×${S.config.shinyMult}` : '';
    renderTypeBadges(el.cardTypes, p.types);

    el.opts.innerHTML = '';
    const active = canAct();
    KEYS.forEach(k => {
      const o = p.options[k];
      const filled = ownSlotFilled(k);
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'sd-opt' + (S.selStat === k ? ' sd-opt--selected' : '') + (filled ? ' sd-opt--filled' : '') + (o.hidden ? ' sd-opt--hidden' : '');
      row.dataset.stat = k;
      const usable = active && (!filled || S.jokerOn);
      row.disabled = !usable;

      const label = document.createElement('span');
      label.className = 'sd-opt__label';
      label.textContent = LABELS[k];

      const bar = document.createElement('span');
      bar.className = 'sd-opt__bar';
      const fill = document.createElement('i');
      fill.style.width = o.hidden ? '100%' : `${Math.min(100, (o.base / 200) * 100)}%`;
      bar.appendChild(fill);

      const val = document.createElement('span');
      val.className = 'sd-opt__val';
      if (o.hidden) val.textContent = '?';
      else {
        const shown = (S.jokerOn && S.targetSlot && o.finalBySlot) ? o.finalBySlot[S.targetSlot] : o.final;
        val.textContent = shown !== o.base ? `${o.base} → ${shown}` : String(o.base);
      }

      const tag = document.createElement('span');
      tag.className = 'sd-opt__tag';
      if (filled && !S.jokerOn) tag.textContent = 'rempli';
      else if (!S.jokerOn && o.bonuses.length) tag.textContent = o.bonuses.map(b => (b === 'type' ? '🎯' : '✨')).join('');
      row.append(label, bar, val, tag);
      row.addEventListener('click', () => {
        if (!canAct()) return;
        S.selStat = k;
        if (S.jokerOn) { if (!S.targetSlot || ownSlotFilled(S.targetSlot)) S.targetSlot = emptySlots()[0] || null; }
        else S.targetSlot = null;
        refresh();
      });
      el.opts.appendChild(row);
    });
    renderControls();
  }

  function renderControls() {
    el.controls.innerHTML = '';
    const active = canAct();
    if (S.config && S.config.team && !isMyTurnToPick()) {
      const p = document.createElement('p');
      p.className = 'sd-hint';
      p.textContent = `${sidName(S.chooserSid)} choisit pour l'équipe…`;
      el.controls.appendChild(p);
      return;
    }
    if (S.my && S.config && S.config.mods.includes('reroll')) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn btn--ghost sd-btn';
      b.textContent = `🔄 Relancer (${S.my.rerollsLeft})`;
      b.disabled = !active || S.my.rerollsLeft <= 0;
      b.addEventListener('click', () => {
        if (!canAct()) return;
        S.selStat = null; S.targetSlot = null; S.jokerOn = false;
        socket.emit('sd_reroll');
      });
      el.controls.appendChild(b);
    }
    if (S.my && S.config && S.config.mods.includes('joker')) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn btn--ghost sd-btn' + (S.jokerOn ? ' sd-btn--on' : '');
      b.textContent = S.my.jokerAvailable ? (S.jokerOn ? '🃏 Joker activé' : '🃏 Joker') : '🃏 Joker utilisé';
      b.disabled = !active || !S.my.jokerAvailable;
      b.addEventListener('click', () => {
        if (!canAct() || !S.my.jokerAvailable) return;
        S.jokerOn = !S.jokerOn;
        S.targetSlot = S.jokerOn ? (emptySlots()[0] || null) : null;
        refresh();
      });
      el.controls.appendChild(b);
    }
    const confirm = document.createElement('button');
    confirm.type = 'button';
    confirm.className = 'btn btn--haut sd-btn sd-btn--confirm';
    const slot = S.jokerOn ? S.targetSlot : S.selStat;
    const ready = active && S.selStat && slot && !ownSlotFilled(slot);
    confirm.disabled = !ready;
    if (S.my && S.my.locked) confirm.textContent = 'Choix verrouillé';
    else if (ready) {
      const v = previewValue(S.selStat);
      confirm.textContent = S.jokerOn && slot !== S.selStat
        ? `Valider : ${LABELS[S.selStat]}${v != null ? ' ' + v : ''} → ${LABELS[slot]}`
        : `Valider : ${LABELS[S.selStat]}${v != null ? ' ' + v : ' (?)'}`;
    } else confirm.textContent = S.jokerOn ? 'Choisis une stat puis une case' : 'Choisis une stat';
    confirm.addEventListener('click', () => {
      if (!ready || !canAct()) return;
      socket.emit('sd_pick', { stat: S.selStat, slot });
      S.my.locked = true; // optimiste : le serveur confirme via sd_pick_ok (ou renvoie une erreur)
      refresh();
    });
    el.controls.appendChild(confirm);
  }

  // ------------------------------------------------------------------
  // Ma base stats + autres joueurs
  // ------------------------------------------------------------------
  function renderBuild() {
    const slots = S.my ? S.my.slots : {};
    const t = total(slots);
    const target = S.config ? S.config.target : 0;
    const left = emptySlots().length;
    el.build.innerHTML = '';

    const head = document.createElement('div');
    head.className = 'sd-build__head';
    const title = document.createElement('p');
    title.className = 'eyebrow';
    title.textContent = S.config && S.config.team ? 'Base stats de l\'équipe' : 'Ta base stats';
    const tot = document.createElement('p');
    tot.className = 'sd-build__total';
    tot.innerHTML = `<strong>${t}</strong> / ${target}`;
    head.append(title, tot);
    el.build.appendChild(head);

    const gauge = document.createElement('div');
    gauge.className = 'sd-gauge';
    const gf = document.createElement('i');
    gf.style.width = `${Math.min(100, target ? (t / target) * 100 : 0)}%`;
    gauge.appendChild(gf);
    el.build.appendChild(gauge);

    const list = document.createElement('div');
    list.className = 'sd-slots';
    KEYS.forEach(k => {
      const it = slots[k];
      const clickable = canAct() && S.jokerOn && !it;
      const row = document.createElement(clickable ? 'button' : 'div');
      if (clickable) row.type = 'button';
      row.className = 'sd-slot' + (it ? ' sd-slot--filled' : '') + (clickable ? ' sd-slot--pickable' : '') + (S.jokerOn && S.targetSlot === k ? ' sd-slot--target' : '');
      const lab = document.createElement('span');
      lab.className = 'sd-slot__label';
      lab.textContent = LABELS[k];
      row.appendChild(lab);
      if (S.config && S.config.slotTypes) {
        const ty = document.createElement('span');
        ty.className = 'sd-slot__type';
        renderTypeBadges(ty, [S.config.slotTypes[k]]);
        ty.classList.add('type-badges', 'type-badges--small');
        row.appendChild(ty);
      }
      const val = document.createElement('span');
      val.className = 'sd-slot__val';
      if (it) {
        val.textContent = String(it.value);
        const img = document.createElement('img');
        img.src = it.pokemon.sprite;
        img.alt = it.pokemon.name;
        img.title = `${it.pokemon.name} · ${LABELS[it.stat]} ${it.base}${it.bonuses.length ? ' (bonus)' : ''}`;
        row.appendChild(img);
      } else if (S.selStat && canAct() && ((S.jokerOn && S.targetSlot === k) || (!S.jokerOn && S.selStat === k))) {
        const v = previewValue(S.selStat);
        val.textContent = v == null ? '?' : String(v);
        val.classList.add('sd-slot__ghost');
      } else val.textContent = '—';
      row.appendChild(val);
      if (clickable) row.addEventListener('click', () => { S.targetSlot = k; refresh(); });
      list.appendChild(row);
    });
    el.build.appendChild(list);

    const need = document.createElement('p');
    need.className = 'sd-need';
    if (left > 0 && t < target) need.textContent = `Il reste ${left} case${left > 1 ? 's' : ''} : ${Math.ceil((target - t) / left)} de moyenne pour atteindre l'objectif.`;
    else if (t >= target) need.textContent = 'Objectif déjà atteint — pousse pour dépasser les autres.';
    else need.textContent = '';
    el.build.appendChild(need);
  }

  function renderOthers() {
    el.others.innerHTML = '';
    const team = S.config && S.config.team;
    const builds = team ? [] : S.builds.filter(b => b.sid !== S.meSid);
    S.players.forEach(p => {
      if (!team && p.sid === S.meSid) return;
      const row = document.createElement('div');
      row.className = 'sd-other' + (p.disconnected ? ' sd-other--off' : '');
      row.appendChild(avatarEl(p.avatar, p.name));
      const info = document.createElement('div');
      info.className = 'sd-other__info';
      const name = document.createElement('p');
      name.className = 'sd-other__name';
      name.textContent = p.name + (p.disconnected ? ' (hors ligne)' : '');
      info.appendChild(name);
      const b = builds.find(x => x.sid === p.sid);
      if (b) {
        const chips = document.createElement('div');
        chips.className = 'sd-chips';
        KEYS.forEach(k => {
          const c = document.createElement('span');
          c.className = 'sd-chip' + (b.slots[k] ? ' sd-chip--on' : '');
          c.textContent = b.slots[k] ? b.slots[k].value : '·';
          c.title = LABELS[k];
          chips.appendChild(c);
        });
        info.appendChild(chips);
      }
      row.appendChild(info);
      const right = document.createElement('div');
      right.className = 'sd-other__right';
      if (b) {
        const t = document.createElement('strong');
        t.textContent = String(b.total);
        right.appendChild(t);
      }
      const st = document.createElement('span');
      st.className = 'sd-other__state';
      if (S.phase === 'choosing' || S.phase === 'spin') {
        if (team) st.textContent = p.sid === S.chooserSid ? '🎯 choisit' : '';
        else st.textContent = p.locked ? '✅' : '⏳';
      }
      right.appendChild(st);
      row.appendChild(right);
      el.others.appendChild(row);
    });
    el.others.classList.toggle('screen--hidden', el.others.children.length === 0);
  }

  // ------------------------------------------------------------------
  // Statut / révélation
  // ------------------------------------------------------------------
  function renderStatus() {
    let txt = '';
    if (S.phase === 'spin') txt = 'La roulette tourne…';
    else if (S.phase === 'choosing') {
      if (S.config && S.config.team && !isMyTurnToPick()) txt = `${sidName(S.chooserSid)} choisit pour l'équipe.`;
      else if (S.my && S.my.locked) txt = 'Choix verrouillé. En attente des autres…';
      else if (S.config && S.config.team) txt = 'À toi de choisir pour l\'équipe !';
      else txt = 'Stats cachées : à toi de deviner où ce Pokémon est fort.';
    } else if (S.phase === 'reveal') txt = 'Choix révélés.';
    el.status.textContent = txt;
  }

  function renderReveal(rev) {
    el.reveal.innerHTML = '';
    el.reveal.classList.remove('screen--hidden');
    const h = document.createElement('p');
    h.className = 'eyebrow';
    h.textContent = `Tirage ${rev.round} : choix révélés`;
    el.reveal.appendChild(h);
    rev.picks.forEach(pk => {
      const row = document.createElement('div');
      row.className = 'sd-pick' + (pk.sid === S.meSid ? ' sd-pick--me' : '');
      const img = document.createElement('img');
      img.src = pk.pokemon.sprite;
      img.alt = '';
      const who = document.createElement('span');
      who.className = 'sd-pick__who';
      who.textContent = pk.sid === 'team' ? `Équipe (${sidName(pk.by)})` : sidName(pk.sid);
      const what = document.createElement('span');
      what.className = 'sd-pick__what';
      const bonus = pk.bonuses && pk.bonuses.length ? ` ${pk.bonuses.map(b => (b === 'type' ? '🎯' : '✨')).join('')}` : '';
      const cross = pk.cross ? ` → ${LABELS[pk.slot]} 🃏` : '';
      what.textContent = `${pk.pokemon.name} · ${LABELS[pk.stat]} ${pk.base}${pk.value !== pk.base ? ' → ' + pk.value : ''}${bonus}${cross}${pk.auto ? ' (auto)' : ''}`;
      const info = document.createElement('div');
      info.className = 'sd-pick__body';
      info.append(who, what);
      if (pk.allStats) {
        const chips = document.createElement('div');
        chips.className = 'sd-chips sd-pick__stats';
        KEYS.forEach(k => {
          const c = document.createElement('span');
          c.className = 'sd-chip sd-chip--on' + (k === pk.stat ? ' sd-chip--taken' : '');
          c.textContent = pk.allStats[k];
          c.title = LABELS[k];
          chips.appendChild(c);
        });
        info.appendChild(chips);
      }
      row.append(img, info);
      el.reveal.appendChild(row);
    });
  }

  function refresh() {
    renderTop();
    renderStatus();
    if (S.phase !== 'reveal') renderCard();
    renderBuild();
    renderOthers();
  }

  // ------------------------------------------------------------------
  // Fin de partie
  // ------------------------------------------------------------------
  function renderFinal(fin) {
    S.ended = true;
    S.phase = 'final';
    stopTimer();
    el.stage.classList.add('screen--hidden');
    el.reveal.classList.add('screen--hidden');
    el.side.classList.add('screen--hidden');
    el.final.classList.remove('screen--hidden');
    const mine = fin.results.find(r => r.sid === (fin.team ? 'team' : S.meSid));
    const ok = mine && mine.success;
    el.finalOutcome.className = 'finished-outcome ' + (ok ? 'finished-outcome--victory' : 'finished-outcome--defeat');
    if (fin.team) el.finalOutcome.textContent = ok ? `Objectif atteint : ${mine.total} / ${fin.target} — victoire d'équipe !` : `Raté : ${mine ? mine.total : 0} / ${fin.target}`;
    else if (ok) el.finalOutcome.textContent = fin.results.length > 1 && mine.rank === 1 ? `Victoire ! ${mine.total} / ${fin.target}` : `Objectif atteint : ${mine.total} / ${fin.target}`;
    else el.finalOutcome.textContent = `Objectif manqué : ${mine ? mine.total : 0} / ${fin.target}`;

    el.finalList.innerHTML = '';
    fin.results.forEach(r => {
      const row = document.createElement('div');
      row.className = 'sd-result' + (r.success ? ' sd-result--ok' : '') + (r.sid === S.meSid ? ' sd-result--me' : '');
      const head = document.createElement('div');
      head.className = 'sd-result__head';
      head.appendChild(avatarEl(r.avatar, r.name));
      const nm = document.createElement('span');
      nm.className = 'sd-result__name';
      nm.textContent = `${fin.team ? '' : '#' + r.rank + ' '}${r.name}`;
      const tt = document.createElement('strong');
      tt.className = 'sd-result__total';
      tt.textContent = `${r.total} / ${fin.target}`;
      head.append(nm, tt);
      row.appendChild(head);
      const g = document.createElement('div');
      g.className = 'sd-gauge';
      const gf = document.createElement('i');
      gf.style.width = `${Math.min(100, (r.total / fin.target) * 100)}%`;
      g.appendChild(gf);
      row.appendChild(g);
      const cells = document.createElement('div');
      cells.className = 'sd-result__cells';
      KEYS.forEach(k => {
        const it = r.slots[k];
        const c = document.createElement('div');
        c.className = 'sd-cell';
        const lab = document.createElement('span');
        lab.textContent = LABELS[k];
        c.appendChild(lab);
        if (it) {
          const img = document.createElement('img');
          img.src = it.pokemon.sprite;
          img.alt = it.pokemon.name;
          img.title = it.pokemon.name;
          c.appendChild(img);
          const v = document.createElement('strong');
          v.textContent = String(it.value);
          c.appendChild(v);
        }
        cells.appendChild(c);
      });
      row.appendChild(cells);
      el.finalList.appendChild(row);
    });
    if (!fin.ranked) {
      const note = document.createElement('p');
      note.className = 'modifiers-note';
      note.textContent = 'Partie à modificateurs : hors-classement (aucune XP).';
      el.finalList.appendChild(note);
    }
    const host = isHost();
    el.btnReplay.classList.toggle('screen--hidden', !host);
    el.finalWait.classList.toggle('screen--hidden', host);
  }

  // ------------------------------------------------------------------
  // Événements serveur
  // ------------------------------------------------------------------
  socket.on('sd_started', (p) => {
    if (typeof isSpectating !== 'undefined' && isSpectating) return;
    resetUi();
    if (typeof resetChatPanel === 'function') resetChatPanel();
    S.meSid = p.meSid;
    S.config = p.config;
    S.players = p.players;
    S.builds = [];
    S.round = 0; S.rounds = p.config.rounds; S.phase = 'idle';
    S.my = {
      slots: KEYS.reduce((o, k) => { o[k] = null; return o; }, {}),
      rerollsLeft: p.config.mods.includes('reroll') ? p.config.rerolls : 0,
      jokerAvailable: p.config.mods.includes('joker'),
      locked: false
    };
    hostId = p.hostId;
    showSd();
    refresh();
  });

  socket.on('sd_round', (p) => {
    if (!S.config) return;
    S.round = p.round; S.rounds = p.rounds; S.phase = 'spin';
    S.hidden = p.hidden; S.chooserSid = p.chooserSid; S.players = p.players;
    S.selStat = null; S.jokerOn = false; S.targetSlot = null;
    if (S.my) S.my.locked = false;
    S.pokemon = null;
    el.reveal.classList.add('screen--hidden');
    el.card.classList.add('screen--hidden');
    stopTimer();
    refresh();
    spinWheel(p.wheel, p.spinMs, () => {
      S.pokemon = p.pokemon;
      refresh();
    });
  });

  socket.on('sd_choose', ({ pickMs }) => {
    S.phase = 'choosing';
    startTimer(pickMs, pickMs);
    refresh();
  });

  socket.on('sd_reroll', (p) => {
    if (S.phase !== 'choosing') return;
    S.pokemon = null;
    if (S.my) S.my.rerollsLeft = p.rerollsLeft;
    S.selStat = null; S.targetSlot = null; S.jokerOn = false;
    el.card.classList.add('screen--hidden');
    spinWheel(p.wheel, p.spinMs, () => {
      S.pokemon = p.pokemon;
      refresh();
    });
    renderStatus();
  });

  socket.on('sd_pick_ok', ({ me }) => {
    if (me) S.my = me;
    S.selStat = null; S.targetSlot = null; S.jokerOn = false;
    refresh();
  });

  socket.on('sd_players', ({ players, chooserSid }) => {
    S.players = players;
    if (chooserSid !== undefined) S.chooserSid = chooserSid;
    if (S.ended) return;
    renderStatus();
    renderOthers();
    renderControls();
  });

  socket.on('sd_reveal', (rev) => {
    S.phase = 'reveal';
    S.builds = rev.builds;
    stopTimer();
    // Ma base : la vérité publique (inclut mon choix, désormais révélé).
    const mine = rev.builds.find(b => b.sid === (S.config && S.config.team ? 'team' : S.meSid));
    if (mine && S.my) { S.my.slots = mine.slots; S.my.locked = true; }
    el.card.classList.add('screen--hidden');
    renderReveal(rev);
    renderTop(); renderStatus(); renderBuild(); renderOthers();
  });

  socket.on('sd_final', (fin) => {
    if (!S.config) return;
    S.builds = fin.results.map(r => ({ sid: r.sid, slots: r.slots, total: r.total }));
    renderFinal(fin);
  });

  // Reconnexion : reconstruit l'écran depuis l'état complet envoyé par le serveur.
  socket.on('sd_state', (st) => {
    resetUi();
    S.meSid = st.meSid; S.config = st.config; S.players = st.players; S.builds = st.builds;
    S.round = st.round; S.rounds = st.rounds; S.phase = st.phase; S.chooserSid = st.chooserSid;
    S.hidden = st.hidden || []; S.my = st.me; S.pickMs = st.pickMs;
    hostId = st.hostId;
    showSd();
    if (st.final) {
      refresh();
      renderFinal(st.final);
      return;
    }
    if (st.phase === 'spin' && st.wheel) {
      refresh();
      spinWheel(st.wheel, Math.max(900, st.msLeft), () => { S.pokemon = st.pokemon; refresh(); });
      return;
    }
    S.pokemon = st.pokemon;
    if (st.phase === 'choosing') startTimer(st.msLeft, st.pickMs);
    if (st.phase === 'reveal' && st.lastReveal) renderReveal(st.lastReveal);
    if (st.phase === 'reveal') { S.pokemon = null; el.card.classList.add('screen--hidden'); }
    el.hub.innerHTML = '';
    if (st.pokemon) {
      const img = document.createElement('img');
      img.src = st.pokemon.sprite; img.alt = st.pokemon.name;
      el.hub.appendChild(img);
    }
    refresh();
  });

  el.btnLeave.addEventListener('click', () => {
    socket.emit('leave_game');
    if (typeof rememberActiveGame === 'function') rememberActiveGame(null);
    showScreen(screenHome);
  });
  el.btnFinalLeave.addEventListener('click', () => el.btnLeave.click());
  el.btnReplay.addEventListener('click', () => socket.emit('play_again'));
})();
