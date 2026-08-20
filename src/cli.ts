#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { SkillEvalError, usageError } from './errors.js';
import { installCompanion } from './install/companion.js';
import { initializeEvaluation, readAnswers } from './intake/init.js';
import { runActivationProbe } from './probe/probe.js';
import { reportRun } from './report/report.js';
import { PromptfooCodexProvider } from './runtime/promptfoo-provider.js';
import { runEvaluation } from './run/run.js';
import { checkEvaluationPackage } from './spec/validate.js';

const GENERAL_HELP = `skill-eval — bounded local evaluation of one Codex skill

Usage:
  skill-eval install --skills
  skill-eval init --skill <directory> --out <directory> [--answers <answers.json>]
  skill-eval check --spec <evaluation-spec.json>
  skill-eval run --spec <evaluation-spec.json> --out <new-run-directory> --approve-provider-calls 4
  skill-eval probe-activation --spec <evaluation-spec.json> --out <new-probe-directory> --approve-provider-calls 3
  skill-eval report --run <run-directory> --format json|markdown [--out <file>]

Exit codes: 0 valid artifact (including negative evidence), 2 usage/spec/preflight,
3 reserved run or probe inconclusive, 4 integrity/overwrite/path safety.

Provider calls occur only for run and probe-activation after their literal authorizations. install, init, check, and report are provider-free.`;

const COMMAND_HELP: Record<string, string> = {
  install: 'Usage: skill-eval install --skills\nInstalls the packaged companion provider-free at .agents/skills/skill-eval in the current project. Existing identical content is a no-op; divergent content is never overwritten.',
  init: 'Usage: skill-eval init --skill <directory> --out <new-directory> [--answers <answers.json>]\nCreates a canonical provider-free evaluation package.',
  check: 'Usage: skill-eval check --spec <evaluation-spec.json>\nValidates schema, relations, digests, paths, isolation inputs, and the exact execution condition without provider calls.',
  run: 'Usage: skill-eval run --spec <evaluation-spec.json> --out <new-run-directory> --approve-provider-calls 4\nRuns at most three Luna/max trials and one qualified Terra/xhigh batch, sequentially, with zero retries.',
  'probe-activation': 'Usage: skill-eval probe-activation --spec <evaluation-spec.json> --out <new-probe-directory> --approve-provider-calls 3\nRuns three isolated Luna/max activation probes with temporary SKILL.md markers, zero retries, and no Terra call.',
  report: 'Usage: skill-eval report --run <run-directory> --format json|markdown [--out <new-file>]\nRenders deterministic provider-free evidence, including incomplete runs as NO_DECISION.',
};

function required(value: string | undefined, option: string): string {
  if (value === undefined || value === '') throw usageError(`Missing required --${option}`);
  return value;
}

export async function main(argv: string[]): Promise<number> {
  const command = argv[0];
  if (command === undefined || command === '--help' || command === '-h') {
    process.stdout.write(`${GENERAL_HELP}\n`);
    return 0;
  }
  if (!(command in COMMAND_HELP)) throw usageError(`Unknown command: ${command}`);
  const rest = argv.slice(1);
  if (rest.includes('--help') || rest.includes('-h')) {
    process.stdout.write(`${COMMAND_HELP[command]}\n`);
    return 0;
  }
  switch (command) {
    case 'install': {
      if (rest.length !== 1 || rest[0] !== '--skills') {
        throw usageError('install accepts exactly the boolean flag --skills');
      }
      const result = await installCompanion();
      const action = result.status === 'INSTALLED' ? 'Installed' : 'Companion already identical at';
      process.stdout.write(`${action} ${result.destination}\nStart a new Codex task if companion discovery is not refreshed; installation does not activate it in the current task.\n`);
      return 0;
    }
    case 'init': {
      const { values } = parseArgs({ args: rest, strict: true, allowPositionals: false, options: { skill: { type: 'string' }, out: { type: 'string' }, answers: { type: 'string' } } });
      const answers = values.answers === undefined ? undefined : await readAnswers(values.answers);
      const spec = await initializeEvaluation({ skillDirectory: required(values.skill, 'skill'), outDirectory: required(values.out, 'out'), ...(answers === undefined ? {} : { answers }) });
      process.stdout.write(`Created evaluation ${spec.evaluationId} at ${values.out}\n`);
      return 0;
    }
    case 'check': {
      const { values } = parseArgs({ args: rest, strict: true, allowPositionals: false, options: { spec: { type: 'string' } } });
      const spec = await checkEvaluationPackage(required(values.spec, 'spec'));
      process.stdout.write(`Valid provider-free evaluation spec: ${spec.evaluationId}\n`);
      return 0;
    }
    case 'run': {
      const { values } = parseArgs({ args: rest, strict: true, allowPositionals: false, options: { spec: { type: 'string' }, out: { type: 'string' }, 'approve-provider-calls': { type: 'string' } } });
      const approval = required(values['approve-provider-calls'], 'approve-provider-calls');
      if (approval !== '4') throw usageError('run requires literal --approve-provider-calls 4 for this execution');
      const result = await runEvaluation({
        specPath: required(values.spec, 'spec'), outDirectory: required(values.out, 'out'), approveProviderCalls: approval,
        provider: new PromptfooCodexProvider(),
        ...(process.env['SKILL_EVAL_CODEX_HOME'] === undefined ? {} : { codexHomeSource: process.env['SKILL_EVAL_CODEX_HOME'] }),
      });
      process.stdout.write(`Run ${result.terminal.status}: ${result.terminal.recommendation}\n`);
      return result.exitCode;
    }
    case 'probe-activation': {
      const { values } = parseArgs({ args: rest, strict: true, allowPositionals: false, options: { spec: { type: 'string' }, out: { type: 'string' }, 'approve-provider-calls': { type: 'string' } } });
      const approval = required(values['approve-provider-calls'], 'approve-provider-calls');
      if (approval !== '3') throw usageError('probe-activation requires literal --approve-provider-calls 3 for this execution');
      const result = await runActivationProbe({
        specPath: required(values.spec, 'spec'), outDirectory: required(values.out, 'out'), approveProviderCalls: approval,
        provider: new PromptfooCodexProvider(),
        ...(process.env['SKILL_EVAL_CODEX_HOME'] === undefined ? {} : { codexHomeSource: process.env['SKILL_EVAL_CODEX_HOME'] }),
      });
      process.stdout.write(`Activation probe ${result.terminal.status}\n`);
      return result.exitCode;
    }
    case 'report': {
      const { values } = parseArgs({ args: rest, strict: true, allowPositionals: false, options: { run: { type: 'string' }, format: { type: 'string' }, out: { type: 'string' } } });
      const format = required(values.format, 'format');
      if (format !== 'json' && format !== 'markdown') throw usageError('--format must be json or markdown');
      const output = await reportRun({ runDirectory: required(values.run, 'run'), format, ...(values.out === undefined ? {} : { outFile: values.out }) });
      if (values.out === undefined) process.stdout.write(output);
      return 0;
    }
  }
  throw usageError(`Unknown command: ${command}`);
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (error: unknown) => {
      const parseArgsError = error instanceof Error && 'code' in error && typeof error.code === 'string' && error.code.startsWith('ERR_PARSE_ARGS');
      const code = error instanceof SkillEvalError ? error.exitCode : parseArgsError ? 2 : 4;
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`skill-eval: ${message}\n`);
      process.exitCode = code;
    },
  );
}
