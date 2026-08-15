import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getJudgeResultSchema } from '../src/judge/batch.js';
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

    const result = await provider.execute({
      role: 'candidate',
      model: 'gpt-5.6-luna',
      reasoningEffort: 'max',
      prompt: 'provider-free prompt',
      timeoutMs: 1_000,
    });

    expect(result).toMatchObject({ status: 'completion', finalOutput: 'provider-free completion' });

    expect(evaluate).toHaveBeenCalledOnce();
    expect(evaluate).toHaveBeenCalledWith(
      expect.objectContaining({ tests: [{ vars: {} }] }),
      expect.objectContaining({ cache: false, maxConcurrency: 1 }),
    );
    expect(result.status === 'completion' ? result.promptfooProjection : undefined).not.toHaveProperty('latencyMs');
  });

  it('forwards the judge output schema unchanged as Promptfoo config.output_schema', async () => {
    const provider = new PromptfooCodexProvider();
    const outputSchema = getJudgeResultSchema();

    await expect(provider.execute({
      role: 'judge',
      model: 'gpt-5.6-terra',
      reasoningEffort: 'xhigh',
      prompt: 'provider-free judge prompt',
      timeoutMs: 1_000,
      outputSchema,
    })).resolves.toMatchObject({ status: 'completion', finalOutput: 'provider-free completion' });

    const testSuite = evaluate.mock.calls[0]?.[0] as { providers?: Array<{ config?: Record<string, unknown> }> } | undefined;
    expect(testSuite?.providers?.[0]?.config?.['output_schema']).toBe(outputSchema);
  });
});
