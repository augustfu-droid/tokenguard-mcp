/**
 * Model pricing catalog (USD per 1M tokens) and fast BPE-calibrated token estimator.
 * Prices reflect public standard API tiers and can be overridden via config/env.
 */

export const MODEL_PRICING = {
  'claude-sonnet-4': { label: 'Claude Sonnet 4', inputPer1M: 3.00, outputPer1M: 15.00, contextWindow: 200000 },
  'claude-opus-4': { label: 'Claude Opus 4', inputPer1M: 15.00, outputPer1M: 75.00, contextWindow: 200000 },
  'claude-haiku-3.5': { label: 'Claude Haiku 3.5', inputPer1M: 0.80, outputPer1M: 4.00, contextWindow: 200000 },
  'gemini-2.5-pro': { label: 'Gemini 2.5 Pro', inputPer1M: 1.25, outputPer1M: 10.00, contextWindow: 1000000 },
  'gemini-2.5-flash': { label: 'Gemini 2.5 Flash', inputPer1M: 0.15, outputPer1M: 0.60, contextWindow: 1000000 },
  'gpt-4.1': { label: 'GPT-4.1', inputPer1M: 2.00, outputPer1M: 8.00, contextWindow: 1000000 },
  'gpt-4.1-mini': { label: 'GPT-4.1 Mini', inputPer1M: 0.40, outputPer1M: 1.60, contextWindow: 1000000 },
  'o3': { label: 'OpenAI o3', inputPer1M: 2.00, outputPer1M: 8.00, contextWindow: 200000 },
  'deepseek-v3': { label: 'DeepSeek V3', inputPer1M: 0.27, outputPer1M: 1.10, contextWindow: 128000 },
  'deepseek-r1': { label: 'DeepSeek R1', inputPer1M: 0.55, outputPer1M: 2.19, contextWindow: 128000 },
};

const CODE_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.go', '.rs', '.java',
  '.kt', '.c', '.cpp', '.h', '.hpp', '.cs', '.rb', '.php', '.swift', '.sh',
  '.sql', '.css', '.scss', '.html', '.xml', '.json', '.yaml', '.yml', '.toml',
]);

/**
 * Fast, dependency-free BPE-calibrated token estimator.
 * Accounts for CJK characters (~1.5 tokens/char), punctuation/symbol clusters,
 * and identifier subword splitting in source code vs English prose.
 */
export function estimateTokens(text = '', ext = '') {
  if (!text) return 0;
  const str = String(text);
  const len = str.length;
  if (len === 0) return 0;

  // Count CJK characters (each is typically 1-2 BPE tokens)
  const cjkMatches = str.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/g);
  const cjkCount = cjkMatches ? cjkMatches.length : 0;

  // Count symbol/operator heavy tokens common in code/JSON
  const symbolMatches = str.match(/[{}[\]().,;:+\-*/=<>!&|^~?@#$%\\"`']/g);
  const symbolCount = symbolMatches ? symbolMatches.length : 0;

  const nonCjkLen = Math.max(0, len - cjkCount);
  const isCode = CODE_EXTENSIONS.has(String(ext).toLowerCase());
  const charsPerToken = isCode ? 3.5 : 4.0;

  // Blend length-based estimate with symbol density adjustment
  const baseNonCjk = nonCjkLen / charsPerToken;
  const symbolDensity = nonCjkLen > 0 ? symbolCount / nonCjkLen : 0;
  const densityMultiplier = symbolDensity > 0.18 ? 1.12 : 1.0;

  return Math.max(1, Math.round(baseNonCjk * densityMultiplier + cjkCount * 1.45));
}

export function resolveModel(modelKey = 'claude-sonnet-4') {
  const key = String(modelKey).toLowerCase().trim();
  if (MODEL_PRICING[key]) return { id: key, ...MODEL_PRICING[key] };
  const fuzzy = Object.keys(MODEL_PRICING).find((k) => k.includes(key) || key.includes(k));
  if (fuzzy) return { id: fuzzy, ...MODEL_PRICING[fuzzy] };
  return { id: 'claude-sonnet-4', ...MODEL_PRICING['claude-sonnet-4'] };
}

export function estimateCostUsd(inputTokens, outputTokens = 0, modelKey = 'claude-sonnet-4') {
  const model = resolveModel(modelKey);
  const inputCost = (inputTokens / 1_000_000) * model.inputPer1M;
  const outputCost = (outputTokens / 1_000_000) * model.outputPer1M;
  return {
    model: model.id,
    label: model.label,
    inputTokens,
    outputTokens,
    inputCostUsd: Number(inputCost.toFixed(6)),
    outputCostUsd: Number(outputCost.toFixed(6)),
    totalCostUsd: Number((inputCost + outputCost).toFixed(6)),
    contextPct: Number(((inputTokens / model.contextWindow) * 100).toFixed(2)),
  };
}

export function estimateMultiModelCosts(inputTokens, outputTokens = 0) {
  return Object.keys(MODEL_PRICING).map((id) => estimateCostUsd(inputTokens, outputTokens, id));
}
