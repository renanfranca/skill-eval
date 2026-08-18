import { access, chmod, lstat, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { initializeEvaluation } from '../src/intake/init.js';
import { scanTree } from '../src/intake/tree.js';
import { runActivationProbe } from '../src/probe/probe.js';
import type { EvaluationProvider, ProviderRequest, ProviderResult } from '../src/runtime/provider.js';
import { canonicalJson } from '../src/spec/canonical.js';
import { checkEvaluationPackage } from '../src/spec/validate.js';
import { directAnswers, FIXED_DATE, makePackage } from './helpers.js';

const MARKER_PATTERN = /🔧\[skill-eval:([a-f0-9]{32})\]/g;

type ProbeStep = 'marker' | 'missing' | 'timeout' | 'error' | 'unsafe-symlink';

class WorkspaceProbeProvider implements EvaluationProvider {
  readonly kind = 'fake' as const;
  readonly requiresAuthentication = false;
  readonly requests: ProviderRequest[] = [];
  readonly markers: string[] = [];
  readonly workspacePaths: string[] = [];
  readonly skillMdModes: number[] = [];
  private cursor = 0;

  constructor(private readonly steps: ProbeStep[]) {}

  async execute(request: ProviderRequest): Promise<ProviderResult> {
    this.requests.push(structuredClone(request));
    if (request.workspace === undefined) throw new Error('Probe workspace missing');
    this.workspacePaths.push(request.workspace);
    const skillMdPath = path.join(request.workspace, '.agents', 'skills', 'sample-skill', 'SKILL.md');
    const skillMd = await readFile(skillMdPath, 'utf8');
    this.skillMdModes.push((await lstat(skillMdPath)).mode & 0o777);
    const markers = [...skillMd.matchAll(MARKER_PATTERN)].map((match) => match[0]);
    expect(markers).toHaveLength(1);
    const marker = markers[0]!;
    this.markers.push(marker);
    expect(request.prompt).not.toContain(marker);
    expect(skillMd).toContain('## Activation probe (evaluation-only)');
    expect(skillMd).toContain(`append exactly \`${marker}\` as the final line`);

    const step = this.steps[this.cursor++] ?? 'error';
    if (step === 'timeout') return { status: 'timeout', elapsedMs: 600_000, message: 'deterministic timeout' };
    if (step === 'error') return { status: 'error', elapsedMs: 2, message: 'deterministic provider error' };
    if (step === 'unsafe-symlink') {
      await symlink('/etc/passwd', path.join(request.workspace, 'unsafe-link'));
      return { status: 'completion', finalOutput: marker, elapsedMs: 3 };
    }
    return {
      status: 'completion',
      finalOutput: step === 'marker' ? `case output\n${marker}` : 'case output without activation marker',
      elapsedMs: 3,
      usage: { input: 10, cachedInput: 2, output: 3 },
      promptfooProjection: { provider: 'fake', probeStep: this.cursor },
    };
  }
}

async function json<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, 'utf8')) as T;
}

describe('activation probe', () => {
  it('confirms three isolated Luna/max exposures and persists a separate auditable artifact', async () => {
    const fixture = await makePackage();
    const originalSpec = await readFile(fixture.specPath);
    const originalSkill = await readFile(path.join(fixture.evaluation, 'skill-snapshot', 'SKILL.md'));
    const provider = new WorkspaceProbeProvider(['marker', 'marker', 'marker']);
    const out = path.join(fixture.root, 'probe-confirmed');

    const result = await runActivationProbe({
      specPath: fixture.specPath,
      outDirectory: out,
      approveProviderCalls: '3',
      provider,
    });

    expect(result).toMatchObject({
      exitCode: 0,
      terminal: {
        status: 'CONFIRMED',
        calls: { authorized: 3, attempted: 3, completed: 3, timeout: 0, error: 0, maximum: 3, retries: 0 },
        cost: { actualChatGptCost: 'UNKNOWN', apiEquivalentEstimateUsd: 0.00001572 },
      },
    });
    expect(provider.requests.map((request) => `${request.role}/${request.model}/${request.reasoningEffort}`)).toEqual([
      'candidate/gpt-5.6-luna/max',
      'candidate/gpt-5.6-luna/max',
      'candidate/gpt-5.6-luna/max',
    ]);
    expect(provider.requests.map((request) => request.prompt)).toEqual(['positive prompt', 'invalid prompt', 'boundary prompt']);
    expect(new Set(provider.markers).size).toBe(3);
    expect(provider.markers.every((marker) => /^🔧\[skill-eval:[a-f0-9]{32}\]$/.test(marker))).toBe(true);

    const manifest = await json<{
      cliVersion: string;
      callsAuthorized: number;
      digests: { spec: string; skillBase: string; fixtures: Record<string, string> };
      condition: { model: string; reasoningEffort: string; maximumCalls: number; timeoutSeconds: number; retries: number };
    }>(path.join(out, 'manifest.json'));
    expect(manifest).toMatchObject({
      cliVersion: '0.3.0',
      callsAuthorized: 3,
      digests: { skillBase: expect.stringMatching(/^sha256:/) },
      condition: { model: 'gpt-5.6-luna', reasoningEffort: 'max', maximumCalls: 3, timeoutSeconds: 600, retries: 0 },
    });
    expect(Object.keys(manifest.digests.fixtures)).toEqual(['boundary-case', 'invalid-case', 'positive-case']);

    const events = (await readFile(path.join(out, 'probe-results.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events.map((event) => event['event'])).toEqual([
      'CALL_ATTEMPTED', 'PROBE_RESULT',
      'CALL_ATTEMPTED', 'PROBE_RESULT',
      'CALL_ATTEMPTED', 'PROBE_RESULT',
    ]);
    const records = events.filter((event) => event['event'] === 'PROBE_RESULT');
    expect(records).toHaveLength(3);
    for (const record of records) {
      expect(record).toMatchObject({
        status: 'COMPLETED', markerPresent: true,
        baseSkillDigest: manifest.digests.skillBase,
        instrumentedSkillDigest: expect.stringMatching(/^sha256:/),
        finalOutputRef: expect.stringMatching(/^evidence\/final-outputs\/.+\.txt$/),
        promptfooProjectionRef: expect.stringMatching(/^evidence\/promptfoo-projections\/.+\.json$/),
      });
      expect(record['instrumentedSkillDigest']).not.toBe(record['baseSkillDigest']);
    }
    expect((await readdir(path.join(out, 'evidence', 'final-outputs'))).sort()).toEqual(['boundary-case.txt', 'invalid-case.txt', 'positive-case.txt']);
    expect((await readdir(path.join(out, 'evidence', 'promptfoo-projections'))).sort()).toEqual(['boundary-case.json', 'invalid-case.json', 'positive-case.json']);

    expect(await readFile(fixture.specPath)).toEqual(originalSpec);
    expect(await readFile(path.join(fixture.evaluation, 'skill-snapshot', 'SKILL.md'))).toEqual(originalSkill);
    for (const workspace of provider.workspacePaths) await expect(access(workspace)).rejects.toThrow();
  });

  it('returns NOT_CONFIRMED and still attempts later cases after a completed response without a marker and a provider error', async () => {
    const fixture = await makePackage();
    const provider = new WorkspaceProbeProvider(['missing', 'error', 'marker']);
    const result = await runActivationProbe({
      specPath: fixture.specPath,
      outDirectory: path.join(fixture.root, 'probe-not-confirmed'),
      approveProviderCalls: '3',
      provider,
    });

    expect(result).toMatchObject({
      exitCode: 0,
      terminal: {
        status: 'NOT_CONFIRMED',
        calls: { attempted: 3, completed: 2, timeout: 0, error: 1, retries: 0 },
        stoppingRule: expect.stringMatching(/completed response.*marker/i),
      },
    });
    expect(provider.requests).toHaveLength(3);
  });

  it('returns INCONCLUSIVE after a timeout when every accepted completion contains its marker, while spending all three safe attempts', async () => {
    const fixture = await makePackage();
    const provider = new WorkspaceProbeProvider(['marker', 'timeout', 'marker']);
    const result = await runActivationProbe({
      specPath: fixture.specPath,
      outDirectory: path.join(fixture.root, 'probe-inconclusive'),
      approveProviderCalls: '3',
      provider,
    });

    expect(result).toMatchObject({
      exitCode: 3,
      terminal: { status: 'INCONCLUSIVE', calls: { attempted: 3, completed: 2, timeout: 1, error: 0, retries: 0 } },
    });
    expect(provider.requests).toHaveLength(3);
  });

  it('stops after an unsafe workspace state and classifies the partial evidence as inconclusive', async () => {
    const fixture = await makePackage();
    const provider = new WorkspaceProbeProvider(['unsafe-symlink', 'marker', 'marker']);
    const out = path.join(fixture.root, 'probe-unsafe');
    const result = await runActivationProbe({
      specPath: fixture.specPath,
      outDirectory: out,
      approveProviderCalls: '3',
      provider,
    });

    expect(result).toMatchObject({
      exitCode: 3,
      terminal: {
        status: 'INCONCLUSIVE',
        calls: { attempted: 1, completed: 1 },
        stoppingRule: expect.stringMatching(/unsafe|environment|integrity/i),
      },
    });
    expect(provider.requests).toHaveLength(1);
    const contents = await Promise.all((await readdir(out, { recursive: true })).map(async (entry) => {
      const target = path.join(out, entry);
      return (await lstat(target)).isFile() ? readFile(target, 'utf8') : '';
    }));
    expect(contents.join('\n')).not.toContain('/etc/passwd');
  });

  it('rejects non-literal authorization and existing output before any provider call', async () => {
    const fixture = await makePackage();
    const provider = new WorkspaceProbeProvider(['marker', 'marker', 'marker']);
    const unauthorizedOut = path.join(fixture.root, 'probe-unauthorized');
    await expect(runActivationProbe({
      specPath: path.join(fixture.root, 'must-not-be-read.json'),
      outDirectory: unauthorizedOut,
      approveProviderCalls: '03',
      provider,
    })).rejects.toMatchObject({ exitCode: 2 });
    await expect(access(unauthorizedOut)).rejects.toThrow();

    const existing = path.join(fixture.root, 'existing-probe');
    await mkdir(existing);
    await writeFile(path.join(existing, 'sentinel.txt'), 'preserve');
    await expect(runActivationProbe({
      specPath: fixture.specPath,
      outDirectory: existing,
      approveProviderCalls: '3',
      provider,
    })).rejects.toMatchObject({ exitCode: 4 });
    expect(await readFile(path.join(existing, 'sentinel.txt'), 'utf8')).toBe('preserve');
    expect(provider.requests).toHaveLength(0);
  });

  it('rejects output inside the frozen evaluation package without modifying it or calling the provider', async () => {
    const fixture = await makePackage();
    const provider = new WorkspaceProbeProvider(['marker', 'marker', 'marker']);
    const packageBefore = await scanTree(fixture.evaluation);
    const originalSpec = await readFile(fixture.specPath);
    const out = path.join(fixture.evaluation, 'skill-snapshot', 'probe-output');

    await expect(runActivationProbe({
      specPath: fixture.specPath,
      outDirectory: out,
      approveProviderCalls: '3',
      provider,
    })).rejects.toMatchObject({ exitCode: 4 });

    expect(provider.requests).toHaveLength(0);
    await expect(access(out)).rejects.toThrow();
    expect(await readFile(fixture.specPath)).toEqual(originalSpec);
    expect((await scanTree(fixture.evaluation)).digest).toBe(packageBefore.digest);
    await expect(checkEvaluationPackage(fixture.specPath)).resolves.toMatchObject({ evaluationId: 'evaluation-test' });
  });

  it('instruments a read-only temporary SKILL.md and restores its frozen mode before provider execution', async () => {
    const fixture = await makePackage();
    const sourceSkillMd = path.join(fixture.skill, 'SKILL.md');
    await chmod(sourceSkillMd, 0o444);
    const sourceBytes = await readFile(sourceSkillMd);
    const evaluation = path.join(fixture.root, 'evaluation-read-only');
    await initializeEvaluation({
      skillDirectory: fixture.skill,
      outDirectory: evaluation,
      answers: directAnswers(),
      now: () => FIXED_DATE,
    });
    const specPath = path.join(evaluation, 'evaluation-spec.json');
    const snapshotSkillMd = path.join(evaluation, 'skill-snapshot', 'SKILL.md');
    const snapshotBytes = await readFile(snapshotSkillMd);
    await expect(checkEvaluationPackage(specPath)).resolves.toMatchObject({ evaluationId: 'evaluation-test' });

    const provider = new WorkspaceProbeProvider(['marker', 'marker', 'marker']);
    const result = await runActivationProbe({
      specPath,
      outDirectory: path.join(fixture.root, 'probe-read-only'),
      approveProviderCalls: '3',
      provider,
    });

    expect(result).toMatchObject({
      exitCode: 0,
      terminal: { status: 'CONFIRMED', calls: { attempted: 3, completed: 3, timeout: 0, error: 0 } },
    });
    expect(provider.requests.map((request) => `${request.role}/${request.model}/${request.reasoningEffort}`)).toEqual([
      'candidate/gpt-5.6-luna/max',
      'candidate/gpt-5.6-luna/max',
      'candidate/gpt-5.6-luna/max',
    ]);
    if (process.platform !== 'win32') {
      expect(provider.skillMdModes).toEqual([0o444, 0o444, 0o444]);
      expect((await lstat(sourceSkillMd)).mode & 0o777).toBe(0o444);
      expect((await lstat(snapshotSkillMd)).mode & 0o777).toBe(0o444);
    }
    expect(await readFile(sourceSkillMd)).toEqual(sourceBytes);
    expect(await readFile(snapshotSkillMd)).toEqual(snapshotBytes);
    await expect(checkEvaluationPackage(specPath)).resolves.toMatchObject({ evaluationId: 'evaluation-test' });
    for (const workspace of provider.workspacePaths) await expect(access(workspace)).rejects.toThrow();
  });

  it('writes canonical terminal JSON and does not expose the frozen spec as a mutable copy', async () => {
    const fixture = await makePackage();
    const out = path.join(fixture.root, 'probe-canonical');
    await runActivationProbe({
      specPath: fixture.specPath,
      outDirectory: out,
      approveProviderCalls: '3',
      provider: new WorkspaceProbeProvider(['marker', 'marker', 'marker']),
    });
    const terminalBytes = await readFile(path.join(out, 'terminal.json'), 'utf8');
    expect(terminalBytes).toBe(canonicalJson(JSON.parse(terminalBytes) as unknown));
    await expect(access(path.join(out, 'evaluation-spec.json'))).rejects.toThrow();
  });

  it('preserves a non-empty frozen fixture and keeps the marker out of the provider prompt and fixture', async () => {
    const fixture = await makePackage();
    const fixtureSource = path.join(fixture.root, 'positive-fixture-source');
    await mkdir(fixtureSource);
    await writeFile(path.join(fixtureSource, 'input.txt'), 'frozen fixture bytes');
    const answers = directAnswers();
    answers.cases[0].fixtureSource = fixtureSource;
    const evaluation = path.join(fixture.root, 'evaluation-with-fixture');
    await initializeEvaluation({
      skillDirectory: fixture.skill,
      outDirectory: evaluation,
      answers,
      now: () => FIXED_DATE,
    });
    const frozenFixture = path.join(evaluation, 'fixtures', 'positive', 'input.txt');
    const originalBytes = await readFile(frozenFixture);
    const observedFixtureBytes: string[] = [];
    const provider: EvaluationProvider = {
      kind: 'fake',
      requiresAuthentication: false,
      execute: async (request) => {
        if (request.workspace === undefined) throw new Error('Probe workspace missing');
        const skillMd = await readFile(path.join(request.workspace, '.agents', 'skills', 'sample-skill', 'SKILL.md'), 'utf8');
        const marker = [...skillMd.matchAll(MARKER_PATTERN)][0]?.[0];
        if (marker === undefined) throw new Error('Probe marker missing');
        expect(request.prompt).not.toContain(marker);
        const workspaceFixture = path.join(request.workspace, 'input.txt');
        if (await access(workspaceFixture).then(() => true, () => false)) {
          const bytes = await readFile(workspaceFixture, 'utf8');
          observedFixtureBytes.push(bytes);
          expect(bytes).not.toContain(marker);
        }
        return { status: 'completion', finalOutput: marker, elapsedMs: 1 };
      },
    };

    await runActivationProbe({
      specPath: path.join(evaluation, 'evaluation-spec.json'),
      outDirectory: path.join(fixture.root, 'probe-fixture'),
      approveProviderCalls: '3',
      provider,
    });
    expect(observedFixtureBytes).toEqual(['frozen fixture bytes']);
    expect(await readFile(frozenFixture)).toEqual(originalBytes);
  });

  it('copies only fake authentication into one temporary Codex home and removes it after the probe', async () => {
    const fixture = await makePackage();
    const sourceHome = path.join(fixture.root, 'fake-codex-home');
    await mkdir(sourceHome);
    await writeFile(path.join(sourceHome, 'auth.json'), '{"fake":"auth-fixture"}\n');
    await writeFile(path.join(sourceHome, 'config.toml'), 'must-not-copy');
    const temporaryHomes: string[] = [];
    const provider: EvaluationProvider = {
      kind: 'fake',
      requiresAuthentication: true,
      execute: async (request) => {
        if (request.codexHome === undefined || request.workspace === undefined) throw new Error('Probe isolation input missing');
        temporaryHomes.push(request.codexHome);
        expect(await readdir(request.codexHome)).toEqual(['auth.json']);
        const skillMd = await readFile(path.join(request.workspace, '.agents', 'skills', 'sample-skill', 'SKILL.md'), 'utf8');
        const marker = [...skillMd.matchAll(MARKER_PATTERN)][0]?.[0];
        if (marker === undefined) throw new Error('Probe marker missing');
        return { status: 'completion', finalOutput: marker, elapsedMs: 1 };
      },
    };

    await runActivationProbe({
      specPath: fixture.specPath,
      outDirectory: path.join(fixture.root, 'probe-auth'),
      approveProviderCalls: '3',
      provider,
      codexHomeSource: sourceHome,
    });
    expect(new Set(temporaryHomes).size).toBe(1);
    await expect(access(temporaryHomes[0]!)).rejects.toThrow();
  });

  it('stops on credential-shaped output without persisting it', async () => {
    const fixture = await makePackage();
    const secret = 'sk-abcdefghijklmnop1234567890';
    const provider: EvaluationProvider = {
      kind: 'fake',
      requiresAuthentication: false,
      execute: () => Promise.resolve({ status: 'completion', finalOutput: `leaked ${secret}`, elapsedMs: 1 }),
    };
    const out = path.join(fixture.root, 'probe-secret');
    const result = await runActivationProbe({
      specPath: fixture.specPath,
      outDirectory: out,
      approveProviderCalls: '3',
      provider,
    });
    expect(result).toMatchObject({ exitCode: 3, terminal: { status: 'INCONCLUSIVE', calls: { attempted: 1 } } });
    const names = await readdir(out, { recursive: true });
    for (const name of names) {
      const target = path.join(out, name);
      if ((await lstat(target)).isFile()) expect(await readFile(target, 'utf8')).not.toContain(secret);
    }
  });

  it('anchors audit timestamps to monotonic progress and records material wall-clock adjustments', async () => {
    const fixture = await makePackage();
    const anchor = Date.parse('2026-08-16T12:00:00.000Z');
    let wallMs = anchor;
    let monotonicMs = 10_000;
    let call = 0;
    const provider: EvaluationProvider = {
      kind: 'fake',
      requiresAuthentication: false,
      execute: async (request) => {
        if (request.workspace === undefined) throw new Error('Probe workspace missing');
        const skillMd = await readFile(path.join(request.workspace, '.agents', 'skills', 'sample-skill', 'SKILL.md'), 'utf8');
        const marker = [...skillMd.matchAll(MARKER_PATTERN)][0]?.[0];
        if (marker === undefined) throw new Error('Probe marker missing');
        call += 1;
        monotonicMs += 1_000;
        if (call === 2) wallMs += 31_000;
        else if (call === 3) wallMs = anchor + 3_000;
        else wallMs += 1_000;
        return { status: 'completion', finalOutput: marker, elapsedMs: 1_000 };
      },
    };
    const out = path.join(fixture.root, 'probe-clock');
    const result = await runActivationProbe({
      specPath: fixture.specPath,
      outDirectory: out,
      approveProviderCalls: '3',
      provider,
      clock: { wallNowMs: () => wallMs, monotonicNowMs: () => monotonicMs },
    });

    expect(result.terminal.status).toBe('CONFIRMED');
    expect(result.terminal.limitations).toContainEqual(expect.stringMatching(/Wall clock adjustments.*30000 ms.*monotonic/i));
    const events = (await readFile(path.join(out, 'probe-results.jsonl'), 'utf8'))
      .trim().split('\n').map((line) => JSON.parse(line) as { at?: string });
    const timestamps = events.flatMap((event) => event.at === undefined ? [] : [Date.parse(event.at)]);
    expect(timestamps.every((value, index) => index === 0 || value >= timestamps[index - 1]!)).toBe(true);
    expect(Date.parse(result.terminal.completedAt)).toBeGreaterThanOrEqual(timestamps.at(-1)!);
  });
});
