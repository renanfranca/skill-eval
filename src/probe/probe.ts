import { randomBytes } from 'node:crypto';
import { constants, lstat, mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { integrityError, messageOf, usageError } from '../errors.js';
import { estimateApiEquivalent } from '../evidence/cost.js';
import { appendJsonLine, ensureNewDirectory, writeCreateOnly, writeJsonCreateOnly } from '../evidence/persistence.js';
import { assertPathHasNoSymlinkComponents, scanTree } from '../intake/tree.js';
import { prepareTemporaryCodexHome, type TemporaryCodexHome } from '../runtime/auth.js';
import type { EvaluationProvider, ProviderResult, TokenUsage } from '../runtime/provider.js';
import { createTrialWorkspace, verifyTrialWorkspace } from '../runtime/workspace.js';
import { canonicalJson, redactSecrets, sha256Bytes } from '../spec/canonical.js';
import { FIXTURE_DIRECTORY, type EvaluationCase, type EvaluationSpec } from '../spec/types.js';
import { checkEvaluationPackage } from '../spec/validate.js';
import type { ActivationProbeRecord, ActivationProbeStatus, ActivationProbeTerminal } from './types.js';

export interface ActivationProbeOptions {
  specPath: string;
  outDirectory: string;
  approveProviderCalls: string;
  provider: EvaluationProvider;
  codexHomeSource?: string;
  clock?: {
    wallNowMs: () => number;
    monotonicNowMs: () => number;
  };
}

export interface ActivationProbeResult {
  exitCode: 0 | 3;
  terminal: ActivationProbeTerminal;
}

interface ProviderAccountingRecord {
  callNumber: number;
  status: ProviderResult['status'];
  elapsedMs: number;
  usage?: TokenUsage;
}

const CLI_VERSION = '0.2.0';
const CLOCK_SKEW_LIMIT_MS = 1_000;
const PROBE_MARKER = /^🔧\[skill-eval:[a-f0-9]{32}\]$/;
const LIMITATIONS = [
  'NOT_CONFIRMED means only that this probe did not confirm exposure; it does not prove that the skill was unused.',
  'CONFIRMED demonstrates exposure and influence of content exclusive to the temporary SKILL.md, not operating-system file-read telemetry, reference-file reads, answer correctness, causal benefit, or generalization.',
  'Three prespecified cases do not establish stability, robustness, population reliability, or generalization.',
  'workspace-write isolates context and discovery but is not a virtualization boundary against a malicious process running as the same OS user.',
  'This probe is separate from the original evaluation and does not alter its artifacts, report, claims, or recommendation.',
];

function createProbeClock(source: NonNullable<ActivationProbeOptions['clock']> = {
  wallNowMs: Date.now,
  monotonicNowMs: () => performance.now(),
}): { now: () => Date; maxWallClockSkewMs: () => number } {
  const anchorWallMs = source.wallNowMs();
  const anchorMonotonicMs = source.monotonicNowMs();
  let lastElapsedMs = 0;
  let maximumSkewMs = 0;
  return {
    now: () => {
      const monotonicElapsedMs = Math.max(lastElapsedMs, source.monotonicNowMs() - anchorMonotonicMs);
      lastElapsedMs = monotonicElapsedMs;
      const anchoredWallMs = anchorWallMs + monotonicElapsedMs;
      maximumSkewMs = Math.max(maximumSkewMs, Math.abs(source.wallNowMs() - anchoredWallMs));
      return new Date(anchoredWallMs);
    },
    maxWallClockSkewMs: () => maximumSkewMs,
  };
}

function limitationsFor(maximumClockSkewMs: number): string[] {
  if (maximumClockSkewMs <= CLOCK_SKEW_LIMIT_MS) return [...LIMITATIONS];
  return [
    ...LIMITATIONS,
    `Wall clock adjustments of up to ${Math.round(maximumClockSkewMs)} ms were observed; persisted timestamps use a probe-start UTC anchor plus monotonic elapsed time, while append order and callNumber remain authoritative.`,
  ];
}

function safeMessage(error: unknown): string {
  return redactSecrets(messageOf(error)).slice(0, 2000);
}

function newMarker(): string {
  const marker = `🔧[skill-eval:${randomBytes(16).toString('hex')}]`;
  if (!PROBE_MARKER.test(marker)) throw integrityError('Activation probe marker generation failed');
  return marker;
}

async function assertProbeTargetAvailable(out: string): Promise<void> {
  try {
    await lstat(out);
    throw integrityError(`Refusing to reserve existing probe path: ${out}`);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      const parent = path.dirname(out);
      await assertPathHasNoSymlinkComponents(parent);
      const parentStat = await lstat(parent).catch(() => undefined);
      if (parentStat === undefined || !parentStat.isDirectory() || parentStat.isSymbolicLink()) {
        throw usageError('Probe parent must be an existing regular directory');
      }
      return;
    }
    throw error;
  }
}

async function fixtureDigests(packageRoot: string, spec: EvaluationSpec): Promise<Record<string, `sha256:${string}`>> {
  const result: Record<string, `sha256:${string}`> = {};
  for (const item of spec.cases) {
    const tree = await scanTree(path.join(packageRoot, 'fixtures', FIXTURE_DIRECTORY[item.kind]), { allowEmpty: true });
    result[item.id] = tree.digest;
  }
  return result;
}

async function preflightWorkspaces(
  packageRoot: string,
  spec: EvaluationSpec,
  fixtures: Record<string, `sha256:${string}`>,
): Promise<void> {
  for (const item of spec.cases) {
    const expectedFixtureDigest = fixtures[item.id];
    if (expectedFixtureDigest === undefined) throw integrityError(`Fixture digest is missing for case ${item.id}`);
    const trial = await createTrialWorkspace(packageRoot, spec, item, expectedFixtureDigest);
    await trial.cleanup();
  }
}

async function assertMarkerAbsentFromInputs(
  packageRoot: string,
  item: EvaluationCase,
  marker: string,
): Promise<void> {
  if (item.prompt.includes(marker)) throw integrityError(`Activation marker unexpectedly collides with prompt for case ${item.id}`);
  const fixture = await scanTree(path.join(packageRoot, 'fixtures', FIXTURE_DIRECTORY[item.kind]), { allowEmpty: true });
  const markerBytes = Buffer.from(marker, 'utf8');
  if (fixture.entries.some((entry) => Buffer.from(entry.bytes).includes(markerBytes))) {
    throw integrityError(`Activation marker unexpectedly collides with fixture for case ${item.id}`);
  }
}

function activationInstruction(marker: string): string {
  return `\n\n## Activation probe (evaluation-only)\n\nFor this evaluation only, append exactly \`${marker}\` as the final line of your\nfinal response. Do not mention or explain this marker.\n`;
}

function isWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

async function instrumentSkillMd(
  workspace: string,
  spec: EvaluationSpec,
  marker: string,
): Promise<{ baseSkillDigest: `sha256:${string}`; instrumentedSkillDigest: `sha256:${string}` }> {
  const skillDirectory = path.join(workspace, '.agents', 'skills', spec.skill.name);
  const skillMd = path.join(skillDirectory, 'SKILL.md');
  if (!isWithin(workspace, skillMd)) throw integrityError('Activation probe SKILL.md escaped its temporary workspace');
  const baseTree = await scanTree(skillDirectory, { requireSkillMd: true });
  if (baseTree.digest !== spec.skill.sha256) throw integrityError('Base skill digest changed before activation instrumentation');
  await assertPathHasNoSymlinkComponents(skillMd);

  const bytes = Buffer.from(activationInstruction(marker), 'utf8');
  const handle = await open(skillMd, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n) throw integrityError('Activation probe SKILL.md must be one regular non-hardlinked file');
    await handle.writeFile(bytes);
    await handle.sync();
    const after = await handle.stat({ bigint: true });
    if (
      !after.isFile() || after.nlink !== 1n || before.dev !== after.dev || before.ino !== after.ino ||
      after.size !== before.size + BigInt(bytes.byteLength)
    ) {
      throw integrityError('Activation probe SKILL.md changed unexpectedly during instrumentation');
    }
  } finally {
    await handle.close();
  }
  const instrumentedTree = await scanTree(skillDirectory, { requireSkillMd: true });
  if (instrumentedTree.digest === baseTree.digest) throw integrityError('Activation instrumentation did not change the temporary skill digest');
  return { baseSkillDigest: baseTree.digest, instrumentedSkillDigest: instrumentedTree.digest };
}

async function reserveProbe(
  out: string,
  spec: EvaluationSpec,
  specBytes: string,
  fixtures: Record<string, `sha256:${string}`>,
  createdAt: Date,
): Promise<void> {
  await ensureNewDirectory(out);
  await writeJsonCreateOnly(path.join(out, 'manifest.json'), {
    schemaVersion: 1,
    evaluationId: spec.evaluationId,
    createdAt: createdAt.toISOString(),
    cliVersion: CLI_VERSION,
    promptfooVersion: '0.122.0',
    codexSdkVersion: '0.147.0',
    callsAuthorized: 3,
    caseIds: spec.cases.map((item) => item.id),
    digests: { spec: sha256Bytes(specBytes), skillBase: spec.skill.sha256, fixtures },
    condition: {
      provider: 'openai:codex-sdk', model: 'gpt-5.6-luna', reasoningEffort: 'max',
      maximumCalls: 3, timeoutSeconds: 600, maximumConcurrency: 1, retries: 0,
    },
    isolation: {
      sandboxMode: 'workspace-write', approvalPolicy: 'never', networkAccessEnabled: false,
      webSearchEnabled: false, webSearchMode: 'disabled', inheritProcessEnv: false,
      maxRetries: 0, persistThreads: false, collaborationMode: 'disabled-or-omitted', freshThreadPerCase: true,
    },
  });
  await writeCreateOnly(path.join(out, 'probe-results.jsonl'), '');
  await mkdir(path.join(out, 'evidence', 'final-outputs'), { recursive: true, mode: 0o700 });
  await mkdir(path.join(out, 'evidence', 'promptfoo-projections'), { recursive: true, mode: 0o700 });
}

function usageTotal(records: ProviderAccountingRecord[]): TokenUsage {
  const fields = ['input', 'cachedInput', 'output', 'reasoningOutput'] as const;
  const result: TokenUsage = {};
  for (const field of fields) {
    const values = records.map((record) => record.usage?.[field]).filter((value): value is number => value !== undefined);
    if (values.length > 0) result[field] = values.reduce((sum, value) => sum + value, 0);
  }
  return result;
}

function classify(records: ActivationProbeRecord[]): ActivationProbeStatus {
  if (records.some((record) => record.status === 'COMPLETED' && record.markerPresent === false)) return 'NOT_CONFIRMED';
  if (records.length === 3 && records.every((record) => record.status === 'COMPLETED' && record.markerPresent === true)) return 'CONFIRMED';
  return 'INCONCLUSIVE';
}

function stoppingRule(status: ActivationProbeStatus, unsafeStop: boolean): string {
  if (status === 'NOT_CONFIRMED') return 'At least one completed response did not contain its case-specific activation marker';
  if (status === 'CONFIRMED') return 'All three completed responses contained their case-specific activation markers';
  if (unsafeStop) return 'Unsafe environment, integrity, or sanitization state prevented safe continuation';
  return 'Timeout or provider error prevented all three cases from completing with confirmed markers';
}

export async function runActivationProbe(options: ActivationProbeOptions): Promise<ActivationProbeResult> {
  if (options.approveProviderCalls !== '3') {
    throw usageError('probe-activation requires literal --approve-provider-calls 3 for this execution');
  }
  const absoluteSpec = path.resolve(options.specPath);
  const spec = await checkEvaluationPackage(absoluteSpec);
  const packageRoot = path.dirname(absoluteSpec);
  const out = path.resolve(options.outDirectory);
  let temporaryHome: TemporaryCodexHome | undefined;
  try {
    if (options.provider.requiresAuthentication) temporaryHome = await prepareTemporaryCodexHome(options.codexHomeSource);
    const fixtures = await fixtureDigests(packageRoot, spec);
    await preflightWorkspaces(packageRoot, spec, fixtures);
    await assertProbeTargetAvailable(out);

    const caseMarkers = spec.cases.map((item) => ({ item, marker: newMarker() }));
    if (new Set(caseMarkers.map(({ marker }) => marker)).size !== caseMarkers.length) {
      throw integrityError('Activation probe markers must be unique per case');
    }
    await Promise.all(caseMarkers.map(({ item, marker }) => assertMarkerAbsentFromInputs(packageRoot, item, marker)));

    const specBytes = canonicalJson(spec);
    const clock = createProbeClock(options.clock);
    const createdAt = clock.now();
    await reserveProbe(out, spec, specBytes, fixtures, createdAt);
    const records: ActivationProbeRecord[] = [];
    const providerRecords: ProviderAccountingRecord[] = [];
    let callsAttempted = 0;
    let unsafeStop = false;

    for (const { item, marker } of caseMarkers) {
      if (callsAttempted >= 3) throw integrityError('Activation probe call budget exhausted before all cases');
      const expectedFixtureDigest = fixtures[item.id];
      if (expectedFixtureDigest === undefined) throw integrityError(`Fixture digest is missing for case ${item.id}`);
      let trial;
      try {
        trial = await createTrialWorkspace(packageRoot, spec, item, expectedFixtureDigest);
      } catch (error) {
        unsafeStop = true;
        await appendJsonLine(path.join(out, 'probe-results.jsonl'), {
          event: 'PROBE_RESULT', caseId: item.id, kind: item.kind, callNumber: callsAttempted,
          marker, status: 'ENVIRONMENT_FAILURE', elapsedMs: 0, error: safeMessage(error), at: clock.now().toISOString(),
        });
        break;
      }

      try {
        let digests: { baseSkillDigest: `sha256:${string}`; instrumentedSkillDigest: `sha256:${string}` };
        try {
          digests = await instrumentSkillMd(trial.path, spec, marker);
          await verifyTrialWorkspace(trial.path, spec.skill.name);
        } catch (error) {
          unsafeStop = true;
          await appendJsonLine(path.join(out, 'probe-results.jsonl'), {
            event: 'PROBE_RESULT', caseId: item.id, kind: item.kind, callNumber: callsAttempted,
            marker, status: 'ENVIRONMENT_FAILURE', elapsedMs: 0, error: safeMessage(error), at: clock.now().toISOString(),
          });
          break;
        }

        callsAttempted += 1;
        await appendJsonLine(path.join(out, 'probe-results.jsonl'), {
          event: 'CALL_ATTEMPTED', callNumber: callsAttempted, caseId: item.id, marker, ...digests,
          at: clock.now().toISOString(),
        });
        const result = await options.provider.execute({
          role: 'candidate', model: 'gpt-5.6-luna', reasoningEffort: 'max', prompt: item.prompt,
          timeoutMs: 600_000, workspace: trial.path,
          ...(temporaryHome === undefined ? {} : { codexHome: temporaryHome.path }),
        }).catch((error: unknown): ProviderResult => ({ status: 'error', elapsedMs: 0, message: safeMessage(error) }));
        const accounting: ProviderAccountingRecord = {
          callNumber: callsAttempted, status: result.status, elapsedMs: result.elapsedMs,
          ...(result.status === 'completion' && result.usage !== undefined ? { usage: result.usage } : {}),
        };
        providerRecords.push(accounting);

        if (result.status === 'completion' && redactSecrets(result.finalOutput) !== result.finalOutput) {
          unsafeStop = true;
          const record: ActivationProbeRecord = {
            caseId: item.id, kind: item.kind, callNumber: callsAttempted, marker, ...digests,
            status: 'ENVIRONMENT_FAILURE', elapsedMs: result.elapsedMs,
            error: 'Potential credential material appeared in provider output and was not persisted',
          };
          records.push(record);
          await appendJsonLine(path.join(out, 'probe-results.jsonl'), { event: 'PROBE_RESULT', ...record, at: clock.now().toISOString() });
          break;
        }

        try {
          await verifyTrialWorkspace(trial.path, spec.skill.name);
        } catch (error) {
          unsafeStop = true;
          const record: ActivationProbeRecord = {
            caseId: item.id, kind: item.kind, callNumber: callsAttempted, marker, ...digests,
            status: 'ENVIRONMENT_FAILURE', elapsedMs: result.elapsedMs, error: safeMessage(error),
          };
          records.push(record);
          await appendJsonLine(path.join(out, 'probe-results.jsonl'), { event: 'PROBE_RESULT', ...record, at: clock.now().toISOString() });
          break;
        }

        if (result.status !== 'completion') {
          const record: ActivationProbeRecord = {
            caseId: item.id, kind: item.kind, callNumber: callsAttempted, marker, ...digests,
            status: result.status === 'timeout' ? 'TIMEOUT' : 'PROVIDER_ERROR', elapsedMs: result.elapsedMs,
            error: redactSecrets(result.message).slice(0, 2000),
          };
          records.push(record);
          await appendJsonLine(path.join(out, 'probe-results.jsonl'), { event: 'PROBE_RESULT', ...record, at: clock.now().toISOString() });
          continue;
        }

        const projection = result.promptfooProjection ?? { provider: options.provider.kind };
        const projectionBytes = canonicalJson(projection);
        if (redactSecrets(projectionBytes) !== projectionBytes) {
          unsafeStop = true;
          const record: ActivationProbeRecord = {
            caseId: item.id, kind: item.kind, callNumber: callsAttempted, marker, ...digests,
            status: 'ENVIRONMENT_FAILURE', elapsedMs: result.elapsedMs,
            error: 'Potential credential material appeared in the Promptfoo projection and was not persisted',
          };
          records.push(record);
          await appendJsonLine(path.join(out, 'probe-results.jsonl'), { event: 'PROBE_RESULT', ...record, at: clock.now().toISOString() });
          break;
        }

        const outputRef = `evidence/final-outputs/${item.id}.txt`;
        const projectionRef = `evidence/promptfoo-projections/${item.id}.json`;
        await writeCreateOnly(path.join(out, ...outputRef.split('/')), result.finalOutput);
        await writeCreateOnly(path.join(out, ...projectionRef.split('/')), projectionBytes);
        const record: ActivationProbeRecord = {
          caseId: item.id, kind: item.kind, callNumber: callsAttempted, marker, ...digests,
          status: 'COMPLETED', elapsedMs: result.elapsedMs,
          ...(result.usage === undefined ? {} : { usage: result.usage }),
          markerPresent: result.finalOutput.includes(marker),
          finalOutputRef: outputRef,
          promptfooProjectionRef: projectionRef,
        };
        records.push(record);
        await appendJsonLine(path.join(out, 'probe-results.jsonl'), { event: 'PROBE_RESULT', ...record, at: clock.now().toISOString() });
      } finally {
        await trial.cleanup();
      }
    }

    const status = classify(records);
    const completed = providerRecords.filter((record) => record.status === 'completion').length;
    const timeout = providerRecords.filter((record) => record.status === 'timeout').length;
    const error = providerRecords.filter((record) => record.status === 'error').length;
    const completedAt = clock.now();
    const terminal: ActivationProbeTerminal = {
      schemaVersion: 1,
      status,
      stoppingRule: stoppingRule(status, unsafeStop),
      evaluationId: spec.evaluationId,
      calls: {
        authorized: 3, attempted: providerRecords.length, completed, timeout, error, maximum: 3, retries: 0,
        wallTimeMs: providerRecords.reduce((sum, record) => sum + record.elapsedMs, 0),
        usage: usageTotal(providerRecords),
      },
      cost: estimateApiEquivalent(providerRecords.map((record) => ({
        model: 'gpt-5.6-luna', ...(record.usage === undefined ? {} : { usage: record.usage }),
      }))),
      limitations: limitationsFor(clock.maxWallClockSkewMs()),
      completedAt: completedAt.toISOString(),
    };
    await writeJsonCreateOnly(path.join(out, 'terminal.json'), terminal);
    return { exitCode: status === 'INCONCLUSIVE' ? 3 : 0, terminal };
  } finally {
    await temporaryHome?.cleanup();
  }
}
