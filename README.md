# TokenGuard (`tokenguard-mcp`)

> **Stop burning AI coding tokens blindly.** Zero-dependency CLI & MCP Server that measures repo token costs across Claude / Gemini / GPT / DeepSeek, packs budget-capped context bundles, catches accidental secret leaks, and audits local AI spend.

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)
[![Node.js >= 20](https://img.shields.io/badge/Node.js-%3E%3D20-blue.svg)](https://nodejs.org)
[![TokenGuard MCP server – quality and maintenance score on Glama](https://glama.ai/mcp/servers/augustfu-droid/tokenguard-mcp/badges/score.svg)](https://glama.ai/mcp/servers/augustfu-droid/tokenguard-mcp)

---

## Quick Start (Zero Dependencies)

```bash
# 1. Scan any repo for token count, context hogs, and multi-model USD cost
npx tokenguard-mcp scan .

# 2. Pack highest-signal files strictly inside a 24k token budget
npx tokenguard-mcp pack . --budget 24000 --format xml --out context.xml

# 3. Check the cost of your git diff before sending it to an AI reviewer
npx tokenguard-mcp diff --base main
```

### VS Code / Cursor / Windsurf Extension (Free `.vsix`)

Prefer live token & USD estimates in your editor status bar plus real-time secret-leak squiggles? Install from the dedicated open-source extension repository ([`augustfu-droid/vscode-tokenguard`](https://github.com/augustfu-droid/vscode-tokenguard)):

```bash
curl -LO https://github.com/augustfu-droid/vscode-tokenguard/releases/download/v1.0.0/tokenguard-vscode-1.0.0.vsix
code --install-extension tokenguard-vscode-1.0.0.vsix
# or in Cursor / Windsurf:
cursor --install-extension tokenguard-vscode-1.0.0.vsix
```

---

## Use as an MCP Server (Claude Code / Cursor / Windsurf / Antigravity)

Add to your MCP config (`claude_desktop_config.json`, `.cursor/mcp.json`, or Claude Code MCP settings):

```json
{
  "mcpServers": {
    "tokenguard": {
      "command": "npx",
      "args": ["-y", "tokenguard-mcp", "mcp"]
    }
  }
}
```

Exposed MCP tools:
- `scan_repo_tokens` — Inspect token counts, context hogs, and multi-model cost before reading giant files.
- `pack_repo_context` — Pack high-signal files within an exact token budget (`full` free, `skeleton` Pro).
- `estimate_prompt_cost` — Estimate input + output USD cost across 10 major 2026 models.
- `check_repo_budget_and_secrets` *(Pro)* — Enforce token/cost ceilings and catch leaked keys.

---

## Free (MIT Open-Source) vs. Pro ($19 One-Time, No Subscription)

| Feature | Free (MIT) | Pro ($19 One-Time) |
| :--- | :---: | :---: |
| Repo Token Scanner & Context Hog Finder (`scan`) | ✅ | ✅ |
| Multi-Model 2026 Cost Estimator (`scan`, `diff`, `pricing`) | ✅ | ✅ |
| Budget-Bounded Context Packer (`pack --mode full`) | ✅ | ✅ |
| Stdio MCP Server (`mcp`) for Claude / Cursor / Windsurf | ✅ | ✅ |
| **Skeleton Compression (`pack --mode skeleton`, 60–85% token savings)** | — | ✅ |
| **CI Budget Gate + Secret Leak Scanner (`check --format sarif`)** | — | ✅ |
| **Local AI Spend Ledger & Session Audit (`audit`)** | — | ✅ |
| Lifetime updates + CI env var support (`TOKENGUARD_LICENSE_KEY`) | — | ✅ |

👉 **Get TokenGuard Pro ($19 one-time):** https://www.creem.io/product/prod_T2ytVQvgiLAWMMxLKnTXU

```bash
tokenguard activate <YOUR_CREEM_LICENSE_KEY>
```

---

## Privacy & Security

- **100% local execution**: your source code, git diffs, and session logs never leave your machine.
- Secret scan results automatically redact detected keys (`AKIAIO...MPLE`) so secrets are never echoed into CI logs.
- Zero external runtime npm dependencies.
