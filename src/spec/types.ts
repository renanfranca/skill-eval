export const CASE_KINDS = ['POSITIVE', 'INVALID_SAFETY', 'NEAR_BOUNDARY'] as const;
export type CaseKind = (typeof CASE_KINDS)[number];

export const CLAIM_KINDS = [
  'BEHAVIOR',
  'ACTIVATION',
  'SAFETY',
  'NON_INTERFERENCE',
  'EFFICIENCY',
] as const;
export type ClaimKind = (typeof CLAIM_KINDS)[number];

export const FAILURE_DECISIONS = ['REVISE', 'DO_NOT_PROCEED', 'ADVISORY'] as const;
export type FailureDecision = (typeof FAILURE_DECISIONS)[number];
export type Recommendation = 'PROCEED' | 'REVISE' | 'DO_NOT_PROCEED' | 'NO_DECISION';
export type ClaimStatus = 'SUPPORTED' | 'NOT_SUPPORTED' | 'NOT_ASSESSED';

export interface SkillSnapshot {
  name: string;
  snapshotPath: 'skill-snapshot';
  sha256: `sha256:${string}`;
}

export interface DecisionSpec {
  question: string;
  proceedMeaning: string;
}

export interface ClaimSpec {
  id: string;
  statement: string;
  kind: ClaimKind;
  required: boolean;
  failureDecision: FailureDecision;
}

interface CheckBase {
  id: string;
  claimId: string;
  required: boolean;
  failureDecision: FailureDecision;
}

export type DirectCheck =
  | (CheckBase & { operator: 'FINAL_EQUALS'; expected: string })
  | (CheckBase & { operator: 'FINAL_CONTAINS' | 'FINAL_EXCLUDES'; fragments: string[] })
  | (CheckBase & { operator: 'FINAL_JSON_SCHEMA'; schema: Record<string, unknown> | boolean })
  | (CheckBase & { operator: 'PATH_EXISTS' | 'PATH_ABSENT'; path: string })
  | (CheckBase & {
      operator: 'FILE_EQUALS';
      path: string;
      expected: string | { sha256: `sha256:${string}` };
    })
  | (CheckBase & {
      operator: 'FILE_CONTAINS' | 'FILE_EXCLUDES';
      path: string;
      fragments: string[];
    })
  | (CheckBase & { operator: 'MARKDOWN_LINKS_TO'; path: string; destinations: string[] })
  | (CheckBase & { operator: 'WRITES_WITHIN'; paths: string[] })
  | (CheckBase & { operator: 'NO_FILESYSTEM_CHANGE' })
  | (CheckBase & { operator: 'MAX_ELAPSED_MS'; maximumMs: number });

export interface SemanticCriterion {
  id: string;
  claimId: string;
  statement: string;
  required: boolean;
}

export interface EvaluationCase {
  id: string;
  kind: CaseKind;
  prompt: string;
  fixturePath: string | null;
  claimIds: string[];
  activationExpectation: 'MUST_ACTIVATE' | 'MUST_NOT_ACTIVATE' | 'NOT_ASSERTED';
  checks: DirectCheck[];
  semanticCriteria: SemanticCriterion[];
}

export interface ExecutionSpec {
  candidate: {
    provider: 'openai:codex-sdk';
    model: 'gpt-5.6-luna';
    reasoningEffort: 'max';
    maximumCalls: 3;
    timeoutSeconds: 600;
  };
  judge: {
    provider: 'openai:codex-sdk';
    model: 'gpt-5.6-terra';
    reasoningEffort: 'xhigh';
    maximumCalls: 1;
    timeoutSeconds: 600;
  };
  totalMaximumCalls: 4;
  maximumConcurrency: 1;
  retries: 0;
}

export interface EvaluationSpec {
  schemaVersion: 1;
  evaluationId: string;
  createdAt: string;
  skill: SkillSnapshot;
  decision: DecisionSpec;
  claims: ClaimSpec[];
  cases: [EvaluationCase, EvaluationCase, EvaluationCase];
  execution: ExecutionSpec;
  retention: { mode: 'SANITIZED_LOCAL_COMPLETE' };
}

export type InitCaseAnswer = Omit<EvaluationCase, 'fixturePath'> & {
  fixtureSource: string | null;
};

export interface InitAnswers {
  evaluationId?: string;
  decision: DecisionSpec;
  claims: ClaimSpec[];
  cases: [InitCaseAnswer, InitCaseAnswer, InitCaseAnswer];
}

export const FIXTURE_DIRECTORY: Record<CaseKind, string> = {
  POSITIVE: 'positive',
  INVALID_SAFETY: 'invalid-safety',
  NEAR_BOUNDARY: 'near-boundary',
};

export const REQUIRED_EXECUTION: ExecutionSpec = {
  candidate: {
    provider: 'openai:codex-sdk',
    model: 'gpt-5.6-luna',
    reasoningEffort: 'max',
    maximumCalls: 3,
    timeoutSeconds: 600,
  },
  judge: {
    provider: 'openai:codex-sdk',
    model: 'gpt-5.6-terra',
    reasoningEffort: 'xhigh',
    maximumCalls: 1,
    timeoutSeconds: 600,
  },
  totalMaximumCalls: 4,
  maximumConcurrency: 1,
  retries: 0,
};
