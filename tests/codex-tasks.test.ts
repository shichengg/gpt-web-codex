import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { TaskStore } from '../src/codex/tasks.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('TaskStore', () => {
  test('persists bounded status and redacts secret-shaped output', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'gpt-web-codex-tasks-'));
    roots.push(root);
    const store = new TaskStore(root, { maxOutputBytes: 32 });

    const task = await store.create({ prompt: 'test', skillIds: [] });
    await store.appendOutput(task.id, 'token=abc123 api_key=secret password=hunter2');

    await expect(store.get(task.id)).resolves.toMatchObject({
      id: task.id,
      state: 'queued',
      output: expect.not.stringContaining('abc123'),
    });
    await expect(readFile(path.join(root, `${task.id}.json`), 'utf8')).resolves.not.toContain('secret');
  });

  test('supports explicit lifecycle completion and rejects unknown tasks', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'gpt-web-codex-tasks-'));
    roots.push(root);
    const store = new TaskStore(root);
    const task = await store.create({ prompt: 'test', skillIds: [] });

    await store.complete(task.id, 'succeeded');

    await expect(store.get(task.id)).resolves.toMatchObject({ state: 'succeeded' });
    await expect(store.get('missing')).rejects.toThrow('Unknown task');
  });

  test('accumulates output chunks under a strict valid-UTF8 byte cap', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'gpt-web-codex-tasks-'));
    roots.push(root);
    const store = new TaskStore(root, { maxOutputBytes: 10 });
    const task = await store.create({ prompt: 'test', skillIds: [] });

    await store.appendOutput(task.id, '你好');
    await store.appendOutput(task.id, '世界abc');

    const output = (await store.get(task.id)).output;
    expect(output).toBe('你好…');
    expect(Buffer.byteLength(output, 'utf8')).toBeLessThanOrEqual(10);
    expect(output).not.toContain('�');
  });
});
