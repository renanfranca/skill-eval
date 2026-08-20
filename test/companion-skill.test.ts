import { execFile } from 'node:child_process';
import { access, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, '..');
const skillRoot = path.join(repositoryRoot, 'skills', 'skill-eval');

function extractRootBootstrap(markdown: string): string {
  const match = markdown.match(/```js skill-eval-root-bootstrap\n([\s\S]*?)\n```/u);
  if (match?.[1] === undefined) throw new Error('Expected the closed package-root bootstrap');
  return match[1];
}

async function runRootBootstrap(bootstrap: string, cwd: string): Promise<string> {
  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '--eval', bootstrap], { cwd });
  return stdout.trim();
}

async function confinedTree(root: string, relative = ''): Promise<string[]> {
  const directory = path.join(root, relative);
  const names = (await readdir(directory)).sort();
  const entries: string[] = [];
  for (const name of names) {
    const item = relative === '' ? name : `${relative}/${name}`;
    const details = await lstat(path.join(root, ...item.split('/')));
    expect(details.isSymbolicLink()).toBe(false);
    if (details.isDirectory()) entries.push(item, ...(await confinedTree(root, item)));
    else {
      expect(details.isFile()).toBe(true);
      expect(details.nlink).toBe(1);
      entries.push(item);
    }
  }
  return entries;
}

describe('experimental skill-eval companion', () => {
  it('has the expected frontmatter and a minimal confined tree', async () => {
    const skill = await readFile(path.join(skillRoot, 'SKILL.md'), 'utf8');
    const frontmatterEnd = skill.indexOf('\n---\n', 4);
    expect(skill.startsWith('---\n')).toBe(true);
    expect(frontmatterEnd).toBeGreaterThan(4);
    expect(skill.slice(4, frontmatterEnd).split('\n')).toEqual([
      'name: skill-eval',
      'description: Operate bounded skill-eval instruments and evidence without inventing owner decisions or provider authorization.',
    ]);
    expect(await confinedTree(skillRoot)).toEqual([
      'SKILL.md',
      'references',
      'references/execution-and-interpretation.md',
      'references/instrument-design.md',
    ]);
  });

  it('keeps every Markdown reference inside the companion and points to an existing regular file', async () => {
    const skill = await readFile(path.join(skillRoot, 'SKILL.md'), 'utf8');
    const references = [...skill.matchAll(/\[[^\]]+\]\(([^)]+)\)/gu)].map((match) => match[1]);
    expect(references).toEqual([
      'references/execution-and-interpretation.md',
      'references/instrument-design.md',
      'references/execution-and-interpretation.md',
    ]);
    for (const reference of references) {
      if (reference === undefined) throw new Error('Expected a Markdown reference');
      const resolved = path.resolve(skillRoot, reference);
      const relative = path.relative(skillRoot, resolved);
      expect(relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)).toBe(false);
      const details = await lstat(resolved);
      expect(details.isFile() && !details.isSymbolicLink()).toBe(true);
    }
  });

  it('preserves the pre-init gate and the three instrument-design outcomes', async () => {
    const content = await readFile(path.join(skillRoot, 'SKILL.md'), 'utf8');
    const normalized = content.replace(/\s+/gu, ' ');
    expect(content).toContain('Não misture ativação explícita, tarefa excluída pela skill e expectativa de');
    expect(normalized).toContain('A valid in-scope task with a latent risk in its fixture may proceed to `init`');
    expect(normalized).toContain('Do not invoke `init`; ask the owner to separate the instruments.');
    expect(normalized).toContain('An excluded task without literal invocation may be a `MUST_NOT_ACTIVATE`');
    expect(content).toContain('Never infer authorization for `run` or `probe-activation`.');
  });

  it('contains no forbidden context, installation policy, or evaluation-specific history', async () => {
    const files = (await confinedTree(skillRoot)).filter((entry) => entry.endsWith('.md'));
    const contents = (await Promise.all(files.map((file) => readFile(path.join(skillRoot, ...file.split('/')), 'utf8')))).join('\n');
    expect(files.some((file) => file.split('/').some((segment) => ['.git', '.agents', 'agents.md'].includes(segment.toLowerCase())))).toBe(false);
    expect(contents).not.toMatch(/explicit[-_ ]only|installer|restructure-documentation|seed4j|v1-v6/iu);
    expect(contents).not.toContain('node dist/cli.js');
    expect(contents).not.toMatch(/Treat `SPEC\.md` as the product contract/iu);
    expect(contents).toContain('node "<skill-eval-root>/dist/cli.js"');
  });

  it('resolves a checkout, installs a real local package dependency, and rejects host-file fallback', async () => {
    const executionReference = await readFile(
      path.join(skillRoot, 'references', 'execution-and-interpretation.md'),
      'utf8',
    );
    const bootstrap = extractRootBootstrap(executionReference);
    const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'skill-eval-companion-resolution-'));
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
    try {
      await execFileAsync(npm, ['run', 'build'], {
        cwd: repositoryRoot,
        maxBuffer: 10 * 1024 * 1024,
      });
      const checkoutCli = path.join(repositoryRoot, 'dist', 'cli.js');
      const directHelp = await execFileAsync(process.execPath, [checkoutCli, '--help'], {
        cwd: repositoryRoot,
      });
      expect(directHelp.stdout).toContain('skill-eval install --skills');
      const importedCli = await execFileAsync(
        process.execPath,
        ['--input-type=module', '--eval', `await import(${JSON.stringify(pathToFileURL(checkoutCli).href)});`],
        { cwd: repositoryRoot },
      );
      expect(importedCli.stdout).toBe('');
      expect(importedCli.stderr).toBe('');
      expect(await runRootBootstrap(bootstrap, repositoryRoot)).toBe(await realpath(repositoryRoot));

      const tarballs = path.join(temporaryRoot, 'tarballs');
      await mkdir(tarballs);
      const packed = await execFileAsync(
        npm,
        ['pack', '--json', '--ignore-scripts', '--pack-destination', tarballs],
        { cwd: repositoryRoot, maxBuffer: 10 * 1024 * 1024 },
      );
      const packResult = JSON.parse(packed.stdout) as Array<{ filename?: string }>;
      const filename = packResult[0]?.filename;
      if (filename === undefined) throw new Error('npm pack did not report a tarball filename');
      const tarball = path.join(tarballs, filename);

      const consumer = path.join(temporaryRoot, 'foreign-consumer');
      await mkdir(consumer);
      await execFileAsync(npm, ['init', '-y'], { cwd: consumer });
      await mkdir(path.join(consumer, 'dist'));
      await mkdir(path.join(consumer, 'docs'));
      const conflictingSpec = '# HOST SPEC — must not be selected\n';
      const conflictingUsage = '# HOST USAGE — must not be selected\n';
      const conflictingCli = [
        "const { writeFileSync } = require('node:fs');",
        "writeFileSync('host-cli-executed.txt', 'wrong CLI executed');",
        "process.stdout.write('HOST CLI — must not be selected\\n');",
        '',
      ].join('\n');
      await writeFile(path.join(consumer, 'SPEC.md'), conflictingSpec);
      await writeFile(path.join(consumer, 'docs', 'USAGE.md'), conflictingUsage);
      await writeFile(path.join(consumer, 'dist', 'cli.js'), conflictingCli);

      await execFileAsync(
        npm,
        ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--save-dev', tarball],
        { cwd: consumer, maxBuffer: 10 * 1024 * 1024 },
      );
      const installedPackage = path.join(consumer, 'node_modules', 'skill-eval');

      const resolvedRoot = await runRootBootstrap(bootstrap, consumer);
      expect(await realpath(resolvedRoot)).toBe(await realpath(installedPackage));
      expect(await readFile(path.join(resolvedRoot, 'SPEC.md'), 'utf8')).toContain('# Especificação do `skill-eval`');
      expect(await readFile(path.join(resolvedRoot, 'docs', 'USAGE.md'), 'utf8')).toContain('# Guia de uso do `skill-eval`');

      const authTrap = path.join(temporaryRoot, 'auth-trap');
      await mkdir(authTrap);
      await writeFile(path.join(authTrap, 'auth.json'), '{"mustNotBeRead":true}\n');
      const environment = { ...process.env, SKILL_EVAL_CODEX_HOME: authTrap };
      const help = await execFileAsync(npx, ['--no-install', 'skill-eval', '--help'], {
        cwd: consumer,
        env: environment,
      });
      expect(help.stdout.trim()).not.toBe('');
      expect(help.stdout).toContain('skill-eval install --skills');
      expect(help.stdout).not.toContain('HOST CLI');

      const installation = await execFileAsync(npx, ['--no-install', 'skill-eval', 'install', '--skills'], {
        cwd: consumer,
        env: environment,
      });
      expect(installation.stdout).toMatch(/Installed .*\.agents[/\\]skills[/\\]skill-eval/iu);
      expect(await confinedTree(path.join(consumer, '.agents', 'skills', 'skill-eval'))).toEqual([
        'SKILL.md',
        'references',
        'references/execution-and-interpretation.md',
        'references/instrument-design.md',
      ]);

      expect(await readFile(path.join(consumer, 'SPEC.md'), 'utf8')).toBe(conflictingSpec);
      expect(await readFile(path.join(consumer, 'docs', 'USAGE.md'), 'utf8')).toBe(conflictingUsage);
      expect(await readFile(path.join(consumer, 'dist', 'cli.js'), 'utf8')).toBe(conflictingCli);
      await expect(access(path.join(consumer, 'host-cli-executed.txt'))).rejects.toThrow();
      expect(await readFile(path.join(authTrap, 'auth.json'), 'utf8')).toBe('{"mustNotBeRead":true}\n');

      const unresolved = path.join(temporaryRoot, 'unresolved-host');
      await mkdir(path.join(unresolved, 'dist'), { recursive: true });
      await mkdir(path.join(unresolved, 'docs'), { recursive: true });
      await writeFile(path.join(unresolved, 'package.json'), '{"name":"foreign-host"}\n');
      await writeFile(path.join(unresolved, 'SPEC.md'), conflictingSpec);
      await writeFile(path.join(unresolved, 'docs', 'USAGE.md'), conflictingUsage);
      await writeFile(path.join(unresolved, 'dist', 'cli.js'), conflictingCli);
      const globalModules = path.join(temporaryRoot, 'global-fallback', 'node_modules');
      await mkdir(globalModules, { recursive: true });
      await symlink(
        installedPackage,
        path.join(globalModules, 'skill-eval'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      await expect(execFileAsync(
        process.execPath,
        ['--input-type=module', '--eval', bootstrap],
        { cwd: unresolved, env: { ...process.env, NODE_PATH: globalModules } },
      )).rejects.toMatchObject({
        stderr: expect.stringMatching(/no validated checkout or local skill-eval dependency/iu),
      });
      await expect(access(path.join(unresolved, 'host-cli-executed.txt'))).rejects.toThrow();
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it('is included in the npm tarball with exactly its required files', async () => {
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const { stdout } = await execFileAsync(npm, ['pack', '--dry-run', '--json', '--ignore-scripts'], {
      cwd: repositoryRoot,
      maxBuffer: 10 * 1024 * 1024,
    });
    const result = JSON.parse(stdout) as Array<{ files?: Array<{ path?: string }> }>;
    const packagedPaths = result.flatMap((item) => item.files ?? []).flatMap((item) => item.path ?? []);
    expect(packagedPaths.filter((item) => item.startsWith('skills/skill-eval/')).sort()).toEqual([
      'skills/skill-eval/SKILL.md',
      'skills/skill-eval/references/execution-and-interpretation.md',
      'skills/skill-eval/references/instrument-design.md',
    ]);
  });
});
