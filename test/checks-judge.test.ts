import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyDirectCheck } from '../src/evidence/checks.js';
import { prepareJudgeBatch, validateJudgeOutput } from '../src/judge/batch.js';
import { directAnswers, qualifiedJudgeOutput } from './helpers.js';

describe('direct evidence and opaque judge qualification', () => {
  it('applies allowed direct operators without callbacks or shell', async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'skill-eval-checks-'));
    await mkdir(path.join(workspace, 'out'));
    await writeFile(path.join(workspace, 'out', 'value.txt'), 'alpha beta');
    const base = { finalOutput: '{"ok":true}', elapsedMs: 5, workspace, changes: [{ path: 'out/value.txt', change: 'CREATED' as const }] };
    await expect(applyDirectCheck({ id: 'json', claimId: 'c', operator: 'FINAL_JSON_SCHEMA', schema: { type: 'object', required: ['ok'] }, required: true, failureDecision: 'REVISE' }, base)).resolves.toMatchObject({ passed: true });
    await expect(applyDirectCheck({ id: 'contains', claimId: 'c', operator: 'FILE_CONTAINS', path: 'out/value.txt', fragments: ['alpha'], required: true, failureDecision: 'REVISE' }, base)).resolves.toMatchObject({ passed: true });
    await expect(applyDirectCheck({ id: 'writes', claimId: 'c', operator: 'WRITES_WITHIN', paths: ['out'], required: true, failureDecision: 'DO_NOT_PROCEED' }, base)).resolves.toMatchObject({ passed: true });
    await expect(applyDirectCheck({ id: 'elapsed', claimId: 'c', operator: 'MAX_ELAPSED_MS', maximumMs: 4, required: true, failureDecision: 'REVISE' }, base)).resolves.toMatchObject({ passed: false });
  });

  it('uses opaque randomized ids and accepts only an exactly qualified batch', () => {
    const cases = directAnswers().cases.map(({ fixtureSource: _fixtureSource, ...item }) => ({ ...item, fixturePath: null }));
    cases[0]!.semanticCriteria = [{ id: 'meaning', claimId: 'behavior', statement: 'The requested meaning is present.', required: true }];
    const prepared = prepareJudgeBatch(cases.map((evaluationCase, index) => ({ evaluationCase, finalOutput: `candidate-${index}`, evidenceRefs: [`candidate-${index}.txt`] })));
    expect(prepared.publicBatch.items).toHaveLength(7);
    expect(prepared.publicBatch.items.every((item) => /^q-[a-f0-9]{16}$/.test(item.opaqueId))).toBe(true);
    const output = qualifiedJudgeOutput(prepared.prompt);
    expect(validateJudgeOutput(output, prepared)).toMatchObject({ valid: true });
  });

  it('invalidates the whole semantic set for missing, duplicate, extra, bad refs, or a failed injection probe', () => {
    const item = directAnswers().cases[0];
    item.semanticCriteria = [{ id: 'meaning', claimId: 'behavior', statement: 'Meaning is present.', required: true }];
    const { fixtureSource: _fixtureSource, ...evaluationCase } = item;
    const prepared = prepareJudgeBatch([{ evaluationCase: { ...evaluationCase, fixturePath: null }, finalOutput: 'candidate', evidenceRefs: ['candidate.txt'] }]);
    const valid = JSON.parse(qualifiedJudgeOutput(prepared.prompt)) as { items: Array<{ criteria: Array<{ evidenceRefs: string[]; verdict: string }> }> };
    valid.items.pop();
    expect(validateJudgeOutput(JSON.stringify(valid), prepared).valid).toBe(false);
    const badRef = JSON.parse(qualifiedJudgeOutput(prepared.prompt)) as { items: Array<{ criteria: Array<{ evidenceRefs: string[] }> }> };
    const criterion = badRef.items.find((candidate) => candidate.criteria.length > 0)?.criteria[0];
    if (criterion === undefined) throw new Error('Expected criterion');
    criterion.evidenceRefs = ['fabricated-ref'];
    expect(validateJudgeOutput(JSON.stringify(badRef), prepared).valid).toBe(false);
    const failedProbe = JSON.parse(qualifiedJudgeOutput(prepared.prompt)) as { items: Array<{ criteria: Array<{ verdict: string }> }> };
    const violated = failedProbe.items.find((candidate) => candidate.criteria[0]?.verdict === 'VIOLATED');
    if (violated?.criteria[0] === undefined) throw new Error('Expected violated probe');
    violated.criteria[0].verdict = 'SATISFIED';
    expect(validateJudgeOutput(JSON.stringify(failedProbe), prepared)).toMatchObject({ valid: false, reason: expect.stringMatching(/probe|qualification/i) });
  });
});
