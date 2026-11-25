import fs from 'node:fs/promises';
import path from 'node:path';
import { estimateMultiModelCosts, estimateTokens } from './pricing.js';

const DEFAULT_IGNORE_DIRS = new Set([
  '.git', 'node_modules', '.next', '.nuxt', 'dist', 'build', 'out', 'target',
  'coverage', '.venv', 'venv', '__pycache__', '.pytest_cache', '.mypy_cache',
  '.cache', '.turbo', '.idea', '.vscode', 'vendor', 'storage', '.tokenguard',
]);

const DEFAULT_IGNORE_FILES = new Set([
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb',
  'Cargo.lock', 'poetry.lock', 'Gemfile.lock', 'composer.lock', 'go.sum',
  '.DS_Store', 'Thumbs.db',
]);

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.tiff', '.avif',
  '.mp4', '.mov', '.avi', '.mkv', '.webm', '.mp3', '.wav', '.flac', '.ogg',
  '.pdf', '.zip', '.tar', '.gz', '.7z', '.rar', '.woff', '.woff2', '.ttf',
  '.eot', '.otf', '.exe', '.dll', '.so', '.dylib', '.wasm', '.pyc', '.class',
  '.sqlite', '.db', '.bin', '.dat', '.parquet',
]);

function globToRegex(pattern) {
  const cleaned = pattern.replace(/\/+$/, '');
  const escaped = cleaned
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '%%DOUBLE_STAR%%')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/%%DOUBLE_STAR%%/g, '.*');
  return new RegExp(`(^|/)${escaped}(/|$)`);
}

async function loadGitignoreMatchers(rootDir) {
  try {
    const raw = await fs.readFile(path.join(rootDir, '.gitignore'), 'utf8');
    return raw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#') && !l.startsWith('!'))
      .map(globToRegex);
  } catch {
    return [];
  }
}

function isProbablyBinary(buf) {
  const sampleLen = Math.min(buf.length, 4096);
  for (let i = 0; i < sampleLen; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

/**
 * Scan a directory recursively, estimating token footprint and context hogs.
 */
export async function scanRepo(rootDir = process.cwd(), options = {}) {
  const absRoot = path.resolve(rootDir);
  const maxFileSizeBytes = options.maxFileSizeBytes ?? 2 * 1024 * 1024;
  const maxFiles = options.maxFiles ?? 5000;
  const includeHidden = Boolean(options.includeHidden);
  const topN = options.topN ?? 15;
  const extraIgnore = (options.ignore || []).map(globToRegex);
  const gitignoreMatchers = options.respectGitignore === false ? [] : await loadGitignoreMatchers(absRoot);
  const matchers = [...gitignoreMatchers, ...extraIgnore];

  const files = [];
  let skippedBinary = 0;
  let skippedLarge = 0;
  let skippedIgnored = 0;

  async function walk(currentDir) {
    if (files.length >= maxFiles) return;
    let entries;
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (files.length >= maxFiles) break;
      const fullPath = path.join(currentDir, entry.name);
      const relPath = path.relative(absRoot, fullPath).replace(/\\/g, '/');

      if (!includeHidden && entry.name.startsWith('.') && entry.name !== '.env.example' && entry.name !== '.github') {
        skippedIgnored += 1;
        continue;
      }

      if (entry.isDirectory()) {
        if (DEFAULT_IGNORE_DIRS.has(entry.name) || matchers.some((re) => re.test(relPath))) {
          skippedIgnored += 1;
          continue;
        }
        await walk(fullPath);
        continue;
      }

      if (!entry.isFile()) continue;

      if (DEFAULT_IGNORE_FILES.has(entry.name) || matchers.some((re) => re.test(relPath))) {
        skippedIgnored += 1;
        continue;
      }

      const ext = path.extname(entry.name).toLowerCase();
      if (BINARY_EXTENSIONS.has(ext)) {
        skippedBinary += 1;
        continue;
      }

      let stat;
      try {
        stat = await fs.stat(fullPath);
      } catch {
        continue;
      }

      if (stat.size > maxFileSizeBytes) {
        skippedLarge += 1;
        continue;
      }

      let buf;
      try {
        buf = await fs.readFile(fullPath);
      } catch {
        continue;
      }

      if (isProbablyBinary(buf)) {
        skippedBinary += 1;
        continue;
      }

      const content = buf.toString('utf8');
      const lines = content.length === 0 ? 0 : content.split(/\r?\n/).length;
      const tokens = estimateTokens(content, ext);

      files.push({
        path: relPath,
        absPath: fullPath,
        ext: ext || '(no ext)',
        bytes: stat.size,
        lines,
        tokens,
      });
    }
  }

  await walk(absRoot);

  files.sort((a, b) => b.tokens - a.tokens);
  const totalTokens = files.reduce((sum, f) => sum + f.tokens, 0);
  const totalBytes = files.reduce((sum, f) => sum + f.bytes, 0);
  const totalLines = files.reduce((sum, f) => sum + f.lines, 0);

  // Breakdown by extension
  const byExtMap = new Map();
  for (const f of files) {
    const prev = byExtMap.get(f.ext) || { ext: f.ext, files: 0, tokens: 0 };
    prev.files += 1;
    prev.tokens += f.tokens;
    byExtMap.set(f.ext, prev);
  }
  const byExtension = [...byExtMap.values()].sort((a, b) => b.tokens - a.tokens);

  // Actionable savings hints
  const hints = [];
  const hugeFiles = files.filter((f) => f.tokens >= 8000);
  if (hugeFiles.length > 0) {
    const hugeTokens = hugeFiles.reduce((s, f) => s + f.tokens, 0);
    hints.push(
      `${hugeFiles.length} file(s) exceed 8,000 tokens each (${hugeTokens.toLocaleString()} tokens total, ${Math.round((hugeTokens / Math.max(1, totalTokens)) * 100)}% of repo). Exclude or use --mode skeleton.`,
    );
  }
  const dataFiles = files.filter((f) => ['.json', '.csv', '.svg', '.xml', '.sql'].includes(f.ext) && f.tokens >= 2000);
  if (dataFiles.length > 0) {
    const dataTokens = dataFiles.reduce((s, f) => s + f.tokens, 0);
    hints.push(
      `Large static/data assets (${dataFiles.length} files, ${dataTokens.toLocaleString()} tokens) inflate AI context with low code signal.`,
    );
  }

  return {
    rootDir: absRoot,
    totalFiles: files.length,
    totalBytes,
    totalLines,
    totalTokens,
    skipped: { binary: skippedBinary, large: skippedLarge, ignored: skippedIgnored },
    topFiles: files.slice(0, topN).map(({ absPath: _omit, ...rest }) => rest),
    allFiles: files,
    byExtension: byExtension.slice(0, 12),
    modelCosts: estimateMultiModelCosts(totalTokens, 0),
    hints,
  };
}
