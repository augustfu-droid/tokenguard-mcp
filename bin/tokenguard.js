#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { auditSpendLogs } from '../src/audit.js';
import { checkRepoGuard, formatCheckAsSarif } from '../src/guard.js';
import {
  activateLicense,
  deactivateLicense,
  formatUpgradeBanner,
  getLicenseStatus,
} from '../src/license.js';
import { startMcpStdioServer } from '../src/mcp.js';
import { packRepoContext } from '../src/packer.js';
import { estimateMultiModelCosts, estimateTokens, MODEL_PRICING } from '../src/pricing.js';
import { scanRepo } from '../src/scanner.js';

const VERSION = '1.0.0';

function parseArgs(argv) {
  const positionals = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq !== -1) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else {
        const key = arg.slice(2);
        const next = argv[i + 1];
        if (next && !next.startsWith('-')) {
          flags[key] = next;
          i += 1;
        } else {
          flags[key] = true;
        }
      }
    } else if (arg === '-v') {
      flags.version = true;
    } else if (arg === '-h') {
      flags.help = true;
    } else {
      positionals.push(arg);
    }
  }
  return { command: positionals[0] || 'help', args: positionals.slice(1), flags };
}

function pad(str, width, right = false) {
  const s = String(str);
  if (s.length >= width) return s.slice(0, width);
  return right ? ' '.repeat(width - s.length) + s : s + ' '.repeat(width - s.length);
}

function printHelp() {
  console.log(`
TokenGuard v${VERSION} — AI Coding Token Budgeter, Context Packer & MCP Server

Usage:
  tokenguard scan [dir] [--top 15] [--json]
      Scan repo token footprint, find context hogs, and compare model costs.

  tokenguard pack [dir] [--budget 32000] [--mode full|skeleton] [--format xml|md] [--out file]
      Pack highest-signal files strictly inside a token budget (skeleton = Pro).

  tokenguard diff [--base HEAD] [--json]
      Estimate token & dollar cost of your current git diff before AI review.

  tokenguard mcp
      Start stdio JSON-RPC 2.0 MCP Server for Claude Code / Cursor / Windsurf.

  tokenguard check [dir] [--max-tokens N] [--max-cost USD] [--model ID] [--format text|json|sarif]
      [Pro] CI/Pre-commit budget gate + secret leak scanner (SARIF 2.1.0 ready).

  tokenguard audit <log-file-or-dir> [--json]
      [Pro] Parse local JSONL/JSON AI usage logs and report spend by model & day.

  tokenguard pricing
      Show built-in 2026 LLM pricing reference table.

  tokenguard activate <LICENSE_KEY> | status | deactivate
      Manage TokenGuard Pro license key.
`.trim());
}

async function main() {
  const { command, args, flags } = parseArgs(process.argv.slice(2));

  if (flags.version || command === 'version') {
    console.log(VERSION);
    return;
  }

  if (flags.help || command === 'help') {
    printHelp();
    return;
  }

  if (command === 'mcp') {
    startMcpStdioServer();
    return;
  }

  if (command === 'pricing') {
    if (flags.json) {
      console.log(JSON.stringify(MODEL_PRICING, null, 2));
      return;
    }
    console.log(`${pad('Model ID', 20)} ${pad('Input / 1M', 12, true)} ${pad('Output / 1M', 13, true)} ${pad('Context', 12, true)}`);
    console.log('-'.repeat(60));
    for (const [id, m] of Object.entries(MODEL_PRICING)) {
      console.log(
        `${pad(id, 20)} ${pad('$' + m.inputPer1M.toFixed(2), 12, true)} ${pad('$' + m.outputPer1M.toFixed(2), 13, true)} ${pad(m.contextWindow.toLocaleString(), 12, true)}`,
      );
    }
    return;
  }

  if (command === 'scan') {
    const dir = args[0] || process.cwd();
    const res = await scanRepo(dir, { topN: Number(flags.top) || 12 });
    if (flags.json) {
      const { allFiles: _omit, ...out } = res;
      console.log(JSON.stringify(out, null, 2));
      return;
    }

    console.log(`\nTokenGuard Scan — ${res.rootDir}`);
    console.log(`Files: ${res.totalFiles} | Lines: ${res.totalLines.toLocaleString()} | Estimated Tokens: ${res.totalTokens.toLocaleString()}`);
    console.log(`Skipped: ${res.skipped.ignored} ignored, ${res.skipped.binary} binary, ${res.skipped.large} oversized\n`);

    console.log('Top Context Hogs:');
    console.log(`  ${pad('File', 48)} ${pad('Tokens', 10, true)} ${pad('Share', 8, true)}`);
    for (const f of res.topFiles) {
      const pct = ((f.tokens / Math.max(1, res.totalTokens)) * 100).toFixed(1) + '%';
      console.log(`  ${pad(f.path, 48)} ${pad(f.tokens.toLocaleString(), 10, true)} ${pad(pct, 8, true)}`);
    }

    console.log('\nSingle-Pass Input Cost Estimate:');
    for (const c of res.modelCosts.slice(0, 6)) {
      console.log(`  ${pad(c.label, 20)} $${pad(c.totalCostUsd.toFixed(4), 9, true)}  (${c.contextPct}% of window)`);
    }

    if (res.hints.length > 0) {
      console.log('\nSavings Hints:');
      for (const h of res.hints) console.log(`  - ${h}`);
    }
    return;
  }

  if (command === 'pack') {
    const dir = args[0] || process.cwd();
    const mode = flags.mode === 'skeleton' ? 'skeleton' : 'full';
    if (mode === 'skeleton') {
      const lic = await getLicenseStatus();
      if (!lic.active) {
        console.error(formatUpgradeBanner('Skeleton Compression Mode (--mode skeleton)'));
        process.exitCode = 2;
        return;
      }
    }

    const packed = await packRepoContext(dir, {
      budget: Number(flags.budget) || 32000,
      mode,
      format: flags.format === 'md' ? 'md' : 'xml',
    });

    if (flags.out) {
      await fs.writeFile(String(flags.out), packed.output, 'utf8');
      console.log(
        `Packed ${packed.filesIncluded} files (${packed.usedTokens.toLocaleString()}/${packed.budget.toLocaleString()} tokens, ${packed.compressionPct}% saved, ${packed.filesOmitted} omitted) -> ${flags.out}`,
      );
    } else {
      process.stdout.write(packed.output + '\n');
    }
    return;
  }

  if (command === 'diff') {
    const base = typeof flags.base === 'string' ? flags.base : 'HEAD';
    let diffText = '';
    try {
      diffText = execFileSync('git', ['diff', base], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
    } catch (err) {
      console.error(`Failed to run git diff ${base}: ${err?.message || err}`);
      process.exitCode = 1;
      return;
    }
    const tokens = estimateTokens(diffText, '.diff');
    const costs = estimateMultiModelCosts(tokens, 1500);
    if (flags.json) {
      console.log(JSON.stringify({ base, chars: diffText.length, tokens, costs }, null, 2));
      return;
    }
    console.log(`Git diff (${base}): ${tokens.toLocaleString()} input tokens (+1,500 est. review output)`);
    for (const c of costs.slice(0, 5)) {
      console.log(`  ${pad(c.label, 20)} $${c.totalCostUsd.toFixed(4)}`);
    }
    return;
  }

  if (command === 'check') {
    const lic = await getLicenseStatus();
    if (!lic.active) {
      console.error(formatUpgradeBanner('CI Budget Gate & Secret Scanner (tokenguard check)'));
      process.exitCode = 2;
      return;
    }
    const dir = args[0] || process.cwd();
    const report = await checkRepoGuard(dir, {
      maxTokens: flags['max-tokens'] ? Number(flags['max-tokens']) : null,
      maxFileTokens: flags['max-file-tokens'] ? Number(flags['max-file-tokens']) : 25000,
      maxCostUsd: flags['max-cost'] ? Number(flags['max-cost']) : null,
      model: typeof flags.model === 'string' ? flags.model : 'claude-sonnet-4',
      scanSecrets: flags['no-secrets'] !== true,
    });

    if (flags.format === 'sarif') {
      console.log(JSON.stringify(formatCheckAsSarif(report), null, 2));
    } else if (flags.format === 'json' || flags.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(`TokenGuard Check — ${report.passed ? 'PASSED' : 'FAILED'}`);
      console.log(`Tokens: ${report.totalTokens.toLocaleString()} | Cost (${report.estimatedCost.label}): $${report.estimatedCost.totalCostUsd.toFixed(4)}`);
      console.log(`Errors: ${report.errorCount} | Warnings: ${report.warningCount}`);
      for (const v of report.violations) {
        console.log(`  [${v.severity.toUpperCase()}] ${v.file}:${v.line} (${v.ruleId}) ${v.message}`);
      }
    }

    if (!report.passed) process.exitCode = 1;
    return;
  }

  if (command === 'audit') {
    const lic = await getLicenseStatus();
    if (!lic.active) {
      console.error(formatUpgradeBanner('Local AI Spend Ledger & Session Audit (tokenguard audit)'));
      process.exitCode = 2;
      return;
    }
    const target = args[0];
    if (!target) {
      console.error('Usage: tokenguard audit <jsonl-file-or-dir>');
      process.exitCode = 1;
      return;
    }
    const summary = await auditSpendLogs(target);
    if (flags.json) {
      console.log(JSON.stringify(summary, null, 2));
      return;
    }
    console.log(`TokenGuard Spend Audit — ${summary.target}`);
    console.log(`Files: ${summary.filesScanned} | Events: ${summary.eventsParsed} | Total Spend: $${summary.totalCostUsd.toFixed(4)}`);
    console.log(`Tokens: ${summary.totalInputTokens.toLocaleString()} in / ${summary.totalOutputTokens.toLocaleString()} out\n`);
    console.log('By Model:');
    for (const m of summary.byModel) {
      console.log(`  ${pad(m.model, 20)} ${pad(m.events + ' calls', 12, true)}  $${m.costUsd.toFixed(4)}`);
    }
    return;
  }

  if (command === 'activate') {
    const key = args[0];
    if (!key) {
      console.error('Usage: tokenguard activate <LICENSE_KEY>');
      process.exitCode = 1;
      return;
    }
    const rec = await activateLicense(key);
    console.log(`TokenGuard Pro activated! Instance: ${rec.instanceId}`);
    return;
  }

  if (command === 'status') {
    const st = await getLicenseStatus({ forceRemote: Boolean(flags.remote) });
    console.log(JSON.stringify(st, null, 2));
    return;
  }

  if (command === 'deactivate') {
    const res = await deactivateLicense();
    console.log(res.message);
    return;
  }

  console.error(`Unknown command: ${command}`);
  printHelp();
  process.exitCode = 1;
}

main().catch((err) => {
  console.error(`[TokenGuard Error] ${err?.message || err}`);
  process.exitCode = 1;
});
