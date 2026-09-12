import { spawn as nodeSpawn } from 'node:child_process';
import { SkillCatalog } from '../skills/catalog.js';
import { TaskStore, type RunningTask } from './tasks.js';

export interface CodexRequest { prompt: string; skillIds: string[]; skillSelection?: 'auto' | 'explicit'; }
interface SpawnOptions { cwd: string; shell: false; }
interface SpawnedChild {
  stdout?: { on(event: string, listener: (chunk: unknown) => void): unknown } | null;
  stderr?: { on(event: string, listener: (chunk: unknown) => void): unknown } | null;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  once(event: string, listener: (...args: unknown[]) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}
type SpawnFunction = (command: string, args: string[], options: SpawnOptions) => SpawnedChild;

export interface CodexRunnerOptions {
  workspaceRoot: string;
  catalog: SkillCatalog;
  store: TaskStore;
  spawn?: SpawnFunction;
  timeoutMs?: number;
  cancelGraceMs?: number;
  maxSkillContextBytes?: number;
  maxPromptBytes?: number;
  maxSkillIds?: number;
  maxSkillIdBytes?: number;
  maxMetadataBytes?: number;
}

type TerminalState = 'succeeded' | 'failed' | 'timed_out' | 'cancelled';
interface Execution { child: SpawnedChild; done: Promise<RunningTask>; cancel: (state: TerminalState, error: string) => Promise<RunningTask>; }

/** Runs a fixed `codex exec --json` contract and persists task progress for polling. */
export class CodexRunner {
  private readonly spawn: SpawnFunction;
  private readonly timeoutMs: number;
  private readonly cancelGraceMs: number;
  private readonly executions = new Map<string, Execution>();
  private readonly submissions = new Set<Promise<RunningTask>>();
  private closing = false;
  private closePromise: Promise<void> | undefined;

  constructor(private readonly options: CodexRunnerOptions) {
    this.spawn = options.spawn ?? nodeSpawn;
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.cancelGraceMs = options.cancelGraceMs ?? 5_000;
    validateBound('timeoutMs', this.timeoutMs, 1, 120_000);
    validateBound('cancelGraceMs', this.cancelGraceMs, 1, 30_000);
    validateBound('maxSkillContextBytes', options.maxSkillContextBytes ?? 64 * 1024, 1, 1024 * 1024);
    validateBound('maxPromptBytes', options.maxPromptBytes ?? 256 * 1024, 1, 1024 * 1024);
    validateBound('maxSkillIds', options.maxSkillIds ?? 64, 1, 256);
    validateBound('maxSkillIdBytes', options.maxSkillIdBytes ?? 64, 1, 64);
    validateBound('maxMetadataBytes', options.maxMetadataBytes ?? 512 * 1024, 1, 2 * 1024 * 1024);
  }

  async submit(request: CodexRequest, signal?: AbortSignal): Promise<RunningTask> {
    if (this.closing) throw new Error('Codex runner is closing');
    const submission = this.submitWhenOpen(request, signal);
    this.submissions.add(submission);
    try {
      return await submission;
    } finally {
      this.submissions.delete(submission);
    }
  }

  private async submitWhenOpen(request: CodexRequest, signal?: AbortSignal): Promise<RunningTask> {
    validateRequest(request, this.options);
    const skillContent = await this.loadSkills(request.skillIds, request.skillSelection ?? 'explicit');
    if (this.closing) throw new Error('Codex runner is closing');
    const task = await this.options.store.create(request);
    if (this.closing) return this.options.store.complete(task.id, 'cancelled', 'Connector is shutting down');
    const running = await this.options.store.complete(task.id, 'running');
    if (this.closing) return this.options.store.complete(task.id, 'cancelled', 'Connector is shutting down');
    const prompt = assemblePrompt(request.prompt, skillContent, this.options.maxSkillContextBytes ?? 64 * 1024, request.skillSelection ?? 'explicit');
    let child: SpawnedChild;
    try {
      child = this.spawn('codex', ['exec', '--json', prompt], { cwd: this.options.workspaceRoot, shell: false });
    } catch (error) {
      return this.options.store.complete(task.id, 'failed', messageOf(error));
    }
    const execution = this.manage(task.id, child);
    this.executions.set(task.id, execution);
    if (signal?.aborted) void execution.cancel('cancelled', 'Codex task cancelled');
    else signal?.addEventListener('abort', () => { void execution.cancel('cancelled', 'Codex task cancelled'); }, { once: true });
    // Do not await execution.done: ChatGPT receives the ID while Codex runs.
    return running;
  }

  async cancel(id: string): Promise<RunningTask> {
    const execution = this.executions.get(id);
    if (!execution) return this.options.store.get(id);
    return execution.cancel('cancelled', 'Codex task cancelled');
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = this.drain();
    return this.closePromise;
  }

  private async drain(): Promise<void> {
    while (this.submissions.size > 0 || this.executions.size > 0) {
      await Promise.allSettled([...this.submissions]);
      await Promise.allSettled([...this.executions.values()].map((execution) => execution.cancel('cancelled', 'Connector is shutting down')));
    }
  }

  private manage(id: string, child: SpawnedChild): Execution {
    let outputWrites = Promise.resolve();
    let terminal: TerminalState | undefined;
    let terminalError: string | undefined;
    let timer: NodeJS.Timeout | undefined;
    let escalation: NodeJS.Timeout | undefined;
    let settled = false;
    let resolveDone!: (task: RunningTask) => void;
    const done = new Promise<RunningTask>((resolve) => { resolveDone = resolve; });
    const capture = (chunk: unknown) => {
      outputWrites = outputWrites.then(() => this.options.store.appendOutput(id, String(chunk))).then(() => undefined);
    };
    const finishAfterExit = async (state: TerminalState, error?: string) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (escalation) clearTimeout(escalation);
      await outputWrites;
      const completed = await this.options.store.complete(id, state, error);
      this.executions.delete(id);
      resolveDone(completed);
    };
    const requestStop = async (state: TerminalState, error: string): Promise<RunningTask> => {
      if (!terminal) {
        terminal = state;
        terminalError = error;
        child.kill('SIGTERM');
        escalation = setTimeout(() => child.kill('SIGKILL'), this.cancelGraceMs);
      }
      return done;
    };
    child.stdout?.on('data', capture);
    child.stderr?.on('data', capture);
    child.once('error', (error) => { void finishAfterExit('failed', messageOf(error)); });
    child.once('close', (code, closeSignal) => {
      const state = terminal ?? (code === 0 ? 'succeeded' : closeSignal ? 'cancelled' : 'failed');
      const error = terminalError ?? (state === 'failed' ? `Codex exited with code ${String(code ?? 'unknown')}` : undefined);
      void finishAfterExit(state, error);
    });
    timer = setTimeout(() => { void requestStop('timed_out', 'Codex task timed out'); }, this.timeoutMs);
    return { child, done, cancel: requestStop };
  }

  private async loadSkills(skillIds: string[], selection: 'auto' | 'explicit'): Promise<string[]> {
    const uniqueIds = [...new Set(skillIds)];
    if (selection === 'auto') {
      const catalog = await this.options.catalog.list();
      const knownIds = new Set(catalog.map((skill) => skill.id));
      const unknown = uniqueIds.find((id) => !knownIds.has(id));
      if (unknown) throw new Error(`Unknown skill: ${unknown}`);
      const selected = new Set(uniqueIds);
      return catalog.filter((skill) => selected.has(skill.id)).map((skill) =>
        `- ${skill.id}: ${skill.name}\n  description: ${skill.description}`,
      );
    }
    const documents = await Promise.all(uniqueIds.map((id) => this.options.catalog.read(id)));
    return documents.map((skill) => `--- SKILL: ${skill.id} ---\n${skill.content}\n--- END SKILL: ${skill.id} ---`);
  }
}

function validateRequest(request: CodexRequest, options: CodexRunnerOptions): void {
  if (!request.prompt.trim()) throw new Error('Codex prompt must not be empty');
  if (Buffer.byteLength(request.prompt, 'utf8') > (options.maxPromptBytes ?? 256 * 1024)) throw new Error('Codex prompt exceeds the configured byte limit');
  if (request.skillIds.length > (options.maxSkillIds ?? 64)) throw new Error('Codex skillIds exceeds the configured count limit');
  for (const id of request.skillIds) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id) || Buffer.byteLength(id, 'utf8') > (options.maxSkillIdBytes ?? 64)) {
      throw new Error(`Codex skill ID exceeds the configured format or byte limit: ${id}`);
    }
  }
  if (Buffer.byteLength(JSON.stringify(request), 'utf8') > (options.maxMetadataBytes ?? 512 * 1024)) throw new Error('Codex request metadata exceeds the configured byte limit');
}

function assemblePrompt(prompt: string, skills: string[], maxSkillContextBytes: number, selection: 'auto' | 'explicit'): string {
  if (skills.length === 0) return prompt;
  const context = `${skills.join('\n')}\n[END SELECTED SKILLS]`;
  const bounded = Buffer.byteLength(context, 'utf8') <= maxSkillContextBytes ? context : `${Buffer.from(context, 'utf8').subarray(0, Math.max(0, maxSkillContextBytes - 15)).toString('utf8')}\n[TRUNCATED]`;
  const heading = selection === 'auto'
    ? '[AVAILABLE SKILLS - read the Skill instructions only when the task requires it]'
    : '[SELECTED SKILLS]';
  return `${prompt}\n\n${heading}\n${bounded}`;
}

function validateBound(name: string, value: number, minimum: number, maximum: number): void {
  if (!Number.isFinite(value) || value < minimum || value > maximum) throw new Error(`${name} must be finite and between ${minimum} and ${maximum}`);
}

function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }
