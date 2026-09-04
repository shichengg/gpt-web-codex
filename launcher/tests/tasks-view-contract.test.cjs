'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('Tasks & Logs queries only the narrow task bridge and polls the selected task', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'App.tsx'), 'utf8');

  assert.match(source, /window\.gptWebCodex\.task\(taskId\.trim\(\)\)/);
  assert.match(source, /setInterval/);
  assert.doesNotMatch(source, /callTool\s*\(/);
});
