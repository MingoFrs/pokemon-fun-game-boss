/* Quêtes journalières — carte de l'accueil.
 * Dépend de client.js (getStoredAccount, socket). Chargé après daily-client.js.
 * Progression et récompenses : 100 % serveur (/api/quests, /api/quests/claim). */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const card = $('quests-card');
  if (!card) return;

  const listEl = $('quests-list');
  const bonusEl = $('quests-bonus');
  const statusEl = $('quests-status');
  const hintEl = $('quests-hint');
  const nf = new Intl.NumberFormat('fr-FR');

  const token = () => { const a = getStoredAccount(); return (a && a.accessToken) || null; };
  let data = null;
  let busy = false;
  let resetTimer = null;

  async function post(url, body) {
    const res = await fetch(url, { method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const json = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, json };
  }

  function row(q, guest) {
    const li = document.createElement('li');
    li.className = 'quest' + (q.done ? ' quest--done' : '') + (q.claimed ? ' quest--claimed' : '');

    const head = document.createElement('div');
    head.className = 'quest__head';
    const title = document.createElement('span');
    title.className = 'quest__title';
    title.textContent = q.title;
    const xp = document.createElement('span');
    xp.className = 'quest__xp';
    xp.textContent = '+' + q.xp + ' XP';
    head.append(title, xp);

    const barWrap = document.createElement('div');
    barWrap.className = 'quest__bar';
    barWrap.setAttribute('role', 'progressbar');
    barWrap.setAttribute('aria-label', q.title);
    barWrap.setAttribute('aria-valuemin', '0');
    barWrap.setAttribute('aria-valuemax', String(q.target));
    barWrap.setAttribute('aria-valuenow', String(q.progress));
    const fill = document.createElement('span');
    fill.className = 'quest__bar-fill';
    fill.style.width = Math.round((q.progress / q.target) * 100) + '%';
    barWrap.appendChild(fill);

    const foot = document.createElement('div');
    foot.className = 'quest__foot';
    const count = document.createElement('span');
    count.className = 'quest__count';
    count.textContent = nf.format(q.progress) + ' / ' + nf.format(q.target);
    foot.appendChild(count);

    if (!guest) {
      if (q.claimed) {
        const done = document.createElement('span');
        done.className = 'quest__state';
        done.textContent = '✓ Réclamée';
        foot.appendChild(done);
      } else if (q.done) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn btn--ghost quest__claim';
        btn.textContent = 'Réclamer +' + q.xp + ' XP';
        btn.setAttribute('aria-label', 'Réclamer ' + q.xp + ' XP : ' + q.title);
        btn.addEventListener('click', () => claim(q.key, btn));
        foot.appendChild(btn);
      }
    }

    li.append(head, barWrap, foot);
    return li;
  }

  function render() {
    if (!data) return;
    const guest = !!data.guest;
    listEl.innerHTML = '';
    (data.quests || []).forEach(q => listEl.appendChild(row(q, guest)));

    const b = data.bonus;
    bonusEl.innerHTML = '';
    if (b) {
      bonusEl.classList.remove('screen--hidden');
      bonusEl.classList.toggle('quests-bonus--ready', !!(b.done && !b.claimed && !guest));
      const label = document.createElement('span');
      label.className = 'quests-bonus__label';
      label.textContent = '🎁 Bonus : ' + b.title.toLowerCase() + ' (+' + b.xp + ' XP)';
      bonusEl.appendChild(label);
      if (!guest && b.done && !b.claimed) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn btn--ghost quest__claim';
        btn.textContent = 'Réclamer';
        btn.setAttribute('aria-label', 'Réclamer le bonus de ' + b.xp + ' XP');
        btn.addEventListener('click', () => claim(b.key, btn));
        bonusEl.appendChild(btn);
      } else if (!guest && b.claimed) {
        const st = document.createElement('span');
        st.className = 'quest__state';
        st.textContent = '✓ Réclamé';
        bonusEl.appendChild(st);
      }
    } else {
      bonusEl.classList.add('screen--hidden');
    }

    if (data.unavailable) hintEl.textContent = 'Progression momentanément indisponible.';
    else if (guest) hintEl.textContent = 'Connecte-toi pour suivre ta progression et gagner de l\'XP.';
    else hintEl.textContent = '3 quêtes par jour, récompense en XP. Renouvelées à minuit.';

    clearTimeout(resetTimer);
    if (data.msUntilReset) resetTimer = setTimeout(refresh, Math.min(data.msUntilReset + 3000, 2147483000));
  }

  async function refresh() {
    try {
      const { ok, json } = await post('/api/quests', { accessToken: token() });
      if (!ok || !Array.isArray(json.quests)) return;
      data = json;
      render();
    } catch (e) { /* hors-ligne : on garde l'affichage précédent */ }
  }

  async function claim(key, btn) {
    if (busy) return;
    busy = true;
    if (btn) btn.disabled = true;
    try {
      const { ok, json } = await post('/api/quests/claim', { accessToken: token(), questKey: key });
      statusEl.textContent = ok ? '+' + json.xp + ' XP réclamés !' : (json.error || 'Réclamation impossible.');
      if (ok && window.rdbFeedback) window.rdbFeedback('reward');
      if (ok && typeof window.refreshAccountSettingsSection === 'function') {
        try { window.refreshAccountSettingsSection(); } catch (e) {}
      }
    } catch (e) {
      statusEl.textContent = 'Réclamation impossible (réseau).';
    } finally {
      busy = false;
      await refresh();
    }
  }

  const canAutoRefresh = () => !document.hidden && document.body.dataset.screen === 'home';

  // Connexion / déconnexion / renouvellement de session.
  if (typeof window.setStoredAccount === 'function') {
    const original = window.setStoredAccount;
    window.setStoredAccount = function () {
      const out = original.apply(this, arguments);
      setTimeout(refresh, 0);
      return out;
    };
  }
  // Fin de partie : l'historique est écrit en tâche de fond côté serveur → petit délai.
  socket.on('game_finished', () => { setTimeout(refresh, 3500); });
  document.addEventListener('visibilitychange', () => { if (canAutoRefresh()) refresh(); });
  window.addEventListener('focus', () => { if (canAutoRefresh()) refresh(); });
  setInterval(() => { if (canAutoRefresh()) refresh(); }, 120000);

  // Retour sur l'accueil (fin de partie, défi quotidien terminé...) : rafraîchit, au plus 1 fois / 5 s.
  let lastScreenRefresh = 0;
  new MutationObserver(() => {
    if (document.body.dataset.screen !== 'home' || Date.now() - lastScreenRefresh < 5000) return;
    lastScreenRefresh = Date.now();
    refresh();
  }).observe(document.body, { attributes: true, attributeFilter: ['data-screen'] });

  refresh();
})();
