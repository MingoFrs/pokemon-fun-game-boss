'use strict';
// =====================================================================
// MÉCANIQUES DE TYPE DES BOSS (serveur uniquement — le client ne calcule jamais rien)
//   A) Faiblesse du boss : bonus par Pokémon       B) Affinité d'équipe : bonus % du score brut
// UN seul calcul partagé (evaluateTeam) : il part TOUJOURS de l'équipe actuelle, donc
// évolution, Méga-Évolution, Métamorph, Double ou rien, remplacements... sont couverts sans
// logique spécifique. Toutes les valeurs viennent de boss-mechanics-config.js.
// Données : types par Pokémon (data/pokemon-stats.json, via fetch-stats.js) et table
// d'efficacité (data/type-chart.json, via fetch-types.js) — jamais saisies à la main.
// =====================================================================
const fs = require('fs');
const path = require('path');
const defaultConfig = require('./boss-mechanics-config');

const DEFAULT_STATS_FILE = process.env.POKEMON_STATS_FILE || path.join(__dirname, 'data', 'pokemon-stats.json');
const DEFAULT_ROSTER_FILE = path.join(__dirname, 'data', 'pokemon-roster.json');
const DEFAULT_CHART_FILE = process.env.TYPE_CHART_FILE || path.join(__dirname, 'data', 'type-chart.json');

function readJson(file, hint) {
  if (!fs.existsSync(file)) throw new Error(`Fichier introuvable : ${file}. ${hint}`);
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { throw new Error(`Fichier illisible : ${file} (${e.message}). ${hint}`); }
}

// Charge et VALIDE les données de types. Lève une erreur claire si absentes/incomplètes
// (le serveur refuse alors de démarrer). Retourne { typesById, chart, typeOrder }.
function loadTypeData({
  statsFile = DEFAULT_STATS_FILE, rosterFile = DEFAULT_ROSTER_FILE, chartFile = DEFAULT_CHART_FILE,
  typeOrder = defaultConfig.TYPE_ORDER
} = {}) {
  const chartJson = readJson(chartFile, 'Lance `node fetch-types.js` pour le générer.');
  const chart = chartJson && chartJson.chart;
  if (!chart || typeof chart !== 'object') throw new Error(`${chartFile} : clé "chart" absente. Relance \`node fetch-types.js\`.`);
  for (const atk of typeOrder) {
    for (const def of typeOrder) {
      const v = chart[atk] && chart[atk][def];
      if (![0, 0.25, 0.5, 1, 2, 4].includes(v)) {
        throw new Error(`${chartFile} : efficacité ${atk} -> ${def} absente/invalide (${v}). Relance \`node fetch-types.js\`.`);
      }
    }
  }

  const roster = readJson(rosterFile, 'Le roster (id + nom) est versionné avec le projet.');
  const stats = readJson(statsFile, 'Lance `node fetch-stats.js` pour le générer.');
  const valid = new Set(typeOrder);
  const typesById = {};
  const bad = [];
  for (const { id } of roster) {
    const t = stats[id] && stats[id].types;
    if (!Array.isArray(t) || t.length < 1 || t.length > 2 || !t.every(x => valid.has(x)) || new Set(t).size !== t.length) bad.push(id);
    else typesById[id] = t.slice();
  }
  if (bad.length) {
    throw new Error(
      `Types manquants/invalides pour ${bad.length} Pokémon (ex. ${bad.slice(0, 8).join(', ')}). ` +
      'Lance `node fetch-stats.js` : les entrées sans types sont retéléchargées automatiquement.'
    );
  }
  return { typesById, chart, typeOrder };
}

// Valeur finale réelle d'un Pokémon : base × trait × (shiny ? ×shinyMultiplier : 1), arrondie
// (même formule que finalPoints au tirage). 0 si le trait est ×0 (Double ou rien raté).
// `shinyInMultiplier` : l'événement « Pokémon Shiny » (et un Métamorph qui en copie un) met déjà
// le ×shiny DANS mon.multiplier ; il ne doit jamais être compté deux fois.
function monFinalValue(mon, shinyMultiplier) {
  const shinyFactor = mon.shiny && !mon.shinyInMultiplier ? shinyMultiplier : 1;
  return Math.round(mon.basePoints * mon.multiplier * shinyFactor);
}

function createBossMechanics({
  typesById, chart, typeOrder = defaultConfig.TYPE_ORDER, config = defaultConfig,
  shinyMultiplier, poolIds = []
}) {
  if (!typesById || !chart) throw new Error('createBossMechanics : typesById et chart requis');
  if (!Number.isFinite(shinyMultiplier)) throw new Error('createBossMechanics : shinyMultiplier requis');

  // Types d'un Pokémon d'équipe : ceux de son id ACTUEL (évolution / Méga changent l'id, donc les
  // types suivent). Métamorph transformé : typeSourceId = id de la cible copiée.
  function getTypes(monOrId) {
    const id = typeof monOrId === 'number' ? monOrId : (monOrId.typeSourceId ?? monOrId.id);
    const t = typesById[id];
    if (!t) throw new Error(`Types inconnus pour le Pokémon #${id}`);
    return t;
  }

  // Efficacité d'un type attaquant contre un ou deux types défenseurs (produit).
  function effectiveness(attackType, defenderTypes) {
    return defenderTypes.reduce((m, d) => m * chart[attackType][d], 1);
  }

  // Nombre de Pokémon du pool de jeu (hors Méga) possédant chaque type.
  const typeCounts = Object.fromEntries(typeOrder.map(t => [t, 0]));
  for (const id of poolIds) for (const t of typesById[id] || []) typeCounts[t]++;

  function isEnabled(mode) { return !!config.ENABLED_BY_MODE[mode]; }

  // Description d'un boss : types, faiblesses (×2/×4) et type « à contrer ».
  function describeBoss(boss) {
    const types = getTypes(boss.id);
    const weaknesses = typeOrder
      .map(type => ({ type, multiplier: effectiveness(type, types) }))
      .filter(w => w.multiplier >= 2)
      .sort((a, b) => b.multiplier - a.multiplier || typeOrder.indexOf(a.type) - typeOrder.indexOf(b.type));

    let counterType = null;
    const override = config.COUNTER_TYPE_OVERRIDES[boss.id];
    if (override !== undefined) {
      if (!typeOrder.includes(override)) throw new Error(`COUNTER_TYPE_OVERRIDES[${boss.id}] : type inconnu "${override}"`);
      counterType = override;
    } else if (weaknesses.length) {
      const top = weaknesses.some(w => w.multiplier >= 4) ? weaknesses.filter(w => w.multiplier >= 4) : weaknesses;
      counterType = top.slice().sort((a, b) =>
        typeCounts[b.type] - typeCounts[a.type] || typeOrder.indexOf(a.type) - typeOrder.indexOf(b.type))[0].type;
    }
    return { types: types.slice(), weaknesses, counterType };
  }

  // Facteur de calibrage de requiredPoints (1 si la mécanique est inactive dans ce mode).
  function scaleFor(boss, mode) {
    if (!isEnabled(mode)) return 1;
    const byDiff = config.SCALE_BY_DIFFICULTY[boss.difficulty] ?? 1;
    const byBoss = config.SCALE_BY_BOSS[boss.id] ?? 1;
    return byDiff * byBoss;
  }

  // Règles affichables (envoyées au client avec le boss : il n'en déduit rien lui-même).
  function publicRules() {
    return {
      weakness: {
        enabled: !!config.WEAKNESS.enabled,
        multiplierX2: config.WEAKNESS.multiplierX2,
        multiplierX4: config.WEAKNESS.multiplierX4
      },
      affinity: { enabled: !!config.AFFINITY.enabled, tiers: config.AFFINITY.tiers.map(t => ({ ...t })) }
    };
  }

  function weaknessMultiplier(bestEffectiveness) {
    const W = config.WEAKNESS;
    if (!W.enabled) return 1;
    if (bestEffectiveness >= 4) return W.multiplierX4;
    if (bestEffectiveness >= 2) return W.multiplierX2;
    if (W.resistance && W.resistance.enabled) {
      if (bestEffectiveness === 0) return W.resistance.multiplierImmune;
      if (bestEffectiveness <= 0.5) return W.resistance.multiplierHalf;
    }
    return 1;
  }

  // Calcul PARTAGÉ : équipe actuelle + boss + score brut (hors bonus de type) -> détail complet.
  function evaluateTeam(team, boss, rawScore) {
    const perMon = team.map((mon, index) => {
      const types = getTypes(mon);
      const best = Math.max(...types.map(t => effectiveness(t, boss.types))); // MEILLEUR type, jamais la somme
      const multiplier = weaknessMultiplier(best);
      const value = monFinalValue(mon, shinyMultiplier);
      return { index, types: types.slice(), effectiveness: best, multiplier, value, bonus: Math.round(value * (multiplier - 1)) };
    });
    const weaknessTotal = perMon.reduce((s, m) => s + m.bonus, 0);

    const A = config.AFFINITY;
    const tiers = A.tiers.slice().sort((a, b) => b.min - a.min);
    const count = boss.counterType ? team.filter(m => getTypes(m).includes(boss.counterType)).length : 0;
    const tier = A.enabled && boss.counterType ? tiers.find(t => count >= t.min) || null : null;
    const nextTier = A.enabled && boss.counterType
      ? tiers.slice().reverse().find(t => count < t.min) || null : null;
    const affinity = {
      counterType: boss.counterType, count,
      rate: tier ? tier.rate : 0,
      bonus: tier ? Math.round(rawScore * tier.rate) : 0,
      nextTier: nextTier ? { min: nextTier.min, rate: nextTier.rate } : null
    };
    return { perMon, weaknessTotal, affinity, total: weaknessTotal + affinity.bonus };
  }

  // Recalcule le bonus d'un joueur depuis son équipe ACTUELLE, ajuste player.score de la
  // différence avec l'ancien bonus, et annote chaque Pokémon (types / multiplicateur / bonus)
  // pour l'affichage. Idempotent. Ne fait RIEN si la mécanique est inactive (mode désactivé,
  // boss absent, ou ADMIN qui n'a ni équipe ni score) : objets et score strictement inchangés.
  // Retourne la variation de score due aux bonus (0 si inactif).
  function syncPlayer(player, game) {
    if (!game || !game.boss || !game.boss.types || !isEnabled(game.gameMode)) return 0;
    if (game.gameMode === 'admin' && player.id === game.adminId) return 0;
    const previous = player.typeBonusTotal || 0;
    const raw = player.score - previous;
    const ev = evaluateTeam(player.team, game.boss, raw);
    player.score += ev.total - previous;
    player.typeBonusTotal = ev.total;
    player.typeBonus = { weakness: ev.weaknessTotal, affinity: ev.affinity, total: ev.total };
    ev.perMon.forEach(m => {
      const mon = player.team[m.index];
      mon.types = m.types;
      mon.typeMult = m.multiplier;
      mon.typeBonus = m.bonus;
    });
    return ev.total - previous;
  }

  return {
    getTypes, effectiveness, describeBoss, scaleFor, publicRules, isEnabled,
    evaluateTeam, syncPlayer, typeCounts,
    monFinalValue: mon => monFinalValue(mon, shinyMultiplier)
  };
}

module.exports = { loadTypeData, createBossMechanics, monFinalValue };
