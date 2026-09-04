import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type TaskState = 'queued' | 'running' | 'succeeded' | 'failed' | 'timed_out' | 'cancelled';

export interface TaskRequest {
  prompt: string;
  skillIds: string[];
}

export interface RunningTask extends TaskRequest {
  id: string;
  state: TaskState;
  output: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TaskStoreOptions {
  maxOutputBytes?: number;
}

const DEFAULT_MAX_OUTPUT_BYTES = 128 * 1024;

export class TaskStore {
  private readonly maxOutputBytes: number;

  constructor(private readonly stateDir: string, options: TaskStoreOptions = {}) {
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    if (!Number.isInteger(this.maxOutputBytes) || this.maxOutputBytes < 1) {
      throw new Error('maxOutputBytes must be a positive integer');
    }
  }

  async create(request: TaskRequest): Promise<RunningTask> {
    if (!request.prompt.trim()) throw new Error('Task prompt must not be empty');
    const now = new Date().toISOString();
    const task: RunningTask = {
      id: randomUUID(),
      prompt: request.prompt,
      skillIds: [...request.skillIds],
      state: 'queued',
      output: '',
      createdAt: now,
      updatedAt: now,
    };
    await this.persist(task);
    return task;
  }

  async get(id: string): Promise<RunningTask> {
    try {
      const source = await readFile(this.filePath(id), 'utf8');
      return JSON.parse(source) as RunningTask;
    } catch (error) {
      throw new Error(`Unknown task: ${id}`, { cause: error });
    }
  }

  async appendOutput(id: string, output: string): Promise<RunningTask> {
    const task = await this.get(id);
    task.output = truncate(Buffer.concat([Buffer.from(task.output, 'utf8'), Buffer.from(redact(output), 'utf8')]), this.maxOutputBytes);
    task.updatedAt = new Date().toISOString();
    await this.persist(task);
    return task;
  }

  async complete(id: string, state: Exclude<TaskState, 'queued'>, error?: string): Promise<RunningTask> {
    const task = await this.get(id);
    task.state = state;
    if (error) task.error = redact(error);
    task.updatedAt = new Date().toISOString();
    await this.persist(task);
    return task;
  }

  private async persist(task: RunningTask): Promise<void> {
    await mkdir(this.stateDir, { recursive: true });
    const target = this.filePath(task.id);
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(task)}\n`, { encoding: 'utf8', flag: 'wx' });
    await rename(temporary, target);
  }

  private filePath(id: string): string {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error(`Unknown task: ${id}`);
    return path.join(this.stateDir, `${id}.json`);
  }
}

function redact(value: string): string {
  return value.replace(/\b(token|api_key|password)\s*=\s*[^\s,;]+/gi, '$1=[REDACTED]');
}

function truncate(value: Buffer, maxBytes: number): string {
  if (value.length <= maxBytes) return value.toString('utf8');
  const marker = Buffer.from('…', 'utf8');
  if (maxBytes < marker.length) return decodeValidUtf8(value, maxBytes);
  return `${decodeValidUtf8(value, maxBytes - marker.length)}…`;
}

function decodeValidUtf8(value: Buffer, maxBytes: number): string {
  for (let length = Math.min(maxBytes, value.length); length >= 0; length -= 1) {
    try {
      const decoder = new TextDecoder('utf-8', { fatal: true });
      return decoder.decode(value.subarray(0, length));
    } catch {
      // Back up over a partial multi-byte sequence.
    }
  }
  return '';
}
