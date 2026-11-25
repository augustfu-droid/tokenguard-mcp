import fs from 'node:fs/promises';
import { estimateTokens } from './pricing.js';
import { scanRepo } from './scanner.js';

/**
 * Pro Feature: Extract high-signal code skeleton (imports, exports, types,
 * interfaces, classes, and function signatures) to achieve 60-85% token compression.
 */
export function compressToSkeleton(content, ext = '') {
  const lower = String(ext).toLowerCase();
  const lines = String(content).split(/\r?\n/);

  if (['.md', '.txt'].includes(lower)) {
    // Keep headings, bullet points, and first 35 lines
    const kept = [];
    for (let i = 0; i < lines.length; i++) {
      if (i < 20 || /^#{1,4}\s/.test(lines[i]) || /^```/.test(lines[i])) {
        kept.push(lines[i]);
      }
    }
    return kept.join('\n').trim();
  }

  if (['.json', '.yaml', '.yml', '.toml'].includes(lower)) {
    if (lines.length <= 60) return content.trim();
    return [...lines.slice(0, 45), `... (${lines.length - 45} lines omitted) ...`].join('\n');
  }

  if (lower === '.py') {
    const out = [];
    let inDocstring = false;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (/^(import |from |class |def |async def |@)/.test(trimmed)) {
        out.push(line);
        continue;
      }
      if (/^[A-Z][A-Z0-9_]{2,}\s*=/.test(trimmed)) {
        out.push(line);
        continue;
      }
      if (trimmed.startsWith('"""') || trimmed.startsWith("'''")) {
        out.push(line);
        if ((trimmed.match(/"""|'''/g) || []).length === 1) {
          inDocstring = !inDocstring;
        }
        continue;
      }
      if (inDocstring) out.push(line);
    }
    return out.length > 0 ? out.join('\n') : lines.slice(0, 40).join('\n');
  }

  if (['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.go', '.rs', '.java', '.kt', '.cs'].includes(lower)) {
    const out = [];
    const sigPattern = /^\s*(export\s+|import\s+|pub\s+|public\s+|private\s+|protected\s+|async\s+|function\s+|class\s+|interface\s+|type\s+|enum\s+|struct\s+|trait\s+|impl\s+|func\s+|fn\s+|const\s+[A-Z0-9_]+\s*=|const\s+\w+\s*=\s*(?:async\s+)?\(|\/\*\*|\*\s|\*\/)/;
    for (const line of lines) {
      if (sigPattern.test(line)) {
        out.push(line.replace(/\{\s*$/, '{ /* ... */ }'));
      }
    }
    return out.length > 0 ? out.join('\n') : lines.slice(0, 40).join('\n');
  }

  return lines.length <= 60 ? content.trim() : [...lines.slice(0, 50), `... (${lines.length - 50} lines omitted) ...`].join('\n');
}

function filePriorityScore(relPath, ext, tokens) {
  const lower = relPath.toLowerCase();
  let score = 50;
  if (/^readme/i.test(lower)) score += 60;
  if (/^(package\.json|pyproject\.toml|cargo\.toml|go\.mod|dockerfile|makefile)$/i.test(lower)) score += 50;
  if (/(^|\/)(index|main|app|server|cli|mod|lib)\.[a-z]+$/i.test(lower)) score += 35;
  if (lower.startsWith('src/') || lower.startsWith('lib/') || lower.startsWith('app/')) score += 25;
  if (/(^|\/)(test|tests|__tests__|spec|fixtures|mocks)\//i.test(lower)) score -= 25;
  if (['.json', '.csv', '.svg', '.xml', '.sql'].includes(ext)) score -= 20;
  if (tokens > 10000) score -= 25;
  return score;
}

/**
 * Pack repository context strictly within a token budget.
 */
export async function packRepoContext(rootDir = process.cwd(), options = {}) {
  const budget = Math.max(500, Number(options.budget) || 32000);
  const mode = options.mode === 'skeleton' ? 'skeleton' : 'full';
  const format = options.format === 'md' ? 'md' : 'xml';

  const scan = await scanRepo(rootDir, options);
  const candidates = scan.allFiles
    .map((f) => ({ ...f, priority: filePriorityScore(f.path, f.ext, f.tokens) }))
    .sort((a, b) => b.priority - a.priority || a.tokens - b.tokens);

  const packed = [];
  const omitted = [];
  let usedTokens = 120; // header/wrapper overhead
  let originalTokensOfPacked = 0;

  for (const file of candidates) {
    let raw;
    try {
      raw = await fs.readFile(file.absPath, 'utf8');
    } catch {
      continue;
    }

    const body = mode === 'skeleton' ? compressToSkeleton(raw, file.ext) : raw;
    const bodyTokens = estimateTokens(body, file.ext) + 20;

    if (usedTokens + bodyTokens <= budget) {
      packed.push({
        path: file.path,
        ext: file.ext,
        originalTokens: file.tokens,
        packedTokens: bodyTokens,
        body,
      });
      usedTokens += bodyTokens;
      originalTokensOfPacked += file.tokens;
    } else {
      omitted.push({ path: file.path, tokens: file.tokens });
    }
  }

  let output = '';
  if (format === 'xml') {
    const fileBlocks = packed.map((f) => `<file path="${f.path}" tokens="${f.packedTokens}">\n${f.body}\n</file>`);
    output = [
      `<repository mode="${mode}" budget="${budget}" used_tokens="${usedTokens}" files_included="${packed.length}" files_omitted="${omitted.length}">`,
      ...fileBlocks,
      '</repository>',
    ].join('\n');
  } else {
    const fileBlocks = packed.map((f) => {
      const lang = f.ext.replace(/^\./, '').replace('(no ext)', '');
      return `## ${f.path} (${f.packedTokens} tokens)\n\n\`\`\`${lang}\n${f.body}\n\`\`\``;
    });
    output = [
      `# Repository Context (${mode} mode — ${usedTokens.toLocaleString()} / ${budget.toLocaleString()} tokens)`,
      '',
      ...fileBlocks,
    ].join('\n\n');
  }

  const compressionPct = originalTokensOfPacked > 0
    ? Math.max(0, Math.round((1 - usedTokens / originalTokensOfPacked) * 100))
    : 0;

  return {
    mode,
    format,
    budget,
    usedTokens,
    originalTokensOfPacked,
    compressionPct,
    filesIncluded: packed.length,
    filesOmitted: omitted.length,
    includedPaths: packed.map((f) => f.path),
    omittedPaths: omitted.slice(0, 20),
    output,
  };
}
