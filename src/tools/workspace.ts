import { constants } from 'node:fs';
import { lstat, open, opendir, stat } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import path from 'node:path';
import type { PathPolicy } from '../security/paths.js';

export const WORKSPACE_LIMITS = {
  maxBytes: 64 * 1024,
  maxEntries: 200,
  maxMatches: 100,
  maxSearchEntries: 200,
  maxSearchFiles: 200,
  maxSearchBytes: 512 * 1024,
  maxSearchMs: 1_000,
} as const;

export interface WorkspaceToolOptions {
  maxSearchEntries?: number;
  maxSearchFiles?: number;
  maxSearchBytes?: number;
  maxSearchMs?: number;
}

export interface WorkspaceInfo { root: string; exists: boolean; isDirectory: boolean; entries: number; }
export interface DirectoryEntry { name: string; type: 'file' | 'directory' | 'other'; }
export interface SearchMatch { path: string; line: number; column: number; snippet: string; }
export interface SearchResult {
  matches: SearchMatch[];
  truncated: boolean;
  scan: { entries: number; files: number; bytes: number; elapsedMs: number };
}
export interface BoundedText { text: string; truncated: boolean; }
export interface WorkspaceTools {
  info(): Promise<WorkspaceInfo>;
  listDirectory(relativePath: string): Promise<DirectoryEntry[]>;
  readFile(relativePath: string): Promise<BoundedText>;
  search(needle: string): Promise<SearchResult>;
}

/** Workspace reader with final-component no-follow and post-read identity revalidation. */
export function createWorkspaceTools(root: string, paths: PathPolicy, configured: WorkspaceToolOptions = {}): WorkspaceTools {
  void root;
  const resolve = (relativePath: string) => paths.resolve(relativePath);
  const limits = {
    maxSearchEntries: configured.maxSearchEntries ?? WORKSPACE_LIMITS.maxSearchEntries,
    maxSearchFiles: configured.maxSearchFiles ?? WORKSPACE_LIMITS.maxSearchFiles,
    maxSearchBytes: configured.maxSearchBytes ?? WORKSPACE_LIMITS.maxSearchBytes,
    maxSearchMs: configured.maxSearchMs ?? WORKSPACE_LIMITS.maxSearchMs,
  };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isFinite(value) || value < 1) throw new Error(`${name} must be a positive finite number`);
  }

  return {
    async info() {
      const rootPath = await resolve('.');
      const details = await stat(rootPath);
      return { root: rootPath, exists: true, isDirectory: details.isDirectory(), entries: details.isDirectory() ? await countEntries(rootPath) : 0 };
    },

    async listDirectory(relativePath) {
      const directoryPath = await resolve(relativePath);
      const initial = await lstat(directoryPath);
      if (!initial.isDirectory()) throw new Error('path is not a directory');
      const directory = await opendir(directoryPath);
      const result: DirectoryEntry[] = [];
      try {
        let entriesSeen = 0;
        for await (const entry of directory) {
          entriesSeen += 1;
          if (entriesSeen > WORKSPACE_LIMITS.maxEntries) break;
          const childRelative = path.join(relativePath, entry.name);
          try {
            const childPath = await resolve(childRelative);
            const childStats = await lstat(childPath);
            if (childStats.isSymbolicLink()) continue;
            result.push({ name: entry.name, type: childStats.isFile() ? 'file' : childStats.isDirectory() ? 'directory' : 'other' });
          } catch {
            // Entries rejected by the path policy are not disclosed.
          }
        }
      } finally {
        await directory.close().catch(() => undefined);
      }
      await revalidateDirectory(relativePath, initial, paths);
      return result;
    },

    async readFile(relativePath) {
      return (await readVerifiedText(relativePath, paths)).text;
    },

    async search(needle) {
      if (!needle) throw new Error('search needle must not be empty');
      const matches: SearchMatch[] = [];
      const scan = { entries: 0, files: 0, bytes: 0, elapsedMs: 0 };
      const startedAt = Date.now();
      let truncated = false;
      const outOfBudget = () => scan.entries >= limits.maxSearchEntries
        || scan.files >= limits.maxSearchFiles
        || scan.bytes >= limits.maxSearchBytes
        || Date.now() - startedAt >= limits.maxSearchMs
        || matches.length >= WORKSPACE_LIMITS.maxMatches;

      async function visit(relativeDirectory: string): Promise<void> {
        if (outOfBudget()) { truncated = true; return; }
        const directoryPath = await resolve(relativeDirectory);
        const initial = await lstat(directoryPath);
        if (!initial.isDirectory()) return;
        const directory = await opendir(directoryPath);
        try {
          for await (const entry of directory) {
            if (outOfBudget()) { truncated = true; return; }
            scan.entries += 1;
            const relativeEntry = path.join(relativeDirectory, entry.name);
            if (entry.isDirectory()) {
              if (!relativeEntry.split(path.sep).some((part) => part.toLowerCase().startsWith('.git'))) {
                try { await visit(relativeEntry); } catch { /* inaccessible or denied directories stay hidden */ }
              }
              continue;
            }
            if (!entry.isFile()) continue;
            try {
              const remainingBytes = limits.maxSearchBytes - scan.bytes;
              if (remainingBytes <= 0) { truncated = true; return; }
              const source = await readVerifiedText(relativeEntry, paths, Math.min(WORKSPACE_LIMITS.maxBytes, remainingBytes));
              scan.files += 1;
              scan.bytes += source.bytes;
              const lines = source.text.text.split(/\r?\n/);
              for (let index = 0; index < lines.length; index += 1) {
                const column = lines[index].indexOf(needle);
                if (column < 0) continue;
                matches.push({ path: relativeEntry, line: index + 1, column: column + 1, snippet: lines[index].slice(0, 500) });
                if (matches.length >= WORKSPACE_LIMITS.maxMatches) { truncated = true; return; }
              }
              if (source.text.truncated || outOfBudget()) truncated = true;
            } catch {
              // Sensitive, inaccessible, binary, or changing files are skipped.
            }
          }
        } finally {
          await directory.close().catch(() => undefined);
        }
        await revalidateDirectory(relativeDirectory, initial, paths);
      }

      await visit('.');
      scan.elapsedMs = Date.now() - startedAt;
      if (outOfBudget()) truncated = true;
      return { matches, truncated, scan };
    },
  };
}

async function readVerifiedText(relativePath: string, paths: PathPolicy, maxBytes = WORKSPACE_LIMITS.maxBytes): Promise<{ text: BoundedText; bytes: number }> {
  const filePath = await paths.resolve(relativePath);
  const initial = await lstat(filePath);
  if (!initial.isFile() || initial.isSymbolicLink()) throw new Error('path must be a regular file');
  const handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const contents = buffer.subarray(0, bytesRead);
    if (contents.includes(0)) throw new Error('binary files are not searchable or readable');
    const currentPath = await paths.resolve(relativePath);
    const [opened, current] = await Promise.all([handle.stat(), stat(currentPath)]);
    if (!sameFileIdentity(opened, current)) throw new Error('file changed while it was being read');
    return { text: { text: contents.toString('utf8'), truncated: opened.size > bytesRead }, bytes: bytesRead };
  } finally {
    await handle.close();
  }
}

async function revalidateDirectory(relativePath: string, initial: Stats, paths: PathPolicy): Promise<void> {
  const current = await stat(await paths.resolve(relativePath));
  if (!sameFileIdentity(initial, current)) throw new Error('directory changed while it was being listed');
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
  if (left.dev !== 0 && left.ino !== 0 && right.dev !== 0 && right.ino !== 0) return left.dev === right.dev && left.ino === right.ino;
  return left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

async function countEntries(directoryPath: string): Promise<number> {
  const directory = await opendir(directoryPath);
  try {
    let count = 0;
    for await (const _entry of directory) {
      count += 1;
      if (count >= WORKSPACE_LIMITS.maxEntries) return count;
    }
    return count;
  } finally {
    await directory.close().catch(() => undefined);
  }
}
