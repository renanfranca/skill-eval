import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { confirm, input } from '@inquirer/prompts';
import { usageError } from '../errors.js';
import { ensureNewDirectory, writeCreateOnly, writeJsonCreateOnly } from '../evidence/persistence.js';
import { canonicalJson } from '../spec/canonical.js';
import { validateAnswers, validateSpec } from '../spec/validate.js';
import {
  FIXTURE_DIRECTORY,
  REQUIRED_EXECUTION,
  type EvaluationCase,
  type EvaluationSpec,
  type InitAnswers,
  type InitCaseAnswer,
} from '../spec/types.js';
import { scanTree, type ScannedTree } from './tree.js';

export interface InitOptions {
  skillDirectory: string;
  outDirectory: string;
  answers?: InitAnswers;
  collectAnswers?: () => Promise<InitAnswers>;
  now?: () => Date;
}

function generatedId(now: Date): string {
  return `evaluation-${now.toISOString().slice(0, 10).replaceAll('-', '')}-${randomBytes(4).toString('hex')}`;
}

function parseJsonAnswer(label: string, value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw usageError(`${label} must be valid JSON`);
  }
}

export async function collectInteractiveAnswers(): Promise<InitAnswers> {
  const question = await input({ message: 'Decision question:' });
  const proceedMeaning = await input({ message: 'Intended use and non-activation boundary:' });
  const claims = parseJsonAnswer(
    'Claims',
    await input({ message: 'Claims JSON array (required outcomes and prohibited effects):' }),
  ) as InitAnswers['claims'];
  const caseAnswers: InitCaseAnswer[] = [];
  for (const kind of ['POSITIVE', 'INVALID_SAFETY', 'NEAR_BOUNDARY'] as const) {
    const answer = parseJsonAnswer(
      `${kind} case`,
      await input({ message: `${kind} case JSON (id, prompt, fixtureSource, claimIds, activationExpectation, checks, semanticCriteria):` }),
    ) as Omit<InitCaseAnswer, 'kind'>;
    caseAnswers.push({ ...answer, kind });
  }
  const candidate: InitAnswers = {
    decision: { question, proceedMeaning },
    claims,
    cases: caseAnswers as InitAnswers['cases'],
  };
  const validated = validateAnswers(candidate);
  process.stderr.write(`${canonicalJson(validated)}\n`);
  const accepted = await confirm({ message: 'Create this evaluation package?', default: false });
  if (!accepted) throw usageError('Initialization cancelled; no package was created');
  return validated;
}

export async function readAnswers(filePath: string): Promise<InitAnswers> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(filePath, 'utf8')) as unknown;
  } catch (error) {
    throw usageError(`Cannot read answers JSON ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return validateAnswers(value);
}

async function copyScannedTree(tree: ScannedTree, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true, mode: 0o700 });
  for (const directory of tree.directories) {
    const target = path.join(destination, ...directory.path.split('/'));
    await mkdir(target, { recursive: true, mode: directory.mode });
    await chmod(target, directory.mode);
  }
  for (const entry of tree.entries) {
    const target = path.join(destination, ...entry.path.split('/'));
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await writeCreateOnly(target, entry.bytes, entry.mode);
    await chmod(target, entry.mode);
  }
}

export async function initializeEvaluation(options: InitOptions): Promise<EvaluationSpec> {
  const now = (options.now ?? (() => new Date()))();
  const answers = validateAnswers(options.answers ?? (await (options.collectAnswers ?? collectInteractiveAnswers)()));
  const skillTree = await scanTree(options.skillDirectory, { requireSkillMd: true });
  const skillName = path.basename(path.resolve(options.skillDirectory));
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(skillName)) {
    throw usageError('Skill directory basename must be a safe Codex skill name');
  }

  const fixtureTrees = new Map<string, ScannedTree>();
  for (const item of answers.cases) {
    if (item.fixtureSource !== null) {
      fixtureTrees.set(item.kind, await scanTree(item.fixtureSource, { allowEmpty: true }));
    }
  }

  const cases = answers.cases.map((item): EvaluationCase => {
    const { fixtureSource, ...specCase } = item;
    return {
      ...specCase,
      fixturePath: fixtureSource === null ? null : `fixtures/${FIXTURE_DIRECTORY[item.kind]}`,
    };
  }) as EvaluationSpec['cases'];
  const spec = validateSpec({
    schemaVersion: 1,
    evaluationId: answers.evaluationId ?? generatedId(now),
    createdAt: now.toISOString(),
    skill: { name: skillName, snapshotPath: 'skill-snapshot', sha256: skillTree.digest },
    decision: answers.decision,
    claims: answers.claims,
    cases,
    execution: REQUIRED_EXECUTION,
    retention: { mode: 'SANITIZED_LOCAL_COMPLETE' },
  });

  const out = path.resolve(options.outDirectory);
  await ensureNewDirectory(out);
  try {
    await copyScannedTree(skillTree, path.join(out, 'skill-snapshot'));
    for (const item of answers.cases) {
      const fixtureDirectory = path.join(out, 'fixtures', FIXTURE_DIRECTORY[item.kind]);
      const tree = fixtureTrees.get(item.kind);
      if (tree === undefined) await mkdir(fixtureDirectory, { recursive: true, mode: 0o700 });
      else await copyScannedTree(tree, fixtureDirectory);
    }
    await writeJsonCreateOnly(path.join(out, 'evaluation-spec.json'), spec);
    return spec;
  } catch (error) {
    await rm(out, { recursive: true, force: true });
    throw error;
  }
}
