import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_CHECKOUT_URL = process.env.TOKENGUARD_CHECKOUT_URL
  || 'https://www.creem.io/product/prod_T2ytVQvgiLAWMMxLKnTXU';

export const DEFAULT_LICENSE_API = process.env.TOKENGUARD_LICENSE_API
  || 'https://tokenguard-license.REPLACE_WITH_YOUR_WORKER.workers.dev';

const OFFLINE_GRACE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function getConfigDir() {
  if (process.env.TOKENGUARD_HOME) return path.resolve(process.env.TOKENGUARD_HOME);
  return path.join(os.homedir(), '.tokenguard');
}

function getLicenseFilePath() {
  return path.join(getConfigDir(), 'license.json');
}

function getMachineFingerprint() {
  const raw = `${os.hostname()}|${os.platform()}|${os.arch()}|${os.userInfo().username}`;
  return `tg-${crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16)}`;
}

async function readStoredLicense() {
  try {
    const raw = await fs.readFile(getLicenseFilePath(), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function writeStoredLicense(data) {
  await fs.mkdir(getConfigDir(), { recursive: true });
  await fs.writeFile(getLicenseFilePath(), JSON.stringify(data, null, 2), 'utf8');
}

async function callLicenseApi(endpoint, payload, apiBase = DEFAULT_LICENSE_API) {
  const base = String(apiBase).replace(/\/+$/, '');
  if (base.includes('REPLACE_WITH_YOUR_WORKER')) {
    throw new Error(
      'License verification API is not configured yet. Deploy license-proxy/ to Cloudflare Workers and set TOKENGUARD_LICENSE_API.',
    );
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const res = await fetch(`${base}${endpoint}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const body = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

export async function activateLicense(licenseKey, options = {}) {
  const key = String(licenseKey || '').trim();
  if (!key) throw new Error('License key is required.');

  const instanceName = options.instanceName || getMachineFingerprint();
  const apiBase = options.apiBase || DEFAULT_LICENSE_API;

  const res = await callLicenseApi('/activate', { key, instance_name: instanceName }, apiBase);
  if (!res.ok || res.body?.valid === false) {
    throw new Error(res.body?.error || `License activation failed (HTTP ${res.status}).`);
  }

  const record = {
    key,
    instanceId: res.body.instance_id || res.body.instance?.id || instanceName,
    instanceName,
    status: res.body.status || 'active',
    activatedAt: new Date().toISOString(),
    lastValidatedAt: new Date().toISOString(),
    expiresAt: res.body.expires_at || null,
  };
  await writeStoredLicense(record);
  return record;
}

export async function deactivateLicense(options = {}) {
  const stored = await readStoredLicense();
  if (!stored) return { deactivated: false, message: 'No active license found on this machine.' };

  const apiBase = options.apiBase || DEFAULT_LICENSE_API;
  try {
    await callLicenseApi('/deactivate', { key: stored.key, instance_id: stored.instanceId }, apiBase);
  } catch {
    // Still remove local license file even if offline
  }

  await fs.rm(getLicenseFilePath(), { force: true });
  return { deactivated: true, message: 'License deactivated on this machine.' };
}

/**
 * Verify whether Pro features are unlocked on this machine or via CI env var.
 */
export async function getLicenseStatus(options = {}) {
  const apiBase = options.apiBase || DEFAULT_LICENSE_API;
  const envKey = (process.env.TOKENGUARD_LICENSE_KEY || '').trim();
  const stored = await readStoredLicense();

  if (!stored && !envKey) {
    return { active: false, tier: 'free', reason: 'No Pro license configured.' };
  }

  const key = stored?.key || envKey;
  const instanceId = stored?.instanceId || getMachineFingerprint();

  // Within offline grace window and not forcing remote check
  if (stored && !options.forceRemote && stored.lastValidatedAt) {
    const ageMs = Date.now() - new Date(stored.lastValidatedAt).getTime();
    if (ageMs >= 0 && ageMs < OFFLINE_GRACE_MS && stored.status === 'active') {
      return {
        active: true,
        tier: 'pro',
        source: 'local-cache',
        instanceId: stored.instanceId,
        lastValidatedAt: stored.lastValidatedAt,
      };
    }
  }

  // Remote validation via proxy
  try {
    const res = await callLicenseApi('/validate', { key, instance_id: instanceId }, apiBase);
    if (res.ok && res.body?.valid) {
      const updated = {
        key,
        instanceId: res.body.instance_id || instanceId,
        instanceName: stored?.instanceName || getMachineFingerprint(),
        status: 'active',
        activatedAt: stored?.activatedAt || new Date().toISOString(),
        lastValidatedAt: new Date().toISOString(),
        expiresAt: res.body.expires_at || null,
      };
      if (stored) await writeStoredLicense(updated);
      return {
        active: true,
        tier: 'pro',
        source: 'remote',
        instanceId: updated.instanceId,
        lastValidatedAt: updated.lastValidatedAt,
      };
    }
    return {
      active: false,
      tier: 'free',
      reason: res.body?.error || 'License is inactive or invalid.',
    };
  } catch (err) {
    // Offline fallback if previously validated within grace period
    if (stored?.status === 'active' && stored?.lastValidatedAt) {
      const ageMs = Date.now() - new Date(stored.lastValidatedAt).getTime();
      if (ageMs >= 0 && ageMs < OFFLINE_GRACE_MS) {
        return {
          active: true,
          tier: 'pro',
          source: 'offline-grace',
          instanceId: stored.instanceId,
        };
      }
    }
    return {
      active: false,
      tier: 'free',
      reason: String(err?.message || err),
    };
  }
}

export function formatUpgradeBanner(featureName) {
  return [
    `[TokenGuard Pro] "${featureName}" requires a Pro license ($19 one-time, no subscription).`,
    `  1. Get your license key: ${DEFAULT_CHECKOUT_URL}`,
    `  2. Activate locally:     tokenguard activate <YOUR_LICENSE_KEY>`,
    `  (All core scan, pack, diff, pricing, and MCP tools remain 100% free & MIT open-source.)`,
  ].join('\n');
}
