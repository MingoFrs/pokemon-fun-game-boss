// dotenv : uniquement utile en LOCAL (charge un fichier .env non commité) ; sur Render,
// les variables d'environnement sont déjà injectées nativement, donc ce require ne fait
// jamais planter le démarrage en prod. Enveloppé quand même par précaution : le jeu (mode
// invité) doit rester jouable même si ce paquet manquait pour une raison quelconque.
try {
  require('dotenv').config();
} catch (err) {
  console.warn('[dotenv] non disponible (sans impact en production sur Render) :', err.message);
}

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

// Points des Pokémon : Base Stats PokéAPI -> BST -> catégorie -> multiplicateur (cf. stats-config.js / stats.js).
const statsConfig = require('./stats-config');
const pokemonStats = require('./stats');
const bossMechanicsConfig = require('./boss-mechanics-config');
const { loadTypeData, createBossMechanics } = require('./boss-mechanics');
const { LEGENDARY_GROUP } = statsConfig; // légendaire + fabuleux + ultra-chimère (ancien palier "légendaire")

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// ---------------------------------------------------------------
// FILET DE SÉCURITÉ : une erreur dans UN handler (payload inattendu, ex. `null` ou un nombre
// au lieu d'un objet/texte, rejet d'une requête Supabase...) ne doit jamais faire tomber tout
// le serveur — et donc toutes les parties en cours.
// ---------------------------------------------------------------
process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err));
process.on('uncaughtException', (err) => console.error('[uncaughtException]', err));

// Handlers socket (ce fichier ET les modules fly/daily : le middleware passe avant tout `connection`).
io.use((socket, next) => {
  const rawOn = socket.on.bind(socket);
  socket.on = (event, handler) => {
    if (typeof handler !== 'function') return rawOn(event, handler);
    return rawOn(event, (...args) => {
      try {
        const out = handler(...args);
        if (out && typeof out.catch === 'function') out.catch(err => console.error(`[socket:${event}]`, err));
      } catch (err) {
        console.error(`[socket:${event}]`, err);
      }
    });
  };
  next();
});

// Routes HTTP : Express 4 n'attrape pas les rejets des handlers async (=> plantage du process).
// On enveloppe chaque handler get/post : toute erreur renvoie un 500 propre au lieu de tout couper.
['get', 'post'].forEach((method) => {
  const original = app[method].bind(app);
  app[method] = (routePath, ...handlers) => {
    if (!handlers.length) return original(routePath); // app.get('setting') : lecture d'un réglage
    return original(routePath, ...handlers.map((h) => (typeof h !== 'function' || h.length > 3 ? h : (req, res, next) => {
      const fail = (err) => {
        console.error(`[http ${method.toUpperCase()} ${routePath}]`, err);
        if (!res.headersSent) res.status(500).json({ error: 'Erreur serveur.' });
      };
      try {
        const out = h(req, res, next);
        if (out && typeof out.catch === 'function') out.catch(fail);
      } catch (err) { fail(err); }
    })));
  };
});

app.use('/sprites', express.static(path.join(__dirname, 'public', 'sprites'), { maxAge: '30d', immutable: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ---------------------------------------------------------------
// COMPTES (optionnels) — cf. section "ROUTES COMPTES" plus bas. Supabase Auth gère
// entièrement les mots de passe (jamais stockés ni même vus en clair par ce serveur) ;
// SUPABASE_URL et SUPABASE_SECRET_KEY viennent UNIQUEMENT de variables d'environnement,
// jamais commitées dans ce fichier. Si absentes ou si le paquet n'est pas installé, les
// comptes sont juste désactivés : le jeu reste 100% jouable en mode invité (pseudo),
// comportement inchangé pour tout le monde.
//
// DEUX clients bien séparés, jamais un seul partagé pour tout :
// - `supabase` (ci-dessous) : UNIQUEMENT pour .from('profiles'), jamais pour une
//   opération .auth.*.
// - `createAuthClient()` : une instance FRAÎCHE et jetable à chaque appel .auth.signUp
//   / signInWithPassword / refreshSession. persistSession:false seul s'est révélé
//   insuffisant en pratique (le client peut quand même se mettre à utiliser la session
//   du joueur en mémoire pour les requêtes suivantes sur cette même instance) : le
//   .from('profiles') se retrouvait exécuté avec le rôle "authenticated" du joueur tout
//   juste inscrit au lieu de "service_role", d'où un "permission denied" malgré des
//   droits service_role pourtant corrects en base. Une instance neuve à chaque fois
//   élimine complètement le risque de fuite d'état entre les deux usages.
// ---------------------------------------------------------------
let supabase = null;
let createAuthClient = null;
try {
  const { createClient } = require('@supabase/supabase-js');
  if (process.env.SUPABASE_URL && process.env.SUPABASE_SECRET_KEY) {
    const clientOptions = { auth: { autoRefreshToken: false, persistSession: false } };
    supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, clientOptions);
    createAuthClient = () => createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, clientOptions);
  } else {
    console.warn('[comptes] SUPABASE_URL / SUPABASE_SECRET_KEY absents : comptes désactivés (mode invité uniquement).');
  }
} catch (err) {
  console.warn('[comptes] @supabase/supabase-js indisponible : comptes désactivés (mode invité uniquement).', err.message);
}

// Avatars de compte (optionnels) : sprites de dresseurs hébergés par Pokémon Showdown
// (play.pokemonshowdown.com/sprites/trainers/<nom>.png), noms vérifiés un par un sur le
// vrai site avant d'être listés ici pour ne jamais pointer vers une image cassée. Cette
// LISTE FAIT AUTORITÉ : toute valeur reçue du client qui n'y figure pas est rejetée (cf.
// /api/profile/avatar) — jamais un nom de fichier arbitraire accepté tel quel.
const AVATARS = [
  'red-gen7', 'blue-gen7', 'leaf-masters', 'may', 'brendan', 'birch', 'wally', 'kris',
  'lyra-masters', 'ethan-masters', 'hilbert-masters', 'hilda-masters', 'calem', 'korrina',
  'diantha', 'lysandre', 'alain', 'wulfric', 'viola', 'valerie', 'guzma', 'hala', 'hau',
  'lillie', 'gladion', 'lusamine', 'nanu', 'plumeria', 'kukui', 'mallow', 'lana', 'mina',
  'kiawe', 'sophocles', 'acerola', 'olivia', 'kahili', 'marnie', 'raihan', 'nessa', 'piers',
  'bea', 'gordie', 'milo', 'opal', 'leon', 'hop', 'victor', 'gloria', 'volo', 'aetheremployee',
  'aetheremployeef', 'aetherfoundation', 'aetherfoundationf', 'anabel-gen7', 'beauty-gen7',
  'burnet', 'colress-gen7', 'dexio', 'elio', 'faba', 'gladion-stance', 'grimsley-gen7', 'hapu',
  'hau-stance', 'ilima', 'kukui-stand', 'lass-gen7', 'lillie-z', 'lusamine-nihilego',
  'molayne', 'officeworker', 'pokemonbreeder-gen7', 'pokemonbreederf-gen7', 'preschoolers',
  'risingstar', 'risingstarf', 'ryuki', 'samsonoak', 'selene', 'sightseerf', 'sina',
  'teacher-gen7', 'theroyal', 'wicke', 'youngathlete', 'youngathletef', 'youngster-gen7',
  'adaman', 'agatha-lgpe', 'akari', 'allister', 'archie-gen6', 'arezu', 'avery', 'ballguy',
  'bede-leader', 'bede', 'brendan-contest', 'burnet-radar', 'calaba', 'chase', 'cogita',
  'cynthia-gen7', 'cynthia-masters', 'doctor-gen8', 'elaine', 'hilda-masters2', 'irida',
  'jacinthe', 'kabu', 'klara', 'koga-lgpe', 'leon-tower', 'lian', 'lisia', 'lorelei-lgpe',
  'magnolia', 'mai', 'may-contest', 'melony', 'miku-flying', 'miku-ground', 'mina-lgpe',
  'mustard-master', 'mustard', 'oleana', 'peony', 'pesselle', 'phoebe-gen6',
  'rainbowrocketgrunt', 'rainbowrocketgruntf', 'rei', 'rose', 'sabi', 'sada-ai', 'sanqua',
  'shielbert', 'sonia-professor', 'sonia', 'sordward-shielbert', 'sordward',
  'tateandliza-gen6', 'turo-ai', 'victor-dojo', 'yellgrunt', 'yellgruntf', 'zisu',
  'rose-zerosuit', 'miku-ghost', 'az', 'brawly-gen6', 'bryony', 'drasna', 'evelyn',
  'furisodegirl-black', 'furisodegirl-pink', 'malva', 'nita', 'olympia', 'ramos', 'shelly',
  'sidney', 'siebold', 'tierno', 'wallace-gen6', 'wikstrom', 'winona-gen6', 'xerosic',
  'youngn', 'zinnia', 'glacia', 'peonia', 'phoebe-masters', 'rosa-masters3', 'scottie-masters',
  'skyla-masters2', 'volo-ginkgo', 'emma-lza', 'florian-bb', 'juliana-bb', 'lida', 'liko',
  'mable', 'naveen', 'red-lgpe', 'roy', 'miku-ice', 'arven-v', 'atticus', 'charm', 'coin',
  'courtney', 'dexio-gen6', 'dulse', 'elio-usum', 'emma', 'eri', 'essentia', 'flannery-gen6',
  'giacomo', 'ginchiyo-conquest', 'gloria-dojo', 'green', 'grusha', 'hanbei-conquest',
  'hero-conquest', 'hero2-conquest', 'heroine-conquest', 'heroine2-conquest',
  'kunoichi-conquest', 'kunoichi2-conquest', 'magmagrunt', 'magmagruntf', 'marnie-league',
  'masamune-conquest', 'mela', 'morgan', 'nobunaga-conquest', 'norman-gen6', 'oichi-conquest',
  'ortega', 'penny', 'phyco', 'ranmaru-conquest', 'selene-usum', 'serena-anime', 'shauna',
  'sina-gen6', 'skullgrunt', 'skullgruntf', 'soliera', 'steven-gen6', 'zossie', 'brendan-e',
  'maxie-gen6', 'aarune', 'acerola-masters', 'acetrainer-gen6', 'adaman-masters',
  'allister-masters', 'amarys', 'anabel', 'ansha', 'arven-masters', 'az-lza',
  'backpacker-gen6', 'barry-masters', 'bea-masters', 'beauty-gen6', 'bede-masters', 'bellis',
  'bianca-masters', 'bill', 'birdkeeper-gen6', 'blackbelt-gen6', 'blaine-lgpe', 'blanche',
  'blue-masters', 'brandon', 'brassius', 'brendan-masters', 'briar', 'brigette', 'brock-lgpe',
  'brock-masters', 'bugsy-masters', 'burgh-masters', 'cabbie', 'caitlin-masters',
  'calem-masters', 'candela', 'candice-masters', 'carmine', 'celio', 'charon',
  'cheren-masters', 'clair-masters', 'cliff', 'colza', 'cook', 'cyrus-masters', 'daisy',
  'dawn-masters', 'delinquent', 'diantha-masters', 'elm', 'emmet-masters', 'erika-masters',
  'fennel', 'geeta', 'gladion-masters', 'gloria-masters', 'grant', 'greta', 'grimsley-masters',
  'guzma-masters', 'hassel', 'hau-masters', 'hilbert-masters2', 'hop-masters', 'hugh-masters',
  'ingo-masters', 'iono', 'iris-masters', 'jasmine-masters', 'johanna', 'kieran', 'kofu',
  'kris-masters', 'kurt', 'lacey', 'lance-masters', 'lanette', 'larry', 'leaf-masters2',
  'lucy', 'mallow-masters', 'marley-masters', 'may-masters', 'misty-masters', 'morty-masters',
  'mrbriney', 'mrstone', 'nate'
];

// ---------------------------------------------------------------
// XP / NIVEAU (optionnel, liés au compte comme l'avatar) — jamais un pré-requis pour
// jouer, jamais bloquant : un joueur invité ou dont le token ne peut plus être vérifié
// au moment de la fin de partie ne reçoit simplement pas d'XP, sans aucune erreur visible
// ni impact sur la partie elle-même (cf. awardXp, appelé en "fire and forget" à chaque
// fin de partie, jamais attendu avant d'annoncer les résultats aux joueurs).
//
// Palier croissant : xpForLevel(N) = XP cumulé nécessaire pour ATTEINDRE le niveau N
// depuis le niveau 1 (palier 1 = 100 XP, palier 2 = 200 XP de plus, etc. — jamais un
// palier fixe, sinon monter de niveau deviendrait de plus en plus rapide en valeur
// relative au lieu de rester un effort croissant).
// Pas réduit de 100 à 25 (progression 4× plus rapide) : niveau 5 = 250 XP, 10 = 1 125 XP, 30 = 10 875 XP.
// Le niveau n'est jamais stocké (calculé depuis l'XP) : tous les comptes existants sont recalculés d'office.
const XP_LEVEL_STEP = 25;
function xpForLevel(level) {
  return Math.round(XP_LEVEL_STEP * level * (level - 1) / 2);
}
function levelForXp(xp) {
  let level = 1;
  while (xpForLevel(level + 1) <= xp) level++;
  return level;
}
const XP_PARTICIPATION = 10; // toujours attribué à qui termine une partie, gagnant ou non
const XP_VICTORY_BONUS = 20; // en plus de XP_PARTICIPATION, uniquement au(x) vainqueur(s)

// Ajoute de l'XP au compte d'un joueur, UNIQUEMENT si son accessToken (fourni à la
// création/connexion à la partie via makePlayer, jamais revalidé avant maintenant)
// correspond réellement à un compte Supabase valide à l'instant de la fin de partie.
// Jamais attendu par l'appelant (fire-and-forget) : l'XP est un bonus, ne doit jamais
// retarder ni bloquer l'annonce des résultats aux joueurs.
// Appelée une fois par joueur à CHAQUE fin de partie (fire-and-forget, jamais attendue
// par l'appelant) : attribue l'XP ET enregistre une ligne d'historique en UNE SEULE
// vérification d'identité (au lieu de deux fonctions séparées qui revalideraient chacune
// le token). Échoue silencieusement si le joueur est invité, son token n'est plus valide,
// ou Supabase est indisponible — jamais un pré-requis pour terminer une partie.
// details : { gameMode, result: 'victory'|'defeat'|'participation', score, opponentName,
//             difficulty (groupe 'easy'|'medium'|'hard'|'extreme', ou null si sans objet —
//             mode auction), team (équipe complète au moment de la fin de partie, pour le
//             détail dans l'historique + le calcul des succès ; null en mode "guess", qui
//             n'a pas de concept d'équipe) }
async function recordGameResult(player, xpAmount, details) {
  // Partie à modificateurs : ni XP, ni historique (donc ni succès/stats/Pokédex, tout en dérive).
  if (!player || player.modifiedGame || !player.accountAccessToken || !supabase || !createAuthClient) return;
  try {
    const { data: { user }, error: userError } = await createAuthClient().auth.getUser(player.accountAccessToken);
    if (userError || !user) return;

    const { data: profile } = await supabase.from('profiles').select('xp').eq('id', user.id).single();
    const newXp = (profile ? (profile.xp || 0) : 0) + xpAmount;
    await supabase.from('profiles').update({ xp: newXp }).eq('id', user.id);

    // Récap : Pokémon jamais obtenus avant cette partie (= absents des équipes déjà en historique,
    // même source que le Pokédex). Lu AVANT l'insertion de la partie en cours.
    const newPokemon = [];
    if (Array.isArray(details.team) && details.team.length) {
      const { data: prevRows } = await supabase.from('game_history').select('team').eq('user_id', user.id);
      const known = new Set();
      (prevRows || []).forEach(r => { if (Array.isArray(r.team)) r.team.forEach(m => { if (m && m.id != null) known.add(m.id); }); });
      const seenNow = new Set();
      details.team.forEach(m => {
        if (m && m.id != null && !known.has(m.id) && !seenNow.has(m.id)) {
          seenNow.add(m.id);
          newPokemon.push({ id: m.id, name: m.name, sprite: m.sprite, shiny: !!m.shiny, shinySprite: m.shinySprite || null });
        }
      });
    }

    await supabase.from('game_history').insert({
      user_id: user.id,
      game_mode: details.gameMode,
      result: details.result,
      score: details.score ?? null,
      opponent_name: details.opponentName ?? null,
      difficulty: details.difficulty ?? null,
      team: details.team ?? null,
      modifiers: Array.isArray(player.gameModifiers) ? player.gameModifiers : []
    });

    // Succès (fire-and-forget comme le reste de cette fonction) : jamais bloquant, jamais
    // un pré-requis pour terminer une partie — cf. checkAndUnlockAchievements.
    if (newPokemon.length) io.to(player.id).emit('game_recap_new', { newPokemon });
    await checkAndUnlockAchievements(user.id, player.id);
  } catch (err) {
    console.error('[fin de partie] échec XP/historique', { err: err.message });
  }
}

// -----------------------------------------------------------------
// SUCCÈS (optionnels, liés au compte comme l'XP) — 2 catégories : "facile" (jalons
// atteignables en une poignée de parties) et "difficile" (performances qui demandent de
// la constance ou de la chance). Recalculés à CHAQUE fin de partie à partir de
// l'historique COMPLET stocké en base (jamais de compteur séparé qui pourrait diverger de
// la réalité) : source de vérité unique, cf. buildAchievementContext.
// -----------------------------------------------------------------
// TITRES : chaque succès débloque UN titre cosmétique (champ `title`), équipable sur le
// compte (profiles.title = clé du succès, '' = aucun). Pas de table à part : le droit
// d'équiper un titre = succès débloqué en base, revalidé dans /api/profile/title.
// Méga de Pokémon Legends Z-A : ids PokéAPI 10278-10326 (49 formes, cf. MEGA_FORMS). Les succès
// « Collection Z-A » comptent les formes DISTINCTES obtenues, toutes parties confondues.
const ZA_MEGA_ID_MIN = 10278;
const ZA_MEGA_ID_MAX = 10326;
const ZA_MEGA_COUNT = ZA_MEGA_ID_MAX - ZA_MEGA_ID_MIN + 1; // 49
const isZaMegaId = id => Number.isInteger(id) && id >= ZA_MEGA_ID_MIN && id <= ZA_MEGA_ID_MAX;

const ACHIEVEMENTS = [
  { key: 'first_game', category: 'facile', title: 'Dresseur Novice', label: 'Premiers pas', description: 'Termine ta première partie.', check: ctx => ctx.gamesPlayed >= 1 },
  { key: 'first_win', category: 'facile', title: 'Vainqueur', label: 'Première victoire', description: 'Remporte ta première partie.', check: ctx => ctx.wins >= 1 },
  { key: 'first_legendary', category: 'facile', title: 'Témoin de Légende', label: 'Rencontre légendaire', description: 'Obtiens un Pokémon légendaire dans ton équipe.', check: ctx => ctx.hasLegendary },
  { key: 'first_epic', category: 'facile', title: 'Veinard', label: 'Coup de chance', description: 'Obtiens un Pokémon épique dans ton équipe.', check: ctx => ctx.hasEpic },
  { key: 'first_shiny', category: 'facile', title: 'Chasseur de Chromatiques', label: 'Reflet chromatique', description: 'Obtiens un Pokémon shiny.', check: ctx => ctx.hasShiny },
  { key: 'games_5', category: 'facile', title: 'Dresseur Assidu', label: 'Habitué', description: 'Termine 5 parties.', check: ctx => ctx.gamesPlayed >= 5 },
  { key: 'guess_win', category: 'facile', title: 'Fin Limier', label: 'Détective', description: 'Remporte une partie de Devine le Pokémon.', check: ctx => ctx.winModes.has('guess') },
  { key: 'admin_win', category: 'facile', title: "Briseur d'IA", label: "Face à l'IA", description: 'Remporte une partie en mode Admin vs Joueur.', check: ctx => ctx.winModes.has('admin') },
  { key: 'score_6000', category: 'difficile', title: 'Maître du Score', label: 'Score légendaire', description: 'Atteins un score de 6000 en une seule partie.', check: ctx => ctx.bestScore >= 6000 },
  { key: 'wins_10', category: 'difficile', title: 'Champion Vétéran', label: 'Vétéran', description: 'Remporte 10 parties.', check: ctx => ctx.wins >= 10 },
  { key: 'beat_extreme', category: 'difficile', title: "Terreur d'Arceus", label: "Chasseur d'Arceus", description: 'Bats un boss de difficulté extrême.', check: ctx => ctx.beatExtreme },
  { key: 'full_legendary_team', category: 'difficile', title: 'Roi des Légendes', label: 'Équipe de légende', description: 'Termine avec 6 Pokémon légendaires ou pseudo-légendaires.', check: ctx => ctx.fullLegendaryTeam },
  { key: 'auction_full_team', category: 'difficile', title: 'Grand Collectionneur', label: 'Collectionneur', description: 'Termine un Draft/Enchères avec une équipe complète de 6.', check: ctx => ctx.auctionFullTeam },
  { key: 'three_modes_win', category: 'difficile', title: 'Touche-à-tout', label: 'Polyvalent', description: 'Remporte au moins une partie en Route du Boss, Admin vs Joueur ET Devine le Pokémon.', check: ctx => ['normal', 'admin', 'guess'].every(m => ctx.winModes.has(m)) },
  { key: 'win_streak_3', category: 'difficile', title: 'Imparable', label: 'Sur une lancée', description: 'Enchaîne 3 victoires d\'affilée.', check: ctx => ctx.maxWinStreak >= 3 },
  { key: 'first_mega', category: 'facile', title: 'Porteur de Méga-Pierre', label: 'Éveil de Méga-Pierre', description: 'Obtiens un Pokémon en méga-évolution dans ton équipe.', check: ctx => ctx.hasMega },
  { key: 'auction_win', category: 'facile', title: 'Roi des Enchères', label: 'Grand enchérisseur', description: 'Remporte une partie de Draft/Enchères.', check: ctx => ctx.winModes.has('auction') },
  { key: 'coop_win', category: 'facile', title: "Âme d'Équipe", label: 'Travail d\'équipe', description: 'Remporte une partie en mode Coop.', check: ctx => ctx.winModes.has('coop') },
  { key: 'games_25', category: 'facile', title: "Pilier de l'Arène", label: 'Habitué confirmé', description: 'Termine 25 parties.', check: ctx => ctx.gamesPlayed >= 25 },
  { key: 'double_shiny', category: 'difficile', title: 'Double Éclat', label: 'Duo chromatique', description: 'Termine une partie avec 2 Pokémon shiny ou plus dans la même équipe.', check: ctx => ctx.doubleShiny },
  { key: 'rainbow_team', category: 'difficile', title: 'Arc-en-ciel Vivant', label: 'Équipe arc-en-ciel', description: 'Termine avec une équipe couvrant au moins 5 raretés différentes.', check: ctx => ctx.rainbowTeam },
  { key: 'wins_25', category: 'difficile', title: 'Légende Vivante', label: 'Increvable', description: 'Remporte 25 parties.', check: ctx => ctx.wins >= 25 },
  { key: 'win_streak_5', category: 'difficile', title: 'Invaincu', label: 'Série parfaite', description: 'Enchaîne 5 victoires d\'affilée.', check: ctx => ctx.maxWinStreak >= 5 },
  { key: 'four_modes_win', category: 'difficile', title: 'Maître Absolu', label: 'Maître absolu', description: 'Remporte au moins une partie dans les 4 modes de jeu (Route du Boss, Admin vs Joueur, Devine le Pokémon, Draft/Enchères).', check: ctx => ['normal', 'admin', 'guess', 'auction'].every(m => ctx.winModes.has(m)) },
  { key: 'za_mega_first', category: 'facile', title: 'Pionnier Z-A', label: 'Éveil Z-A', description: 'Obtiens une Méga-Évolution de Pokémon Légendes Z-A dans ton équipe.', check: ctx => ctx.zaMegaIds.size >= 1 },
  { key: 'za_mega_10', category: 'difficile', title: 'Collectionneur Z-A', label: 'Collection Z-A', description: 'Obtiens 10 Méga-Évolutions Z-A différentes (cumul de toutes tes parties).', check: ctx => ctx.zaMegaIds.size >= 10 },
  { key: 'za_mega_all', category: 'difficile', title: 'Maître Méga Z-A', label: 'Méga-Dex Z-A complet', description: `Obtiens les ${ZA_MEGA_COUNT} Méga-Évolutions Z-A (cumul de toutes tes parties).`, check: ctx => ctx.zaMegaIds.size >= ZA_MEGA_COUNT },
  { key: 'gamble_x2', category: 'difficile', title: 'Jackpot', label: 'Jackpot ×2', description: "Fais tomber ×2 avec LET'S GO GAMBLING.", check: ctx => ctx.gambleX2 },
  { key: 'gamble_x05', category: 'facile', title: 'Malchanceux', label: 'Perdu au Gambling', description: "Tombe sur ×0.5 avec LET'S GO GAMBLING.", check: ctx => ctx.gambleX05 },
  { key: 'aura_duo', category: 'difficile', title: 'Équilibre des Auras', label: 'Yin & Yang', description: 'Aies Aura +150 et Aura -100 dans la même équipe.', check: ctx => ctx.auraDuo },
  { key: 'six_traits', category: 'difficile', title: 'Casting Complet', label: 'Six traits', description: 'Termine une partie avec 6 Pokémon ayant chacun un trait (aucun Neutre).', check: ctx => ctx.sixTraits },
  { key: 'p2l_victory', category: 'difficile', title: 'Porté par la Chance', label: 'Gagner avec P2L', description: 'Gagne une partie avec un Pokémon P2L dans ton équipe.', check: ctx => ctx.p2lVictory },
  { key: 'all_traits', category: 'difficile', title: 'Collectionneur de Traits', label: 'Trait-dex complet', description: 'Obtiens tous les traits du Trait-dex (cumul de toutes tes parties).', check: ctx => ctx.traitsSeen.size >= EFFECTS.length },
  { key: 'score_10000', category: 'difficile', title: 'Astre du Score', label: 'Score astronomique', description: 'Atteins un score de 10000 en une seule partie.', check: ctx => ctx.bestScore >= 10000 }
];

// ---- SUCCÈS CHROMATIQUES : compteur cumulé de shiny + rareté du shiny obtenu ----
const SHINY_RARITY_ORDER = ['commun', 'peu_commun', 'rare', 'epique', 'pseudo_legendaire', 'mega', 'legendaire', 'fabuleux', 'ultra_chimere'];
const shinyRank = r => SHINY_RARITY_ORDER.indexOf(r);
[
  { key: 'shiny_3', category: 'facile', title: "Collectionneur d'Éclats", label: 'Trois éclats', description: 'Obtiens 3 Pokémon shiny au total (cumul de toutes tes parties).', check: ctx => ctx.shinyTotal >= 3 },
  { key: 'shiny_10', category: 'difficile', title: 'Chasseur Confirmé', label: 'Dix éclats', description: 'Obtiens 10 Pokémon shiny au total.', check: ctx => ctx.shinyTotal >= 10 },
  { key: 'shiny_25', category: 'difficile', title: 'Légende Chromatique', label: 'Vingt-cinq éclats', description: 'Obtiens 25 Pokémon shiny au total.', check: ctx => ctx.shinyTotal >= 25 },
  { key: 'shiny_epic', category: 'difficile', title: 'Éclat Épique', label: 'Shiny épique', description: 'Obtiens un Pokémon shiny de rareté Épique ou supérieure.', check: ctx => ctx.shinyBestRank >= shinyRank('epique') },
  { key: 'shiny_legend', category: 'difficile', title: 'Éclat Légendaire', label: 'Shiny légendaire', description: 'Obtiens un Pokémon shiny de rareté Légendaire ou supérieure.', check: ctx => ctx.shinyBestRank >= shinyRank('legendaire') },
  { key: 'shiny_mega', category: 'difficile', title: 'Éclat Méga', label: 'Shiny Méga', description: 'Obtiens une Méga-Évolution shiny.', check: ctx => ctx.shinyMega }
].forEach(a => ACHIEVEMENTS.push(a));

// Statistiques chromatiques d'un joueur à partir de ses équipes finales (hors mode fly).
function computeShinyStats(rows) {
  const byRarity = {};
  const species = new Map(); // id -> { id, name, sprite, shinySprite, rarity, count }
  let total = 0;
  (rows || []).filter(r => r.game_mode !== 'fly').forEach(r => {
    if (!Array.isArray(r.team)) return;
    r.team.forEach(m => {
      if (!m || !m.shiny) return;
      total += 1;
      const rar = m.rarity || 'commun';
      byRarity[rar] = (byRarity[rar] || 0) + 1;
      const cur = species.get(m.id);
      if (cur) { cur.count += 1; if (shinyRank(rar) > shinyRank(cur.rarity)) cur.rarity = rar; }
      else species.set(m.id, { id: m.id, name: m.name, sprite: m.sprite || null, shinySprite: m.shinySprite || null, rarity: rar, count: 1 });
    });
  });
  const list = Array.from(species.values()).sort((a, b) => shinyRank(b.rarity) - shinyRank(a.rarity) || b.count - a.count || a.id - b.id);
  return { total, species: list.length, byRarity, list };
}

// ---- OBJECTIFS POKÉDEX : « 10 Pokémon feu différents » → titre (catégorie 'pokedex') ----
// Comptés sur les espèces de base (id < 10000, formes/Méga exclues), toutes parties classées confondues.
const DEX_TYPE_LABELS = {
  normal: 'Normal', fire: 'Feu', water: 'Eau', electric: 'Électrik', grass: 'Plante', ice: 'Glace',
  fighting: 'Combat', poison: 'Poison', ground: 'Sol', flying: 'Vol', psychic: 'Psy', bug: 'Insecte',
  rock: 'Roche', ghost: 'Spectre', dark: 'Ténèbres', dragon: 'Dragon', steel: 'Acier', fairy: 'Fée'
};
const DEX_TYPE_TIERS = [{ n: 10, prefix: 'Dresseur' }, { n: 25, prefix: 'Maître' }];
const DEX_TOTAL_TIERS = [{ n: 50, title: 'Curieux' }, { n: 150, title: 'Explorateur' }, { n: 300, title: 'Encyclopédiste' }];
const dexTypesOf = id => { try { return BOSS_MECHANICS.getTypes(id) || []; } catch (e) { return []; } };
function computeDexTypeCounts(ids) {
  const counts = {};
  ids.forEach(id => dexTypesOf(id).forEach(t => { counts[t] = (counts[t] || 0) + 1; }));
  return counts;
}
Object.keys(DEX_TYPE_LABELS).forEach(type => {
  DEX_TYPE_TIERS.forEach(t => {
    const label = DEX_TYPE_LABELS[type];
    ACHIEVEMENTS.push({
      key: `dex_${type}_${t.n}`, category: 'pokedex', title: `${t.prefix} ${label}`,
      label: `Pokédex ${label} ×${t.n}`,
      description: `Obtiens ${t.n} Pokémon de type ${label} différents (cumul de toutes tes parties).`,
      check: ctx => (ctx.dexTypeCounts[type] || 0) >= t.n
    });
  });
});
DEX_TOTAL_TIERS.forEach(t => {
  ACHIEVEMENTS.push({
    key: `dex_total_${t.n}`, category: 'pokedex', title: t.title, label: `Pokédex ${t.n}`,
    description: `Obtiens ${t.n} Pokémon différents (cumul de toutes tes parties).`,
    check: ctx => ctx.dexTotal >= t.n
  });
});

// Libellé du titre équipé à partir de la clé stockée ('' si aucun / clé inconnue).
function titleLabelFor(key) {
  const a = key ? ACHIEVEMENTS.find(x => x.key === key) : null;
  return a ? a.title : '';
}

// Agrège toutes les lignes d'historique d'un joueur (déjà chargées, triées du plus ancien
// au plus récent — cf. l'ORDER BY de l'appelant, nécessaire pour maxWinStreak) en un
// contexte plat, pratique à tester dans chaque `check` ci-dessus. rows[i].team est le
// snapshot stocké par recordGameResult : peut être null (mode "guess") ou un tableau de
// Pokémon.
function buildAchievementContext(allRows) {
  const rows = allRows.filter(r => r.game_mode !== 'fly'); // mode fly : jamais dans les succès
  const ctx = {
    gamesPlayed: rows.length,
    wins: 0,
    bestScore: 0,
    hasLegendary: false,
    hasEpic: false,
    hasShiny: false,
    hasMega: false,
    zaMegaIds: new Set(),
    shinyTotal: 0,
    shinyBestRank: -1,
    shinyMega: false,
    dexIds: new Set(),
    dexTypeCounts: {},
    dexTotal: 0,
    traitsSeen: new Set(),
    gambleX2: false,
    gambleX05: false,
    auraDuo: false,
    sixTraits: false,
    p2lVictory: false,
    doubleShiny: false,
    rainbowTeam: false,
    beatExtreme: false,
    fullLegendaryTeam: false,
    auctionFullTeam: false,
    winModes: new Set(),
    maxWinStreak: 0
  };

  let currentStreak = 0;
  rows.forEach(row => {
    if (row.result === 'victory') {
      ctx.wins += 1;
      ctx.winModes.add(row.game_mode);
      currentStreak += 1;
      if (currentStreak > ctx.maxWinStreak) ctx.maxWinStreak = currentStreak;
    } else if (row.result === 'defeat') {
      currentStreak = 0;
    }
    if (typeof row.score === 'number' && row.score > ctx.bestScore) ctx.bestScore = row.score;
    if (row.result === 'victory' && (row.game_mode === 'normal' || row.game_mode === 'admin') && row.difficulty === 'extreme') {
      ctx.beatExtreme = true;
    }
    if (Array.isArray(row.team)) {
      if (row.team.some(mon => LEGENDARY_GROUP.includes(mon.rarity))) ctx.hasLegendary = true;
      if (row.team.some(mon => mon.rarity === 'epique')) ctx.hasEpic = true;
      if (row.team.some(mon => mon.shiny)) ctx.hasShiny = true;
      if (row.team.some(mon => mon.rarity === 'mega')) ctx.hasMega = true;
      row.team.forEach(mon => { if (mon && isZaMegaId(mon.id)) ctx.zaMegaIds.add(mon.id); });
      row.team.forEach(mon => { if (mon && Number.isInteger(mon.id) && mon.id < 10000) ctx.dexIds.add(mon.id); });
      row.team.forEach(mon => {
        if (!mon || !mon.shiny) return;
        ctx.shinyTotal += 1;
        ctx.shinyBestRank = Math.max(ctx.shinyBestRank, shinyRank(mon.rarity));
        if (mon.rarity === 'mega') ctx.shinyMega = true;
      });
      // Traits : lus sur le snapshot de l'équipe (effectName / gambleRoll / flat, cf. teamMonFromReward).
      const names = row.team.map(mon => mon && mon.effectName);
      names.forEach(n => { if (n && EFFECTS.some(e => e.name === n)) ctx.traitsSeen.add(n); }); // Trait-dex
      if (row.team.some(mon => mon && mon.gambleRoll === 2)) ctx.gambleX2 = true;
      if (row.team.some(mon => mon && mon.gambleRoll === 0.5)) ctx.gambleX05 = true;
      if (names.includes('Aura +150') && names.includes('Aura -100')) ctx.auraDuo = true;
      if (row.team.length >= 6 && row.team.filter(mon => mon && EFFECTS.some(e => e.name !== 'Neutre' && e.name === mon.effectName)).length >= 6) ctx.sixTraits = true;
      if (row.result === 'victory' && names.includes('P2L')) ctx.p2lVictory = true;
      if (row.team.filter(mon => mon.shiny).length >= 2) ctx.doubleShiny = true;
      if (new Set(row.team.map(mon => mon.rarity)).size >= 5) ctx.rainbowTeam = true;
      if (row.game_mode === 'auction' && row.team.length >= 6) ctx.auctionFullTeam = true;
      if (
        (row.game_mode === 'normal' || row.game_mode === 'admin') &&
        row.team.length === 6 &&
        row.team.every(mon => LEGENDARY_GROUP.includes(mon.rarity) || mon.rarity === 'pseudo_legendaire')
      ) {
        ctx.fullLegendaryTeam = true;
      }
    }
  });

  ctx.dexTotal = ctx.dexIds.size;
  ctx.dexTypeCounts = computeDexTypeCounts(ctx.dexIds);
  return ctx;
}

// Recalcule les succès obtenus, insère les nouveaux, et notifie le joueur (SI sa socket
// est toujours connectée — socketId est son id AU MOMENT de la fin de partie, jamais
// revalidé : si absent, le succès reste débloqué en base, juste pas de toast affiché tout
// de suite, il apparaîtra à la prochaine ouverture des Réglages).
async function checkAndUnlockAchievements(userId, socketId) {
  try {
    const { data: rows, error } = await supabase
      .from('game_history')
      .select('result, score, team, difficulty, game_mode')
      .eq('user_id', userId)
      .order('created_at', { ascending: true });
    if (error || !rows) return;

    const ctx = buildAchievementContext(rows);

    const { data: already, error: alreadyError } = await supabase
      .from('achievements')
      .select('achievement_key')
      .eq('user_id', userId);
    if (alreadyError) return;
    const unlockedKeys = new Set((already || []).map(a => a.achievement_key));

    const newlyUnlocked = ACHIEVEMENTS.filter(a => !unlockedKeys.has(a.key) && a.check(ctx));
    if (newlyUnlocked.length === 0) return;

    await supabase.from('achievements').insert(
      newlyUnlocked.map(a => ({ user_id: userId, achievement_key: a.key }))
    );

    if (socketId) {
      io.to(socketId).emit('achievements_unlocked', {
        achievements: newlyUnlocked.map(a => ({ key: a.key, label: a.label, description: a.description, category: a.category, title: a.title }))
      });
    }
  } catch (err) {
    console.error('[succès] échec vérification', { err: err.message });
  }
}

// Manifeste des sprites (tous les dex id du pool + des boss) : le client s'en sert au
// chargement pour précharger discrètement les images en arrière-plan pendant le lobby,
// AVANT qu'une partie ne les demande réellement pour un tour. Supprime le petit flash de
// chargement visible sinon à chaque nouveau Pokémon tiré. Calculé à la demande (route peu
// appelée, une fois par chargement de page) plutôt qu'en variable globale figée : évite
// tout souci d'ordre de déclaration avec BOSSES, défini plus loin dans ce fichier.
app.get('/api/sprite-ids', (req, res) => {
  const ids = [...new Set([...ALL_DEX_IDS, ...BOSSES.map(b => b.id)])].sort((a, b) => a - b);
  res.json(ids);
});

// Formes finales d'évolution (même source que le Bonbon XP : EVOLUTION_MAP). Sert à l'export
// du Draft côté client pour rester cohérent avec le jeu. { dexId: { id, name } } — uniquement
// les Pokémon évoluables ; absent = déjà forme finale.
app.get('/api/evolution-finals', (req, res) => {
  const finals = {};
  for (const [dexId, evo] of Object.entries(EVOLUTION_MAP)) finals[dexId] = { id: evo.id, name: evo.name };
  res.json(finals);
});

// Dex national complet (1-1025, gen 1 à 9) : id + nom pour CHAQUE Pokémon, pas
// seulement ceux tirables en partie. Sert au Pokédex profil (onglet Compte >
// Pokédex) pour afficher la liste complète divisée par génération, avec les
// entrées jamais obtenues masquées ("?"). Statique, calculé une fois au démarrage.
const GENERATIONS = [
  { gen: 1, label: 'Génération 1 — Kanto', from: 1, to: 151 },
  { gen: 2, label: 'Génération 2 — Johto', from: 152, to: 251 },
  { gen: 3, label: 'Génération 3 — Hoenn', from: 252, to: 386 },
  { gen: 4, label: 'Génération 4 — Sinnoh', from: 387, to: 493 },
  { gen: 5, label: 'Génération 5 — Unys', from: 494, to: 649 },
  { gen: 6, label: 'Génération 6 — Kalos', from: 650, to: 721 },
  { gen: 7, label: 'Génération 7 — Alola', from: 722, to: 809 },
  { gen: 8, label: 'Génération 8 — Galar', from: 810, to: 905 },
  { gen: 9, label: 'Génération 9 — Paldea', from: 906, to: 1025 }
];
// `megas` : toutes les formes Méga du jeu (id >= 10000, données du roster), `za: true` pour les
// 49 Méga de Pokémon Légendes Z-A — alimente les onglets « Méga » / « Méga Z-A » du Pokédex.
app.get('/api/pokedex/national', (req, res) => {
  const megas = POKEMON_ENTRIES
    .filter(e => e.id >= 10000)
    .map(e => ({ id: e.id, name: e.name, za: isZaMegaId(e.id) }))
    .sort((a, b) => a.id - b.id);
  // Trait-dex : définitions des traits (ordre de EFFECTS). Aucune probabilité exposée : la rareté
  // reste à découvrir. kind = 'neutral' | 'bonus' | 'malus' | 'gamble' (couleur côté client).
  const traits = EFFECTS.map(e => ({
    name: e.name,
    kind: e.name === 'Neutre' ? 'neutral' : (e.gamble ? 'gamble' : (e.power > 1 ? 'bonus' : 'malus')),
    multiplier: e.gamble ? null : e.multiplier,
    flat: e.flat || 0
  }));
  res.json({ generations: GENERATIONS, dex: NATIONAL_DEX, megas, traits });
});

// Catalogue des modificateurs de partie (libellés/descriptions : source unique côté serveur,
// jamais dupliqué dans le client) + modes où ils sont disponibles.
app.get('/api/modifiers', (req, res) => {
  res.json({ modifiers: GAME_MODIFIERS, modes: MODIFIER_GAME_MODES });
});

app.get('/api/avatars', (req, res) => {
  res.json(AVATARS);
});

// ---------------------------------------------------------------
// ROUTES COMPTES (optionnelles) — Supabase Auth (cf. bloc `supabase` plus haut). Ce
// serveur ne stocke NI ne voit jamais un mot de passe en clair (Supabase Auth s'en
// occupe entièrement) ; seule la table "profiles" (créée manuellement dans Supabase,
// colonnes id/pseudo/created_at) associe un pseudo à chaque compte. Renvoie toujours des
// erreurs génériques côté login pour ne jamais révéler si un email existe ou non.
// ---------------------------------------------------------------
function requireSupabase(res) {
  if (!supabase || !createAuthClient) {
    res.status(503).json({ error: 'Les comptes sont temporairement indisponibles (mode invité toujours utilisable).' });
    return false;
  }
  return true;
}

app.post('/api/register', async (req, res) => {
  if (!requireSupabase(res)) return;
  const { email, password, pseudo } = req.body || {};
  const cleanPseudo = String(pseudo || '').trim();
  if (!email || !password || !cleanPseudo) {
    res.status(400).json({ error: 'Email, mot de passe et pseudo requis.' });
    return;
  }
  if (cleanPseudo.length > 16) {
    res.status(400).json({ error: 'Le pseudo doit faire 16 caractères maximum.' });
    return;
  }

  const { data, error } = await createAuthClient().auth.signUp({ email, password });
  if (error) {
    res.status(400).json({ error: error.message });
    return;
  }
  if (!data.user) {
    res.status(400).json({ error: 'Compte non créé.' });
    return;
  }

  // Avatar de départ tiré au hasard dans AVATARS (pas de valeur par défaut arbitraire
  // hors-liste) — modifiable ensuite via /api/profile/avatar.
  const startingAvatar = AVATARS[Math.floor(Math.random() * AVATARS.length)];
  const { error: profileError } = await supabase
    .from('profiles')
    .insert({ id: data.user.id, pseudo: cleanPseudo, avatar: startingAvatar });
  if (profileError) {
    // Log complet côté serveur (jamais visible du joueur) : le message renvoyé au
    // client seul ne suffit pas à diagnostiquer, cf. code/details/hint PostgREST.
    console.error('[comptes] échec insert profiles', {
      userId: data.user.id,
      code: profileError.code,
      message: profileError.message,
      details: profileError.details,
      hint: profileError.hint
    });
    res.status(400).json({ error: "Compte créé mais le pseudo n'a pas pu être enregistré : " + profileError.message });
    return;
  }

  if (!data.session) {
    // La confirmation par email est activée côté Supabase malgré tout : pas de session
    // immédiate, l'utilisateur doit cliquer le lien reçu avant de pouvoir se connecter.
    res.json({ needsEmailConfirmation: true });
    return;
  }

  res.json({
    accessToken: data.session.access_token,
    refreshToken: data.session.refresh_token,
    pseudo: cleanPseudo,
    avatar: startingAvatar,
    frame: '',
    title: '',
    titleLabel: '',
    xp: 0,
    level: levelForXp(0)
  });
});

app.post('/api/login', async (req, res) => {
  if (!requireSupabase(res)) return;
  const { email, password } = req.body || {};
  if (!email || !password) {
    res.status(400).json({ error: 'Email et mot de passe requis.' });
    return;
  }

  const { data, error } = await createAuthClient().auth.signInWithPassword({ email, password });
  if (error || !data.session) {
    res.status(400).json({ error: 'Email ou mot de passe incorrect.' });
    return;
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('pseudo, avatar, frame, xp, title')
    .eq('id', data.user.id)
    .single();

  const xp = profile ? (profile.xp || 0) : 0;
  res.json({
    accessToken: data.session.access_token,
    refreshToken: data.session.refresh_token,
    pseudo: profile ? profile.pseudo : '',
    avatar: profile ? profile.avatar : null,
    frame: profile ? (profile.frame || '') : '',
    title: profile ? (profile.title || '') : '',
    titleLabel: profile ? titleLabelFor(profile.title) : '',
    xp,
    level: levelForXp(xp)
  });
});

// Restaure une session à partir du refresh_token gardé côté client (cf. localStorage
// rdb_account dans client.js), pour ne pas redemander le mot de passe à chaque
// chargement de page. Réutilisée aussi par le client pour rafraîchir XP/niveau après
// chaque fin de partie (cf. refreshAccountProfile côté client.js).
app.post('/api/session', async (req, res) => {
  if (!requireSupabase(res)) return;
  const { refreshToken } = req.body || {};
  if (!refreshToken) {
    res.status(400).json({ error: 'refreshToken requis.' });
    return;
  }

  const { data, error } = await createAuthClient().auth.refreshSession({ refresh_token: refreshToken });
  if (error || !data.session) {
    res.status(401).json({ error: 'Session expirée.' });
    return;
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('pseudo, avatar, frame, xp, title')
    .eq('id', data.user.id)
    .single();

  const xp = profile ? (profile.xp || 0) : 0;
  res.json({
    accessToken: data.session.access_token,
    refreshToken: data.session.refresh_token,
    pseudo: profile ? profile.pseudo : '',
    avatar: profile ? profile.avatar : null,
    frame: profile ? (profile.frame || '') : '',
    title: profile ? (profile.title || '') : '',
    titleLabel: profile ? titleLabelFor(profile.title) : '',
    xp,
    level: levelForXp(xp)
  });
});

// Change l'avatar du compte connecté. L'identité est vérifiée via accessToken (jamais un
// id envoyé tel quel par le client) : un joueur ne peut modifier que SON PROPRE profil.
app.post('/api/profile/avatar', async (req, res) => {
  if (!requireSupabase(res)) return;
  const { accessToken, avatar } = req.body || {};
  if (!accessToken || !avatar) {
    res.status(400).json({ error: 'accessToken et avatar requis.' });
    return;
  }
  if (!AVATARS.includes(avatar)) {
    res.status(400).json({ error: 'Avatar inconnu.' });
    return;
  }

  const { data: { user }, error: userError } = await createAuthClient().auth.getUser(accessToken);
  if (userError || !user) {
    res.status(401).json({ error: 'Session invalide.' });
    return;
  }

  const { error: updateError } = await supabase
    .from('profiles')
    .update({ avatar })
    .eq('id', user.id);
  if (updateError) {
    res.status(400).json({ error: "L'avatar n'a pas pu être enregistré : " + updateError.message });
    return;
  }

  res.json({ avatar });
});

// Cadres cosmétiques autour de l'avatar, débloqués en montant de niveau (comme les
// couleurs de thème, cf. FRAME_REQUIRED_LEVEL côté client pour l'affichage verrouillé/
// déverrouillé) — revalidé ICI côté serveur avant d'enregistrer, jamais une simple
// confiance dans ce que le client envoie.
const FRAME_REQUIRED_LEVEL = { '': 1, bronze: 5, silver: 10, gold: 20, legendary: 30 };

app.post('/api/profile/frame', async (req, res) => {
  if (!requireSupabase(res)) return;
  const { accessToken, frame } = req.body || {};
  if (!accessToken || frame === undefined) {
    res.status(400).json({ error: 'accessToken et frame requis.' });
    return;
  }
  if (!(frame in FRAME_REQUIRED_LEVEL)) {
    res.status(400).json({ error: 'Cadre inconnu.' });
    return;
  }

  const { data: { user }, error: userError } = await createAuthClient().auth.getUser(accessToken);
  if (userError || !user) {
    res.status(401).json({ error: 'Session invalide.' });
    return;
  }

  const { data: profile, error: profileError } = await supabase.from('profiles').select('xp').eq('id', user.id).single();
  if (profileError) {
    res.status(400).json({ error: 'Profil introuvable.' });
    return;
  }
  const level = levelForXp(profile.xp || 0);
  if (level < FRAME_REQUIRED_LEVEL[frame]) {
    res.status(403).json({ error: `Ce cadre se débloque au niveau ${FRAME_REQUIRED_LEVEL[frame]}.` });
    return;
  }

  const { error: updateError } = await supabase
    .from('profiles')
    .update({ frame })
    .eq('id', user.id);
  if (updateError) {
    res.status(400).json({ error: "Le cadre n'a pas pu être enregistré : " + updateError.message });
    return;
  }

  res.json({ frame });
});

// Équipe / retire un titre. `title` = clé d'un succès ('' = aucun titre). Revalidé ICI :
// la clé doit exister ET le succès correspondant doit être débloqué pour ce compte.
app.post('/api/profile/title', async (req, res) => {
  if (!requireSupabase(res)) return;
  const { accessToken, title } = req.body || {};
  if (!accessToken || typeof title !== 'string') {
    res.status(400).json({ error: 'accessToken et title requis.' });
    return;
  }
  if (title !== '' && !ACHIEVEMENTS.some(a => a.key === title)) {
    res.status(400).json({ error: 'Titre inconnu.' });
    return;
  }

  const { data: { user }, error: userError } = await createAuthClient().auth.getUser(accessToken);
  if (userError || !user) {
    res.status(401).json({ error: 'Session invalide.' });
    return;
  }

  if (title !== '') {
    await checkAndUnlockAchievements(user.id, null); // réconcilie avant de vérifier
    const { data: owned, error: ownedError } = await supabase
      .from('achievements')
      .select('achievement_key')
      .eq('user_id', user.id)
      .eq('achievement_key', title);
    if (ownedError) {
      res.status(400).json({ error: 'Vérification du titre impossible.' });
      return;
    }
    if (!owned || owned.length === 0) {
      res.status(403).json({ error: "Ce titre n'est pas encore débloqué." });
      return;
    }
  }

  const { error: updateError } = await supabase
    .from('profiles')
    .update({ title })
    .eq('id', user.id);
  if (updateError) {
    res.status(400).json({ error: "Le titre n'a pas pu être enregistré : " + updateError.message });
    return;
  }

  res.json({ title, titleLabel: titleLabelFor(title) });
});

// Historique des 10 dernières parties terminées (cf. recordGameResult, appelé à chaque
// fin de partie). Identité vérifiée via accessToken, comme /api/profile/avatar.
app.post('/api/profile/history', async (req, res) => {
  if (!requireSupabase(res)) return;
  const { accessToken } = req.body || {};
  if (!accessToken) {
    res.status(400).json({ error: 'accessToken requis.' });
    return;
  }

  const { data: { user }, error: userError } = await createAuthClient().auth.getUser(accessToken);
  if (userError || !user) {
    res.status(401).json({ error: 'Session invalide.' });
    return;
  }

  const { data, error } = await supabase
    .from('game_history')
    .select('game_mode, result, score, opponent_name, team, created_at')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(10);
  if (error) {
    res.status(400).json({ error: "L'historique n'a pas pu être récupéré." });
    return;
  }

  res.json({ history: data || [] });
});

// Liste des 10 succès (facile/difficile) avec leur état débloqué/verrouillé pour ce
// compte. La définition (label/description/catégorie) vient toujours du serveur — jamais
// stockée ni recalculée côté client — seul le statut "unlocked" varie par joueur.
app.post('/api/profile/achievements', async (req, res) => {
  if (!requireSupabase(res)) return;
  const { accessToken } = req.body || {};
  if (!accessToken) {
    res.status(400).json({ error: 'accessToken requis.' });
    return;
  }

  const { data: { user }, error: userError } = await createAuthClient().auth.getUser(accessToken);
  if (userError || !user) {
    res.status(401).json({ error: 'Session invalide.' });
    return;
  }

  // Réconcilie silencieusement (sans toast, cf. checkAndUnlockAchievements(..., null))
  // AVANT de lire l'état actuel : garantit que la liste retournée est toujours à jour,
  // même pour un succès déjà mérité dans l'historique mais jamais encore vérifié (ex :
  // juste après le déploiement de cette fonctionnalité, ou après une longue absence).
  // Sans ça, un succès ancien ne se débloquerait visuellement qu'à la prochaine fin de
  // partie — quel que soit son résultat, gagné ou perdu — ce qui semble incohérent.
  await checkAndUnlockAchievements(user.id, null);

  const { data, error } = await supabase.from('achievements').select('achievement_key').eq('user_id', user.id);
  if (error) {
    res.status(400).json({ error: 'Les succès n\'ont pas pu être récupérés.' });
    return;
  }

  const unlockedKeys = new Set((data || []).map(a => a.achievement_key));
  const { data: titleRow } = await supabase.from('profiles').select('title').eq('id', user.id).single();
  const selectedTitle = titleRow && unlockedKeys.has(titleRow.title) ? titleRow.title : '';
  res.json({
    selectedTitle,
    achievements: ACHIEVEMENTS.map(a => ({
      key: a.key,
      category: a.category,
      label: a.label,
      description: a.description,
      title: a.title,
      unlocked: unlockedKeys.has(a.key)
    }))
  });
});

// Pokédex personnel : tous les Pokémon obtenus au moins une fois, toutes parties/modes
// confondus — dérivé de game_history.team (déjà stocké pour le détail d'historique et les
// succès), jamais une table à part : une seule source de vérité. auctionTeam n'a pas de
// champ shiny (jamais aveugle en Draft/Enchères) donc ignoré pour ce flag spécifiquement,
// mais compte quand même comme "obtenu".
app.post('/api/profile/pokedex', async (req, res) => {
  if (!requireSupabase(res)) return;
  const { accessToken } = req.body || {};
  if (!accessToken) {
    res.status(400).json({ error: 'accessToken requis.' });
    return;
  }

  const { data: { user }, error: userError } = await createAuthClient().auth.getUser(accessToken);
  if (userError || !user) {
    res.status(401).json({ error: 'Session invalide.' });
    return;
  }

  const { data, error } = await supabase.from('game_history').select('team, game_mode').eq('user_id', user.id);
  if (error) {
    res.status(400).json({ error: 'Le Pokédex n\'a pas pu être récupéré.' });
    return;
  }

  // Objectifs Pokédex (titres) : réconcilie d'abord les succès (silencieux), puis lit ceux débloqués.
  let objectives = null;
  try {
    await checkAndUnlockAchievements(user.id, null);
    const { data: unlockedRows } = await supabase.from('achievements').select('achievement_key').eq('user_id', user.id);
    const unlocked = new Set((unlockedRows || []).map(a => a.achievement_key));
    const dexIds = new Set();
    (data || []).filter(r => r.game_mode !== 'fly').forEach(r => {
      if (Array.isArray(r.team)) r.team.forEach(m => { if (m && Number.isInteger(m.id) && m.id < 10000) dexIds.add(m.id); });
    });
    const typeCounts = computeDexTypeCounts(dexIds);
    objectives = {
      total: {
        count: dexIds.size,
        tiers: DEX_TOTAL_TIERS.map(t => ({ n: t.n, title: t.title, unlocked: unlocked.has(`dex_total_${t.n}`) }))
      },
      types: Object.keys(DEX_TYPE_LABELS).map(type => ({
        type, label: DEX_TYPE_LABELS[type], count: typeCounts[type] || 0,
        tiers: DEX_TYPE_TIERS.map(t => ({ n: t.n, title: `${t.prefix} ${DEX_TYPE_LABELS[type]}`, unlocked: unlocked.has(`dex_${type}_${t.n}`) }))
      }))
    };
  } catch (e) { objectives = null; }

  const seen = new Map(); // id -> { id, name, sprite, shiny }
  (data || []).forEach(row => {
    if (!Array.isArray(row.team)) return;
    row.team.forEach(mon => {
      if (!mon || !mon.id) return;
      const existing = seen.get(mon.id);
      if (existing) {
        if (mon.shiny) existing.shiny = true;
      } else {
        seen.set(mon.id, { id: mon.id, name: mon.name, sprite: mon.sprite, shiny: !!mon.shiny });
      }
    });
  });

  // Trait-dex : traits présents dans les équipes FINALES de l'historique (comme le Pokédex : un
  // trait remplacé en cours de partie n'est pas compté). count = nb de Pokémon l'ayant porté ;
  // pour LET'S GO GAMBLING, minRoll/maxRoll = pire/meilleur multiplicateur tiré (gambleRoll).
  const traitNames = new Set(EFFECTS.map(e => e.name));
  const traits = {};
  (data || []).forEach(row => {
    if (!Array.isArray(row.team)) return;
    row.team.forEach(mon => {
      if (!mon || !traitNames.has(mon.effectName)) return;
      const t = traits[mon.effectName] || (traits[mon.effectName] = { count: 0 });
      t.count += 1;
      if (typeof mon.gambleRoll === 'number') {
        t.minRoll = t.minRoll === undefined ? mon.gambleRoll : Math.min(t.minRoll, mon.gambleRoll);
        t.maxRoll = t.maxRoll === undefined ? mon.gambleRoll : Math.max(t.maxRoll, mon.gambleRoll);
      }
    });
  });

  res.json({ seen: Array.from(seen.values()), traits, objectives, shinies: computeShinyStats(data) });
});

// Stats de profil : Pokémon le plus tiré, taux de victoire par mode, meilleur score par
// difficulté — dérivé de game_history comme le Pokédex, mêmes principes (rien de
// persisté à part, tout recalculé à la demande).
app.post('/api/profile/stats', async (req, res) => {
  if (!requireSupabase(res)) return;
  const { accessToken } = req.body || {};
  if (!accessToken) {
    res.status(400).json({ error: 'accessToken requis.' });
    return;
  }

  const { data: { user }, error: userError } = await createAuthClient().auth.getUser(accessToken);
  if (userError || !user) {
    res.status(401).json({ error: 'Session invalide.' });
    return;
  }

  const { data, error } = await supabase.from('game_history').select('game_mode, result, score, difficulty, team').eq('user_id', user.id);
  if (error) {
    res.status(400).json({ error: 'Les statistiques n\'ont pas pu être récupérées.' });
    return;
  }

  const rows = data || [];
  const winRateByMode = {};
  const bestScoreByDifficulty = {};
  const pokemonCounts = new Map(); // id -> { id, name, sprite, count }

  rows.forEach(row => {
    if (!winRateByMode[row.game_mode]) winRateByMode[row.game_mode] = { wins: 0, total: 0 };
    winRateByMode[row.game_mode].total += 1;
    if (row.result === 'victory') winRateByMode[row.game_mode].wins += 1;

    if (typeof row.score === 'number' && row.difficulty) {
      const current = bestScoreByDifficulty[row.difficulty];
      if (current === undefined || row.score > current) bestScoreByDifficulty[row.difficulty] = row.score;
    }

    if (Array.isArray(row.team)) {
      row.team.forEach(mon => {
        if (!mon || !mon.id) return;
        const existing = pokemonCounts.get(mon.id);
        if (existing) existing.count += 1;
        else pokemonCounts.set(mon.id, { id: mon.id, name: mon.name, sprite: mon.sprite, count: 1 });
      });
    }
  });

  const topPokemon = Array.from(pokemonCounts.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  res.json({ gamesPlayed: rows.length, winRateByMode, bestScoreByDifficulty, topPokemon });
});

// -----------------------------------------------------------------
// AMIS — table `friendships` : une ligne par relation, PEU IMPORTE le sens
// (user_id = qui a envoyé la demande, friend_id = qui l'a reçue), status
// 'pending'|'accepted'. Toujours vérifiée dans LES DEUX sens (cf. .or(...) plus bas) :
// une amitié acceptée ou une demande en cours n'a qu'une seule ligne, jamais deux.
// -----------------------------------------------------------------
async function getAuthedUser(accessToken) {
  if (!accessToken) return null;
  const { data: { user } } = await createAuthClient().auth.getUser(accessToken);
  return user || null;
}

// Recherche par pseudo (insensible à la casse), exclut soi-même, indique pour chaque
// résultat la relation déjà existante (aucune/demande envoyée/demande reçue/ami) pour que
// le client affiche le bon bouton sans avoir à deviner.
app.post('/api/friends/search', async (req, res) => {
  if (!requireSupabase(res)) return;
  const { accessToken, query } = req.body || {};
  const user = await getAuthedUser(accessToken);
  if (!user) {
    res.status(401).json({ error: 'Session invalide.' });
    return;
  }
  const trimmed = (query || '').trim();
  if (trimmed.length < 2) {
    res.json({ results: [] });
    return;
  }

  const { data: profiles, error } = await supabase
    .from('profiles')
    .select('id, pseudo, avatar, frame, title')
    .ilike('pseudo', `%${trimmed}%`)
    .neq('id', user.id)
    .limit(10);
  if (error) {
    res.status(400).json({ error: 'La recherche a échoué.' });
    return;
  }

  const { data: relations } = await supabase
    .from('friendships')
    .select('user_id, friend_id, status')
    .or(`user_id.eq.${user.id},friend_id.eq.${user.id}`);

  const results = (profiles || []).map(p => {
    const rel = (relations || []).find(r => r.user_id === p.id || r.friend_id === p.id);
    let relation = 'none';
    if (rel) {
      if (rel.status === 'accepted') relation = 'friend';
      else if (rel.user_id === user.id) relation = 'pending_sent';
      else relation = 'pending_received';
    }
    return { id: p.id, pseudo: p.pseudo, avatar: p.avatar, frame: p.frame || '', titleLabel: titleLabelFor(p.title), relation };
  });
  res.json({ results });
});

app.post('/api/friends/request', async (req, res) => {
  if (!requireSupabase(res)) return;
  const { accessToken, targetId } = req.body || {};
  const user = await getAuthedUser(accessToken);
  if (!user) {
    res.status(401).json({ error: 'Session invalide.' });
    return;
  }
  if (!targetId || targetId === user.id) {
    res.status(400).json({ error: 'Destinataire invalide.' });
    return;
  }

  const { data: existing } = await supabase
    .from('friendships')
    .select('user_id, friend_id, status')
    .or(`user_id.eq.${user.id},friend_id.eq.${user.id}`)
    .or(`user_id.eq.${targetId},friend_id.eq.${targetId}`);
  const already = (existing || []).find(r =>
    (r.user_id === user.id && r.friend_id === targetId) || (r.user_id === targetId && r.friend_id === user.id)
  );
  if (already) {
    res.status(400).json({ error: 'Une relation existe déjà avec ce joueur.' });
    return;
  }

  const { error } = await supabase.from('friendships').insert({ user_id: user.id, friend_id: targetId, status: 'pending' });
  if (error) {
    res.status(400).json({ error: "La demande n'a pas pu être envoyée." });
    return;
  }
  res.json({ ok: true });
});

// accept: true accepte, false refuse (supprime la ligne). Seul le DESTINATAIRE
// (friend_id) d'une demande en attente peut répondre — jamais celui qui l'a envoyée.
app.post('/api/friends/respond', async (req, res) => {
  if (!requireSupabase(res)) return;
  const { accessToken, requesterId, accept } = req.body || {};
  const user = await getAuthedUser(accessToken);
  if (!user) {
    res.status(401).json({ error: 'Session invalide.' });
    return;
  }
  if (!requesterId) {
    res.status(400).json({ error: 'Demande invalide.' });
    return;
  }

  if (accept) {
    const { error } = await supabase
      .from('friendships')
      .update({ status: 'accepted' })
      .eq('user_id', requesterId)
      .eq('friend_id', user.id)
      .eq('status', 'pending');
    if (error) {
      res.status(400).json({ error: "La demande n'a pas pu être acceptée." });
      return;
    }
  } else {
    await supabase.from('friendships').delete().eq('user_id', requesterId).eq('friend_id', user.id).eq('status', 'pending');
  }
  res.json({ ok: true });
});

app.post('/api/friends/remove', async (req, res) => {
  if (!requireSupabase(res)) return;
  const { accessToken, friendId } = req.body || {};
  const user = await getAuthedUser(accessToken);
  if (!user) {
    res.status(401).json({ error: 'Session invalide.' });
    return;
  }
  if (!friendId) {
    res.status(400).json({ error: 'Ami invalide.' });
    return;
  }
  await supabase.from('friendships').delete().eq('user_id', user.id).eq('friend_id', friendId);
  await supabase.from('friendships').delete().eq('user_id', friendId).eq('friend_id', user.id);
  res.json({ ok: true });
});

// Liste complète : amis acceptés (avec statut en ligne, cf. onlineAccounts plus bas),
// demandes reçues (à répondre) et demandes envoyées (en attente de l'autre).
app.post('/api/friends/list', async (req, res) => {
  if (!requireSupabase(res)) return;
  const { accessToken } = req.body || {};
  const user = await getAuthedUser(accessToken);
  if (!user) {
    res.status(401).json({ error: 'Session invalide.' });
    return;
  }

  const { data: relations, error } = await supabase
    .from('friendships')
    .select('user_id, friend_id, status')
    .or(`user_id.eq.${user.id},friend_id.eq.${user.id}`);
  if (error) {
    res.status(400).json({ error: 'La liste d\'amis n\'a pas pu être récupérée.' });
    return;
  }

  const otherIds = (relations || []).map(r => (r.user_id === user.id ? r.friend_id : r.user_id));
  let profilesById = {};
  if (otherIds.length > 0) {
    const { data: profiles } = await supabase.from('profiles').select('id, pseudo, avatar, frame, title').in('id', otherIds);
    profilesById = Object.fromEntries((profiles || []).map(p => [p.id, p]));
  }

  const friends = [];
  const incoming = [];
  const outgoing = [];
  (relations || []).forEach(r => {
    const otherId = r.user_id === user.id ? r.friend_id : r.user_id;
    const profile = profilesById[otherId];
    if (!profile) return;
    const entry = { id: otherId, pseudo: profile.pseudo, avatar: profile.avatar, frame: profile.frame || '', titleLabel: titleLabelFor(profile.title) };
    if (r.status === 'accepted') {
      entry.online = isAccountOnline(otherId);
      friends.push(entry);
    } else if (r.friend_id === user.id) {
      incoming.push(entry);
    } else {
      outgoing.push(entry);
    }
  });

  res.json({ friends, incoming, outgoing });
});

// Classement global par XP — public (aucun accessToken requis, comme /api/avatars),
// mais accepte un accessToken OPTIONNEL pour indiquer au client quelle ligne est "la
// sienne" (surlignage) sans lui faire deviner via le pseudo (qu'un autre joueur pourrait
// avoir choisi à l'identique). N'affecte jamais le classement lui-même : purement pour
// l'affichage.
app.post('/api/leaderboard', async (req, res) => {
  if (!requireSupabase(res)) return;
  const { accessToken } = req.body || {};

  let selfId = null;
  if (accessToken) {
    const { data: { user } } = await createAuthClient().auth.getUser(accessToken);
    if (user) selfId = user.id;
  }

  const { data, error } = await supabase
    .from('profiles')
    .select('id, pseudo, avatar, xp, title')
    .order('xp', { ascending: false })
    .limit(50);
  if (error) {
    res.status(400).json({ error: 'Le classement n\'a pas pu être récupéré.' });
    return;
  }

  res.json({
    leaderboard: (data || []).map(p => ({
      pseudo: p.pseudo,
      avatar: p.avatar,
      titleLabel: titleLabelFor(p.title),
      xp: p.xp || 0,
      level: levelForXp(p.xp || 0),
      isSelf: !!selfId && p.id === selfId
    }))
  });
});


// ---------------------------------------------------------------
// Configuration du jeu
// ---------------------------------------------------------------
const MAX_TURNS = 6; // aligné sur les 6 slots d'équipe : chaque tour rapporte 1 Pokémon
const REVEAL_DELAY_MS = 4000; // pause de révélation avant de passer au tour suivant

// Plafond d'équipe (mode normal/admin — l'équipe d'enchères a son propre AUCTION_TEAM_SIZE
// plus haut). Passe TOUJOURS par pushMonToTeam ci-dessous pour ajouter un Pokémon à une
// équipe : point de passage unique, pour qu'aucun futur event/bonus ne puisse oublier la
// vérification et dépasser 6 (cf. l'événement MIRROR, retiré du jeu pour cette raison).
const MAX_TEAM_SIZE = 6;

// Retourne true si le Pokémon a bien été ajouté, false si l'équipe était déjà pleine
// (le joueur garde son score/point gagné, juste pas de 7e slot).
function pushMonToTeam(player, mon) {
  if (player.team.length >= MAX_TEAM_SIZE) return false;
  player.team.push(mon);
  return true;
}

// Sprites AUTO-HÉBERGÉS (public/sprites/<id>.webp, 256 px) : bien plus légers que les PNG ~475 px du CDN
// PokeAPI (≈13 Ko contre ≈130 Ko), servis par le même serveur, mis en cache 30 jours. Si un fichier manque,
// le client retombe automatiquement sur le CDN (cf. client.js, gestionnaire d'erreur d'image).
function spriteUrl(dexId) {
  return `/sprites/${dexId}.webp`;
}

// Aucun sprite shiny n'existe (même chez PokeAPI) pour ces Méga Z-A, dont Méga-Carchacrok Z (10309) :
// on renvoie le sprite normal plutôt qu'une image cassée.
const SHINY_SPRITE_MISSING = new Set([10309, 10318, 10322, 10323]);
function shinySpriteUrl(dexId) {
  if (SHINY_SPRITE_MISSING.has(Number(dexId))) return spriteUrl(dexId);
  return `/sprites/shiny/${dexId}.webp`;
}

// -----------------------------------------------------------------
// SHINY — indépendant de la rareté et de l'effet/trait. 2% de chance qu'un Pokémon
// nouvellement généré soit chromatique ; ses points sont alors multipliés par
// SHINY_POINTS_MULTIPLIER en plus de son effet (cumulatif, jamais à la place). Constante
// UNIQUE et partagée : utilisée à la fois au tirage (buildRewardOption/buildAdminModeOption)
// et par l'événement rare POKÉMON SHINY (qui rend chromatique un Pokémon déjà en équipe) —
// un seul chiffre à ajuster pour tout le jeu, jamais deux mécaniques qui divergent.
// -----------------------------------------------------------------
const SHINY_CHANCE = 0.02;
const SHINY_POINTS_MULTIPLIER = 1.5;

// doubled = true pour un joueur qui a le Charme Chroma (passif) : chances de shiny ×2.
function rollShiny(doubled) {
  return Math.random() < SHINY_CHANCE * (doubled ? 2 : 1);
}

// -----------------------------------------------------------------
// EASTER EGG — MÉTAMORPH (dex 132). Cliquer sur un Métamorph dans son équipe (cf.
// socket.on('transform_metamorph')) le transforme : il copie le sprite d'un AUTRE
// Pokémon au hasard dans la même équipe et prend 75% de sa valeur actuelle. Le nom
// affiché reste TOUJOURS "Métamorph" (jamais réécrit, c'est tout le principe).
// -----------------------------------------------------------------
const METAMORPH_DEX_ID = 132;
const METAMORPH_TRANSFORM_MULTIPLIER = 0.75;

// -----------------------------------------------------------------
// Pool de Pokémon organisé par rareté.
// Chaque tour, le serveur tire d'abord une rareté (selon RARITY_TABLE),
// puis un Pokémon au hasard dans cette rareté.
// -----------------------------------------------------------------

// Plus AUCUNE liste manuelle par rareté : la catégorie et les points de chaque Pokémon sont
// calculés au démarrage par stats.js (BST officiel × multiplicateur de catégorie). Les
// exceptions (Méga, Ultra-Chimère, Fabuleux, Légendaire, Semi-légendaire) et les seuils de BST
// vivent uniquement dans stats-config.js ; les Base Stats dans data/pokemon-stats.json
// (généré par fetch-stats.js). Le serveur refuse de démarrer si ce fichier est absent/incomplet.
let POKEMON_ENTRIES;
try {
  POKEMON_ENTRIES = pokemonStats.loadEntries();
} catch (err) {
  console.error('[points] Démarrage impossible : ' + err.message);
  process.exit(1);
}

// Lignées SEMI-LÉGENDAIRES (pseudo-légendaires) complètes : les 1er et 2e stades sont rangés dans la même
// catégorie que la forme finale (tirages, Pokédex, succès). Seule l'ÉTIQUETTE de rareté change : les points
// de base restent ceux calculés par stats.js (BST), donc aucun gonflement de score. Les Méga (id >= 10000)
// gardent leur propre catégorie.
const PSEUDO_LEGENDARY_LINES = [
  [147, 148, 149], // Minidraco, Draco, Dracolosse
  [246, 247, 248], // Embrylex, Ymphect, Tyranocif
  [371, 372, 373], // Draby, Drackhaus, Drattak
  [374, 375, 376], // Terhal, Métang, Métalosse
  [443, 444, 445], // Griknot, Carmache, Carchacrok
  [633, 634, 635], // Solochi, Diamat, Trioxhydre
  [704, 705, 706], // Mucuscule, Colimucus, Muplodocus
  [782, 783, 784], // Bébécaille, Écaïd, Ékaïser
  [885, 886, 887], // Fantyrm, Dispareptil, Lanssorien
  [996, 997, 998]  // Frigodo, Cryodo, Glaivodo
];
{
  const pseudoIds = new Set(PSEUDO_LEGENDARY_LINES.flat());
  let moved = 0;
  POKEMON_ENTRIES.forEach(e => {
    if (pseudoIds.has(e.id) && e.rarity !== 'pseudo_legendaire') { e.rarity = 'pseudo_legendaire'; moved++; }
  });
  if (moved) console.log(`[points] ${moved} pré-évolution(s) de semi-légendaires rangée(s) en pseudo_legendaire.`);
}

// ---- Mécaniques de TYPE des boss (cf. boss-mechanics.js / boss-mechanics-config.js) ----
// Types par Pokémon (data/pokemon-stats.json, via fetch-stats.js) + table d'efficacité
// (data/type-chart.json, via fetch-types.js) : jamais saisis à la main. Le serveur refuse de
// démarrer si l'un des deux est absent/incomplet. Le pool de référence (type « à contrer »)
// exclut les Méga (id >= 10000, tirées seulement en Admin vs Joueur).
let BOSS_MECHANICS;
try {
  BOSS_MECHANICS = createBossMechanics({
    ...loadTypeData(),
    config: bossMechanicsConfig,
    shinyMultiplier: SHINY_POINTS_MULTIPLIER,
    poolIds: POKEMON_ENTRIES.filter(e => e.id < 10000).map(e => e.id)
  });
} catch (err) {
  console.error('[types] Démarrage impossible : ' + err.message);
  process.exit(1);
}

// Recalcule le bonus de type du joueur depuis son équipe ACTUELLE (un seul calcul partagé) et
// ajuste player.score de la différence. À appeler après TOUT changement d'équipe/de score.
// Retourne la variation de score due aux bonus (0 si la mécanique est inactive dans ce mode).
function syncTypeBonus(player, game) {
  const delta = BOSS_MECHANICS.syncPlayer(player, game);
  if (player.typeBonus && player.id) io.to(player.id).emit('type_bonus_updated', player.typeBonus);
  return delta;
}

// Types / faiblesses / type à contrer du boss + règles affichables ; calibrage optionnel des
// objectifs (facteur 1 par défaut = aucun changement). Appelé AVANT le calcul de l'objectif coop.
function applyBossMechanics(game) {
  const boss = game.boss;
  Object.assign(boss, BOSS_MECHANICS.describeBoss(boss));
  boss.typeRules = BOSS_MECHANICS.isEnabled(game.gameMode) ? BOSS_MECHANICS.publicRules() : null;
  const scale = BOSS_MECHANICS.scaleFor(boss, game.gameMode);
  if (scale !== 1) boss.requiredPoints = Math.round(boss.requiredPoints * scale / 10) * 10;
  // Modificateurs de partie (cf. GAME_MODIFIERS) : appliqués ICI, avant l'objectif coop.
  let modifierFactor = 1;
  if (gameHasModifier(game, 'boss_x15')) modifierFactor *= 1.5;
  if (gameHasModifier(game, 'sprint')) modifierFactor *= SPRINT_TURNS / MAX_TURNS;
  if (modifierFactor !== 1) boss.requiredPoints = Math.max(10, Math.round(boss.requiredPoints * modifierFactor / 10) * 10);
}

const POKEMON_POOLS = {};
statsConfig.CATEGORY_ORDER.forEach(cat => { POKEMON_POOLS[cat] = []; });
for (const e of POKEMON_ENTRIES) {
  POKEMON_POOLS[e.rarity].push({
    id: e.id,
    name: e.name,
    rarity: e.rarity,
    sprite: spriteUrl(e.id),
    bst: e.bst,
    basePoints: e.basePoints
  });
}
for (const [cat, pool] of Object.entries(POKEMON_POOLS)) {
  if (!pool.length) {
    throw new Error(`[points] La catégorie "${cat}" est vide : vérifie CATEGORY_THRESHOLDS dans stats-config.js.`);
  }
}
console.log('[points] Pools : ' + statsConfig.CATEGORY_ORDER.map(c => `${c}=${POKEMON_POOLS[c].length}`).join(' '));
if (!statsConfig.THRESHOLDS_CALIBRATED) {
  console.warn('[points] ⚠ Seuils de BST provisoires : lance "node analyze-stats.js" puis mets à jour stats-config.js.');
}

// Pool d'un "palier" pour les modes Devine/Enchères : le palier 'legendaire' regroupe
// légendaire + fabuleux + ultra-chimère (ancien palier unique), pour garder les mêmes
// effectifs de planche/lots qu'avant la séparation des catégories.
function getTierPool(tier) {
  return tier === 'legendaire' ? LEGENDARY_GROUP.flatMap(r => POKEMON_POOLS[r]) : POKEMON_POOLS[tier];
}

// -----------------------------------------------------------------
// ÉVOLUTIONS — SOURCE DE VÉRITÉ UNIQUE (Bonbon XP, Évolution instantanée ET export du
// Draft, cf. GET /api/evolution-finals). Table brute id -> id du stade précédent, tirée de
// PokeAPI (pokemon_species.evolves_from_species_id, dex national 1-1025, toutes générations,
// toutes méthodes d'évolution). Une seule donnée saisie ; tout le reste (évolvable ?, forme
// finale, points) en est DÉDUIT, plus aucune liste parallèle à maintenir à la main.
// Règle de descente (identique à l'ancienne table pour les branches existantes : Ortide,
// Ptitard, Ramoloss, Miaouss...) : on part du Pokémon lui-même, et à chaque embranchement on
// prend l'évolution au dex id le plus bas. Un Pokémon sans évolution (forme finale) n'est
// jamais évoluable ; les formes méga (id >= 10000) ne sont pas dans le graphe.
// -----------------------------------------------------------------
const EVOLVES_FROM = {
  2: 1, 3: 2, 5: 4, 6: 5, 8: 7, 9: 8, 11: 10, 12: 11, 14: 13, 15: 14, 17: 16, 18: 17, 20: 19,
  22: 21, 24: 23, 25: 172, 26: 25, 28: 27, 30: 29, 31: 30, 33: 32, 34: 33, 35: 173, 36: 35,
  38: 37, 39: 174, 40: 39, 42: 41, 44: 43, 45: 44, 47: 46, 49: 48, 51: 50, 53: 52, 55: 54,
  57: 56, 59: 58, 61: 60, 62: 61, 64: 63, 65: 64, 67: 66, 68: 67, 70: 69, 71: 70, 73: 72,
  75: 74, 76: 75, 78: 77, 80: 79, 82: 81, 85: 84, 87: 86, 89: 88, 91: 90, 93: 92, 94: 93,
  97: 96, 99: 98, 101: 100, 103: 102, 105: 104, 106: 236, 107: 236, 110: 109, 112: 111,
  113: 440, 117: 116, 119: 118, 121: 120, 122: 439, 124: 238, 125: 239, 126: 240, 130: 129,
  134: 133, 135: 133, 136: 133, 139: 138, 141: 140, 143: 446, 148: 147, 149: 148, 153: 152,
  154: 153, 156: 155, 157: 156, 159: 158, 160: 159, 162: 161, 164: 163, 166: 165, 168: 167,
  169: 42, 171: 170, 176: 175, 178: 177, 180: 179, 181: 180, 182: 44, 183: 298, 184: 183,
  185: 438, 186: 61, 188: 187, 189: 188, 192: 191, 195: 194, 196: 133, 197: 133, 199: 79,
  202: 360, 205: 204, 208: 95, 210: 209, 212: 123, 217: 216, 219: 218, 221: 220, 224: 223,
  226: 458, 229: 228, 230: 117, 232: 231, 233: 137, 237: 236, 242: 113, 247: 246, 248: 247,
  253: 252, 254: 253, 256: 255, 257: 256, 259: 258, 260: 259, 262: 261, 264: 263, 266: 265,
  267: 266, 268: 265, 269: 268, 271: 270, 272: 271, 274: 273, 275: 274, 277: 276, 279: 278,
  281: 280, 282: 281, 284: 283, 286: 285, 288: 287, 289: 288, 291: 290, 292: 290, 294: 293,
  295: 294, 297: 296, 301: 300, 305: 304, 306: 305, 308: 307, 310: 309, 315: 406, 317: 316,
  319: 318, 321: 320, 323: 322, 326: 325, 329: 328, 330: 329, 332: 331, 334: 333, 340: 339,
  342: 341, 344: 343, 346: 345, 348: 347, 350: 349, 354: 353, 356: 355, 358: 433, 362: 361,
  364: 363, 365: 364, 367: 366, 368: 366, 372: 371, 373: 372, 375: 374, 376: 375, 388: 387,
  389: 388, 391: 390, 392: 391, 394: 393, 395: 394, 397: 396, 398: 397, 400: 399, 402: 401,
  404: 403, 405: 404, 407: 315, 409: 408, 411: 410, 413: 412, 414: 412, 416: 415, 419: 418,
  421: 420, 423: 422, 424: 190, 426: 425, 428: 427, 429: 200, 430: 198, 432: 431, 435: 434,
  437: 436, 444: 443, 445: 444, 448: 447, 450: 449, 452: 451, 454: 453, 457: 456, 460: 459,
  461: 215, 462: 82, 463: 108, 464: 112, 465: 114, 466: 125, 467: 126, 468: 176, 469: 193,
  470: 133, 471: 133, 472: 207, 473: 221, 474: 233, 475: 281, 476: 299, 477: 356, 478: 361,
  496: 495, 497: 496, 499: 498, 500: 499, 502: 501, 503: 502, 505: 504, 507: 506, 508: 507,
  510: 509, 512: 511, 514: 513, 516: 515, 518: 517, 520: 519, 521: 520, 523: 522, 525: 524,
  526: 525, 528: 527, 530: 529, 533: 532, 534: 533, 536: 535, 537: 536, 541: 540, 542: 541,
  544: 543, 545: 544, 547: 546, 549: 548, 552: 551, 553: 552, 555: 554, 558: 557, 560: 559,
  563: 562, 565: 564, 567: 566, 569: 568, 571: 570, 573: 572, 575: 574, 576: 575, 578: 577,
  579: 578, 581: 580, 583: 582, 584: 583, 586: 585, 589: 588, 591: 590, 593: 592, 596: 595,
  598: 597, 600: 599, 601: 600, 603: 602, 604: 603, 606: 605, 608: 607, 609: 608, 611: 610,
  612: 611, 614: 613, 617: 616, 620: 619, 623: 622, 625: 624, 628: 627, 630: 629, 634: 633,
  635: 634, 637: 636, 651: 650, 652: 651, 654: 653, 655: 654, 657: 656, 658: 657, 660: 659,
  662: 661, 663: 662, 665: 664, 666: 665, 668: 667, 670: 669, 671: 670, 673: 672, 675: 674,
  678: 677, 680: 679, 681: 680, 683: 682, 685: 684, 687: 686, 689: 688, 691: 690, 693: 692,
  695: 694, 697: 696, 699: 698, 700: 133, 705: 704, 706: 705, 709: 708, 711: 710, 713: 712,
  715: 714, 723: 722, 724: 723, 726: 725, 727: 726, 729: 728, 730: 729, 732: 731, 733: 732,
  735: 734, 737: 736, 738: 737, 740: 739, 743: 742, 745: 744, 748: 747, 750: 749, 752: 751,
  754: 753, 756: 755, 758: 757, 760: 759, 762: 761, 763: 762, 768: 767, 770: 769, 773: 772,
  783: 782, 784: 783, 790: 789, 791: 790, 792: 790, 804: 803, 809: 808, 811: 810, 812: 811,
  814: 813, 815: 814, 817: 816, 818: 817, 820: 819, 822: 821, 823: 822, 825: 824, 826: 825,
  828: 827, 830: 829, 832: 831, 834: 833, 836: 835, 838: 837, 839: 838, 841: 840, 842: 840,
  844: 843, 847: 846, 849: 848, 851: 850, 853: 852, 855: 854, 857: 856, 858: 857, 860: 859,
  861: 860, 862: 264, 863: 52, 864: 222, 865: 83, 866: 122, 867: 562, 869: 868, 873: 872,
  879: 878, 886: 885, 887: 886, 892: 891, 899: 234, 900: 123, 901: 217, 902: 550, 903: 215,
  904: 211, 907: 906, 908: 907, 910: 909, 911: 910, 913: 912, 914: 913, 916: 915, 918: 917,
  920: 919, 922: 921, 923: 922, 925: 924, 927: 926, 929: 928, 930: 929, 933: 932, 934: 933,
  936: 935, 937: 935, 939: 938, 941: 940, 943: 942, 945: 944, 947: 946, 949: 948, 952: 951,
  954: 953, 956: 955, 958: 957, 959: 958, 961: 960, 964: 963, 966: 965, 970: 969, 972: 971,
  975: 974, 979: 57, 980: 194, 981: 203, 982: 206, 983: 625, 997: 996, 998: 997, 1000: 999,
  1011: 840, 1013: 1012, 1018: 884, 1019: 1011
};

const EVOLUTION_CHILDREN = {};
for (const [child, parent] of Object.entries(EVOLVES_FROM)) {
  (EVOLUTION_CHILDREN[parent] = EVOLUTION_CHILDREN[parent] || []).push(Number(child));
}
Object.values(EVOLUTION_CHILDREN).forEach(list => list.sort((a, b) => a - b));

// Forme finale d'un dex id (lui-même s'il n'évolue pas). Garde-fou anti-boucle : aucune
// chaîne réelle ne dépasse 3 stades.
function getFinalEvolutionId(dexId) {
  let id = dexId;
  for (let guard = 0; guard < 10 && EVOLUTION_CHILDREN[id]; guard++) id = EVOLUTION_CHILDREN[id][0];
  return id;
}

// id -> { id, name, basePoints } de la forme finale, pour chaque Pokémon réellement évoluable.
// Nom/points de la forme finale = ceux de son entrée dans POKEMON_POOLS (basePoints calculés
// depuis ses propres Base Stats). Même forme et même
// format qu'avant : tous les appelants (EVOLUTION_MAP[mon.id]) restent inchangés.
function buildEvolutionMap() {
  const byId = {};
  Object.values(POKEMON_POOLS).flat().forEach(p => { byId[p.id] = p; });
  const map = {};
  for (const dexId of Object.keys(EVOLUTION_CHILDREN)) {
    const final = byId[getFinalEvolutionId(Number(dexId))];
    if (byId[dexId] && final) map[dexId] = { id: final.id, name: final.name, basePoints: final.basePoints };
  }
  return map;
}
const EVOLUTION_MAP = buildEvolutionMap();

// Liste à plat de tous les dex id uniques du pool (tous paliers confondus), calculée une
// seule fois au démarrage. Sert uniquement au préchargement client des sprites (cf.
// app.get('/api/sprite-ids') plus bas + client.js) : le but est que le navigateur ait
// déjà les images en cache AVANT qu'un tour ne les demande réellement, pour supprimer le
// petit flash/délai de chargement visible autrement à chaque nouveau Pokémon tiré.
// Dex national complet (1..1025) : id + nom pour TOUT Pokémon existant, pas
// seulement ceux tirables en partie. Sert uniquement au Pokédex profil (route
// /api/pokedex/national plus bas).
const NATIONAL_DEX = [{id:1,name:"Bulbizarre"},{id:2,name:"Herbizarre"},{id:3,name:"Florizarre"},{id:4,name:"Salamèche"},{id:5,name:"Reptincel"},{id:6,name:"Dracaufeu"},{id:7,name:"Carapuce"},{id:8,name:"Carabaffe"},{id:9,name:"Tortank"},{id:10,name:"Chenipan"},{id:11,name:"Chrysacier"},{id:12,name:"Papilusion"},{id:13,name:"Aspicot"},{id:14,name:"Coconfort"},{id:15,name:"Dardargnan"},{id:16,name:"Roucool"},{id:17,name:"Roucoups"},{id:18,name:"Roucarnage"},{id:19,name:"Rattata"},{id:20,name:"Rattatac"},{id:21,name:"Piafabec"},{id:22,name:"Rapasdepic"},{id:23,name:"Abo"},{id:24,name:"Arbok"},{id:25,name:"Pikachu"},{id:26,name:"Raichu"},{id:27,name:"Sabelette"},{id:28,name:"Sablaireau"},{id:29,name:"Nidoran♀"},{id:30,name:"Nidorina"},{id:31,name:"Nidoqueen"},{id:32,name:"Nidoran♂"},{id:33,name:"Nidorino"},{id:34,name:"Nidoking"},{id:35,name:"Mélofée"},{id:36,name:"Mélodelfe"},{id:37,name:"Goupix"},{id:38,name:"Feunard"},{id:39,name:"Rondoudou"},{id:40,name:"Grodoudou"},{id:41,name:"Nosferapti"},{id:42,name:"Nosferalto"},{id:43,name:"Mystherbe"},{id:44,name:"Ortide"},{id:45,name:"Rafflesia"},{id:46,name:"Paras"},{id:47,name:"Parasect"},{id:48,name:"Mimitoss"},{id:49,name:"Aéromite"},{id:50,name:"Taupiqueur"},{id:51,name:"Triopikeur"},{id:52,name:"Miaouss"},{id:53,name:"Persian"},{id:54,name:"Psykokwak"},{id:55,name:"Akwakwak"},{id:56,name:"Férosinge"},{id:57,name:"Colossinge"},{id:58,name:"Caninos"},{id:59,name:"Arcanin"},{id:60,name:"Ptitard"},{id:61,name:"Têtarte"},{id:62,name:"Tartard"},{id:63,name:"Abra"},{id:64,name:"Kadabra"},{id:65,name:"Alakazam"},{id:66,name:"Machoc"},{id:67,name:"Machopeur"},{id:68,name:"Mackogneur"},{id:69,name:"Chétiflor"},{id:70,name:"Boustiflor"},{id:71,name:"Empiflor"},{id:72,name:"Tentacool"},{id:73,name:"Tentacruel"},{id:74,name:"Racaillou"},{id:75,name:"Gravalanch"},{id:76,name:"Grolem"},{id:77,name:"Ponyta"},{id:78,name:"Galopa"},{id:79,name:"Ramoloss"},{id:80,name:"Flagadoss"},{id:81,name:"Magnéti"},{id:82,name:"Magnéton"},{id:83,name:"Canarticho"},{id:84,name:"Doduo"},{id:85,name:"Dodrio"},{id:86,name:"Otaria"},{id:87,name:"Lamantine"},{id:88,name:"Tadmorv"},{id:89,name:"Grotadmorv"},{id:90,name:"Kokiyas"},{id:91,name:"Crustabri"},{id:92,name:"Fantominus"},{id:93,name:"Spectrum"},{id:94,name:"Ectoplasma"},{id:95,name:"Onix"},{id:96,name:"Soporifik"},{id:97,name:"Hypnomade"},{id:98,name:"Krabby"},{id:99,name:"Krabboss"},{id:100,name:"Voltorbe"},{id:101,name:"Électrode"},{id:102,name:"Noeunoeuf"},{id:103,name:"Noadkoko"},{id:104,name:"Osselait"},{id:105,name:"Ossatueur"},{id:106,name:"Kicklee"},{id:107,name:"Tygnon"},{id:108,name:"Excelangue"},{id:109,name:"Smogo"},{id:110,name:"Smogogo"},{id:111,name:"Rhinocorne"},{id:112,name:"Rhinoféros"},{id:113,name:"Leveinard"},{id:114,name:"Saquedeneu"},{id:115,name:"Kangourex"},{id:116,name:"Hypotrempe"},{id:117,name:"Hypocéan"},{id:118,name:"Poissirène"},{id:119,name:"Poissoroy"},{id:120,name:"Stari"},{id:121,name:"Staross"},{id:122,name:"M. Mime"},{id:123,name:"Insécateur"},{id:124,name:"Lippoutou"},{id:125,name:"Élektek"},{id:126,name:"Magmar"},{id:127,name:"Scarabrute"},{id:128,name:"Tauros"},{id:129,name:"Magicarpe"},{id:130,name:"Léviator"},{id:131,name:"Lokhlass"},{id:132,name:"Métamorph"},{id:133,name:"Évoli"},{id:134,name:"Aquali"},{id:135,name:"Voltali"},{id:136,name:"Pyroli"},{id:137,name:"Porygon"},{id:138,name:"Amonita"},{id:139,name:"Amonistar"},{id:140,name:"Kabuto"},{id:141,name:"Kabutops"},{id:142,name:"Ptéra"},{id:143,name:"Ronflex"},{id:144,name:"Artikodin"},{id:145,name:"Électhor"},{id:146,name:"Sulfura"},{id:147,name:"Minidraco"},{id:148,name:"Draco"},{id:149,name:"Dracolosse"},{id:150,name:"Mewtwo"},{id:151,name:"Mew"},{id:152,name:"Germignon"},{id:153,name:"Macronium"},{id:154,name:"Méganium"},{id:155,name:"Héricendre"},{id:156,name:"Feurisson"},{id:157,name:"Typhlosion"},{id:158,name:"Kaiminus"},{id:159,name:"Crocrodil"},{id:160,name:"Aligatueur"},{id:161,name:"Fouinette"},{id:162,name:"Fouinar"},{id:163,name:"Hoothoot"},{id:164,name:"Noarfang"},{id:165,name:"Coxy"},{id:166,name:"Coxyclaque"},{id:167,name:"Mimigal"},{id:168,name:"Migalos"},{id:169,name:"Nostenfer"},{id:170,name:"Loupio"},{id:171,name:"Lanturn"},{id:172,name:"Pichu"},{id:173,name:"Mélo"},{id:174,name:"Toudoudou"},{id:175,name:"Togepi"},{id:176,name:"Togetic"},{id:177,name:"Natu"},{id:178,name:"Xatu"},{id:179,name:"Wattouat"},{id:180,name:"Lainergie"},{id:181,name:"Pharamp"},{id:182,name:"Joliflor"},{id:183,name:"Marill"},{id:184,name:"Azumarill"},{id:185,name:"Simularbre"},{id:186,name:"Tarpaud"},{id:187,name:"Granivol"},{id:188,name:"Floravol"},{id:189,name:"Cotovol"},{id:190,name:"Capumain"},{id:191,name:"Tournegrin"},{id:192,name:"Héliatronc"},{id:193,name:"Yanma"},{id:194,name:"Axoloto"},{id:195,name:"Maraiste"},{id:196,name:"Mentali"},{id:197,name:"Noctali"},{id:198,name:"Cornèbre"},{id:199,name:"Roigada"},{id:200,name:"Feuforêve"},{id:201,name:"Zarbi"},{id:202,name:"Qulbutoké"},{id:203,name:"Girafarig"},{id:204,name:"Pomdepik"},{id:205,name:"Foretress"},{id:206,name:"Insolourdo"},{id:207,name:"Scorplane"},{id:208,name:"Steelix"},{id:209,name:"Snubbull"},{id:210,name:"Granbull"},{id:211,name:"Qwilfish"},{id:212,name:"Cizayox"},{id:213,name:"Caratroc"},{id:214,name:"Scarhino"},{id:215,name:"Farfuret"},{id:216,name:"Teddiursa"},{id:217,name:"Ursaring"},{id:218,name:"Limagma"},{id:219,name:"Volcaropod"},{id:220,name:"Marcacrin"},{id:221,name:"Cochignon"},{id:222,name:"Corayon"},{id:223,name:"Rémoraid"},{id:224,name:"Octillery"},{id:225,name:"Cadoizo"},{id:226,name:"Démanta"},{id:227,name:"Airmure"},{id:228,name:"Malosse"},{id:229,name:"Démolosse"},{id:230,name:"Hyporoi"},{id:231,name:"Phanpy"},{id:232,name:"Donphan"},{id:233,name:"Porygon2"},{id:234,name:"Cerfrousse"},{id:235,name:"Queulorior"},{id:236,name:"Debugant"},{id:237,name:"Kapoera"},{id:238,name:"Lippouti"},{id:239,name:"Élekid"},{id:240,name:"Magby"},{id:241,name:"Écrémeuh"},{id:242,name:"Leuphorie"},{id:243,name:"Raikou"},{id:244,name:"Entei"},{id:245,name:"Suicune"},{id:246,name:"Embrylex"},{id:247,name:"Ymphect"},{id:248,name:"Tyranocif"},{id:249,name:"Lugia"},{id:250,name:"Ho-Oh"},{id:251,name:"Celebi"},{id:252,name:"Arcko"},{id:253,name:"Massko"},{id:254,name:"Jungko"},{id:255,name:"Poussifeu"},{id:256,name:"Galifeu"},{id:257,name:"Braségali"},{id:258,name:"Gobou"},{id:259,name:"Flobio"},{id:260,name:"Laggron"},{id:261,name:"Medhyèna"},{id:262,name:"Grahyèna"},{id:263,name:"Zigzaton"},{id:264,name:"Linéon"},{id:265,name:"Chenipotte"},{id:266,name:"Armulys"},{id:267,name:"Charmillon"},{id:268,name:"Blindalys"},{id:269,name:"Papinox"},{id:270,name:"Nénupiot"},{id:271,name:"Lombre"},{id:272,name:"Ludicolo"},{id:273,name:"Grainipiot"},{id:274,name:"Pifeuil"},{id:275,name:"Tengalice"},{id:276,name:"Nirondelle"},{id:277,name:"Hélédelle"},{id:278,name:"Goélise"},{id:279,name:"Bekipan"},{id:280,name:"Tarsal"},{id:281,name:"Kirlia"},{id:282,name:"Gardevoir"},{id:283,name:"Arakdo"},{id:284,name:"Maskadra"},{id:285,name:"Balignon"},{id:286,name:"Chapignon"},{id:287,name:"Parecool"},{id:288,name:"Vigoroth"},{id:289,name:"Monaflèmit"},{id:290,name:"Ningale"},{id:291,name:"Ninjask"},{id:292,name:"Munja"},{id:293,name:"Chuchmur"},{id:294,name:"Ramboum"},{id:295,name:"Brouhabam"},{id:296,name:"Makuhita"},{id:297,name:"Hariyama"},{id:298,name:"Azurill"},{id:299,name:"Tarinor"},{id:300,name:"Skitty"},{id:301,name:"Delcatty"},{id:302,name:"Ténéfix"},{id:303,name:"Mysdibule"},{id:304,name:"Galekid"},{id:305,name:"Galegon"},{id:306,name:"Galeking"},{id:307,name:"Méditikka"},{id:308,name:"Charmina"},{id:309,name:"Dynavolt"},{id:310,name:"Élecsprint"},{id:311,name:"Posipi"},{id:312,name:"Négapi"},{id:313,name:"Muciole"},{id:314,name:"Lumivole"},{id:315,name:"Rosélia"},{id:316,name:"Gloupti"},{id:317,name:"Avaltout"},{id:318,name:"Carvanha"},{id:319,name:"Sharpedo"},{id:320,name:"Wailmer"},{id:321,name:"Wailord"},{id:322,name:"Chamallot"},{id:323,name:"Camérupt"},{id:324,name:"Chartor"},{id:325,name:"Spoink"},{id:326,name:"Groret"},{id:327,name:"Spinda"},{id:328,name:"Kraknoix"},{id:329,name:"Vibraninf"},{id:330,name:"Libégon"},{id:331,name:"Cacnea"},{id:332,name:"Cacturne"},{id:333,name:"Tylton"},{id:334,name:"Altaria"},{id:335,name:"Mangriff"},{id:336,name:"Séviper"},{id:337,name:"Séléroc"},{id:338,name:"Solaroc"},{id:339,name:"Barloche"},{id:340,name:"Barbicha"},{id:341,name:"Écrapince"},{id:342,name:"Colhomard"},{id:343,name:"Balbuto"},{id:344,name:"Kaorine"},{id:345,name:"Lilia"},{id:346,name:"Vacilys"},{id:347,name:"Anorith"},{id:348,name:"Armaldo"},{id:349,name:"Barpau"},{id:350,name:"Milobellus"},{id:351,name:"Morphéo"},{id:352,name:"Kecleon"},{id:353,name:"Polichombr"},{id:354,name:"Branette"},{id:355,name:"Skelénox"},{id:356,name:"Téraclope"},{id:357,name:"Tropius"},{id:358,name:"Éoko"},{id:359,name:"Absol"},{id:360,name:"Okéoké"},{id:361,name:"Stalgamin"},{id:362,name:"Oniglali"},{id:363,name:"Obalie"},{id:364,name:"Phogleur"},{id:365,name:"Kaimorse"},{id:366,name:"Coquiperl"},{id:367,name:"Serpang"},{id:368,name:"Rosabyss"},{id:369,name:"Relicanth"},{id:370,name:"Lovdisc"},{id:371,name:"Draby"},{id:372,name:"Drackhaus"},{id:373,name:"Drattak"},{id:374,name:"Terhal"},{id:375,name:"Métang"},{id:376,name:"Métalosse"},{id:377,name:"Regirock"},{id:378,name:"Regice"},{id:379,name:"Registeel"},{id:380,name:"Latias"},{id:381,name:"Latios"},{id:382,name:"Kyogre"},{id:383,name:"Groudon"},{id:384,name:"Rayquaza"},{id:385,name:"Jirachi"},{id:386,name:"Deoxys"},{id:387,name:"Tortipouss"},{id:388,name:"Boskara"},{id:389,name:"Torterra"},{id:390,name:"Ouisticram"},{id:391,name:"Chimpenfeu"},{id:392,name:"Simiabraz"},{id:393,name:"Tiplouf"},{id:394,name:"Prinplouf"},{id:395,name:"Pingoléon"},{id:396,name:"Étourmi"},{id:397,name:"Étourvol"},{id:398,name:"Étouraptor"},{id:399,name:"Keunotor"},{id:400,name:"Castorno"},{id:401,name:"Crikzik"},{id:402,name:"Mélokrik"},{id:403,name:"Lixy"},{id:404,name:"Luxio"},{id:405,name:"Luxray"},{id:406,name:"Rozbouton"},{id:407,name:"Roserade"},{id:408,name:"Kranidos"},{id:409,name:"Charkos"},{id:410,name:"Dinoclier"},{id:411,name:"Bastiodon"},{id:412,name:"Cheniti"},{id:413,name:"Cheniselle"},{id:414,name:"Papilord"},{id:415,name:"Apitrini"},{id:416,name:"Apireine"},{id:417,name:"Pachirisu"},{id:418,name:"Mustébouée"},{id:419,name:"Mustéflott"},{id:420,name:"Ceribou"},{id:421,name:"Ceriflor"},{id:422,name:"Sancoki"},{id:423,name:"Tritosor"},{id:424,name:"Capidextre"},{id:425,name:"Baudrive"},{id:426,name:"Grodrive"},{id:427,name:"Laporeille"},{id:428,name:"Lockpin"},{id:429,name:"Magirêve"},{id:430,name:"Corboss"},{id:431,name:"Chaglam"},{id:432,name:"Chaffreux"},{id:433,name:"Korillon"},{id:434,name:"Moufouette"},{id:435,name:"Moufflair"},{id:436,name:"Archéomire"},{id:437,name:"Archéodong"},{id:438,name:"Manzaï"},{id:439,name:"Mime Jr."},{id:440,name:"Ptiravi"},{id:441,name:"Pijako"},{id:442,name:"Spiritomb"},{id:443,name:"Griknot"},{id:444,name:"Carmache"},{id:445,name:"Carchacrok"},{id:446,name:"Goinfrex"},{id:447,name:"Riolu"},{id:448,name:"Lucario"},{id:449,name:"Hippopotas"},{id:450,name:"Hippodocus"},{id:451,name:"Rapion"},{id:452,name:"Drascore"},{id:453,name:"Cradopaud"},{id:454,name:"Coatox"},{id:455,name:"Vortente"},{id:456,name:"Écayon"},{id:457,name:"Luminéon"},{id:458,name:"Babimanta"},{id:459,name:"Blizzi"},{id:460,name:"Blizzaroi"},{id:461,name:"Dimoret"},{id:462,name:"Magnézone"},{id:463,name:"Coudlangue"},{id:464,name:"Rhinastoc"},{id:465,name:"Bouldeneu"},{id:466,name:"Élekable"},{id:467,name:"Maganon"},{id:468,name:"Togekiss"},{id:469,name:"Yanmega"},{id:470,name:"Phyllali"},{id:471,name:"Givrali"},{id:472,name:"Scorvol"},{id:473,name:"Mammochon"},{id:474,name:"Porygon-Z"},{id:475,name:"Gallame"},{id:476,name:"Tarinorme"},{id:477,name:"Noctunoir"},{id:478,name:"Momartik"},{id:479,name:"Motisma"},{id:480,name:"Créhelf"},{id:481,name:"Créfollet"},{id:482,name:"Créfadet"},{id:483,name:"Dialga"},{id:484,name:"Palkia"},{id:485,name:"Heatran"},{id:486,name:"Regigigas"},{id:487,name:"Giratina"},{id:488,name:"Cresselia"},{id:489,name:"Phione"},{id:490,name:"Manaphy"},{id:491,name:"Darkrai"},{id:492,name:"Shaymin"},{id:493,name:"Arceus"},{id:494,name:"Victini"},{id:495,name:"Vipélierre"},{id:496,name:"Lianaja"},{id:497,name:"Majaspic"},{id:498,name:"Gruikui"},{id:499,name:"Grotichon"},{id:500,name:"Roitiflam"},{id:501,name:"Moustillon"},{id:502,name:"Mateloutre"},{id:503,name:"Clamiral"},{id:504,name:"Ratentif"},{id:505,name:"Miradar"},{id:506,name:"Ponchiot"},{id:507,name:"Ponchien"},{id:508,name:"Mastouffe"},{id:509,name:"Chacripan"},{id:510,name:"Léopardus"},{id:511,name:"Feuillajou"},{id:512,name:"Feuiloutan"},{id:513,name:"Flamajou"},{id:514,name:"Flamoutan"},{id:515,name:"Flotajou"},{id:516,name:"Flotoutan"},{id:517,name:"Munna"},{id:518,name:"Mushana"},{id:519,name:"Poichigeon"},{id:520,name:"Colombeau"},{id:521,name:"Déflaisan"},{id:522,name:"Zébibron"},{id:523,name:"Zéblitz"},{id:524,name:"Nodulithe"},{id:525,name:"Géolithe"},{id:526,name:"Gigalithe"},{id:527,name:"Chovsourir"},{id:528,name:"Rhinolove"},{id:529,name:"Rototaupe"},{id:530,name:"Minotaupe"},{id:531,name:"Nanméouïe"},{id:532,name:"Charpenti"},{id:533,name:"Ouvrifier"},{id:534,name:"Bétochef"},{id:535,name:"Tritonde"},{id:536,name:"Batracné"},{id:537,name:"Crapustule"},{id:538,name:"Judokrak"},{id:539,name:"Karaclée"},{id:540,name:"Larveyette"},{id:541,name:"Couverdure"},{id:542,name:"Manternel"},{id:543,name:"Venipatte"},{id:544,name:"Scobolide"},{id:545,name:"Brutapode"},{id:546,name:"Doudouvet"},{id:547,name:"Farfaduvet"},{id:548,name:"Chlorobule"},{id:549,name:"Fragilady"},{id:550,name:"Bargantua"},{id:551,name:"Mascaïman"},{id:552,name:"Escroco"},{id:553,name:"Crocorible"},{id:554,name:"Darumarond"},{id:555,name:"Darumacho"},{id:556,name:"Maracachi"},{id:557,name:"Crabicoque"},{id:558,name:"Crabaraque"},{id:559,name:"Baggiguane"},{id:560,name:"Baggaïd"},{id:561,name:"Cryptéro"},{id:562,name:"Tutafeh"},{id:563,name:"Tutankafer"},{id:564,name:"Carapagos"},{id:565,name:"Mégapagos"},{id:566,name:"Arkéapti"},{id:567,name:"Aéroptéryx"},{id:568,name:"Miamiasme"},{id:569,name:"Miasmax"},{id:570,name:"Zorua"},{id:571,name:"Zoroark"},{id:572,name:"Chinchidou"},{id:573,name:"Pashmilla"},{id:574,name:"Scrutella"},{id:575,name:"Mesmérella"},{id:576,name:"Sidérella"},{id:577,name:"Nucléos"},{id:578,name:"Méios"},{id:579,name:"Symbios"},{id:580,name:"Couaneton"},{id:581,name:"Lakmécygne"},{id:582,name:"Sorbébé"},{id:583,name:"Sorboul"},{id:584,name:"Sorbouboul"},{id:585,name:"Vivaldaim"},{id:586,name:"Haydaim"},{id:587,name:"Emolga"},{id:588,name:"Carabing"},{id:589,name:"Lançargot"},{id:590,name:"Trompignon"},{id:591,name:"Gaulet"},{id:592,name:"Viskuse"},{id:593,name:"Moyade"},{id:594,name:"Mamanbo"},{id:595,name:"Statitik"},{id:596,name:"Mygavolt"},{id:597,name:"Grindur"},{id:598,name:"Noacier"},{id:599,name:"Tic"},{id:600,name:"Clic"},{id:601,name:"Cliticlic"},{id:602,name:"Anchwatt"},{id:603,name:"Lampéroie"},{id:604,name:"Ohmassacre"},{id:605,name:"Lewsor"},{id:606,name:"Neitram"},{id:607,name:"Funécire"},{id:608,name:"Mélancolux"},{id:609,name:"Lugulabre"},{id:610,name:"Coupenotte"},{id:611,name:"Incisache"},{id:612,name:"Tranchodon"},{id:613,name:"Polarhume"},{id:614,name:"Polagriffe"},{id:615,name:"Hexagel"},{id:616,name:"Escargaume"},{id:617,name:"Limaspeed"},{id:618,name:"Limonde"},{id:619,name:"Kungfouine"},{id:620,name:"Shaofouine"},{id:621,name:"Drakkarmin"},{id:622,name:"Gringolem"},{id:623,name:"Golemastoc"},{id:624,name:"Scalpion"},{id:625,name:"Scalproie"},{id:626,name:"Frison"},{id:627,name:"Furaiglon"},{id:628,name:"Guerlaigle"},{id:629,name:"Vostourno"},{id:630,name:"Vaututrice"},{id:631,name:"Aflamanoir"},{id:632,name:"Fermite"},{id:633,name:"Solochi"},{id:634,name:"Diamat"},{id:635,name:"Trioxhydre"},{id:636,name:"Pyronille"},{id:637,name:"Volcarona"},{id:638,name:"Cobaltium"},{id:639,name:"Terrakium"},{id:640,name:"Viridium"},{id:641,name:"Boréas"},{id:642,name:"Fulguris"},{id:643,name:"Reshiram"},{id:644,name:"Zekrom"},{id:645,name:"Démétéros"},{id:646,name:"Kyurem"},{id:647,name:"Keldeo"},{id:648,name:"Meloetta"},{id:649,name:"Genesect"},{id:650,name:"Marisson"},{id:651,name:"Boguérisse"},{id:652,name:"Blindépique"},{id:653,name:"Feunnec"},{id:654,name:"Roussil"},{id:655,name:"Goupelin"},{id:656,name:"Grenousse"},{id:657,name:"Croâporal"},{id:658,name:"Amphinobi"},{id:659,name:"Sapereau"},{id:660,name:"Excavarenne"},{id:661,name:"Passerouge"},{id:662,name:"Braisillon"},{id:663,name:"Flambusard"},{id:664,name:"Lépidonille"},{id:665,name:"Pérégrain"},{id:666,name:"Prismillon"},{id:667,name:"Hélionceau"},{id:668,name:"Néméleos"},{id:669,name:"Flabébé"},{id:670,name:"Floette"},{id:671,name:"Florges"},{id:672,name:"Cabriolaine"},{id:673,name:"Chevroum"},{id:674,name:"Pandespiègle"},{id:675,name:"Pandarbare"},{id:676,name:"Couafarel"},{id:677,name:"Psystigri"},{id:678,name:"Mistigrix"},{id:679,name:"Monorpale"},{id:680,name:"Dimoclès"},{id:681,name:"Exagide"},{id:682,name:"Fluvetin"},{id:683,name:"Cocotine"},{id:684,name:"Sucroquin"},{id:685,name:"Cupcanaille"},{id:686,name:"Sepiatop"},{id:687,name:"Sepiatroce"},{id:688,name:"Opermine"},{id:689,name:"Golgopathe"},{id:690,name:"Venalgue"},{id:691,name:"Kravarech"},{id:692,name:"Flingouste"},{id:693,name:"Gamblast"},{id:694,name:"Galvaran"},{id:695,name:"Iguolta"},{id:696,name:"Ptyranidur"},{id:697,name:"Rexillius"},{id:698,name:"Amagara"},{id:699,name:"Dragmara"},{id:700,name:"Nymphali"},{id:701,name:"Brutalibré"},{id:702,name:"Dedenne"},{id:703,name:"Strassie"},{id:704,name:"Mucuscule"},{id:705,name:"Colimucus"},{id:706,name:"Muplodocus"},{id:707,name:"Trousselin"},{id:708,name:"Brocélôme"},{id:709,name:"Desséliande"},{id:710,name:"Pitrouille"},{id:711,name:"Banshitrouye"},{id:712,name:"Grelaçon"},{id:713,name:"Séracrawl"},{id:714,name:"Sonistrelle"},{id:715,name:"Bruyverne"},{id:716,name:"Xerneas"},{id:717,name:"Yveltal"},{id:718,name:"Zygarde"},{id:719,name:"Diancie"},{id:720,name:"Hoopa"},{id:721,name:"Volcanion"},{id:722,name:"Brindibou"},{id:723,name:"Efflèche"},{id:724,name:"Archéduc"},{id:725,name:"Flamiaou"},{id:726,name:"Matoufeu"},{id:727,name:"Félinferno"},{id:728,name:"Otaquin"},{id:729,name:"Otarlette"},{id:730,name:"Oratoria"},{id:731,name:"Picassaut"},{id:732,name:"Piclairon"},{id:733,name:"Bazoucan"},{id:734,name:"Manglouton"},{id:735,name:"Argouste"},{id:736,name:"Larvibule"},{id:737,name:"Chrysapile"},{id:738,name:"Lucanon"},{id:739,name:"Crabagarre"},{id:740,name:"Crabominable"},{id:741,name:"Plumeline"},{id:742,name:"Bombydou"},{id:743,name:"Rubombelle"},{id:744,name:"Rocabot"},{id:745,name:"Lougaroc"},{id:746,name:"Froussardine"},{id:747,name:"Vorastérie"},{id:748,name:"Prédastérie"},{id:749,name:"Tiboudet"},{id:750,name:"Bourrinos"},{id:751,name:"Araqua"},{id:752,name:"Tarenbulle"},{id:753,name:"Mimantis"},{id:754,name:"Floramantis"},{id:755,name:"Spododo"},{id:756,name:"Lampignon"},{id:757,name:"Tritox"},{id:758,name:"Malamandre"},{id:759,name:"Nounourson"},{id:760,name:"Chelours"},{id:761,name:"Croquine"},{id:762,name:"Candine"},{id:763,name:"Sucreine"},{id:764,name:"Guérilande"},{id:765,name:"Gouroutan"},{id:766,name:"Quartermac"},{id:767,name:"Sovkipou"},{id:768,name:"Sarmuraï"},{id:769,name:"Bacabouh"},{id:770,name:"Trépassable"},{id:771,name:"Concombaffe"},{id:772,name:"Type:0"},{id:773,name:"Silvallié"},{id:774,name:"Météno"},{id:775,name:"Dodoala"},{id:776,name:"Boumata"},{id:777,name:"Togedemaru"},{id:778,name:"Mimiqui"},{id:779,name:"Denticrisse"},{id:780,name:"Draïeul"},{id:781,name:"Sinistrail"},{id:782,name:"Bébécaille"},{id:783,name:"Écaïd"},{id:784,name:"Ékaïser"},{id:785,name:"Tokorico"},{id:786,name:"Tokopiyon"},{id:787,name:"Tokotoro"},{id:788,name:"Tokopisco"},{id:789,name:"Cosmog"},{id:790,name:"Cosmovum"},{id:791,name:"Solgaleo"},{id:792,name:"Lunala"},{id:793,name:"Zéroïd"},{id:794,name:"Mouscoto"},{id:795,name:"Cancrelove"},{id:796,name:"Câblifère"},{id:797,name:"Bamboiselle"},{id:798,name:"Katagami"},{id:799,name:"Engloutyran"},{id:800,name:"Necrozma"},{id:801,name:"Magearna"},{id:802,name:"Marshadow"},{id:803,name:"Véminigon"},{id:804,name:"Mandrillon"},{id:805,name:"Ama-Ama"},{id:806,name:"Pierroteknik"},{id:807,name:"Zeraora"},{id:808,name:"Meltan"},{id:809,name:"Melmetal"},{id:810,name:"Ouistempo"},{id:811,name:"Badabouin"},{id:812,name:"Gorythmic"},{id:813,name:"Flambino"},{id:814,name:"Lapyro"},{id:815,name:"Pyrobut"},{id:816,name:"Larméléon"},{id:817,name:"Arrozard"},{id:818,name:"Lézargus"},{id:819,name:"Rongourmand"},{id:820,name:"Rongrigou"},{id:821,name:"Minisange"},{id:822,name:"Bleuseille"},{id:823,name:"Corvaillus"},{id:824,name:"Larvadar"},{id:825,name:"Coléodôme"},{id:826,name:"Astronelle"},{id:827,name:"Goupilou"},{id:828,name:"Roublenard"},{id:829,name:"Tournicoton"},{id:830,name:"Blancoton"},{id:831,name:"Moumouton"},{id:832,name:"Moumouflon"},{id:833,name:"Khélocrok"},{id:834,name:"Torgamord"},{id:835,name:"Voltoutou"},{id:836,name:"Fulgudog"},{id:837,name:"Charbi"},{id:838,name:"Wagomine"},{id:839,name:"Monthracite"},{id:840,name:"Verpom"},{id:841,name:"Pomdrapi"},{id:842,name:"Dratatin"},{id:843,name:"Dunaja"},{id:844,name:"Dunaconda"},{id:845,name:"Nigosier"},{id:846,name:"Embrochet"},{id:847,name:"Hastacuda"},{id:848,name:"Toxizap"},{id:849,name:"Salarsen"},{id:850,name:"Grillepattes"},{id:851,name:"Scolocendre"},{id:852,name:"Poulpaf"},{id:853,name:"Krakos"},{id:854,name:"Théffroi"},{id:855,name:"Polthégeist"},{id:856,name:"Bibichut"},{id:857,name:"Chapotus"},{id:858,name:"Sorcilence"},{id:859,name:"Grimalin"},{id:860,name:"Fourbelin"},{id:861,name:"Angoliath"},{id:862,name:"Ixon"},{id:863,name:"Berserkatt"},{id:864,name:"Corayôme"},{id:865,name:"Palarticho"},{id:866,name:"M. Glaquette"},{id:867,name:"Tutétékri"},{id:868,name:"Crèmy"},{id:869,name:"Charmilly"},{id:870,name:"Hexadron"},{id:871,name:"Wattapik"},{id:872,name:"Frissonille"},{id:873,name:"Beldeneige"},{id:874,name:"Dolman"},{id:875,name:"Bekaglaçon"},{id:876,name:"Wimessir"},{id:877,name:"Morpeko"},{id:878,name:"Charibari"},{id:879,name:"Pachyradjah"},{id:880,name:"Galvagon"},{id:881,name:"Galvagla"},{id:882,name:"Hydragon"},{id:883,name:"Hydragla"},{id:884,name:"Duralugon"},{id:885,name:"Fantyrm"},{id:886,name:"Dispareptil"},{id:887,name:"Lanssorien"},{id:888,name:"Zacian"},{id:889,name:"Zamazenta"},{id:890,name:"Éthernatos"},{id:891,name:"Wushours"},{id:892,name:"Shifours"},{id:893,name:"Zarude"},{id:894,name:"Regieleki"},{id:895,name:"Regidrago"},{id:896,name:"Blizzeval"},{id:897,name:"Spectreval"},{id:898,name:"Sylveroy"},{id:899,name:"Cerbyllin"},{id:900,name:"Hachécateur"},{id:901,name:"Ursaking"},{id:902,name:"Paragruel"},{id:903,name:"Farfurex"},{id:904,name:"Qwilpik"},{id:905,name:"Amovénus"},{id:906,name:"Poussacha"},{id:907,name:"Matourgeon"},{id:908,name:"Miascarade"},{id:909,name:"Chochodile"},{id:910,name:"Crocogril"},{id:911,name:"Flâmigator"},{id:912,name:"Coiffeton"},{id:913,name:"Canarbello"},{id:914,name:"Palmaval"},{id:915,name:"Gourmelet"},{id:916,name:"Fragroin"},{id:917,name:"Tissenboule"},{id:918,name:"Filentrappe"},{id:919,name:"Lilliterelle"},{id:920,name:"Gambex"},{id:921,name:"Pohm"},{id:922,name:"Pohmotte"},{id:923,name:"Pohmarmotte"},{id:924,name:"Compagnol"},{id:925,name:"Famignol"},{id:926,name:"Pâtachiot"},{id:927,name:"Briochien"},{id:928,name:"Olivini"},{id:929,name:"Olivado"},{id:930,name:"Arboliva"},{id:931,name:"Tapatoès"},{id:932,name:"Selutin"},{id:933,name:"Amassel"},{id:934,name:"Giganssel"},{id:935,name:"Charbambin"},{id:936,name:"Carmadura"},{id:937,name:"Malvalame"},{id:938,name:"Têtampoule"},{id:939,name:"Ampibidou"},{id:940,name:"Zapétrel"},{id:941,name:"Fulgulairo"},{id:942,name:"Grondogue"},{id:943,name:"Dogrino"},{id:944,name:"Gribouraigne"},{id:945,name:"Tag-Tag"},{id:946,name:"Viroment"},{id:947,name:"Virevorreur"},{id:948,name:"Terracool"},{id:949,name:"Terracruel"},{id:950,name:"Craparoi"},{id:951,name:"Pimito"},{id:952,name:"Scovilain"},{id:953,name:"Léboulérou"},{id:954,name:"Bérasca"},{id:955,name:"Flotillon"},{id:956,name:"Cléopsytra"},{id:957,name:"Forgerette"},{id:958,name:"Forgella"},{id:959,name:"Forgelina"},{id:960,name:"Taupikeau"},{id:961,name:"Triopikeau"},{id:962,name:"Lestombaile"},{id:963,name:"Dofin"},{id:964,name:"Superdofin"},{id:965,name:"Vrombi"},{id:966,name:"Vrombotor"},{id:967,name:"Motorizard"},{id:968,name:"Ferdeter"},{id:969,name:"Germéclat"},{id:970,name:"Floréclat"},{id:971,name:"Toutombe"},{id:972,name:"Tomberro"},{id:973,name:"Flamenroule"},{id:974,name:"Piétacé"},{id:975,name:"Balbalèze"},{id:976,name:"Délestin"},{id:977,name:"Oyacata"},{id:978,name:"Nigirigon"},{id:979,name:"Courrousinge"},{id:980,name:"Terraiste"},{id:981,name:"Farigiraf"},{id:982,name:"Deusolourdo"},{id:983,name:"Scalpereur"},{id:984,name:"Fort-Ivoire"},{id:985,name:"Hurle-Queue"},{id:986,name:"Fongus-Furie"},{id:987,name:"Flotte-Mèche"},{id:988,name:"Rampe-Ailes"},{id:989,name:"Pelage-Sablé"},{id:990,name:"Roue-de-Fer"},{id:991,name:"Hotte-de-Fer"},{id:992,name:"Paume-de-Fer"},{id:993,name:"Têtes-de-Fer"},{id:994,name:"Mite-de-Fer"},{id:995,name:"Épine-de-Fer"},{id:996,name:"Frigodo"},{id:997,name:"Cryodo"},{id:998,name:"Glaivodo"},{id:999,name:"Mordudor"},{id:1000,name:"Gromago"},{id:1001,name:"Chongjian"},{id:1002,name:"Baojian"},{id:1003,name:"Dinglu"},{id:1004,name:"Yuyu"},{id:1005,name:"Rugit-Lune"},{id:1006,name:"Garde-de-Fer"},{id:1007,name:"Koraidon"},{id:1008,name:"Miraidon"},{id:1009,name:"Serpente-Eau"},{id:1010,name:"Vert-de-Fer"},{id:1011,name:"Pomdramour"},{id:1012,name:"Poltchageist"},{id:1013,name:"Théffroyable"},{id:1014,name:"Félicanis"},{id:1015,name:"Fortusimia"},{id:1016,name:"Favianos"},{id:1017,name:"Ogerpon"},{id:1018,name:"Pondralugon"},{id:1019,name:"Pomdorochi"},{id:1020,name:"Feu-Perçant"},{id:1021,name:"Ire-Foudre"},{id:1022,name:"Roc-de-Fer"},{id:1023,name:"Chef-de-Fer"},{id:1024,name:"Terapagos"},{id:1025,name:"Pêchaminus"}];

const ALL_DEX_IDS = [...new Set(
  Object.values(POKEMON_POOLS).flat().map(mon => mon.id)
)].sort((a, b) => a - b);

// Probabilité de tirage de chaque rareté (somme = 1). Commun très fréquent,
// légendaire extrêmement rare, mais assez généreux pour qu'une partie complète
// (6 tours × 2 options) ait de bonnes chances de croiser au moins un Pokémon fort.
// "méga" n'y figure PAS : elle ne participe au tirage classique qu'en mode admin vs
// joueur (ajoutée dynamiquement, cf. MEGA_ADMIN_WEIGHT/buildWeightedRarityTable) — en
// mode normal/coop, il n'y a AUCUN moyen d'obtenir un méga (l'ancien event Méga Gemme a
// été retiré), jamais ce tirage-ci.
const RARITY_TABLE = [
  { rarity: 'commun', weight: 0.39 },
  { rarity: 'peu_commun', weight: 0.26 },
  { rarity: 'rare', weight: 0.17 },
  { rarity: 'epique', weight: 0.11 },
  // Semi-légendaire : plus fréquent que chaque catégorie du groupe légendaire.
  { rarity: 'pseudo_legendaire', weight: 0.04 },
  // Légendaire / Fabuleux / Ultra-Chimère : MÊME taux chacune (0.01), quelle que soit la taille de leur liste.
  ...LEGENDARY_GROUP.map(rarity => ({ rarity, weight: 0.01 }))
];

// Poids de "méga" quand elle rejoint le tirage classique (mode admin vs joueur
// uniquement) : entre semi-légendaire (0.04) et chaque catégorie légendaire (0.01) —
// plus dur à obtenir qu'un semi-légendaire, plus facile qu'un légendaire.
const MEGA_ADMIN_WEIGHT = 0.025;

// Le bonus ×1.5 des Méga-Évolutions n'existe plus ici : c'est le multiplicateur de la catégorie
// 'mega' (stats-config.js), déjà inclus dans basePoints. Ne JAMAIS le réappliquer ailleurs.

// Charme Chroma : les raretés "puissantes" voient leur poids multiplié par ×2.5,
// le reste est renormalisé proportionnellement pour que la somme reste 1 (pas de
// probabilité invalide, pas de garantie absolue non plus).
const SHINY_CHARM_MULTIPLIER = 2.5;
const SHINY_CHARM_BOOSTED_RARITIES = ['epique', 'pseudo_legendaire', 'mega', ...LEGENDARY_GROUP];

// -----------------------------------------------------------------
// Anti-RNG / pity, par joueur. N'accorde JAMAIS de légendaire garanti : réduit
// seulement les séries de malchance extrêmes. "Bonne rareté" = rare et au-dessus
// (même palier que le boost ci-dessous) ; "mauvaise" = commun/peu_commun.
// Progressif comme demandé (0 -> normal, 1 très léger, 2 léger, 3-4 supplémentaire,
// 5+ plus important), plafonné à 5 pour éviter un boost qui grandit indéfiniment.
// -----------------------------------------------------------------
const PITY_BOOSTED_RARITIES = ['rare', 'epique', 'pseudo_legendaire', 'mega', ...LEGENDARY_GROUP];
const PITY_GOOD_RARITIES = PITY_BOOSTED_RARITIES;
const PITY_MULTIPLIER_BY_LEVEL = [1.0, 1.15, 1.35, 1.6, 1.9, 2.3]; // index = pity (0..5, plafonné)

function getPityMultiplier(pity) {
  const level = Math.max(0, Math.min(pity || 0, PITY_MULTIPLIER_BY_LEVEL.length - 1));
  return PITY_MULTIPLIER_BY_LEVEL[level];
}

// Ordre croissant des raretés, utilisé pour appliquer un "plancher" (LUCKY_TURN, TIME_RIFT) :
// tout ce qui est strictement en dessous du plancher voit son poids ramené à 0, puis la
// table est renormalisée — même principe que le boost pity/Charme Chroma, jamais une
// probabilité négative ni une garantie de légendaire (le plancher n'élimine QUE le bas
// de la table, il ne force jamais une seule rareté à 100%). "méga" est placée entre
// pseudo-légendaire et légendaire, à sa place dans la hiérarchie.
const RARITY_ORDER = ['commun', 'peu_commun', 'rare', 'epique', 'pseudo_legendaire', 'mega', ...LEGENDARY_GROUP];

// Applique un ou plusieurs boosts multiplicatifs à une table de poids, PUIS
// normalise une seule fois à la fin (jamais de "probabilité × pity × 2.5" brut,
// qui produirait des probabilités absurdes en cas de cumul).
// extraBoost est optionnel (CROSSED_FATES) : un petit bonus supplémentaire sur les mêmes
// raretés que le pity, cumulable avec pity/Charme mais toujours renormalisé une seule fois.
// gameMode détermine si "méga" participe DU TOUT à ce tirage (admin vs joueur uniquement,
// cf. RARITY_TABLE ci-dessus) — absent/'normal' : jamais incluse ici.
function buildWeightedRarityTable({ useCharm, pity, floorRarity, extraBoost, gameMode, megaWeight }) {
  const pityMultiplier = getPityMultiplier(pity);
  const boost = extraBoost || 1;
  // megaWeight : modificateur de partie "Méga-déferlante" (cf. GAME_MODIFIERS), 0/absent = aucun.
  const baseTable = gameMode === 'admin'
    ? [...RARITY_TABLE, { rarity: 'mega', weight: MEGA_ADMIN_WEIGHT }]
    : (megaWeight > 0 ? [...RARITY_TABLE, { rarity: 'mega', weight: megaWeight }] : RARITY_TABLE);
  let weighted = baseTable.map(entry => {
    let weight = entry.weight;
    if (useCharm && SHINY_CHARM_BOOSTED_RARITIES.includes(entry.rarity)) weight *= SHINY_CHARM_MULTIPLIER;
    if (PITY_BOOSTED_RARITIES.includes(entry.rarity)) weight *= pityMultiplier * boost;
    return { rarity: entry.rarity, weight };
  });

  if (floorRarity) {
    const floorIndex = RARITY_ORDER.indexOf(floorRarity);
    if (floorIndex > 0) {
      weighted = weighted.map(e => (RARITY_ORDER.indexOf(e.rarity) < floorIndex ? { rarity: e.rarity, weight: 0 } : e));
    }
  }

  const total = weighted.reduce((sum, e) => sum + e.weight, 0);
  return weighted.map(e => ({ rarity: e.rarity, weight: total > 0 ? e.weight / total : 0 }));
}

function pickRarity(useCharm, pity, floorRarity, extraBoost, gameMode, megaWeight) {
  const table = buildWeightedRarityTable({ useCharm, pity, floorRarity, extraBoost, gameMode, megaWeight });
  const roll = Math.random();
  let cumulative = 0;
  for (const entry of table) {
    cumulative += entry.weight;
    if (roll < cumulative) return entry.rarity;
  }
  return table[table.length - 1].rarity; // filet de sécurité (arrondis flottants)
}

// Bonus / malus secrets appliqués au tirage d'un Pokémon.
// Chaque trait porte soit un multiplicateur (`multiplier`), soit des points FIXES (`flat`, ajoutés
// APRÈS le calcul : jamais multipliés par shiny/Méga/etc., multiplier = 1.0). `gamble: true` =
// LET'S GO GAMBLING : le multiplicateur final est tiré au moment de l'attribution (cf.
// resolveEffect), `multiplier` ici n'est qu'une valeur par défaut neutre.
//
// RARETÉ : plus un trait s'éloigne de la neutralité (très bon OU très mauvais), plus il est rare.
// Seule `power` (force équivalente en multiplicateur) est saisie ; les poids sont CALCULÉS
// ci-dessous : poids ∝ 1 / |power - 1|, ~75% Neutre et ~25% répartis sur les vrais traits.
// Pour un trait à points fixes, power = 1 + flat / FLAT_REFERENCE_POINTS (Pokémon « moyen »).
const GAMBLE_EFFECT_NAME = "LET'S GO GAMBLING";
const GAMBLE_MULTIPLIERS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]; // ×0.5 -> ×2, roulette côté client
const FLAT_REFERENCE_POINTS = 500;
const EFFECT_NEUTRAL_WEIGHT = 75;
const EFFECT_TRAITS_WEIGHT_TOTAL = 25;
const EFFECTS = [
  { name: 'Neutre', multiplier: 1.0, weight: EFFECT_NEUTRAL_WEIGHT },
  { name: 'Motivé', multiplier: 1.1 },
  { name: 'Sous steroïde', multiplier: 1.15 },
  { name: 'Salzmann secret technique', multiplier: 1.2 },
  { name: 'Smurf', multiplier: 1.25 },
  { name: 'Aura +150', multiplier: 1.0, flat: 150 },
  { name: 'Main Character', multiplier: 1.35 },
  { name: 'P2W', multiplier: 1.0, flat: 250 },
  { name: 'Beauty privilege', multiplier: 1.6 },
  { name: GAMBLE_EFFECT_NAME, multiplier: 1.0, gamble: true, power: 1.5 }, // gros écart possible : rare
  { name: 'Aura -100', multiplier: 1.0, flat: -100 },
  { name: 'Lagging', multiplier: 0.8 },
  { name: 'Sub-5', multiplier: 0.75 },
  { name: 'Épine dans le pied', multiplier: 0.7 },
  { name: 'Skill issues', multiplier: 0.6 },
  { name: 'P2L', multiplier: 1.0, flat: -200 }
];

// Calcul des poids (une seule fois au démarrage) : tout est dérivé de `power`.
(function computeEffectWeights() {
  const traits = EFFECTS.filter(e => e.name !== 'Neutre');
  for (const e of traits) {
    if (e.power === undefined) e.power = e.flat ? 1 + e.flat / FLAT_REFERENCE_POINTS : e.multiplier;
  }
  const rawSum = traits.reduce((sum, e) => sum + 1 / Math.abs(e.power - 1), 0);
  for (const e of traits) e.weight = (1 / Math.abs(e.power - 1)) / rawSum * EFFECT_TRAITS_WEIGHT_TOTAL;
})();

// Résout un trait avant attribution : copie avec les champs normalisés (flat toujours défini) ;
// pour LET'S GO GAMBLING, tire le multiplicateur final ici (côté serveur, jamais le client).
function resolveEffect(effect) {
  const resolved = { ...effect, flat: effect.flat || 0 };
  if (effect.gamble) resolved.multiplier = GAMBLE_MULTIPLIERS[Math.floor(Math.random() * GAMBLE_MULTIPLIERS.length)];
  return resolved;
}

const EFFECTS_TOTAL_WEIGHT = EFFECTS.reduce((sum, e) => sum + e.weight, 0);

function pickEffect(noNeutral) {
  // noNeutral : modificateur "Talents chaotiques" — jamais de trait Neutre, tirage uniforme
  // parmi les 8 vrais bonus/malus (le multiplicateur reste porté par effect.multiplier, donc
  // tout le reste du code — contribution, mutations, bonus de type — reste cohérent).
  if (noNeutral) {
    const real = EFFECTS.filter(e => e.name !== 'Neutre');
    return resolveEffect(real[Math.floor(Math.random() * real.length)]);
  }
  let roll = Math.random() * EFFECTS_TOTAL_WEIGHT;
  for (const effect of EFFECTS) {
    if (roll < effect.weight) return resolveEffect(effect);
    roll -= effect.weight;
  }
  return resolveEffect(EFFECTS[0]); // filet de sécurité (arrondis flottants) -> Neutre
}

// Plusieurs boss légendaires possibles, avec un objectif propre à chacun.
// Cibles calées sur des percentiles de la distribution réelle des scores (choix aveugle,
// RNG pure — cf. simulation) plutôt que sur une moyenne : une équipe faible doit pouvoir
// perdre même contre le boss "facile", et même une excellente RNG (légendaire obtenu) ne
// garantit pas la victoire contre les boss les plus durs.
// Après le rééquilibrage des modificateurs (75% Neutre), seul "facile" était devenu trop
// clément (64.7% de victoire en choix aveugle) : buffé de 1450 -> 1650 (~51%). Les autres
// paliers étaient restés cohérents (moyen 44%, difficile 25%, très difficile 11%, extrême 3%)
// et n'ont pas été touchés.
// Regroupe les 5 paliers existants (facile/moyen/difficile/très difficile/extrême)
// en 4 catégories sélectionnables dans le lobby. Aucun boss supprimé ni renommé.
const DIFFICULTY_TO_GROUP = {
  facile: 'easy',
  moyen: 'medium',
  difficile: 'hard',
  extrême: 'extreme'
};

// TOUS les légendaires/mythiques du jeu (catégories légendaire/fabuleux/ultra-chimère, cf. stats-config.js)
// SAUF leurs formes méga (déjà gérées à part par le système de méga-évolution). Classés
// en 4 groupes par quartile de leur valeur de tirage (points), avec une variance interne
// à chaque groupe pour que 2 boss du même groupe ne soient jamais identiques. Seuils
// nettement relevés par rapport à l'ancienne liste (17 boss, 1650-3200 pts) car avec le
// dex complet, le score moyen en fin de partie a bien augmenté — le mode normal était
// devenu trop facile à battre.
// ---- NERF DES BOSS : facteur par difficulté ----
// Avec le nouveau système (points = BST × multiplicateur), le score moyen d'une équipe a monté
// d'environ ×1,4 à ×1,5 (estimation) alors que les objectifs des boss n'ont pas bougé.
// Chaque facteur multiplie les requiredPoints de sa difficulté (mode normal ET coop, qui en dérive).
// 1 = ancien réglage. Extrême à 1.33 => objectif moyen ~5500 pts.
// Variable d'environnement BOSS_POINTS_SCALE (ex. sur Render) : si définie, remplace TOUS les
// facteurs ci-dessous par cette valeur unique.
const BOSS_POINTS_SCALE_BY_DIFFICULTY = {
  facile: 1.5,
  moyen: 1.5,
  difficile: 1.5,
  'extrême': 1.33
};
const BOSS_POINTS_SCALE_OVERRIDE = (() => {
  const v = Number(process.env.BOSS_POINTS_SCALE);
  return Number.isFinite(v) && v > 0 ? v : null;
})();
function getBossPointsScale(difficulty) {
  return BOSS_POINTS_SCALE_OVERRIDE ?? BOSS_POINTS_SCALE_BY_DIFFICULTY[difficulty] ?? 1;
}

const BOSSES = [
  // --- facile (easy) ---
  { id: 144, name: 'Artikodin', requiredPoints: 2020, difficulty: 'facile' },
  { id: 145, name: 'Électhor', requiredPoints: 2020, difficulty: 'facile' },
  { id: 146, name: 'Sulfura', requiredPoints: 2020, difficulty: 'facile' },
  { id: 243, name: 'Raikou', requiredPoints: 2030, difficulty: 'facile' },
  { id: 244, name: 'Entei', requiredPoints: 2040, difficulty: 'facile' },
  { id: 245, name: 'Suicune', requiredPoints: 2040, difficulty: 'facile' },
  { id: 377, name: 'Regirock', requiredPoints: 2170, difficulty: 'facile' },
  { id: 378, name: 'Regice', requiredPoints: 2180, difficulty: 'facile' },
  { id: 379, name: 'Registeel', requiredPoints: 2180, difficulty: 'facile' },
  { id: 480, name: 'Créhelf', requiredPoints: 2200, difficulty: 'facile' },
  { id: 481, name: 'Créfollet', requiredPoints: 2200, difficulty: 'facile' },
  { id: 482, name: 'Créfadet', requiredPoints: 2210, difficulty: 'facile' },
  { id: 485, name: 'Heatran', requiredPoints: 2250, difficulty: 'facile' },
  { id: 488, name: 'Cresselia', requiredPoints: 2250, difficulty: 'facile' },
  { id: 638, name: 'Cobaltium', requiredPoints: 2070, difficulty: 'facile' },
  { id: 639, name: 'Terrakium', requiredPoints: 2070, difficulty: 'facile' },
  { id: 640, name: 'Viridium', requiredPoints: 2080, difficulty: 'facile' },
  { id: 641, name: 'Boréas', requiredPoints: 2220, difficulty: 'facile' },
  { id: 642, name: 'Fulguris', requiredPoints: 2230, difficulty: 'facile' },
  { id: 645, name: 'Démétéros', requiredPoints: 2230, difficulty: 'facile' },
  { id: 785, name: 'Tokorico', requiredPoints: 2240, difficulty: 'facile' },
  { id: 786, name: 'Tokopiyon', requiredPoints: 2240, difficulty: 'facile' },
  { id: 787, name: 'Tokotoro', requiredPoints: 2250, difficulty: 'facile' },
  { id: 788, name: 'Tokopisco', requiredPoints: 2250, difficulty: 'facile' },
  { id: 793, name: 'Zéroïd', requiredPoints: 2280, difficulty: 'facile' },
  { id: 905, name: 'Amovénus', requiredPoints: 2240, difficulty: 'facile' },
  // --- moyen (medium) ---
  { id: 151, name: 'Mew', requiredPoints: 2460, difficulty: 'moyen' },
  { id: 251, name: 'Celebi', requiredPoints: 2480, difficulty: 'moyen' },
  { id: 385, name: 'Jirachi', requiredPoints: 2430, difficulty: 'moyen' },
  { id: 386, name: 'Deoxys', requiredPoints: 2440, difficulty: 'moyen' },
  { id: 491, name: 'Darkrai', requiredPoints: 2440, difficulty: 'moyen' },
  { id: 492, name: 'Shaymin', requiredPoints: 2440, difficulty: 'moyen' },
  { id: 494, name: 'Victini', requiredPoints: 2460, difficulty: 'moyen' },
  { id: 647, name: 'Keldeo', requiredPoints: 2460, difficulty: 'moyen' },
  { id: 794, name: 'Mouscoto', requiredPoints: 2220, difficulty: 'moyen' },
  { id: 795, name: 'Cancrelove', requiredPoints: 2240, difficulty: 'moyen' },
  { id: 796, name: 'Câblifère', requiredPoints: 2260, difficulty: 'moyen' },
  { id: 797, name: 'Bamboiselle', requiredPoints: 2270, difficulty: 'moyen' },
  { id: 798, name: 'Katagami', requiredPoints: 2290, difficulty: 'moyen' },
  { id: 799, name: 'Engloutyran', requiredPoints: 2300, difficulty: 'moyen' },
  { id: 800, name: 'Necrozma', requiredPoints: 2440, difficulty: 'moyen' },
  { id: 802, name: 'Marshadow', requiredPoints: 2460, difficulty: 'moyen' },
  { id: 805, name: 'Ama-Ama', requiredPoints: 2320, difficulty: 'moyen' },
  { id: 806, name: 'Pierroteknik', requiredPoints: 2330, difficulty: 'moyen' },
  { id: 807, name: 'Zeraora', requiredPoints: 2440, difficulty: 'moyen' },
  { id: 1001, name: 'Chongjian', requiredPoints: 2350, difficulty: 'moyen' },
  { id: 1002, name: 'Baojian', requiredPoints: 2370, difficulty: 'moyen' },
  { id: 1003, name: 'Dinglu', requiredPoints: 2380, difficulty: 'moyen' },
  { id: 1004, name: 'Yuyu', requiredPoints: 2400, difficulty: 'moyen' },
  { id: 1014, name: 'Félicanis', requiredPoints: 2410, difficulty: 'moyen' },
  { id: 1015, name: 'Fortusimia', requiredPoints: 2430, difficulty: 'moyen' },
  { id: 1016, name: 'Favianos', requiredPoints: 2440, difficulty: 'moyen' },
  // --- difficile (hard) ---
  { id: 380, name: 'Latias', requiredPoints: 2730, difficulty: 'difficile' },
  { id: 381, name: 'Latios', requiredPoints: 2730, difficulty: 'difficile' },
  { id: 486, name: 'Regigigas', requiredPoints: 2730, difficulty: 'difficile' },
  { id: 490, name: 'Manaphy', requiredPoints: 2730, difficulty: 'difficile' },
  { id: 648, name: 'Meloetta', requiredPoints: 2720, difficulty: 'difficile' },
  { id: 649, name: 'Genesect', requiredPoints: 2730, difficulty: 'difficile' },
  { id: 719, name: 'Diancie', requiredPoints: 2730, difficulty: 'difficile' },
  { id: 720, name: 'Hoopa', requiredPoints: 2720, difficulty: 'difficile' },
  { id: 721, name: 'Volcanion', requiredPoints: 2730, difficulty: 'difficile' },
  { id: 801, name: 'Magearna', requiredPoints: 2730, difficulty: 'difficile' },
  { id: 891, name: 'Wushours', requiredPoints: 2730, difficulty: 'difficile' },
  { id: 892, name: 'Shifours', requiredPoints: 2740, difficulty: 'difficile' },
  { id: 893, name: 'Zarude', requiredPoints: 2740, difficulty: 'difficile' },
  { id: 894, name: 'Regieleki', requiredPoints: 2740, difficulty: 'difficile' },
  { id: 895, name: 'Regidrago', requiredPoints: 2740, difficulty: 'difficile' },
  { id: 896, name: 'Blizzeval', requiredPoints: 3060, difficulty: 'difficile' },
  { id: 897, name: 'Spectreval', requiredPoints: 3060, difficulty: 'difficile' },
  { id: 1005, name: 'Rugit-Lune', requiredPoints: 3060, difficulty: 'difficile' },
  { id: 1006, name: 'Garde-de-Fer', requiredPoints: 3060, difficulty: 'difficile' },
  { id: 1009, name: 'Serpente-Eau', requiredPoints: 3070, difficulty: 'difficile' },
  { id: 1010, name: 'Vert-de-Fer', requiredPoints: 3070, difficulty: 'difficile' },
  { id: 1017, name: 'Ogerpon', requiredPoints: 2740, difficulty: 'difficile' },
  { id: 1020, name: 'Feu-Perçant', requiredPoints: 3080, difficulty: 'difficile' },
  { id: 1022, name: 'Roc-de-Fer', requiredPoints: 3070, difficulty: 'difficile' },
  { id: 1023, name: 'Chef-de-Fer', requiredPoints: 3070, difficulty: 'difficile' },
  { id: 1025, name: 'Pêchaminus', requiredPoints: 2750, difficulty: 'difficile' },
  // --- extrême (extreme) ---
  { id: 150, name: 'Mewtwo', requiredPoints: 4150, difficulty: 'extrême' },
  { id: 249, name: 'Lugia', requiredPoints: 4150, difficulty: 'extrême' },
  { id: 250, name: 'Ho-Oh', requiredPoints: 4150, difficulty: 'extrême' },
  { id: 382, name: 'Kyogre', requiredPoints: 4070, difficulty: 'extrême' },
  { id: 383, name: 'Groudon', requiredPoints: 4070, difficulty: 'extrême' },
  { id: 384, name: 'Rayquaza', requiredPoints: 4150, difficulty: 'extrême' },
  { id: 483, name: 'Dialga', requiredPoints: 4140, difficulty: 'extrême' },
  { id: 484, name: 'Palkia', requiredPoints: 4150, difficulty: 'extrême' },
  { id: 487, name: 'Giratina', requiredPoints: 4150, difficulty: 'extrême' },
  { id: 493, name: 'Arceus', requiredPoints: 4450, difficulty: 'extrême' },
  { id: 643, name: 'Reshiram', requiredPoints: 4150, difficulty: 'extrême' },
  { id: 644, name: 'Zekrom', requiredPoints: 4140, difficulty: 'extrême' },
  { id: 646, name: 'Kyurem', requiredPoints: 3990, difficulty: 'extrême' },
  { id: 716, name: 'Xerneas', requiredPoints: 4150, difficulty: 'extrême' },
  { id: 717, name: 'Yveltal', requiredPoints: 4150, difficulty: 'extrême' },
  { id: 718, name: 'Zygarde', requiredPoints: 4190, difficulty: 'extrême' },
  { id: 791, name: 'Solgaleo', requiredPoints: 4140, difficulty: 'extrême' },
  { id: 792, name: 'Lunala', requiredPoints: 4150, difficulty: 'extrême' },
  { id: 888, name: 'Zacian', requiredPoints: 4000, difficulty: 'extrême' },
  { id: 889, name: 'Zamazenta', requiredPoints: 3990, difficulty: 'extrême' },
  { id: 890, name: 'Éthernatos', requiredPoints: 4450, difficulty: 'extrême' },
  { id: 898, name: 'Sylveroy', requiredPoints: 4150, difficulty: 'extrême' },
  { id: 1007, name: 'Koraidon', requiredPoints: 4080, difficulty: 'extrême' },
  { id: 1008, name: 'Miraidon', requiredPoints: 4070, difficulty: 'extrême' },
  { id: 1021, name: 'Ire-Foudre', requiredPoints: 3950, difficulty: 'extrême' },
  { id: 1024, name: 'Terapagos', requiredPoints: 4160, difficulty: 'extrême' },
].map(b => ({
  ...b,
  // Nerf : requiredPoints (mode normal ET coop, qui en dérive) × facteur de la difficulté, arrondi à 10.
  requiredPoints: Math.round(b.requiredPoints * getBossPointsScale(b.difficulty) / 10) * 10,
  group: DIFFICULTY_TO_GROUP[b.difficulty],
  sprite: spriteUrl(b.id)
}));

// 4 groupes de difficulté sélectionnables dans le lobby (feature difficulté du boss).
// "difficile" et "très difficile" sont fusionnés dans le groupe "hard" : aucun boss
// supprimé, ils gardent simplement des objectifs différents (2150 et 2600) au sein
// du même groupe, ce qui est explicitement acceptable.
const BOSS_GROUPS = ['easy', 'medium', 'hard', 'extreme'];

function pickRandomBoss(group) {
  const pool = BOSSES.filter(b => b.group === group);
  return randomFrom(pool.length ? pool : BOSSES); // filet de sécurité si groupe invalide/vide
}

// Objets de départ (choisis avant le tour 1). Poids = probabilité d'être PROPOSÉ (parmi
// les 3 options tirées), pas une garantie d'obtention : le joueur choisit ensuite lequel
// des trois il prend. La Méga Gemme est proposée un peu moins souvent (très puissante).
const BONUS_WEIGHTS = {
  xpCandy: 30,
  mysteryItem: 30,
  shinyCharm: 30,
  megaGem: 20,
  patchNote: 20,
  reroll: 25
};

const BONUS_LABELS = {
  xpCandy: 'Bonbon XP',
  mysteryItem: 'PSL',
  shinyCharm: 'Charme Chroma',
  megaGem: 'Méga Gemme',
  patchNote: 'Return To Zero',
  reroll: 'Reroll'
};

// Objets PASSIFS : effet actif toute la partie dès le choix de départ, jamais cliquables
// (pas de use_item) — cf. starting_item_choice. Tous les autres se déclenchent au clic.
const PASSIVE_ITEMS = new Set(['shinyCharm']);
const STARTING_ITEM_CHOICES = 3;

function weightedPickKey(entries) {
  const total = entries.reduce((sum, e) => sum + e.weight, 0);
  let roll = Math.random() * total;
  for (const entry of entries) {
    if (roll < entry.weight) return entry.key;
    roll -= entry.weight;
  }
  return entries[entries.length - 1].key;
}

// Tire STARTING_ITEM_CHOICES objets DIFFÉRENTS (tirage pondéré sans remise) pour le choix
// de DÉBUT DE PARTIE (avant tour 1, cf. start_game), où l'équipe est encore vide —
// l'éligibilité (ex. Bonbon XP sans Pokémon évoluable) est revérifiée plus tard, au moment
// de l'UTILISATION (cf. use_item).
function pickStartingItemKeys() {
  let remaining = Object.keys(BONUS_WEIGHTS).map(key => ({ key, weight: BONUS_WEIGHTS[key] }));
  const picked = [];
  while (picked.length < STARTING_ITEM_CHOICES && remaining.length) {
    const key = weightedPickKey(remaining);
    picked.push(key);
    remaining = remaining.filter(e => e.key !== key);
  }
  return picked;
}

function randomFrom(list) {
  return list[Math.floor(Math.random() * list.length)];
}

// ---- Helpers de mutation d'un Pokémon d'équipe (factorisent un pattern répété par
// tous les événements rares qui modifient un Pokémon existant : talent caché, évolution
// instantanée, double ou rien, shiny, loterie, Bonbon XP, PSL). ----

// Contribution actuelle d'un Pokémon au score (arrondie, jamais stockée : recalculée
// à chaque fois à partir de basePoints/multiplier, seule source de vérité).
function monContribution(mon) {
  return Math.round(mon.basePoints * mon.multiplier) + (mon.flat || 0);
}

// Applique une mutation à un Pokémon puis répercute la différence de contribution sur
// le score du joueur. `mutate` reçoit le Pokémon et le modifie en place. Retourne le
// scoreDelta appliqué.
function applyMonMutation(player, mon, mutate, game) {
  const before = monContribution(mon);
  mutate(mon);
  const after = monContribution(mon);
  let scoreDelta = after - before;
  player.score += scoreDelta;
  // Types (évolution, Méga, Métamorph...) et valeur de l'équipe ayant pu changer : bonus recalculé.
  if (game) scoreDelta += syncTypeBonus(player, game);
  return scoreDelta;
}

// Fait évoluer un Pokémon vers sa forme finale (EVOLUTION_MAP). Mutation en place,
// retourne le nom d'origine (utile pour l'affichage "from -> to").
function evolveMon(mon, evolution) {
  const fromName = mon.name;
  mon.id = evolution.id;
  mon.name = evolution.name;
  mon.sprite = spriteUrl(evolution.id);
  // Un Pokémon shiny qui évolue reste shiny : son sprite chromatique doit lui aussi
  // pointer vers la NOUVELLE forme, sinon l'ancien sprite shiny (désormais périmé)
  // continue d'être affiché indéfiniment (pokemonSprite() le préfère à mon.sprite).
  if (mon.shiny) {
    mon.shinySprite = shinySpriteUrl(evolution.id);
  }
  mon.basePoints = evolution.basePoints;
  mon.evolvedFrom = fromName;
  return fromName;
}

// Assigne un trait/effet à un Pokémon. Mutation en place.
function assignEffect(mon, effect) {
  mon.effectName = effect.name;
  // Le ×shiny déjà inclus dans le multiplicateur (cf. startShinyPokemon) ne doit jamais être perdu.
  mon.multiplier = effect.multiplier * (mon.shinyInMultiplier ? SHINY_POINTS_MULTIPLIER : 1);
  mon.flat = effect.flat || 0;
  if (effect.gamble) mon.gambleRoll = effect.multiplier; // roulette du trait (succès / récap)
  else delete mon.gambleRoll;
}

// ---- PATCH NOTE / REROLL : helpers d'éligibilité et de tirage ----
// Malus = trait dont la force équivalente (`power`) est < 1 ; LET'S GO GAMBLING n'est un malus
// que s'il est tombé sous ×1. Neutre, « Transformé » ou une valeur mise à 0 (double ou rien) : pas des traits.
function isMalusMon(mon) {
  const eff = EFFECTS.find(e => e.name === mon.effectName);
  if (!eff || eff.name === 'Neutre') return false;
  if (eff.gamble) return mon.multiplier / (mon.shinyInMultiplier ? SHINY_POINTS_MULTIPLIER : 1) < 1;
  return eff.power < 1;
}

// Un Métamorph transformé garde une valeur figée (« Transformé ») : jamais relancé.
function isRerollable(mon) {
  return !mon.metamorphUsed;
}

// Multiplicateur « du trait » (sans le ×shiny intégré), pour l'affichage de l'ancien trait.
function traitDisplayMultiplier(mon) {
  return Math.round((mon.multiplier / (mon.shinyInMultiplier ? SHINY_POINTS_MULTIPLIER : 1)) * 100) / 100;
}

// Reroll : jamais Neutre, jamais le trait actuel ; tirage pondéré par la rareté des traits
// (mêmes poids que le tirage normal : les extrêmes restent rares).
function pickRerolledEffect(currentName) {
  const pool = EFFECTS.filter(e => e.name !== 'Neutre' && e.name !== currentName);
  let roll = Math.random() * pool.reduce((sum, e) => sum + e.weight, 0);
  for (const e of pool) {
    if (roll < e.weight) return { effect: resolveEffect(e), pool };
    roll -= e.weight;
  }
  return { effect: resolveEffect(pool[pool.length - 1]), pool };
}

// Construit un Pokémon d'équipe prêt à être poussé dans player.team, à partir d'une
// récompense tirée par buildRewardOption (ou d'un objet de même forme, ex. carte loterie).
// shiny/shinySprite ne sont ajoutés QUE si la récompense est effectivement shiny : garde
// les objets d'équipe non-shiny identiques à avant (mêmes clés qu'avant l'ajout du shiny).
function teamMonFromReward(reward) {
  const mon = {
    id: reward.pokemonId,
    name: reward.name,
    sprite: reward.sprite,
    rarity: reward.rarity,
    basePoints: reward.basePoints,
    effectName: reward.effectName,
    multiplier: reward.multiplier,
    flat: reward.flat || 0
  };
  if (reward.gambleRoll != null) mon.gambleRoll = reward.gambleRoll; // résultat de la roulette (succès / récap)
  if (reward.shiny) {
    mon.shiny = true;
    mon.shinySprite = reward.shinySprite;
  }
  return mon;
}

// Construit une récompense secrète complète (rareté → Pokémon + effet + points calculés).
// floorRarity est optionnel (LUCKY_TURN, TIME_RIFT) ; extraBoost aussi (CROSSED_FATES) :
// undefined pour les deux = comportement inchangé. shiny est tiré ici, indépendamment de
// la rareté/l'effet (cf. SHINY_CHANCE) : s'applique donc à TOUT ce qui appelle cette
// fonction (tirage normal, DOUBLE_ENCOUNTER, TIME_RIFT). gameMode détermine si
// "méga" participe au tirage (admin vs joueur uniquement, cf. pickRarity) — le ×1.5 d'un
// méga est déjà dans basePoints (multiplicateur de catégorie), jamais ré-appliqué ici.
function buildRewardOption(useCharm, pity, floorRarity, extraBoost, gameMode, modifiers) {
  // modifiers : clés de GAME_MODIFIERS actives (game.modifiers), absent = partie classique.
  const floor = hasModifier(modifiers, 'elite') ? higherRarity(floorRarity, 'rare') : floorRarity;
  const megaWeight = hasModifier(modifiers, 'mega_rush') ? MEGA_RUSH_WEIGHT : 0;
  const draw = () => pickRarity(useCharm, pity, floor, extraBoost, gameMode, megaWeight);

  let rarity = draw();
  let pool = POKEMON_POOLS[rarity];
  if (hasModifier(modifiers, 'kanto_only')) {
    // Certaines raretés n'ont aucun Pokémon de Kanto : on retire la rareté tant que le pool
    // filtré est vide (borné, jamais de boucle infinie).
    let kantoPool = pool.filter(isKantoEntry);
    for (let i = 0; i < 50 && kantoPool.length === 0; i++) {
      rarity = draw();
      kantoPool = POKEMON_POOLS[rarity].filter(isKantoEntry);
    }
    pool = kantoPool.length ? kantoPool : POKEMON_POOLS[rarity];
  }

  const pokemon = randomFrom(pool);
  const effect = pickEffect(hasModifier(modifiers, 'chaos_traits'));
  const shiny = hasModifier(modifiers, 'all_shiny') || rollShiny(useCharm); // Charme Chroma : ×2 chances de shiny
  const finalPoints = Math.round(
    pokemon.basePoints *
    effect.multiplier *
    (shiny ? SHINY_POINTS_MULTIPLIER : 1)
  ) + effect.flat;

  return {
    pokemonId: pokemon.id,
    name: pokemon.name,
    sprite: pokemon.sprite,
    rarity: pokemon.rarity,
    basePoints: pokemon.basePoints,
    effectName: effect.name,
    multiplier: effect.multiplier,
    flat: effect.flat,
    gambleRoll: effect.gamble ? effect.multiplier : null,
    shiny,
    shinySprite: shiny ? shinySpriteUrl(pokemon.id) : null,
    finalPoints
  };
}

// ---- MÉGA GEMME : fait Méga-Évoluer un Pokémon DÉJÀ présent dans l'équipe (aucun ajout). ----
// Table dex id de l'espèce de base -> id(s) de sa/ses forme(s) Méga présentes dans les pools
// du jeu (catégorie 'mega'). Tirée de PokeAPI (pokemon.csv : species_id des ids >= 10000),
// Méga de Pokémon Legends Z-A incluses (ids 10278-10326).
// Nom et basePoints de chaque Méga (calculés sur les Base Stats de la forme Méga) viennent de
// POKEMON_POOLS, comme pour EVOLUTION_MAP.
// Un Pokémon absent de la table n'a pas de Méga-Évolution : il n'est jamais proposé.
const MEGA_FORMS = {
  3: [10033], 6: [10034, 10035], 9: [10036], 15: [10090], 18: [10073], 26: [10304, 10305],
  36: [10278], 65: [10037], 71: [10279], 80: [10071], 94: [10038], 115: [10039], 121: [10280],
  127: [10040], 130: [10041], 142: [10042], 149: [10281], 150: [10043, 10044], 154: [10282],
  160: [10283], 181: [10045], 208: [10072], 212: [10046], 214: [10047], 227: [10284],
  229: [10048], 248: [10049], 254: [10065], 257: [10050], 260: [10064], 282: [10051],
  302: [10066], 303: [10052], 306: [10053], 308: [10054], 310: [10055], 319: [10070],
  323: [10087], 334: [10067], 354: [10056], 358: [10306], 359: [10057, 10307], 362: [10074],
  373: [10089], 376: [10076], 380: [10062], 381: [10063], 384: [10079], 398: [10308],
  428: [10088], 445: [10058, 10309], 448: [10059, 10310], 460: [10060], 475: [10068],
  478: [10285], 485: [10311], 491: [10312], 500: [10286], 530: [10287], 531: [10069],
  545: [10288], 560: [10289], 604: [10290], 609: [10291], 623: [10313], 652: [10292],
  655: [10293], 658: [10294], 668: [10295], 670: [10296], 678: [10314, 10326], 687: [10297],
  689: [10298], 691: [10299], 701: [10300], 718: [10301], 719: [10075], 740: [10315],
  768: [10316], 780: [10302], 801: [10317, 10318], 807: [10319], 870: [10303], 952: [10320],
  970: [10321], 978: [10322, 10323, 10324], 998: [10325]
};

function buildMegaMap() {
  const byId = {};
  Object.values(POKEMON_POOLS).flat().forEach(p => { byId[p.id] = p; });
  const map = {};
  for (const [baseId, megaIds] of Object.entries(MEGA_FORMS)) {
    const forms = megaIds.filter(id => byId[id]).map(id => ({ id, name: byId[id].name, basePoints: byId[id].basePoints }));
    if (forms.length) map[baseId] = forms;
  }
  return map;
}
const MEGA_MAP = buildMegaMap();

// Formes Méga possibles d'un Pokémon d'équipe ([] si aucune ; un Pokémon déjà Méga, id >= 10000,
// n'est jamais dans la table).
function getMegaForms(mon) {
  return (mon && MEGA_MAP[mon.id]) || [];
}

// Transforme EN PLACE un Pokémon d'équipe en sa forme Méga. Conserve tout le reste (trait
// effectName/multiplier, shiny). Comme un Méga tiré normalement : rarity 'mega' (succès
// "Éveil de Méga-Pierre"). Le ×1.5 est déjà dans form.basePoints (catégorie 'mega'). Le score
// est ajusté de la différence entre la valeur du Méga (base × trait × shiny, même formule que
// buildRewardOption) et celle du Pokémon d'origine (base × trait × shiny). Retourne
// { fromName, scoreDelta }.
function megaEvolveMon(player, mon, form, game) {
  const shinyFactor = mon.shiny && !mon.shinyInMultiplier ? SHINY_POINTS_MULTIPLIER : 1;
  const before = Math.round(mon.basePoints * mon.multiplier * shinyFactor);
  const after = Math.round(form.basePoints * mon.multiplier * shinyFactor);
  const fromName = mon.name;
  mon.id = form.id;
  mon.name = form.name;
  mon.sprite = spriteUrl(form.id);
  if (mon.shiny) mon.shinySprite = shinySpriteUrl(form.id);
  mon.basePoints = form.basePoints;
  mon.rarity = 'mega';
  mon.megaFrom = fromName;
  let scoreDelta = after - before;
  player.score += scoreDelta;
  if (game) scoreDelta += syncTypeBonus(player, game);
  return { fromName, scoreDelta };
}

// -----------------------------------------------------------------
// MODIFICATEURS DE PARTIE (Route du Boss : modes "normal" et "coop" uniquement), activables
// par l'HÔTE dans le lobby (cf. set_modifiers). Règle d'or : une partie avec au moins un
// modificateur est "hors-classement" — AUCUNE XP, AUCUN historique, donc ni succès, ni stats,
// ni Pokédex (tout en dérive, cf. recordGameResult qui sort dès que player.modifiedGame).
// -----------------------------------------------------------------
const GAME_MODIFIERS = [
  { key: 'all_shiny', icon: '✨', label: 'Tout shiny', description: 'Chaque Pokémon proposé est chromatique (×1.5 pts).' },
  { key: 'no_items', icon: '🚫', label: "Pas d'objets", description: "Aucun objet de départ : tout se joue sur le tirage." },
  { key: 'boss_x15', icon: '💪', label: 'Boss ×1.5', description: "L'objectif du boss est multiplié par 1,5." },
  { key: 'chaos_traits', icon: '🎲', label: 'Talents chaotiques', description: 'Plus aucun trait Neutre : chaque Pokémon a un bonus ou un malus.' },
  { key: 'kanto_only', icon: '🔴', label: 'Retour à Kanto', description: 'Seuls les Pokémon de la 1re génération (et leurs Méga) sont tirés.' },
  { key: 'elite', icon: '👑', label: "Sélection d'élite", description: 'Plus de communs ni de peu communs : rare et au-dessus uniquement.' },
  { key: 'sprint', icon: '⚡', label: 'Sprint', description: '3 tours seulement, objectif du boss réduit de moitié.' },
  { key: 'mega_rush', icon: '💎', label: 'Méga-déferlante', description: 'Les Méga-Évolutions rejoignent les tirages (~13 % par Pokémon).' },
  { key: 'mirror', icon: '🪞', label: 'Miroir', description: 'Tous les joueurs reçoivent exactement le même tirage à chaque tour : le meilleur score gagne (la partie reste classée).' }
];
// Modificateurs qui NE rendent PAS la partie hors-classement (XP, historique, succès conservés).
const RANKED_SAFE_MODIFIERS = ['mirror'];
const GAME_MODIFIER_KEYS = GAME_MODIFIERS.map(m => m.key);
const MODIFIER_GAME_MODES = ['normal', 'coop'];
const SPRINT_TURNS = 3;
const MEGA_RUSH_WEIGHT = 0.15;
const KANTO_MAX_DEX_ID = 151;
const KANTO_MEGA_IDS = new Set(
  Object.entries(MEGA_FORMS).filter(([baseId]) => Number(baseId) <= KANTO_MAX_DEX_ID).flatMap(([, ids]) => ids)
);

function hasModifier(modifiers, key) {
  return Array.isArray(modifiers) && modifiers.includes(key);
}

function gameHasModifier(game, key) {
  return !!game && hasModifier(game.modifiers, key);
}

function isKantoEntry(entry) {
  return entry.id <= KANTO_MAX_DEX_ID || KANTO_MEGA_IDS.has(entry.id);
}

// La plus haute des deux raretés (a peut être absent) — sert à combiner un plancher existant
// (Tour chanceux, Faille temporelle) avec celui de la "Sélection d'élite".
function higherRarity(a, b) {
  if (!a) return b;
  return RARITY_ORDER.indexOf(a) >= RARITY_ORDER.indexOf(b) ? a : b;
}

// Génère les 2 options HAUT/BAS d'un joueur pour un tour (toujours 2 Pokémon distincts).
function pickPlayerTurnOptions(useCharm, pity, floorRarity, extraBoost, gameMode, modifiers) {
  const haut = buildRewardOption(useCharm, pity, floorRarity, extraBoost, gameMode, modifiers);
  let bas = buildRewardOption(useCharm, pity, floorRarity, extraBoost, gameMode, modifiers);

  let guard = 0;
  while (bas.pokemonId === haut.pokemonId && guard < 10) {
    bas = buildRewardOption(useCharm, pity, floorRarity, extraBoost, gameMode, modifiers);
    guard += 1;
  }

  return { haut, bas };
}

// -----------------------------------------------------------------
// GAMEMODE "ADMIN VS JOUEUR" — génération des options de tour.
//
// Contrairement au mode normal, chaque option est tirée INDÉPENDAMMENT dans une table
// de raretés dédiée (ADMIN_MODE_RARITY_TABLE), volontairement inclinée vers les raretés
// fortes, mais SANS jamais empêcher deux Pokémon faibles — ou deux légendaires — de se
// retrouver face à face : c'est le principe même du mode (écarts de puissance imprévisibles,
// cf. spec section 7-10). Pas de pity, pas de plancher, pas de Charme Chroma ici : ce mode
// est volontairement chaotique, pas équilibré sur la durée comme le mode normal.
// -----------------------------------------------------------------
const ADMIN_MODE_RARITY_TABLE = [
  { rarity: 'commun', weight: 0.16 },
  { rarity: 'peu_commun', weight: 0.16 },
  { rarity: 'rare', weight: 0.20 },
  { rarity: 'epique', weight: 0.20 },
  { rarity: 'pseudo_legendaire', weight: 0.16 },
  // Légendaire / Fabuleux / Ultra-Chimère : MÊME taux chacune (0.04, soit 0.12 au total), quelle que soit la taille de leur liste.
  ...LEGENDARY_GROUP.map(rarity => ({ rarity, weight: 0.04 }))
];

function pickAdminModeRarity() {
  const roll = Math.random();
  let cumulative = 0;
  for (const entry of ADMIN_MODE_RARITY_TABLE) {
    cumulative += entry.weight;
    if (roll < cumulative) return entry.rarity;
  }
  return ADMIN_MODE_RARITY_TABLE[ADMIN_MODE_RARITY_TABLE.length - 1].rarity; // filet de sécurité (arrondis flottants)
}

function buildAdminModeOption() {
  const rarity = pickAdminModeRarity();
  const pokemon = randomFrom(POKEMON_POOLS[rarity]);
  const effect = pickEffect();
  const shiny = rollShiny();
  const finalPoints = Math.round(pokemon.basePoints * effect.multiplier * (shiny ? SHINY_POINTS_MULTIPLIER : 1)) + effect.flat;

  return {
    pokemonId: pokemon.id,
    name: pokemon.name,
    sprite: pokemon.sprite,
    rarity: pokemon.rarity,
    basePoints: pokemon.basePoints,
    effectName: effect.name,
    multiplier: effect.multiplier,
    flat: effect.flat,
    gambleRoll: effect.gamble ? effect.multiplier : null,
    shiny,
    shinySprite: shiny ? shinySpriteUrl(pokemon.id) : null,
    finalPoints
  };
}

// Génère les 2 options HAUT/BAS d'une manche en mode ADMIN VS JOUEUR. Tirage totalement
// indépendant pour chaque option (AUCUNE règle "1 seul légendaire max" — cf. spec section
// 10) ; seule contrainte conservée, comme en mode normal : ne jamais proposer deux fois
// le même Pokémon.
function pickAdminModeOptions() {
  const haut = buildAdminModeOption();
  let bas = buildAdminModeOption();

  let guard = 0;
  while (bas.pokemonId === haut.pokemonId && guard < 10) {
    bas = buildAdminModeOption();
    guard += 1;
  }

  return { haut, bas };
}

// -----------------------------------------------------------------
// GAMEMODE "DEVINE LE POKÉMON" — planche partagée + Pokémon secret + tours chronométrés.
//
// Contrairement aux deux autres modes, ici pas de rareté/points/traits : chaque case de
// la planche n'est qu'un Pokémon "identité" (id, nom, sprite). Réutilise POKEMON_POOLS
// tel quel (aucune deuxième base de données) via un échantillonnage stratifié par palier
// de rareté, pour éviter une planche qui ne contiendrait que des Pokémon très similaires.
// -----------------------------------------------------------------
// Durée d'un tour : réglable par l'hôte dans le lobby (cf. socket.on('set_guess_turn_duration')),
// parmi ces valeurs seulement (jamais une valeur arbitraire envoyée par le client).
// GUESS_TURN_DURATION_MS reste la valeur par défaut à la création d'une partie.
const GUESS_TURN_DURATION_OPTIONS_MS = [20000, 30000, 45000, 60000, 90000];
const GUESS_TURN_DURATION_MS = 30000;

// Nombre de cases tirées par palier pour chaque taille de planche (la somme de chaque
// ligne correspond exactement à la taille visée). Toujours un peu de chaque palier,
// jamais tout un palier d'un coup : la planche reste variée même à 15 cases.
const GUESS_TIER_COUNTS_BY_DIFFICULTY = {
  easy: { commun: 5, peu_commun: 3, rare: 3, epique: 2, pseudo_legendaire: 1, mega: 1, legendaire: 1 },
  medium: { commun: 6, peu_commun: 5, rare: 4, epique: 3, pseudo_legendaire: 1, mega: 1, legendaire: 1 },
  hard: { commun: 9, peu_commun: 7, rare: 6, epique: 5, pseudo_legendaire: 2, mega: 2, legendaire: 1 },
  extreme: { commun: 11, peu_commun: 9, rare: 8, epique: 6, pseudo_legendaire: 3, mega: 3, legendaire: 3 }
};

// Fisher-Yates : mélange correct et non biaisé (contrairement à `sort(() => Math.random())`,
// qui ne produit pas une distribution uniforme).
function shuffleArray(arr) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

// Construit une planche fraîche, différente à chaque partie. Le contenu entier
// (planche = quels Pokémon, dans quel ordre) n'est PAS secret : les deux joueurs la
// voient intégralement identique. Seule la case CHOISIE par chacun comme secret l'est.
function buildGuessBoard(difficulty) {
  const tierCounts = GUESS_TIER_COUNTS_BY_DIFFICULTY[difficulty] || GUESS_TIER_COUNTS_BY_DIFFICULTY.medium;
  const picked = [];
  for (const [tier, count] of Object.entries(tierCounts)) {
    const shuffledTier = shuffleArray(getTierPool(tier));
    picked.push(...shuffledTier.slice(0, count));
  }
  return shuffleArray(picked).map((p, index) => ({
    index,
    id: p.id,
    name: p.name,
    sprite: p.sprite
  }));
}

// Démarre une partie "guess" : nouvelle planche, secrets réinitialisés. Appelé UNIQUEMENT
// par start_game (jamais par play_again directement : la planche précédente ne doit
// jamais être réutilisée, cf. section 20 de la spec).
// ===================================================================
// MODE "DRAFT / ENCHÈRES" (gameMode === 'auction')
// ===================================================================
// Isolé dans sa propre section, comme le mode "guess" juste en dessous : structure de
// données totalement différente (budget, lots, historique), jamais mélangée avec les
// champs Route du Boss (turn/route/boss/team) ni avec ceux du mode guess.

// Tire un pool de lots varié et SANS RÉPÉTITION depuis POKEMON_POOLS (même mécanisme que
// buildGuessBoard : shuffleArray + slice par palier, jamais une nouvelle base de données).
// Un lot ne garde que ce qui doit un jour être visible à un joueur (id/name/sprite/points)
// — jamais le champ `rarity` brut, qui n'a pas de sens côté enchère.
function buildAuctionPool() {
  const picked = [];
  for (const [tier, count] of Object.entries(AUCTION_POOL_TIER_COUNTS)) {
    const shuffled = shuffleArray(getTierPool(tier));
    picked.push(...shuffled.slice(0, count));
  }
  // basePoints inclut déjà le ×1.5 des méga (catégorie), comme dans les autres modes — même si
  // `points` ne sert ici qu'en interne (jamais montré tel quel pendant l'enchère, qui se joue
  // sur le budget virtuel des joueurs).
  return shuffleArray(picked).map(p => ({
    id: p.id,
    name: p.name,
    sprite: p.sprite,
    points: p.basePoints
  }));
}

function getPublicAuctionPlayers(game) {
  return game.players.map(p => ({
    id: p.id,
    name: p.name,
    avatar: p.avatar,
    disconnected: !!p.disconnected,
    budget: p.budget,
    team: p.auctionTeam,
    teamCount: p.auctionTeam.length
  }));
}

function auctionPlayerCanBid(player) {
  return player.auctionTeam.length < AUCTION_TEAM_SIZE;
}

function auctionBothTeamsFull(game) {
  return game.players.every(p => p.auctionTeam.length >= AUCTION_TEAM_SIZE);
}

// Retourne l'id du joueur qui doit RÉELLEMENT jouer : si le candidat désigné a déjà son
// équipe complète (6 Pokémon), la main lui est automatiquement retirée au profit de
// l'autre. Toujours sûr : si les 2 équipes étaient pleines, auctionBothTeamsFull() aurait
// déjà mis fin à la partie avant qu'on en arrive là. Le budget n'a lui jamais besoin
// d'être vérifié ici : quel que soit son budget (même 0), un joueur a toujours au moins
// une action possible sur son tour — enchérir au plancher s'il en a les moyens, ou à 0M
// sinon (cf. socket.on('auction_bid')) — jamais besoin de le sauter pour cette raison.
function auctionNextBidder(game, candidateId) {
  const candidate = game.players.find(p => p.id === candidateId);
  if (candidate && auctionPlayerCanBid(candidate)) return candidateId;
  const other = game.players.find(p => p.id !== candidateId);
  return other ? other.id : candidateId;
}

function startAuctionGame(game) {
  game.auctionPool = buildAuctionPool();
  game.auctionHistory = [];
  game.players.forEach(p => {
    p.budget = AUCTION_STARTING_BUDGET;
    p.auctionTeam = [];
  });
  // Premier voyant en semi-aveugle ET premier joueur à ouvrir les enchères : le second
  // joueur de la liste (arbitraire mais déterministe) ; startNextAuctionLot() fait
  // alterner vers l'AUTRE joueur (donc players[0]) dès le premier lot, puis à chaque lot
  // suivant — ce choix initial ne favorise jamais durablement le même joueur.
  game.auctionBlindSeerId = game.players[1] ? game.players[1].id : null;
  game.auctionBidStarterId = game.players[1] ? game.players[1].id : null;

  io.to(game.id).emit('auction_game_started', {
    gameId: game.id,
    auctionType: game.auctionType,
    players: getPublicAuctionPlayers(game)
  });

  startNextAuctionLot(game);
}

// Envoie l'état du lot en cours à CHAQUE joueur individuellement (io.to(playerId), jamais
// un broadcast salon unique) : c'est ce qui garantit qu'en semi-aveugle, le payload reçu
// par le joueur qui ne doit pas voir ne contient tout simplement PAS le champ `pokemon`,
// plutôt qu'un champ à masquer côté client. Voir section 6 du brief : un `hidden:true`
// caché en CSS serait une fuite de données, jamais acceptable ici.
function broadcastAuctionLot(game) {
  const lot = game.auctionLot;
  const publicPlayers = getPublicAuctionPlayers(game);
  game.players.forEach(p => {
    const canSeePokemon = game.auctionType !== 'semi_blind' || lot.seerId === p.id;
    io.to(p.id).emit('auction_lot_started', {
      pokemon: canSeePokemon ? lot.pokemon : null,
      mystery: !canSeePokemon,
      isSeer: canSeePokemon,
      currentBid: lot.currentBid,
      currentBidderId: lot.currentBidderId,
      activePlayerId: lot.activePlayerId,
      canBid: auctionPlayerCanBid(p),
      lotsRemaining: game.auctionPool.length,
      players: publicPlayers
    });
  });
  // 'auction_lot_started' ci-dessus est ciblé PAR JOUEUR (cf. semi-aveugle) donc ne
  // touche jamais les spectateurs, contrairement à 'auction_bid_update'/
  // 'auction_lot_resolved' plus bas qui sont déjà room-wide. Un event dédié, ignoré par
  // les 2 joueurs (leur client ne l'écoute que si isSpectating) : voir
  // buildSpectatePayload pour la règle de masquage du Pokémon en semi-aveugle.
  if (game.spectators.length > 0) {
    io.to(game.id).emit('auction_lot_started_spectator', buildSpectatePayload(game));
  }
}

function startNextAuctionLot(game) {
  if (auctionBothTeamsFull(game) || game.auctionPool.length === 0) {
    // Pool épuisé avant que les 2 aient 6 Pokémon : cas limite improbable (30 lots pour
    // 12 achats max) mais on termine proprement plutôt que de bloquer la partie.
    finishAuctionGame(game, 'complete');
    return;
  }

  const mon = game.auctionPool.shift();

  let seerId = null;
  if (game.auctionType === 'semi_blind') {
    const other = game.players.find(p => p.id !== game.auctionBlindSeerId);
    seerId = other ? other.id : game.players[0].id;
    game.auctionBlindSeerId = seerId;
  }

  // Alterne qui ouvre les enchères à chaque lot (même mécanique que le voyant en
  // semi-aveugle juste au-dessus), en sautant automatiquement le joueur dont l'équipe
  // est déjà complète (cf. auctionNextBidder).
  const otherBidder = game.players.find(p => p.id !== game.auctionBidStarterId);
  const starterCandidate = otherBidder ? otherBidder.id : game.players[0].id;
  game.auctionBidStarterId = auctionNextBidder(game, starterCandidate);

  game.auctionLot = {
    pokemon: mon,
    currentBid: null,
    currentBidderId: null,
    activePlayerId: game.auctionBidStarterId,
    seerId
  };

  broadcastAuctionLot(game);
}

function resolveAuctionLot(game) {
  const lot = game.auctionLot;
  if (!lot) return;

  const winner = lot.currentBidderId ? game.players.find(p => p.id === lot.currentBidderId) : null;

  if (winner) {
    winner.budget -= lot.currentBid;
    winner.auctionTeam.push({ id: lot.pokemon.id, name: lot.pokemon.name, sprite: lot.pokemon.sprite });
  }

  // Révélé aux DEUX joueurs ici, même en semi-aveugle : le bluff ne dure que le temps du
  // lot, ensuite tout le monde découvre ce qui vient vraiment de se vendre (section 33).
  game.auctionHistory.push({
    pokemon: { id: lot.pokemon.id, name: lot.pokemon.name, sprite: lot.pokemon.sprite },
    winnerId: winner ? winner.id : null,
    winnerName: winner ? winner.name : null,
    price: winner ? lot.currentBid : null
  });

  game.auctionLot = null;

  io.to(game.id).emit('auction_lot_resolved', {
    pokemon: { id: lot.pokemon.id, name: lot.pokemon.name, sprite: lot.pokemon.sprite },
    winnerId: winner ? winner.id : null,
    winnerName: winner ? winner.name : null,
    price: winner ? lot.currentBid : null,
    players: getPublicAuctionPlayers(game)
  });

  startNextAuctionLot(game);
}

function finishAuctionGame(game, reason) {
  game.auctionLot = null;
  game.status = 'finished';
  deletePersistedGame(game.id); // partie finie : plus jamais besoin de la restaurer après un redémarrage
  // XP + historique (fire-and-forget) : uniquement pour une fin "normale" (pool épuisé /
  // 2 équipes pleines) — le cas "forfeit" est géré à part par
  // finishAuctionGameByForfeit AVANT d'arriver ici (le joueur parti n'est déjà plus dans
  // game.players à ce stade, donc cette boucle ne le verrait de toute façon jamais).
  if (reason === 'complete') {
    game.players.forEach(p => {
      const opponent = game.players.find(x => x.id !== p.id);
      recordGameResult(p, XP_PARTICIPATION, {
        gameMode: 'auction',
        result: 'participation',
        score: null,
        opponentName: opponent ? opponent.name : null,
        team: p.auctionTeam
      });
    });
  }
  io.to(game.id).emit('auction_game_over', {
    reason: reason || 'complete', // 'complete' (les 2 équipes sont pleines / pool épuisé) | 'forfeit'
    players: getPublicAuctionPlayers(game),
    history: game.auctionHistory
  });
}

// Déconnexion en cours de draft (cf. finalizePlayerRemoval) : pas de "défaite" à proprement
// parler (l'enchère n'a pas de score à comparer), juste une fin de partie prématurée —
// chacun repart avec l'équipe qu'il avait au moment de la coupure. XP/historique quand
// même enregistrés ici (et pas dans finishAuctionGame) car leavingPlayer n'est déjà plus
// dans game.players à ce stade (retiré par leaveCurrentGame juste avant).
function finishAuctionGameByForfeit(game, leavingPlayer) {
  const remaining = game.players[0]; // un seul joueur restant, cf. leaveCurrentGame()
  recordGameResult(leavingPlayer, XP_PARTICIPATION, {
    gameMode: 'auction', result: 'defeat', score: null,
    opponentName: remaining ? remaining.name : null,
    team: leavingPlayer.auctionTeam
  });
  if (remaining) {
    recordGameResult(remaining, XP_PARTICIPATION + XP_VICTORY_BONUS, {
      gameMode: 'auction', result: 'victory', score: null,
      opponentName: leavingPlayer.name,
      team: remaining.auctionTeam
    });
  }
  finishAuctionGame(game, 'forfeit');
}

function startGuessGame(game) {
  game.guessBoard = buildGuessBoard(game.selectedDifficulty);
  game.guessActivePlayerId = null;
  game.guessTurnEndsAt = null;
  if (game.guessTurnTimer) {
    clearTimeout(game.guessTurnTimer);
    game.guessTurnTimer = null;
  }
  game.guessWinnerId = null;
  game.players.forEach(p => { p.secretPokemonIndex = null; });

  io.to(game.id).emit('guess_game_started', {
    gameId: game.id,
    board: game.guessBoard,
    difficulty: game.selectedDifficulty,
    turnDurationMs: game.guessTurnDurationMs || GUESS_TURN_DURATION_MS,
    players: getPublicPlayers(game)
  });
}

function broadcastGuessPlayers(game) {
  io.to(game.id).emit('guess_players_updated', { players: getPublicPlayers(game) });
}

// Démarre le tour de `activePlayerId` : pose le timer serveur (source de vérité, cf.
// section 6 de la spec — jamais confiance dans un timer client) et notifie tout le monde.
function beginGuessTurn(game, activePlayerId) {
  if (game.guessTurnTimer) clearTimeout(game.guessTurnTimer);

  const durationMs = game.guessTurnDurationMs || GUESS_TURN_DURATION_MS;
  game.guessActivePlayerId = activePlayerId;
  game.guessTurnEndsAt = Date.now() + durationMs;

  io.to(game.id).emit('guess_turn_started', {
    activePlayerId,
    turnEndsAt: game.guessTurnEndsAt,
    turnDurationMs: durationMs
  });

  game.guessTurnTimer = setTimeout(() => advanceGuessTurn(game), durationMs);
}

// Premier tour de la partie, une fois que les DEUX joueurs ont choisi leur secret.
function startGuessTurns(game) {
  const first = randomFrom(game.players);
  beginGuessTurn(game, first.id);
}

// Passe au joueur suivant, que ce soit parce que le temps est écoulé (timer serveur) ou
// que le joueur actif a cliqué sur "Finir le tour" (cf. socket.on('guess_finish_turn')) :
// un seul chemin de code pour les deux déclencheurs, donc aucune divergence possible.
function advanceGuessTurn(game) {
  if (game.status !== 'playing' || game.gameMode !== 'guess') return; // partie déjà finie/rejouée entretemps
  const other = game.players.find(p => p.id !== game.guessActivePlayerId);
  if (!other) return; // adversaire déjà parti : la déconnexion gère la suite (forfait)
  beginGuessTurn(game, other.id);
}

// Victoire normale : un joueur a trouvé le Pokémon secret de l'autre.
function finishGuessGame(game, winnerId, opponentSecretIndex) {
  if (game.guessTurnTimer) {
    clearTimeout(game.guessTurnTimer);
    game.guessTurnTimer = null;
  }
  game.status = 'finished';
  game.guessWinnerId = winnerId;
  deletePersistedGame(game.id); // partie finie : plus jamais besoin de la restaurer après un redémarrage

  // XP + historique (fire-and-forget) : participation pour les deux, bonus pour le
  // gagnant. Pas de score en mode guess (jamais suivi).
  game.players.forEach(p => {
    const opponent = game.players.find(x => x.id !== p.id);
    recordGameResult(p, XP_PARTICIPATION + (p.id === winnerId ? XP_VICTORY_BONUS : 0), {
      gameMode: 'guess',
      result: p.id === winnerId ? 'victory' : 'defeat',
      score: null,
      opponentName: opponent ? opponent.name : null,
      difficulty: game.selectedDifficulty || null
    });
  });

  const secretMon = game.guessBoard[opponentSecretIndex];
  io.to(game.id).emit('guess_game_over', {
    winnerId,
    reason: 'found',
    secretPokemon: { name: secretMon.name, sprite: secretMon.sprite },
    players: getPublicPlayers(game)
  });
}

// Abandon : l'un des deux quitte en cours de partie (ou de sélection du secret). Comme
// ce mode nécessite strictement 2 joueurs, celui qui reste ne peut de toute façon plus
// continuer normalement — victoire par forfait plutôt qu'un blocage silencieux (même
// principe que finishAdminModeByForfeit).
function finishGuessGameByForfeit(game, leavingPlayer) {
  if (game.guessTurnTimer) {
    clearTimeout(game.guessTurnTimer);
    game.guessTurnTimer = null;
  }
  game.status = 'finished';
  deletePersistedGame(game.id); // partie finie : plus jamais besoin de la restaurer après un redémarrage

  const remaining = game.players[0]; // un seul joueur restant, cf. leaveCurrentGame()/finalizePlayerRemoval()
  game.guessWinnerId = remaining ? remaining.id : null;

  // XP + historique (fire-and-forget) : le joueur qui a quitté n'a que la participation,
  // celui qui reste (victoire par forfait) touche aussi le bonus. Pas de score en mode
  // guess (jamais suivi, juste victoire/défaite).
  recordGameResult(leavingPlayer, XP_PARTICIPATION, {
    gameMode: 'guess', result: 'defeat', score: null,
    opponentName: remaining ? remaining.name : null,
    difficulty: game.selectedDifficulty || null
  });
  if (remaining) {
    recordGameResult(remaining, XP_PARTICIPATION + XP_VICTORY_BONUS, {
      gameMode: 'guess', result: 'victory', score: null,
      opponentName: leavingPlayer.name,
      difficulty: game.selectedDifficulty || null
    });
  }

  io.to(game.id).emit('guess_game_over', {
    winnerId: game.guessWinnerId,
    reason: 'forfeit',
    secretPokemon: null,
    players: getPublicPlayers(game)
  });
}

// -----------------------------------------------------------------
// ÉVÉNEMENTS RARES
//
// Tirés côté serveur UNIQUEMENT, individuellement pour CHAQUE joueur, juste après
// la résolution de son tour (cf. finalizePlayerTurn). Chaque événement est testé
// indépendamment avec sa propre probabilité (pas une table normalisée à 100% comme
// les raretés) : la plupart du temps AUCUN événement ne se déclenche, ce qui est
// volontaire — ce sont des bonus rares, pas un système central du jeu.
//
// "implemented: false" = déclaré (architecture prête) mais jamais tiré tant que le
// handler serveur correspondant n'existe pas. Évite qu'un événement mal terminé se
// déclenche par erreur pendant que les étapes suivantes sont en cours de développement.
// -----------------------------------------------------------------
const EVENT_TYPES = {
  DOUBLE_ENCOUNTER: 'DOUBLE_ENCOUNTER',
  DOUBLE_OR_NOTHING: 'DOUBLE_OR_NOTHING',
  INSTANT_EVOLUTION: 'INSTANT_EVOLUTION',
  HIDDEN_TALENT: 'HIDDEN_TALENT',
  SHINY_POKEMON: 'SHINY_POKEMON',
  DUEL: 'DUEL',
  CROSSED_FATES: 'CROSSED_FATES',
  LUCKY_TURN: 'LUCKY_TURN',
  TIME_RIFT: 'TIME_RIFT'
};

// scope 'solo' = ne concerne que le joueur qui vient de finir son tour.
// scope 'duo'  = nécessite un adversaire (jamais tiré en solo) — étape 4, pas encore implémenté.
const EVENT_DEFINITIONS = [
  {
    id: EVENT_TYPES.DOUBLE_ENCOUNTER,
    label: 'Double rencontre',
    probability: 0.03,
    scope: 'solo',
    implemented: true,
    condition: (game, player) => player.team.length > 0 // remplace un Pokémon existant, ou skip
  },
  {
    id: EVENT_TYPES.DOUBLE_OR_NOTHING,
    label: 'Double ou rien',
    probability: 0.02,
    scope: 'solo',
    implemented: true,
    condition: (game, player) => player.team.length > 0
  },
  {
    id: EVENT_TYPES.INSTANT_EVOLUTION,
    label: 'Évolution instantanée',
    probability: 0.03,
    scope: 'solo',
    implemented: true,
    condition: (game, player) => player.team.some(mon => EVOLUTION_MAP[mon.id])
  },
  {
    id: EVENT_TYPES.HIDDEN_TALENT,
    label: 'Talent caché',
    probability: 0.03,
    scope: 'solo',
    implemented: true,
    condition: (game, player) => player.team.length > 0
  },
  {
    id: EVENT_TYPES.SHINY_POKEMON,
    label: 'Pokémon shiny',
    probability: 0.02,
    scope: 'solo',
    implemented: true,
    // Un Pokémon déjà chromatique (tiré directement shiny, cf. SHINY_CHANCE) ne peut pas
    // "redevenir" shiny une seconde fois : évite un cumul ×1.5 doublé, narrativement absurde.
    condition: (game, player) => {
      const mon = player.team[player.team.length - 1];
      return !!mon && !mon.shiny;
    }
  },
  {
    id: EVENT_TYPES.DUEL,
    label: 'Duel',
    probability: 0.03,
    scope: 'duo',
    implemented: true,
    condition: (game, player) => !!pickEventOpponent(game, player)
  },
  {
    id: EVENT_TYPES.CROSSED_FATES,
    label: 'Destins croisés',
    probability: 0.02,
    scope: 'duo',
    implemented: true,
    condition: (game, player) => !!pickEventOpponent(game, player)
  },
  {
    id: EVENT_TYPES.LUCKY_TURN,
    label: 'Tour chanceux',
    probability: 0.02,
    scope: 'solo',
    implemented: true,
    condition: (game) => game.turn < game.maxTurns // sinon il n'y a plus de "prochain tirage" à booster
  },
  {
    id: EVENT_TYPES.TIME_RIFT,
    label: 'Faille spatio-temporelle',
    probability: 0.01,
    scope: 'solo',
    implemented: true,
    condition: (game, player) => player.team.length > 0 // remplace un Pokémon existant, ou skip
  }
];

// Nombre de tours minimum entre deux événements pour un même joueur (anti-spam).
const EVENT_COOLDOWN_TURNS = 2;

// Tire un événement pour CE joueur uniquement (jamais les autres). Retourne null la
// plupart du temps — c'est volontaire, les événements doivent rester rares. Chaque
// définition est testée indépendamment avec sa propre probabilité ; la première qui
// "réussit" son tirage déclenche l'événement et arrête la boucle (un seul à la fois).
function maybeTriggerEvent(game, player) {
  if (game.status !== 'playing') return null;
  if (player.activeEvent) return null; // déjà un événement en cours -> jamais de cumul
  if (player.eventCooldown > 0) return null; // anti-spam : pas deux événements qui se suivent

  const candidates = EVENT_DEFINITIONS.filter(def =>
    def.implemented &&
    (def.scope === 'solo' || game.players.length >= 2) &&
    def.condition(game, player)
  );

  for (const def of candidates) {
    if (Math.random() < def.probability) {
      return startEvent(game, player, def);
    }
  }
  return null;
}

// Dispatch générique de démarrage. Chaque événement construit son propre
// player.activeEvent (tout ce qu'il faut pour valider la réponse plus tard) et émet
// 'rare_event_start' avec uniquement ce que le client a le droit de voir.
function startEvent(game, player, def) {
  player.eventCooldown = EVENT_COOLDOWN_TURNS;
  switch (def.id) {
    case EVENT_TYPES.DOUBLE_ENCOUNTER: return startDoubleEncounter(game, player);
    case EVENT_TYPES.DOUBLE_OR_NOTHING: return startDoubleOrNothing(game, player);
    case EVENT_TYPES.HIDDEN_TALENT: return startHiddenTalent(game, player);
    case EVENT_TYPES.INSTANT_EVOLUTION: return startInstantEvolution(game, player);
    case EVENT_TYPES.SHINY_POKEMON: return startShinyPokemon(game, player);
    case EVENT_TYPES.LUCKY_TURN: return startLuckyTurn(game, player);
    case EVENT_TYPES.TIME_RIFT: return startTimeRift(game, player);
    case EVENT_TYPES.DUEL: return startDuel(game, player);
    case EVENT_TYPES.CROSSED_FATES: return startCrossedFates(game, player);
    default: return null;
  }
}

// ---- DOUBLE RENCONTRE : 2 Pokémon générés, le joueur en garde un, l'autre disparaît. ----
// N'affecte PAS le pity : c'est un tirage bonus hors flux principal, pas un tour normal.
function startDoubleEncounter(game, player) {
  const useCharm = !!player.hasShinyCharm;
  const optionA = buildRewardOption(useCharm, player.pity, undefined, undefined, game.gameMode, game.modifiers);
  let optionB = buildRewardOption(useCharm, player.pity, undefined, undefined, game.gameMode, game.modifiers);
  let guard = 0;
  while (optionB.pokemonId === optionA.pokemonId && guard < 10) {
    optionB = buildRewardOption(useCharm, player.pity, undefined, undefined, game.gameMode, game.modifiers);
    guard += 1;
  }

  player.activeEvent = { type: EVENT_TYPES.DOUBLE_ENCOUNTER, options: [optionA, optionB] };

  io.to(player.id).emit('rare_event_start', {
    type: EVENT_TYPES.DOUBLE_ENCOUNTER,
    label: 'Double rencontre',
    options: [optionA, optionB].map(o => ({
      name: o.name,
      sprite: o.sprite,
      rarity: o.rarity,
      basePoints: o.basePoints,
      effectName: o.effectName,
      multiplier: o.multiplier,
      flat: o.flat || 0,
      finalPoints: o.finalPoints
    })),
    team: player.team.map((mon, index) => ({ index, id: mon.id, name: mon.name, sprite: mon.sprite }))
  });
  return player.activeEvent;
}

// Ne grossit JAMAIS l'équipe au-delà de 6 : le joueur choisit un Pokémon parmi les 2
// proposés, PUIS lequel de ses Pokémon actuels il remplace — ou skip entièrement, ce
// qui ne change rien. { skip: true } court-circuite tout le reste.
function resolveDoubleEncounter(game, player, action) {
  if (action && action.skip === true) {
    return { result: { type: EVENT_TYPES.DOUBLE_ENCOUNTER, skipped: true, score: player.score, team: player.team } };
  }

  const options = player.activeEvent.options;
  const optionIndex = action && (action.index === 0 || action.index === 1) ? action.index : null;
  const replaceIndex = action && Number.isInteger(action.replaceIndex) ? action.replaceIndex : null;
  const replacedMon = replaceIndex !== null ? player.team[replaceIndex] : null;
  if (optionIndex === null || !replacedMon) return { error: 'Choix invalide.' };

  const chosen = options[optionIndex];
  let scoreDelta = chosen.finalPoints - monContribution(replacedMon);
  player.team[replaceIndex] = teamMonFromReward(chosen);
  player.score += scoreDelta;
  scoreDelta += syncTypeBonus(player, game);

  return {
    result: {
      type: EVENT_TYPES.DOUBLE_ENCOUNTER,
      pokemon: { name: chosen.name, sprite: chosen.sprite },
      rarity: chosen.rarity,
      replacedName: replacedMon.name,
      scoreDelta,
      score: player.score,
      team: player.team
    }
  };
}

// ---- DOUBLE OU RIEN : risque le dernier Pokémon obtenu ce tour (×2 ou ×0). ----
// Probabilité de SUCCÈS (×2) quand le joueur risque : 0.6 = 60 % de réussite / 40 % d'échec.
// (0.5 = pile ou face ; 0.4 = 40 % de réussite / 60 % d'échec.)
const DOUBLE_OR_NOTHING_SUCCESS_CHANCE = 0.6;
function startDoubleOrNothing(game, player) {
  const teamIndex = player.team.length - 1;
  const mon = player.team[teamIndex];
  if (!mon) return null;

  player.activeEvent = { type: EVENT_TYPES.DOUBLE_OR_NOTHING, teamIndex };

  io.to(player.id).emit('rare_event_start', {
    type: EVENT_TYPES.DOUBLE_OR_NOTHING,
    label: 'Double ou rien',
    pokemon: { name: mon.name, sprite: mon.sprite },
    currentPoints: monContribution(mon)
  });
  return player.activeEvent;
}

function resolveDoubleOrNothing(game, player, action) {
  const teamIndex = player.activeEvent.teamIndex;
  const risk = !!(action && action.risk === true);

  if (!risk) {
    return {
      result: {
        type: EVENT_TYPES.DOUBLE_OR_NOTHING,
        outcome: 'kept',
        scoreDelta: 0,
        score: player.score,
        team: player.team
      }
    };
  }

  const mon = player.team[teamIndex];
  if (!mon) {
    return {
      result: {
        type: EVENT_TYPES.DOUBLE_OR_NOTHING,
        outcome: 'kept',
        scoreDelta: 0,
        score: player.score,
        team: player.team
      }
    };
  }

  const success = Math.random() < DOUBLE_OR_NOTHING_SUCCESS_CHANCE; // tiré côté serveur, jamais le client
  const scoreDelta = applyMonMutation(player, mon, m => { m.multiplier = success ? m.multiplier * 2 : 0; m.flat = success ? (m.flat || 0) * 2 : 0; }, game);

  return {
    result: {
      type: EVENT_TYPES.DOUBLE_OR_NOTHING,
      outcome: success ? 'success' : 'fail',
      pokemon: { name: mon.name, sprite: mon.sprite },
      scoreDelta,
      score: player.score,
      team: player.team
    }
  };
}

// ---- TALENT CACHÉ : le joueur choisit un Pokémon de son équipe, le serveur tire le trait. ----
function startHiddenTalent(game, player) {
  if (player.team.length === 0) return null;

  player.activeEvent = { type: EVENT_TYPES.HIDDEN_TALENT };

  io.to(player.id).emit('rare_event_start', {
    type: EVENT_TYPES.HIDDEN_TALENT,
    label: 'Talent caché',
    team: player.team.map((mon, index) => ({ index, id: mon.id, name: mon.name, sprite: mon.sprite }))
  });
  return player.activeEvent;
}

function resolveHiddenTalent(game, player, action) {
  if (action && action.skip === true) {
    return { result: { type: EVENT_TYPES.HIDDEN_TALENT, skipped: true, score: player.score, team: player.team } };
  }

  const index = action && Number.isInteger(action.index) ? action.index : null;
  const mon = index !== null ? player.team[index] : null;
  if (!mon) return { error: 'Pokémon invalide.' };

  const newEffect = resolveEffect(randomFrom(EFFECTS.filter(e => e.name !== 'Neutre')));
  const scoreDelta = applyMonMutation(player, mon, m => assignEffect(m, newEffect), game);

  return {
    result: {
      type: EVENT_TYPES.HIDDEN_TALENT,
      pokemonName: mon.name,
      sprite: mon.sprite,
      effect: { name: newEffect.name, multiplier: newEffect.multiplier, flat: newEffect.flat },
      scoreDelta,
      score: player.score,
      team: player.team
    }
  };
}

// ---- ÉVOLUTION INSTANTANÉE : le joueur choisit un Pokémon évoluable de son équipe. ----
// Réutilise EVOLUTION_MAP tel quel (déjà un mapping direct vers la forme finale, cf. Bonbon XP).
function startInstantEvolution(game, player) {
  const eligible = player.team
    .map((mon, index) => ({ index, mon }))
    .filter(({ mon }) => EVOLUTION_MAP[mon.id]);
  if (eligible.length === 0) return null;

  player.activeEvent = { type: EVENT_TYPES.INSTANT_EVOLUTION };
  io.to(player.id).emit('rare_event_start', {
    type: EVENT_TYPES.INSTANT_EVOLUTION,
    label: 'Évolution instantanée',
    team: eligible.map(({ index, mon }) => ({ index, id: mon.id, name: mon.name, sprite: mon.sprite }))
  });
  return player.activeEvent;
}

function resolveInstantEvolution(game, player, action) {
  const index = action && Number.isInteger(action.index) ? action.index : null;
  const mon = index !== null ? player.team[index] : null;
  const evolution = mon && EVOLUTION_MAP[mon.id];
  if (!mon || !evolution) return { error: 'Ce Pokémon ne peut pas évoluer.' };

  let fromName;
  const scoreDelta = applyMonMutation(player, mon, m => { fromName = evolveMon(m, evolution); }, game);

  return {
    result: {
      type: EVENT_TYPES.INSTANT_EVOLUTION,
      from: fromName,
      to: mon.name,
      sprite: mon.sprite,
      scoreDelta,
      score: player.score,
      team: player.team
    }
  };
}

// ---- POKÉMON SHINY : aucun choix, aucun nouveau Pokémon — juste un état ajouté sur celui
// obtenu ce tour, plus un bonus de points (SHINY_POINTS_MULTIPLIER, même constante que le
// tirage direct — cf. plus haut). Instantané : pas d'activeEvent, résolu et annoncé en un
// seul emit. ----
function startShinyPokemon(game, player) {
  const mon = player.team[player.team.length - 1];
  if (!mon) return null;

  const scoreDelta = applyMonMutation(player, mon, m => {
    m.shiny = true;
    m.shinySprite = shinySpriteUrl(m.id);
    m.multiplier = m.multiplier * SHINY_POINTS_MULTIPLIER;
    m.shinyInMultiplier = true; // le ×shiny est déjà dans le multiplicateur : jamais recompté
  }, game);

  broadcastGameUpdated(game); // score/équipe changés hors du flux de tour déjà diffusé par finalizePlayerTurn
  io.to(player.id).emit('rare_event_result', {
    type: EVENT_TYPES.SHINY_POKEMON,
    label: 'Pokémon shiny',
    pokemon: { name: mon.name, sprite: mon.sprite, shinySprite: mon.shinySprite },
    scoreDelta,
    score: player.score,
    team: player.team
  });
  return null; // rien à résoudre : pas de choix pour ce joueur (cf. spec)
}

// ---- TOUR CHANCEUX : pose un plancher de rareté pour le PROCHAIN tirage du joueur.
// Effet différé et à usage unique (cf. player.rarityFloor, consommé dans
// assignTurnOptions). Ne garantit jamais un légendaire : seule la
// borne basse de la table change (cf. buildWeightedRarityTable), pas de tirage 100% fixe. ----
const LUCKY_TURN_FLOOR_RARITY = 'epique'; // facilement modifiable

function startLuckyTurn(game, player) {
  player.rarityFloor = LUCKY_TURN_FLOOR_RARITY;
  io.to(player.id).emit('rare_event_result', {
    type: EVENT_TYPES.LUCKY_TURN,
    label: 'Tour chanceux',
    floorRarity: LUCKY_TURN_FLOOR_RARITY
  });
  return null; // effet différé, rien à résoudre maintenant
}

// ---- FAILLE SPATIO-TEMPORELLE : table spéciale (plancher pseudo-légendaire), reste un
// tirage RNG normal via le même mécanisme poids+normalisation — jamais 100% légendaire.
// Instantané, comme SHINY_POKEMON/LUCKY_TURN : aucun choix décrit pour cet événement. ----
const TIME_RIFT_FLOOR_RARITY = 'pseudo_legendaire'; // uniquement pseudo-légendaire ou légendaire, jamais garanti lequel

// Ne grossit JAMAIS l'équipe au-delà de 6 : le tirage spécial est proposé, mais le
// joueur doit choisir lequel de ses Pokémon actuels il remplace, ou skip (rien ne change).
function startTimeRift(game, player) {
  const useCharm = !!player.hasShinyCharm;
  const reward = buildRewardOption(useCharm, player.pity, TIME_RIFT_FLOOR_RARITY, undefined, game.gameMode, game.modifiers);

  player.activeEvent = { type: EVENT_TYPES.TIME_RIFT, reward };

  io.to(player.id).emit('rare_event_start', {
    type: EVENT_TYPES.TIME_RIFT,
    label: 'Faille spatio-temporelle',
    pokemon: { name: reward.name, sprite: reward.sprite, rarity: reward.rarity, finalPoints: reward.finalPoints },
    team: player.team.map((mon, index) => ({ index, id: mon.id, name: mon.name, sprite: mon.sprite }))
  });
  return player.activeEvent;
}

function resolveTimeRift(game, player, action) {
  if (action && action.skip === true) {
    return { result: { type: EVENT_TYPES.TIME_RIFT, skipped: true, score: player.score, team: player.team } };
  }

  const reward = player.activeEvent.reward;
  const replaceIndex = action && Number.isInteger(action.replaceIndex) ? action.replaceIndex : null;
  const replacedMon = replaceIndex !== null ? player.team[replaceIndex] : null;
  if (!replacedMon) return { error: 'Choix invalide.' };

  let scoreDelta = reward.finalPoints - monContribution(replacedMon);
  player.team[replaceIndex] = teamMonFromReward(reward);
  player.score += scoreDelta;
  scoreDelta += syncTypeBonus(player, game);

  return {
    result: {
      type: EVENT_TYPES.TIME_RIFT,
      pokemon: { name: reward.name, sprite: reward.sprite },
      rarity: reward.rarity,
      replacedName: replacedMon.name,
      scoreDelta,
      score: player.score,
      team: player.team
    }
  };
}

// -----------------------------------------------------------------
// ÉVÉNEMENTS À DEUX JOUEURS (DUEL, CROSSED_FATES)
//
// Contrairement aux événements solo, ceux-ci concernent deux joueurs de la même partie.
// Le serveur choisit lui-même un adversaire valide ; jamais le client. Seuls les deux
// joueurs concernés sont bloqués le temps de la résolution (activeEvent posé sur les
// deux) — les autres continuent normalement, le flux de tour global n'attend jamais un
// événement (cf. finalizePlayerTurn, qui ne bloque jamais la transition de tour).
// -----------------------------------------------------------------

// Choisit un adversaire valide : un autre joueur de la même partie, qui n'a pas déjà un
// événement actif (jamais interrompre quelqu'un d'autre en pleine résolution). Fonction
// pure (aucun effet de bord) : utilisée à la fois pour vérifier la condition de
// déclenchement et pour le tirage réel au démarrage de l'événement.
function pickEventOpponent(game, player, extraFilter) {
  const candidates = game.players.filter(p =>
    p.id !== player.id && !p.activeEvent && (!extraFilter || extraFilter(p))
  );
  if (candidates.length === 0) return null;
  return randomFrom(candidates);
}

// ---- DUEL : les 2 joueurs choisissent chacun HAUT/BAS. Choix différents -> HAUT bat BAS
// (règle simple et fixe). Choix identiques -> tirage 50/50 côté serveur (règle simple et
// clairement définie, jamais de blocage). Le perdant ne perd RIEN (juste pas de gain) :
// reste amusant, jamais punitif. ----
const DUEL_REWARD_POINTS = 120; // gain raisonnable pour le gagnant, cohérent avec l'échelle de points du jeu

function startDuel(game, player) {
  const opponent = pickEventOpponent(game, player);
  if (!opponent) return null;

  const sharedEvent = {
    type: EVENT_TYPES.DUEL,
    participants: [player.id, opponent.id],
    choices: {}
  };
  player.activeEvent = sharedEvent;
  opponent.activeEvent = sharedEvent;
  opponent.eventCooldown = EVENT_COOLDOWN_TURNS; // l'adversaire entre aussi en cooldown

  [player, opponent].forEach(p => {
    const other = p.id === player.id ? opponent : player;
    io.to(p.id).emit('rare_event_start', {
      type: EVENT_TYPES.DUEL,
      label: 'Duel',
      opponentName: other.name
    });
  });

  return sharedEvent;
}

// Retourné à socket.on('rare_event_action') via resolveEventAction. Contrat spécial :
// { pending: true } tant que l'autre joueur n'a pas encore répondu (rien n'est nettoyé,
// rien n'est diffusé) ; { resultsByPlayer } une fois les deux choix reçus, avec une
// perspective distincte pour chacun (gagnant/perdant) — géré par le handler générique.
function resolveDuel(game, player, action) {
  const shared = player.activeEvent;
  const choice = action && (action.choice === 'HAUT' || action.choice === 'BAS') ? action.choice : null;
  if (!choice) return { error: 'Choix invalide.' };
  if (shared.choices[player.id]) return { error: 'Choix déjà envoyé.' };

  shared.choices[player.id] = choice;

  const [idA, idB] = shared.participants;
  if (!shared.choices[idA] || !shared.choices[idB]) {
    return { pending: true }; // en attente de l'autre joueur
  }

  const playerA = game.players.find(p => p.id === idA);
  const playerB = game.players.find(p => p.id === idB);
  const choiceA = shared.choices[idA];
  const choiceB = shared.choices[idB];

  let winnerId;
  if (choiceA !== choiceB) {
    winnerId = choiceA === 'HAUT' ? idA : idB; // règle fixe : HAUT bat BAS
  } else {
    winnerId = Math.random() < 0.5 ? idA : idB; // égalité de choix -> 50/50 serveur
  }

  if (playerA && winnerId === idA) playerA.score += DUEL_REWARD_POINTS;
  if (playerB && winnerId === idB) playerB.score += DUEL_REWARD_POINTS;
  // L'affinité est un % du score brut : recalculée après tout changement de score.
  if (playerA) syncTypeBonus(playerA, game);
  if (playerB) syncTypeBonus(playerB, game);

  const resultsByPlayer = {};
  [playerA, playerB].forEach(p => {
    if (!p) return;
    const won = p.id === winnerId;
    resultsByPlayer[p.id] = {
      type: EVENT_TYPES.DUEL,
      won,
      yourChoice: shared.choices[p.id],
      opponentChoice: shared.choices[p.id === idA ? idB : idA],
      pointsGained: won ? DUEL_REWARD_POINTS : 0,
      score: p.score,
      team: p.team
    };
  });

  return { resultsByPlayer };
}

// ---- MIROIR : SUPPRIMÉ (2024) — provoquait, en jeu réel, des équipes à 7 Pokémon
// malgré les gardes team.length<6 en place (cause exacte jamais identifiée avec
// certitude ; désactivé un temps via implemented:false, puis retiré du code plutôt que
// laissé en risque latent réactivable par erreur). Voir MAX_TEAM_SIZE/pushMonToTeam
// ci-dessous pour le garde-fou désormais unique et partagé par tous les ajouts d'équipe.

// ---- DESTINS CROISÉS : lie 2 joueurs. Règle simple et clairement définie, toujours
// positive (jamais punitive, cf. consigne générale des événements) : quand l'un des deux
// termine son PROCHAIN tour, l'AUTRE reçoit un petit bonus de rareté sur son tirage
// suivant (cf. rarityBoost, même mécanisme poids+normalisation que pity/Charme/plancher).
// Instantané au déclenchement ; l'effet lui-même se joue plus tard, passivement, sur les
// tours normaux (cf. applyCrossedFatesLink, appelé depuis finalizePlayerTurn). ----
const CROSSED_FATES_BOOST_MULTIPLIER = 1.25; // petit bonus, volontairement modeste

function startCrossedFates(game, player) {
  const opponent = pickEventOpponent(game, player);
  if (!opponent) return null;

  player.crossedFatesPartner = opponent.id;
  opponent.crossedFatesPartner = player.id;
  opponent.eventCooldown = EVENT_COOLDOWN_TURNS;

  [player, opponent].forEach(p => {
    const other = p.id === player.id ? opponent : player;
    io.to(p.id).emit('rare_event_result', {
      type: EVENT_TYPES.CROSSED_FATES,
      label: 'Destins croisés',
      subtype: 'linked',
      linkedPlayerName: other.name
    });
  });

  return null; // pas d'activeEvent : l'effet se joue passivement sur les prochains tours normaux
}

// Appelé par finalizePlayerTurn pour CE joueur : si son tour qui vient de se résoudre le
// liait à un partenaire (CROSSED_FATES), le partenaire reçoit un petit bonus pour son
// PROCHAIN tirage. Lien consommé immédiatement du côté du joueur qui vient de jouer
// (à usage unique par joueur), que le partenaire soit encore présent ou non.
function applyCrossedFatesLink(game, player) {
  const partnerId = player.crossedFatesPartner;
  if (!partnerId) return;
  player.crossedFatesPartner = null;

  const partner = game.players.find(p => p.id === partnerId);
  if (!partner) return; // le partenaire a quitté entre temps : rien à faire, pas d'erreur

  partner.rarityBoost = CROSSED_FATES_BOOST_MULTIPLIER;
  io.to(partner.id).emit('rare_event_result', {
    type: EVENT_TYPES.CROSSED_FATES,
    label: 'Destins croisés',
    subtype: 'boost_received',
    linkedPlayerName: player.name
  });
}

// Dispatch générique de résolution, appelé par socket.on('rare_event_action').
function resolveEventAction(game, player, action) {
  switch (player.activeEvent.type) {
    case EVENT_TYPES.DOUBLE_ENCOUNTER: return resolveDoubleEncounter(game, player, action);
    case EVENT_TYPES.DOUBLE_OR_NOTHING: return resolveDoubleOrNothing(game, player, action);
    case EVENT_TYPES.HIDDEN_TALENT: return resolveHiddenTalent(game, player, action);
    case EVENT_TYPES.INSTANT_EVOLUTION: return resolveInstantEvolution(game, player, action);
    case EVENT_TYPES.TIME_RIFT: return resolveTimeRift(game, player, action);
    case EVENT_TYPES.DUEL: return resolveDuel(game, player, action);
    default: return { error: "Type d'événement inconnu." };
  }
}

function buildRoute(length = MAX_TURNS) {
  return Array.from({ length }, (_, i) => ({
    turn: i + 1,
    status: i === 0 ? 'current' : 'upcoming'
  }));
}

// ---------------------------------------------------------------
// État en mémoire. Aucune base de données pour ce MVP.
// games[gameId] = {
//   id, status: "waiting" | "playing" | "finished",
//   turn, maxTurns, hostId,
//   boss: null tant que la partie n'a pas démarré, puis { id, name, sprite, requiredPoints, difficulty }
//         tiré aléatoirement dans BOSSES au moment du start_game (identique pour tous les joueurs),
//   route,
//   turnTimer: setTimeout id | null (pause de révélation entre 2 tours),
//   gameMode: "normal" | "admin" (cf. GAME_MODES), choisi dans le lobby, "normal" par défaut,
//   adminId: id du joueur ADMIN si gameMode === "admin", sinon null (choisi par l'hôte,
//            valide uniquement à exactement 2 joueurs — cf. set_admin_role),
//   players: [player],
//   spectators: [{ id, name }] — observateurs en lecture seule d'une partie déjà démarrée
//               (normal/admin uniquement), cf. socket.on('join_game') + removeSpectator/
//               clearSpectators. Jamais dans players, aucun impact sur la logique de jeu.
// }
// player = {
//   id, name, score, team, currentChoice,
//   currentOptions: { haut, bas } (secret, jamais envoyé tel quel au client),
//   hasShinyCharm: bool (Charme Chroma passif, actif toute la partie si choisi au départ),
//   startItemOptions: [key, key, key] | null (3 objets proposés avant le tour 1, secret intermédiaire),
//   heldItem: 'xpCandy' | 'mysteryItem' | 'shinyCharm' | 'megaGem' | 'patchNote' | 'reroll' | null (objet retenu pour toute la partie),
//   heldItemUsed: bool (objet déjà consommé ou non — utilisable une seule fois, à tout moment),
//   pendingBonusKey: 'xpCandy' | 'mysteryItem' | 'megaGem' | 'patchNote' | 'reroll' | null (objet en cours d'utilisation, attente de la cible)
// }
// ---------------------------------------------------------------
const games = {};

// -----------------------------------------------------------------
// PRÉSENCE EN LIGNE (comptes) — nécessaire pour savoir quels amis inviter directement
// (cf. socket.on('invite_friend') plus bas) sans que la personne soit forcément déjà
// dans une partie. userId -> Set de socket.id (plusieurs onglets/appareils possibles).
// Best-effort, jamais persisté : un redémarrage serveur vide simplement le registre, les
// clients se ré-identifient tout seuls à la reconnexion (cf. socket.on('identify_account')).
// -----------------------------------------------------------------
const onlineAccounts = {};

function isAccountOnline(userId) {
  return !!(onlineAccounts[userId] && onlineAccounts[userId].size > 0);
}

function registerAccountSocket(userId, socketId) {
  if (!onlineAccounts[userId]) onlineAccounts[userId] = new Set();
  onlineAccounts[userId].add(socketId);
}

function unregisterAccountSocket(userId, socketId) {
  if (!onlineAccounts[userId]) return;
  onlineAccounts[userId].delete(socketId);
  if (onlineAccounts[userId].size === 0) delete onlineAccounts[userId];
}

// -----------------------------------------------------------------
// PERSISTANCE DES PARTIES EN COURS (table Supabase `active_games`) — pour survivre à un
// redémarrage du serveur (déploiement Render, crash...) sans perdre les parties déjà
// lancées. Uniquement les parties status === 'playing' (une partie en lobby ou déjà finie
// n'a rien à gagner à être restaurée : triviale à recréer, ou déjà entièrement traitée
// via recordGameResult). Best-effort partout (fire-and-forget, jamais bloquant, jamais un
// pré-requis pour que le jeu fonctionne) : si Supabase est absent/mal configuré, tout se
// comporte exactement comme avant cette fonctionnalité, juste sans résistance aux
// redémarrages.
// -----------------------------------------------------------------

// Retire tout ce qui n'est PAS sérialisable en JSON (Timeout de setTimeout) — jamais un
// JSON.stringify(game) direct, qui laisserait passer des objets Timeout à moitié
// sérialisés (propriétés internes Node, inexploitables à la relecture).
function serializeGameForPersistence(game) {
  const { turnTimer, guessTurnTimer, ...rest } = game;
  return {
    ...rest,
    players: game.players.map(p => {
      const { disconnectTimer, ...playerRest } = p;
      return playerRest;
    })
  };
}

async function persistGame(game) {
  if (!supabase || game.status !== 'playing' || game.gameMode === 'fly' || game.gameMode === 'statdraft') return;
  try {
    await supabase.from('active_games').upsert({
      game_id: game.id,
      state: serializeGameForPersistence(game),
      updated_at: new Date().toISOString()
    });
  } catch (err) {
    console.error('[persistance] échec sauvegarde partie', game.id, err.message);
  }
}

async function deletePersistedGame(gameId) {
  if (!supabase) return;
  try {
    await supabase.from('active_games').delete().eq('game_id', gameId);
  } catch (err) {
    console.error('[persistance] échec suppression partie', gameId, err.message);
  }
}

// Sauvegarde périodique de TOUTES les parties en cours — bien plus simple et fiable que
// d'ajouter un appel à persistGame() après chaque mutation possible (des dizaines
// d'endroits différents) ; au pire ~20s de jeu perdues sur un crash brutal, largement
// acceptable pour ce projet. Les redémarrages "propres" (nouveau déploiement Render) sont
// couverts séparément par le handler SIGTERM juste en dessous, qui sauvegarde tout juste
// avant l'arrêt plutôt que d'attendre le prochain tick.
const PERSIST_INTERVAL_MS = 20000;
setInterval(() => {
  if (!supabase) return;
  Object.values(games).forEach(persistGame);
}, PERSIST_INTERVAL_MS);

process.on('SIGTERM', async () => {
  if (supabase) {
    console.log('[persistance] SIGTERM reçu, sauvegarde des parties en cours...');
    await Promise.all(Object.values(games).map(persistGame));
  }
  try { await flyBrain.flush(); } catch (e) { /* cerveau : meilleur effort */ }
  process.exit(0);
});

// Restauration au démarrage : relit toutes les parties persistées et les replace dans
// `games`, comme si le serveur n'avait jamais redémarré. Personne n'est réellement
// connecté à ce stade (nouveau process = 0 socket) : chaque joueur est marqué
// "déconnecté" avec le MÊME délai de grâce qu'une coupure réseau normale (cf.
// handleSocketDisconnect/RECONNECT_GRACE_MS plus bas) — son client, en se reconnectant
// tout seul (Socket.IO) puis en renvoyant rejoin_game, le retrouvera et annulera ce délai.
// S'il ne revient pas à temps, la partie se termine par forfait exactement comme une
// vraie déconnexion : aucune logique de nettoyage spécifique à inventer ici.
async function loadPersistedGames() {
  if (!supabase) return;
  try {
    const { data, error } = await supabase.from('active_games').select('game_id, state');
    if (error || !data || data.length === 0) return;

    data.forEach(row => {
      const game = row.state;
      if (!game || !game.id || !Array.isArray(game.players)) return;
      game.turnTimer = null;
      game.guessTurnTimer = null;
      // Partie sauvegardée AVANT les mécaniques de type : on ajoute seulement types/faiblesses au
      // boss (objectif et scores déjà sauvegardés, jamais recalculés).
      if (game.boss && !game.boss.types && game.boss.id !== undefined) {
        try {
          Object.assign(game.boss, BOSS_MECHANICS.describeBoss(game.boss));
          game.boss.typeRules = BOSS_MECHANICS.isEnabled(game.gameMode) ? BOSS_MECHANICS.publicRules() : null;
        } catch (e) { console.error('[types] boss restauré sans types :', e.message); }
      }
      games[game.id] = game;

      game.players.forEach(player => {
        player.disconnected = true;
        player.disconnectTimer = setTimeout(() => {
          game.players = game.players.filter(p => p.token !== player.token);
          finalizePlayerRemoval(game, game.id, player);
        }, RECONNECT_GRACE_MS);
      });

      // Mode "guess" : relance un tour complet (durée pleine plutôt que le temps restant
      // précis — un redémarrage serveur est rare et perturbateur, autant repartir sur une
      // base simple et généreuse qu'un calcul de temps restant fragile).
      if (game.gameMode === 'guess' && game.guessActivePlayerId && game.status === 'playing') {
        beginGuessTurn(game, game.guessActivePlayerId);
      }

      // Mode normal/admin : si les joueurs actifs avaient déjà choisi avant l'arrêt du
      // serveur (transition de tour en attente des 4s de révélation, cf.
      // resolveTurnTransition), on la résout tout de suite plutôt que de laisser la
      // partie bloquée indéfiniment — le délai lui-même est de toute façon largement
      // dépassé par le redémarrage.
      if ((game.gameMode === 'normal' || game.gameMode === 'admin') && game.status === 'playing') {
        const activePlayers = game.gameMode === 'admin' ? game.players.filter(p => p.id !== game.adminId) : game.players;
        if (activePlayers.length > 0 && activePlayers.every(p => p.currentChoice !== null)) {
          resolveTurnTransition(game);
        }
      }

      console.log(`[persistance] partie ${game.id} restaurée (${game.gameMode}, ${game.players.length} joueur(s))`);
    });
  } catch (err) {
    console.error('[persistance] échec restauration des parties', err.message);
  }
}


// -----------------------------------------------------------------
// GAMEMODE "ADMIN VS JOUEUR" — cf. set_game_mode / set_admin_role.
// "normal" = comportement actuel, inchangé. "admin" = à exactement 2 joueurs, l'un
// devient ADMIN (voit tout, ne joue jamais), l'autre JOUEUR (joue normalement, ne voit
// rien de caché). Le champ gameMode est posé ici ; la logique de tour spécifique au
// mode admin sera ajoutée aux étapes suivantes (génération des options, diffusion
// différenciée admin/joueur, interfaces dédiées).
// -----------------------------------------------------------------
const GAME_MODES = ['normal', 'admin', 'guess', 'auction', 'coop', 'fly', 'statdraft'];

// Objectif D'ÉQUIPE en mode Coop (cf. finishGame) : la vie de base du boss (100%, déjà
// buffée dans BOSSES comme en mode normal) PLUS +50% de cette vie de base pour CHAQUE
// joueur, le 1er inclus → 2 joueurs = ×2, 3 = ×2,5, 4 = ×3, etc. (pas de plafond de
// joueurs, 2 minimum). game.boss est TOUJOURS cloné (jamais la référence partagée de
// BOSSES) avant d'y ajouter ce champ, pour ne jamais muter les objets boss partagés
// entre parties (cf. beginRouteGameplay).
function computeCoopTeamRequiredPoints(boss, playerCount) {
  return Math.round(boss.requiredPoints * (1 + 0.5 * playerCount));
}

// -----------------------------------------------------------------
// MODE "DRAFT / ENCHÈRES" (gameMode === 'auction') — strictement 2 joueurs, aucun
// mécanisme de banc/spectateur (contrairement à admin/guess) : le lobby doit être à
// exactement 2 joueurs pour démarrer, point final (cf. socket.on('start_game')).
//
// Deux variantes, choisies par l'hôte avant le lancement (cf. set_auction_type) :
// - 'complete'   : les 2 joueurs voient toujours le vrai Pokémon du lot en cours.
// - 'semi_blind' : à chaque lot, UN SEUL des 2 voit le vrai Pokémon (rotation stricte à
//   chaque lot, cf. game.auctionBlindSeerId) ; l'autre ne reçoit RIEN qui permette de le
//   deviner (jamais un champ "hidden:true" à masquer en CSS — cf. broadcastAuctionLot,
//   qui envoie un payload PAR JOUEUR via io.to(playerId).emit, jamais un broadcast salon
//   unique). Le vrai Pokémon est révélé aux deux une fois le lot résolu (achat ou non).
//
// Enchères TOUR PAR TOUR, sans limite de temps ni prix de départ dépendant du lot (cf.
// game.auctionLot : activePlayerId désigne qui doit jouer) :
// - à son tour, un joueur enchérit (montant strictement supérieur à l'enchère actuelle,
//   ou au moins AUCTION_MIN_BID si le lot n'a encore reçu aucune offre — un plancher
//   fixe et identique pour tous les lots, pas un prix de départ calculé par rareté) ou
//   passe ;
// - passer n'est autorisé QUE si une enchère a déjà été posée sur ce lot (impossible
//   d'ouvrir un lot en passant : quelqu'un doit toujours enchérir en premier) ; passer
//   attribue alors immédiatement le lot à l'auteur de cette enchère ;
// - EXCEPTION au plancher : un joueur qui n'a pas les moyens d'AUCTION_MIN_BID peut, pour
//   ouvrir un lot vierge UNIQUEMENT, miser 0M à la place (jamais s'il a les moyens du
//   vrai plancher — cf. socket.on('auction_bid')). Ça revient à laisser le choix à
//   l'adversaire : passer (lui laisser le lot gratuitement) ou enchérir pour le prendre.
// -----------------------------------------------------------------
const AUCTION_TYPES = ['complete', 'semi_blind'];
const AUCTION_STARTING_BUDGET = 500_000_000;
const AUCTION_MIN_BID = 10_000_000; // plancher fixe (pas de prix de départ par lot) ; garde aussi formatAuctionMoney lisible
const AUCTION_TEAM_SIZE = 6;
const AUCTION_POOL_TIER_COUNTS = {
  // Mélange volontairement large et varié (32 lots), tiré sans répétition depuis
  // POKEMON_POOLS (cf. buildAuctionPool) — largement assez pour que les 2 joueurs
  // puissent chacun compléter une équipe de 6, même si plusieurs lots ne trouvent
  // aucun acheteur (cf. section 26 du brief : Pokémon retiré si personne n'enchérit).
  // "mega" comme en admin vs joueur : entre pseudo-légendaire et légendaire.
  commun: 8,
  peu_commun: 6,
  rare: 6,
  epique: 5,
  pseudo_legendaire: 3,
  mega: 2,
  legendaire: 2
};

// Affiche le ,5 exact plutôt que d'arrondir au million (montants toujours multiples de
// 500 000, cf. la validation "entier ou ,5" dans socket.on('auction_bid')).
function formatAuctionMoney(amount) {
  const snapped = Math.round((amount / 1_000_000) * 2) / 2;
  const text = Number.isInteger(snapped) ? String(snapped) : snapped.toFixed(1).replace('.', ',');
  return `${text}M`;
}

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sans 0/O/1/I

// -----------------------------------------------------------------
// RECONNEXION — cf. socket.on('rejoin_game').
//
// Chaque joueur a un token stable généré côté CLIENT au premier chargement (stocké en
// localStorage, jamais régénéré tant que le navigateur ne l'efface pas). Contrairement à
// socket.id (qui change à chaque connexion), ce token survit à une coupure réseau/un
// refresh de page : c'est lui qui permet de retrouver et de "rebrancher" le bon joueur
// sur sa nouvelle socket lors d'une reconnexion.
//
// Le comportement diffère selon l'état de la partie au moment de la déconnexion :
// - "waiting" (lobby) ou "finished" : rien à sauver, retrait immédiat (comportement
//   historique, inchangé) — les enjeux sont faibles, autant garder simple.
// - "playing" : le joueur N'EST PAS retiré immédiatement. Il est marqué `disconnected`
//   (les autres voient un badge "hors ligne"), et un délai de grâce démarre. S'il
//   revient dans ce délai (rejoin_game avec le bon token), il reprend exactement sa
//   place (score, équipe, tour en cours) sans rien perdre. Sinon, il est retiré comme
//   d'habitude une fois le délai écoulé (y compris le forfait en mode ADMIN VS JOUEUR).
// -----------------------------------------------------------------
const RECONNECT_GRACE_MS = 45000;

function generateToken() {
  return Array.from({ length: 24 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
}

function generateGameId() {
  let id;
  do {
    id = Array.from({ length: 6 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
  } while (games[id]);
  return id;
}

function makePlayer(id, name, token, avatar, accessToken) {
  const player = {
    id,
    name,
    // Avatar de compte (optionnel, cf. AVATARS) : jamais une valeur arbitraire du
    // client — uniquement une valeur de la liste, sinon null (joueur invité ou sans
    // avatar choisi).
    avatar: AVATARS.includes(avatar) ? avatar : null,
    // accessToken du compte (optionnel) : JAMAIS validé ni exposé aux autres joueurs
    // (absent de getPublicPlayers/getPublicAuctionPlayers) — uniquement revérifié une
    // fois, en fin de partie, pour attribuer de l'XP (cf. awardXp). Un token expiré ou
    // absent (joueur invité) signifie simplement "pas d'XP cette partie", jamais une
    // erreur.
    accountAccessToken: accessToken || null,
    titleLabel: '', // titre équipé (cosmétique), chargé côté serveur depuis le compte — jamais fourni par le client
    token: token || generateToken(), // filet de sécurité si un vieux client n'en envoie pas
    disconnected: false, // cf. RECONNECT_GRACE_MS — true pendant le délai de grâce
    disconnectTimer: null,
    score: 0,
    team: [],
    currentChoice: null,
    currentOptions: null,
    hasShinyCharm: false,
    startItemOptions: null,
    heldItem: null,
    heldItemUsed: false,
    pendingBonusKey: null,
    pity: 0, // compteur anti-RNG individuel, jamais partagé entre joueurs
    worstChoice: null, // récap de fin de partie : plus gros regret HAUT/BAS
    activeEvent: null, // événement rare en cours pour CE joueur (jamais 2 à la fois)
    eventCooldown: 0, // nb de tours restants avant qu'un nouvel événement puisse se tirer
    rarityFloor: null, // effet différé de LUCKY_TURN : plancher de rareté pour le PROCHAIN tirage, à usage unique
    rarityBoost: null, // petit bonus différé de CROSSED_FATES pour le PROCHAIN tirage, à usage unique
    crossedFatesPartner: null, // id du joueur lié (CROSSED_FATES), consommé au prochain choix de CE joueur
    secretPokemonIndex: null // mode "guess" uniquement : case choisie sur guessBoard, jamais révélée à l'adversaire
  };
  if (accessToken) setImmediate(() => loadPlayerTitle(player)); // après l'ajout du joueur à sa partie
  return player;
}

// Titre équipé du compte (profiles.title), résolu ICI à partir du token vérifié : un client ne peut
// donc pas s'attribuer un titre qu'il n'a pas. Silencieux en cas d'échec (le titre est purement cosmétique).
async function loadPlayerTitle(player) {
  if (!supabase || !createAuthClient || !player.accountAccessToken) return;
  try {
    const { data: { user } } = await createAuthClient().auth.getUser(player.accountAccessToken);
    if (!user) return;
    const { data } = await supabase.from('profiles').select('title').eq('id', user.id).limit(1);
    const label = titleLabelFor(data && data[0] ? data[0].title : '');
    if (label === player.titleLabel) return;
    player.titleLabel = label;
    const game = Object.values(games).find(g => g.players && g.players.includes(player));
    if (!game) return;
    if (game.status === 'waiting') broadcastPlayers(game);
    else if (game.gameMode !== 'guess' && game.gameMode !== 'auction') broadcastGameUpdated(game);
  } catch (err) { /* cosmétique : ignoré */ }
}

// Ne renvoie jamais currentOptions au client (secret tant que le choix n'est pas fait).
// Ne renvoie jamais token non plus (secret de reconnexion : seul le joueur concerné le
// connaît, cf. rejoin_success qui le renvoie uniquement à l'intéressé).
function getPublicPlayers(game) {
  return game.players.map(p => ({
    id: p.id,
    name: p.name,
    avatar: p.avatar,
    titleLabel: p.titleLabel || '',
    disconnected: p.disconnected,
    score: p.score,
    team: p.team,
    typeBonus: p.typeBonus || null, // détail du bonus de type (affichage) — calculé par le serveur
    hasChosen: p.currentChoice !== null,
    secretSelected: p.secretPokemonIndex !== null // mode "guess" : jamais LEQUEL, juste si choisi
  }));
}

function broadcastPlayers(game) {
  io.to(game.id).emit('players_updated', {
    players: getPublicPlayers(game),
    hostId: game.hostId
  });
}

function broadcastGameUpdated(game) {
  if (game.gameMode === 'statdraft') { SD.broadcastPresence(game); return; } // mode isolé : ses propres événements sd_*
  const payload = {
    status: game.status,
    turn: game.turn,
    maxTurns: game.maxTurns,
    route: game.route,
    players: getPublicPlayers(game),
    hostId: game.hostId,
    adminId: game.adminId,
    spectatorCount: game.spectators ? game.spectators.length : 0
  };
  // Coop : score cumulé + objectif d'équipe, recalculés à chaque update (jamais stockés
  // ailleurs que dans les scores individuels + game.boss.teamRequiredPoints).
  if (game.gameMode === 'coop' && game.boss) {
    payload.teamScore = game.players.reduce((sum, p) => sum + p.score, 0);
    payload.teamRequired = game.boss.teamRequiredPoints;
    payload.bossAttackTargetId = game.bossAttackTargetId || null;
  }
  io.to(game.id).emit('game_updated', payload);
}

// Génère et envoie individuellement à chaque joueur ses 2 choix (sprite + nom uniquement).
// Le Charme Chroma (passif, choisi avant le tour 1) agit sur TOUS les tours : meilleures
// raretés et chances de shiny ×2.
function assignTurnOptions(game) {
  // Modificateur MIROIR : UN seul tirage par tour, copié à l'identique pour tous les joueurs (seuls leurs
  // choix HAUT/BAS et leurs objets les différencient). Les effets qui modifient le tirage d'un joueur
  // (Charme Chroma, Tour chanceux, Destins croisés, pitié) sont donc neutralisés pour garder l'égalité.
  const mirrorDraw = gameHasModifier(game, 'mirror')
    ? pickPlayerTurnOptions(false, 0, undefined, undefined, game.gameMode, game.modifiers)
    : null;
  game.players.forEach(p => {
    if (mirrorDraw) {
      p.currentOptions = { ...mirrorDraw, haut: { ...mirrorDraw.haut }, bas: { ...mirrorDraw.bas } };
      p.rarityFloor = null;
      p.rarityBoost = null;
      io.to(p.id).emit('turn_options', {
        haut: { name: p.currentOptions.haut.name, sprite: p.currentOptions.haut.sprite, shiny: p.currentOptions.haut.shiny, shinySprite: p.currentOptions.haut.shinySprite },
        bas: { name: p.currentOptions.bas.name, sprite: p.currentOptions.bas.sprite, shiny: p.currentOptions.bas.shiny, shinySprite: p.currentOptions.bas.shinySprite }
      });
      return;
    }
    // Le Charme Chroma est un objet PASSIF (cf. PASSIVE_ITEMS) : actif dès le tour 1 si le
    // joueur l'a choisi au départ, sans aucune restriction de tour.
    const useCharm = !!p.hasShinyCharm;
    p.currentOptions = pickPlayerTurnOptions(useCharm, p.pity, p.rarityFloor || undefined, p.rarityBoost || undefined, game.gameMode, game.modifiers);
    p.rarityFloor = null; // effet LUCKY_TURN consommé, à usage unique
    p.rarityBoost = null; // effet CROSSED_FATES consommé, à usage unique
    io.to(p.id).emit('turn_options', {
      haut: { name: p.currentOptions.haut.name, sprite: p.currentOptions.haut.sprite, shiny: p.currentOptions.haut.shiny, shinySprite: p.currentOptions.haut.shinySprite },
      bas: { name: p.currentOptions.bas.name, sprite: p.currentOptions.bas.sprite, shiny: p.currentOptions.bas.shiny, shinySprite: p.currentOptions.bas.shinySprite }
    });
  });
}

// Équivalent de assignTurnOptions() pour le mode ADMIN VS JOUEUR : un seul tirage par
// manche (pickAdminModeOptions), stocké sur le JOUEUR (réutilise le champ currentOptions,
// donc player_choice n'a besoin de presque aucune adaptation). Deux payloads DIFFÉRENTS
// envoyés séparément : jamais la même donnée cachée avec un simple flag côté client (cf.
// spec section 5/17) — le serveur ne fait tout simplement pas transiter l'info secrète
// vers la socket du JOUEUR.
//
// admin.currentChoice est mis à une sentinelle ('OBSERVE', jamais une valeur HAUT/BAS
// valide) dès la génération de la manche : l'ADMIN ne joue jamais, mais allReady
// (cf. maybeScheduleTurnTransition) attend currentChoice !== null pour TOUS les joueurs
// présents. Sans cette sentinelle, la manche ne pourrait jamais avancer.
function assignAdminModeOptions(game) {
  const joueur = game.players.find(p => p.id !== game.adminId);
  const admin = game.players.find(p => p.id === game.adminId);
  if (!joueur || !admin) return; // état invalide : ne devrait pas arriver (validé par start_game)

  joueur.currentOptions = pickAdminModeOptions();
  admin.currentChoice = 'OBSERVE';

  io.to(admin.id).emit('admin_view_turn_options', {
    turn: game.turn,
    playerName: joueur.name,
    playerScore: joueur.score,
    haut: { ...joueur.currentOptions.haut },
    bas: { ...joueur.currentOptions.bas }
  });

  io.to(joueur.id).emit('player_turn_hidden', { turn: game.turn });
}

// Lance réellement le tour 1 (route/boss/scores), une fois que TOUS les joueurs ont
// choisi leur objet de départ (cf. socket.on('starting_item_choice')). Émet 'game_started'
// avec l'état complet — jusqu'ici, côté client, seul l'écran de choix d'objet était visible.
function beginRouteGameplay(game, gameId) {
  game.status = 'playing';
  game.turn = 1;
  game.maxTurns = gameHasModifier(game, 'sprint') ? SPRINT_TURNS : MAX_TURNS;
  game.route = buildRoute(game.maxTurns);
  // Cloné (jamais la référence partagée de BOSSES) : en mode coop on ajoute un champ
  // teamRequiredPoints propre à CETTE partie, jamais sur l'objet boss partagé.
  game.boss = { ...pickRandomBoss(game.selectedDifficulty || 'medium') };
  applyBossMechanics(game); // types/faiblesses + calibrage éventuel, AVANT l'objectif coop
  if (game.gameMode === 'coop') {
    game.boss.teamRequiredPoints = computeCoopTeamRequiredPoints(game.boss, game.players.length);
    // Attaque du boss (mécanique exclusive au mode Coop, cf. advanceTurn) : jamais au
    // tour 1 (délai de grâce), donc rien à initialiser tant que le premier tour n'a pas
    // été résolu — juste les champs pour que advanceTurn les trouve définis.
    game.bossAttackTargetId = null;
    game.lastBossAttackTargetId = null;
  }

  io.to(gameId).emit('game_started', {
    gameId: game.id,
    status: game.status,
    turn: game.turn,
    maxTurns: game.maxTurns,
    route: game.route,
    boss: game.boss,
    difficulty: game.selectedDifficulty,
    gameMode: game.gameMode,
    adminId: game.adminId,
    modifiers: game.modifiers || [],
    players: getPublicPlayers(game)
  });
  // État de l'objet : privé à chacun (jamais dans le payload ci-dessus, partagé par toute
  // la room) — chaque joueur reçoit UNIQUEMENT le sien.
  game.players.forEach(p => {
    io.to(p.id).emit('your_item', { item: p.heldItem, used: p.heldItemUsed, passive: PASSIVE_ITEMS.has(p.heldItem) });
  });

  startTurnForPlayers(game);
  persistGame(game);
}

// Démarre un tour pour tous les joueurs. Depuis le passage à l'inventaire d'objets
// (choisis avant le tour 1, cf. start_game/starting_item_choice), il n'y a PLUS de
// tour spécial : tous les tours, tour 4 inclus, suivent le même flux normal.
//
// Mode ADMIN VS JOUEUR : décision de gameplay volontaire — jamais d'objet dans ce mode
// (assignAdminModeOptions gère ses 6 tours identiques lui-même).
function startTurnForPlayers(game) {
  if (game.gameMode === 'fly') {
    FLY.startTurn(game);
    return;
  }
  if (game.gameMode === 'admin') {
    assignAdminModeOptions(game);
    return;
  }
  assignTurnOptions(game);
}

function advanceTurn(game) {
  game.route[game.turn - 1].status = 'done';
  game.turn += 1;
  game.route[game.turn - 1].status = 'current';
  game.players.forEach(p => {
    p.currentChoice = null;
    p.currentOptions = null;
    p.pendingBonusKey = null;
    if (p.activeEvent) {
      // Un événement non résolu avant le tour suivant expire : le joueur DOIT en être
      // informé, sinon son overlay reste ouvert indéfiniment (softlock côté client,
      // ses boutons ne feraient plus qu'échouer silencieusement contre un activeEvent nul).
      p.activeEvent = null;
      io.to(p.id).emit('rare_event_cancelled', { reason: 'expired' });
    }
    if (p.eventCooldown > 0) p.eventCooldown -= 1;
  });
  // Attaque du boss (Coop uniquement) : jamais au tour 1 (délai de grâce le temps que
  // tout le monde prenne ses marques), ~40% de chance chaque tour suivant, jamais 2 fois
  // de suite sur la même personne tant qu'un autre joueur connecté est disponible. La
  // cible perd la moitié des points de CE tour (cf. player_choice), consommé dès qu'elle
  // choisit — pas de cumul si elle traîne plusieurs tours sans jouer.
  if (game.gameMode === 'coop') {
    game.bossAttackTargetId = null;
    if (game.turn > 1 && Math.random() < 0.4) {
      const eligible = game.players.filter(p => !p.disconnected);
      const pool = eligible.length > 1
        ? eligible.filter(p => p.id !== game.lastBossAttackTargetId)
        : eligible;
      if (pool.length > 0) {
        const target = pool[Math.floor(Math.random() * pool.length)];
        game.bossAttackTargetId = target.id;
        game.lastBossAttackTargetId = target.id;
      }
    }
  }
  broadcastGameUpdated(game);
  startTurnForPlayers(game);
}

function finishGame(game) {
  if (game.gameMode === 'fly') {
    // Aucun boss, aucun bonus de type, aucun objectif : cf. fly-game.js
    game.status = 'finished';
    game.route[game.route.length - 1].status = 'done';
    FLY.finish(game);
    return;
  }
  // Filet de sécurité : score final = score brut + bonus de type de l'équipe FINALE, quel que
  // soit le chemin qui a modifié l'équipe (idempotent : sans effet si déjà à jour).
  game.players.forEach(p => syncTypeBonus(p, game));
  game.status = 'finished';
  deletePersistedGame(game.id); // partie finie : plus jamais besoin de la restaurer après un redémarrage
  game.route[game.route.length - 1].status = 'done';

  // Mode COOP : AUCUN résultat individuel — victoire/défaite = même verdict pour toute
  // l'équipe, basé sur la SOMME des scores contre teamRequiredPoints (cf. computeCoop-
  // TeamRequiredPoints). Branche isolée, retournée avant la logique normal/admin ci-dessous
  // (result par-joueur n'a pas de sens ici).
  if (game.gameMode === 'coop') {
    const teamScore = game.players.reduce((sum, p) => sum + p.score, 0);
    const teamWon = teamScore >= game.boss.teamRequiredPoints;
    const coopResults = game.players.map(p => ({
      id: p.id, name: p.name, avatar: p.avatar, score: p.score, team: p.team, typeBonus: p.typeBonus || null,
      result: teamWon ? 'victory' : 'defeat'
    }));
    game.players.forEach(p => {
      recordGameResult(p, XP_PARTICIPATION + (teamWon ? XP_VICTORY_BONUS : 0), {
        gameMode: game.gameMode,
        result: teamWon ? 'victory' : 'defeat',
        score: p.score,
        opponentName: null,
        difficulty: game.selectedDifficulty || null,
        team: p.team
      });
    });
    io.to(game.id).emit('game_finished', {
      boss: game.boss,
      difficulty: game.selectedDifficulty,
      gameMode: game.gameMode,
      adminId: game.adminId,
      route: game.route,
      players: coopResults,
      teamScore,
      teamRequired: game.boss.teamRequiredPoints,
      modifiers: game.modifiers || []
    });
    emitGameRecaps(game);
    return;
  }

  // Mode ADMIN VS JOUEUR : un seul résultat réel (celui du JOUEUR, seul à avoir un score).
  // L'ADMIN n'a pas sa propre victoire/défaite : la sienne est l'INVERSE de celle du
  // JOUEUR (cf. spec section 20 — JOUEUR gagne = ADMIN perd, et inversement). Sans ce
  // cas particulier, l'ADMIN (score toujours à 0) serait toujours marqué "defeat", même
  // quand le JOUEUR l'emporte.
  const joueur = game.gameMode === 'admin' ? game.players.find(p => p.id !== game.adminId) : null;
  const joueurWon = joueur ? joueur.score >= game.boss.requiredPoints : null;

  // Modificateur MIROIR (mode normal, 2 joueurs ou plus) : tirages identiques pour tous, donc le MEILLEUR
  // SCORE gagne (égalité = victoire partagée), indépendamment de l'objectif du boss.
  const mirrorBest = (game.gameMode === 'normal' && gameHasModifier(game, 'mirror') && game.players.length >= 2)
    ? Math.max(...game.players.map(p => p.score))
    : null;

  const results = game.players.map(p => {
    if (game.gameMode === 'admin' && p.id === game.adminId) {
      return { id: p.id, name: p.name, avatar: p.avatar, score: p.score, team: p.team, result: joueurWon ? 'defeat' : 'victory' };
    }
    if (mirrorBest !== null) {
      return {
        id: p.id, name: p.name, avatar: p.avatar, score: p.score, team: p.team,
        typeBonus: p.typeBonus || null,
        result: p.score >= mirrorBest ? 'victory' : 'defeat'
      };
    }
    return {
      id: p.id,
      name: p.name,
      avatar: p.avatar,
      score: p.score,
      team: p.team,
      typeBonus: p.typeBonus || null,
      result: p.score >= game.boss.requiredPoints ? 'victory' : 'defeat'
    };
  });

  // XP + historique (fire-and-forget, cf. recordGameResult) : participation pour tous,
  // bonus pour qui a gagné.
  game.players.forEach(p => {
    const r = results.find(x => x.id === p.id);
    const opponent = game.players.find(x => x.id !== p.id);
    recordGameResult(p, XP_PARTICIPATION + (r && r.result === 'victory' ? XP_VICTORY_BONUS : 0), {
      gameMode: game.gameMode,
      result: r ? r.result : 'defeat',
      score: p.score,
      opponentName: opponent ? opponent.name : null,
      difficulty: game.selectedDifficulty || null,
      team: p.team
    });
  });

  io.to(game.id).emit('game_finished', {
    boss: game.boss,
    difficulty: game.selectedDifficulty,
    gameMode: game.gameMode,
    adminId: game.adminId,
    route: game.route,
    modifiers: game.modifiers || [],
    players: results
  });
  emitGameRecaps(game);
}

// RÉCAP DE FIN DE PARTIE (par joueur, calculé ICI à partir de l'équipe finale, envoyé via
// 'game_recap' juste après game_finished). Gain d'un trait = points du Pokémon avec son trait
// moins ses points « neutres » (le ×shiny intégré au multiplicateur n'est pas attribué au trait).
function buildPlayerRecap(player) {
  const team = Array.isArray(player.team) ? player.team : [];
  const traitMons = team
    .filter(mon => EFFECTS.some(e => e.name !== 'Neutre' && e.name === mon.effectName))
    .map(mon => {
      const shinyFactor = mon.shinyInMultiplier ? SHINY_POINTS_MULTIPLIER : 1;
      const gain = Math.round(mon.basePoints * mon.multiplier) + (mon.flat || 0) - Math.round(mon.basePoints * shinyFactor);
      const multiplier = mon.gambleRoll != null ? mon.gambleRoll : traitDisplayMultiplier(mon);
      return { mon, gain, trait: { name: mon.effectName, multiplier, flat: mon.flat || 0 } };
    });
  const toEntry = t => ({ pokemonName: t.mon.name, sprite: t.mon.sprite, trait: t.trait, gain: t.gain });
  const best = traitMons.filter(t => t.gain > 0).sort((a, b) => b.gain - a.gain)[0];
  const worst = traitMons.filter(t => t.gain < 0).sort((a, b) => a.gain - b.gain)[0];
  const gambles = traitMons.filter(t => t.mon.gambleRoll != null).sort((a, b) => b.mon.gambleRoll - a.mon.gambleRoll || b.gain - a.gain);
  return {
    bestTrait: best ? toEntry(best) : null,
    worstTrait: worst ? toEntry(worst) : null,
    bigGamble: gambles[0] ? { ...toEntry(gambles[0]), roll: gambles[0].mon.gambleRoll } : null,
    worstChoice: player.worstChoice || null
  };
}

function emitGameRecaps(game) {
  game.players.forEach(p => {
    if (game.gameMode === 'admin' && p.id === game.adminId) return; // l'admin n'a pas d'équipe
    io.to(p.id).emit('game_recap', buildPlayerRecap(p));
  });
}

// Résout la transition de tour (avance ou termine la partie). Appelé soit par le
// timer de révélation (~4s), soit immédiatement par skip_reveal en solo.
function resolveTurnTransition(game) {
  game.turnTimer = null;
  if (game.turn >= game.maxTurns) {
    finishGame(game);
  } else {
    advanceTurn(game);
  }
}

// Un événement bloque la transition de tour tant qu'il n'est pas résolu, SAUF DUEL :
// DUEL est le seul événement conçu pour ne jamais bloquer les autres joueurs (cf. spec
// multijoueur d'origine — 2 joueurs sur N, les autres continuent normalement). Tous les
// autres événements interactifs (solo) doivent laisser au joueur tout le temps nécessaire :
// un choix en 2 étapes (ex: DOUBLE RENCONTRE) ne tient pas dans les 4s de révélation.
function hasBlockingEvent(player) {
  return !!player.activeEvent && player.activeEvent.type !== EVENT_TYPES.DUEL;
}

// Une fois que tous les joueurs présents ont choisi ET qu'aucun n'a d'événement bloquant
// en cours, laisse ~4s de révélation avant de faire avancer le tour (ou de terminer la
// partie), pour tout le monde en même temps.
function maybeScheduleTurnTransition(game) {
  if (game.status !== 'playing') return;
  if (game.turnTimer) return; // déjà planifié, ne pas doubler
  if (game.gameMode === 'fly' && !(game.fly && game.fly.revealed)) return; // la Mouche n'a pas encore révélé son choix

  const allReady = game.players.length > 0 && game.players.every(p => p.currentChoice !== null && !hasBlockingEvent(p));
  if (!allReady) return;

  game.turnTimer = setTimeout(() => resolveTurnTransition(game), REVEAL_DELAY_MS);
}

// Point de sortie commun à la fin d'un tour, que le joueur ait choisi POKÉMON (HAUT/BAS)
// ou BONUS (ancien flux du tour 4, supprimé) — un seul chemin de code pour
// diffuser l'état et planifier la transition, évite toute divergence entre les deux flux.
// C'est aussi le point d'accroche des événements rares : tirés pour CE joueur uniquement,
// jamais pour les autres. Le tirage doit précéder la vérification de transition : un
// événement fraîchement déclenché doit pouvoir bloquer le passage au tour suivant tant
// qu'il n'est pas résolu (cf. hasBlockingEvent) — sauf DUEL, jamais bloquant.
//
// Mode ADMIN VS JOUEUR : les événements rares sont désactivés pour l'instant (cf. spec
// section 18). Les événements à deux joueurs (DUEL/CROSSED_FATES) chercheraient
// un "adversaire" via pickEventOpponent — en mode admin, le seul autre joueur présent
// est l'ADMIN, qui n'a ni score ni équipe : les activer sans adaptation lui attribuerait
// à tort des points/Pokémon. À réintroduire, événement par événement, une fois vérifiés
// compatibles avec ce mode.
function finalizePlayerTurn(game, player) {
  broadcastGameUpdated(game);
  if (game.gameMode === 'fly') {
    // Événements rares désactivés (comme en admin, dans un premier temps)
    FLY.onHumanChose(game);
    maybeScheduleTurnTransition(game);
    return;
  }
  if (player && game.gameMode !== 'admin') {
    applyCrossedFatesLink(game, player);
    maybeTriggerEvent(game, player);
  }
  maybeScheduleTurnTransition(game);
}

// Retire réellement un joueur déjà sorti de game.players et gère toutes les conséquences
// (DUEL partagé, suppression de la partie si elle se retrouve vide, réassignation de
// l'hôte, reset du rôle ADMIN en lobby, forfait en mode ADMIN VS JOUEUR, transition de
// tour). Ne dépend d'AUCUNE socket : appelable longtemps après qu'elle a disparu, ce qui
// est exactement le cas quand le délai de grâce de reconnexion expire (cf. RECONNECT_GRACE_MS).
function finalizePlayerRemoval(game, gameId, leavingPlayer) {
  // Événement à deux joueurs (DUEL) : si celui qui part y participait, l'autre ne doit
  // jamais rester bloqué à attendre indéfiniment un choix qui ne viendra plus.
  if (leavingPlayer.activeEvent && Array.isArray(leavingPlayer.activeEvent.participants)) {
    const shared = leavingPlayer.activeEvent;
    shared.participants
      .filter(id => id !== leavingPlayer.id)
      .forEach(id => {
        const partner = game.players.find(p => p.id === id);
        if (partner && partner.activeEvent === shared) {
          partner.activeEvent = null;
          io.to(partner.id).emit('rare_event_cancelled', { type: shared.type });
        }
      });
  }

  if (game.players.length === 0) {
    if (game.turnTimer) clearTimeout(game.turnTimer);
    if (game.guessTurnTimer) clearTimeout(game.guessTurnTimer); // sinon timer zombie qui retient `game` en mémoire et peut encore tenter d'émettre sur un salon mort
    clearSpectators(game, gameId);
    FLY.dispose(game); // mode fly : abandon = aucun apprentissage
    SD.dispose(game); // mode Roulette de Stats : timer de tirage
    delete games[gameId];
    deletePersistedGame(gameId);
    return;
  }

  if (game.hostId === leavingPlayer.id) {
    game.hostId = game.players[0].id;
  }

  if (game.status === 'waiting') {
    // L'ADMIN choisi qui quitte le lobby n'a plus de sens : l'hôte doit re-choisir
    // (cf. set_admin_role, qui revalide de toute façon qu'il reste 2 joueurs).
    if (game.adminId === leavingPlayer.id) {
      game.adminId = null;
      io.to(gameId).emit('admin_role_updated', { adminId: null });
    }
    // Idem pour la sélection des 2 joueurs actifs (mode admin/guess à >2 joueurs) : si
    // l'un des 2 choisis quitte, la sélection entière n'a plus de sens.
    if (game.activePlayerIds && game.activePlayerIds.includes(leavingPlayer.id)) {
      game.activePlayerIds = null;
      io.to(gameId).emit('active_players_updated', { activePlayerIds: null, adminId: game.adminId });
    }
    broadcastPlayers(game);
    return;
  }

  // Mode ADMIN VS JOUEUR : la manche est un tirage partagé (cf. assignAdminModeOptions) —
  // si l'ADMIN ou le JOUEUR quitte en cours de partie (pour de bon : délai de grâce déjà
  // écoulé), l'autre ne peut plus jamais recevoir de nouvelle manche (softlock silencieux).
  // Victoire par forfait plutôt que de le laisser bloqué sans explication.
  if (game.status === 'playing' && game.gameMode === 'admin') {
    finishAdminModeByForfeit(game, leavingPlayer);
    return;
  }

  // Mode DEVINE LE POKÉMON : strictement 2 joueurs, aucune continuation possible seul —
  // même principe de victoire par forfait.
  if (game.status === 'playing' && game.gameMode === 'guess') {
    finishGuessGameByForfeit(game, leavingPlayer);
    return;
  }

  // Mode DRAFT/ENCHÈRES : strictement 2 joueurs, aucun banc/spectateur pour continuer
  // seul — fin de partie immédiate, chacun repart avec l'équipe qu'il avait.
  if (game.status === 'playing' && game.gameMode === 'auction') {
    finishAuctionGameByForfeit(game, leavingPlayer);
    return;
  }

  // Mode ROULETTE DE STATS : la partie continue avec les joueurs restants (cf. statdraft-game.js).
  if (game.status === 'playing' && game.gameMode === 'statdraft') {
    SD.onPlayerRemoved(game, leavingPlayer);
    return;
  }

  broadcastGameUpdated(game);
  maybeScheduleTurnTransition(game);
}

// Départ EXPLICITE (bouton "Quitter", ou nettoyage avant de créer/rejoindre une autre
// partie) : toujours immédiat, jamais de délai de grâce — contrairement à une simple
// déconnexion réseau (cf. handleSocketDisconnect), cliquer sur "Quitter" est un choix
// délibéré, pas un accident dont on pourrait vouloir revenir.
function leaveCurrentGame(socket) {
  const gameId = socket.data.gameId;
  if (!gameId) return;

  const game = games[gameId];
  if (!game) return;

  const leavingPlayer = game.players.find(p => p.id === socket.id);
  if (!leavingPlayer) {
    socket.data.gameId = null;
    return;
  }
  if (leavingPlayer.disconnectTimer) clearTimeout(leavingPlayer.disconnectTimer);

  game.players = game.players.filter(p => p.id !== socket.id);
  socket.leave(gameId);
  socket.data.gameId = null;

  finalizePlayerRemoval(game, gameId, leavingPlayer);
}

// Construit le payload spectateur adapté au mode de jeu — UN SEUL point de construction
// (plutôt que dupliqué à chaque endroit qui bascule quelqu'un en spectateur : lancement
// avec banc, rejoint via code sur une partie déjà en cours, transfert lors de "Rejouer").
// Règle de sécurité : ne JAMAIS montrer à un spectateur plus que ce que verrait le joueur
// le MOINS informé des deux — cf. l'enchère semi-aveugle, où même un spectateur ne doit
// jamais voir le Pokémon du lot en cours (il pourrait le révéler au joueur aveugle par
// Discord, ce qui viderait le mode de son intérêt).
function buildSpectatePayload(game) {
  const base = {
    gameId: game.id,
    status: game.status,
    hostId: game.hostId,
    gameMode: game.gameMode,
    difficulty: game.selectedDifficulty,
    spectatorCount: game.spectators.length
  };

  if (game.gameMode === 'guess') {
    return {
      ...base,
      players: getPublicPlayers(game),
      activePlayerId: game.guessActivePlayerId || null,
      turnEndsAt: game.guessTurnEndsAt || null,
      turnDurationMs: game.guessTurnDurationMs || GUESS_TURN_DURATION_MS,
      chatMessages: game.chatMessages
    };
  }

  if (game.gameMode === 'auction') {
    const lot = game.auctionLot;
    const hideLotPokemon = !!lot && game.auctionType === 'semi_blind';
    return {
      ...base,
      players: getPublicAuctionPlayers(game),
      auctionType: game.auctionType,
      lot: lot ? {
        pokemon: hideLotPokemon ? null : lot.pokemon,
        mystery: hideLotPokemon,
        currentBid: lot.currentBid,
        currentBidderId: lot.currentBidderId,
        activePlayerId: lot.activePlayerId
      } : null,
      lotsRemaining: game.auctionPool ? game.auctionPool.length : 0,
      chatMessages: game.chatMessages
    };
  }

  // normal / admin
  return {
    ...base,
    turn: game.turn,
    maxTurns: game.maxTurns,
    boss: game.boss || null,
    route: game.route || null,
    players: getPublicPlayers(game),
    adminId: game.adminId,
    chatMessages: game.chatMessages
  };
}

// ---------- MODE SPECTATEUR ----------
// Rejoindre une partie déjà démarrée place la socket en simple observateur : elle rejoint
// le même salon Socket.IO que les joueurs, ce qui suffit à recevoir toutes les diffusions
// déjà PUBLIQUES (game_updated, game_finished, guess_turn_started, auction_bid_update...)
// sans aucun changement côté serveur — tout ce qui est secret (turn_options,
// choice_result, vue ADMIN...) est déjà ciblé individuellement par id de joueur ailleurs
// dans ce fichier, jamais diffusé au salon entier. Un spectateur n'entre JAMAIS dans
// game.players : aucun impact sur le tour, le score, ou la logique de partie.
function removeSpectator(socket) {
  const gameId = socket.data.spectateGameId;
  if (!gameId) return;
  socket.data.spectateGameId = null;
  socket.leave(gameId);

  const game = games[gameId];
  if (!game || !game.spectators) return;
  game.spectators = game.spectators.filter(s => s.id !== socket.id);
  // broadcastGameUpdated() a un payload façonné pour Route du Boss (route/turn/maxTurns) :
  // en mode "guess"/"auction", ce n'est jamais ce que les joueurs actifs écoutent (leurs
  // mises à jour passent par guess_players_updated/auction_bid_update etc.), donc on ne
  // diffuse le compteur de spectateurs que pour les modes normal/admin.
  if (game.gameMode !== 'guess' && game.gameMode !== 'auction') {
    broadcastGameUpdated(game); // met à jour spectatorCount pour les joueurs restants
  }
}

// Coupe proprement les spectateurs quand la partie elle-même disparaît (plus aucun
// joueur), pour ne pas les laisser accrochés à un salon Socket.IO orphelin.
function clearSpectators(game, gameId) {
  if (!game.spectators || game.spectators.length === 0) return;
  game.spectators.forEach(spec => {
    const specSocket = io.sockets.sockets.get(spec.id);
    if (specSocket) {
      specSocket.emit('spectate_ended', { reason: 'no_players' });
      specSocket.leave(gameId);
      specSocket.data.spectateGameId = null;
    }
  });
  game.spectators = [];
}

// Mode admin/guess à >2 joueurs dans le lobby (cf. socket.on('start_game')) : les
// joueurs non retenus par l'hôte (set_active_players) basculent en spectateurs de CETTE
// MÊME partie au moment du lancement — déjà dans le salon Socket.IO (aucun join/leave
// réseau nécessaire), juste un changement de rôle côté serveur + un spectate_joined pour
// que leur client bascule sur #screen-spectate avant que game_started/guess_game_started
// (diffusés à tout le salon juste après) n'arrivent.
function benchExtraPlayersAsSpectators(game, gameId, benchedPlayers) {
  if (!benchedPlayers || benchedPlayers.length === 0) return;
  benchedPlayers.forEach(p => {
    game.spectators.push({ id: p.id, name: p.name });
    const s = io.sockets.sockets.get(p.id);
    if (!s) return;
    s.data.gameId = null;
    s.data.spectateGameId = gameId;
    s.emit('spectate_joined', buildSpectatePayload(game));
  });
}

// Déconnexion RÉSEAU (perte de connexion, refresh de page, onglet fermé...) : jamais
// distinguable côté serveur d'un abandon volontaire, donc on donne toujours le bénéfice
// du doute si la partie est en cours (cf. RECONNECT_GRACE_MS). En lobby/partie finie,
// les enjeux sont trop faibles pour justifier la complexité : retrait immédiat, comme
// avant.
function handleSocketDisconnect(socket) {
  // Spectateur : aucun enjeu de partie (pas de délai de grâce), retrait immédiat.
  if (socket.data.spectateGameId) {
    removeSpectator(socket);
    return;
  }

  const gameId = socket.data.gameId;
  if (!gameId) return;

  const game = games[gameId];
  if (!game) {
    socket.data.gameId = null;
    return;
  }

  const player = game.players.find(p => p.id === socket.id);
  if (!player) {
    socket.data.gameId = null;
    return;
  }

  if (game.status !== 'playing') {
    leaveCurrentGame(socket);
    return;
  }

  player.disconnected = true;
  socket.data.gameId = null; // cette socket-ci ne représente plus ce joueur
  broadcastGameUpdated(game); // les autres voient tout de suite le badge "hors ligne"

  player.disconnectTimer = setTimeout(() => {
    game.players = game.players.filter(p => p.token !== player.token);
    finalizePlayerRemoval(game, gameId, player);
  }, RECONNECT_GRACE_MS);
}

// Termine immédiatement une partie ADMIN VS JOUEUR quand l'un des deux quitte en cours
// de jeu : victoire par forfait pour celui qui reste, défaite pour celui qui est parti —
// peu importe le rôle de chacun (contrairement à finishGame(), qui inverse spécifiquement
// le résultat de l'ADMIN par rapport au score du JOUEUR : ici il n'y a pas de "score
// atteint", juste un abandon). leavingPlayer est capturé par leaveCurrentGame() AVANT
// d'être retiré de game.players, sinon son score/équipe finaux seraient perdus.
function finishAdminModeByForfeit(game, leavingPlayer) {
  if (game.turnTimer) {
    clearTimeout(game.turnTimer);
    game.turnTimer = null;
  }
  game.status = 'finished';
  deletePersistedGame(game.id); // partie finie : plus jamais besoin de la restaurer après un redémarrage

  const remaining = game.players[0]; // un seul joueur restant, cf. leaveCurrentGame()
  const results = [leavingPlayer, remaining]
    .filter(Boolean)
    .map(p => ({
      id: p.id,
      name: p.name,
      avatar: p.avatar,
      score: p.score,
      team: p.team,
      result: p.id === leavingPlayer.id ? 'defeat' : 'victory'
    }));

  // XP + historique (fire-and-forget) : le joueur qui a quitté n'a que la participation,
  // celui qui reste (victoire par forfait) touche aussi le bonus.
  recordGameResult(leavingPlayer, XP_PARTICIPATION, {
    gameMode: game.gameMode, result: 'defeat', score: leavingPlayer.score,
    opponentName: remaining ? remaining.name : null,
    difficulty: game.selectedDifficulty || null,
    team: leavingPlayer.team
  });
  if (remaining) {
    recordGameResult(remaining, XP_PARTICIPATION + XP_VICTORY_BONUS, {
      gameMode: game.gameMode, result: 'victory', score: remaining.score,
      opponentName: leavingPlayer.name,
      difficulty: game.selectedDifficulty || null,
      team: remaining.team
    });
  }

  io.to(game.id).emit('game_finished', {
    boss: game.boss,
    difficulty: game.selectedDifficulty,
    gameMode: game.gameMode,
    adminId: game.adminId,
    reason: 'forfeit',
    route: game.route,
    modifiers: game.modifiers || [],
    players: results
  });
  emitGameRecaps(game);
}

io.on('connection', (socket) => {
  // Présence en ligne pour les amis (cf. onlineAccounts plus haut) : indépendant de toute
  // partie, un compte connecté sur l'accueil doit déjà pouvoir recevoir une invitation.
  // Jamais un pré-requis : un client qui n'appelle jamais ceci fonctionne normalement,
  // juste invisible pour ses amis.
  socket.on('identify_account', async ({ accessToken } = {}) => {
    if (!accessToken || !createAuthClient) return;
    try {
      const { data: { user } } = await createAuthClient().auth.getUser(accessToken);
      if (!user) return;
      socket.data.accountUserId = user.id;
      registerAccountSocket(user.id, socket.id);
    } catch (err) {
      // Jeton invalide/expiré : on ignore simplement, pas d'impact sur le reste du jeu.
    }
  });

  // Envoie une invitation à un ami actuellement connecté (n'importe où — pas
  // nécessairement dans une partie), à rejoindre la partie du joueur courant. Ne fait
  // RIEN si l'ami n'est pas en ligne (cf. isAccountOnline) : pas de file d'attente, pas
  // de notification différée, uniquement du temps réel.
  socket.on('invite_friend', ({ friendUserId, fromPseudo, fromAvatar } = {}) => {
    const gameId = socket.data.gameId;
    if (!gameId || !friendUserId || !onlineAccounts[friendUserId]) return;
    onlineAccounts[friendUserId].forEach(sid => {
      io.to(sid).emit('friend_game_invite', {
        gameId,
        fromPseudo: fromPseudo || 'Un ami',
        fromAvatar: fromAvatar || null
      });
    });
  });

  socket.on('create_game', ({ name, token, avatar, accessToken } = {}) => {
    const trimmed = (name || '').trim();
    if (!trimmed) {
      socket.emit('error_message', 'Pseudo requis.');
      return;
    }

    // Si ce socket était déjà dans une autre partie (ex. retour en arrière du
    // navigateur), on le retire proprement avant d'en créer une nouvelle : sinon son
    // ancienne entrée reste orpheline dans games[oldId], qui n'avance plus jamais.
    leaveCurrentGame(socket);
    removeSpectator(socket); // idem si le socket observait une partie en spectateur

    const gameId = generateGameId();

    games[gameId] = {
      id: gameId,
      status: 'waiting',
      turn: 0,
      maxTurns: MAX_TURNS,
      hostId: socket.id,
      boss: null, // choisi aléatoirement au démarrage (start_game), identique pour tous les joueurs
      selectedDifficulty: 'medium', // choisi par l'hôte dans le lobby ; défaut = MOYEN
      gameMode: 'normal', // 'normal' | 'admin' | 'guess' | 'auction' — choisi par l'hôte dans le lobby, cf. set_game_mode
      adminId: null, // id du joueur ADMIN si gameMode === 'admin', cf. set_admin_role
      modifiers: [], // clés de GAME_MODIFIERS choisies par l'hôte (modes normal/coop), cf. set_modifiers
      route: buildRoute(),
      turnTimer: null,
      // ---- Mode "guess" (Devine le Pokémon) uniquement, cf. startGuessGame() ----
      guessBoard: null,
      guessActivePlayerId: null,
      guessTurnEndsAt: null,
      guessTurnTimer: null,
      guessWinnerId: null,
      guessTurnDurationMs: GUESS_TURN_DURATION_MS, // réglable par l'hôte, cf. set_guess_turn_duration
      players: [makePlayer(socket.id, trimmed, token, avatar, accessToken)],
      spectators: [], // cf. socket.on('join_game') : { id, name } uniquement, jamais de state de jeu
      activePlayerIds: null, // [id, id] : qui joue réellement en mode admin/guess à >2 joueurs dans le lobby (cf. set_active_players) ; ignoré/null tant qu'il n'y a que 2 joueurs
      // ---- Mode "auction" (Draft / Enchères) uniquement, cf. startAuctionGame() ----
      auctionType: null, // 'complete' | 'semi_blind', choisi par l'hôte avant de démarrer (cf. set_auction_type)
      auctionPool: [], // lots restants (mélangés, sans répétition), rempli au démarrage
      auctionHistory: [], // [{ pokemon:{id,name,sprite}, winnerId, winnerName, price }], dans l'ordre
      auctionLot: null, // lot en cours : { pokemon, currentBid, currentBidderId, activePlayerId, seerId }
      auctionBlindSeerId: null, // id du joueur qui VOIT au lot en cours (semi_blind uniquement) ; alterne à chaque lot
      auctionBidStarterId: null, // id du joueur qui ouvre les enchères du lot en cours (tour par tour) ; alterne à chaque lot
      chatMessages: [] // discussion texte de la partie : { id, name, avatar, isSpectator, text, ts } — jamais persisté au-delà de la session, cf. socket.on('chat_message')
    };

    socket.join(gameId);
    socket.data.gameId = gameId;

    socket.emit('game_created', {
      gameId,
      token: games[gameId].players[0].token,
      players: getPublicPlayers(games[gameId]),
      hostId: games[gameId].hostId,
      difficulty: games[gameId].selectedDifficulty,
      gameMode: games[gameId].gameMode,
      adminId: games[gameId].adminId,
      activePlayerIds: games[gameId].activePlayerIds,
      guessTurnDurationMs: games[gameId].guessTurnDurationMs,
      auctionType: games[gameId].auctionType,
      modifiers: games[gameId].modifiers || []
    });
  });

  socket.on('join_game', ({ name, gameId, token, avatar, accessToken } = {}) => {
    const trimmedName = (name || '').trim();
    const id = (gameId || '').trim().toUpperCase();
    const game = games[id];

    if (!trimmedName) {
      socket.emit('error_message', 'Pseudo requis.');
      return;
    }
    if (!game) {
      socket.emit('error_message', 'Partie introuvable.');
      return;
    }
    if (game.gameMode === 'fly' && socket.data.gameId !== id) {
      socket.emit('error_message', 'Cette partie est un duel Humanité vs Mouche : elle ne peut pas être rejointe.');
      return;
    }
    if (game.gameMode === 'statdraft' && game.status !== 'waiting' && socket.data.gameId !== id) {
      socket.emit('error_message', 'Roulette de Stats : partie en cours, elle ne peut pas être rejointe ni observée.');
      return;
    }
    if (game.status !== 'waiting') {
      // Partie déjà démarrée : mode spectateur, tous modes confondus. Un spectateur
      // n'entre JAMAIS dans game.players : voir clearSpectators/removeSpectator plus
      // haut pour le détail de ce que ça implique. Le payload exact (ce qu'un
      // spectateur a le droit de voir) est décidé par buildSpectatePayload selon le
      // mode — jamais construit ici.
      if (!trimmedName) {
        socket.emit('error_message', 'Pseudo requis.');
        return;
      }
      // Même précaution que pour un joueur : ne jamais laisser une socket accrochée à
      // deux parties/rôles à la fois.
      if (socket.data.gameId) leaveCurrentGame(socket);
      if (socket.data.spectateGameId && socket.data.spectateGameId !== id) removeSpectator(socket);

      if (!game.spectators.some(s => s.id === socket.id)) {
        game.spectators.push({ id: socket.id, name: trimmedName });
      }
      socket.join(id);
      socket.data.spectateGameId = id;

      socket.emit('spectate_joined', buildSpectatePayload(game));
      // broadcastGameUpdated() ne convient qu'à normal/admin (cf. removeSpectator) — les
      // joueurs de ces 2 modes voient tout de suite le compteur de spectateurs bouger ;
      // pour guess/auction, le prochain événement de partie (déjà room-wide) portera le
      // compteur à jour de toute façon, cf. buildSpectatePayload > spectatorCount.
      if (game.gameMode !== 'guess' && game.gameMode !== 'auction') {
        broadcastGameUpdated(game);
      }
      return;
    }

    // Même précaution que create_game : quitte proprement toute AUTRE partie précédente
    // avant de rejoindre celle-ci. Si c'est déjà cette partie-là, ne pas dupliquer
    // l'entrée joueur : renvoyer simplement l'état actuel.
    if (socket.data.gameId === id) {
      const self = game.players.find(p => p.id === socket.id);
      socket.emit('game_joined', {
        gameId: id,
        token: self ? self.token : token,
        players: getPublicPlayers(game),
        hostId: game.hostId,
        difficulty: game.selectedDifficulty,
        gameMode: game.gameMode,
        adminId: game.adminId,
        activePlayerIds: game.activePlayerIds,
        guessTurnDurationMs: game.guessTurnDurationMs,
        auctionType: game.auctionType,
        modifiers: game.modifiers || []
      });
      return;
    }
    if (socket.data.gameId) {
      leaveCurrentGame(socket);
    }
    removeSpectator(socket); // idem si le socket observait une AUTRE partie en spectateur

    const newPlayer = makePlayer(socket.id, trimmedName, token, avatar, accessToken);
    game.players.push(newPlayer);

    socket.join(id);
    socket.data.gameId = id;

    socket.emit('game_joined', {
      gameId: id,
      token: newPlayer.token,
      players: getPublicPlayers(game),
      hostId: game.hostId,
      difficulty: game.selectedDifficulty,
      gameMode: game.gameMode,
      adminId: game.adminId,
      activePlayerIds: game.activePlayerIds,
      guessTurnDurationMs: game.guessTurnDurationMs,
      auctionType: game.auctionType,
      modifiers: game.modifiers || []
    });
    if (game.gameMode === 'statdraft') SD.syncLobby(game, socket); // modificateurs du mode Roulette de Stats

    broadcastPlayers(game);
  });

  socket.on('leave_game', () => {
    if (socket.data.spectateGameId) {
      removeSpectator(socket);
      return;
    }
    leaveCurrentGame(socket);
  });

  // ---------- Réactions rapides (🔥😭💀⚡) ----------
  // Petite couche purement sociale, sans aucun effet sur la logique de jeu : diffusée à
  // TOUT le salon (joueurs + spectateurs), avec juste assez de garde-fous pour éviter le
  // spam (emoji whitelist + cooldown court par socket).
  const REACTION_EMOJIS = ['🔥', '😭', '💀', '⚡'];
  const REACTION_COOLDOWN_MS = 400;

  socket.on('send_reaction', ({ emoji } = {}) => {
    const gameId = socket.data.gameId || socket.data.spectateGameId;
    const game = games[gameId];
    if (!game) return;
    if (!REACTION_EMOJIS.includes(emoji)) return;

    const now = Date.now();
    if (socket.data.lastReactionAt && now - socket.data.lastReactionAt < REACTION_COOLDOWN_MS) return;
    socket.data.lastReactionAt = now;

    const player = game.players.find(p => p.id === socket.id);
    const spectator = !player && game.spectators ? game.spectators.find(s => s.id === socket.id) : null;
    const playerName = player ? player.name : (spectator ? spectator.name : null);
    if (!playerName) return; // ni joueur ni spectateur de cette partie : rien à diffuser

    io.to(gameId).emit('reaction', { playerId: socket.id, playerName, emoji });
  });

  // Discussion texte de la partie (n'importe quel mode) : relayée à tout le salon
  // Socket.IO, joueurs ET spectateurs compris (déjà dans le même salon, cf. le
  // commentaire MODE SPECTATEUR plus bas) — jamais stockée au-delà de la session, jamais
  // persistée en base. Même throttle anti-spam que les réactions rapides, en un peu plus
  // large (le texte demande plus de temps à taper que de cliquer une réaction).
  const CHAT_COOLDOWN_MS = 600;
  const CHAT_MAX_LENGTH = 300;
  const CHAT_HISTORY_LIMIT = 50; // pour un spectateur qui rejoint en cours de partie
  socket.on('chat_message', ({ text } = {}) => {
    const gameId = socket.data.gameId || socket.data.spectateGameId;
    const game = games[gameId];
    if (!game) return;

    const trimmed = (typeof text === 'string' ? text : '').trim().slice(0, CHAT_MAX_LENGTH);
    if (!trimmed) return;

    const now = Date.now();
    if (socket.data.lastChatAt && now - socket.data.lastChatAt < CHAT_COOLDOWN_MS) return;
    socket.data.lastChatAt = now;

    const player = game.players.find(p => p.id === socket.id);
    const spectator = !player && game.spectators ? game.spectators.find(s => s.id === socket.id) : null;
    if (!player && !spectator) return; // ni joueur ni spectateur de cette partie : rien à diffuser

    const message = {
      id: `${now}-${socket.id}`,
      authorId: socket.id,
      name: player ? player.name : spectator.name,
      avatar: player ? player.avatar : null, // les spectateurs n'ont pas d'avatar stocké (cf. game.spectators)
      isSpectator: !player,
      text: trimmed,
      ts: now
    };

    game.chatMessages.push(message);
    if (game.chatMessages.length > CHAT_HISTORY_LIMIT) game.chatMessages.shift();

    io.to(gameId).emit('chat_message', message);
  });

  socket.on('start_game', () => {
    const gameId = socket.data.gameId;
    const game = games[gameId];

    if (!game) {
      socket.emit('error_message', 'Partie introuvable.');
      return;
    }
    if (game.hostId !== socket.id) {
      socket.emit('error_message', "Seul l'hôte peut démarrer la partie.");
      return;
    }
    if (game.status !== 'waiting') {
      socket.emit('error_message', 'Partie déjà démarrée.');
      return;
    }

    // Défensif : des modificateurs ne peuvent jamais survivre dans un mode qui ne les gère pas.
    if (game.modifiers && game.modifiers.length && !MODIFIER_GAME_MODES.includes(game.gameMode)) {
      game.modifiers = [];
    }

    // Mode "auction" (Draft/Enchères) : strictement 2 joueurs, JAMAIS de banc/spectateur
    // comme admin/guess — le lobby doit être à exactement 2 pour démarrer, point final
    // (section 1 du brief : ne démarre pas à 1, 3, ou plus).
    if (game.gameMode === 'auction') {
      if (game.players.length !== 2) {
        socket.emit('error_message', 'Ce mode nécessite exactement 2 joueurs.');
        return;
      }
      if (!AUCTION_TYPES.includes(game.auctionType)) {
        socket.emit('error_message', "Choisis le type d'enchère avant de démarrer.");
        return;
      }
      game.status = 'playing';
      startAuctionGame(game);
      persistGame(game);
      return;
    }

    // Modes 2 joueurs (admin/guess) à PLUS de 2 joueurs dans le lobby : l'hôte doit avoir
    // choisi les 2 qui jouent réellement (cf. set_active_players) avant de pouvoir
    // démarrer — les autres basculeront en spectateurs juste plus bas.
    if (game.gameMode === 'admin' || game.gameMode === 'guess') {
      if (game.players.length < 2) {
        socket.emit('error_message', 'Ce mode nécessite au moins 2 joueurs.');
        return;
      }
      if (game.players.length > 2) {
        const active = game.activePlayerIds;
        if (!active || active.length !== 2 || !active.every(id => game.players.some(p => p.id === id))) {
          socket.emit('error_message', 'Choisis les 2 joueurs qui vont jouer avant de démarrer.');
          return;
        }
      }
    }
    if (game.gameMode === 'admin') {
      const eligibleIds = game.players.length === 2 ? game.players.map(p => p.id) : game.activePlayerIds;
      if (!game.adminId || !eligibleIds.includes(game.adminId)) {
        socket.emit('error_message', "Choisis l'ADMIN avant de démarrer.");
        return;
      }
    }
    // Mode Coop : 2 joueurs minimum, AUCUN plafond (le boss scale avec l'effectif, cf.
    // computeCoopTeamRequiredPoints) — aucun mécanisme de banc/spectateur ici, contrairement
    // à admin/guess.
    if (game.gameMode === 'coop' && game.players.length < 2) {
      socket.emit('error_message', 'Le mode Coop nécessite au moins 2 joueurs.');
      return;
    }
    if (game.gameMode === 'fly' && (game.players.length !== 1 || (game.spectators && game.spectators.length > 0))) {
      socket.emit('error_message', 'Humanité vs Mouche : 1 seul joueur, sans spectateur.');
      return;
    }
    // Mode Roulette de Stats : 1 joueur minimum (2 avec Frankenstein), aucun boss/route/objet — cf. statdraft-game.js.
    if (game.gameMode === 'statdraft') {
      const sdError = SD.validateStart(game);
      if (sdError) {
        socket.emit('error_message', sdError);
        return;
      }
      SD.begin(game); // passe la partie en 'playing' et lance le 1er tirage
      return;
    }

    // Mise sur le banc AVANT toute génération d'état de partie : au-delà de 2 joueurs en
    // mode admin/guess, seuls les 2 actifs choisis par l'hôte jouent réellement.
    let benchedPlayers = [];
    if ((game.gameMode === 'admin' || game.gameMode === 'guess') && game.players.length > 2) {
      const activeIds = game.activePlayerIds;
      benchedPlayers = game.players.filter(p => !activeIds.includes(p.id));
      game.players = game.players.filter(p => activeIds.includes(p.id));
    }

    game.status = 'playing';

    // Mode "Devine le Pokémon" : aucun concept de boss/route/équipe/tour-cadeau — flux
    // entièrement différent (planche + secrets + tours chronométrés), isolé dans
    // startGuessGame(). On sort ici avant de toucher aux champs Route du Boss.
    if (game.gameMode === 'guess') {
      game.players.forEach(p => { p.secretPokemonIndex = null; });
      benchExtraPlayersAsSpectators(game, gameId, benchedPlayers);
      startGuessGame(game);
      persistGame(game);
      return;
    }

    benchExtraPlayersAsSpectators(game, gameId, benchedPlayers);

    game.players.forEach(p => {
      p.score = 0;
      p.team = [];
      p.typeBonusTotal = 0;
      p.typeBonus = null;
      p.currentChoice = null;
      p.currentOptions = null;
      p.hasShinyCharm = false;
      p.heldItem = null;
      p.heldItemUsed = false;
      p.startItemOptions = null;
      p.pendingBonusKey = null;
      p.pity = 0; // compteur anti-RNG propre à chaque nouvelle partie
      p.worstChoice = null; // récap : pire choix de la partie
      p.activeEvent = null;
      p.eventCooldown = 0;
      p.rarityFloor = null;
      p.rarityBoost = null;
      p.crossedFatesPartner = null;
      p.secretPokemonIndex = null;
      // Partie à modificateurs = hors-classement : lu par recordGameResult (aucune XP, aucun
      // historique, donc ni succès, ni stats, ni Pokédex). Remis à false sinon.
      p.modifiedGame = !!(game.modifiers && game.modifiers.some(k => !RANKED_SAFE_MODIFIERS.includes(k)));
      p.gameModifiers = Array.isArray(game.modifiers) ? [...game.modifiers] : []; // historisé (cf. Hall of Fame)
    });

    // Mode ADMIN VS JOUEUR : décision de gameplay volontaire — jamais d'objet dans ce
    // mode (déjà le cas avant, cf. startTurnForPlayers), inchangé : démarre directement.
    if (game.gameMode === 'fly') {
      FLY.begin(game); // pas d'objet de départ, pas de boss, pas de persistance
      return;
    }
    if (game.gameMode === 'admin') {
      beginRouteGameplay(game, gameId);
      return;
    }

    // Modificateur "Pas d'objets" : aucun choix d'objet de départ, le tour 1 démarre tout de
    // suite (beginRouteGameplay émet your_item avec item: null à chaque joueur).
    if (gameHasModifier(game, 'no_items')) {
      beginRouteGameplay(game, gameId);
      return;
    }

    // Choix de l'objet de départ AVANT le tour 1 (remplace l'ancien choix spécial du
    // tour 4, cf. socket.on('starting_item_choice')) : chaque joueur reçoit 3 options,
    // le tour 1 ne démarre (beginRouteGameplay) qu'une fois TOUS les joueurs choisis.
    game.status = 'item_select';
    game.players.forEach(p => {
      const keys = pickStartingItemKeys();
      p.startItemOptions = keys;
      io.to(p.id).emit('starting_item_options', {
        bonuses: keys.map(key => ({ key, label: BONUS_LABELS[key] }))
      });
    });
    io.to(gameId).emit('item_select_started', { gameMode: game.gameMode, players: getPublicPlayers(game) });
    persistGame(game);
  });

  // ---------------------------------------------------------------
  // GAMEMODE "DEVINE LE POKÉMON" — sélection du secret + tours chronométrés.
  // ---------------------------------------------------------------

  // Choix du Pokémon secret (une case de guessBoard). Une fois choisi, définitif pour
  // toute la partie (aucun event pour le modifier, cf. spec section 16 anti-cheat).
  socket.on('select_secret_pokemon', ({ index } = {}) => {
    const gameId = socket.data.gameId;
    const game = games[gameId];

    if (!game) {
      socket.emit('error_message', 'Partie introuvable.');
      return;
    }
    if (game.gameMode !== 'guess' || game.status !== 'playing') {
      socket.emit('error_message', "Action invalide.");
      return;
    }
    const player = game.players.find(p => p.id === socket.id);
    if (!player) {
      socket.emit('error_message', 'Tu ne fais pas partie de cette partie.');
      return;
    }
    if (player.secretPokemonIndex !== null) {
      socket.emit('error_message', 'Pokémon secret déjà choisi.');
      return;
    }
    if (!game.guessBoard || !game.guessBoard[index]) {
      socket.emit('error_message', 'Case invalide.');
      return;
    }

    player.secretPokemonIndex = index;

    // Confirmation UNIQUEMENT à l'intéressé (jamais révélé à l'adversaire, même
    // implicitement) : les autres joueurs ne reçoivent qu'un booléen via
    // guess_players_updated (secretSelected), jamais l'index ni le nom.
    socket.emit('secret_selection_confirmed', { index, name: game.guessBoard[index].name });
    broadcastGuessPlayers(game);

    const bothReady = game.players.length === 2 && game.players.every(p => p.secretPokemonIndex !== null);
    if (bothReady) {
      startGuessTurns(game);
    }
  });

  // Le joueur ACTIF termine son tour avant les 25s. Le serveur revérifie que c'est
  // bien son tour : un clic après expiration (course avec le timer serveur) ou d'un
  // spectateur est silencieusement ignoré plutôt que de perturber le timer en cours.
  socket.on('guess_finish_turn', () => {
    const gameId = socket.data.gameId;
    const game = games[gameId];

    if (!game || game.gameMode !== 'guess' || game.status !== 'playing') return;
    if (game.guessActivePlayerId !== socket.id) return;

    advanceGuessTurn(game);
  });

  // Tentative de trouver le Pokémon secret de l'ADVERSAIRE. Comparaison faite
  // EXCLUSIVEMENT côté serveur (jamais confiance au client, cf. spec section 15/16).
  // "Dire ma réponse" engage le tour : la tentative (bonne ou mauvaise) le termine
  // immédiatement, une seule utilisation possible par tour.
  socket.on('guess_attempt', ({ index } = {}) => {
    const gameId = socket.data.gameId;
    const game = games[gameId];

    if (!game) {
      socket.emit('error_message', 'Partie introuvable.');
      return;
    }
    if (game.gameMode !== 'guess' || game.status !== 'playing') {
      socket.emit('error_message', "La partie n'est pas en cours.");
      return;
    }
    if (game.guessActivePlayerId !== socket.id) {
      socket.emit('error_message', "Ce n'est pas ton tour.");
      return;
    }
    const player = game.players.find(p => p.id === socket.id);
    const opponent = game.players.find(p => p.id !== socket.id);
    if (!player || !opponent) {
      socket.emit('error_message', 'Adversaire introuvable.');
      return;
    }
    if (!game.guessBoard || !game.guessBoard[index]) {
      socket.emit('error_message', 'Case invalide.');
      return;
    }

    const correct = index === opponent.secretPokemonIndex;
    const guessedMon = game.guessBoard[index];

    // Diffusé aux DEUX joueurs, y compris en cas d'erreur : dans "Devine le Pokémon",
    // savoir ce que l'adversaire a tenté (et raté) fait partie du jeu de déduction.
    io.to(gameId).emit('guess_attempt_result', {
      by: player.id,
      index,
      name: guessedMon.name,
      correct
    });

    if (correct) {
      finishGuessGame(game, player.id, opponent.secretPokemonIndex);
    } else {
      // "Dire ma réponse" engage TOUJOURS le tour : une tentative (bonne ou mauvaise)
      // le termine immédiatement, jamais de seconde chance dans le même tour. Comme
      // advanceGuessTurn() change game.guessActivePlayerId de façon synchrone avant que
      // ce handler ne rende la main, une éventuelle deuxième tentative envoyée juste
      // après échoue déjà naturellement au contrôle "Ce n'est pas ton tour" plus haut —
      // aucun verrou supplémentaire n'est nécessaire pour garantir l'usage unique.
      advanceGuessTurn(game);
    }
  });

  // ---------------------------------------------------------------
  // GAMEMODE "DRAFT / ENCHÈRES" — tour par tour, sans limite de temps ni prix de départ :
  // enchère à montant libre (jamais de paliers/incréments fixes : le joueur écrit le
  // montant exact qu'il propose), uniquement quand c'est son tour. Le serveur reste seul
  // juge de : le budget réel, le prix actuel, à qui est le tour, l'équipe — jamais une
  // valeur reçue du client n'est utilisée telle quelle pour autre chose que l'identifier.
  socket.on('auction_bid', ({ amount } = {}) => {
    const gameId = socket.data.gameId;
    const game = games[gameId];

    if (!game) {
      socket.emit('error_message', 'Partie introuvable.');
      return;
    }
    if (game.gameMode !== 'auction' || game.status !== 'playing') {
      socket.emit('error_message', "La partie n'est pas en cours.");
      return;
    }
    const player = game.players.find(p => p.id === socket.id);
    if (!player) {
      socket.emit('error_message', 'Tu ne fais pas partie de cette partie.');
      return;
    }
    if (!auctionPlayerCanBid(player)) {
      socket.emit('error_message', 'Ton équipe est déjà complète (6 Pokémon).');
      return;
    }
    const lot = game.auctionLot;
    if (!lot) {
      socket.emit('error_message', 'Aucune enchère en cours.');
      return;
    }
    if (lot.activePlayerId !== player.id) {
      socket.emit('error_message', "Ce n'est pas ton tour.");
      return;
    }

    // Rejette explicitement tout ce qui n'est pas un entier fini normal : NaN, Infinity,
    // décimales, chaînes non numériques, valeurs négatives. 0 est en revanche accepté ici
    // (cas spécial ci-dessous : miser 0M) — géré séparément de la validation "trop bas"
    // habituelle.
    const bid = Number(amount);
    if (!Number.isInteger(bid) || !Number.isFinite(bid) || bid < 0) {
      socket.emit('error_message', 'Montant invalide.');
      return;
    }
    // Seuls un nombre entier de millions ou un ,5 sont autorisés (cf. saisie côté client)
    // — donc toujours un multiple de 500 000 en unité brute. Revalidé ici : le client
    // n'est jamais la seule barrière.
    if (bid % 500_000 !== 0) {
      socket.emit('error_message', 'Ton enchère doit être un nombre entier ou se terminant par ,5 (en millions).');
      return;
    }

    if (bid === 0) {
      // Miser 0M : autorisé UNIQUEMENT pour OUVRIR un lot vierge (jamais si une enchère
      // existe déjà — dans ce cas il faut soit suivre, soit passer, cf. auction_pass), et
      // UNIQUEMENT si ce joueur n'a vraiment pas les moyens du plancher AUCTION_MIN_BID
      // (sinon ce serait juste un moyen de le contourner). Ça revient à laisser le choix
      // à l'adversaire : passer (lui laisser le lot gratuitement) ou enchérir pour le
      // prendre.
      if (lot.currentBid !== null) {
        socket.emit('error_message', 'Une enchère est déjà posée : suis-la ou passe.');
        return;
      }
      if (player.budget >= AUCTION_MIN_BID) {
        socket.emit('error_message', `Tu as les moyens de miser au moins ${formatAuctionMoney(AUCTION_MIN_BID)}, tu ne peux pas proposer 0M.`);
        return;
      }
    } else {
      // Sans prix de départ dépendant du lot : la toute première enchère du lot doit
      // juste atteindre le plancher fixe AUCTION_MIN_BID (sauf le cas 0M ci-dessus) ;
      // ensuite, chaque enchère doit strictement dépasser la précédente.
      const minBid = lot.currentBid !== null ? lot.currentBid + 1 : AUCTION_MIN_BID;
      if (bid < minBid) {
        socket.emit('error_message', `Ton enchère doit être d'au moins ${formatAuctionMoney(minBid)}.`);
        return;
      }
      if (bid > player.budget) {
        socket.emit('error_message', "Tu ne possèdes pas assez d'argent.");
        return;
      }
    }

    lot.currentBid = bid;
    lot.currentBidderId = player.id;

    // La main passe à l'autre joueur (sauf s'il a déjà son équipe complète, cf.
    // auctionNextBidder, auquel cas elle revient à celui qui vient d'enchérir).
    const other = game.players.find(p => p.id !== player.id);
    lot.activePlayerId = auctionNextBidder(game, other ? other.id : player.id);

    io.to(gameId).emit('auction_bid_update', {
      currentBid: lot.currentBid,
      currentBidderId: lot.currentBidderId,
      currentBidderName: player.name,
      activePlayerId: lot.activePlayerId,
      players: getPublicAuctionPlayers(game)
    });
  });

  // Passer son tour (mode "auction", tour par tour) : UNIQUEMENT possible si une enchère
  // a déjà été posée sur ce lot, auquel cas l'adversaire le remporte immédiatement au
  // prix actuel. Impossible de passer sur un lot encore vierge — quelqu'un doit toujours
  // ouvrir les enchères en premier, jamais de lot invendu par double passe.
  socket.on('auction_pass', () => {
    const gameId = socket.data.gameId;
    const game = games[gameId];

    if (!game) {
      socket.emit('error_message', 'Partie introuvable.');
      return;
    }
    if (game.gameMode !== 'auction' || game.status !== 'playing') {
      socket.emit('error_message', "La partie n'est pas en cours.");
      return;
    }
    const player = game.players.find(p => p.id === socket.id);
    if (!player) {
      socket.emit('error_message', 'Tu ne fais pas partie de cette partie.');
      return;
    }
    const lot = game.auctionLot;
    if (!lot) {
      socket.emit('error_message', 'Aucune enchère en cours.');
      return;
    }
    if (lot.activePlayerId !== player.id) {
      socket.emit('error_message', "Ce n'est pas ton tour.");
      return;
    }
    if (!lot.currentBidderId) {
      socket.emit('error_message', "Il faut au moins une enchère sur ce lot avant de pouvoir passer.");
      return;
    }

    resolveAuctionLot(game);
  });

  // Rejouer avec les mêmes joueurs : crée une partie entièrement neuve (nouveau code,
  // nouveau boss, nouveaux Pokémon/modificateurs, scores/équipes/route à zéro) et déplace
  // uniquement les joueurs encore connectés dans ce nouveau salon. L'ancienne partie est
  // détruite pour éviter toute fuite d'état vers la nouvelle.
  socket.on('play_again', () => {
    const oldGameId = socket.data.gameId;
    const oldGame = games[oldGameId];

    if (!oldGame) {
      socket.emit('error_message', 'Partie introuvable.');
      return;
    }
    if (oldGame.hostId !== socket.id) {
      socket.emit('error_message', "Seul l'hôte peut relancer une partie.");
      return;
    }
    if (oldGame.status !== 'finished') {
      socket.emit('error_message', "La partie n'est pas terminée.");
      return;
    }

    const newGameId = generateGameId();
    // Ne conserve que les joueurs dont le socket est encore réellement connecté :
    // un joueur resté dans oldGame.players sans socket actif deviendrait un "fantôme"
    // qui ne rejoint jamais le nouveau salon mais y bloquerait "allReady" pour toujours.
    const connectedOldPlayers = oldGame.players.filter(p => io.sockets.sockets.has(p.id));
    // gameMode conservé tel quel (l'hôte peut le changer avant de relancer). adminId
    // conservé UNIQUEMENT s'il désigne toujours un joueur présent dans la nouvelle
    // partie ; sinon l'hôte doit re-choisir (cf. set_admin_role).
    const carriedAdminId = connectedOldPlayers.some(p => p.id === oldGame.adminId) ? oldGame.adminId : null;
    const newGame = {
      id: newGameId,
      status: 'waiting',
      turn: 0,
      maxTurns: MAX_TURNS,
      hostId: oldGame.hostId,
      boss: null,
      selectedDifficulty: oldGame.selectedDifficulty || 'medium', // conservée, modifiable avant le lancement
      gameMode: oldGame.gameMode || 'normal',
      adminId: carriedAdminId,
      modifiers: Array.isArray(oldGame.modifiers) ? [...oldGame.modifiers] : [], // conservés, modifiables avant le lancement
      route: buildRoute(),
      turnTimer: null,
      guessBoard: null,
      guessActivePlayerId: null,
      guessTurnEndsAt: null,
      guessTurnTimer: null,
      guessWinnerId: null,
      guessTurnDurationMs: oldGame.guessTurnDurationMs || GUESS_TURN_DURATION_MS, // conservée, modifiable avant le lancement
      players: connectedOldPlayers.map(p => makePlayer(p.id, p.name, p.token, p.avatar, p.accountAccessToken)), // pity remis à 0, token/avatar/compte conservés (cf. makePlayer)
      spectators: [],
      activePlayerIds: null, // nouvelle partie = nouvelle sélection à faire si jamais elle repasse à >2 joueurs
      // ---- Mode "auction" : reset complet, y compris le type (l'hôte re-choisit avant
      // de relancer) — startAuctionGame() réinitialise de toute façon tout ceci au
      // lancement réel, mais explicite ici pour la même raison que guessBoard: null
      // juste au-dessus : lisible d'un coup d'œil, pas de champ implicite.
      auctionType: null,
      auctionPool: [],
      auctionHistory: [],
      auctionLot: null,
      auctionBlindSeerId: null,
      auctionBidStarterId: null,
      chatMessages: [] // nouvelle partie = discussion vierge, jamais reprise de l'ancienne
    };

    games[newGameId] = newGame;

    // Déplace chaque joueur encore connecté de l'ancien salon vers le nouveau.
    newGame.players.forEach(p => {
      const playerSocket = io.sockets.sockets.get(p.id);
      if (playerSocket) {
        playerSocket.leave(oldGameId);
        playerSocket.join(newGameId);
        playerSocket.data.gameId = newGameId;
      }
    });

    // Idem pour les spectateurs encore connectés : Rejouer ne doit pas les éjecter vers
    // l'accueil, ils suivent automatiquement la partie dans son nouveau salon (comme les
    // joueurs juste au-dessus), avec un spectate_joined frais reflétant le nouvel état
    // (statut 'waiting', pas encore de boss tant que l'hôte n'a pas relancé).
    const connectedOldSpectators = (oldGame.spectators || []).filter(s => io.sockets.sockets.has(s.id));
    newGame.spectators = connectedOldSpectators.map(s => ({ id: s.id, name: s.name }));
    connectedOldSpectators.forEach(s => {
      const specSocket = io.sockets.sockets.get(s.id);
      if (!specSocket) return;
      specSocket.leave(oldGameId);
      specSocket.join(newGameId);
      specSocket.data.spectateGameId = newGameId;
      specSocket.emit('spectate_joined', buildSpectatePayload(newGame));
    });

    FLY.dispose(oldGame);
    SD.carry(oldGame, newGame); // modificateurs Roulette de Stats conservés
    SD.dispose(oldGame);
    if (oldGame.turnTimer) clearTimeout(oldGame.turnTimer); // filet de sécurité : status 'finished' devrait déjà l'avoir nettoyé
    if (oldGame.guessTurnTimer) clearTimeout(oldGame.guessTurnTimer);
    delete games[oldGameId];
    deletePersistedGame(oldGameId);

    io.to(newGameId).emit('game_replayed', {
      gameId: newGameId,
      players: getPublicPlayers(newGame),
      hostId: newGame.hostId,
      difficulty: newGame.selectedDifficulty,
      gameMode: newGame.gameMode,
      adminId: newGame.adminId,
      activePlayerIds: newGame.activePlayerIds,
      guessTurnDurationMs: newGame.guessTurnDurationMs,
      auctionType: newGame.auctionType,
      modifiers: newGame.modifiers || []
    });
    if (newGame.gameMode === 'statdraft') SD.syncLobby(newGame);
  });

  // Choix de la difficulté du boss dans le lobby. Réservé à l'hôte, uniquement avant
  // le lancement. Le client n'envoie qu'une clé parmi BOSS_GROUPS ; le serveur choisit
  // seul le boss final au démarrage (start_game) — jamais de confiance envers le client.
  socket.on('set_difficulty', ({ difficulty } = {}) => {
    const gameId = socket.data.gameId;
    const game = games[gameId];

    if (!game) {
      socket.emit('error_message', 'Partie introuvable.');
      return;
    }
    if (game.hostId !== socket.id) {
      socket.emit('error_message', "Seul l'hôte peut choisir la difficulté.");
      return;
    }
    if (game.status !== 'waiting') {
      socket.emit('error_message', 'La difficulté ne peut plus être modifiée.');
      return;
    }
    if (!BOSS_GROUPS.includes(difficulty)) {
      socket.emit('error_message', 'Difficulté invalide.');
      return;
    }

    game.selectedDifficulty = difficulty;
    io.to(gameId).emit('difficulty_updated', { difficulty: game.selectedDifficulty });
  });

  // Modificateurs de partie (cf. GAME_MODIFIERS). Réservé à l'hôte, uniquement avant le
  // lancement, modes normal/coop. Le client envoie la liste COMPLÈTE souhaitée ; le serveur
  // la valide (clés connues), la dédoublonne et la remet dans l'ordre du catalogue.
  socket.on('set_modifiers', ({ modifiers } = {}) => {
    const gameId = socket.data.gameId;
    const game = games[gameId];

    if (!game) {
      socket.emit('error_message', 'Partie introuvable.');
      return;
    }
    if (game.hostId !== socket.id) {
      socket.emit('error_message', "Seul l'hôte peut choisir les modificateurs.");
      return;
    }
    if (game.status !== 'waiting') {
      socket.emit('error_message', 'Les modificateurs ne peuvent plus être modifiés.');
      return;
    }
    if (!Array.isArray(modifiers) || modifiers.length > GAME_MODIFIER_KEYS.length
        || !modifiers.every(k => typeof k === 'string' && GAME_MODIFIER_KEYS.includes(k))) {
      socket.emit('error_message', 'Modificateur invalide.');
      return;
    }
    const clean = GAME_MODIFIER_KEYS.filter(k => modifiers.includes(k));
    if (clean.length && !MODIFIER_GAME_MODES.includes(game.gameMode)) {
      socket.emit('error_message', "Les modificateurs ne sont disponibles qu'en Mode normal et Coop.");
      return;
    }

    game.modifiers = clean;
    io.to(gameId).emit('modifiers_updated', { modifiers: game.modifiers });
  });

  // Choix du mode de jeu dans le lobby. Réservé à l'hôte, uniquement avant le lancement.
  // Changer de mode réinitialise systématiquement adminId : un ADMIN choisi pour une
  // configuration précédente n'a plus de sens après un changement de mode (l'hôte doit
  // re-choisir via set_admin_role).
  socket.on('set_game_mode', ({ mode } = {}) => {
    const gameId = socket.data.gameId;
    const game = games[gameId];

    if (!game) {
      socket.emit('error_message', 'Partie introuvable.');
      return;
    }
    if (game.hostId !== socket.id) {
      socket.emit('error_message', "Seul l'hôte peut choisir le mode de jeu.");
      return;
    }
    if (game.status !== 'waiting') {
      socket.emit('error_message', 'Le mode de jeu ne peut plus être modifié.');
      return;
    }
    if (!GAME_MODES.includes(mode)) {
      socket.emit('error_message', 'Mode de jeu invalide.');
      return;
    }
    if (mode === 'fly' && game.players.length !== 1) {
      socket.emit('error_message', 'Humanité vs Mouche se joue seul : retire les autres joueurs du lobby.');
      return;
    }

    game.gameMode = mode;
    if (!MODIFIER_GAME_MODES.includes(mode) && game.modifiers && game.modifiers.length) {
      game.modifiers = []; // les modificateurs n'existent qu'en normal/coop
      io.to(gameId).emit('modifiers_updated', { modifiers: game.modifiers });
    }
    game.adminId = null;
    game.activePlayerIds = null;
    game.auctionType = null; // repart de zéro si l'hôte change de mode puis revient sur "auction"
    io.to(gameId).emit('game_mode_updated', { gameMode: game.gameMode, adminId: game.adminId, activePlayerIds: game.activePlayerIds, auctionType: game.auctionType });
    if (game.gameMode === 'statdraft') SD.syncLobby(game);
  });

  // Choix du type d'enchère (mode "auction" uniquement), avant le lancement. Cf.
  // socket.on('start_game') : le type doit être choisi pour pouvoir démarrer.
  socket.on('set_auction_type', ({ auctionType } = {}) => {
    const gameId = socket.data.gameId;
    const game = games[gameId];

    if (!game) {
      socket.emit('error_message', 'Partie introuvable.');
      return;
    }
    if (game.hostId !== socket.id) {
      socket.emit('error_message', "Seul l'hôte peut choisir le type d'enchère.");
      return;
    }
    if (game.status !== 'waiting') {
      socket.emit('error_message', "Le type d'enchère ne peut plus être modifié.");
      return;
    }
    if (game.gameMode !== 'auction') {
      socket.emit('error_message', "Le mode Draft/Enchères n'est pas sélectionné.");
      return;
    }
    if (!AUCTION_TYPES.includes(auctionType)) {
      socket.emit('error_message', "Type d'enchère invalide.");
      return;
    }

    game.auctionType = auctionType;
    io.to(gameId).emit('auction_type_updated', { auctionType: game.auctionType });
  });

  // Choix des 2 joueurs qui jouent réellement (mode admin/guess à >2 joueurs dans le
  // lobby, cf. socket.on('start_game') plus bas pour la mise sur le banc effective au
  // lancement). Sans effet à exactement 2 joueurs : ils sont alors automatiquement les
  // 2 actifs, pas besoin de ce picker.
  socket.on('set_active_players', ({ playerIds } = {}) => {
    const gameId = socket.data.gameId;
    const game = games[gameId];

    if (!game) {
      socket.emit('error_message', 'Partie introuvable.');
      return;
    }
    if (game.hostId !== socket.id) {
      socket.emit('error_message', "Seul l'hôte peut choisir les joueurs actifs.");
      return;
    }
    if (game.status !== 'waiting') {
      socket.emit('error_message', 'La sélection des joueurs actifs ne peut plus être modifiée.');
      return;
    }
    if (game.gameMode !== 'admin' && game.gameMode !== 'guess') {
      socket.emit('error_message', "Ce mode ne nécessite pas de choisir les joueurs actifs.");
      return;
    }
    if (!Array.isArray(playerIds) || playerIds.length !== 2) {
      socket.emit('error_message', 'Choisis exactement 2 joueurs.');
      return;
    }
    const uniqueIds = [...new Set(playerIds)];
    if (uniqueIds.length !== 2 || !uniqueIds.every(id => game.players.some(p => p.id === id))) {
      socket.emit('error_message', 'Sélection de joueurs invalide.');
      return;
    }

    game.activePlayerIds = uniqueIds;
    // L'ADMIN précédemment choisi n'est peut-être plus parmi les 2 actifs : on le
    // réinitialise plutôt que de laisser une incohérence (ADMIN sur le banc).
    if (game.gameMode === 'admin' && game.adminId && !uniqueIds.includes(game.adminId)) {
      game.adminId = null;
    }
    io.to(gameId).emit('active_players_updated', { activePlayerIds: game.activePlayerIds, adminId: game.adminId });
  });

  // Choix du joueur ADMIN dans le lobby (mode "admin" uniquement). Réservé à l'hôte,
  // uniquement avant le lancement, uniquement à exactement 2 joueurs. Le serveur revalide
  // que l'id proposé désigne bien un joueur réellement présent dans la partie — jamais un
  // id arbitraire envoyé par le client.
  socket.on('set_admin_role', ({ adminId } = {}) => {
    const gameId = socket.data.gameId;
    const game = games[gameId];

    if (!game) {
      socket.emit('error_message', 'Partie introuvable.');
      return;
    }
    if (game.hostId !== socket.id) {
      socket.emit('error_message', "Seul l'hôte peut choisir l'ADMIN.");
      return;
    }
    if (game.status !== 'waiting') {
      socket.emit('error_message', "Le rôle ADMIN ne peut plus être modifié.");
      return;
    }
    if (game.gameMode !== 'admin') {
      socket.emit('error_message', "Le mode ADMIN VS JOUEUR n'est pas sélectionné.");
      return;
    }
    if (game.players.length < 2) {
      socket.emit('error_message', 'Le mode ADMIN VS JOUEUR nécessite au moins 2 joueurs.');
      return;
    }

    // À exactement 2 joueurs dans le lobby, les 2 sont automatiquement les "actifs" (pas
    // besoin de set_active_players). Au-delà, l'ADMIN doit obligatoirement être l'un des
    // 2 joueurs déjà choisis comme actifs — jamais un joueur resté sur le banc.
    const eligibleIds = game.players.length === 2
      ? game.players.map(p => p.id)
      : (game.activePlayerIds || []);

    if (game.players.length > 2 && eligibleIds.length !== 2) {
      socket.emit('error_message', "Choisis d'abord les 2 joueurs qui vont jouer.");
      return;
    }
    if (!eligibleIds.includes(adminId)) {
      socket.emit('error_message', 'Joueur invalide.');
      return;
    }

    game.adminId = adminId;
    io.to(gameId).emit('admin_role_updated', { adminId: game.adminId });
  });

  // Durée d'un tour en mode "Devine le Pokémon", réglable par l'hôte dans le lobby.
  // Uniquement parmi GUESS_TURN_DURATION_OPTIONS_MS (jamais une valeur arbitraire).
  socket.on('set_guess_turn_duration', ({ durationMs } = {}) => {
    const gameId = socket.data.gameId;
    const game = games[gameId];

    if (!game) {
      socket.emit('error_message', 'Partie introuvable.');
      return;
    }
    if (game.hostId !== socket.id) {
      socket.emit('error_message', "Seul l'hôte peut régler la durée des tours.");
      return;
    }
    if (game.status !== 'waiting') {
      socket.emit('error_message', 'La durée des tours ne peut plus être modifiée.');
      return;
    }
    if (!GUESS_TURN_DURATION_OPTIONS_MS.includes(durationMs)) {
      socket.emit('error_message', 'Durée invalide.');
      return;
    }

    game.guessTurnDurationMs = durationMs;
    io.to(gameId).emit('guess_turn_duration_updated', { turnDurationMs: game.guessTurnDurationMs });
  });

  socket.on('player_choice', ({ choice } = {}) => {
    const gameId = socket.data.gameId;
    const game = games[gameId];

    if (!game) {
      socket.emit('error_message', 'Partie introuvable.');
      return;
    }
    if (game.status !== 'playing') {
      socket.emit('error_message', "La partie n'est pas en cours.");
      return;
    }
    if (choice !== 'HAUT' && choice !== 'BAS') {
      socket.emit('error_message', 'Choix invalide.');
      return;
    }

    const player = game.players.find(p => p.id === socket.id);
    if (!player) {
      socket.emit('error_message', 'Tu ne fais pas partie de cette partie.');
      return;
    }
    if (game.gameMode === 'admin' && socket.id === game.adminId) {
      socket.emit('error_message', "L'ADMIN ne joue pas : il observe uniquement.");
      return;
    }
    if (player.currentChoice !== null) {
      socket.emit('error_message', 'Choix déjà enregistré pour ce tour.');
      return;
    }
    if (!player.currentOptions) {
      socket.emit('error_message', 'Choix pas encore disponible, réessaie.');
      return;
    }

    player.currentChoice = choice;
    const key = choice === 'HAUT' ? 'haut' : 'bas';
    const reward = player.currentOptions[key];

    // Anti-RNG : bonne rareté -> réinitialise le compteur ; mauvaise -> l'incrémente.
    // Basé UNIQUEMENT sur la rareté effectivement obtenue (pas les 2 options générées).
    // N'existe pas en mode ADMIN VS JOUEUR : ce mode est volontairement chaotique, sans
    // mécanisme d'équité sur la durée (cf. pickAdminModeOptions).
    if (game.gameMode !== 'admin') {
      player.pity = PITY_GOOD_RARITIES.includes(reward.rarity) ? 0 : (player.pity || 0) + 1;
    }

    // Attaque du boss (Coop, cf. advanceTurn) : consommée ici, une seule fois, dès que la
    // cible choisit — jamais réappliquée si elle traîne plusieurs tours sans jouer.
    const bossAttackHit = game.gameMode === 'coop' && game.bossAttackTargetId === player.id;
    const pointsGained = bossAttackHit ? Math.round(reward.finalPoints * 0.5) : reward.finalPoints;
    if (bossAttackHit) game.bossAttackTargetId = null;

    // Récap de fin de partie : « pire choix » = plus gros regret (points de l'option NON choisie
    // moins ceux de l'option choisie). Comparaison sur finalPoints, avant attaque du boss.
    const otherReward = player.currentOptions[key === 'haut' ? 'bas' : 'haut'];
    if (otherReward) {
      const regret = otherReward.finalPoints - reward.finalPoints;
      if (regret > 0 && (!player.worstChoice || regret > player.worstChoice.regret)) {
        player.worstChoice = {
          turn: game.turn,
          chosenName: reward.name, chosenPoints: reward.finalPoints,
          otherName: otherReward.name, otherPoints: otherReward.finalPoints,
          regret
        };
      }
    }

    player.score += pointsGained;
    pushMonToTeam(player, teamMonFromReward(reward));
    const typeBonusDelta = game.gameMode === 'fly' ? 0 : syncTypeBonus(player, game); // bonus de faiblesse + affinité, recalculés depuis l'équipe

    socket.emit('choice_result', {
      pokemon: { name: reward.name, sprite: reward.sprite, shiny: reward.shiny, shinySprite: reward.shinySprite, types: BOSS_MECHANICS.getTypes(reward.pokemonId) },
      rarity: reward.rarity,
      basePoints: reward.basePoints,
      effect: { name: reward.effectName, multiplier: reward.multiplier, flat: reward.flat || 0 },
      pointsGained,
      bossAttackHit,
      typeBonusDelta,
      typeBonus: player.typeBonus || null,
      score: player.score,
      team: player.team
    });

    finalizePlayerTurn(game, player);
  });

  // Choix de l'objet de DÉBUT DE PARTIE (avant le tour 1, cf. start_game qui propose
  // 2 options à chaque joueur et attend que TOUS aient choisi avant de lancer le tour 1).
  // Remplace l'ancien choix spécial du tour 4 : l'objet est ensuite gardé en inventaire
  // et activable À TOUT MOMENT pendant la partie (cf. use_item plus bas).
  socket.on('starting_item_choice', ({ key } = {}) => {
    const gameId = socket.data.gameId;
    const game = games[gameId];

    if (!game) {
      socket.emit('error_message', 'Partie introuvable.');
      return;
    }
    if (game.status !== 'item_select') {
      socket.emit('error_message', "Ce n'est pas le moment de choisir un objet.");
      return;
    }
    const player = game.players.find(p => p.id === socket.id);
    if (!player) {
      socket.emit('error_message', 'Tu ne fais pas partie de cette partie.');
      return;
    }
    if (player.heldItem) {
      socket.emit('error_message', 'Objet déjà choisi.');
      return;
    }
    if (!player.startItemOptions || !player.startItemOptions.includes(key)) {
      socket.emit("error_message", "Cet objet ne t'a pas été proposé.");
      return;
    }

    player.heldItem = key;
    player.startItemOptions = null;
    // Objet passif (Charme Chroma) : actif toute la partie dès maintenant, rien à cliquer.
    const passive = PASSIVE_ITEMS.has(key);
    if (key === 'shinyCharm') player.hasShinyCharm = true;
    player.heldItemUsed = passive;
    socket.emit('your_item', { item: player.heldItem, used: player.heldItemUsed, passive });

    if (game.players.every(p => p.heldItem)) {
      beginRouteGameplay(game, gameId);
    }
  });

  // Utilisation de l'objet en inventaire, À TOUT MOMENT pendant la partie (clic sur son
  // icône côté client) — jamais lié à un tour précis, contrairement à l'ancien système.
  // Charme Chroma s'applique instantanément ; Bonbon XP / PSL ouvrent le même
  // sélecteur d'équipe qu'avant (xp_candy_pending / mystery_item_pending, inchangés).
  socket.on('use_item', () => {
    const gameId = socket.data.gameId;
    const game = games[gameId];

    if (!game) {
      socket.emit('error_message', 'Partie introuvable.');
      return;
    }
    if (game.status !== 'playing') {
      socket.emit('error_message', "La partie n'est pas en cours.");
      return;
    }
    const player = game.players.find(p => p.id === socket.id);
    if (!player) {
      socket.emit('error_message', 'Tu ne fais pas partie de cette partie.');
      return;
    }
    if (!player.heldItem || player.heldItemUsed) {
      socket.emit('error_message', 'Aucun objet disponible.');
      return;
    }
    if (player.pendingBonusKey) {
      socket.emit('error_message', 'Choix déjà en cours.');
      return;
    }

    if (PASSIVE_ITEMS.has(player.heldItem)) {
      socket.emit('error_message', 'Cet objet est passif : il est déjà actif toute la partie.');
      return;
    }

    if (player.heldItem === 'megaGem') {
      // Ne consomme RIEN ici : liste uniquement les Pokémon de l'équipe qui ont une Méga-Évolution.
      // L'objet n'est consommé qu'à la sélection valide (cf. 'mega_gem_select').
      const eligible = player.team
        .map((mon, index) => ({ index, mon }))
        .filter(({ mon }) => getMegaForms(mon).length > 0);
      if (!eligible.length) {
        socket.emit('error_message', "Aucun Pokémon de ton équipe ne peut Méga-Évoluer : Méga Gemme conservée.");
        return;
      }
      player.pendingBonusKey = 'megaGem';
      socket.emit('mega_gem_pending', {
        team: eligible.map(({ index, mon }) => ({ index, id: mon.id, name: mon.name, sprite: mon.sprite }))
      });
      return;
    }

    if (player.heldItem === 'xpCandy') {
      const eligible = player.team
        .map((mon, index) => ({ index, mon }))
        .filter(({ mon }) => EVOLUTION_MAP[mon.id]);
      if (!eligible.length) {
        socket.emit('error_message', 'Aucun Pokémon éligible pour le moment.');
        return;
      }
      player.pendingBonusKey = 'xpCandy';
      socket.emit('xp_candy_pending', {
        team: eligible.map(({ index, mon }) => ({ index, id: mon.id, name: mon.name, sprite: mon.sprite }))
      });
      return;
    }

    if (player.heldItem === 'mysteryItem') {
      if (!player.team.length) {
        socket.emit('error_message', 'Aucun Pokémon éligible pour le moment.');
        return;
      }
      player.pendingBonusKey = 'mysteryItem';
      socket.emit('mystery_item_pending', {
        team: player.team.map((mon, index) => ({ index, id: mon.id, name: mon.name, sprite: mon.sprite }))
      });
      return;
    }

    // Return To Zero : uniquement les Pokémon qui ont un malus (revalidé à la sélection).
    if (player.heldItem === 'patchNote') {
      const eligible = player.team
        .map((mon, index) => ({ index, mon }))
        .filter(({ mon }) => isMalusMon(mon));
      if (!eligible.length) {
        socket.emit('error_message', "Aucun Pokémon de ton équipe n'a de malus : Return To Zero conservé.");
        return;
      }
      player.pendingBonusKey = 'patchNote';
      socket.emit('patch_note_pending', {
        team: eligible.map(({ index, mon }) => ({ index, id: mon.id, name: mon.name, sprite: mon.sprite }))
      });
      return;
    }

    // Reroll : tout Pokémon de l'équipe sauf un Métamorph déjà transformé.
    if (player.heldItem === 'reroll') {
      const eligible = player.team
        .map((mon, index) => ({ index, mon }))
        .filter(({ mon }) => isRerollable(mon));
      if (!eligible.length) {
        socket.emit('error_message', 'Aucun Pokémon éligible pour le moment.');
        return;
      }
      player.pendingBonusKey = 'reroll';
      socket.emit('reroll_pending', {
        team: eligible.map(({ index, mon }) => ({ index, id: mon.id, name: mon.name, sprite: mon.sprite }))
      });
    }
  });

  // Méga Gemme : le joueur choisit QUEL Pokémon de son équipe Méga-Évolue. C'est le Pokémon à
  // l'index reçu, relu ICI dans player.team côté serveur (jamais un objet fourni par le client),
  // qui est réellement modifié. L'équipe ne grossit jamais ; l'objet n'est consommé qu'au succès.
  socket.on('mega_gem_select', ({ index } = {}) => {
    const gameId = socket.data.gameId;
    const game = games[gameId];

    if (!game) {
      socket.emit('error_message', 'Partie introuvable.');
      return;
    }
    if (game.status !== 'playing') {
      socket.emit('error_message', "La partie n'est pas en cours.");
      return;
    }
    const player = game.players.find(p => p.id === socket.id);
    if (!player) {
      socket.emit('error_message', 'Tu ne fais pas partie de cette partie.');
      return;
    }
    if (player.pendingBonusKey !== 'megaGem' || player.heldItem !== 'megaGem' || player.heldItemUsed) {
      socket.emit('error_message', 'Aucune Méga Gemme en attente.');
      return;
    }

    const mon = Number.isInteger(index) ? player.team[index] : null;
    const forms = getMegaForms(mon);
    if (!mon || !forms.length) {
      // Choix invalide : rien n'est modifié ni consommé, le sélecteur reste ouvert côté serveur.
      socket.emit('error_message', 'Ce Pokémon ne peut pas Méga-Évoluer.');
      return;
    }

    const teamSizeBefore = player.team.length;
    const { fromName, scoreDelta } = megaEvolveMon(player, mon, randomFrom(forms), game);

    player.pendingBonusKey = null;
    player.heldItemUsed = true;

    socket.emit('bonus_result', {
      type: 'megaGem',
      from: fromName,
      to: mon.name,
      pokemonName: mon.name,
      sprite: mon.shiny && mon.shinySprite ? mon.shinySprite : mon.sprite,
      shiny: !!mon.shiny,
      scoreDelta,
      score: player.score,
      team: player.team
    });

    if (player.team.length !== teamSizeBefore) console.error('[megaGem] taille d\'équipe modifiée (bug)');
    broadcastGameUpdated(game); // score d'équipe (coop) à jour pour tout le monde
  });

  // Annulation du sélecteur d'objet (bouton Annuler) : l'objet n'est PAS consommé et reste
  // réutilisable ; sans ça, pendingBonusKey restait bloqué jusqu'au tour suivant ("Choix déjà
  // en cours").
  socket.on('item_cancel', () => {
    const game = games[socket.data.gameId];
    const player = game && game.players.find(p => p.id === socket.id);
    if (player && player.pendingBonusKey) player.pendingBonusKey = null;
  });

  // Bonbon XP : le joueur choisit QUEL Pokémon de son équipe évolue jusqu'à sa forme finale.
  socket.on('xp_candy_select', ({ index } = {}) => {
    const gameId = socket.data.gameId;
    const game = games[gameId];

    if (!game) {
      socket.emit('error_message', 'Partie introuvable.');
      return;
    }
    if (game.status !== 'playing') {
      socket.emit('error_message', "La partie n'est pas en cours.");
      return;
    }
    const player = game.players.find(p => p.id === socket.id);
    if (!player) {
      socket.emit('error_message', 'Tu ne fais pas partie de cette partie.');
      return;
    }
    if (player.pendingBonusKey !== 'xpCandy') {
      socket.emit('error_message', 'Aucun Bonbon XP en attente.');
      return;
    }

    const mon = player.team[index];
    const evolution = mon && EVOLUTION_MAP[mon.id];
    if (!mon || !evolution) {
      socket.emit('error_message', 'Ce Pokémon ne peut pas évoluer.');
      return;
    }

    let fromName;
    const scoreDelta = applyMonMutation(player, mon, m => { fromName = evolveMon(m, evolution); }, game);

    player.pendingBonusKey = null;
    player.heldItemUsed = true;

    socket.emit('bonus_result', {
      type: 'xpCandy',
      from: fromName,
      to: mon.name,
      sprite: mon.sprite,
      scoreDelta,
      score: player.score,
      team: player.team
    });

    broadcastGameUpdated(game);
  });

  // PSL (clé interne 'mysteryItem', conservée pour l'historique) : le joueur choisit QUEL Pokémon
  // reçoit un trait ; le trait est TOUJOURS 'Beauty privilege' (×1.6), jamais aléatoire.
  socket.on('mystery_item_select', ({ index } = {}) => {
    const gameId = socket.data.gameId;
    const game = games[gameId];

    if (!game) {
      socket.emit('error_message', 'Partie introuvable.');
      return;
    }
    if (game.status !== 'playing') {
      socket.emit('error_message', "La partie n'est pas en cours.");
      return;
    }
    const player = game.players.find(p => p.id === socket.id);
    if (!player) {
      socket.emit('error_message', 'Tu ne fais pas partie de cette partie.');
      return;
    }
    if (player.pendingBonusKey !== 'mysteryItem') {
      socket.emit('error_message', 'Aucun PSL en attente.');
      return;
    }

    const mon = player.team[index];
    if (!mon) {
      socket.emit('error_message', 'Pokémon invalide.');
      return;
    }

    const newEffect = resolveEffect(EFFECTS.find(e => e.name === 'Beauty privilege'));
    if (!newEffect) {
      socket.emit('error_message', 'Trait Beauty privilege introuvable.');
      return;
    }
    const scoreDelta = applyMonMutation(player, mon, m => assignEffect(m, newEffect), game);

    player.pendingBonusKey = null;
    player.heldItemUsed = true;

    socket.emit('bonus_result', {
      type: 'mysteryItem',
      pokemonName: mon.name,
      sprite: mon.sprite,
      effect: { name: newEffect.name, multiplier: newEffect.multiplier, flat: newEffect.flat },
      scoreDelta,
      score: player.score,
      team: player.team
    });

    broadcastGameUpdated(game);
  });

  // Return To Zero : retire le malus d'un Pokémon (trait remis à Neutre). Le Pokémon est relu ICI
  // dans player.team et son éligibilité revalidée ; l'objet n'est consommé qu'au succès.
  socket.on('patch_note_select', ({ index } = {}) => {
    const game = games[socket.data.gameId];
    if (!game) {
      socket.emit('error_message', 'Partie introuvable.');
      return;
    }
    if (game.status !== 'playing') {
      socket.emit('error_message', "La partie n'est pas en cours.");
      return;
    }
    const player = game.players.find(p => p.id === socket.id);
    if (!player) {
      socket.emit('error_message', 'Tu ne fais pas partie de cette partie.');
      return;
    }
    if (player.pendingBonusKey !== 'patchNote' || player.heldItem !== 'patchNote' || player.heldItemUsed) {
      socket.emit('error_message', 'Aucun Return To Zero en attente.');
      return;
    }
    const mon = Number.isInteger(index) ? player.team[index] : null;
    if (!mon || !isMalusMon(mon)) {
      socket.emit('error_message', "Ce Pokémon n'a pas de malus.");
      return;
    }

    const removed = { name: mon.effectName, multiplier: traitDisplayMultiplier(mon), flat: mon.flat || 0 };
    const neutral = resolveEffect(EFFECTS.find(e => e.name === 'Neutre'));
    const scoreDelta = applyMonMutation(player, mon, m => assignEffect(m, neutral), game);

    player.pendingBonusKey = null;
    player.heldItemUsed = true;

    socket.emit('bonus_result', {
      type: 'patchNote',
      pokemonName: mon.name,
      sprite: mon.sprite,
      removed,
      scoreDelta,
      score: player.score,
      team: player.team
    });

    broadcastGameUpdated(game);
  });

  // Reroll : relance le trait d'un Pokémon (jamais Neutre, jamais le même). Le tirage est fait
  // ICI ; le client reçoit la liste des traits possibles pour animer la roulette.
  socket.on('reroll_select', ({ index } = {}) => {
    const game = games[socket.data.gameId];
    if (!game) {
      socket.emit('error_message', 'Partie introuvable.');
      return;
    }
    if (game.status !== 'playing') {
      socket.emit('error_message', "La partie n'est pas en cours.");
      return;
    }
    const player = game.players.find(p => p.id === socket.id);
    if (!player) {
      socket.emit('error_message', 'Tu ne fais pas partie de cette partie.');
      return;
    }
    if (player.pendingBonusKey !== 'reroll' || player.heldItem !== 'reroll' || player.heldItemUsed) {
      socket.emit('error_message', 'Aucun Reroll en attente.');
      return;
    }
    const mon = Number.isInteger(index) ? player.team[index] : null;
    if (!mon || !isRerollable(mon)) {
      socket.emit('error_message', 'Pokémon invalide.');
      return;
    }

    const previous = { name: mon.effectName || 'Neutre', multiplier: traitDisplayMultiplier(mon), flat: mon.flat || 0 };
    const { effect: newEffect, pool } = pickRerolledEffect(mon.effectName);
    const scoreDelta = applyMonMutation(player, mon, m => assignEffect(m, newEffect), game);

    player.pendingBonusKey = null;
    player.heldItemUsed = true;

    socket.emit('bonus_result', {
      type: 'reroll',
      pokemonName: mon.name,
      sprite: mon.sprite,
      previous,
      effect: { name: newEffect.name, multiplier: newEffect.multiplier, flat: newEffect.flat },
      roulette: pool.map(e => ({ name: e.name, multiplier: e.multiplier, flat: e.flat || 0, gamble: !!e.gamble })),
      scoreDelta,
      score: player.score,
      team: player.team
    });

    broadcastGameUpdated(game);
  });

  // Point d'entrée UNIQUE pour répondre à un événement rare, quel qu'il soit (architecture
  // extensible : les futurs événements — étapes 3/4 — n'ajoutent pas de nouvel event Socket.IO,
  // juste un cas dans resolveEventAction). Le serveur ne fait jamais confiance à l'action
  // envoyée : il valide qu'un événement est bien actif pour CE joueur avant tout traitement,
  // et chaque resolveXxx revalide ensuite l'index/le choix par rapport à ce qui a été
  // réellement proposé (jamais une valeur arbitraire envoyée par le client).
  socket.on('rare_event_action', (action = {}) => {
    const gameId = socket.data.gameId;
    const game = games[gameId];

    if (!game) {
      socket.emit('error_message', 'Partie introuvable.');
      return;
    }
    if (game.status !== 'playing') {
      socket.emit('error_message', "La partie n'est pas en cours.");
      return;
    }
    const player = game.players.find(p => p.id === socket.id);
    if (!player) {
      socket.emit('error_message', 'Tu ne fais pas partie de cette partie.');
      return;
    }
    if (!player.activeEvent) {
      socket.emit('error_message', 'Aucun événement en cours.');
      return;
    }

    const outcome = resolveEventAction(game, player, action);

    if (!outcome || outcome.error) {
      socket.emit('error_message', (outcome && outcome.error) || 'Action invalide.');
      return;
    }

    if (outcome.pending) {
      // Événement à deux joueurs (DUEL) : ce joueur a répondu, on attend l'autre.
      // Rien à nettoyer ni à diffuser tant que les deux choix ne sont pas là.
      socket.emit('rare_event_waiting', { type: player.activeEvent.type });
      return;
    }

    if (outcome.resultsByPlayer) {
      // Événement à deux joueurs pleinement résolu : chaque participant reçoit SA
      // propre perspective (gagnant/perdant), puis on nettoie l'état des DEUX joueurs.
      Object.entries(outcome.resultsByPlayer).forEach(([playerId, payload]) => {
        const participant = game.players.find(p => p.id === playerId);
        if (participant) participant.activeEvent = null;
        io.to(playerId).emit('rare_event_result', payload);
      });
      broadcastGameUpdated(game);
      maybeScheduleTurnTransition(game);
      return;
    }

    player.activeEvent = null; // résolu : nettoyage systématique avant tout autre traitement
    broadcastGameUpdated(game); // score/équipe changés hors du flux de tour normal -> resynchronise tout le monde
    socket.emit('rare_event_result', outcome.result);
    maybeScheduleTurnTransition(game); // l'événement bloquait peut-être la transition : à re-vérifier maintenant
  });

  // Easter egg : clique sur un Métamorph dans TON équipe -> il copie le sprite d'un
  // autre Pokémon au hasard dans la même équipe et prend 75% de sa valeur actuelle.
  // Valable UNE SEULE FOIS par Métamorph (mon.metamorphUsed), dans les deux modes
  // d'équipe (normal + admin vs joueur) : une fois transformé, le slot reste figé sur
  // sa nouvelle forme pour le reste de la partie.
  // Aucun lien avec le tour en cours : peut être cliqué à tout moment pendant la partie.
  socket.on('transform_metamorph', ({ index } = {}) => {
    const gameId = socket.data.gameId;
    const game = games[gameId];
    if (game && game.gameMode === 'fly') {
      socket.emit('error_message', 'Indisponible dans ce mode.');
      return;
    }

    if (!game) {
      socket.emit('error_message', 'Partie introuvable.');
      return;
    }
    if (game.status !== 'playing') {
      socket.emit('error_message', "La partie n'est pas en cours.");
      return;
    }
    const player = game.players.find(p => p.id === socket.id);
    if (!player) {
      socket.emit('error_message', 'Tu ne fais pas partie de cette partie.');
      return;
    }

    const mon = player.team[index];
    if (!mon || mon.id !== METAMORPH_DEX_ID) {
      socket.emit('error_message', "Ce n'est pas un Métamorph.");
      return;
    }
    if (mon.metamorphUsed) {
      socket.emit('error_message', 'Ce Métamorph a déjà pris sa forme.');
      return;
    }

    const candidates = player.team.filter((m, i) => i !== index);
    if (candidates.length === 0) {
      socket.emit('error_message', "Il faut un autre Pokémon dans l'équipe pour se transformer.");
      return;
    }

    const target = randomFrom(candidates);
    const targetContribution = monContribution(target);
    const scoreDelta = applyMonMutation(player, mon, m => {
      // Sprite normal TOUJOURS celui de la cible (jamais un reliquat de l'ancien Métamorph).
      m.sprite = target.sprite;
      // Le statut shiny doit lui aussi être remplacé par celui de la cible, pas conservé :
      // sinon un Métamorph shiny qui copie un Pokémon normal continuerait à afficher
      // son ANCIEN sprite chromatique (pokemonSprite() le préfère à mon.sprite).
      if (target.shiny && target.shinySprite) {
        m.shiny = true;
        m.shinySprite = target.shinySprite;
      } else {
        m.shiny = false;
        m.shinySprite = null;
      }
      m.basePoints = targetContribution;
      m.multiplier = METAMORPH_TRANSFORM_MULTIPLIER;
      m.flat = 0; // targetContribution inclut déjà le flat de la cible : jamais recompté
      // Copie les TYPES de la cible ; et reprend son éventuel ×shiny déjà inclus dans targetContribution.
      m.typeSourceId = target.typeSourceId ?? target.id;
      m.shinyInMultiplier = !!target.shinyInMultiplier;
      m.effectName = 'Transformé';
      m.metamorphUsed = true; // verrou définitif : usage unique pour ce Métamorph
      // m.name INTENTIONNELLEMENT jamais réécrit : reste "Métamorph" pour toujours.
    }, game);

    socket.emit('metamorph_transformed', {
      score: player.score,
      scoreDelta,
      team: player.team,
      targetName: target.name,
      sprite: (mon.shiny && mon.shinySprite) ? mon.shinySprite : mon.sprite
    });
    broadcastGameUpdated(game); // score/équipe changés hors du flux de tour -> resynchronise les autres joueurs
  });

  // Solo uniquement : passe immédiatement la pause de révélation en cours. Le serveur
  // revérifie lui-même qu'il n'y a bien qu'un seul joueur (jamais confiance au client).
  socket.on('skip_reveal', () => {
    const gameId = socket.data.gameId;
    const game = games[gameId];

    if (!game || game.status !== 'playing') return;
    if (game.players.length !== 1) {
      socket.emit('error_message', 'Le skip est réservé au mode solo.');
      return;
    }
    if (!game.turnTimer) return; // rien à sauter pour le moment

    clearTimeout(game.turnTimer);
    resolveTurnTransition(game);
  });

  // Reconnexion après une coupure réseau/un refresh pendant une partie en cours
  // (cf. RECONNECT_GRACE_MS / handleSocketDisconnect). Le token est la seule preuve
  // d'identité : jamais confiance sur un gameId+pseudo fournis sans le bon token.
  socket.on('rejoin_game', ({ gameId, token } = {}) => {
    const game = games[gameId];
    if (!game) {
      socket.emit('rejoin_failed');
      return;
    }
    const player = game.players.find(p => p.token === token);
    if (!player) {
      socket.emit('rejoin_failed');
      return;
    }

    if (player.disconnectTimer) {
      clearTimeout(player.disconnectTimer);
      player.disconnectTimer = null;
    }

    const oldId = player.id; // avant rebranchement : tout ce qui référençait CE joueur
    // référençait cet ancien id, désormais mort — à repointer vers le nouveau partout.
    player.disconnected = false;
    player.id = socket.id; // rebranche ce joueur sur sa nouvelle socket
    socket.join(gameId);
    socket.data.gameId = gameId;

    // Tout champ qui stocke un id de joueur AILLEURS que sur l'objet joueur lui-même
    // doit être repointé, sinon il continue de désigner une socket morte : perte du
    // statut hôte/ADMIN, ou joueur bloqué "ce n'est pas ton tour" alors que si (mode
    // "guess"). Repéré ici une bonne fois pour toutes plutôt que de laisser chaque
    // fonctionnalité future réintroduire le même bug.
    if (game.hostId === oldId) game.hostId = player.id;
    if (game.adminId === oldId) game.adminId = player.id;
    if (game.guessActivePlayerId === oldId) game.guessActivePlayerId = player.id;
    if (game.auctionBlindSeerId === oldId) game.auctionBlindSeerId = player.id;
    if (game.auctionBidStarterId === oldId) game.auctionBidStarterId = player.id;
    if (game.auctionLot) {
      if (game.auctionLot.seerId === oldId) game.auctionLot.seerId = player.id;
      if (game.auctionLot.currentBidderId === oldId) game.auctionLot.currentBidderId = player.id;
      if (game.auctionLot.activePlayerId === oldId) game.auctionLot.activePlayerId = player.id;
    }
    game.players.forEach(p => {
      if (p.crossedFatesPartner === oldId) p.crossedFatesPartner = player.id;
    });

    socket.emit('rejoin_success', {
      gameId: game.id,
      modifiers: game.modifiers || [],
      status: game.status,
      turn: game.turn,
      maxTurns: game.maxTurns,
      route: game.route,
      boss: game.boss,
      difficulty: game.selectedDifficulty,
      gameMode: game.gameMode,
      adminId: game.adminId,
      activePlayerIds: game.activePlayerIds,
      hostId: game.hostId,
      // Mode "auction" : getPublicPlayers() ne renvoie que score/team (champs Route du
      // Boss) — budget/auctionTeam en sont absents. Sans ce remplacement, un joueur qui
      // se reconnecte après la fin d'un draft (écran final) verrait des équipes/budgets
      // vides jusqu'au prochain événement, qui n'arrive jamais une fois la partie finie.
      // Uniquement si status !== 'waiting' : p.budget/p.auctionTeam ne sont initialisés
      // que par startAuctionGame() (au lancement réel) — y accéder avant planterait
      // (getPublicAuctionPlayers fait p.auctionTeam.length sur un champ encore undefined).
      players: (game.gameMode === 'auction' && game.status !== 'waiting') ? getPublicAuctionPlayers(game) : getPublicPlayers(game),
      // Mode "guess" uniquement : sans ces champs, le client n'a aucun moyen de
      // reconstruire la planche/le tour en cours après une reconnexion. mySecretIndex
      // est UNIQUEMENT le sien (jamais celui de l'adversaire, cf. getPublicPlayers qui
      // ne renvoie qu'un booléen) — sûr ici car rejoin_success cible ce seul socket.
      guessBoard: game.gameMode === 'guess' ? game.guessBoard : undefined,
      guessActivePlayerId: game.gameMode === 'guess' ? game.guessActivePlayerId : undefined,
      guessTurnEndsAt: game.gameMode === 'guess' ? game.guessTurnEndsAt : undefined,
      guessTurnDurationMs: game.gameMode === 'guess' ? (game.guessTurnDurationMs || GUESS_TURN_DURATION_MS) : undefined,
      mySecretIndex: game.gameMode === 'guess' ? player.secretPokemonIndex : undefined,
      // Mode "auction" uniquement : reflet direct (mêmes champs que game_created/joined)
      // du budget/équipe/type déjà choisi, pour reconstruire l'écran de suite sans état
      // intermédiaire manquant. auctionHistory permet de reconstruire l'écran final
      // (liste des lots vendus) si la reconnexion arrive après la fin du draft.
      auctionType: game.gameMode === 'auction' ? game.auctionType : undefined,
      auctionHistory: game.gameMode === 'auction' ? game.auctionHistory : undefined,
      chatMessages: game.chatMessages,
      fly: game.gameMode === 'fly' ? FLY.publicState(game) : undefined
    });
    if (game.gameMode === 'fly') FLY.resyncTurn(game, socket.id);
    if (game.gameMode === 'statdraft') { SD.syncLobby(game, socket); SD.resync(game, socket, player); }

    // Mode "auction" : renvoie le lot en cours à CE seul joueur, avec la même règle de
    // visibilité que broadcastAuctionLot (jamais le Pokémon s'il ne doit pas le voir).
    // Sans ça, un joueur qui recharge la page reste bloqué sans aucun lot affiché jusqu'à
    // ce que le suivant démarre (jusqu'à 20s+ d'écran vide).
    if (game.status === 'playing' && game.gameMode === 'auction' && game.auctionLot) {
      const lot = game.auctionLot;
      const canSeePokemon = game.auctionType !== 'semi_blind' || lot.seerId === player.id;
      socket.emit('auction_lot_started', {
        pokemon: canSeePokemon ? lot.pokemon : null,
        mystery: !canSeePokemon,
        isSeer: canSeePokemon,
        currentBid: lot.currentBid,
        currentBidderId: lot.currentBidderId,
        activePlayerId: lot.activePlayerId,
        canBid: auctionPlayerCanBid(player),
        lotsRemaining: game.auctionPool.length,
        players: getPublicAuctionPlayers(game)
      });
    }

    // Si une manche est en cours et que ce joueur n'a pas encore choisi, on lui renvoie
    // ses options actuelles (mêmes règles de confidentialité qu'à l'assignation normale).
    // Cas plus rares volontairement non reconstruits ici (tour 4 spécial, événement rare
    // en cours) : le joueur retrouve quand même son score/équipe/tour à jour, et
    // rattrapera l'interactivité complète dès le tour suivant.
    if (game.status === 'playing' && game.gameMode !== 'guess' && player.currentChoice === null) {
      if (game.gameMode === 'admin') {
        const joueur = game.players.find(p => p.id !== game.adminId);
        if (player.id === game.adminId && joueur && joueur.currentOptions) {
          io.to(player.id).emit('admin_view_turn_options', {
            turn: game.turn,
            playerName: joueur.name,
            playerScore: joueur.score,
            haut: { ...joueur.currentOptions.haut },
            bas: { ...joueur.currentOptions.bas }
          });
        } else if (player.id !== game.adminId && player.currentOptions) {
          io.to(player.id).emit('player_turn_hidden', { turn: game.turn });
        }
      } else if (player.currentOptions) {
        io.to(player.id).emit('turn_options', {
          haut: {
            name: player.currentOptions.haut.name,
            sprite: player.currentOptions.haut.sprite,
            shiny: player.currentOptions.haut.shiny,
            shinySprite: player.currentOptions.haut.shinySprite
          },
          bas: {
            name: player.currentOptions.bas.name,
            sprite: player.currentOptions.bas.sprite,
            shiny: player.currentOptions.bas.shiny,
            shinySprite: player.currentOptions.bas.shinySprite
          }
        });
      }
    }

    if (game.gameMode === 'guess') {
      broadcastGuessPlayers(game); // les autres voient le badge "hors ligne" disparaître
    } else {
      broadcastGameUpdated(game);
    }
  });

  socket.on('disconnect', () => {
    handleSocketDisconnect(socket);
    if (socket.data.accountUserId) unregisterAccountSocket(socket.data.accountUserId, socket.id);
  });
});

// ---- MODE 'fly' (Humanité vs Mouche) : cerveau partagé, échauffement, XP plafonnée, déroulement de partie ----
const { createBrainStore } = require('./fly-brain-store');
const { registerFlyAdminRoutes } = require('./fly-admin-routes');
const { createFlyGame } = require('./fly-game');
const { createFlyXp } = require('./fly-xp');
const { runWarmup } = require('./fly-warmup');
const flyDraw = () => { const o = pickPlayerTurnOptions(false, 0, undefined, undefined, 'fly'); return [o.haut, o.bas]; };
const flyGetTypes = id => { try { return BOSS_MECHANICS.getTypes(id); } catch (e) { return []; } }; // simple lecture : aucun bonus de type
const flyBst = {};
const flyTypes = {};
Object.values(POKEMON_POOLS).flat().forEach(p => { flyBst[p.id] = p.bst; flyTypes[p.id] = flyGetTypes(p.id); });
const flyBrain = createBrainStore({
  supabase,
  warmup: policy => runWarmup({ policy, draw: flyDraw, bst: flyBst, typesById: flyTypes }) // parties simulées sur tout cerveau neuf
});
registerFlyAdminRoutes(app, { store: flyBrain });
app.get('/api/fly/stats', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(flyBrain.getPublicStats()); // génération, parties vécues, score global, courbe : jamais de valeurs apprises
});
const FLY = createFlyGame({
  io, store: flyBrain,
  recordFlyResult: createFlyXp({ supabase, createAuthClient, xpParticipation: XP_PARTICIPATION, xpVictoryBonus: XP_VICTORY_BONUS }),
  deps: {
    pickPlayerTurnOptions: (...a) => pickPlayerTurnOptions(...a),
    teamMonFromReward: r => teamMonFromReward(r),
    buildRoute: () => buildRoute(),
    getPublicPlayers: g => getPublicPlayers(g),
    maybeScheduleTurnTransition: g => maybeScheduleTurnTransition(g),
    getTypes: flyGetTypes
  }
});

// ---- MODE 'statdraft' (Roulette de Stats) : 6 tirages, une stat de base par tirage, objectif 500/550/625/700 ----
const { createStatDraft } = require('./statdraft-game');
const SD = createStatDraft({
  io, app, games, supabase, createAuthClient,
  pool: Object.values(POKEMON_POOLS).flat(), // { id, name, bst } ; formes de base uniquement (id < 10000), filtrées dans le module
  entries: POKEMON_ENTRIES,
  getTypes: flyGetTypes,
  spriteUrl, shinySpriteUrl,
  dataDir: path.join(__dirname, 'data'),
  xpParticipation: XP_PARTICIPATION, xpVictoryBonus: XP_VICTORY_BONUS,
  broadcastPlayers: g => broadcastPlayers(g),
  log: console
});

// ---- DÉFI QUOTIDIEN : même boss + mêmes 6 tours pour tous (RNG à graine, jour Europe/Paris), classement du jour ----
const { registerDaily } = require('./daily-game');
const dailyApi = registerDaily({
  io, app, supabase, createAuthClient,
  deps: {
    pickRandomBoss: g => pickRandomBoss(g),
    pickPlayerTurnOptions: (...a) => pickPlayerTurnOptions(...a),
    xpParticipation: XP_PARTICIPATION,
    xpVictoryBonus: XP_VICTORY_BONUS
  }
});

// ---- HALL OF FAME : meilleures équipes du jour (parties classées SANS modificateur, mode normal) ----
require('./hall-of-fame').registerHallOfFame({ app, supabase, dayKey: dailyApi.dayKey, titleLabelFor });

// ---- QUÊTES JOURNALIÈRES (3 par jour, progression calculée depuis game_history / daily_scores) ----
require('./quests').registerQuests({ app, supabase, createAuthClient, dayKey: dailyApi.dayKey });

// ---- NOTIFICATIONS PUSH : rappel quotidien du défi (nécessite `npm i web-push` + clés VAPID, cf. push.sql) ----
let webpushModule = null;
try { webpushModule = require('web-push'); } catch (e) { /* optionnel : rappels désactivés sans le module */ }
require('./push-notifications').registerPush({ app, supabase, createAuthClient, daily: dailyApi, webpush: webpushModule });

const PORT = process.env.PORT || 3000;
// Restaure les parties persistées AVANT d'accepter des connexions : sinon un client qui
// se reconnecte dans la fraction de seconde suivant le démarrage pourrait arriver avant
// que sa partie soit relue, et se voir répondre "partie introuvable" à tort.
Promise.all([loadPersistedGames(), flyBrain.load().catch(err => console.error('[fly] chargement du cerveau', err.message))])
  .catch(err => console.error('[persistance] échec inattendu au démarrage', err.message))
  .finally(() => {
    server.listen(PORT, () => {
      console.log(`Serveur lancé sur http://localhost:${PORT}`);
    });
  });

// Export test-only : n'affecte rien en production (module.exports est ignoré quand ce
// fichier est lancé directement via `node server.js`), utilisé uniquement par les
// simulateurs Node en sandbox pour inspecter l'état interne sans réseau réel.
module.exports = { games };