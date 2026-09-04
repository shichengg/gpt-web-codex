import { spawn as nodeSpawn } from 'node:child_process';
import { SkillCatalog } from '../skills/catalog.js';
import { TaskStore, type RunningTask } from './tasks.js';

export interface CodexRequest {
  prompt: string;
  skillIds: string[];
}

interface SpawnOptions {
  cwd: string;
  shell: false;
}

interface SpawnedChild {
  stdout?: { on(event: string, listener: (chunk: unknown) => void): unknown } | null;
  stderr?: { on(event: string, listener: (chunk: unknown) => void): unknown } | null;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  once(event: string, listener: (...args: unknown[]) => void): unknown;
  kill(): boolean;
}

type SpawnFunction = (command: string, args: string[], options: SpawnOptions) => SpawnedChild;

export interface CodexRunnerOptions {
  workspaceRoot: string;
  catalog: SkillCatalog;
  store: TaskStore;
  spawn?: SpawnFunction;
  timeoutMs?: number;
  maxSkillContextBytes?: number;
}

/** Executes only the fixed Codex CLI contract for the configured workspace. */
export class CodexRunner {
  private readonly spawn: SpawnFunction;
  private readonly timeoutMs: number;

  constructor(private readonly options: CodexRunnerOptions) {
    this.spawn = options.spawn ?? nodeSpawn;
    this.timeoutMs = options.timeoutMs ?? 120_000;
  }

  async submit(request: CodexRequest): Promise<RunningTask> {
    if (!request.prompt.trim()) throw new Error('Codex prompt must not be empty');
    const skillContent = await this.loadSkills(request.skillIds);
    const task = await this.options.store.create(request);
    const prompt = assemblePrompt(request.prompt, skillContent, this.options.maxSkillContextBytes ?? 64 * 1024);
    await this.options.store.complete(task.id, 'running');

    const child = this.spawn('codex', ['exec', '--json', prompt], {
      cwd: this.options.workspaceRoot,
      shell: false,
    });
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let outputWrites = Promise.resolve();
    let completionError: string | undefined;
    const finish = (state: 'succeeded' | 'failed' | 'timed_out' | 'cancelled', error?: string) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      completionError = error;
      return state;
    };
    const capture = (chunk: unknown) => {
      outputWrites = outputWrites.then(() => this.options.store.appendOutput(task.id, String(chunk))).then(() => undefined);
    };
    child.stdout?.on('data', capture);
    child.stderr?.on('data', capture);

    const result = await new Promise<'succeeded' | 'failed' | 'timed_out' | 'cancelled'>((resolve) => {
      timer = setTimeout(() => {
        child.kill();
        finish('timed_out', 'Codex task timed out');
        resolve('timed_out');
      }, this.timeoutMs);
      child.once('error', (error) => {
        finish('failed', error instanceof Error ? error.message : String(error));
        resolve('failed');
      });
      child.once('close', (code, signal) => {
        const state = signal === 'SIGTERM' ? 'cancelled' : code === 0 ? 'succeeded' : 'failed';
        finish(state, code === 0 ? undefined : `Codex exited with code ${code ?? 'unknown'}`);
        resolve(state);
      });
    });
    await outputWrites;
    return this.options.store.complete(task.id, result, completionError);
  }

  private async loadSkills(skillIds: string[]): Promise<string[]> {
    const uniqueIds = [...new Set(skillIds)];
    const documents = await Promise.all(uniqueIds.map((id) => this.options.catalog.read(id)));
    return documents.map((skill) => `--- SKILL: ${skill.id} ---\n${skill.content}\n--- END SKILL: ${skill.id} ---`);
  }
}

function assemblePrompt(prompt: string, skills: string[], maxSkillContextBytes: number): string {
  if (skills.length === 0) return prompt;
  const context = `${skills.join('\n')}\n[END SELECTED SKILLS]`;
  const bounded = Buffer.byteLength(context, 'utf8') <= maxSkillContextBytes
    ? context
    : `${Buffer.from(context, 'utf8').subarray(0, Math.max(0, maxSkillContextBytes - 15)).toString('utf8')}\n[TRUNCATED]`;
  return `${prompt}\n\n[SELECTED SKILLS]\n${bounded}`;
}
