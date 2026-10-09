/* Retour sonore et haptique — réglages Volume + Vibrations, effets « chromatique » et « récompense ».
 * Dépend de client.js (playTone, play*Sound, socket) ; chargé après lui.
 * Les sons restent pilotés par le réglage « Sons » existant ; les vibrations sont désactivées par défaut
 * (navigator.vibrate : Android / Chrome ; absent sur iOS Safari → option grisée avec explication). */
(function () {
  'use strict';
  const KEY = 'rdb_settings_v1';
  const $ = id => document.getElementById(id);
  const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { return {}; } };
  const save = s => { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (e) {} };

  let settings = load();
  const canVibrate = typeof navigator.vibrate === 'function';
  const hapticsOn = () => canVibrate && settings.haptics === true;
  const DEFAULT_VOLUME = 0.8; // volume « historique » : 0,8 = intensité d'origine des sons
  const volume = () => (typeof settings.volume === 'number' ? Math.min(1, Math.max(0, settings.volume)) : DEFAULT_VOLUME);

  function vibrate(pattern) {
    if (!hapticsOn()) return;
    try { navigator.vibrate(pattern); } catch (e) {}
  }

  // ---------- Réglages ----------
  const hapticsInput = $('settings-haptics');
  const hapticsHint = $('settings-haptics-hint');
  const volumeInput = $('settings-volume');

  if (hapticsInput) {
    hapticsInput.checked = hapticsOn();
    if (!canVibrate) {
      hapticsInput.disabled = true;
      if (hapticsHint) {
        hapticsHint.textContent = 'Vibrations non prises en charge par cet appareil ou ce navigateur.';
        hapticsHint.classList.remove('screen--hidden');
      }
    }
    hapticsInput.addEventListener('change', () => {
      settings = load();
      settings.haptics = hapticsInput.checked;
      save(settings);
      if (hapticsInput.checked) vibrate(40); // aperçu immédiat (le clic est le geste utilisateur requis)
    });
  }
  if (volumeInput) {
    volumeInput.value = String(Math.round(volume() * 100));
    volumeInput.addEventListener('input', () => {
      settings = load();
      settings.volume = Number(volumeInput.value) / 100;
      save(settings);
    });
    // Aperçu à la fin du glissement (un son par mouvement serait pénible).
    volumeInput.addEventListener('change', () => { if (typeof window.playClickSound === 'function') window.playClickSound(); });
  }

  // ---------- Volume : mise à l'échelle de playTone (le niveau par défaut garde l'intensité d'origine) ----------
  if (typeof window.playTone === 'function') {
    const original = window.playTone;
    window.playTone = function (opts) {
      const o = opts || {};
      const base = typeof o.volume === 'number' ? o.volume : 0.15;
      return original.call(this, Object.assign({}, o, { volume: base * (volume() / DEFAULT_VOLUME) }));
    };
  }

  // ---------- Haptique sur les sons existants ----------
  const HAPTIC_FOR = {
    playClickSound: 8,
    playRevealSound: [12, 30, 18],
    playVictorySound: [40, 60, 40, 60, 120],
    playDefeatSound: [160, 70, 60],
    playRouletteStopSound: isBonus => (isBonus ? [30, 40, 60] : [90])
  };
  Object.keys(HAPTIC_FOR).forEach(name => {
    const original = window[name];
    if (typeof original !== 'function') return;
    window[name] = function () {
      const out = original.apply(this, arguments);
      const p = HAPTIC_FOR[name];
      vibrate(typeof p === 'function' ? p.apply(null, arguments) : p);
      return out;
    };
  });

  // ---------- Effets dédiés ----------
  function tone(freq, delay, dur, vol, type) {
    if (typeof window.playTone === 'function') window.playTone({ freq, duration: dur, type: type || 'triangle', volume: vol, delay });
  }
  function shinyFx() {
    [1318.5, 1568, 2093, 2637].forEach((f, i) => tone(f, i * 0.07, 0.25, 0.07, 'sine'));
    vibrate([20, 40, 20, 40, 20, 40, 120]);
  }
  function rewardFx() {
    [659.25, 783.99, 987.77, 1318.5].forEach((f, i) => tone(f, i * 0.08, 0.22, 0.1));
    vibrate([30, 50, 30, 50, 100]);
  }
  window.rdbFeedback = function (kind) {
    if (kind === 'shiny') shinyFx();
    else if (kind === 'reward') rewardFx();
    else if (kind === 'click' && typeof window.playClickSound === 'function') window.playClickSound();
  };

  if (typeof socket !== 'undefined') {
    socket.on('choice_result', (d) => { if (d && d.pokemon && d.pokemon.shiny) shinyFx(); });
    socket.on('achievements_unlocked', () => rewardFx());
  }
})();
