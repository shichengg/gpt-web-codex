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
  outputTruncated: boolean;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TaskStoreOptions {
  maxOutputBytes?: number;
  maxPromptBytes?: number;
  maxSkillIdBytes?: number;
  maxSkillIds?: number;
  maxMetadataBytes?: number;
}

const DEFAULT_MAX_OUTPUT_BYTES = 128 * 1024;

export class TaskStore {
  private readonly maxOutputBytes: number;
  private readonly maxPromptBytes: number;
  private readonly maxSkillIdBytes: number;
  private readonly maxSkillIds: number;
  private readonly maxMetadataBytes: number;

  constructor(private readonly stateDir: string, options: TaskStoreOptions = {}) {
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    this.maxPromptBytes = options.maxPromptBytes ?? 256 * 1024;
    this.maxSkillIdBytes = options.maxSkillIdBytes ?? 64;
    this.maxSkillIds = options.maxSkillIds ?? 64;
    this.maxMetadataBytes = options.maxMetadataBytes ?? 512 * 1024;
    for (const [name, value] of Object.entries({
      maxOutputBytes: this.maxOutputBytes,
      maxPromptBytes: this.maxPromptBytes,
      maxSkillIdBytes: this.maxSkillIdBytes,
      maxSkillIds: this.maxSkillIds,
      maxMetadataBytes: this.maxMetadataBytes,
    })) {
      if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
    }
  }

  async create(request: TaskRequest): Promise<RunningTask> {
    if (!request.prompt.trim()) throw new Error('Task prompt must not be empty');
    if (Buffer.byteLength(request.prompt, 'utf8') > this.maxPromptBytes) throw new Error('Task prompt exceeds the configured byte limit');
    if (request.skillIds.length > this.maxSkillIds) throw new Error('Task skillIds exceeds the configured count limit');
    for (const id of request.skillIds) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id) || Buffer.byteLength(id, 'utf8') > this.maxSkillIdBytes) {
        throw new Error(`Task skill ID exceeds the configured format or byte limit: ${id}`);
      }
    }
    const metadata = JSON.stringify({ prompt: request.prompt, skillIds: request.skillIds });
    if (Buffer.byteLength(metadata, 'utf8') > this.maxMetadataBytes) throw new Error('Task metadata exceeds the configured byte limit');
    const now = new Date().toISOString();
    const task: RunningTask = {
      id: randomUUID(),
      prompt: request.prompt,
      skillIds: [...request.skillIds],
      state: 'queued',
      output: '',
      outputTruncated: false,
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
    const combined = Buffer.concat([Buffer.from(task.output, 'utf8'), Buffer.from(redact(output), 'utf8')]);
    task.outputTruncated ||= combined.length > this.maxOutputBytes;
    task.output = truncate(combined, this.maxOutputBytes);
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
  return value
    .replace(/\b(token|api_key|password)\s*=\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .replace(/(["'])(token|api_key|password)\1\s*:\s*(["'])[^"']*\3/gi, '$1$2$1:[REDACTED]')
    .replace(/\bauthorization\s*:\s*bearer\s+[^\s,;]+/gi, 'Authorization: Bearer [REDACTED]');
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
