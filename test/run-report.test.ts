import { access, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FakeProvider } from '../src/runtime/fake.js';
import type { EvaluationProvider, ProviderRequest, ProviderResult } from '../src/runtime/provider.js';
import { buildReport, renderMarkdown, reportRun } from '../src/report/report.js';
import { runEvaluation } from '../src/run/run.js';
import { canonicalJson } from '../src/spec/canonical.js';
import { initializeEvaluation } from '../src/intake/init.js';
import { directAnswers, FIXED_DATE, makePackage, qualifiedJudgeOutput } from './helpers.js';

const completions = () => [
  { type: 'completion' as const, output: 'positive-ok', usage: { input: 10, cachedInput: 2, output: 3 } },
  { type: 'completion' as const, output: 'invalid-ok', usage: { input: 10, cachedInput: 2, output: 3 } },
  { type: 'completion' as const, output: 'boundary-ok', usage: { input: 10, cachedInput: 2, output: 3 } },
];

class InvalidUtf8Provider implements EvaluationProvider {
  readonly kind = 'fake' as const;
  readonly requiresAuthentication = false;
  calls = 0;

  constructor(private readonly finalOutput: string) {}

  async execute(request: ProviderRequest): Promise<ProviderResult> {
    this.calls += 1;
    if (request.workspace === undefined) throw new Error('workspace missing');
    await writeFile(path.join(request.workspace, 'invalid-utf8.txt'), Uint8Array.from([0xc3, 0x28]));
    return { status: 'completion', finalOutput: this.finalOutput, elapsedMs: 7, usage: { input: 2, cachedInput: 0, output: 1 } };
  }
}

describe('provider-bounded run and deterministic report', () => {
  it('completes direct evidence with three calls, does not call Terra, and reports separated evidence and unknown actual cost', async () => {
    const fixture = await makePackage();
    const provider = new FakeProvider(completions());
    const run = path.join(fixture.root, 'run');
    const result = await runEvaluation({ specPath: fixture.specPath, outDirectory: run, approveProviderCalls: '4', provider });
    expect(result.exitCode).toBe(0);
    expect(result.terminal).toMatchObject({ status: 'COMPLETED', recommendation: 'PROCEED', calls: { attempted: 3, retries: 0 }, cost: { actualChatGptCost: 'UNKNOWN' } });
    expect(provider.requests.map((request) => request.role)).toEqual(['candidate', 'candidate', 'candidate']);
    expect(provider.requests.map((request) => request.model)).toEqual(['gpt-5.6-luna', 'gpt-5.6-luna', 'gpt-5.6-luna']);
    await expect(access(path.join(run, 'judge-batch.json'))).rejects.toThrow();
    await expect(readFile(path.join(run, 'manifest.json'), 'utf8').then((bytes) => JSON.parse(bytes) as unknown)).resolves.toMatchObject({
      cliVersion: '0.4.0',
    });
    const report = await buildReport(run);
    expect(report.directObservations).toHaveLength(3);
    expect(report.semanticAssessments).toHaveLength(0);
    const markdown = renderMarkdown(report);
    expect(markdown).toContain('Actual ChatGPT cost: **UNKNOWN**');
    expect(markdown).toContain(canonicalJson(report));
    expect(await reportRun({ runDirectory: run, format: 'json' })).toContain('"recommendation": "PROCEED"');
  });

  it('executes and reports MARKDOWN_LINKS_TO without opening or requiring the linked destination', async () => {
    const fixture = await makePackage();
    const fixtureSource = path.join(fixture.root, 'markdown-fixture');
    await mkdir(fixtureSource);
    await writeFile(path.join(fixtureSource, 'README.md'), '[Guide](docs/guide.md?view=compact#start)\n');
    const answers = directAnswers();
    answers.cases[0].fixtureSource = fixtureSource;
    answers.cases[0].checks = [{
      id: 'readme-navigation', claimId: 'behavior', operator: 'MARKDOWN_LINKS_TO', path: 'README.md',
      destinations: ['docs/guide.md'], required: true, failureDecision: 'REVISE',
    }];
    const evaluation = path.join(fixture.root, 'evaluation-markdown-links');
    await initializeEvaluation({
      skillDirectory: fixture.skill,
      outDirectory: evaluation,
      answers,
      now: () => FIXED_DATE,
    });
    const run = path.join(fixture.root, 'run-markdown-links');
    const result = await runEvaluation({
      specPath: path.join(evaluation, 'evaluation-spec.json'),
      outDirectory: run,
      approveProviderCalls: '4',
      provider: new FakeProvider(completions()),
    });

    expect(result).toMatchObject({
      exitCode: 0,
      terminal: {
        status: 'COMPLETED', recommendation: 'PROCEED',
        directObservations: expect.arrayContaining([
          expect.objectContaining({ operator: 'MARKDOWN_LINKS_TO', passed: true }),
        ]),
      },
    });
    await expect(access(path.join(evaluation, 'fixtures', 'positive', 'docs', 'guide.md'))).rejects.toThrow();
    await expect(buildReport(run)).resolves.toMatchObject({
      decision: { recommendation: 'PROCEED' },
      directObservations: expect.arrayContaining([
        expect.objectContaining({ operator: 'MARKDOWN_LINKS_TO', passed: true }),
      ]),
    });
  });

  it.each(['04', '4.0', '4e0', '+4'])('rejects numerically equivalent authorization %s before reservation or any provider call', async (approval) => {
    const fixture = await makePackage();
    const provider = new FakeProvider(completions());
    const run = path.join(fixture.root, `run-invalid-approval-${approval.replaceAll('.', '-')}`);
    await expect(runEvaluation({ specPath: fixture.specPath, outDirectory: run, approveProviderCalls: approval, provider })).rejects.toMatchObject({ exitCode: 2 });
    expect(provider.requests).toHaveLength(0);
    await expect(access(run)).rejects.toThrow();
  });

  it('requires literal authorization and a new directory before any provider call', async () => {
    const fixture = await makePackage();
    const provider = new FakeProvider(completions());
    const run = path.join(fixture.root, 'run');
    await expect(runEvaluation({ specPath: fixture.specPath, outDirectory: run, approveProviderCalls: '3', provider })).rejects.toMatchObject({ exitCode: 2 });
    expect(provider.requests).toHaveLength(0);
    await mkdir(run);
    await expect(runEvaluation({ specPath: fixture.specPath, outDirectory: run, approveProviderCalls: '4', provider })).rejects.toMatchObject({ exitCode: 4 });
    expect(provider.requests).toHaveLength(0);
  });

  it('rejects missing real-provider authentication during preflight without reserving or calling', async () => {
    const fixture = await makePackage();
    let called = false;
    const provider: EvaluationProvider = {
      kind: 'promptfoo-codex',
      requiresAuthentication: true,
      execute: () => {
        called = true;
        return Promise.resolve({
          status: 'error' as const, errorKind: 'instrument' as const, elapsedMs: 0, message: 'must not execute',
        });
      },
    };
    const out = path.join(fixture.root, 'run-no-auth');
    await expect(runEvaluation({ specPath: fixture.specPath, outDirectory: out, approveProviderCalls: '4', provider })).rejects.toMatchObject({ exitCode: 2 });
    expect(called).toBe(false);
    await expect(access(out)).rejects.toThrow();
  });

  it.each([
    ['timeout', { type: 'timeout' as const, message: 'timeout' }, 'EXECUTION_TIMEOUT'],
    ['error', { type: 'error' as const, message: 'provider failed' }, 'PROVIDER_ERROR'],
  ])('debits one %s attempt and performs zero retries', async (_label, first, expectedStatus) => {
    const fixture = await makePackage();
    const provider = new FakeProvider([first, ...completions()]);
    const run = path.join(fixture.root, `run-${_label}`);
    const result = await runEvaluation({ specPath: fixture.specPath, outDirectory: run, approveProviderCalls: '4', provider });
    expect(result.exitCode).toBe(3);
    expect(result.terminal.status).toBe(expectedStatus);
    expect(result.terminal.calls).toMatchObject({ attempted: 1, retries: 0 });
    expect(provider.requests).toHaveLength(1);
    if (_label === 'error') {
      const events = (await readFile(path.join(run, 'case-results.jsonl'), 'utf8'))
        .trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(events.find((event) => event['event'] === 'CALL_RESULT')).toMatchObject({
        status: 'error', errorKind: 'provider', callNumber: 1,
      });
    }
  });

  it('classifies a candidate instrument error without retry and persists its origin for reporting', async () => {
    const fixture = await makePackage();
    const provider = new FakeProvider([{
      type: 'error', errorKind: 'instrument', message: 'local adapter shape failure',
    }, ...completions()]);
    const run = path.join(fixture.root, 'run-candidate-instrument-error');

    const result = await runEvaluation({
      specPath: fixture.specPath,
      outDirectory: run,
      approveProviderCalls: '4',
      provider,
    });

    expect(result).toMatchObject({
      exitCode: 3,
      terminal: {
        status: 'INSTRUMENT_INVALID', recommendation: 'NO_DECISION',
        calls: { attempted: 1, completed: 0, timeout: 0, error: 1, retries: 0 },
        cases: [expect.objectContaining({ status: 'INSTRUMENT_INVALID' })],
        suggestedAction: expect.stringMatching(/correct the evaluation instrument before creating/i),
      },
    });
    expect(provider.requests).toHaveLength(1);
    const events = (await readFile(path.join(run, 'case-results.jsonl'), 'utf8'))
      .trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events.find((event) => event['event'] === 'CALL_RESULT')).toMatchObject({
      status: 'error', errorKind: 'instrument', callNumber: 1,
    });
    await expect(buildReport(run)).resolves.toMatchObject({
      decision: { recommendation: 'NO_DECISION' },
      terminal: { status: 'INSTRUMENT_INVALID' },
      cases: [expect.objectContaining({ status: 'INSTRUMENT_INVALID' })],
      suggestedAction: expect.stringMatching(/correct the evaluation instrument before creating/i),
    });
  });

  it('preserves a direct critical failure, stops remaining calls, and never lets a judge override it', async () => {
    const fixture = await makePackage();
    const provider = new FakeProvider([{ type: 'completion', output: 'positive-ok' }, { type: 'completion', output: 'unsafe' }, ...completions()]);
    const result = await runEvaluation({ specPath: fixture.specPath, outDirectory: path.join(fixture.root, 'run-critical'), approveProviderCalls: '4', provider });
    expect(result.exitCode).toBe(0);
    expect(result.terminal).toMatchObject({ status: 'CRITICAL_VIOLATION', recommendation: 'DO_NOT_PROCEED', calls: { attempted: 2 } });
    expect(provider.requests).toHaveLength(2);
    expect(result.terminal.judgeQualification.attempted).toBe(false);
  });

  it('gives an observed direct DO_NOT_PROCEED violation precedence over another invalid check in the same case', async () => {
    const answers = directAnswers();
    answers.cases[0].checks = [
      {
        id: 'critical-direct', claimId: 'behavior', operator: 'FINAL_EQUALS', expected: 'positive-ok',
        required: true, failureDecision: 'DO_NOT_PROCEED',
      },
      {
        id: 'invalid-instrument', claimId: 'behavior', operator: 'FILE_CONTAINS', path: 'invalid-utf8.txt',
        fragments: ['expected'], required: true, failureDecision: 'REVISE',
      },
    ];
    const fixture = await makePackage(answers);
    const provider = new InvalidUtf8Provider('unsafe');
    const run = path.join(fixture.root, 'run-critical-precedence');
    const result = await runEvaluation({
      specPath: fixture.specPath,
      outDirectory: run,
      approveProviderCalls: '4',
      provider,
    });

    expect(result).toMatchObject({
      exitCode: 0,
      terminal: {
        status: 'CRITICAL_VIOLATION', recommendation: 'DO_NOT_PROCEED',
        calls: { attempted: 1, completed: 1, retries: 0 },
        judgeQualification: { attempted: false },
      },
    });
    expect(result.terminal.directObservations).toEqual([
      expect.objectContaining({
        checkId: 'critical-direct', status: 'APPLIED', passed: false, failureDecision: 'DO_NOT_PROCEED',
      }),
      expect.objectContaining({
        checkId: 'invalid-instrument', status: 'INSTRUMENT_INVALID', passed: false,
      }),
    ]);
    expect(result.terminal.claims).toEqual([expect.objectContaining({ status: 'NOT_SUPPORTED' })]);
    expect(provider.calls).toBe(1);
    await expect(buildReport(run)).resolves.toMatchObject({
      decision: { recommendation: 'DO_NOT_PROCEED' },
      terminal: { status: 'CRITICAL_VIOLATION' },
      directObservations: [
        expect.objectContaining({ checkId: 'critical-direct', status: 'APPLIED', passed: false }),
        expect.objectContaining({ checkId: 'invalid-instrument', status: 'INSTRUMENT_INVALID', passed: false }),
      ],
    });
  });

  it('preserves an observed required failure as REVISE with exit code zero', async () => {
    const fixture = await makePackage();
    const provider = new FakeProvider([{ type: 'completion', output: 'wrong-positive' }, ...completions()]);
    const result = await runEvaluation({
      specPath: fixture.specPath,
      outDirectory: path.join(fixture.root, 'run-revise'),
      approveProviderCalls: '4',
      provider,
    });
    expect(result).toMatchObject({
      exitCode: 0,
      terminal: { status: 'CRITICAL_VIOLATION', recommendation: 'REVISE', calls: { attempted: 1, retries: 0 } },
    });
    expect(result.terminal.directObservations).toEqual([
      expect.objectContaining({ checkId: 'positive-equals', status: 'APPLIED', passed: false }),
    ]);
    expect(result.terminal.judgeQualification.attempted).toBe(false);
    expect(provider.requests).toHaveLength(1);
  });

  it('spends exactly one Terra call for required semantics and qualifies all four opaque probes', async () => {
    const answers = directAnswers();
    answers.cases[0].semanticCriteria = [{ id: 'semantic-meaning', claimId: 'behavior', statement: 'The output conveys the requested meaning.', required: true }];
    const fixture = await makePackage(answers);
    const provider = new FakeProvider([...completions(), { type: 'completion', output: (request) => qualifiedJudgeOutput(request.prompt), usage: { input: 100, cachedInput: 0, output: 40 } }]);
    const result = await runEvaluation({ specPath: fixture.specPath, outDirectory: path.join(fixture.root, 'run-semantic'), approveProviderCalls: '4', provider });
    expect(result.terminal).toMatchObject({ status: 'COMPLETED', recommendation: 'PROCEED', calls: { attempted: 4 }, judgeQualification: { attempted: true, valid: true } });
    expect(provider.requests.map((request) => `${request.model}/${request.reasoningEffort}`)).toEqual([
      'gpt-5.6-luna/max', 'gpt-5.6-luna/max', 'gpt-5.6-luna/max', 'gpt-5.6-terra/xhigh',
    ]);
    const batch = JSON.parse(await readFile(path.join(fixture.root, 'run-semantic', 'judge-batch.json'), 'utf8')) as { items: Array<{ opaqueId: string }> };
    expect(batch.items).toHaveLength(7);
    expect(batch.items.every((item) => /^q-[a-f0-9]{16}$/.test(item.opaqueId))).toBe(true);
  });

  it('turns an invalid judge into NO_DECISION without retry or fallback while preserving direct evidence', async () => {
    const answers = directAnswers();
    answers.cases[0].semanticCriteria = [{ id: 'semantic-meaning', claimId: 'behavior', statement: 'The output conveys the requested meaning.', required: true }];
    const fixture = await makePackage(answers);
    const provider = new FakeProvider([...completions(), { type: 'completion', output: '{"schemaVersion":1,"items":[]}' }, { type: 'completion', output: 'fallback forbidden' }]);
    const result = await runEvaluation({ specPath: fixture.specPath, outDirectory: path.join(fixture.root, 'run-invalid-judge'), approveProviderCalls: '4', provider });
    expect(result.exitCode).toBe(3);
    expect(result.terminal).toMatchObject({ status: 'JUDGE_INVALID', recommendation: 'NO_DECISION', calls: { attempted: 4, retries: 0 }, judgeQualification: { valid: false } });
    expect(result.terminal.directObservations).toHaveLength(3);
    expect(provider.requests).toHaveLength(4);
  });

  it('classifies a judge instrument error as INSTRUMENT_INVALID after exactly one debited judge attempt', async () => {
    const answers = directAnswers();
    answers.cases[0].semanticCriteria = [{
      id: 'semantic-meaning', claimId: 'behavior',
      statement: 'The output conveys the requested meaning.', required: true,
    }];
    const fixture = await makePackage(answers);
    const provider = new FakeProvider([
      ...completions(),
      { type: 'error', errorKind: 'instrument', message: 'local judge adapter failure' },
      { type: 'completion', output: 'retry forbidden' },
    ]);
    const run = path.join(fixture.root, 'run-judge-instrument-error');

    const result = await runEvaluation({
      specPath: fixture.specPath, outDirectory: run, approveProviderCalls: '4', provider,
    });

    expect(result).toMatchObject({
      exitCode: 3,
      terminal: {
        status: 'INSTRUMENT_INVALID', recommendation: 'NO_DECISION',
        calls: { attempted: 4, completed: 3, timeout: 0, error: 1, retries: 0 },
        judgeQualification: { attempted: true, valid: false, summary: 'local judge adapter failure' },
        suggestedAction: expect.stringMatching(/correct the evaluation instrument before creating/i),
      },
    });
    expect(provider.requests).toHaveLength(4);
    expect(result.terminal.directObservations).toHaveLength(3);
    await expect(buildReport(run)).resolves.toMatchObject({
      terminal: { status: 'INSTRUMENT_INVALID' },
      decision: { recommendation: 'NO_DECISION' },
      calls: { attempted: 4, error: 1, retries: 0 },
    });
  });

  it('keeps absent activation telemetry NOT_ASSESSED rather than treating heuristic absence as proof', async () => {
    const answers = directAnswers();
    answers.claims = [{ id: 'activation', statement: 'The target activates when required.', kind: 'ACTIVATION', required: true, failureDecision: 'REVISE' }];
    for (const item of answers.cases) {
      item.claimIds = ['activation']; item.checks = []; item.semanticCriteria = [];
      item.activationExpectation = item.kind === 'POSITIVE' ? 'MUST_ACTIVATE' : 'NOT_ASSERTED';
    }
    const fixture = await makePackage(answers);
    const provider = new FakeProvider([{ type: 'completion', output: 'one' }, { type: 'completion', output: 'two' }, { type: 'completion', output: 'three' }]);
    const result = await runEvaluation({ specPath: fixture.specPath, outDirectory: path.join(fixture.root, 'run-activation'), approveProviderCalls: '4', provider });
    expect(result.terminal.recommendation).toBe('NO_DECISION');
    expect(result.terminal.claims[0]).toMatchObject({ status: 'NOT_ASSESSED' });
  });

  it('constructs each candidate workspace with only the target skill and permitted fixture', async () => {
    const fixture = await makePackage();
    const fixtureSource = path.join(fixture.root, 'positive-fixture');
    await mkdir(fixtureSource);
    await writeFile(path.join(fixtureSource, 'input.txt'), 'permitted fixture');
    const answers = directAnswers();
    answers.cases[0].fixtureSource = fixtureSource;
    const evaluationWithFixture = path.join(fixture.root, 'evaluation-with-fixture');
    await initializeEvaluation({
      skillDirectory: fixture.skill,
      outDirectory: evaluationWithFixture,
      answers,
      now: () => FIXED_DATE,
    });
    const observed: string[][] = [];
    class InspectingProvider implements EvaluationProvider {
      readonly kind = 'fake' as const;
      readonly requiresAuthentication = false;
      private index = 0;
      async execute(request: ProviderRequest): Promise<ProviderResult> {
        if (request.workspace === undefined) throw new Error('workspace missing');
        observed.push((await readdir(request.workspace)).sort());
        const skills = await readdir(path.join(request.workspace, '.agents', 'skills'));
        expect(skills).toEqual(['sample-skill']);
        return { status: 'completion', finalOutput: ['positive-ok', 'invalid-ok', 'boundary-ok'][this.index++]!, elapsedMs: 1 };
      }
    }
    await runEvaluation({ specPath: path.join(evaluationWithFixture, 'evaluation-spec.json'), outDirectory: path.join(fixture.root, 'run-isolation'), approveProviderCalls: '4', provider: new InspectingProvider() });
    expect(observed).toEqual([['.agents', 'input.txt'], ['.agents'], ['.agents']]);
  });

  it('copies only fake auth into a temporary Codex home and cleans it on completion', async () => {
    const fixture = await makePackage();
    const sourceHome = path.join(fixture.root, 'fake-codex-home');
    await mkdir(sourceHome);
    await writeFile(path.join(sourceHome, 'auth.json'), '{"fake":"auth-fixture"}\n');
    await writeFile(path.join(sourceHome, 'config.toml'), 'must-not-copy');
    const temporaryHomes: string[] = [];
    class AuthInspectingProvider implements EvaluationProvider {
      readonly kind = 'fake' as const;
      readonly requiresAuthentication = true;
      private index = 0;
      async execute(request: ProviderRequest): Promise<ProviderResult> {
        if (request.codexHome === undefined) throw new Error('codex home missing');
        temporaryHomes.push(request.codexHome);
        expect(await readdir(request.codexHome)).toEqual(['auth.json']);
        return { status: 'completion', finalOutput: ['positive-ok', 'invalid-ok', 'boundary-ok'][this.index++]!, elapsedMs: 1 };
      }
    }
    await runEvaluation({ specPath: fixture.specPath, outDirectory: path.join(fixture.root, 'run-auth'), approveProviderCalls: '4', provider: new AuthInspectingProvider(), codexHomeSource: sourceHome });
    expect(new Set(temporaryHomes).size).toBe(1);
    await expect(access(temporaryHomes[0]!)).rejects.toThrow();
  });

  it('cleans temporary authentication after a captured provider error', async () => {
    const fixture = await makePackage();
    const sourceHome = path.join(fixture.root, 'error-codex-home');
    await mkdir(sourceHome);
    await writeFile(path.join(sourceHome, 'auth.json'), '{"fake":"auth-fixture"}\n');
    let temporaryHome: string | undefined;
    const provider: EvaluationProvider = {
      kind: 'fake',
      requiresAuthentication: true,
      execute: (request) => {
        temporaryHome = request.codexHome;
        return Promise.resolve({
          status: 'error' as const, errorKind: 'provider' as const, elapsedMs: 1, message: 'captured deterministic error',
        });
      },
    };
    const result = await runEvaluation({ specPath: fixture.specPath, outDirectory: path.join(fixture.root, 'run-auth-error'), approveProviderCalls: '4', provider, codexHomeSource: sourceHome });
    expect(result).toMatchObject({ exitCode: 3, terminal: { status: 'PROVIDER_ERROR' } });
    expect(temporaryHome).toBeDefined();
    await expect(access(temporaryHome!)).rejects.toThrow();
  });

  it('never persists credential-shaped provider output', async () => {
    const fixture = await makePackage();
    const secret = 'sk-abcdefghijklmnop1234567890';
    const run = path.join(fixture.root, 'run-secret');
    const result = await runEvaluation({
      specPath: fixture.specPath, outDirectory: run, approveProviderCalls: '4',
      provider: new FakeProvider([{ type: 'completion', output: `leaked ${secret}` }]),
    });
    expect(result).toMatchObject({ exitCode: 3, terminal: { status: 'ENVIRONMENT_FAILURE', recommendation: 'NO_DECISION' } });
    const names = await readdir(run, { recursive: true });
    for (const name of names) {
      const target = path.join(run, name);
      const details = await (await import('node:fs/promises')).lstat(target);
      if (details.isFile()) expect(await readFile(target, 'utf8')).not.toContain(secret);
    }
  });

  it('rejects a symlink introduced by a provider and never follows it', async () => {
    const fixture = await makePackage();
    class SymlinkProvider implements EvaluationProvider {
      readonly kind = 'fake' as const;
      readonly requiresAuthentication = false;
      async execute(request: ProviderRequest): Promise<ProviderResult> {
        if (request.workspace === undefined) throw new Error('workspace missing');
        await symlink('/etc/passwd', path.join(request.workspace, 'escaped-link'));
        return { status: 'completion', finalOutput: 'positive-ok', elapsedMs: 1 };
      }
    }
    const result = await runEvaluation({ specPath: fixture.specPath, outDirectory: path.join(fixture.root, 'run-symlink'), approveProviderCalls: '4', provider: new SymlinkProvider() });
    expect(result).toMatchObject({ exitCode: 3, terminal: { status: 'ENVIRONMENT_FAILURE', calls: { attempted: 1, retries: 0 } } });
  });

  it('keeps an unavailable DO_NOT_PROCEED check INSTRUMENT_INVALID without treating it as an observed violation', async () => {
    const answers = directAnswers();
    answers.cases[0].checks = [{
      id: 'utf8-check', claimId: 'behavior', operator: 'FILE_CONTAINS', path: 'invalid-utf8.txt',
      fragments: ['expected'], required: true, failureDecision: 'DO_NOT_PROCEED',
    }];
    const fixture = await makePackage(answers);
    const provider = new InvalidUtf8Provider('positive-ok');
    const result = await runEvaluation({
      specPath: fixture.specPath,
      outDirectory: path.join(fixture.root, 'run-instrument-invalid'),
      approveProviderCalls: '4',
      provider,
    });
    expect(result).toMatchObject({
      exitCode: 3,
      terminal: {
        status: 'INSTRUMENT_INVALID', recommendation: 'NO_DECISION',
        calls: { attempted: 1, completed: 1, retries: 0 },
        judgeQualification: { attempted: false },
      },
    });
    expect(result.terminal.directObservations).toEqual([
      expect.objectContaining({
        checkId: 'utf8-check', status: 'INSTRUMENT_INVALID', passed: false,
        observation: expect.stringMatching(/^Check could not be applied:/),
      }),
    ]);
    expect(result.terminal.claims).toEqual([expect.objectContaining({ status: 'NOT_ASSESSED' })]);
    expect(provider.calls).toBe(1);
  });

  it('reports an interrupted directory as NO_DECISION and never resumes it', async () => {
    const fixture = await makePackage();
    const run = path.join(fixture.root, 'run-interrupted');
    await runEvaluation({ specPath: fixture.specPath, outDirectory: run, approveProviderCalls: '4', provider: new FakeProvider(completions()) });
    await rm(path.join(run, 'terminal.json'));
    const report = await buildReport(run);
    expect(report).toMatchObject({
      decision: { recommendation: 'NO_DECISION' },
      terminal: { status: 'INTERRUPTED_UNCONFIRMED' },
      calls: {
        attempted: 3,
        completed: 3,
        timeout: 0,
        error: 0,
        wallTimeMs: 3,
        usage: { input: 30, cachedInput: 6, output: 9 },
      },
      cost: { apiEquivalentEstimateUsd: 0.00001572 },
    });
    expect(report.cases).toHaveLength(3);
    expect(report.directObservations).toHaveLength(3);
    expect(report.claims).toEqual([expect.objectContaining({ claimId: 'behavior', status: 'SUPPORTED' })]);
    const events = (await readFile(path.join(run, 'case-results.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { event: string });
    expect(events.map((event) => event.event)).toEqual([
      'CALL_ATTEMPTED', 'CALL_RESULT', 'CASE_RESULT',
      'CALL_ATTEMPTED', 'CALL_RESULT', 'CASE_RESULT',
      'CALL_ATTEMPTED', 'CALL_RESULT', 'CASE_RESULT',
    ]);
    const nextProvider = new FakeProvider(completions());
    await expect(runEvaluation({ specPath: fixture.specPath, outDirectory: run, approveProviderCalls: '4', provider: nextProvider })).rejects.toMatchObject({ exitCode: 4 });
    expect(nextProvider.requests).toHaveLength(0);
  });

  it('keeps a 0.2.0 file-fragment observation readable in a legacy run report', async () => {
    const answers = directAnswers();
    answers.cases[0].checks = [{
      id: 'legacy-file-fragment', claimId: 'behavior', operator: 'FILE_CONTAINS',
      path: '.agents/skills/sample-skill/SKILL.md', fragments: ['not-present'],
      required: true, failureDecision: 'REVISE',
    }];
    const fixture = await makePackage(answers);
    const run = path.join(fixture.root, 'run-legacy-fragment-observation');
    await runEvaluation({
      specPath: fixture.specPath,
      outDirectory: run,
      approveProviderCalls: '4',
      provider: new FakeProvider([{ type: 'completion', output: 'positive-ok' }]),
    });

    const legacyObservation = 'File fragment contract is violated';
    const eventsPath = path.join(run, 'case-results.jsonl');
    const events = (await readFile(eventsPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    const caseEvent = events.find((event) => event['event'] === 'CASE_RESULT') as { checks?: Array<{ observation: string }> } | undefined;
    if (caseEvent?.checks?.[0] === undefined) throw new Error('Expected legacy case check evidence');
    caseEvent.checks[0].observation = legacyObservation;
    await writeFile(eventsPath, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);

    const terminalPath = path.join(run, 'terminal.json');
    const terminal = JSON.parse(await readFile(terminalPath, 'utf8')) as {
      cases: Array<{ checks: Array<{ observation: string }> }>;
      directObservations: Array<{ observation: string }>;
    };
    terminal.cases[0]!.checks[0]!.observation = legacyObservation;
    terminal.directObservations[0]!.observation = legacyObservation;
    await writeFile(terminalPath, canonicalJson(terminal));

    await expect(buildReport(run)).resolves.toMatchObject({
      directObservations: [expect.objectContaining({
        checkId: 'legacy-file-fragment',
        observation: legacyObservation,
      })],
    });
  });

  it('accepts legacy provider-error events without errorKind and preserves their historical terminal classification', async () => {
    const fixture = await makePackage();
    const run = path.join(fixture.root, 'run-legacy-provider-error');
    await runEvaluation({
      specPath: fixture.specPath,
      outDirectory: run,
      approveProviderCalls: '4',
      provider: new FakeProvider([{ type: 'error', message: 'historical provider error' }]),
    });

    const eventsPath = path.join(run, 'case-results.jsonl');
    const events = (await readFile(eventsPath, 'utf8')).trim().split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    for (const event of events) {
      if (event['event'] === 'CALL_RESULT') delete event['errorKind'];
    }
    await writeFile(eventsPath, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);

    await expect(buildReport(run)).resolves.toMatchObject({
      terminal: { status: 'PROVIDER_ERROR' },
      decision: { recommendation: 'NO_DECISION' },
      cases: [expect.objectContaining({ status: 'PROVIDER_ERROR' })],
      calls: { attempted: 1, error: 1, retries: 0 },
    });
  });

  it('anchors persisted timestamps to monotonic progress and reports material civil-clock adjustments without changing the decision', async () => {
    const fixture = await makePackage();
    const anchor = Date.parse('2026-08-15T12:00:00.000Z');
    let wallMs = anchor;
    let monotonicMs = 10_000;
    let call = 0;
    const provider: EvaluationProvider = {
      kind: 'fake',
      requiresAuthentication: false,
      execute: () => {
        call += 1;
        monotonicMs += 1_000;
        if (call === 2) wallMs += 31_000;
        else if (call === 3) wallMs = anchor + monotonicMs - 10_000;
        else wallMs += 1_000;
        return Promise.resolve({
          status: 'completion' as const,
          finalOutput: ['positive-ok', 'invalid-ok', 'boundary-ok'][call - 1]!,
          elapsedMs: 1_000,
        });
      },
    };
    const run = path.join(fixture.root, 'run-clock-adjustment');
    const result = await runEvaluation({
      specPath: fixture.specPath,
      outDirectory: run,
      approveProviderCalls: '4',
      provider,
      clock: { wallNowMs: () => wallMs, monotonicNowMs: () => monotonicMs },
    });

    expect(result.terminal).toMatchObject({ status: 'COMPLETED', recommendation: 'PROCEED' });
    expect(result.terminal.limitations).toContainEqual(expect.stringMatching(/Wall clock adjustments.*30000 ms.*monotonic/i));
    const events = (await readFile(path.join(run, 'case-results.jsonl'), 'utf8'))
      .trim().split('\n').map((line) => JSON.parse(line) as { event: string; at?: string });
    const timestamps = events.flatMap((event) => event.at === undefined ? [] : [Date.parse(event.at)]);
    expect(timestamps.every((value, index) => index === 0 || value >= timestamps[index - 1]!)).toBe(true);
    expect(Date.parse(result.terminal.completedAt)).toBeGreaterThanOrEqual(timestamps.at(-1)!);
    const report = await buildReport(run);
    expect(report.limitations).toEqual(result.terminal.limitations);
    expect(renderMarkdown(report)).toMatch(/Wall clock adjustments.*30000 ms.*monotonic/i);
  });

  it('keeps append order authoritative when a historical civil timestamp regresses', async () => {
    const fixture = await makePackage();
    const run = path.join(fixture.root, 'run-legacy-clock-regression');
    await runEvaluation({ specPath: fixture.specPath, outDirectory: run, approveProviderCalls: '4', provider: new FakeProvider(completions()) });
    const eventPath = path.join(run, 'case-results.jsonl');
    const events = (await readFile(eventPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    const thirdAttempt = events.find((event) => event['event'] === 'CALL_ATTEMPTED' && event['callNumber'] === 3);
    const thirdResult = events.find((event) => event['event'] === 'CALL_RESULT' && event['callNumber'] === 3);
    if (thirdAttempt === undefined || thirdResult === undefined) throw new Error('Expected third call accounting events');
    thirdAttempt['at'] = '2026-08-15T12:00:30.000Z';
    thirdResult['at'] = '2026-08-15T12:00:15.000Z';
    await writeFile(eventPath, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);

    await expect(buildReport(run)).resolves.toMatchObject({
      decision: { recommendation: 'PROCEED' },
      calls: { attempted: 3, completed: 3 },
    });
  });

  it('rejects a non-ISO accounting timestamp as corrupt evidence', async () => {
    const fixture = await makePackage();
    const run = path.join(fixture.root, 'run-invalid-timestamp');
    await runEvaluation({ specPath: fixture.specPath, outDirectory: run, approveProviderCalls: '4', provider: new FakeProvider(completions()) });
    const eventPath = path.join(run, 'case-results.jsonl');
    const events = (await readFile(eventPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    const firstAttempt = events.find((event) => event['event'] === 'CALL_ATTEMPTED');
    if (firstAttempt === undefined) throw new Error('Expected a call attempt');
    firstAttempt['at'] = 'not-an-iso-timestamp';
    await writeFile(eventPath, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);

    await expect(buildReport(run)).rejects.toMatchObject({ exitCode: 4 });
  });

  it('refuses to overwrite an existing report file', async () => {
    const fixture = await makePackage();
    const run = path.join(fixture.root, 'run-report');
    await runEvaluation({ specPath: fixture.specPath, outDirectory: run, approveProviderCalls: '4', provider: new FakeProvider(completions()) });
    const out = path.join(fixture.root, 'report.json');
    await writeFile(out, 'existing');
    await expect(reportRun({ runDirectory: run, format: 'json', outFile: out })).rejects.toMatchObject({ exitCode: 4 });
    expect(await readFile(out, 'utf8')).toBe('existing');
  });

  it('rejects canonical-looking terminal tampering as run corruption', async () => {
    const fixture = await makePackage();
    const run = path.join(fixture.root, 'run-tampered');
    await runEvaluation({ specPath: fixture.specPath, outDirectory: run, approveProviderCalls: '4', provider: new FakeProvider(completions()) });
    const terminalPath = path.join(run, 'terminal.json');
    const terminal = JSON.parse(await readFile(terminalPath, 'utf8')) as { calls: { attempted: number } };
    terminal.calls.attempted = 4;
    await writeFile(terminalPath, canonicalJson(terminal));
    await expect(buildReport(run)).rejects.toMatchObject({ exitCode: 4 });
  });
});
