import type { JSONSchemaType } from 'ajv';
import type { InitAnswers } from './types.js';

const id = { type: 'string', pattern: '^[a-z][a-z0-9-]{0,63}$' } as const;
const text = { type: 'string', pattern: '.*\\S.*' } as const;
const digest = { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' } as const;
const skillName = { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$' } as const;
const failureDecision = { enum: ['REVISE', 'DO_NOT_PROCEED', 'ADVISORY'] } as const;
const checkBaseProperties = {
  id,
  claimId: id,
  required: { type: 'boolean' },
  failureDecision,
} as const;

const directCheckSchema = {
  oneOf: [
    {
      type: 'object', additionalProperties: false,
      required: ['id', 'claimId', 'operator', 'expected', 'required', 'failureDecision'],
      properties: { ...checkBaseProperties, operator: { const: 'FINAL_EQUALS' }, expected: { type: 'string' } },
    },
    ...(['FINAL_CONTAINS', 'FINAL_EXCLUDES'] as const).map((operator) => ({
      type: 'object', additionalProperties: false,
      required: ['id', 'claimId', 'operator', 'fragments', 'required', 'failureDecision'],
      properties: { ...checkBaseProperties, operator: { const: operator }, fragments: { type: 'array', minItems: 1, uniqueItems: true, items: text } },
    })),
    {
      type: 'object', additionalProperties: false,
      required: ['id', 'claimId', 'operator', 'schema', 'required', 'failureDecision'],
      properties: { ...checkBaseProperties, operator: { const: 'FINAL_JSON_SCHEMA' }, schema: { oneOf: [{ type: 'object' }, { type: 'boolean' }] } },
    },
    ...(['PATH_EXISTS', 'PATH_ABSENT'] as const).map((operator) => ({
      type: 'object', additionalProperties: false,
      required: ['id', 'claimId', 'operator', 'path', 'required', 'failureDecision'],
      properties: { ...checkBaseProperties, operator: { const: operator }, path: text },
    })),
    {
      type: 'object', additionalProperties: false,
      required: ['id', 'claimId', 'operator', 'path', 'expected', 'required', 'failureDecision'],
      properties: {
        ...checkBaseProperties, operator: { const: 'FILE_EQUALS' }, path: text,
        expected: { oneOf: [{ type: 'string' }, { type: 'object', additionalProperties: false, required: ['sha256'], properties: { sha256: digest } }] },
      },
    },
    ...(['FILE_CONTAINS', 'FILE_EXCLUDES'] as const).map((operator) => ({
      type: 'object', additionalProperties: false,
      required: ['id', 'claimId', 'operator', 'path', 'fragments', 'required', 'failureDecision'],
      properties: { ...checkBaseProperties, operator: { const: operator }, path: text, fragments: { type: 'array', minItems: 1, uniqueItems: true, items: text } },
    })),
    {
      type: 'object', additionalProperties: false,
      required: ['id', 'claimId', 'operator', 'paths', 'required', 'failureDecision'],
      properties: { ...checkBaseProperties, operator: { const: 'WRITES_WITHIN' }, paths: { type: 'array', minItems: 1, uniqueItems: true, items: text } },
    },
    {
      type: 'object', additionalProperties: false,
      required: ['id', 'claimId', 'operator', 'required', 'failureDecision'],
      properties: { ...checkBaseProperties, operator: { const: 'NO_FILESYSTEM_CHANGE' } },
    },
    {
      type: 'object', additionalProperties: false,
      required: ['id', 'claimId', 'operator', 'maximumMs', 'required', 'failureDecision'],
      properties: { ...checkBaseProperties, operator: { const: 'MAX_ELAPSED_MS' }, maximumMs: { type: 'integer', minimum: 0 } },
    },
  ],
} as const;

const claimSchema = {
  type: 'object', additionalProperties: false,
  required: ['id', 'statement', 'kind', 'required', 'failureDecision'],
  properties: {
    id, statement: text,
    kind: { enum: ['BEHAVIOR', 'ACTIVATION', 'SAFETY', 'NON_INTERFERENCE', 'EFFICIENCY'] },
    required: { type: 'boolean' }, failureDecision,
  },
} as const;

const semanticCriterionSchema = {
  type: 'object', additionalProperties: false,
  required: ['id', 'claimId', 'statement', 'required'],
  properties: { id, claimId: id, statement: text, required: { type: 'boolean' } },
} as const;

const caseProperties = {
  id,
  kind: { enum: ['POSITIVE', 'INVALID_SAFETY', 'NEAR_BOUNDARY'] },
  prompt: text,
  claimIds: { type: 'array', minItems: 1, uniqueItems: true, items: id },
  activationExpectation: { enum: ['MUST_ACTIVATE', 'MUST_NOT_ACTIVATE', 'NOT_ASSERTED'] },
  checks: { type: 'array', items: directCheckSchema },
  semanticCriteria: { type: 'array', items: semanticCriterionSchema },
} as const;

const caseSchema = {
  type: 'object', additionalProperties: false,
  required: ['id', 'kind', 'prompt', 'fixturePath', 'claimIds', 'activationExpectation', 'checks', 'semanticCriteria'],
  properties: { ...caseProperties, fixturePath: { type: ['string', 'null'] } },
} as const;

export const evaluationSpecSchema = {
  $id: 'https://skill-eval.local/evaluation-spec.schema.json',
  type: 'object', additionalProperties: false,
  required: ['schemaVersion', 'evaluationId', 'createdAt', 'skill', 'decision', 'claims', 'cases', 'execution', 'retention'],
  properties: {
    schemaVersion: { const: 1 }, evaluationId: id, createdAt: text,
    skill: {
      type: 'object', additionalProperties: false, required: ['name', 'snapshotPath', 'sha256'],
      properties: { name: skillName, snapshotPath: { const: 'skill-snapshot' }, sha256: digest },
    },
    decision: {
      type: 'object', additionalProperties: false, required: ['question', 'proceedMeaning'],
      properties: { question: text, proceedMeaning: text },
    },
    claims: { type: 'array', minItems: 1, items: claimSchema },
    cases: { type: 'array', minItems: 3, maxItems: 3, items: caseSchema },
    execution: {
      type: 'object', additionalProperties: false,
      required: ['candidate', 'judge', 'totalMaximumCalls', 'maximumConcurrency', 'retries'],
      properties: {
        candidate: {
          type: 'object', additionalProperties: false,
          required: ['provider', 'model', 'reasoningEffort', 'maximumCalls', 'timeoutSeconds'],
          properties: { provider: { const: 'openai:codex-sdk' }, model: { const: 'gpt-5.6-luna' }, reasoningEffort: { const: 'max' }, maximumCalls: { const: 3 }, timeoutSeconds: { const: 600 } },
        },
        judge: {
          type: 'object', additionalProperties: false,
          required: ['provider', 'model', 'reasoningEffort', 'maximumCalls', 'timeoutSeconds'],
          properties: { provider: { const: 'openai:codex-sdk' }, model: { const: 'gpt-5.6-terra' }, reasoningEffort: { const: 'xhigh' }, maximumCalls: { const: 1 }, timeoutSeconds: { const: 600 } },
        },
        totalMaximumCalls: { const: 4 }, maximumConcurrency: { const: 1 }, retries: { const: 0 },
      },
    },
    retention: { type: 'object', additionalProperties: false, required: ['mode'], properties: { mode: { const: 'SANITIZED_LOCAL_COMPLETE' } } },
  },
} as const;

export const initAnswersSchema = {
  type: 'object', additionalProperties: false,
  required: ['decision', 'claims', 'cases'],
  properties: {
    evaluationId: id,
    decision: {
      type: 'object', additionalProperties: false, required: ['question', 'proceedMeaning'],
      properties: { question: text, proceedMeaning: text },
    },
    claims: { type: 'array', minItems: 1, items: claimSchema },
    cases: {
      type: 'array', minItems: 3, maxItems: 3,
      items: {
        type: 'object', additionalProperties: false,
        required: ['id', 'kind', 'prompt', 'fixtureSource', 'claimIds', 'activationExpectation', 'checks', 'semanticCriteria'],
        properties: { ...caseProperties, fixtureSource: { type: ['string', 'null'] } },
      },
    },
  },
} as unknown as JSONSchemaType<InitAnswers>;
