#!/usr/bin/env node
'use strict';
// Diagnostic de la persistance de La Mouche : pourquoi le score « Humanité – Mouche » repart à zéro.
// À lancer depuis la racine du projet, avec les MÊMES variables que sur Render (ne colle jamais la clé dans un chat) :
//   PowerShell :  $env:SUPABASE_URL = "https://xxxx.supabase.co" ; $env:SUPABASE_SECRET_KEY = "..." ; node check-fly-db.js
//   Option --no-write : ne fait aucun test d'écriture (sinon : une seule écriture, de la colonne updated_at de la ligne id = 1).
// Il ne lit que fly_brain / fly_brain_snapshots et n'écrit rien d'autre. Ne modifie jamais le cerveau ni les compteurs.

const NEW_COLUMNS = 'generation,total_games,total_wins,total_losses,total_draws';

function hint(message) {
  const m = String(message || '').toLowerCase();
  if (m.includes('does not exist') && m.includes('relation')) return "La table n'existe pas dans CE projet Supabase : exécute fly-brain-v2.sql.";
  if (m.includes('column') && (m.includes('does not exist') || m.includes('could not find'))) return 'Colonnes manquantes : exécute fly-brain-v2.sql (il ajoute generation et total_*), puis redémarre le service Render.';
  if (m.includes('permission denied') || m.includes('row-level security')) return "Droits refusés : la clé n'est pas la clé service_role/secret, ou les « grant » du SQL manquent. Exécute fly-brain-v2.sql et vérifie SUPABASE_SECRET_KEY.";
  if (m.includes('jwt') || m.includes('invalid api key') || m.includes('apikey')) return 'Clé refusée : vérifie SUPABASE_SECRET_KEY (clé secrète / service_role du MÊME projet).';
  if (m.includes('fetch failed') || m.includes('enotfound')) return "Projet injoignable : vérifie SUPABASE_URL.";
  return null;
}

async function diagnose(sb, { write = true, now = Date.now(), host = null } = {}) {
  const out = [];
  const say = s => out.push(s);
  const problems = [];
  const fail = (what, err, fix) => { problems.push(what); say(`  ✘ ${what} : ${err && err.message ? err.message : err}`); const h = hint(err && err.message); if (h || fix) say(`    -> ${h || fix}`); };
  if (host) say(`Projet Supabase interrogé : ${host}   (compare avec SUPABASE_URL sur Render : ce doit être le MÊME)`);

  // 1. Table et colonnes v2 (fonctionne même si la table est vide)
  const cols = await sb.from('fly_brain').select(NEW_COLUMNS).limit(1);
  if (cols.error) fail('fly_brain illisible ou colonnes v2 absentes', cols.error);
  else say('  ✔ table fly_brain accessible, colonnes generation / total_* présentes');

  // 2. Ligne du cerveau
  const rowRes = await sb.from('fly_brain').select('*').eq('id', 1).maybeSingle();
  let row = null;
  if (rowRes.error) { if (!cols.error) fail('lecture de la ligne id = 1', rowRes.error); }
  else if (!rowRes.data) say("  • aucune ligne id = 1 : normale avant le premier démarrage du serveur v2 (il la crée). Si le serveur a déjà démarré, voir ses logs [fly].");
  else {
    row = rowRes.data;
    const kind = row.weights && row.weights.kind;
    const age = row.updated_at ? Math.round((now - Date.parse(row.updated_at)) / 60000) : null;
    say(`  ✔ ligne id = 1 : modèle « ${kind} », génération ${row.generation}, parties vécues ${row.games_played}, ` +
      `score global ${row.total_games} partie(s) (Humanité ${row.total_losses} – Mouche ${row.total_wins}, nuls ${row.total_draws}), dernière sauvegarde ${age == null ? '?' : `il y a ${age} min`}`);
    if (kind !== 'value' || (row.weights && row.weights.version) !== 1) {
      problems.push('modèle illisible');
      say(`  ✘ modèle en base illisible (kind=${JSON.stringify(kind)}) : le serveur désactive la sauvegarde et n'écrase jamais la ligne.`);
      say("    -> supprime la ligne : delete from fly_brain where weights->>'kind' is distinct from 'value';  puis redémarre le service Render.");
    }
  }

  // 3. Archives
  const snap = await sb.from('fly_brain_snapshots').select('id,generation').limit(1);
  if (snap.error) fail('fly_brain_snapshots illisible ou sans colonne generation', snap.error);
  else say('  ✔ table fly_brain_snapshots accessible');

  // 4. Test d'écriture minimal (updated_at seulement) : détecte les droits manquants
  if (write && row && !cols.error) {
    const w = await sb.from('fly_brain').update({ updated_at: new Date(now).toISOString() }).eq('id', 1).select('id');
    if (w.error) fail("écriture dans fly_brain refusée", w.error);
    else if (!w.data || !w.data.length) { problems.push('écriture sans effet'); say("  ✘ l'écriture n'a modifié aucune ligne (droits / RLS ?)."); }
    else say("  ✔ écriture possible (test sur updated_at uniquement)");
  } else if (write && !row) say("  • test d'écriture non fait (pas de ligne) ");

  const ok = problems.length === 0;
  say('');
  say(ok
    ? 'VERDICT : la base est correcte. Si le score repart quand même à zéro, regarde les logs Render : une ligne « [fly] … sauvegarde désactivée » ou « échec écriture DB » donne la cause.'
    : `VERDICT : ${problems.length} problème(s) à corriger (voir ✘ ci-dessus). Tant qu'ils existent, le serveur joue sans sauvegarder : le score « Humanité – Mouche » vit en mémoire et repart à zéro à chaque redémarrage (déploiement, mise en veille Render). Après correction, REDÉMARRE le service Render.`);
  return { ok, problems, lines: out };
}

module.exports = { diagnose, hint };

if (require.main === module) {
  (async () => {
    const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SECRET_KEY;
    if (!url || !key) { console.error('SUPABASE_URL et SUPABASE_SECRET_KEY doivent être définies (mêmes valeurs que sur Render).'); process.exit(2); }
    let createClient;
    try { ({ createClient } = require('@supabase/supabase-js')); }
    catch (e) { console.error('@supabase/supabase-js introuvable : lance ce script depuis la racine du projet (npm install fait).'); process.exit(2); }
    const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
    let host = url; try { host = new URL(url).hostname; } catch (e) { /* url brute */ }
    console.log('Diagnostic de la persistance de La Mouche\n');
    const r = await diagnose(sb, { write: !process.argv.includes('--no-write'), host });
    console.log(r.lines.join('\n'));
    process.exit(r.ok ? 0 : 1);
  })().catch(e => { console.error('Erreur :', e && e.message ? e.message : e); process.exit(2); });
}
