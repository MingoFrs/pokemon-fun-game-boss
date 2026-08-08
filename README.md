# Route du Boss — MVP multijoueur

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
route-du-boss/
├── package.json
├── server.js          # Express + Socket.IO + état des parties
├── README.md
└── public/
    ├── index.html      # écran accueil + lobby
    ├── style.css        # thème sombre
    └── client.js        # logique socket côté navigateur
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