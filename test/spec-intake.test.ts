import { execFile } from 'node:child_process';
import { chmod, link, lstat, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { scanTree } from '../src/intake/tree.js';
import { canonicalJson } from '../src/spec/canonical.js';
import { checkEvaluationPackage, validateAnswers } from '../src/spec/validate.js';
import { directAnswers, makePackage } from './helpers.js';

describe('specification and confined intake', () => {
  const execFileAsync = promisify(execFile);
  it('creates a canonical package, preserves bytes and executable mode, and checks its digest offline', async () => {
    const fixture = await makePackage();
    const script = path.join(fixture.skill, 'tool.sh');
    await writeFile(script, '#!/bin/sh\nexit 0\n');
    await chmod(script, 0o751);
    const second = path.join(fixture.root, 'evaluation-with-script');
    const { initializeEvaluation } = await import('../src/intake/init.js');
    await initializeEvaluation({ skillDirectory: fixture.skill, outDirectory: second, answers: directAnswers(), now: () => new Date('2026-08-15T12:00:00Z') });
    const specPath = path.join(second, 'evaluation-spec.json');
    const bytes = await readFile(specPath, 'utf8');
    expect(bytes).toBe(canonicalJson(JSON.parse(bytes)));
    await expect(checkEvaluationPackage(specPath)).resolves.toMatchObject({ evaluationId: 'evaluation-test' });
    expect((await lstat(path.join(second, 'skill-snapshot', 'tool.sh'))).mode & 0o777).toBe(0o751);
    expect(await readFile(path.join(second, 'skill-snapshot', 'tool.sh'), 'utf8')).toBe('#!/bin/sh\nexit 0\n');
  });

  it('produces identical canonical specs from non-interactive and guided answer collection', async () => {
    const fixture = await makePackage();
    const answers = directAnswers();
    const { initializeEvaluation } = await import('../src/intake/init.js');
    const nonInteractive = path.join(fixture.root, 'non-interactive');
    const guided = path.join(fixture.root, 'guided');
    const now = () => new Date('2026-08-15T12:00:00Z');
    await initializeEvaluation({ skillDirectory: fixture.skill, outDirectory: nonInteractive, answers, now });
    await initializeEvaluation({ skillDirectory: fixture.skill, outDirectory: guided, collectAnswers: () => Promise.resolve(structuredClone(answers)), now });
    expect(await readFile(path.join(guided, 'evaluation-spec.json'), 'utf8')).toBe(await readFile(path.join(nonInteractive, 'evaluation-spec.json'), 'utf8'));
  });

  it('changes the canonical digest when path, mode, or bytes change', async () => {
    const fixture = await makePackage();
    const first = await scanTree(fixture.skill, { requireSkillMd: true });
    await chmod(path.join(fixture.skill, 'SKILL.md'), 0o700);
    const mode = await scanTree(fixture.skill, { requireSkillMd: true });
    await writeFile(path.join(fixture.skill, 'extra.txt'), 'same bytes');
    const itemPath = await scanTree(fixture.skill, { requireSkillMd: true });
    await writeFile(path.join(fixture.skill, 'extra.txt'), 'different bytes');
    const bytes = await scanTree(fixture.skill, { requireSkillMd: true });
    expect(new Set([first.digest, mode.digest, itemPath.digest, bytes.digest]).size).toBe(4);
  });

  it('rejects unknown fields, duplicate ids, orphan references, wrong case ordering, and remote schema refs', () => {
    const extra = { ...directAnswers(), unexpected: true };
    expect(() => validateAnswers(extra)).toThrow(/additional properties/i);
    const duplicate = directAnswers();
    duplicate.claims.push({ ...duplicate.claims[0]!, statement: 'duplicate' });
    expect(() => validateAnswers(duplicate)).toThrow(/unique/i);
    const orphan = directAnswers();
    orphan.cases[0].checks[0]!.claimId = 'missing';
    expect(() => validateAnswers(orphan)).toThrow(/outside case/i);
    const wrongOrder = directAnswers();
    [wrongOrder.cases[0], wrongOrder.cases[1]] = [wrongOrder.cases[1], wrongOrder.cases[0]];
    expect(() => validateAnswers(wrongOrder)).toThrow(/ordered/i);
    const remote = directAnswers();
    remote.cases[0].checks = [{
      id: 'json-check', claimId: 'behavior', operator: 'FINAL_JSON_SCHEMA',
      schema: { $ref: 'https://example.invalid/schema.json' }, required: true, failureDecision: 'REVISE',
    }];
    expect(() => validateAnswers(remote)).toThrow(/non-local/i);
  });

  it('accepts MARKDOWN_LINKS_TO and rejects empty, duplicate, or unsafe source and destination paths', () => {
    const accepted = directAnswers();
    accepted.cases[0].checks = [{
      id: 'markdown-navigation', claimId: 'behavior', operator: 'MARKDOWN_LINKS_TO', path: 'README.md',
      destinations: ['docs/getting-started.md', 'docs/commands.md'], required: true, failureDecision: 'REVISE',
    }];
    expect(validateAnswers(accepted).cases[0].checks[0]).toMatchObject({ operator: 'MARKDOWN_LINKS_TO' });

    for (const destinations of [
      [],
      ['docs/same.md', 'docs/same.md'],
      ['/absolute.md'],
      ['docs/./not-normalized.md'],
      ['../outside.md'],
      ['docs\\windows.md'],
      ['docs/\0nul.md'],
    ]) {
      const invalid = structuredClone(accepted);
      const invalidCheck = invalid.cases[0].checks[0]!;
      if (invalidCheck.operator !== 'MARKDOWN_LINKS_TO') throw new Error('Expected MARKDOWN_LINKS_TO check');
      invalidCheck.destinations = destinations;
      expect(() => validateAnswers(invalid)).toThrow(/invalid answers|unique|confined normalized POSIX path/i);
    }

    for (const sourcePath of ['', '/README.md', 'docs/./README.md', '../README.md', 'docs\\README.md', 'docs/\0README.md']) {
      const invalid = structuredClone(accepted);
      const invalidCheck = invalid.cases[0].checks[0]!;
      if (invalidCheck.operator !== 'MARKDOWN_LINKS_TO') throw new Error('Expected MARKDOWN_LINKS_TO check');
      invalidCheck.path = sourcePath;
      expect(() => validateAnswers(invalid)).toThrow(/invalid answers|confined normalized POSIX path/i);
    }
  });

  it('rejects symlinks, forbidden contexts, and escaping Markdown references', async () => {
    const fixture = await makePackage();
    await symlink(path.join(fixture.skill, 'SKILL.md'), path.join(fixture.skill, 'link.md'));
    await expect(scanTree(fixture.skill, { requireSkillMd: true })).rejects.toThrow(/Symlink|safely open/i);
    await (await import('node:fs/promises')).unlink(path.join(fixture.skill, 'link.md'));
    await writeFile(path.join(fixture.skill, 'AGENTS.md'), 'context');
    await expect(scanTree(fixture.skill, { requireSkillMd: true })).rejects.toThrow(/Forbidden/i);
    await (await import('node:fs/promises')).unlink(path.join(fixture.skill, 'AGENTS.md'));
    await mkdir(path.join(fixture.skill, '.agents'));
    await expect(scanTree(fixture.skill, { requireSkillMd: true })).rejects.toThrow(/Forbidden/i);
    await (await import('node:fs/promises')).rmdir(path.join(fixture.skill, '.agents'));
    await writeFile(path.join(fixture.skill, 'SKILL.md'), '[escape][outside]\n\n[outside]: ..\\outside.txt\n');
    await expect(scanTree(fixture.skill, { requireSkillMd: true })).rejects.toThrow(/escapes snapshot/i);
  });

  it.runIf(process.platform !== 'win32')('rejects a hardlinked file', async () => {
    const fixture = await makePackage();
    const original = path.join(fixture.skill, 'original.txt');
    await writeFile(original, 'shared inode');
    await link(original, path.join(fixture.skill, 'alias.txt'));
    await expect(scanTree(fixture.skill, { requireSkillMd: true })).rejects.toThrow(/Hardlinked/i);
  });

  it.runIf(process.platform !== 'win32')('rejects a special filesystem entry when the platform supports FIFOs', async () => {
    const fixture = await makePackage();
    await execFileAsync('mkfifo', [path.join(fixture.skill, 'special.fifo')]);
    await expect(scanTree(fixture.skill, { requireSkillMd: true })).rejects.toThrow(/Special filesystem entry/i);
  });

  it.runIf(process.platform === 'linux')('rejects case-insensitive path collisions', async () => {
    const fixture = await makePackage();
    await writeFile(path.join(fixture.skill, 'Result.txt'), 'first');
    await writeFile(path.join(fixture.skill, 'result.txt'), 'second', { flag: 'wx' });
    await expect(scanTree(fixture.skill, { requireSkillMd: true })).rejects.toThrow(/Case-insensitive path collision/i);
  });

  it('detects post-init skill tampering', async () => {
    const fixture = await makePackage();
    await writeFile(path.join(fixture.evaluation, 'skill-snapshot', 'SKILL.md'), 'tampered');
    await expect(checkEvaluationPackage(fixture.specPath)).rejects.toThrow(/digest/i);
  });
});
