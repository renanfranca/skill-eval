export type ExitCode = 2 | 3 | 4;

export class SkillEvalError extends Error {
  readonly exitCode: ExitCode;

  constructor(message: string, exitCode: ExitCode, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SkillEvalError';
    this.exitCode = exitCode;
  }
}

export function usageError(message: string): SkillEvalError {
  return new SkillEvalError(message, 2);
}

export function inconclusiveError(message: string): SkillEvalError {
  return new SkillEvalError(message, 3);
}

export function integrityError(message: string): SkillEvalError {
  return new SkillEvalError(message, 4);
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
