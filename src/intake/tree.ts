import { createHash } from 'node:crypto';
import { constants, lstat, open, readdir } from 'node:fs/promises';
import path from 'node:path';
import { usageError } from '../errors.js';

export interface TreeEntry {
  path: string;
  mode: number;
  bytes: Uint8Array;
  sha256: `sha256:${string}`;
}

export interface ScannedTree {
  root: string;
  entries: TreeEntry[];
  directories: Array<{ path: string; mode: number }>;
  digest: `sha256:${string}`;
}

interface ScanOptions {
  requireSkillMd?: boolean;
  allowEmpty?: boolean;
  permitAgentDirectoryAtRoot?: boolean;
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function assertAllowedName(relativePath: string, permitAgentDirectoryAtRoot: boolean): void {
  const segments = relativePath.split('/');
  for (const [index, segment] of segments.entries()) {
    const lower = segment.toLowerCase();
    if (lower === '.git' || lower === 'agents.md' || (lower === '.agents' && !(permitAgentDirectoryAtRoot && index === 0))) {
      throw usageError(`Forbidden evaluation context entry: ${relativePath}`);
    }
  }
}

function validateMarkdownLinks(root: string, entry: TreeEntry): void {
  if (!entry.path.toLowerCase().endsWith('.md')) return;
  const text = Buffer.from(entry.bytes).toString('utf8');
  const inline = /!?\[[^\]]*\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+[^)]*)?\)/g;
  const definitions = /^\s*\[[^\]]+\]:\s*(?:<([^>]+)>|([^\s]+))/gm;
  const targets = [
    ...[...text.matchAll(inline)].map((match) => match[1] ?? match[2]),
    ...[...text.matchAll(definitions)].map((match) => match[1] ?? match[2]),
  ];
  for (const rawTarget of targets) {
    if (rawTarget === undefined || /^(?:[a-z][a-z0-9+.-]*:|#)/i.test(rawTarget)) continue;
    let target: string;
    try {
      target = decodeURIComponent(rawTarget.split('#', 1)[0] ?? '');
    } catch {
      throw usageError(`Malformed local Markdown reference in ${entry.path}`);
    }
    if (target.includes('\0')) throw usageError(`NUL in Markdown reference in ${entry.path}`);
    const resolved = path.resolve(root, path.dirname(entry.path), target.replaceAll('\\', '/'));
    if (!inside(root, resolved)) throw usageError(`Markdown reference escapes snapshot in ${entry.path}: ${rawTarget}`);
  }
}

async function readStableRegularFile(filePath: string, relativePath: string): Promise<TreeEntry> {
  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    throw usageError(`Cannot safely open ${relativePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) throw usageError(`Non-regular file rejected: ${relativePath}`);
    if (before.nlink !== 1n) throw usageError(`Hardlinked file rejected: ${relativePath}`);
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (
      before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
    ) {
      throw usageError(`File changed while being read: ${relativePath}`);
    }
    return {
      path: relativePath,
      mode: Number(before.mode & BigInt(0o777)),
      bytes,
      sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    };
  } finally {
    await handle.close();
  }
}

export async function scanTree(rootPath: string, options: ScanOptions = {}): Promise<ScannedTree> {
  const root = path.resolve(rootPath);
  let rootHandle;
  try {
    rootHandle = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  } catch (error) {
    throw usageError(`Cannot inspect directory ${root}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const rootStat = await rootHandle.stat({ bigint: true });
  await rootHandle.close();
  if (!rootStat.isDirectory()) throw usageError(`Expected a directory: ${root}`);

  const entries: TreeEntry[] = [];
  const directories: Array<{ path: string; mode: number }> = [];
  const caseFolded = new Set<string>();
  async function visit(directory: string): Promise<void> {
    const names = (await readdir(directory)).sort();
    for (const name of names) {
      const absolute = path.join(directory, name);
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      assertAllowedName(relative, options.permitAgentDirectoryAtRoot ?? false);
      const folded = relative.toLowerCase();
      if (caseFolded.has(folded)) throw usageError(`Case-insensitive path collision: ${relative}`);
      caseFolded.add(folded);
      const initialStat = await lstat(absolute, { bigint: true });
      if (initialStat.isSymbolicLink()) throw usageError(`Symlink entry rejected: ${relative}`);
      if (initialStat.isDirectory()) {
        const handle = await open(absolute, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW).catch((error: unknown) => {
          throw usageError(`Cannot safely open directory ${relative}: ${error instanceof Error ? error.message : String(error)}`);
        });
        const entryStat = await handle.stat({ bigint: true });
        await handle.close();
        if (!entryStat.isDirectory() || entryStat.dev !== initialStat.dev || entryStat.ino !== initialStat.ino) {
          throw usageError(`Directory changed while being inspected: ${relative}`);
        }
        directories.push({ path: relative, mode: Number(entryStat.mode & BigInt(0o777)) });
        await visit(absolute);
      } else if (initialStat.isFile()) {
        entries.push(await readStableRegularFile(absolute, relative));
      } else {
        throw usageError(`Special filesystem entry rejected: ${relative}`);
      }
    }
  }
  await visit(root);
  entries.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  directories.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  if (options.requireSkillMd && !entries.some((entry) => entry.path === 'SKILL.md')) {
    throw usageError('Skill directory must contain a regular SKILL.md at its root');
  }
  if (!options.allowEmpty && entries.length === 0 && directories.length === 0) throw usageError(`Directory is empty: ${root}`);
  for (const entry of entries) validateMarkdownLinks(root, entry);

  const hash = createHash('sha256');
  for (const directory of directories) {
    hash.update('D\0', 'ascii');
    hash.update(directory.path, 'utf8');
    hash.update(Uint8Array.of(0));
    hash.update(directory.mode.toString(8), 'ascii');
    hash.update(Uint8Array.of(0));
  }
  for (const entry of entries) {
    hash.update('F\0', 'ascii');
    hash.update(entry.path, 'utf8');
    hash.update(Uint8Array.of(0));
    hash.update(entry.mode.toString(8), 'ascii');
    hash.update(Uint8Array.of(0));
    hash.update(entry.bytes);
    hash.update(Uint8Array.of(0));
  }
  return { root, entries, directories, digest: `sha256:${hash.digest('hex')}` };
}

export async function assertPathHasNoSymlinkComponents(candidate: string): Promise<void> {
  const absolute = path.resolve(candidate);
  const root = path.parse(absolute).root;
  const relative = path.relative(root, absolute);
  let cursor = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    try {
      const details = await lstat(cursor);
      if (details.isSymbolicLink()) throw usageError(`Symlink component rejected: ${cursor}`);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') break;
      if (error instanceof Error && error.message.startsWith('Symlink component')) throw error;
      throw error;
    }
  }
}
