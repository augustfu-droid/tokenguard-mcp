import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { auditSpendLogs } from '../src/audit.js';
import { checkRepoGuard, formatCheckAsSarif } from '../src/guard.js';
import {
  activateLicense,
  deactivateLicense,
  getLicenseStatus,
  issueOfflineSignedToken,
  verifyOfflineSignedToken,
} from '../src/license.js';
import { handleMcpRequest } from '../src/mcp.js';
import { compressToSkeleton, packRepoContext } from '../src/packer.js';
import { estimateCostUsd, estimateTokens } from '../src/pricing.js';
import { scanRepo } from '../src/scanner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN_PATH = path.resolve(__dirname, '..', 'bin', 'tokenguard.js');

async function makeTempFixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tokenguard-test-'));
  await fs.mkdir(path.join(dir, 'src'), { recursive: true });
  await fs.writeFile(path.join(dir, 'README.md'), '# Demo Project\n\nA fast utility.\n', 'utf8');
  await fs.writeFile(
    path.join(dir, 'src', 'app.ts'),
    `import { helper } from './helper';\n\nexport interface UserConfig {\n  budget: number;\n}\n\nexport async function runPipeline(cfg: UserConfig) {\n  const lines = [];\n  ${'lines.push("work");\n  '.repeat(60)}\n  return helper(lines.length + cfg.budget);\n}\n`,
    'utf8',
  );
  await fs.writeFile(
    path.join(dir, 'src', 'helper.py'),
    `import math\n\ndef compute_score(x: int) -> float:\n    """Compute normalized score."""\n    ${'x += 1\n    '.repeat(40)}\n    return math.sqrt(x)\n`,
    'utf8',
  );
  await fs.writeFile(path.join(dir, '.gitignore'), 'ignored_dir/\n', 'utf8');
  await fs.mkdir(path.join(dir, 'ignored_dir'), { recursive: true });
  await fs.writeFile(path.join(dir, 'ignored_dir', 'giant.txt'), 'x'.repeat(50000), 'utf8');
  return dir;
}

test('estimateTokens and estimateCostUsd return sensible values for code and CJK text', () => {
  const codeTokens = estimateTokens('export function hello(name: string) { return `hi ${name}`; }', '.ts');
  const cjkTokens = estimateTokens('你好世界，这是一段中文测试文本', '.md');
  assert.ok(codeTokens >= 10 && codeTokens <= 30);
  assert.ok(cjkTokens >= 15 && cjkTokens <= 35);

  const cost = estimateCostUsd(100_000, 10_000, 'claude-sonnet-4');
  assert.equal(cost.inputCostUsd, 0.3);
  assert.equal(cost.outputCostUsd, 0.15);
  assert.equal(cost.totalCostUsd, 0.45);
});

test('scanRepo respects .gitignore and ranks context hogs', async () => {
  const dir = await makeTempFixture();
  try {
    const res = await scanRepo(dir);
    assert.equal(res.totalFiles, 3);
    assert.ok(res.totalTokens > 100);
    assert.equal(res.topFiles[0].path, 'src/app.ts');
    assert.ok(res.skipped.ignored >= 1);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('packRepoContext enforces token budget and skeleton mode achieves high compression', async () => {
  const dir = await makeTempFixture();
  try {
    const full = await packRepoContext(dir, { budget: 5000, mode: 'full', format: 'xml' });
    assert.equal(full.filesIncluded, 3);
    assert.ok(full.usedTokens <= 5000);
    assert.match(full.output, /<repository mode="full"/);

    const skel = await packRepoContext(dir, { budget: 5000, mode: 'skeleton', format: 'md' });
    assert.equal(skel.filesIncluded, 3);
    assert.ok(skel.usedTokens < full.usedTokens);
    assert.ok(skel.compressionPct >= 40);
    assert.match(skel.output, /export async function runPipeline/);
    assert.match(skel.output, /def compute_score/);

    const pySkel = compressToSkeleton('import os\ndef foo():\n    x = 1\n    y = 2\n    return x + y\n', '.py');
    assert.match(pySkel, /def foo\(\):/);
    assert.doesNotMatch(pySkel, /return x \+ y/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('checkRepoGuard catches budget breaches and redacts secret leaks in SARIF output', async () => {
  const dir = await makeTempFixture();
  try {
    const fakeKey = 'AKIA' + 'IOSFODNN7EXAMPLE';
    await fs.writeFile(path.join(dir, 'src', 'leaked.js'), `const k = "${fakeKey}";\n`, 'utf8');
    const report = await checkRepoGuard(dir, { maxTokens: 50, model: 'claude-sonnet-4' });
    assert.equal(report.passed, false);
    assert.ok(report.violations.some((v) => v.ruleId === 'budget-max-tokens'));
    const secretViolation = report.violations.find((v) => v.ruleId === 'secret-aws-access-key');
    assert.ok(secretViolation);
    assert.doesNotMatch(secretViolation.message, new RegExp(fakeKey));

    const sarif = formatCheckAsSarif(report);
    assert.equal(sarif.version, '2.1.0');
    assert.ok(sarif.runs[0].results.length >= 2);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('auditSpendLogs parses local JSONL AI usage logs accurately', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tokenguard-audit-'));
  try {
    const logFile = path.join(dir, 'usage.jsonl');
    await fs.writeFile(
      logFile,
      [
        JSON.stringify({ timestamp: '2026-11-25T10:00:00Z', session_id: 's1', model: 'claude-sonnet-4', usage: { input_tokens: 50000, output_tokens: 5000 } }),
        JSON.stringify({ timestamp: '2026-11-25T11:00:00Z', session_id: 's2', model: 'gemini-2.5-flash', usage: { input_tokens: 100000, output_tokens: 10000 } }),
      ].join('\n'),
      'utf8',
    );
    const audit = await auditSpendLogs(logFile);
    assert.equal(audit.eventsParsed, 2);
    assert.equal(audit.byModel.length, 2);
    assert.ok(audit.totalCostUsd > 0.2);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('Creem license proxy activate, validate, and deactivate lifecycle works cleanly', async () => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tokenguard-home-'));
  const prevHome = process.env.TOKENGUARD_HOME;
  process.env.TOKENGUARD_HOME = homeDir;

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}');
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.url === '/activate' && parsed.key === 'TG-PRO-VALID-123') {
        res.end(JSON.stringify({ valid: true, status: 'active', instance_id: 'inst_001' }));
        return;
      }
      if (req.url === '/validate' && parsed.key === 'TG-PRO-VALID-123') {
        res.end(JSON.stringify({ valid: true, status: 'active', instance_id: 'inst_001' }));
        return;
      }
      if (req.url === '/deactivate') {
        res.end(JSON.stringify({ deactivated: true }));
        return;
      }
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ valid: false, error: 'Invalid key' }));
    });
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const apiBase = `http://127.0.0.1:${server.address().port}`;

  try {
    const freeStatus = await getLicenseStatus({ apiBase });
    assert.equal(freeStatus.active, false);

    const rec = await activateLicense('TG-PRO-VALID-123', { apiBase });
    assert.equal(rec.instanceId, 'inst_001');

    const proStatus = await getLicenseStatus({ apiBase, forceRemote: true });
    assert.equal(proStatus.active, true);
    assert.equal(proStatus.tier, 'pro');

    const deact = await deactivateLicense({ apiBase });
    assert.equal(deact.deactivated, true);
  } finally {
    server.close();
    if (prevHome === undefined) delete process.env.TOKENGUARD_HOME;
    else process.env.TOKENGUARD_HOME = prevHome;
    await fs.rm(homeDir, { recursive: true, force: true });
  }
});

test('MCP JSON-RPC 2.0 handler and live stdio subprocess work end-to-end', async () => {
  const initResp = await handleMcpRequest({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  assert.equal(initResp.result.serverInfo.name, 'tokenguard-mcp');

  const listResp = await handleMcpRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.equal(listResp.result.tools.length, 4);

  // Live subprocess test of CLI scan + live stdio MCP server
  const dir = await makeTempFixture();
  try {
    const scanJson = execFileSync(process.execPath, [BIN_PATH, 'scan', dir, '--json'], { encoding: 'utf8' });
    const parsedScan = JSON.parse(scanJson);
    assert.equal(parsedScan.totalFiles, 3);

    const child = spawn(process.execPath, [BIN_PATH, 'mcp'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const responses = [];
    await new Promise((resolve, reject) => {
      let buf = '';
      child.stdout.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const l of lines) {
          if (l.trim()) responses.push(JSON.parse(l));
        }
        if (responses.length >= 2) resolve();
      });
      child.on('error', reject);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'initialize', params: {} }) + '\n');
      child.stdin.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 11,
          method: 'tools/call',
          params: { name: 'estimate_prompt_cost', arguments: { text: 'Hello MCP world!', expectedOutputTokens: 500 } },
        }) + '\n',
      );
      setTimeout(() => reject(new Error('MCP stdio timeout')), 5000);
    });
    child.kill();

    assert.equal(responses[0].id, 10);
    assert.equal(responses[1].id, 11);
    const toolPayload = JSON.parse(responses[1].result.content[0].text);
    assert.ok(toolPayload.inputTokens >= 3);
    assert.ok(toolPayload.costs.length >= 5);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('Zero-proxy license backends: Offline Ed25519 TG1, Polar.sh, Payhip, and Gumroad work cleanly', async () => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tokenguard-zero-proxy-'));
  const prevHome = process.env.TOKENGUARD_HOME;
  process.env.TOKENGUARD_HOME = homeDir;

  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.url === '/v1/customer-portal/license-keys/activate') {
        const parsed = JSON.parse(body || '{}');
        if (parsed.organization_id === 'org_polar_123' && parsed.key === 'POLAR-KEY-1') {
          res.end(JSON.stringify({ id: 'act_polar_1', license_key: { status: 'granted', expires_at: null } }));
          return;
        }
      }
      if (req.url === '/v1/customer-portal/license-keys/validate') {
        const parsed = JSON.parse(body || '{}');
        if (parsed.key === 'POLAR-KEY-1' && parsed.activation_id === 'act_polar_1') {
          res.end(JSON.stringify({ id: 'act_polar_1', license_key: { status: 'granted' } }));
          return;
        }
      }
      if (req.url.startsWith('/api/v2/license/verify') && req.headers['product-secret-key'] === 'payhip_sec_123') {
        res.end(JSON.stringify({ data: { enabled: true, license_key: 'PAYHIP-KEY-1' } }));
        return;
      }
      if (req.url === '/v2/licenses/verify') {
        const params = new URLSearchParams(body);
        if (params.get('product_id') === 'gum_prod_1' && params.get('license_key') === 'GUM-VALID') {
          res.end(JSON.stringify({ success: true, uses: 1, purchase: { refunded: false, chargebacked: false } }));
          return;
        }
        if (params.get('license_key') === 'GUM-REFUNDED') {
          res.end(JSON.stringify({ success: true, uses: 1, purchase: { refunded: true, chargebacked: false } }));
          return;
        }
      }
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid license' }));
    });
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const mockBase = `http://127.0.0.1:${server.address().port}`;

  try {
    // 1. Offline Ed25519 TG1 token (zero network calls)
    const token = issueOfflineSignedToken({ id: 'ord_001', tier: 'pro', exp: '2099-01-01T00:00:00Z' }, privateKey);
    assert.equal(verifyOfflineSignedToken(token, publicKey).valid, true);
    assert.equal(verifyOfflineSignedToken(`${token}tampered`, publicKey).valid, false);
    const expiredToken = issueOfflineSignedToken({ id: 'ord_exp', exp: '2020-01-01T00:00:00Z' }, privateKey);
    assert.equal(verifyOfflineSignedToken(expiredToken, publicKey).valid, false);

    await activateLicense(token, { publicKeyPem: publicKey });
    const offlineStatus = await getLicenseStatus({ publicKeyPem: publicKey, forceRemote: true });
    assert.equal(offlineStatus.active, true);
    assert.equal(offlineStatus.provider, 'offline');
    await deactivateLicense();

    // 2. Polar.sh zero-proxy client API
    const polarRec = await activateLicense('POLAR-KEY-1', { provider: 'polar', polarOrgId: 'org_polar_123', polarBase: mockBase });
    assert.equal(polarRec.instanceId, 'act_polar_1');
    const polarStatus = await getLicenseStatus({ provider: 'polar', polarOrgId: 'org_polar_123', polarBase: mockBase, forceRemote: true });
    assert.equal(polarStatus.active, true);
    assert.equal(polarStatus.provider, 'polar');
    await deactivateLicense();

    // 3. Payhip per-product API
    await activateLicense('PAYHIP-KEY-1', { provider: 'payhip', payhipProductKey: 'payhip_sec_123', payhipBase: mockBase });
    const payhipStatus = await getLicenseStatus({ provider: 'payhip', payhipProductKey: 'payhip_sec_123', payhipBase: mockBase, forceRemote: true });
    assert.equal(payhipStatus.active, true);
    assert.equal(payhipStatus.provider, 'payhip');
    await deactivateLicense();

    // 4. Gumroad zero-proxy API (and refunded rejection)
    await activateLicense('GUM-VALID', { provider: 'gumroad', gumroadProductId: 'gum_prod_1', gumroadBase: mockBase });
    const gumStatus = await getLicenseStatus({ provider: 'gumroad', gumroadProductId: 'gum_prod_1', gumroadBase: mockBase, forceRemote: true });
    assert.equal(gumStatus.active, true);
    await assert.rejects(() => activateLicense('GUM-REFUNDED', { provider: 'gumroad', gumroadProductId: 'gum_prod_1', gumroadBase: mockBase }));
  } finally {
    server.close();
    if (prevHome === undefined) delete process.env.TOKENGUARD_HOME;
    else process.env.TOKENGUARD_HOME = prevHome;
    await fs.rm(homeDir, { recursive: true, force: true });
  }
});
