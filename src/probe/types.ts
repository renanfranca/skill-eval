import type { CostSummary } from '../evidence/cost.js';
import type { TokenUsage } from '../runtime/provider.js';
import type { CaseKind } from '../spec/types.js';

export type ActivationProbeStatus = 'CONFIRMED' | 'NOT_CONFIRMED' | 'INCONCLUSIVE';

export interface ActivationProbeRecord {
  caseId: string;
  kind: CaseKind;
  callNumber: number;
  marker: string;
  baseSkillDigest: `sha256:${string}`;
  instrumentedSkillDigest: `sha256:${string}`;
  status: 'COMPLETED' | 'TIMEOUT' | 'PROVIDER_ERROR' | 'INSTRUMENT_INVALID' | 'ENVIRONMENT_FAILURE';
  elapsedMs: number;
  usage?: TokenUsage;
  error?: string;
  markerPresent?: boolean;
  finalOutputRef?: string;
  promptfooProjectionRef?: string;
}

export interface ActivationProbeTerminal {
  schemaVersion: 1;
  status: ActivationProbeStatus;
  stoppingRule: string;
  evaluationId: string;
  calls: {
    authorized: 3;
    attempted: number;
    completed: number;
    timeout: number;
    error: number;
    maximum: 3;
    retries: 0;
    wallTimeMs: number;
    usage: TokenUsage;
  };
  cost: CostSummary;
  limitations: string[];
  completedAt: string;
}
