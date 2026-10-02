#!/usr/bin/env python3
# Patch du client pour le mode 'fly' : modifie public/index.html et public/style.css.
# client.js n'est PAS modifié (public/fly-client.js enveloppe ses fonctions au chargement).
#   python3 patch-client-fly.py [dossier_public]      (défaut : ./public)
# Chaque ancre doit exister EXACTEMENT 1 fois, sinon abandon sans rien écrire.
# Sauvegardes : index.html.bak-fly, style.css.bak-fly. Idempotent.
import os, sys, shutil

pub = sys.argv[1] if len(sys.argv) > 1 else 'public'
html_path, css_path = os.path.join(pub, 'index.html'), os.path.join(pub, 'style.css')
html = open(html_path, encoding='utf-8').read()
css = open(css_path, encoding='utf-8').read()
if 'fly-client.js' in html or '/* ===== MODE FLY' in css:
    sys.exit('Déjà patché. Rien à faire.')

edits = []   # (nom, ancre, remplacement)  — insertion = ancre + ajout, ou ajout + ancre
def E(name, anchor, new, before=False): edits.append((name, anchor, (new + anchor) if before else (anchor + new)))

E('bouton du lobby',
  '<button type="button" class="gamemode-btn" data-mode="coop">Coop</button>',
  '\n            <button type="button" class="gamemode-btn" data-mode="fly">Humanité vs Mouche</button>')

E('stats du lobby',
  '<p id="gamemode-hint" class="gamemode-hint screen--hidden"></p>',
  '\n        <div id="fly-lobby-stats" class="fly-stats screen--hidden"></div>')

E('carte de la Mouche (barre latérale)',
  '        <div class="route-panel">',
  '''        <div id="fly-card" class="fly-card screen--hidden">
          <p class="eyebrow">Adversaire</p>
          <div class="fly-card__head">
            <span class="fly-card__avatar" aria-hidden="true">🪰</span>
            <div>
              <h2 class="fly-card__name">LA MOUCHE</h2>
              <p id="fly-card-meta" class="fly-card__meta"></p>
            </div>
          </div>
          <p id="fly-card-status" class="fly-card__status"></p>
          <div class="my-score-row">
            <span class="my-score-label">Score de la Mouche</span>
            <span class="my-score-value-wrap">
              <span id="fly-score-value" class="my-score-value">0</span>
              <span id="fly-score-popup" class="my-score-popup"></span>
            </span>
          </div>
          <div id="fly-team" class="fly-team"></div>
          <p class="fly-card__note">IA simple (apprentissage par renforcement) : elle apprend après chaque partie.</p>
          <div id="fly-card-stats" class="fly-stats"></div>
        </div>

''', before=True)

E('révélation du choix de la Mouche',
  '        <button id="btn-skip" type="button" class="btn btn--ghost btn--block screen--hidden">Skip ⏩</button>',
  '''        <div id="fly-reveal-panel" class="result-panel fly-reveal fly-reveal--hidden">
          <p class="eyebrow">Choix de la Mouche · <span id="fly-reveal-choice"></span></p>
          <p id="fly-reveal-rarity" class="result-rarity"></p>
          <img id="fly-reveal-sprite" class="result-sprite" src="" alt="">
          <p id="fly-reveal-name" class="result-name"></p>
          <div class="result-breakdown">
            <p class="result-line">Base : <span id="fly-reveal-base">0</span> PTS</p>
            <p class="result-line">Effet : <span id="fly-reveal-effect">—</span></p>
            <p class="result-final">Résultat : <span id="fly-reveal-points">0</span> PTS</p>
          </div>
        </div>
''', before=True)

E('écran de fin dédié',
  '  <!-- ============ MODE "DEVINE LE POKÉMON" ============ -->',
  '''  <!-- ============ MODE "HUMANITÉ vs MOUCHE" : écran de fin ============ -->
  <section id="screen-fly-finished" class="screen screen--hidden">
    <p id="fly-finished-outcome" class="finished-outcome"></p>
    <div class="fly-finished-scores">
      <div class="finished-stat">
        <p class="eyebrow">Toi</p>
        <p id="fly-finished-me" class="finished-stat__value">0 PTS</p>
      </div>
      <div class="finished-stat">
        <p class="eyebrow">La Mouche 🪰</p>
        <p id="fly-finished-fly" class="finished-stat__value">0 PTS</p>
      </div>
    </div>
    <p class="eyebrow finished-ranking-title">Tour par tour</p>
    <div id="fly-finished-turns" class="fly-turns"></div>
    <p id="fly-finished-learned" class="fly-learned"></p>
    <div id="fly-finished-stats" class="fly-stats"></div>
    <button id="fly-btn-replay" class="btn btn--haut btn--block screen--hidden">Rejouer</button>
    <button id="fly-btn-leave" class="btn btn--ghost btn--block">Quitter</button>
  </section>

''', before=True)

E('script',
  '<script src="client.js?v=2"></script>',
  '\n<script src="fly-client.js?v=1"></script>')

CSS = '''

/* ===== MODE FLY (Humanité vs Mouche) ===== */
/* Boss absent : on masque ses éléments dans le panneau (le score personnel, lui, reste affiché). */
body.fly-mode #boss-panel > .eyebrow,
body.fly-mode #boss-sprite,
body.fly-mode #boss-name,
body.fly-mode .boss-target,
body.fly-mode #boss-types,
body.fly-mode #boss-weak,
body.fly-mode #type-bonus-panel,
body.fly-mode #boss-attack-banner { display: none !important; }

.fly-card {
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: 14px;
  padding: 16px;
  margin: 12px 0;
}
.fly-card__head { display: flex; align-items: center; gap: 12px; margin: 6px 0 10px; }
.fly-card__avatar {
  display: grid; place-items: center; width: 52px; height: 52px; flex: none;
  font-size: 1.9rem; border-radius: 50%;
  background: var(--bg-panel-raised); border: 1px solid var(--border);
  animation: fly-buzz 2.4s ease-in-out infinite;
}
.fly-card__name { font-family: var(--font-display); font-size: 1.15rem; letter-spacing: 0.06em; margin: 0; }
.fly-card__meta { margin: 2px 0 0; font-size: 0.78rem; color: var(--text-muted); }
.fly-card__status { min-height: 1.4em; margin: 0 0 10px; font-size: 0.9rem; color: var(--accent-bas); }
.fly-card__status--thinking::after {
  content: ''; display: inline-block; width: 1.2em; text-align: left;
  animation: fly-dots 1.2s steps(4, end) infinite;
}
.fly-card__note { margin: 10px 0 0; font-size: 0.72rem; color: var(--text-muted); }
.fly-team { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
.fly-team__slot { width: 44px; height: 44px; padding: 2px; }
.fly-team__slot img { width: 100%; height: 100%; object-fit: contain; image-rendering: pixelated; }

.fly-reveal--hidden { display: none; }

.fly-stats { margin: 12px 0; padding: 12px; border: 1px solid var(--border-soft); border-radius: 12px; background: var(--bg-panel-alt); }
.fly-stats__score { margin: 0 0 6px; font-family: var(--font-display); font-size: 1.15rem; letter-spacing: 0.04em; }
.fly-stats__humanity { color: var(--accent-bas); }
.fly-stats__fly { color: var(--accent-haut); }
.fly-stats__dash { color: var(--text-muted); }
.fly-stats__line { margin: 0 0 8px; font-size: 0.82rem; color: var(--text-muted); }
.fly-stats__caption { margin: 4px 0 0; font-size: 0.7rem; color: var(--text-muted); }
.fly-curve { display: block; width: 100%; max-width: 360px; height: 64px; }
.fly-curve__mid { stroke: var(--border); stroke-width: 1; stroke-dasharray: 3 3; }
.fly-curve__line { fill: none; stroke: var(--accent-haut); stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }

.fly-finished-scores { display: flex; gap: 12px; flex-wrap: wrap; margin: 12px 0; }
.fly-finished-scores .finished-stat { flex: 1 1 140px; }
.fly-turns { display: flex; flex-direction: column; gap: 6px; margin-bottom: 12px; }
.fly-turn {
  display: grid; grid-template-columns: 2.2em 1fr 1.6fr; gap: 8px; align-items: center;
  padding: 8px 10px; background: var(--bg-panel); border: 1px solid var(--border-soft); border-radius: 10px; font-size: 0.85rem;
}
.fly-turn__n { font-family: var(--font-mono); color: var(--text-muted); }
.fly-turn__side--fly { display: flex; align-items: center; gap: 4px; color: var(--accent-haut); }
.fly-turn__side--fly img { width: 32px; height: 32px; object-fit: contain; image-rendering: pixelated; }
.fly-learned { margin: 0 0 8px; color: var(--accent-bas); font-size: 0.9rem; }
@media (max-width: 520px) {
  .fly-turn { grid-template-columns: 2em 1fr; }
  .fly-turn__side--fly { grid-column: 1 / -1; }
}

@keyframes fly-buzz { 0%, 100% { transform: translate(0, 0) rotate(0); } 25% { transform: translate(2px, -2px) rotate(6deg); } 75% { transform: translate(-2px, 1px) rotate(-6deg); } }
@keyframes fly-dots { 0% { content: ''; } 25% { content: '.'; } 50% { content: '..'; } 75% { content: '...'; } }
@media (prefers-reduced-motion: reduce) { .fly-card__avatar, .fly-card__status--thinking::after { animation: none; } }
'''

out_html = html
for name, anchor, new in edits:
    n = out_html.count(anchor)
    if n != 1:
        sys.exit(f"ÉCHEC [{name}] : ancre trouvée {n} fois (attendu 1). Aucun fichier modifié.")
    out_html = out_html.replace(anchor, new)

shutil.copyfile(html_path, html_path + '.bak-fly')
shutil.copyfile(css_path, css_path + '.bak-fly')
open(html_path, 'w', encoding='utf-8').write(out_html)
open(css_path, 'w', encoding='utf-8').write(css.rstrip('\n') + CSS)
print(f"OK : {len(edits)} insertions dans index.html + bloc CSS ajouté à style.css")
for name, _, _ in edits:
    print('  -', name)
