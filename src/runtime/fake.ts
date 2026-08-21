import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { usageError } from '../errors.js';
import { assertSafeRelativePath } from '../spec/validate.js';
import type { EvaluationProvider, ProviderErrorKind, ProviderRequest, ProviderResult, TokenUsage } from './provider.js';

export interface FakeMutation {
  path: string;
  content?: string;
  remove?: boolean;
}

export type FakeStep =
  | {
      type: 'completion';
      output: string | ((request: ProviderRequest) => string);
      elapsedMs?: number;
      usage?: TokenUsage;
      filesRead?: string[];
      mutations?: FakeMutation[];
    }
  | { type: 'timeout'; elapsedMs?: number; message?: string }
  | { type: 'error'; errorKind?: ProviderErrorKind; elapsedMs?: number; message?: string };

export class FakeProvider implements EvaluationProvider {
  readonly kind = 'fake' as const;
  readonly requiresAuthentication = false;
  readonly requests: ProviderRequest[] = [];
  private cursor = 0;

  constructor(private readonly script: FakeStep[]) {}

  async execute(request: ProviderRequest): Promise<ProviderResult> {
    this.requests.push(structuredClone(request));
    const step = this.script[this.cursor++];
    if (step === undefined) return { status: 'error', errorKind: 'instrument', elapsedMs: 0, message: 'Fake script exhausted' };
    if (step.type === 'timeout') return { status: 'timeout', elapsedMs: step.elapsedMs ?? request.timeoutMs, message: step.message ?? 'Deterministic timeout' };
    if (step.type === 'error') {
      return {
        status: 'error',
        errorKind: step.errorKind ?? 'provider',
        elapsedMs: step.elapsedMs ?? 1,
        message: step.message ?? 'Deterministic provider error',
      };
    }
    if (request.workspace !== undefined) {
      for (const mutation of step.mutations ?? []) {
        assertSafeRelativePath(mutation.path, 'Fake mutation path');
        const target = path.join(request.workspace, ...mutation.path.split('/'));
        if (mutation.remove === true) await rm(target, { recursive: true, force: true });
        else {
          if (mutation.content === undefined) throw usageError(`Fake mutation ${mutation.path} requires content`);
          await mkdir(path.dirname(target), { recursive: true });
          await writeFile(target, mutation.content, { flag: 'wx' });
        }
      }
    }
    const finalOutput = typeof step.output === 'function' ? step.output(request) : step.output;
    return {
      status: 'completion', finalOutput, elapsedMs: step.elapsedMs ?? 1,
      ...(step.usage === undefined ? {} : { usage: step.usage }),
      ...(step.filesRead === undefined ? {} : { filesRead: step.filesRead }),
      promptfooProjection: { provider: 'fake', scriptedStep: this.cursor },
    };
  }
}
