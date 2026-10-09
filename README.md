# Fiatsend AI Kit

Everything a developer needs to integrate Fiatsend using Claude, Cursor, Copilot, Windsurf or any AI coding tool.

Fiatsend sends USDC/USDT to MTN MoMo, Telecel Cash and AirtelTigo Money wallets in seconds, and lets you take payments in cedis or USDC with hosted checkout. API docs: https://developer.fiatsend.com

## What's inside

| Path | What it is | Works with |
|---|---|---|
| `skills/fiatsend-api/` | Agent Skill: rules, endpoint map, webhook handlers, examples | Claude Code, Claude.ai, Claude API, any skill-aware agent |
| `.claude-plugin/` + `.mcp.json` | One-step Claude Code plugin (skill + MCP server) | Claude Code |
| `mcp-server/` | MCP server (`@fiatsend/mcp`) — live tools for rates, payouts, checkout, webhooks | Claude Code/Desktop, Cursor, VS Code, Windsurf, any MCP client |
| `.cursor/rules/fiatsend.mdc` | Cursor project rule | Cursor |
| `AGENTS.md` | Plain-markdown rules most agents read automatically | Codex, Copilot, Cursor, Windsurf, Zed, Jules… |
| `llms/llms.txt`, `llms/llms-full.txt` | AI-readable docs to host on developer.fiatsend.com | Any LLM / docs crawler |

## Quick start (2 minutes)

1. Get a sandbox key at https://console.fiatsend.com → Developers → API Keys (`fs_test_…`).
2. Pick your tool:

**Claude Code** (skill + MCP in one go)
```bash
/plugin marketplace add fiatsend/fiatsend-ai
/plugin install fiatsend@fiatsend
```
Or just the skill: copy `skills/fiatsend-api/` into `.claude/skills/` in your repo (or `~/.claude/skills/`).

**Cursor** — copy `.cursor/rules/fiatsend.mdc` into your project, and add the MCP server (see `mcp-server/README.md`).

**Anything else** — copy `AGENTS.md` into your repo root and add the MCP server to your tool's MCP config.

3. Ask your AI: *"Add a Fiatsend payout endpoint to this app, with webhook handling, using the sandbox."*

## Safety defaults

- Sandbox unless you give a live key.
- The MCP server refuses live payouts unless `FIATSEND_ALLOW_LIVE_PAYOUTS=true`, and every payout call needs `user_confirmed: true`.
- Keys are read from env vars; nothing is logged or stored.

Support: partners@fiatsend.com
