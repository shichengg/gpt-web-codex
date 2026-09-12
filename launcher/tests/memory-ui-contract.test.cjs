'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');

test('memory UI uses the bounded memory bridge and explains privacy', async () => {
  const source = await fs.readFile(path.join(__dirname, '..', 'src', 'App.tsx'), 'utf8');
  assert.match(source, /window\.gptWebCodex\.listMemory\(\)/);
  assert.match(source, /window\.gptWebCodex\.saveMemory\(/);
  assert.match(source, /window\.gptWebCodex\.removeMemory\(/);
  assert.match(source, /不保存聊天内容、API Key 或 Cookie/);
});

test('MCP UI remains explicitly optional with an empty-state action', async () => {
  const source = await fs.readFile(path.join(__dirname, '..', 'src', 'App.tsx'), 'utf8');
  assert.match(source, /MCP 是可选项/);
  assert.match(source, /未配置 MCP/);
  assert.match(source, /servers\.length === 0/);
});
