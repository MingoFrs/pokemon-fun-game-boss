'use strict';
// =====================================================================
// MOT DE PASSE — côté client (chargé APRÈS client.js, dont il réutilise les globaux :
// getStoredAccount, refreshAccountFromServer, openSettings, refreshAccountSettingsSection...).
//  - "Mot de passe oublié ?" dans l'onglet Connexion : demande un lien par email.
//  - Arrivée depuis ce lien (#access_token=...&type=recovery) : formulaire "nouveau mot de passe".
//  - Compte connecté, sous-onglet "Mot de passe" : changement avec le mot de passe actuel.
// Aucun mot de passe n'est conservé : tout part vers le serveur, qui s'appuie sur Supabase Auth.
// =====================================================================
(function () {
  const $ = id => document.getElementById(id);
  const el = {
    tabs: $('account-tabs'),
    formLogin: $('account-form-login'),
    formRegister: $('account-form-register'),
    formForgot: $('account-form-forgot'),
    formReset: $('account-form-reset'),
    loggedPanel: $('account-logged-panel'),
    loginMsg: $('account-login-msg'),
    btnForgot: $('btn-account-forgot'),
    forgotEmail: $('account-forgot-email'),
    loginEmail: $('account-login-email'),
    btnForgotSend: $('btn-account-forgot-send'),
    btnForgotBack: $('btn-account-forgot-back'),
    forgotMsg: $('account-forgot-msg'),
    resetPassword: $('account-reset-password'),
    resetConfirm: $('account-reset-confirm'),
    btnResetSave: $('btn-account-reset-save'),
    resetMsg: $('account-reset-msg'),
    pwCurrent: $('account-pw-current'),
    pwNew: $('account-pw-new'),
    pwConfirm: $('account-pw-confirm'),
    btnPwSave: $('btn-account-pw-save'),
    pwMsg: $('account-pw-msg')
  };
  if (!el.formForgot || !el.formReset || !el.btnForgot || !el.btnPwSave) return; // HTML non intégré : rien à faire

  const MIN_LENGTH = 6;
  const MAX_LENGTH = 72;
  let recoveryToken = null;      // jeton du lien reçu par email (en mémoire uniquement, jamais stocké)
  let pendingLoginNotice = '';   // message affiché sur l'onglet Connexion après une réinitialisation

  function setMsg(node, text, kind) {
    node.textContent = text || '';
    node.classList.toggle('account-pw-msg--ok', kind === 'ok');
    node.classList.toggle('account-pw-msg--error', kind === 'error');
  }
  const hide = node => node.classList.add('screen--hidden');
  const show = node => node.classList.remove('screen--hidden');

  async function postJson(url, body) {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    let data = {};
    try { data = await res.json(); } catch (err) { /* réponse non JSON */ }
    return { ok: res.ok, status: res.status, data };
  }

  function passwordProblem(password, confirm) {
    if (!password) return 'Mot de passe requis.';
    if (password.length < MIN_LENGTH) return `Le mot de passe doit faire au moins ${MIN_LENGTH} caractères.`;
    if (password.length > MAX_LENGTH) return `Le mot de passe doit faire ${MAX_LENGTH} caractères maximum.`;
    if (password !== confirm) return 'Les deux mots de passe ne correspondent pas.';
    return null;
  }

  // ------------------------------------------------------------------
  // Quel formulaire montrer (appelé après CHAQUE refreshAccountSettingsSection de client.js)
  // ------------------------------------------------------------------
  function applyView() {
    hide(el.formForgot);
    setMsg(el.forgotMsg, '');
    if (recoveryToken) {
      // Mode récupération : seul le formulaire "nouveau mot de passe" est visible.
      hide(el.tabs); hide(el.formLogin); hide(el.formRegister); hide(el.loggedPanel);
      show(el.formReset);
      return;
    }
    hide(el.formReset);
    setMsg(el.resetMsg, '');
    if (pendingLoginNotice && !el.formLogin.classList.contains('screen--hidden')) {
      setMsg(el.loginMsg, pendingLoginNotice, 'ok');
    } else {
      setMsg(el.loginMsg, '');
    }
    pendingLoginNotice = '';
  }

  const originalRefresh = window.refreshAccountSettingsSection;
  if (typeof originalRefresh === 'function') {
    window.refreshAccountSettingsSection = function () {
      const out = originalRefresh.apply(this, arguments);
      applyView();
      return out;
    };
  }

  // Les onglets Connexion / Créer un compte referment le formulaire "oublié".
  document.querySelectorAll('#account-tabs .admin-role-btn').forEach(btn => {
    btn.addEventListener('click', () => { hide(el.formForgot); setMsg(el.forgotMsg, ''); });
  });

  // ------------------------------------------------------------------
  // 1) Mot de passe oublié
  // ------------------------------------------------------------------
  el.btnForgot.addEventListener('click', () => {
    hide(el.formLogin); hide(el.formRegister);
    show(el.formForgot);
    if (!el.forgotEmail.value) el.forgotEmail.value = el.loginEmail.value.trim();
    setMsg(el.forgotMsg, '');
    el.forgotEmail.focus();
  });

  el.btnForgotBack.addEventListener('click', () => {
    hide(el.formForgot);
    show(el.formLogin);
    setMsg(el.forgotMsg, '');
  });

  el.btnForgotSend.addEventListener('click', async () => {
    const email = el.forgotEmail.value.trim();
    if (!email || !email.includes('@')) {
      setMsg(el.forgotMsg, 'Entre une adresse email valide.', 'error');
      return;
    }
    el.btnForgotSend.disabled = true;
    setMsg(el.forgotMsg, 'Envoi…');
    try {
      const { ok, data } = await postJson('/api/forgot-password', { email });
      if (!ok) {
        setMsg(el.forgotMsg, data.error || "L'email n'a pas pu être envoyé.", 'error');
        el.btnForgotSend.disabled = false;
        return;
      }
      setMsg(el.forgotMsg, "C'est envoyé : si un compte existe avec cet email, tu vas recevoir un lien (pense aux spams). Il reste valable un temps limité.", 'ok');
      // Anti-spam : le bouton reste bloqué 30 s avant un nouvel envoi.
      setTimeout(() => { el.btnForgotSend.disabled = false; }, 30000);
    } catch (err) {
      setMsg(el.forgotMsg, 'Connexion au serveur impossible.', 'error');
      el.btnForgotSend.disabled = false;
    }
  });

  // ------------------------------------------------------------------
  // 2) Arrivée depuis le lien du mail : #access_token=...&type=recovery
  // ------------------------------------------------------------------
  function cleanUrl() {
    history.replaceState(null, '', location.pathname + location.search); // le jeton ne reste ni dans la barre d'adresse ni dans l'historique
  }

  function openAccountSettings() {
    if (typeof openSettings === 'function') openSettings();
    applyView();
  }

  function handleEmailLink() {
    const raw = location.hash.startsWith('#') ? location.hash.slice(1) : '';
    if (!raw) return;
    const params = new URLSearchParams(raw);
    if (params.get('type') === 'recovery' && params.get('access_token')) {
      recoveryToken = params.get('access_token');
      cleanUrl();
      openAccountSettings();
      setMsg(el.resetMsg, '');
      el.resetPassword.focus();
    } else if (params.get('error_code') || params.get('error_description')) {
      cleanUrl();
      openAccountSettings();
      // Le plus souvent : lien expiré (otp_expired) ou déjà utilisé.
      hide(el.formLogin);
      show(el.formForgot);
      setMsg(el.forgotMsg, 'Ce lien a expiré ou a déjà été utilisé. Refais une demande ci-dessous.', 'error');
    }
  }

  el.btnResetSave.addEventListener('click', async () => {
    if (!recoveryToken) return;
    const problem = passwordProblem(el.resetPassword.value, el.resetConfirm.value);
    if (problem) {
      setMsg(el.resetMsg, problem, 'error');
      return;
    }
    el.btnResetSave.disabled = true;
    setMsg(el.resetMsg, 'Enregistrement…');
    try {
      const { ok, data } = await postJson('/api/reset-password', { accessToken: recoveryToken, password: el.resetPassword.value });
      if (!ok) {
        setMsg(el.resetMsg, data.error || "Le mot de passe n'a pas pu être changé.", 'error');
        return;
      }
      recoveryToken = null;
      el.resetPassword.value = '';
      el.resetConfirm.value = '';
      pendingLoginNotice = 'Mot de passe modifié ✅ Connecte-toi avec le nouveau.';
      if (typeof window.refreshAccountSettingsSection === 'function') window.refreshAccountSettingsSection();
    } catch (err) {
      setMsg(el.resetMsg, 'Connexion au serveur impossible.', 'error');
    } finally {
      el.btnResetSave.disabled = false;
    }
  });

  // ------------------------------------------------------------------
  // 3) Changer son mot de passe (compte connecté)
  // ------------------------------------------------------------------
  el.btnPwSave.addEventListener('click', async () => {
    if (!getStoredAccount()) {
      setMsg(el.pwMsg, 'Tu dois être connecté.', 'error');
      return;
    }
    if (!el.pwCurrent.value) {
      setMsg(el.pwMsg, 'Entre ton mot de passe actuel.', 'error');
      return;
    }
    const problem = passwordProblem(el.pwNew.value, el.pwConfirm.value);
    if (problem) {
      setMsg(el.pwMsg, problem, 'error');
      return;
    }
    el.btnPwSave.disabled = true;
    setMsg(el.pwMsg, 'Enregistrement…');
    try {
      // Le jeton d'accès expire vite : on le renouvelle via le refreshToken avant d'agir.
      await refreshAccountFromServer();
      const account = getStoredAccount();
      if (!account) {
        setMsg(el.pwMsg, 'Session expirée : reconnecte-toi.', 'error');
        return;
      }
      const { ok, data } = await postJson('/api/profile/password', {
        accessToken: account.accessToken,
        currentPassword: el.pwCurrent.value,
        newPassword: el.pwNew.value
      });
      if (!ok) {
        setMsg(el.pwMsg, data.error || "Le mot de passe n'a pas pu être changé.", 'error');
        return;
      }
      el.pwCurrent.value = '';
      el.pwNew.value = '';
      el.pwConfirm.value = '';
      setMsg(el.pwMsg, 'Mot de passe modifié ✅ Les autres appareils ont été déconnectés.', 'ok');
    } catch (err) {
      setMsg(el.pwMsg, 'Connexion au serveur impossible.', 'error');
    } finally {
      el.btnPwSave.disabled = false;
    }
  });

  // Efface les champs/messages dès que l'on change de sous-onglet ou ferme les Réglages.
  document.querySelectorAll('#account-subtabs .settings-subtab').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.accountSubpage !== 'password') setMsg(el.pwMsg, '');
    });
  });

  handleEmailLink();
})();
