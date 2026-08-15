import { chmod, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { usageError } from '../errors.js';
import { writeCreateOnly } from '../evidence/persistence.js';
import { scanTree, type ScannedTree } from '../intake/tree.js';
import { FIXTURE_DIRECTORY, type EvaluationCase, type EvaluationSpec } from '../spec/types.js';

export interface TrialWorkspace {
  path: string;
  initialTree: ScannedTree;
  cleanup(): Promise<void>;
}

function isDescendant(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function copyTree(tree: ScannedTree, destination: string): Promise<void> {
  for (const directory of tree.directories) {
    const target = path.join(destination, ...directory.path.split('/'));
    await mkdir(target, { recursive: true, mode: directory.mode });
    await chmod(target, directory.mode);
  }
  for (const entry of tree.entries) {
    const target = path.join(destination, ...entry.path.split('/'));
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await writeCreateOnly(target, entry.bytes, entry.mode);
  }
}

export async function verifyTrialWorkspace(workspace: string, skillName: string): Promise<ScannedTree> {
  const top = (await readdir(workspace)).sort();
  if (!top.includes('.agents')) throw usageError('Trial workspace is missing its isolated target skill');
  if (top.some((name) => name.toLowerCase() === 'agents.md')) throw usageError('Concurrent AGENTS.md rejected from trial workspace');
  const agentsEntries = (await readdir(path.join(workspace, '.agents'))).sort();
  if (agentsEntries.length !== 1 || agentsEntries[0] !== 'skills') throw usageError('Unexpected .agents context in trial workspace');
  const skills = (await readdir(path.join(workspace, '.agents', 'skills'))).sort();
  if (skills.length !== 1 || skills[0] !== skillName) throw usageError('Trial workspace must contain exactly the target skill');
  await scanTree(path.join(workspace, '.agents', 'skills', skillName), { requireSkillMd: true });
  return scanTree(workspace, { allowEmpty: true, permitAgentDirectoryAtRoot: true });
}

export async function createTrialWorkspace(
  packageRoot: string,
  spec: EvaluationSpec,
  evaluationCase: EvaluationCase,
  expectedFixtureDigest?: string,
): Promise<TrialWorkspace> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'skill-eval-trial-'));
  const forbiddenRoots = [packageRoot, os.homedir()];
  if (forbiddenRoots.some((root) => isDescendant(root, workspace))) {
    await rm(workspace, { recursive: true, force: true });
    throw usageError('Temporary trial workspace is inside a forbidden context');
  }
  try {
    const skillTree = await scanTree(path.join(packageRoot, 'skill-snapshot'), { requireSkillMd: true });
    if (skillTree.digest !== spec.skill.sha256) throw usageError('Skill snapshot changed after preflight validation');
    const skillDestination = path.join(workspace, '.agents', 'skills', spec.skill.name);
    await copyTree(skillTree, skillDestination);
    if (evaluationCase.fixturePath !== null) {
      const expected = path.join(packageRoot, 'fixtures', FIXTURE_DIRECTORY[evaluationCase.kind]);
      const fixtureTree = await scanTree(expected, { allowEmpty: true });
      if (expectedFixtureDigest !== undefined && fixtureTree.digest !== expectedFixtureDigest) {
        throw usageError(`Fixture for case ${evaluationCase.id} changed after preflight validation`);
      }
      await copyTree(fixtureTree, workspace);
    }
    const initialTree = await verifyTrialWorkspace(workspace, spec.skill.name);
    return {
      path: workspace,
      initialTree,
      cleanup: async () => rm(workspace, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(workspace, { recursive: true, force: true });
    throw error;
  }
}
