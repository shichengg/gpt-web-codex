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
  maxPromptBytes?: number;
  maxSkillIds?: number;
  maxSkillIdBytes?: number;
  maxMetadataBytes?: number;
}

/** Executes only the fixed Codex CLI contract for the configured workspace. */
export class CodexRunner {
  private readonly spawn: SpawnFunction;
  private readonly timeoutMs: number;

  constructor(private readonly options: CodexRunnerOptions) {
    this.spawn = options.spawn ?? nodeSpawn;
    this.timeoutMs = options.timeoutMs ?? 120_000;
    validateBound('timeoutMs', this.timeoutMs, 1, 120_000);
    validateBound('maxSkillContextBytes', options.maxSkillContextBytes ?? 64 * 1024, 1, 1024 * 1024);
    validateBound('maxPromptBytes', options.maxPromptBytes ?? 256 * 1024, 1, 1024 * 1024);
    validateBound('maxSkillIds', options.maxSkillIds ?? 64, 1, 256);
    validateBound('maxSkillIdBytes', options.maxSkillIdBytes ?? 64, 1, 64);
    validateBound('maxMetadataBytes', options.maxMetadataBytes ?? 512 * 1024, 1, 2 * 1024 * 1024);
  }

  async submit(request: CodexRequest, signal?: AbortSignal): Promise<RunningTask> {
    if (!request.prompt.trim()) throw new Error('Codex prompt must not be empty');
    if (Buffer.byteLength(request.prompt, 'utf8') > (this.options.maxPromptBytes ?? 256 * 1024)) {
      throw new Error('Codex prompt exceeds the configured byte limit');
    }
    if (request.skillIds.length > (this.options.maxSkillIds ?? 64)) {
      throw new Error('Codex skillIds exceeds the configured count limit');
    }
    for (const id of request.skillIds) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)
        || Buffer.byteLength(id, 'utf8') > (this.options.maxSkillIdBytes ?? 64)) {
        throw new Error(`Codex skill ID exceeds the configured format or byte limit: ${id}`);
      }
    }
    const metadata = JSON.stringify({ prompt: request.prompt, skillIds: request.skillIds });
    if (Buffer.byteLength(metadata, 'utf8') > (this.options.maxMetadataBytes ?? 512 * 1024)) {
      throw new Error('Codex request metadata exceeds the configured byte limit');
    }
    const skillContent = await this.loadSkills(request.skillIds);
    const task = await this.options.store.create(request);
    const prompt = assemblePrompt(request.prompt, skillContent, this.options.maxSkillContextBytes ?? 64 * 1024);
    await this.options.store.complete(task.id, 'running');

    let child: SpawnedChild;
    try {
      child = this.spawn('codex', ['exec', '--json', prompt], {
        cwd: this.options.workspaceRoot,
        shell: false,
      });
    } catch (error) {
      await this.options.store.complete(task.id, 'failed', error instanceof Error ? error.message : String(error));
      throw error;
    }
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

    const abort = () => {
      child.kill();
    };
    if (signal?.aborted) abort();
    signal?.addEventListener('abort', abort, { once: true });

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
      const cancel = () => {
        child.kill();
        finish('cancelled', 'Codex task cancelled');
        resolve('cancelled');
      };
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) cancel();
    });
    signal?.removeEventListener('abort', abort);
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

function validateBound(name: string, value: number, minimum: number, maximum: number): void {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be finite and between ${minimum} and ${maximum}`);
  }
}
