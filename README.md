# skill-eval

`skill-eval` é uma CLI local para avaliar uma única skill Codex sob uma condição pequena, explícita e auditável. O MVP congela a skill e três
casos declarados pelo owner, executa checks mecânicos antes de qualquer julgamento semântico e preserva evidência sanitizada sem transformar
três observações em alegações de estabilidade, causalidade ou generalização.

**Status:** MVP provider-free concluído conforme os critérios de aceitação do `SPEC.md`.

O contrato completo e canônico está em [SPEC.md](SPEC.md).
Para instalar, configurar e operar o MVP passo a passo, consulte o [guia detalhado de uso](docs/USAGE.md).

## Requisitos e instalação

- Node.js 24 ou posterior;
- npm;
- para uma execução model-backed futura, um Codex home autenticado por ChatGPT indicado explicitamente por `SKILL_EVAL_CODEX_HOME`.

```text
npm ci
npm run build
node dist/cli.js --help
```

As versões do Promptfoo (`0.122.0`) e do Codex SDK (`0.147.0`) estão fixadas no lockfile. Não há API pública de biblioteca.

## Comandos

```text
skill-eval install --skills
skill-eval init --skill <directory> --out <new-directory> [--answers <answers.json>]
skill-eval check --spec <evaluation-spec.json>
skill-eval run --spec <evaluation-spec.json> --out <new-run-directory> --approve-provider-calls 4
skill-eval probe-activation --spec <evaluation-spec.json> --out <new-probe-directory> --approve-provider-calls 3
skill-eval report --run <run-directory> --format json|markdown [--out <new-file>]
```

Cada comando e subcomando possui `--help`. `install`, `init`, `check` e `report` são sempre provider-free. `run` aceita somente a autorização literal `4`;
`probe-activation`, somente `3`. Ambos exigem um diretório inexistente e não reutilizam autorização nem artefato anterior. O output do probe
também precisa ficar fora do pacote de avaliação congelado.

### Companion conversacional opcional

O pacote inclui um companion conversacional que ajuda a revisar a coerência do instrumento e a operar a jornada documentada. Ele não
substitui os comandos da CLI, não inventa decisões do owner e não autoriza providers. Para disponibilizá-lo explicitamente no projeto atual:

```text
skill-eval install --skills
```

O único destino é `.agents/skills/skill-eval` relativo ao diretório corrente. Uma instalação nova copia exatamente o companion empacotado;
uma árvore já idêntica é no-op; qualquer diferença, arquivo extra ou tipo inseguro é recusado sem alteração. Não existe path configurável,
`--force`, instalação global, overwrite, `postinstall`, provider ou ativação automática. A descoberta do companion pode exigir uma nova task
do Codex, e a instalação não comprova ativação na task atual.

O fluxo assistido é `companion → confirmação explícita do owner → init → check`. Usar `init` e `check` diretamente, sem instalar ou usar o
companion, continua sendo uma alternativa completa e válida.

### Intake não interativo

`--answers` aponta para um JSON fechado com a decisão, claims e exatamente os casos `POSITIVE`, `INVALID_SAFETY` e `NEAR_BOUNDARY`, nessa
ordem. O próprio fornecimento do arquivo é a confirmação não interativa do resumo nele contido. Um caso pode copiar uma fixture confinada por
`fixtureSource` ou usar `null`. O formato completo dos checks permitidos está na seção 5 do `SPEC.md`; nenhum check aceita código, shell,
callback, import, rede ou regex do usuário.

Exemplo mínimo de estrutura:

```json
{
  "evaluationId": "my-evaluation",
  "decision": {
    "question": "Should this skill be used for the declared task?",
    "proceedMeaning": "Proceed only for the declared inputs and boundary."
  },
  "claims": [{
    "id": "behavior",
    "statement": "The skill returns the required value.",
    "kind": "BEHAVIOR",
    "required": true,
    "failureDecision": "REVISE"
  }],
  "cases": [
    {
      "id": "positive-case",
      "kind": "POSITIVE",
      "prompt": "Return the positive value.",
      "fixtureSource": null,
      "claimIds": ["behavior"],
      "activationExpectation": "NOT_ASSERTED",
      "checks": [{
        "id": "positive-equals", "claimId": "behavior", "operator": "FINAL_EQUALS",
        "expected": "positive", "required": true, "failureDecision": "REVISE"
      }],
      "semanticCriteria": []
    },
    {
      "id": "invalid-case",
      "kind": "INVALID_SAFETY",
      "prompt": "Handle the invalid request safely.",
      "fixtureSource": null,
      "claimIds": ["behavior"],
      "activationExpectation": "NOT_ASSERTED",
      "checks": [{
        "id": "invalid-equals", "claimId": "behavior", "operator": "FINAL_EQUALS",
        "expected": "refused", "required": true, "failureDecision": "DO_NOT_PROCEED"
      }],
      "semanticCriteria": []
    },
    {
      "id": "boundary-case",
      "kind": "NEAR_BOUNDARY",
      "prompt": "Handle the near-boundary request.",
      "fixtureSource": null,
      "claimIds": ["behavior"],
      "activationExpectation": "NOT_ASSERTED",
      "checks": [{
        "id": "boundary-equals", "claimId": "behavior", "operator": "FINAL_EQUALS",
        "expected": "boundary", "required": true, "failureDecision": "REVISE"
      }],
      "semanticCriteria": []
    }
  ]
}
```

Sem `--answers`, a CLI coleta os mesmos campos, mostra o JSON resultante e pede confirmação antes de criar o pacote.

## Autorização e isolamento

Uma execução real somente pode começar depois de uma autorização explícita posterior:

```text
SKILL_EVAL_CODEX_HOME=/path/to/authenticated-codex-home \
  skill-eval run --spec evaluation/evaluation-spec.json --out runs/run-001 --approve-provider-calls 4
```

O probe de ativação possui autorização e artefato próprios:

```text
SKILL_EVAL_CODEX_HOME=/path/to/authenticated-codex-home \
  skill-eval probe-activation --spec evaluation/evaluation-spec.json --out probes/probe-001 --approve-provider-calls 3
```

O preflight lê apenas metadados de um `auth.json` regular. Para as chamadas, a CLI cria um Codex home privado temporário contendo somente uma
cópia `0600` dessa autenticação, redefine `HOME`, `USERPROFILE` e `CODEX_HOME` para esse local e o apaga no `finally`. Configuração, histórico
e skills globais não são copiados.

Cada caso recebe um workspace temporário novo, fora do repositório, do pacote de avaliação e do home do usuário. Ele contém apenas
`.agents/skills/<target>` e a fixture daquele caso. As chamadas são sequenciais, têm timeout de 600 segundos e zero retries. O teto é três
tentativas Luna/max e, somente se necessário, um batch Terra/xhigh com quatro probes opacos. Um check direto crítico encerra antes do judge.

`probe-activation` reutiliza os três prompts e fixtures sem modificá-los. Em cada workspace novo, acrescenta a uma cópia temporária de
`SKILL.md` um marcador aleatório exclusivo e verifica se a resposta contém esse marcador. As três tentativas são Luna/max, sequenciais, sem
retry e sem Terra. `CONFIRMED` demonstra exposição e influência desse conteúdo temporário exclusivo; não demonstra telemetria de leitura no
sistema operacional, correção, benefício causal ou generalização. `NOT_CONFIRMED` não prova que a skill deixou de ser usada.

`workspace-write` limita contexto e descoberta, mas não é uma fronteira de virtualização contra um processo malicioso executado pela mesma
conta do sistema operacional.

## Evidência e relatórios

Runs, probes e reports são create-only. Um run incompleto nunca é retomado: `report` o representa como `NO_DECISION` e mostra o último evento
append-only confirmado. JSON e Markdown derivam do mesmo assessment canônico e separam observações diretas, assessments semânticos,
claims, recomendação, custo, limitações e gatilhos de reavaliação.

O probe grava `manifest.json`, `probe-results.jsonl`, `terminal.json`, outputs finais e projeções Promptfoo em diretório separado. Ele não
altera nem é agregado automaticamente ao run, ao report ou à recomendação original; teste A/B permanece fora do MVP.

Timestamps de novos runs e probes usam um anchor UTC mais progresso monotônico; a ordem autoritativa permanece append-only com `callNumber`. Ajustes
do relógio civil acima de um segundo são registrados como limitação e não invalidam sozinhos evidência cuja sequência e duração monotônica
continuam confirmadas. A projeção mínima do Promptfoo não persiste sua latência baseada no relógio civil.

O custo monetário real da conta ChatGPT é sempre `UNKNOWN`. A estimativa API-equivalent só aparece quando a decomposição necessária de usage
está disponível e nunca é apresentada como custo real da assinatura.

## Exit codes

| Código | Significado |
| ---: | --- |
| 0 | artefato válido, inclusive `REVISE`, `DO_NOT_PROCEED` ou probe `NOT_CONFIRMED` |
| 2 | erro de uso, spec ou preflight antes da reserva |
| 3 | run ou probe reservado inconclusivo por timeout, provider, ambiente ou judge inválido |
| 4 | corrupção, tentativa de overwrite, path inseguro ou violação de integridade |

## Desenvolvimento provider-free

Testes usam somente providers fake determinísticos. Nenhum teste, build, exemplo ou comando de CI deve autenticar ou chamar Luna, Terra ou
qualquer provider remoto.

```text
npm ci
npm run typecheck
npm run lint
npm test
npm run build
npm pack --dry-run
```

Completar esses comandos prova o mecanismo local provider-free; não qualifica Luna/max, Terra/xhigh nem a utilidade de uma avaliação real.

## Licença

[MIT](LICENSE)
