'use strict';

const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TASK_STATES = new Set(['queued', 'running', 'succeeded', 'failed', 'timed_out', 'cancelled']);
const RUNTIME_STATES = new Set(['stopped', 'starting', 'running', 'stopping', 'error']);
const DEFAULT_MAX_TEXT_LENGTH = 4_096;
const DEFAULT_MAX_LOG_ENTRIES = 64;

/**
 * A narrow adapter over a managed runtime. It has no generic call method:
 * callers can reach only the fixed task/activity operations below.
 */
class RuntimeClient {
  constructor(runtime, options = {}) {
    if (!runtime || typeof runtime.call !== 'function') {
      throw new TypeError('Runtime client requires a managed runtime call boundary');
    }
    this.runtime = runtime;
    this.maxTextLength = boundedOption(options.maxTextLength, DEFAULT_MAX_TEXT_LENGTH, 128, 16_384, 'maxTextLength');
    this.maxLogEntries = boundedOption(options.maxLogEntries, DEFAULT_MAX_LOG_ENTRIES, 1, 128, 'maxLogEntries');
  }

  async snapshot() {
    return sanitizeSnapshot(await this.runtime.call('runtime_snapshot', {}), this.maxTextLength);
  }

  async task(taskId) {
    const id = validateTaskId(taskId);
    const [status, output] = await Promise.all([
      this.runtime.call('codex_status', { taskId: id }),
      this.runtime.call('codex_output', { taskId: id }),
    ]);
    return sanitizeTask(id, status, output, this.maxTextLength);
  }

  async logs() {
    const response = await this.runtime.call('runtime_logs', { limit: this.maxLogEntries });
    const entries = response && typeof response === 'object' && Array.isArray(response.entries) ? response.entries : [];
    return entries
      .slice(0, this.maxLogEntries)
      .filter((entry) => typeof entry === 'string')
      .map((entry) => redactAndBound(entry, this.maxTextLength));
  }

  async cancel(taskId) {
    const id = validateTaskId(taskId);
    const response = await this.runtime.call('codex_cancel', { taskId: id });
    return sanitizeTask(id, response, undefined, this.maxTextLength);
  }
}

function boundedOption(value, fallback, minimum, maximum, name) {
  const selected = value === undefined ? fallback : value;
  if (!Number.isInteger(selected) || selected < minimum || selected > maximum) {
    throw new TypeError(`${name} must be a bounded integer`);
  }
  return selected;
}

function validateTaskId(value) {
  if (typeof value !== 'string' || !TASK_ID.test(value)) {
    throw new TypeError('task ID must be a bounded identifier');
  }
  return value;
}

function sanitizeSnapshot(value, maximumLength) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    state: RUNTIME_STATES.has(source.state) ? source.state : 'error',
    ...(typeof source.workspace === 'string' ? { workspace: redactAndBound(source.workspace, maximumLength) } : {}),
    ...(typeof source.message === 'string' ? { message: redactAndBound(source.message, maximumLength) } : {}),
  };
}

function sanitizeTask(id, status, output, maximumLength) {
  const statusRecord = status && typeof status === 'object' ? status : {};
  const outputRecord = output && typeof output === 'object' ? output : {};
  return {
    id,
    state: TASK_STATES.has(statusRecord.state) ? statusRecord.state : 'failed',
    ...(typeof statusRecord.error === 'string' ? { error: redactAndBound(statusRecord.error, maximumLength) } : {}),
    ...(typeof outputRecord.output === 'string' ? { output: redactAndBound(outputRecord.output, maximumLength) } : {}),
    ...(outputRecord.outputTruncated === true ? { outputTruncated: true } : {}),
  };
}

function redactAndBound(value, maximumLength) {
  const redacted = value
    .replace(/\b(token|api_key|password|access_token|client_secret)\s*=\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .replace(/(["'])(token|api_key|password|access_token|client_secret)\1\s*:\s*(["'])[^"']*\3/gi, '$1$2$1:[REDACTED]')
    .replace(/\bauthorization\s*:\s*bearer\s+[^\s,;]+/gi, 'Authorization: Bearer [REDACTED]');
  if (Buffer.byteLength(redacted, 'utf8') <= maximumLength) return redacted;
  const marker = Buffer.from('…', 'utf8');
  return `${decodeValidUtf8(Buffer.from(redacted, 'utf8'), maximumLength - marker.length)}…`;
}

function decodeValidUtf8(value, maximumBytes) {
  for (let length = Math.min(maximumBytes, value.length); length >= 0; length -= 1) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(value.subarray(0, length));
    } catch {
      // Back up over a partial multi-byte sequence.
    }
  }
  return '';
}

module.exports = { RuntimeClient, redactAndBound };
