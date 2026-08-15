import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PromptfooCodexProvider } from '../src/runtime/promptfoo-provider.js';

const { evaluate } = vi.hoisted(() => ({ evaluate: vi.fn() }));

vi.mock('promptfoo', () => ({ evaluate }));

describe('Promptfoo adapter', () => {
  beforeEach(() => {
    evaluate.mockReset();
    evaluate.mockResolvedValue({
      results: [{
        success: true,
        latencyMs: 1,
        response: { output: 'provider-free completion' },
      }],
    });
  });

  it('supplies an explicit empty vars object for its single Promptfoo test', async () => {
    const provider = new PromptfooCodexProvider();

    await expect(provider.execute({
      role: 'candidate',
      model: 'gpt-5.6-luna',
      reasoningEffort: 'max',
      prompt: 'provider-free prompt',
      timeoutMs: 1_000,
    })).resolves.toMatchObject({ status: 'completion', finalOutput: 'provider-free completion' });

    expect(evaluate).toHaveBeenCalledOnce();
    expect(evaluate).toHaveBeenCalledWith(
      expect.objectContaining({ tests: [{ vars: {} }] }),
      expect.objectContaining({ cache: false, maxConcurrency: 1 }),
    );
  });
});
