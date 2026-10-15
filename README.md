# Pokéroute — MVP multijoueur

Lobby multijoueur temps réel + partie jouable : tours, choix HAUT/BAS, Pokémon, points, équipe, route, boss Arceus.

## Installation

```bash
npm install
```

## Lancement

```bash
npm start
```

Serveur sur `http://localhost:3000`.

Mode dev (redémarrage auto) :
```bash
npm run dev
```

## Test multijoueur

### Lobby
1. Onglet 1 → `http://localhost:3000` → pseudo → **Créer une partie**.
2. Noter le code affiché (ex: `A7K29F`).
3. Onglet 2 (ou navigateur privé) → même URL → pseudo différent → coller le code → **Rejoindre**.
4. Les deux onglets voient la liste des joueurs se mettre à jour en temps réel.
5. Fermer un onglet → l'autre voit le joueur disparaître.

### Partie
6. Dans l'onglet hôte, cliquer **Démarrer la partie**. Les deux onglets basculent sur l'écran de jeu avec **le même boss** (même nom, même sprite, même `Objectif : XXXX PTS`) — recommencer plusieurs parties pour voir le boss changer aléatoirement d'une partie à l'autre.
7. Chaque onglet affiche 2 cartes (sprite + nom) distinctes pour HAUT et BAS. Vérifier qu'aucun point, rareté ni effet n'est visible avant de cliquer, et que les deux onglets voient des Pokémon différents (choix individuels).
8. Cliquer **HAUT** ou **BAS** dans l'onglet 1 → carte résultat révèle : Pokémon, `Base : XXX PTS`, `Effet : NomEffet ×multiplicateur`, `Résultat : XXX PTS`. Vérifier `Résultat = round(Base × multiplicateur)`. Rejouer plusieurs parties pour croiser des Pokémon rares/épiques/pseudo-légendaires/légendaires (Mewtwo, Rayquaza, Dracolosse, etc.) — ils doivent rester nettement plus rares que les communs.
9. Pendant ~4s, le résultat reste affiché, boutons désactivés ; les deux onglets passent au tour suivant **en même temps**.
10. Répéter jusqu'au TOUR 6/6 → équipe complète (6 slots remplis) → écran de fin : score final, **VICTOIRE si `score >= objectif du boss affiché`**, sinon DÉFAITE. Vérifier avec un boss facile (Lugia/Ho-Oh, 1500 pts) qu'une partie sans légendaire peut gagner, et avec un boss extrême (Koraidon/Miraidon/Arceus, 3100 pts) que la victoire reste possible mais nettement plus dure.
11. **Quitter** ramène à l'écran d'accueil.

## Mode « Roulette de Stats »

Un mode à part, choisi dans le lobby (bouton **Roulette de Stats**). Il n'utilise ni boss, ni route, ni équipe : on construit une **base stats**.

### Principe
- **6 tirages**, un par stat : PV, Attaque, Défense, Atq. Spé., Déf. Spé., Vitesse.
- À chaque tirage, une **roulette** (roue de sprites animée) désigne un Pokémon, **le même pour tous les joueurs**. On voit son sprite, son nom et ses types, mais **toutes ses stats sont cachées** (« ? ») : il faut deviner où il est fort.
- Chaque joueur choisit **une stat** du Pokémon. Elle remplit la case **du même nom** de sa base stats (l'Attaque du Pokémon va dans la case Attaque, etc.). Une case remplie est définitive. La valeur réelle est révélée une fois le choix fait, puis les 6 stats du Pokémon sont dévoilées à la fin du tirage.
- Les choix sont secrets jusqu'à ce que tout le monde ait validé (ou que le temps soit écoulé : 30 s, sinon une case au hasard est remplie).
- **Objectif :** total des 6 cases ≥ objectif de la difficulté choisie dans le lobby. Le classement se fait au total, ex æquo possibles. Jouable seul ou à plusieurs.

| Difficulté | Objectif (total des 6 stats) |
|---|---|
| Facile | 500 |
| Moyen | 550 |
| Difficile | 625 |
| Extrême | 700 |

### Pool de tirage
Tout le roster du jeu (`POKEMON_POOLS`), **Méga-Évolutions incluses** (y compris Z-A, ids ≥ 10000). Tirage **uniforme** (un légendaire sort aussi souvent qu'un Pokémon commun) et **sans doublon** dans une partie. Les Méga sont signalées par « ⚡ Méga-Évolution » sur la carte.

### Modificateurs (au choix de l'hôte, cumulables)
| Modificateur | Effet |
|---|---|
| 🔄 Relances | 2 relances de roulette par partie |
| 🃏 Joker | 1 fois par partie : place une stat dans une autre case que la sienne |
| 🎯 Cases typées | Chaque case a un type tiré au hasard : ×1,2 si le Pokémon tiré a ce type |
| 🔍 Éclaireur | 2 stats sur 6, tirées au hasard, sont révélées à chaque tirage |
| ⏱️ Éclair | 10 s pour choisir au lieu de 30 s |
| 💎 Jackpot final | Le 6ᵉ tirage est un Pokémon du top 10 % de BST |
| ✨ Chromatique | 20 % de chances qu'un Pokémon tiré soit chromatique : stats ×1,15 |
| 🧬 Frankenstein | Une seule base stats pour toute l'équipe, choix à tour de rôle (2 joueurs minimum), victoire commune |

Une partie **avec modificateur** est hors-classement (aucune XP), comme pour les autres modes. Sans modificateur : XP de participation + bonus de victoire si l'objectif est atteint.

### Données requises
Il faut les 6 stats de base de chaque Pokémon. Le module lit `data/pokemon-stats.json` (format tolérant : `hp/attack/defense/special-attack/special-defense/speed`, ou abréviations, ou tableau de 6 valeurs, ou format PokéAPI brut) et **vérifie que la somme des 6 stats égale le BST** de l'entrée. Si ce fichier ne contient pas les stats détaillées, le serveur le signale au démarrage (`[statdraft] Base stats par statistique introuvables`) et le mode est désactivé. Dans ce cas :

```bash
node fetch-statdraft-stats.js   # Node 18+, génère data/statdraft-stats.json (espèces + formes/Méga)
```

Au démarrage, le serveur affiche le nombre de Pokémon dans la roulette et un **calibrage** des objectifs : pourcentage de réussite par difficulté avec un choix au hasard (borne basse) et avec une vision parfaite des stats (borne haute). Les objectifs se règlent dans `TARGETS` (`statdraft-game.js`).

### Limites connues
- Pas de spectateurs : une partie de ce mode déjà lancée ne peut pas être rejointe ni observée.
- Parties jamais persistées : un redémarrage du serveur les efface (la reconnexion d'un joueur en cours de partie fonctionne, tant que le serveur tourne).
- Un joueur qui quitte en cours de partie est retiré, les autres terminent.

### Événements Socket.IO du mode
| Événement | Sens | Payload |
|---|---|---|
| `sd_set_modifiers` | client → serveur (hôte, lobby) | `{ modifiers: [clé, …] }` |
| `sd_modifiers_updated` | serveur → salon | `{ modifiers }` |
| `sd_started` | serveur → joueur | `{ gameId, meSid, hostId, config, players }` |
| `sd_round` | serveur → salon | `{ round, rounds, wheel, pokemon, hidden, spinMs, pickMs, chooserSid, players }` — `pokemon.options` ne contient aucune valeur de stat pour les stats cachées |
| `sd_choose` | serveur → salon | `{ pickMs }` (fin de la roulette, début du chrono) |
| `sd_pick` | client → serveur | `{ stat, slot? }` — `slot` ≠ `stat` seulement avec le Joker |
| `sd_pick_ok` | serveur → joueur | `{ item, me }` (confirmation privée) |
| `sd_reroll` | client → serveur / serveur → joueur (salon en équipe) | — / `{ round, wheel, pokemon, rerollsLeft, spinMs }` |
| `sd_players` | serveur → salon | `{ players, chooserSid }` (qui a validé, présence) |
| `sd_reveal` | serveur → salon | `{ round, picks, builds, revealMs, last }` |
| `sd_final` | serveur → salon | `{ target, difficulty, mods, team, ranked, results, winners, best }` |
| `sd_state` | serveur → joueur | état complet pour reconstruire l'écran après reconnexion |

Route HTTP : `GET /api/statdraft/config` → `{ ready, modifiers, targets, statKeys, statLabels, rounds }`.

## Matchmaking et faux joueurs

Pour les joueurs seuls : dans son lobby, l'hôte clique sur **🔍 Trouver des adversaires** (visible uniquement s'il est seul, dans un mode compatible). Le serveur simule une recherche de quelques secondes, fait « arriver » des joueurs un par un dans le lobby (avec leur avatar), puis **lance la partie tout seul**. Annulation possible à tout moment ; la recherche s'annule aussi si un autre humain rejoint le lobby ou si le mode change.

| Mode | Bots ajoutés | Rôle du bot |
|---|---|---|
| Pokéroute (normal) | 1 à 3 | joue HAUT/BAS au hasard, choisit un objet de départ au hasard |
| Coop | 1 à 3 | idem |
| Roulette de Stats | 1 à 3 | choisit une stat au hasard dans une case vide |
| Admin vs Joueur | 1 | **est l'Admin** (il observe, comme le veut le mode), l'humain joue |
| Devine le Pokémon | 1 | choisit un Pokémon secret, finit son tour ou tente une réponse au hasard (de plus en plus souvent) |
| Enchères | 1 | mise au hasard (multiples de 0,5 M, dans son budget) ou passe |
| Humanité vs Mouche | — | se joue seul par conception : pas de matchmaking |

- **Comment ça marche :** chaque bot est un faux socket qui passe par **exactement les mêmes handlers que les humains** (`join_game`, `player_choice`, `guess_attempt`, `auction_bid`, `sd_pick`…). Aucune règle n'est dupliquée et un bot ne peut pas tricher : il joue à partir de l'état serveur, au hasard, après un délai de « réflexion » aléatoire.
- **Transparence :** le nom des bots se termine par 🤖. Variable d'environnement `MATCHMAKING_BOT_LABEL=off` pour retirer ce suffixe.
- **Hors classement :** les bots n'ont pas de compte (aucune XP, aucun historique pour eux). Aucun événement rare ne les cible ni ne les implique (sinon la partie attendrait une réponse qu'ils ne donneraient pas).
- **Nettoyage :** si l'humain quitte, la partie (et ses bots) est supprimée ; une partie avec bots n'est jamais restaurée après un redémarrage du serveur.
- **Évolution prévue :** un vrai matchmaking (file d'attente entre humains) pourra remplacer `startSearch()` dans `matchmaking-bots.js` ; les bots ne serviront alors que de remplissage.
- Événements : `mm_search` / `mm_cancel` (client → serveur), `mm_state` `{ state: 'searching' | 'ready' | 'idle', total, found, reason?, started? }` (serveur → hôte). Route : `GET /api/matchmaking/config` → `{ modes }`.

## Comptes : mot de passe oublié et changement

Les comptes passent par Supabase Auth ; le serveur ne voit ni ne stocke jamais de mot de passe.

- **Mot de passe oublié :** lien « Mot de passe oublié ? » sous le formulaire de connexion (Réglages → Compte). `POST /api/forgot-password` déclenche l'email Supabase ; la réponse est identique que l'email existe ou non. Limites : 3 demandes/heure par email, 10/heure par IP.
- **Nouveau mot de passe :** le lien du mail ramène sur le site avec `#access_token=…&type=recovery`. Le client affiche le formulaire (6 à 72 caractères), puis `POST /api/reset-password`. Toutes les sessions du compte sont déconnectées. Le jeton est effacé de la barre d'adresse.
- **Changement connecté :** Réglages → Compte → sous-onglet **Mot de passe** (mot de passe actuel requis, `POST /api/profile/password`). Les autres appareils sont déconnectés.
- **Pseudo visible dans Supabase :** un trigger (`supabase-display-name.sql`, déjà appliqué) copie `profiles.pseudo` dans `Authentication → Users → Display name`, pour les comptes existants et les nouveaux.

À configurer côté Supabase / Render :
1. **Authentication → URL Configuration :** Site URL = `https://pokeroute.onrender.com` et `https://pokeroute.onrender.com/**` dans Redirect URLs (sinon le lien du mail ne ramène pas sur le jeu).
2. **Authentication → Emails → SMTP Settings :** activer un SMTP personnalisé. Le serveur d'envoi par défaut de Supabase n'écrit qu'aux membres de ton équipe Supabase et est limité à 2 emails par heure : sans SMTP personnalisé, tes amis ne recevront pas le mail.
3. *(Optionnel)* variable d'environnement `PUBLIC_URL=https://pokeroute.onrender.com` sur Render pour fixer l'adresse mise dans le mail (sinon elle est déduite de la requête).

## Architecture

```
Navigateur (HTML/CSS/JS vanilla)
      ↓ Socket.IO
Serveur Node.js / Express
      ↓
État des parties (mémoire, objet `games`)
```

Le serveur est seul autorité sur `score`, `players`, `status`, `turn`. Le client ne fait qu'émettre des intentions (`create_game`, `join_game`, `leave_game`) et reçoit l'état à jour.

## Structure

```
pokeroute/
├── package.json
├── server.js               # Express + Socket.IO + état des parties
├── statdraft-game.js       # mode Roulette de Stats (module serveur isolé)
├── matchmaking-bots.js     # matchmaking simulé + faux joueurs (module serveur isolé)
├── fetch-statdraft-stats.js # (secours) génère data/statdraft-stats.json depuis PokéAPI
├── README.md
└── public/
    ├── index.html          # écran accueil + lobby + écrans de jeu
    ├── style.css           # thème sombre
    ├── statdraft.css       # styles du mode Roulette de Stats
    ├── client.js           # logique socket côté navigateur
    ├── statdraft-client.js # client du mode Roulette de Stats (chargé après client.js)
    ├── account-password.js # mot de passe oublié / changement (chargé après client.js)
    └── matchmaking-client.js # bouton et écran de recherche d'adversaires (chargé après client.js)
```

## Données serveur

```js
game = {
  id: "A7K29F",
  status: "waiting" | "playing" | "finished",
  turn: 1,
  maxTurns: 6,          // = nombre de slots d'équipe, pour que l'équipe se remplisse exactement
  hostId: "socket-id",
  boss: null,           // tiré aléatoirement au démarrage (start_game), puis { id, name, sprite, requiredPoints, difficulty }
  route: [ { turn: 1, status: "done" | "current" | "upcoming" }, ... ],
  turnTimer: null,      // setTimeout de la pause de révélation (~4s) entre 2 tours
  players: [ { id, name, score, team, currentChoice, currentOptions } ]
}
```

`currentOptions` est propre à **chaque joueur** (pas partagé) : `{ haut, bas }`, chacun contenant `{ pokemonId, name, sprite, rarity, basePoints, effectName, multiplier, finalPoints }`. C'est un secret serveur — jamais envoyé tel quel au client.

### Pool de Pokémon (124) par rareté

Chaque tour, le serveur tire d'abord une **rareté**, puis un Pokémon au hasard dans cette rareté. Les points de base des raretés épique/pseudo-légendaire/légendaire sont **nerfés de 22.5%** (appliqué avant le multiplicateur bonus/malus) pour éviter qu'elles ne dominent le score :

| Rareté | Nombre | Points de base | Probabilité |
|---|---|---|---|
| Commun | 37 | 60-190 (inchangé) | 39% |
| Peu commun | 26 | 150-280 (inchangé) | 26% |
| Rare | 23 | 300-480 (inchangé) | 17% |
| Épique | 10 | 405-620 (nerfé, ex-520-800) | 9% |
| Pseudo-légendaire | 6 (Dracolosse, Tyranocif, Métalosse, Carchacrok, Trioxhydre, Dragapult) | 735-890 (nerfé, ex-950-1150) | 6% |
| Légendaire | 22 (Mewtwo, Lugia, Ho-Oh, Rayquaza, Groudon, Kyogre, Dialga, Palkia, Giratina, Reshiram, Zekrom, Kyurem, Xerneas, Yveltal, Solgaleo, Lunala, Necrozma, Zacian, Zamazenta, Koraidon, Miraidon, Arceus) | 1160-1550 (nerfé, ex-1500-2000) | 3% |

× 9 effets bonus/malus inchangés (`Énergétique ×1.2`, `Chanceux ×1.3`, `Neutre ×1.0`, `Malchanceux ×0.6`, etc.), appliqués **après** le nerf. Le serveur tire pour **chaque joueur individuellement** 2 récompenses secrètes distinctes, et n'envoie que le sprite + le nom via `turn_options` — points, rareté et effet restent cachés jusqu'au choix (le jeu reste piloté par le RNG, pas par la stratégie). `pointsFinal = round(basePointsNerfé × multiplicateur)`, calculé et arrondi côté serveur uniquement.

### Boss (18, tirage aléatoire par partie)

Au clic sur **Démarrer la partie**, le serveur tire un boss aléatoire parmi 18, identique pour tous les joueurs de la partie. Les objectifs sont calés sur des **percentiles de la distribution réelle des scores** (choix aveugle, 100 000 parties simulées) plutôt que sur la moyenne, pour qu'une mauvaise RNG puisse réellement perdre et qu'une excellente RNG ne garantisse jamais la victoire :

| Difficulté | Objectif | Percentile visé | Boss possibles |
|---|---|---|---|
| Facile | 1450 pts | ≈ P40 | Lugia, Ho-Oh |
| Moyen | 1750 pts | ≈ P60 | Rayquaza, Groudon, Kyogre, Dialga, Palkia |
| Difficile | 2150 pts | ≈ P78 | Giratina, Reshiram, Zekrom, Mewtwo |
| Très difficile | 2600 pts | ≈ P90 | Xerneas, Yveltal, Zacian, Zamazenta |
| Extrême | 3200 pts | ≈ P97 | Koraidon, Miraidon, Arceus |

Simulation (choix aveugle, RNG pure, 100 000 parties) par profil de partie :

| Profil (résultat du RNG, pas un choix du joueur) | Score médian | Facile | Moyen | Difficile | Très difficile | Extrême |
|---|---|---|---|---|---|---|
| Équipe faible (aucun épique+/pseudo/légendaire) | 1158 | 15.8% | 2.7% | 0.1% | ~0% | ~0% |
| Toutes parties confondues (RNG moyenne) | 1605 | 60.3% | 41.1% | 22.6% | 10.6% | 3.1% |
| Bonne équipe (≥ 2 épique/pseudo/légendaire) | 2261 | 96.3% | 83.6% | 57.3% | 30.6% | 10.6% |
| Excellente RNG (≥ 1 légendaire obtenu et choisi) | 2568 | 99.4% | 94.5% | 77.2% | 47.8% | 17.3% |

Confirme la philosophie demandée : mauvaise RNG → défaite quasi certaine ; RNG moyenne → résultat incertain (surtout dès "moyen") ; bonne équipe → vraie chance, jamais garantie ; légendaire → très avantageux mais jamais une victoire automatique, même sur "difficile".

Le tour avance automatiquement (après ~4s de révélation, cf. `turnTimer`) dès que tous les joueurs présents ont choisi. Après le 6ᵉ tour, la partie passe en `finished` et chaque joueur est déclaré `victory` ou `defeat` selon `score >= boss.requiredPoints`.

## Événements Socket.IO

| Événement | Sens | Payload |
|---|---|---|
| `create_game` | client → serveur | `{ name }` |
| `game_created` | serveur → client | `{ gameId, players, hostId }` |
| `join_game` | client → serveur | `{ name, gameId }` |
| `game_joined` | serveur → client | `{ gameId, players, hostId }` |
| `players_updated` | serveur → salon | `{ players, hostId }` (lobby uniquement) |
| `leave_game` | client → serveur | — |
| `start_game` | client → serveur (hôte) | — |
| `game_started` | serveur → salon | `{ status, turn, maxTurns, route, boss, players }` |
| `turn_options` | serveur → client (privé) | `{ haut: { name, sprite }, bas: { name, sprite } }` — points/effet cachés |
| `player_choice` | client → serveur | `{ choice: "HAUT" \| "BAS" }` |
| `choice_result` | serveur → client (privé) | `{ pokemon, basePoints, effect: { name, multiplier }, pointsGained, score, team }` |
| `game_updated` | serveur → salon | `{ status, turn, maxTurns, route, players, hostId }` |
| `game_finished` | serveur → salon | `{ boss, route, players }` (avec `result: "victory" \| "defeat"`) |
| `get_game_state` | client → serveur | `{ gameId }` |
| `game_state` | serveur → client | état complet à la demande |
| `error_message` | serveur → client | `string` |

## Validation serveur

- partie et joueur doivent exister
- partie en statut `playing` pour accepter un choix
- choix limité à `"HAUT"` / `"BAS"`
- un seul choix par joueur et par tour (`currentChoice` déjà défini → refusé)
- `currentOptions` doit exister avant d'accepter un choix
- équipe plafonnée à 6 Pokémon (au-delà, le Pokémon obtenu est ignoré, le score augmente quand même — non atteignable en pratique puisque `maxTurns = 6`)

## Prochaines étapes

1. Matchmaking
2. Comptes utilisateurs
3. Base de données
4. Classement
5. Animations complexes
6. Objets / combats
7. Système de niveaux
8. Déploiement