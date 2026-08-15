import { describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli.js';

describe('public CLI surface', () => {
  it('provides general help and provider-free help for all four commands', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await expect(main(['--help'])).resolves.toBe(0);
      for (const command of ['init', 'check', 'run', 'report']) {
        await expect(main([command, '--help'])).resolves.toBe(0);
      }
      const output = write.mock.calls.map(([value]) => String(value)).join('');
      expect(output).toContain('skill-eval init');
      expect(output).toContain('skill-eval check');
      expect(output).toContain('skill-eval run');
      expect(output).toContain('skill-eval report');
      expect(output).toContain('Exit codes');
    } finally {
      write.mockRestore();
    }
  });

  it('rejects unknown commands as a usage error', async () => {
    await expect(main(['unknown'])).rejects.toMatchObject({ exitCode: 2 });
  });
});
