import fs from 'node:fs/promises';
import path from 'node:path';
import { estimateCostUsd } from './pricing.js';

function extractUsageRecord(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const usage = obj.usage || obj.token_usage || obj;
  const inputTokens = Number(usage.input_tokens ?? usage.prompt_tokens ?? usage.inputTokens ?? 0);
  const outputTokens = Number(usage.output_tokens ?? usage.completion_tokens ?? usage.outputTokens ?? 0);
  if (inputTokens <= 0 && outputTokens <= 0) return null;

  const model = obj.model || usage.model || 'claude-sonnet-4';
  const rawTs = obj.timestamp || obj.created_at || obj.date || '';
  const day = typeof rawTs === 'string' && /^\d{4}-\d{2}-\d{2}/.test(rawTs) ? rawTs.slice(0, 10) : 'unknown';
  const session = obj.session_id || obj.session || obj.project || 'default';
  const cost = estimateCostUsd(inputTokens, outputTokens, model);

  return {
    day,
    session: String(session),
    model: cost.model,
    inputTokens,
    outputTokens,
    totalCostUsd: cost.totalCostUsd,
  };
}

async function collectJsonlFiles(targetPath) {
  const stat = await fs.stat(targetPath);
  if (stat.isFile()) return [targetPath];
  const entries = await fs.readdir(targetPath, { withFileTypes: true });
  const files = [];
  for (const e of entries) {
    const full = path.join(targetPath, e.name);
    if (e.isFile() && /\.(jsonl|ndjson|json)$/i.test(e.name)) {
      files.push(full);
    }
  }
  return files;
}

/**
 * Pro Feature: Audit local AI usage JSONL/JSON logs to track spend by model, day, and session.
 */
export async function auditSpendLogs(targetPath) {
  const absTarget = path.resolve(targetPath);
  const files = await collectJsonlFiles(absTarget);

  const byModel = new Map();
  const byDay = new Map();
  const bySession = new Map();
  let events = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCostUsd = 0;

  for (const file of files) {
    let raw;
    try {
      raw = await fs.readFile(file, 'utf8');
    } catch {
      continue;
    }

    const candidates = [];
    if (file.endsWith('.json')) {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) candidates.push(...parsed);
        else candidates.push(parsed);
      } catch {
        continue;
      }
    } else {
      for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          candidates.push(JSON.parse(trimmed));
        } catch {
          // skip malformed line
        }
      }
    }

    for (const item of candidates) {
      const rec = extractUsageRecord(item);
      if (!rec) continue;
      events += 1;
      totalInputTokens += rec.inputTokens;
      totalOutputTokens += rec.outputTokens;
      totalCostUsd += rec.totalCostUsd;

      const m = byModel.get(rec.model) || { model: rec.model, events: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
      m.events += 1;
      m.inputTokens += rec.inputTokens;
      m.outputTokens += rec.outputTokens;
      m.costUsd = Number((m.costUsd + rec.totalCostUsd).toFixed(6));
      byModel.set(rec.model, m);

      const d = byDay.get(rec.day) || { day: rec.day, events: 0, costUsd: 0 };
      d.events += 1;
      d.costUsd = Number((d.costUsd + rec.totalCostUsd).toFixed(6));
      byDay.set(rec.day, d);

      const s = bySession.get(rec.session) || { session: rec.session, events: 0, costUsd: 0 };
      s.events += 1;
      s.costUsd = Number((s.costUsd + rec.totalCostUsd).toFixed(6));
      bySession.set(rec.session, s);
    }
  }

  return {
    target: absTarget,
    filesScanned: files.length,
    eventsParsed: events,
    totalInputTokens,
    totalOutputTokens,
    totalCostUsd: Number(totalCostUsd.toFixed(4)),
    byModel: [...byModel.values()].sort((a, b) => b.costUsd - a.costUsd),
    byDay: [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)),
    topSessions: [...bySession.values()].sort((a, b) => b.costUsd - a.costUsd).slice(0, 10),
  };
}
