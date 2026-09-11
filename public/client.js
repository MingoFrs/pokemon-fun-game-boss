const socket = io();

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
const accountStatusGuestEl = document.getElementById('account-status-guest');
const accountStatusLoggedEl = document.getElementById('account-status-logged');
const accountStatusPseudoEl = document.getElementById('account-status-pseudo');
const btnAccountOpen = document.getElementById('btn-account-open');
const btnAccountLogout = document.getElementById('btn-account-logout');
const accountOverlayEl = document.getElementById('account-overlay');
const btnAccountClose = document.getElementById('btn-account-close');
const accountTabButtons = Array.from(document.querySelectorAll('#account-tabs .admin-role-btn'));
const accountFormLoginEl = document.getElementById('account-form-login');
const accountFormRegisterEl = document.getElementById('account-form-register');
const accountLoginEmailEl = document.getElementById('account-login-email');
const accountLoginPasswordEl = document.getElementById('account-login-password');
const accountRegisterPseudoEl = document.getElementById('account-register-pseudo');
const accountRegisterEmailEl = document.getElementById('account-register-email');
const accountRegisterPasswordEl = document.getElementById('account-register-password');
const btnAccountLogin = document.getElementById('btn-account-login');
const btnAccountRegister = document.getElementById('btn-account-register');
const accountErrorEl = document.getElementById('account-error');

// Compte connecté (ou null) : { accessToken, refreshToken, pseudo }. accessToken n'est
// pas réellement utilisé par ce jeu pour l'instant (pas d'action nécessitant un accès
// authentifié au-delà du pseudo) — gardé pour plus tard (ex: historique de parties lié
// au compte) plutôt que jeté.
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

function applyAccountUI(account) {
  if (account) {
    accountStatusGuestEl.classList.add('screen--hidden');
    accountStatusLoggedEl.classList.remove('screen--hidden');
    accountStatusPseudoEl.textContent = account.pseudo;
    // Toujours synchroniser (pas seulement si le champ est vide) : se connecter à un
    // compte doit systématiquement remplacer le pseudo affiché par celui du compte,
    // même si un autre pseudo traînait dans le champ (mode invité précédent, etc.).
    pseudoInput.value = account.pseudo;
  } else {
    accountStatusGuestEl.classList.remove('screen--hidden');
    accountStatusLoggedEl.classList.add('screen--hidden');
  }
}
applyAccountUI(getStoredAccount());

// Restaure la session au chargement (silencieux : en cas d'échec, on retombe simplement
// en mode invité sans message d'erreur intrusif — l'utilisateur n'a rien demandé ici).
(async function restoreAccountSession() {
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
    const account = { accessToken: data.accessToken, refreshToken: data.refreshToken, pseudo: data.pseudo };
    setStoredAccount(account);
    applyAccountUI(account);
  } catch (err) {
    // Hors-ligne ou serveur injoignable au chargement : on ne touche à rien, la session
    // stockée reste telle quelle pour une prochaine tentative (ex: prochain chargement).
  }
})();

function openAccountOverlay() {
  accountErrorEl.textContent = '';
  accountOverlayEl.classList.remove('screen--hidden');
}
function closeAccountOverlay() {
  accountOverlayEl.classList.add('screen--hidden');
}

btnAccountOpen.addEventListener('click', openAccountOverlay);
btnAccountClose.addEventListener('click', closeAccountOverlay);

btnAccountLogout.addEventListener('click', () => {
  setStoredAccount(null);
  applyAccountUI(null);
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
    const account = { accessToken: data.accessToken, refreshToken: data.refreshToken, pseudo: data.pseudo };
    setStoredAccount(account);
    applyAccountUI(account);
    closeAccountOverlay();
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
    const account = { accessToken: data.accessToken, refreshToken: data.refreshToken, pseudo: data.pseudo };
    setStoredAccount(account);
    applyAccountUI(account);
    closeAccountOverlay();
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
const gamemodeHintEl = document.getElementById('gamemode-hint');
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
const metamorphResultTitleEl = document.getElementById('metamorph-result-title');
const metamorphResultSpriteEl = document.getElementById('metamorph-result-sprite');
const metamorphResultDetailEl = document.getElementById('metamorph-result-detail');
const metamorphResultFinalEl = document.getElementById('metamorph-result-final');
let metamorphResultTimer = null;
const gamePlayersListEl = document.getElementById('game-players-list');
const btnLeaveGame = document.getElementById('btn-leave-game');

// ---------- Tour 4 spécial : avantage / bonus ----------
const choiceCardsEl = document.getElementById('choice-cards');
const advantagePanelEl = document.getElementById('advantage-panel');
const btnAdvantagePokemon = document.getElementById('btn-advantage-pokemon');
const btnAdvantageBonus = document.getElementById('btn-advantage-bonus');
const bonusPanelEl = document.getElementById('bonus-panel');
const bonusCardA = document.getElementById('bonus-card-a');
const bonusCardALabelEl = document.getElementById('bonus-card-a-label');
const bonusCardADescEl = document.getElementById('bonus-card-a-desc');
const bonusCardB = document.getElementById('bonus-card-b');
const bonusCardBLabelEl = document.getElementById('bonus-card-b-label');
const bonusCardBDescEl = document.getElementById('bonus-card-b-desc');
const bonusTargetPanelEl = document.getElementById('bonus-target-panel');
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

const RARITY_LABELS = {
  commun: 'Commun',
  peu_commun: 'Peu commun',
  rare: 'Rare',
  epique: 'Épique',
  pseudo_legendaire: 'Pseudo-légendaire',
  legendaire: 'Légendaire'
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

const BONUS_DESCRIPTIONS = {
  xpCandy: 'Fait évoluer un Pokémon de ton équipe jusqu\'à sa forme finale.',
  mysteryItem: 'Applique un trait aléatoire à un Pokémon — quitte ou double.',
  shinyCharm: 'Améliore tes chances de Pokémon puissants aux tours 5 et 6.'
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
  gamemodeHintEl.classList.toggle('screen--hidden', !needsGuessHint && !needsAuctionHint);
  if (needsGuessHint) {
    gamemodeHintEl.textContent = lastLobbyPlayers.length > 2
      ? 'Choisis les 2 joueurs qui vont jouer ci-dessous — les autres seront spectateurs.'
      : 'Ce mode nécessite exactement 2 joueurs.';
  } else if (needsAuctionHint) {
    gamemodeHintEl.textContent = lastLobbyPlayers.length === 2
      ? 'Choisis le type de draft ci-dessous, puis lance la partie.'
      : 'Ce mode nécessite exactement 2 joueurs, ni plus ni moins.';
  }
  guessDurationPanelEl.classList.toggle('screen--hidden', currentGameMode !== 'guess');
  auctionTypePanelEl.classList.toggle('screen--hidden', currentGameMode !== 'auction');
}

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

function renderPlayers(listEl, players) {
  listEl.innerHTML = '';
  players.forEach(p => {
    const li = document.createElement('li');
    li.classList.toggle('player-item--disconnected', !!p.disconnected);

    const row = document.createElement('div');
    row.className = 'player-item__row';

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
    if (p.hasChosen) {
      const check = document.createElement('span');
      check.className = 'player-check';
      check.textContent = '✓';
      name.appendChild(check);
    }

    const score = document.createElement('span');
    score.className = 'player-score';
    score.textContent = `${p.score} pts`;

    row.appendChild(name);
    row.appendChild(score);
    li.appendChild(row);

    // Mini équipe (sprites en petit) : uniquement une fois que le joueur a des Pokémon
    // (lobby -> team toujours vide, rien ne s'affiche). Volontairement en LECTURE SEULE,
    // aucune donnée secrète (pas d'effet/rareté/points), juste ce que tout le monde verra
    // de toute façon à l'écran de fin.
    if (p.team && p.team.length > 0) {
      const teamRow = document.createElement('div');
      teamRow.className = 'player-item__team';
      p.team.forEach(mon => {
        const icon = document.createElement('img');
        icon.className = 'player-item__team-icon';
        icon.src = pokemonSprite(mon);
        icon.alt = mon.name;
        teamRow.appendChild(icon);
      });
      li.appendChild(teamRow);
    }

    listEl.appendChild(li);
  });
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
  advantagePanelEl.classList.toggle('screen--hidden', phase !== 'advantage');
  bonusPanelEl.classList.toggle('screen--hidden', phase !== 'bonus-pick');
  bonusTargetPanelEl.classList.toggle('screen--hidden', phase !== 'bonus-target');
  adminViewPanelEl.classList.toggle('screen--hidden', phase !== 'admin-view');
}

function setAdvantageButtonsEnabled(enabled) {
  btnAdvantagePokemon.disabled = !enabled;
  btnAdvantageBonus.disabled = !enabled;
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
      ? `${c.data.effectName} ×${c.data.multiplier} · Shiny ×${SHINY_POINTS_MULTIPLIER}`
      : `${c.data.effectName} ×${c.data.multiplier}`;
    c.sprite.closest('.admin-view-card').classList.toggle('admin-view-card--shiny', !!c.data.shiny);
  });
}

// Bouton "cible" (sprite + nom) pour choisir un Pokémon de l'équipe. Réutilisé par
// renderBonusTargetList (Bonbon XP / Objet Mystère, tour 4) et renderEventTeamPicker
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
// serveur) et Objet Mystère (toute l'équipe). Le client ne renvoie que l'index fourni
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

function renderLotteryStart(payload) {
  eventBodyEl.appendChild(buildEventText('Choisis une carte — son contenu est un mystère.', 'event-modal__hint'));
  const row = document.createElement('div');
  row.className = 'choice-cards';
  for (let i = 0; i < payload.cardCount; i++) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'choice-card';
    const mark = document.createElement('span');
    mark.className = 'choice-card__icon';
    mark.textContent = '❓';
    btn.appendChild(mark);
    btn.addEventListener('click', () => {
      Array.from(row.children).forEach(b => { b.disabled = true; });
      sendEventAction({ index: i });
    });
    row.appendChild(btn);
  }
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
    case 'LOTTERY': renderLotteryStart(payload); break;
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
  wrap.appendChild(buildEventText(`${payload.pokemonName} reçoit : ${payload.effect.name} (×${payload.effect.multiplier})`));
  wrap.appendChild(buildDeltaLine(payload.scoreDelta));
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

function renderLotteryResult(payload) {
  const wrap = document.createElement('div');
  wrap.className = 'event-result';
  let text = '';
  let delta = 0;

  if (payload.kind === 'pokemon') {
    wrap.appendChild(buildEventSprite(payload.pokemon.sprite, payload.pokemon.name));
    text = `${payload.pokemon.name} rejoint ton équipe !`;
    delta = payload.pointsGained;
  } else if (payload.kind === 'points') {
    text = 'Bonus de points !';
    delta = payload.pointsGained;
  } else if (payload.kind === 'trait') {
    wrap.appendChild(buildEventSprite(payload.sprite, payload.pokemonName));
    text = `${payload.pokemonName} reçoit : ${payload.effect.name} (×${payload.effect.multiplier})`;
    delta = payload.scoreDelta;
  } else if (payload.kind === 'evolution') {
    wrap.appendChild(buildEventSprite(payload.sprite, payload.to));
    text = `${payload.from} évolue en ${payload.to} !`;
    delta = payload.scoreDelta;
  }

  wrap.appendChild(buildEventText(text));
  wrap.appendChild(buildDeltaLine(delta));
  eventBodyEl.appendChild(wrap);
  eventBodyEl.appendChild(buildEventCloseButton());
  updateMyScore(payload.score, delta);
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

function renderMirrorResult(payload) {
  const wrap = document.createElement('div');
  wrap.className = 'event-result';
  wrap.appendChild(buildEventSprite(payload.pokemon.sprite, payload.pokemon.name));
  wrap.appendChild(buildEventText(`Toi et ${payload.opponentName} recevez ${payload.pokemon.name} !`));
  wrap.appendChild(buildDeltaLine(payload.pointsGained));
  eventBodyEl.appendChild(wrap);
  eventBodyEl.appendChild(buildEventCloseButton());
  updateMyScore(payload.score, payload.pointsGained);
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
    case 'LOTTERY': renderLotteryResult(payload); break;
    case 'TIME_RIFT': renderTimeRiftResult(payload); break;
    case 'MIRROR': renderMirrorResult(payload); break;
    case 'CROSSED_FATES': renderCrossedFatesResult(payload); break;
    case 'DUEL': renderDuelResult(payload); break;
    default: eventBodyEl.appendChild(buildEventCloseButton());
  }

  // Le score est géré par chaque renderXxxResult (le calcul du delta net diffère selon
  // le type, ex: skip = aucun changement). L'équipe, elle, suit toujours la même règle.
  if (payload.team) renderTeam(payload.team, true); // toujours ta propre équipe (résultat d'événement rare)
}


function showBonusResult(data) {
  const titles = {
    xpCandy: 'Bonbon XP',
    mysteryItem: 'Objet Mystère',
    shinyCharm: 'Charme Chroma'
  };
  bonusResultTitleEl.textContent = titles[data.type] || '';

  if (data.type === 'shinyCharm') {
    bonusResultSpriteEl.classList.add('screen--hidden');
    bonusResultDetailEl.textContent = 'Activé pour les tours 5 et 6 !';
    bonusResultFinalEl.textContent = '';
  } else if (data.type === 'xpCandy') {
    bonusResultSpriteEl.classList.remove('screen--hidden');
    bonusResultSpriteEl.src = data.sprite;
    bonusResultDetailEl.textContent = `${data.from} → ${data.to}`;
    bonusResultFinalEl.textContent = `${data.scoreDelta >= 0 ? '+' : ''}${data.scoreDelta} PTS`;
  } else if (data.type === 'mysteryItem') {
    bonusResultSpriteEl.classList.remove('screen--hidden');
    bonusResultSpriteEl.src = data.sprite;
    bonusResultDetailEl.textContent = `${data.pokemonName} — ${data.effect.name} ×${data.effect.multiplier}`;
    bonusResultFinalEl.textContent = `${data.scoreDelta >= 0 ? '+' : ''}${data.scoreDelta} PTS`;
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
  // (choice/advantage/bonus-pick/bonus-target sont mutuellement exclusifs).
  showTurnPhase('none');
  setAdvantageButtonsEnabled(false);
  bonusCardA.disabled = true;
  bonusCardB.disabled = true;
  bonusTargetListEl.innerHTML = '';

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

function applyGameState({ status, turn, maxTurns, route, players }) {
  flashTurnLabel(turn);
  turnCurrentEl.textContent = turn;
  turnMaxEl.textContent = maxTurns;
  renderRoute(route);
  updateBossProximity(turn, maxTurns);
  updateSkipButton(players);
  renderPlayers(gamePlayersListEl, players);

  // Mode ADMIN VS JOUEUR : l'ADMIN n'a ni score ni équipe (cf. spec section 3) — le
  // panneau "score" affiche celui du JOUEUR observé, jamais le sien (toujours à 0).
  const observed = isAdminNow() ? players.find(p => p.id !== currentAdminId) : players.find(p => p.id === myId);
  if (observed) {
    renderTeam(observed.team, !isAdminNow()); // ADMIN observe en lecture seule, jamais interactif
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
  socket.emit('create_game', { name, token: deviceToken });
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
  socket.emit('join_game', { name, gameId: code, token: deviceToken });
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

// ---------- Actions : tour 4 spécial ----------
btnAdvantagePokemon.addEventListener('click', () => {
  setAdvantageButtonsEnabled(false);
  socket.emit('special_choice', { mode: 'POKEMON' });
});

btnAdvantageBonus.addEventListener('click', () => {
  setAdvantageButtonsEnabled(false);
  socket.emit('special_choice', { mode: 'BONUS' });
});

bonusCardA.addEventListener('click', () => {
  bonusCardA.disabled = true;
  bonusCardB.disabled = true;
  turnStatusEl.textContent = 'Choix enregistré !';
  socket.emit('bonus_choice', { key: bonusCardA.dataset.key });
});

bonusCardB.addEventListener('click', () => {
  bonusCardA.disabled = true;
  bonusCardB.disabled = true;
  turnStatusEl.textContent = 'Choix enregistré !';
  socket.emit('bonus_choice', { key: bonusCardB.dataset.key });
});

btnSkip.addEventListener('click', () => {
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
      adminId: payload.adminId
    });
  } else if (payload.status === 'finished') {
    applyGameFinished({
      boss: payload.boss,
      difficulty: payload.difficulty,
      gameMode: payload.gameMode,
      adminId: payload.adminId,
      reason: null,
      players: payload.players
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

socket.on('game_created', ({ gameId, players, hostId: hId, difficulty, gameMode, adminId, activePlayerIds, guessTurnDurationMs, auctionType }) => {
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
  updateHostControls();
  showScreen(screenLobby);
});

socket.on('game_joined', ({ gameId, players, hostId: hId, difficulty, gameMode, adminId, activePlayerIds, guessTurnDurationMs, auctionType }) => {
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
  updateHostControls();
  showScreen(screenLobby);
});

socket.on('game_replayed', ({ gameId, players, hostId: hId, difficulty, gameMode, adminId, activePlayerIds, guessTurnDurationMs, auctionType }) => {
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
function applyGameStarted({ status, turn, maxTurns, route, boss, players, gameMode, adminId }) {
  resetGameUI(); // aucun résidu de l'ancienne partie ; masque aussi le choix tour 4 par défaut
  currentGameMode = gameMode || 'normal';
  currentAdminId = adminId || null;
  myScoreLabelEl.textContent = isAdminNow() ? 'Score du joueur' : 'Ton score';
  bossTarget = boss.requiredPoints;
  bossSpriteEl.src = boss.sprite;
  bossNameEl.textContent = boss.name.toUpperCase();
  bossTargetValueEl.textContent = boss.requiredPoints;
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

// Tour 4 uniquement : "CHOISIS TON AVANTAGE" (POKÉMON ou BONUS).
socket.on('advantage_options', () => {
  resultPanelEl.classList.add('result-panel--hidden');
  bonusResultPanelEl.classList.add('result-panel--hidden');
  hasChosenThisTurn = false;
  setAdvantageButtonsEnabled(true);
  turnStatusEl.textContent = 'Choisis ton avantage';
  showTurnPhase('advantage');
});

// Les 2 bonus tirés par le serveur pour ce joueur (jamais choisis par le client).
socket.on('bonus_options', ({ bonuses }) => {
  bonusCardA.dataset.key = bonuses[0].key;
  bonusCardALabelEl.textContent = bonuses[0].label;
  bonusCardADescEl.textContent = BONUS_DESCRIPTIONS[bonuses[0].key] || '';
  bonusCardA.disabled = false;

  bonusCardB.dataset.key = bonuses[1].key;
  bonusCardBLabelEl.textContent = bonuses[1].label;
  bonusCardBDescEl.textContent = BONUS_DESCRIPTIONS[bonuses[1].key] || '';
  bonusCardB.disabled = false;

  turnStatusEl.textContent = 'Choisis ton bonus';
  showTurnPhase('bonus-pick');
});

// Bonbon XP : uniquement les Pokémon réellement évoluables (filtré côté serveur).
socket.on('xp_candy_pending', ({ team }) => {
  bonusTargetTitleEl.textContent = 'Choisis un Pokémon à faire évoluer';
  renderBonusTargetList(team, (index) => {
    socket.emit('xp_candy_select', { index });
  });
  turnStatusEl.textContent = 'Bonbon XP';
  showTurnPhase('bonus-target');
});

// Objet Mystère : toute l'équipe, le trait reste tiré par le serveur ensuite.
socket.on('mystery_item_pending', ({ team }) => {
  bonusTargetTitleEl.textContent = 'Choisis un Pokémon';
  renderBonusTargetList(team, (index) => {
    socket.emit('mystery_item_select', { index });
  });
  turnStatusEl.textContent = 'Objet Mystère';
  showTurnPhase('bonus-target');
});

// Résultat final du bonus choisi (quel que soit son type).
socket.on('bonus_result', (data) => {
  showTurnPhase('none'); // tour 4 résolu : masque avantage/bonus/cible avant le tour 5
  showBonusResult(data);
  if (data.team) renderTeam(data.team, true); // toujours ta propre équipe (résultat de bonus tour 4)
  updateMyScore(data.score, data.scoreDelta);
});

socket.on('choice_result', ({ pokemon, rarity, basePoints, effect, pointsGained, score, team }) => {
  resultPanelEl.dataset.rarity = rarity || 'commun'; // rareté fournie par le serveur, jamais déterminée ici
  resultPanelEl.classList.toggle('result-panel--shiny', !!pokemon.shiny);
  resultRarityEl.textContent = RARITY_LABELS[rarity] || '';
  resultSpriteEl.src = pokemonSprite(pokemon);
  resultSpriteEl.onerror = pokemon.shiny ? () => { resultSpriteEl.src = pokemon.sprite; } : null;
  resultNameEl.textContent = pokemon.shiny ? `✨ ${pokemon.name.toUpperCase()}` : pokemon.name.toUpperCase();
  resultBaseEl.textContent = basePoints;
  resultEffectEl.textContent = pokemon.shiny
    ? `${effect.name} ×${effect.multiplier} · Shiny ×${SHINY_POINTS_MULTIPLIER}`
    : `${effect.name} ×${effect.multiplier}`;
  resultEffectEl.classList.toggle('result-effect--bonus', effect.multiplier >= 1);
  resultEffectEl.classList.toggle('result-effect--malus', effect.multiplier < 1);
  resultPointsEl.textContent = pointsGained;
  resultPanelEl.classList.remove('result-panel--hidden');
  playRevealAnimation();
  playRevealSound();
  renderTeam(team, true); // toujours ta propre équipe (résultat de ton propre choix)
  updateMyScore(score, pointsGained);
});

socket.on('game_updated', ({ status, turn, maxTurns, route, players, hostId: hId, adminId }) => {
  if (hId) hostId = hId;
  if (adminId !== undefined) currentAdminId = adminId;
  if (isSpectating) {
    renderSpectateView({ status, turn, maxTurns, boss: spectateBoss, players });
    return;
  }
  applyGameState({ status, turn, maxTurns, route, players });
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

      if (mon.evolvedFrom) {
        const evoTag = document.createElement('p');
        evoTag.className = 'finished-team-slot__evo';
        evoTag.textContent = `${mon.evolvedFrom} → ${mon.name} (Bonbon XP)`;
        slot.appendChild(evoTag);
      }

      if (mon.effectName && mon.effectName !== 'Neutre') {
        const traitTag = document.createElement('p');
        traitTag.className = `finished-team-slot__trait ${mon.multiplier >= 1 ? 'finished-team-slot__trait--bonus' : 'finished-team-slot__trait--malus'}`;
        traitTag.textContent = `${mon.effectName} ×${mon.multiplier}`;
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

function applyGameFinished({ boss, difficulty, gameMode, adminId, reason, players }) {
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
  ['easy', 'medium', 'hard', 'extreme'].forEach(d => {
    finishedDifficultyEl.classList.toggle(`finished-difficulty-badge--${d}`, d === difficulty);
  });
  finishedTargetEl.textContent = `${boss.requiredPoints} PTS`;
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

    const name = document.createElement('p');
    name.className = 'finished-card__name';
    // Mode ADMIN VS JOUEUR : précise le rôle à côté du pseudo (l'ADMIN a un score à 0,
    // sinon incompréhensible dans le classement/badge).
    name.textContent = currentGameMode === 'admin'
      ? `${p.name} (${p.id === currentAdminId ? 'ADMIN' : 'JOUEUR'})`
      : p.name;

    const score = document.createElement('p');
    score.className = 'finished-card__score';
    score.textContent = `${p.score} PTS`;

    nameRow.appendChild(name);
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
    // serveur) : pas de vue plateau dédiée pour l'instant, juste un statut simple sur
    // l'écran spectateur générique (planche + secrets restent invisibles, comme pour
    // les 2 joueurs actifs eux-mêmes tant qu'ils n'ont pas révélé quoi que ce soit).
    spectateBoss = null;
    renderSpectateView({ status: 'playing', gameMode: 'guess', players });
    return;
  }
  resetGuessUI();
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
    renderSpectateView({ status: 'playing', gameMode: 'guess', boss: spectateBoss, players });
    return;
  }
  renderGuessPlayers(players);
});

socket.on('guess_turn_started', ({ activePlayerId, turnEndsAt, turnDurationMs }) => {
  if (isSpectating) return; // pas de minuteur/tour à afficher côté spectateur pour l'instant

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
  if (isSpectating) return; // écran spectateur générique : pas de fil de tentatives pour l'instant

  guessLastAttemptEl.classList.remove('guess-last-attempt--correct', 'guess-last-attempt--wrong');
  guessLastAttemptEl.classList.add(correct ? 'guess-last-attempt--correct' : 'guess-last-attempt--wrong');
  guessLastAttemptEl.textContent = correct
    ? `✅ ${guessPlayerName(by)} a trouvé : ${name} !`
    : `❌ ${guessPlayerName(by)} a tenté ${name} — mauvaise réponse.`;
  guessLastAttemptEl.classList.remove('screen--hidden');
});

socket.on('guess_game_over', ({ winnerId, reason, secretPokemon, players }) => {
  if (isSpectating) {
    // Même logique que game_finished pour Route du Boss : ne jamais rediriger un
    // spectateur vers #screen-guess-finished (vue "victoire/défaite" propre aux 2
    // joueurs actifs, sans objet pour lui).
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
const auctionOppTeamLabelEl = document.getElementById('auction-opp-team-label');
const auctionOppTeamCountEl = document.getElementById('auction-opp-team-count');
const auctionOppTeamSlotsEl = document.getElementById('auction-opp-team-slots');
const auctionHistoryListEl = document.getElementById('auction-history-list');
const auctionFinishedTitleEl = document.getElementById('auction-finished-title');
const auctionFinishedReasonEl = document.getElementById('auction-finished-reason');
const auctionFinishedMySlotsEl = document.getElementById('auction-finished-my-slots');
const auctionFinishedMyBudgetEl = document.getElementById('auction-finished-my-budget');
const auctionFinishedOppLabelEl = document.getElementById('auction-finished-opp-label');
const auctionFinishedOppSlotsEl = document.getElementById('auction-finished-opp-slots');
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
    renderAuctionTeamSlots(auctionMyTeamSlotsEl, me.team);
  }
  if (opp) {
    auctionOppNameEl.textContent = opp.name + (opp.disconnected ? ' (déconnecté)' : '');
    auctionOppTeamLabelEl.textContent = `Équipe de ${opp.name}`;
    auctionOppBudgetEl.textContent = formatAuctionMoneyClient(opp.budget);
    auctionBudgetOppEl.classList.toggle('auction-budget-card--empty', opp.budget <= 0);
    auctionOppTeamCountEl.textContent = `(${opp.teamCount}/6)`;
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
    auctionFinishedMyBudgetEl.textContent = `Budget restant : ${formatAuctionMoneyClient(me.budget)}`;
    btnAuctionCopyTeam.disabled = !(me.team && me.team.length);
  }
  if (opp) {
    auctionFinishedOppLabelEl.textContent = `Équipe de ${opp.name}`;
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
    const res = await fetch(`https://pokeapi.co/api/v2/pokemon-species/${dexId}/`);
    if (!res.ok) throw new Error('Réponse PokeAPI invalide');
    const data = await res.json();
    const entry = (data.names || []).find(n => n.language && n.language.name === 'en');
    return entry ? entry.name : null;
  } catch (err) {
    return null;
  }
}

// Descend la chaîne d'évolution PokeAPI d'un Pokémon jusqu'à sa forme FINALE, peu importe
// la méthode d'évolution (niveau, objet, échange, bonheur...). Seule une VRAIE branche
// (plusieurs évolutions possibles depuis un même stade, ex: Évoli) arrête la descente :
// impossible de deviner laquelle choisir, donc on s'arrête là plutôt que d'en inventer
// une. Repli sur dexId lui-même si l'appel échoue.
async function fetchFinalEvolutionId(dexId) {
  try {
    const speciesRes = await fetch(`https://pokeapi.co/api/v2/pokemon-species/${dexId}/`);
    if (!speciesRes.ok) throw new Error('Réponse PokeAPI invalide');
    const species = await speciesRes.json();
    const chainUrl = species.evolution_chain && species.evolution_chain.url;
    if (!chainUrl) return dexId;

    const chainRes = await fetch(chainUrl);
    if (!chainRes.ok) throw new Error('Chaîne d\u2019évolution indisponible');
    const { chain } = await chainRes.json();

    let node = chain;
    while (node.evolves_to && node.evolves_to.length === 1) {
      node = node.evolves_to[0];
    }
    const match = node.species.url.match(/\/pokemon-species\/(\d+)\//);
    return match ? Number(match[1]) : dexId;
  } catch (err) {
    return dexId;
  }
}

// Format d'import minimal (juste le nom de chaque Pokémon, séparé par une ligne vide) —
// compatible avec un import Smogon/Showdown basique. Ni l'talent ni l'objet/les
// capacités/EVs ne sont jamais suivis par le jeu, donc jamais inclus ici (rien à
// inventer). Chaque Pokémon est exporté sous sa forme ÉVOLUÉE AU MAXIMUM (cf.
// fetchFinalEvolutionId), pas celle réellement obtenue pendant le draft, puis traduit en
// anglais (cf. fetchEnglishPokemonName) — jamais l'inverse (traduire d'abord puis
// évoluer), pour n'interroger PokeAPI qu'avec des dexId, seule donnée fiable qu'on ait.
async function buildSmogonExport(team) {
  const names = await Promise.all((team || []).map(async mon => {
    const finalId = await fetchFinalEvolutionId(mon.id);
    const enName = await fetchEnglishPokemonName(finalId);
    return enName || mon.name; // repli sur le nom (français, stade obtenu) si PokeAPI n'a pas répondu
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
  resetAuctionUI();
  rememberActiveGame(gameId);
  renderAuctionPlayers(players);
  updateAuctionBidAvailability();
  showScreen(screenAuction);
});

socket.on('auction_lot_started', (payload) => {
  renderAuctionLot(payload);
});

socket.on('auction_bid_update', (payload) => {
  playClickSound();
  renderAuctionBidInfo(payload);
});

socket.on('auction_lot_resolved', (payload) => {
  playRevealSound();
  renderAuctionPlayers(payload.players);
  updateAuctionBidAvailability();
  addAuctionHistoryEntry(payload);
});

socket.on('auction_game_over', ({ reason, players, history }) => {
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

function renderSpectateView({ status, turn, maxTurns, boss, players, gameMode }) {
  if (gameMode) spectateGameMode = gameMode; // certains appelants (game_updated) n'ont pas ce champ
  const isGuess = spectateGameMode === 'guess';
  // Mode "Devine le Pokémon" : aucun concept de boss/route, le panneau n'a pas de sens.
  spectateBossPanelEl.classList.toggle('screen--hidden', isGuess);

  if (!isGuess) {
    if (boss) {
      spectateBossSpriteEl.src = boss.sprite;
      spectateBossSpriteEl.alt = boss.name;
      spectateBossNameEl.textContent = boss.name;
      spectateBossTargetEl.textContent = boss.requiredPoints;
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
    // Pas de vue plateau dédiée pour l'instant côté spectateur (planche/secrets restent
    // invisibles) : juste un statut simple, cf. socket.on('guess_game_started') plus haut.
    spectateTurnEl.textContent = 'Duel Devine le Pokémon en cours...';
  } else {
    spectateTurnEl.textContent = `Tour ${turn} / ${maxTurns}`;
  }
  renderPlayers(spectatePlayersListEl, players);
  spectateStatusEl.textContent = status === 'finished' ? 'La partie est terminée.' : '';
}

socket.on('spectate_joined', (payload) => {
  isSpectating = true;
  hostId = payload.hostId;
  spectateBoss = payload.boss;
  renderSpectateView(payload);
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