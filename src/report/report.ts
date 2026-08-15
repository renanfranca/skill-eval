import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { integrityError, usageError } from '../errors.js';
import { writeCreateOnly } from '../evidence/persistence.js';
import { canonicalJson, sha256Bytes } from '../spec/canonical.js';
import { assertPathHasNoSymlinkComponents } from '../intake/tree.js';
import { assertSafeRelativePath, validateSpec } from '../spec/validate.js';
import type { EvaluationSpec } from '../spec/types.js';
import type { ClaimAssessment, TerminalReceipt } from '../run/types.js';

interface Manifest {
  schemaVersion: 1;
  evaluationId: string;
  spec: EvaluationSpec;
  digests: { spec: string };
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

function incompleteClaims(spec: EvaluationSpec): ClaimAssessment[] {
  return spec.claims.map((claim) => ({
    claimId: claim.id, statement: claim.statement, required: claim.required, failureDecision: claim.failureDecision,
    status: 'NOT_ASSESSED', evidenceRefs: [], basis: 'The run has no confirmed terminal receipt; absent evidence was not inferred',
  }));
}

async function validateTerminalReceipt(
  runDirectory: string,
  manifest: Manifest,
  terminal: TerminalReceipt,
  events: Array<Record<string, unknown>>,
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
  const attemptedEvents = events.filter((event) => event['event'] === 'CALL_ATTEMPTED').length;
  const attemptRecords = events.filter((event) => event['event'] === 'CALL_ATTEMPTED');
  const caseRecords = events.filter((event) => event['event'] === 'CASE_RESULT');
  const caseEvents = caseRecords.length;
  if (attemptedEvents !== terminal.calls.attempted || caseEvents !== terminal.cases.length) {
    throw integrityError('Terminal receipt disagrees with append-only accounting events');
  }
  if (attemptRecords.some((event, index) => event['callNumber'] !== index + 1 || (event['role'] !== 'candidate' && event['role'] !== 'judge'))) {
    throw integrityError('Append-only call accounting contains a gap, duplicate, or invalid role');
  }
  const allowedClaims = new Set(manifest.spec.claims.map((claim) => claim.id));
  if (terminal.claims.length !== allowedClaims.size || terminal.claims.some((claim) => !allowedClaims.has(claim.claimId))) {
    throw integrityError('Terminal receipt claim set disagrees with the frozen spec');
  }
  const allowedCases = new Set(manifest.spec.cases.map((item) => item.id));
  if (new Set(terminal.cases.map((item) => item.caseId)).size !== terminal.cases.length || terminal.cases.some((item) => !allowedCases.has(item.caseId))) {
    throw integrityError('Terminal receipt contains an unknown or duplicate case');
  }
  for (const item of terminal.cases) {
    const event = caseRecords.find((candidate) => candidate['caseId'] === item.caseId);
    if (event === undefined) throw integrityError(`Append-only result for case ${item.caseId} is missing`);
    const eventRecord = { ...event };
    delete eventRecord['event'];
    if (canonicalJson(eventRecord) !== canonicalJson(item)) throw integrityError(`Terminal result for case ${item.caseId} disagrees with append-only evidence`);
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
  if (terminal !== undefined) {
    await validateTerminalReceipt(runDirectory, manifest, terminal, events);
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
  const attempts = events.filter((event) => event['event'] === 'CALL_ATTEMPTED').length;
  const completedCases = events.filter((event) => event['event'] === 'CASE_RESULT');
  const completed = completedCases.filter((event) => event['status'] === 'COMPLETED').length;
  const timeout = completedCases.filter((event) => event['status'] === 'TIMEOUT').length;
  const providerErrors = completedCases.filter((event) => event['status'] === 'PROVIDER_ERROR' || event['status'] === 'ENVIRONMENT_FAILURE').length;
  const last = events.at(-1);
  return {
    schemaVersion: 1, evaluationId: manifest.evaluationId,
    decision: { question: manifest.spec.decision.question, proceedMeaning: manifest.spec.decision.proceedMeaning, recommendation: 'NO_DECISION' },
    terminal: { status: 'INTERRUPTED_UNCONFIRMED', stoppingRule: 'No terminal receipt exists; provider calls are never resumed from this directory' },
    snapshot: manifest.spec.skill, condition: manifest.spec.execution, claims: incompleteClaims(manifest.spec),
    directObservations: [], semanticAssessments: [], cases: [],
    judgeQualification: { attempted: events.some((event) => event['role'] === 'judge'), valid: null, summary: 'No confirmed judge qualification is available' },
    calls: {
      authorized: 4, attempted: attempts, completed, timeout, error: providerErrors,
      maximum: 4, retries: 0, wallTimeMs: 0, usage: {},
    },
    cost: {
      actualChatGptCost: 'UNKNOWN', actualChatGptCostReason: 'ChatGPT account usage has no auditable monetary unit',
      apiEquivalentEstimateUsd: 'UNKNOWN', apiEquivalentEstimateReason: 'The interrupted run has no complete auditable usage decomposition',
      priceTableVersion: '2026-08-15',
    },
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
