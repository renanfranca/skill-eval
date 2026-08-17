---
name: plan-to-goal
description: Materialize the latest complete and finalized plan from the current conversation into an ignored temporary file and prepare its /goal handoff. Use only when the user explicitly invokes $plan-to-goal; never trigger implicitly, design or merge plans, implement the plan, or create the goal.
---

# Plan to Goal

Materialize the selected plan and return its exact `/goal` handoff. Treat the
explicit invocation as approval to materialize only; do not implement, create a
goal through a tool, call a provider, or commit.

## Select the plan

Walk backward from the invocation and select the most recent coherent, complete
plan state. Use conversation order rather than topic similarity.

- Include later refinements only when the conversation clearly resolved them.
- Ignore all earlier plans unless the selected plan explicitly incorporates
  them.
- Never merge independent plan threads, even when they concern the same topic.

Require an objective, bounded scope, expected behavior or deliverables, and a
way to verify completion. Do not require a particular presentation format.

If the selected plan has an unresolved decision, ask one concise question and
stop. If conversation compaction removed required details, identify the missing
details and stop. Never reconstruct them from earlier plans, repository code, or
general preferences.

## Preserve decisions and authority

Read the current root `AGENTS.md` before writing. Follow it above this skill. If
it names a canonical contract such as `SPEC.md`, record this authority order in
the temporary plan:

1. repository instructions for operational constraints;
2. the canonical product specification;
3. current code and tests as implementation evidence;
4. the temporary plan as subordinate approved intent.

Require the future goal to re-read those sources before editing and reconcile
divergences explicitly. Never treat the plan as evidence that behavior already
exists.

Transcribe and organize the selected plan without redesigning it. Preserve its
objective, motivation, contracts, constraints, non-goals, acceptance cases,
documentation and version decisions, validation commands, and completion gate.
Do not add architecture, features, refactors, dependencies, providers, release
actions, or acceptance criteria.

Add only administrative safeguards required by the repository or this handoff:
authority, revalidation, create-only storage, provider restrictions, validation,
and deletion of the temporary plan. Do not use another skill, subagent, web,
provider, or repository-external instruction.

## Write the temporary plan

Use:

```text
.skill-eval/plans/<descriptive-kebab-case-slug>.md
```

Before writing:

1. Capture the exact output of `git status --short`.
2. Confirm the target is ignored with `git check-ignore`.
3. Stop rather than editing `.gitignore` when it is not ignored.
4. Confirm the target does not exist.

Never overwrite, update, or delete an existing plan. If the natural slug exists,
use the first available numeric suffix such as `-2`.

Create the file with `apply_patch`. Make it self-contained and include:

- a descriptive title and `Status: finalizado e aprovado para handoff.`;
- its temporary, ignored, and subordinate nature;
- the authority and revalidation protocol;
- the complete selected plan, constraints, and non-goals;
- observable validation and the completion gate;
- removal of this file only after genuine completion.

Do not edit a tracked file. Compare `git status --short` byte-for-byte with the
baseline after writing. If it differs, report the unexpected change and stop;
do not hide, revert, stage, or commit it.

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

Adapt the `/goal` text only to repeat critical constraints material to the plan.
Do not paste the full plan, set a token budget, create the goal through a tool,
begin implementation, delete an older plan, or commit.
