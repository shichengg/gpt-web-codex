import { realpath } from 'node:fs/promises';
import path from 'node:path';

export interface PathPolicy {
  resolve(relativePath: string): Promise<string>;
}

export interface PathPolicyOptions {
  /** Canonical directories which workspace tools must never disclose. */
  deniedRoots?: string[];
}

const SENSITIVE_NAMES = new Set(['.env', 'credentials']);
const SENSITIVE_EXTENSIONS = new Set(['.pem', '.key']);

/** Returns whether a workspace-relative path contains credential material or VCS metadata. */
export function isSensitivePath(relativePath: string): boolean {
  const parts = relativePath.replaceAll('\\', '/').split('/').filter(Boolean);
  return parts.some((part) => {
    const name = part.toLowerCase();
    return name === '.git'
      || name === '.env'
      || name.startsWith('.env.')
      || name.startsWith('credentials')
      || name.startsWith('token')
      || name.endsWith('.pem')
      || name.endsWith('.key');
  });
}

async function canonicalizeCandidate(candidate: string): Promise<string> {
  let current = candidate;
  const missingParts: string[] = [];

  while (true) {
    try {
      const canonicalCurrent = await realpath(current);
      return path.join(canonicalCurrent, ...missingParts.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }

      const parent = path.dirname(current);
      if (parent === current) {
        throw error;
      }
      missingParts.push(path.basename(current));
      current = parent;
    }
  }
}

export async function createPathPolicy(root: string, options: PathPolicyOptions = {}): Promise<PathPolicy> {
  const canonicalRoot = await realpath(root);
  const rootWithSeparator = canonicalRoot.endsWith(path.sep) ? canonicalRoot : `${canonicalRoot}${path.sep}`;
  const deniedRoots = await Promise.all((options.deniedRoots ?? []).map(async (deniedRoot) => canonicalizeCandidate(deniedRoot)));

  return {
    async resolve(relativePath: string): Promise<string> {
      if (typeof relativePath !== 'string' || relativePath.length === 0 || path.isAbsolute(relativePath)) {
        throw new Error('path must be a relative path');
      }

      if (isSensitivePath(relativePath)) {
        throw new Error('sensitive paths are not allowed');
      }

      const normalized = path.normalize(relativePath);
      if (normalized === '..' || normalized.startsWith(`..${path.sep}`)) {
        throw new Error('path resolves outside the allowed root');
      }

      const candidate = path.resolve(canonicalRoot, normalized);
      const canonicalCandidate = await canonicalizeCandidate(candidate);
      const relativeToRoot = path.relative(canonicalRoot, canonicalCandidate);
      if (relativeToRoot === '..' || relativeToRoot.startsWith(`..${path.sep}`) || !canonicalCandidate.startsWith(rootWithSeparator) && canonicalCandidate !== canonicalRoot) {
        throw new Error('path resolves outside the allowed root');
      }
      if (deniedRoots.some((deniedRoot) => isContainedBy(canonicalCandidate, deniedRoot))) {
        throw new Error('path resolves into a denied operational directory');
      }

      return canonicalCandidate;
    },
  };
}

function isContainedBy(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
