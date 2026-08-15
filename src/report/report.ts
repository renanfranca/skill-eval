import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { integrityError, usageError } from '../errors.js';
import { estimateApiEquivalent, PRICE_TABLE } from '../evidence/cost.js';
import { writeCreateOnly } from '../evidence/persistence.js';
import { canonicalJson, sha256Bytes } from '../spec/canonical.js';
import { assertPathHasNoSymlinkComponents } from '../intake/tree.js';
import { assertSafeRelativePath, validateSpec } from '../spec/validate.js';
import type { EvaluationSpec } from '../spec/types.js';
import type { TokenUsage } from '../runtime/provider.js';
import { assessClaims } from '../run/decision.js';
import type { CaseRecord, ClaimAssessment, TerminalReceipt } from '../run/types.js';

interface Manifest {
  schemaVersion: 1;
  evaluationId: string;
  spec: EvaluationSpec;
  digests: { spec: string };
}

interface CallAttemptEvent {
  event: 'CALL_ATTEMPTED';
  callNumber: number;
  role: 'candidate' | 'judge';
  caseId?: string;
  at: string;
}

interface CallResultEvent {
  event: 'CALL_RESULT';
  callNumber: number;
  role: 'candidate' | 'judge';
  model: 'gpt-5.6-luna' | 'gpt-5.6-terra';
  caseId?: string;
  status: 'completion' | 'timeout' | 'error';
  elapsedMs: number;
  usage?: TokenUsage;
  message?: string;
  at: string;
}

interface AccountingEvidence {
  attempts: CallAttemptEvent[];
  results: CallResultEvent[];
  cases: CaseRecord[];
}

export interface ReportData {
  schemaVersion: 1;
  evaluationId: string;
  decision: {
    question: string;
    proceedMeaning: string;
    recommendation: TerminalReceipt['recommendation'];
  };
  terminal: { status: TerminalReceipt['status']; stoppingRule: string };
  snapshot: EvaluationSpec['skill'];
  condition: EvaluationSpec['execution'];
  claims: ClaimAssessment[];
  directObservations: TerminalReceipt['directObservations'];
  semanticAssessments: TerminalReceipt['semanticAssessments'];
  cases: TerminalReceipt['cases'];
  judgeQualification: TerminalReceipt['judgeQualification'];
  calls: TerminalReceipt['calls'];
  cost: TerminalReceipt['cost'];
  limitations: string[];
  suggestedAction: string;
  reevaluationTriggers: string[];
  lastConfirmedEvidence: string;
}

async function readCanonicalJson<T>(filePath: string): Promise<T> {
  let bytes: string;
  try { bytes = await readFile(filePath, 'utf8'); } catch { throw integrityError(`Required run artifact is missing: ${filePath}`); }
  let value: unknown;
  try { value = JSON.parse(bytes) as unknown; } catch { throw integrityError(`Run artifact is corrupt JSON: ${filePath}`); }
  if (canonicalJson(value) !== bytes) throw integrityError(`Run artifact is not canonical: ${filePath}`);
  return value as T;
}

async function readEvents(runDirectory: string): Promise<Array<Record<string, unknown>>> {
  const filePath = path.join(runDirectory, 'case-results.jsonl');
  let bytes: string;
  try { bytes = await readFile(filePath, 'utf8'); } catch { return []; }
  const events: Array<Record<string, unknown>> = [];
  for (const line of bytes.split('\n').filter(Boolean)) {
    try {
      const value = JSON.parse(line) as unknown;
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) events.push(value as Record<string, unknown>);
      else throw new Error('not an object');
    } catch {
      throw integrityError('case-results.jsonl contains corrupt evidence');
    }
  }
  return events;
}

function hasExactKeys(value: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => keys.includes(key)) && keys.every((key) => allowed.has(key));
}

function validNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function parseUsage(value: unknown): TokenUsage | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw integrityError('Append-only usage evidence is invalid');
  const record = value as Record<string, unknown>;
  const fields = ['input', 'cachedInput', 'output', 'reasoningOutput'];
  if (!hasExactKeys(record, [], fields) || Object.values(record).some((item) => !validNonNegativeNumber(item))) {
    throw integrityError('Append-only usage evidence is invalid');
  }
  return record as TokenUsage;
}

function parseCaseRecord(event: Record<string, unknown>): CaseRecord {
  const required = ['event', 'caseId', 'kind', 'callNumber', 'status', 'elapsedMs', 'filesystemChanges', 'checks', 'activation'];
  const optional = ['usage', 'error', 'finalOutputRef', 'filesystemDiffRef', 'promptfooProjectionRef'];
  if (!hasExactKeys(event, required, optional)) throw integrityError('Append-only case result shape is invalid');
  if (
    typeof event['caseId'] !== 'string' || !['POSITIVE', 'INVALID_SAFETY', 'NEAR_BOUNDARY'].includes(String(event['kind'])) ||
    !Number.isInteger(event['callNumber']) || (event['callNumber'] as number) < 0 ||
    !['COMPLETED', 'TIMEOUT', 'PROVIDER_ERROR', 'ENVIRONMENT_FAILURE'].includes(String(event['status'])) ||
    !validNonNegativeNumber(event['elapsedMs']) || !Array.isArray(event['filesystemChanges']) || !Array.isArray(event['checks'])
  ) throw integrityError('Append-only case result content is invalid');
  for (const change of event['filesystemChanges']) {
    if (change === null || typeof change !== 'object' || Array.isArray(change)) throw integrityError('Append-only filesystem observation is invalid');
    const record = change as Record<string, unknown>;
    if (
      !hasExactKeys(record, ['path', 'change'], ['beforeSha256', 'afterSha256']) || typeof record['path'] !== 'string' ||
      !['CREATED', 'MODIFIED', 'REMOVED'].includes(String(record['change'])) ||
      (record['beforeSha256'] !== undefined && typeof record['beforeSha256'] !== 'string') ||
      (record['afterSha256'] !== undefined && typeof record['afterSha256'] !== 'string')
    ) throw integrityError('Append-only filesystem observation is invalid');
  }
  for (const check of event['checks']) {
    if (check === null || typeof check !== 'object' || Array.isArray(check)) throw integrityError('Append-only direct check observation is invalid');
    const record = check as Record<string, unknown>;
    if (
      !hasExactKeys(record, ['checkId', 'claimId', 'operator', 'required', 'failureDecision', 'status', 'passed', 'observation']) ||
      typeof record['checkId'] !== 'string' || typeof record['claimId'] !== 'string' || typeof record['operator'] !== 'string' ||
      typeof record['required'] !== 'boolean' || !['REVISE', 'DO_NOT_PROCEED', 'ADVISORY'].includes(String(record['failureDecision'])) ||
      !['APPLIED', 'INSTRUMENT_INVALID'].includes(String(record['status'])) || typeof record['passed'] !== 'boolean' ||
      typeof record['observation'] !== 'string'
    ) throw integrityError('Append-only direct check observation is invalid');
  }
  const activation = event['activation'];
  if (activation === null || typeof activation !== 'object' || Array.isArray(activation)) throw integrityError('Append-only activation observation is invalid');
  const activationRecord = activation as Record<string, unknown>;
  if (
    !hasExactKeys(activationRecord, ['expectation', 'skillMdRead', 'promptfooSkillUsedHeuristic']) ||
    !['MUST_ACTIVATE', 'MUST_NOT_ACTIVATE', 'NOT_ASSERTED'].includes(String(activationRecord['expectation'])) ||
    typeof activationRecord['skillMdRead'] !== 'boolean' || typeof activationRecord['promptfooSkillUsedHeuristic'] !== 'boolean'
  ) throw integrityError('Append-only activation observation is invalid');
  parseUsage(event['usage']);
  for (const key of ['error', 'finalOutputRef', 'filesystemDiffRef', 'promptfooProjectionRef']) {
    if (event[key] !== undefined && typeof event[key] !== 'string') throw integrityError('Append-only case evidence reference is invalid');
  }
  const record = { ...event };
  delete record['event'];
  return record as unknown as CaseRecord;
}

function parseAccountingEvents(manifest: Manifest, events: Array<Record<string, unknown>>): AccountingEvidence {
  const attempts: CallAttemptEvent[] = [];
  const results: CallResultEvent[] = [];
  const cases: CaseRecord[] = [];
  const allowedCases = new Set(manifest.spec.cases.map((item) => item.id));
  for (const [index, event] of events.entries()) {
    if (event['event'] === 'CALL_ATTEMPTED') {
      if (!hasExactKeys(event, ['event', 'callNumber', 'role', 'at'], ['caseId'])) throw integrityError('Append-only call attempt shape is invalid');
      const role = event['role'];
      const caseId = event['caseId'];
      if (
        event['callNumber'] !== attempts.length + 1 || attempts.length >= 4 || (role !== 'candidate' && role !== 'judge') ||
        typeof event['at'] !== 'string' || (role === 'candidate' ? typeof caseId !== 'string' || !allowedCases.has(caseId) : caseId !== undefined)
      ) throw integrityError('Append-only call accounting contains a gap, duplicate, or invalid role');
      if (attempts.length !== results.length) throw integrityError('A later call was attempted before the preceding result was confirmed');
      attempts.push(event as unknown as CallAttemptEvent);
      continue;
    }
    if (event['event'] === 'CALL_RESULT') {
      const required = ['event', 'callNumber', 'role', 'model', 'status', 'elapsedMs', 'at'];
      if (!hasExactKeys(event, required, ['caseId', 'usage', 'message'])) throw integrityError('Append-only provider result shape is invalid');
      const attempt = attempts.at(-1);
      const role = event['role'];
      const status = event['status'];
      const model = event['model'];
      const caseId = event['caseId'];
      if (
        attempt === undefined || index === 0 || events[index - 1]?.['event'] !== 'CALL_ATTEMPTED' || results.length !== attempts.length - 1 ||
        event['callNumber'] !== attempt.callNumber || role !== attempt.role || caseId !== attempt.caseId ||
        (role === 'candidate' ? model !== 'gpt-5.6-luna' : model !== 'gpt-5.6-terra') ||
        !['completion', 'timeout', 'error'].includes(String(status)) || !validNonNegativeNumber(event['elapsedMs']) || typeof event['at'] !== 'string' ||
        (status === 'completion' ? event['message'] !== undefined : typeof event['message'] !== 'string')
      ) throw integrityError('Append-only provider result does not match its immediately preceding attempt');
      parseUsage(event['usage']);
      results.push(event as unknown as CallResultEvent);
      continue;
    }
    if (event['event'] === 'CASE_RESULT') {
      cases.push(parseCaseRecord(event));
      continue;
    }
    throw integrityError('case-results.jsonl contains an unknown event');
  }
  return { attempts, results, cases };
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

async function validateCaseRecords(runDirectory: string, manifest: Manifest, cases: CaseRecord[]): Promise<void> {
  const allowedCases = new Map(manifest.spec.cases.map((item) => [item.id, item]));
  if (
    new Set(cases.map((item) => item.caseId)).size !== cases.length ||
    cases.some((item, index) => item.caseId !== manifest.spec.cases[index]?.id || !allowedCases.has(item.caseId))
  ) throw integrityError('Append-only evidence contains an unknown, duplicate, or out-of-order case');
  for (const item of cases) {
    const evaluationCase = allowedCases.get(item.caseId);
    if (evaluationCase === undefined || item.kind !== evaluationCase.kind || item.activation.expectation !== evaluationCase.activationExpectation) {
      throw integrityError(`Append-only result for case ${item.caseId} disagrees with the frozen spec`);
    }
    if (item.status === 'COMPLETED') {
      if (item.checks.length !== evaluationCase.checks.length) throw integrityError(`Completed case ${item.caseId} has an incomplete direct check set`);
      for (const [index, check] of item.checks.entries()) {
        const expected = evaluationCase.checks[index];
        if (
          expected === undefined || check.checkId !== expected.id || check.claimId !== expected.claimId || check.operator !== expected.operator ||
          check.required !== expected.required || check.failureDecision !== expected.failureDecision ||
          (check.status === 'INSTRUMENT_INVALID' && check.passed)
        ) throw integrityError(`Direct check evidence for case ${item.caseId} disagrees with the frozen spec`);
      }
    } else if (item.checks.length !== 0) {
      throw integrityError(`Incomplete case ${item.caseId} contains unexpected direct check evidence`);
    }
    const refs = [
      [item.finalOutputRef, `evidence/final-outputs/${item.caseId}.txt`],
      [item.filesystemDiffRef, `evidence/filesystem-diffs/${item.caseId}.json`],
      [item.promptfooProjectionRef, `evidence/promptfoo-projections/${item.caseId}.json`],
    ] as const;
    if (item.status === 'COMPLETED' && refs.some(([ref, expected]) => ref !== expected)) {
      throw integrityError(`Completed case ${item.caseId} has incomplete or unexpected evidence references`);
    }
    for (const [ref, expected] of refs) {
      if (ref === undefined) continue;
      if (ref !== expected) throw integrityError(`Evidence reference has an unexpected location: ${ref}`);
      assertSafeRelativePath(ref, 'Evidence reference');
      const target = path.join(runDirectory, ...ref.split('/'));
      const details = await lstat(target).catch(() => undefined);
      if (details === undefined || !details.isFile() || details.isSymbolicLink()) throw integrityError(`Evidence reference is missing or unsafe: ${ref}`);
    }
  }
}

async function validateTerminalReceipt(
  runDirectory: string,
  manifest: Manifest,
  terminal: TerminalReceipt,
  evidence: AccountingEvidence,
): Promise<void> {
  const runtimeReceipt = terminal as unknown as {
    schemaVersion: unknown;
    calls: { authorized: unknown; maximum: unknown; retries: unknown };
  };
  const statuses = [
    'COMPLETED', 'INSTRUMENT_INVALID', 'AUTHORIZATION_MISSING', 'EXECUTION_TIMEOUT', 'PROVIDER_ERROR',
    'ENVIRONMENT_FAILURE', 'CRITICAL_VIOLATION', 'JUDGE_INVALID', 'INTERRUPTED_UNCONFIRMED',
  ];
  const recommendations = ['PROCEED', 'REVISE', 'DO_NOT_PROCEED', 'NO_DECISION'];
  if (
    runtimeReceipt.schemaVersion !== 1 || !statuses.includes(terminal.status) || !recommendations.includes(terminal.recommendation) ||
    runtimeReceipt.calls.authorized !== 4 || runtimeReceipt.calls.maximum !== 4 || runtimeReceipt.calls.retries !== 0 ||
    !Number.isInteger(terminal.calls.attempted) || terminal.calls.attempted < 0 || terminal.calls.attempted > 4 ||
    canonicalJson(terminal.condition) !== canonicalJson(manifest.spec.execution) ||
    canonicalJson(terminal.snapshot) !== canonicalJson(manifest.spec.skill) ||
    terminal.decisionQuestion !== manifest.spec.decision.question || terminal.proceedMeaning !== manifest.spec.decision.proceedMeaning
  ) throw integrityError('Terminal receipt violates frozen run invariants');
  const completed = evidence.results.filter((event) => event.status === 'completion').length;
  const timeout = evidence.results.filter((event) => event.status === 'timeout').length;
  const error = evidence.results.filter((event) => event.status === 'error').length;
  const wallTimeMs = evidence.results.reduce((sum, event) => sum + event.elapsedMs, 0);
  const usage = usageTotal(evidence.results);
  const cost = estimateApiEquivalent(evidence.results.map((event) => ({ model: event.model, ...(event.usage === undefined ? {} : { usage: event.usage }) })));
  if (
    evidence.attempts.length !== terminal.calls.attempted || evidence.results.length !== terminal.calls.attempted ||
    evidence.cases.length !== terminal.cases.length || terminal.calls.completed !== completed || terminal.calls.timeout !== timeout ||
    terminal.calls.error !== error || terminal.calls.wallTimeMs !== wallTimeMs || canonicalJson(terminal.calls.usage) !== canonicalJson(usage) ||
    canonicalJson(terminal.cost) !== canonicalJson(cost)
  ) {
    throw integrityError('Terminal receipt disagrees with append-only accounting events');
  }
  const allowedClaims = new Set(manifest.spec.claims.map((claim) => claim.id));
  if (terminal.claims.length !== allowedClaims.size || terminal.claims.some((claim) => !allowedClaims.has(claim.claimId))) {
    throw integrityError('Terminal receipt claim set disagrees with the frozen spec');
  }
  await validateCaseRecords(runDirectory, manifest, evidence.cases);
  for (const item of terminal.cases) {
    const event = evidence.cases.find((candidate) => candidate.caseId === item.caseId);
    if (event === undefined) throw integrityError(`Append-only result for case ${item.caseId} is missing`);
    if (canonicalJson(event) !== canonicalJson(item)) throw integrityError(`Terminal result for case ${item.caseId} disagrees with append-only evidence`);
  }
  if (canonicalJson(terminal.directObservations) !== canonicalJson(terminal.cases.flatMap((item) => item.checks))) {
    throw integrityError('Terminal direct observations disagree with confirmed case evidence');
  }
}

export async function buildReport(runDirectoryValue: string): Promise<ReportData> {
  const runDirectory = path.resolve(runDirectoryValue);
  const manifest = await readCanonicalJson<Manifest>(path.join(runDirectory, 'manifest.json'));
  try { validateSpec(manifest.spec); }
  catch { throw integrityError('Frozen evaluation spec in manifest is invalid'); }
  if (manifest.evaluationId !== manifest.spec.evaluationId) {
    throw integrityError('Run manifest shape or evaluation identity is invalid');
  }
  if (sha256Bytes(canonicalJson(manifest.spec)) !== manifest.digests.spec) throw integrityError('Frozen spec digest in manifest is invalid');
  let terminal: TerminalReceipt | undefined;
  try {
    terminal = await readCanonicalJson<TerminalReceipt>(path.join(runDirectory, 'terminal.json'));
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('missing')) throw error;
  }
  const events = await readEvents(runDirectory);
  const evidence = parseAccountingEvents(manifest, events);
  if (terminal !== undefined) {
    await validateTerminalReceipt(runDirectory, manifest, terminal, evidence);
    return {
      schemaVersion: 1, evaluationId: manifest.evaluationId,
      decision: { question: terminal.decisionQuestion, proceedMeaning: terminal.proceedMeaning, recommendation: terminal.recommendation },
      terminal: { status: terminal.status, stoppingRule: terminal.stoppingRule },
      snapshot: terminal.snapshot, condition: terminal.condition, claims: terminal.claims,
      directObservations: terminal.directObservations, semanticAssessments: terminal.semanticAssessments,
      cases: terminal.cases, judgeQualification: terminal.judgeQualification, calls: terminal.calls, cost: terminal.cost,
      limitations: terminal.limitations, suggestedAction: terminal.suggestedAction,
      reevaluationTriggers: terminal.reevaluationTriggers,
      lastConfirmedEvidence: 'terminal.json is present and integrity-checked',
    };
  }
  await validateCaseRecords(runDirectory, manifest, evidence.cases);
  const completed = evidence.results.filter((event) => event.status === 'completion').length;
  const timeout = evidence.results.filter((event) => event.status === 'timeout').length;
  const providerErrors = evidence.results.filter((event) => event.status === 'error').length;
  const usage = usageTotal(evidence.results);
  const wallTimeMs = evidence.results.reduce((sum, event) => sum + event.elapsedMs, 0);
  const cost = evidence.results.length === evidence.attempts.length
    ? estimateApiEquivalent(evidence.results.map((event) => ({ model: event.model, ...(event.usage === undefined ? {} : { usage: event.usage }) })))
    : {
        actualChatGptCost: 'UNKNOWN' as const,
        actualChatGptCostReason: 'ChatGPT account usage has no auditable monetary unit',
        apiEquivalentEstimateUsd: 'UNKNOWN' as const,
        apiEquivalentEstimateReason: 'At least one attempted provider call has no confirmed result event',
        priceTableVersion: PRICE_TABLE.version,
      };
  const claims = assessClaims(manifest.spec, evidence.cases, new Map(), false);
  const last = events.at(-1);
  return {
    schemaVersion: 1, evaluationId: manifest.evaluationId,
    decision: { question: manifest.spec.decision.question, proceedMeaning: manifest.spec.decision.proceedMeaning, recommendation: 'NO_DECISION' },
    terminal: { status: 'INTERRUPTED_UNCONFIRMED', stoppingRule: 'No terminal receipt exists; provider calls are never resumed from this directory' },
    snapshot: manifest.spec.skill, condition: manifest.spec.execution, claims,
    directObservations: evidence.cases.flatMap((item) => item.checks), semanticAssessments: [], cases: evidence.cases,
    judgeQualification: { attempted: evidence.attempts.some((event) => event.role === 'judge'), valid: null, summary: 'No confirmed judge qualification is available without a terminal receipt' },
    calls: {
      authorized: 4, attempted: evidence.attempts.length, completed, timeout, error: providerErrors,
      maximum: 4, retries: 0, wallTimeMs, usage,
    },
    cost,
    limitations: [
      'This run is incomplete and cannot support a decision.',
      'Three cases cannot establish stability, robustness, causality, population reliability, or generalization.',
      'workspace-write is not a virtualization boundary against a malicious same-user process.',
    ],
    suggestedAction: 'Create a separate run directory with a new literal authorization; never resume this run.',
    reevaluationTriggers: ['incomplete or interrupted evidence'],
    lastConfirmedEvidence: last === undefined
      ? 'Only the manifest and initial budget ledger are confirmed'
      : `Last append-only event: ${typeof last['event'] === 'string' ? last['event'] : 'unknown'}`,
  };
}

function markdownTable(rows: string[][]): string {
  const headers = rows[0] ?? [];
  return [
    '| ' + headers.join(' | ') + ' |',
    '| ' + headers.map(() => '---').join(' | ') + ' |',
    ...rows.slice(1).map((row) => '| ' + row.map((cell) => cell.replaceAll('|', '\\|').replaceAll('\n', ' ')).join(' | ') + ' |'),
  ].join('\n');
}

export function renderMarkdown(report: ReportData): string {
  const claims = report.claims.length === 0
    ? '_No claims assessed._'
    : markdownTable([
        ['Claim', 'Required', 'Status', 'Failure decision', 'Basis'],
        ...report.claims.map((claim) => [claim.claimId, String(claim.required), claim.status, claim.failureDecision, claim.basis]),
      ]);
  const cases = report.cases.length === 0
    ? '_No completed case evidence._'
    : markdownTable([
        ['Case', 'Kind', 'Status', 'Elapsed ms', 'Checks'],
        ...report.cases.map((item) => [item.caseId, item.kind, item.status, String(item.elapsedMs), `${item.checks.filter((check) => check.passed).length}/${item.checks.length}`]),
      ]);
  return `# skill-eval report\n\n` +
    `- Evaluation: \`${report.evaluationId}\`\n` +
    `- Decision question: ${report.decision.question}\n` +
    `- Recommendation: **${report.decision.recommendation}**\n` +
    `- Terminal status: \`${report.terminal.status}\`\n` +
    `- Stopping rule: ${report.terminal.stoppingRule}\n` +
    `- Last confirmed evidence: ${report.lastConfirmedEvidence}\n\n` +
    `## Claims\n\n${claims}\n\n` +
    `## Direct observations by case\n\n${cases}\n\n` +
    `## Semantic assessment\n\n` +
    `Judge attempted: ${String(report.judgeQualification.attempted)}; valid: ${String(report.judgeQualification.valid)}. ${report.judgeQualification.summary}\n\n` +
    `## Calls and cost\n\n` +
    `Calls: ${report.calls.attempted}/${report.calls.maximum} attempted, ${report.calls.completed} completed, ${report.calls.timeout} timeout, ${report.calls.error} error, ${report.calls.retries} retries.\n\n` +
    `Actual ChatGPT cost: **UNKNOWN**. API-equivalent estimate: **${String(report.cost.apiEquivalentEstimateUsd)}** (${report.cost.apiEquivalentEstimateReason}).\n\n` +
    `## Limitations\n\n${report.limitations.map((item) => `- ${item}`).join('\n')}\n\n` +
    `## Suggested action\n\n${report.suggestedAction}\n\n` +
    `## Re-evaluate when\n\n${report.reevaluationTriggers.map((item) => `- ${item}`).join('\n')}\n\n` +
    `## Canonical report data\n\nThe JSON below is the complete canonical assessment represented by this Markdown report.\n\n` +
    `\`\`\`json\n${canonicalJson(report)}\`\`\`\n`;
}

export async function reportRun(options: { runDirectory: string; format: 'json' | 'markdown'; outFile?: string }): Promise<string> {
  const report = await buildReport(options.runDirectory);
  const output = options.format === 'json' ? canonicalJson(report) : renderMarkdown(report);
  if (options.outFile !== undefined) {
    const parent = path.dirname(path.resolve(options.outFile));
    await assertPathHasNoSymlinkComponents(parent);
    const parentStat = await (await import('node:fs/promises')).lstat(parent).catch(() => undefined);
    if (parentStat === undefined || !parentStat.isDirectory() || parentStat.isSymbolicLink()) throw usageError('Report output parent must be an existing regular directory');
    await writeCreateOnly(path.resolve(options.outFile), output);
  }
  return output;
}
