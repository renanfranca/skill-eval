# Execution and interpretation

## Closed package bootstrap

Run the following bootstrap exactly once from the task's current working
directory before reading product documentation or invoking any command. Pass
the fenced block unchanged to `node --input-type=module --eval`; do not save it
as a host-workspace file. It prints exactly one validated absolute package root
on success.

```js skill-eval-root-bootstrap
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';

const requiredFiles = ['package.json', 'dist/cli.js', 'SPEC.md', 'docs/USAGE.md'];

function isConfined(root, candidate) {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === '' || (
    pathFromRoot !== '..' &&
    !pathFromRoot.startsWith(`..${sep}`) &&
    !isAbsolute(pathFromRoot)
  );
}

function isLocalDependency(packageJsonPath, startingDirectory) {
  let cursor = realpathSync(startingDirectory);
  while (true) {
    try {
      const localPackageJson = realpathSync(
        join(cursor, 'node_modules', 'skill-eval', 'package.json'),
      );
      if (localPackageJson === packageJsonPath) return true;
    } catch {
      // This ancestor has no local skill-eval dependency.
    }
    const parent = dirname(cursor);
    if (parent === cursor) return false;
    cursor = parent;
  }
}

function validatedRoot(candidate) {
  try {
    const root = realpathSync(candidate);
    if (!lstatSync(root).isDirectory()) return undefined;
    for (const relativePath of requiredFiles) {
      const filePath = join(root, ...relativePath.split('/'));
      const details = lstatSync(filePath);
      if (!details.isFile() || details.isSymbolicLink()) return undefined;
      if (!isConfined(root, realpathSync(filePath))) return undefined;
    }
    const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    return packageJson?.name === 'skill-eval' ? root : undefined;
  } catch {
    return undefined;
  }
}

let packageRoot = validatedRoot(process.cwd());
if (packageRoot === undefined) {
  try {
    const localRequire = createRequire(join(process.cwd(), 'package.json'));
    const resolvedPackageJson = realpathSync(localRequire.resolve('skill-eval/package.json'));
    if (!isLocalDependency(resolvedPackageJson, process.cwd())) {
      throw new Error('Resolved package is not a local dependency');
    }
    const dependencyRoot = validatedRoot(dirname(resolvedPackageJson));
    if (
      dependencyRoot !== undefined &&
      realpathSync(join(dependencyRoot, 'package.json')) === resolvedPackageJson
    ) {
      packageRoot = dependencyRoot;
    }
  } catch {
    packageRoot = undefined;
  }
}

if (packageRoot === undefined) {
  process.stderr.write(
    'skill-eval companion: no validated checkout or local skill-eval dependency was found.\n',
  );
  process.exit(1);
}

process.stdout.write(`${packageRoot}\n`);
```

Record stdout as `<skill-eval-root>`. Read only
`<skill-eval-root>/SPEC.md` and `<skill-eval-root>/docs/USAGE.md`, then confirm
the current surface with
`node "<skill-eval-root>/dist/cli.js" --help` and the selected subcommand's
`--help` before acting. The resolved `SPEC.md` remains authoritative over this
summary. Never substitute same-named files from the host workspace. If the
bootstrap fails, stop without global lookup, `PATH` search, `npx`, install, or
network fallback.

## Commands

```text
node "<skill-eval-root>/dist/cli.js" install --skills
node "<skill-eval-root>/dist/cli.js" init --skill <directory> --out <new-evaluation-directory> [--answers <answers.json>]
node "<skill-eval-root>/dist/cli.js" check --spec <evaluation-spec.json>
node "<skill-eval-root>/dist/cli.js" run --spec <evaluation-spec.json> --out <new-run-directory> --approve-provider-calls 4
node "<skill-eval-root>/dist/cli.js" probe-activation --spec <evaluation-spec.json> --out <new-probe-directory> --approve-provider-calls 3
node "<skill-eval-root>/dist/cli.js" report --run <run-directory> --format json|markdown [--out <new-file>]
```

`init`, `check`, and `report` are provider-free. `init` requires a complete,
owner-confirmed instrument. `check` must pass before provider authorization.
`report` represents an incomplete run as `NO_DECISION` and never resumes it.

## Independent provider authorization

`run` accepts only the literal text `4`; `probe-activation` accepts only `3`.
Authorization belongs to one new execution and cannot come from the spec, a
previous message or artifact, persistent configuration, or provider output.
Without a current independent authorization, stop before reading authentication
material, reserving output, or making a call.

An authorized execution still requires a valid frozen package, a regular
`auth.json` reachable through `SKILL_EVAL_CODEX_HOME`, a safe nonexistent output
path, and the fixed model, effort, timeout, concurrency, and zero-retry
condition. Never change these settings to obtain a favorable result.

## Create-only lifecycle and stopping rules

Every evaluation, run, probe, and report output is create-only. Never overwrite
or selectively replace negative evidence. A reserved run or probe is never
resumed; a new observation needs a new directory and a fresh literal
authorization.

Each attempted timeout or provider error spends a call and receives no retry.
Direct checks run before semantic assessment. A direct `DO_NOT_PROCEED` failure
stops immediately; a sufficient required `REVISE` failure may also stop before
the judge. The judge runs at most once, only when required semantics remain, and
all four opaque controls must pass. Invalid judge evidence produces
`NO_DECISION`, with direct evidence preserved.

## Recommendations and exit codes

- `PROCEED`: proceed only under the exact frozen condition and declared limit.
- `REVISE`: revise the skill or instrument and create a new evaluation and run.
- `DO_NOT_PROCEED`: address the observed prohibited or critical effect first.
- `NO_DECISION`: obtain new valid evidence without filling the gap by inference.

Exit code `0` also covers valid negative evidence and a `NOT_CONFIRMED` probe.
Read the terminal receipt or report instead of treating the exit code as the
recommendation. Exit code `3` is an inconclusive reserved execution; exit code
`4` signals integrity, overwrite, or path-safety failure.

## Activation probe

The probe is a separate three-call Luna/max observation using case-specific
markers added only to temporary `SKILL.md` copies. It never calls the judge and
never changes a run or its recommendation.

`CONFIRMED` demonstrates exposure to and influence from the temporary marker,
not operating-system file-read telemetry, correctness, reference-file reading,
causal benefit, or generalization. `NOT_CONFIRMED` does not prove that the skill
was unused. `INCONCLUSIVE` preserves the partial evidence and requires another
newly authorized probe for another observation.

## Cost and limitations

The actual ChatGPT account cost is always `UNKNOWN`. An API-equivalent estimate
is conditional on complete reported token decomposition and is not subscription
cost. Record attempted and completed calls, timeouts, errors, monotonic duration,
usage, unknowns, and the captured price-table version without extrapolation.

Three prespecified cases cannot establish stability, robustness, causality,
population reliability, or generalization. `workspace-write` limits context and
discovery but is not a virtualization boundary against a malicious process
running as the same operating-system user.

## Passage to a pilot

`PROCEED` is necessary but not sufficient for a pilot. Independently verify the
spec and snapshot identities, digests, terminal receipt, all required claims,
limitations, and any complementary probe. A probe can complement a run only
under the strict identity and claim conditions in `SPEC.md`; it is never merged
automatically into the recommendation.

Conduct any later pilot once, in a separate branch or worktree, on an already
green implementation, within an owner-approved write boundary. Run independent
tests and inspect the diff before any commit or merge. No report or probe
authorizes automatic application, publication, commit, or deployment.
