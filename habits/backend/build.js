#!/usr/bin/env node
/** Builds Code.gs from main.gs + engine.js. Run after editing either. */
const fs = require('fs');
const path = require('path');

const read = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');
const banner = [
  '/**',
  ' * Habit Builder — Google Apps Script backend.',
  ' *',
  ' * GENERATED FILE — do not edit directly.',
  ' * Edit backend/main.gs (Apps Script glue) or backend/engine.js (reward',
  ' * logic, unit-tested), then run:  node backend/build.js',
  ' * Deploy: paste this whole file into the Apps Script editor.',
  ' */',
  '',
  '',
].join('\n');

const out = banner + read('main.gs') + '\n' + read('engine.js');
fs.writeFileSync(path.join(__dirname, 'Code.gs'), out);
console.log('Wrote Code.gs (' + out.length + ' chars)');
