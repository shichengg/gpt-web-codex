'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('Tasks & Logs queries only the narrow task bridge and polls the selected task', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'App.tsx'), 'utf8');

  assert.match(source, /window\.gptWebCodex\.task\(taskId\.trim\(\)\)/);
  assert.match(source, /window\.gptWebCodex\.cancelTask\(taskId\.trim\(\)\)/);
  assert.match(source, /setInterval/);
  assert.doesNotMatch(source, /callTool\s*\(/);
  assert.doesNotMatch(source, /window\.gptWebCodex\.(?:runtime|runTask|listTasks)\s*\(/);
});

test('overview and deployment surfaces expose explicit lifecycle controls', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'App.tsx'), 'utf8');
  assert.match(source, /data-action=\"restart\"|重新部署/);
  assert.match(source, /data-action=\"refresh\"|重新检测/);
  assert.match(source, /保存并部署|saveDeploy/);
  assert.match(source, /运行测试|runBuild|verify_build/);
});
