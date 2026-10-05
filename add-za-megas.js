#!/usr/bin/env node
'use strict';
// Ajoute les Méga Z-A (10278-10326) à data/pokemon-roster.json (idempotent), puis :
//   node fetch-stats.js --only=10278,...  (déjà fait : data/pokemon-stats.json fourni)
const fs = require('fs');
const path = require('path');
const ROSTER = path.join(__dirname, 'data', 'pokemon-roster.json');
const ADD = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'za-megas-roster.json'), 'utf8'));
const roster = JSON.parse(fs.readFileSync(ROSTER, 'utf8'));
const ids = new Set(roster.map(r => r.id));
const added = ADD.filter(r => !ids.has(r.id));
const out = [...roster, ...added].sort((a, b) => a.id - b.id);
fs.writeFileSync(`${ROSTER}.tmp`, JSON.stringify(out, null, 2));
fs.renameSync(`${ROSTER}.tmp`, ROSTER);
console.log(`+${added.length} Méga (${out.length} au roster).`);
