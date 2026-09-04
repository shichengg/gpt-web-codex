import { constants } from 'node:fs';
import { lstat, open, readdir, stat } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import path from 'node:path';
import { createPathPolicy, type PathPolicy } from '../security/paths.js';

export interface SkillSummary {
  id: string;
  name: string;
  description: string;
}

export interface SkillDocument extends SkillSummary {
  content: string;
}

interface ParsedSkill extends SkillDocument {}

/** Read-only catalog of direct-child SKILL.md packages under one trusted root. */
export class SkillCatalog {
  private constructor(
    private readonly root: string,
    private readonly paths: PathPolicy,
  ) {}

  static async create(skillsRoot: string): Promise<SkillCatalog> {
    const paths = await createPathPolicy(skillsRoot);
    return new SkillCatalog(skillsRoot, paths);
  }

  async list(): Promise<SkillSummary[]> {
    const entries = await readdir(this.root, { withFileTypes: true });
    const skills: SkillSummary[] = [];

    for (const entry of entries) {
      // Do not follow directory symlinks. A package must be a direct child.
      if (!entry.isDirectory()) {
        continue;
      }

      const id = entry.name;
      try {
        const document = await this.readPackage(id);
        skills.push({ id: document.id, name: document.name, description: document.description });
      } catch {
        // Invalid or inaccessible packages are intentionally omitted from discovery.
      }
    }

    return skills.sort((left, right) => left.id.localeCompare(right.id));
  }

  async read(id: string): Promise<SkillDocument> {
    const known = await this.list();
    if (!known.some((skill) => skill.id === id)) {
      throw new Error(`Unknown skill: ${id}`);
    }

    try {
      return await this.readPackage(id);
    } catch {
      throw new Error(`Unknown skill: ${id}`);
    }
  }

  private async readPackage(id: string): Promise<ParsedSkill> {
    const relativePath = path.join(id, 'SKILL.md');
    const skillPath = await this.paths.resolve(relativePath);
    const source = await readSkillFile(skillPath, relativePath, this.paths);
    const metadata = parseFrontmatter(source);
    return {
      id,
      name: metadata.name,
      description: metadata.description,
      content: metadata.content,
    };
  }
}

/**
 * Open the already policy-checked file as a handle before reading it. On
 * platforms that support it, O_NOFOLLOW closes the final symlink race; the
 * lstat check also rejects static symlink packages on Windows.
 */
async function readSkillFile(skillPath: string, relativePath: string, paths: PathPolicy): Promise<string> {
  const fileInfo = await lstat(skillPath);
  if (!fileInfo.isFile()) {
    throw new Error('SKILL.md must be a regular file');
  }

  const noFollow = constants.O_NOFOLLOW ?? 0;
  const handle = await open(skillPath, constants.O_RDONLY | noFollow);
  try {
    const source = await handle.readFile('utf8');
    // Re-resolve after reading: a replaced parent may have pointed the request
    // outside the root while the already-open handle was still readable.
    const currentPath = await paths.resolve(relativePath);
    const [openedStats, currentStats] = await Promise.all([handle.stat(), stat(currentPath)]);
    if (!sameFileIdentity(openedStats, currentStats)) {
      throw new Error('SKILL.md changed while it was being read');
    }
    return source;
  } finally {
    await handle.close();
  }
}

/** Compare stable file identity when available, with metadata fallback on Windows. */
export function sameFileIdentity(opened: Stats, current: Stats): boolean {
  if (!opened.isFile() || !current.isFile()) {
    return false;
  }
  if (opened.dev !== 0 && opened.ino !== 0 && current.dev !== 0 && current.ino !== 0) {
    return opened.dev === current.dev && opened.ino === current.ino;
  }
  return opened.size === current.size
    && opened.mtimeMs === current.mtimeMs
    && opened.ctimeMs === current.ctimeMs;
}

interface Frontmatter {
  name: string;
  description: string;
  content: string;
}

function parseFrontmatter(source: string): Frontmatter {
  const normalized = source.replaceAll('\r\n', '\n');
  const lines = normalized.split('\n');
  if (lines[0] !== '---') {
    throw new Error('SKILL.md must begin with YAML frontmatter');
  }

  const end = lines.indexOf('---', 1);
  if (end < 0) {
    throw new Error('SKILL.md frontmatter is not closed');
  }

  const values = new Map<string, string>();
  for (const line of lines.slice(1, end)) {
    if (line.trim() === '') {
      continue;
    }
    const separator = line.indexOf(':');
    if (separator <= 0) {
      throw new Error('SKILL.md contains malformed frontmatter');
    }
    const key = line.slice(0, separator).trim();
    const rawValue = line.slice(separator + 1).trim();
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(key) || !rawValue || values.has(key)) {
      throw new Error('SKILL.md contains malformed frontmatter');
    }
    values.set(key, unquote(rawValue));
  }

  const name = values.get('name');
  const description = values.get('description');
  if (!name || !description) {
    throw new Error('SKILL.md requires name and description');
  }

  return {
    name,
    description,
    content: lines.slice(end + 1).join('\n').replace(/^\n/, ''),
  };
}

function unquote(value: string): string {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1);
  }
  return value;
}
