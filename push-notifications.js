'use strict';
/* NOTIFICATIONS PUSH — rappel quotidien du défi (Web Push / VAPID).
 *
 * - Abonnement lié à un COMPTE (table Supabase `push_subscriptions`, cf. push.sql).
 * - 1 rappel par jour et par appareil, à partir de PUSH_REMINDER_HOUR (Europe/Paris, défaut 18 h)
 *   et jusqu'à 22 h, uniquement si le défi du jour n'est pas terminé.
 *     · série en cours  → "🔥 Série de N jours : joue avant minuit"
 *     · sinon           → "🗓️ Défi du jour : <boss>"
 * - Anti-doublon atomique : les abonnements dus sont "réclamés" par un UPDATE conditionnel
 *   sur last_sent_day (sûr après redémarrage, et même avec plusieurs instances).
 * - Désactivé proprement (routes en 503) si web-push ou les clés VAPID sont absents.
 * - Sécurité : seuls les endpoints des services push connus sont acceptés (anti-SSRF).
 *
 * Variables d'environnement : VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT
 * (mailto:… ou https://…), PUSH_REMINDER_HOUR (0-21, défaut 18).
 * Clés : npx web-push generate-vapid-keys
 */

const { computeStreak, addDays, dayKey } = require('./daily-game');

const REMINDER_END_HOUR = 22;
const TICK_MS = 60000;
const STREAK_WINDOW_DAYS = 400;
const SEND_BATCH = 20;
const PUSH_TTL_S = 6 * 3600;
const ENDPOINT_MAX = 2048;

const hourFmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Paris', hour: '2-digit', hourCycle: 'h23' });
const parisHour = (date = new Date()) => parseInt(hourFmt.format(date), 10);

// Hôtes autorisés : Chrome/Android/Opera (FCM), Firefox, Safari/iOS, Edge (WNS).
function isAllowedEndpoint(endpoint) {
  if (typeof endpoint !== 'string' || endpoint.length > ENDPOINT_MAX) return false;
  let u;
  try { u = new URL(endpoint); } catch (e) { return false; }
  if (u.protocol !== 'https:') return false;
  const h = u.hostname.toLowerCase();
  return h === 'fcm.googleapis.com'
    || h === 'updates.push.services.mozilla.com' || h.endsWith('.push.services.mozilla.com')
    || h === 'push.apple.com' || h.endsWith('.push.apple.com')
    || h.endsWith('.notify.windows.com');
}

function validSubscription(sub) {
  return !!sub && isAllowedEndpoint(sub.endpoint) && sub.keys
    && typeof sub.keys.p256dh === 'string' && sub.keys.p256dh.length > 20 && sub.keys.p256dh.length < 200
    && typeof sub.keys.auth === 'string' && sub.keys.auth.length > 8 && sub.keys.auth.length < 100;
}

function registerPush({ app, supabase, createAuthClient, daily, webpush, env = process.env }) {
  const publicKey = env.VAPID_PUBLIC_KEY;
  const privateKey = env.VAPID_PRIVATE_KEY;
  const subject = env.VAPID_SUBJECT || 'mailto:admin@example.com';
  const configuredHour = parseInt(env.PUSH_REMINDER_HOUR, 10);
  const reminderHour = Math.min(Math.max(Number.isFinite(configuredHour) ? configuredHour : 18, 0), REMINDER_END_HOUR - 1);

  let enabled = false;
  if (!webpush) console.warn('[push] module "web-push" absent (npm i web-push) : rappels désactivés.');
  else if (!publicKey || !privateKey) console.warn('[push] VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY manquants : rappels désactivés.');
  else if (!supabase) console.warn('[push] Supabase indisponible : rappels désactivés.');
  else {
    try { webpush.setVapidDetails(subject, publicKey, privateKey); enabled = true; }
    catch (err) { console.error('[push] clés VAPID invalides :', err && err.message); }
  }

  async function authUser(accessToken) {
    if (!accessToken || !createAuthClient) return null;
    try {
      const { data: { user } } = await createAuthClient().auth.getUser(accessToken);
      return user || null;
    } catch (e) { return null; }
  }

  async function sendOne(sub, payload) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        JSON.stringify(payload),
        { TTL: PUSH_TTL_S, urgency: 'normal' }
      );
      return true;
    } catch (err) {
      if (err && (err.statusCode === 404 || err.statusCode === 410)) {
        try { await supabase.from('push_subscriptions').delete().eq('endpoint', sub.endpoint); } catch (e) {}
      } else {
        console.error('[push] envoi échoué :', (err && (err.statusCode || err.message)) || err);
      }
      return false;
    }
  }

  // ---------- Routes ----------
  app.get('/api/push/key', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(enabled ? { enabled: true, publicKey, hour: reminderHour } : { enabled: false });
  });

  app.post('/api/push/subscribe', async (req, res) => {
    if (!enabled) { res.status(503).json({ error: 'Rappels indisponibles.' }); return; }
    try {
      const { accessToken, subscription, welcome } = req.body || {};
      const user = await authUser(accessToken);
      if (!user) { res.status(401).json({ error: 'Connexion requise.' }); return; }
      if (!validSubscription(subscription)) { res.status(400).json({ error: 'Abonnement invalide.' }); return; }

      const row = {
        user_id: user.id,
        p256dh: subscription.keys.p256dh,
        auth: subscription.keys.auth,
        user_agent: String(req.get('user-agent') || '').slice(0, 200)
      };
      const { data: existing, error: selErr } = await supabase.from('push_subscriptions')
        .select('endpoint').eq('endpoint', subscription.endpoint).limit(1);
      if (selErr) throw selErr;

      if (existing && existing[0]) {
        const { error } = await supabase.from('push_subscriptions').update(row).eq('endpoint', subscription.endpoint);
        if (error) throw error;
      } else {
        // Nouvel abonné : pas de rappel le jour même (la notification de bienvenue suffit).
        const { error } = await supabase.from('push_subscriptions')
          .insert({ endpoint: subscription.endpoint, ...row, last_sent_day: dayKey() });
        if (error) throw error;
      }

      if (welcome) {
        sendOne({ endpoint: subscription.endpoint, p256dh: row.p256dh, auth: row.auth }, {
          title: '🔔 Rappels activés',
          body: `Tu recevras un rappel vers ${reminderHour} h si tu n'as pas encore joué au défi du jour.`,
          url: '/?daily=1', tag: 'rdb-welcome'
        });
      }
      res.json({ ok: true });
    } catch (err) {
      console.error('[push] subscribe :', err && err.message);
      res.status(500).json({ error: 'Abonnement impossible.' });
    }
  });

  // L'endpoint (URL secrète et unique de l'appareil) vaut capacité : pas de jeton requis,
  // ce qui permet aussi de se désabonner pendant une déconnexion de compte.
  app.post('/api/push/unsubscribe', async (req, res) => {
    if (!enabled) { res.json({ ok: true }); return; }
    try {
      const { endpoint } = req.body || {};
      if (typeof endpoint === 'string' && endpoint.length <= ENDPOINT_MAX) {
        const { error } = await supabase.from('push_subscriptions').delete().eq('endpoint', endpoint);
        if (error) throw error;
      }
      res.json({ ok: true });
    } catch (err) {
      console.error('[push] unsubscribe :', err && err.message);
      res.status(500).json({ error: 'Désabonnement impossible.' });
    }
  });

  // ---------- Rappels ----------
  function reminderPayload(today, boss, streak) {
    if (streak > 0) {
      return {
        title: `🔥 Série de ${streak} jour${streak > 1 ? 's' : ''}`,
        body: 'Joue le défi du jour avant minuit pour la garder !',
        url: '/?daily=1', tag: 'rdb-daily-' + today
      };
    }
    return {
      title: '🗓️ Défi du jour',
      body: `${boss.name} t'attend : mêmes Pokémon pour tous, 1 seul essai.`,
      url: '/?daily=1', tag: 'rdb-daily-' + today
    };
  }

  async function runReminders(now = new Date()) {
    if (!enabled) return { skipped: 'disabled' };
    const today = dayKey(now);
    const hour = parisHour(now);
    if (hour < reminderHour || hour >= REMINDER_END_HOUR) return { skipped: 'hors-plage' };

    // Réclamation atomique des abonnements dus.
    const { data: due, error } = await supabase.from('push_subscriptions')
      .update({ last_sent_day: today })
      .or(`last_sent_day.is.null,last_sent_day.neq.${today}`)
      .select('endpoint, user_id, p256dh, auth');
    if (error) throw error;
    if (!due || !due.length) return { claimed: 0, sent: 0 };

    const ids = [...new Set(due.map(s => s.user_id))];
    const since = addDays(today, -STREAK_WINDOW_DAYS);
    const { data: rows, error: rowsErr } = await supabase.from('daily_scores')
      .select('user_id, day').eq('finished', true).in('user_id', ids).gte('day', since);
    if (rowsErr) throw rowsErr;

    const daysByUser = new Map();
    (rows || []).forEach(r => {
      if (!daysByUser.has(r.user_id)) daysByUser.set(r.user_id, []);
      daysByUser.get(r.user_id).push(r.day);
    });

    const boss = daily.publicBoss(daily.buildDaily(today));
    const targets = [];
    for (const sub of due) {
      const st = computeStreak(daysByUser.get(sub.user_id) || [], today);
      if (st.playedToday) continue;
      targets.push({ sub, payload: reminderPayload(today, boss, st.current) });
    }

    let sent = 0;
    for (let i = 0; i < targets.length; i += SEND_BATCH) {
      const results = await Promise.all(targets.slice(i, i + SEND_BATCH).map(t => sendOne(t.sub, t.payload)));
      sent += results.filter(Boolean).length;
    }
    return { claimed: due.length, sent };
  }

  if (enabled) {
    const tick = () => runReminders().catch(err => console.error('[push] rappels :', err && err.message));
    const t1 = setTimeout(tick, 15000);
    const t2 = setInterval(tick, TICK_MS);
    if (t1.unref) t1.unref();
    if (t2.unref) t2.unref();
    console.log(`[push] rappels actifs : ${reminderHour} h (Europe/Paris), 1 par jour et par appareil.`);
  }

  return { enabled, runReminders };
}

module.exports = { registerPush, isAllowedEndpoint, validSubscription, _test: { parisHour } };
