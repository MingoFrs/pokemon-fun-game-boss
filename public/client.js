const socket = io();

// ---------- Écran de chargement ----------
// Overlay tant que des sprites reçus du serveur ne sont pas chargés (tous modes :
// normal/admin/coop/fly, guess, auction, spectateur, reconnexion). Hook générique sur TOUS les
// événements socket : tout champ `sprite` / `shinySprite` (profondeur quelconque) est
// préchargé. Overlay affiché après 150 ms seulement (aucun flash si déjà en cache), jamais
// bloquant plus de 8 s (une image en erreur compte comme terminée : les handlers existants
// ont déjà leurs replis onerror). Au boot : attend polices + connexion socket (max 5 s).
const loadingOverlayEl = document.getElementById('loading-overlay');
const loadingTextEl = document.getElementById('loading-text');
const LOADING_SHOW_DELAY_MS = 150;
const LOADING_MAX_WAIT_MS = 8000;
const LOADING_BOOT_MAX_MS = 5000;
const preloadedSprites = new Set();
const preloadingSprites = new Set();
let loadingPending = 0;
let loadingTotal = 0;
let loadingShowTimer = null;
let loadingBootPending = true;

function refreshLoadingOverlay() {
  const busy = loadingBootPending || loadingPending > 0;
  if (!busy) {
    clearTimeout(loadingShowTimer);
    loadingShowTimer = null;
    loadingTotal = 0;
    loadingOverlayEl.classList.add('is-hidden');
    return;
  }
  loadingTextEl.textContent = loadingPending > 0 && loadingTotal > 1
    ? `Chargement… ${loadingTotal - loadingPending}/${loadingTotal}`
    : 'Chargement…';
  if (loadingOverlayEl.classList.contains('is-hidden') && !loadingShowTimer) {
    loadingShowTimer = setTimeout(() => {
      loadingShowTimer = null;
      if (loadingBootPending || loadingPending > 0) loadingOverlayEl.classList.remove('is-hidden');
    }, LOADING_SHOW_DELAY_MS);
  }
}

function preloadSprite(url) {
  if (typeof url !== 'string' || !url || preloadedSprites.has(url) || preloadingSprites.has(url)) return;
  preloadingSprites.add(url);
  loadingPending++;
  loadingTotal++;
  let settled = false;
  const img = new Image();
  const finish = () => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    preloadingSprites.delete(url);
    preloadedSprites.add(url);
    loadingPending--;
    refreshLoadingOverlay();
  };
  const timer = setTimeout(finish, LOADING_MAX_WAIT_MS);
  img.onload = finish;
  img.onerror = finish;
  img.src = url;
}

function collectSprites(value, depth) {
  if (!value || typeof value !== 'object' || depth > 6) return;
  if (Array.isArray(value)) {
    value.forEach(v => collectSprites(v, depth + 1));
    return;
  }
  for (const key of Object.keys(value)) {
    const v = value[key];
    if ((key === 'sprite' || key === 'shinySprite') && typeof v === 'string') preloadSprite(v);
    else if (v && typeof v === 'object') collectSprites(v, depth + 1);
  }
}

function onIncomingSocketEvent(args) {
  try { collectSprites(args, 0); } catch (e) {}
  refreshLoadingOverlay();
}

if (typeof socket.onAny === 'function') {
  socket.onAny((event, ...args) => onIncomingSocketEvent(args)); // socket.io v3+ : appelé avant les handlers
} else {
  const originalOnEvent = socket.onevent; // socket.io v2
  socket.onevent = function (packet) {
    onIncomingSocketEvent((packet && packet.data ? packet.data.slice(1) : []));
    return originalOnEvent.apply(this, arguments);
  };
}

(function bootLoading() {
  const waits = [];
  if (document.fonts && document.fonts.ready) waits.push(document.fonts.ready.catch(() => {}));
  if (document.readyState !== 'complete') {
    waits.push(new Promise(res => window.addEventListener('load', res, { once: true })));
  }
  if (!socket.connected) {
    waits.push(new Promise(res => socket.once('connect', res)));
  }
  const end = () => {
    if (!loadingBootPending) return;
    loadingBootPending = false;
    refreshLoadingOverlay();
  };
  setTimeout(end, LOADING_BOOT_MAX_MS);
  Promise.all(waits).then(end);
})();

// Easter egg : dex id de Métamorph (cf. socket.on('transform_metamorph') côté serveur).
const METAMORPH_DEX_ID = 132;

// ---------- Éléments DOM : écrans ----------
// Déclarés ICI, avant toute logique de reconnexion : celle-ci référence ces éléments
// immédiatement au chargement (pas seulement dans des handlers différés), donc l'ordre
// compte réellement — les référencer avant leur déclaration plante tout le script.
const screenHome = document.getElementById('screen-home');
const reconnectStatusEl = document.getElementById('reconnect-status');
const homeFormsEl = document.getElementById('home-forms');
const homeCardsEl = document.getElementById('home-cards');
const screenLobby = document.getElementById('screen-lobby');
const screenGame = document.getElementById('screen-game');
const screenFinished = document.getElementById('screen-finished');
const screenGuess = document.getElementById('screen-guess');
const screenGuessFinished = document.getElementById('screen-guess-finished');
const screenAuction = document.getElementById('screen-auction');
const screenAuctionFinished = document.getElementById('screen-auction-finished');
const screenSpectate = document.getElementById('screen-spectate');

// ---------- Reconnexion (cf. socket.on('rejoin_game') côté serveur) ----------
// Token stable par navigateur, généré une seule fois et conservé en localStorage : c'est
// lui (et non socket.id, qui change à chaque connexion) qui permet au serveur de
// retrouver le bon joueur après une coupure réseau ou un refresh de page pendant une
// partie en cours.
function getOrCreateDeviceToken() {
  let token = localStorage.getItem('routeduboss_token');
  if (!token) {
    token = Array.from({ length: 24 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
    localStorage.setItem('routeduboss_token', token);
  }
  return token;
}
const deviceToken = getOrCreateDeviceToken();

// gameId de la partie en cours (si il y en a une), retenu pour tenter une reconnexion
// automatique au chargement de la page. Effacé dès qu'on quitte volontairement une
// partie ou qu'une partie se termine.
function rememberActiveGame(gameId) {
  if (gameId) localStorage.setItem('routeduboss_active_game', gameId);
  else localStorage.removeItem('routeduboss_active_game');
}

// Si une partie était en cours au dernier chargement, masque le formulaire créer/rejoindre
// et affiche "Reconnexion..." le temps que rejoin_success/rejoin_failed tranche — sinon
// on verrait le formulaire s'afficher une fraction de seconde avant d'être remplacé.
// SAUF si la reconnexion automatique est désactivée (cf. Réglages > Partie) : lecture
// brute de rdb_settings_v1 ici plutôt que via loadSettings() (déclarée bien plus bas,
// section Réglages) car ce bloc s'exécute AVANT que cette déclaration n'ait pu tourner —
// même contrainte d'ordre que le script anti-flash dans index.html.
let earlyAutoReconnect = true;
try {
  const earlySettings = JSON.parse(localStorage.getItem('rdb_settings_v1')) || {};
  earlyAutoReconnect = earlySettings.autoReconnect !== false;
} catch (e) {}

const pendingRejoinGameId = earlyAutoReconnect ? localStorage.getItem('routeduboss_active_game') : null;
if (pendingRejoinGameId) {
  reconnectStatusEl.classList.remove('screen--hidden');
  homeFormsEl.classList.add('screen--hidden');
  homeCardsEl.classList.add('screen--hidden');
}
function endReconnectAttempt() {
  reconnectStatusEl.classList.add('screen--hidden');
  homeFormsEl.classList.remove('screen--hidden');
  homeCardsEl.classList.remove('screen--hidden');
}

// ---------- Accueil ----------
const pseudoInput = document.getElementById('pseudo-input');
const codeInput = document.getElementById('code-input');
const btnCreate = document.getElementById('btn-create');
const btnJoin = document.getElementById('btn-join');
const errorMessage = document.getElementById('error-message');

// ---------- Compte (optionnel — le mode invité avec juste un pseudo reste inchangé) ----------
// Tout le système vit maintenant DANS le panneau Réglages (plus d'overlay séparé) : les
// liens du statut d'accueil se contentent d'ouvrir les Réglages (cf. openSettings, plus
// bas dans ce fichier), qui rafraîchit la section Compte à chaque ouverture.
const accountStatusGuestEl = document.getElementById('account-status-guest');
const accountStatusLoggedEl = document.getElementById('account-status-logged');
const accountStatusAvatarEl = document.getElementById('account-status-avatar');
const accountStatusPseudoEl = document.getElementById('account-status-pseudo');
const btnAccountOpen = document.getElementById('btn-account-open');
const btnAccountOpenLogged = document.getElementById('btn-account-open-logged');
const btnAccountLogoutModal = document.getElementById('btn-account-logout-modal');
const accountTabButtons = Array.from(document.querySelectorAll('#account-tabs .admin-role-btn'));
const accountTabsContainerEl = document.getElementById('account-tabs');
const accountFormLoginEl = document.getElementById('account-form-login');
const accountFormRegisterEl = document.getElementById('account-form-register');
const accountLoginEmailEl = document.getElementById('account-login-email');
const accountLoginPasswordEl = document.getElementById('account-login-password');
const accountRegisterPseudoEl = document.getElementById('account-register-pseudo');
const accountRegisterEmailEl = document.getElementById('account-register-email');
const accountRegisterPasswordEl = document.getElementById('account-register-password');
const btnAccountLogin = document.getElementById('btn-account-login');
const btnAccountRegister = document.getElementById('btn-account-register');
const accountLoggedPanelEl = document.getElementById('account-logged-panel');
const accountAvatarCurrentEl = document.getElementById('account-avatar-current');
const accountLoggedPseudoEl = document.getElementById('account-logged-pseudo');
const accountLoggedTitleEl = document.getElementById('account-logged-title');
const accountTitlesListEl = document.getElementById('account-titles-list');
const accountLevelValueEl = document.getElementById('account-level-value');
const accountXpBarFillEl = document.getElementById('account-xp-bar-fill');
const accountXpTextEl = document.getElementById('account-xp-text');
const accountAvatarGridEl = document.getElementById('account-avatar-grid');
const accountHistoryListEl = document.getElementById('account-history-list');
const accountAchievementsListEl = document.getElementById('account-achievements-list');
const achievementToastContainerEl = document.getElementById('achievement-toast-container');
const leaderboardListEl = document.getElementById('leaderboard-list');
const friendsSearchInputEl = document.getElementById('friends-search-input');
const friendsSearchResultsEl = document.getElementById('friends-search-results');
const friendsIncomingBlockEl = document.getElementById('friends-incoming-block');
const friendsIncomingListEl = document.getElementById('friends-incoming-list');
const friendsOutgoingBlockEl = document.getElementById('friends-outgoing-block');
const friendsOutgoingListEl = document.getElementById('friends-outgoing-list');
const friendsListEl = document.getElementById('friends-list');
const lobbyFriendsBarEl = document.getElementById('lobby-friends-bar');
const lobbyFriendsBarListEl = document.getElementById('lobby-friends-bar-list');
const friendInviteToastContainerEl = document.getElementById('friend-invite-toast-container');
const accountPokedexCountEl = document.getElementById('account-pokedex-count');
const accountPokedexSearchEl = document.getElementById('account-pokedex-search');
const accountPokedexGridEl = document.getElementById('account-pokedex-grid');
const accountPokedexGenTabsEl = document.getElementById('account-pokedex-gen-tabs');
const accountStatsContentEl = document.getElementById('account-stats-content');
const accountAvatarSearchEl = document.getElementById('account-avatar-search');
const accountErrorEl = document.getElementById('account-error');
const settingsTabButtons = Array.from(document.querySelectorAll('.settings-tab'));
const settingsPageEls = Array.from(document.querySelectorAll('.settings-page'));
const accountSubtabButtons = Array.from(document.querySelectorAll('.settings-subtab'));
const accountSubpageEls = Array.from(document.querySelectorAll('.account-subpage'));

// Reflet côté client de la formule de niveau du serveur (cf. xpForLevel/levelForXp dans
// server.js) : UNIQUEMENT pour afficher la barre de progression jusqu'au niveau suivant
// — le serveur reste seul à calculer et stocker le niveau réel (renvoyé directement dans
// account.level à chaque login/session, jamais recalculé ici pour la valeur affichée).
const XP_LEVEL_STEP = 100;
function xpForLevel(level) {
  return Math.round(XP_LEVEL_STEP * level * (level - 1) / 2);
}

function renderAccountLevel(account) {
  const level = account.level || 1;
  const xp = account.xp || 0;
  const floor = xpForLevel(level);
  const ceil = xpForLevel(level + 1);
  const pct = ceil > floor ? Math.max(0, Math.min(100, ((xp - floor) / (ceil - floor)) * 100)) : 100;
  accountLevelValueEl.textContent = level;
  accountXpBarFillEl.style.width = `${pct}%`;
  accountXpTextEl.textContent = `${xp} / ${ceil} XP`;
}

// ---------- Déblocages par niveau (couleurs de thème + cadres d'avatar) ----------
// Chaque swatch porte data-required-level dans le HTML — une seule fonction pour les deux
// familles (même mécanique). Un invité (pas de compte) garde TOUT ouvert : le système de
// déblocage n'a de sens que pour un compte qui progresse en XP/niveau.
const accountFrameButtons = Array.from(document.querySelectorAll('.account-frame-swatch'));

function applyUnlockLocks(buttons, level) {
  buttons.forEach(btn => {
    const required = Number(btn.dataset.requiredLevel || 1);
    const locked = level !== null && level < required;
    btn.classList.toggle('is-locked', locked);
    btn.disabled = locked;
  });
}

function refreshCosmeticLocks() {
  const account = getStoredAccount();
  const level = account ? (account.level || 1) : null; // null = invité : rien de verrouillé
  applyUnlockLocks(settingsThemeButtons, level);
  applyUnlockLocks(accountFrameButtons, level);
  accountFrameButtons.forEach(btn => {
    btn.classList.toggle('account-frame-swatch--selected', !!account && (account.frame || '') === btn.dataset.frame);
  });
}

// Applique le cadre choisi à UNE image d'avatar donnée (retire l'ancien, pose le nouveau) —
// utilisé partout où un avatar de compte est affiché.
function applyAvatarFrame(imgEl, frame) {
  ['bronze', 'silver', 'gold', 'legendary'].forEach(f => imgEl.classList.remove(`avatar-frame--${f}`));
  if (frame) imgEl.classList.add(`avatar-frame--${frame}`);
}

const GAME_MODE_LABELS = { normal: 'Route du Boss', admin: 'Admin vs Joueur', guess: 'Devine le Pokémon', auction: 'Draft/Enchères' };
const RESULT_LABELS = { victory: 'Victoire', defeat: 'Défaite', participation: 'Terminé' };

// Détail "équipe complète" d'une ligne d'historique (cf. colonne `team` ajoutée à
// game_history côté serveur, cf. recordGameResult) : un tableau de Pokémon pour
// normal/admin/auction, ou null en mode "guess" (pas de concept d'équipe). Replié par
// défaut (juste le résumé), déplié au clic sur la ligne — jamais les deux affichés
// d'entrée pour garder la liste compacte.
function buildAccountHistoryTeamDetail(team) {
  if (!Array.isArray(team) || team.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'account-history-item__team-empty';
    empty.textContent = "Aucune équipe enregistrée pour cette partie.";
    return empty;
  }
  const wrap = document.createElement('div');
  wrap.className = 'account-history-item__team';
  team.forEach(mon => {
    const slot = document.createElement('div');
    slot.className = 'account-history-item__team-slot';
    const img = document.createElement('img');
    img.src = pokemonSprite(mon);
    img.alt = mon.name;
    slot.appendChild(img);
    wrap.appendChild(slot);
  });
  return wrap;
}

async function fetchAndRenderAccountHistory(account) {
  accountHistoryListEl.innerHTML = '';
  try {
    const res = await fetch('/api/profile/history', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accessToken: account.accessToken })
    });
    const data = await res.json();
    if (!res.ok || !data.history || !data.history.length) {
      const empty = document.createElement('p');
      empty.className = 'account-history-empty';
      empty.textContent = 'Aucune partie terminée pour le moment.';
      accountHistoryListEl.appendChild(empty);
      return;
    }
    data.history.forEach(entry => {
      const li = document.createElement('li');
      li.className = 'account-history-item' + (entry.result === 'victory' ? ' account-history-item--victory' : entry.result === 'defeat' ? ' account-history-item--defeat' : '');

      const row = document.createElement('div');
      row.className = 'account-history-item__row';

      const mode = document.createElement('span');
      mode.className = 'account-history-item__mode';
      mode.textContent = GAME_MODE_LABELS[entry.game_mode] || entry.game_mode;

      const detail = document.createElement('span');
      detail.className = 'account-history-item__detail';
      const resultLabel = RESULT_LABELS[entry.result] || entry.result;
      const parts = [resultLabel];
      if (entry.opponent_name) parts.push(`vs ${entry.opponent_name}`);
      if (entry.score !== null && entry.score !== undefined) parts.push(`${entry.score} pts`);
      detail.textContent = parts.join(' · ');

      const date = document.createElement('span');
      date.className = 'account-history-item__date';
      const d = new Date(entry.created_at);
      date.textContent = `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;

      row.appendChild(mode);
      row.appendChild(detail);
      row.appendChild(date);
      li.appendChild(row);
      li.appendChild(buildAccountHistoryTeamDetail(entry.team));

      // Construit le détail une seule fois (au-dessus), juste replié/déplié au clic —
      // jamais reconstruit à chaque toggle.
      li.addEventListener('click', () => {
        li.classList.toggle('account-history-item--expanded');
      });

      accountHistoryListEl.appendChild(li);
    });
  } catch (err) {
    const empty = document.createElement('p');
    empty.className = 'account-history-empty';
    empty.textContent = 'Historique indisponible pour le moment.';
    accountHistoryListEl.appendChild(empty);
  }
}

// ---------- Succès ----------
const ACHIEVEMENT_CATEGORY_LABELS = { facile: 'Facile', difficile: 'Difficile' };
// Icône purement décorative par clé — jamais transmise par le serveur (qui ne connaît que
// label/description/category) : un simple mapping visuel côté client, facile à étendre si
// de nouveaux succès sont ajoutés côté serveur (retombe sur 🏆 par défaut, jamais cassé).
const ACHIEVEMENT_ICONS = {
  first_game: '🎮',
  first_win: '🥇',
  first_legendary: '✨',
  first_epic: '💎',
  first_shiny: '🌟',
  games_5: '📅',
  guess_win: '🕵️',
  admin_win: '🤖',
  score_6000: '💯',
  wins_10: '🏆',
  beat_extreme: '🔥',
  full_legendary_team: '👑',
  auction_full_team: '💰',
  three_modes_win: '🧭',
  win_streak_3: '⚡',
  za_mega_first: '🧬',
  za_mega_10: '🧪',
  za_mega_all: '🌌',
  gamble_x2: '🎰',
  gamble_x05: '📉',
  aura_duo: '☯️',
  six_traits: '🎭',
  p2l_victory: '🍀',
  all_traits: '📖'
};

async function fetchAndRenderAccountAchievements(account) {
  accountAchievementsListEl.innerHTML = '';
  accountTitlesListEl.innerHTML = '';
  try {
    const res = await fetch('/api/profile/achievements', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accessToken: account.accessToken })
    });
    const data = await res.json();
    if (!res.ok || !data.achievements) {
      const empty = document.createElement('p');
      empty.className = 'account-history-empty';
      empty.textContent = 'Succès indisponibles pour le moment.';
      accountAchievementsListEl.appendChild(empty);
      accountTitlesListEl.appendChild(empty.cloneNode(true));
      return;
    }

    // 2 catégories fixes (facile/difficile, cf. ACHIEVEMENTS côté serveur) : toujours les
    // deux affichées, dans cet ordre, même si l'une d'elles n'a encore rien de débloqué.
    ['facile', 'difficile'].forEach(category => {
      const items = data.achievements.filter(a => a.category === category);
      if (items.length === 0) return;

      const block = document.createElement('div');
      const title = document.createElement('p');
      title.className = 'account-achievements-category__title';
      title.textContent = ACHIEVEMENT_CATEGORY_LABELS[category] || category;
      block.appendChild(title);

      const grid = document.createElement('div');
      grid.className = 'account-achievements-grid';
      items.forEach(a => {
        const badge = document.createElement('div');
        badge.className = `account-achievement-badge account-achievement-badge--${category}` + (a.unlocked ? ' account-achievement-badge--unlocked' : ' account-achievement-badge--locked');
        badge.title = a.unlocked ? a.description : `??? — ${a.description}`;

        const icon = document.createElement('span');
        icon.className = 'account-achievement-badge__icon';
        icon.textContent = ACHIEVEMENT_ICONS[a.key] || '🏆';

        const label = document.createElement('span');
        label.className = 'account-achievement-badge__label';
        label.textContent = a.unlocked ? a.label : '???';

        badge.appendChild(icon);
        badge.appendChild(label);
        grid.appendChild(badge);
      });
      block.appendChild(grid);
      accountAchievementsListEl.appendChild(block);
    });

    accountTitlesCache = { achievements: data.achievements, selected: data.selectedTitle || '' };
    renderAccountTitles();
  } catch (err) {
    const empty = document.createElement('p');
    empty.className = 'account-history-empty';
    empty.textContent = 'Succès indisponibles pour le moment.';
    accountAchievementsListEl.appendChild(empty);
    accountTitlesListEl.appendChild(empty.cloneNode(true));
  }
}

// ---------- Titres (1 par succès, équipables une fois le succès débloqué) ----------
let accountTitlesCache = { achievements: [], selected: '' };

// Ligne "titre équipé" sous le pseudo dans la carte profil (masquée si aucun).
function renderAccountTitleLine(account) {
  const label = account && account.titleLabel ? account.titleLabel : '';
  accountLoggedTitleEl.textContent = label;
  accountLoggedTitleEl.classList.toggle('screen--hidden', !label);
}

function buildTitleOption({ icon, name, hint, selected, locked, onClick }) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'account-title-option' + (selected ? ' account-title-option--selected' : '');
  btn.disabled = !!locked;

  const iconEl = document.createElement('span');
  iconEl.className = 'account-title-option__icon';
  iconEl.textContent = icon;

  const text = document.createElement('span');
  text.className = 'account-title-option__text';
  const nameEl = document.createElement('span');
  nameEl.className = 'account-title-option__name';
  nameEl.textContent = name;
  const hintEl = document.createElement('span');
  hintEl.className = 'account-title-option__hint';
  hintEl.textContent = hint;
  text.appendChild(nameEl);
  text.appendChild(hintEl);

  btn.appendChild(iconEl);
  btn.appendChild(text);
  if (!locked) btn.addEventListener('click', onClick);
  return btn;
}

function renderAccountTitles() {
  accountTitlesListEl.innerHTML = '';
  const { achievements, selected } = accountTitlesCache;

  accountTitlesListEl.appendChild(buildTitleOption({
    icon: '∅',
    name: 'Aucun titre',
    hint: 'Ne rien afficher sous ton pseudo.',
    selected: selected === '',
    locked: false,
    onClick: () => equipAccountTitle('')
  }));

  // Débloqués d'abord, puis verrouillés (ordre serveur conservé à l'intérieur de chaque groupe).
  const ordered = achievements.filter(a => a.unlocked).concat(achievements.filter(a => !a.unlocked));
  ordered.forEach(a => {
    accountTitlesListEl.appendChild(buildTitleOption({
      icon: ACHIEVEMENT_ICONS[a.key] || '🏆',
      name: a.unlocked ? a.title : '???',
      hint: a.unlocked ? `Succès : ${a.label}` : `Succès requis : ${a.description}`,
      selected: a.unlocked && selected === a.key,
      locked: !a.unlocked,
      onClick: () => equipAccountTitle(a.key)
    }));
  });
}

async function equipAccountTitle(key) {
  const account = getStoredAccount();
  if (!account) return;
  try {
    const res = await fetch('/api/profile/title', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accessToken: account.accessToken, title: key })
    });
    const data = await res.json();
    if (!res.ok) {
      accountErrorEl.textContent = data.error || "Le titre n'a pas pu être changé.";
      return;
    }
    accountErrorEl.textContent = '';
    const updated = Object.assign({}, account, { title: data.title, titleLabel: data.titleLabel });
    setStoredAccount(updated);
    renderAccountTitleLine(updated);
    accountTitlesCache.selected = data.title;
    renderAccountTitles();
  } catch (err) {
    accountErrorEl.textContent = 'Connexion au serveur impossible.';
  }
}

// ---------- Pokédex personnel ----------
// Galerie de tout ce qui a déjà été obtenu au moins une fois (toutes parties/modes
// confondus) — PAS un dex complet avec silhouettes des non-obtenus (jamais demandé, et le
// client n'a de toute façon pas la liste complète des ~1073 Pokémon/méga possibles).
let pokedexSeenCache = [];
let pokedexOwnedMap = new Map(); // id -> { id, name, sprite, shiny }
let pokedexTraitsOwned = {}; // Trait-dex : nom du trait -> { count, minRoll?, maxRoll? } (cf. /api/profile/pokedex)
let nationalDexCache = null; // { generations, dex } (cf. GET /api/pokedex/national)
let currentPokedexGen = 1;

function pokemonSpriteUrl(dexId) {
  return `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/${dexId}.png`;
}

async function loadNationalDexIfNeeded() {
  if (nationalDexCache) return nationalDexCache;
  const res = await fetch('/api/pokedex/national');
  nationalDexCache = await res.json();
  return nationalDexCache;
}

// Onglets par génération (Gen 1 Kanto ... Gen 9 Paldea, cf. GENERATIONS côté serveur).
// Le badge sous chaque onglet (ex. "42/151") est recalculé à chaque rendu depuis
// pokedexOwnedMap, jamais stocké : toujours cohérent avec les Pokémon réellement obtenus.
function renderPokedexGenTabs() {
  accountPokedexGenTabsEl.innerHTML = '';
  nationalDexCache.generations.forEach(gen => {
    const owned = nationalDexCache.dex.filter(p => p.id >= gen.from && p.id <= gen.to && pokedexOwnedMap.has(p.id)).length;
    const total = gen.to - gen.from + 1;
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'pokedex-gen-tab' + (gen.gen === currentPokedexGen ? ' pokedex-gen-tab--selected' : '');
    tab.dataset.gen = gen.gen;
    tab.innerHTML = `<span class="pokedex-gen-tab__num">Gen ${gen.gen}</span><span class="pokedex-gen-tab__count">${owned}/${total}</span>`;
    tab.addEventListener('click', () => renderPokedexGen(gen.gen));
    accountPokedexGenTabsEl.appendChild(tab);
  });
  // Onglets Méga : formes Méga classiques puis Méga de Pokémon Légendes Z-A (cf. megas côté serveur).
  POKEDEX_MEGA_TABS.forEach(def => {
    const entries = pokedexMegaEntries(def.key);
    const owned = entries.filter(p => pokedexOwnedMap.has(p.id)).length;
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'pokedex-gen-tab pokedex-gen-tab--mega' + (def.key === currentPokedexGen ? ' pokedex-gen-tab--selected' : '');
    tab.dataset.gen = def.key;
    tab.innerHTML = `<span class="pokedex-gen-tab__num">${def.tab}</span><span class="pokedex-gen-tab__count">${owned}/${entries.length}</span>`;
    tab.addEventListener('click', () => renderPokedexGen(def.key));
    accountPokedexGenTabsEl.appendChild(tab);
  });
  // Onglet Trait-dex : collection des traits (débloqué à la première obtention).
  const traitDefs = nationalDexCache.traits || [];
  const traitsOwned = traitDefs.filter(t => pokedexTraitsOwned[t.name]).length;
  const traitTab = document.createElement('button');
  traitTab.type = 'button';
  traitTab.className = 'pokedex-gen-tab pokedex-gen-tab--mega' + (currentPokedexGen === TRAITDEX_KEY ? ' pokedex-gen-tab--selected' : '');
  traitTab.dataset.gen = TRAITDEX_KEY;
  traitTab.innerHTML = `<span class="pokedex-gen-tab__num">Traits</span><span class="pokedex-gen-tab__count">${traitsOwned}/${traitDefs.length}</span>`;
  traitTab.addEventListener('click', () => renderPokedexGen(TRAITDEX_KEY));
  accountPokedexGenTabsEl.appendChild(traitTab);
}

const TRAITDEX_KEY = 'traits';
const TRAIT_KIND_ICONS = { neutral: '⚪', bonus: '🟢', malus: '🔴', gamble: '🎰' };

// Valeur d'un trait pour la grille (sans son nom) : « ×1.25 », « +150 PTS », « ×0.5 → ×2 ».
function traitValueLabel(def) {
  if (def.kind === 'gamble') return `×${formatMultiplier(GAMBLE_MULTIPLIERS[0])} → ×${formatMultiplier(GAMBLE_MULTIPLIERS[GAMBLE_MULTIPLIERS.length - 1])}`;
  if (def.flat) return `${def.flat > 0 ? '+' : ''}${def.flat} PTS`;
  return `×${formatMultiplier(def.multiplier)}`;
}

function buildTraitCell(def) {
  const owned = pokedexTraitsOwned[def.name];
  const cell = document.createElement('div');
  cell.className = 'pokedex-cell pokedex-cell--trait' + (owned ? ` pokedex-cell--owned pokedex-cell--trait-${def.kind}` : ' pokedex-cell--locked');
  cell.title = owned ? def.name : 'Trait non obtenu';

  const imgWrap = document.createElement('div');
  imgWrap.className = 'pokedex-cell__img';
  const icon = document.createElement('span');
  icon.className = owned ? 'trait-cell__icon' : 'pokedex-cell__mark';
  icon.textContent = owned ? TRAIT_KIND_ICONS[def.kind] || '⚪' : '?';
  imgWrap.appendChild(icon);
  cell.appendChild(imgWrap);

  const name = document.createElement('span');
  name.className = 'pokedex-cell__name';
  name.textContent = owned ? def.name : '???';
  cell.appendChild(name);

  if (owned) {
    const value = document.createElement('span');
    value.className = 'trait-cell__value';
    value.textContent = traitValueLabel(def);
    cell.appendChild(value);
    const count = document.createElement('span');
    count.className = 'trait-cell__count';
    count.textContent = `Obtenu ${owned.count} fois`;
    cell.appendChild(count);
    if (def.kind === 'gamble' && owned.minRoll !== undefined) {
      const rolls = document.createElement('span');
      rolls.className = 'trait-cell__count';
      rolls.textContent = owned.minRoll === owned.maxRoll
        ? `Tiré : ×${formatMultiplier(owned.maxRoll)}`
        : `Pire ×${formatMultiplier(owned.minRoll)} · Meilleur ×${formatMultiplier(owned.maxRoll)}`;
      cell.appendChild(rolls);
    }
  }
  return cell;
}

function renderTraitDex() {
  const defs = nationalDexCache.traits || [];
  const query = accountPokedexSearchEl.value.trim().toLowerCase();
  // La recherche ne porte que sur les traits déjà obtenus (les autres restent « ??? »).
  const filtered = query ? defs.filter(d => pokedexTraitsOwned[d.name] && d.name.toLowerCase().includes(query)) : defs;
  accountPokedexGridEl.innerHTML = '';
  if (!filtered.length) {
    const empty = document.createElement('p');
    empty.className = 'account-history-empty';
    empty.textContent = 'Aucun trait ne correspond.';
    accountPokedexGridEl.appendChild(empty);
  } else {
    filtered.forEach(def => accountPokedexGridEl.appendChild(buildTraitCell(def)));
  }
  const owned = defs.filter(d => pokedexTraitsOwned[d.name]).length;
  accountPokedexCountEl.textContent = `Trait-dex : ${owned}/${defs.length} traits obtenus (équipes finales de tes parties)`;
}

const POKEDEX_MEGA_TABS = [
  { key: 'mega', tab: 'Méga', label: 'Méga-Évolutions', za: false },
  { key: 'mega-za', tab: 'Méga Z-A', label: 'Méga-Évolutions Pokémon Légendes Z-A', za: true }
];

// Entrées d'un onglet Méga ('mega' = formes classiques, 'mega-za' = Z-A), triées par id.
function pokedexMegaEntries(key) {
  const wantZa = key === 'mega-za';
  return (nationalDexCache.megas || []).filter(m => m.za === wantZa);
}

function buildPokedexCell(entry) {
  const owned = pokedexOwnedMap.get(entry.id);
  const cell = document.createElement('div');
  cell.className = 'pokedex-cell' + (owned ? ' pokedex-cell--owned' : ' pokedex-cell--locked');
  cell.title = owned ? entry.name : 'Non obtenu';

  const num = document.createElement('span');
  num.className = 'pokedex-cell__num';
  num.textContent = entry.id >= 10000 ? 'MÉGA' : '#' + String(entry.id).padStart(4, '0');
  cell.appendChild(num);

  const imgWrap = document.createElement('div');
  imgWrap.className = 'pokedex-cell__img';
  if (owned) {
    const img = document.createElement('img');
    img.src = owned.sprite || pokemonSpriteUrl(entry.id);
    img.alt = entry.name;
    img.loading = 'lazy';
    imgWrap.appendChild(img);
    if (owned.shiny) {
      const star = document.createElement('span');
      star.className = 'pokedex-cell__shiny';
      star.textContent = '✨';
      imgWrap.appendChild(star);
    }
  } else {
    const mark = document.createElement('span');
    mark.className = 'pokedex-cell__mark';
    mark.textContent = '?';
    imgWrap.appendChild(mark);
  }
  cell.appendChild(imgWrap);

  if (entry.za) {
    const tag = document.createElement('span');
    tag.className = 'pokedex-cell__za';
    tag.textContent = 'Z-A';
    cell.appendChild(tag);
  }

  const name = document.createElement('span');
  name.className = 'pokedex-cell__name';
  name.textContent = owned ? entry.name : '???';
  cell.appendChild(name);

  return cell;
}

function renderPokedexGen(genNumber) {
  currentPokedexGen = genNumber;
  accountPokedexGenTabsEl.querySelectorAll('.pokedex-gen-tab').forEach(tab => {
    tab.classList.toggle('pokedex-gen-tab--selected', tab.dataset.gen === String(genNumber));
  });
  if (genNumber === TRAITDEX_KEY) {
    renderTraitDex();
    return;
  }
  const megaDef = POKEDEX_MEGA_TABS.find(d => d.key === genNumber);
  const gen = megaDef
    ? { label: megaDef.label }
    : nationalDexCache.generations.find(g => g.gen === genNumber);
  if (!gen) return;

  const query = accountPokedexSearchEl.value.trim().toLowerCase();
  const entries = megaDef
    ? pokedexMegaEntries(megaDef.key)
    : nationalDexCache.dex.filter(p => p.id >= gen.from && p.id <= gen.to);
  const filtered = query ? entries.filter(p => p.name.toLowerCase().includes(query)) : entries;

  accountPokedexGridEl.innerHTML = '';
  if (!filtered.length) {
    const empty = document.createElement('p');
    empty.className = 'account-history-empty';
    empty.textContent = megaDef && !entries.length ? 'Aucune Méga disponible.' : 'Aucun Pokémon ne correspond.';
    accountPokedexGridEl.appendChild(empty);
  } else {
    filtered.forEach(entry => accountPokedexGridEl.appendChild(buildPokedexCell(entry)));
  }

  const genOwned = entries.filter(p => pokedexOwnedMap.has(p.id)).length;
  // Total national = formes du dex national uniquement (les Méga ont leurs propres onglets).
  const nationalOwned = nationalDexCache.dex.filter(p => pokedexOwnedMap.has(p.id)).length;
  accountPokedexCountEl.textContent = `${nationalOwned} / ${nationalDexCache.dex.length} au total — ${gen.label} : ${genOwned}/${entries.length}`;
}

async function fetchAndRenderPokedex(account) {
  accountPokedexGridEl.innerHTML = '';
  accountPokedexCountEl.textContent = 'Chargement...';
  try {
    await loadNationalDexIfNeeded();
    const res = await fetch('/api/profile/pokedex', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accessToken: account.accessToken })
    });
    const data = await res.json();
    if (!res.ok || !data.seen) {
      accountPokedexCountEl.textContent = 'Pokédex indisponible pour le moment.';
      return;
    }
    pokedexSeenCache = data.seen.sort((a, b) => a.id - b.id);
    pokedexOwnedMap = new Map(pokedexSeenCache.map(m => [m.id, m]));
    pokedexTraitsOwned = data.traits || {};
    renderPokedexGenTabs();
    renderPokedexGen(currentPokedexGen);
  } catch (err) {
    accountPokedexCountEl.textContent = 'Pokédex indisponible pour le moment.';
  }
}

accountPokedexSearchEl.addEventListener('input', () => {
  if (nationalDexCache) renderPokedexGen(currentPokedexGen);
});

// ---------- Stats de profil ----------
const STATS_MODE_LABELS = { normal: 'Route du Boss', admin: 'Admin vs Joueur', guess: 'Devine le Pokémon', auction: 'Draft/Enchères' };
const STATS_DIFFICULTY_LABELS = { easy: 'Facile', medium: 'Moyen', hard: 'Difficile', extreme: 'Extrême' };

async function fetchAndRenderProfileStats(account) {
  accountStatsContentEl.innerHTML = '';
  try {
    const res = await fetch('/api/profile/stats', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accessToken: account.accessToken })
    });
    const data = await res.json();
    if (!res.ok) {
      const empty = document.createElement('p');
      empty.className = 'account-history-empty';
      empty.textContent = 'Statistiques indisponibles pour le moment.';
      accountStatsContentEl.appendChild(empty);
      return;
    }

    if (!data.gamesPlayed) {
      const empty = document.createElement('p');
      empty.className = 'account-history-empty';
      empty.textContent = 'Aucune partie terminée pour le moment.';
      accountStatsContentEl.appendChild(empty);
      return;
    }

    // Bloc taux de victoire par mode.
    const winBlock = document.createElement('div');
    winBlock.className = 'account-stats-block';
    const winTitle = document.createElement('p');
    winTitle.className = 'account-achievements-category__title';
    winTitle.textContent = 'Taux de victoire par mode';
    winBlock.appendChild(winTitle);
    Object.entries(data.winRateByMode || {}).forEach(([mode, stat]) => {
      const row = document.createElement('div');
      row.className = 'account-stats-row';
      const label = document.createElement('span');
      label.textContent = STATS_MODE_LABELS[mode] || mode;
      const value = document.createElement('span');
      const pct = stat.total > 0 ? Math.round((stat.wins / stat.total) * 100) : 0;
      value.textContent = `${stat.wins}/${stat.total} (${pct}%)`;
      row.appendChild(label);
      row.appendChild(value);
      winBlock.appendChild(row);
    });
    accountStatsContentEl.appendChild(winBlock);

    // Bloc meilleur score par difficulté.
    if (Object.keys(data.bestScoreByDifficulty || {}).length > 0) {
      const scoreBlock = document.createElement('div');
      scoreBlock.className = 'account-stats-block';
      const scoreTitle = document.createElement('p');
      scoreTitle.className = 'account-achievements-category__title';
      scoreTitle.textContent = 'Meilleur score par difficulté';
      scoreBlock.appendChild(scoreTitle);
      Object.entries(data.bestScoreByDifficulty).forEach(([difficulty, best]) => {
        const row = document.createElement('div');
        row.className = 'account-stats-row';
        const label = document.createElement('span');
        label.textContent = STATS_DIFFICULTY_LABELS[difficulty] || difficulty;
        const value = document.createElement('span');
        value.textContent = `${best} pts`;
        row.appendChild(label);
        row.appendChild(value);
        scoreBlock.appendChild(row);
      });
      accountStatsContentEl.appendChild(scoreBlock);
    }

    // Bloc Pokémon les plus tirés.
    if ((data.topPokemon || []).length > 0) {
      const topBlock = document.createElement('div');
      topBlock.className = 'account-stats-block';
      const topTitle = document.createElement('p');
      topTitle.className = 'account-achievements-category__title';
      topTitle.textContent = 'Pokémon les plus tirés';
      topBlock.appendChild(topTitle);
      const topGrid = document.createElement('div');
      topGrid.className = 'account-pokedex-grid';
      data.topPokemon.forEach(mon => {
        const cell = document.createElement('div');
        cell.className = 'account-pokedex-cell';
        cell.title = mon.name;
        const img = document.createElement('img');
        img.src = mon.sprite;
        img.alt = mon.name;
        img.loading = 'lazy';
        cell.appendChild(img);
        const name = document.createElement('span');
        name.className = 'account-pokedex-cell__name';
        name.textContent = `${mon.name} ×${mon.count}`;
        cell.appendChild(name);
        topGrid.appendChild(cell);
      });
      topBlock.appendChild(topGrid);
      accountStatsContentEl.appendChild(topBlock);
    }
  } catch (err) {
    const empty = document.createElement('p');
    empty.className = 'account-history-empty';
    empty.textContent = 'Statistiques indisponibles pour le moment.';
    accountStatsContentEl.appendChild(empty);
  }
}

// ---------- Amis ----------
function buildFriendRow(entry, actions) {
  const row = document.createElement('div');
  row.className = 'friend-row';

  const avatar = document.createElement('img');
  avatar.className = 'friend-row__avatar';
  avatar.src = entry.avatar ? avatarUrl(entry.avatar) : '';
  avatar.alt = '';
  if (entry.frame) applyAvatarFrame(avatar, entry.frame);
  row.appendChild(avatar);

  const info = document.createElement('div');
  info.className = 'friend-row__info';
  const name = document.createElement('span');
  name.textContent = entry.pseudo;
  info.appendChild(name);
  if (entry.titleLabel) {
    const title = document.createElement('span');
    title.className = 'friend-row__title';
    title.textContent = entry.titleLabel;
    info.appendChild(title);
  }
  if (entry.online !== undefined) {
    const status = document.createElement('span');
    status.className = 'friend-row__status' + (entry.online ? ' friend-row__status--online' : '');
    status.textContent = entry.online ? 'En ligne' : 'Hors ligne';
    info.appendChild(status);
  }
  row.appendChild(info);

  const actionsWrap = document.createElement('div');
  actionsWrap.className = 'friend-row__actions';
  actions.forEach(({ label, className, onClick }) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = className || 'btn btn--ghost';
    btn.textContent = label;
    btn.addEventListener('click', onClick);
    actionsWrap.appendChild(btn);
  });
  row.appendChild(actionsWrap);
  return row;
}

async function fetchAndRenderFriends(account) {
  friendsListEl.innerHTML = '';
  friendsIncomingListEl.innerHTML = '';
  friendsOutgoingListEl.innerHTML = '';
  try {
    const res = await fetch('/api/friends/list', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accessToken: account.accessToken })
    });
    const data = await res.json();
    if (!res.ok) return;

    friendsIncomingBlockEl.classList.toggle('screen--hidden', !(data.incoming || []).length);
    (data.incoming || []).forEach(entry => {
      friendsIncomingListEl.appendChild(buildFriendRow(entry, [
        { label: 'Accepter', className: 'btn btn--haut', onClick: () => respondFriendRequest(account, entry.id, true) },
        { label: 'Refuser', className: 'btn btn--ghost', onClick: () => respondFriendRequest(account, entry.id, false) }
      ]));
    });

    friendsOutgoingBlockEl.classList.toggle('screen--hidden', !(data.outgoing || []).length);
    (data.outgoing || []).forEach(entry => {
      friendsOutgoingListEl.appendChild(buildFriendRow(entry, [
        { label: 'Annuler', className: 'btn btn--ghost', onClick: () => removeFriend(account, entry.id) }
      ]));
    });

    if ((data.friends || []).length === 0) {
      const empty = document.createElement('p');
      empty.className = 'account-history-empty';
      empty.textContent = 'Aucun ami pour le moment.';
      friendsListEl.appendChild(empty);
    } else {
      data.friends.forEach(entry => {
        friendsListEl.appendChild(buildFriendRow(entry, [
          { label: 'Retirer', className: 'btn btn--ghost', onClick: () => removeFriend(account, entry.id) }
        ]));
      });
    }
  } catch (err) {
    const empty = document.createElement('p');
    empty.className = 'account-history-empty';
    empty.textContent = 'Liste d\'amis indisponible pour le moment.';
    friendsListEl.appendChild(empty);
  }
}

async function respondFriendRequest(account, requesterId, accept) {
  await fetch('/api/friends/respond', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accessToken: account.accessToken, requesterId, accept })
  });
  fetchAndRenderFriends(account);
}

async function removeFriend(account, friendId) {
  await fetch('/api/friends/remove', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accessToken: account.accessToken, friendId })
  });
  fetchAndRenderFriends(account);
}

const FRIEND_RELATION_LABEL = { pending_sent: 'Demande envoyée', pending_received: 'Demande reçue', friend: 'Déjà ami' };

let friendsSearchDebounce = null;
friendsSearchInputEl.addEventListener('input', () => {
  clearTimeout(friendsSearchDebounce);
  const query = friendsSearchInputEl.value.trim();
  friendsSearchDebounce = setTimeout(async () => {
    const account = getStoredAccount();
    friendsSearchResultsEl.innerHTML = '';
    if (!account || query.length < 2) return;
    try {
      const res = await fetch('/api/friends/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accessToken: account.accessToken, query })
      });
      const data = await res.json();
      if (!res.ok || !data.results) return;
      data.results.forEach(entry => {
        const actions = entry.relation === 'none'
          ? [{ label: 'Ajouter', className: 'btn btn--haut', onClick: async () => {
              await fetch('/api/friends/request', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ accessToken: account.accessToken, targetId: entry.id })
              });
              friendsSearchInputEl.dispatchEvent(new Event('input'));
              fetchAndRenderFriends(account);
            } }]
          : [{ label: FRIEND_RELATION_LABEL[entry.relation] || '', className: 'btn btn--ghost', onClick: () => {} }];
        if (entry.relation !== 'none') actions[0].onClick = () => {}; // statut informatif seulement
        friendsSearchResultsEl.appendChild(buildFriendRow(entry, actions));
      });
    } catch (err) {
      // recherche silencieusement indisponible (hors-ligne...) — pas bloquant
    }
  }, 350);
});

// Toast flottant (cf. #achievement-toast-container dans index.html), un par succès
// débloqué, empilables si plusieurs arrivent d'un coup (ex: fin de partie qui déclenche
// 2 succès à la fois). Se retire lui-même du DOM après son animation de sortie — jamais
// laissé en résidu invisible dans le conteneur.
function showAchievementToast(achievement) {
  const toast = document.createElement('div');
  toast.className = 'achievement-toast';

  const icon = document.createElement('span');
  icon.className = 'achievement-toast__icon';
  icon.textContent = ACHIEVEMENT_ICONS[achievement.key] || '🏆';

  const body = document.createElement('div');
  const eyebrow = document.createElement('p');
  eyebrow.className = 'achievement-toast__eyebrow';
  eyebrow.textContent = 'Succès débloqué';
  const label = document.createElement('p');
  label.className = 'achievement-toast__label';
  label.textContent = achievement.label;
  const description = document.createElement('p');
  description.className = 'achievement-toast__description';
  description.textContent = achievement.description;
  body.appendChild(eyebrow);
  body.appendChild(label);
  body.appendChild(description);
  if (achievement.title) {
    const titleLine = document.createElement('p');
    titleLine.className = 'achievement-toast__description';
    titleLine.textContent = `Titre débloqué : ${achievement.title}`;
    body.appendChild(titleLine);
  }

  toast.appendChild(icon);
  toast.appendChild(body);
  achievementToastContainerEl.appendChild(toast);

  setTimeout(() => toast.remove(), 5000); // couvre large la durée totale de l'animation CSS (4.5s + 0.25s)
}

// ---------- Classement global ----------
// Public : fonctionne même sans compte connecté (accessToken omis dans ce cas — le
// serveur renvoie juste isSelf: false partout). Chargé à la demande, seulement au premier
// clic sur l'onglet Classement des Réglages, jamais en arrière-plan.
let leaderboardLoaded = false;
async function fetchAndRenderLeaderboard() {
  if (leaderboardLoaded) return;
  leaderboardLoaded = true;
  leaderboardListEl.innerHTML = '';
  try {
    const account = getStoredAccount();
    const res = await fetch('/api/leaderboard', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accessToken: account ? account.accessToken : null })
    });
    const data = await res.json();
    if (!res.ok || !data.leaderboard || !data.leaderboard.length) {
      const empty = document.createElement('p');
      empty.className = 'leaderboard-empty';
      empty.textContent = 'Aucun compte classé pour le moment.';
      leaderboardListEl.appendChild(empty);
      leaderboardLoaded = false; // rien de valable affiché : retenter au prochain clic
      return;
    }
    data.leaderboard.forEach((entry, index) => {
      const rank = index + 1;
      const li = document.createElement('li');
      li.className = 'leaderboard-item' + (entry.isSelf ? ' leaderboard-item--self' : '') + (rank <= 3 ? ' leaderboard-item--top3' : '');

      const rankEl = document.createElement('span');
      rankEl.className = 'leaderboard-item__rank';
      rankEl.textContent = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : String(rank);

      const avatar = document.createElement('img');
      avatar.className = 'leaderboard-item__avatar';
      avatar.src = entry.avatar ? avatarUrl(entry.avatar) : '';
      avatar.alt = '';

      const pseudo = document.createElement('span');
      pseudo.className = 'leaderboard-item__pseudo';
      pseudo.textContent = entry.pseudo;
      if (entry.titleLabel) {
        const titleEl = document.createElement('small');
        titleEl.className = 'leaderboard-item__title';
        titleEl.textContent = entry.titleLabel;
        pseudo.appendChild(titleEl);
      }

      const level = document.createElement('span');
      level.className = 'leaderboard-item__level';
      level.textContent = `Niv. ${entry.level}`;

      const xp = document.createElement('span');
      xp.className = 'leaderboard-item__xp';
      xp.textContent = `${entry.xp} XP`;

      li.appendChild(rankEl);
      li.appendChild(avatar);
      li.appendChild(pseudo);
      li.appendChild(level);
      li.appendChild(xp);
      leaderboardListEl.appendChild(li);
    });
  } catch (err) {
    const empty = document.createElement('p');
    empty.className = 'leaderboard-empty';
    empty.textContent = 'Classement indisponible pour le moment.';
    leaderboardListEl.appendChild(empty);
    leaderboardLoaded = false;
  }
}

// Sprites de dresseurs hébergés par Pokémon Showdown, réutilisés tels quels comme
// avatars de compte (même principe que spriteUrl() pour les Pokémon : pointer vers des
// assets déjà hébergés ailleurs plutôt que d'en héberger nous-mêmes).
function avatarUrl(name) {
  return `https://play.pokemonshowdown.com/sprites/trainers/${name}.png`;
}

let cachedAvatarList = null;
async function fetchAvatarList() {
  if (cachedAvatarList) return cachedAvatarList;
  try {
    const res = await fetch('/api/avatars');
    cachedAvatarList = await res.json();
  } catch (err) {
    cachedAvatarList = [];
  }
  return cachedAvatarList;
}

// Compte connecté (ou null) : { accessToken, refreshToken, pseudo, avatar }.
function getStoredAccount() {
  try {
    return JSON.parse(localStorage.getItem('rdb_account'));
  } catch (err) {
    return null;
  }
}
function setStoredAccount(account) {
  if (account) localStorage.setItem('rdb_account', JSON.stringify(account));
  else localStorage.removeItem('rdb_account');
}

// Signale au serveur qu'un compte est en ligne (cf. onlineAccounts côté serveur), pour
// que ses amis puissent l'inviter directement. Sans effet si pas de compte stocké — ne
// bloque jamais rien, juste invisible pour les amis dans ce cas.
function identifyAccountIfLoggedIn() {
  const account = getStoredAccount();
  if (account) socket.emit('identify_account', { accessToken: account.accessToken });
}

function applyAccountUI(account) {
  if (account) {
    accountStatusGuestEl.classList.add('screen--hidden');
    accountStatusLoggedEl.classList.remove('screen--hidden');
    accountStatusPseudoEl.textContent = account.pseudo;
    accountStatusAvatarEl.src = account.avatar ? avatarUrl(account.avatar) : '';
    accountStatusAvatarEl.classList.toggle('screen--hidden', !account.avatar);
    // Toujours synchroniser (pas seulement si le champ est vide) : se connecter à un
    // compte doit systématiquement remplacer le pseudo affiché par celui du compte,
    // même si un autre pseudo traînait dans le champ (mode invité précédent, etc.).
    pseudoInput.value = account.pseudo;
    identifyAccountIfLoggedIn();
    lobbyFriendsBarEl.classList.remove('screen--hidden');
  } else {
    accountStatusGuestEl.classList.remove('screen--hidden');
    accountStatusLoggedEl.classList.add('screen--hidden');
    lobbyFriendsBarEl.classList.add('screen--hidden');
  }
}
applyAccountUI(getStoredAccount());

// Recharge le compte depuis le serveur (pseudo/avatar/xp/niveau à jour) à partir du
// refreshToken stocké — utilisée au chargement de page ET après chaque fin de partie
// (cf. les 3 handlers game_finished/guess_game_over/auction_game_over plus bas) pour que
// l'XP gagnée pendant la partie qui vient de se terminer soit reflétée sans recharger la
// page. Silencieuse en cas d'échec (mode invité, hors-ligne...) : ce n'est jamais
// bloquant pour le joueur.
async function refreshAccountFromServer() {
  const stored = getStoredAccount();
  if (!stored || !stored.refreshToken) return;
  try {
    const res = await fetch('/api/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: stored.refreshToken })
    });
    const data = await res.json();
    if (!res.ok) {
      setStoredAccount(null);
      applyAccountUI(null);
      return;
    }
    const account = { accessToken: data.accessToken, refreshToken: data.refreshToken, pseudo: data.pseudo, avatar: data.avatar, frame: data.frame || '', title: data.title || '', titleLabel: data.titleLabel || '', xp: data.xp, level: data.level };
    setStoredAccount(account);
    applyAccountUI(account);
  } catch (err) {
    // Hors-ligne ou serveur injoignable : on ne touche à rien, la session stockée reste
    // telle quelle pour une prochaine tentative.
  }
}
refreshAccountFromServer();

// Peuple la grille de choix d'avatar (une seule fois par ouverture) et surligne celui
// actuellement utilisé par le compte connecté.
// Filtre la liste selon la recherche (sous-chaîne, insensible à la casse) — sans elle,
// impossible de retrouver un personnage précis parmi les 325 avatars rien qu'en
// scrollant. "" (recherche vide) = tout afficher.
async function populateAvatarGrid(account, filterText) {
  const list = await fetchAvatarList();
  const term = (filterText || '').trim().toLowerCase();
  const filtered = term ? list.filter(name => name.toLowerCase().includes(term)) : list;
  accountAvatarGridEl.innerHTML = '';
  filtered.forEach(name => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'account-avatar-choice' + (name === account.avatar ? ' account-avatar-choice--selected' : '');
    const img = document.createElement('img');
    img.src = avatarUrl(name);
    img.alt = name;
    btn.appendChild(img);
    btn.addEventListener('click', async () => {
      accountErrorEl.textContent = '';
      try {
        const res = await fetch('/api/profile/avatar', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ accessToken: account.accessToken, avatar: name })
        });
        const data = await res.json();
        if (!res.ok) {
          accountErrorEl.textContent = data.error || "L'avatar n'a pas pu être changé.";
          return;
        }
        const updated = Object.assign({}, account, { avatar: data.avatar });
        setStoredAccount(updated);
        applyAccountUI(updated);
        accountAvatarCurrentEl.src = avatarUrl(data.avatar);
        Array.from(accountAvatarGridEl.children).forEach(c => c.classList.remove('account-avatar-choice--selected'));
        btn.classList.add('account-avatar-choice--selected');
      } catch (err) {
        accountErrorEl.textContent = 'Connexion au serveur impossible.';
      }
    });
    accountAvatarGridEl.appendChild(btn);
  });
}

// Décide quoi montrer dans la section Compte des Réglages (tabs+formulaires si invité,
// panneau avatar si connecté) — appelée à CHAQUE ouverture des Réglages, quelle que soit
// la façon dont ils ont été ouverts (icône ⚙ ou lien du statut d'accueil), cf.
// openSettings plus bas dans ce fichier.
function refreshAccountSettingsSection() {
  accountErrorEl.textContent = '';
  const account = getStoredAccount();
  const loggedIn = !!account;

  accountTabsContainerEl.classList.toggle('screen--hidden', loggedIn);
  accountLoggedPanelEl.classList.toggle('screen--hidden', !loggedIn);
  refreshCosmeticLocks();

  if (loggedIn) {
    accountFormLoginEl.classList.add('screen--hidden');
    accountFormRegisterEl.classList.add('screen--hidden');
    accountLoggedPseudoEl.textContent = account.pseudo;
    renderAccountTitleLine(account);
    accountAvatarCurrentEl.src = account.avatar ? avatarUrl(account.avatar) : '';
    applyAvatarFrame(accountAvatarCurrentEl, account.frame);
    renderAccountLevel(account);
    fetchAndRenderAccountHistory(account);
    fetchAndRenderAccountAchievements(account);
    fetchAndRenderPokedex(account);
    fetchAndRenderProfileStats(account);
    fetchAndRenderFriends(account);
    accountAvatarSearchEl.value = '';
    populateAvatarGrid(account, '');
  } else {
    // Réaffiche toujours l'onglet Connexion par défaut à l'ouverture (état simple et
    // prévisible plutôt que de retenir le dernier onglet visité).
    accountTabButtons.forEach(b => b.classList.toggle('admin-role-btn--selected', b.dataset.accountTab === 'login'));
    accountFormLoginEl.classList.remove('screen--hidden');
    accountFormRegisterEl.classList.add('screen--hidden');
  }
}

btnAccountOpen.addEventListener('click', openSettings);
btnAccountOpenLogged.addEventListener('click', openSettings);

btnAccountLogoutModal.addEventListener('click', () => {
  setStoredAccount(null);
  applyAccountUI(null);
  refreshAccountSettingsSection();
});

accountAvatarSearchEl.addEventListener('input', () => {
  const account = getStoredAccount();
  if (account) populateAvatarGrid(account, accountAvatarSearchEl.value);
});

accountTabButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    accountTabButtons.forEach(b => b.classList.toggle('admin-role-btn--selected', b === btn));
    const isLogin = btn.dataset.accountTab === 'login';
    accountFormLoginEl.classList.toggle('screen--hidden', !isLogin);
    accountFormRegisterEl.classList.toggle('screen--hidden', isLogin);
    accountErrorEl.textContent = '';
  });
});

// Onglets DU HAUT des Réglages (Compte / Préférences / Infos) — une seule page visible à
// la fois, cf. .settings-page/.settings-tab dans index.html. Même mécanique simple que
// les sous-onglets ci-dessous : toggle la classe "sélectionné" + screen--hidden en phase.
settingsTabButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    const page = btn.dataset.settingsPage;
    settingsTabButtons.forEach(b => {
      const selected = b === btn;
      b.classList.toggle('settings-tab--selected', selected);
      b.setAttribute('aria-selected', String(selected));
    });
    settingsPageEls.forEach(p => p.classList.toggle('screen--hidden', p.dataset.settingsPage !== page));
    if (page === 'leaderboard') fetchAndRenderLeaderboard();
  });
});

// Sous-onglets DE LA PAGE COMPTE connectée (Historique / Succès / Avatar).
accountSubtabButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    const page = btn.dataset.accountSubpage;
    accountSubtabButtons.forEach(b => {
      const selected = b === btn;
      b.classList.toggle('settings-subtab--selected', selected);
      b.setAttribute('aria-selected', String(selected));
    });
    accountSubpageEls.forEach(p => p.classList.toggle('screen--hidden', p.dataset.accountSubpage !== page));
  });
});

// Remet toujours les Réglages sur l'onglet Compte / sous-onglet Historique à l'ouverture
// (état simple et prévisible plutôt que de retenir le dernier onglet visité — même
// principe que le retour systématique sur "Connexion", juste au-dessus).
function resetSettingsTabs() {
  settingsTabButtons.forEach(b => {
    const selected = b.dataset.settingsPage === 'account';
    b.classList.toggle('settings-tab--selected', selected);
    b.setAttribute('aria-selected', String(selected));
  });
  settingsPageEls.forEach(p => p.classList.toggle('screen--hidden', p.dataset.settingsPage !== 'account'));
  accountSubtabButtons.forEach(b => {
    const selected = b.dataset.accountSubpage === 'history';
    b.classList.toggle('settings-subtab--selected', selected);
    b.setAttribute('aria-selected', String(selected));
  });
  accountSubpageEls.forEach(p => p.classList.toggle('screen--hidden', p.dataset.accountSubpage !== 'history'));
}

btnAccountLogin.addEventListener('click', async () => {
  const email = accountLoginEmailEl.value.trim();
  const password = accountLoginPasswordEl.value;
  if (!email || !password) {
    accountErrorEl.textContent = 'Email et mot de passe requis.';
    return;
  }
  btnAccountLogin.disabled = true;
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    const data = await res.json();
    if (!res.ok) {
      accountErrorEl.textContent = data.error || 'Connexion impossible.';
      return;
    }
    const account = { accessToken: data.accessToken, refreshToken: data.refreshToken, pseudo: data.pseudo, avatar: data.avatar, frame: data.frame || '', title: data.title || '', titleLabel: data.titleLabel || '', xp: data.xp, level: data.level };
    setStoredAccount(account);
    applyAccountUI(account);
    refreshAccountSettingsSection();
  } catch (err) {
    accountErrorEl.textContent = 'Connexion au serveur impossible.';
  } finally {
    btnAccountLogin.disabled = false;
  }
});

btnAccountRegister.addEventListener('click', async () => {
  const pseudo = accountRegisterPseudoEl.value.trim();
  const email = accountRegisterEmailEl.value.trim();
  const password = accountRegisterPasswordEl.value;
  if (!pseudo || !email || !password) {
    accountErrorEl.textContent = 'Pseudo, email et mot de passe requis.';
    return;
  }
  btnAccountRegister.disabled = true;
  try {
    const res = await fetch('/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, pseudo })
    });
    const data = await res.json();
    if (!res.ok) {
      accountErrorEl.textContent = data.error || 'Inscription impossible.';
      return;
    }
    if (data.needsEmailConfirmation) {
      accountErrorEl.textContent = 'Compte créé : vérifie tes emails avant de te connecter.';
      return;
    }
    const account = { accessToken: data.accessToken, refreshToken: data.refreshToken, pseudo: data.pseudo, avatar: data.avatar, frame: data.frame || '', title: data.title || '', titleLabel: data.titleLabel || '', xp: data.xp, level: data.level };
    setStoredAccount(account);
    applyAccountUI(account);
    refreshAccountSettingsSection();
  } catch (err) {
    accountErrorEl.textContent = 'Connexion au serveur impossible.';
  } finally {
    btnAccountRegister.disabled = false;
  }
});

// ---------- Lien d'invitation (?code=XXXXXX) ----------
// Pré-remplit le code si on arrive via un lien partagé (ex: sur Discord), au lieu de
// forcer un copier-coller manuel du code par l'hôte puis une saisie manuelle par
// l'invité. Ignoré si une reconnexion automatique est déjà en cours : pendingRejoinGameId
// (donc la partie en cours du visiteur) prend toujours la priorité sur un lien externe.
const urlParams = new URLSearchParams(location.search);
const inviteCode = urlParams.get('code');
if (inviteCode && !pendingRejoinGameId) {
  codeInput.value = inviteCode.toUpperCase().slice(0, 6);
  pseudoInput.focus();
}
if (urlParams.has('code')) {
  // Nettoie l'URL après lecture : évite qu'un refresh ou un partage du lien de la barre
  // d'adresse ne re-remplisse le champ avec un code de partie potentiellement expirée.
  urlParams.delete('code');
  const cleanQuery = urlParams.toString();
  history.replaceState(null, '', location.pathname + (cleanQuery ? `?${cleanQuery}` : ''));
}

// ---------- Lobby ----------
const gameCodeEl = document.getElementById('game-code');
const playersListEl = document.getElementById('players-list');
const playersCountEl = document.getElementById('players-count');
const btnStart = document.getElementById('btn-start');
const btnLeave = document.getElementById('btn-leave');
const lobbyStatusEl = document.getElementById('lobby-status');
const btnCopyCode = document.getElementById('btn-copy-code');
const btnCopyLink = document.getElementById('btn-copy-link');
const copyFeedbackEl = document.getElementById('copy-feedback');
const difficultyButtons = Array.from(document.querySelectorAll('.difficulty-btn'));
const gamemodeButtons = Array.from(document.querySelectorAll('.gamemode-btn'));
const modifiersPanelEl = document.getElementById('modifiers-panel');
const modifiersOptionsEl = document.getElementById('modifiers-options');
const modifiersActiveListEl = document.getElementById('modifiers-active-list');
const modifiersNoteEl = document.getElementById('modifiers-note');
const gameModifiersEl = document.getElementById('game-modifiers');
const finishedModifiersEl = document.getElementById('finished-modifiers');
const finishedModifiersNoteEl = document.getElementById('finished-modifiers-note');
const gamemodeHintEl = document.getElementById('gamemode-hint');
const teamScoreLineEl = document.getElementById('team-score-line');
const bossAttackBannerEl = document.getElementById('boss-attack-banner');
const resultBossAttackEl = document.getElementById('result-boss-attack');
const resultTypeBonusEl = document.getElementById('result-type-bonus');
const resultTypesEl = document.getElementById('result-types');
const bossTypesEl = document.getElementById('boss-types');
const bossWeakEl = document.getElementById('boss-weak');
const typeBonusPanelEl = document.getElementById('type-bonus-panel');
const finishedBossTypesEl = document.getElementById('finished-boss-types');
const finishedTypeBonusEl = document.getElementById('finished-type-bonus');
const finishedTeamStatEl = document.getElementById('finished-team-stat');
const finishedTeamScoreEl = document.getElementById('finished-team-score');
const adminRolePanelEl = document.getElementById('admin-role-panel');
const adminRoleOptionsEl = document.getElementById('admin-role-options');
const adminRoleStatusEl = document.getElementById('admin-role-status');
const activePlayersPanelEl = document.getElementById('active-players-panel');
const activePlayersOptionsEl = document.getElementById('active-players-options');
const activePlayersStatusEl = document.getElementById('active-players-status');
const guessDurationPanelEl = document.getElementById('guess-duration-panel');
const guessDurationButtons = Array.from(document.querySelectorAll('#guess-duration-options .admin-role-btn'));
const auctionTypePanelEl = document.getElementById('auction-type-panel');
const auctionTypeButtons = Array.from(document.querySelectorAll('#auction-type-options .admin-role-btn'));
const auctionTypeStatusEl = document.getElementById('auction-type-status');

// ---------- Jeu ----------
const bossPanelEl = document.getElementById('boss-panel');
const bossSpriteEl = document.getElementById('boss-sprite');
const bossNameEl = document.getElementById('boss-name');
const bossTargetValueEl = document.getElementById('boss-target-value');
const myScoreValueEl = document.getElementById('my-score-value');
const myScoreLabelEl = document.getElementById('my-score-label');
const myScorePopupEl = document.getElementById('my-score-popup');
const routeTrackEl = document.getElementById('route-track');
const turnCurrentEl = document.getElementById('turn-current');
const turnMaxEl = document.getElementById('turn-max');
const turnStatusEl = document.getElementById('turn-status');
const btnHaut = document.getElementById('btn-haut');
const btnBas = document.getElementById('btn-bas');
const choiceHautSpriteEl = document.getElementById('choice-haut-sprite');
const choiceHautNameEl = document.getElementById('choice-haut-name');
const choiceBasSpriteEl = document.getElementById('choice-bas-sprite');
const choiceBasNameEl = document.getElementById('choice-bas-name');

// ---------- Mode ADMIN VS JOUEUR ----------
const adminViewPanelEl = document.getElementById('admin-view-panel');
const adminViewPlayerNameEl = document.getElementById('admin-view-player-name');
const adminViewPlayerScoreEl = document.getElementById('admin-view-player-score');
const adminViewHautSpriteEl = document.getElementById('admin-view-haut-sprite');
const adminViewHautNameEl = document.getElementById('admin-view-haut-name');
const adminViewHautRarityEl = document.getElementById('admin-view-haut-rarity');
const adminViewHautPointsEl = document.getElementById('admin-view-haut-points');
const adminViewHautEffectEl = document.getElementById('admin-view-haut-effect');
const adminViewBasSpriteEl = document.getElementById('admin-view-bas-sprite');
const adminViewBasNameEl = document.getElementById('admin-view-bas-name');
const adminViewBasRarityEl = document.getElementById('admin-view-bas-rarity');
const adminViewBasPointsEl = document.getElementById('admin-view-bas-points');
const adminViewBasEffectEl = document.getElementById('admin-view-bas-effect');
const resultPanelEl = document.getElementById('result-panel');
const resultRarityEl = document.getElementById('result-rarity');
const resultSpriteEl = document.getElementById('result-sprite');
const resultNameEl = document.getElementById('result-name');
const resultBaseEl = document.getElementById('result-base');
const resultEffectEl = document.getElementById('result-effect');
const resultPointsEl = document.getElementById('result-points');
const teamSlotsEl = document.getElementById('team-slots');
const metamorphResultPanelEl = document.getElementById('metamorph-result-panel');
const metamorphResultSpriteEl = document.getElementById('metamorph-result-sprite');
const metamorphResultDetailEl = document.getElementById('metamorph-result-detail');
const metamorphResultFinalEl = document.getElementById('metamorph-result-final');
let metamorphResultTimer = null;
const gamePlayersListEl = document.getElementById('game-players-list');
const gameMatchupMeAvatarEl = document.getElementById('game-matchup-me-avatar');
const gameMatchupMeNameEl = document.getElementById('game-matchup-me-name');
const gameMatchupOppAvatarEl = document.getElementById('game-matchup-opp-avatar');
const gameMatchupOppNameEl = document.getElementById('game-matchup-opp-name');

// Bandeau "Toi VS Adversaire" en haut de l'écran de jeu actif (normal/admin et guess) —
// avatars bien plus grands/visibles que dans la simple liste de joueurs en dessous,
// dans l'esprit de ce que fait Pokémon Showdown en combat. players : payload standard
// (cf. getPublicPlayers côté serveur). Fonctionne avec >2 joueurs (prend juste le
// premier "pas moi" comme adversaire affiché) même si pensé pour du 1 contre 1.
function renderMatchupBanner(refs, players) {
  const me = (players || []).find(p => p.id === myId);
  const opp = (players || []).find(p => p.id !== myId);
  if (me) {
    refs.meAvatar.src = me.avatar ? avatarUrl(me.avatar) : '';
    refs.meAvatar.classList.toggle('screen--hidden', !me.avatar);
    refs.meName.textContent = 'Toi';
  }
  if (opp) {
    refs.oppAvatar.src = opp.avatar ? avatarUrl(opp.avatar) : '';
    refs.oppAvatar.classList.toggle('screen--hidden', !opp.avatar);
    refs.oppName.textContent = opp.name + (opp.disconnected ? ' (déconnecté)' : '');
  }
}
const gameMatchupRefs = {
  meAvatar: gameMatchupMeAvatarEl, meName: gameMatchupMeNameEl,
  oppAvatar: gameMatchupOppAvatarEl, oppName: gameMatchupOppNameEl
};
const btnLeaveGame = document.getElementById('btn-leave-game');

// ---------- Tour 4 spécial : avantage / bonus ----------
const choiceCardsEl = document.getElementById('choice-cards');
const bonusTargetOverlayEl = document.getElementById('bonus-target-overlay');
const btnBonusTargetCancel = document.getElementById('btn-bonus-target-cancel');
const itemSelectOverlayEl = document.getElementById('item-select-overlay');
// 3 cartes de choix d'objet de départ : { bouton, icône, nom, description } par carte.
const startItemCards = ['a', 'b', 'c'].map(k => ({
  btn: document.getElementById(`start-item-card-${k}`),
  icon: document.getElementById(`start-item-card-${k}-icon`),
  label: document.getElementById(`start-item-card-${k}-label`),
  desc: document.getElementById(`start-item-card-${k}-desc`)
}));
const itemSelectStatusEl = document.getElementById('item-select-status');
const itemInventoryBarEl = document.getElementById('item-inventory-bar');
const btnUseItem = document.getElementById('btn-use-item');
const itemInventoryIconEl = document.getElementById('item-inventory-icon');
const itemInventoryLabelEl = document.getElementById('item-inventory-label');
const ITEM_ICONS = { xpCandy: '🍬', mysteryItem: '❓', shinyCharm: '✨', megaGem: '💎', patchNote: '📝', reroll: '🎲' };
const bonusTargetTitleEl = document.getElementById('bonus-target-title');
const bonusTargetListEl = document.getElementById('bonus-target-list');
const bonusResultPanelEl = document.getElementById('bonus-result-panel');
const bonusResultTitleEl = document.getElementById('bonus-result-title');
const bonusResultSpriteEl = document.getElementById('bonus-result-sprite');
const bonusResultDetailEl = document.getElementById('bonus-result-detail');
const bonusResultFinalEl = document.getElementById('bonus-result-final');
const btnSkip = document.getElementById('btn-skip');

// ---------- Fin de partie ----------
const finishedOutcomeEl = document.getElementById('finished-outcome');
const finishedBossSpriteEl = document.getElementById('finished-boss-sprite');
const finishedBossNameEl = document.getElementById('finished-boss-name');
const finishedMyScoreEl = document.getElementById('finished-my-score');
const finishedMyScoreLabelEl = document.getElementById('finished-my-score-label');
const finishedTargetEl = document.getElementById('finished-target');
const finishedMyTeamEl = document.getElementById('finished-my-team');
const finishedMyTeamLabelEl = document.getElementById('finished-my-team-label');
const finishedResultsEl = document.getElementById('finished-results');
const btnReplay = document.getElementById('btn-replay');
const finishedStatusEl = document.getElementById('finished-status');
const btnLeaveFinished = document.getElementById('btn-leave-finished');
const finishedDifficultyEl = document.getElementById('finished-difficulty');

// ---------- Événements rares ----------
const eventOverlayEl = document.getElementById('event-overlay');
const eventModalEl = document.getElementById('event-modal');
const eventTitleEl = document.getElementById('event-title');
const eventBodyEl = document.getElementById('event-body');

// ---------- État local ----------
let myId = null;
let hostId = null;
let bossTarget = 2500;
let coopTeamRequired = null; // mode Coop uniquement : boss.teamRequiredPoints de la partie en cours
let hasChosenThisTurn = false;
let lastTeamSize = 0;
let lastRenderedTurn = 0;
let currentDifficulty = 'medium'; // reflet local de la difficulté choisie par l'hôte (le serveur reste source de vérité)
let currentGameMode = 'normal'; // 'normal' | 'admin' — reflet local, serveur = source de vérité
let currentAdminId = null; // id du joueur ADMIN choisi par l'hôte (mode "admin" uniquement)
let currentActivePlayerIds = []; // [id, id] : qui joue réellement en mode admin/guess à >2 joueurs (cf. set_active_players) ; toujours vide/non pertinent à 2 joueurs pile
let lastLobbyPlayers = []; // dernière liste de joueurs du lobby, réutilisée pour re-render le picker ADMIN
let isSpectating = false; // true entre spectate_joined et un retour à l'accueil/spectate_ended
let spectateBoss = null; // boss caché en local (jamais renvoyé par game_updated, seulement par spectate_joined/game_started)
let spectateGameMode = null; // idem : certains broadcasts (game_updated) ne portent pas gameMode, on retombe sur ce cache
let spectateGuessPlayers = []; // idem : guess_turn_started n'inclut pas `players`, on garde le dernier reçu (guess_game_started/guess_players_updated)

// AFFICHAGE UNIQUEMENT (le gameplay et les points utilisent toujours la valeur exacte).
// Arrondit le multiplicateur affiché au pas le plus proche : 0.05 garde exactes toutes les valeurs
// de traits (×1.15, ×0.75, ×0.6...) et ne ramène que les combinaisons "bruitées" à une valeur
// lisible (1.7249999999999999 -> 1.75, 1.2000000000000002 -> 1.2, 3.45 -> 3.45).
const MULTIPLIER_DISPLAY_STEP = 0.05;
// ---------- Mécaniques de TYPE des boss : AFFICHAGE UNIQUEMENT ----------
// Tout (types du boss, faiblesses, multiplicateurs, bonus par Pokémon, bonus d'affinité, paliers)
// est calculé par le serveur et envoyé tel quel ; le client ne fait que le montrer.
const TYPE_LABELS = {
  normal: 'Normal', fire: 'Feu', water: 'Eau', electric: 'Électrik', grass: 'Plante', ice: 'Glace',
  fighting: 'Combat', poison: 'Poison', ground: 'Sol', flying: 'Vol', psychic: 'Psy', bug: 'Insecte',
  rock: 'Roche', ghost: 'Spectre', dark: 'Ténèbres', dragon: 'Dragon', steel: 'Acier', fairy: 'Fée'
};
let currentBossInfo = null; // boss de la partie en cours (types, faiblesses, règles), tel que reçu du serveur

function typeLabel(type) { return TYPE_LABELS[type] || type; }

function renderTypeBadges(container, types) {
  container.innerHTML = '';
  (types || []).forEach(type => {
    const badge = document.createElement('span');
    badge.className = 'type-badge';
    badge.dataset.type = type;
    badge.textContent = typeLabel(type);
    container.appendChild(badge);
  });
  container.classList.toggle('screen--hidden', !(types && types.length));
}

function renderBossTypeInfo(boss) {
  currentBossInfo = boss || null;
  renderTypeBadges(bossTypesEl, boss && boss.types);
  const rules = boss && boss.typeRules;
  if (!boss || !boss.types || !rules || !boss.weaknesses || !boss.weaknesses.length) {
    bossWeakEl.classList.add('screen--hidden');
    typeBonusPanelEl.classList.add('screen--hidden');
    return;
  }
  const weak = boss.weaknesses.map(w => `${typeLabel(w.type)}${w.multiplier >= 4 ? ' ×4' : ''}`).join(', ');
  let text = `Faible contre : ${weak}`;
  if (rules.weakness.enabled) {
    text += ` — tes Pokémon de ces types : ×${formatMultiplier(rules.weakness.multiplierX2)}`
      + ` (×${formatMultiplier(rules.weakness.multiplierX4)} pour ×4)`;
  }
  bossWeakEl.textContent = text;
  bossWeakEl.classList.remove('screen--hidden');
  renderTypeBonusPanel(null);
}

// Bonus de type courant du joueur observé (détail envoyé par le serveur : weakness, affinity, total).
// Affichage COMPACT (2 lignes max) : palier suivant et bonus actif ; le détail complet est en infobulle.
function renderTypeBonusPanel(detail) {
  const rules = currentBossInfo && currentBossInfo.typeRules;
  if (!rules || !currentBossInfo.counterType) { typeBonusPanelEl.classList.add('screen--hidden'); return; }
  const aff = detail && detail.affinity;
  const pct = rate => `+${Math.round(rate * 100)} %`;
  const lines = [];
  if (rules.affinity.enabled) {
    const tiers = rules.affinity.tiers.slice().sort((x, y) => x.min - y.min);
    const count = aff ? aff.count : 0;
    const next = aff ? aff.nextTier : tiers[0];
    const label = `Affinité ${typeLabel(currentBossInfo.counterType)} : `;
    if (aff && aff.rate > 0) {
      lines.push(next ? `${label}${count}/${next.min} · ${pct(aff.rate)} actif` : `${label}${count} · ${pct(aff.rate)} (max)`);
    } else {
      lines.push(next ? `${label}${count}/${next.min} (${pct(next.rate)})` : `${label}${count}`);
    }
  }
  if (detail && detail.total) lines.push(`Bonus de type : +${detail.total} pts`);
  typeBonusPanelEl.innerHTML = '';
  lines.forEach(l => { const p = document.createElement('p'); p.textContent = l; typeBonusPanelEl.appendChild(p); });
  typeBonusPanelEl.title = detail && detail.total
    ? `Faiblesses +${detail.weakness}${rules.affinity.enabled ? ` · Affinité +${aff ? aff.bonus : 0}` : ''}`
      + (rules.affinity.enabled ? ` — paliers : ${rules.affinity.tiers.slice().sort((x, y) => x.min - y.min).map(t => `${t.min}${t.min === Math.max(...rules.affinity.tiers.map(z => z.min)) ? '+' : ''} → ${pct(t.rate)}`).join(', ')}` : '')
    : '';
  typeBonusPanelEl.classList.toggle('screen--hidden', !lines.length);
}

function formatMultiplier(value) {
  // + 1e-9 : un milieu exact (ex. 1.725) s'arrondit toujours vers le haut malgré le bruit flottant.
  const rounded = Math.round(Number(value) / MULTIPLIER_DISPLAY_STEP + 1e-9) * MULTIPLIER_DISPLAY_STEP;
  return String(parseFloat(rounded.toFixed(2)));
}

// ---- Traits à points fixes (`flat`) + LET'S GO GAMBLING (roulette) ----
// Miroir de server.js (GAMBLE_EFFECT_NAME / GAMBLE_MULTIPLIERS) : le serveur tire TOUJOURS le
// multiplicateur final ; le client ne fait que rejouer une roulette qui s'arrête dessus.
const GAMBLE_EFFECT_NAME = "LET'S GO GAMBLING";
const GAMBLE_MULTIPLIERS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

// Libellé d'un trait : points fixes (« Aura +150 +150 PTS ») ou multiplicateur (« Smurf ×1.25 »).
function formatEffect(name, multiplier, flat) {
  return flat ? `${name} ${flat > 0 ? '+' : ''}${flat} PTS` : `${name} ×${formatMultiplier(multiplier)}`;
}

function isBonusEffect(multiplier, flat) {
  return flat ? flat > 0 : multiplier >= 1;
}

// Roues en cours : permet de les finir instantanément (Skip, tour suivant, fin de partie) pour
// qu'une animation ne dépasse jamais la pause de révélation native du jeu.
const gambleActiveEls = new Set();

// Termine tout de suite la roue de `el` (et la roue suivante d'une chaîne Reroll -> Gambling) :
// elle saute directement à son résultat, texte et points révélés.
function fastForwardGambleRoulette(el) {
  for (let guard = 0; guard < 3; guard++) {
    if (el._gambleFinishNow) { const f = el._gambleFinishNow; el._gambleFinishNow = null; f(); continue; }
    if (el._gambleChain) {
      if (el._gambleTimer) { clearTimeout(el._gambleTimer); el._gambleTimer = null; }
      const next = el._gambleChain; el._gambleChain = null; next(); continue;
    }
    break;
  }
  gambleActiveEls.delete(el);
}

function finishAllGambleWheels() {
  Array.from(gambleActiveEls).forEach(fastForwardGambleRoulette);
}

function stopGambleRoulette(el) {
  if (el._gambleTimer) { clearTimeout(el._gambleTimer); el._gambleTimer = null; }
  if (el._gambleRaf) { cancelAnimationFrame(el._gambleRaf); el._gambleRaf = null; }
  el._gambleFinishNow = null;
  el._gambleChain = null;
  gambleActiveEls.delete(el);
  if (el._gambleWheel) { el._gambleWheel.remove(); el._gambleWheel = null; }
  el.classList.remove('gamble-roulette', 'gamble-roulette--spinning', 'gamble-roulette--landed',
    'gamble-roulette--up', 'gamble-roulette--down');
}

// ---- Roue dorée (LET'S GO GAMBLING + Reroll) : segments colorés, ampoules, pointeur, moyeu ----
// Le serveur choisit TOUJOURS le résultat ; la roue ne fait que tourner et s'arrêter dessus.
const GAMBLE_WHEEL_COLORS = { 0.5: '#b83a37', 0.75: '#e8615d', 1: '#6b7587', 1.25: '#2f9d96', 1.5: '#3fd0c9', 1.75: '#f5a623', 2: '#ffd54a' };
let gambleWheelUid = 0;

function ensureGambleWheelStyles() {
  if (document.getElementById('gamble-wheel-style')) return;
  const st = document.createElement('style');
  st.id = 'gamble-wheel-style';
  st.textContent = `
.gamble-wheel { position: relative; display: flex; justify-content: center; margin: 8px auto 12px; }
.gamble-wheel svg { width: var(--gw-size, 210px); max-width: 82vw; height: auto; overflow: visible; filter: drop-shadow(0 6px 16px rgba(0,0,0,.55)); }
.gw-seg { stroke: rgba(0,0,0,.45); stroke-width: 1.2; }
.gw-seg--win { stroke: #fff; stroke-width: 3.5; }
.gw-label { font-family: 'JetBrains Mono', monospace; font-weight: 700; dominant-baseline: middle; pointer-events: none; }
.gw-bulb { fill: #fff3b0; filter: drop-shadow(0 0 2.5px #ffe27a); }
.gamble-wheel--spinning .gw-bulb--a { animation: gwBlinkA .32s steps(1) infinite; }
.gamble-wheel--spinning .gw-bulb--b { animation: gwBlinkB .32s steps(1) infinite; }
.gamble-wheel--landed .gw-bulb { animation: gwFlash .22s ease 8 alternate; }
.gamble-wheel--landed svg { animation: gambleWheelPop .7s ease-out 1; }
.gamble-wheel--rare svg { animation: gambleWheelPop .7s ease-out 1, gwRareGlow 1.1s ease-in-out .7s infinite; }
.gamble-wheel--bad svg { animation: gwShake .5s ease 1; }
.gw-spark { position: absolute; left: 50%; top: 50%; width: 7px; height: 7px; border-radius: 50%; background: #ffd54a; box-shadow: 0 0 8px #ffd54a; pointer-events: none; animation: gwSpark 1.1s ease-out forwards; }
@keyframes gwBlinkA { 0% { opacity: 1; } 50% { opacity: .2; } }
@keyframes gwBlinkB { 0% { opacity: .2; } 50% { opacity: 1; } }
@keyframes gwFlash { from { opacity: .25; } to { opacity: 1; } }
@keyframes gambleWheelPop { 0% { transform: scale(1); } 40% { transform: scale(1.1); } 100% { transform: scale(1); } }
@keyframes gwRareGlow { 0%, 100% { filter: drop-shadow(0 0 8px rgba(255,213,74,.5)); } 50% { filter: drop-shadow(0 0 26px rgba(255,213,74,1)); } }
@keyframes gwShake { 0%, 100% { transform: translateX(0); } 20% { transform: translateX(-7px); } 40% { transform: translateX(6px); } 60% { transform: translateX(-4px); } 80% { transform: translateX(3px); } }
@keyframes gwSpark { from { transform: translate(-50%, -50%) scale(1); opacity: 1; } to { transform: translate(calc(-50% + var(--dx)), calc(-50% + var(--dy))) scale(.2); opacity: 0; } }
.gamble-roulette { min-width: 12ch; text-align: center; }
.result-line .gamble-roulette { color: #ffd54a; }
.result-line .gamble-roulette.gamble-roulette--up { color: var(--accent-bas); }
.result-line .gamble-roulette.gamble-roulette--down { color: var(--danger); }
`;
  document.head.appendChild(st);
}

// Texte lisible (blanc/noir) sur une couleur de segment hexadécimale.
function wheelTextOn(hex) {
  const n = parseInt(hex.slice(1), 16);
  const lum = 0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
  return lum > 150 ? '#0b0f16' : '#ffffff';
}

// Construit la roue. o = { items, fill(item, i) -> '#hex', label(item) -> texte du segment, size }
function buildGambleWheel(o) {
  const NS = 'http://www.w3.org/2000/svg';
  const n = o.items.length, seg = 360 / n, R = 96, uid = ++gambleWheelUid;
  const mk = (tag, attrs, parent) => {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  };
  const pt = (deg, r) => { const a = deg * Math.PI / 180; return [(r * Math.sin(a)).toFixed(2), (-r * Math.cos(a)).toFixed(2)]; };

  const root = document.createElement('div');
  root.className = 'gamble-wheel gamble-wheel--spinning';
  root.style.setProperty('--gw-size', `${o.size || 210}px`);
  root.setAttribute('aria-hidden', 'true');
  const svg = mk('svg', { viewBox: '-122 -146 244 268' }, root);

  const defs = mk('defs', {}, svg);
  const gold = mk('linearGradient', { id: `gwGold${uid}`, x1: '0', y1: '0', x2: '1', y2: '1' }, defs);
  [['0', '#fff1a8'], ['0.45', '#e0a82e'], ['1', '#8a5a00']].forEach(([off, c]) => mk('stop', { offset: off, 'stop-color': c }, gold));
  const shine = mk('radialGradient', { id: `gwShine${uid}`, cx: '0.5', cy: '0.4', r: '0.65' }, defs);
  [['0', 'rgba(255,255,255,.38)'], ['0.55', 'rgba(255,255,255,0)'], ['1', 'rgba(0,0,0,.28)']].forEach(([off, c]) => mk('stop', { offset: off, 'stop-color': c }, shine));
  const pin = mk('linearGradient', { id: `gwPin${uid}`, x1: '0', y1: '0', x2: '1', y2: '1' }, defs);
  [['0', '#ff6a5e'], ['1', '#b3140f']].forEach(([off, c]) => mk('stop', { offset: off, 'stop-color': c }, pin));

  // Plateau (tourne) : segments + libellés
  const rot = mk('g', { transform: 'rotate(0)' }, svg);
  const segs = [];
  const fs = n > 10 ? 11.5 : 16;
  o.items.forEach((item, i) => {
    const [x1, y1] = pt(i * seg, R), [x2, y2] = pt((i + 1) * seg, R);
    const fill = o.fill(item, i);
    segs.push(mk('path', { d: `M0 0 L${x1} ${y1} A${R} ${R} 0 0 1 ${x2} ${y2} Z`, fill, class: 'gw-seg' }, rot));
    const c = (i + 0.5) * seg;
    const t = mk('text', { transform: `rotate(${(c - 90).toFixed(2)}) translate(${R - 9} 0)`, 'text-anchor': 'end', 'font-size': fs, fill: wheelTextOn(fill), class: 'gw-label' }, rot);
    t.textContent = o.label(item);
  });
  mk('circle', { r: R, fill: `url(#gwShine${uid})`, 'pointer-events': 'none' }, rot); // relief (tourne avec)

  // Cadre doré fixe + ampoules
  mk('circle', { r: 104, fill: 'none', stroke: `url(#gwGold${uid})`, 'stroke-width': 16 }, svg);
  mk('circle', { r: 112, fill: 'none', stroke: '#6b4300', 'stroke-width': 1.5 }, svg);
  mk('circle', { r: 96, fill: 'none', stroke: '#6b4300', 'stroke-width': 1.5 }, svg);
  const bulbs = 24;
  for (let i = 0; i < bulbs; i++) {
    const [bx, by] = pt(i * (360 / bulbs), 104);
    mk('circle', { cx: bx, cy: by, r: 3.1, class: `gw-bulb ${i % 2 ? 'gw-bulb--a' : 'gw-bulb--b'}` }, svg);
  }
  // Moyeu doré
  mk('circle', { r: 17, fill: `url(#gwGold${uid})`, stroke: '#6b4300', 'stroke-width': 2 }, svg);
  mk('circle', { r: 8, fill: '#7a4d00', stroke: '#fff1a8', 'stroke-width': 1.5 }, svg);
  // Pointeur « épingle » rouge, pointe vers la roue
  mk('path', { d: 'M0 -90 C-17 -108 -17 -139 0 -139 C17 -139 17 -108 0 -90 Z', fill: `url(#gwPin${uid})`, stroke: '#6b0f0b', 'stroke-width': 2, 'stroke-linejoin': 'round' }, svg);
  mk('circle', { cx: 0, cy: -121, r: 5.5, fill: '#fff' }, svg);

  return { root, rot, segs, seg, n };
}

function burstWheelSparks(root) {
  for (let i = 0; i < 26; i++) {
    const sp = document.createElement('span');
    sp.className = 'gw-spark';
    const ang = Math.random() * Math.PI * 2, dist = 70 + Math.random() * 90;
    sp.style.setProperty('--dx', `${(Math.cos(ang) * dist).toFixed(0)}px`);
    sp.style.setProperty('--dy', `${(Math.sin(ang) * dist).toFixed(0)}px`);
    sp.style.animationDelay = `${(Math.random() * 0.25).toFixed(2)}s`;
    root.appendChild(sp);
    setTimeout(() => sp.remove(), 1600);
  }
}

// Moteur générique : la roue tourne en ralentissant, tick à chaque case franchie, s'arrête sur
// items[finalIdx]. o = { items, finalIdx, fill, label, live(item)->texte, tone(item)->'up'|'down'|null,
//   size, duration, spins, power (frein), rare(item), bad(item), onDone }
function spinGambleWheel(el, o) {
  stopGambleRoulette(el);
  ensureGambleWheelStyles();
  const wheel = buildGambleWheel(o);
  (el.parentElement || el).insertAdjacentElement('beforebegin', wheel.root);
  el._gambleWheel = wheel.root;

  const final = o.items[o.finalIdx];
  const paint = (item) => {
    el.textContent = o.live(item);
    const t = o.tone(item);
    el.classList.toggle('gamble-roulette--up', t === 'up');
    el.classList.toggle('gamble-roulette--down', t === 'down');
  };
  const setRot = (deg) => wheel.rot.setAttribute('transform', `rotate(${deg.toFixed(2)})`);
  const idxUnder = (deg) => Math.floor(((360 - (deg % 360)) % 360) / wheel.seg) % wheel.n; // case sous le pointeur (haut)
  const finish = () => {
    if (el._gambleRaf) { cancelAnimationFrame(el._gambleRaf); el._gambleRaf = null; }
    el._gambleFinishNow = null;
    el.classList.remove('gamble-roulette--spinning');
    el.classList.add('gamble-roulette--landed');
    wheel.root.classList.remove('gamble-wheel--spinning');
    wheel.root.classList.add('gamble-wheel--landed');
    wheel.segs[o.finalIdx].classList.add('gw-seg--win');
    paint(final);
    const rare = o.rare && o.rare(final);
    if (rare) { wheel.root.classList.add('gamble-wheel--rare'); burstWheelSparks(wheel.root); }
    if (o.bad && o.bad(final)) wheel.root.classList.add('gamble-wheel--bad');
    playRouletteStopSound(o.tone(final) !== 'down');
    if (o.onDone) o.onDone();
  };

  el.classList.add('gamble-roulette');
  const jitter = (Math.random() - 0.5) * 0.7;                       // arrêt rarement pile au centre
  const base = (360 - (o.finalIdx + 0.5 + jitter) * wheel.seg + 360) % 360;
  if (document.documentElement.classList.contains('reduce-motion')) { setRot(base); finish(); return; } // réglage du jeu uniquement
  gambleActiveEls.add(el);
  el._gambleFinishNow = () => { setRot(base); finish(); };          // Skip / tour suivant : saute au résultat

  const start = Math.random() * 360;
  const end = start + 360 * (o.spins || 5) + ((((base - start) % 360) + 360) % 360);
  const DURATION = o.duration || 4500, POW = o.power || 4;
  const t0 = performance.now();
  let lastIdx = -1, lastTick = 0;
  el.classList.add('gamble-roulette--spinning');
  const frame = (now) => {
    if (!el.isConnected) { stopGambleRoulette(el); return; }
    const t = Math.min(1, (now - t0) / DURATION);
    const deg = start + (end - start) * (1 - Math.pow(1 - t, POW)); // démarre vite, freine longtemps
    setRot(deg);
    const idx = idxUnder(deg);
    if (idx !== lastIdx) {
      lastIdx = idx;
      paint(o.items[idx]);
      if (t < 1 && now - lastTick > 35) { lastTick = now; playRouletteTickSound(t); }
    }
    if (t < 1) el._gambleRaf = requestAnimationFrame(frame);
    else finish();
  };
  el._gambleRaf = requestAnimationFrame(frame);
}

// LET'S GO GAMBLING : roue des multiplicateurs ×0.5 -> ×2 (×2 = jackpot, étincelles ; ×0.5 = secousse).
function playGambleRoulette(el, finalMultiplier, onDone, opts = {}) {
  const items = GAMBLE_MULTIPLIERS.includes(finalMultiplier)
    ? GAMBLE_MULTIPLIERS
    : [...GAMBLE_MULTIPLIERS, finalMultiplier].sort((a, b) => a - b);
  spinGambleWheel(el, {
    items,
    finalIdx: items.indexOf(finalMultiplier),
    fill: (m) => GAMBLE_WHEEL_COLORS[m] || (m > 1 ? '#3fd0c9' : m < 1 ? '#e8615d' : '#6b7587'),
    label: (m) => `×${formatMultiplier(m)}`,
    live: (m) => `${GAMBLE_EFFECT_NAME} ×${formatMultiplier(m)}`,
    tone: (m) => (m > 1 ? 'up' : (m < 1 ? 'down' : null)),
    size: 210,
    duration: opts.duration || 3500,
    spins: opts.spins || 4,
    rare: (m) => m >= 1.75,
    bad: (m) => m <= 0.5,
    onDone
  });
}

// ---- Reroll : roue de TOUS les traits possibles ----
function traitStrength(it) {
  if (it.gamble) return 1.5;
  return it.flat ? 1 + it.flat / 500 : it.multiplier; // même échelle que `power` côté serveur
}

// Alterne bon / mauvais autour de la roue (couleurs vives, quasi-ratés fréquents), 🎰 au milieu.
function orderTraitsForWheel(items) {
  const bonus = items.filter(it => !it.gamble && traitStrength(it) >= 1).sort((a, b) => traitStrength(b) - traitStrength(a));
  const malus = items.filter(it => !it.gamble && traitStrength(it) < 1).sort((a, b) => traitStrength(a) - traitStrength(b));
  const gamble = items.filter(it => it.gamble);
  const out = [];
  const max = Math.max(bonus.length, malus.length);
  for (let i = 0; i < max; i++) {
    if (bonus[i]) out.push(bonus[i]);
    if (malus[i]) out.push(malus[i]);
    if (i === Math.floor(max / 2)) out.push(...gamble);
  }
  gamble.forEach(g => { if (!out.includes(g)) out.push(g); });
  return out;
}

function traitWheelFill(it, i) {
  if (it.gamble) return '#ffd54a';                                 // doré = jackpot potentiel
  const st = traitStrength(it);
  if (st >= 1.6) return '#f2578c';                                 // rose = très rare
  if (st >= 1.35) return '#b98cf2';                                // violet = rare
  if (st >= 1) return i % 2 ? '#2fb89a' : '#3fd0c9';               // bon
  if (st <= 0.65) return '#7a1f1d';                                // très mauvais
  return i % 2 ? '#d8504c' : '#b83a37';                            // mauvais
}

function traitWheelLabel(it) {
  if (it.gamble) return '🎰';
  return it.flat ? `${it.flat > 0 ? '+' : ''}${it.flat}` : `×${formatMultiplier(it.multiplier)}`;
}

// Reroll : la roue des traits tourne jusqu'au trait tiré ; si c'est LET'S GO GAMBLING,
// une seconde roue (multiplicateurs) prend le relais.
function playTraitRoulette(el, items, finalEffect, onDone) {
  const ordered = orderTraitsForWheel(items);
  const finalIdx = Math.max(0, ordered.findIndex(it => it.name === finalEffect.name));
  spinGambleWheel(el, {
    items: ordered,
    finalIdx,
    fill: traitWheelFill,
    label: traitWheelLabel,
    live: (it) => (it.gamble ? `${GAMBLE_EFFECT_NAME} 🎰` : formatEffect(it.name, it.multiplier, it.flat)),
    tone: (it) => (it.gamble ? null : (isBonusEffect(it.multiplier, it.flat) ? 'up' : 'down')),
    size: 280,
    duration: 5000,
    spins: 5,
    power: 4.5,
    rare: (it) => it.gamble || traitStrength(it) >= 1.35,
    bad: (it) => !it.gamble && traitStrength(it) <= 0.65,
    onDone: () => {
      if (finalEffect.name === GAMBLE_EFFECT_NAME) {
        const next = () => { el._gambleChain = null; playGambleRoulette(el, finalEffect.multiplier, onDone, { duration: 3000 }); };
        el._gambleChain = next;
        gambleActiveEls.add(el);
        el._gambleTimer = setTimeout(() => { el._gambleTimer = null; next(); }, 900);
      } else if (onDone) onDone();
    }
  });
}

const RARITY_LABELS = {
  commun: 'Normal',
  peu_commun: 'Peu commun',
  rare: 'Rare',
  epique: 'Épique',
  pseudo_legendaire: 'Semi-légendaire',
  mega: 'Méga-Évolution',
  legendaire: 'Légendaire',
  fabuleux: 'Fabuleux',
  ultra_chimere: 'Ultra-Chimère'
};

// Purement cosmétique (texte affiché) : la valeur qui compte réellement est calculée
// côté serveur (cf. SHINY_POINTS_MULTIPLIER dans server.js — une seule source de vérité
// pour le calcul, ce chiffre ici ne sert qu'à l'affichage).
const SHINY_POINTS_MULTIPLIER = 1.5;

// État de l'overlay événements rares. activeEventType = type actuellement affiché
// (start ou result) ; eventQueue = résultats reçus pendant qu'un AUTRE événement est
// affiché (ex: notification CROSSED_FATES arrivant pendant un choix DOUBLE_ENCOUNTER) —
// jamais perdus, simplement affichés à la suite une fois l'overlay refermé.
let activeEventType = null;
let eventQueue = [];

const DIFFICULTY_LABELS = {
  easy: 'FACILE',
  medium: 'MOYEN',
  hard: 'DIFFICILE',
  extreme: 'EXTRÊME'
};

const BONUS_LABELS_CLIENT = {
  xpCandy: 'Bonbon XP',
  mysteryItem: 'PSL',
  shinyCharm: 'Charme Chroma',
  megaGem: 'Méga Gemme',
  patchNote: 'Return To Zero',
  reroll: 'Reroll'
};

const BONUS_DESCRIPTIONS = {
  xpCandy: 'Fait évoluer un Pokémon de ton équipe jusqu\'à sa forme finale.',
  mysteryItem: 'Donne le trait Beauty privilege (×1.6) à un Pokémon de ton équipe.',
  shinyCharm: 'Passif, tous les tours : meilleurs Pokémon et ×2 de chances de shiny.',
  megaGem: 'Fait Méga-Évoluer un Pokémon de ton équipe (×1.5 pts), quand tu veux.',
  patchNote: 'Retire le malus d\'un Pokémon de ton équipe (trait remis à Neutre).',
  reroll: 'Relance le trait d\'un Pokémon de ton équipe — roulette, jamais Neutre.'
};

// ---------- Helpers UI ----------
function showError(msg) {
  errorMessage.textContent = msg;
}

function clearError() {
  errorMessage.textContent = '';
}

function showScreen(screen) {
  [screenHome, screenLobby, screenGame, screenFinished, screenGuess, screenGuessFinished, screenAuction, screenAuctionFinished, screenSpectate].forEach(s => s.classList.add('screen--hidden'));
  screen.classList.remove('screen--hidden');
  // Reflété en attribut sur <body> : la mise en page large écran (cf. style.css) en
  // dépend pour savoir si l'écran actif est l'accueil (hero éclaté) ou un écran de jeu
  // (grille resserrée), sans dupliquer la logique de visibilité elle-même.
  document.body.dataset.screen = screen.id.replace('screen-', '');
  if (screen === screenLobby && getStoredAccount()) refreshLobbyFriendsBar();
}

function isHost() {
  return !!(myId && hostId && myId === hostId);
}

function updateHostControls() {
  const host = isHost();
  btnStart.classList.toggle('screen--hidden', !host);
  difficultyButtons.forEach(btn => { btn.disabled = !host; });
  gamemodeButtons.forEach(btn => { btn.disabled = !host; });
  guessDurationButtons.forEach(btn => { btn.disabled = !host; });
  auctionTypeButtons.forEach(btn => { btn.disabled = !host; });
  renderModifiers(currentModifiers); // boutons désactivés pour l'invité
  renderActivePlayersOptions(); // dépend aussi de isHost() (boutons désactivés pour l'invité)
  renderAdminRoleOptions(); // dépend aussi de isHost() (boutons désactivés pour l'invité)
  lobbyStatusEl.textContent = host
    ? 'Lance la partie quand tout le monde est prêt.'
    : "En attente que l'hôte démarre la partie...";
}

// Met à jour l'affichage de la difficulté (mise en évidence du choix actuel).
// N'émet jamais rien : uniquement du rendu à partir de ce que le serveur a confirmé.
function renderDifficulty(difficulty) {
  currentDifficulty = difficulty || 'medium';
  difficultyButtons.forEach(btn => {
    btn.classList.toggle('difficulty-btn--selected', btn.dataset.difficulty === currentDifficulty);
  });
}

// Met à jour l'affichage du mode de jeu + affiche/masque les pickers ADMIN et
// "joueurs actifs". N'émet jamais rien : uniquement du rendu à partir de ce que le
// serveur a confirmé.
function renderGameMode(gameMode) {
  currentGameMode = gameMode || 'normal';
  gamemodeButtons.forEach(btn => {
    btn.classList.toggle('gamemode-btn--selected', btn.dataset.mode === currentGameMode);
  });
  adminRolePanelEl.classList.toggle('screen--hidden', currentGameMode !== 'admin');
  renderActivePlayersOptions();
  renderAdminRoleOptions();

  // "Devine le Pokémon" : pas de rôle à choisir (contrairement à ADMIN VS JOUEUR), juste
  // un rappel du nombre de joueurs nécessaire — le serveur revalide de toute façon au
  // démarrage, ce message n'est qu'un confort visuel.
  const needsGuessHint = currentGameMode === 'guess';
  // "Draft/Enchères" : AUCUN mécanisme de banc/spectateur (contrairement à guess/admin qui
  // acceptent >2 joueurs avec mise sur banc) — start_game bloque toujours si players.length
  // !== 2, même à 3+ dans le lobby. D'où un message qui ne parle jamais de spectateurs.
  const needsAuctionHint = currentGameMode === 'auction';
  // "Coop" : aucun banc/spectateur (contrairement à guess/admin) — 2 joueurs minimum,
  // AUCUN plafond, tous jouent. Score cumulé contre un boss commun qui scale avec
  // l'effectif (cf. computeCoopTeamRequiredPoints côté serveur).
  const needsCoopHint = currentGameMode === 'coop';
  gamemodeHintEl.classList.toggle('screen--hidden', !needsGuessHint && !needsAuctionHint && !needsCoopHint);
  if (needsGuessHint) {
    gamemodeHintEl.textContent = lastLobbyPlayers.length > 2
      ? 'Choisis les 2 joueurs qui vont jouer ci-dessous — les autres seront spectateurs.'
      : 'Ce mode nécessite exactement 2 joueurs.';
  } else if (needsAuctionHint) {
    gamemodeHintEl.textContent = lastLobbyPlayers.length === 2
      ? 'Choisis le type de draft ci-dessous, puis lance la partie.'
      : 'Ce mode nécessite exactement 2 joueurs, ni plus ni moins.';
  } else if (needsCoopHint) {
    const n = lastLobbyPlayers.length;
    gamemodeHintEl.textContent = n >= 2
      ? 'Mode coopératif : vos scores s\'additionnent contre un boss commun (+50% de vie par joueur en plus).'
      : 'Ce mode nécessite au moins 2 joueurs.';
  }
  guessDurationPanelEl.classList.toggle('screen--hidden', currentGameMode !== 'guess');
  auctionTypePanelEl.classList.toggle('screen--hidden', currentGameMode !== 'auction');
  renderModifiers(currentModifiers); // le panneau n'existe qu'en Mode normal / Coop
}

// ---------- Modificateurs de partie ----------
// Catalogue (libellés/descriptions) fourni par le serveur — jamais dupliqué ici. La sélection
// est celle de l'hôte, confirmée par le serveur (modifiers_updated), jamais décidée côté client.
// Une partie à modificateurs est hors-classement : aucune XP/succès/stats/Pokédex (serveur).
let modifiersCatalog = [];
let modifiersAllowedModes = ['normal', 'coop'];
let currentModifiers = [];
let lastGameModifiers = []; // modificateurs de la partie en cours / qui vient de finir (bandeaux)

function renderModifiers(mods) {
  currentModifiers = Array.isArray(mods) ? mods : [];
  const allowed = modifiersAllowedModes.includes(currentGameMode);
  modifiersPanelEl.classList.toggle('screen--hidden', !allowed || modifiersCatalog.length === 0);
  modifiersOptionsEl.innerHTML = '';
  modifiersActiveListEl.innerHTML = '';
  const host = isHost();

  modifiersCatalog.forEach(m => {
    const active = currentModifiers.includes(m.key);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'modifier-chip' + (active ? ' modifier-chip--active' : '');
    btn.title = m.description;
    btn.disabled = !host;
    btn.setAttribute('aria-pressed', String(active));
    btn.textContent = `${m.icon} ${m.label}`;
    btn.addEventListener('click', () => {
      if (!isHost()) return;
      const next = active ? currentModifiers.filter(k => k !== m.key) : currentModifiers.concat(m.key);
      socket.emit('set_modifiers', { modifiers: next });
    });
    modifiersOptionsEl.appendChild(btn);

    if (active) {
      // Descriptions des modificateurs actifs en toutes lettres (le title ne marche pas au doigt).
      const li = document.createElement('li');
      li.textContent = `${m.icon} ${m.label} — ${m.description}`;
      modifiersActiveListEl.appendChild(li);
    }
  });
  modifiersNoteEl.classList.toggle('screen--hidden', currentModifiers.length === 0);
}

// Pastilles des modificateurs actifs (panneau du boss en partie, écran de fin).
function renderModifierBadges(containerEl, mods) {
  containerEl.innerHTML = '';
  const list = (Array.isArray(mods) ? mods : [])
    .map(key => modifiersCatalog.find(m => m.key === key))
    .filter(Boolean);
  containerEl.classList.toggle('screen--hidden', list.length === 0);
  list.forEach(m => {
    const badge = document.createElement('span');
    badge.className = 'modifier-badge';
    badge.title = m.description;
    badge.textContent = `${m.icon} ${m.label}`;
    containerEl.appendChild(badge);
  });
}

async function fetchModifiersCatalog() {
  try {
    const res = await fetch('/api/modifiers');
    const data = await res.json();
    if (!res.ok || !Array.isArray(data.modifiers)) return;
    modifiersCatalog = data.modifiers;
    if (Array.isArray(data.modes)) modifiersAllowedModes = data.modes;
    renderModifiers(currentModifiers);
    renderModifierBadges(gameModifiersEl, lastGameModifiers);
    renderModifierBadges(finishedModifiersEl, lastGameModifiers);
  } catch (err) {
    // Silencieux : le lobby fonctionne sans (panneau simplement masqué).
  }
}
fetchModifiersCatalog();

// Reflet local de la durée de tour choisie par l'hôte (mode "guess"). Le serveur reste
// seul à décider réellement (cf. GUESS_TURN_DURATION_MS / set_guess_turn_duration côté
// serveur) ; réutilisée aussi par startGuessTimerDisplay() plus bas pour calculer le %
// de la barre de temps restant.
let currentGuessTurnDurationMs = 30000;

function renderGuessDuration(durationMs) {
  currentGuessTurnDurationMs = durationMs || 30000;
  guessDurationButtons.forEach(btn => {
    btn.classList.toggle('admin-role-btn--selected', Number(btn.dataset.duration) === currentGuessTurnDurationMs);
  });
}

// Reflet local du type de draft choisi par l'hôte (mode "auction"). Le serveur reste seul
// à décider réellement ; null tant que rien n'est choisi (cf. AUCTION_TYPES côté serveur).
let currentAuctionType = null;

function renderAuctionType(auctionType) {
  currentAuctionType = auctionType || null;
  auctionTypeButtons.forEach(btn => {
    btn.classList.toggle('admin-role-btn--selected', btn.dataset.auctiontype === currentAuctionType);
  });
  auctionTypeStatusEl.textContent = currentAuctionType
    ? ''
    : "Choix requis avant de pouvoir démarrer.";
}

// Picker "qui joue" (mode admin/guess, UNIQUEMENT quand il y a plus de 2 joueurs dans le
// lobby — à exactement 2, ils sont automatiquement les 2 actifs, ce picker n'a pas lieu
// d'être). Sélection à bascule plafonnée à 2 : le 3e clic remplace le plus ancien choisi.
function renderActivePlayersOptions() {
  const needsPicker = (currentGameMode === 'admin' || currentGameMode === 'guess') && lastLobbyPlayers.length > 2;
  activePlayersPanelEl.classList.toggle('screen--hidden', !needsPicker);
  if (!needsPicker) return;

  activePlayersOptionsEl.innerHTML = '';
  const host = isHost();

  lastLobbyPlayers.forEach(p => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'admin-role-btn';
    btn.classList.toggle('admin-role-btn--selected', currentActivePlayerIds.includes(p.id));
    btn.disabled = !host;
    btn.textContent = p.name;
    btn.addEventListener('click', () => {
      if (!isHost()) return;
      let next = currentActivePlayerIds.includes(p.id)
        ? currentActivePlayerIds.filter(id => id !== p.id)
        : [...currentActivePlayerIds, p.id];
      if (next.length > 2) next = next.slice(next.length - 2); // garde les 2 derniers cliqués
      socket.emit('set_active_players', { playerIds: next });
    });
    activePlayersOptionsEl.appendChild(btn);
  });

  activePlayersStatusEl.textContent = currentActivePlayerIds.length === 2
    ? ''
    : host ? 'Sélectionne les 2 joueurs qui vont jouer.' : "En attente que l'hôte choisisse...";
}

// Reconstruit le picker ADMIN à partir de la dernière liste de joueurs connue. Affiché
// uniquement en mode "admin". À exactement 2 joueurs, les 2 sont directement proposés ;
// au-delà, uniquement parmi les 2 joueurs actifs déjà choisis via renderActivePlayersOptions
// (jamais un joueur resté sur le banc) — sinon affiche juste un message explicite.
function renderAdminRoleOptions() {
  if (currentGameMode !== 'admin') return;

  adminRoleOptionsEl.innerHTML = '';
  const host = isHost();

  if (lastLobbyPlayers.length < 2) {
    adminRoleStatusEl.textContent = 'Au moins 2 joueurs sont nécessaires pour ce mode.';
    return;
  }

  const candidates = lastLobbyPlayers.length === 2
    ? lastLobbyPlayers
    : lastLobbyPlayers.filter(p => currentActivePlayerIds.includes(p.id));

  if (lastLobbyPlayers.length > 2 && candidates.length !== 2) {
    adminRoleStatusEl.textContent = "Choisis d'abord les 2 joueurs qui vont jouer ci-dessus.";
    return;
  }

  candidates.forEach(p => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'admin-role-btn';
    btn.classList.toggle('admin-role-btn--selected', p.id === currentAdminId);
    btn.disabled = !host;
    btn.textContent = p.name;
    btn.addEventListener('click', () => {
      if (!isHost()) return;
      socket.emit('set_admin_role', { adminId: p.id });
    });
    adminRoleOptionsEl.appendChild(btn);
  });

  adminRoleStatusEl.textContent = currentAdminId
    ? ''
    : host ? "Choisis qui sera l'ADMIN." : "En attente que l'hôte choisisse l'ADMIN...";
}

function updateReplayControls() {
  const host = isHost();
  btnReplay.classList.toggle('screen--hidden', !host);
  finishedStatusEl.textContent = host
    ? 'Relance une partie quand tu es prêt.'
    : "En attente que l'hôte relance une partie...";
}

// Cache de lignes par liste (lobby ET en jeu partagent cette fonction, cf. renderLobbyPlayers /
// applyGameState) : réutilise le DOM existant d'un joueur au lieu de tout détruire/recréer à
// CHAQUE mise à jour (un choix de n'importe quel joueur rediffuse la liste à tout le monde,
// cf. finalizePlayerTurn) — sans ça, les avatars et mini-équipes clignotaient et le tout
// devenait perceptiblement moins fluide à mesure que le nombre de joueurs grandissait
// (mode Coop notamment, illimité). Indexé par élément de liste (WeakMap) pour ne jamais
// mélanger le cache du lobby avec celui de l'écran de jeu.
const playerRowCache = new WeakMap();

function buildPlayerRow(p) {
  const li = document.createElement('li');

  const row = document.createElement('div');
  row.className = 'player-item__row';

  const identity = document.createElement('div');
  identity.className = 'player-item__identity';

  const avatarImg = document.createElement('img');
  avatarImg.className = 'player-item__avatar';
  avatarImg.alt = '';

  const who = document.createElement('div');
  who.className = 'player-item__who';
  const name = document.createElement('span');
  const nameText = document.createTextNode('');
  const hostTag = document.createElement('span');
  hostTag.className = 'player-host';
  hostTag.textContent = 'Hôte';
  const offlineTag = document.createElement('span');
  offlineTag.className = 'player-offline';
  offlineTag.textContent = 'Hors ligne';
  const check = document.createElement('span');
  check.className = 'player-check';
  check.textContent = '✓';
  name.append(nameText, hostTag, offlineTag, check);
  const titleEl = document.createElement('div'); // titre équipé, petit, sous le pseudo
  titleEl.className = 'player-item__title screen--hidden';
  who.append(name, titleEl);

  const score = document.createElement('span');
  score.className = 'player-score';

  identity.appendChild(who);
  row.appendChild(identity);
  row.appendChild(score);
  li.appendChild(row);

  const teamRow = document.createElement('div');
  teamRow.className = 'player-item__team';

  return { li, identity, avatarImg, nameText, titleEl, hostTag, offlineTag, check, score, teamRow, teamCount: 0, avatarKey: null };
}

function updatePlayerRow(refs, p) {
  refs.li.classList.toggle('player-item--disconnected', !!p.disconnected);

  if (p.avatar) {
    if (refs.avatarKey !== p.avatar) {
      refs.avatarKey = p.avatar;
      refs.avatarImg.src = avatarUrl(p.avatar); // seulement si l'avatar a réellement changé
      if (!refs.avatarImg.isConnected) refs.identity.insertBefore(refs.avatarImg, refs.identity.firstChild);
    }
  } else if (refs.avatarImg.isConnected) {
    refs.avatarImg.remove();
    refs.avatarKey = null;
  }

  if (refs.nameText.data !== p.name) refs.nameText.data = p.name;
  const titleLabel = p.titleLabel || '';
  if (refs.titleEl.textContent !== titleLabel) refs.titleEl.textContent = titleLabel;
  refs.titleEl.classList.toggle('screen--hidden', !titleLabel);
  refs.hostTag.classList.toggle('screen--hidden', p.id !== hostId);
  refs.offlineTag.classList.toggle('screen--hidden', !p.disconnected);
  refs.check.classList.toggle('screen--hidden', !p.hasChosen);

  const scoreText = `${p.score} pts`;
  if (refs.score.textContent !== scoreText) refs.score.textContent = scoreText;

  // Mini équipe (sprites en petit) : l'équipe ne fait que grandir pendant une partie (jamais
  // réordonnée/raccourcie), donc ajouter les icônes manquantes suffit — jamais besoin de tout
  // reconstruire. Volontairement en LECTURE SEULE, aucune donnée secrète (pas d'effet/rareté/
  // points), juste ce que tout le monde verra de toute façon à l'écran de fin.
  const team = p.team || [];
  if (team.length !== refs.teamCount) {
    if (team.length < refs.teamCount) refs.teamRow.innerHTML = ''; // équipe reset (nouvelle partie)
    for (let i = refs.teamRow.children.length; i < team.length; i++) {
      const icon = document.createElement('img');
      icon.className = 'player-item__team-icon';
      refs.teamRow.appendChild(icon);
    }
    refs.teamCount = team.length;
    if (team.length > 0 && !refs.teamRow.isConnected) refs.li.appendChild(refs.teamRow);
    if (team.length === 0 && refs.teamRow.isConnected) refs.teamRow.remove();
  }
  // Même taille mais Pokémon modifié (Bonbon XP, Méga Gemme, événements : évolution, shiny...) :
  // on resynchronise le sprite de chaque icône (src recalculé seulement s'il a changé).
  for (let i = 0; i < team.length; i++) {
    const icon = refs.teamRow.children[i];
    if (!icon) continue;
    const mon = team[i];
    const src = pokemonSprite(mon);
    if (icon.dataset.sprite === src) continue;
    icon.dataset.sprite = src;
    icon.alt = mon.name;
    icon.onerror = mon.shiny ? () => { icon.onerror = null; icon.src = mon.sprite; } : null;
    icon.src = src;
  }
}

function renderPlayers(listEl, players) {
  let cache = playerRowCache.get(listEl);
  if (!cache) {
    cache = new Map();
    playerRowCache.set(listEl, cache);
  }

  const seen = new Set();
  players.forEach((p, index) => {
    seen.add(p.id);
    let refs = cache.get(p.id);
    if (!refs) {
      refs = buildPlayerRow(p);
      cache.set(p.id, refs);
    }
    updatePlayerRow(refs, p);
    if (listEl.children[index] !== refs.li) {
      listEl.insertBefore(refs.li, listEl.children[index] || null);
    }
  });

  for (const [id, refs] of cache) {
    if (!seen.has(id)) {
      refs.li.remove();
      cache.delete(id);
    }
  }
}

function renderLobbyPlayers(players) {
  playersCountEl.textContent = `(${players.length})`;
  renderPlayers(playersListEl, players);
  lastLobbyPlayers = players;
  renderAdminRoleOptions(); // la liste de joueurs a pu changer (join/leave) : re-sync le picker ADMIN
}

let routeStepEls = [];

function ensureRouteTrack(length) {
  if (routeStepEls.length === length) return;
  routeTrackEl.innerHTML = '';
  routeStepEls = [];
  for (let i = 0; i < length; i++) {
    const span = document.createElement('span');
    span.className = 'route-step route-step--upcoming';
    routeTrackEl.appendChild(span);
    routeStepEls.push(span);
  }
  const crown = document.createElement('span');
  crown.className = 'route-step route-step--boss';
  crown.textContent = '👑';
  routeTrackEl.appendChild(crown);
}

function renderRoute(route) {
  ensureRouteTrack(route.length);
  route.forEach((step, i) => {
    const el = routeStepEls[i];
    const previousStatus = el.dataset.status;
    el.className = `route-step route-step--${step.status}`;
    el.textContent = step.status === 'done' ? '✓' : step.status === 'current' ? '?' : '□';
    if (previousStatus && previousStatus !== step.status) {
      el.classList.remove('route-step--pulse');
      void el.offsetWidth; // force le reflow pour pouvoir rejouer l'animation
      el.classList.add('route-step--pulse');
    }
    el.dataset.status = step.status;
  });
}

// Sprite à afficher pour un Pokémon de l'équipe : shiny si le joueur l'a obtenu via
// l'événement POKÉMON SHINY, sinon le sprite normal. Repli automatique si l'image
// shiny est indisponible (même logique que la révélation de l'événement lui-même).
function pokemonSprite(mon) {
  return (mon && mon.shiny && mon.shinySprite) ? mon.shinySprite : (mon ? mon.sprite : '');
}

// interactive = true uniquement quand c'est réellement TA propre équipe (jamais celle
// observée par l'ADMIN en mode ADMIN VS JOUEUR, qui reste strictement en lecture seule).
function renderTeam(team, interactive) {
  teamSlotsEl.innerHTML = '';
  for (let i = 0; i < 6; i++) {
    const slot = document.createElement('div');
    slot.className = 'team-slot';
    const pokemon = team[i];
    if (pokemon) {
      const img = document.createElement('img');
      img.src = pokemonSprite(pokemon);
      img.alt = pokemon.name;
      if (pokemon.shiny) {
        img.onerror = () => { img.src = pokemon.sprite; };
        slot.classList.add('team-slot--shiny');
      }
      slot.appendChild(img);
      if (pokemon.types && pokemon.typeMult && pokemon.typeMult !== 1) {
        const tag = document.createElement('span');
        tag.className = `team-slot__type ${pokemon.typeMult > 1 ? 'team-slot__type--bonus' : 'team-slot__type--malus'}`;
        tag.textContent = `×${formatMultiplier(pokemon.typeMult)}`;
        slot.appendChild(tag);
      }
      if (pokemon.types) {
        slot.title = `${pokemon.name} — ${pokemon.types.map(typeLabel).join(' / ')}`
          + (pokemon.typeBonus ? ` — bonus de type ${pokemon.typeBonus > 0 ? '+' : ''}${pokemon.typeBonus} pts` : '');
      }
      if (i === team.length - 1 && team.length > lastTeamSize) {
        slot.classList.add('team-slot--new');
      }
      // Easter egg : Métamorph cliquable -> se transforme en copiant le sprite d'un
      // autre membre de l'équipe (cf. socket.on('metamorph_transformed') plus bas).
      // Usage unique (pokemon.metamorphUsed, verrouillé côté serveur) : une fois utilisé,
      // le slot reste figé (verrouillé visuellement) pour le reste de la partie, y compris
      // après reconnexion. Avant usage, verrouillage anti-spam le temps de la réponse serveur.
      if (interactive && pokemon.id === METAMORPH_DEX_ID) {
        slot.classList.add('team-slot--metamorph');
        if (pokemon.metamorphUsed) {
          slot.classList.add('team-slot--metamorph-locked');
        } else {
          slot.addEventListener('click', () => {
            if (slot.classList.contains('team-slot--metamorph-locked')) return;
            slot.classList.add('team-slot--metamorph-locked');
            socket.emit('transform_metamorph', { index: i });
          });
        }
      }
    }
    teamSlotsEl.appendChild(slot);
  }
  lastTeamSize = team.length;
}

function setChoiceButtonsEnabled(enabled) {
  btnHaut.disabled = !enabled;
  btnBas.disabled = !enabled;
}

function clearChoiceSelection() {
  [btnHaut, btnBas].forEach(btn => btn.classList.remove('choice-card--selected', 'choice-card--rejected'));
}

function markChoiceSelected(chosenBtn, otherBtn) {
  chosenBtn.classList.add('choice-card--selected');
  otherBtn.classList.add('choice-card--rejected');
}

function playRevealAnimation() {
  resultPanelEl.classList.remove('result-panel--animate');
  void resultPanelEl.offsetWidth; // force le reflow pour rejouer la séquence de révélation
  resultPanelEl.classList.add('result-panel--animate');
}

function updateMyScore(score, delta) {
  if (delta) {
    const sign = delta > 0 ? '+' : '';
    myScorePopupEl.textContent = `${sign}${delta}`;
    myScorePopupEl.classList.toggle('my-score-popup--negative', delta < 0);
    myScorePopupEl.classList.remove('my-score-popup--play');
    myScoreValueEl.classList.remove('my-score-value--pulse');
    void myScorePopupEl.offsetWidth; // force le reflow pour rejouer l'animation
    myScorePopupEl.classList.add('my-score-popup--play');
    myScoreValueEl.classList.add('my-score-value--pulse');
  }
  myScoreValueEl.textContent = score;
}

function flashTurnLabel(turn) {
  if (turn === lastRenderedTurn) return;
  lastRenderedTurn = turn;
  const label = turnCurrentEl.closest('.turn-label') || turnCurrentEl.parentElement;
  label.classList.remove('turn-label--flash');
  void label.offsetWidth; // force le reflow pour rejouer l'animation
  label.classList.add('turn-label--flash');
}

function updateBossProximity(turn, maxTurns) {
  bossPanelEl.classList.toggle('boss-panel--close', maxTurns - turn <= 1);
}

// ---------- Tour 4 spécial : avantage / bonus ----------

// Une seule de ces 4 zones est visible à la fois : choix normal HAUT/BAS,
// choix avantage (tour 4), choix entre 2 bonus, ou choix de la cible du bonus.
function showTurnPhase(phase) {
  choiceCardsEl.classList.toggle('screen--hidden', phase !== 'choice');
  adminViewPanelEl.classList.toggle('screen--hidden', phase !== 'admin-view');
}

function showBonusTargetOverlay() {
  bonusTargetOverlayEl.classList.remove('screen--hidden');
}

function hideBonusTargetOverlay() {
  bonusTargetOverlayEl.classList.add('screen--hidden');
}

// ---------- Mode ADMIN VS JOUEUR ----------

// Vrai uniquement pour le socket qui a été désigné ADMIN dans CETTE partie (cf.
// currentGameMode/currentAdminId, mis à jour par game_started et les events du lobby).
function isAdminNow() {
  return currentGameMode === 'admin' && !!currentAdminId && myId === currentAdminId;
}

// Remplit le panneau d'observation de l'ADMIN avec les données complètes des 2 options
// (jamais calculées ici : uniquement ce que le serveur a envoyé via admin_view_turn_options).
function renderAdminViewOptions({ playerName, playerScore, haut, bas }) {
  adminViewPlayerNameEl.textContent = playerName;
  adminViewPlayerScoreEl.textContent = playerScore;

  const cards = [
    { rarity: haut.rarity, sprite: adminViewHautSpriteEl, name: adminViewHautNameEl, rarityEl: adminViewHautRarityEl, points: adminViewHautPointsEl, effect: adminViewHautEffectEl, data: haut },
    { rarity: bas.rarity, sprite: adminViewBasSpriteEl, name: adminViewBasNameEl, rarityEl: adminViewBasRarityEl, points: adminViewBasPointsEl, effect: adminViewBasEffectEl, data: bas }
  ];
  cards.forEach(c => {
    c.sprite.src = pokemonSprite(c.data);
    c.sprite.onerror = c.data.shiny ? () => { c.sprite.src = c.data.sprite; } : null;
    c.name.textContent = c.data.shiny ? `✨ ${c.data.name.toUpperCase()}` : c.data.name.toUpperCase();
    c.rarityEl.textContent = RARITY_LABELS[c.data.rarity] || '';
    c.rarityEl.dataset.rarity = c.data.rarity;
    c.points.textContent = `${c.data.finalPoints} PTS (base ${c.data.basePoints})`;
    c.effect.textContent = c.data.shiny
      ? `${formatEffect(c.data.effectName, c.data.multiplier, c.data.flat)} · Shiny ×${SHINY_POINTS_MULTIPLIER}`
      : formatEffect(c.data.effectName, c.data.multiplier, c.data.flat);
    c.sprite.closest('.admin-view-card').classList.toggle('admin-view-card--shiny', !!c.data.shiny);
  });
}

// Bouton "cible" (sprite + nom) pour choisir un Pokémon de l'équipe. Réutilisé par
// renderBonusTargetList (Bonbon XP / PSL, tour 4) et renderEventTeamPicker
// (HIDDEN_TALENT / INSTANT_EVOLUTION, événements rares).
function buildTeamTargetButton(mon, onClick) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'bonus-target-item';

  const img = document.createElement('img');
  img.src = mon.sprite;
  img.alt = mon.name;

  const name = document.createElement('span');
  name.textContent = mon.name;

  btn.appendChild(img);
  btn.appendChild(name);
  btn.addEventListener('click', onClick);
  return btn;
}

// Liste cible réutilisée par Bonbon XP (Pokémon évoluables uniquement, filtré côté
// serveur) et PSL (toute l'équipe). Le client ne renvoie que l'index fourni
// par le serveur, jamais un choix qu'il aurait inventé lui-même.
function renderBonusTargetList(team, onSelect) {
  bonusTargetListEl.innerHTML = '';
  team.forEach(mon => {
    const btn = buildTeamTargetButton(mon, () => {
      Array.from(bonusTargetListEl.children).forEach(b => { b.disabled = true; });
      turnStatusEl.textContent = 'Choix enregistré !';
      onSelect(mon.index);
    });
    bonusTargetListEl.appendChild(btn);
  });
}

// ---------- Événements rares ----------

function sendEventAction(action) {
  socket.emit('rare_event_action', action);
}

function showEventOverlay(title) {
  if (title) eventTitleEl.textContent = title;
  eventOverlayEl.classList.remove('screen--hidden');
}

function hideEventOverlay() {
  eventOverlayEl.classList.add('screen--hidden');
  eventBodyEl.innerHTML = '';
  eventModalEl.removeAttribute('data-event-type');
  eventModalEl.removeAttribute('data-outcome');
  eventModalEl.removeAttribute('data-rarity');
  activeEventType = null;
  if (eventQueue.length > 0) {
    const next = eventQueue.shift();
    renderEventResult(next);
  }
}

function buildEventCloseButton(label) {
  const wrap = document.createElement('div');
  wrap.className = 'event-modal__actions';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn btn--haut btn--block';
  btn.textContent = label || 'Continuer';
  btn.addEventListener('click', hideEventOverlay);
  wrap.appendChild(btn);
  return wrap;
}

function buildDeltaLine(delta) {
  const el = document.createElement('p');
  const value = delta || 0;
  el.className = 'event-result__delta ' + (
    value > 0 ? 'event-result__delta--positive' : value < 0 ? 'event-result__delta--negative' : 'event-result__delta--neutral'
  );
  el.textContent = value === 0 ? '± 0 PT' : `${value > 0 ? '+' : ''}${value} PTS`;
  return el;
}

function buildEventPokemonCard(opt, onClick) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'choice-card event-card';
  btn.dataset.rarity = opt.rarity || '';

  const img = document.createElement('img');
  img.className = 'choice-card__sprite';
  img.src = opt.sprite;
  img.alt = opt.name;

  const name = document.createElement('p');
  name.className = 'choice-card__name';
  name.textContent = opt.name;

  const rarity = document.createElement('span');
  rarity.className = 'event-card__rarity';
  rarity.textContent = RARITY_LABELS[opt.rarity] || '';

  const points = document.createElement('span');
  points.className = 'event-card__points';
  points.textContent = `${opt.finalPoints ?? opt.basePoints} PTS`;

  btn.appendChild(img);
  btn.appendChild(name);
  btn.appendChild(rarity);
  btn.appendChild(points);
  btn.addEventListener('click', onClick);
  return btn;
}

function buildEventChoiceButton(label, tone, onClick) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `choice-card choice-card--${tone}`;
  const text = document.createElement('p');
  text.className = 'choice-card__name';
  text.textContent = label;
  btn.appendChild(text);
  btn.addEventListener('click', onClick);
  return btn;
}

function buildEventSprite(src, alt) {
  const img = document.createElement('img');
  img.className = 'event-result__sprite';
  img.src = src;
  img.alt = alt || '';
  return img;
}

function buildEventText(text, className) {
  const p = document.createElement('p');
  p.className = className || 'event-modal__text';
  p.textContent = text;
  return p;
}

// Liste de sélection dans l'équipe, réutilisée par HIDDEN_TALENT et INSTANT_EVOLUTION
// (même forme d'action : { index }).
// options.allowSkip : ajoute un bouton "Passer" qui envoie { skip: true }.
// options.onPick : callback custom(index) — par défaut envoie { index }.
function renderEventTeamPicker(payload, hintText, options) {
  const opts = options || {};
  let skipBtn = null;

  eventBodyEl.appendChild(buildEventText(hintText, 'event-modal__hint'));

  const list = document.createElement('div');
  list.className = 'bonus-target-list';
  payload.team.forEach(mon => {
    const btn = buildTeamTargetButton(mon, () => {
      Array.from(list.children).forEach(b => { b.disabled = true; });
      if (skipBtn) skipBtn.disabled = true;
      (opts.onPick || (index => sendEventAction({ index })))(mon.index);
    });
    list.appendChild(btn);
  });
  eventBodyEl.appendChild(list);

  if (opts.allowSkip) {
    const wrap = document.createElement('div');
    wrap.className = 'event-modal__actions';
    skipBtn = document.createElement('button');
    skipBtn.type = 'button';
    skipBtn.className = 'btn btn--ghost btn--block';
    skipBtn.textContent = 'Passer';
    skipBtn.addEventListener('click', () => {
      Array.from(list.children).forEach(b => { b.disabled = true; });
      skipBtn.disabled = true;
      sendEventAction({ skip: true });
    });
    wrap.appendChild(skipBtn);
    eventBodyEl.appendChild(wrap);
  }
}

// ---- Démarrage (choix interactifs) ----

function renderDoubleEncounterStart(payload) {
  eventBodyEl.appendChild(buildEventText('Choisis le Pokémon à garder, ou passe ton tour.', 'event-modal__hint'));
  const row = document.createElement('div');
  row.className = 'choice-cards';
  payload.options.forEach((opt, optionIndex) => {
    row.appendChild(buildEventPokemonCard(opt, () => {
      renderDoubleEncounterReplaceStep(payload, optionIndex);
    }));
  });
  eventBodyEl.appendChild(row);

  const wrap = document.createElement('div');
  wrap.className = 'event-modal__actions';
  const skipBtn = document.createElement('button');
  skipBtn.type = 'button';
  skipBtn.className = 'btn btn--ghost btn--block';
  skipBtn.textContent = 'Passer';
  skipBtn.addEventListener('click', () => {
    Array.from(row.children).forEach(c => { c.disabled = true; });
    skipBtn.disabled = true;
    sendEventAction({ skip: true });
  });
  wrap.appendChild(skipBtn);
  eventBodyEl.appendChild(wrap);
}

// Étape locale (aucun aller-retour serveur) : une fois le Pokémon choisi, il faut
// dire lequel de l'équipe actuelle il remplace — l'équipe ne dépasse jamais 6.
function renderDoubleEncounterReplaceStep(payload, optionIndex) {
  eventBodyEl.innerHTML = '';
  renderEventTeamPicker(
    { team: payload.team },
    'Quel Pokémon de ton équipe remplacer ?',
    { onPick: replaceIndex => sendEventAction({ index: optionIndex, replaceIndex }) }
  );
}

function renderDoubleOrNothingStart(payload) {
  const info = document.createElement('div');
  info.className = 'event-result';
  info.appendChild(buildEventSprite(payload.pokemon.sprite, payload.pokemon.name));
  info.appendChild(buildEventText(`${payload.pokemon.name} — ${payload.currentPoints} PTS`));
  eventBodyEl.appendChild(info);
  eventBodyEl.appendChild(buildEventText('Risquer ce Pokémon ? Succès = ×2, échec = 0 point.', 'event-modal__hint'));

  const row = document.createElement('div');
  row.className = 'choice-cards';
  row.appendChild(buildEventChoiceButton('RISQUER', 'bas', () => {
    Array.from(row.children).forEach(b => { b.disabled = true; });
    sendEventAction({ risk: true });
  }));
  row.appendChild(buildEventChoiceButton('GARDER', 'haut', () => {
    Array.from(row.children).forEach(b => { b.disabled = true; });
    sendEventAction({ risk: false });
  }));
  eventBodyEl.appendChild(row);
}

function renderDuelStart(payload) {
  eventBodyEl.appendChild(buildEventText(
    `Face à ${payload.opponentName} — HAUT bat BAS, à choix égal c'est 50/50.`,
    'event-modal__hint'
  ));
  const row = document.createElement('div');
  row.className = 'choice-cards';
  row.appendChild(buildEventChoiceButton('🔼 HAUT', 'haut', () => {
    Array.from(row.children).forEach(b => { b.disabled = true; });
    sendEventAction({ choice: 'HAUT' });
  }));
  row.appendChild(buildEventChoiceButton('🔽 BAS', 'bas', () => {
    Array.from(row.children).forEach(b => { b.disabled = true; });
    sendEventAction({ choice: 'BAS' });
  }));
  eventBodyEl.appendChild(row);
}

function renderEventStart(payload) {
  activeEventType = payload.type;
  eventBodyEl.innerHTML = '';
  eventModalEl.dataset.eventType = payload.type;
  showEventOverlay(payload.label);

  switch (payload.type) {
    case 'DOUBLE_ENCOUNTER': renderDoubleEncounterStart(payload); break;
    case 'DOUBLE_OR_NOTHING': renderDoubleOrNothingStart(payload); break;
    case 'HIDDEN_TALENT':
      renderEventTeamPicker(
        payload,
        "Choisis le Pokémon qui reçoit le talent — c'est quitte ou double : le trait tiré au hasard peut être un bonus... ou un malus !",
        { allowSkip: true }
      );
      break;
    case 'INSTANT_EVOLUTION': renderEventTeamPicker(payload, 'Choisis le Pokémon qui évolue.'); break;
    case 'TIME_RIFT': renderTimeRiftStart(payload); break;
    case 'DUEL': renderDuelStart(payload); break;
    default: hideEventOverlay(); // type inconnu : ne jamais bloquer l'UI
  }
}

// ---- Résolution (résultats) ----

function renderDoubleEncounterResult(payload) {
  if (payload.skipped) {
    eventBodyEl.appendChild(buildEventText('Tu passes — rien ne change.'));
    eventBodyEl.appendChild(buildEventCloseButton());
    return;
  }
  const wrap = document.createElement('div');
  wrap.className = 'event-result';
  wrap.appendChild(buildEventSprite(payload.pokemon.sprite, payload.pokemon.name));
  wrap.appendChild(buildEventText(`${payload.pokemon.name} remplace ${payload.replacedName} !`));
  wrap.appendChild(buildDeltaLine(payload.scoreDelta));
  eventBodyEl.appendChild(wrap);
  eventBodyEl.appendChild(buildEventCloseButton());
  updateMyScore(payload.score, payload.scoreDelta);
}

function renderDoubleOrNothingResult(payload) {
  eventModalEl.dataset.outcome = payload.outcome;
  const wrap = document.createElement('div');
  wrap.className = 'event-result';
  let text = 'Tu gardes ton Pokémon tel quel.';
  if (payload.outcome === 'success') text = `${payload.pokemon.name} voit ses points doublés !`;
  else if (payload.outcome === 'fail') text = `${payload.pokemon.name} ne rapporte plus rien ce tour...`;
  wrap.appendChild(buildEventText(text));
  wrap.appendChild(buildDeltaLine(payload.scoreDelta));
  eventBodyEl.appendChild(wrap);
  eventBodyEl.appendChild(buildEventCloseButton());
  updateMyScore(payload.score, payload.scoreDelta);
}

function renderHiddenTalentResult(payload) {
  if (payload.skipped) {
    eventBodyEl.appendChild(buildEventText('Tu passes — rien ne change.'));
    eventBodyEl.appendChild(buildEventCloseButton());
    return;
  }
  const wrap = document.createElement('div');
  wrap.className = 'event-result';
  wrap.appendChild(buildEventSprite(payload.sprite, payload.pokemonName));
  if (payload.effect.name === GAMBLE_EFFECT_NAME) {
    const textEl = buildEventText(`${payload.pokemonName} reçoit : `);
    const rouletteEl = document.createElement('span');
    textEl.appendChild(rouletteEl);
    wrap.appendChild(textEl);
    const deltaEl = buildDeltaLine(payload.scoreDelta);
    deltaEl.style.visibility = 'hidden'; // révélé à l'arrêt de la roulette
    wrap.appendChild(deltaEl);
    playGambleRoulette(rouletteEl, payload.effect.multiplier, () => { deltaEl.style.visibility = ''; });
  } else {
    wrap.appendChild(buildEventText(`${payload.pokemonName} reçoit : ${formatEffect(payload.effect.name, payload.effect.multiplier, payload.effect.flat)}`));
    wrap.appendChild(buildDeltaLine(payload.scoreDelta));
  }
  eventBodyEl.appendChild(wrap);
  eventBodyEl.appendChild(buildEventCloseButton());
  updateMyScore(payload.score, payload.scoreDelta);
}

function renderInstantEvolutionResult(payload) {
  const wrap = document.createElement('div');
  wrap.className = 'event-result';
  wrap.appendChild(buildEventSprite(payload.sprite, payload.to));
  wrap.appendChild(buildEventText(`${payload.from} évolue en ${payload.to} !`));
  wrap.appendChild(buildDeltaLine(payload.scoreDelta));
  eventBodyEl.appendChild(wrap);
  eventBodyEl.appendChild(buildEventCloseButton());
  updateMyScore(payload.score, payload.scoreDelta);
}

function renderShinyResult(payload) {
  const wrap = document.createElement('div');
  wrap.className = 'event-result';
  const img = buildEventSprite(payload.pokemon.shinySprite || payload.pokemon.sprite, payload.pokemon.name);
  img.onerror = () => { img.src = payload.pokemon.sprite; }; // filet si le sprite shiny est indisponible
  wrap.appendChild(img);
  wrap.appendChild(buildEventText(`✨ ${payload.pokemon.name} devient chromatique !`));
  wrap.appendChild(buildDeltaLine(payload.scoreDelta));
  eventBodyEl.appendChild(wrap);
  eventBodyEl.appendChild(buildEventCloseButton());
  updateMyScore(payload.score, payload.scoreDelta);
}

function renderLuckyTurnResult(payload) {
  const label = RARITY_LABELS[payload.floorRarity] || payload.floorRarity;
  eventBodyEl.appendChild(buildEventText(`Ton prochain Pokémon sera au moins ${label} !`));
  eventBodyEl.appendChild(buildEventCloseButton());
}

function renderTimeRiftStart(payload) {
  eventModalEl.dataset.rarity = payload.pokemon.rarity;
  const wrap = document.createElement('div');
  wrap.className = 'event-result';
  wrap.appendChild(buildEventText("Une faille spatio-temporelle s'ouvre...", 'event-modal__hint'));
  wrap.appendChild(buildEventSprite(payload.pokemon.sprite, payload.pokemon.name));
  wrap.appendChild(buildEventText(`${payload.pokemon.name} — ${payload.pokemon.finalPoints} PTS`));
  eventBodyEl.appendChild(wrap);

  renderEventTeamPicker(
    payload,
    'Quel Pokémon de ton équipe remplacer ? (ou passe)',
    { allowSkip: true, onPick: replaceIndex => sendEventAction({ replaceIndex }) }
  );
}

function renderTimeRiftResult(payload) {
  if (payload.skipped) {
    eventBodyEl.appendChild(buildEventText('Tu passes — rien ne change.'));
    eventBodyEl.appendChild(buildEventCloseButton());
    return;
  }
  const wrap = document.createElement('div');
  wrap.className = 'event-result';
  wrap.appendChild(buildEventSprite(payload.pokemon.sprite, payload.pokemon.name));
  wrap.appendChild(buildEventText(`${payload.pokemon.name} remplace ${payload.replacedName} !`));
  wrap.appendChild(buildDeltaLine(payload.scoreDelta));
  eventBodyEl.appendChild(wrap);
  eventBodyEl.appendChild(buildEventCloseButton());
  updateMyScore(payload.score, payload.scoreDelta);
}

function renderCrossedFatesResult(payload) {
  const text = payload.subtype === 'linked'
    ? `Ton destin se lie à celui de ${payload.linkedPlayerName} pour le prochain tour.`
    : `${payload.linkedPlayerName} a joué son tour : tu reçois un petit bonus de rareté au prochain tirage !`;
  eventBodyEl.appendChild(buildEventText(text));
  eventBodyEl.appendChild(buildEventCloseButton());
}

function renderDuelResult(payload) {
  eventModalEl.dataset.outcome = payload.won ? 'won' : 'lost';
  const wrap = document.createElement('div');
  wrap.className = 'event-result';
  wrap.appendChild(buildEventText(payload.won ? 'Tu remportes le duel !' : 'Tu perds le duel (mais rien à perdre).'));
  wrap.appendChild(buildEventText(`Toi : ${payload.yourChoice} — Adversaire : ${payload.opponentChoice}`, 'event-result__line'));
  wrap.appendChild(buildDeltaLine(payload.pointsGained));
  eventBodyEl.appendChild(wrap);
  eventBodyEl.appendChild(buildEventCloseButton());
  updateMyScore(payload.score, payload.pointsGained);
}

function renderEventResult(payload) {
  const overlayOpen = !eventOverlayEl.classList.contains('screen--hidden');
  if (overlayOpen && activeEventType && activeEventType !== payload.type) {
    eventQueue.push(payload); // un autre événement est déjà affiché : jamais perdu, juste différé
    return;
  }

  activeEventType = payload.type;
  eventBodyEl.innerHTML = '';
  eventModalEl.dataset.eventType = payload.type;
  if (payload.rarity) eventModalEl.dataset.rarity = payload.rarity;
  else eventModalEl.removeAttribute('data-rarity');
  showEventOverlay(payload.label);

  switch (payload.type) {
    case 'DOUBLE_ENCOUNTER': renderDoubleEncounterResult(payload); break;
    case 'DOUBLE_OR_NOTHING': renderDoubleOrNothingResult(payload); break;
    case 'HIDDEN_TALENT': renderHiddenTalentResult(payload); break;
    case 'INSTANT_EVOLUTION': renderInstantEvolutionResult(payload); break;
    case 'SHINY_POKEMON': renderShinyResult(payload); break;
    case 'LUCKY_TURN': renderLuckyTurnResult(payload); break;
    case 'TIME_RIFT': renderTimeRiftResult(payload); break;
    case 'CROSSED_FATES': renderCrossedFatesResult(payload); break;
    case 'DUEL': renderDuelResult(payload); break;
    default: eventBodyEl.appendChild(buildEventCloseButton());
  }

  // Le score est géré par chaque renderXxxResult (le calcul du delta net diffère selon
  // le type, ex: skip = aucun changement). L'équipe, elle, suit toujours la même règle.
  if (payload.team) renderTeam(payload.team, true); // toujours ta propre équipe (résultat d'événement rare)
}


let activeBonusRouletteEl = null; // span de la roulette Reroll en cours (résultat d'objet)

function showBonusResult(data) {
  const titles = {
    xpCandy: 'Bonbon XP',
    mysteryItem: 'PSL',
    shinyCharm: 'Charme Chroma',
    megaGem: 'Méga Gemme',
    patchNote: 'Return To Zero',
    reroll: 'Reroll'
  };
  bonusResultTitleEl.textContent = titles[data.type] || '';
  if (activeBonusRouletteEl) { stopGambleRoulette(activeBonusRouletteEl); activeBonusRouletteEl = null; } // coupe une roulette précédente
  document.querySelectorAll('#bonus-result-panel .gamble-wheel').forEach(w => w.remove()); // roue d'un Reroll précédent (déjà terminée)

  if (data.type === 'shinyCharm') {
    bonusResultSpriteEl.classList.add('screen--hidden');
    bonusResultDetailEl.textContent = 'Actif toute la partie !';
    bonusResultFinalEl.textContent = '';
  } else if (data.type === 'megaGem') {
    bonusResultSpriteEl.classList.remove('screen--hidden');
    bonusResultSpriteEl.src = data.sprite;
    bonusResultDetailEl.textContent = `${data.shiny ? '✨ ' : ''}${data.from} → ${data.to}`;
    bonusResultFinalEl.textContent = `+${data.scoreDelta} PTS`;
  } else if (data.type === 'xpCandy') {
    bonusResultSpriteEl.classList.remove('screen--hidden');
    bonusResultSpriteEl.src = data.sprite;
    bonusResultDetailEl.textContent = `${data.from} → ${data.to}`;
    bonusResultFinalEl.textContent = `${data.scoreDelta >= 0 ? '+' : ''}${data.scoreDelta} PTS`;
  } else if (data.type === 'mysteryItem') {
    bonusResultSpriteEl.classList.remove('screen--hidden');
    bonusResultSpriteEl.src = data.sprite;
    bonusResultDetailEl.textContent = `${data.pokemonName} — ${formatEffect(data.effect.name, data.effect.multiplier, data.effect.flat)}`;
    bonusResultFinalEl.textContent = `${data.scoreDelta >= 0 ? '+' : ''}${data.scoreDelta} PTS`;
  } else if (data.type === 'patchNote') {
    bonusResultSpriteEl.classList.remove('screen--hidden');
    bonusResultSpriteEl.src = data.sprite;
    bonusResultDetailEl.textContent = `${data.pokemonName} — ${formatEffect(data.removed.name, data.removed.multiplier, data.removed.flat)} retiré`;
    bonusResultFinalEl.textContent = `${data.scoreDelta >= 0 ? '+' : ''}${data.scoreDelta} PTS`;
  } else if (data.type === 'reroll') {
    bonusResultSpriteEl.classList.remove('screen--hidden');
    bonusResultSpriteEl.src = data.sprite;
    const previousLabel = data.previous.name === 'Neutre'
      ? 'Neutre'
      : formatEffect(data.previous.name, data.previous.multiplier, data.previous.flat);
    bonusResultDetailEl.textContent = `${data.pokemonName} : ${previousLabel} → `;
    const rouletteEl = document.createElement('span');
    bonusResultDetailEl.appendChild(rouletteEl);
    activeBonusRouletteEl = rouletteEl;
    bonusResultFinalEl.textContent = '…'; // points révélés à l'arrêt de la roulette
    playTraitRoulette(rouletteEl, data.roulette, data.effect, () => {
      activeBonusRouletteEl = null;
      bonusResultFinalEl.textContent = `${data.scoreDelta >= 0 ? '+' : ''}${data.scoreDelta} PTS`;
    });
  }

  bonusResultPanelEl.classList.remove('result-panel--hidden');
  bonusResultPanelEl.classList.remove('result-panel--animate');
  void bonusResultPanelEl.offsetWidth; // force le reflow pour rejouer l'animation
  bonusResultPanelEl.classList.add('result-panel--animate');
}

// Le bouton Skip n'existe qu'en solo — le serveur revalide de toute façon ce point.
function updateSkipButton(players) {
  btnSkip.classList.toggle('screen--hidden', players.length !== 1);
}

function resetTurnUI() {
  hasChosenThisTurn = false;
  setChoiceButtonsEnabled(true);
  clearChoiceSelection();
  turnStatusEl.textContent = 'Choisis ton chemin';
  resultPanelEl.classList.add('result-panel--hidden');
  resultPanelEl.removeAttribute('data-rarity');
  bonusResultPanelEl.classList.add('result-panel--hidden');
}

// Nettoyage centralisé de l'écran de jeu. Remet tous les panneaux temporaires
// (fin de partie, résultats, phases du tour 4) en état caché/inactif, et réinitialise
// l'état local. Appelé à chaque (re)démarrage de partie pour garantir qu'aucun élément
// de l'ancienne partie ne persiste visuellement. Ne préjuge jamais du tour serveur :
// se contente de vider l'affichage, le prochain événement serveur reconstruit l'état réel.
function resetGameUI() {
  clearError();

  // Écran de fin
  screenFinished.classList.add('screen--hidden');
  finishedResultsEl.innerHTML = '';
  finishedMyTeamEl.innerHTML = '';
  finishedOutcomeEl.textContent = '';
  finishedOutcomeEl.classList.remove('finished-outcome--victory', 'finished-outcome--defeat');
  finishedModifiersEl.innerHTML = '';
  finishedModifiersEl.classList.add('screen--hidden');
  finishedModifiersNoteEl.classList.add('screen--hidden');
  gameModifiersEl.innerHTML = '';
  gameModifiersEl.classList.add('screen--hidden');
  finishedDifficultyEl.textContent = '';
  finishedDifficultyEl.classList.remove('finished-difficulty-badge--easy', 'finished-difficulty-badge--medium', 'finished-difficulty-badge--hard', 'finished-difficulty-badge--extreme');
  btnReplay.classList.add('screen--hidden');
  finishedStatusEl.textContent = '';

  // Résultats de tour / bonus
  resultPanelEl.classList.add('result-panel--hidden');
  resultPanelEl.classList.remove('result-panel--animate');
  resultPanelEl.removeAttribute('data-rarity');
  bonusResultPanelEl.classList.add('result-panel--hidden');
  bonusResultPanelEl.classList.remove('result-panel--animate');
  metamorphResultPanelEl.classList.add('result-panel--hidden');
  clearTimeout(metamorphResultTimer);

  // Phases du tour : rien de visible tant que le serveur n'en indique pas une
  // (choice/admin-view sont mutuellement exclusifs). L'overlay de cible d'objet et le
  // mini-inventaire sont indépendants de ces phases (cf. showBonusTargetOverlay/hideBonusTargetOverlay).
  showTurnPhase('none');
  hideBonusTargetOverlay();
  bonusTargetListEl.innerHTML = '';
  itemInventoryBarEl.classList.remove('item-inventory-bar--visible');
  btnUseItem.disabled = true;
  itemSelectOverlayEl.classList.add('screen--hidden'); // filet de sécurité (your_item la masque déjà normalement)

  // Choix HAUT/BAS
  clearChoiceSelection();
  setChoiceButtonsEnabled(false);
  hasChosenThisTurn = false;
  turnStatusEl.textContent = 'Choisis ton chemin';

  // Skip
  btnSkip.classList.add('screen--hidden');

  // Événements rares : jamais de résidu d'une ancienne partie (nettoyage direct,
  // sans passer par hideEventOverlay() pour ne pas re-déclencher la file d'attente).
  eventOverlayEl.classList.add('screen--hidden');
  eventBodyEl.innerHTML = '';
  eventModalEl.removeAttribute('data-event-type');
  eventModalEl.removeAttribute('data-outcome');
  eventModalEl.removeAttribute('data-rarity');
  activeEventType = null;
  eventQueue = [];

  // Équipe / score / route
  teamSlotsEl.innerHTML = '';
  routeTrackEl.innerHTML = '';
  routeStepEls = [];
  lastTeamSize = 0;
  lastRenderedTurn = 0;
  myScoreValueEl.textContent = '0';
  myScoreLabelEl.textContent = 'Ton score';
  myScorePopupEl.textContent = '';
  myScorePopupEl.classList.remove('my-score-popup--play', 'my-score-popup--negative');
}

function applyGameState({ status, turn, maxTurns, route, players, bossAttackTargetId }) {
  flashTurnLabel(turn);
  turnCurrentEl.textContent = turn;
  turnMaxEl.textContent = maxTurns;
  renderRoute(route);
  updateBossProximity(turn, maxTurns);
  updateSkipButton(players);
  renderPlayers(gamePlayersListEl, players);
  renderMatchupBanner(gameMatchupRefs, players);

  // Coop : recalculé à chaque update depuis les scores individuels déjà présents dans
  // `players` (jamais stocké séparément) — visible juste au-dessus de la liste des
  // joueurs, là où chacun voit déjà les scores de ses coéquipiers monter en direct.
  if (currentGameMode === 'coop' && coopTeamRequired != null) {
    const teamScore = players.reduce((sum, p) => sum + p.score, 0);
    teamScoreLineEl.textContent = `Score d'équipe : ${teamScore} / ${coopTeamRequired} pts`;
    teamScoreLineEl.classList.remove('screen--hidden');
  } else {
    teamScoreLineEl.classList.add('screen--hidden');
  }

  // Attaque du boss (Coop) : bannière visible de TOUTE l'équipe (cible incluse), pour que
  // les autres sachent que ses gains ce tour seront réduits et compensent si besoin.
  if (currentGameMode === 'coop' && bossAttackTargetId) {
    const target = players.find(p => p.id === bossAttackTargetId);
    const targetName = bossAttackTargetId === myId ? 'toi' : (target ? target.name : 'un coéquipier');
    bossAttackBannerEl.textContent = `⚡ Le boss attaque ${targetName} ce tour !`;
    bossAttackBannerEl.classList.remove('screen--hidden');
  } else {
    bossAttackBannerEl.classList.add('screen--hidden');
  }

  // Mode ADMIN VS JOUEUR : l'ADMIN n'a ni score ni équipe (cf. spec section 3) — le
  // panneau "score" affiche celui du JOUEUR observé, jamais le sien (toujours à 0).
  const observed = isAdminNow() ? players.find(p => p.id !== currentAdminId) : players.find(p => p.id === myId);
  if (observed) {
    renderTeam(observed.team, !isAdminNow()); // ADMIN observe en lecture seule, jamais interactif
    renderTypeBonusPanel(observed.typeBonus);
    myScoreValueEl.textContent = observed.score;
    if (!isAdminNow() && observed.hasChosen) {
      setChoiceButtonsEnabled(false);
      turnStatusEl.textContent = 'En attente des autres joueurs...';
    }
  }
}

// ---------- Actions : accueil ----------
btnCreate.addEventListener('click', () => {
  clearError();
  const name = pseudoInput.value.trim();
  if (!name) {
    showError('Entre un pseudo.');
    return;
  }
  socket.emit('create_game', { name, token: deviceToken, avatar: getStoredAccount()?.avatar || null, accessToken: getStoredAccount()?.accessToken || null });
});

btnJoin.addEventListener('click', () => {
  clearError();
  const name = pseudoInput.value.trim();
  const code = codeInput.value.trim();
  if (!name) {
    showError('Entre un pseudo.');
    return;
  }
  if (!code) {
    showError('Entre un code de partie.');
    return;
  }
  socket.emit('join_game', { name, gameId: code, token: deviceToken, avatar: getStoredAccount()?.avatar || null, accessToken: getStoredAccount()?.accessToken || null });
});

codeInput.addEventListener('input', () => {
  codeInput.value = codeInput.value.toUpperCase();
});

// ---------- Actions : lobby ----------
btnStart.addEventListener('click', () => {
  socket.emit('start_game');
});

btnLeave.addEventListener('click', () => {
  socket.emit('leave_game');
  rememberActiveGame(null);
  showScreen(screenHome);
});

// Barre d'amis persistante du lobby : toujours visible (si connecté), pas de clic pour
// l'ouvrir — remplace l'ancien panneau "Inviter un ami" replié par défaut. Les amis EN
// LIGNE apparaissent en premier avec un bouton "Inviter" direct sur leur avatar ; les
// hors-ligne suivent, grisés, sans action. Rafraîchie à chaque entrée dans le lobby (cf.
// showScreen) pour ne jamais montrer un statut périmé.
async function refreshLobbyFriendsBar() {
  const account = getStoredAccount();
  if (!account) return;
  lobbyFriendsBarListEl.innerHTML = '<p class="lobby-friends-bar__loading">Chargement...</p>';
  try {
    const res = await fetch('/api/friends/list', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accessToken: account.accessToken })
    });
    const data = await res.json();
    lobbyFriendsBarListEl.innerHTML = '';
    const friends = (data.friends || []).slice().sort((a, b) => (b.online ? 1 : 0) - (a.online ? 1 : 0));
    if (!res.ok || !friends.length) {
      const empty = document.createElement('p');
      empty.className = 'lobby-friends-bar__loading';
      empty.textContent = 'Aucun ami pour le moment.';
      lobbyFriendsBarListEl.appendChild(empty);
      return;
    }
    friends.forEach(entry => {
      const chip = document.createElement(entry.online ? 'button' : 'div');
      chip.className = 'friend-chip' + (entry.online ? ' friend-chip--online' : ' friend-chip--offline');
      if (entry.online) chip.type = 'button';
      chip.title = entry.online ? `Inviter ${entry.pseudo}` : `${entry.pseudo} (hors ligne)`;

      const avatar = document.createElement('img');
      avatar.className = 'friend-chip__avatar';
      avatar.src = entry.avatar ? avatarUrl(entry.avatar) : '';
      avatar.alt = '';
      chip.appendChild(avatar);

      const dot = document.createElement('span');
      dot.className = 'friend-chip__dot';
      chip.appendChild(dot);

      const name = document.createElement('span');
      name.className = 'friend-chip__name';
      name.textContent = entry.pseudo;
      chip.appendChild(name);

      if (entry.online) {
        chip.addEventListener('click', () => {
          socket.emit('invite_friend', { friendUserId: entry.id, fromPseudo: account.pseudo, fromAvatar: account.avatar });
          chip.classList.add('friend-chip--sent');
          chip.disabled = true;
          name.textContent = 'Invité !';
          setTimeout(() => { chip.disabled = false; name.textContent = entry.pseudo; chip.classList.remove('friend-chip--sent'); }, 2500);
        });
      }

      lobbyFriendsBarListEl.appendChild(chip);
    });
  } catch (err) {
    lobbyFriendsBarListEl.innerHTML = '<p class="lobby-friends-bar__loading">Amis indisponibles pour le moment.</p>';
  }
}

// Invitation reçue d'un ami en ligne (cf. socket.on('invite_friend') côté serveur) : un
// toast avec un bouton direct pour rejoindre — jamais besoin de redemander le code.
socket.on('friend_game_invite', ({ gameId, fromPseudo, fromAvatar }) => {
  const toast = document.createElement('div');
  toast.className = 'achievement-toast';

  const icon = document.createElement('img');
  icon.className = 'friend-invite-toast__avatar';
  icon.src = fromAvatar ? avatarUrl(fromAvatar) : '';
  icon.alt = '';

  const body = document.createElement('div');
  const eyebrow = document.createElement('p');
  eyebrow.className = 'achievement-toast__eyebrow';
  eyebrow.textContent = 'Invitation';
  const label = document.createElement('p');
  label.className = 'achievement-toast__label';
  label.textContent = `${fromPseudo} t'invite à jouer !`;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn btn--haut btn--block';
  btn.textContent = 'Rejoindre';
  btn.addEventListener('click', () => {
    const account = getStoredAccount();
    const name = (account && account.pseudo) || pseudoInput.value.trim();
    if (!name) return;
    socket.emit('join_game', { name, gameId, token: deviceToken, avatar: account?.avatar || null, accessToken: account?.accessToken || null });
    toast.remove();
  });
  body.appendChild(eyebrow);
  body.appendChild(label);
  body.appendChild(btn);

  toast.appendChild(icon);
  toast.appendChild(body);
  friendInviteToastContainerEl.appendChild(toast);

  setTimeout(() => toast.remove(), 15000); // laisse plus de temps qu'un succès (décision à prendre, pas juste à lire)
});

// Un seul jeu de listeners pour les 4 boutons de difficulté, enregistrés une seule fois
// au chargement (comme tous les autres listeners du fichier). Le serveur revalide de
// toute façon que l'émetteur est bien l'hôte : ce garde-fou côté client n'est qu'un confort.
difficultyButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    if (!isHost()) return;
    socket.emit('set_difficulty', { difficulty: btn.dataset.difficulty });
  });
});

// Même principe pour le mode de jeu. Les boutons du picker ADMIN, eux, sont créés
// dynamiquement dans renderAdminRoleOptions() (leur nombre dépend des joueurs présents).
gamemodeButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    if (!isHost()) return;
    socket.emit('set_game_mode', { mode: btn.dataset.mode });
  });
});

guessDurationButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    if (!isHost()) return;
    socket.emit('set_guess_turn_duration', { durationMs: Number(btn.dataset.duration) });
  });
});

auctionTypeButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    if (!isHost()) return;
    socket.emit('set_auction_type', { auctionType: btn.dataset.auctiontype });
  });
});

btnCopyCode.addEventListener('click', async () => {
  const code = gameCodeEl.textContent.trim();
  try {
    await navigator.clipboard.writeText(code);
  } catch (err) {
    // Solution de repli pour navigateurs sans API Clipboard / contexte non sécurisé
    const tmpInput = document.createElement('input');
    tmpInput.value = code;
    document.body.appendChild(tmpInput);
    tmpInput.select();
    document.execCommand('copy');
    document.body.removeChild(tmpInput);
  }
  copyFeedbackEl.textContent = 'Code copié !';
  copyFeedbackEl.classList.remove('copy-feedback--play');
  void copyFeedbackEl.offsetWidth;
  copyFeedbackEl.classList.add('copy-feedback--play');
});

btnCopyLink.addEventListener('click', async () => {
  const code = gameCodeEl.textContent.trim();
  const link = `${location.origin}${location.pathname}?code=${code}`;
  try {
    await navigator.clipboard.writeText(link);
  } catch (err) {
    // Même solution de repli que btnCopyCode ci-dessus.
    const tmpInput = document.createElement('input');
    tmpInput.value = link;
    document.body.appendChild(tmpInput);
    tmpInput.select();
    document.execCommand('copy');
    document.body.removeChild(tmpInput);
  }
  copyFeedbackEl.textContent = 'Lien copié !';
  copyFeedbackEl.classList.remove('copy-feedback--play');
  void copyFeedbackEl.offsetWidth;
  copyFeedbackEl.classList.add('copy-feedback--play');
});

// ---------- Actions : jeu ----------
btnHaut.addEventListener('click', () => {
  if (hasChosenThisTurn) return;
  hasChosenThisTurn = true;
  setChoiceButtonsEnabled(false);
  markChoiceSelected(btnHaut, btnBas);
  turnStatusEl.textContent = 'Choix enregistré !';
  playClickSound();
  socket.emit('player_choice', { choice: 'HAUT' });
});

btnBas.addEventListener('click', () => {
  if (hasChosenThisTurn) return;
  hasChosenThisTurn = true;
  setChoiceButtonsEnabled(false);
  markChoiceSelected(btnBas, btnHaut);
  turnStatusEl.textContent = 'Choix enregistré !';
  playClickSound();
  socket.emit('player_choice', { choice: 'BAS' });
});

// ---------- Actions : objet de départ (avant tour 1) et inventaire (à tout moment) ----------
startItemCards.forEach(card => {
  card.btn.addEventListener('click', () => {
    startItemCards.forEach(c => { c.btn.disabled = true; });
    itemSelectStatusEl.classList.remove('screen--hidden');
    socket.emit('starting_item_choice', { key: card.btn.dataset.key });
  });
});

btnUseItem.addEventListener('click', () => {
  socket.emit('use_item');
});

btnBonusTargetCancel.addEventListener('click', () => {
  hideBonusTargetOverlay();
  socket.emit('item_cancel'); // libère le choix en attente côté serveur : l'objet n'est pas consommé
});

btnSkip.addEventListener('click', () => {
  finishAllGambleWheels(); // la roue saute à son résultat, comme le reste de la révélation
  socket.emit('skip_reveal');
});

btnLeaveGame.addEventListener('click', () => {
  socket.emit('leave_game');
  rememberActiveGame(null);
  resetGameUI();
  showScreen(screenHome);
});

btnLeaveFinished.addEventListener('click', () => {
  socket.emit('leave_game');
  rememberActiveGame(null);
  resetGameUI();
  showScreen(screenHome);
});

btnReplay.addEventListener('click', () => {
  socket.emit('play_again');
});

// ---------- Événements serveur : lobby ----------
socket.on('connect', () => {
  myId = socket.id;
  identifyAccountIfLoggedIn(); // présence en ligne pour les amis, cf. socket.on('identify_account') côté serveur
  // Se déclenche à la toute première connexion ET après chaque reconnexion automatique
  // de socket.io (coupure réseau brève) : dans les deux cas, s'il existe une partie
  // enregistrée ET que la reconnexion automatique n'est pas désactivée (cf. Réglages >
  // Partie), on tente de reprendre exactement là où on en était. loadSettings() est déjà
  // exécutable ici (contrairement au bloc tout en haut du fichier) : ce handler ne
  // s'exécute qu'après un vrai aller-retour réseau, donc bien après que sa déclaration,
  // plus bas dans ce même fichier, ait déjà tourné.
  const gameId = localStorage.getItem('routeduboss_active_game');
  const autoReconnect = loadSettings().autoReconnect !== false;
  if (gameId && autoReconnect) {
    socket.emit('rejoin_game', { gameId, token: deviceToken });
  } else if (gameId) {
    // Reconnexion automatique désactivée : on abandonne toute tentative de reprise pour
    // cette ancienne partie (jamais contactée) et on revient à un accueil normal, y
    // compris si l'écran "Reconnexion..." était affiché (réglage changé entre-temps).
    endReconnectAttempt();
  }
});

socket.on('rejoin_success', (payload) => {
  endReconnectAttempt();
  isSpectating = false;
  hostId = payload.hostId;
  currentGameMode = payload.gameMode || 'normal';
  currentAdminId = payload.adminId || null;
  currentActivePlayerIds = payload.activePlayerIds || [];
  rememberActiveGame(payload.gameId);
  loadChatHistory(payload.chatMessages); // reprend la discussion en cours, jamais un reset (cf. resetChatPanel)

  // Mode "Devine le Pokémon" : structure d'état complètement différente (planche/secret/
  // tour chronométré, aucun boss/route/équipe) — reconstruction dédiée, jamais via
  // applyGameStarted/applyGameFinished qui supposent ces champs Route du Boss présents.
  if (payload.gameMode === 'guess') {
    if (payload.status === 'waiting') {
      resetGameUI();
      gameCodeEl.textContent = payload.gameId;
      renderLobbyPlayers(payload.players);
      renderDifficulty(payload.difficulty);
      renderGameMode(payload.gameMode);
      updateHostControls();
      showScreen(screenLobby);
    } else if (payload.status === 'playing') {
      resetGuessUI();
      guessBoard = payload.guessBoard || [];
      guessMySecretIndex = payload.mySecretIndex !== undefined ? payload.mySecretIndex : null;
      renderGuessPlayers(payload.players);

      if (guessMySecretIndex === null) {
        // Toujours en phase de sélection : la planche redevient cliquable pour choisir.
        renderGuessBoard();
        showScreen(screenGuess);
      } else if (payload.guessActivePlayerId) {
        // Les 2 secrets étaient déjà choisis : reprend directement le tour en cours.
        renderGuessBoard();
        showScreen(screenGuess);
        const isMe = payload.guessActivePlayerId === myId;
        guessActivePlayerId = payload.guessActivePlayerId;
        guessSelectionPanelEl.classList.add('screen--hidden');
        guessTurnPanelEl.classList.remove('screen--hidden');
        guessActiveNameEl.textContent = guessPlayerName(payload.guessActivePlayerId);
        guessTurnHintEl.textContent = isMe
          ? 'Pose tes questions à ton adversaire via Discord.'
          : `${guessPlayerName(payload.guessActivePlayerId)} réfléchit...`;
        guessActiveActionsEl.classList.toggle('screen--hidden', !isMe);
        if (payload.guessTurnEndsAt) startGuessTimerDisplay(payload.guessTurnEndsAt);
      } else {
        // Cas limite : mon secret est choisi mais pas encore celui de l'adversaire.
        guessSelectionStatusEl.textContent = 'Pokémon secret sélectionné. En attente de l\'adversaire...';
        renderGuessBoard();
        showScreen(screenGuess);
      }
    } else if (payload.status === 'finished') {
      resetGuessUI();
      lastGuessPlayers = payload.players;
      // Pas assez d'info pour redistinguer victoire/défaite/forfait après coup sans
      // guess_game_over (diffusé seulement au moment réel, jamais renvoyé par rejoin) :
      // affichage neutre plutôt qu'un mauvais verdict inventé.
      guessFinishedOutcomeEl.textContent = 'Partie terminée.';
      guessFinishedOutcomeEl.classList.remove('finished-outcome--victory', 'finished-outcome--defeat');
      guessFinishedDetailEl.innerHTML = '';
      updateGuessReplayControls();
      showScreen(screenGuessFinished);
    }
    return;
  }

  // Mode "Draft/Enchères" : idem, structure d'état dédiée (budget/équipe/lot en cours,
  // aucun boss/route) — jamais via applyGameStarted/applyGameFinished.
  if (payload.gameMode === 'auction') {
    if (payload.status === 'waiting') {
      resetGameUI();
      gameCodeEl.textContent = payload.gameId;
      renderLobbyPlayers(payload.players);
      renderDifficulty(payload.difficulty);
      renderGameMode(payload.gameMode);
      renderAuctionType(payload.auctionType);
      updateHostControls();
      showScreen(screenLobby);
    } else if (payload.status === 'playing') {
      resetAuctionUI();
      renderAuctionPlayers(payload.players);
      updateAuctionBidAvailability();
      showScreen(screenAuction);
      // Le lot en cours (sprite/prix/enchère/timer) arrive juste après via un
      // auction_lot_started ciblé (cf. socket.on('rejoin_game') côté serveur) : rien de
      // plus à reconstruire ici en attendant.
    } else if (payload.status === 'finished') {
      resetAuctionUI();
      renderAuctionFinished({ reason: null, players: payload.players, history: payload.auctionHistory });
    }
    return;
  }

  if (payload.status === 'waiting') {
    resetGameUI();
    gameCodeEl.textContent = payload.gameId;
    renderLobbyPlayers(payload.players);
    renderDifficulty(payload.difficulty);
    renderGameMode(payload.gameMode);
    renderModifiers(payload.modifiers);
    updateHostControls();
    showScreen(screenLobby);
  } else if (payload.status === 'playing') {
    // applyGameState() (appelée par applyGameStarted) gère déjà l'état "en attente des
    // autres" si ce joueur avait déjà choisi ce tour — rien à dupliquer ici. S'il n'avait
    // PAS encore choisi, le serveur envoie séparément turn_options/player_turn_hidden/
    // admin_view_turn_options juste après rejoin_success (cf. socket.on('rejoin_game')
    // côté serveur), qui prendront le relais pour l'interactivité.
    applyGameStarted({
      status: payload.status,
      turn: payload.turn,
      maxTurns: payload.maxTurns,
      route: payload.route,
      boss: payload.boss,
      players: payload.players,
      gameMode: payload.gameMode,
      adminId: payload.adminId,
      modifiers: payload.modifiers
    });
  } else if (payload.status === 'finished') {
    applyGameFinished({
      boss: payload.boss,
      difficulty: payload.difficulty,
      gameMode: payload.gameMode,
      adminId: payload.adminId,
      reason: null,
      players: payload.players,
      modifiers: payload.modifiers
    });
  }
});

// Token invalide, partie introuvable, ou délai de grâce déjà expiré : la reconnexion
// automatique ne peut pas aboutir, retour silencieux à l'écran d'accueil normal (rien
// à récupérer, pas la peine d'afficher une erreur pour un cas aussi ordinaire).
socket.on('rejoin_failed', () => {
  rememberActiveGame(null);
  endReconnectAttempt();
});

socket.on('game_created', ({ gameId, players, hostId: hId, difficulty, gameMode, adminId, activePlayerIds, guessTurnDurationMs, auctionType, modifiers }) => {
  resetGameUI();
  isSpectating = false;
  hostId = hId;
  gameCodeEl.textContent = gameId;
  currentAdminId = adminId || null;
  currentActivePlayerIds = activePlayerIds || [];
  rememberActiveGame(gameId);
  renderLobbyPlayers(players);
  renderDifficulty(difficulty);
  renderGameMode(gameMode);
  renderGuessDuration(guessTurnDurationMs);
  renderAuctionType(auctionType);
  renderModifiers(modifiers);
  updateHostControls();
  showScreen(screenLobby);
});

socket.on('game_joined', ({ gameId, players, hostId: hId, difficulty, gameMode, adminId, activePlayerIds, guessTurnDurationMs, auctionType, modifiers }) => {
  resetGameUI();
  isSpectating = false;
  hostId = hId;
  gameCodeEl.textContent = gameId;
  currentAdminId = adminId || null;
  currentActivePlayerIds = activePlayerIds || [];
  rememberActiveGame(gameId);
  renderLobbyPlayers(players);
  renderDifficulty(difficulty);
  renderGameMode(gameMode);
  renderGuessDuration(guessTurnDurationMs);
  renderAuctionType(auctionType);
  renderModifiers(modifiers);
  updateHostControls();
  showScreen(screenLobby);
});

socket.on('game_replayed', ({ gameId, players, hostId: hId, difficulty, gameMode, adminId, activePlayerIds, guessTurnDurationMs, auctionType, modifiers }) => {
  // Diffusé à tout le nouveau salon (io.to(newGameId).emit), donc reçu aussi par un
  // spectateur transféré depuis l'ancienne partie (cf. socket.on('play_again') côté
  // serveur) : celui-ci vient de recevoir SON propre spectate_joined juste avant, il ne
  // doit surtout pas être traité comme un membre du lobby ici.
  if (isSpectating) return;

  resetGameUI();
  hostId = hId;
  gameCodeEl.textContent = gameId;
  copyFeedbackEl.textContent = '';
  copyFeedbackEl.classList.remove('copy-feedback--play');
  currentAdminId = adminId || null;
  currentActivePlayerIds = activePlayerIds || [];
  rememberActiveGame(gameId);
  renderLobbyPlayers(players);
  renderDifficulty(difficulty);
  renderGameMode(gameMode);
  renderGuessDuration(guessTurnDurationMs);
  renderAuctionType(auctionType);
  renderModifiers(modifiers);
  updateHostControls();
  showScreen(screenLobby);
});

// Un invité voit la difficulté changer en direct quand l'hôte la modifie (source de
// vérité = serveur ; ce n'est jamais le client qui décide ce qui s'affiche ici).
socket.on('difficulty_updated', ({ difficulty }) => {
  renderDifficulty(difficulty);
});

// Idem pour le mode de jeu : changer de mode réinitialise toujours adminId ET
// auctionType côté serveur (cf. set_game_mode), donc tout se met à jour ensemble ici.
socket.on('game_mode_updated', ({ gameMode, adminId, activePlayerIds, auctionType }) => {
  currentAdminId = adminId || null;
  currentActivePlayerIds = activePlayerIds || [];
  renderGameMode(gameMode);
  renderAuctionType(auctionType);
});

// Modificateurs de partie : confirmés par le serveur (ou vidés quand l'hôte change vers un
// mode qui ne les gère pas, cf. set_game_mode).
socket.on('modifiers_updated', ({ modifiers }) => {
  renderModifiers(modifiers);
});

// Le rôle ADMIN change (hôte uniquement) : les deux joueurs voient le nouveau choix en direct.
socket.on('admin_role_updated', ({ adminId }) => {
  currentAdminId = adminId || null;
  renderAdminRoleOptions();
});

// Idem pour la sélection des 2 joueurs actifs (mode admin/guess à >2 joueurs dans le lobby).
socket.on('active_players_updated', ({ activePlayerIds, adminId }) => {
  currentActivePlayerIds = activePlayerIds || [];
  if (adminId !== undefined) currentAdminId = adminId || null;
  renderActivePlayersOptions();
  renderAdminRoleOptions();
});

// Idem pour la durée des tours en mode "guess" (hôte uniquement, avant le lancement).
socket.on('guess_turn_duration_updated', ({ turnDurationMs }) => {
  renderGuessDuration(turnDurationMs);
});

// Idem pour le type de draft en mode "auction" (hôte uniquement, avant le lancement).
socket.on('auction_type_updated', ({ auctionType }) => {
  renderAuctionType(auctionType);
});

socket.on('players_updated', ({ players, hostId: hId }) => {
  hostId = hId;
  renderLobbyPlayers(players);
  // renderGameMode() dépend de lastLobbyPlayers.length pour son message d'aide (guess/
  // auction : "il manque des joueurs" vs "choisis..."). Sans ce ré-appel, le message
  // restait figé sur l'état du tout premier rendu (ex: création de partie à 1 joueur)
  // même après qu'un 2e joueur ait rejoint le lobby.
  renderGameMode(currentGameMode);
  updateHostControls();
});

// ---------- Événements serveur : jeu ----------
function applyGameStarted({ status, turn, maxTurns, route, boss, players, gameMode, adminId, modifiers }) {
  resetGameUI(); // aucun résidu de l'ancienne partie ; masque aussi le choix tour 4 par défaut
  resetChatPanel(); // nouvelle partie = discussion vierge
  currentGameMode = gameMode || 'normal';
  currentAdminId = adminId || null;
  myScoreLabelEl.textContent = isAdminNow() ? 'Score du joueur' : 'Ton score';
  coopTeamRequired = currentGameMode === 'coop' ? boss.teamRequiredPoints : null;
  // Coop : l'objectif affiché est celui de L'ÉQUIPE (la vraie condition de victoire, cf.
  // finishGame côté serveur) — le seuil individuel n'a pas de sens ici.
  bossTarget = coopTeamRequired != null ? coopTeamRequired : boss.requiredPoints;
  bossSpriteEl.src = boss.sprite;
  bossNameEl.textContent = boss.name.toUpperCase();
  bossTargetValueEl.textContent = bossTarget;
  renderBossTypeInfo(boss);
  lastGameModifiers = Array.isArray(modifiers) ? modifiers : [];
  renderModifierBadges(gameModifiersEl, lastGameModifiers);
  applyGameState({ status, turn, maxTurns, route, players });
  showScreen(screenGame);
}

socket.on('game_started', (payload) => {
  if (isSpectating) {
    // Le salon reçoit game_started en broadcast room-wide ; un spectateur présent au
    // moment où l'hôte relance (Rejouer -> Démarrer) ne doit PAS basculer sur
    // applyGameStarted (vue joueur, non pertinente pour lui) mais rafraîchir SA vue
    // en lecture seule avec l'état frais de la partie qui vient de démarrer.
    spectateBoss = payload.boss;
    renderSpectateView(payload);
    return;
  }
  applyGameStarted(payload);
});

// Options individuelles du joueur pour ce tour : sprite + nom visibles, points/effet cachés.
// display remis à '' au cas où le panneau vient d'un tour caché (mode ADMIN VS JOUEUR,
// cf. player_turn_hidden) — sinon le sprite resterait masqué même une fois repeuplé.
socket.on('turn_options', ({ haut, bas }) => {
  finishAllGambleWheels(); // nouveau tour : aucune roue ne doit continuer à tourner
  choiceHautSpriteEl.style.display = '';
  choiceHautSpriteEl.src = pokemonSprite(haut);
  choiceHautSpriteEl.onerror = haut.shiny ? () => { choiceHautSpriteEl.src = haut.sprite; } : null;
  choiceHautNameEl.textContent = haut.name.toUpperCase();
  choiceCardsEl.querySelector('.choice-card--haut').classList.toggle('choice-card--shiny', !!haut.shiny);

  choiceBasSpriteEl.style.display = '';
  choiceBasSpriteEl.src = pokemonSprite(bas);
  choiceBasSpriteEl.onerror = bas.shiny ? () => { choiceBasSpriteEl.src = bas.sprite; } : null;
  choiceBasNameEl.textContent = bas.name.toUpperCase();
  choiceCardsEl.querySelector('.choice-card--bas').classList.toggle('choice-card--shiny', !!bas.shiny);

  showTurnPhase('choice');
  resetTurnUI();
});

// Mode ADMIN VS JOUEUR — reçu UNIQUEMENT par le socket ADMIN. Contient les données
// complètes des 2 options : jamais envoyé au JOUEUR (cf. player_turn_hidden ci-dessous).
socket.on('admin_view_turn_options', (payload) => {
  renderAdminViewOptions(payload);
  showTurnPhase('admin-view');
  turnStatusEl.textContent = "Tu es l'ADMIN — indique au JOUEUR ce que tu vois (ou mens-lui).";
});

// Mode ADMIN VS JOUEUR — reçu UNIQUEMENT par le socket JOUEUR. Ne contient aucune donnée
// de Pokémon : le serveur ne l'envoie tout simplement pas (cf. assignAdminModeOptions),
// donc rien à cacher ici côté client. Le sprite est complètement MASQUÉ (display: none),
// pas juste vidé (src="") : un <img> sans src affiche quand même un cadre/icône "image
// cassée" dans la plupart des navigateurs — visuellement sale et jamais voulu ici, on ne
// doit voir que "???".
socket.on('player_turn_hidden', () => {
  choiceHautSpriteEl.style.display = 'none';
  choiceHautSpriteEl.removeAttribute('src');
  choiceHautNameEl.textContent = '???';
  choiceCardsEl.querySelector('.choice-card--haut').classList.remove('choice-card--shiny');

  choiceBasSpriteEl.style.display = 'none';
  choiceBasSpriteEl.removeAttribute('src');
  choiceBasNameEl.textContent = '???';
  choiceCardsEl.querySelector('.choice-card--bas').classList.remove('choice-card--shiny');

  showTurnPhase('choice');
  resetTurnUI();
  turnStatusEl.textContent = "Écoute les indications de l'ADMIN.";
});

// Objet de départ (avant tour 1, cf. start_game) : le lobby reste affiché dessous, cet
// overlay prend toute la place tant que tout le monde n'a pas choisi.
socket.on('item_select_started', () => {
  startItemCards.forEach(c => { c.btn.disabled = false; });
  itemSelectStatusEl.classList.add('screen--hidden');
  itemSelectOverlayEl.classList.remove('screen--hidden');
});

// Les 2 objets tirés par le serveur pour CE joueur (jamais choisis par le client).
socket.on('starting_item_options', ({ bonuses }) => {
  startItemCards.forEach((card, i) => {
    const bonus = bonuses[i];
    card.btn.classList.toggle('screen--hidden', !bonus);
    if (!bonus) return;
    card.btn.dataset.key = bonus.key;
    card.icon.textContent = ITEM_ICONS[bonus.key] || '🎁';
    card.label.textContent = bonus.label;
    card.desc.textContent = BONUS_DESCRIPTIONS[bonus.key] || '';
  });
});

// Confirmation de l'objet retenu pour cette partie (envoyé une fois au choix, puis re-
// envoyé par le serveur juste avant game_started pour être sûr que le client soit synchro).
socket.on('your_item', ({ item, used, passive }) => {
  itemSelectOverlayEl.classList.add('screen--hidden');
  if (!item) {
    itemInventoryBarEl.classList.remove('item-inventory-bar--visible');
    return;
  }
  itemInventoryBarEl.classList.add('item-inventory-bar--visible');
  itemInventoryIconEl.textContent = ITEM_ICONS[item] || '🎁';
  const name = BONUS_LABELS_CLIENT[item] || '';
  // Objet passif (Charme Chroma) : simple rappel "actif", jamais cliquable.
  btnUseItem.classList.toggle('item-inventory-btn--passive', !!passive);
  itemInventoryLabelEl.textContent = passive ? `${name} · actif` : name;
  btnUseItem.disabled = !!used;
  btnUseItem.title = passive
    ? 'Effet passif : actif toute la partie'
    : (used ? 'Déjà utilisé' : `Utiliser : ${name}`);
});

// Bonbon XP : uniquement les Pokémon réellement évoluables (filtré côté serveur).
socket.on('xp_candy_pending', ({ team }) => {
  bonusTargetTitleEl.textContent = 'Choisis un Pokémon à faire évoluer';
  renderBonusTargetList(team, (index) => {
    hideBonusTargetOverlay();
    socket.emit('xp_candy_select', { index });
  });
  showBonusTargetOverlay();
});

// Méga Gemme : uniquement les Pokémon de TON équipe qui ont une Méga-Évolution (filtré côté
// serveur, qui modifie ensuite ce Pokémon précis — aucun Pokémon n'est ajouté).
socket.on('mega_gem_pending', ({ team }) => {
  bonusTargetTitleEl.textContent = 'Choisis un Pokémon à Méga-Évoluer';
  renderBonusTargetList(team, (index) => {
    hideBonusTargetOverlay();
    socket.emit('mega_gem_select', { index });
  });
  showBonusTargetOverlay();
});

// PSL : toute l'équipe, le trait (Beauty privilege) est appliqué par le serveur.
socket.on('mystery_item_pending', ({ team }) => {
  bonusTargetTitleEl.textContent = 'Choisis un Pokémon';
  renderBonusTargetList(team, (index) => {
    hideBonusTargetOverlay();
    socket.emit('mystery_item_select', { index });
  });
  showBonusTargetOverlay();
});

// Return To Zero : uniquement les Pokémon qui ont un malus (filtré côté serveur, revalidé à la sélection).
socket.on('patch_note_pending', ({ team }) => {
  bonusTargetTitleEl.textContent = 'Choisis un Pokémon à nettoyer';
  renderBonusTargetList(team, (index) => {
    hideBonusTargetOverlay();
    socket.emit('patch_note_select', { index });
  });
  showBonusTargetOverlay();
});

// Reroll : toute l'équipe (sauf Métamorph transformé) ; le trait est tiré par le serveur.
socket.on('reroll_pending', ({ team }) => {
  bonusTargetTitleEl.textContent = 'Choisis un Pokémon à relancer';
  renderBonusTargetList(team, (index) => {
    hideBonusTargetOverlay();
    socket.emit('reroll_select', { index });
  });
  showBonusTargetOverlay();
});

// Résultat final de l'objet utilisé (quel que soit son type) : objet consommé, retiré
// de l'inventaire (bouton désactivé) — jamais lié à un tour précis désormais.
socket.on('bonus_result', (data) => {
  hideBonusTargetOverlay();
  btnUseItem.disabled = true;
  btnUseItem.title = 'Déjà utilisé';
  showBonusResult(data);
  if (data.team) renderTeam(data.team, true); // toujours ta propre équipe
  updateMyScore(data.score, data.scoreDelta);
});

socket.on('choice_result', ({ pokemon, rarity, basePoints, effect, pointsGained, bossAttackHit, typeBonusDelta, typeBonus, score, team }) => {
  resultPanelEl.dataset.rarity = rarity || 'commun'; // rareté fournie par le serveur, jamais déterminée ici
  resultPanelEl.classList.toggle('result-panel--shiny', !!pokemon.shiny);
  resultRarityEl.textContent = RARITY_LABELS[rarity] || '';
  resultSpriteEl.src = pokemonSprite(pokemon);
  resultSpriteEl.onerror = pokemon.shiny ? () => { resultSpriteEl.src = pokemon.sprite; } : null;
  resultNameEl.textContent = pokemon.shiny ? `✨ ${pokemon.name.toUpperCase()}` : pokemon.name.toUpperCase();
  renderTypeBadges(resultTypesEl, pokemon.types); // types fournis par le serveur
  resultBaseEl.textContent = basePoints;
  const effectBonus = isBonusEffect(effect.multiplier, effect.flat);
  const shinySuffix = pokemon.shiny ? ` · Shiny ×${SHINY_POINTS_MULTIPLIER}` : '';
  stopGambleRoulette(resultEffectEl); // coupe une roulette encore en cours (tirage précédent)
  resultEffectEl.classList.toggle('result-effect--bonus', effectBonus);
  resultEffectEl.classList.toggle('result-effect--malus', !effectBonus);
  if (effect.name === GAMBLE_EFFECT_NAME) {
    // LET'S GO GAMBLING : roulette, les points ne sont révélés qu'à l'arrêt.
    resultPointsEl.textContent = '…';
    playGambleRoulette(resultEffectEl, effect.multiplier, () => {
      resultEffectEl.textContent += shinySuffix;
      resultPointsEl.textContent = pointsGained;
    }, { duration: 2600, spins: 3 }); // tient dans REVEAL_DELAY_MS (4 s) avec ~1,4 s pour lire le résultat
  } else {
    resultEffectEl.textContent = formatEffect(effect.name, effect.multiplier, effect.flat) + shinySuffix;
    resultPointsEl.textContent = pointsGained;
  }
  resultBossAttackEl.classList.toggle('screen--hidden', !bossAttackHit);
  // Bonus de type de CE tirage (faiblesse du nouveau Pokémon + variation d'affinité), fourni par le serveur.
  resultTypeBonusEl.textContent = typeBonusDelta ? `Bonus de type : ${typeBonusDelta > 0 ? '+' : ''}${typeBonusDelta} PTS` : '';
  resultTypeBonusEl.classList.toggle('screen--hidden', !typeBonusDelta);
  renderTypeBonusPanel(typeBonus);
  resultPanelEl.classList.remove('result-panel--hidden');
  playRevealAnimation();
  playRevealSound();
  renderTeam(team, true); // toujours ta propre équipe (résultat de ton propre choix)
  updateMyScore(score, pointsGained + (typeBonusDelta || 0));
});

// Bonus de type recalculé par le serveur (après tirage, évolution, Méga, événement...) : affichage seul.
socket.on('type_bonus_updated', (detail) => {
  if (!isSpectating) renderTypeBonusPanel(detail);
});

socket.on('game_updated', ({ status, turn, maxTurns, route, players, hostId: hId, adminId, bossAttackTargetId }) => {
  if (hId) hostId = hId;
  if (adminId !== undefined) currentAdminId = adminId;
  if (isSpectating) {
    renderSpectateView({ status, turn, maxTurns, boss: spectateBoss, players });
    return;
  }
  applyGameState({ status, turn, maxTurns, route, players, bossAttackTargetId });
});

// Équipe finale détaillée du joueur : sprite + nom + trait (si non neutre) + évolution
// éventuelle (Bonbon XP). Réutilise la même structure de slot que .team-slot en jeu.
function renderFinishedTeam(team) {
  finishedMyTeamEl.innerHTML = '';
  for (let i = 0; i < 6; i++) {
    const slot = document.createElement('div');
    slot.className = 'team-slot finished-team-slot';
    const mon = team[i];

    if (mon) {
      const img = document.createElement('img');
      img.src = pokemonSprite(mon);
      img.alt = mon.name;
      if (mon.shiny) {
        img.onerror = () => { img.src = mon.sprite; };
        slot.classList.add('finished-team-slot--shiny');
      }
      slot.appendChild(img);

      const label = document.createElement('p');
      label.className = 'finished-team-slot__name';
      label.textContent = mon.name;
      slot.appendChild(label);

      if (mon.evolvedFrom || mon.megaFrom) {
        const evoTag = document.createElement('p');
        evoTag.className = 'finished-team-slot__evo';
        evoTag.textContent = mon.megaFrom
          ? `${mon.megaFrom} → ${mon.name} (Méga Gemme)`
          : `${mon.evolvedFrom} → ${mon.name} (Bonbon XP)`;
        slot.appendChild(evoTag);
      }

      if (mon.types) {
        const typesRow = document.createElement('div');
        typesRow.className = 'type-badges type-badges--small';
        renderTypeBadges(typesRow, mon.types);
        slot.appendChild(typesRow);
        // Détail du score : composantes envoyées par le serveur (jamais recalculées ici).
        const detail = document.createElement('p');
        detail.className = 'finished-team-slot__detail';
        const parts = [`Base ${mon.basePoints}`];
        if (mon.multiplier !== 1 || !mon.flat) parts.push(`Trait ×${formatMultiplier(mon.multiplier)}`);
        if (mon.flat) parts.push(`Trait ${mon.flat > 0 ? '+' : ''}${mon.flat}`);
        if (mon.shiny && !mon.shinyInMultiplier) parts.push(`Shiny ×${SHINY_POINTS_MULTIPLIER}`);
        if (mon.typeMult && mon.typeMult !== 1) parts.push(`Type ×${formatMultiplier(mon.typeMult)} (${mon.typeBonus > 0 ? '+' : ''}${mon.typeBonus})`);
        detail.textContent = parts.join(' · ');
        slot.appendChild(detail);
      }

      if (mon.effectName && mon.effectName !== 'Neutre') {
        const traitTag = document.createElement('p');
        traitTag.className = `finished-team-slot__trait ${isBonusEffect(mon.multiplier, mon.flat) ? 'finished-team-slot__trait--bonus' : 'finished-team-slot__trait--malus'}`;
        traitTag.textContent = formatEffect(mon.effectName, mon.multiplier, mon.flat);
        slot.appendChild(traitTag);
      }
    }

    finishedMyTeamEl.appendChild(slot);
  }
}

function ordinalFr(rank) {
  return rank === 1 ? '1er' : `${rank}e`;
}

// Easter egg Métamorph : révélation claire ("Métamorphe se transforme ??!") avec le
// Pokémon copié et le delta de points, affichée quelques secondes puis masquée seule.
function showMetamorphResult({ targetName, sprite, scoreDelta }) {
  metamorphResultSpriteEl.src = sprite;
  metamorphResultDetailEl.textContent = `Copie de ${targetName}`;
  const sign = scoreDelta > 0 ? '+' : '';
  metamorphResultFinalEl.textContent = `${sign}${scoreDelta} PTS`;
  metamorphResultFinalEl.classList.toggle('result-effect--bonus', scoreDelta >= 0);
  metamorphResultFinalEl.classList.toggle('result-effect--malus', scoreDelta < 0);
  metamorphResultPanelEl.classList.remove('result-panel--hidden');

  clearTimeout(metamorphResultTimer);
  metamorphResultTimer = setTimeout(() => {
    metamorphResultPanelEl.classList.add('result-panel--hidden');
  }, 4000);
}

socket.on('metamorph_transformed', ({ score, scoreDelta, team, targetName, sprite }) => {
  renderTeam(team, true);
  updateMyScore(score, scoreDelta);
  showMetamorphResult({ targetName, sprite, scoreDelta });
});

function applyGameFinished({ boss, difficulty, gameMode, adminId, reason, players, teamScore, teamRequired, modifiers }) {
  finishAllGambleWheels();
  // Le rôle a pu changer entre le dernier game_started reçu (aucun risque en pratique
  // puisqu'il est verrouillé après start_game, mais on resynchronise par cohérence).
  currentGameMode = gameMode || currentGameMode;
  currentAdminId = adminId !== undefined ? adminId : currentAdminId;

  const me = players.find(p => p.id === myId);
  // Mode ADMIN VS JOUEUR : l'ADMIN n'a ni score ni équipe propres — l'écran final lui
  // montre ceux du JOUEUR observé (cf. spec section 20 : "l'ADMIN peut également voir
  // le résumé [de l'équipe du JOUEUR]").
  const observed = isAdminNow() ? players.find(p => p.id !== currentAdminId) : me;

  const outcomeText = (me && me.result === 'victory' ? 'VICTOIRE !' : 'DÉFAITE') + (reason === 'forfeit' ? ' (forfait)' : '');
  finishedOutcomeEl.textContent = outcomeText;
  finishedOutcomeEl.classList.toggle('finished-outcome--victory', !!me && me.result === 'victory');
  finishedOutcomeEl.classList.toggle('finished-outcome--defeat', !!me && me.result !== 'victory');
  if (me && me.result === 'victory') playVictorySound(); else playDefeatSound();

  finishedBossSpriteEl.src = boss.sprite;
  finishedBossNameEl.textContent = boss.name.toUpperCase();
  finishedDifficultyEl.textContent = DIFFICULTY_LABELS[difficulty] || '';
  lastGameModifiers = Array.isArray(modifiers) ? modifiers : [];
  renderModifierBadges(finishedModifiersEl, lastGameModifiers);
  finishedModifiersNoteEl.classList.toggle('screen--hidden', lastGameModifiers.length === 0);
  renderTypeBadges(finishedBossTypesEl, boss.types);
  const tb = observed && observed.typeBonus;
  if (tb && boss.typeRules) {
    const aff = tb.affinity;
    finishedTypeBonusEl.textContent = `Bonus de type : +${tb.total} pts (faiblesses +${tb.weakness}`
      + `${boss.typeRules.affinity.enabled ? `, affinité ${typeLabel(aff.counterType)} +${aff.bonus}` : ''})`;
    finishedTypeBonusEl.classList.remove('screen--hidden');
  } else {
    finishedTypeBonusEl.classList.add('screen--hidden');
  }
  ['easy', 'medium', 'hard', 'extreme'].forEach(d => {
    finishedDifficultyEl.classList.toggle(`finished-difficulty-badge--${d}`, d === difficulty);
  });
  const isCoop = gameMode === 'coop' && teamRequired != null;
  finishedTargetEl.textContent = `${isCoop ? teamRequired : boss.requiredPoints} PTS`;
  finishedTeamStatEl.classList.toggle('screen--hidden', !isCoop);
  if (isCoop) finishedTeamScoreEl.textContent = `${teamScore} PTS`;
  finishedMyScoreLabelEl.textContent = isAdminNow() ? 'Score du joueur' : 'Ton score';
  finishedMyTeamLabelEl.textContent = isAdminNow() ? 'Équipe du joueur' : 'Ton équipe';
  finishedMyScoreEl.textContent = `${observed ? observed.score : 0} PTS`;

  if (observed) renderFinishedTeam(observed.team);

  finishedResultsEl.innerHTML = '';

  updateReplayControls();

  const ranked = [...players].sort((a, b) => b.score - a.score);
  ranked.forEach((p, index) => {
    const rank = index + 1;
    const card = document.createElement('div');
    card.className = `finished-card finished-card--${p.result}`;
    if (rank <= 3) card.classList.add(`finished-card--rank-${rank}`);

    const rankEl = document.createElement('span');
    rankEl.className = 'finished-card__rank';
    rankEl.textContent = ordinalFr(rank);

    const info = document.createElement('div');
    info.className = 'finished-card__info';

    const nameRow = document.createElement('div');
    nameRow.className = 'finished-card__name-row';

    const identity = document.createElement('div');
    identity.className = 'finished-card__identity';

    if (p.avatar) {
      const avatarImg = document.createElement('img');
      avatarImg.className = 'finished-card__avatar';
      avatarImg.src = avatarUrl(p.avatar);
      avatarImg.alt = '';
      identity.appendChild(avatarImg);
    }

    const name = document.createElement('p');
    name.className = 'finished-card__name';
    // Mode ADMIN VS JOUEUR : précise le rôle à côté du pseudo (l'ADMIN a un score à 0,
    // sinon incompréhensible dans le classement/badge).
    name.textContent = currentGameMode === 'admin'
      ? `${p.name} (${p.id === currentAdminId ? 'ADMIN' : 'JOUEUR'})`
      : p.name;
    identity.appendChild(name);

    const score = document.createElement('p');
    score.className = 'finished-card__score';
    score.textContent = `${p.score} PTS`;

    nameRow.appendChild(identity);
    nameRow.appendChild(score);

    const teamRow = document.createElement('div');
    teamRow.className = 'finished-card__team';
    p.team.forEach(mon => {
      const img = document.createElement('img');
      img.src = pokemonSprite(mon);
      img.alt = mon.name;
      img.title = mon.shiny ? `${mon.name} ✨` : mon.name;
      if (mon.shiny) img.onerror = () => { img.src = mon.sprite; };
      teamRow.appendChild(img);
    });

    info.appendChild(nameRow);
    info.appendChild(teamRow);

    const badge = document.createElement('p');
    badge.className = 'finished-card__badge';
    badge.textContent = p.result === 'victory' ? 'VICTOIRE !' : 'DÉFAITE';

    card.appendChild(rankEl);
    card.appendChild(info);
    card.appendChild(badge);
    finishedResultsEl.appendChild(card);
  });

  showScreen(screenFinished);
}

socket.on('game_finished', (payload) => {
  resetRecapCard(); // le récap de la partie précédente ne doit jamais rester affiché
  refreshAccountFromServer(); // XP gagnée pendant la partie (cf. awardXp côté serveur)
  if (isSpectating) {
    // Même logique que game_started ci-dessus : un spectateur reste dans le salon
    // jusqu'à la fin de partie, mais ne doit jamais atterrir sur #screen-finished (vue
    // joueur avec "ton score"/"ton équipe", sans objet pour lui).
    spectateBoss = payload.boss;
    renderSpectateView({ status: 'finished', boss: payload.boss, players: payload.players, gameMode: payload.gameMode });
    return;
  }
  applyGameFinished(payload);
});

// Peut arriver après la fin de N'IMPORTE quel mode (normal/admin/guess/auction, cf.
// recordGameResult côté serveur) : un seul listener global plutôt que dupliqué dans
// chaque handler de fin de partie. Purement informatif — le succès est déjà enregistré
// en base au moment où cet event arrive, ce toast ne fait qu'informer le joueur tout de
// suite plutôt que de le laisser le découvrir à la prochaine ouverture des Réglages.
socket.on('achievements_unlocked', ({ achievements }) => {
  (achievements || []).forEach(a => showAchievementToast(a));
});

// ---------- Récap de fin de partie ----------
// Envoyé par le serveur juste après game_finished ('game_recap' : traits, Gambling, pire choix)
// puis, un peu plus tard si le joueur est connecté, 'game_recap_new' (Pokémon jamais obtenus
// avant cette partie). Tout est calculé côté serveur ; ici : affichage uniquement.
let lastRecap = null;
let lastRecapNew = null;

function resetRecapCard() {
  lastRecap = null;
  lastRecapNew = null;
  const old = document.getElementById('finished-recap');
  if (old) old.remove();
}

function signedPts(n) {
  return `${n > 0 ? '+' : ''}${n} PTS`;
}

function renderRecapCard() {
  const old = document.getElementById('finished-recap');
  if (old) old.remove();
  if (!finishedMyTeamEl || !finishedMyTeamEl.parentElement) return;

  const rows = [];
  const r = lastRecap;
  if (r) {
    if (r.bestTrait) rows.push({ icon: '🏆', label: 'Meilleur trait', sprite: r.bestTrait.sprite,
      text: `${formatEffect(r.bestTrait.trait.name, r.bestTrait.trait.multiplier, r.bestTrait.trait.flat)} — ${r.bestTrait.pokemonName}`,
      value: signedPts(r.bestTrait.gain), up: true });
    if (r.worstTrait) rows.push({ icon: '💀', label: 'Pire trait', sprite: r.worstTrait.sprite,
      text: `${formatEffect(r.worstTrait.trait.name, r.worstTrait.trait.multiplier, r.worstTrait.trait.flat)} — ${r.worstTrait.pokemonName}`,
      value: signedPts(r.worstTrait.gain), up: false });
    if (r.bigGamble) rows.push({ icon: '🎰', label: 'Plus gros Gambling', sprite: r.bigGamble.sprite,
      text: `×${formatMultiplier(r.bigGamble.roll)} — ${r.bigGamble.pokemonName}`,
      value: signedPts(r.bigGamble.gain), up: r.bigGamble.gain >= 0 });
    if (r.worstChoice) rows.push({ icon: '🤦', label: 'Pire choix', sprite: null,
      text: `Tour ${r.worstChoice.turn} : ${r.worstChoice.chosenName} (${r.worstChoice.chosenPoints} pts) au lieu de ${r.worstChoice.otherName} (${r.worstChoice.otherPoints} pts)`,
      value: signedPts(-r.worstChoice.regret), up: false });
  }
  const hasNew = Array.isArray(lastRecapNew) && lastRecapNew.length > 0;
  if (!rows.length && !hasNew) return;

  const card = document.createElement('div');
  card.id = 'finished-recap';
  card.className = 'finished-recap';
  const title = document.createElement('h3');
  title.className = 'finished-recap__title';
  title.textContent = 'Récap de ta partie';
  card.appendChild(title);

  rows.forEach(row => {
    const el = document.createElement('div');
    el.className = 'finished-recap__row';
    const icon = document.createElement('span');
    icon.className = 'finished-recap__icon';
    icon.textContent = row.icon;
    el.appendChild(icon);
    if (row.sprite) {
      const img = document.createElement('img');
      img.className = 'finished-recap__sprite';
      img.src = row.sprite;
      img.alt = '';
      el.appendChild(img);
    }
    const body = document.createElement('div');
    body.className = 'finished-recap__body';
    const label = document.createElement('span');
    label.className = 'finished-recap__label';
    label.textContent = row.label;
    const text = document.createElement('span');
    text.className = 'finished-recap__text';
    text.textContent = row.text;
    body.appendChild(label);
    body.appendChild(text);
    el.appendChild(body);
    const value = document.createElement('span');
    value.className = 'finished-recap__value ' + (row.up ? 'finished-recap__value--up' : 'finished-recap__value--down');
    value.textContent = row.value;
    el.appendChild(value);
    card.appendChild(el);
  });

  if (hasNew) {
    const el = document.createElement('div');
    el.className = 'finished-recap__row finished-recap__row--new';
    const icon = document.createElement('span');
    icon.className = 'finished-recap__icon';
    icon.textContent = '✨';
    el.appendChild(icon);
    const body = document.createElement('div');
    body.className = 'finished-recap__body';
    const label = document.createElement('span');
    label.className = 'finished-recap__label';
    label.textContent = lastRecapNew.length > 1 ? `${lastRecapNew.length} nouveaux Pokémon (Pokédex)` : 'Nouveau Pokémon (Pokédex)';
    body.appendChild(label);
    const chips = document.createElement('div');
    chips.className = 'finished-recap__chips';
    lastRecapNew.forEach(p => {
      const chip = document.createElement('span');
      chip.className = 'finished-recap__chip';
      const img = document.createElement('img');
      img.src = p.shiny && p.shinySprite ? p.shinySprite : p.sprite;
      img.alt = '';
      const name = document.createElement('span');
      name.textContent = p.name;
      chip.appendChild(img);
      chip.appendChild(name);
      chips.appendChild(chip);
    });
    body.appendChild(chips);
    el.appendChild(body);
    card.appendChild(el);
  }
  finishedMyTeamEl.insertAdjacentElement('afterend', card);
}

socket.on('game_recap', (recap) => {
  lastRecap = recap;
  renderRecapCard();
});

socket.on('game_recap_new', ({ newPokemon }) => {
  lastRecapNew = newPokemon;
  renderRecapCard();
});

// ---------- Événements serveur : événements rares ----------
// Peuvent arriver à tout moment pendant screen-game, indépendamment du flux de tour
// normal (le serveur ne bloque jamais la progression des autres joueurs pour ça).
socket.on('rare_event_start', (payload) => {
  renderEventStart(payload);
});

socket.on('rare_event_result', (payload) => {
  renderEventResult(payload);
});

// DUEL : l'autre joueur n'a pas encore répondu. Rien de nouveau à choisir ici.
socket.on('rare_event_waiting', () => {
  eventBodyEl.innerHTML = '';
  eventBodyEl.appendChild(buildEventText('En attente de la réponse de ton adversaire...', 'event-modal__hint'));
});

// L'adversaire d'un DUEL a quitté avant la résolution : on ne laisse jamais l'overlay
// bloqué indéfiniment.
socket.on('rare_event_cancelled', () => {
  eventBodyEl.innerHTML = '';
  eventBodyEl.appendChild(buildEventText("L'autre joueur a quitté la partie. Événement annulé."));
  eventBodyEl.appendChild(buildEventCloseButton());
});

socket.on('error_message', (msg) => {
  // #error-message vit dans #screen-home (cf. style.css) : invisible sur tout autre
  // écran. Pendant une enchère, une erreur de mise (montant invalide, budget dépassé...)
  // doit apparaître là où le joueur regarde, donc routée vers le hint dédié.
  if (document.body.dataset.screen === 'auction') {
    auctionBidHintEl.textContent = msg;
    return;
  }
  showError(msg);
});

// ============================================================
// MODE "DEVINE LE POKÉMON"
// ============================================================
// Écran entièrement séparé de Route du Boss/Admin (aucun boss/route/équipe/points ici) :
// planche partagée, Pokémon secret, tours chronométrés. Réutilise uniquement le socle
// commun (salon/lobby/reconnexion/REJOUER), jamais game_started/applyGameState.

// ---------- Éléments DOM ----------
const btnLeaveGuess = document.getElementById('btn-leave-guess');
const guessSelectionPanelEl = document.getElementById('guess-selection-panel');
const guessSelectionStatusEl = document.getElementById('guess-selection-status');
const guessTurnPanelEl = document.getElementById('guess-turn-panel');
const guessActiveNameEl = document.getElementById('guess-active-name');
const guessTurnHintEl = document.getElementById('guess-turn-hint');
const guessTimerBarEl = document.getElementById('guess-timer-bar');
const guessTimerValueEl = document.getElementById('guess-timer-value');
const guessActiveActionsEl = document.getElementById('guess-active-actions');
const btnGuessAnswer = document.getElementById('btn-guess-answer');
const btnGuessFinishTurn = document.getElementById('btn-guess-finish-turn');
const guessLastAttemptEl = document.getElementById('guess-last-attempt');
const guessBoardEl = document.getElementById('guess-board');
const guessPlayersListEl = document.getElementById('guess-players-list');
const guessMatchupRefs = {
  meAvatar: document.getElementById('guess-matchup-me-avatar'),
  meName: document.getElementById('guess-matchup-me-name'),
  oppAvatar: document.getElementById('guess-matchup-opp-avatar'),
  oppName: document.getElementById('guess-matchup-opp-name')
};
const guessMySecretEl = document.getElementById('guess-my-secret');
const guessMySecretSpriteEl = document.getElementById('guess-my-secret-sprite');
const guessMySecretNameEl = document.getElementById('guess-my-secret-name');
const guessConfirmOverlayEl = document.getElementById('guess-confirm-overlay');
const guessConfirmContentEl = document.getElementById('guess-confirm-content');
const btnGuessConfirmCancel = document.getElementById('btn-guess-confirm-cancel');
const btnGuessConfirmOk = document.getElementById('btn-guess-confirm-ok');
const guessFinishedOutcomeEl = document.getElementById('guess-finished-outcome');
const guessFinishedDetailEl = document.getElementById('guess-finished-detail');
const btnGuessReplay = document.getElementById('btn-guess-replay');
const guessFinishedStatusEl = document.getElementById('guess-finished-status');
const btnLeaveGuessFinished = document.getElementById('btn-leave-guess-finished');

// ---------- État local ----------
// currentGuessTurnDurationMs (déclarée plus haut, section lobby) sert aussi ici pour le
// calcul de la barre de temps : purement cosmétique, le serveur seul fait foi pour
// l'expiration réelle (turnEndsAt).
let guessBoard = [];
let guessMySecretIndex = null; // ma propre sélection UNIQUEMENT (jamais celle de l'adversaire)
let guessActivePlayerId = null;
let guessTimerInterval = null;
let guessBoardMode = 'select-secret'; // 'select-secret' | 'idle' | 'guessing'
let guessPendingAttemptIndex = null;
let lastGuessPlayers = [];
// Cases que JE coche personnellement comme "pas ça" en cliquant en dehors du mode
// "Dire ma réponse" (aide-mémoire type Qui est-ce ?). Purement local : jamais envoyé au
// serveur, jamais synchronisé avec l'adversaire — jamais un vrai deuxième bit de secret.
let guessHintedIndexes = new Set();

function resetGuessUI() {
  guessBoard = [];
  guessMySecretIndex = null;
  guessActivePlayerId = null;
  guessBoardMode = 'select-secret';
  guessPendingAttemptIndex = null;
  lastGuessPlayers = [];
  guessHintedIndexes = new Set();
  clearInterval(guessTimerInterval);

  guessSelectionPanelEl.classList.remove('screen--hidden');
  guessSelectionStatusEl.textContent = 'Clique sur une case de la planche.';
  guessTurnPanelEl.classList.add('screen--hidden');
  guessActiveActionsEl.classList.add('screen--hidden');
  guessLastAttemptEl.classList.add('screen--hidden');
  guessConfirmOverlayEl.classList.add('screen--hidden');
  guessBoardEl.innerHTML = '';
  guessPlayersListEl.innerHTML = '';
  btnGuessAnswer.textContent = 'Dire ma réponse';

  guessMySecretEl.classList.add('screen--hidden');
  guessMySecretSpriteEl.src = '';
  guessMySecretNameEl.textContent = '';
}

// Affiche/actualise la case fixe du bas avec le Pokémon secret du joueur local.
function renderGuessMySecret() {
  if (guessMySecretIndex === null || !guessBoard[guessMySecretIndex]) {
    guessMySecretEl.classList.add('screen--hidden');
    return;
  }
  const mon = guessBoard[guessMySecretIndex];
  guessMySecretSpriteEl.src = mon.sprite;
  guessMySecretSpriteEl.alt = mon.name;
  guessMySecretNameEl.textContent = mon.name;
  guessMySecretEl.classList.remove('screen--hidden');
}

// Nom d'un joueur à partir de la dernière liste connue (jamais son secret, juste son nom).
function guessPlayerName(id) {
  if (id === myId) return 'Toi';
  const p = lastGuessPlayers.find(x => x.id === id);
  return p ? p.name : 'Ton adversaire';
}

function renderGuessPlayers(players) {
  lastGuessPlayers = players;
  renderMatchupBanner(guessMatchupRefs, players);
  guessPlayersListEl.innerHTML = '';
  players.forEach(p => {
    const li = document.createElement('li');
    li.classList.toggle('player-item--disconnected', !!p.disconnected);

    const name = document.createElement('span');
    name.textContent = p.name;
    if (p.id === hostId) {
      const hostTag = document.createElement('span');
      hostTag.className = 'player-host';
      hostTag.textContent = 'Hôte';
      name.appendChild(hostTag);
    }
    if (p.disconnected) {
      const offlineTag = document.createElement('span');
      offlineTag.className = 'player-offline';
      offlineTag.textContent = 'Hors ligne';
      name.appendChild(offlineTag);
    }

    const status = document.createElement('span');
    status.className = 'player-score';
    const ready = p.id === myId ? guessMySecretIndex !== null : p.secretSelected;
    status.textContent = ready ? 'Prêt ✓' : 'En attente';

    li.appendChild(name);
    li.appendChild(status);
    guessPlayersListEl.appendChild(li);
  });
}

// La planche est TOUJOURS cliquable (cf. handleGuessTileClick pour ce que fait
// réellement un clic selon le contexte : choisir son secret, cocher une aide
// personnelle, ou tenter une réponse). Seule exception : plus aucune interaction utile
// une fois mon propre secret déjà choisi ET qu'on n'est pas encore en phase de tours
// (l'adversaire n'a pas fini de choisir) — cocher des aides reste possible même là,
// ça ne gêne rien.
function renderGuessBoard() {
  guessBoardEl.innerHTML = '';

  // Nombre de colonnes calculé pour approcher un carré (au lieu de dépendre de la
  // largeur du conteneur comme avec auto-fill) : cols = ceil(sqrt(n)), rows en découle.
  const cols = Math.max(1, Math.ceil(Math.sqrt(guessBoard.length)));
  guessBoardEl.style.setProperty('--guess-cols', cols);

  guessBoard.forEach(mon => {
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = 'guess-tile guess-tile--clickable';
    if (mon.index === guessMySecretIndex) tile.classList.add('guess-tile--mine');
    if (guessHintedIndexes.has(mon.index)) tile.classList.add('guess-tile--hinted');

    const img = document.createElement('img');
    img.src = mon.sprite;
    img.alt = mon.name;

    const name = document.createElement('span');
    name.className = 'guess-tile__name';
    name.textContent = mon.name;

    tile.appendChild(img);
    tile.appendChild(name);
    tile.addEventListener('click', () => handleGuessTileClick(mon.index));

    guessBoardEl.appendChild(tile);
  });

  renderGuessMySecret();
}

function setGuessBoardMode(mode) {
  guessBoardMode = mode;
  renderGuessBoard();
}

// Un clic sur une case ne veut pas dire la même chose selon le contexte :
// - Phase de sélection, secret pas encore choisi -> choisit CE Pokémon comme secret.
// - Mode "guessing" (après avoir cliqué "Dire ma réponse") -> ouvre la confirmation
//   de tentative.
// - Tout le reste du temps (y compris pendant l'attente, pendant son propre tour sans
//   avoir cliqué "Dire ma réponse", ou pendant le tour de l'adversaire) -> simple
//   coche personnelle "pas ça" (aide-mémoire, jamais envoyée au serveur).
function handleGuessTileClick(index) {
  playClickSound();
  if (guessBoardMode === 'select-secret' && guessMySecretIndex === null) {
    socket.emit('select_secret_pokemon', { index });
    return;
  }
  if (guessBoardMode === 'guessing') {
    openGuessConfirm(index);
    return;
  }
  toggleGuessHint(index);
}

function toggleGuessHint(index) {
  if (guessHintedIndexes.has(index)) guessHintedIndexes.delete(index);
  else guessHintedIndexes.add(index);
  renderGuessBoard();
}

function openGuessConfirm(index) {
  guessPendingAttemptIndex = index;
  const mon = guessBoard[index];

  guessConfirmContentEl.innerHTML = '';
  const img = document.createElement('img');
  img.src = mon.sprite;
  img.alt = mon.name;
  const p = document.createElement('p');
  p.textContent = `Tu es sûr de vouloir répondre : ${mon.name} ?`;
  const warning = document.createElement('p');
  warning.className = 'guess-confirm-warning';
  warning.textContent = 'Ça termine ton tour, bonne ou mauvaise réponse.';
  guessConfirmContentEl.appendChild(img);
  guessConfirmContentEl.appendChild(p);
  guessConfirmContentEl.appendChild(warning);

  guessConfirmOverlayEl.classList.remove('screen--hidden');
}

btnGuessConfirmCancel.addEventListener('click', () => {
  guessPendingAttemptIndex = null;
  guessConfirmOverlayEl.classList.add('screen--hidden');
});

btnGuessConfirmOk.addEventListener('click', () => {
  if (guessPendingAttemptIndex === null) return;
  socket.emit('guess_attempt', { index: guessPendingAttemptIndex });
  guessPendingAttemptIndex = null;
  guessConfirmOverlayEl.classList.add('screen--hidden');
  setGuessBoardMode('idle');
  btnGuessAnswer.textContent = 'Dire ma réponse';
  // "Dire ma réponse" engage toujours le tour côté serveur (bonne ou mauvaise réponse) :
  // désactive tout de suite les actions plutôt que d'attendre guess_turn_started/
  // guess_game_over, pour éviter un double-clic dans la fenêtre entre les deux.
  guessActiveActionsEl.classList.add('screen--hidden');
});

// Purement visuelle : la barre/le chiffre se recalculent depuis turnEndsAt (fourni par
// le serveur) à chaque tick, jamais depuis un décompte local qui pourrait dériver.
// durationMs (optionnel) resynchronise currentGuessTurnDurationMs si fourni — sinon la
// dernière valeur connue est réutilisée (ex: relance interne sans nouvelle donnée).
function startGuessTimerDisplay(turnEndsAt, durationMs) {
  clearInterval(guessTimerInterval);
  if (durationMs) currentGuessTurnDurationMs = durationMs;

  function tick() {
    const remainingMs = Math.max(0, turnEndsAt - Date.now());
    const remainingSec = Math.ceil(remainingMs / 1000);
    guessTimerValueEl.textContent = remainingSec;
    const pct = Math.max(0, Math.min(100, (remainingMs / currentGuessTurnDurationMs) * 100));
    guessTimerBarEl.style.width = `${pct}%`;
    guessTimerBarEl.classList.toggle('guess-timer-bar--low', remainingSec <= 5);
    if (remainingMs <= 0) clearInterval(guessTimerInterval);
  }
  tick();
  guessTimerInterval = setInterval(tick, 250);
}

function updateGuessReplayControls() {
  const host = isHost();
  btnGuessReplay.classList.toggle('screen--hidden', !host);
  guessFinishedStatusEl.textContent = host
    ? 'Relance une partie quand tu es prêt.'
    : "En attente que l'hôte relance une partie...";
}

// ---------- Boutons ----------
btnLeaveGuess.addEventListener('click', () => {
  socket.emit('leave_game');
  rememberActiveGame(null);
  resetGuessUI();
  showScreen(screenHome);
});

btnLeaveGuessFinished.addEventListener('click', () => {
  socket.emit('leave_game');
  rememberActiveGame(null);
  resetGuessUI();
  showScreen(screenHome);
});

btnGuessReplay.addEventListener('click', () => {
  socket.emit('play_again'); // même event que Route du Boss, déjà gameMode-agnostic côté serveur
});

btnGuessAnswer.addEventListener('click', () => {
  if (guessBoardMode === 'guessing') {
    setGuessBoardMode('idle');
    btnGuessAnswer.textContent = 'Dire ma réponse';
  } else {
    setGuessBoardMode('guessing');
    btnGuessAnswer.textContent = 'Annuler la réponse';
  }
});

btnGuessFinishTurn.addEventListener('click', () => {
  socket.emit('guess_finish_turn');
});

// ---------- Événements serveur ----------
socket.on('guess_game_started', ({ gameId, board, players }) => {
  if (isSpectating) {
    // Mis sur le banc en mode "Devine le Pokémon" à >2 joueurs (cf. start_game côté
    // serveur), ou rejoint via code sur une partie déjà lancée : planche/secrets restent
    // invisibles (comme pour les 2 joueurs actifs eux-mêmes tant qu'ils n'ont rien
    // révélé) — seul le tour en cours est indiqué, cf. renderSpectateView.
    spectateBoss = null;
    spectateGuessPlayers = players;
    renderSpectateView({ status: 'playing', gameMode: 'guess', players });
    return;
  }
  resetGuessUI();
  resetChatPanel(); // nouvelle partie = discussion vierge
  rememberActiveGame(gameId);
  guessBoard = board;
  renderGuessPlayers(players);
  renderGuessBoard();
  showScreen(screenGuess);
});

socket.on('secret_selection_confirmed', ({ index, name }) => {
  guessMySecretIndex = index;
  guessSelectionStatusEl.textContent = `Pokémon secret sélectionné : ${name}. En attente de l'adversaire...`;
  renderGuessBoard();
  renderGuessPlayers(lastGuessPlayers);
});

socket.on('guess_players_updated', ({ players }) => {
  if (isSpectating) {
    spectateGuessPlayers = players;
    renderSpectateView({ status: 'playing', gameMode: 'guess', boss: spectateBoss, players });
    return;
  }
  renderGuessPlayers(players);
});

socket.on('guess_turn_started', ({ activePlayerId, turnEndsAt, turnDurationMs }) => {
  if (isSpectating) {
    // Pas de minuteur affiché côté spectateur (juste "à qui le tour") — cf.
    // renderSpectateView, qui n'a besoin que de l'id et de la liste de joueurs déjà en cache.
    renderSpectateView({ status: 'playing', gameMode: 'guess', players: spectateGuessPlayers, activePlayerId });
    return;
  }

  guessActivePlayerId = activePlayerId;
  guessSelectionPanelEl.classList.add('screen--hidden');
  guessTurnPanelEl.classList.remove('screen--hidden');
  guessLastAttemptEl.classList.add('screen--hidden');

  const isMe = activePlayerId === myId;
  guessActiveNameEl.textContent = guessPlayerName(activePlayerId);
  guessTurnHintEl.textContent = isMe
    ? 'Pose tes questions à ton adversaire via Discord.'
    : `${guessPlayerName(activePlayerId)} réfléchit...`;
  guessActiveActionsEl.classList.toggle('screen--hidden', !isMe);

  setGuessBoardMode('idle');
  btnGuessAnswer.textContent = 'Dire ma réponse';

  startGuessTimerDisplay(turnEndsAt, turnDurationMs);
});

// Diffusé aux DEUX joueurs, bonne ou mauvaise réponse : ça fait partie du jeu de
// déduction (cf. spec section 5/9/10). Une mauvaise réponse ne change rien d'autre.
socket.on('guess_attempt_result', ({ by, index, name, correct }) => {
  if (isSpectating) {
    // Une tentative RATÉE ne révèle rien sur le secret de l'adversaire — sans risque à
    // montrer. Une tentative RÉUSSIE, si, mais la partie se termine dans la foulée
    // (guess_game_over juste après) donc ce n'est jamais un avantage exploitable ensuite.
    spectateStatusEl.textContent = correct
      ? `✅ ${spectateFindPlayerName(spectateGuessPlayers, by)} a trouvé : ${name} !`
      : `❌ ${spectateFindPlayerName(spectateGuessPlayers, by)} a tenté ${name} — mauvaise réponse.`;
    return;
  }

  guessLastAttemptEl.classList.remove('guess-last-attempt--correct', 'guess-last-attempt--wrong');
  guessLastAttemptEl.classList.add(correct ? 'guess-last-attempt--correct' : 'guess-last-attempt--wrong');
  guessLastAttemptEl.textContent = correct
    ? `✅ ${guessPlayerName(by)} a trouvé : ${name} !`
    : `❌ ${guessPlayerName(by)} a tenté ${name} — mauvaise réponse.`;
  guessLastAttemptEl.classList.remove('screen--hidden');
});

socket.on('guess_game_over', ({ winnerId, reason, secretPokemon, players }) => {
  refreshAccountFromServer(); // XP gagnée pendant la partie (cf. awardXp côté serveur)
  if (isSpectating) {
    // Même logique que game_finished pour Route du Boss : ne jamais rediriger un
    // spectateur vers #screen-guess-finished (vue "victoire/défaite" propre aux 2
    // joueurs actifs, sans objet pour lui).
    spectateGuessPlayers = players;
    renderSpectateView({ status: 'finished', gameMode: 'guess', boss: spectateBoss, players });
    return;
  }
  clearInterval(guessTimerInterval);
  lastGuessPlayers = players;

  const won = winnerId === myId;
  guessFinishedOutcomeEl.textContent = won ? 'VICTOIRE !' : 'DÉFAITE';
  guessFinishedOutcomeEl.classList.toggle('finished-outcome--victory', won);
  guessFinishedOutcomeEl.classList.toggle('finished-outcome--defeat', !won);
  if (won) playVictorySound(); else playDefeatSound();

  guessFinishedDetailEl.innerHTML = '';
  if (reason === 'forfeit') {
    const p = document.createElement('p');
    p.textContent = won ? "Ton adversaire a quitté la partie." : 'Tu as quitté la partie.';
    guessFinishedDetailEl.appendChild(p);
  } else if (secretPokemon) {
    const img = document.createElement('img');
    img.src = secretPokemon.sprite;
    img.alt = secretPokemon.name;
    const p = document.createElement('p');
    p.textContent = won
      ? `Tu as trouvé : ${secretPokemon.name} !`
      : `${guessPlayerName(winnerId)} a trouvé : ${secretPokemon.name} !`;
    guessFinishedDetailEl.appendChild(img);
    guessFinishedDetailEl.appendChild(p);
  }

  updateGuessReplayControls();
  showScreen(screenGuessFinished);
});

// ============================================================
// MODE DRAFT/ENCHÈRES
// ============================================================
// Strictement 2 joueurs, aucun banc/spectateur (cf. start_game côté serveur qui bloque
// toujours si players.length !== 2). Type "complete" : les 2 voient le Pokémon en vente.
// Type "semi_blind" : un seul (isSeer) le voit, rotation à chaque lot — l'autre reçoit
// pokemon: null côté serveur (jamais juste masqué en CSS), donc si !payload.isSeer le
// voyant est nécessairement l'unique autre joueur (toujours exactement 2 en jeu).

const btnLeaveAuction = document.getElementById('btn-leave-auction');
const auctionLotsRemainingEl = document.getElementById('auction-lots-remaining');
const auctionBudgetMeEl = document.getElementById('auction-budget-me');
const auctionMyBudgetEl = document.getElementById('auction-my-budget');
const auctionBudgetOppEl = document.getElementById('auction-budget-opp');
const auctionOppNameEl = document.getElementById('auction-opp-name');
const auctionOppBudgetEl = document.getElementById('auction-opp-budget');
const auctionLotMysteryEl = document.getElementById('auction-lot-mystery');
const auctionSeerNameEl = document.getElementById('auction-seer-name');
const auctionLotRevealEl = document.getElementById('auction-lot-reveal');
const auctionLotSpriteEl = document.getElementById('auction-lot-sprite');
const auctionLotNameEl = document.getElementById('auction-lot-name');
const auctionActiveNameEl = document.getElementById('auction-active-name');
const auctionCurrentBidValueEl = document.getElementById('auction-current-bid-value');
const auctionCurrentBidderEl = document.getElementById('auction-current-bidder');
const auctionBidInputEl = document.getElementById('auction-bid-input');
const btnAuctionBid = document.getElementById('btn-auction-bid');
const btnAuctionPass = document.getElementById('btn-auction-pass');
const auctionQuickBidButtons = Array.from(document.querySelectorAll('#auction-quick-bid-options .admin-role-btn'));
const auctionBidHintEl = document.getElementById('auction-bid-hint');
const auctionMyTeamCountEl = document.getElementById('auction-my-team-count');
const auctionMyTeamSlotsEl = document.getElementById('auction-my-team-slots');
const auctionMyTeamAvatarEl = document.getElementById('auction-my-team-avatar');
const auctionOppTeamLabelEl = document.getElementById('auction-opp-team-label');
const auctionOppTeamCountEl = document.getElementById('auction-opp-team-count');
const auctionOppTeamSlotsEl = document.getElementById('auction-opp-team-slots');
const auctionOppTeamAvatarEl = document.getElementById('auction-opp-team-avatar');
const auctionHistoryListEl = document.getElementById('auction-history-list');
const auctionFinishedTitleEl = document.getElementById('auction-finished-title');
const auctionFinishedReasonEl = document.getElementById('auction-finished-reason');
const auctionFinishedMySlotsEl = document.getElementById('auction-finished-my-slots');
const auctionFinishedMyAvatarEl = document.getElementById('auction-finished-my-avatar');
const auctionFinishedMyBudgetEl = document.getElementById('auction-finished-my-budget');
const auctionFinishedOppLabelEl = document.getElementById('auction-finished-opp-label');
const auctionFinishedOppSlotsEl = document.getElementById('auction-finished-opp-slots');
const auctionFinishedOppAvatarEl = document.getElementById('auction-finished-opp-avatar');
const auctionFinishedOppBudgetEl = document.getElementById('auction-finished-opp-budget');
const btnAuctionReplay = document.getElementById('btn-auction-replay');
const auctionFinishedStatusEl = document.getElementById('auction-finished-status');
const btnLeaveAuctionFinished = document.getElementById('btn-leave-auction-finished');
const btnAuctionCopyTeam = document.getElementById('btn-auction-copy-team');
const auctionCopyFeedbackEl = document.getElementById('auction-copy-feedback');

let lastAuctionPlayers = [];
// id du joueur dont c'est le tour d'enchérir/passer sur le lot en cours (tour par tour,
// cf. auction_lot_started / auction_bid_update côté serveur).
let lastAuctionActivePlayerId = null;
// Enchère actuelle du lot en cours (null tant que personne n'a encore enchéri) : sert à
// savoir si "Passer" est autorisé (impossible tant qu'aucune enchère n'a été posée).
let lastAuctionCurrentBid = null;
// Reflet du plancher AUCTION_MIN_BID côté serveur (uniquement pour les indices affichés
// ici — le serveur reste seul juge de la validité réelle de toute mise).
const AUCTION_MIN_BID_CLIENT = 10_000_000;

function auctionSelf(players) {
  return (players || []).find(p => p.id === myId);
}
function auctionOpponent(players) {
  return (players || []).find(p => p.id !== myId);
}

// Affiche le ,5 exact plutôt que d'arrondir au million (les montants sont toujours des
// multiples de 500 000, cf. la saisie limitée à un entier ou un ,5 — jamais 15,3M par ex).
// Le *2/2 protège juste des imprécisions flottantes (15.5*2=31 exact en binaire, aucun
// souci réel attendu ici, mais ne coûte rien).
function formatAuctionMoneyClient(amount) {
  const snapped = Math.round((amount / 1_000_000) * 2) / 2;
  const text = Number.isInteger(snapped) ? String(snapped) : snapped.toFixed(1).replace('.', ',');
  return `${text}M`;
}

function resetAuctionUI() {
  lastAuctionPlayers = [];
  lastAuctionActivePlayerId = null;
  lastAuctionCurrentBid = null;
  auctionLotMysteryEl.classList.add('screen--hidden');
  auctionLotRevealEl.classList.add('screen--hidden');
  auctionCurrentBidValueEl.textContent = '—';
  auctionCurrentBidderEl.textContent = '';
  auctionActiveNameEl.textContent = '—';
  auctionBidInputEl.value = '';
  auctionBidInputEl.disabled = false;
  btnAuctionBid.disabled = false;
  btnAuctionPass.disabled = false;
  auctionQuickBidButtons.forEach(btn => { btn.disabled = false; });
  auctionBidHintEl.textContent = '';
  auctionHistoryListEl.innerHTML = '';
  auctionMyTeamSlotsEl.innerHTML = '';
  auctionOppTeamSlotsEl.innerHTML = '';
  auctionMyTeamCountEl.textContent = '(0/6)';
  auctionOppTeamCountEl.textContent = '(0/6)';
  auctionMyBudgetEl.textContent = '500M';
  auctionOppBudgetEl.textContent = '500M';
  auctionBudgetMeEl.classList.remove('auction-budget-card--empty');
  auctionBudgetOppEl.classList.remove('auction-budget-card--empty');
  auctionLotsRemainingEl.textContent = '30';
  auctionOppNameEl.textContent = 'Adversaire';
  auctionOppTeamLabelEl.textContent = 'Équipe adverse';
}

// 6 emplacements fixes par équipe, remplis ou vides — même patron visuel que les
// team-slots du mode normal (cf. renderTeamSlots), juste sans variante shiny/metamorph.
function renderAuctionTeamSlots(container, team) {
  container.innerHTML = '';
  for (let i = 0; i < 6; i++) {
    const slot = document.createElement('div');
    slot.className = 'team-slot';
    const mon = (team || [])[i];
    if (mon) {
      const img = document.createElement('img');
      img.src = mon.sprite;
      img.alt = mon.name;
      slot.appendChild(img);
    }
    container.appendChild(slot);
  }
}

// Combine plusieurs conditions pour savoir si CE joueur peut agir maintenant : équipe
// pas pleine ET c'est son tour (tour par tour, cf. lastAuctionActivePlayerId). "Passer"
// est en plus soumis à une 3e condition : impossible tant qu'aucune enchère n'a encore
// été posée sur ce lot (cf. lastAuctionCurrentBid) — il faut toujours que quelqu'un
// ouvre les enchères en premier (avec cependant une exception à 0M pour qui n'a pas les
// moyens du plancher, cf. AUCTION_MIN_BID_CLIENT et le handler de clic plus bas).
function updateAuctionBidAvailability() {
  const me = auctionSelf(lastAuctionPlayers);
  const teamFull = !me || me.teamCount >= 6;
  const isMyTurn = !!me && lastAuctionActivePlayerId === myId;
  const canBid = !teamFull && isMyTurn;
  const canPass = canBid && lastAuctionCurrentBid !== null;
  auctionBidInputEl.disabled = !canBid;
  btnAuctionBid.disabled = !canBid;
  btnAuctionPass.disabled = !canPass;
  auctionQuickBidButtons.forEach(btn => { btn.disabled = !canBid; });
  const cantAffordFloor = !!me && me.budget < AUCTION_MIN_BID_CLIENT;
  if (teamFull) {
    auctionBidHintEl.textContent = me ? 'Ton équipe est déjà complète (6 Pokémon).' : '';
  } else if (!isMyTurn) {
    auctionBidHintEl.textContent = "En attente du tour de ton adversaire...";
  } else if (lastAuctionCurrentBid === null && cantAffordFloor) {
    auctionBidHintEl.textContent = "Tu n'as pas 10M : tu peux quand même miser 0M (l'adversaire choisira de le prendre ou de te le laisser).";
  } else if (lastAuctionCurrentBid === null) {
    auctionBidHintEl.textContent = "Tu dois enchérir en premier sur ce lot (impossible de passer).";
  } else if (
    auctionBidHintEl.textContent === 'Ton équipe est déjà complète (6 Pokémon).' ||
    auctionBidHintEl.textContent === "En attente du tour de ton adversaire..." ||
    auctionBidHintEl.textContent === "Tu dois enchérir en premier sur ce lot (impossible de passer)." ||
    auctionBidHintEl.textContent === "Tu n'as pas 10M : tu peux quand même miser 0M (l'adversaire choisira de le prendre ou de te le laisser)."
  ) {
    auctionBidHintEl.textContent = '';
  }
}

// players : payload de getPublicAuctionPlayers() côté serveur — {id, name, disconnected,
// budget, team, teamCount}. Exactement 2 entrées, donc "l'autre que moi" = l'adversaire.
function renderAuctionPlayers(players) {
  lastAuctionPlayers = players || [];
  const me = auctionSelf(lastAuctionPlayers);
  const opp = auctionOpponent(lastAuctionPlayers);

  if (me) {
    auctionMyBudgetEl.textContent = formatAuctionMoneyClient(me.budget);
    auctionBudgetMeEl.classList.toggle('auction-budget-card--empty', me.budget <= 0);
    auctionMyTeamCountEl.textContent = `(${me.teamCount}/6)`;
    auctionMyTeamAvatarEl.src = me.avatar ? avatarUrl(me.avatar) : '';
    auctionMyTeamAvatarEl.classList.toggle('screen--hidden', !me.avatar);
    renderAuctionTeamSlots(auctionMyTeamSlotsEl, me.team);
  }
  if (opp) {
    auctionOppNameEl.textContent = opp.name + (opp.disconnected ? ' (déconnecté)' : '');
    auctionOppTeamLabelEl.textContent = `Équipe de ${opp.name}`;
    auctionOppBudgetEl.textContent = formatAuctionMoneyClient(opp.budget);
    auctionBudgetOppEl.classList.toggle('auction-budget-card--empty', opp.budget <= 0);
    auctionOppTeamCountEl.textContent = `(${opp.teamCount}/6)`;
    auctionOppTeamAvatarEl.src = opp.avatar ? avatarUrl(opp.avatar) : '';
    auctionOppTeamAvatarEl.classList.toggle('screen--hidden', !opp.avatar);
    renderAuctionTeamSlots(auctionOppTeamSlotsEl, opp.team);
  }
}

// Met à jour à qui le tour (tour par tour, sans limite de temps) et rafraîchit la
// disponibilité des contrôles en conséquence.
function renderAuctionTurn(activePlayerId) {
  lastAuctionActivePlayerId = activePlayerId || null;
  if (lastAuctionActivePlayerId) {
    auctionActiveNameEl.textContent = lastAuctionActivePlayerId === myId
      ? 'Toi'
      : (auctionOpponent(lastAuctionPlayers)?.name || 'ton adversaire');
  } else {
    auctionActiveNameEl.textContent = '—';
  }
  updateAuctionBidAvailability();
}

// Partagé entre auction_lot_started (nouveau lot) et auction_bid_update (quelqu'un
// enchérit sur le lot en cours) : les deux portent les mêmes champs d'enchère/joueurs.
function renderAuctionBidInfo({ currentBid, currentBidderId, currentBidderName, activePlayerId, players }) {
  if (players) renderAuctionPlayers(players);
  lastAuctionCurrentBid = (currentBid !== null && currentBid !== undefined) ? currentBid : null;
  auctionCurrentBidValueEl.textContent = lastAuctionCurrentBid !== null
    ? formatAuctionMoneyClient(lastAuctionCurrentBid)
    : '—';
  if (currentBidderId) {
    const name = currentBidderId === myId ? 'Toi' : (currentBidderName || auctionOpponent(lastAuctionPlayers)?.name || 'ton adversaire');
    auctionCurrentBidderEl.textContent = `(${name})`;
  } else {
    auctionCurrentBidderEl.textContent = '';
  }
  renderAuctionTurn(activePlayerId);
}

function renderAuctionLot(payload) {
  auctionLotsRemainingEl.textContent = payload.lotsRemaining;
  renderAuctionPlayers(payload.players);

  if (payload.pokemon) {
    auctionLotMysteryEl.classList.add('screen--hidden');
    auctionLotRevealEl.classList.remove('screen--hidden');
    auctionLotSpriteEl.src = payload.pokemon.sprite;
    auctionLotSpriteEl.alt = payload.pokemon.name;
    auctionLotNameEl.textContent = payload.pokemon.name;
  } else {
    // Semi-aveugle, pas le voyant : le serveur n'a jamais envoyé le Pokémon à cette
    // socket (cf. broadcastAuctionLot), impossible de le retrouver ici — normal.
    auctionLotRevealEl.classList.add('screen--hidden');
    auctionLotMysteryEl.classList.remove('screen--hidden');
    auctionSeerNameEl.textContent = auctionOpponent(payload.players)?.name || 'ton adversaire';
  }

  auctionBidInputEl.value = '';
  renderAuctionBidInfo(payload);
}

function updateAuctionReplayControls() {
  const host = isHost();
  btnAuctionReplay.classList.toggle('screen--hidden', !host);
  auctionFinishedStatusEl.textContent = host
    ? 'Relance une partie quand tu es prêt.'
    : "En attente que l'hôte relance une partie...";
}

// Partagé entre auction_game_over (fin réelle, avec raison) et rejoin_success sur une
// partie déjà finie (reason: null — pas assez d'info pour la retrouver après coup,
// jamais renvoyée par rejoin, même limite déjà acceptée côté guess).
function renderAuctionFinished({ reason, players, history }) {
  lastAuctionPlayers = players || [];
  const me = auctionSelf(lastAuctionPlayers);
  const opp = auctionOpponent(lastAuctionPlayers);

  auctionFinishedTitleEl.textContent = 'Draft terminé';
  auctionFinishedReasonEl.textContent = reason === 'forfeit'
    ? "Ton adversaire a quitté la partie — la draft s'arrête là."
    : reason === 'complete'
      ? 'Les 30 lots ont été vendus.'
      : 'Partie déjà terminée.';

  if (me) {
    renderAuctionTeamSlots(auctionFinishedMySlotsEl, me.team);
    auctionFinishedMyAvatarEl.src = me.avatar ? avatarUrl(me.avatar) : '';
    auctionFinishedMyAvatarEl.classList.toggle('screen--hidden', !me.avatar);
    auctionFinishedMyBudgetEl.textContent = `Budget restant : ${formatAuctionMoneyClient(me.budget)}`;
    btnAuctionCopyTeam.disabled = !(me.team && me.team.length);
  }
  if (opp) {
    auctionFinishedOppLabelEl.textContent = `Équipe de ${opp.name}`;
    auctionFinishedOppAvatarEl.src = opp.avatar ? avatarUrl(opp.avatar) : '';
    auctionFinishedOppAvatarEl.classList.toggle('screen--hidden', !opp.avatar);
    renderAuctionTeamSlots(auctionFinishedOppSlotsEl, opp.team);
    auctionFinishedOppBudgetEl.textContent = `Budget restant : ${formatAuctionMoneyClient(opp.budget)}`;
  }

  auctionCopyFeedbackEl.textContent = '';
  updateAuctionReplayControls();
  showScreen(screenAuctionFinished);
}

// Smogon/Showdown attend des noms EN ANGLAIS, alors que le jeu stocke tout en français
// (cf. name côté serveur) : on récupère le nom anglais via PokeAPI (déjà utilisée pour
// les sprites, cf. spriteUrl) à partir du dexId, seule donnée fiable et indépendante de
// la langue qu'on ait pour chaque Pokémon. Repli sur null si l'appel échoue (offline,
// API indisponible, etc.) — c'est à l'appelant de décider du repli affiché.
async function fetchEnglishPokemonName(dexId) {
  try {
    // Formes (Méga, id >= 10000) : pas de /pokemon-species/{id} (404) -> /pokemon/{id}, dont
    // le nom ("venusaur-mega", "charizard-mega-x") est converti au format Showdown
    // ("Venusaur-Mega", "Charizard-Mega-X").
    if (dexId >= 10000) {
      const res = await fetch(`https://pokeapi.co/api/v2/pokemon/${dexId}/`);
      if (!res.ok) throw new Error('Réponse PokeAPI invalide');
      const data = await res.json();
      return data.name
        ? data.name.split('-').map(part => part.charAt(0).toUpperCase() + part.slice(1)).join('-')
        : null;
    }
    const res = await fetch(`https://pokeapi.co/api/v2/pokemon-species/${dexId}/`);
    if (!res.ok) throw new Error('Réponse PokeAPI invalide');
    const data = await res.json();
    const entry = (data.names || []).find(n => n.language && n.language.name === 'en');
    return entry ? entry.name : null;
  } catch (err) {
    return null;
  }
}

// Formes finales d'évolution : MÊME source que le Bonbon XP (EVOLUTION_MAP côté serveur, cf.
// GET /api/evolution-finals) — plus aucune logique d'évolution propre au client. Réponse
// { dexId: { id, name } } (absent = déjà forme finale), chargée une seule fois. Si l'appel
// échoue, {} : aucun Pokémon évolué (rien d'inventé), et on retente au prochain export.
let evolutionFinalsPromise = null;
function loadEvolutionFinals() {
  if (!evolutionFinalsPromise) {
    evolutionFinalsPromise = fetch('/api/evolution-finals')
      .then(res => {
        if (!res.ok) throw new Error('Formes finales indisponibles');
        return res.json();
      })
      .catch(() => {
        evolutionFinalsPromise = null;
        return {};
      });
  }
  return evolutionFinalsPromise;
}

// Format d'import minimal (juste le nom de chaque Pokémon, séparé par une ligne vide) —
// compatible avec un import Smogon/Showdown basique. Ni l'talent ni l'objet/les
// capacités/EVs ne sont jamais suivis par le jeu, donc jamais inclus ici (rien à
// inventer). Chaque Pokémon est exporté sous sa forme ÉVOLUÉE AU MAXIMUM (cf.
// loadEvolutionFinals : même table que le Bonbon XP), pas celle réellement obtenue pendant
// le draft, puis traduit en anglais (cf. fetchEnglishPokemonName) — jamais l'inverse
// (traduire d'abord puis évoluer), pour ne travailler qu'avec des dexId, seule donnée fiable
// qu'on ait. Repli si PokeAPI ne répond pas : nom français de la forme finale.
async function buildSmogonExport(team) {
  const finals = await loadEvolutionFinals();
  const names = await Promise.all((team || []).map(async mon => {
    const final = finals[mon.id];
    const enName = await fetchEnglishPokemonName(final ? final.id : mon.id);
    return enName || (final ? final.name : mon.name);
  }));
  return names.join('\n\n');
}

function addAuctionHistoryEntry({ pokemon, winnerId, winnerName, price }) {
  const li = document.createElement('li');
  const img = document.createElement('img');
  img.src = pokemon.sprite;
  img.alt = pokemon.name;
  const name = document.createElement('span');
  name.textContent = pokemon.name;
  li.appendChild(img);
  li.appendChild(name);

  const tag = document.createElement('span');
  if (winnerId) {
    tag.className = 'auction-history-price';
    const who = winnerId === myId ? 'Toi' : (winnerName || 'Adversaire');
    tag.textContent = `${who} — ${formatAuctionMoneyClient(price)}`;
  } else {
    tag.className = 'auction-history-unsold';
    tag.textContent = 'Invendu';
  }
  li.appendChild(tag);
  auctionHistoryListEl.insertBefore(li, auctionHistoryListEl.firstChild);
}

socket.on('auction_game_started', ({ gameId, players }) => {
  if (isSpectating) return; // ne devrait jamais arriver (les spectateurs ne sont jamais dans game.players côté serveur) — garde défensive
  resetAuctionUI();
  resetChatPanel(); // nouvelle partie = discussion vierge
  rememberActiveGame(gameId);
  renderAuctionPlayers(players);
  updateAuctionBidAvailability();
  showScreen(screenAuction);
});

// Ciblé PAR JOUEUR côté serveur (cf. semi-aveugle) : ne concerne donc jamais un
// spectateur, qui reçoit 'auction_lot_started_spectator' à la place (même moment, vue
// adaptée — cf. buildSpectatePayload côté serveur).
socket.on('auction_lot_started', (payload) => {
  renderAuctionLot(payload);
});

socket.on('auction_lot_started_spectator', (payload) => {
  if (!isSpectating) return; // les 2 joueurs actifs reçoivent aussi cet event (room-wide) : ignoré pour eux
  renderSpectateAuctionView(payload);
});

socket.on('auction_bid_update', (payload) => {
  if (isSpectating) {
    renderSpectateAuctionPlayers(payload.players, payload.activePlayerId);
    spectateTurnEl.textContent = `Au tour de ${spectateFindPlayerName(payload.players, payload.activePlayerId)} de miser...`;
    spectateAuctionBidEl.textContent = `Enchère actuelle : ${formatAuctionMoneyClient(payload.currentBid)}`;
    return;
  }
  playClickSound();
  renderAuctionBidInfo(payload);
});

socket.on('auction_lot_resolved', (payload) => {
  if (isSpectating) {
    renderSpectateAuctionPlayers(payload.players, null);
    return;
  }
  playRevealSound();
  renderAuctionPlayers(payload.players);
  updateAuctionBidAvailability();
  addAuctionHistoryEntry(payload);
});

socket.on('auction_game_over', ({ reason, players, history }) => {
  if (isSpectating) {
    // Même logique que game_finished/guess_game_over : jamais rediriger un spectateur
    // vers #screen-auction-finished, propre aux 2 joueurs actifs.
    renderSpectateAuctionView({ status: 'finished', players, lot: null });
    return;
  }
  refreshAccountFromServer(); // XP gagnée pendant la partie (cf. awardXp côté serveur)
  renderAuctionFinished({ reason, players, history });
});

// Envoie réellement l'enchère au serveur (partagé entre le bouton "Enchérir" et les
// raccourcis +10M/+25M/+50M/+100M ci-dessous) — amount est déjà le montant final en
// unité brute, jamais arrondi ici (cf. les 2 appelants).
function submitAuctionBid(amount) {
  playClickSound();
  socket.emit('auction_bid', { amount });
}

// Saisie SIMPLIFIÉE en millions pour que le joueur n'ait jamais à écrire tous les zéros :
// "1" -> 1 000 000, "15,5" ou "15.5" -> 15 500 000 (virgule française acceptée, cf.
// input type="text" dans index.html, pas type="number" qui la rejette selon le
// navigateur). Seuls un entier ou un entier suivi de ",5"/" .5" sont acceptés (ex: 15 ou
// 15,5, jamais 15,3) — validé sur la CHAÎNE plutôt que par calcul flottant, pour rester
// exact. Le serveur reste seul juge final (rejette aussi tout montant qui ne serait pas
// un multiple de 500 000, cf. AUCTION_MIN_BID côté serveur).
const AUCTION_BID_INPUT_RE = /^\d+(?:\.5)?$/;

btnAuctionBid.addEventListener('click', () => {
  const raw = auctionBidInputEl.value.trim().replace(',', '.');
  if (!AUCTION_BID_INPUT_RE.test(raw)) {
    auctionBidHintEl.textContent = 'Entre un nombre entier ou se terminant par ,5 (ex: 15 ou 15,5).';
    return;
  }
  const units = Number(raw);
  const amount = Math.round(units * 1_000_000);
  submitAuctionBid(amount);
});

// Raccourcis rapides : ajoutent l'incrément à l'enchère actuelle (0 si le lot est encore
// vierge — donc "+10M" mise directement 10M, qui est justement le plancher). Envoient la
// mise directement, sans passer par le champ texte.
auctionQuickBidButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    const increment = Number(btn.dataset.increment);
    const base = lastAuctionCurrentBid !== null ? lastAuctionCurrentBid : 0;
    submitAuctionBid(base + increment);
  });
});

auctionBidInputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    btnAuctionBid.click();
  }
});

btnAuctionPass.addEventListener('click', () => {
  playClickSound();
  socket.emit('auction_pass');
});

btnLeaveAuction.addEventListener('click', () => {
  socket.emit('leave_game');
  rememberActiveGame(null);
  resetAuctionUI();
  showScreen(screenHome);
});

btnLeaveAuctionFinished.addEventListener('click', () => {
  socket.emit('leave_game');
  rememberActiveGame(null);
  resetAuctionUI();
  showScreen(screenHome);
});

btnAuctionReplay.addEventListener('click', () => {
  if (!isHost()) return;
  socket.emit('play_again');
});

btnAuctionCopyTeam.addEventListener('click', async () => {
  const me = auctionSelf(lastAuctionPlayers);
  const team = me ? me.team : [];
  if (!team.length) return;

  const originalLabel = btnAuctionCopyTeam.textContent;
  btnAuctionCopyTeam.disabled = true;
  btnAuctionCopyTeam.textContent = 'Copie en cours...';
  const text = await buildSmogonExport(team);
  btnAuctionCopyTeam.disabled = false;
  btnAuctionCopyTeam.textContent = originalLabel;

  try {
    await navigator.clipboard.writeText(text);
  } catch (err) {
    // Repli avec un <textarea> plutôt qu'un <input> (cf. btnCopyCode/btnCopyLink) : ce
    // texte est multi-lignes (lignes vides entre chaque Pokémon), un <input> l'aplatirait.
    const tmp = document.createElement('textarea');
    tmp.value = text;
    document.body.appendChild(tmp);
    tmp.select();
    document.execCommand('copy');
    document.body.removeChild(tmp);
  }
  auctionCopyFeedbackEl.textContent = 'Équipe copiée !';
  auctionCopyFeedbackEl.classList.remove('copy-feedback--play');
  void auctionCopyFeedbackEl.offsetWidth;
  auctionCopyFeedbackEl.classList.add('copy-feedback--play');
});

// ============================================================
// MODE SPECTATEUR
// ============================================================
// Rejoint automatiquement via socket.on('join_game') côté serveur quand le code entré
// correspond à une partie déjà démarrée (normal/admin). Vue strictement en lecture :
// aucun bouton de choix nulle part sur cet écran. isSpectating (déclaré en haut du
// fichier avec le reste de l'état local) sert de garde pour savoir si le prochain
// game_updated doit rafraîchir CET écran plutôt que #screen-game.
const btnLeaveSpectate = document.getElementById('btn-leave-spectate');
const spectateBossSpriteEl = document.getElementById('spectate-boss-sprite');
const spectateBossNameEl = document.getElementById('spectate-boss-name');
const spectateBossTargetEl = document.getElementById('spectate-boss-target');
const spectateTurnEl = document.getElementById('spectate-turn');
const spectatePlayersListEl = document.getElementById('spectate-players-list');
const spectateStatusEl = document.getElementById('spectate-status');
const spectateBossPanelEl = document.getElementById('spectate-boss-panel');
const spectateAuctionPanelEl = document.getElementById('spectate-auction-panel');
const spectateAuctionSpriteEl = document.getElementById('spectate-auction-sprite');
const spectateAuctionNameEl = document.getElementById('spectate-auction-name');
const spectateAuctionBidEl = document.getElementById('spectate-auction-bid');

// Trouve un nom de joueur dans la liste PASSÉE (jamais lastGuessPlayers/lastAuctionPlayers,
// qui appartiennent à l'écran actif — un spectateur n'y transite jamais).
function spectateFindPlayerName(players, id) {
  const p = (players || []).find(x => x.id === id);
  return p ? p.name : '';
}

function renderSpectateView({ status, turn, maxTurns, boss, players, gameMode, activePlayerId }) {
  if (gameMode) spectateGameMode = gameMode; // certains appelants (game_updated) n'ont pas ce champ
  const isGuess = spectateGameMode === 'guess';
  // Mode "Devine le Pokémon" : aucun concept de boss/route, le panneau n'a pas de sens.
  spectateBossPanelEl.classList.toggle('screen--hidden', isGuess);

  if (!isGuess) {
    if (boss) {
      spectateBossSpriteEl.src = boss.sprite;
      spectateBossSpriteEl.alt = boss.name;
      spectateBossNameEl.textContent = boss.name;
      spectateBossTargetEl.textContent = (spectateGameMode === 'coop' && boss.teamRequiredPoints != null)
        ? boss.teamRequiredPoints
        : boss.requiredPoints;
    } else {
      // Partie relancée (Rejouer) : nouveau salon en attente, pas encore de boss tiré.
      spectateBossSpriteEl.src = '';
      spectateBossSpriteEl.alt = '';
      spectateBossNameEl.textContent = '—';
      spectateBossTargetEl.textContent = '0';
    }
  }

  if (status === 'finished') {
    spectateTurnEl.textContent = 'Partie terminée';
  } else if (status === 'waiting') {
    spectateTurnEl.textContent = "En attente du lancement de la partie...";
  } else if (isGuess) {
    // Planche/secrets restent invisibles (cf. socket.on('guess_game_started') plus haut) —
    // seul le tour en cours est indiqué, sans détail sur ce qui s'y joue.
    spectateTurnEl.textContent = activePlayerId
      ? `Au tour de ${spectateFindPlayerName(players, activePlayerId)}...`
      : 'Duel Devine le Pokémon en cours...';
  } else {
    spectateTurnEl.textContent = `Tour ${turn} / ${maxTurns}`;
  }
  renderPlayers(spectatePlayersListEl, players);
  spectateStatusEl.textContent = status === 'finished' ? 'La partie est terminée.' : '';
}

// ---- Vue spectateur DÉDIÉE au Draft/Enchères : budgets/équipes remplacent le score, pas
// de "moi vs adversaire" (aucun des deux joueurs n'est le spectateur) — jamais réutilisé
// via renderAuctionPlayers/renderPlayers, qui supposent tous deux un point de vue joueur.
function renderSpectateAuctionPlayers(players, activePlayerId) {
  spectatePlayersListEl.innerHTML = '';
  (players || []).forEach(p => {
    const li = document.createElement('li');
    li.classList.toggle('player-item--disconnected', !!p.disconnected);

    const row = document.createElement('div');
    row.className = 'player-item__row';

    const identity = document.createElement('div');
    identity.className = 'player-item__identity';
    if (p.avatar) {
      const avatarImg = document.createElement('img');
      avatarImg.className = 'player-item__avatar';
      avatarImg.src = avatarUrl(p.avatar);
      avatarImg.alt = '';
      identity.appendChild(avatarImg);
    }
    const name = document.createElement('span');
    name.textContent = p.name + (p.id === activePlayerId ? ' 🎯' : '');
    identity.appendChild(name);

    const budget = document.createElement('span');
    budget.className = 'player-score';
    budget.textContent = `${formatAuctionMoneyClient(p.budget)} · ${p.teamCount}/6`;

    row.appendChild(identity);
    row.appendChild(budget);
    li.appendChild(row);

    if (p.team && p.team.length > 0) {
      const teamRow = document.createElement('div');
      teamRow.className = 'player-item__team';
      p.team.forEach(mon => {
        const icon = document.createElement('img');
        icon.className = 'player-item__team-icon';
        icon.src = mon.sprite;
        icon.alt = mon.name;
        teamRow.appendChild(icon);
      });
      li.appendChild(teamRow);
    }

    spectatePlayersListEl.appendChild(li);
  });
}

function renderSpectateAuctionView(payload) {
  spectateGameMode = 'auction';
  spectateBossPanelEl.classList.add('screen--hidden');
  spectateAuctionPanelEl.classList.toggle('screen--hidden', payload.status !== 'playing');

  const lot = payload.lot;
  if (lot) {
    if (lot.mystery || !lot.pokemon) {
      spectateAuctionSpriteEl.src = '';
      spectateAuctionSpriteEl.alt = '';
      spectateAuctionNameEl.textContent = 'Lot mystère (semi-aveugle)';
    } else {
      spectateAuctionSpriteEl.src = lot.pokemon.sprite;
      spectateAuctionSpriteEl.alt = lot.pokemon.name;
      spectateAuctionNameEl.textContent = lot.pokemon.name;
    }
    spectateAuctionBidEl.textContent = lot.currentBid
      ? `Enchère actuelle : ${formatAuctionMoneyClient(lot.currentBid)}`
      : 'Aucune enchère pour le moment';
  }

  if (payload.status === 'finished') {
    spectateTurnEl.textContent = 'Partie terminée';
  } else if (payload.status === 'waiting') {
    spectateTurnEl.textContent = "En attente du lancement de la partie...";
  } else if (lot) {
    spectateTurnEl.textContent = `Au tour de ${spectateFindPlayerName(payload.players, lot.activePlayerId)} de miser...`;
  } else {
    spectateTurnEl.textContent = 'Draft/Enchères en cours...';
  }

  renderSpectateAuctionPlayers(payload.players, lot ? lot.activePlayerId : null);
  spectateStatusEl.textContent = payload.status === 'finished' ? 'La partie est terminée.' : '';
}

socket.on('spectate_joined', (payload) => {
  isSpectating = true;
  hostId = payload.hostId;
  spectateBoss = payload.boss;
  loadChatHistory(payload.chatMessages);
  if (payload.gameMode === 'auction') {
    renderSpectateAuctionView(payload);
  } else {
    renderSpectateView(payload);
  }
  showScreen(screenSpectate);
});

// La partie elle-même disparaît (plus aucun joueur) pendant qu'on observe : retour à
// l'accueil plutôt que de rester accroché à un écran mort.
socket.on('spectate_ended', () => {
  isSpectating = false;
  showScreen(screenHome);
  errorMessage.textContent = "La partie s'est terminée (tous les joueurs sont partis).";
});

btnLeaveSpectate.addEventListener('click', () => {
  socket.emit('leave_game');
  isSpectating = false;
  showScreen(screenHome);
});

// ============================================================
// REACTIONS RAPIDES (feu / pleurs / tete de mort / eclair)
// ============================================================
// Purement social, aucun effet sur la logique de jeu. Widget unique et partagé entre
// #screen-game et #screen-spectate (cf. index.html/style.css) : pas de duplication par
// écran, la visibilité est gérée en CSS via body[data-screen].
const reactionButtons = Array.from(document.querySelectorAll('.reaction-btn'));
const reactionBubblesEl = document.getElementById('reaction-bubbles');
const MAX_REACTION_BUBBLES = 6;

function spawnReactionBubble(playerName, emoji) {
  const bubble = document.createElement('div');
  bubble.className = 'reaction-bubble';

  const emojiSpan = document.createElement('span');
  emojiSpan.className = 'reaction-bubble__emoji';
  emojiSpan.textContent = emoji;

  const nameSpan = document.createElement('span');
  nameSpan.className = 'reaction-bubble__name';
  nameSpan.textContent = playerName;

  bubble.appendChild(emojiSpan);
  bubble.appendChild(nameSpan);
  reactionBubblesEl.appendChild(bubble);

  setTimeout(() => bubble.remove(), 2300);

  // Borne le nombre de bulles simultanées : en cas de spam, on ne laisse jamais la pile
  // grossir indéfiniment (les plus anciennes sont retirées avant même leur propre timer).
  while (reactionBubblesEl.children.length > MAX_REACTION_BUBBLES) {
    reactionBubblesEl.removeChild(reactionBubblesEl.firstChild);
  }
}

reactionButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    socket.emit('send_reaction', { emoji: btn.dataset.emoji });
  });
});

socket.on('reaction', ({ playerName, emoji }) => {
  spawnReactionBubble(playerName, emoji);
});

// ============================================================
// CHAT TEXTE DE PARTIE
// ============================================================
// Même principe que les réactions juste au-dessus : widget unique et partagé, visibilité
// gérée en CSS via body[data-screen] (game/guess/auction/spectate uniquement). Fermé par
// défaut ; les messages continuent d'arriver même panneau fermé (juste le badge "non lu"
// qui s'allume) — jamais de file d'attente à rejouer à l'ouverture.
const btnChatToggle = document.getElementById('btn-chat-toggle');
const btnChatClose = document.getElementById('btn-chat-close');
const chatPanelEl = document.getElementById('chat-panel');
const chatMessagesEl = document.getElementById('chat-messages');
const chatFormEl = document.getElementById('chat-form');
const chatInputEl = document.getElementById('chat-input');
const chatUnreadBadgeEl = document.getElementById('chat-unread-badge');

function chatAppendMessage(msg) {
  const empty = chatMessagesEl.querySelector('.chat-empty');
  if (empty) empty.remove();

  const li = document.createElement('li');
  li.className = 'chat-message' + (msg.authorId === myId ? ' chat-message--self' : '') + (msg.isSpectator ? ' chat-message--spectator' : '');

  const author = document.createElement('span');
  author.className = 'chat-message__author';
  author.textContent = msg.authorId === myId ? 'Toi' : (msg.isSpectator ? `${msg.name} (spectateur)` : msg.name);

  const text = document.createElement('span');
  text.className = 'chat-message__text';
  text.textContent = msg.text;

  li.appendChild(author);
  li.appendChild(text);
  chatMessagesEl.appendChild(li);
  chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
}

// Vide le fil ET affiche le message d'espace vide — appelé au début de chaque NOUVELLE
// partie (jamais en cours de route, cf. les 3 appelants : applyGameStarted,
// guess_game_started, auction_game_started).
function resetChatPanel() {
  chatMessagesEl.innerHTML = '';
  const empty = document.createElement('p');
  empty.className = 'chat-empty';
  empty.textContent = 'Aucun message pour le moment.';
  chatMessagesEl.appendChild(empty);
  chatUnreadBadgeEl.classList.add('screen--hidden');
}

// Reprend l'historique déjà en cours (spectateur qui rejoint en cours de partie, ou
// reconnexion) — jamais un simple reset, sinon le contexte de la conversation serait perdu.
function loadChatHistory(messages) {
  chatMessagesEl.innerHTML = '';
  if (!messages || messages.length === 0) {
    resetChatPanel();
    return;
  }
  messages.forEach(chatAppendMessage);
}

function setChatPanelOpen(open) {
  chatPanelEl.classList.toggle('screen--hidden', !open);
  if (open) chatUnreadBadgeEl.classList.add('screen--hidden');
}

btnChatToggle.addEventListener('click', () => {
  setChatPanelOpen(chatPanelEl.classList.contains('screen--hidden'));
});

btnChatClose.addEventListener('click', () => setChatPanelOpen(false));

chatFormEl.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = chatInputEl.value.trim();
  if (!text) return;
  socket.emit('chat_message', { text });
  chatInputEl.value = '';
});

socket.on('chat_message', (msg) => {
  chatAppendMessage(msg);
  if (chatPanelEl.classList.contains('screen--hidden')) {
    chatUnreadBadgeEl.classList.remove('screen--hidden');
  }
});
// ============================================================
// SONS COURTS (Réglages > Affichage > Sons)
// ============================================================
// Générés à la volée via Web Audio API (oscillateurs) plutôt que des fichiers audio à
// charger : aucun asset à servir/mettre en cache, fonctionne offline, zéro dépendance.
// Désactivés par défaut (soundEnabled, cf. section RÉGLAGES juste en dessous qui
// l'initialise depuis localStorage) : les navigateurs bloquent de toute façon l'audio
// tant qu'il n'y a pas eu de geste utilisateur, donc pas de perte à rester silencieux
// jusqu'à la première interaction.
let audioCtx = null;
let soundEnabled = false;

function getAudioContext() {
  if (!audioCtx) {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return null; // navigateur trop ancien : silencieux, jamais bloquant
    audioCtx = new AudioCtx();
  }
  return audioCtx;
}

function playTone({ freq, duration, type = 'sine', volume = 0.15, delay = 0 }) {
  if (!soundEnabled) return;
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    if (ctx.state === 'suspended') ctx.resume();

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;

    const startTime = ctx.currentTime + delay;
    gain.gain.setValueAtTime(0, startTime);
    gain.gain.linearRampToValueAtTime(volume, startTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.001, startTime + duration);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(startTime);
    osc.stop(startTime + duration + 0.02);
  } catch (e) {
    // Web Audio indisponible/bloqué (permissions, contexte non déverrouillé...) :
    // le son est un confort, jamais une raison de casser le reste de l'interaction.
  }
}

function playClickSound() {
  playTone({ freq: 720, duration: 0.06, type: 'sine', volume: 0.12 });
}

// Roulette : tick court dont la hauteur descend avec la progression (t de 0 à 1) ; le rythme
// qui ralentit vient du freinage de la roue (cf. spinGambleWheel).
function playRouletteTickSound(t) {
  playTone({ freq: 900 - t * 400, duration: 0.035, type: 'square', volume: 0.035 });
}

// Son d'arrêt : accord montant si le résultat est favorable, descendant sinon.
function playRouletteStopSound(isBonus) {
  const notes = isBonus ? [523.25, 659.25, 1046.5] : [392, 311.13, 233.08];
  notes.forEach((freq, i) => {
    playTone({ freq, duration: 0.2, type: isBonus ? 'triangle' : 'sawtooth', volume: 0.12, delay: i * 0.08 });
  });
}

function playRevealSound() {
  playTone({ freq: 520, duration: 0.09, type: 'triangle', volume: 0.14 });
  playTone({ freq: 780, duration: 0.12, type: 'triangle', volume: 0.1, delay: 0.06 });
}

function playVictorySound() {
  [523.25, 659.25, 783.99, 1046.5].forEach((freq, i) => {
    playTone({ freq, duration: 0.22, type: 'triangle', volume: 0.13, delay: i * 0.09 });
  });
}

function playDefeatSound() {
  [440, 349.23, 293.66].forEach((freq, i) => {
    playTone({ freq, duration: 0.28, type: 'sawtooth', volume: 0.1, delay: i * 0.12 });
  });
}

// ============================================================
// RÉGLAGES (chrome persistant, barre d'app)
// ============================================================
// Section volontairement isolée et indépendante de tout flux de partie : ouverture/
// fermeture du panneau + 4 réglages (réduction d'animations, son, thème de fond, crédits
// statiques). Persisté en localStorage et réappliqué au chargement AVANT le premier
// rendu par le script anti-flash dans <head> (index.html) pour thème/animations — le son
// reste désactivé par défaut tant que le visiteur n'a pas interagi une première fois
// (cf. plus bas, contrainte des navigateurs sur l'audio).
const SETTINGS_STORAGE_KEY = 'rdb_settings_v1';

const btnSettings = document.getElementById('btn-settings');
const settingsOverlayEl = document.getElementById('settings-overlay');
const btnSettingsClose = document.getElementById('btn-settings-close');
const settingsReduceMotionInput = document.getElementById('settings-reduce-motion');
const settingsSoundInput = document.getElementById('settings-sound');
const settingsAutoReconnectInput = document.getElementById('settings-auto-reconnect');
const settingsThemeButtons = Array.from(document.querySelectorAll('.settings-theme-swatch'));

function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY)) || {};
  } catch (e) {
    return {};
  }
}

function saveSettings(settings) {
  try {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch (e) {
    // localStorage indisponible (navigation privée, quota...) : le réglage reste actif
    // pour la session en cours via les classes/attributs déjà posés sur <html>, seule
    // la persistance entre sessions est perdue.
  }
}

function applyTheme(theme) {
  if (theme && theme !== 'default') {
    document.documentElement.dataset.theme = theme;
  } else {
    delete document.documentElement.dataset.theme;
  }
  settingsThemeButtons.forEach(btn => {
    btn.classList.toggle('settings-theme-swatch--selected', (theme || 'default') === btn.dataset.theme);
  });
}

function applyReduceMotion(enabled) {
  document.documentElement.classList.toggle('reduce-motion', !!enabled);
  settingsReduceMotionInput.checked = !!enabled;
}

function applySoundSetting(enabled) {
  soundEnabled = !!enabled;
  settingsSoundInput.checked = soundEnabled;
}

// true par défaut (comportement historique inchangé) : seul un false explicite désactive
// la reprise automatique de partie au chargement (cf. le bloc tout en haut du fichier et
// socket.on('connect', ...)).
function applyAutoReconnectSetting(enabled) {
  settingsAutoReconnectInput.checked = enabled !== false;
}

function openSettings() {
  resetSettingsTabs();
  refreshAccountSettingsSection();
  settingsOverlayEl.classList.remove('screen--hidden');
}

function closeSettings() {
  settingsOverlayEl.classList.add('screen--hidden');
}

// Synchronise l'UI du panneau avec l'état déjà appliqué par le script anti-flash.
(function initSettingsUI() {
  const settings = loadSettings();
  applyTheme(settings.theme || 'default');
  applyReduceMotion(!!settings.reduceMotion);
  applySoundSetting(!!settings.sound);
  applyAutoReconnectSetting(settings.autoReconnect);
})();

btnSettings.addEventListener('click', openSettings);
btnSettingsClose.addEventListener('click', closeSettings);
settingsOverlayEl.addEventListener('click', (e) => {
  if (e.target === settingsOverlayEl) closeSettings(); // clic sur le fond, pas sur la modale
});

settingsReduceMotionInput.addEventListener('change', () => {
  const settings = loadSettings();
  settings.reduceMotion = settingsReduceMotionInput.checked;
  saveSettings(settings);
  applyReduceMotion(settings.reduceMotion);
});

settingsSoundInput.addEventListener('change', () => {
  const settings = loadSettings();
  settings.sound = settingsSoundInput.checked;
  saveSettings(settings);
  applySoundSetting(settings.sound);
  // Le clic qui active le son EST le geste utilisateur requis par les navigateurs pour
  // débloquer l'audio : on joue un petit son de confirmation immédiatement, ce qui
  // "débloque" le contexte audio pour tous les sons suivants de la session.
  if (soundEnabled) playClickSound();
});

settingsAutoReconnectInput.addEventListener('change', () => {
  const settings = loadSettings();
  settings.autoReconnect = settingsAutoReconnectInput.checked;
  saveSettings(settings);
  applyAutoReconnectSetting(settings.autoReconnect);
});

settingsThemeButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    const settings = loadSettings();
    settings.theme = btn.dataset.theme;
    saveSettings(settings);
    applyTheme(settings.theme);
  });
});

// Cadre : contrairement au thème (préférence locale, cf. ci-dessus), c'est un attribut du
// COMPTE (comme l'avatar) — persisté serveur, jamais juste en localStorage. Les boutons
// verrouillés sont natively disabled (cf. applyUnlockLocks), donc jamais cliquables ici.
accountFrameButtons.forEach(btn => {
  btn.addEventListener('click', async () => {
    const account = getStoredAccount();
    if (!account) return;
    const frame = btn.dataset.frame || '';
    try {
      const res = await fetch('/api/profile/frame', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accessToken: account.accessToken, frame })
      });
      const data = await res.json();
      if (!res.ok) {
        accountErrorEl.textContent = data.error || "Le cadre n'a pas pu être changé.";
        return;
      }
      const updated = Object.assign({}, account, { frame: data.frame });
      setStoredAccount(updated);
      applyAvatarFrame(accountAvatarCurrentEl, updated.frame);
      refreshCosmeticLocks();
    } catch (err) {
      accountErrorEl.textContent = 'Connexion au serveur impossible.';
    }
  });
});

// ============================================================
// PRÉCHARGEMENT DES SPRITES (perf perçue)
// ============================================================
// Sans ça, chaque nouveau Pokémon jamais vu (tour, boss, case Devine le Pokémon...)
// déclenche un premier chargement d'image visible (petit flash/pop-in) au moment même où
// il faudrait déjà l'afficher. Ici, on récupère la liste complète des dex id possibles
// (cf. GET /api/sprite-ids côté serveur) et on précharge discrètement chaque sprite en
// arrière-plan dès l'arrivée sur la page — l'essentiel du temps passé en lobby/accueil
// sert de fenêtre de chargement gratuite, avant qu'une partie ne les demande "pour de
// vrai". Par petits paquets espacés : la partie encore en cours (si reconnexion) ou les
// premières images réellement affichées restent prioritaires, jamais concurrencées par
// ce préchargement de fond.
(function preloadSpritesInBackground() {
  const BATCH_SIZE = 12;
  const BATCH_DELAY_MS = 120;

  // Même construction d'URL que spriteUrl() côté serveur (server.js) : le préchargement
  // n'a aucune donnée Pokémon complète à disposition, juste des dex id bruts.
  function spriteUrlFromId(dexId) {
    return `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/${dexId}.png`;
  }

  fetch('/api/sprite-ids')
    .then(res => res.ok ? res.json() : [])
    .then(ids => {
      if (!Array.isArray(ids) || ids.length === 0) return;
      let i = 0;
      function loadNextBatch() {
        const batch = ids.slice(i, i + BATCH_SIZE);
        batch.forEach(id => {
          const img = new Image();
          img.src = spriteUrlFromId(id); // sprite normal uniquement (le shiny, 2% de tirage, n'est pas préchargé pour limiter la bande passante)
        });
        i += BATCH_SIZE;
        if (i < ids.length) setTimeout(loadNextBatch, BATCH_DELAY_MS);
      }
      loadNextBatch();
    })
    .catch(() => {
      // Échec silencieux (offline, manifeste indisponible...) : simple dégradation vers
      // le comportement précédent (chargement à la demande), jamais bloquant.
    });
})();

// ---------- PWA : service worker + bouton d'installation ----------
// sw.js (racine) : cache des sprites/polices/shell, cf. commentaire en tête du fichier.
// Le SW n'est actif qu'en HTTPS ou sur localhost.
(function setupPwa() {
  if ('serviceWorker' in navigator) {
    const register = () => navigator.serviceWorker.register('/sw.js').catch(() => {});
    if (document.readyState === 'complete') register();
    else window.addEventListener('load', register, { once: true });
  }

  const block = document.getElementById('pwa-install-block');
  const btn = document.getElementById('btn-pwa-install');
  const hint = document.getElementById('pwa-install-hint');
  if (!block || !btn || !hint) return;

  const standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  if (standalone) return; // déjà installée : rien à proposer

  let deferredPrompt = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    block.classList.remove('screen--hidden');
    btn.classList.remove('screen--hidden');
  });
  btn.addEventListener('click', async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    try { await deferredPrompt.userChoice; } catch (e) {}
    deferredPrompt = null;
    block.classList.add('screen--hidden');
  });
  window.addEventListener('appinstalled', () => block.classList.add('screen--hidden'));

  // iOS Safari : pas d'événement d'installation, seulement l'indication manuelle.
  if (/iphone|ipad|ipod/i.test(navigator.userAgent)) {
    block.classList.remove('screen--hidden');
    hint.classList.remove('screen--hidden');
  }
})();
