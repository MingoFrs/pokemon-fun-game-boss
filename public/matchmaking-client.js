'use strict';
// =====================================================================
// MATCHMAKING — côté client (chargé APRÈS client.js, dont il réutilise les globaux :
// socket, isHost, currentGameMode, lastLobbyPlayers, btnStart, avatarUrl...).
// Bouton "Trouver des adversaires" visible uniquement pour l'hôte SEUL dans son lobby, dans un mode
// compatible. Le serveur décide de tout (joueurs trouvés, lancement) : ici, du rendu uniquement.
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
      el.found.appendChild(li);
    });
  }

  socket.on('mm_state', (st) => {
    if (st.state === 'idle') {
      searching = false;
      el.found.innerHTML = '';
      if (st.reason) lobbyStatusEl.textContent = st.reason;
      refresh();
      return;
    }
    searching = true;
    renderFound(st.found);
    const n = st.found.length + 1;
    if (st.state === 'ready') el.status.textContent = `Adversaires trouvés (${st.total}/${st.total}) : la partie démarre…`;
    else if (!st.found.length) el.status.textContent = "Recherche d'adversaires…";
    else el.status.textContent = `Joueur trouvé : ${st.found[st.found.length - 1].name} (${n}/${st.total})`;
    refresh();
  });

  // Tout changement de salle/connexion annule l'état local (le serveur a déjà tout nettoyé).
  ['game_created', 'game_joined', 'game_replayed', 'disconnect'].forEach(ev => {
    socket.on(ev, () => { searching = false; el.found.innerHTML = ''; refresh(); });
  });

  el.btnSearch.addEventListener('click', () => {
    if (!canSearch()) return;
    socket.emit('mm_search');
  });
  el.btnCancel.addEventListener('click', () => socket.emit('mm_cancel'));
})();
