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
    const report = await buildReport(run);
    expect(report.directObservations).toHaveLength(3);
    expect(report.semanticAssessments).toHaveLength(0);
    const markdown = renderMarkdown(report);
    expect(markdown).toContain('Actual ChatGPT cost: **UNKNOWN**');
    expect(markdown).toContain(canonicalJson(report));
    expect(await reportRun({ runDirectory: run, format: 'json' })).toContain('"recommendation": "PROCEED"');
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
        return Promise.resolve({ status: 'error' as const, elapsedMs: 0, message: 'must not execute' });
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
    const result = await runEvaluation({ specPath: fixture.specPath, outDirectory: path.join(fixture.root, `run-${_label}`), approveProviderCalls: '4', provider });
    expect(result.exitCode).toBe(3);
    expect(result.terminal.status).toBe(expectedStatus);
    expect(result.terminal.calls).toMatchObject({ attempted: 1, retries: 0 });
    expect(provider.requests).toHaveLength(1);
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
        return Promise.resolve({ status: 'error' as const, elapsedMs: 1, message: 'captured deterministic error' });
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

  it('classifies a check application error as INSTRUMENT_INVALID without judge or retry and preserves the sanitized observation', async () => {
    const answers = directAnswers();
    answers.cases[0].checks = [{
      id: 'utf8-check', claimId: 'behavior', operator: 'FILE_CONTAINS', path: 'invalid-utf8.txt',
      fragments: ['expected'], required: true, failureDecision: 'REVISE',
    }];
    const fixture = await makePackage(answers);
    class InvalidUtf8Provider implements EvaluationProvider {
      readonly kind = 'fake' as const;
      readonly requiresAuthentication = false;
      calls = 0;
      async execute(request: ProviderRequest): Promise<ProviderResult> {
        this.calls += 1;
        if (request.workspace === undefined) throw new Error('workspace missing');
        await writeFile(path.join(request.workspace, 'invalid-utf8.txt'), Uint8Array.from([0xc3, 0x28]));
        return { status: 'completion', finalOutput: 'positive-ok', elapsedMs: 7, usage: { input: 2, cachedInput: 0, output: 1 } };
      }
    }
    const provider = new InvalidUtf8Provider();
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
