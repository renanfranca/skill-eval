import { chmod, constants, lstat, mkdtemp, open, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { usageError } from '../errors.js';
import { assertPathHasNoSymlinkComponents } from '../intake/tree.js';

export interface TemporaryCodexHome {
  path: string;
  cleanup(): Promise<void>;
}

export async function prepareTemporaryCodexHome(sourceHomeValue: string | undefined): Promise<TemporaryCodexHome> {
  if (sourceHomeValue === undefined || sourceHomeValue.trim() === '') {
    throw usageError('SKILL_EVAL_CODEX_HOME must point to a Codex home containing auth.json');
  }
  const sourceHome = path.resolve(sourceHomeValue);
  const sourceAuth = path.join(sourceHome, 'auth.json');
  await assertPathHasNoSymlinkComponents(sourceAuth);
  const homeStat = await lstat(sourceHome).catch(() => undefined);
  if (homeStat === undefined || !homeStat.isDirectory() || homeStat.isSymbolicLink()) {
    throw usageError('SKILL_EVAL_CODEX_HOME must be a regular non-symlink directory');
  }
  let authStat;
  try {
    authStat = await lstat(sourceAuth);
  } catch {
    throw usageError('SKILL_EVAL_CODEX_HOME does not contain a readable auth.json');
  }
  if (!authStat.isFile() || authStat.isSymbolicLink() || authStat.nlink !== 1) {
    throw usageError('auth.json must be a single regular non-symlink file');
  }
  const directory = await mkdtemp(path.join(os.tmpdir(), 'skill-eval-codex-home-'));
  await chmod(directory, 0o700);
  const destination = path.join(directory, 'auth.json');
  try {
    const sourceHandle = await open(sourceAuth, constants.O_RDONLY | constants.O_NOFOLLOW);
    const destinationHandle = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try {
      const before = await sourceHandle.stat({ bigint: true });
      if (!before.isFile() || before.nlink !== 1n) throw usageError('auth.json changed before it could be copied safely');
      const bytes = await sourceHandle.readFile();
      const after = await sourceHandle.stat({ bigint: true });
      if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs) {
        throw usageError('auth.json changed while it was copied');
      }
      await destinationHandle.writeFile(bytes);
      await destinationHandle.sync();
      bytes.fill(0);
    } finally {
      await sourceHandle.close();
      await destinationHandle.close();
    }
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return { path: directory, cleanup: async () => rm(directory, { recursive: true, force: true }) };
}
