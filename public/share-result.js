/* PARTAGE DE RÉSULTAT — client.
 * Génère une image récap 1080×1080 (canvas) + un texte, puis propose : Partager (feuille
 * système mobile), Copier l'image, Télécharger, Copier le texte.
 *
 * API : window.RDBShare.open(data)
 *   data = { title, boss:{name,sprite}, difficultyKey, difficultyLabel, victory, score, required,
 *            scoreLabel?, rankLine?, choices?:['HAUT'|'BAS',...], team:[{name, urls:[...], shiny}],
 *            pseudo?, url? }
 *
 * Branché sur : fin de partie Route du Boss (normal / admin / coop) via applyGameFinished,
 * et défi quotidien (daily-client.js). Dépend de client.js (myId, isAdminNow, ordinalFr,
 * DIFFICULTY_LABELS) uniquement pour la fin de partie.
 * Sprites : chargés en CORS (crossOrigin) pour ne jamais "tainter" le canvas ; un sprite qui
 * échoue est simplement omis (nom affiché à la place). */
(function () {
  'use strict';

  const SIZE = 1080;
  const C = {
    bg: '#070a10', void: '#04060a', panel: '#141a24', panelAlt: '#1a2230', border: '#262f3d',
    text: '#eef0f5', muted: '#8a93a6', haut: '#f5a623', bas: '#3fd0c9', danger: '#e8615d', gold: '#ffd54a'
  };
  const DIFF_COLORS = { easy: '#7cc9a0', medium: '#f5a623', hard: '#e8615d', extreme: '#b98cf2' };
  const FONT_D = "'Chakra Petch', 'Segoe UI', sans-serif";
  const FONT_M = "'JetBrains Mono', ui-monospace, monospace";
  const IMG_TIMEOUT_MS = 7000;

  // ---------- Chargement d'images (CORS) ----------
  function loadImage(urls) {
    const list = (Array.isArray(urls) ? urls : [urls]).filter(Boolean);
    return list.reduce((chain, url) => chain.then(found => found || new Promise(resolve => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      const timer = setTimeout(() => resolve(null), IMG_TIMEOUT_MS);
      img.onload = () => { clearTimeout(timer); resolve(img); };
      img.onerror = () => { clearTimeout(timer); resolve(null); };
      img.src = url;
    })), Promise.resolve(null));
  }

  // ---------- Dessin (pur : ctx + données + images déjà chargées) ----------
  function roundRectPath(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function fitText(ctx, text, weight, maxPx, minPx, maxW, family) {
    let px = maxPx;
    ctx.font = `${weight} ${px}px ${family}`;
    while (px > minPx && ctx.measureText(text).width > maxW) { px -= 2; ctx.font = `${weight} ${px}px ${family}`; }
    return px;
  }

  function ellipsize(ctx, text, maxW) {
    if (ctx.measureText(text).width <= maxW) return text;
    let t = text;
    while (t.length > 1 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1);
    return t + '…';
  }

  function drawContain(ctx, img, x, y, w, h) {
    const s = Math.min(w / img.naturalWidth, h / img.naturalHeight);
    const dw = img.naturalWidth * s, dh = img.naturalHeight * s;
    ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
  }

  function drawCard(ctx, data, imgs) {
    const W = SIZE, cx = W / 2;
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'center';

    // Fond + lueurs HAUT/BAS
    ctx.fillStyle = C.bg; ctx.fillRect(0, 0, W, W);
    let g = ctx.createRadialGradient(140, 120, 0, 140, 120, 620);
    g.addColorStop(0, 'rgba(245,166,35,0.16)'); g.addColorStop(1, 'rgba(245,166,35,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, W);
    g = ctx.createRadialGradient(W - 140, W - 120, 0, W - 140, W - 120, 640);
    g.addColorStop(0, 'rgba(63,208,201,0.16)'); g.addColorStop(1, 'rgba(63,208,201,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, W);
    roundRectPath(ctx, 24, 24, W - 48, W - 48, 28);
    ctx.strokeStyle = C.border; ctx.lineWidth = 2; ctx.stroke();

    // En-tête
    ctx.fillStyle = C.text;
    ctx.font = `700 38px ${FONT_D}`;
    ctx.fillText('ROUTE DU BOSS', cx, 90);
    ctx.fillStyle = C.muted;
    ctx.font = `500 26px ${FONT_M}`;
    ctx.fillText(ellipsize(ctx, data.title || '', 900), cx, 132);

    // Boss
    if (imgs.boss) drawContain(ctx, imgs.boss, cx - 125, 150, 250, 250);
    ctx.fillStyle = C.text;
    fitText(ctx, data.boss.name.toUpperCase(), 700, 56, 30, 900, FONT_D);
    ctx.fillText(data.boss.name.toUpperCase(), cx, 450);

    if (data.difficultyLabel) {
      ctx.font = `700 22px ${FONT_M}`;
      const label = data.difficultyLabel.toUpperCase();
      const pw = ctx.measureText(label).width + 44;
      const col = DIFF_COLORS[data.difficultyKey] || C.muted;
      roundRectPath(ctx, cx - pw / 2, 470, pw, 40, 20);
      ctx.fillStyle = col + '26'; ctx.fill();
      ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.stroke();
      ctx.fillStyle = col;
      ctx.fillText(label, cx, 498);
    }

    // Résultat
    const win = !!data.victory;
    ctx.fillStyle = win ? C.bas : C.danger;
    ctx.shadowColor = win ? 'rgba(63,208,201,0.45)' : 'rgba(232,97,93,0.4)';
    ctx.shadowBlur = 28;
    ctx.font = `700 88px ${FONT_D}`;
    ctx.fillText(win ? 'VICTOIRE !' : 'DÉFAITE', cx, 610);
    ctx.shadowBlur = 0; ctx.shadowColor = 'transparent';

    ctx.fillStyle = C.text;
    ctx.font = `700 46px ${FONT_M}`;
    ctx.fillText(`${data.score} / ${data.required} ${data.scoreLabel || 'PTS'}`, cx, 672);

    let y = 716;
    if (data.rankLine) {
      ctx.fillStyle = C.muted; ctx.font = `500 28px ${FONT_M}`;
      ctx.fillText(ellipsize(ctx, data.rankLine, 900), cx, y);
    }

    // Choix HAUT/BAS (défi quotidien)
    if (data.choices && data.choices.length) {
      const sq = 26, gap = 10, total = data.choices.length * sq + (data.choices.length - 1) * gap;
      let x = cx - total / 2;
      const top = 736;
      data.choices.forEach(c => {
        roundRectPath(ctx, x, top, sq, sq, 6);
        ctx.fillStyle = c === 'HAUT' ? C.haut : C.bas; ctx.fill();
        x += sq + gap;
      });
    }

    // Équipe : 6 emplacements
    const slot = 130, sgap = 24, x0 = (W - (6 * slot + 5 * sgap)) / 2, ty = 790;
    for (let i = 0; i < 6; i++) {
      const mon = data.team[i];
      const x = x0 + i * (slot + sgap);
      roundRectPath(ctx, x, ty, slot, slot, 16);
      ctx.fillStyle = C.panel; ctx.fill();
      ctx.strokeStyle = mon && mon.shiny ? C.gold : C.border;
      ctx.lineWidth = mon && mon.shiny ? 3 : 2; ctx.stroke();
      if (!mon) continue;
      if (imgs.team[i]) drawContain(ctx, imgs.team[i], x + 8, ty + 8, slot - 16, slot - 16);
      ctx.fillStyle = C.muted; ctx.font = `500 18px ${FONT_M}`;
      ctx.fillText(ellipsize(ctx, mon.name, slot + 10), x + slot / 2, ty + slot + 28);
    }

    // Pied
    ctx.font = `500 22px ${FONT_M}`;
    ctx.fillStyle = C.muted;
    ctx.textAlign = 'left';
    if (data.pseudo) ctx.fillText(ellipsize(ctx, data.pseudo, 420), 64, 1030);
    ctx.textAlign = 'right';
    ctx.fillStyle = C.haut;
    ctx.fillText((data.url || '').replace(/^https?:\/\//, ''), W - 64, 1030);
    ctx.textAlign = 'center';
  }

  async function renderCanvas(data) {
    try {
      if (document.fonts && document.fonts.load) {
        await Promise.all([
          document.fonts.load(`700 40px ${FONT_D}`), document.fonts.load(`500 24px ${FONT_M}`), document.fonts.load(`700 24px ${FONT_M}`)
        ]);
      }
    } catch (e) {}
    const [boss, ...team] = await Promise.all([
      loadImage(data.boss.sprite),
      ...data.team.slice(0, 6).map(m => loadImage(m.urls))
    ]);
    const canvas = document.createElement('canvas');
    canvas.width = SIZE; canvas.height = SIZE;
    drawCard(canvas.getContext('2d'), data, { boss, team });
    return canvas;
  }

  // ---------- Texte à partager ----------
  function buildText(data) {
    const lines = [];
    lines.push(`${data.victory ? '🏆' : '💀'} Route du Boss · ${data.title}`);
    lines.push(`⚔️ ${data.boss.name}${data.difficultyLabel ? ` (${data.difficultyLabel})` : ''}`);
    lines.push(`${data.victory ? '✅ Victoire' : '❌ Défaite'} · ${data.score}/${data.required} ${data.scoreLabel || 'PTS'}`);
    if (data.rankLine) lines.push(data.rankLine);
    if (data.choices && data.choices.length) lines.push(data.choices.map(c => (c === 'HAUT' ? '🟧' : '🟦')).join(''));
    const names = data.team.map(m => m.name).filter(Boolean);
    if (names.length) lines.push(`🎯 ${names.join(', ')}`);
    if (data.url) lines.push(data.url);
    return lines.join('\n');
  }

  // ---------- Modale ----------
  let modal = null;
  let currentUrl = null;

  function toBlob(canvas) {
    return new Promise((resolve, reject) => {
      try { canvas.toBlob(b => (b ? resolve(b) : reject(new Error('blob'))), 'image/png'); }
      catch (e) { reject(e); }
    });
  }

  function legacyCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e) {}
    document.body.removeChild(ta);
    return ok;
  }

  async function copyText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(text); return true; }
    } catch (e) {}
    return legacyCopy(text);
  }

  function buildModal() {
    const root = document.createElement('div');
    root.className = 'share-modal is-hidden';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', 'Partager mon résultat');
    root.innerHTML = `
      <div class="share-modal__box">
        <img class="share-modal__img" alt="Aperçu du résultat">
        <div class="share-modal__actions">
          <button type="button" class="btn btn--haut" data-act="share">Partager</button>
          <button type="button" class="btn btn--bas" data-act="copy-img">Copier l'image</button>
          <button type="button" class="btn btn--ghost" data-act="download">Télécharger</button>
          <button type="button" class="btn btn--ghost" data-act="copy-text">Copier le texte</button>
        </div>
        <p class="share-modal__status" role="status"></p>
        <button type="button" class="btn btn--ghost btn--block" data-act="close">Fermer</button>
      </div>`;
    document.body.appendChild(root);
    root.addEventListener('click', (e) => { if (e.target === root) closeModal(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !root.classList.contains('is-hidden')) closeModal(); });
    return root;
  }

  function closeModal() {
    if (!modal) return;
    modal.classList.add('is-hidden');
    const img = modal.querySelector('.share-modal__img');
    img.removeAttribute('src');
    if (currentUrl) { URL.revokeObjectURL(currentUrl); currentUrl = null; }
  }

  async function open(data) {
    if (!data) return;
    if (!modal) modal = buildModal();
    const status = modal.querySelector('.share-modal__status');
    const imgEl = modal.querySelector('.share-modal__img');
    const btn = act => modal.querySelector(`[data-act="${act}"]`);
    const text = buildText(data);
    const setStatus = (t) => { status.textContent = t || ''; };

    imgEl.removeAttribute('src');
    if (currentUrl) { URL.revokeObjectURL(currentUrl); currentUrl = null; }
    modal.classList.remove('is-hidden');
    ['share', 'copy-img', 'download'].forEach(a => { btn(a).disabled = true; });
    btn('copy-text').disabled = false;
    setStatus('Génération de l\'image…');

    // Fonctions indisponibles sur ce navigateur : masquées.
    btn('share').classList.toggle('screen--hidden', !navigator.share);
    btn('copy-img').classList.toggle('screen--hidden', !(navigator.clipboard && window.ClipboardItem));

    let blob = null;
    try {
      blob = await toBlob(await renderCanvas(data));
      currentUrl = URL.createObjectURL(blob);
      imgEl.src = currentUrl;
      ['share', 'copy-img', 'download'].forEach(a => { btn(a).disabled = false; });
      setStatus('');
    } catch (err) {
      setStatus('Image indisponible : tu peux copier le texte.');
    }

    const file = blob ? new File([blob], 'route-du-boss.png', { type: 'image/png' }) : null;

    btn('share').onclick = async () => {
      try {
        if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
          await navigator.share({ files: [file], text, title: 'Route du Boss' });
        } else {
          await navigator.share({ title: 'Route du Boss', text, url: data.url });
        }
      } catch (e) { if (!e || e.name !== 'AbortError') setStatus('Partage impossible.'); }
    };
    btn('copy-img').onclick = async () => {
      try {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        setStatus('Image copiée !');
      } catch (e) { setStatus('Copie impossible : utilise Télécharger.'); }
    };
    btn('download').onclick = () => {
      if (!blob) return;
      const a = document.createElement('a');
      a.href = currentUrl; a.download = 'route-du-boss.png';
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setStatus('Image téléchargée.');
    };
    btn('copy-text').onclick = async () => { setStatus((await copyText(text)) ? 'Texte copié !' : 'Copie impossible.'); };
    btn('close').onclick = closeModal;
  }

  window.RDBShare = { open, buildText, _drawCard: drawCard, _gameShareData: gameShareData };

  // ---------- Intégration : fin de partie Route du Boss ----------
  const MODE_TITLES = { normal: 'Partie normale', admin: 'Admin vs Joueur', coop: 'Coopératif' };
  const shareBtn = document.getElementById('btn-share-finished');
  let lastGame = null;

  function gameShareData(payload) {
    const { boss, difficulty, gameMode, adminId, players, teamScore, teamRequired, reason } = payload;
    if (!boss || !players) return null;
    const admin = typeof isAdminNow === 'function' && isAdminNow();
    const me = players.find(p => p.id === myId);
    const subject = admin ? players.find(p => p.id !== adminId) : me;
    if (!subject) return null;

    const isCoop = gameMode === 'coop' && teamRequired != null;
    const contenders = players.filter(p => gameMode !== 'admin' || p.id !== adminId);
    const rank = [...contenders].sort((a, b) => b.score - a.score).findIndex(p => p.id === subject.id) + 1;
    const account = typeof getStoredAccount === 'function' ? getStoredAccount() : null;

    let rankLine = null;
    if (isCoop) rankLine = `Ma contribution : ${subject.score} PTS`;
    else if (contenders.length > 1 && rank > 0) rankLine = `Classement : ${ordinalFr(rank)} sur ${contenders.length}`;

    return {
      title: (MODE_TITLES[gameMode] || MODE_TITLES.normal) + (reason === 'forfeit' ? ' (forfait)' : ''),
      boss: { name: boss.name, sprite: boss.sprite },
      difficultyKey: difficulty,
      difficultyLabel: (typeof DIFFICULTY_LABELS !== 'undefined' && DIFFICULTY_LABELS[difficulty]) || '',
      victory: subject.result === 'victory',
      score: isCoop ? teamScore : subject.score,
      required: isCoop ? teamRequired : boss.requiredPoints,
      scoreLabel: isCoop ? 'PTS D\'ÉQUIPE' : 'PTS',
      rankLine,
      team: (subject.team || []).map(m => ({
        name: m.name, shiny: !!m.shiny,
        urls: [m.shiny && m.shinySprite ? m.shinySprite : null, m.sprite]
      })),
      pseudo: (account && account.pseudo) || subject.name || '',
      url: location.origin
    };
  }

  if (shareBtn && typeof window.applyGameFinished === 'function') {
    const originalApplyGameFinished = window.applyGameFinished;
    window.applyGameFinished = function (payload) {
      const out = originalApplyGameFinished.apply(this, arguments);
      try {
        lastGame = gameShareData(payload);
        shareBtn.classList.toggle('screen--hidden', !lastGame);
      } catch (e) { lastGame = null; shareBtn.classList.add('screen--hidden'); }
      return out;
    };
    shareBtn.addEventListener('click', () => open(lastGame));
  }
})();
