import type { EvaluationProvider, ProviderRequest, ProviderResult, TokenUsage } from './provider.js';

interface PromptfooResponse {
  output?: unknown;
  error?: string;
  tokenUsage?: {
    prompt?: number;
    completion?: number;
    cached?: number;
    completionDetails?: { reasoning?: number };
  };
  metadata?: Record<string, unknown>;
  raw?: string;
}

interface PromptfooResult {
  success?: unknown;
  error?: unknown;
  response?: unknown;
}

function judgeUsedForbiddenTools(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  try {
    const turn = JSON.parse(raw) as unknown;
    if (turn === null || typeof turn !== 'object' || !('items' in turn) || !Array.isArray(turn.items)) return false;
    return turn.items.some((item: unknown) => {
      if (item === null || typeof item !== 'object' || !('type' in item)) return false;
      return ['command_execution', 'file_change', 'mcp_tool_call', 'web_search'].includes(String(item.type));
    });
  } catch {
    return false;
  }
}

function outputText(output: unknown): string | undefined {
  if (typeof output === 'string') return output;
  if (output !== undefined) return JSON.stringify(output);
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isTimeout(message: string): boolean {
  return /abort|timeout/i.test(message);
}

function errorMessage(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.message;
  try {
    const serialized = JSON.stringify(value) as string | undefined;
    return serialized === undefined ? 'Promptfoo returned a provider error' : serialized;
  } catch {
    return 'Promptfoo returned a provider error';
  }
}

function instrumentError(elapsedMs: number, message: string): ProviderResult {
  return { status: 'error', errorKind: 'instrument', elapsedMs, message };
}

function providerError(elapsedMs: number, message: string): ProviderResult {
  return { status: 'error', errorKind: 'provider', elapsedMs, message };
}

export class PromptfooCodexProvider implements EvaluationProvider {
  readonly kind = 'promptfoo-codex' as const;
  readonly requiresAuthentication = true;

  async execute(request: ProviderRequest): Promise<ProviderResult> {
    const startedAt = performance.now();
    try {
      const { evaluate } = await import('promptfoo');
      const config: Record<string, unknown> = {
        model: request.model,
        model_reasoning_effort: request.reasoningEffort,
        maxRetries: 0,
        skip_git_repo_check: true,
        sandbox_mode: request.role === 'candidate' ? 'workspace-write' : 'read-only',
        approval_policy: 'never',
        network_access_enabled: false,
        web_search_enabled: false,
        web_search_mode: 'disabled',
        inherit_process_env: false,
        persist_threads: false,
        cli_env: {
          ...(request.codexHome === undefined ? {} : {
            CODEX_HOME: request.codexHome,
            HOME: request.codexHome,
            USERPROFILE: request.codexHome,
          }),
        },
        ...(request.workspace === undefined ? {} : { working_dir: request.workspace }),
        ...(request.outputSchema === undefined ? {} : { output_schema: request.outputSchema }),
      };
      const evaluation = await evaluate(
        {
          prompts: [{ raw: request.prompt, label: `skill-eval-${request.role}` }],
          providers: [{ id: 'openai:codex-sdk', config }],
          tests: [{ vars: {} }],
          writeLatestResults: false,
        },
        {
          cache: false,
          maxConcurrency: 1,
          repeat: 1,
          timeoutMs: request.timeoutMs,
          maxEvalTimeMs: request.timeoutMs,
          showProgressBar: false,
          silent: true,
        },
      );
      const result = evaluation.results[0] as PromptfooResult | undefined;
      const elapsedMs = Math.round(performance.now() - startedAt);
      if (result === undefined) return instrumentError(elapsedMs, 'Promptfoo returned no result');
      if (result.error != null) {
        const message = errorMessage(result.error);
        return isTimeout(message)
          ? { status: 'timeout', elapsedMs, message }
          : providerError(elapsedMs, message);
      }
      if (!isRecord(result.response)) return instrumentError(elapsedMs, 'Promptfoo result has no valid response');
      const response = result.response as PromptfooResponse;
      if (response.error !== undefined) {
        if (typeof response.error !== 'string') return instrumentError(elapsedMs, 'Promptfoo response error is structurally invalid');
        return isTimeout(response.error)
          ? { status: 'timeout', elapsedMs, message: response.error }
          : providerError(elapsedMs, response.error);
      }
      const safeResponse = response;
      const finalOutput = outputText(safeResponse.output);
      if (finalOutput === undefined) return instrumentError(elapsedMs, 'Promptfoo result has no final output');
      const tokenUsage: TokenUsage | undefined = safeResponse.tokenUsage === undefined ? undefined : {
        ...(safeResponse.tokenUsage.prompt === undefined ? {} : { input: safeResponse.tokenUsage.prompt }),
        ...(safeResponse.tokenUsage.cached === undefined ? {} : { cachedInput: safeResponse.tokenUsage.cached }),
        ...(safeResponse.tokenUsage.completion === undefined ? {} : { output: safeResponse.tokenUsage.completion }),
        ...(safeResponse.tokenUsage.completionDetails?.reasoning === undefined ? {} : { reasoningOutput: safeResponse.tokenUsage.completionDetails.reasoning }),
      };
      const skillCallsValue: unknown = safeResponse.metadata?.['skillCalls'];
      const skillCalls: unknown[] = Array.isArray(skillCallsValue) ? skillCallsValue : [];
      const filesRead = skillCalls.flatMap((item): string[] => {
        if (item !== null && typeof item === 'object' && 'path' in item) {
          const source = (item as Record<string, unknown>)['source'];
          const itemPath = (item as Record<string, unknown>)['path'];
          if (source === 'tool' && typeof itemPath === 'string') return [itemPath];
        }
        return [];
      });
      const hasSkillHeuristic = skillCalls.some((item) => item !== null && typeof item === 'object' && (item as Record<string, unknown>)['source'] === 'heuristic');
      const forbiddenJudgeToolUse = request.role === 'judge' && judgeUsedForbiddenTools(safeResponse.raw);
      return {
        status: 'completion', finalOutput, elapsedMs,
        ...(tokenUsage === undefined ? {} : { usage: tokenUsage }),
        filesRead,
        promptfooProjection: {
          provider: 'openai:codex-sdk', model: request.model,
          success: result.success,
          skillUsedHeuristic: hasSkillHeuristic,
          forbiddenJudgeToolUse,
        },
      };
    } catch (error) {
      const elapsedMs = Math.round(performance.now() - startedAt);
      const message = error instanceof Error ? error.message : String(error);
      return isTimeout(message)
        ? { status: 'timeout', elapsedMs, message }
        : instrumentError(elapsedMs, message);
    }
  }
}
