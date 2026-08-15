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
          prompts: [request.prompt],
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
      const result = evaluation.results[0];
      const response = result?.response as PromptfooResponse | undefined;
      const elapsedMs = Math.round(performance.now() - startedAt);
      if (result === undefined || response === undefined || response.error !== undefined || result.error != null) {
        const message = response?.error ?? result?.error ?? 'Promptfoo returned no result';
        return { status: /abort|timeout/i.test(message) ? 'timeout' : 'error', elapsedMs, message };
      }
      const safeResponse = response;
      const finalOutput = outputText(safeResponse.output);
      if (finalOutput === undefined) return { status: 'error', elapsedMs, message: 'Promptfoo result has no final output' };
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
          success: result.success, latencyMs: result.latencyMs,
          skillUsedHeuristic: hasSkillHeuristic,
          forbiddenJudgeToolUse,
        },
      };
    } catch (error) {
      const elapsedMs = Math.round(performance.now() - startedAt);
      const message = error instanceof Error ? error.message : String(error);
      return { status: /abort|timeout/i.test(message) ? 'timeout' : 'error', elapsedMs, message };
    }
  }
}
