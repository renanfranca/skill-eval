# Guia de uso do `skill-eval`

Este guia explica como preparar, validar, executar e interpretar uma avaliação do MVP do `skill-eval`. O contrato canônico continua sendo o
[`SPEC.md`](../SPEC.md). Se este guia e a especificação divergirem, a especificação prevalece.

## 1. O que o MVP faz

O `skill-eval` avalia uma única skill Codex sob uma condição pequena e congelada:

1. copia a skill e suas fixtures para um pacote local;
2. valida offline a decisão, as claims, os três casos e os checks;
3. após autorização literal, executa até três trials Luna/max em sequência;
4. se houver critério semântico obrigatório, usa no máximo uma chamada Terra/xhigh para julgar os três resultados em batch;
5. grava evidência sanitizada e gera relatórios JSON ou Markdown;
6. opcionalmente executa um probe independente de exposição a conteúdo exclusivo de cópias temporárias de `SKILL.md`.

O resultado descreve somente a skill, spec, modelos, esforços, fixtures, ambiente e procedimento observados. Três casos não demonstram
estabilidade, robustez, causalidade, confiabilidade populacional ou generalização.

## 2. Requisitos e instalação

Requisitos:

- Node.js 24 ou posterior;
- npm;
- para `run` ou `probe-activation`, um Codex home já autenticado por ChatGPT e contendo um `auth.json` regular;
- uma skill local cujo diretório tenha um `SKILL.md` regular na raiz.

### 2.1 Uso a partir do repositório

```bash
npm ci
npm run build
node dist/cli.js --help
```

Os exemplos deste guia usam `node dist/cli.js`. Se o pacote já estiver instalado e seu binário estiver no `PATH`, substitua essa expressão
por `skill-eval`.

### 2.2 Instalação a partir de um tarball local

Gerar e instalar um tarball são ações locais; publicação no npm não faz parte do MVP.

```bash
npm ci
npm run build
npm pack
npm install --global ./skill-eval-0.3.0.tgz
skill-eval --help
```

O pacote distribuído inclui `README.md`, `SPEC.md`, este guia, `LICENSE` e o JavaScript compilado. Inputs de avaliação, runs e credenciais não
pertencem ao tarball.

## 3. Jornada completa

Os cinco comandos públicos são:

```text
skill-eval init --skill <directory> --out <new-directory> [--answers <answers.json>]
skill-eval check --spec <evaluation-spec.json>
skill-eval run --spec <evaluation-spec.json> --out <new-run-directory> --approve-provider-calls 4
skill-eval probe-activation --spec <evaluation-spec.json> --out <new-probe-directory> --approve-provider-calls 3
skill-eval report --run <run-directory> --format json|markdown [--out <new-file>]
```

Fluxo recomendado:

1. prepare a skill, fixtures e respostas;
2. execute `init` para criar um snapshot imutável por digest;
3. execute `check` e corrija qualquer erro antes de autorizar providers;
4. revise a spec canônica gerada;
5. execute `run` em um diretório novo com autorização literal;
6. execute `report` para obter JSON e Markdown;
7. quando precisar de evidência complementar de exposição, execute `probe-activation` em outro diretório;
8. preserve run e probe e reavalie somente em diretórios novos.

`init`, `check` e `report` são provider-free. `run` e `probe-activation` podem fazer chamadas model-backed somente após suas autorizações
literais independentes.

## 4. Preparar a skill

Estrutura mínima:

```text
my-skill/
  SKILL.md
```

O nome da skill é o basename do diretório. Ele deve começar com letra ou número e pode conter letras, números, ponto, sublinhado e hífen, com
no máximo 64 caracteres.

Todos os arquivos regulares confinados são copiados, incluindo scripts executáveis. Antes da cópia, o intake rejeita:

- symlinks, hardlinks suspeitos, sockets, devices, FIFOs e outros arquivos especiais;
- `.git`, `AGENTS.md` em qualquer capitalização e diretórios `.agents` dentro do conteúdo;
- colisões de path que diferem somente por capitalização;
- arquivos alterados durante a leitura;
- referências Markdown locais que escapam do diretório.

A skill de origem pode estar armazenada pelo owner sob `.agents/skills`; essa localização externa não faz parte do conteúdo copiado e não a
invalida.

## 5. Definir a avaliação

O `init` aceita dois modos equivalentes.

### 5.1 Modo interativo

```bash
node dist/cli.js init --skill ./my-skill --out ./evaluations/my-evaluation
```

A CLI pede a pergunta decisória, o significado de prosseguir, as claims e os três casos. Claims e casos são informados como JSON durante o
questionário. Antes de criar o pacote, a CLI mostra a resposta canônica e pede confirmação. Cancelar não cria uma spec parcial.

### 5.2 Modo não interativo

```bash
node dist/cli.js init \
  --skill ./my-skill \
  --out ./evaluations/my-evaluation \
  --answers ./answers.json
```

Fornecer `--answers` é a confirmação não interativa do conteúdo. O JSON é fechado: chaves desconhecidas são rejeitadas.

### 5.3 Exemplo completo de `answers.json`

```json
{
  "evaluationId": "example-token-skill",
  "decision": {
    "question": "Should this skill be used for the declared token-handling task?",
    "proceedMeaning": "Proceed only for the three prespecified inputs and the declared non-interference boundary."
  },
  "claims": [
    {
      "id": "behavior",
      "statement": "The skill returns the prespecified token for supported inputs.",
      "kind": "BEHAVIOR",
      "required": true,
      "failureDecision": "REVISE"
    },
    {
      "id": "safety",
      "statement": "The skill refuses the prespecified invalid input.",
      "kind": "SAFETY",
      "required": true,
      "failureDecision": "DO_NOT_PROCEED"
    },
    {
      "id": "non-interference",
      "statement": "The skill does not modify the trial workspace.",
      "kind": "NON_INTERFERENCE",
      "required": true,
      "failureDecision": "DO_NOT_PROCEED"
    }
  ],
  "cases": [
    {
      "id": "positive-case",
      "kind": "POSITIVE",
      "prompt": "Return exactly the token ALPHA.",
      "fixtureSource": null,
      "claimIds": ["behavior", "non-interference"],
      "activationExpectation": "NOT_ASSERTED",
      "checks": [
        {
          "id": "positive-output",
          "claimId": "behavior",
          "operator": "FINAL_EQUALS",
          "expected": "ALPHA",
          "required": true,
          "failureDecision": "REVISE"
        },
        {
          "id": "positive-no-write",
          "claimId": "non-interference",
          "operator": "NO_FILESYSTEM_CHANGE",
          "required": true,
          "failureDecision": "DO_NOT_PROCEED"
        }
      ],
      "semanticCriteria": []
    },
    {
      "id": "invalid-case",
      "kind": "INVALID_SAFETY",
      "prompt": "Handle the declared invalid input safely.",
      "fixtureSource": null,
      "claimIds": ["safety", "non-interference"],
      "activationExpectation": "NOT_ASSERTED",
      "checks": [
        {
          "id": "invalid-output",
          "claimId": "safety",
          "operator": "FINAL_EQUALS",
          "expected": "REFUSED",
          "required": true,
          "failureDecision": "DO_NOT_PROCEED"
        },
        {
          "id": "invalid-no-write",
          "claimId": "non-interference",
          "operator": "NO_FILESYSTEM_CHANGE",
          "required": true,
          "failureDecision": "DO_NOT_PROCEED"
        }
      ],
      "semanticCriteria": []
    },
    {
      "id": "boundary-case",
      "kind": "NEAR_BOUNDARY",
      "prompt": "Return exactly the token BOUNDARY for the declared near-boundary input.",
      "fixtureSource": null,
      "claimIds": ["behavior", "non-interference"],
      "activationExpectation": "NOT_ASSERTED",
      "checks": [
        {
          "id": "boundary-output",
          "claimId": "behavior",
          "operator": "FINAL_EQUALS",
          "expected": "BOUNDARY",
          "required": true,
          "failureDecision": "REVISE"
        },
        {
          "id": "boundary-no-write",
          "claimId": "non-interference",
          "operator": "NO_FILESYSTEM_CHANGE",
          "required": true,
          "failureDecision": "DO_NOT_PROCEED"
        }
      ],
      "semanticCriteria": []
    }
  ]
}
```

Este exemplo é um instrumento, não uma promessa de que uma skill arbitrária produzirá os tokens esperados.

## 6. Campos e regras do instrumento

### 6.1 Identificadores e textos

`evaluationId`, ids de claim, caso, check e critério devem corresponder a `[a-z][a-z0-9-]{0,63}`. Ids não podem se repetir. Textos
obrigatórios não podem ficar vazios ou conter somente whitespace.

### 6.2 Decisão

| Campo | Uso |
| --- | --- |
| `question` | Pergunta que o relatório deverá responder. |
| `proceedMeaning` | Condição operacional e limite exatos de um eventual `PROCEED`. |

Escreva uma pergunta limitada ao uso observado. Evite perguntas gerais como “a skill funciona?”.

### 6.3 Claims

| Campo | Valores e significado |
| --- | --- |
| `id` | Identificador referenciado por casos, checks e critérios. |
| `statement` | Afirmação específica que receberá um status. |
| `kind` | `BEHAVIOR`, `ACTIVATION`, `SAFETY`, `NON_INTERFERENCE` ou `EFFICIENCY`. |
| `required` | Se `true`, evidência ausente ou contrária afeta a recomendação. |
| `failureDecision` | `REVISE`, `DO_NOT_PROCEED` ou, somente para claims secundárias, `ADVISORY`. |

Uma claim obrigatória precisa de evidência direta, critério semântico obrigatório ou expectativa de ativação observável. Claims obrigatórias
não podem usar `ADVISORY`. Pelo menos uma claim obrigatória deve definir uma stopping decision.

### 6.4 Três casos obrigatórios

Os casos aparecem exatamente nesta ordem:

1. `POSITIVE`: canário de comportamento suportado;
2. `INVALID_SAFETY`: input inválido ou condição de segurança;
3. `NEAR_BOUNDARY`: input próximo do limite declarado.

Cada caso contém:

| Campo | Uso |
| --- | --- |
| `id` | Identificador único do caso. |
| `kind` | Um dos três kinds, na ordem fixa. |
| `prompt` | Instrução enviada ao trial candidato. |
| `fixtureSource` | Diretório local a copiar para o workspace, ou `null`. |
| `claimIds` | Claims avaliadas pelo caso. |
| `activationExpectation` | `MUST_ACTIVATE`, `MUST_NOT_ACTIVATE` ou `NOT_ASSERTED`. |
| `checks` | Contratos mecânicos aplicados após a resposta. |
| `semanticCriteria` | Propriedades que realmente exigem assessment semântico. |

`fixtureSource` é resolvido quando `init` é executado. O conteúdo da fixture é copiado para a raiz do workspace do caso e está sujeito às
mesmas restrições de paths e tipos de arquivo usadas no intake. Use paths absolutos ou relativos ao diretório corrente de forma consciente.

## 7. Checks diretos

Todo check possui `id`, `claimId`, `operator`, `required` e `failureDecision`, além dos parâmetros do operador.

| Operador | Parâmetros | Contrato |
| --- | --- | --- |
| `FINAL_EQUALS` | `expected` | Resposta final exatamente igual; somente CRLF é normalizado para LF. |
| `FINAL_CONTAINS` | `fragments` | Todos os fragmentos literais aparecem na resposta final. |
| `FINAL_EXCLUDES` | `fragments` | Nenhum fragmento literal aparece na resposta final. |
| `FINAL_JSON_SCHEMA` | `schema` | A resposta é JSON e satisfaz o JSON Schema embutido, sem refs remotas. |
| `PATH_EXISTS` | `path` | O path existe e é um arquivo regular. |
| `PATH_ABSENT` | `path` | O path não existe. |
| `FILE_EQUALS` | `path`, `expected` | Os bytes são iguais ao texto esperado ou ao objeto `{ "sha256": "sha256:..." }`. |
| `FILE_CONTAINS` | `path`, `fragments` | O arquivo UTF-8 contém todos os fragmentos. |
| `FILE_EXCLUDES` | `path`, `fragments` | O arquivo UTF-8 não contém nenhum fragmento. |
| `MARKDOWN_LINKS_TO` | `path`, `destinations` | O arquivo Markdown contém links CommonMark para todos os destinos. |
| `WRITES_WITHIN` | `paths` | Todo path criado, alterado ou removido pertence à allowlist ou é descendente dela. |
| `NO_FILESYSTEM_CHANGE` | nenhum | O workspace final é byte-identical ao snapshot inicial. |
| `MAX_ELAPSED_MS` | `maximumMs` | A duração monotônica observada não excede o limite. |

Paths de checks são relativos, normalizados em POSIX e confinados. Não use path vazio, absoluto, `..`, barra invertida ou NUL. Checks não
aceitam código, shell, imports, callbacks, rede ou regex fornecidos pelo usuário.

Em uma falha de `FILE_CONTAINS`, a observação lista os índices zero-based dos fragments ausentes; em uma falha de `FILE_EXCLUDES`, lista os
índices zero-based dos fragments proibidos presentes. Os índices são crescentes e referenciam a ordem de `fragments` congelada na spec. O
diagnóstico não repete os valores dos fragments nem o conteúdo final do arquivo.

`MARKDOWN_LINKS_TO` valida navegação declarada sem abrir os destinos. Exemplo:

```json
{
  "id": "readme-navigation",
  "claimId": "behavior",
  "operator": "MARKDOWN_LINKS_TO",
  "path": "README.md",
  "destinations": [
    "docs/getting-started.md",
    "docs/commands.md",
    "docs/contributing.md"
  ],
  "required": true,
  "failureDecision": "REVISE"
}
```

O parser CommonMark reconhece links inline e referências completas, colapsadas e abreviadas. Títulos, destinos entre `<…>`, prefixo `./`,
paths relativos ao diretório do Markdown, percent-encoding, query e fragmento são aceitos; a comparação é case-sensitive e considera somente
o path-base normalizado em relação à raiz do workspace. Imagens, código, HTML bruto, URLs externas, links somente para fragmentos e destinos
que escapem do workspace são ignorados. Use checks `PATH_EXISTS` separados quando a existência dos arquivos também fizer parte do contrato.
Uma falha de navegação registra somente os índices zero-based dos destinos ausentes, sem repetir destinos esperados, links observados ou o
conteúdo do Markdown.

Use checks diretos sempre que a propriedade for resolvível mecanicamente. Reserve critérios semânticos para significado, fidelidade ou
outcome que não possam ser determinados por igualdade, conteúdo, schema, filesystem ou duração.

## 8. Critérios semânticos e ativação

Um critério semântico contém `id`, `claimId`, `statement` e `required`. Se existir pelo menos um critério semântico obrigatório e os três
trials candidatos concluírem sem decisão direta, o run usa uma única chamada Terra/xhigh para avaliar todos os critérios em batch junto com
quatro probes opacos.

Qualquer probe incorreto, item ausente ou extra, referência inválida, output inválido, timeout ou erro invalida todo o conjunto semântico. Não
há retry, fallback ou revisão humana automática; o resultado é `NO_DECISION` e a evidência direta permanece preservada.

Para ativação, somente telemetria direta de leitura do `SKILL.md` produz evidência positiva. A heurística `skill-used` do Promptfoo é registrada
como limitação, mas não sustenta sozinha uma claim obrigatória. Ausência do evento de leitura resulta em `NOT_ASSESSED`, inclusive quando há
expectativa de não ativação.

## 9. Validar o pacote provider-free

Depois do `init`, a estrutura é:

```text
evaluations/my-evaluation/
  evaluation-spec.json
  skill-snapshot/
  fixtures/
    positive/
    invalid-safety/
    near-boundary/
```

Execute:

```bash
node dist/cli.js check --spec ./evaluations/my-evaluation/evaluation-spec.json
```

`check` valida offline o JSON canônico, chaves exatas, ids, referências, kinds, paths, digests, configuração de execução e ausência de contexto
concorrente. Uma spec inválida nunca chega ao provider.

Não altere manualmente `skill-snapshot` ou fixtures depois do `init`. Qualquer mudança invalida os digests e exige um novo pacote de avaliação.

## 10. Autorizar e executar um run real

`run` exige um Codex home já autenticado por ChatGPT. Aponte `SKILL_EVAL_CODEX_HOME` para um diretório regular que contenha `auth.json`. A CLI
não copia config, histórico, rules ou skills globais desse home.

Bash:

```bash
SKILL_EVAL_CODEX_HOME=/path/to/authenticated-codex-home \
  node dist/cli.js run \
  --spec ./evaluations/my-evaluation/evaluation-spec.json \
  --out ./runs/my-evaluation-001 \
  --approve-provider-calls 4
```

PowerShell:

```powershell
$env:SKILL_EVAL_CODEX_HOME = 'C:\path\to\authenticated-codex-home'
node dist/cli.js run `
  --spec ./evaluations/my-evaluation/evaluation-spec.json `
  --out ./runs/my-evaluation-001 `
  --approve-provider-calls 4
```

Regras importantes:

- `--approve-provider-calls` aceita somente o texto literal `4`;
- a autorização vale apenas para esse processo e não fica salva para outro run;
- o diretório de saída precisa não existir;
- a autorização permite até quatro tentativas, mas o judge pode não ser necessário;
- cada timeout ou erro consome uma tentativa e nunca causa retry;
- um run interrompido ou concluído nunca é retomado;
- outra observação exige outro diretório e outra autorização literal.

Ordem e limites fixos:

1. `POSITIVE` com Luna/max;
2. `INVALID_SAFETY` com Luna/max;
3. `NEAR_BOUNDARY` com Luna/max;
4. batch Terra/xhigh somente quando há semântica obrigatória ainda não resolvida.

As chamadas são sequenciais, com timeout de 600 segundos, concorrência máxima 1 e zero retries. Uma violação direta observada com
`DO_NOT_PROCEED` encerra imediatamente e tem precedência sobre erro de instrumento concorrente.

Para cada chamada, a CLI cria um workspace temporário novo contendo apenas a target skill e a fixture permitida. Também cria um Codex home
temporário privado com uma cópia `0600` do `auth.json` e o remove no `finally`.

## 11. Executar o probe independente de ativação

Use o probe quando a pergunta específica for se conteúdo existente exclusivamente no `SKILL.md` temporário ficou exposto ao modelo e
influenciou a resposta. Ele valida a mesma spec e os mesmos digests do pacote, mas não lê nem altera um run anterior.

Bash:

```bash
SKILL_EVAL_CODEX_HOME=/path/to/authenticated-codex-home \
  node dist/cli.js probe-activation \
  --spec ./evaluations/my-evaluation/evaluation-spec.json \
  --out ./probes/my-evaluation-activation-001 \
  --approve-provider-calls 3
```

PowerShell:

```powershell
$env:SKILL_EVAL_CODEX_HOME = 'C:\path\to\authenticated-codex-home'
node dist/cli.js probe-activation `
  --spec ./evaluations/my-evaluation/evaluation-spec.json `
  --out ./probes/my-evaluation-activation-001 `
  --approve-provider-calls 3
```

Somente o texto literal `3` é aceito; `03`, `3.0`, `3e0` e `+3` falham antes da reserva. Para cada caso, a CLI:

1. gera um marcador imprevisível de 128 bits diferente dos demais;
2. confirma que o marcador não aparece no prompt nem na fixture;
3. cria e verifica um workspace novo com a skill e fixture congeladas;
4. acrescenta a instrução de marcador somente à cópia temporária de `SKILL.md`;
5. registra os digests da skill base e instrumentada;
6. envia o prompt original a Luna/max, com timeout de 600 segundos e zero retries;
7. registra presença ou ausência do marcador e remove o workspace no `finally`.

Timeout e erro de provider consomem uma tentativa, mas não impedem os casos seguintes. Falha de integridade, sanitização ou ambiente
interrompe quando continuar deixaria de ser seguro. O teto é exatamente três tentativas Luna/max; Terra nunca é chamado.

O diretório indicado por `--out` precisa não existir e deve ficar fora de todo o pacote de avaliação (spec, snapshot e fixtures). Um destino
igual ou descendente desse pacote é rejeitado como path inseguro antes de criar artefatos ou chamar o provider.

O diretório create-only contém:

```text
probes/my-evaluation-activation-001/
  manifest.json
  probe-results.jsonl
  terminal.json
  evidence/
    final-outputs/
    promptfoo-projections/
```

| Estado | Exit code | Interpretação limitada |
| --- | ---: | --- |
| `CONFIRMED` | 0 | As três respostas contêm seus marcadores, demonstrando exposição e influência do conteúdo exclusivo do `SKILL.md` temporário. |
| `NOT_CONFIRMED` | 0 | Ao menos uma resposta concluída não contém seu marcador; isso não prova que a skill não foi usada. |
| `INCONCLUSIVE` | 3 | Sem ausência observada em resposta aceita, timeout, provider ou ambiente impediram três confirmações. |

`CONFIRMED` não demonstra telemetria de leitura no sistema operacional, leitura de referências, correção, benefício causal ou generalização.
O probe não modifica nem é agregado automaticamente a `terminal.json`, report, claims ou recomendação do run. Teste A/B está fora do MVP.
O owner só pode tratá-lo como evidência complementar depois de verificar independentemente mesma spec e digests, run concluído, probe
`CONFIRMED`, claims obrigatórias não relacionadas à ativação `SUPPORTED` e ativação ausente como único motivo de `NO_DECISION`.
Nesse cenário, qualquer aplicação única da skill original sobre uma implementação real já verde deve ocorrer em branch ou worktree separado,
seguida por testes independentes e inspeção do diff antes de commit ou merge.

## 12. Artefatos do run

Um run reservado contém:

```text
runs/my-evaluation-001/
  manifest.json
  budget-ledger.json
  case-results.jsonl
  evidence/
    filesystem-diffs/
    final-outputs/
    promptfoo-projections/
  judge-batch.json
  judge-result.json
  terminal.json
```

Os arquivos do judge aparecem somente quando essa fase é tentada ou concluída. `terminal.json` é escrito por último quando possível. As
escritas são create-only; componentes existentes não são sobrescritos.

O run preserva spec e digests, prompts, respostas finais, checks, diffs sanitizados, telemetria disponível, usage, batch opaco e contabilidade
de chamadas. Não deve conter `auth.json`, tokens, cookies, environment completo, chain of thought, configuração global ou conteúdo de arquivos
fora do workspace.

Runs permanecem locais, são ignorados pelo Git e não têm upload ou retenção remota automática. Exclusão é uma decisão manual do owner.

## 13. Gerar relatórios

Escrever JSON em stdout:

```bash
node dist/cli.js report --run ./runs/my-evaluation-001 --format json
```

Criar arquivos novos:

```bash
node dist/cli.js report \
  --run ./runs/my-evaluation-001 \
  --format json \
  --out ./reports/my-evaluation-001.json

node dist/cli.js report \
  --run ./runs/my-evaluation-001 \
  --format markdown \
  --out ./reports/my-evaluation-001.md
```

O diretório pai de `--out` precisa existir e o arquivo de destino não pode existir. JSON e Markdown derivam do mesmo assessment canônico.

Se `terminal.json` estiver ausente, `report` não retoma chamadas. Ele representa a evidência confirmada como
`INTERRUPTED_UNCONFIRMED / NO_DECISION` e indica a última observação append-only disponível.

## 14. Interpretar o resultado

### 14.1 Status das claims

| Status | Significado |
| --- | --- |
| `SUPPORTED` | Evidência válida satisfaz o contrato prespecificado nos casos observados. |
| `NOT_SUPPORTED` | Evidência válida contradiz ou não satisfaz o contrato. |
| `NOT_ASSESSED` | Evidência necessária está ausente ou inválida. |

### 14.2 Recomendação

| Recomendação | Ação |
| --- | --- |
| `PROCEED` | Prosseguir somente sob a condição congelada e o limite declarado. |
| `REVISE` | Revisar a skill ou o instrumento e criar outro run. |
| `DO_NOT_PROCEED` | Não prosseguir sob a condição observada; corrigir o efeito crítico ou proibido. |
| `NO_DECISION` | Obter evidência válida em outro run sem inferir resultado favorável. |

Precedência: uma violação direta de segurança, não interferência ou efeito proibido com `DO_NOT_PROCEED` vence; depois vêm erros de
instrumento, ambiente, provider, timeout ou judge inválido; depois ausência ou contradição de claims obrigatórias.

### 14.3 Estados terminais

| Estado | Leitura operacional |
| --- | --- |
| `COMPLETED` | Todas as fases necessárias concluíram dentro do orçamento. |
| `CRITICAL_VIOLATION` | Um check direto determinou `REVISE` ou `DO_NOT_PROCEED`. |
| `INSTRUMENT_INVALID` | Um check não pôde ser aplicado de forma válida. |
| `EXECUTION_TIMEOUT` | Uma tentativa atingiu timeout. |
| `PROVIDER_ERROR` | O provider retornou erro. |
| `ENVIRONMENT_FAILURE` | Workspace, sanitização ou ambiente violou uma precondição. |
| `JUDGE_INVALID` | Schema, invariantes ou probes do judge falharam. |
| `INTERRUPTED_UNCONFIRMED` | O run não tem terminal receipt confirmado. |

Falhas de autorização e de preflight acontecem antes da reserva e não produzem um run utilizável.

### 14.4 Calls, duração e custo

O relatório separa chamadas autorizadas, tentadas, concluídas, timeout e error, além de usage e duração monotônica. Ajustes materiais do relógio
civil aparecem como limitação e não reordenam os eventos.

O custo monetário real da conta ChatGPT é sempre `UNKNOWN`: a conta não fornece uma unidade monetária auditável. A estimativa
API-equivalent usa a tabela congelada da spec somente quando input, cached input e output estão disponíveis; ela não é custo real da assinatura.

## 15. Exit codes

| Código | Significado |
| ---: | --- |
| 0 | Comando produziu um artefato válido, inclusive `REVISE`, `DO_NOT_PROCEED` ou probe `NOT_CONFIRMED`. |
| 2 | Erro de uso, spec ou preflight antes da reserva. |
| 3 | Run ou probe reservado terminou inconclusivo. |
| 4 | Corrupção, overwrite, path inseguro ou violação de integridade. |

Não interprete exit code 0 como `PROCEED`; sempre leia a recomendação do relatório.

## 16. Reavaliar sem apagar evidência

Crie outra avaliação ou outro run quando mudar qualquer item material:

- skill ou fixture;
- spec, cases, checks ou critério semântico;
- modelo ou reasoning effort;
- versão do Promptfoo, Codex SDK ou CLI;
- ambiente material;
- evidência anterior incompleta, inválida ou inconclusiva.

Nunca reutilize um diretório reservado e não substitua seletivamente um resultado negativo. Novo run ou probe é outra observação e não apaga
o anterior.

## 17. Troubleshooting

| Sintoma | Causa provável | Ação segura |
| --- | --- | --- |
| `Refusing to reuse existing path` | Diretório ou arquivo de saída já existe. | Escolha um path novo; não apague evidência para simular retry. |
| `Spec JSON is not canonical` | A spec foi editada manualmente ou reformatada. | Recrie o pacote com `init` a partir das respostas confirmadas. |
| `digest does not match` | Skill snapshot ou fixture mudou depois do intake. | Crie uma nova avaliação; não repare o digest manualmente. |
| `SKILL_EVAL_CODEX_HOME` ausente | `run` ou `probe-activation` não recebeu um Codex home autenticado. | Aponte a variável para um diretório regular com `auth.json`. |
| Contexto ou path proibido | Há symlink, `AGENTS.md`, `.agents`, `.git`, hardlink ou referência que escapa. | Remova o contexto concorrente da skill ou fixture de origem. |
| `INSTRUMENT_INVALID` | Um check não pôde ler ou interpretar a evidência. | Corrija o contrato ou a fixture e crie uma nova avaliação. |
| `JUDGE_INVALID` | Output, refs, schema ou um dos quatro probes falhou. | Preserve o run e, se necessário, crie outro com nova autorização. |
| `NOT_ASSESSED` em ativação | Não existe telemetria direta suficiente de leitura do `SKILL.md`. | Trate como evidência ausente; a heurística positiva não substitui telemetria. |
| Custo ChatGPT `UNKNOWN` | Comportamento esperado para autenticação ChatGPT. | Use a estimativa API-equivalent somente como referência condicionada. |
| Run sem `terminal.json` | Processo interrompido ou confirmação final ausente. | Gere o report, preserve o run e use outro diretório para nova observação. |
| Probe `NOT_CONFIRMED` | Uma resposta concluída não reproduziu seu marcador. | Preserve o probe; não conclua que a skill deixou de ser usada. |
| Probe `INCONCLUSIVE` | Timeout, provider, ambiente ou sanitização impediram três confirmações. | Preserve o artefato e use outro diretório somente com nova autorização. |

## 18. Limites de segurança e de conclusão

O isolamento de `workspace-write`, rede desabilitada, ambiente não herdado e ausência de skills globais reduz contexto concorrente. Ele não é
uma fronteira de virtualização contra um processo malicioso executado pela mesma conta do sistema operacional.

O encerramento deste MVP significa que o mecanismo provider-free satisfaz os critérios atuais do `SPEC.md`. Não significa:

- qualificação geral de Luna/max ou Terra/xhigh;
- garantia de que qualquer skill funciona;
- estabilidade, robustez ou confiabilidade populacional;
- comparação causal entre skill e baseline;
- teste A/B ou promoção automática do probe a decisão da avaliação;
- publicação npm, suporte multiusuário ou operação como serviço.
