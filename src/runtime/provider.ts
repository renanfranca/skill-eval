export interface TokenUsage {
  input?: number;
  cachedInput?: number;
  output?: number;
  reasoningOutput?: number;
}

export interface ProviderRequest {
  role: 'candidate' | 'judge';
  model: 'gpt-5.6-luna' | 'gpt-5.6-terra';
  reasoningEffort: 'max' | 'xhigh';
  prompt: string;
  timeoutMs: number;
  workspace?: string;
  codexHome?: string;
  outputSchema?: Record<string, unknown>;
}

export interface ProviderCompletion {
  status: 'completion';
  finalOutput: string;
  elapsedMs: number;
  usage?: TokenUsage;
  filesRead?: string[];
  promptfooProjection?: Record<string, unknown>;
}

export type ProviderResult =
  | ProviderCompletion
  | { status: 'timeout'; elapsedMs: number; message: string }
  | { status: 'error'; elapsedMs: number; message: string };

export interface EvaluationProvider {
  readonly kind: 'fake' | 'promptfoo-codex';
  readonly requiresAuthentication: boolean;
  execute(request: ProviderRequest): Promise<ProviderResult>;
}
