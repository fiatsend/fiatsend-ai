# Fiatsend MCP server

Lets Claude, Cursor, VS Code, Windsurf and any other MCP client talk to the Fiatsend Partner API: check rates and networks, preview and send stablecoin → mobile money payouts, create checkout links, and manage webhooks.

**Sandbox-first.** With an `fs_test_` key everything runs against `sandbox.fiatsend.com`. With an `fs_live_` key, read-only tools and checkout work, but payouts stay blocked until you set `FIATSEND_ALLOW_LIVE_PAYOUTS=true`.

## Tools

| Tool | What it does | Moves money? |
|---|---|---|
| `fiatsend_health` | API status + which environment you're on | No |
| `fiatsend_list_networks` | MTN / Telecel / AirtelTigo status and limits | No |
| `fiatsend_get_limits` | KYC tier limits | No |
| `fiatsend_get_rate` | USDC/USDT → GHS quote | No |
| `fiatsend_quote_payout` | Full preflight: phone, network, quote, limit warnings | No |
| `fiatsend_create_withdrawal` | Send a payout (needs `user_confirmed: true`) | **Yes** |
| `fiatsend_get_withdrawal` | Payout status by `wd_…` | No |
| `fiatsend_list_transactions` | Search payouts (e.g. by `reference_id`) | No |
| `fiatsend_create_checkout_session` | Create a payment link | No (collects) |
| `fiatsend_get_checkout_session` / `fiatsend_list_checkout_sessions` | Check payments | No |
| `fiatsend_create_payment_intent` / `fiatsend_get_payment_intent` / `fiatsend_cancel_payment_intent` | Payment intents (beta): request, check or cancel a customer payment | No (collects); cancel asks first |
| `fiatsend_register_webhook` / `fiatsend_list_webhooks` / `fiatsend_delete_webhook` | Manage withdrawal and payment-intent webhooks | No |
| `fiatsend_verify_webhook_signature` | Local signature debugger | No |

Resource: `fiatsend://docs/llms-full` — the full API reference, so the AI can write integration code accurately.

## Environment variables

| Variable | Required | Default |
|---|---|---|
| `FIATSEND_API_KEY` | ✓ | — (`fs_test_…` or `fs_live_…`) |
| `FIATSEND_ALLOW_LIVE_PAYOUTS` | | `false` |
| `FIATSEND_BASE_URL` | | sandbox for test keys, api for live keys |
| `FIATSEND_CHECKOUT_URL` | | `https://api.fiatsend.com/v1` |

## Install

### Claude Code
```bash
claude mcp add fiatsend --env FIATSEND_API_KEY=fs_test_xxx -- npx -y @fiatsend/mcp
```

### Claude Desktop — `claude_desktop_config.json`
```json
{
  "mcpServers": {
    "fiatsend": {
      "command": "npx",
      "args": ["-y", "@fiatsend/mcp"],
      "env": { "FIATSEND_API_KEY": "fs_test_xxx" }
    }
  }
}
```

### Cursor — `.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global)
```json
{
  "mcpServers": {
    "fiatsend": {
      "command": "npx",
      "args": ["-y", "@fiatsend/mcp"],
      "env": { "FIATSEND_API_KEY": "fs_test_xxx" }
    }
  }
}
```

### VS Code (Copilot agent mode) — `.vscode/mcp.json`
```json
{
  "inputs": [{ "id": "fiatsend-key", "type": "promptString", "description": "Fiatsend API key", "password": true }],
  "servers": {
    "fiatsend": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@fiatsend/mcp"],
      "env": { "FIATSEND_API_KEY": "${input:fiatsend-key}" }
    }
  }
}
```

### Windsurf — `~/.codeium/windsurf/mcp_config.json`
Same `mcpServers` block as Cursor.

## Develop

```bash
npm install
npm run build
npm test                       # 12 tests, no network needed
FIATSEND_API_KEY=fs_test_xxx node test/sandbox.smoke.mjs   # live sandbox check
FIATSEND_API_KEY=fs_test_demo_key_2026 npm run inspect   # click around in MCP Inspector
```

Try in your AI tool: *"Using Fiatsend sandbox, how many cedis would 25 USDC be on MTN, and is MTN up right now?"*
