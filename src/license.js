import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_CHECKOUT_URL = process.env.TOKENGUARD_CHECKOUT_URL
  || 'https://augustfu-droid.github.io/tokenguard-mcp/';

export const DEFAULT_LICENSE_API = process.env.TOKENGUARD_LICENSE_API || '';

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

async function fetchJson(url, fetchOpts = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const res = await fetch(url, { ...fetchOpts, signal: controller.signal });
    const body = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Verify an offline Ed25519 signed token: `TG1.<payload_b64url>.<sig_b64url>`.
 * Enables zero-server, zero-domain Pro licensing across Payhip/WeChat/Alipay/Sponsors.
 */
export function verifyOfflineSignedToken(token, publicKeyPem) {
  const str = String(token || '').trim();
  const parts = str.split('.');
  if (parts.length !== 3 || parts[0] !== 'TG1') {
    return { valid: false, error: 'Malformed TG1 offline token.' };
  }
  const pem = String(publicKeyPem || process.env.TOKENGUARD_PUBLIC_KEY || '').trim();
  if (!pem) {
    return { valid: false, error: 'TOKENGUARD_PUBLIC_KEY is not configured for offline TG1 verification.' };
  }

  try {
    const payloadBuf = Buffer.from(parts[1], 'base64url');
    const sigBuf = Buffer.from(parts[2], 'base64url');
    const verified = crypto.verify(null, Buffer.from(parts[1], 'utf8'), pem, sigBuf);
    if (!verified) return { valid: false, error: 'Invalid offline token signature.' };

    const claims = JSON.parse(payloadBuf.toString('utf8'));
    if (claims.exp) {
      const expMs = Date.parse(claims.exp);
      if (!Number.isNaN(expMs) && Date.now() > expMs) {
        return { valid: false, error: `Offline token expired at ${claims.exp}.` };
      }
    }
    return {
      valid: true,
      id: claims.id || 'tg1-offline',
      tier: claims.tier || 'pro',
      expiresAt: claims.exp || null,
    };
  } catch (err) {
    return { valid: false, error: `Offline token parse error: ${err?.message || err}` };
  }
}

export function issueOfflineSignedToken(claims, privateKeyPem) {
  const payloadB64 = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  const sigB64 = crypto.sign(null, Buffer.from(payloadB64, 'utf8'), privateKeyPem).toString('base64url');
  return `TG1.${payloadB64}.${sigB64}`;
}

function resolveProvider(key, options = {}, stored = null) {
  if (String(key || '').startsWith('TG1.')) return 'offline';
  if (options.provider) return String(options.provider).toLowerCase();
  if (stored?.provider) return String(stored.provider).toLowerCase();
  if (options.polarOrgId || process.env.TOKENGUARD_POLAR_ORG_ID) return 'polar';
  if (options.payhipProductKey || process.env.TOKENGUARD_PAYHIP_PRODUCT_KEY) return 'payhip';
  if (options.gumroadProductId || process.env.TOKENGUARD_GUMROAD_PRODUCT_ID) return 'gumroad';
  if (options.apiBase || process.env.TOKENGUARD_LICENSE_API) return 'creem';
  return 'unconfigured';
}

async function callCreemProxy(endpoint, payload, apiBase) {
  const base = String(apiBase || '').replace(/\/+$/, '');
  if (!base || base.includes('REPLACE_WITH_YOUR_WORKER')) {
    throw new Error(
      'Creem license proxy URL is not configured. Set TOKENGUARD_LICENSE_API or use zero-proxy Polar (TOKENGUARD_POLAR_ORG_ID), Payhip (TOKENGUARD_PAYHIP_PRODUCT_KEY), Gumroad (TOKENGUARD_GUMROAD_PRODUCT_ID), or offline TG1 tokens.',
    );
  }
  return fetchJson(`${base}${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export async function activateLicense(licenseKey, options = {}) {
  const key = String(licenseKey || '').trim();
  if (!key) throw new Error('License key is required.');

  const instanceName = options.instanceName || getMachineFingerprint();
  const provider = resolveProvider(key, options, null);

  if (provider === 'offline') {
    const check = verifyOfflineSignedToken(key, options.publicKeyPem);
    if (!check.valid) throw new Error(check.error);
    const record = {
      key,
      provider: 'offline',
      instanceId: check.id || instanceName,
      instanceName,
      status: 'active',
      activatedAt: new Date().toISOString(),
      lastValidatedAt: new Date().toISOString(),
      expiresAt: check.expiresAt,
    };
    await writeStoredLicense(record);
    return record;
  }

  if (provider === 'polar') {
    const orgId = options.polarOrgId || process.env.TOKENGUARD_POLAR_ORG_ID;
    if (!orgId) throw new Error('TOKENGUARD_POLAR_ORG_ID is required for Polar.sh activation.');
    const polarBase = String(options.polarBase || 'https://api.polar.sh').replace(/\/+$/, '');
    const res = await fetchJson(`${polarBase}/v1/customer-portal/license-keys/activate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key, organization_id: orgId, conditions: { instance: instanceName } }),
    });
    const lkStatus = res.body?.license_key?.status || res.body?.status;
    if (!res.ok || (lkStatus && lkStatus !== 'granted')) {
      throw new Error(res.body?.detail || res.body?.error || `Polar activation failed (HTTP ${res.status}).`);
    }
    const record = {
      key,
      provider: 'polar',
      polarOrgId: orgId,
      polarBase,
      instanceId: res.body?.id || instanceName,
      instanceName,
      status: 'active',
      activatedAt: new Date().toISOString(),
      lastValidatedAt: new Date().toISOString(),
      expiresAt: res.body?.license_key?.expires_at || null,
    };
    await writeStoredLicense(record);
    return record;
  }

  if (provider === 'payhip') {
    const productKey = options.payhipProductKey || process.env.TOKENGUARD_PAYHIP_PRODUCT_KEY;
    if (!productKey) throw new Error('TOKENGUARD_PAYHIP_PRODUCT_KEY is required for Payhip verification.');
    const payhipBase = String(options.payhipBase || 'https://payhip.com').replace(/\/+$/, '');
    const res = await fetchJson(
      `${payhipBase}/api/v2/license/verify?license_key=${encodeURIComponent(key)}`,
      { method: 'GET', headers: { 'product-secret-key': productKey } },
    );
    const enabled = res.body?.data?.enabled ?? res.body?.enabled;
    if (!res.ok || enabled === false) {
      throw new Error(res.body?.message || res.body?.error || `Payhip license check failed (HTTP ${res.status}).`);
    }
    const record = {
      key,
      provider: 'payhip',
      payhipBase,
      instanceId: instanceName,
      instanceName,
      status: 'active',
      activatedAt: new Date().toISOString(),
      lastValidatedAt: new Date().toISOString(),
      expiresAt: null,
    };
    await writeStoredLicense(record);
    return record;
  }

  if (provider === 'gumroad') {
    const productId = options.gumroadProductId || process.env.TOKENGUARD_GUMROAD_PRODUCT_ID;
    if (!productId) throw new Error('TOKENGUARD_GUMROAD_PRODUCT_ID is required for Gumroad verification.');
    const gumroadBase = String(options.gumroadBase || 'https://api.gumroad.com').replace(/\/+$/, '');
    const form = new URLSearchParams({
      product_id: productId,
      license_key: key,
      increment_uses_count: 'true',
    });
    const res = await fetchJson(`${gumroadBase}/v2/licenses/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    if (!res.ok || !res.body?.success || res.body?.purchase?.refunded || res.body?.purchase?.chargebacked) {
      throw new Error(res.body?.message || `Gumroad license verification failed (HTTP ${res.status}).`);
    }
    const record = {
      key,
      provider: 'gumroad',
      gumroadProductId: productId,
      gumroadBase,
      instanceId: instanceName,
      instanceName,
      status: 'active',
      activatedAt: new Date().toISOString(),
      lastValidatedAt: new Date().toISOString(),
      expiresAt: null,
    };
    await writeStoredLicense(record);
    return record;
  }

  if (provider === 'creem') {
    const apiBase = options.apiBase || DEFAULT_LICENSE_API;
    const res = await callCreemProxy('/activate', { key, instance_name: instanceName }, apiBase);
    if (!res.ok || res.body?.valid === false) {
      throw new Error(res.body?.error || `License activation failed (HTTP ${res.status}).`);
    }
    const record = {
      key,
      provider: 'creem',
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

  throw new Error(
    'No license verification provider configured. Pass a TG1.* offline token or set TOKENGUARD_POLAR_ORG_ID / TOKENGUARD_PAYHIP_PRODUCT_KEY / TOKENGUARD_GUMROAD_PRODUCT_ID / TOKENGUARD_LICENSE_API.',
  );
}

export async function deactivateLicense(options = {}) {
  const stored = await readStoredLicense();
  if (!stored) return { deactivated: false, message: 'No active license found on this machine.' };

  if (stored.provider === 'creem' || (!stored.provider && (options.apiBase || DEFAULT_LICENSE_API))) {
    const apiBase = options.apiBase || DEFAULT_LICENSE_API;
    try {
      await callCreemProxy('/deactivate', { key: stored.key, instance_id: stored.instanceId }, apiBase);
    } catch {
      // Still remove local license file even if offline
    }
  }

  await fs.rm(getLicenseFilePath(), { force: true });
  return { deactivated: true, message: 'License deactivated on this machine.' };
}

async function remoteValidate(provider, key, stored, options) {
  if (provider === 'offline') {
    const check = verifyOfflineSignedToken(key, options.publicKeyPem);
    return check.valid
      ? { valid: true, instanceId: check.id, expiresAt: check.expiresAt }
      : { valid: false, error: check.error };
  }

  if (provider === 'polar') {
    const orgId = options.polarOrgId || stored?.polarOrgId || process.env.TOKENGUARD_POLAR_ORG_ID;
    const polarBase = String(options.polarBase || stored?.polarBase || 'https://api.polar.sh').replace(/\/+$/, '');
    const res = await fetchJson(`${polarBase}/v1/customer-portal/license-keys/validate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key, organization_id: orgId, activation_id: stored?.instanceId }),
    });
    const status = res.body?.license_key?.status || res.body?.status;
    if (res.ok && (!status || status === 'granted')) {
      return { valid: true, instanceId: res.body?.id || stored?.instanceId, expiresAt: res.body?.license_key?.expires_at || null };
    }
    return { valid: false, error: res.body?.detail || res.body?.error || 'Polar license inactive.' };
  }

  if (provider === 'payhip') {
    const productKey = options.payhipProductKey || process.env.TOKENGUARD_PAYHIP_PRODUCT_KEY;
    const payhipBase = String(options.payhipBase || stored?.payhipBase || 'https://payhip.com').replace(/\/+$/, '');
    const res = await fetchJson(
      `${payhipBase}/api/v2/license/verify?license_key=${encodeURIComponent(key)}`,
      { method: 'GET', headers: { 'product-secret-key': productKey || '' } },
    );
    const enabled = res.body?.data?.enabled ?? res.body?.enabled;
    return res.ok && enabled !== false
      ? { valid: true, instanceId: stored?.instanceId || getMachineFingerprint(), expiresAt: null }
      : { valid: false, error: res.body?.message || 'Payhip license inactive.' };
  }

  if (provider === 'gumroad') {
    const productId = options.gumroadProductId || stored?.gumroadProductId || process.env.TOKENGUARD_GUMROAD_PRODUCT_ID;
    const gumroadBase = String(options.gumroadBase || stored?.gumroadBase || 'https://api.gumroad.com').replace(/\/+$/, '');
    const form = new URLSearchParams({
      product_id: productId || '',
      license_key: key,
      increment_uses_count: 'false',
    });
    const res = await fetchJson(`${gumroadBase}/v2/licenses/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    if (res.ok && res.body?.success && !res.body?.purchase?.refunded && !res.body?.purchase?.chargebacked) {
      return { valid: true, instanceId: stored?.instanceId || getMachineFingerprint(), expiresAt: null };
    }
    return { valid: false, error: res.body?.message || 'Gumroad license invalid or refunded.' };
  }

  if (provider === 'creem') {
    const apiBase = options.apiBase || DEFAULT_LICENSE_API;
    const instanceId = stored?.instanceId || getMachineFingerprint();
    const res = await callCreemProxy('/validate', { key, instance_id: instanceId }, apiBase);
    if (res.ok && res.body?.valid) {
      return { valid: true, instanceId: res.body.instance_id || instanceId, expiresAt: res.body.expires_at || null };
    }
    return { valid: false, error: res.body?.error || 'License is inactive or invalid.' };
  }

  return { valid: false, error: 'No license verification provider configured.' };
}

/**
 * Verify whether Pro features are unlocked on this machine or via CI env var.
 */
export async function getLicenseStatus(options = {}) {
  const envKey = (process.env.TOKENGUARD_LICENSE_KEY || '').trim();
  const stored = await readStoredLicense();

  if (!stored && !envKey) {
    return { active: false, tier: 'free', reason: 'No Pro license configured.' };
  }

  const key = stored?.key || envKey;
  const provider = resolveProvider(key, options, stored);

  if (provider === 'offline') {
    const check = verifyOfflineSignedToken(key, options.publicKeyPem);
    return check.valid
      ? { active: true, tier: 'pro', provider: 'offline', source: 'ed25519-offline', instanceId: check.id }
      : { active: false, tier: 'free', provider: 'offline', reason: check.error };
  }

  // Within offline grace window and not forcing remote check
  if (stored && !options.forceRemote && stored.lastValidatedAt) {
    const ageMs = Date.now() - new Date(stored.lastValidatedAt).getTime();
    if (ageMs >= 0 && ageMs < OFFLINE_GRACE_MS && stored.status === 'active') {
      return {
        active: true,
        tier: 'pro',
        provider,
        source: 'local-cache',
        instanceId: stored.instanceId,
        lastValidatedAt: stored.lastValidatedAt,
      };
    }
  }

  try {
    const res = await remoteValidate(provider, key, stored, options);
    if (res.valid) {
      const updated = {
        ...stored,
        key,
        provider,
        instanceId: res.instanceId,
        instanceName: stored?.instanceName || getMachineFingerprint(),
        status: 'active',
        activatedAt: stored?.activatedAt || new Date().toISOString(),
        lastValidatedAt: new Date().toISOString(),
        expiresAt: res.expiresAt || null,
      };
      if (stored) await writeStoredLicense(updated);
      return {
        active: true,
        tier: 'pro',
        provider,
        source: 'remote',
        instanceId: updated.instanceId,
        lastValidatedAt: updated.lastValidatedAt,
      };
    }
    return {
      active: false,
      tier: 'free',
      provider,
      reason: res.error || 'License is inactive or invalid.',
    };
  } catch (err) {
    if (stored?.status === 'active' && stored?.lastValidatedAt) {
      const ageMs = Date.now() - new Date(stored.lastValidatedAt).getTime();
      if (ageMs >= 0 && ageMs < OFFLINE_GRACE_MS) {
        return {
          active: true,
          tier: 'pro',
          provider,
          source: 'offline-grace',
          instanceId: stored.instanceId,
        };
      }
    }
    return {
      active: false,
      tier: 'free',
      provider,
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
