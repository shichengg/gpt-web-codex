import { open, opendir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { PathPolicy } from '../security/paths.js';

export const WORKSPACE_LIMITS = {
  maxBytes: 64 * 1024,
  maxEntries: 200,
  maxMatches: 100,
} as const;

export interface WorkspaceInfo {
  root: string;
  exists: boolean;
  isDirectory: boolean;
  entries: number;
}

export interface DirectoryEntry {
  name: string;
  type: 'file' | 'directory' | 'other';
}

export interface SearchMatch {
  path: string;
  line: number;
  column: number;
  snippet: string;
}

export interface SearchResult {
  matches: SearchMatch[];
  truncated: boolean;
}

export interface BoundedText {
  text: string;
  truncated: boolean;
}

export interface WorkspaceTools {
  info(): Promise<WorkspaceInfo>;
  listDirectory(relativePath: string): Promise<DirectoryEntry[]>;
  readFile(relativePath: string): Promise<string>;
  search(needle: string): Promise<SearchResult>;
}

export function createWorkspaceTools(root: string, paths: PathPolicy): WorkspaceTools {
  void root;
  const resolve = (relativePath: string) => paths.resolve(relativePath);

  return {
    async info() {
      const rootPath = await resolve('.');
      const details = await stat(rootPath);
      const entries = details.isDirectory()
        ? await countEntries(rootPath)
        : 0;
      return { root: rootPath, exists: true, isDirectory: details.isDirectory(), entries };
    },

    async listDirectory(relativePath) {
      const directoryPath = await resolve(relativePath);
      const result: DirectoryEntry[] = [];
      const directory = await opendir(directoryPath);
      for await (const entry of directory) {
          if (result.length >= WORKSPACE_LIMITS.maxEntries) break;
        const childRelative = path.join(relativePath, entry.name);
        try {
          const childPath = await resolve(childRelative);
          const childStats = await stat(childPath);
          result.push({
            name: entry.name,
            type: childStats.isFile() ? 'file' : childStats.isDirectory() ? 'directory' : 'other',
          });
        } catch {
          // Entries rejected by the path policy are not disclosed.
          }
      }
      return result;
    },

    async readFile(relativePath) {
      const filePath = await resolve(relativePath);
      return (await readText(filePath)).text;
    },

    async search(needle) {
      if (!needle) {
        throw new Error('search needle must not be empty');
      }
      const matches: SearchMatch[] = [];
      let truncated = false;

      async function visit(relativeDirectory: string): Promise<void> {
        if (matches.length >= WORKSPACE_LIMITS.maxMatches) {
          truncated = true;
          return;
        }
        const directoryPath = await resolve(relativeDirectory);
        const directory = await opendir(directoryPath);
        let entriesSeen = 0;
        for await (const entry of directory) {
          entriesSeen += 1;
          if (entriesSeen > WORKSPACE_LIMITS.maxEntries) {
            truncated = true;
            break;
          }
          if (matches.length >= WORKSPACE_LIMITS.maxMatches) {
            truncated = true;
            return;
          }
          const relativeEntry = path.join(relativeDirectory, entry.name);
          if (entry.isDirectory()) {
            if (!relativeEntry.split(path.sep).some((part) => part.toLowerCase().startsWith('.git'))) {
              try {
                await visit(relativeEntry);
              } catch {
                // Sensitive or inaccessible directories are skipped.
              }
            }
            continue;
          }
          if (!entry.isFile()) continue;
          try {
            const filePath = await resolve(relativeEntry);
            const source = (await readText(filePath)).text;
            const lines = source.split(/\r?\n/);
            for (let index = 0; index < lines.length; index += 1) {
              const column = lines[index].indexOf(needle);
              if (column < 0) continue;
              matches.push({ path: relativeEntry, line: index + 1, column: column + 1, snippet: lines[index].slice(0, 500) });
              if (matches.length >= WORKSPACE_LIMITS.maxMatches) {
                truncated = true;
                return;
              }
            }
          } catch {
            // Sensitive, inaccessible, or changing files are skipped.
          }
        }
      }

      await visit('.');
      return { matches, truncated };
    },
  };
}

async function countEntries(directoryPath: string): Promise<number> {
  const directory = await opendir(directoryPath);
  let count = 0;
  for await (const _entry of directory) {
      count += 1;
      if (count >= WORKSPACE_LIMITS.maxEntries) return count;
  }
  return count;
}

async function readText(filePath: string): Promise<BoundedText> {
  const handle = await open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(WORKSPACE_LIMITS.maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const contents = buffer.subarray(0, bytesRead);
    if (contents.includes(0)) throw new Error('binary files are not searchable or readable');
    const details = await handle.stat();
    return { text: contents.toString('utf8'), truncated: details.size > bytesRead };
  } finally {
    await handle.close();
  }
}
