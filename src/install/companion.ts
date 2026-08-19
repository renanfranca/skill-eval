import { constants, chmod, lstat, mkdir, mkdtemp, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SkillEvalError, integrityError, messageOf } from '../errors.js';
import { writeCreateOnly } from '../evidence/persistence.js';
import { scanTree, type ScannedTree } from '../intake/tree.js';

const EXPECTED_DIRECTORIES = ['references'];
const EXPECTED_FILES = [
  'SKILL.md',
  'references/execution-and-interpretation.md',
  'references/instrument-design.md',
];

interface DirectoryIdentity {
  dev: bigint;
  ino: bigint;
  mode: number;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

interface InstallTree {
  tree: ScannedTree;
  rootMode: number;
}

export interface InstallCompanionOptions {
  cwd?: string;
  packageRoot?: string;
  testHooks?: {
    beforeSourceRecheck?: () => Promise<void>;
    beforePromotion?: () => Promise<void>;
  };
}

export interface InstallCompanionResult {
  destination: string;
  status: 'INSTALLED' | 'ALREADY_IDENTICAL';
}

function defaultPackageRoot(): string {
  return fileURLToPath(new URL('../../', import.meta.url));
}

function sameDirectoryIdentity(left: DirectoryIdentity, right: DirectoryIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

async function directoryIdentity(directory: string): Promise<DirectoryIdentity> {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const details = await handle.stat({ bigint: true });
    if (!details.isDirectory()) throw integrityError(`Expected a regular directory: ${directory}`);
    return {
      dev: details.dev,
      ino: details.ino,
      mode: Number(details.mode & BigInt(0o777)),
      mtimeNs: details.mtimeNs,
      ctimeNs: details.ctimeNs,
    };
  } finally {
    await handle.close();
  }
}

async function inspectInstallTree(root: string, description: string): Promise<InstallTree> {
  try {
    const before = await directoryIdentity(root);
    const tree = await scanTree(root, { requireSkillMd: true });
    const after = await directoryIdentity(root);
    if (!sameDirectoryIdentity(before, after)) {
      throw integrityError(`${description} changed while it was inspected`);
    }
    return { tree, rootMode: after.mode };
  } catch (error) {
    if (error instanceof SkillEvalError && error.exitCode === 4) throw error;
    throw integrityError(`${description} is missing or unsafe: ${messageOf(error)}`);
  }
}

function assertExpectedCompanionTree(source: InstallTree): void {
  const directories = source.tree.directories.map((entry) => entry.path);
  const files = source.tree.entries.map((entry) => entry.path);
  if (
    directories.join('\0') !== EXPECTED_DIRECTORIES.join('\0') ||
    files.join('\0') !== EXPECTED_FILES.join('\0')
  ) {
    throw integrityError('Packaged companion tree does not match the required minimal distribution');
  }
}

function treesAreIdentical(left: InstallTree, right: InstallTree): boolean {
  return left.rootMode === right.rootMode && left.tree.digest === right.tree.digest;
}

async function assertExistingDirectoryChain(directory: string, description: string): Promise<void> {
  const absolute = path.resolve(directory);
  const root = path.parse(absolute).root;
  let cursor = root;
  const rootDetails = await lstat(root);
  if (!rootDetails.isDirectory() || rootDetails.isSymbolicLink()) {
    throw integrityError(`${description} contains an unsafe filesystem root`);
  }
  for (const segment of path.relative(root, absolute).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    const details = await lstat(cursor).catch(() => undefined);
    if (details === undefined || !details.isDirectory() || details.isSymbolicLink()) {
      throw integrityError(`${description} contains a missing, symlink, or non-directory component: ${cursor}`);
    }
  }
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
  }
  const details = await lstat(directory);
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw integrityError(`Install path component must be a regular directory: ${directory}`);
  }
}

async function ensureInstallParents(cwd: string): Promise<string> {
  await assertExistingDirectoryChain(cwd, 'Current workspace');
  const agents = path.join(cwd, '.agents');
  const skills = path.join(agents, 'skills');
  await ensurePrivateDirectory(agents);
  await ensurePrivateDirectory(skills);
  return skills;
}

async function copyTreeToStaging(source: InstallTree, staging: string): Promise<void> {
  for (const directory of source.tree.directories) {
    await mkdir(path.join(staging, ...directory.path.split('/')), { recursive: true, mode: 0o700 });
  }
  for (const entry of source.tree.entries) {
    const target = path.join(staging, ...entry.path.split('/'));
    await writeCreateOnly(target, entry.bytes, entry.mode);
    await chmod(target, entry.mode);
  }
  const deepestFirst = [...source.tree.directories].sort((left, right) =>
    right.path.split('/').length - left.path.split('/').length
  );
  for (const directory of deepestFirst) {
    await chmod(path.join(staging, ...directory.path.split('/')), directory.mode);
  }
  await chmod(staging, source.rootMode);
}

async function cleanupStaging(staging: string | undefined, source: InstallTree | undefined): Promise<void> {
  if (staging === undefined) return;
  if (source !== undefined) {
    await chmod(staging, 0o700).catch(() => undefined);
    for (const directory of source.tree.directories) {
      await chmod(path.join(staging, ...directory.path.split('/')), 0o700).catch(() => undefined);
    }
  }
  await rm(staging, { recursive: true, force: true });
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await lstat(candidate);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}

export async function installCompanion(options: InstallCompanionOptions = {}): Promise<InstallCompanionResult> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const packageRoot = path.resolve(options.packageRoot ?? defaultPackageRoot());
  const sourcePath = path.join(packageRoot, 'skills', 'skill-eval');
  const destination = path.join(cwd, '.agents', 'skills', 'skill-eval');
  let staging: string | undefined;
  let source: InstallTree | undefined;
  try {
    await assertExistingDirectoryChain(sourcePath, 'Packaged companion source path');
    source = await inspectInstallTree(sourcePath, 'Packaged companion source');
    assertExpectedCompanionTree(source);
    const skillsParent = await ensureInstallParents(cwd);

    if (await pathExists(destination)) {
      const installed = await inspectInstallTree(destination, 'Installed companion destination');
      if (!treesAreIdentical(source, installed)) {
        throw integrityError(`Refusing to overwrite divergent companion installation: ${destination}`);
      }
      return { destination, status: 'ALREADY_IDENTICAL' };
    }

    staging = await mkdtemp(path.join(skillsParent, '.skill-eval-install-'));
    await chmod(staging, 0o700);
    await copyTreeToStaging(source, staging);
    const staged = await inspectInstallTree(staging, 'Staged companion installation');
    if (!treesAreIdentical(source, staged)) {
      throw integrityError('Staged companion installation does not exactly match the packaged source');
    }

    await options.testHooks?.beforeSourceRecheck?.();
    const recheckedSource = await inspectInstallTree(sourcePath, 'Packaged companion source');
    assertExpectedCompanionTree(recheckedSource);
    if (!treesAreIdentical(source, recheckedSource)) {
      throw integrityError('Packaged companion source changed before promotion');
    }

    await options.testHooks?.beforePromotion?.();
    if (await pathExists(destination)) {
      throw integrityError(`Refusing to overwrite companion path created during installation: ${destination}`);
    }
    await rename(staging, destination);
    staging = undefined;
    return { destination, status: 'INSTALLED' };
  } catch (error) {
    await cleanupStaging(staging, source);
    if (error instanceof SkillEvalError) throw error;
    throw integrityError(`Companion installation failed without changing the destination: ${messageOf(error)}`);
  }
}
