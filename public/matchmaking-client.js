'use strict';
// =====================================================================
// MATCHMAKING — côté client (chargé APRÈS client.js, dont il réutilise les globaux :
// socket, isHost, currentGameMode, lastLobbyPlayers, btnStart, avatarUrl...).
// Bouton "Trouver des adversaires" visible uniquement pour l'hôte SEUL dans son lobby, dans un mode
// compatible. Le serveur décide de tout (vrais joueurs trouvés pendant 30 s, puis bots, lancement) :
// ici, du rendu uniquement (compte à rebours local à partir de endsInMs).
// =====================================================================
(function () {
  const $ = id => document.getElementById(id);
  const el = {
    panel: $('mm-panel'), btnSearch: $('btn-mm-search'),
    searching: $('mm-searching'), status: $('mm-status'), found: $('mm-found'), btnCancel: $('btn-mm-cancel')
  };
  if (!el.panel || !el.btnSearch || !el.searching) return; // HTML non intégré : rien à faire

  let supportedModes = [];
  let searching = false;
  let last = null;        // dernier mm_state reçu
  let endsAtLocal = 0;    // fin de la phase "vrais joueurs" (horloge locale)
  let countdownTimer = 0;

  fetch('/api/matchmaking/config').then(r => r.json()).then(data => {
    if (data && Array.isArray(data.modes)) { supportedModes = data.modes; refresh(); }
  }).catch(() => { /* sans la config, le bouton reste simplement masqué */ });

  function canSearch() {
    return isHost() && lastLobbyPlayers.length === 1 && supportedModes.includes(currentGameMode);
  }

  function refresh() {
    el.panel.classList.toggle('screen--hidden', searching || !canSearch());
    el.searching.classList.toggle('screen--hidden', !searching);
    document.body.classList.toggle('mm-busy', searching); // grise les réglages du lobby (cf. style.css)
    if (searching) btnStart.classList.add('screen--hidden'); // la partie se lancera toute seule
    el.btnCancel.textContent = last && last.isHost === false ? 'Quitter la recherche' : 'Annuler la recherche';
  }

  function stopCountdown() {
    clearInterval(countdownTimer);
    countdownTimer = 0;
  }

  function renderStatus() {
    if (!last) return;
    const st = last;
    if (st.state === 'ready') {
      el.status.textContent = `Adversaires trouvés (${st.count}/${st.count}) : la partie démarre…`;
    } else if (st.phase === 'humans') {
      const secs = Math.max(0, Math.ceil((endsAtLocal - Date.now()) / 1000));
      el.status.textContent = `Recherche de joueurs… ${secs} s (${st.count}/${st.total})`;
    } else if (!st.found.length) {
      el.status.textContent = "Aucun joueur disponible : on te trouve des adversaires…";
    } else {
      el.status.textContent = `Joueur trouvé : ${st.found[st.found.length - 1].name} (${st.count}/${st.total})`;
    }
  }

  // Greffes non intrusives sur les rendus du lobby de client.js (chaînées avec les autres modules).
  ['renderGameMode', 'updateHostControls', 'renderLobbyPlayers'].forEach(name => {
    const original = window[name];
    if (typeof original !== 'function') return;
    window[name] = function () {
      const out = original.apply(this, arguments);
      refresh();
      return out;
    };
  });

  function renderFound(found) {
    el.found.innerHTML = '';
    found.forEach(f => {
      const li = document.createElement('li');
      li.className = 'mm-found__item';
      const av = document.createElement('span');
      av.className = 'mm-found__avatar';
      if (f.avatar && typeof avatarUrl === 'function') {
        const img = document.createElement('img');
        img.src = avatarUrl(f.avatar);
        img.alt = '';
        av.appendChild(img);
      } else {
        av.textContent = (f.name || '?').slice(0, 1).toUpperCase();
      }
      const name = document.createElement('span');
      name.textContent = f.name;
      li.append(av, name);
      if (!f.bot) { // un VRAI joueur trouvé
        const tag = document.createElement('span');
        tag.className = 'mm-found__tag';
        tag.textContent = 'joueur';
        li.appendChild(tag);
      }
      el.found.appendChild(li);
    });
  }

  function resetLocal() {
    searching = false;
    last = null;
    stopCountdown();
    el.found.innerHTML = '';
  }

  socket.on('mm_state', (st) => {
    if (st.state === 'idle') {
      resetLocal();
      if (st.left) { // un invité qui quitte la recherche quitte aussi le lobby
        if (typeof rememberActiveGame === 'function') rememberActiveGame(null);
        showScreen(screenHome);
      } else if (st.reason) {
        lobbyStatusEl.textContent = st.reason;
      }
      refresh();
      return;
    }
    searching = true;
    last = st;
    endsAtLocal = Date.now() + (st.endsInMs || 0);
    renderFound(st.found);
    stopCountdown();
    if (st.phase === 'humans' && st.state !== 'ready') countdownTimer = setInterval(renderStatus, 250); // compte à rebours des 30 s
    renderStatus();
    refresh();
  });

  // Tout changement de salle/connexion annule l'état local (le serveur a déjà tout nettoyé ; en cas de
  // déplacement vers un autre lobby, il renvoie aussitôt un mm_state qui rétablit l'affichage).
  ['game_created', 'game_joined', 'game_replayed', 'disconnect'].forEach(ev => {
    socket.on(ev, () => { resetLocal(); refresh(); });
  });

  el.btnSearch.addEventListener('click', () => {
    if (!canSearch()) return;
    socket.emit('mm_search');
  });
  el.btnCancel.addEventListener('click', () => socket.emit('mm_cancel'));
})();
