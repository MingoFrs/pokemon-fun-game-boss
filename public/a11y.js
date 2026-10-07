/* Accessibilité — lecteur d'écran, clavier, réglages d'affichage.
 * Dépend de client.js (socket) ; chargé après lui.
 * Réglages (localStorage rdb_settings_v1, mêmes clés que le script anti-flash de <head>) :
 *   highContrast · colorblind · largeText · srAnnounce (annonces, activées par défaut). */
(function () {
  'use strict';
  const KEY = 'rdb_settings_v1';
  const root = document.documentElement;
  const $ = id => document.getElementById(id);

  const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { return {}; } };
  const save = s => { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (e) {} };

  // ---------- Réglages d'affichage ----------
  const TOGGLES = [
    { id: 'settings-high-contrast', key: 'highContrast', cls: 'high-contrast' },
    { id: 'settings-colorblind', key: 'colorblind', cls: 'colorblind' },
    { id: 'settings-large-text', key: 'largeText', cls: 'large-text' }
  ];
  const settings = load();
  TOGGLES.forEach(t => {
    const input = $(t.id);
    root.classList.toggle(t.cls, !!settings[t.key]);
    if (!input) return;
    input.checked = !!settings[t.key];
    input.addEventListener('change', () => {
      const s = load();
      s[t.key] = input.checked;
      save(s);
      root.classList.toggle(t.cls, input.checked);
    });
  });
  const srInput = $('settings-sr-announce');
  const srEnabled = () => load().srAnnounce !== false;
  if (srInput) {
    srInput.checked = srEnabled();
    srInput.addEventListener('change', () => { const s = load(); s.srAnnounce = srInput.checked; save(s); });
  }

  // ---------- Régions live ----------
  function makeLive(id, role, live) {
    const el = document.createElement('div');
    el.id = id;
    el.className = 'sr-only';
    el.setAttribute('role', role);
    el.setAttribute('aria-live', live);
    el.setAttribute('aria-atomic', 'true');
    document.body.appendChild(el);
    return el;
  }
  const polite = makeLive('sr-live', 'status', 'polite');
  const assertive = makeLive('sr-alert', 'alert', 'assertive');

  function announce(text, urgent) {
    if (!text || !srEnabled()) return;
    const el = urgent ? assertive : polite;
    el.textContent = '';
    // Le vidage puis la réécriture décalée force les lecteurs d'écran à relire un message identique.
    setTimeout(() => { el.textContent = String(text); }, 60);
  }
  window.rdbAnnounce = announce;

  // ---------- Annonces des événements de jeu ----------
  let lastTurn = null;
  const me = list => (Array.isArray(list) ? list.find(p => p && p.id === socket.id) : null);
  const pts = n => (typeof n === 'number' ? n.toLocaleString('fr-FR') : '?');
  const mon = o => (o ? o.name + (o.shiny ? ' (chromatique)' : '') : '?');

  socket.on('game_started', (d) => {
    lastTurn = d && d.turn;
    if (!d || !d.boss) return;
    announce('Partie lancée contre ' + d.boss.name + '. Objectif : ' + pts(d.boss.requiredPoints) + ' points en ' + d.maxTurns + ' tours.');
  });
  socket.on('game_updated', (d) => {
    if (!d || d.status !== 'playing' || d.turn === lastTurn) return;
    lastTurn = d.turn;
    const mine = me(d.players);
    announce('Tour ' + d.turn + ' sur ' + d.maxTurns + (mine ? '. Ton score : ' + pts(mine.score) + ' points.' : '.'));
  });
  socket.on('turn_options', (o) => {
    if (!o) return;
    announce('Choix. Haut : ' + mon(o.haut) + '. Bas : ' + mon(o.bas) + '.');
  });
  socket.on('game_finished', (d) => {
    const mine = d && me(d.players);
    if (!mine) { announce('Partie terminée.'); return; }
    announce('Partie terminée. ' + (mine.result === 'victory' ? 'Victoire' : 'Défaite') + ', ' + pts(mine.score) + ' points.');
  });
  socket.on('error_message', (msg) => announce(msg, true));
  // Défi quotidien
  socket.on('daily_turn', (t) => {
    if (!t || !t.options) return;
    announce('Défi quotidien, tour ' + t.turn + '. Haut : ' + mon(t.options.haut || t.options[0]) + '. Bas : ' + mon(t.options.bas || t.options[1]) + '.');
  });
  socket.on('daily_finished', (f) => {
    if (!f) return;
    announce('Défi quotidien terminé. ' + (f.victory ? 'Victoire' : 'Défaite') + (typeof f.score === 'number' ? ', ' + pts(f.score) + ' points.' : '.'));
  });
  socket.on('daily_error', (msg) => announce(msg, true));

  // ---------- Statuts statiques -> régions live ----------
  ['finished-outcome', 'fly-finished-outcome', 'daily-card-status', 'finished-status', 'quests-status'].forEach(id => {
    const el = $(id);
    if (el && !el.getAttribute('role')) el.setAttribute('role', 'status');
  });
  document.querySelectorAll('.lobby-status').forEach(el => { if (!el.getAttribute('role')) el.setAttribute('role', 'status'); });

  // ---------- Images décoratives : alt="" par défaut (jamais le nom de fichier lu à voix haute) ----------
  function fixImg(img) { if (!img.hasAttribute('alt')) img.setAttribute('alt', ''); }
  document.querySelectorAll('img').forEach(fixImg);
  new MutationObserver((muts) => {
    muts.forEach(m => m.addedNodes.forEach(n => {
      if (n.nodeType !== 1) return;
      if (n.tagName === 'IMG') fixImg(n);
      else if (n.querySelectorAll) n.querySelectorAll('img').forEach(fixImg);
    }));
  }).observe(document.body, { childList: true, subtree: true });

  // ---------- Lien d'évitement + focus à chaque changement d'écran ----------
  const skip = document.createElement('a');
  skip.href = '#';
  skip.className = 'skip-link';
  skip.textContent = 'Aller au contenu';
  const visibleScreen = () => document.querySelector('section.screen:not(.screen--hidden)');
  function focusScreen(el) {
    if (!el) return;
    const target = el.querySelector('h1, h2, .finished-outcome') || el;
    if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
    target.focus({ preventScroll: true });
  }
  skip.addEventListener('click', (e) => { e.preventDefault(); focusScreen(visibleScreen()); });
  document.body.insertBefore(skip, document.body.firstChild);

  let firstScreen = true;
  let lastScreen = document.body.dataset.screen;
  new MutationObserver(() => {
    const cur = document.body.dataset.screen;
    if (cur === lastScreen) return;
    lastScreen = cur;
    if (firstScreen) { firstScreen = false; }
    // Léger délai : laisse le rendu de l'écran terminer avant de déplacer le focus.
    setTimeout(() => focusScreen(visibleScreen()), 80);
  }).observe(document.body, { attributes: true, attributeFilter: ['data-screen'] });

  // ---------- Boîtes de dialogue (Réglages, événements...) : focus piégé, Échap, restitution ----------
  const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  const openers = new WeakMap();

  function visibleFocusables(dlg) {
    return Array.from(dlg.querySelectorAll(FOCUSABLE)).filter(el => el.offsetParent !== null);
  }
  function watchDialog(dlg) {
    let wasHidden = dlg.classList.contains('screen--hidden');
    new MutationObserver(() => {
      const hidden = dlg.classList.contains('screen--hidden');
      if (hidden === wasHidden) return;
      wasHidden = hidden;
      if (!hidden) {
        openers.set(dlg, document.activeElement);
        setTimeout(() => { const f = visibleFocusables(dlg)[0]; if (f) f.focus(); }, 50);
      } else {
        const op = openers.get(dlg);
        if (op && document.contains(op) && op.focus) op.focus();
      }
    }).observe(dlg, { attributes: true, attributeFilter: ['class'] });
  }
  document.querySelectorAll('[role="dialog"]').forEach(watchDialog);

  document.addEventListener('keydown', (e) => {
    const dlg = Array.from(document.querySelectorAll('[role="dialog"]')).find(d => !d.classList.contains('screen--hidden'));
    if (!dlg) return;
    if (e.key === 'Escape') {
      const close = dlg.querySelector('[aria-label="Fermer"], .settings-header__close, [data-close]');
      if (close) { e.preventDefault(); close.click(); }
      return;
    }
    if (e.key !== 'Tab') return;
    const f = visibleFocusables(dlg);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });

  // ---------- Onglets des réglages : flèches gauche/droite ----------
  document.querySelectorAll('[role="tablist"]').forEach(tl => {
    tl.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const tabs = Array.from(tl.querySelectorAll('[role="tab"]'));
      const i = tabs.indexOf(document.activeElement);
      if (i < 0) return;
      e.preventDefault();
      const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
      next.focus();
      next.click();
    });
  });
})();
