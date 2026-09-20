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

const app = express();
const server = http.createServer(app);
const io = new Server(server);

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
const XP_LEVEL_STEP = 100;
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
  if (!player || !player.accountAccessToken || !supabase || !createAuthClient) return;
  try {
    const { data: { user }, error: userError } = await createAuthClient().auth.getUser(player.accountAccessToken);
    if (userError || !user) return;

    const { data: profile } = await supabase.from('profiles').select('xp').eq('id', user.id).single();
    const newXp = (profile ? (profile.xp || 0) : 0) + xpAmount;
    await supabase.from('profiles').update({ xp: newXp }).eq('id', user.id);

    await supabase.from('game_history').insert({
      user_id: user.id,
      game_mode: details.gameMode,
      result: details.result,
      score: details.score ?? null,
      opponent_name: details.opponentName ?? null,
      difficulty: details.difficulty ?? null,
      team: details.team ?? null
    });

    // Succès (fire-and-forget comme le reste de cette fonction) : jamais bloquant, jamais
    // un pré-requis pour terminer une partie — cf. checkAndUnlockAchievements.
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
const ACHIEVEMENTS = [
  { key: 'first_game', category: 'facile', label: 'Premiers pas', description: 'Termine ta première partie.', check: ctx => ctx.gamesPlayed >= 1 },
  { key: 'first_win', category: 'facile', label: 'Première victoire', description: 'Remporte ta première partie.', check: ctx => ctx.wins >= 1 },
  { key: 'first_legendary', category: 'facile', label: 'Rencontre légendaire', description: 'Obtiens un Pokémon légendaire dans ton équipe.', check: ctx => ctx.hasLegendary },
  { key: 'first_epic', category: 'facile', label: 'Coup de chance', description: 'Obtiens un Pokémon épique dans ton équipe.', check: ctx => ctx.hasEpic },
  { key: 'first_shiny', category: 'facile', label: 'Reflet chromatique', description: 'Obtiens un Pokémon shiny.', check: ctx => ctx.hasShiny },
  { key: 'games_5', category: 'facile', label: 'Habitué', description: 'Termine 5 parties.', check: ctx => ctx.gamesPlayed >= 5 },
  { key: 'guess_win', category: 'facile', label: 'Détective', description: 'Remporte une partie de Devine le Pokémon.', check: ctx => ctx.winModes.has('guess') },
  { key: 'admin_win', category: 'facile', label: "Face à l'IA", description: 'Remporte une partie en mode Admin vs Joueur.', check: ctx => ctx.winModes.has('admin') },
  { key: 'score_6000', category: 'difficile', label: 'Score légendaire', description: 'Atteins un score de 6000 en une seule partie.', check: ctx => ctx.bestScore >= 6000 },
  { key: 'wins_10', category: 'difficile', label: 'Vétéran', description: 'Remporte 10 parties.', check: ctx => ctx.wins >= 10 },
  { key: 'beat_extreme', category: 'difficile', label: "Chasseur d'Arceus", description: 'Bats un boss de difficulté extrême.', check: ctx => ctx.beatExtreme },
  { key: 'full_legendary_team', category: 'difficile', label: 'Équipe de légende', description: 'Termine avec 6 Pokémon légendaires ou pseudo-légendaires.', check: ctx => ctx.fullLegendaryTeam },
  { key: 'auction_full_team', category: 'difficile', label: 'Collectionneur', description: 'Termine un Draft/Enchères avec une équipe complète de 6.', check: ctx => ctx.auctionFullTeam },
  { key: 'three_modes_win', category: 'difficile', label: 'Polyvalent', description: 'Remporte au moins une partie en Route du Boss, Admin vs Joueur ET Devine le Pokémon.', check: ctx => ['normal', 'admin', 'guess'].every(m => ctx.winModes.has(m)) },
  { key: 'win_streak_3', category: 'difficile', label: 'Sur une lancée', description: 'Enchaîne 3 victoires d\'affilée.', check: ctx => ctx.maxWinStreak >= 3 }
];

// Agrège toutes les lignes d'historique d'un joueur (déjà chargées, triées du plus ancien
// au plus récent — cf. l'ORDER BY de l'appelant, nécessaire pour maxWinStreak) en un
// contexte plat, pratique à tester dans chaque `check` ci-dessus. rows[i].team est le
// snapshot stocké par recordGameResult : peut être null (mode "guess") ou un tableau de
// Pokémon.
function buildAchievementContext(rows) {
  const ctx = {
    gamesPlayed: rows.length,
    wins: 0,
    bestScore: 0,
    hasLegendary: false,
    hasEpic: false,
    hasShiny: false,
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
      if (row.team.some(mon => mon.rarity === 'legendaire')) ctx.hasLegendary = true;
      if (row.team.some(mon => mon.rarity === 'epique')) ctx.hasEpic = true;
      if (row.team.some(mon => mon.shiny)) ctx.hasShiny = true;
      if (row.game_mode === 'auction' && row.team.length >= 6) ctx.auctionFullTeam = true;
      if (
        (row.game_mode === 'normal' || row.game_mode === 'admin') &&
        row.team.length === 6 &&
        row.team.every(mon => mon.rarity === 'legendaire' || mon.rarity === 'pseudo_legendaire')
      ) {
        ctx.fullLegendaryTeam = true;
      }
    }
  });

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
        achievements: newlyUnlocked.map(a => ({ key: a.key, label: a.label, description: a.description, category: a.category }))
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
    .select('pseudo, avatar, xp')
    .eq('id', data.user.id)
    .single();

  const xp = profile ? (profile.xp || 0) : 0;
  res.json({
    accessToken: data.session.access_token,
    refreshToken: data.session.refresh_token,
    pseudo: profile ? profile.pseudo : '',
    avatar: profile ? profile.avatar : null,
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
    .select('pseudo, avatar, xp')
    .eq('id', data.user.id)
    .single();

  const xp = profile ? (profile.xp || 0) : 0;
  res.json({
    accessToken: data.session.access_token,
    refreshToken: data.session.refresh_token,
    pseudo: profile ? profile.pseudo : '',
    avatar: profile ? profile.avatar : null,
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
  res.json({
    achievements: ACHIEVEMENTS.map(a => ({
      key: a.key,
      category: a.category,
      label: a.label,
      description: a.description,
      unlocked: unlockedKeys.has(a.key)
    }))
  });
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
    .select('id, pseudo, avatar, xp')
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

function spriteUrl(dexId) {
  return `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/${dexId}.png`;
}

function shinySpriteUrl(dexId) {
  return `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/shiny/${dexId}.png`;
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

function rollShiny() {
  return Math.random() < SHINY_CHANCE;
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

const COMMON_RAW = [
  { id: 10, name: 'Chenipan', points: 56 },
  { id: 13, name: 'Aspicot', points: 57 },
  { id: 280, name: 'Tarsal', points: 57 },
  { id: 265, name: 'Chenipotte', points: 57 },
  { id: 298, name: 'Azurill', points: 58 },
  { id: 401, name: 'Crikzik', points: 58 },
  { id: 273, name: 'Grainipiot', points: 58 },
  { id: 129, name: 'Magicarpe', points: 60 },
  { id: 11, name: 'Chrysacier', points: 63 },
  { id: 14, name: 'Coconfort', points: 65 },
  { id: 194, name: 'Axoloto', points: 68 },
  { id: 161, name: 'Fouinette', points: 70 },
  { id: 261, name: 'Medhyèna', points: 74 },
  { id: 349, name: 'Barpau', points: 86 },
  { id: 263, name: 'Zigzaton', points: 90 },
  { id: 191, name: 'Tournegrin', points: 92 },
  { id: 396, name: 'Étourmi', points: 93 },
  { id: 41, name: 'Nosferapti', points: 94 },
  { id: 399, name: 'Keunotor', points: 96 },
  { id: 16, name: 'Roucool', points: 97 },
  { id: 19, name: 'Rattata', points: 100 },
  { id: 266, name: 'Armulys', points: 100 },
  { id: 268, name: 'Blindalys', points: 100 },
  { id: 21, name: 'Piafabec', points: 104 },
  { id: 163, name: 'Hoothoot', points: 105 },
  { id: 50, name: 'Taupiqueur', points: 107 },
  { id: 172, name: 'Pichu', points: 108 },
  { id: 174, name: 'Toudoudou', points: 110 },
  { id: 276, name: 'Nirondelle', points: 111 },
  { id: 39, name: 'Rondoudou', points: 112 },
  { id: 173, name: 'Mélo', points: 112 },
  { id: 29, name: 'Nidoran♀', points: 114 },
  { id: 32, name: 'Nidoran♂', points: 114 },
  { id: 46, name: 'Paras', points: 123 },
  { id: 23, name: 'Abo', points: 124 },
  { id: 52, name: 'Miaouss', points: 126 },
  { id: 440, name: 'Ptiravi', points: 127 },
  { id: 116, name: 'Hypotrempe', points: 130 },
  { id: 37, name: 'Goupix', points: 132 },
  { id: 60, name: 'Ptitard', points: 134 },
  { id: 74, name: 'Racaillou', points: 134 },
  { id: 27, name: 'Sabelette', points: 135 },
  { id: 69, name: 'Chétiflor', points: 135 },
  { id: 56, name: 'Férosinge', points: 136 },
  { id: 412, name: 'Cheniti', points: 137 },
  { id: 48, name: 'Mimitoss', points: 138 },
  { id: 90, name: 'Kokiyas', points: 138 },
  { id: 155, name: 'Héricendre', points: 139 },
  { id: 84, name: 'Doduo', points: 140 },
  { id: 252, name: 'Arcko', points: 140 },
  { id: 4, name: 'Salamèche', points: 141 },
  { id: 255, name: 'Poussifeu', points: 141 },
  { id: 258, name: 'Gobou', points: 142 },
  { id: 270, name: 'Nénupiot', points: 142 },
  { id: 7, name: 'Carapuce', points: 143 },
  { id: 158, name: 'Kaiminus', points: 144 },
  { id: 1, name: 'Bulbizarre', points: 146 },
  { id: 43, name: 'Mystherbe', points: 148 },
  { id: 152, name: 'Germignon', points: 148 },
  { id: 35, name: 'Mélofée', points: 149 },
  { id: 54, name: 'Psykokwak', points: 149 },
  { id: 118, name: 'Poissirène', points: 150 },
  { id: 98, name: 'Krabby', points: 151 },
  { id: 88, name: 'Tadmorv', points: 152 },
  { id: 86, name: 'Otaria', points: 152 },
  { id: 102, name: 'Noeunoeuf', points: 152 },
  { id: 100, name: 'Voltorbe', points: 155 },
  { id: 96, name: 'Soporifik', points: 155 },
  { id: 216, name: 'Teddiursa', points: 157 },
  { id: 72, name: 'Tentacool', points: 159 },
  { id: 120, name: 'Stari', points: 162 },
  { id: 109, name: 'Smogo', points: 163 },
  { id: 140, name: 'Kabuto', points: 175 },
  { id: 292, name: 'Munja', points: 187 },
  { id: 296, name: 'Makuhita', points: 190 },
  { id: 415, name: 'Apitrini', points: 190 },
  { id: 293, name: 'Chuchmur', points: 190 },
  { id: 108, name: 'Excelangue', points: 196 }

];

const UNCOMMON_RAW = [
  { id: 132, name: 'Métamorph', points: 207 },
  { id: 147, name: 'Minidraco', points: 210 },
  { id: 300, name: 'Skitty', points: 210 },
  { id: 360, name: 'Okéoké', points: 210 },
  { id: 403, name: 'Lixy', points: 210 },
  { id: 287, name: 'Parecool', points: 210 },
  { id: 66, name: 'Machoc', points: 213 },
  { id: 175, name: 'Togepi', points: 214 },
  { id: 79, name: 'Ramoloss', points: 216 },
  { id: 167, name: 'Mimigal', points: 217 },
  { id: 290, name: 'Ningale', points: 217 },
  { id: 187, name: 'Granivol', points: 219 },
  { id: 283, name: 'Arakdo', points: 220 },
  { id: 81, name: 'Magnéti', points: 221 },
  { id: 218, name: 'Limagma', points: 221 },
  { id: 278, name: 'Goélise', points: 221 },
  { id: 220, name: 'Marcacrin', points: 223 },
  { id: 420, name: 'Ceribou', points: 224 },
  { id: 183, name: 'Marill', points: 225 },
  { id: 17, name: 'Roucoups', points: 230 },
  { id: 111, name: 'Rhinocorne', points: 230 },
  { id: 58, name: 'Caninos', points: 230 },
  { id: 281, name: 'Kirlia', points: 230 },
  { id: 406, name: 'Rozbouton', points: 230 },
  { id: 165, name: 'Coxy', points: 231 },
  { id: 307, name: 'Méditikka', points: 232 },
  { id: 30, name: 'Nidorina', points: 236 },
  { id: 433, name: 'Korillon', points: 236 },
  { id: 447, name: 'Riolu', points: 236 },
  { id: 33, name: 'Nidorino', points: 237 },
  { id: 179, name: 'Wattouat', points: 238 },
  { id: 339, name: 'Barloche', points: 241 },
  { id: 438, name: 'Manzaï', points: 242 },
  { id: 269, name: 'Papinox', points: 244 },
  { id: 328, name: 'Kraknoix', points: 244 },
  { id: 363, name: 'Obalie', points: 244 },
  { id: 70, name: 'Boustiflor', points: 245 },
  { id: 44, name: 'Ortide', points: 247 },
  { id: 75, name: 'Gravalanch', points: 247 },
  { id: 267, name: 'Charmillon', points: 247 },
  { id: 137, name: 'Porygon', points: 248 },
  { id: 204, name: 'Pomdepik', points: 248 },
  { id: 285, name: 'Balignon', points: 249 },
  { id: 309, name: 'Dynavolt', points: 249 },
  { id: 353, name: 'Polichombr', points: 249 },
  { id: 355, name: 'Skelénox', points: 249 },
  { id: 259, name: 'Flobio', points: 250 },
  { id: 51, name: 'Triopikeur', points: 251 },
  { id: 253, name: 'Massko', points: 251 },
  { id: 77, name: 'Ponyta', points: 252 },
  { id: 47, name: 'Parasect', points: 252 },
  { id: 256, name: 'Galifeu', points: 252 },
  { id: 400, name: 'Castorno', points: 253 },
  { id: 436, name: 'Archéomire', points: 254 },
  { id: 443, name: 'Griknot', points: 254 },
  { id: 453, name: 'Cradopaud', points: 254 },
  { id: 343, name: 'Balbuto', points: 255 },
  { id: 361, name: 'Stalgamin', points: 255 },
  { id: 371, name: 'Draby', points: 255 },
  { id: 374, name: 'Terhal', points: 255 },
  { id: 262, name: 'Grahyèna', points: 257 },
  { id: 316, name: 'Gloupti', points: 257 },
  { id: 264, name: 'Linéon', points: 258 },
  { id: 223, name: 'Rémoraid', points: 258 },
  { id: 318, name: 'Carvanha', points: 260 },
  { id: 322, name: 'Chamallot', points: 260 },
  { id: 104, name: 'Osselait', points: 261 },
  { id: 209, name: 'Snubbull', points: 262 },
  { id: 24, name: 'Arbok', points: 264 },
  { id: 341, name: 'Écrapince', points: 264 },
  { id: 390, name: 'Ouisticram', points: 264 },
  { id: 53, name: 'Persian', points: 266 },
  { id: 333, name: 'Tylton', points: 266 },
  { id: 431, name: 'Chaglam', points: 266 },
  { id: 439, name: 'Mime Jr.', points: 266 },
  { id: 42, name: 'Nosferalto', points: 270 },
  { id: 393, name: 'Tiplouf', points: 270 },
  { id: 85, name: 'Dodrio', points: 272 },
  { id: 122, name: 'M. Mime', points: 273 },
  { id: 387, name: 'Tortipouss', points: 275 },
  { id: 99, name: 'Krabboss', points: 278 },
  { id: 231, name: 'Phanpy', points: 278 },
  { id: 101, name: 'Électrode', points: 281 },
  { id: 225, name: 'Cadoizo', points: 283 },
  { id: 422, name: 'Sancoki', points: 283 },
  { id: 304, name: 'Galekid', points: 288 },
  { id: 325, name: 'Spoink', points: 288 },
  { id: 370, name: 'Lovdisc', points: 288 },
  { id: 434, name: 'Moufouette', points: 288 },
  { id: 418, name: 'Mustébouée', points: 289 },
  { id: 449, name: 'Hippopotas', points: 289 },
  { id: 451, name: 'Rapion', points: 289 },
  { id: 456, name: 'Écayon', points: 289 },
  { id: 331, name: 'Cacnea', points: 294 },
  { id: 459, name: 'Blizzi', points: 294 },
  { id: 246, name: 'Embrylex', points: 294 },
  { id: 121, name: 'Staross', points: 296 }

];

const RARE_RAW = [
  { id: 25, name: 'Pikachu', points: 307 },
  { id: 63, name: 'Abra', points: 312 },
  { id: 92, name: 'Fantominus', points: 313 },
  { id: 271, name: 'Lombre', points: 315 },
  { id: 274, name: 'Pifeuil', points: 315 },
  { id: 329, name: 'Vibraninf', points: 315 },
  { id: 397, name: 'Étourvol', points: 315 },
  { id: 294, name: 'Ramboum', points: 315 },
  { id: 2, name: 'Herbizarre', points: 318 },
  { id: 5, name: 'Reptincel', points: 320 },
  { id: 366, name: 'Coquiperl', points: 321 },
  { id: 458, name: 'Babimanta', points: 321 },
  { id: 8, name: 'Carabaffe', points: 322 },
  { id: 153, name: 'Macronium', points: 322 },
  { id: 133, name: 'Évoli', points: 323 },
  { id: 156, name: 'Feurisson', points: 324 },
  { id: 425, name: 'Baudrive', points: 324 },
  { id: 159, name: 'Crocrodil', points: 326 },
  { id: 408, name: 'Kranidos', points: 327 },
  { id: 410, name: 'Dinoclier', points: 327 },
  { id: 427, name: 'Laporeille', points: 327 },
  { id: 83, name: 'Canarticho', points: 330 },
  { id: 177, name: 'Natu', points: 330 },
  { id: 345, name: 'Lilia', points: 333 },
  { id: 347, name: 'Anorith', points: 333 },
  { id: 170, name: 'Loupio', points: 335 },
  { id: 228, name: 'Malosse', points: 338 },
  { id: 327, name: 'Spinda', points: 339 },
  { id: 138, name: 'Amonita', points: 340 },
  { id: 404, name: 'Luxio', points: 342 },
  { id: 188, name: 'Floravol', points: 345 },
  { id: 299, name: 'Tarinor', points: 358 },
  { id: 61, name: 'Têtarte', points: 360 },
  { id: 190, name: 'Capumain', points: 362 },
  { id: 302, name: 'Ténéfix', points: 364 },
  { id: 303, name: 'Mysdibule', points: 364 },
  { id: 15, name: 'Dardargnan', points: 367 },
  { id: 402, name: 'Mélokrik', points: 367 },
  { id: 180, name: 'Lainergie', points: 368 },
  { id: 95, name: 'Onix', points: 369 },
  { id: 12, name: 'Papilusion', points: 374 },
  { id: 446, name: 'Goinfrex', points: 374 },
  { id: 315, name: 'Rosélia', points: 378 },
  { id: 67, name: 'Machopeur', points: 383 },
  { id: 20, name: 'Rattatac', points: 387 },
  { id: 301, name: 'Delcatty', points: 388 },
  { id: 320, name: 'Wailmer', points: 388 },
  { id: 193, name: 'Yanma', points: 392 },
  { id: 388, name: 'Boskara', points: 392 },
  { id: 391, name: 'Chimpenfeu', points: 392 },
  { id: 394, name: 'Prinplouf', points: 392 },
  { id: 417, name: 'Pachirisu', points: 392 },
  { id: 311, name: 'Posipi', points: 394 },
  { id: 312, name: 'Négapi', points: 394 },
  { id: 40, name: 'Grodoudou', points: 396 },
  { id: 105, name: 'Ossatueur', points: 396 },
  { id: 358, name: 'Éoko', points: 397 },
  { id: 444, name: 'Carmache', points: 398 },
  { id: 441, name: 'Pijako', points: 399 },
  { id: 64, name: 'Kadabra', points: 400 },
  { id: 93, name: 'Spectrum', points: 400 },
  { id: 308, name: 'Charmina', points: 401 },
  { id: 364, name: 'Phogleur', points: 401 },
  { id: 106, name: 'Kicklee', points: 405 },
  { id: 107, name: 'Tygnon', points: 405 },
  { id: 124, name: 'Lippoutou', points: 405 },
  { id: 176, name: 'Togetic', points: 407 },
  { id: 222, name: 'Corayon', points: 407 },
  { id: 247, name: 'Ymphect', points: 407 },
  { id: 168, name: 'Migalos', points: 408 },
  { id: 148, name: 'Draco', points: 410 },
  { id: 198, name: 'Cornèbre', points: 410 },
  { id: 202, name: 'Qulbutoké', points: 412 },
  { id: 351, name: 'Morphéo', points: 413 },
  { id: 372, name: 'Drackhaus', points: 413 },
  { id: 28, name: 'Sablaireau', points: 414 },
  { id: 49, name: 'Aéromite', points: 414 },
  { id: 413, name: 'Cheniselle', points: 415 },
  { id: 414, name: 'Papilord', points: 415 },
  { id: 185, name: 'Simularbre', points: 416 },
  { id: 203, name: 'Girafarig', points: 418 },
  { id: 57, name: 'Colossinge', points: 418 },
  { id: 277, name: 'Hélédelle', points: 420 },
  { id: 206, name: 'Insolourdo', points: 420 },
  { id: 166, name: 'Coxyclaque', points: 422 },
  { id: 162, name: 'Fouinar', points: 424 },
  { id: 305, name: 'Galegon', points: 425 },
  { id: 313, name: 'Muciole', points: 425 },
  { id: 314, name: 'Lumivole', points: 425 },
  { id: 375, name: 'Métang', points: 425 },
  { id: 359, name: 'Absol', points: 426 },
  { id: 82, name: 'Magnéton', points: 427 },
  { id: 18, name: 'Roucarnage', points: 430 },
  { id: 36, name: 'Mélodelfe', points: 431 },
  { id: 195, name: 'Maraiste', points: 432 },
  { id: 479, name: 'Motisma', points: 434 },
  { id: 26, name: 'Raichu', points: 435 },
  { id: 119, name: 'Poissoroy', points: 435 },
  { id: 207, name: 'Scorplane', points: 436 },
  { id: 45, name: 'Rafflesia', points: 437 },
  { id: 71, name: 'Empiflor', points: 437 },
  { id: 279, name: 'Bekipan', points: 437 },
  { id: 352, name: 'Kecleon', points: 437 },
  { id: 192, name: 'Héliatronc', points: 438 },
  { id: 114, name: 'Saquedeneu', points: 440 },
  { id: 117, name: 'Hypocéan', points: 440 },
  { id: 215, name: 'Farfuret', points: 440 },
  { id: 219, name: 'Volcaropod', points: 442 },
  { id: 80, name: 'Flagadoss', points: 445 },
  { id: 241, name: 'Écrémeuh', points: 445 },
  { id: 125, name: 'Élektek', points: 445 },
  { id: 126, name: 'Magmar', points: 445 },
  { id: 211, name: 'Qwilfish', points: 446 },
  { id: 421, name: 'Ceriflor', points: 446 },
  { id: 31, name: 'Nidoqueen', points: 448 },
  { id: 432, name: 'Chaffreux', points: 448 },
  { id: 34, name: 'Nidoking', points: 450 },
  { id: 87, name: 'Lamantine', points: 450 },
  { id: 455, name: 'Vortente', points: 450 },
  { id: 78, name: 'Galopa', points: 451 },
  { id: 127, name: 'Scarabrute', points: 451 },
  { id: 123, name: 'Insécateur', points: 452 },
  { id: 200, name: 'Feuforêve', points: 452 },
  { id: 55, name: 'Akwakwak', points: 453 },
  { id: 284, name: 'Maskadra', points: 454 },
  { id: 97, name: 'Hypnomade', points: 455 },
  { id: 115, name: 'Kangourex', points: 455 },
  { id: 164, name: 'Noarfang', points: 455 },
  { id: 354, name: 'Branette', points: 456 },
  { id: 356, name: 'Téraclope', points: 456 },
  { id: 291, name: 'Ninjask', points: 457 },
  { id: 457, name: 'Luminéon', points: 457 },
  { id: 171, name: 'Lanturn', points: 458 },
  { id: 335, name: 'Mangriff', points: 459 },
  { id: 336, name: 'Séviper', points: 459 },
  { id: 22, name: 'Rapasdepic', points: 460 },
  { id: 189, name: 'Cotovol', points: 462 },
  { id: 286, name: 'Chapignon', points: 462 },
  { id: 319, name: 'Sharpedo', points: 462 },
  { id: 323, name: 'Camérupt', points: 462 },
  { id: 337, name: 'Séléroc', points: 462 },
  { id: 338, name: 'Solaroc', points: 462 },
  { id: 357, name: 'Tropius', points: 462 },
  { id: 288, name: 'Vigoroth', points: 462 },
  { id: 73, name: 'Tentacruel', points: 463 },
  { id: 139, name: 'Amonistar', points: 465 },
  { id: 3, name: 'Florizarre', points: 470 },
  { id: 134, name: 'Aquali', points: 470 },
  { id: 135, name: 'Voltali', points: 470 },
  { id: 136, name: 'Pyroli', points: 470 },
  { id: 317, name: 'Avaltout', points: 470 },
  { id: 340, name: 'Barbicha', points: 471 },
  { id: 342, name: 'Colhomard', points: 471 },
  { id: 9, name: 'Tortank', points: 474 },
  { id: 324, name: 'Chartor', points: 474 },
  { id: 326, name: 'Groret', points: 474 },
  { id: 416, name: 'Apireine', points: 474 },
  { id: 423, name: 'Tritosor', points: 475 },
  { id: 154, name: 'Méganium', points: 476 },
  { id: 157, name: 'Typhlosion', points: 477 },
  { id: 6, name: 'Dracaufeu', points: 478 },
  { id: 297, name: 'Hariyama', points: 479 },
  { id: 310, name: 'Élecsprint', points: 480 },
  { id: 332, name: 'Cacturne', points: 480 },
  { id: 435, name: 'Moufflair', points: 480 },
  { id: 210, name: 'Granbull', points: 480 },
  { id: 489, name: 'Phione', points: 481 },
  { id: 130, name: 'Léviator', points: 482 }

];

// NERF (~22.5%, appliqué au point de base, AVANT le multiplicateur bonus/malus) :
// épique / pseudo-légendaire / légendaire uniquement. Commun/peu commun/rare inchangés.
const EPIC_RAW = [
  { id: 113, name: 'Leveinard', points: 495 },
  { id: 272, name: 'Ludicolo', points: 498 },
  { id: 362, name: 'Oniglali', points: 498 },
  { id: 428, name: 'Lockpin', points: 498 },
  { id: 478, name: 'Momartik', points: 498 },
  { id: 275, name: 'Tengalice', points: 498 },
  { id: 184, name: 'Azumarill', points: 500 },
  { id: 424, name: 'Capidextre', points: 504 },
  { id: 182, name: 'Joliflor', points: 505 },
  { id: 221, name: 'Cochignon', points: 508 },
  { id: 199, name: 'Roigada', points: 508 },
  { id: 295, name: 'Brouhabam', points: 508 },
  { id: 178, name: 'Xatu', points: 512 },
  { id: 442, name: 'Spiritomb', points: 513 },
  { id: 205, name: 'Foretress', points: 515 },
  { id: 367, name: 'Serpang', points: 516 },
  { id: 368, name: 'Rosabyss', points: 516 },
  { id: 369, name: 'Relicanth', points: 516 },
  { id: 229, name: 'Démolosse', points: 520 },
  { id: 232, name: 'Donphan', points: 525 },
  { id: 212, name: 'Cizayox', points: 528 },
  { id: 454, name: 'Coatox', points: 528 },
  { id: 214, name: 'Scarhino', points: 530 },
  { id: 233, name: 'Porygon2', points: 533 },
  { id: 334, name: 'Altaria', points: 534 },
  { id: 142, name: 'Ptéra', points: 535 },
  { id: 217, name: 'Ursaring', points: 535 },
  { id: 213, name: 'Caratroc', points: 538 },
  { id: 460, name: 'Blizzaroi', points: 539 },
  { id: 778, name: 'Mimiqui', points: 540 },
  { id: 128, name: 'Tauros', points: 540 },
  { id: 409, name: 'Charkos', points: 542 },
  { id: 411, name: 'Bastiodon', points: 542 },
  { id: 419, name: 'Mustéflott', points: 542 },
  { id: 429, name: 'Magirêve', points: 542 },
  { id: 103, name: 'Noadkoko', points: 545 },
  { id: 186, name: 'Tarpaud', points: 545 },
  { id: 160, name: 'Aligatueur', points: 549 },
  { id: 426, name: 'Grodrive', points: 551 },
  { id: 208, name: 'Steelix', points: 552 },
  { id: 346, name: 'Vacilys', points: 552 },
  { id: 348, name: 'Armaldo', points: 552 },
  { id: 112, name: 'Rhinoféros', points: 554 },
  { id: 76, name: 'Grolem', points: 557 },
  { id: 398, name: 'Étouraptor', points: 557 },
  { id: 437, name: 'Archéodong', points: 557 },
  { id: 452, name: 'Drascore', points: 557 },
  { id: 181, name: 'Pharamp', points: 558 },
  { id: 91, name: 'Crustabri', points: 560 },
  { id: 110, name: 'Smogogo', points: 563 },
  { id: 196, name: 'Mentali', points: 565 },
  { id: 197, name: 'Noctali', points: 565 },
  { id: 321, name: 'Wailord', points: 570 },
  { id: 344, name: 'Kaorine', points: 570 },
  { id: 141, name: 'Kabutops', points: 572 },
  { id: 430, name: 'Corboss', points: 572 },
  { id: 62, name: 'Tartard', points: 580 },
  { id: 65, name: 'Alakazam', points: 580 },
  { id: 89, name: 'Grotadmorv', points: 580 },
  { id: 94, name: 'Ectoplasma', points: 581 },
  { id: 461, name: 'Dimoret', points: 587 },
  { id: 472, name: 'Scorvol', points: 587 },
  { id: 38, name: 'Feunard', points: 588 },
  { id: 68, name: 'Mackogneur', points: 590 },
  { id: 407, name: 'Roserade', points: 601 },
  { id: 463, name: 'Coudlangue', points: 601 },
  { id: 469, name: 'Yanmega', points: 601 },
  { id: 282, name: 'Gardevoir', points: 611 },
  { id: 475, name: 'Gallame', points: 613 },
  { id: 448, name: 'Lucario', points: 622 },
  { id: 405, name: 'Luxray', points: 625 },
  { id: 389, name: 'Torterra', points: 631 },
  { id: 450, name: 'Hippodocus', points: 631 },
  { id: 470, name: 'Phyllali', points: 631 },
  { id: 471, name: 'Givrali', points: 631 },
  { id: 476, name: 'Tarinorme', points: 631 },
  { id: 477, name: 'Noctunoir', points: 631 },
  { id: 254, name: 'Jungko', points: 632 },
  { id: 257, name: 'Braségali', points: 633 },
  { id: 260, name: 'Laggron', points: 640 },
  { id: 169, name: 'Nostenfer', points: 640 },
  { id: 131, name: 'Lokhlass', points: 642 },
  { id: 330, name: 'Libégon', points: 642 },
  { id: 395, name: 'Pingoléon', points: 646 },
  { id: 473, name: 'Mammochon', points: 646 },
  { id: 350, name: 'Milobellus', points: 648 },
  { id: 230, name: 'Hyporoi', points: 648 },
  { id: 143, name: 'Ronflex', points: 649 },
  { id: 392, name: 'Simiabraz', points: 658 },
  { id: 462, name: 'Magnézone', points: 660 },
  { id: 464, name: 'Rhinastoc', points: 660 },
  { id: 465, name: 'Bouldeneu', points: 660 },
  { id: 474, name: 'Porygon-Z', points: 660 },
  { id: 637, name: 'Volcarona', points: 665 },
  { id: 59, name: 'Arcanin', points: 674 },
  { id: 466, name: 'Élekable', points: 675 },
  { id: 467, name: 'Maganon', points: 675 },
  { id: 306, name: 'Galeking', points: 678 },
  { id: 365, name: 'Kaimorse', points: 678 },
  { id: 468, name: 'Togekiss', points: 690 },
  { id: 289, name: 'Monaflèmit', points: 690 }

];

// Vrais pseudo-légendaires (évolution 3 stades, très puissants, mais pas légendaires).
// NERF CIBLÉ (~12%, sur les points déjà nerfés de l'étape précédente) : seuls les Pokémon
// clairement au-dessus de la moyenne de leur propre palier sont concernés.
// Moyenne pseudo-légendaire ≈ 818 → Lanssorien (890, +8.8%) est le seul net outlier.
const PSEUDO_LEGENDARY_RAW = [
  { id: 149, name: 'Dracolosse', points: 801 },
  { id: 248, name: 'Tyranocif', points: 801 },
  { id: 373, name: 'Drattak', points: 801 },
  { id: 445, name: 'Carchacrok', points: 802 },
  { id: 376, name: 'Métalosse', points: 802 },
  { id: 635, name: 'Trioxhydre', points: 802 },
  { id: 887, name: 'Lanssorien', points: 802 },
  { id: 706, name: 'Muplodocus', points: 802 }
];

// Moyenne légendaire ≈ 1334 → seuls les 5 nettement au-dessus (>+10%) sont nerfés :
// Arceus (1550, +16%), Koraidon/Miraidon (1510, +13%), Zacian/Zamazenta (1475, +11%).
// Necrozma (1435, +7.6%) reste inchangé : pas assez d'écart pour être "clairement" trop fort.
const LEGENDARY_RAW = [
  { id: 144, name: 'Artikodin', points: 952 },
  { id: 145, name: 'Électhor', points: 952 },
  { id: 146, name: 'Sulfura', points: 952 },
  { id: 243, name: 'Raikou', points: 953 },
  { id: 244, name: 'Entei', points: 954 },
  { id: 245, name: 'Suicune', points: 955 },
  { id: 377, name: 'Regirock', points: 980 },
  { id: 378, name: 'Regice', points: 981 },
  { id: 379, name: 'Registeel', points: 982 },
  { id: 480, name: 'Créhelf', points: 985 },
  { id: 481, name: 'Créfollet', points: 986 },
  { id: 482, name: 'Créfadet', points: 987 },
  { id: 485, name: 'Heatran', points: 995 },
  { id: 488, name: 'Cresselia', points: 996 },
  { id: 385, name: 'Jirachi', points: 1014 },
  { id: 386, name: 'Deoxys', points: 1015 },
  { id: 491, name: 'Darkrai', points: 1015 },
  { id: 800, name: 'Necrozma', points: 1015 },
  { id: 807, name: 'Zeraora', points: 1015 },
  { id: 492, name: 'Shaymin', points: 1015 },
  { id: 802, name: 'Marshadow', points: 1016 },
  { id: 151, name: 'Mew', points: 1016 },
  { id: 494, name: 'Victini', points: 1016 },
  { id: 251, name: 'Celebi', points: 1017 },
  { id: 720, name: 'Hoopa', points: 1017 },
  { id: 380, name: 'Latias', points: 1018 },
  { id: 490, name: 'Manaphy', points: 1018 },
  { id: 381, name: 'Latios', points: 1019 },
  { id: 486, name: 'Regigigas', points: 1020 },
  { id: 889, name: 'Zamazenta', points: 1207 },
  { id: 646, name: 'Kyurem', points: 1208 },
  { id: 888, name: 'Zacian', points: 1210 },
  { id: 1008, name: 'Miraidon', points: 1239 },
  { id: 383, name: 'Groudon', points: 1241 },
  { id: 382, name: 'Kyogre', points: 1241 },
  { id: 1007, name: 'Koraidon', points: 1242 },
  { id: 483, name: 'Dialga', points: 1271 },
  { id: 644, name: 'Zekrom', points: 1271 },
  { id: 791, name: 'Solgaleo', points: 1271 },
  { id: 484, name: 'Palkia', points: 1272 },
  { id: 792, name: 'Lunala', points: 1272 },
  { id: 716, name: 'Xerneas', points: 1272 },
  { id: 150, name: 'Mewtwo', points: 1273 },
  { id: 717, name: 'Yveltal', points: 1273 },
  { id: 249, name: 'Lugia', points: 1273 },
  { id: 250, name: 'Ho-Oh', points: 1273 },
  { id: 487, name: 'Giratina', points: 1273 },
  { id: 384, name: 'Rayquaza', points: 1274 },
  { id: 643, name: 'Reshiram', points: 1274 },
  { id: 493, name: 'Arceus', points: 1401 }
];

function buildPool(rarity, entries) {
  return entries.map(p => ({ ...p, rarity, sprite: spriteUrl(p.id) }));
}

// -----------------------------------------------------------------
// Évolutions réelles (forme finale) pour le Bonbon XP. Couvre tous les
// Pokémon commun/peu commun/rare de base ou intermédiaires qui ont une
// évolution standard simple (pas d'évolution par échange/objet, pas de
// branches multiples comme Évoli). Les entrées déjà "finales" (Persian,
// Dracaufeu, Grolem, etc.) ne sont volontairement pas dans cette table :
// elles ne sont pas évoluables. Réutilise les points déjà définis dans
// les pools existants quand la forme finale y figure déjà (cohérence).
// -----------------------------------------------------------------
const EVOLUTION_MAP = {
  1: { id: 3, name: 'Florizarre', points: 470 },
  4: { id: 6, name: 'Dracaufeu', points: 478 },
  7: { id: 9, name: 'Tortank', points: 474 },
  10: { id: 12, name: 'Papilusion', points: 374 },
  13: { id: 15, name: 'Dardargnan', points: 367 },
  16: { id: 18, name: 'Roucarnage', points: 430 },
  17: { id: 18, name: 'Roucarnage', points: 430 },
  19: { id: 20, name: 'Rattatac', points: 387 },
  23: { id: 24, name: 'Arbok', points: 264 },
  27: { id: 28, name: 'Sablaireau', points: 414 },
  29: { id: 31, name: 'Nidoqueen', points: 448 },
  30: { id: 31, name: 'Nidoqueen', points: 448 },
  32: { id: 34, name: 'Nidoking', points: 450 },
  33: { id: 34, name: 'Nidoking', points: 450 },
  35: { id: 36, name: 'Mélodelfe', points: 431 },
  37: { id: 38, name: 'Feunard', points: 588 },
  39: { id: 40, name: 'Grodoudou', points: 396 },
  41: { id: 169, name: 'Nostenfer', points: 640 },
  42: { id: 169, name: 'Nostenfer', points: 640 },
  43: { id: 45, name: 'Rafflesia', points: 437 },
  44: { id: 45, name: 'Rafflesia', points: 437 },
  46: { id: 47, name: 'Parasect', points: 252 },
  48: { id: 49, name: 'Aéromite', points: 414 },
  50: { id: 51, name: 'Triopikeur', points: 251 },
  52: { id: 53, name: 'Persian', points: 266 },
  54: { id: 55, name: 'Akwakwak', points: 453 },
  56: { id: 57, name: 'Colossinge', points: 418 },
  58: { id: 59, name: 'Arcanin', points: 674 },
  60: { id: 62, name: 'Tartard', points: 580 },
  63: { id: 65, name: 'Alakazam', points: 580 },
  66: { id: 68, name: 'Mackogneur', points: 590 },
  67: { id: 68, name: 'Mackogneur', points: 590 },
  69: { id: 71, name: 'Empiflor', points: 437 },
  70: { id: 71, name: 'Empiflor', points: 437 },
  72: { id: 73, name: 'Tentacruel', points: 463 },
  74: { id: 76, name: 'Grolem', points: 557 },
  75: { id: 76, name: 'Grolem', points: 557 },
  77: { id: 78, name: 'Galopa', points: 451 },
  79: { id: 80, name: 'Flagadoss', points: 445 },
  81: { id: 82, name: 'Magnéton', points: 427 },
  84: { id: 85, name: 'Dodrio', points: 272 },
  88: { id: 89, name: 'Grotadmorv', points: 580 },
  92: { id: 94, name: 'Ectoplasma', points: 581 },
  98: { id: 99, name: 'Krabboss', points: 278 },
  100: { id: 101, name: 'Électrode', points: 281 },
  104: { id: 105, name: 'Ossatueur', points: 396 },
  109: { id: 110, name: 'Smogogo', points: 563 },
  111: { id: 112, name: 'Rhinoféros', points: 554 },
  116: { id: 230, name: 'Hyporoi', points: 648 },
  120: { id: 121, name: 'Staross', points: 296 },
  129: { id: 130, name: 'Léviator', points: 482 },
  140: { id: 141, name: 'Kabutops', points: 572 },
  147: { id: 149, name: 'Dracolosse', points: 801 }
};

const POKEMON_POOLS = {
  commun: buildPool('commun', COMMON_RAW),
  peu_commun: buildPool('peu_commun', UNCOMMON_RAW),
  rare: buildPool('rare', RARE_RAW),
  epique: buildPool('epique', EPIC_RAW),
  pseudo_legendaire: buildPool('pseudo_legendaire', PSEUDO_LEGENDARY_RAW),
  legendaire: buildPool('legendaire', LEGENDARY_RAW)
};

// Liste à plat de tous les dex id uniques du pool (tous paliers confondus), calculée une
// seule fois au démarrage. Sert uniquement au préchargement client des sprites (cf.
// app.get('/api/sprite-ids') plus bas + client.js) : le but est que le navigateur ait
// déjà les images en cache AVANT qu'un tour ne les demande réellement, pour supprimer le
// petit flash/délai de chargement visible autrement à chaque nouveau Pokémon tiré.
const ALL_DEX_IDS = [...new Set(
  Object.values(POKEMON_POOLS).flat().map(mon => mon.id)
)].sort((a, b) => a - b);

// Probabilité de tirage de chaque rareté (somme = 1). Commun très fréquent,
// légendaire extrêmement rare, mais assez généreux pour qu'une partie complète
// (6 tours × 2 options) ait de bonnes chances de croiser au moins un Pokémon fort.
const RARITY_TABLE = [
  { rarity: 'commun', weight: 0.39 },
  { rarity: 'peu_commun', weight: 0.26 },
  { rarity: 'rare', weight: 0.17 },
  { rarity: 'epique', weight: 0.09 },
  { rarity: 'pseudo_legendaire', weight: 0.06 },
  { rarity: 'legendaire', weight: 0.03 }
];

// Charme Chroma : les raretés "puissantes" voient leur poids multiplié par ×2.5,
// le reste est renormalisé proportionnellement pour que la somme reste 1 (pas de
// probabilité invalide, pas de garantie absolue non plus).
const SHINY_CHARM_MULTIPLIER = 2.5;
const SHINY_CHARM_BOOSTED_RARITIES = ['epique', 'pseudo_legendaire', 'legendaire'];

// -----------------------------------------------------------------
// Anti-RNG / pity, par joueur. N'accorde JAMAIS de légendaire garanti : réduit
// seulement les séries de malchance extrêmes. "Bonne rareté" = rare et au-dessus
// (même palier que le boost ci-dessous) ; "mauvaise" = commun/peu_commun.
// Progressif comme demandé (0 -> normal, 1 très léger, 2 léger, 3-4 supplémentaire,
// 5+ plus important), plafonné à 5 pour éviter un boost qui grandit indéfiniment.
// -----------------------------------------------------------------
const PITY_BOOSTED_RARITIES = ['rare', 'epique', 'pseudo_legendaire', 'legendaire'];
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
// de la table, il ne force jamais une seule rareté à 100%).
const RARITY_ORDER = ['commun', 'peu_commun', 'rare', 'epique', 'pseudo_legendaire', 'legendaire'];

// Applique un ou plusieurs boosts multiplicatifs à une table de poids, PUIS
// normalise une seule fois à la fin (jamais de "probabilité × pity × 2.5" brut,
// qui produirait des probabilités absurdes en cas de cumul).
// extraBoost est optionnel (CROSSED_FATES) : un petit bonus supplémentaire sur les mêmes
// raretés que le pity, cumulable avec pity/Charme mais toujours renormalisé une seule fois.
function buildWeightedRarityTable({ useCharm, pity, floorRarity, extraBoost }) {
  const pityMultiplier = getPityMultiplier(pity);
  const boost = extraBoost || 1;
  let weighted = RARITY_TABLE.map(entry => {
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

function pickRarity(useCharm, pity, floorRarity, extraBoost) {
  const table = buildWeightedRarityTable({ useCharm, pity, floorRarity, extraBoost });
  const roll = Math.random();
  let cumulative = 0;
  for (const entry of table) {
    cumulative += entry.weight;
    if (roll < cumulative) return entry.rarity;
  }
  return table[table.length - 1].rarity; // filet de sécurité (arrondis flottants)
}

// Bonus / malus secrets appliqués au tirage d'un Pokémon.
// Multiplicateurs inchangés — seule leur fréquence d'apparition change (poids ci-dessous) :
// ~75% Neutre (aucun modificateur perceptible), ~25% répartis entre les 8 vrais bonus/malus.
const EFFECTS = [
  { name: 'Neutre', multiplier: 1.0, weight: 75 },
  { name: 'Salzmann secret technique', multiplier: 1.2, weight: 3.125 },
  { name: 'Beauty privilege', multiplier: 1.3, weight: 3.125 },
  { name: 'Motivé', multiplier: 1.1, weight: 3.125 },
  { name: 'Sous steroïde', multiplier: 1.15, weight: 3.125 },
  { name: 'Sub-5', multiplier: 0.75, weight: 3.125 },
  { name: 'Lagging', multiplier: 0.8, weight: 3.125 },
  { name: 'Skill issues', multiplier: 0.6, weight: 3.125 },
  { name: 'Épine dans le pied', multiplier: 0.7, weight: 3.125 }
];

const EFFECTS_TOTAL_WEIGHT = EFFECTS.reduce((sum, e) => sum + e.weight, 0);

function pickEffect() {
  let roll = Math.random() * EFFECTS_TOTAL_WEIGHT;
  for (const effect of EFFECTS) {
    if (roll < effect.weight) return effect;
    roll -= effect.weight;
  }
  return EFFECTS[0]; // filet de sécurité (arrondis flottants) -> Neutre
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
  'très difficile': 'hard',
  extrême: 'extreme'
};

// facile ≈ P50 | moyen ≈ P58 | difficile ≈ P77 | très difficile ≈ P90 | extrême ≈ P97
const BOSSES = [
  { id: 249, name: 'Lugia', requiredPoints: 1650, difficulty: 'facile' },
  { id: 250, name: 'Ho-Oh', requiredPoints: 1650, difficulty: 'facile' },
  { id: 384, name: 'Rayquaza', requiredPoints: 1750, difficulty: 'moyen' },
  { id: 383, name: 'Groudon', requiredPoints: 1750, difficulty: 'moyen' },
  { id: 382, name: 'Kyogre', requiredPoints: 1750, difficulty: 'moyen' },
  { id: 483, name: 'Dialga', requiredPoints: 1750, difficulty: 'moyen' },
  { id: 484, name: 'Palkia', requiredPoints: 1750, difficulty: 'moyen' },
  { id: 487, name: 'Giratina', requiredPoints: 2150, difficulty: 'difficile' },
  { id: 643, name: 'Reshiram', requiredPoints: 2150, difficulty: 'difficile' },
  { id: 644, name: 'Zekrom', requiredPoints: 2150, difficulty: 'difficile' },
  { id: 150, name: 'Mewtwo', requiredPoints: 2150, difficulty: 'difficile' },
  { id: 716, name: 'Xerneas', requiredPoints: 2600, difficulty: 'très difficile' },
  { id: 717, name: 'Yveltal', requiredPoints: 2600, difficulty: 'très difficile' },
  { id: 888, name: 'Zacian', requiredPoints: 2600, difficulty: 'très difficile' },
  { id: 889, name: 'Zamazenta', requiredPoints: 2600, difficulty: 'très difficile' },
  { id: 1007, name: 'Koraidon', requiredPoints: 3200, difficulty: 'extrême' },
  { id: 1008, name: 'Miraidon', requiredPoints: 3200, difficulty: 'extrême' },
  { id: 493, name: 'Arceus', requiredPoints: 3200, difficulty: 'extrême' }
].map(b => ({ ...b, group: DIFFICULTY_TO_GROUP[b.difficulty], sprite: spriteUrl(b.id) }));

// 4 groupes de difficulté sélectionnables dans le lobby (feature difficulté du boss).
// "difficile" et "très difficile" sont fusionnés dans le groupe "hard" : aucun boss
// supprimé, ils gardent simplement des objectifs différents (2150 et 2600) au sein
// du même groupe, ce qui est explicitement acceptable.
const BOSS_GROUPS = ['easy', 'medium', 'hard', 'extreme'];

function pickRandomBoss(group) {
  const pool = BOSSES.filter(b => b.group === group);
  return randomFrom(pool.length ? pool : BOSSES); // filet de sécurité si groupe invalide/vide
}

// Bonus du tour 4 spécial. Poids = probabilité d'être PROPOSÉ (parmi les 2 options),
// pas une garantie d'obtention : le joueur choisit ensuite lequel des deux il prend.
const BONUS_WEIGHTS = {
  xpCandy: 35,
  mysteryItem: 35,
  shinyCharm: 30
};

const BONUS_LABELS = {
  xpCandy: 'Bonbon XP',
  mysteryItem: 'Objet Mystère',
  shinyCharm: 'Charme Chroma'
};

function weightedPickKey(entries) {
  const total = entries.reduce((sum, e) => sum + e.weight, 0);
  let roll = Math.random() * total;
  for (const entry of entries) {
    if (roll < entry.weight) return entry.key;
    roll -= entry.weight;
  }
  return entries[entries.length - 1].key;
}

// Bonbon XP n'est proposable que si le joueur a au moins un Pokémon évoluable.
function getAvailableBonusKeys(player) {
  return Object.keys(BONUS_WEIGHTS).filter(key => {
    if (key === 'xpCandy') return player.team.some(mon => EVOLUTION_MAP[mon.id]);
    return true;
  });
}

// Tire 2 bonus DIFFÉRENTS parmi ceux réellement disponibles pour ce joueur.
function pickTwoBonuses(player) {
  const available = getAvailableBonusKeys(player).map(key => ({ key, weight: BONUS_WEIGHTS[key] }));
  const first = weightedPickKey(available);
  const remaining = available.filter(e => e.key !== first);
  const second = weightedPickKey(remaining);
  return [first, second];
}

function randomFrom(list) {
  return list[Math.floor(Math.random() * list.length)];
}

// ---- Helpers de mutation d'un Pokémon d'équipe (factorisent un pattern répété par
// tous les événements rares qui modifient un Pokémon existant : talent caché, évolution
// instantanée, double ou rien, shiny, loterie, Bonbon XP, Objet Mystère). ----

// Contribution actuelle d'un Pokémon au score (arrondie, jamais stockée : recalculée
// à chaque fois à partir de basePoints/multiplier, seule source de vérité).
function monContribution(mon) {
  return Math.round(mon.basePoints * mon.multiplier);
}

// Applique une mutation à un Pokémon puis répercute la différence de contribution sur
// le score du joueur. `mutate` reçoit le Pokémon et le modifie en place. Retourne le
// scoreDelta appliqué.
function applyMonMutation(player, mon, mutate) {
  const before = monContribution(mon);
  mutate(mon);
  const after = monContribution(mon);
  const scoreDelta = after - before;
  player.score += scoreDelta;
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
  mon.basePoints = evolution.points;
  mon.evolvedFrom = fromName;
  return fromName;
}

// Assigne un trait/effet à un Pokémon. Mutation en place.
function assignEffect(mon, effect) {
  mon.effectName = effect.name;
  mon.multiplier = effect.multiplier;
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
    multiplier: reward.multiplier
  };
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
// fonction (tirage normal, DOUBLE_ENCOUNTER, TIME_RIFT, LOTTERY).
function buildRewardOption(useCharm, pity, floorRarity, extraBoost) {
  const rarity = pickRarity(useCharm, pity, floorRarity, extraBoost);
  const pokemon = randomFrom(POKEMON_POOLS[rarity]);
  const effect = pickEffect();
  const shiny = rollShiny();
  const finalPoints = Math.round(pokemon.points * effect.multiplier * (shiny ? SHINY_POINTS_MULTIPLIER : 1));

  return {
    pokemonId: pokemon.id,
    name: pokemon.name,
    sprite: pokemon.sprite,
    rarity: pokemon.rarity,
    basePoints: pokemon.points,
    effectName: effect.name,
    multiplier: effect.multiplier,
    shiny,
    shinySprite: shiny ? shinySpriteUrl(pokemon.id) : null,
    finalPoints
  };
}

// Génère les 2 options HAUT/BAS d'un joueur pour un tour (toujours 2 Pokémon distincts).
function pickPlayerTurnOptions(useCharm, pity, floorRarity, extraBoost) {
  const haut = buildRewardOption(useCharm, pity, floorRarity, extraBoost);
  let bas = buildRewardOption(useCharm, pity, floorRarity, extraBoost);

  let guard = 0;
  while (bas.pokemonId === haut.pokemonId && guard < 10) {
    bas = buildRewardOption(useCharm, pity, floorRarity, extraBoost);
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
  { rarity: 'legendaire', weight: 0.12 }
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
  const finalPoints = Math.round(pokemon.points * effect.multiplier * (shiny ? SHINY_POINTS_MULTIPLIER : 1));

  return {
    pokemonId: pokemon.id,
    name: pokemon.name,
    sprite: pokemon.sprite,
    rarity: pokemon.rarity,
    basePoints: pokemon.points,
    effectName: effect.name,
    multiplier: effect.multiplier,
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

// Taille de la planche pilotée par la difficulté choisie dans le lobby (réutilise le
// même sélecteur que Route du Boss — jamais un 2e réglage séparé). Plus de Pokémon en
// jeu = plus de possibilités à éliminer = plus difficile à deviner.
const GUESS_BOARD_SIZE_BY_DIFFICULTY = {
  easy: 15,
  medium: 20,
  hard: 30,
  extreme: 40
};

// Nombre de cases tirées par palier pour chaque taille de planche (la somme de chaque
// ligne correspond exactement à la taille visée). Toujours un peu de chaque palier,
// jamais tout un palier d'un coup : la planche reste variée même à 15 cases.
const GUESS_TIER_COUNTS_BY_DIFFICULTY = {
  easy: { commun: 5, peu_commun: 3, rare: 3, epique: 2, pseudo_legendaire: 1, legendaire: 1 },
  medium: { commun: 6, peu_commun: 5, rare: 4, epique: 3, pseudo_legendaire: 1, legendaire: 1 },
  hard: { commun: 9, peu_commun: 7, rare: 6, epique: 5, pseudo_legendaire: 2, legendaire: 1 },
  extreme: { commun: 11, peu_commun: 9, rare: 8, epique: 6, pseudo_legendaire: 3, legendaire: 3 }
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
    const shuffledTier = shuffleArray(POKEMON_POOLS[tier]);
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
    const shuffled = shuffleArray(POKEMON_POOLS[tier]);
    picked.push(...shuffled.slice(0, count));
  }
  return shuffleArray(picked).map(p => ({ id: p.id, name: p.name, sprite: p.sprite, points: p.points }));
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
  LOTTERY: 'LOTTERY',
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
    id: EVENT_TYPES.LOTTERY,
    label: 'Loterie',
    probability: 0.02,
    scope: 'solo',
    implemented: true,
    condition: () => true
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
    case EVENT_TYPES.LOTTERY: return startLottery(game, player);
    case EVENT_TYPES.TIME_RIFT: return startTimeRift(game, player);
    case EVENT_TYPES.DUEL: return startDuel(game, player);
    case EVENT_TYPES.CROSSED_FATES: return startCrossedFates(game, player);
    default: return null;
  }
}

// ---- DOUBLE RENCONTRE : 2 Pokémon générés, le joueur en garde un, l'autre disparaît. ----
// N'affecte PAS le pity : c'est un tirage bonus hors flux principal, pas un tour normal.
function startDoubleEncounter(game, player) {
  const useCharm = player.hasShinyCharm && game.turn >= 5;
  const optionA = buildRewardOption(useCharm, player.pity);
  let optionB = buildRewardOption(useCharm, player.pity);
  let guard = 0;
  while (optionB.pokemonId === optionA.pokemonId && guard < 10) {
    optionB = buildRewardOption(useCharm, player.pity);
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
  const scoreDelta = chosen.finalPoints - monContribution(replacedMon);
  player.team[replaceIndex] = teamMonFromReward(chosen);
  player.score += scoreDelta;

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

  const success = Math.random() < 0.5; // 50/50 côté serveur, jamais le client
  const scoreDelta = applyMonMutation(player, mon, m => { m.multiplier = success ? m.multiplier * 2 : 0; });

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

  const newEffect = randomFrom(EFFECTS.filter(e => e.name !== 'Neutre'));
  const scoreDelta = applyMonMutation(player, mon, m => assignEffect(m, newEffect));

  return {
    result: {
      type: EVENT_TYPES.HIDDEN_TALENT,
      pokemonName: mon.name,
      sprite: mon.sprite,
      effect: { name: newEffect.name, multiplier: newEffect.multiplier },
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
  const scoreDelta = applyMonMutation(player, mon, m => { fromName = evolveMon(m, evolution); });

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
  });

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
// assignTurnOptions / special_choice). Ne garantit jamais un légendaire : seule la
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

// ---- LOTERIE : 3 cartes générées côté serveur (le client ne voit que leur nombre),
// le joueur choisit un index, jamais le contenu. Récompenses variées en réutilisant
// exactement les systèmes existants (Pokémon / points / trait / évolution). ----
const LOTTERY_POINTS_MIN = 150;
const LOTTERY_POINTS_MAX = 350;

function buildLotteryCard(game, player) {
  const kinds = ['pokemon', 'points'];
  if (player.team.length > 0) kinds.push('trait');
  if (player.team.some(mon => EVOLUTION_MAP[mon.id])) kinds.push('evolution');
  const kind = randomFrom(kinds);

  if (kind === 'points') {
    const points = LOTTERY_POINTS_MIN + Math.floor(Math.random() * (LOTTERY_POINTS_MAX - LOTTERY_POINTS_MIN + 1));
    return { kind, points };
  }
  if (kind === 'trait') {
    const teamIndex = Math.floor(Math.random() * player.team.length);
    const effect = randomFrom(EFFECTS.filter(e => e.name !== 'Neutre'));
    return { kind, teamIndex, effect };
  }
  if (kind === 'evolution') {
    const eligible = player.team.map((mon, index) => ({ index, mon })).filter(({ mon }) => EVOLUTION_MAP[mon.id]);
    const pick = randomFrom(eligible);
    return { kind, teamIndex: pick.index };
  }
  // kind === 'pokemon' (toujours disponible, défaut)
  const useCharm = player.hasShinyCharm && game.turn >= 5;
  return { kind: 'pokemon', pokemon: buildRewardOption(useCharm, player.pity) };
}

function startLottery(game, player) {
  const cards = [1, 2, 3].map(() => buildLotteryCard(game, player));
  player.activeEvent = { type: EVENT_TYPES.LOTTERY, cards };
  io.to(player.id).emit('rare_event_start', {
    type: EVENT_TYPES.LOTTERY,
    label: 'Loterie',
    cardCount: cards.length // le client ne connaît QUE le nombre de cartes, jamais leur contenu
  });
  return player.activeEvent;
}

function resolveLottery(game, player, action) {
  const cards = player.activeEvent.cards;
  const index = action && Number.isInteger(action.index) && action.index >= 0 && action.index < cards.length
    ? action.index
    : null;
  if (index === null) return { error: 'Choix invalide.' };

  const card = cards[index];
  const result = { type: EVENT_TYPES.LOTTERY, kind: card.kind };

  if (card.kind === 'pokemon') {
    player.score += card.pokemon.finalPoints;
    pushMonToTeam(player, teamMonFromReward(card.pokemon));
    result.pokemon = { name: card.pokemon.name, sprite: card.pokemon.sprite };
    result.rarity = card.pokemon.rarity;
    result.pointsGained = card.pokemon.finalPoints;
  } else if (card.kind === 'points') {
    player.score += card.points;
    result.pointsGained = card.points;
  } else if (card.kind === 'trait') {
    const mon = player.team[card.teamIndex];
    if (mon) {
      result.scoreDelta = applyMonMutation(player, mon, m => assignEffect(m, card.effect));
      result.pokemonName = mon.name;
      result.sprite = mon.sprite;
      result.effect = { name: card.effect.name, multiplier: card.effect.multiplier };
    }
  } else if (card.kind === 'evolution') {
    const mon = player.team[card.teamIndex];
    const evolution = mon && EVOLUTION_MAP[mon.id];
    if (mon && evolution) {
      let fromName;
      result.scoreDelta = applyMonMutation(player, mon, m => { fromName = evolveMon(m, evolution); });
      result.from = fromName;
      result.to = mon.name;
      result.sprite = mon.sprite;
    }
  }

  result.score = player.score;
  result.team = player.team;
  return { result };
}

// ---- FAILLE SPATIO-TEMPORELLE : table spéciale (plancher pseudo-légendaire), reste un
// tirage RNG normal via le même mécanisme poids+normalisation — jamais 100% légendaire.
// Instantané, comme SHINY_POKEMON/LUCKY_TURN : aucun choix décrit pour cet événement. ----
const TIME_RIFT_FLOOR_RARITY = 'pseudo_legendaire'; // uniquement pseudo-légendaire ou légendaire, jamais garanti lequel

// Ne grossit JAMAIS l'équipe au-delà de 6 : le tirage spécial est proposé, mais le
// joueur doit choisir lequel de ses Pokémon actuels il remplace, ou skip (rien ne change).
function startTimeRift(game, player) {
  const useCharm = player.hasShinyCharm && game.turn >= 5;
  const reward = buildRewardOption(useCharm, player.pity, TIME_RIFT_FLOOR_RARITY);

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

  const scoreDelta = reward.finalPoints - monContribution(replacedMon);
  player.team[replaceIndex] = teamMonFromReward(reward);
  player.score += scoreDelta;

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
    case EVENT_TYPES.LOTTERY: return resolveLottery(game, player, action);
    case EVENT_TYPES.TIME_RIFT: return resolveTimeRift(game, player, action);
    case EVENT_TYPES.DUEL: return resolveDuel(game, player, action);
    default: return { error: "Type d'événement inconnu." };
  }
}

function buildRoute() {
  return Array.from({ length: MAX_TURNS }, (_, i) => ({
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
//   hasShinyCharm: bool (Charme Chroma actif, propre au joueur, effet tours 5-6 uniquement),
//   currentBonusOptions: [keyA, keyB] | null (2 bonus proposés au tour 4, secret intermédiaire),
//   pendingBonusKey: 'xpCandy' | 'mysteryItem' | null (bonus choisi, en attente de la cible)
// }
// ---------------------------------------------------------------
const games = {};

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
  if (!supabase || game.status !== 'playing') return;
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
const GAME_MODES = ['normal', 'admin', 'guess', 'auction'];

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
  // Mélange volontairement large et varié (30 lots), tiré sans répétition depuis
  // POKEMON_POOLS (cf. buildAuctionPool) — largement assez pour que les 2 joueurs
  // puissent chacun compléter une équipe de 6, même si plusieurs lots ne trouvent
  // aucun acheteur (cf. section 26 du brief : Pokémon retiré si personne n'enchérit).
  commun: 8,
  peu_commun: 6,
  rare: 6,
  epique: 5,
  pseudo_legendaire: 3,
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
  return {
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
    token: token || generateToken(), // filet de sécurité si un vieux client n'en envoie pas
    disconnected: false, // cf. RECONNECT_GRACE_MS — true pendant le délai de grâce
    disconnectTimer: null,
    score: 0,
    team: [],
    currentChoice: null,
    currentOptions: null,
    hasShinyCharm: false,
    currentBonusOptions: null,
    pendingBonusKey: null,
    pity: 0, // compteur anti-RNG individuel, jamais partagé entre joueurs
    activeEvent: null, // événement rare en cours pour CE joueur (jamais 2 à la fois)
    eventCooldown: 0, // nb de tours restants avant qu'un nouvel événement puisse se tirer
    rarityFloor: null, // effet différé de LUCKY_TURN : plancher de rareté pour le PROCHAIN tirage, à usage unique
    rarityBoost: null, // petit bonus différé de CROSSED_FATES pour le PROCHAIN tirage, à usage unique
    crossedFatesPartner: null, // id du joueur lié (CROSSED_FATES), consommé au prochain choix de CE joueur
    secretPokemonIndex: null // mode "guess" uniquement : case choisie sur guessBoard, jamais révélée à l'adversaire
  };
}

// Ne renvoie jamais currentOptions au client (secret tant que le choix n'est pas fait).
// Ne renvoie jamais token non plus (secret de reconnexion : seul le joueur concerné le
// connaît, cf. rejoin_success qui le renvoie uniquement à l'intéressé).
function getPublicPlayers(game) {
  return game.players.map(p => ({
    id: p.id,
    name: p.name,
    avatar: p.avatar,
    disconnected: p.disconnected,
    score: p.score,
    team: p.team,
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
  io.to(game.id).emit('game_updated', {
    status: game.status,
    turn: game.turn,
    maxTurns: game.maxTurns,
    route: game.route,
    players: getPublicPlayers(game),
    hostId: game.hostId,
    adminId: game.adminId,
    spectatorCount: game.spectators ? game.spectators.length : 0
  });
}

// Génère et envoie individuellement à chaque joueur ses 2 choix (sprite + nom uniquement).
// Le Charme Chroma (par joueur) n'améliore les probabilités qu'aux tours 5 et 6.
function assignTurnOptions(game) {
  game.players.forEach(p => {
    const useCharm = p.hasShinyCharm && game.turn >= 5;
    p.currentOptions = pickPlayerTurnOptions(useCharm, p.pity, p.rarityFloor || undefined, p.rarityBoost || undefined);
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

// Démarre un tour pour tous les joueurs. Au tour 4, phase spéciale : on ne révèle
// rien tout de suite, chaque joueur doit d'abord choisir POKÉMON ou BONUS
// (cf. socket.on('special_choice')). Tous les autres tours : flux normal inchangé.
//
// Mode ADMIN VS JOUEUR : décision de gameplay volontaire — pas de tour 4 spécial
// (Bonbon XP / Objet Mystère) dans ce mode. Les 6 tours y sont tous des manches
// identiques (assignAdminModeOptions), y compris le tour 4.
function startTurnForPlayers(game) {
  if (game.gameMode === 'admin') {
    assignAdminModeOptions(game);
    return;
  }
  if (game.turn === 4) {
    game.players.forEach(p => {
      io.to(p.id).emit('advantage_options', {});
    });
  } else {
    assignTurnOptions(game);
  }
}

function advanceTurn(game) {
  game.route[game.turn - 1].status = 'done';
  game.turn += 1;
  game.route[game.turn - 1].status = 'current';
  game.players.forEach(p => {
    p.currentChoice = null;
    p.currentOptions = null;
    p.currentBonusOptions = null;
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
  broadcastGameUpdated(game);
  startTurnForPlayers(game);
}

function finishGame(game) {
  game.status = 'finished';
  deletePersistedGame(game.id); // partie finie : plus jamais besoin de la restaurer après un redémarrage
  game.route[game.route.length - 1].status = 'done';

  // Mode ADMIN VS JOUEUR : un seul résultat réel (celui du JOUEUR, seul à avoir un score).
  // L'ADMIN n'a pas sa propre victoire/défaite : la sienne est l'INVERSE de celle du
  // JOUEUR (cf. spec section 20 — JOUEUR gagne = ADMIN perd, et inversement). Sans ce
  // cas particulier, l'ADMIN (score toujours à 0) serait toujours marqué "defeat", même
  // quand le JOUEUR l'emporte.
  const joueur = game.gameMode === 'admin' ? game.players.find(p => p.id !== game.adminId) : null;
  const joueurWon = joueur ? joueur.score >= game.boss.requiredPoints : null;

  const results = game.players.map(p => {
    if (game.gameMode === 'admin' && p.id === game.adminId) {
      return { id: p.id, name: p.name, avatar: p.avatar, score: p.score, team: p.team, result: joueurWon ? 'defeat' : 'victory' };
    }
    return {
      id: p.id,
      name: p.name,
      avatar: p.avatar,
      score: p.score,
      team: p.team,
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
    players: results
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

  const allReady = game.players.length > 0 && game.players.every(p => p.currentChoice !== null && !hasBlockingEvent(p));
  if (!allReady) return;

  game.turnTimer = setTimeout(() => resolveTurnTransition(game), REVEAL_DELAY_MS);
}

// Point de sortie commun à la fin d'un tour, que le joueur ait choisi POKÉMON (HAUT/BAS)
// ou BONUS (Bonbon XP / Objet Mystère / Charme Chroma) — un seul chemin de code pour
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
    players: results
  });
}

io.on('connection', (socket) => {
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
      auctionType: games[gameId].auctionType
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
        auctionType: game.auctionType
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
      auctionType: game.auctionType
    });

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

    const trimmed = (text || '').trim().slice(0, CHAT_MAX_LENGTH);
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

    game.turn = 1;
    game.route = buildRoute();
    game.boss = pickRandomBoss(game.selectedDifficulty || 'medium');
    game.players.forEach(p => {
      p.score = 0;
      p.team = [];
      p.currentChoice = null;
      p.currentOptions = null;
      p.hasShinyCharm = false;
      p.currentBonusOptions = null;
      p.pendingBonusKey = null;
      p.pity = 0; // compteur anti-RNG propre à chaque nouvelle partie
      p.activeEvent = null;
      p.eventCooldown = 0;
      p.rarityFloor = null;
      p.rarityBoost = null;
      p.crossedFatesPartner = null;
      p.secretPokemonIndex = null;
    });

    benchExtraPlayersAsSpectators(game, gameId, benchedPlayers);

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
      players: getPublicPlayers(game)
    });

    startTurnForPlayers(game);
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
      auctionType: newGame.auctionType
    });
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

    game.gameMode = mode;
    game.adminId = null;
    game.activePlayerIds = null;
    game.auctionType = null; // repart de zéro si l'hôte change de mode puis revient sur "auction"
    io.to(gameId).emit('game_mode_updated', { gameMode: game.gameMode, adminId: game.adminId, activePlayerIds: game.activePlayerIds, auctionType: game.auctionType });
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

    player.score += reward.finalPoints;
    pushMonToTeam(player, teamMonFromReward(reward));

    socket.emit('choice_result', {
      pokemon: { name: reward.name, sprite: reward.sprite, shiny: reward.shiny, shinySprite: reward.shinySprite },
      rarity: reward.rarity,
      basePoints: reward.basePoints,
      effect: { name: reward.effectName, multiplier: reward.multiplier },
      pointsGained: reward.finalPoints,
      score: player.score,
      team: player.team
    });

    finalizePlayerTurn(game, player);
  });

  // Tour 4 uniquement : le joueur choisit POKÉMON (flux HAUT/BAS normal, révélé seulement
  // maintenant) ou BONUS (il renonce à son Pokémon du tour, 2 bonus lui sont proposés).
  socket.on('special_choice', ({ mode } = {}) => {
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
    if (game.turn !== 4) {
      socket.emit('error_message', 'Le choix spécial est réservé au tour 4.');
      return;
    }
    if (mode !== 'POKEMON' && mode !== 'BONUS') {
      socket.emit('error_message', 'Mode invalide.');
      return;
    }

    const player = game.players.find(p => p.id === socket.id);
    if (!player) {
      socket.emit('error_message', 'Tu ne fais pas partie de cette partie.');
      return;
    }
    if (player.currentChoice !== null || player.currentOptions || player.currentBonusOptions || player.pendingBonusKey) {
      socket.emit('error_message', 'Choix déjà en cours pour ce tour.');
      return;
    }

    if (mode === 'POKEMON') {
      // Flux identique aux autres tours (charme jamais actif au tour 4, il ne commence qu'au tour 5).
      player.currentOptions = pickPlayerTurnOptions(false, player.pity, player.rarityFloor || undefined, player.rarityBoost || undefined);
      player.rarityFloor = null; // effet LUCKY_TURN consommé, à usage unique
      player.rarityBoost = null; // effet CROSSED_FATES consommé, à usage unique
      socket.emit('turn_options', {
        haut: { name: player.currentOptions.haut.name, sprite: player.currentOptions.haut.sprite },
        bas: { name: player.currentOptions.bas.name, sprite: player.currentOptions.bas.sprite }
      });
      return;
    }

    // mode === 'BONUS'
    const [keyA, keyB] = pickTwoBonuses(player);
    player.currentBonusOptions = [keyA, keyB];
    socket.emit('bonus_options', {
      bonuses: [keyA, keyB].map(key => ({ key, label: BONUS_LABELS[key] }))
    });
  });

  // Le joueur choisit l'un des deux bonus qui lui ont été proposés. Le serveur vérifie
  // que ce bonus faisait bien partie des deux options tirées pour LUI (jamais de confiance
  // aveugle envers une clé envoyée directement par le client).
  socket.on('bonus_choice', ({ key } = {}) => {
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
    if (!player.currentBonusOptions || !player.currentBonusOptions.includes(key)) {
      socket.emit('error_message', "Ce bonus ne t'a pas été proposé.");
      return;
    }

    if (key === 'shinyCharm') {
      player.hasShinyCharm = true;
      player.currentBonusOptions = null;
      player.currentChoice = 'BONUS';
      socket.emit('bonus_result', {
        type: 'shinyCharm',
        score: player.score,
        team: player.team
      });
      finalizePlayerTurn(game, player);
      return;
    }

    if (key === 'xpCandy') {
      const eligible = player.team
        .map((mon, index) => ({ index, mon }))
        .filter(({ mon }) => EVOLUTION_MAP[mon.id]);
      player.currentBonusOptions = null;
      player.pendingBonusKey = 'xpCandy';
      socket.emit('xp_candy_pending', {
        team: eligible.map(({ index, mon }) => ({ index, id: mon.id, name: mon.name, sprite: mon.sprite }))
      });
      return;
    }

    if (key === 'mysteryItem') {
      player.currentBonusOptions = null;
      player.pendingBonusKey = 'mysteryItem';
      socket.emit('mystery_item_pending', {
        team: player.team.map((mon, index) => ({ index, id: mon.id, name: mon.name, sprite: mon.sprite }))
      });
    }
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
    const scoreDelta = applyMonMutation(player, mon, m => { fromName = evolveMon(m, evolution); });

    player.pendingBonusKey = null;
    player.currentBonusOptions = null;
    player.currentChoice = 'BONUS';

    socket.emit('bonus_result', {
      type: 'xpCandy',
      from: fromName,
      to: mon.name,
      sprite: mon.sprite,
      scoreDelta,
      score: player.score,
      team: player.team
    });

    finalizePlayerTurn(game, player);
  });

  // Objet Mystère : le joueur choisit QUEL Pokémon reçoit un trait, le trait lui-même
  // est tiré aléatoirement par le serveur (le joueur ne le choisit jamais).
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
      socket.emit('error_message', 'Aucun Objet Mystère en attente.');
      return;
    }

    const mon = player.team[index];
    if (!mon) {
      socket.emit('error_message', 'Pokémon invalide.');
      return;
    }

    const newEffect = randomFrom(EFFECTS.filter(e => e.name !== 'Neutre'));
    const scoreDelta = applyMonMutation(player, mon, m => assignEffect(m, newEffect));

    player.pendingBonusKey = null;
    player.currentBonusOptions = null;
    player.currentChoice = 'BONUS';

    socket.emit('bonus_result', {
      type: 'mysteryItem',
      pokemonName: mon.name,
      sprite: mon.sprite,
      effect: { name: newEffect.name, multiplier: newEffect.multiplier },
      scoreDelta,
      score: player.score,
      team: player.team
    });

    finalizePlayerTurn(game, player);
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
      m.effectName = 'Transformé';
      m.metamorphUsed = true; // verrou définitif : usage unique pour ce Métamorph
      // m.name INTENTIONNELLEMENT jamais réécrit : reste "Métamorph" pour toujours.
    });

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
      chatMessages: game.chatMessages
    });

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
  });
});

const PORT = process.env.PORT || 3000;
// Restaure les parties persistées AVANT d'accepter des connexions : sinon un client qui
// se reconnecte dans la fraction de seconde suivant le démarrage pourrait arriver avant
// que sa partie soit relue, et se voir répondre "partie introuvable" à tort.
loadPersistedGames()
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