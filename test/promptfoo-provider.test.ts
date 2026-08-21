import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('supplies an inline candidate prompt with a deterministic label and an explicit empty vars object', async () => {
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
      expect.objectContaining({
        prompts: [{ raw: 'provider-free prompt', label: 'skill-eval-candidate' }],
        tests: [{ vars: {} }],
      }),
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
    expect(evaluate.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      prompts: [{ raw: 'provider-free judge prompt', label: 'skill-eval-judge' }],
    }));
  });

  it('classifies a non-timeout exception thrown by Promptfoo as an instrument error', async () => {
    evaluate.mockRejectedValueOnce(new Error('local Promptfoo evaluation failed'));
    const provider = new PromptfooCodexProvider();

    await expect(provider.execute({
      role: 'candidate', model: 'gpt-5.6-luna', reasoningEffort: 'max',
      prompt: 'inline prompt', timeoutMs: 1_000,
    })).resolves.toMatchObject({
      status: 'error', errorKind: 'instrument', message: 'local Promptfoo evaluation failed',
    });
  });

  it.each([
    ['response.error', { results: [{ response: { error: 'upstream provider failed' } }] }],
    ['result.error', { results: [{ error: 'upstream provider failed' }] }],
  ])('classifies %s as a provider error', async (_source, evaluation) => {
    evaluate.mockResolvedValueOnce(evaluation);
    const provider = new PromptfooCodexProvider();

    await expect(provider.execute({
      role: 'candidate', model: 'gpt-5.6-luna', reasoningEffort: 'max',
      prompt: 'inline prompt', timeoutMs: 1_000,
    })).resolves.toMatchObject({
      status: 'error', errorKind: 'provider', message: 'upstream provider failed',
    });
  });

  it('keeps timeout separate from error origin', async () => {
    evaluate.mockRejectedValueOnce(new Error('Promptfoo evaluation timeout'));
    const provider = new PromptfooCodexProvider();

    await expect(provider.execute({
      role: 'candidate', model: 'gpt-5.6-luna', reasoningEffort: 'max',
      prompt: 'inline prompt', timeoutMs: 1_000,
    })).resolves.toMatchObject({ status: 'timeout', message: 'Promptfoo evaluation timeout' });
  });

  it.each([
    ['missing result', { results: [] }],
    ['missing response', { results: [{ success: false }] }],
    ['missing final output', { results: [{ success: true, response: {} }] }],
  ])('classifies a structurally invalid %s as an instrument error', async (_description, evaluation) => {
    evaluate.mockResolvedValueOnce(evaluation);
    const provider = new PromptfooCodexProvider();

    await expect(provider.execute({
      role: 'candidate', model: 'gpt-5.6-luna', reasoningEffort: 'max',
      prompt: 'inline prompt', timeoutMs: 1_000,
    })).resolves.toMatchObject({ status: 'error', errorKind: 'instrument' });
  });

  it('passes a single-line path-like prompt unchanged through real Promptfoo to one local in-process provider call', async () => {
    vi.stubEnv('PROMPTFOO_DISABLE_TELEMETRY', 'true');
    vi.stubEnv('IS_TESTING', 'true');
    const actualPromptfoo = await vi.importActual<typeof import('promptfoo')>('promptfoo');
    const observed: string[] = [];
    const prompt = 'Inspect evaluation/evaluation-spec.json';
    const localProvider = {
      id: () => 'skill-eval:local-inline-canary',
      callApi: (received: string) => {
        observed.push(received);
        return Promise.resolve({ output: 'local provider completion' });
      },
    };

    const evaluation = await actualPromptfoo.evaluate({
      prompts: [{ raw: prompt, label: 'skill-eval-local-inline-canary' }],
      providers: [localProvider],
      tests: [{ vars: {} }],
      writeLatestResults: false,
    }, {
      cache: false,
      maxConcurrency: 1,
      repeat: 1,
      showProgressBar: false,
      silent: true,
    });

    expect(observed).toEqual([prompt]);
    expect(evaluation.results).toHaveLength(1);
    expect(evaluation.results[0]?.response?.output).toBe('local provider completion');
  });
});
