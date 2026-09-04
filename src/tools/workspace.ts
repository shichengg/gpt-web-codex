import { readFile, readdir, stat } from 'node:fs/promises';
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
        ? Math.min((await readdir(rootPath)).length, WORKSPACE_LIMITS.maxEntries)
        : 0;
      return { root: rootPath, exists: true, isDirectory: details.isDirectory(), entries };
    },

    async listDirectory(relativePath) {
      const directoryPath = await resolve(relativePath);
      const entries = await readdir(directoryPath, { withFileTypes: true });
      const result: DirectoryEntry[] = [];
      for (const entry of entries.slice(0, WORKSPACE_LIMITS.maxEntries)) {
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
      const contents = await readFile(filePath);
      return contents.subarray(0, WORKSPACE_LIMITS.maxBytes).toString('utf8');
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
        const entries = await readdir(directoryPath, { withFileTypes: true });
        for (const entry of entries.slice(0, WORKSPACE_LIMITS.maxEntries)) {
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
            const source = (await readFile(filePath)).subarray(0, WORKSPACE_LIMITS.maxBytes).toString('utf8');
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
