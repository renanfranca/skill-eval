# Instrument design

Use this reference before accepting answers for `init`. The owner defines the
decision and expected behavior; the companion checks coherence but does not
fill gaps or optimize an instrument after seeing results.

## Separate the three questions

1. **Positive behavior:** Can the skill complete a supported task and produce
   the prespecified observable outcome?
2. **Safety during valid use:** When a supported task contains a risky or
   contradictory input, does the skill preserve the declared safety and
   non-interference contracts while still completing the legitimate task?
3. **Activation boundary:** On a narrow task outside the skill's scope, does
   the broader skill behavior remain absent?

Do not combine explicit activation, a task excluded by the skill, and an
expected refusal in one case. That combination cannot distinguish activation
behavior from refusal behavior.

## Design positive and safety cases

Put the latent risk, contradiction, or unsafe proposal in the fixture when the
task is supposed to discover and handle it. Keep the prompt focused on the
legitimate task and decision. This tests the skill's behavior rather than the
model's ability to repeat a safe resolution disclosed by the prompt.

Do not order the rejected conduct and expect the skill to disobey the prompt.
Do not spell out the entire safe answer in the prompt and then count ordinary
instruction-following as evidence of the skill's guarantee. Prespecify direct
checks for outputs and forbidden effects; use semantic criteria only for
meaning that a mechanical check cannot resolve.

## Design a non-activation case

Use an outside-scope task that does not literally name or invoke the target
skill and set `activationExpectation` to `MUST_NOT_ACTIVATE`. The expectation is
metadata for assessment; it does not rewrite, prefix, or otherwise alter the
prompt.

Checks should permit the narrow task to complete normally while rejecting the
skill's broader activity. For example, allow the one requested file edit while
requiring unrelated files to remain unchanged. A refusal-only contract usually
tests refusal, not non-activation.

Absence of direct `SKILL.md` read telemetry is `NOT_ASSESSED`, not proof that the
skill did not activate. Keep activation claims distinct from behavioral and
non-interference claims.

## Exception for conflict-adherence research

An explicit invocation followed by a conflicting instruction can be valid when
the declared research question is specifically whether the skill follows its
own constraints under that conflict. Label it as an adherence observation, not
as a non-activation case. Limit the conclusion to the frozen prompt, fixture,
skill, model, and procedure; do not claim that the skill enforces policy,
prevents misuse, or will resist other conflicts.

## Review checklist

- The decision question and `proceedMeaning` describe a narrow operational use.
- Exactly one positive, invalid-or-safety, and near-boundary case exists.
- Each prompt, fixture, authority, and expected result is mutually coherent.
- Required claims have prespecified observable evidence and failure decisions.
- Directly observable navigation uses `MARKDOWN_LINKS_TO` rather than link-label
  text matching; path existence is checked separately when required.
- Risk remains latent in the fixture instead of being resolved in the prompt.
- A changed or corrected instrument receives a new evaluation identifier.
