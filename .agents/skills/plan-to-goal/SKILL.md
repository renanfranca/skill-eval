---
name: plan-to-goal
description: Use only when the user explicitly invokes $plan-to-goal to materialize the latest finalized plan from the current conversation and prepare its /goal handoff. Never trigger automatically, design a new plan, or implement the selected plan.
---

# Plan to Goal

Materialize the latest finalized plan from the current conversation as a local,
ignored, temporary execution document. Then return the exact `/goal` command
that hands off implementation. Do not execute the goal.

## Activation boundary

Run this skill only when the user explicitly writes `$plan-to-goal`. Do not infer
activation from a request to plan, implement, review, or discuss `/goal`.

The explicit invocation counts as confirmation that the user wants the most
recent complete plan materialized. It does not authorize implementation, a
provider call, a commit, or any other product change.

## Select the plan

Use conversation order, not topic similarity:

1. Walk backward from the `$plan-to-goal` invocation.
2. Identify the most recent coherent and complete plan state.
3. Include refinements the user made after that plan only when the conversation
   clearly resolved and accepted them.
4. Ignore every earlier plan, even when it concerns the same files or feature,
   unless the latest plan explicitly incorporates it.
5. Never merge separate plan threads merely because they appear in the same
   conversation.

The selected plan must state an objective, bounded scope, expected behavior or
deliverables, and a way to verify completion. A numbered list is not required;
the semantic completeness of the plan is what matters.

If the latest plan still contains an unresolved choice, ask one concise question
and stop. If conversation compaction removed details required to reproduce the
plan faithfully, state which details are unavailable and stop. Never reconstruct
missing decisions from older plans, repository code, or general preferences.

## Preserve the finalized decisions

Transcribe and organize the selected plan without redesigning it. Preserve:

- the objective and motivation;
- approved decisions and exact public contracts;
- safety and scope constraints;
- explicitly excluded work;
- observable acceptance cases;
- documentation and version decisions;
- validation commands and completion criteria.

Do not silently add architecture, features, refactors, dependencies, providers,
release actions, or acceptance criteria. Administrative safeguards required by
this handoff may be added, such as authority order, revalidation, create-only
storage, provider prohibition already imposed by the repository, and deletion
of the temporary plan.

## Respect repository authority

Read the repository's current root `AGENTS.md` before writing. Treat its rules as
higher authority than this skill. When that file names a canonical product
contract such as `SPEC.md`, record the following order in the temporary plan:

1. repository instructions for operational constraints;
2. the named canonical product specification;
3. current code and tests as evidence of implementation state;
4. the temporary plan as the approved intent, subordinate to the preceding
   sources.

Require the future goal to re-read those sources before editing. A discrepancy
must be reconciled explicitly; the plan must never be used as evidence that a
behavior is already implemented.

Do not load or invoke another skill, spawn a subagent, browse the web, access a
provider, or inspect repository-external instructions while performing this
handoff.

## Write the temporary plan

Use this repository-local destination:

```text
.skill-eval/plans/<descriptive-kebab-case-slug>.md
```

Before writing:

1. capture `git status --short` without changing the worktree;
2. confirm with `git check-ignore` that the proposed path is ignored;
3. stop rather than editing `.gitignore` if it is not ignored;
4. confirm the target file does not exist.

Never overwrite or update an existing plan. When the natural slug already
exists, choose the first unused numeric suffix such as `-2` or `-3` and report
the selected path.

Create the file safely with `apply_patch`. The document must be self-contained
and contain, in this order:

1. a descriptive title;
2. `Status: finalizado e aprovado para handoff.`;
3. a statement that it is temporary, ignored, subordinate, and must be removed
   after successful implementation;
4. the authority and revalidation protocol;
5. the complete selected plan;
6. explicit non-goals and safety constraints from the conversation or
   repository instructions;
7. observable tests and completion gate;
8. final cleanup requiring removal of this temporary file only after the goal
   is genuinely complete.

Do not edit any tracked file. After writing, run `git status --short` again and
verify that its output is byte-for-byte identical to the captured baseline. If
it differs, report the unexpected change and stop without attempting to hide,
revert, stage, or commit it.

## Return the handoff

Respond in the user's language. Show only the information needed to verify and
start the handoff:

```text
Plano selecionado: <title>
Origem: último plano finalizado desta conversa
Arquivo: <relative-path>
Git: nenhuma alteração rastreada causada pela materialização

/goal Implementar integralmente `<relative-path>`. Antes de agir, reler
AGENTS.md, a especificação canônica indicada pelo repositório, o código e os
testes atuais; reconciliar divergências explicitamente; não usar skills externas
nem providers reais; respeitar exatamente o escopo e os critérios de conclusão;
remover o plano temporário somente após toda a validação passar; concluir apenas
quando o completion gate do repositório estiver verde.
```

Adapt the `/goal` text only to repeat critical constraints that are material to
the selected plan. Do not paste the whole plan into the goal, set a token budget,
create the goal through a tool, begin implementation, delete an older plan, or
commit anything.
