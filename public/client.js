const socket = io();

// ---------- Éléments DOM : écrans ----------
const screenHome = document.getElementById('screen-home');
const screenLobby = document.getElementById('screen-lobby');
const screenGame = document.getElementById('screen-game');
const screenFinished = document.getElementById('screen-finished');

// ---------- Accueil ----------
const pseudoInput = document.getElementById('pseudo-input');
const codeInput = document.getElementById('code-input');
const btnCreate = document.getElementById('btn-create');
const btnJoin = document.getElementById('btn-join');
const errorMessage = document.getElementById('error-message');

// ---------- Lobby ----------
const gameCodeEl = document.getElementById('game-code');
const playersListEl = document.getElementById('players-list');
const playersCountEl = document.getElementById('players-count');
const btnStart = document.getElementById('btn-start');
const btnLeave = document.getElementById('btn-leave');
const lobbyStatusEl = document.getElementById('lobby-status');
const btnCopyCode = document.getElementById('btn-copy-code');
const copyFeedbackEl = document.getElementById('copy-feedback');
const difficultyButtons = Array.from(document.querySelectorAll('.difficulty-btn'));

// ---------- Jeu ----------
const bossPanelEl = document.getElementById('boss-panel');
const bossSpriteEl = document.getElementById('boss-sprite');
const bossNameEl = document.getElementById('boss-name');
const bossTargetValueEl = document.getElementById('boss-target-value');
const myScoreValueEl = document.getElementById('my-score-value');
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
const resultPanelEl = document.getElementById('result-panel');
const resultRarityEl = document.getElementById('result-rarity');
const resultSpriteEl = document.getElementById('result-sprite');
const resultNameEl = document.getElementById('result-name');
const resultBaseEl = document.getElementById('result-base');
const resultEffectEl = document.getElementById('result-effect');
const resultPointsEl = document.getElementById('result-points');
const teamSlotsEl = document.getElementById('team-slots');
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
const finishedTargetEl = document.getElementById('finished-target');
const finishedMyTeamEl = document.getElementById('finished-my-team');
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

const RARITY_LABELS = {
  commun: 'Commun',
  peu_commun: 'Peu commun',
  rare: 'Rare',
  epique: 'Épique',
  pseudo_legendaire: 'Pseudo-légendaire',
  legendaire: 'Légendaire'
};

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
  [screenHome, screenLobby, screenGame, screenFinished].forEach(s => s.classList.add('screen--hidden'));
  screen.classList.remove('screen--hidden');
}

function isHost() {
  return !!(myId && hostId && myId === hostId);
}

function updateHostControls() {
  const host = isHost();
  btnStart.classList.toggle('screen--hidden', !host);
  difficultyButtons.forEach(btn => { btn.disabled = !host; });
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

    const name = document.createElement('span');
    name.textContent = p.name;
    if (p.id === hostId) {
      const hostTag = document.createElement('span');
      hostTag.className = 'player-host';
      hostTag.textContent = 'Hôte';
      name.appendChild(hostTag);
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

    li.appendChild(name);
    li.appendChild(score);
    listEl.appendChild(li);
  });
}

function renderLobbyPlayers(players) {
  playersCountEl.textContent = `(${players.length})`;
  renderPlayers(playersListEl, players);
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

function renderTeam(team) {
  teamSlotsEl.innerHTML = '';
  for (let i = 0; i < 6; i++) {
    const slot = document.createElement('div');
    slot.className = 'team-slot';
    const pokemon = team[i];
    if (pokemon) {
      const img = document.createElement('img');
      img.src = pokemon.sprite;
      img.alt = pokemon.name;
      slot.appendChild(img);
      if (i === team.length - 1 && team.length > lastTeamSize) {
        slot.classList.add('team-slot--new');
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
}

function setAdvantageButtonsEnabled(enabled) {
  btnAdvantagePokemon.disabled = !enabled;
  btnAdvantageBonus.disabled = !enabled;
}

// Liste cible réutilisée par Bonbon XP (Pokémon évoluables uniquement, filtré côté
// serveur) et Objet Mystère (toute l'équipe). Le client ne renvoie que l'index fourni
// par le serveur, jamais un choix qu'il aurait inventé lui-même.
function renderBonusTargetList(team, onSelect) {
  bonusTargetListEl.innerHTML = '';
  team.forEach(mon => {
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
    btn.addEventListener('click', () => {
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
function renderEventTeamPicker(payload, hintText) {
  eventBodyEl.appendChild(buildEventText(hintText, 'event-modal__hint'));
  const list = document.createElement('div');
  list.className = 'bonus-target-list';
  payload.team.forEach(mon => {
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
    btn.addEventListener('click', () => {
      Array.from(list.children).forEach(b => { b.disabled = true; });
      sendEventAction({ index: mon.index });
    });
    list.appendChild(btn);
  });
  eventBodyEl.appendChild(list);
}

// ---- Démarrage (choix interactifs) ----

function renderDoubleEncounterStart(payload) {
  eventBodyEl.appendChild(buildEventText("Choisis le Pokémon à garder — l'autre disparaît.", 'event-modal__hint'));
  const row = document.createElement('div');
  row.className = 'choice-cards';
  payload.options.forEach((opt, index) => {
    row.appendChild(buildEventPokemonCard(opt, () => {
      Array.from(row.children).forEach(c => { c.disabled = true; });
      sendEventAction({ index });
    }));
  });
  eventBodyEl.appendChild(row);
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

function renderSecondChanceStart() {
  eventBodyEl.appendChild(buildEventText("Refais ton choix — le nouveau résultat remplace l'ancien.", 'event-modal__hint'));
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
    case 'HIDDEN_TALENT': renderEventTeamPicker(payload, 'Choisis le Pokémon qui reçoit le talent.'); break;
    case 'SECOND_CHANCE': renderSecondChanceStart(); break;
    case 'INSTANT_EVOLUTION': renderEventTeamPicker(payload, 'Choisis le Pokémon qui évolue.'); break;
    case 'LOTTERY': renderLotteryStart(payload); break;
    case 'DUEL': renderDuelStart(payload); break;
    default: hideEventOverlay(); // type inconnu : ne jamais bloquer l'UI
  }
}

// ---- Résolution (résultats) ----

function renderDoubleEncounterResult(payload) {
  const wrap = document.createElement('div');
  wrap.className = 'event-result';
  wrap.appendChild(buildEventSprite(payload.pokemon.sprite, payload.pokemon.name));
  wrap.appendChild(buildEventText(`${payload.pokemon.name} rejoint ton équipe !`));
  wrap.appendChild(buildDeltaLine(payload.pointsGained));
  eventBodyEl.appendChild(wrap);
  eventBodyEl.appendChild(buildEventCloseButton());
  updateMyScore(payload.score, payload.pointsGained);
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
  const wrap = document.createElement('div');
  wrap.className = 'event-result';
  wrap.appendChild(buildEventSprite(payload.sprite, payload.pokemonName));
  wrap.appendChild(buildEventText(`${payload.pokemonName} reçoit : ${payload.effect.name} (×${payload.effect.multiplier})`));
  wrap.appendChild(buildDeltaLine(payload.scoreDelta));
  eventBodyEl.appendChild(wrap);
  eventBodyEl.appendChild(buildEventCloseButton());
  updateMyScore(payload.score, payload.scoreDelta);
}

function renderSecondChanceResult(payload) {
  const wrap = document.createElement('div');
  wrap.className = 'event-result';
  wrap.appendChild(buildEventSprite(payload.pokemon.sprite, payload.pokemon.name));
  wrap.appendChild(buildEventText(`Nouveau résultat : ${payload.pokemon.name} !`));
  const netDelta = payload.pointsGained - payload.previousPointsRemoved;
  wrap.appendChild(buildDeltaLine(netDelta));
  eventBodyEl.appendChild(wrap);
  eventBodyEl.appendChild(buildEventCloseButton());
  updateMyScore(payload.score, netDelta);
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

function renderTimeRiftResult(payload) {
  const wrap = document.createElement('div');
  wrap.className = 'event-result';
  wrap.appendChild(buildEventText("Une faille spatio-temporelle s'ouvre...", 'event-modal__hint'));
  wrap.appendChild(buildEventSprite(payload.pokemon.sprite, payload.pokemon.name));
  wrap.appendChild(buildEventText(payload.pokemon.name));
  wrap.appendChild(buildDeltaLine(payload.pointsGained));
  eventBodyEl.appendChild(wrap);
  eventBodyEl.appendChild(buildEventCloseButton());
  updateMyScore(payload.score, payload.pointsGained);
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
    case 'SECOND_CHANCE': renderSecondChanceResult(payload); break;
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
  // le type, ex: SECOND_CHANCE). L'équipe, elle, suit toujours la même règle.
  if (payload.team) renderTeam(payload.team);
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

  const me = players.find(p => p.id === myId);
  if (me) {
    renderTeam(me.team);
    myScoreValueEl.textContent = me.score;
    if (me.hasChosen) {
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
  socket.emit('create_game', { name });
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
  socket.emit('join_game', { name, gameId: code });
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

// ---------- Actions : jeu ----------
btnHaut.addEventListener('click', () => {
  if (hasChosenThisTurn) return;
  hasChosenThisTurn = true;
  setChoiceButtonsEnabled(false);
  markChoiceSelected(btnHaut, btnBas);
  turnStatusEl.textContent = 'Choix enregistré !';
  socket.emit('player_choice', { choice: 'HAUT' });
});

btnBas.addEventListener('click', () => {
  if (hasChosenThisTurn) return;
  hasChosenThisTurn = true;
  setChoiceButtonsEnabled(false);
  markChoiceSelected(btnBas, btnHaut);
  turnStatusEl.textContent = 'Choix enregistré !';
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
  resetGameUI();
  showScreen(screenHome);
});

btnLeaveFinished.addEventListener('click', () => {
  socket.emit('leave_game');
  resetGameUI();
  showScreen(screenHome);
});

btnReplay.addEventListener('click', () => {
  socket.emit('play_again');
});

// ---------- Événements serveur : lobby ----------
socket.on('connect', () => {
  myId = socket.id;
});

socket.on('game_created', ({ gameId, players, hostId: hId, difficulty }) => {
  resetGameUI();
  hostId = hId;
  gameCodeEl.textContent = gameId;
  renderLobbyPlayers(players);
  renderDifficulty(difficulty);
  updateHostControls();
  showScreen(screenLobby);
});

socket.on('game_joined', ({ gameId, players, hostId: hId, difficulty }) => {
  resetGameUI();
  hostId = hId;
  gameCodeEl.textContent = gameId;
  renderLobbyPlayers(players);
  renderDifficulty(difficulty);
  updateHostControls();
  showScreen(screenLobby);
});

socket.on('game_replayed', ({ gameId, players, hostId: hId, difficulty }) => {
  resetGameUI();
  hostId = hId;
  gameCodeEl.textContent = gameId;
  copyFeedbackEl.textContent = '';
  copyFeedbackEl.classList.remove('copy-feedback--play');
  renderLobbyPlayers(players);
  renderDifficulty(difficulty);
  updateHostControls();
  showScreen(screenLobby);
});

// Un invité voit la difficulté changer en direct quand l'hôte la modifie (source de
// vérité = serveur ; ce n'est jamais le client qui décide ce qui s'affiche ici).
socket.on('difficulty_updated', ({ difficulty }) => {
  renderDifficulty(difficulty);
});

socket.on('players_updated', ({ players, hostId: hId }) => {
  hostId = hId;
  renderLobbyPlayers(players);
  updateHostControls();
});

// ---------- Événements serveur : jeu ----------
socket.on('game_started', ({ status, turn, maxTurns, route, boss, players }) => {
  resetGameUI(); // aucun résidu de l'ancienne partie ; masque aussi le choix tour 4 par défaut
  bossTarget = boss.requiredPoints;
  bossSpriteEl.src = boss.sprite;
  bossNameEl.textContent = boss.name.toUpperCase();
  bossTargetValueEl.textContent = boss.requiredPoints;
  applyGameState({ status, turn, maxTurns, route, players });
  showScreen(screenGame);
});

// Options individuelles du joueur pour ce tour : sprite + nom visibles, points/effet cachés.
socket.on('turn_options', ({ haut, bas }) => {
  choiceHautSpriteEl.src = haut.sprite;
  choiceHautNameEl.textContent = haut.name.toUpperCase();
  choiceBasSpriteEl.src = bas.sprite;
  choiceBasNameEl.textContent = bas.name.toUpperCase();
  showTurnPhase('choice');
  resetTurnUI();
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
  if (data.team) renderTeam(data.team);
  updateMyScore(data.score, data.scoreDelta);
});

socket.on('choice_result', ({ pokemon, rarity, basePoints, effect, pointsGained, score, team }) => {
  resultPanelEl.dataset.rarity = rarity || 'commun'; // rareté fournie par le serveur, jamais déterminée ici
  resultRarityEl.textContent = RARITY_LABELS[rarity] || '';
  resultSpriteEl.src = pokemon.sprite;
  resultNameEl.textContent = pokemon.name.toUpperCase();
  resultBaseEl.textContent = basePoints;
  resultEffectEl.textContent = `${effect.name} ×${effect.multiplier}`;
  resultEffectEl.classList.toggle('result-effect--bonus', effect.multiplier >= 1);
  resultEffectEl.classList.toggle('result-effect--malus', effect.multiplier < 1);
  resultPointsEl.textContent = pointsGained;
  resultPanelEl.classList.remove('result-panel--hidden');
  playRevealAnimation();
  renderTeam(team);
  updateMyScore(score, pointsGained);
});

socket.on('game_updated', ({ status, turn, maxTurns, route, players, hostId: hId }) => {
  if (hId) hostId = hId;
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
      img.src = mon.sprite;
      img.alt = mon.name;
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

socket.on('game_finished', ({ boss, difficulty, players }) => {
  const me = players.find(p => p.id === myId);

  finishedOutcomeEl.textContent = me && me.result === 'victory' ? 'VICTOIRE !' : 'DÉFAITE';
  finishedOutcomeEl.classList.toggle('finished-outcome--victory', !!me && me.result === 'victory');
  finishedOutcomeEl.classList.toggle('finished-outcome--defeat', !!me && me.result !== 'victory');

  finishedBossSpriteEl.src = boss.sprite;
  finishedBossNameEl.textContent = boss.name.toUpperCase();
  finishedDifficultyEl.textContent = DIFFICULTY_LABELS[difficulty] || '';
  ['easy', 'medium', 'hard', 'extreme'].forEach(d => {
    finishedDifficultyEl.classList.toggle(`finished-difficulty-badge--${d}`, d === difficulty);
  });
  finishedTargetEl.textContent = `${boss.requiredPoints} PTS`;
  finishedMyScoreEl.textContent = `${me ? me.score : 0} PTS`;

  if (me) renderFinishedTeam(me.team);

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
    name.textContent = p.name;

    const score = document.createElement('p');
    score.className = 'finished-card__score';
    score.textContent = `${p.score} PTS`;

    nameRow.appendChild(name);
    nameRow.appendChild(score);

    const teamRow = document.createElement('div');
    teamRow.className = 'finished-card__team';
    p.team.forEach(mon => {
      const img = document.createElement('img');
      img.src = mon.sprite;
      img.alt = mon.name;
      img.title = mon.name;
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
  showError(msg);
});