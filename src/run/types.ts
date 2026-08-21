import type { CheckResult, FilesystemChange } from '../evidence/checks.js';
import type { CostSummary } from '../evidence/cost.js';
import type { JudgeCriterionResult } from '../judge/batch.js';
import type { TokenUsage } from '../runtime/provider.js';
import type { CaseKind, ClaimStatus, EvaluationSpec, Recommendation } from '../spec/types.js';

export type TerminalStatus =
  | 'COMPLETED'
  | 'INSTRUMENT_INVALID'
  | 'AUTHORIZATION_MISSING'
  | 'EXECUTION_TIMEOUT'
  | 'PROVIDER_ERROR'
  | 'ENVIRONMENT_FAILURE'
  | 'CRITICAL_VIOLATION'
  | 'JUDGE_INVALID'
  | 'INTERRUPTED_UNCONFIRMED';

export interface CaseRecord {
  caseId: string;
  kind: CaseKind;
  callNumber: number;
  status: 'COMPLETED' | 'TIMEOUT' | 'PROVIDER_ERROR' | 'INSTRUMENT_INVALID' | 'ENVIRONMENT_FAILURE';
  elapsedMs: number;
  usage?: TokenUsage;
  error?: string;
  finalOutputRef?: string;
  filesystemDiffRef?: string;
  promptfooProjectionRef?: string;
  filesystemChanges: FilesystemChange[];
  checks: CheckResult[];
  activation: {
    expectation: 'MUST_ACTIVATE' | 'MUST_NOT_ACTIVATE' | 'NOT_ASSERTED';
    skillMdRead: boolean;
    promptfooSkillUsedHeuristic: boolean;
  };
}

export interface ClaimAssessment {
  claimId: string;
  statement: string;
  required: boolean;
  failureDecision: 'REVISE' | 'DO_NOT_PROCEED' | 'ADVISORY';
  status: ClaimStatus;
  evidenceRefs: string[];
  basis: string;
}

export interface TerminalReceipt {
  schemaVersion: 1;
  status: TerminalStatus;
  stoppingRule: string;
  recommendation: Recommendation;
  decisionQuestion: string;
  proceedMeaning: string;
  snapshot: EvaluationSpec['skill'];
  condition: EvaluationSpec['execution'];
  claims: ClaimAssessment[];
  directObservations: CheckResult[];
  semanticAssessments: Array<JudgeCriterionResult & { caseId: string }>;
  cases: CaseRecord[];
  judgeQualification: {
    attempted: boolean;
    valid: boolean | null;
    summary: string;
  };
  calls: {
    authorized: 4;
    attempted: number;
    completed: number;
    timeout: number;
    error: number;
    maximum: 4;
    retries: 0;
    wallTimeMs: number;
    usage: TokenUsage;
  };
  cost: CostSummary;
  limitations: string[];
  suggestedAction: string;
  reevaluationTriggers: string[];
  completedAt: string;
}
