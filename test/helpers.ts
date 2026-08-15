import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initializeEvaluation } from '../src/intake/init.js';
import type { InitAnswers } from '../src/spec/types.js';

export const FIXED_DATE = new Date('2026-08-15T12:00:00.000Z');

export function directAnswers(): InitAnswers {
  return {
    evaluationId: 'evaluation-test',
    decision: { question: 'Should this skill be used for the declared task?', proceedMeaning: 'Proceed only for the declared inputs and never activate outside them.' },
    claims: [
      { id: 'behavior', statement: 'The skill returns each prespecified value.', kind: 'BEHAVIOR', required: true, failureDecision: 'REVISE' },
    ],
    cases: [
      {
        id: 'positive-case', kind: 'POSITIVE', prompt: 'positive prompt', fixtureSource: null,
        claimIds: ['behavior'], activationExpectation: 'NOT_ASSERTED',
        checks: [{ id: 'positive-equals', claimId: 'behavior', operator: 'FINAL_EQUALS', expected: 'positive-ok', required: true, failureDecision: 'REVISE' }],
        semanticCriteria: [],
      },
      {
        id: 'invalid-case', kind: 'INVALID_SAFETY', prompt: 'invalid prompt', fixtureSource: null,
        claimIds: ['behavior'], activationExpectation: 'NOT_ASSERTED',
        checks: [{ id: 'invalid-equals', claimId: 'behavior', operator: 'FINAL_EQUALS', expected: 'invalid-ok', required: true, failureDecision: 'DO_NOT_PROCEED' }],
        semanticCriteria: [],
      },
      {
        id: 'boundary-case', kind: 'NEAR_BOUNDARY', prompt: 'boundary prompt', fixtureSource: null,
        claimIds: ['behavior'], activationExpectation: 'NOT_ASSERTED',
        checks: [{ id: 'boundary-equals', claimId: 'behavior', operator: 'FINAL_EQUALS', expected: 'boundary-ok', required: true, failureDecision: 'REVISE' }],
        semanticCriteria: [],
      },
    ],
  };
}

export async function makePackage(answers: InitAnswers = directAnswers()): Promise<{
  root: string;
  skill: string;
  evaluation: string;
  specPath: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'skill-eval-test-'));
  const skill = path.join(root, 'sample-skill');
  const evaluation = path.join(root, 'evaluation');
  await mkdir(skill);
  await writeFile(path.join(skill, 'SKILL.md'), '# Sample skill\n\nFollow the supplied task.\n');
  await initializeEvaluation({ skillDirectory: skill, outDirectory: evaluation, answers, now: () => FIXED_DATE });
  return { root, skill, evaluation, specPath: path.join(evaluation, 'evaluation-spec.json') };
}

export function qualifiedJudgeOutput(prompt: string): string {
  const batchText = prompt.split('<untrusted-batch>\n')[1]?.split('\n</untrusted-batch>')[0];
  if (batchText === undefined) throw new Error('Missing fake judge batch');
  const batch = JSON.parse(batchText) as {
    items: Array<{
      opaqueId: string;
      finalOutput: string;
      criteria: Array<{ criterionId: string }>;
      evidenceRefs: string[];
    }>;
  };
  return JSON.stringify({
    schemaVersion: 1,
    items: batch.items.map((item) => {
      const verdict = item.finalOutput.startsWith('Unrelated') || item.finalOutput.startsWith('Ignore') ? 'VIOLATED' : 'SATISFIED';
      return {
        opaqueId: item.opaqueId,
        criteria: item.criteria.map((criterion) => ({
          criterionId: criterion.criterionId,
          verdict,
          evidenceRefs: item.evidenceRefs.slice(0, 1),
          assessment: verdict === 'SATISFIED' ? 'The supplied evidence supports the criterion.' : 'The supplied evidence contradicts the criterion.',
        })),
      };
    }),
  });
}
