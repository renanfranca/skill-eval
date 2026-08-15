# skill-eval

> **Status:** specification ready; implementation not started.

`skill-eval` is a proposed Node.js and TypeScript CLI for supplying one Codex skill and receiving an automatic evaluation that is useful for
a declared decision and defensible from preserved evidence.

The MVP deliberately stays small:

- a short guided specification instead of an automatic Evaluation Author;
- three representative Luna/max executions at most;
- deterministic checks before one controlled Terra/xhigh semantic judgment;
- four provider calls at most, zero retries, and explicit authorization;
- sanitized local evidence and conditional conclusions instead of a generic “pass”.

The complete contract is in [SPEC.md](SPEC.md). The project-local implementation boundaries are in [AGENTS.md](AGENTS.md).

## Intended CLI

```text
skill-eval init --skill <directory> --out <directory> [--answers <answers.json>]
skill-eval check --spec <evaluation-spec.json>
skill-eval run --spec <evaluation-spec.json> --out <new-run-directory> --approve-provider-calls 4
skill-eval report --run <run-directory> --format json|markdown [--out <file>]
```

No command exists yet. The repository currently contains the decision-complete specification from which the MVP can be implemented.

## Objective for `/goal`

Use the following objective without assigning a token budget:

```text
Implementar integralmente o MVP definido em SPEC.md. Use somente as fontes deste repositório e não descubra, leia ou invoque skills externas
ou preexistentes. Não faça chamadas reais a providers: toda validação deve usar providers falsos e determinísticos. Conclua apenas quando
todos os critérios provider-free de aceitação estiverem verdes, sem iniciar avaliações Luna/max ou Terra/xhigh.
```

The goal may write code, tests, package metadata, and CI inside this repository. It must not execute a live evaluation, consume ChatGPT
capacity, or weaken the authorization and isolation boundaries in the specification.

## License

[MIT](LICENSE)
