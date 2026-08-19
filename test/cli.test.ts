import { access, mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli.js';

describe('public CLI surface', () => {
  it('provides general help and help for all six commands', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await expect(main(['--help'])).resolves.toBe(0);
      for (const command of ['install', 'init', 'check', 'run', 'probe-activation', 'report']) {
        await expect(main([command, '--help'])).resolves.toBe(0);
      }
      const output = write.mock.calls.map(([value]) => String(value)).join('');
      expect(output).toContain('skill-eval install --skills');
      expect(output).toContain('skill-eval init');
      expect(output).toContain('skill-eval check');
      expect(output).toContain('skill-eval run');
      expect(output).toContain('skill-eval probe-activation');
      expect(output).toContain('skill-eval report');
      expect(output).toContain('Exit codes');
      expect(output).toContain('.agents/skills/skill-eval');
      expect(output).toContain('provider-free');
    } finally {
      write.mockRestore();
    }
  });

  it('rejects unknown commands as a usage error', async () => {
    await expect(main(['unknown'])).rejects.toMatchObject({ exitCode: 2 });
  });

  it.each([
    ['missing flag', []],
    ['unknown flag', ['--global']],
    ['force flag', ['--skills', '--force']],
    ['positional', ['--skills', './elsewhere']],
  ])('rejects install with %s before writing to the current project', async (_label, args) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'skill-eval-cli-install-usage-'));
    const previous = process.cwd();
    process.chdir(root);
    try {
      await expect(main(['install', ...args])).rejects.toMatchObject({ exitCode: 2 });
      await expect(access(path.join(root, '.agents'))).rejects.toThrow();
    } finally {
      process.chdir(previous);
    }
  });

  it.each([
    ['missing', []],
    ['leading zero', ['--approve-provider-calls', '04']],
    ['decimal', ['--approve-provider-calls', '4.0']],
    ['exponent', ['--approve-provider-calls', '4e0']],
    ['explicit plus', ['--approve-provider-calls', '+4']],
  ])('rejects %s authorization text before inspecting or reserving the run', async (_label, approvalArgs) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'skill-eval-cli-approval-'));
    const out = path.join(root, 'must-not-exist');
    await expect(main([
      'run', '--spec', path.join(root, 'also-must-not-be-read.json'), '--out', out, ...approvalArgs,
    ])).rejects.toMatchObject({ exitCode: 2 });
    await expect(access(out)).rejects.toThrow();
  });

  it.each([
    ['missing', []],
    ['leading zero', ['--approve-provider-calls', '03']],
    ['decimal', ['--approve-provider-calls', '3.0']],
    ['exponent', ['--approve-provider-calls', '3e0']],
    ['explicit plus', ['--approve-provider-calls', '+3']],
  ])('rejects %s probe authorization text before inspecting or reserving output', async (_label, approvalArgs) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'skill-eval-cli-probe-approval-'));
    const out = path.join(root, 'must-not-exist');
    await expect(main([
      'probe-activation', '--spec', path.join(root, 'also-must-not-be-read.json'), '--out', out, ...approvalArgs,
    ])).rejects.toMatchObject({ exitCode: 2 });
    await expect(access(out)).rejects.toThrow();
  });
});
