import { constants, open } from 'node:fs/promises';
import path from 'node:path';
import Ajv, { type ErrorObject } from 'ajv';
import { usageError } from '../errors.js';
import { assertPathHasNoSymlinkComponents, scanTree } from '../intake/tree.js';
import { canonicalJson } from './canonical.js';
import { evaluationSpecSchema, initAnswersSchema } from './schema.js';
import { CASE_KINDS, FIXTURE_DIRECTORY, type EvaluationSpec, type InitAnswers } from './types.js';

const AjvConstructor = Ajv as unknown as typeof import('ajv').default;
const ajv = new AjvConstructor({ allErrors: true, strict: true, allowUnionTypes: true });
const validateSpecSchema = ajv.compile<EvaluationSpec>(evaluationSpecSchema);
const validateAnswersSchema = ajv.compile<InitAnswers>(initAnswersSchema);

function errorsText(errors: ErrorObject[] | null | undefined): string {
  return (errors ?? []).map((error) => `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`).join('; ');
}

function ensureUnique(values: string[], description: string): void {
  if (new Set(values).size !== values.length) {
    throw usageError(`${description} must be unique`);
  }
}

export function assertSafeRelativePath(value: string, description = 'path'): void {
  if (
    value.length === 0 ||
    value.includes('\0') ||
    value.includes('\\') ||
    path.posix.isAbsolute(value) ||
    path.posix.normalize(value) !== value ||
    value.split('/').includes('..') ||
    value === '.'
  ) {
    throw usageError(`${description} is not a confined normalized POSIX path: ${JSON.stringify(value)}`);
  }
}

function assertNoRemoteRefs(value: unknown, location: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoRemoteRefs(item, `${location}/${index}`));
  } else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (key === '$ref' && (typeof item !== 'string' || !item.startsWith('#'))) {
        throw usageError(`${location} contains a non-local JSON Schema reference`);
      }
      assertNoRemoteRefs(item, `${location}/${key}`);
    }
  }
}

export function validateAnswers(value: unknown): InitAnswers {
  if (!validateAnswersSchema(value)) {
    throw usageError(`Invalid answers: ${errorsText(validateAnswersSchema.errors)}`);
  }
  const answers = value;
  validateRelations(answers, false);
  return answers;
}

function validateRelations(value: EvaluationSpec | InitAnswers, checkFixturePaths: boolean): void {
  const claimIds = value.claims.map((claim) => claim.id);
  ensureUnique(claimIds, 'Claim ids');
  const caseIds = value.cases.map((item) => item.id);
  ensureUnique(caseIds, 'Case ids');
  ensureUnique(value.cases.map((item) => item.kind), 'Case kinds');
  if (CASE_KINDS.some((kind) => !value.cases.some((item) => item.kind === kind))) {
    throw usageError('Exactly one case of each required kind is required');
  }
  if (value.cases.some((item, index) => item.kind !== CASE_KINDS[index])) {
    throw usageError('Cases must be ordered POSITIVE, INVALID_SAFETY, NEAR_BOUNDARY');
  }

  const nestedIds: string[] = [];
  for (const item of value.cases) {
    for (const claimId of item.claimIds) {
      if (!claimIds.includes(claimId)) throw usageError(`Case ${item.id} references unknown claim ${claimId}`);
    }
    for (const check of item.checks) {
      nestedIds.push(check.id);
      if (!item.claimIds.includes(check.claimId)) throw usageError(`Check ${check.id} references claim outside case ${item.id}`);
      if ('path' in check) assertSafeRelativePath(check.path, `Check ${check.id} path`);
      if ('paths' in check) check.paths.forEach((entry) => assertSafeRelativePath(entry, `Check ${check.id} allowlist path`));
      if (check.operator === 'FINAL_JSON_SCHEMA') {
        assertNoRemoteRefs(check.schema, `Check ${check.id}`);
        try {
          new AjvConstructor({ strict: false }).compile(check.schema);
        } catch (error) {
          throw usageError(`Check ${check.id} contains an invalid JSON Schema: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    for (const criterion of item.semanticCriteria) {
      nestedIds.push(criterion.id);
      if (!item.claimIds.includes(criterion.claimId)) throw usageError(`Criterion ${criterion.id} references claim outside case ${item.id}`);
    }
    ensureUnique(item.checks.map((check) => check.id), `Check ids in case ${item.id}`);
    ensureUnique(item.semanticCriteria.map((criterion) => criterion.id), `Criterion ids in case ${item.id}`);
    if (checkFixturePaths && 'fixturePath' in item && item.fixturePath !== null) {
      const expected = `fixtures/${FIXTURE_DIRECTORY[item.kind]}`;
      if (item.fixturePath !== expected) throw usageError(`Case ${item.id} fixturePath must be ${expected}`);
      assertSafeRelativePath(item.fixturePath, `Case ${item.id} fixturePath`);
    }
  }
  ensureUnique(nestedIds, 'Check and criterion ids');

  for (const claim of value.claims) {
    const hasRequiredDirect = value.cases.some((item) => item.checks.some((check) => check.claimId === claim.id && check.required));
    const hasRequiredSemantic = value.cases.some((item) => item.semanticCriteria.some((criterion) => criterion.claimId === claim.id && criterion.required));
    const hasActivationObservation = claim.kind === 'ACTIVATION' && value.cases.some((item) => item.claimIds.includes(claim.id) && item.activationExpectation !== 'NOT_ASSERTED');
    if (claim.required && !(hasRequiredDirect || hasRequiredSemantic || hasActivationObservation)) {
      throw usageError(`Required claim ${claim.id} has no required prespecified evidence`);
    }
    if (claim.required && claim.failureDecision === 'ADVISORY') {
      throw usageError(`Required claim ${claim.id} cannot have ADVISORY failureDecision`);
    }
  }
  if (!value.claims.some((claim) => claim.required && claim.failureDecision !== 'ADVISORY')) {
    throw usageError('At least one required claim must define a stopping decision');
  }
}

export function validateSpec(value: unknown): EvaluationSpec {
  if (!validateSpecSchema(value)) {
    throw usageError(`Invalid evaluation spec: ${errorsText(validateSpecSchema.errors)}`);
  }
  const spec = value;
  if (!Number.isFinite(Date.parse(spec.createdAt)) || !/^\d{4}-\d{2}-\d{2}T/.test(spec.createdAt)) {
    throw usageError('createdAt must be an ISO-8601 timestamp');
  }
  validateRelations(spec, true);
  return spec;
}

export async function readCanonicalSpec(specPath: string): Promise<EvaluationSpec> {
  let bytes: string;
  await assertPathHasNoSymlinkComponents(specPath);
  try {
    const handle = await open(specPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await handle.stat({ bigint: true });
      if (!before.isFile() || before.nlink !== 1n) throw usageError('Spec must be a single regular non-symlink file');
      bytes = await handle.readFile({ encoding: 'utf8' });
      const after = await handle.stat({ bigint: true });
      if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs) {
        throw usageError('Spec changed while being read');
      }
    } finally {
      await handle.close();
    }
  } catch (error) {
    throw usageError(`Cannot read spec ${specPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes) as unknown;
  } catch {
    throw usageError(`Spec is not valid JSON: ${specPath}`);
  }
  const spec = validateSpec(parsed);
  if (bytes !== canonicalJson(spec)) {
    throw usageError('Spec JSON is not canonical (sorted keys, two-space indentation, trailing newline)');
  }
  return spec;
}

export async function checkEvaluationPackage(specPath: string): Promise<EvaluationSpec> {
  const absoluteSpec = path.resolve(specPath);
  const spec = await readCanonicalSpec(absoluteSpec);
  const root = path.dirname(absoluteSpec);
  const skillPath = path.join(root, spec.skill.snapshotPath);
  const skillTree = await scanTree(skillPath, { requireSkillMd: true });
  if (skillTree.digest !== spec.skill.sha256) throw usageError('Skill snapshot digest does not match the spec');
  for (const item of spec.cases) {
    const fixtureRoot = path.join(root, 'fixtures', FIXTURE_DIRECTORY[item.kind]);
    const fixture = await scanTree(fixtureRoot, { allowEmpty: true });
    if (item.fixturePath === null && (fixture.entries.length > 0 || fixture.directories.length > 0)) {
      throw usageError(`Case ${item.id} declares no fixture but its fixture directory is not empty`);
    }
  }
  return spec;
}
