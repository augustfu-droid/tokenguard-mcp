# TokenGuard (`tokenguard-mcp`) — Zero-Cost Organic Launch Copy

Ready to post once `https://github.com/augustfu-droid/tokenguard-mcp` and npm `tokenguard-mcp` are published.
Pro Checkout Link: `https://www.creem.io/product/prod_T2ytVQvgiLAWMMxLKnTXU`

---

## 1. Hacker News (`Show HN`)

**Title:**
`Show HN: TokenGuard – Zero-dependency CLI & MCP server to budget AI coding tokens`

**Body:**
Hi HN,

I kept burning through Claude Code / Cursor token budgets because giant JSON fixtures, generated files, and full function bodies silently ate 80% of my context window.

So I built TokenGuard (`npx tokenguard-mcp`), a zero-dependency Node.js CLI and stdio MCP server that runs 100% locally:

- `tokenguard scan .` — `.gitignore`-aware token scanner showing context hogs and single-pass cost across 10 current LLMs (Claude, Gemini, GPT, DeepSeek).
- `tokenguard pack . --budget 24000` — packs highest-signal files into XML/Markdown strictly capped to your token budget.
- `tokenguard diff --base main` — checks the exact dollar cost of a git diff before sending it to an AI reviewer.
- `tokenguard mcp` — exposes these directly to Claude Code / Cursor / Windsurf over stdio JSON-RPC 2.0.

The core CLI + MCP server is MIT open-source and free forever. There is an optional $19 one-time Pro license (no subscription) that unlocks AST-style skeleton compression (`--mode skeleton`, ~70% token reduction), a CI budget/secret gate with SARIF 2.1.0 output, and local JSONL spend auditing.

Repo: https://github.com/augustfu-droid/tokenguard-mcp
Docs & ROI Calculator: https://augustfu-droid.github.io/tokenguard-mcp/

Would love feedback on the token estimation heuristics and what other local AI spend log formats you'd like parsed!

---

## 2. Reddit (`r/ClaudeAI`, `r/cursor`, `r/LocalLLaMA`)

**Title:**
`I built a zero-dependency CLI + MCP server to see which files are burning your AI coding tokens (and pack repos inside a strict budget)`

**Body:**
If you've ever watched a single coding session burn way more tokens than expected, it's usually 3–5 bloated files quietly eating half your context window.

I built **TokenGuard** (`npx tokenguard-mcp`), 100% local, zero runtime npm dependencies:
- `npx tokenguard-mcp scan .` → ranks your biggest context hogs + shows cost across Claude Sonnet/Opus, Gemini 2.5, GPT-4.1, and DeepSeek
- `npx tokenguard-mcp pack . --budget 24000` → generates a clean XML/MD context bundle guaranteed to stay under budget
- `npx tokenguard-mcp mcp` → drop straight into Claude Code / Cursor `mcp.json` so your agent checks budgets *before* reading huge files

Core CLI & MCP server is MIT open-source: https://github.com/augustfu-droid/tokenguard-mcp
(Optional $19 one-time Pro adds skeleton compression, CI secret/budget SARIF gate, and local JSONL spend logs.)

---

## 3. MCP Directory Submission Metadata (`mcp-registry` / Smithery / Glama / PulseMCP)

- **Name:** `tokenguard-mcp`
- **Category:** Developer Tools / Cost & Context Optimization
- **Transport:** `stdio`
- **Install command:** `npx -y tokenguard-mcp mcp`
- **Tools:** `scan_repo_tokens`, `pack_repo_context`, `estimate_prompt_cost`, `check_repo_budget_and_secrets`
- **Privacy:** 100% local filesystem processing; no code uploaded to third-party servers.
