# Repository instructions

## Authority

`SPEC.md` is the product and implementation contract. Implement only the MVP described there. When code and the specification disagree,
stop and reconcile the code with the specification; do not silently reinterpret the contract.

## Self-contained implementation

Use only instructions and sources committed to this repository. Do not discover, inspect, read, copy, install, or invoke skills from the
user's machine, including any repository-external `.agents/skills`, `$CODEX_HOME/skills`, or equivalent location. Do not use an external
workflow skill to plan, implement, test, refactor, review, commit, or publish this project.

This prohibition does not remove the product requirement to place the single skill being evaluated inside an isolated trial workspace.
That runtime copy is untrusted evaluation input, not an implementation aid.

Do not create additional `AGENTS.md` files. Do not make the implementation depend on conversational context, global configuration, or
uncommitted files outside this repository.

## Cost and provider safety

Development, tests, builds, CI, examples, and documentation must make zero real provider calls. Use deterministic fake providers for every
implementation and acceptance scenario. Never use real Luna, Terra, Promptfoo remote providers, authenticated preflight, or ChatGPT account
capacity while implementing this repository.

Live evaluation is a product capability guarded by the explicit authorization described in `SPEC.md`; it is never an implementation or CI
step. Never commit credentials, copied authentication material, model reasoning, local evaluation inputs, or run artifacts.

## Scope discipline

Prefer the smallest direct implementation of the specification. Do not add automatic authoring, recursive supervision, multi-reviewer
workflows, campaign infrastructure, public schema compatibility layers, retries, dashboards, servers, or model-selection logic.

Tests are required for observable behavior and safety boundaries, but this repository prescribes no external development methodology.
Keep code identifiers and user-facing CLI flags in English. Documentation may remain in Portuguese.

## Completion gate

The provider-free implementation is complete only when these commands succeed locally:

```text
npm ci
npm run typecheck
npm run lint
npm test
npm run build
npm pack --dry-run
```
