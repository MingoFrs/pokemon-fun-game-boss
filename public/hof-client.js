/* Hall of Fame — carte de l'accueil (lecture seule).
 * Affiche les meilleures équipes du jour / d'hier ; chaque ligne se déplie pour détailler l'équipe,
 * avec un bouton « Copier la composition » (texte). Aucune action de jeu possible depuis ici. */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const card = $('hof-card');
  if (!card) return;

  const listEl = $('hof-list');
  const emptyEl = $('hof-empty');
  const statusEl = $('hof-status');
  const tabs = Array.from(card.querySelectorAll('[data-hof-scope]'));
  const nf = new Intl.NumberFormat('fr-FR');
  const DIFF = { easy: 'FACILE', medium: 'MOYEN', hard: 'DIFFICILE', extreme: 'EXTRÊME' };
  const RARITY = {
    commun: 'Commun', peu_commun: 'Peu commun', rare: 'Rare', epique: 'Épique',
    pseudo_legendaire: 'Pseudo-légendaire', mega: 'Méga', legendaire: 'Légendaire',
    fabuleux: 'Fabuleux', ultra_chimere: 'Ultra-chimère'
  };

  let scope = 'today';
  let reqId = 0;

  const monSprite = m => (m.shiny && m.shinySprite) ? m.shinySprite : m.sprite;

  function teamText(e) {
    const head = `${e.pseudo} — ${nf.format(e.score)} pts`
      + (e.boss ? ` contre ${e.boss}` : '') + (DIFF[e.difficulty] ? ` (${DIFF[e.difficulty].toLowerCase()})` : '');
    const lines = e.team.map((m, i) => `${i + 1}. ${m.name}${m.shiny ? ' ✨' : ''}`
      + ` (${RARITY[m.rarity] || m.rarity || '?'}${m.effectName && m.effectName !== 'Neutre' ? ', ' + m.effectName : ''})`);
    return [head, ...lines].join('\n');
  }

  async function copy(text, btn) {
    let ok = false;
    try { await navigator.clipboard.writeText(text); ok = true; } catch (e) {
      // Repli : sélection d'un textarea temporaire (navigateurs sans API presse-papiers).
      const ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { ok = document.execCommand('copy'); } catch (err) { ok = false; }
      document.body.removeChild(ta);
    }
    const msg = ok ? 'Composition copiée.' : 'Copie impossible.';
    statusEl.textContent = msg;
    if (window.rdbAnnounce) window.rdbAnnounce(msg);
    if (btn) { const old = btn.textContent; btn.textContent = ok ? '✓ Copié' : 'Échec'; setTimeout(() => { btn.textContent = old; }, 1600); }
  }

  function entryEl(e, idx) {
    const li = document.createElement('li');
    li.className = 'hof-entry' + (e.rank === 1 ? ' hof-entry--first' : '');

    const panelId = 'hof-panel-' + idx;
    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'hof-entry__head';
    head.setAttribute('aria-expanded', 'false');
    head.setAttribute('aria-controls', panelId);
    head.setAttribute('aria-label', `Rang ${e.rank}, ${e.pseudo}, ${nf.format(e.score)} points. Afficher le détail de l'équipe.`);

    const rank = document.createElement('span');
    rank.className = 'hof-entry__rank';
    rank.textContent = '#' + e.rank;

    const who = document.createElement('span');
    who.className = 'hof-entry__who';
    const name = document.createElement('span');
    name.className = 'hof-entry__name';
    name.textContent = e.pseudo;
    who.appendChild(name);
    if (e.titleLabel) {
      const t = document.createElement('span');
      t.className = 'hof-entry__title';
      t.textContent = e.titleLabel;
      who.appendChild(t);
    }

    const team = document.createElement('span');
    team.className = 'hof-entry__team';
    e.team.forEach(m => {
      const img = document.createElement('img');
      img.className = 'hof-entry__mon';
      img.src = monSprite(m);
      img.alt = '';
      img.loading = 'lazy';
      img.width = 32; img.height = 32;
      team.appendChild(img);
    });

    const score = document.createElement('span');
    score.className = 'hof-entry__score';
    score.textContent = nf.format(e.score) + ' pts';

    head.append(rank, who, team, score);

    const panel = document.createElement('div');
    panel.id = panelId;
    panel.className = 'hof-entry__panel screen--hidden';
    const meta = document.createElement('p');
    meta.className = 'hof-entry__meta';
    meta.textContent = (e.boss ? 'Boss : ' + e.boss : 'Route du Boss') + (DIFF[e.difficulty] ? ' · ' + DIFF[e.difficulty] : '')
      + (e.victory ? ' · Victoire' : ' · Défaite');
    const ul = document.createElement('ul');
    ul.className = 'hof-mons';
    ul.setAttribute('aria-label', 'Équipe de ' + e.pseudo);
    e.team.forEach(m => {
      const mi = document.createElement('li');
      mi.className = 'hof-mon';
      const img = document.createElement('img');
      img.src = monSprite(m); img.alt = ''; img.loading = 'lazy'; img.width = 48; img.height = 48;
      const txt = document.createElement('span');
      txt.className = 'hof-mon__text';
      const n = document.createElement('span');
      n.className = 'hof-mon__name';
      n.textContent = m.name + (m.shiny ? ' ✨' : '');
      const r = document.createElement('span');
      r.className = 'hof-mon__meta';
      r.textContent = (RARITY[m.rarity] || m.rarity || '') + (m.effectName && m.effectName !== 'Neutre' ? ' · ' + m.effectName : '');
      txt.append(n, r);
      mi.append(img, txt);
      ul.appendChild(mi);
    });
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn--ghost hof-entry__copy';
    btn.textContent = 'Copier la composition';
    btn.addEventListener('click', () => copy(teamText(e), btn));
    panel.append(meta, ul, btn);

    head.addEventListener('click', () => {
      const open = head.getAttribute('aria-expanded') === 'true';
      head.setAttribute('aria-expanded', String(!open));
      panel.classList.toggle('screen--hidden', open);
      li.classList.toggle('hof-entry--open', !open);
    });

    li.append(head, panel);
    return li;
  }

  async function load() {
    const id = ++reqId;
    try {
      const res = await fetch('/api/hall-of-fame', {
        method: 'POST', cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope })
      });
      const data = await res.json();
      if (id !== reqId) return; // réponse périmée (changement d'onglet entre-temps)
      listEl.innerHTML = '';
      const entries = Array.isArray(data.entries) ? data.entries : [];
      entries.forEach((e, i) => listEl.appendChild(entryEl(e, i)));
      emptyEl.textContent = data.unavailable
        ? 'Hall of Fame momentanément indisponible.'
        : (scope === 'today' ? "Aucune équipe classée aujourd'hui : sois le premier !" : "Aucune équipe classée hier.");
      emptyEl.classList.toggle('screen--hidden', entries.length > 0);
    } catch (e) {
      if (id !== reqId) return;
      listEl.innerHTML = '';
      emptyEl.textContent = 'Hall of Fame momentanément indisponible.';
      emptyEl.classList.remove('screen--hidden');
    }
  }

  tabs.forEach(tab => tab.addEventListener('click', () => {
    scope = tab.dataset.hofScope;
    tabs.forEach(t => {
      const on = t === tab;
      t.setAttribute('aria-selected', String(on));
      t.classList.toggle('hof-tab--active', on);
      t.tabIndex = on ? 0 : -1;
    });
    load();
  }));

  const canAutoRefresh = () => !document.hidden && document.body.dataset.screen === 'home';
  document.addEventListener('visibilitychange', () => { if (canAutoRefresh()) load(); });
  setInterval(() => { if (canAutoRefresh()) load(); }, 180000);
  // Retour sur l'accueil (fin de partie...) : rafraîchit, au plus 1 fois / 10 s.
  let last = 0;
  new MutationObserver(() => {
    if (document.body.dataset.screen !== 'home' || Date.now() - last < 10000) return;
    last = Date.now();
    load();
  }).observe(document.body, { attributes: true, attributeFilter: ['data-screen'] });
  socket.on('game_finished', () => { setTimeout(load, 4000); });

  load();
})();
