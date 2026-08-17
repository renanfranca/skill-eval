import { lstat, mkdir, mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { integrityError, messageOf, usageError } from '../errors.js';
import { applyDirectChecks, diffTrees } from '../evidence/checks.js';
import { estimateApiEquivalent } from '../evidence/cost.js';
import { appendJsonLine, ensureNewDirectory, writeCreateOnly, writeJsonCreateOnly } from '../evidence/persistence.js';
import { prepareJudgeBatch, getJudgeResultSchema, validateJudgeOutput, type JudgeCriterionResult } from '../judge/batch.js';
import { prepareTemporaryCodexHome, type TemporaryCodexHome } from '../runtime/auth.js';
import type { EvaluationProvider, ProviderResult, TokenUsage } from '../runtime/provider.js';
import { createTrialWorkspace, verifyTrialWorkspace } from '../runtime/workspace.js';
import { canonicalJson, redactSecrets, sha256Bytes } from '../spec/canonical.js';
import { checkEvaluationPackage } from '../spec/validate.js';
import { assertPathHasNoSymlinkComponents } from '../intake/tree.js';
import { FIXTURE_DIRECTORY, type EvaluationCase, type EvaluationSpec } from '../spec/types.js';
import { assessClaims, recommend, suggestedAction } from './decision.js';
import type { CaseRecord, TerminalReceipt, TerminalStatus } from './types.js';

export interface RunOptions {
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

export interface RunResult {
  exitCode: 0 | 3;
  terminal: TerminalReceipt;
}

interface ProviderAccountingRecord {
  callNumber: number;
  role: 'candidate' | 'judge';
  model: 'gpt-5.6-luna' | 'gpt-5.6-terra';
  caseId?: string;
  status: ProviderResult['status'];
  elapsedMs: number;
  usage?: TokenUsage;
  message?: string;
}

const LIMITATIONS = [
  'Three prespecified cases do not establish stability, robustness, causality, population reliability, or generalization.',
  'Activation is direct evidence only when SKILL.md read telemetry is present; Promptfoo skill-used metadata is heuristic.',
  'workspace-write isolates context and discovery but is not a virtualization boundary against a malicious process running as the same OS user.',
  'The recommendation is conditioned on the frozen skill, spec, fixtures, models, effort, package versions, environment, and procedure.',
];

const REEVALUATION_TRIGGERS = [
  'skill snapshot change', 'evaluation spec or fixtures change', 'candidate or judge model change',
  'reasoning effort change', 'Promptfoo or Codex SDK change', 'material environment change',
];

const CLOCK_SKEW_LIMIT_MS = 1_000;

function createRunClock(source: NonNullable<RunOptions['clock']> = {
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
    `Wall clock adjustments of up to ${Math.round(maximumClockSkewMs)} ms were observed; persisted timestamps use a run-start UTC anchor plus monotonic elapsed time, while append order and callNumber remain authoritative.`,
  ];
}

function safeMessage(error: unknown): string {
  return redactSecrets(messageOf(error)).slice(0, 2000);
}

async function assertRunTargetAvailable(out: string): Promise<void> {
  try {
    await lstat(out);
    throw integrityError(`Refusing to reserve existing run path: ${out}`);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      const parent = path.dirname(out);
      await assertPathHasNoSymlinkComponents(parent);
      const parentStat = await lstat(parent).catch(() => undefined);
      if (parentStat === undefined || !parentStat.isDirectory() || parentStat.isSymbolicLink()) {
        throw usageError('Run parent must be an existing regular directory');
      }
      return;
    }
    throw error;
  }
}

async function fixtureDigests(packageRoot: string, spec: EvaluationSpec): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const { scanTree } = await import('../intake/tree.js');
  for (const item of spec.cases) {
    const tree = await scanTree(path.join(packageRoot, 'fixtures', FIXTURE_DIRECTORY[item.kind]), { allowEmpty: true });
    result[item.id] = tree.digest;
  }
  return result;
}

async function preflightWorkspaces(packageRoot: string, spec: EvaluationSpec, fixtures: Record<string, string>): Promise<void> {
  for (const item of spec.cases) {
    const expectedFixtureDigest = fixtures[item.id];
    if (expectedFixtureDigest === undefined) throw integrityError(`Fixture digest is missing for case ${item.id}`);
    const trial = await createTrialWorkspace(packageRoot, spec, item, expectedFixtureDigest);
    await trial.cleanup();
  }
}

function usageTotal(records: Array<{ usage?: TokenUsage }>): TokenUsage {
  const fields = ['input', 'cachedInput', 'output', 'reasoningOutput'] as const;
  const result: TokenUsage = {};
  for (const field of fields) {
    const values = records.map((record) => record.usage?.[field]).filter((value): value is number => value !== undefined);
    if (values.length > 0) result[field] = values.reduce((sum, value) => sum + value, 0);
  }
  return result;
}

function skillRead(filesRead: string[] | undefined, skillName: string): boolean {
  return (filesRead ?? []).some((value) => value.replaceAll('\\', '/').endsWith(`/.agents/skills/${skillName}/SKILL.md`) || value === `.agents/skills/${skillName}/SKILL.md`);
}

function promptfooHeuristic(result: ProviderResult): boolean {
  return result.status === 'completion' && result.promptfooProjection?.['skillUsedHeuristic'] === true;
}

function providerAccountingRecord(
  callNumber: number,
  role: ProviderAccountingRecord['role'],
  model: ProviderAccountingRecord['model'],
  result: ProviderResult,
  caseId?: string,
): ProviderAccountingRecord {
  return {
    callNumber,
    role,
    model,
    ...(caseId === undefined ? {} : { caseId }),
    status: result.status,
    elapsedMs: result.elapsedMs,
    ...(result.status === 'completion' && result.usage !== undefined ? { usage: result.usage } : {}),
    ...(result.status === 'completion' ? {} : { message: redactSecrets(result.message).slice(0, 2000) }),
  };
}

async function reserveRun(
  out: string,
  spec: EvaluationSpec,
  specBytes: string,
  fixtures: Record<string, string>,
  now: Date,
): Promise<void> {
  await ensureNewDirectory(out);
  await writeJsonCreateOnly(path.join(out, 'manifest.json'), {
    schemaVersion: 1,
    evaluationId: spec.evaluationId,
    createdAt: now.toISOString(),
    cliVersion: '0.2.1',
    promptfooVersion: '0.122.0',
    codexSdkVersion: '0.147.0',
    spec,
    digests: { spec: sha256Bytes(specBytes), skill: spec.skill.sha256, fixtures },
    caseIds: spec.cases.map((item) => item.id),
    isolation: {
      candidate: {
        sandboxMode: 'workspace-write', approvalPolicy: 'never', networkAccessEnabled: false,
        webSearchEnabled: false, webSearchMode: 'disabled', inheritProcessEnv: false,
        maxRetries: 0, persistThreads: false, maximumConcurrency: 1, freshThreadPerCase: true,
      },
      judge: { sandboxMode: 'read-only', toolsFilesNetwork: 'disabled' },
    },
  });
  await writeJsonCreateOnly(path.join(out, 'budget-ledger.json'), {
    schemaVersion: 1,
    callsAuthorized: 4,
    maximumCalls: 4,
    candidateMaximumCalls: 3,
    judgeMaximumCalls: 1,
    retries: 0,
    accountingEvents: 'case-results.jsonl',
    actualChatGptCost: 'UNKNOWN',
    actualChatGptCostReason: 'ChatGPT account usage has no auditable monetary unit',
  });
  await writeCreateOnly(path.join(out, 'case-results.jsonl'), '');
  await mkdir(path.join(out, 'evidence', 'filesystem-diffs'), { recursive: true, mode: 0o700 });
  await mkdir(path.join(out, 'evidence', 'final-outputs'), { recursive: true, mode: 0o700 });
  await mkdir(path.join(out, 'evidence', 'promptfoo-projections'), { recursive: true, mode: 0o700 });
}

function terminalStatusForResult(result: ProviderResult): TerminalStatus {
  return result.status === 'timeout' ? 'EXECUTION_TIMEOUT' : 'PROVIDER_ERROR';
}

export async function runEvaluation(options: RunOptions): Promise<RunResult> {
  const absoluteSpec = path.resolve(options.specPath);
  const spec = await checkEvaluationPackage(absoluteSpec);
  if (options.approveProviderCalls !== '4') throw usageError('run requires literal --approve-provider-calls 4 for this execution');
  const packageRoot = path.dirname(absoluteSpec);
  const out = path.resolve(options.outDirectory);
  let temporaryHome: TemporaryCodexHome | undefined;
  try {
    if (options.provider.requiresAuthentication) {
      temporaryHome = await prepareTemporaryCodexHome(options.codexHomeSource);
    }
    const fixtures = await fixtureDigests(packageRoot, spec);
    await preflightWorkspaces(packageRoot, spec, fixtures);
    await assertRunTargetAvailable(out);
    const specBytes = canonicalJson(spec);
    const clock = createRunClock(options.clock);
    const reservedAt = clock.now();
    const cases: CaseRecord[] = [];
    const providerRecords: ProviderAccountingRecord[] = [];
    let callsAttempted = 0;
    let terminalStatus: TerminalStatus = 'INTERRUPTED_UNCONFIRMED';
    let stoppingRule = 'Run ended before a terminal receipt could be confirmed';
    let directDoNotProceed = false;
    let instrumentInvalid = false;
    let judgeAttempted = false;
    let judgeValid: boolean | null = null;
    let judgeSummary = 'Judge was not needed or not reached';
    const semanticByCase = new Map<string, JudgeCriterionResult[]>();
    await reserveRun(out, spec, specBytes, fixtures, reservedAt);
    for (const item of spec.cases) {
      if (callsAttempted >= 3) throw integrityError('Candidate call budget exhausted before all cases');
      let trial;
      try {
        const expectedFixtureDigest = fixtures[item.id];
        if (expectedFixtureDigest === undefined) throw integrityError(`Fixture digest is missing for case ${item.id}`);
        trial = await createTrialWorkspace(packageRoot, spec, item, expectedFixtureDigest);
      } catch (error) {
        const record: CaseRecord = {
          caseId: item.id, kind: item.kind, callNumber: callsAttempted, status: 'ENVIRONMENT_FAILURE', elapsedMs: 0,
          error: safeMessage(error), filesystemChanges: [], checks: [],
          activation: { expectation: item.activationExpectation, skillMdRead: false, promptfooSkillUsedHeuristic: false },
        };
        cases.push(record);
        await appendJsonLine(path.join(out, 'case-results.jsonl'), { event: 'CASE_RESULT', ...record });
        terminalStatus = 'ENVIRONMENT_FAILURE';
        stoppingRule = 'Trial workspace could not be reconstructed from the frozen package';
        instrumentInvalid = true;
        break;
      }
      try {
        callsAttempted += 1;
        await appendJsonLine(path.join(out, 'case-results.jsonl'), {
          event: 'CALL_ATTEMPTED', callNumber: callsAttempted, role: 'candidate', caseId: item.id, at: clock.now().toISOString(),
        });
        const result = await options.provider.execute({
          role: 'candidate', model: 'gpt-5.6-luna', reasoningEffort: 'max', prompt: item.prompt,
          timeoutMs: 600_000, workspace: trial.path,
          ...(temporaryHome === undefined ? {} : { codexHome: temporaryHome.path }),
        }).catch((error: unknown): ProviderResult => ({ status: 'error', elapsedMs: 0, message: safeMessage(error) }));
        const providerRecord = providerAccountingRecord(callsAttempted, 'candidate', 'gpt-5.6-luna', result, item.id);
        await appendJsonLine(path.join(out, 'case-results.jsonl'), { event: 'CALL_RESULT', ...providerRecord, at: clock.now().toISOString() });
        providerRecords.push(providerRecord);
        if (result.status !== 'completion') {
          const record: CaseRecord = {
            caseId: item.id, kind: item.kind, callNumber: callsAttempted,
            status: result.status === 'timeout' ? 'TIMEOUT' : 'PROVIDER_ERROR', elapsedMs: result.elapsedMs,
            error: redactSecrets(result.message), filesystemChanges: [], checks: [],
            activation: { expectation: item.activationExpectation, skillMdRead: false, promptfooSkillUsedHeuristic: false },
          };
          cases.push(record);
          await appendJsonLine(path.join(out, 'case-results.jsonl'), { event: 'CASE_RESULT', ...record });
          terminalStatus = terminalStatusForResult(result);
          stoppingRule = `${result.status} is terminal and receives zero retries`;
          instrumentInvalid = true;
          break;
        }
        if (redactSecrets(result.finalOutput) !== result.finalOutput) {
          const record: CaseRecord = {
            caseId: item.id, kind: item.kind, callNumber: callsAttempted, status: 'ENVIRONMENT_FAILURE',
            elapsedMs: result.elapsedMs, error: 'Potential credential material appeared in provider output and was not persisted',
            filesystemChanges: [], checks: [],
            activation: { expectation: item.activationExpectation, skillMdRead: skillRead(result.filesRead, spec.skill.name), promptfooSkillUsedHeuristic: promptfooHeuristic(result) },
          };
          cases.push(record);
          await appendJsonLine(path.join(out, 'case-results.jsonl'), { event: 'CASE_RESULT', ...record });
          terminalStatus = 'ENVIRONMENT_FAILURE';
          stoppingRule = 'Credential sanitization boundary triggered';
          instrumentInvalid = true;
          break;
        }
        let after;
        try {
          after = await verifyTrialWorkspace(trial.path, spec.skill.name);
        } catch (error) {
          const record: CaseRecord = {
            caseId: item.id, kind: item.kind, callNumber: callsAttempted, status: 'ENVIRONMENT_FAILURE', elapsedMs: result.elapsedMs,
            error: safeMessage(error), filesystemChanges: [], checks: [],
            activation: { expectation: item.activationExpectation, skillMdRead: skillRead(result.filesRead, spec.skill.name), promptfooSkillUsedHeuristic: promptfooHeuristic(result) },
          };
          cases.push(record);
          await appendJsonLine(path.join(out, 'case-results.jsonl'), { event: 'CASE_RESULT', ...record });
          terminalStatus = 'ENVIRONMENT_FAILURE';
          stoppingRule = 'Unsafe or unexpected trial filesystem state';
          instrumentInvalid = true;
          break;
        }
        const changes = diffTrees(trial.initialTree, after);
        const checks = await applyDirectChecks(item.checks, { finalOutput: result.finalOutput, elapsedMs: result.elapsedMs, workspace: trial.path, changes });
        const outputRef = `evidence/final-outputs/${item.id}.txt`;
        const diffRef = `evidence/filesystem-diffs/${item.id}.json`;
        const projectionRef = `evidence/promptfoo-projections/${item.id}.json`;
        await writeCreateOnly(path.join(out, ...outputRef.split('/')), result.finalOutput);
        await writeJsonCreateOnly(path.join(out, ...diffRef.split('/')), { caseId: item.id, changes });
        await writeJsonCreateOnly(path.join(out, ...projectionRef.split('/')), result.promptfooProjection ?? { provider: options.provider.kind });
        const record: CaseRecord = {
          caseId: item.id, kind: item.kind, callNumber: callsAttempted, status: 'COMPLETED', elapsedMs: result.elapsedMs,
          ...(result.usage === undefined ? {} : { usage: result.usage }),
          finalOutputRef: outputRef, filesystemDiffRef: diffRef, promptfooProjectionRef: projectionRef,
          filesystemChanges: changes, checks,
          activation: {
            expectation: item.activationExpectation,
            skillMdRead: skillRead(result.filesRead, spec.skill.name),
            promptfooSkillUsedHeuristic: promptfooHeuristic(result),
          },
        };
        cases.push(record);
        await appendJsonLine(path.join(out, 'case-results.jsonl'), { event: 'CASE_RESULT', ...record });
        const doNotProceed = checks.some((check) =>
          check.status === 'APPLIED' && !check.passed && check.failureDecision === 'DO_NOT_PROCEED'
        );
        if (doNotProceed) {
          directDoNotProceed = true;
          terminalStatus = 'CRITICAL_VIOLATION';
          stoppingRule = 'A direct DO_NOT_PROCEED check failed';
          break;
        }
        const invalidCheck = checks.find((check) => check.status === 'INSTRUMENT_INVALID');
        if (invalidCheck !== undefined) {
          terminalStatus = 'INSTRUMENT_INVALID';
          stoppingRule = `Direct check ${invalidCheck.checkId} could not be applied`;
          instrumentInvalid = true;
          break;
        }
        const revise = checks.some((check) =>
          check.status === 'APPLIED' && !check.passed && check.required && check.failureDecision === 'REVISE'
        );
        if (revise) {
          terminalStatus = 'CRITICAL_VIOLATION';
          stoppingRule = 'A required direct REVISE check failed with sufficient evidence';
          break;
        }
      } finally {
        await trial.cleanup();
      }
    }

    const allCasesCompleted = cases.length === 3 && cases.every((item) => item.status === 'COMPLETED');
    if (allCasesCompleted && terminalStatus === 'INTERRUPTED_UNCONFIRMED') {
      const requiredSemantic = spec.cases.some((item) => item.semanticCriteria.some((criterion) => criterion.required));
      if (requiredSemantic) {
        const candidates = cases.map((record) => {
          const evaluationCase = spec.cases.find((item) => item.id === record.caseId) as EvaluationCase;
          const finalOutput = readFile(path.join(out, ...(record.finalOutputRef as string).split('/')), 'utf8');
          return finalOutput.then((output) => ({
            evaluationCase, finalOutput: output,
            evidenceRefs: [record.finalOutputRef as string, record.filesystemDiffRef as string, ...record.checks.map((check) => `case:${record.caseId}:check:${check.checkId}`)],
          }));
        });
        const prepared = prepareJudgeBatch(await Promise.all(candidates));
        await writeJsonCreateOnly(path.join(out, 'judge-batch.json'), prepared.publicBatch);
        const judgeWorkspace = await mkdtemp(path.join(os.tmpdir(), 'skill-eval-judge-'));
        try {
          judgeAttempted = true;
          callsAttempted += 1;
          if (callsAttempted > 4) throw integrityError('Total call budget exceeded');
          await appendJsonLine(path.join(out, 'case-results.jsonl'), { event: 'CALL_ATTEMPTED', callNumber: callsAttempted, role: 'judge', at: clock.now().toISOString() });
          const judgeResult = await options.provider.execute({
            role: 'judge', model: 'gpt-5.6-terra', reasoningEffort: 'xhigh', prompt: prepared.prompt,
            timeoutMs: 600_000, workspace: judgeWorkspace, outputSchema: getJudgeResultSchema(),
            ...(temporaryHome === undefined ? {} : { codexHome: temporaryHome.path }),
          }).catch((error: unknown): ProviderResult => ({ status: 'error', elapsedMs: 0, message: safeMessage(error) }));
          const providerRecord = providerAccountingRecord(callsAttempted, 'judge', 'gpt-5.6-terra', judgeResult);
          await appendJsonLine(path.join(out, 'case-results.jsonl'), { event: 'CALL_RESULT', ...providerRecord, at: clock.now().toISOString() });
          providerRecords.push(providerRecord);
          if (judgeResult.status !== 'completion') {
            terminalStatus = terminalStatusForResult(judgeResult);
            stoppingRule = `Judge ${judgeResult.status} is terminal and receives zero retries`;
            judgeValid = false;
            judgeSummary = redactSecrets(judgeResult.message);
            instrumentInvalid = true;
          } else if (judgeResult.promptfooProjection?.['forbiddenJudgeToolUse'] === true) {
            terminalStatus = 'JUDGE_INVALID';
            stoppingRule = 'Judge attempted a forbidden tool, file, MCP, or web operation';
            judgeValid = false;
            judgeSummary = 'Judge tools/files/network policy was violated; semantic evidence was discarded';
            instrumentInvalid = true;
          } else if (redactSecrets(judgeResult.finalOutput) !== judgeResult.finalOutput) {
            terminalStatus = 'JUDGE_INVALID';
            stoppingRule = 'Judge output failed sanitization';
            judgeValid = false;
            judgeSummary = 'Potential credential material appeared in judge output and was not persisted';
            instrumentInvalid = true;
          } else {
            let persistedJudgeOutput: unknown;
            try { persistedJudgeOutput = JSON.parse(judgeResult.finalOutput) as unknown; }
            catch { persistedJudgeOutput = { invalidRawOutput: judgeResult.finalOutput }; }
            await writeJsonCreateOnly(path.join(out, 'judge-result.json'), persistedJudgeOutput);
            const validation = validateJudgeOutput(judgeResult.finalOutput, prepared);
            judgeValid = validation.valid;
            judgeSummary = validation.reason;
            if (!validation.valid) {
              terminalStatus = 'JUDGE_INVALID';
              stoppingRule = 'Opaque judge qualification or schema validation failed';
              instrumentInvalid = true;
            } else {
              for (const [caseId, criteria] of validation.candidateCriteria) semanticByCase.set(caseId, criteria);
              terminalStatus = 'COMPLETED';
              stoppingRule = 'All authorized phases completed within budget';
            }
          }
        } finally {
          await (await import('node:fs/promises')).rm(judgeWorkspace, { recursive: true, force: true });
        }
      } else {
        terminalStatus = 'COMPLETED';
        stoppingRule = 'Direct checks resolved the prespecified claims; judge call was not spent';
        judgeSummary = 'No required semantic criterion was prespecified';
      }
    }

    const claims = assessClaims(spec, cases, semanticByCase, judgeValid === true || !judgeAttempted);
    const recommendation = recommend(claims, { instrumentInvalid, directDoNotProceed });
    const semanticAssessments = [...semanticByCase.entries()].flatMap(([caseId, criteria]) => criteria.map((criterion) => ({ caseId, ...criterion })));
    const completedAt = clock.now();
    const attempted = providerRecords.length;
    const completed = providerRecords.filter((record) => record.status === 'completion').length;
    const timeout = providerRecords.filter((record) => record.status === 'timeout').length;
    const error = providerRecords.filter((record) => record.status === 'error').length;
    const terminal: TerminalReceipt = {
      schemaVersion: 1, status: terminalStatus, stoppingRule, recommendation,
      decisionQuestion: spec.decision.question, proceedMeaning: spec.decision.proceedMeaning,
      snapshot: spec.skill, condition: spec.execution, claims,
      directObservations: cases.flatMap((item) => item.checks), semanticAssessments, cases,
      judgeQualification: { attempted: judgeAttempted, valid: judgeValid, summary: judgeSummary },
      calls: {
        authorized: 4, attempted, completed, timeout, error, maximum: 4, retries: 0,
        wallTimeMs: providerRecords.reduce((sum, record) => sum + record.elapsedMs, 0),
        usage: usageTotal(providerRecords),
      },
      cost: estimateApiEquivalent(providerRecords.map((record) => ({ model: record.model, ...(record.usage === undefined ? {} : { usage: record.usage }) }))),
      limitations: limitationsFor(clock.maxWallClockSkewMs()),
      suggestedAction: suggestedAction(recommendation),
      reevaluationTriggers: REEVALUATION_TRIGGERS,
      completedAt: completedAt.toISOString(),
    };
    await writeJsonCreateOnly(path.join(out, 'terminal.json'), terminal);
    const exitCode = terminalStatus === 'COMPLETED' || terminalStatus === 'CRITICAL_VIOLATION' ? 0 : 3;
    return { exitCode, terminal };
  } finally {
    await temporaryHome?.cleanup();
  }
}
