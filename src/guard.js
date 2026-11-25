import fs from 'node:fs/promises';
import { estimateCostUsd } from './pricing.js';
import { scanRepo } from './scanner.js';

const SECRET_RULES = [
  { id: 'aws-access-key', name: 'AWS Access Key ID', regex: /\bAKIA[0-9A-Z]{16}\b/g },
  { id: 'github-pat', name: 'GitHub Personal Access Token', regex: /\b(?:ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{40,})\b/g },
  { id: 'openai-anthropic-key', name: 'OpenAI / Anthropic API Key', regex: /\b(?:sk-ant-[A-Za-z0-9_-]{20,}|sk-(?:proj-)?[A-Za-z0-9_-]{32,})\b/g },
  { id: 'stripe-creem-live', name: 'Live Payment API Key', regex: /\b(?:sk_live_[A-Za-z0-9]{20,}|creem_live_[A-Za-z0-9_-]{16,})\b/g },
  { id: 'private-key-block', name: 'Private Key PEM Header', regex: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g },
  { id: 'google-api-key', name: 'Google API Key', regex: /\bAIza[0-9A-Za-z\-_]{35}\b/g },
];

function redactSecret(match) {
  if (match.length <= 12) return '***REDACTED***';
  return `${match.slice(0, 6)}...${match.slice(-4)}`;
}

/**
 * Pro Feature: CI / Pre-commit Token Budget Gate + Secret Leak Audit (with SARIF 2.1.0 output).
 */
export async function checkRepoGuard(rootDir = process.cwd(), options = {}) {
  const maxTokens = options.maxTokens ? Number(options.maxTokens) : null;
  const maxFileTokens = options.maxFileTokens ? Number(options.maxFileTokens) : 25000;
  const maxCostUsd = options.maxCostUsd ? Number(options.maxCostUsd) : null;
  const model = options.model || 'claude-sonnet-4';
  const scanSecrets = options.scanSecrets !== false;

  const scan = await scanRepo(rootDir, options);
  const cost = estimateCostUsd(scan.totalTokens, 0, model);
  const violations = [];

  if (maxTokens !== null && scan.totalTokens > maxTokens) {
    violations.push({
      ruleId: 'budget-max-tokens',
      severity: 'error',
      file: '.',
      line: 1,
      message: `Repository context (${scan.totalTokens.toLocaleString()} tokens) exceeds budget limit (${maxTokens.toLocaleString()} tokens).`,
    });
  }

  if (maxCostUsd !== null && cost.totalCostUsd > maxCostUsd) {
    violations.push({
      ruleId: 'budget-max-cost',
      severity: 'error',
      file: '.',
      line: 1,
      message: `Single-pass input cost for ${cost.label} ($${cost.totalCostUsd.toFixed(4)}) exceeds limit ($${maxCostUsd.toFixed(4)}).`,
    });
  }

  for (const f of scan.allFiles) {
    if (f.tokens > maxFileTokens) {
      violations.push({
        ruleId: 'file-context-bloat',
        severity: 'warning',
        file: f.path,
        line: 1,
        message: `File "${f.path}" is ${f.tokens.toLocaleString()} tokens (threshold: ${maxFileTokens.toLocaleString()}).`,
      });
    }

    if (scanSecrets) {
      let content = '';
      try {
        content = await fs.readFile(f.absPath, 'utf8');
      } catch {
        continue;
      }
      const lines = content.split(/\r?\n/);
      for (let idx = 0; idx < lines.length; idx++) {
        const line = lines[idx];
        for (const rule of SECRET_RULES) {
          rule.regex.lastIndex = 0;
          const m = rule.regex.exec(line);
          if (m) {
            violations.push({
              ruleId: `secret-${rule.id}`,
              severity: 'error',
              file: f.path,
              line: idx + 1,
              message: `Possible ${rule.name} detected (${redactSecret(m[0])}) — remove before exposing repo to AI tools or Git.`,
            });
          }
        }
      }
    }
  }

  const errorCount = violations.filter((v) => v.severity === 'error').length;
  const warningCount = violations.filter((v) => v.severity === 'warning').length;

  return {
    passed: errorCount === 0,
    rootDir: scan.rootDir,
    totalFiles: scan.totalFiles,
    totalTokens: scan.totalTokens,
    estimatedCost: cost,
    errorCount,
    warningCount,
    violations,
  };
}

export function formatCheckAsSarif(report) {
  return {
    version: '2.1.0',
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    runs: [
      {
        tool: {
          driver: {
            name: 'TokenGuard',
            version: '1.0.0',
            informationUri: 'https://github.com/augustfu-droid/tokenguard-mcp',
          },
        },
        results: report.violations.map((v) => ({
          ruleId: v.ruleId,
          level: v.severity === 'error' ? 'error' : 'warning',
          message: { text: v.message },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: v.file },
                region: { startLine: v.line },
              },
            },
          ],
        })),
      },
    ],
  };
}
