import { execFile } from 'node:child_process';
import {
  access,
  chmod,
  cp,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli.js';
import { installCompanion } from '../src/install/companion.js';

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, '..');
const packagedSkill = path.join(repositoryRoot, 'skills', 'skill-eval');

interface SnapshotEntry {
  path: string;
  kind: 'directory' | 'file' | 'symlink' | 'special';
  mode: number;
  mtimeNs?: string;
  nlink?: number;
  bytes?: string;
  target?: string;
}

async function snapshot(root: string, includeTimestamps = false): Promise<SnapshotEntry[]> {
  const result: SnapshotEntry[] = [];
  async function visit(absolute: string, relative: string): Promise<void> {
    const details = await lstat(absolute, { bigint: true });
    const common = {
      path: relative,
      mode: Number(details.mode & BigInt(0o777)),
      ...(includeTimestamps ? { mtimeNs: details.mtimeNs.toString() } : {}),
    };
    if (details.isDirectory()) {
      result.push({ ...common, kind: 'directory' });
      for (const name of (await readdir(absolute)).sort()) {
        await visit(path.join(absolute, name), relative === '' ? name : `${relative}/${name}`);
      }
    } else if (details.isFile()) {
      result.push({
        ...common,
        kind: 'file',
        nlink: Number(details.nlink),
        bytes: (await readFile(absolute)).toString('hex'),
      });
    } else if (details.isSymbolicLink()) {
      result.push({ ...common, kind: 'symlink', target: await readlink(absolute) });
    } else {
      result.push({ ...common, kind: 'special' });
    }
  }
  await visit(root, '');
  return result;
}

async function makeWorkspace(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

async function makePackageFixture(): Promise<{ root: string; source: string }> {
  const root = await makeWorkspace('skill-eval-install-package-');
  const source = path.join(root, 'skills', 'skill-eval');
  await mkdir(path.dirname(source), { recursive: true });
  await cp(packagedSkill, source, { recursive: true, preserveTimestamps: true });
  return { root, source };
}

async function expectNoPartialInstall(workspace: string): Promise<void> {
  const skills = path.join(workspace, '.agents', 'skills');
  await expect(access(path.join(skills, 'skill-eval'))).rejects.toThrow();
  if (await access(skills).then(() => true, () => false)) {
    expect((await readdir(skills)).filter((name) => name.startsWith('.skill-eval-install-'))).toEqual([]);
  }
}

describe('provider-free local companion installation', () => {
  it('installs through the public CLI into a temporary current project and explains discovery', async () => {
    const workspace = await makeWorkspace('skill-eval-install-cli-');
    const previous = process.cwd();
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    process.chdir(workspace);
    try {
      await expect(main(['install', '--skills'])).resolves.toBe(0);
      expect(write.mock.calls.map(([value]) => String(value)).join('')).toMatch(/Installed .*\.agents\/skills\/skill-eval[\s\S]*new Codex task[\s\S]*does not activate/i);
      expect(await snapshot(path.join(workspace, '.agents', 'skills', 'skill-eval'))).toEqual(await snapshot(packagedSkill));
    } finally {
      process.chdir(previous);
      write.mockRestore();
    }
  });

  it('preserves the complete tree, bytes, and modes and changes only the minimum local path', async () => {
    const workspace = await makeWorkspace('skill-eval-install-new-');
    const fixture = await makePackageFixture();
    await chmod(fixture.source, 0o751);
    await chmod(path.join(fixture.source, 'SKILL.md'), 0o640);
    await chmod(path.join(fixture.source, 'references'), 0o711);
    await writeFile(path.join(workspace, 'sentinel.txt'), 'preserve');

    const result = await installCompanion({ cwd: workspace, packageRoot: fixture.root });

    expect(result).toEqual({
      destination: path.join(workspace, '.agents', 'skills', 'skill-eval'),
      status: 'INSTALLED',
    });
    expect(await snapshot(result.destination)).toEqual(await snapshot(fixture.source));
    expect((await readdir(workspace)).sort()).toEqual(['.agents', 'sentinel.txt']);
    expect(await readdir(path.join(workspace, '.agents'))).toEqual(['skills']);
    expect(await readdir(path.join(workspace, '.agents', 'skills'))).toEqual(['skill-eval']);
    expect(await readFile(path.join(workspace, 'sentinel.txt'), 'utf8')).toBe('preserve');
  });

  it('returns a timestamp-preserving no-op for an already identical installation', async () => {
    const workspace = await makeWorkspace('skill-eval-install-noop-');
    const first = await installCompanion({ cwd: workspace, packageRoot: repositoryRoot });
    const before = await snapshot(first.destination, true);

    const second = await installCompanion({ cwd: workspace, packageRoot: repositoryRoot });

    expect(second.status).toBe('ALREADY_IDENTICAL');
    expect(await snapshot(first.destination, true)).toEqual(before);
  });

  it.each([
    ['modified bytes', async (destination: string) => writeFile(path.join(destination, 'SKILL.md'), 'divergent bytes')],
    ['extra file', async (destination: string) => writeFile(path.join(destination, 'extra.txt'), 'extra')],
    ['symlink', async (destination: string) => symlink('SKILL.md', path.join(destination, 'linked.md'))],
  ])('refuses a destination with %s without mutating it', async (_label, mutate) => {
    const workspace = await makeWorkspace('skill-eval-install-divergent-');
    const installed = await installCompanion({ cwd: workspace, packageRoot: repositoryRoot });
    await mutate(installed.destination);
    const before = await snapshot(installed.destination, true);

    await expect(installCompanion({ cwd: workspace, packageRoot: repositoryRoot })).rejects.toMatchObject({ exitCode: 4 });

    expect(await snapshot(installed.destination, true)).toEqual(before);
  });

  it.runIf(process.platform !== 'win32')('refuses a destination with a different mode without mutation', async () => {
    const workspace = await makeWorkspace('skill-eval-install-mode-');
    const installed = await installCompanion({ cwd: workspace, packageRoot: repositoryRoot });
    const skillMd = path.join(installed.destination, 'SKILL.md');
    await chmod(skillMd, ((await lstat(skillMd)).mode & 0o777) ^ 0o100);
    const before = await snapshot(installed.destination, true);
    await expect(installCompanion({ cwd: workspace, packageRoot: repositoryRoot })).rejects.toMatchObject({ exitCode: 4 });
    expect(await snapshot(installed.destination, true)).toEqual(before);
  });

  it.runIf(process.platform !== 'win32')('refuses hardlinks and special files in the destination without mutation', async () => {
    for (const kind of ['hardlink', 'fifo'] as const) {
      const workspace = await makeWorkspace(`skill-eval-install-${kind}-`);
      const installed = await installCompanion({ cwd: workspace, packageRoot: repositoryRoot });
      if (kind === 'hardlink') {
        await link(path.join(installed.destination, 'SKILL.md'), path.join(installed.destination, 'hardlink.md'));
      } else {
        await execFileAsync('mkfifo', [path.join(installed.destination, 'special.fifo')]);
      }
      const before = await snapshot(installed.destination, true);
      await expect(installCompanion({ cwd: workspace, packageRoot: repositoryRoot })).rejects.toMatchObject({ exitCode: 4 });
      expect(await snapshot(installed.destination, true)).toEqual(before);
    }
  });

  it('rejects symlink and non-directory path components without touching their targets', async () => {
    const linkedWorkspace = await makeWorkspace('skill-eval-install-linked-parent-');
    const outside = await makeWorkspace('skill-eval-install-outside-');
    await writeFile(path.join(outside, 'sentinel.txt'), 'outside');
    await symlink(outside, path.join(linkedWorkspace, '.agents'));
    await expect(installCompanion({ cwd: linkedWorkspace, packageRoot: repositoryRoot })).rejects.toMatchObject({ exitCode: 4 });
    expect(await readFile(path.join(outside, 'sentinel.txt'), 'utf8')).toBe('outside');
    expect(await readdir(outside)).toEqual(['sentinel.txt']);

    const fileWorkspace = await makeWorkspace('skill-eval-install-file-parent-');
    await mkdir(path.join(fileWorkspace, '.agents'));
    await writeFile(path.join(fileWorkspace, '.agents', 'skills'), 'not a directory');
    await expect(installCompanion({ cwd: fileWorkspace, packageRoot: repositoryRoot })).rejects.toMatchObject({ exitCode: 4 });
    expect(await readFile(path.join(fileWorkspace, '.agents', 'skills'), 'utf8')).toBe('not a directory');
  });

  it.runIf(process.platform !== 'win32')('rejects unsafe packaged symlinks, hardlinks, and special files without a partial destination', async () => {
    for (const kind of ['symlink', 'hardlink', 'fifo'] as const) {
      const fixture = await makePackageFixture();
      const workspace = await makeWorkspace(`skill-eval-install-unsafe-source-${kind}-`);
      if (kind === 'symlink') {
        await symlink('SKILL.md', path.join(fixture.source, 'unsafe-link.md'));
      } else if (kind === 'hardlink') {
        await link(path.join(fixture.source, 'SKILL.md'), path.join(fixture.source, 'unsafe-hardlink.md'));
      } else {
        await execFileAsync('mkfifo', [path.join(fixture.source, 'unsafe.fifo')]);
      }
      await expect(installCompanion({ cwd: workspace, packageRoot: fixture.root })).rejects.toMatchObject({ exitCode: 4 });
      await expect(access(path.join(workspace, '.agents'))).rejects.toThrow();
    }
  });

  it('rejects a symlink component above the packaged source tree', async () => {
    const fixture = await makePackageFixture();
    const packageRoot = await makeWorkspace('skill-eval-install-linked-source-root-');
    const workspace = await makeWorkspace('skill-eval-install-linked-source-workspace-');
    await symlink(path.join(fixture.root, 'skills'), path.join(packageRoot, 'skills'));

    await expect(installCompanion({ cwd: workspace, packageRoot })).rejects.toMatchObject({ exitCode: 4 });

    await expect(access(path.join(workspace, '.agents'))).rejects.toThrow();
  });

  it('rejects a packaged source changed before promotion and cleans its private staging', async () => {
    const fixture = await makePackageFixture();
    const workspace = await makeWorkspace('skill-eval-install-source-race-');
    await expect(installCompanion({
      cwd: workspace,
      packageRoot: fixture.root,
      testHooks: {
        beforeSourceRecheck: async () => {
          await writeFile(path.join(fixture.source, 'SKILL.md'), 'changed after the first stable read');
        },
      },
    })).rejects.toMatchObject({ exitCode: 4 });
    await expectNoPartialInstall(workspace);
  });

  it('cleans staging on pre-promotion failure and preserves all preexisting project content', async () => {
    const workspace = await makeWorkspace('skill-eval-install-promotion-failure-');
    await mkdir(path.join(workspace, '.agents', 'skills'), { recursive: true });
    await writeFile(path.join(workspace, '.agents', 'sentinel.txt'), 'preserve agents content');
    await writeFile(path.join(workspace, 'root-sentinel.txt'), 'preserve root content');

    await expect(installCompanion({
      cwd: workspace,
      packageRoot: repositoryRoot,
      testHooks: { beforePromotion: () => Promise.reject(new Error('deterministic promotion failure')) },
    })).rejects.toMatchObject({ exitCode: 4 });

    await expectNoPartialInstall(workspace);
    expect(await readFile(path.join(workspace, '.agents', 'sentinel.txt'), 'utf8')).toBe('preserve agents content');
    expect(await readFile(path.join(workspace, 'root-sentinel.txt'), 'utf8')).toBe('preserve root content');
  });

  it.each([
    { label: 'empty', sentinel: null },
    { label: 'non-empty', sentinel: 'concurrent owner data' },
  ])('refuses and preserves a $label destination created before the final recheck', async ({ sentinel }) => {
    const workspace = await makeWorkspace('skill-eval-install-concurrent-');
    const destination = path.join(workspace, '.agents', 'skills', 'skill-eval');
    let destinationBeforeRecheck: SnapshotEntry[] | undefined;
    await expect(installCompanion({
      cwd: workspace,
      packageRoot: repositoryRoot,
      testHooks: {
        beforePromotion: async () => {
          await mkdir(destination);
          if (sentinel !== null) await writeFile(path.join(destination, 'sentinel.txt'), sentinel);
          destinationBeforeRecheck = await snapshot(destination);
        },
      },
    })).rejects.toMatchObject({ exitCode: 4 });

    expect(await snapshot(destination)).toEqual(destinationBeforeRecheck);
    expect(await readdir(destination)).toEqual(sentinel === null ? [] : ['sentinel.txt']);
    if (sentinel !== null) expect(await readFile(path.join(destination, 'sentinel.txt'), 'utf8')).toBe(sentinel);
    await expect(access(path.join(destination, 'SKILL.md'))).rejects.toThrow();
    expect((await readdir(path.dirname(destination))).filter((name) => name.startsWith('.skill-eval-install-'))).toEqual([]);
  });

  it('does not inspect authentication or require provider configuration', async () => {
    const workspace = await makeWorkspace('skill-eval-install-provider-free-');
    const previous = process.env['SKILL_EVAL_CODEX_HOME'];
    process.env['SKILL_EVAL_CODEX_HOME'] = path.join(workspace, 'missing-auth-home');
    try {
      await expect(installCompanion({ cwd: workspace, packageRoot: repositoryRoot })).resolves.toMatchObject({ status: 'INSTALLED' });
    } finally {
      if (previous === undefined) delete process.env['SKILL_EVAL_CODEX_HOME'];
      else process.env['SKILL_EVAL_CODEX_HOME'] = previous;
    }
  });
});
