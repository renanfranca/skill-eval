import type { TokenUsage } from '../runtime/provider.js';

export const PRICE_TABLE = {
  version: '2026-08-15',
  currency: 'USD',
  models: {
    'gpt-5.6-luna': { inputPerMillion: 0.2, cachedInputPerMillion: 0.02, outputPerMillion: 1.2 },
    'gpt-5.6-terra': { inputPerMillion: 2, cachedInputPerMillion: 0.2, outputPerMillion: 12 },
  },
} as const;

export interface CostSummary {
  actualChatGptCost: 'UNKNOWN';
  actualChatGptCostReason: string;
  apiEquivalentEstimateUsd: number | 'UNKNOWN';
  apiEquivalentEstimateReason: string;
  priceTableVersion: string;
}

export function estimateApiEquivalent(
  records: Array<{ model: keyof typeof PRICE_TABLE.models; usage?: TokenUsage }>,
): CostSummary {
  let total = 0;
  for (const record of records) {
    const usage = record.usage;
    if (
      usage?.input === undefined || usage.cachedInput === undefined || usage.output === undefined ||
      usage.cachedInput > usage.input
    ) {
      return {
        actualChatGptCost: 'UNKNOWN',
        actualChatGptCostReason: 'ChatGPT account usage has no auditable monetary unit',
        apiEquivalentEstimateUsd: 'UNKNOWN',
        apiEquivalentEstimateReason: 'Required input, cached-input, or output token decomposition is unavailable',
        priceTableVersion: PRICE_TABLE.version,
      };
    }
    const price = PRICE_TABLE.models[record.model];
    total += ((usage.input - usage.cachedInput) * price.inputPerMillion + usage.cachedInput * price.cachedInputPerMillion + usage.output * price.outputPerMillion) / 1_000_000;
  }
  return {
    actualChatGptCost: 'UNKNOWN',
    actualChatGptCostReason: 'ChatGPT account usage has no auditable monetary unit',
    apiEquivalentEstimateUsd: Number(total.toFixed(8)),
    apiEquivalentEstimateReason: 'Estimate uses the captured API-equivalent price table; it is not subscription cost',
    priceTableVersion: PRICE_TABLE.version,
  };
}
