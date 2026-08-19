import { execFile } from 'node:child_process';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, '..');
const skillRoot = path.join(repositoryRoot, 'skills', 'skill-eval');

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
