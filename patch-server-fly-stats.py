#!/usr/bin/env python3
# Ajoute GET /api/fly/stats (stats publiques de la Mouche : jamais de poids) à server.js.
# PRÉREQUIS : patch-server-fly.py déjà appliqué (étape 3).   python3 patch-server-fly-stats.py [server.js]
import sys, shutil
path = sys.argv[1] if len(sys.argv) > 1 else 'server.js'
src = open(path, encoding='utf-8').read()
if "'/api/fly/stats'" in src:
    sys.exit('Déjà patché. Rien à faire.')
anchor = "registerFlyAdminRoutes(app, { store: flyBrain });\n"
if src.count(anchor) != 1:
    sys.exit(f"ÉCHEC : ancre trouvée {src.count(anchor)} fois (attendu 1). Applique d'abord patch-server-fly.py. Aucun fichier modifié.")
new = anchor + """app.get('/api/fly/stats', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(flyBrain.getPublicStats()); // nom, parties, victoires, nuls, taux, génération, derniers résultats : jamais de poids
});
"""
shutil.copyfile(path, path + '.bak-fly-stats')
open(path, 'w', encoding='utf-8').write(src.replace(anchor, new))
print('OK : route GET /api/fly/stats ajoutée')
