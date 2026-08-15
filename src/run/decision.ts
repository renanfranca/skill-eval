import type { JudgeCriterionResult } from '../judge/batch.js';
import type { EvaluationSpec, Recommendation } from '../spec/types.js';
import type { CaseRecord, ClaimAssessment } from './types.js';

export function assessClaims(
  spec: EvaluationSpec,
  cases: CaseRecord[],
  semanticByCase: Map<string, JudgeCriterionResult[]>,
  semanticEvidenceValid: boolean,
): ClaimAssessment[] {
  return spec.claims.map((claim) => {
    const evidenceRefs: string[] = [];
    let hasEvidence = false;
    let contradicted = false;
    let insufficient = false;
    const relatedCases = spec.cases.filter((item) => item.claimIds.includes(claim.id));
    for (const item of relatedCases) {
      const record = cases.find((candidate) => candidate.caseId === item.id);
      const requiresEvidenceInCase =
        item.checks.some((check) => check.claimId === claim.id && check.required) ||
        item.semanticCriteria.some((criterion) => criterion.claimId === claim.id && criterion.required) ||
        (claim.kind === 'ACTIVATION' && item.activationExpectation !== 'NOT_ASSERTED');
      if (record === undefined || record.status !== 'COMPLETED') {
        if (requiresEvidenceInCase) insufficient = true;
        continue;
      }
      const results = record.checks.filter((check) => check.claimId === claim.id);
      for (const result of results) {
        if (result.status === 'INSTRUMENT_INVALID') {
          insufficient = true;
          continue;
        }
        hasEvidence = true;
        evidenceRefs.push(`case:${item.id}:check:${result.checkId}`);
        if (!result.passed) contradicted = true;
      }
      if (claim.kind === 'ACTIVATION' && item.activationExpectation !== 'NOT_ASSERTED') {
        if (item.activationExpectation === 'MUST_ACTIVATE') {
          if (record.activation.skillMdRead) {
            hasEvidence = true;
            evidenceRefs.push(`case:${item.id}:telemetry:skill-md-read`);
          } else insufficient = true;
        } else if (record.activation.skillMdRead) {
          hasEvidence = true;
          contradicted = true;
          evidenceRefs.push(`case:${item.id}:telemetry:unexpected-skill-md-read`);
        } else {
          insufficient = true;
        }
      }
      const requiredCriteria = item.semanticCriteria.filter((criterion) => criterion.claimId === claim.id && criterion.required);
      if (requiredCriteria.length > 0) {
        if (!semanticEvidenceValid) {
          insufficient = true;
        } else {
          const semantic = semanticByCase.get(item.id) ?? [];
          for (const criterion of requiredCriteria) {
            const result = semantic.find((candidate) => candidate.criterionId === criterion.id);
            if (result === undefined || result.verdict === 'INSUFFICIENT') insufficient = true;
            else {
              hasEvidence = true;
              evidenceRefs.push(...result.evidenceRefs);
              if (result.verdict === 'VIOLATED') contradicted = true;
            }
          }
        }
      }
    }
    const status = contradicted ? 'NOT_SUPPORTED' : insufficient || !hasEvidence ? 'NOT_ASSESSED' : 'SUPPORTED';
    const basis = status === 'SUPPORTED'
      ? 'All available prespecified required evidence supports the claim in the observed cases'
      : status === 'NOT_SUPPORTED'
        ? 'At least one valid prespecified observation contradicts the claim'
        : 'Required direct or qualified semantic evidence is absent or invalid';
    return {
      claimId: claim.id,
      statement: claim.statement,
      required: claim.required,
      failureDecision: claim.failureDecision,
      status,
      evidenceRefs: [...new Set(evidenceRefs)].sort(),
      basis,
    };
  });
}

export function recommend(
  claims: ClaimAssessment[],
  options: { instrumentInvalid: boolean; directDoNotProceed: boolean },
): Recommendation {
  if (options.directDoNotProceed) return 'DO_NOT_PROCEED';
  if (options.instrumentInvalid) return 'NO_DECISION';
  const required = claims.filter((claim) => claim.required);
  if (required.some((claim) => claim.status === 'NOT_ASSESSED')) return 'NO_DECISION';
  const unsupported = required.filter((claim) => claim.status === 'NOT_SUPPORTED');
  if (unsupported.some((claim) => claim.failureDecision === 'DO_NOT_PROCEED')) return 'DO_NOT_PROCEED';
  if (unsupported.length > 0) return 'REVISE';
  return 'PROCEED';
}

export function suggestedAction(recommendation: Recommendation): string {
  switch (recommendation) {
    case 'PROCEED': return 'Proceed only under the exact observed condition and declared boundary.';
    case 'REVISE': return 'Revise the skill or evaluation contract, then create a separate newly authorized run.';
    case 'DO_NOT_PROCEED': return 'Do not proceed under this condition; address the observed prohibited or critical effect.';
    case 'NO_DECISION': return 'Obtain the missing valid evidence in a separate run; do not infer a favorable result.';
  }
}
