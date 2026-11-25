import readline from 'node:readline';
import { checkRepoGuard } from './guard.js';
import { formatUpgradeBanner, getLicenseStatus } from './license.js';
import { packRepoContext } from './packer.js';
import { estimateMultiModelCosts, estimateTokens } from './pricing.js';
import { scanRepo } from './scanner.js';

const SERVER_INFO = {
  name: 'tokenguard-mcp',
  version: '1.0.0',
};

export const MCP_TOOLS = [
  {
    name: 'scan_repo_tokens',
    description: 'Scan a local repository to count tokens per file, spot context hogs, and compare single-pass input cost across major LLMs (Claude, Gemini, GPT, DeepSeek).',
    inputSchema: {
      type: 'object',
      properties: {
        dir: { type: 'string', description: 'Directory path to scan (defaults to current working directory).' },
        topN: { type: 'integer', description: 'Number of largest context-hog files to return (default 10).', default: 10 },
      },
    },
  },
  {
    name: 'pack_repo_context',
    description: 'Pack the highest-signal repository files into an LLM-ready XML or Markdown context bundle guaranteed to fit within a strict token budget. Use mode="skeleton" (Pro) for 60-85% symbol-level compression.',
    inputSchema: {
      type: 'object',
      properties: {
        dir: { type: 'string', description: 'Repository directory path.' },
        budget: { type: 'integer', description: 'Maximum token budget (default 24000).', default: 24000 },
        mode: { type: 'string', enum: ['full', 'skeleton'], default: 'full' },
        format: { type: 'string', enum: ['xml', 'md'], default: 'xml' },
      },
    },
  },
  {
    name: 'estimate_prompt_cost',
    description: 'Estimate token count and USD cost across Claude, Gemini, OpenAI, and DeepSeek models for any text or code snippet before sending it to an LLM.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Prompt text or code to measure.' },
        expectedOutputTokens: { type: 'integer', description: 'Expected output tokens (default 1000).', default: 1000 },
        ext: { type: 'string', description: 'Optional file extension hint such as .ts or .py.' },
      },
      required: ['text'],
    },
  },
  {
    name: 'check_repo_budget_and_secrets',
    description: '[Pro] Audit a repository against a strict token/cost budget and scan for accidental API keys, tokens, or private keys before sharing context with AI tools.',
    inputSchema: {
      type: 'object',
      properties: {
        dir: { type: 'string', description: 'Directory path to audit.' },
        maxTokens: { type: 'integer', description: 'Fail if total repo tokens exceed this cap.' },
        maxCostUsd: { type: 'number', description: 'Fail if single-pass cost exceeds this USD cap.' },
        model: { type: 'string', description: 'Model ID for cost calculation (default claude-sonnet-4).' },
      },
    },
  },
];

export async function handleMcpRequest(req, options = {}) {
  if (!req || typeof req !== 'object' || req.jsonrpc !== '2.0') {
    return {
      jsonrpc: '2.0',
      id: req?.id ?? null,
      error: { code: -32600, message: 'Invalid JSON-RPC 2.0 request' },
    };
  }

  const { id, method, params = {} } = req;

  // Notifications have no id and expect no response
  if (id === undefined || id === null) {
    return null;
  }

  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: params.protocolVersion || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      },
    };
  }

  if (method === 'ping') {
    return { jsonrpc: '2.0', id, result: {} };
  }

  if (method === 'tools/list') {
    return {
      jsonrpc: '2.0',
      id,
      result: { tools: MCP_TOOLS },
    };
  }

  if (method === 'tools/call') {
    const toolName = params.name;
    const args = params.arguments || {};

    try {
      if (toolName === 'scan_repo_tokens') {
        const res = await scanRepo(args.dir || process.cwd(), { topN: args.topN || 10 });
        const { allFiles: _omit, ...summary } = res;
        return {
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }] },
        };
      }

      if (toolName === 'pack_repo_context') {
        if (args.mode === 'skeleton') {
          const lic = await getLicenseStatus({ apiBase: options.apiBase });
          if (!lic.active) {
            return {
              jsonrpc: '2.0',
              id,
              result: { isError: true, content: [{ type: 'text', text: formatUpgradeBanner('Skeleton Compression Mode') }] },
            };
          }
        }
        const packed = await packRepoContext(args.dir || process.cwd(), {
          budget: args.budget || 24000,
          mode: args.mode || 'full',
          format: args.format || 'xml',
        });
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [
              {
                type: 'text',
                text: `Packed ${packed.filesIncluded} files (${packed.usedTokens}/${packed.budget} tokens, ${packed.filesOmitted} omitted).\n\n${packed.output}`,
              },
            ],
          },
        };
      }

      if (toolName === 'estimate_prompt_cost') {
        const inputTokens = estimateTokens(args.text || '', args.ext || '');
        const outputTokens = Number(args.expectedOutputTokens ?? 1000);
        const costs = estimateMultiModelCosts(inputTokens, outputTokens);
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: JSON.stringify({ inputTokens, outputTokens, costs }, null, 2) }],
          },
        };
      }

      if (toolName === 'check_repo_budget_and_secrets') {
        const lic = await getLicenseStatus({ apiBase: options.apiBase });
        if (!lic.active) {
          return {
            jsonrpc: '2.0',
            id,
            result: { isError: true, content: [{ type: 'text', text: formatUpgradeBanner('Budget Gate & Secret Scanner') }] },
          };
        }
        const report = await checkRepoGuard(args.dir || process.cwd(), {
          maxTokens: args.maxTokens,
          maxCostUsd: args.maxCostUsd,
          model: args.model || 'claude-sonnet-4',
        });
        return {
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: JSON.stringify(report, null, 2) }] },
        };
      }

      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Unknown tool: ${toolName}` },
      };
    } catch (err) {
      return {
        jsonrpc: '2.0',
        id,
        result: { isError: true, content: [{ type: 'text', text: String(err?.message || err) }] },
      };
    }
  }

  return {
    jsonrpc: '2.0',
    id,
    error: { code: -32601, message: `Method not found: ${method}` },
  };
}

/**
 * Start stdio JSON-RPC 2.0 MCP Server loop (one JSON message per line).
 */
export function startMcpStdioServer(options = {}) {
  const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });

  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      process.stdout.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error' },
      })}\n`);
      return;
    }

    const response = await handleMcpRequest(parsed, options);
    if (response) {
      process.stdout.write(`${JSON.stringify(response)}\n`);
    }
  });
}
