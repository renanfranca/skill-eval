import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import Ajv from 'ajv/dist/ajv.js';
import { messageOf } from '../errors.js';
import { redactSecrets, sha256Bytes } from '../spec/canonical.js';
import type { DirectCheck } from '../spec/types.js';
import type { ScannedTree } from '../intake/tree.js';

const AjvConstructor = Ajv as unknown as typeof import('ajv').default;

export interface FilesystemChange {
  path: string;
  change: 'CREATED' | 'MODIFIED' | 'REMOVED';
  beforeSha256?: string;
  afterSha256?: string;
}

export interface CheckResult {
  checkId: string;
  claimId: string;
  operator: DirectCheck['operator'];
  required: boolean;
  failureDecision: DirectCheck['failureDecision'];
  status: 'APPLIED' | 'INSTRUMENT_INVALID';
  passed: boolean;
  observation: string;
}

interface SnapshotNode {
  kind: 'directory' | 'file';
  mode: number;
  sha256?: string;
}

function treeMap(tree: ScannedTree): Map<string, SnapshotNode> {
  const result = new Map<string, SnapshotNode>();
  for (const directory of tree.directories) result.set(directory.path, { kind: 'directory', mode: directory.mode });
  for (const entry of tree.entries) result.set(entry.path, { kind: 'file', mode: entry.mode, sha256: entry.sha256 });
  return result;
}

export function diffTrees(before: ScannedTree, after: ScannedTree): FilesystemChange[] {
  const beforeMap = treeMap(before);
  const afterMap = treeMap(after);
  const paths = [...new Set([...beforeMap.keys(), ...afterMap.keys()])].sort();
  const changes: FilesystemChange[] = [];
  for (const itemPath of paths) {
    const oldEntry = beforeMap.get(itemPath);
    const newEntry = afterMap.get(itemPath);
    if (oldEntry === undefined && newEntry !== undefined) {
      changes.push({ path: itemPath, change: 'CREATED', ...(newEntry.sha256 === undefined ? {} : { afterSha256: newEntry.sha256 }) });
    } else if (oldEntry !== undefined && newEntry === undefined) {
      changes.push({ path: itemPath, change: 'REMOVED', ...(oldEntry.sha256 === undefined ? {} : { beforeSha256: oldEntry.sha256 }) });
    } else if (oldEntry !== undefined && newEntry !== undefined && (
      oldEntry.kind !== newEntry.kind || oldEntry.mode !== newEntry.mode ||
      oldEntry.sha256 !== newEntry.sha256
    )) {
      changes.push({
        path: itemPath, change: 'MODIFIED',
        ...(oldEntry.sha256 === undefined ? {} : { beforeSha256: oldEntry.sha256 }),
        ...(newEntry.sha256 === undefined ? {} : { afterSha256: newEntry.sha256 }),
      });
    }
  }
  return changes;
}

function workspacePath(workspace: string, relative: string): string {
  return path.join(workspace, ...relative.split('/'));
}

async function regularFile(filePath: string): Promise<boolean> {
  try {
    const details = await lstat(filePath);
    return details.isFile() && !details.isSymbolicLink();
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}

async function absentPath(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath);
    return false;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return true;
    throw error;
  }
}

async function utf8File(filePath: string): Promise<string> {
  const bytes = await readFile(filePath);
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

function withinAllowlist(itemPath: string, allowlist: string[]): boolean {
  return allowlist.some((allowed) => itemPath === allowed || itemPath.startsWith(`${allowed}/`));
}

export async function applyDirectCheck(
  check: DirectCheck,
  context: {
    finalOutput: string;
    elapsedMs: number;
    workspace: string;
    changes: FilesystemChange[];
  },
): Promise<CheckResult> {
  let status: CheckResult['status'] = 'APPLIED';
  let passed = false;
  let observation = '';
  try {
    switch (check.operator) {
      case 'FINAL_EQUALS': {
        passed = context.finalOutput.replaceAll('\r\n', '\n') === check.expected.replaceAll('\r\n', '\n');
        observation = passed ? 'Final output equals the prespecified value' : 'Final output differs from the prespecified value';
        break;
      }
      case 'FINAL_CONTAINS': {
        const missing = check.fragments.filter((fragment) => !context.finalOutput.includes(fragment));
        passed = missing.length === 0;
        observation = passed ? 'All prespecified fragments are present' : `${missing.length} prespecified fragment(s) are absent`;
        break;
      }
      case 'FINAL_EXCLUDES': {
        const present = check.fragments.filter((fragment) => context.finalOutput.includes(fragment));
        passed = present.length === 0;
        observation = passed ? 'All prohibited fragments are absent' : `${present.length} prohibited fragment(s) are present`;
        break;
      }
      case 'FINAL_JSON_SCHEMA': {
        let parsed: unknown;
        try {
          parsed = JSON.parse(context.finalOutput) as unknown;
        } catch {
          observation = 'Final output is not JSON';
          break;
        }
        const validator = new AjvConstructor({ allErrors: true, strict: false }).compile(check.schema);
        passed = validator(parsed);
        observation = passed ? 'Final JSON satisfies the embedded schema' : 'Final JSON violates the embedded schema';
        break;
      }
      case 'PATH_EXISTS': {
        passed = await regularFile(workspacePath(context.workspace, check.path));
        observation = passed ? 'Prespecified regular path exists' : 'Prespecified regular path does not exist';
        break;
      }
      case 'PATH_ABSENT': {
        passed = await absentPath(workspacePath(context.workspace, check.path));
        observation = passed ? 'Prespecified path is absent' : 'Prespecified path exists';
        break;
      }
      case 'FILE_EQUALS': {
        const target = workspacePath(context.workspace, check.path);
        if (!(await regularFile(target))) {
          observation = 'Prespecified file is absent or not regular';
          break;
        }
        const bytes = await readFile(target);
        if (typeof check.expected === 'string') passed = Buffer.from(check.expected).equals(bytes);
        else passed = sha256Bytes(bytes) === check.expected.sha256;
        observation = passed ? 'File bytes equal the prespecified value' : 'File bytes differ from the prespecified value';
        break;
      }
      case 'FILE_CONTAINS':
      case 'FILE_EXCLUDES': {
        const target = workspacePath(context.workspace, check.path);
        if (!(await regularFile(target))) {
          observation = 'Prespecified file is absent or not regular';
          break;
        }
        const content = await utf8File(target);
        const relevantIndexes = check.fragments.flatMap((fragment, index) =>
          content.includes(fragment) === (check.operator === 'FILE_EXCLUDES') ? [index] : []
        );
        passed = relevantIndexes.length === 0;
        observation = passed
          ? 'File fragment contract is satisfied'
          : check.operator === 'FILE_CONTAINS'
            ? `Missing prespecified file fragment indexes (zero-based): ${relevantIndexes.join(', ')}`
            : `Present prohibited file fragment indexes (zero-based): ${relevantIndexes.join(', ')}`;
        break;
      }
      case 'WRITES_WITHIN': {
        const outside = context.changes.filter((change) => !withinAllowlist(change.path, check.paths));
        passed = outside.length === 0;
        observation = passed ? 'All filesystem changes stay within the allowlist' : `${outside.length} filesystem change(s) escape the allowlist`;
        break;
      }
      case 'NO_FILESYSTEM_CHANGE': {
        passed = context.changes.length === 0;
        observation = passed ? 'Workspace is byte-identical to its initial snapshot' : `${context.changes.length} filesystem change(s) were observed`;
        break;
      }
      case 'MAX_ELAPSED_MS': {
        passed = context.elapsedMs <= check.maximumMs;
        observation = `Observed ${context.elapsedMs} ms against a ${check.maximumMs} ms maximum`;
        break;
      }
    }
  } catch (error) {
    status = 'INSTRUMENT_INVALID';
    passed = false;
    observation = `Check could not be applied: ${redactSecrets(messageOf(error)).slice(0, 2000)}`;
  }
  return {
    checkId: check.id,
    claimId: check.claimId,
    operator: check.operator,
    required: check.required,
    failureDecision: check.failureDecision,
    status,
    passed,
    observation,
  };
}

export async function applyDirectChecks(
  checks: DirectCheck[],
  context: Parameters<typeof applyDirectCheck>[1],
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const check of checks) results.push(await applyDirectCheck(check, context));
  return results;
}
