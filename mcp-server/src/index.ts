#!/usr/bin/env node
// Fiatsend MCP server — exposes the Fiatsend Partner API as tools for Claude, Cursor and other MCP clients.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { FiatsendClient, FiatsendError, loadConfig, normaliseGhanaPhone, verifySignature, type Config } from "./client.js";

const VERSION = "0.1.0";

const HINTS: Record<string, string> = {
  UNAUTHORIZED: "Check FIATSEND_API_KEY. Sandbox keys (fs_test_) only work on the sandbox host.",
  INVALID_PHONE: "Use a Ghana number in E.164 form, e.g. +233241234567.",
  INVALID_NETWORK: "mobile_network must be MTN, TELECEL or AIRTELTIGO.",
  BELOW_MINIMUM: "Call fiatsend_list_networks for the network's min_amount.",
  ABOVE_MAXIMUM: "Call fiatsend_list_networks / fiatsend_get_limits for the maximum.",
  REFERENCE_IN_USE: "Use a new, unique reference_id for this payout.",
  INSUFFICIENT_BALANCE: "Fund the business balance in the Fiatsend console, then retry.",
  PAYOUTS_UNAVAILABLE: "Payouts are temporarily unavailable and nothing was charged; retry later.",
  RATE_EXPIRED: "Get a fresh quote with fiatsend_get_rate, then retry.",
  RATE_LIMITED: "Too many requests — wait and retry with the same reference_id.",
  rate_limited: "Too many requests — wait and retry.",
  NETWORK_DOWN: "The mobile money network is unavailable — retry later with the same reference_id.",
  INSUFFICIENT_LIQUIDITY: "Retry later with the same reference_id, or contact partners@fiatsend.com.",
  account_not_active: "Live checkout needs an activated account. Use an fs_test_ key until you go live.",
  account_not_ready: "The business can't take this payment yet (e.g. no Stellar wallet connected for fiatsend checkout).",
};

let cached: { cfg: Config; client: FiatsendClient } | undefined;
function api() {
  if (!cached) {
    const cfg = loadConfig();
    cached = { cfg, client: new FiatsendClient(cfg) };
  }
  return cached;
}

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

const ok = (data: unknown): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });

async function run(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return ok(await fn());
  } catch (e) {
    if (e instanceof FiatsendError) {
      return {
        isError: true,
        content: [{ type: "text", text: JSON.stringify({
          error: e.code, http_status: e.status, message: e.message,
          retryable: e.retryable, hint: HINTS[e.code],
        }, null, 2) }],
      };
    }
    return { isError: true, content: [{ type: "text", text: `Error: ${(e as Error).message}` }] };
  }
}

const Amount = z.string().regex(/^\d+(\.\d{1,2})?$/, 'Decimal string with up to 2 places, e.g. "50.00"');
const Network = z.enum(["MTN", "TELECEL", "AIRTELTIGO"]);
const Stablecoin = z.enum(["USDC", "USDT"]);

const server = new McpServer(
  { name: "fiatsend", version: VERSION },
  {
    instructions:
      "Fiatsend Partner API: stablecoin (USDC/USDT) to Ghana mobile money payouts and hosted checkout. " +
      "Always call fiatsend_quote_payout and show the user the amount, recipient phone, network and GHS total before calling fiatsend_create_withdrawal. " +
      "Use a stable reference_id per payout and reuse it on retry. Payouts with a live key are blocked unless FIATSEND_ALLOW_LIVE_PAYOUTS=true. " +
      "Read the fiatsend://docs/llms-full resource for the full API reference when writing integration code.",
  },
);

// ── Read-only ─────────────────────────────────────────────────────────────

server.registerTool("fiatsend_health", {
  title: "Fiatsend health",
  description: "Check Fiatsend API status, version and which environment (sandbox/live) this server is pointed at.",
  inputSchema: {},
  annotations: { readOnlyHint: true, openWorldHint: true },
}, () => run(async () => {
  const { client, cfg } = api();
  const health = await client.request("GET", "/health", { auth: false });
  return { key_mode: cfg.mode, base_url: cfg.baseUrl, live_payouts_enabled: cfg.allowLivePayouts, health };
}));

server.registerTool("fiatsend_list_networks", {
  title: "List mobile money networks",
  description: "List supported mobile money networks (MTN, TELECEL, AIRTELTIGO) with operational status and min/max amounts.",
  inputSchema: {},
  annotations: { readOnlyHint: true, openWorldHint: true },
}, () => run(() => api().client.request("GET", "/supported-networks")));

server.registerTool("fiatsend_get_limits", {
  title: "Get KYC tier limits",
  description: "Daily, monthly and per-transaction limits for each KYC tier (basic, standard, enterprise).",
  inputSchema: {},
  annotations: { readOnlyHint: true, openWorldHint: true },
}, () => run(() => api().client.request("GET", "/limits")));

server.registerTool("fiatsend_get_rate", {
  title: "Get FX rate",
  description: "Real-time quote for converting USDC/USDT to GHS. The rate is guaranteed until valid_until.",
  inputSchema: { from_currency: Stablecoin.default("USDC"), amount: Amount.describe("Amount in the stablecoin") },
  annotations: { readOnlyHint: true, openWorldHint: true },
}, ({ from_currency, amount }) => run(() =>
  api().client.request("GET", "/rates", { query: { from_currency, to_currency: "GHS", amount } })));

server.registerTool("fiatsend_quote_payout", {
  title: "Preview a payout",
  description:
    "Validate a payout before sending it: normalises the phone number, checks the network is operational, gets a live FX quote, " +
    "and flags amounts outside the network's limits. Sends no money. Call this and show the result to the user before fiatsend_create_withdrawal.",
  inputSchema: {
    amount: Amount,
    currency: Stablecoin.default("USDC"),
    recipient_phone: z.string().describe("Ghana mobile number, any common format"),
    mobile_network: Network,
  },
  annotations: { readOnlyHint: true, openWorldHint: true },
}, (a) => run(async () => {
  const { client, cfg } = api();
  const phone = normaliseGhanaPhone(a.recipient_phone);
  const [nets, rate] = await Promise.all([
    client.request("GET", "/supported-networks"),
    client.request("GET", "/rates", { query: { from_currency: a.currency, to_currency: "GHS", amount: a.amount } }),
  ]);
  const net = (nets?.data ?? []).find((n: any) => n.network_id === a.mobile_network);
  const warnings: string[] = [];
  if (!net) warnings.push(`${a.mobile_network} is not in the supported networks list.`);
  else {
    if (net.status !== "operational") warnings.push(`${net.name} status is "${net.status}".`);
    const ghs = Number(rate?.data?.total_ghs);
    if (Number.isFinite(ghs)) {
      if (net.min_amount && ghs < Number(net.min_amount)) warnings.push(`GHS ${ghs} is below the ${net.name} minimum of ${net.min_amount}.`);
      if (net.max_amount && ghs > Number(net.max_amount)) warnings.push(`GHS ${ghs} is above the ${net.name} maximum of ${net.max_amount}.`);
    }
  }
  if (cfg.mode === "live" && !cfg.allowLivePayouts) warnings.push("Live key: fiatsend_create_withdrawal is disabled until FIATSEND_ALLOW_LIVE_PAYOUTS=true.");
  return {
    environment: cfg.mode === "live" ? "LIVE — real money" : "sandbox",
    payout: { amount: a.amount, currency: a.currency, recipient_phone: phone, mobile_network: a.mobile_network },
    quote: rate?.data,
    network: net,
    ready: warnings.length === 0,
    warnings,
  };
}));

server.registerTool("fiatsend_get_withdrawal", {
  title: "Get withdrawal",
  description: "Get the status and details of a withdrawal by withdrawal_id (wd_…): status, GHS amount, on-chain hash, mobile money reference, failure_reason.",
  inputSchema: { withdrawal_id: z.string().min(1) },
  annotations: { readOnlyHint: true, openWorldHint: true },
}, ({ withdrawal_id }) => run(() => api().client.request("GET", `/withdrawals/${encodeURIComponent(withdrawal_id)}`)));

server.registerTool("fiatsend_list_transactions", {
  title: "List transactions",
  description: "List withdrawals with optional filters (status, reference_id, from_date, to_date). To recover from a timeout, re-send fiatsend_create_withdrawal with the same reference_id instead: it returns the existing payout.",
  inputSchema: {
    status: z.enum(["pending", "processing", "completed", "failed"]).optional(),
    reference_id: z.string().optional(),
    from_date: z.string().optional().describe("ISO 8601"),
    to_date: z.string().optional().describe("ISO 8601"),
    page: z.number().int().min(1).optional(),
    per_page: z.number().int().min(1).max(100).optional(),
  },
  annotations: { readOnlyHint: true, openWorldHint: true },
}, (q) => run(async () => {
  const res = await api().client.request("GET", "/transactions", { query: q });
  // Safety net for older API versions that ignored reference_id: never hand back other payouts.
  if (q.reference_id && Array.isArray(res?.data)) {
    return { ...res, data: res.data.filter((w: any) => w.reference_id === q.reference_id) };
  }
  return res;
}));

server.registerTool("fiatsend_get_checkout_session", {
  title: "Get checkout session",
  description: "Retrieve a checkout session (cs_…). status \"complete\" means paid.",
  inputSchema: { session_id: z.string().regex(/^cs_[a-f0-9]{48}$/, "Expected cs_ followed by 48 hex characters") },
  annotations: { readOnlyHint: true, openWorldHint: true },
}, ({ session_id }) => run(() => api().client.request("GET", `/checkout/sessions/${session_id}`, { checkout: true })));

server.registerTool("fiatsend_list_checkout_sessions", {
  title: "List checkout sessions",
  description: "Most recent checkout sessions, newest first, in the mode (test/live) of the API key.",
  inputSchema: { limit: z.number().int().min(1).max(100).default(25) },
  annotations: { readOnlyHint: true, openWorldHint: true },
}, ({ limit }) => run(() => api().client.request("GET", "/checkout/sessions", { query: { limit }, checkout: true })));

server.registerTool("fiatsend_list_webhooks", {
  title: "List webhooks",
  description: "List registered withdrawal webhook endpoints. (Checkout webhooks are managed in Console.)",
  inputSchema: {},
  annotations: { readOnlyHint: true, openWorldHint: true },
}, () => run(() => api().client.request("GET", "/webhooks")));

server.registerTool("fiatsend_verify_webhook_signature", {
  title: "Verify webhook signature",
  description: "Debug helper: check whether an X-Fiatsend-Signature matches a raw webhook body and secret. Runs locally; nothing is sent to Fiatsend.",
  inputSchema: {
    raw_body: z.string().describe("Exact raw request body as received"),
    signature: z.string().describe("Value of the X-Fiatsend-Signature header"),
    secret: z.string().describe("Your webhook secret"),
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
}, ({ raw_body, signature, secret }) => run(async () => ({
  valid: verifySignature(raw_body, signature, secret),
  note: "Sign the raw bytes, not re-serialised JSON. Whitespace or key-order changes break the signature.",
})));

// ── Write ─────────────────────────────────────────────────────────────────

server.registerTool("fiatsend_create_withdrawal", {
  title: "Send a payout (moves money)",
  description:
    "Send USDC/USDT to a Ghana mobile money wallet. MOVES MONEY. Only call after fiatsend_quote_payout and after the user has explicitly confirmed the amount, phone and network. " +
    "reference_id is the idempotency key: re-sending the same value returns the existing payout, so retry with it after a timeout. Blocked for live keys unless FIATSEND_ALLOW_LIVE_PAYOUTS=true.",
  inputSchema: {
    amount: Amount,
    currency: Stablecoin,
    recipient_phone: z.string(),
    mobile_network: Network,
    reference_id: z.string().min(1).max(100).describe("Your unique, stable reference for this payout"),
    metadata: z.record(z.string(), z.string()).optional(),
    user_confirmed: z.literal(true).describe("Set true only after the user explicitly confirmed this exact payout"),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
}, (a) => run(async () => {
  const { client, cfg } = api();
  if (cfg.mode === "live" && !cfg.allowLivePayouts) {
    throw new Error("Live payouts are disabled. Set FIATSEND_ALLOW_LIVE_PAYOUTS=true in the MCP server's env to enable them.");
  }
  return client.request("POST", "/withdrawals", {
    body: {
      amount: a.amount, currency: a.currency,
      recipient_phone: normaliseGhanaPhone(a.recipient_phone),
      mobile_network: a.mobile_network, reference_id: a.reference_id,
      ...(a.metadata ? { metadata: a.metadata } : {}),
    },
  });
}));

server.registerTool("fiatsend_create_checkout_session", {
  title: "Create checkout session",
  description: "Create a hosted checkout (payment link) for a customer to pay in GHS or USDC. Returns a url to send the customer to. Uses api.fiatsend.com for both test and live keys.",
  inputSchema: {
    amount: z.number().positive().describe("Major units, e.g. 50.00"),
    currency: z.enum(["GHS", "USDC"]).default("GHS"),
    description: z.string().max(200).optional(),
    client_reference_id: z.string().max(100).optional(),
    customer: z.object({
      name: z.string().max(120).optional(),
      email: z.string().email().optional(),
      phone: z.string().optional(),
    }).optional(),
    success_url: z.string().max(500).optional(),
    cancel_url: z.string().max(500).optional(),
    metadata: z.record(z.string(), z.string().max(500)).optional(),
    accepted_methods: z.array(z.enum(["fiatsend", "mobile_money", "bank_transfer"])).optional(),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
}, (a) => run(() => api().client.request("POST", "/checkout/sessions", { body: a, checkout: true })));

server.registerTool("fiatsend_register_webhook", {
  title: "Register webhook",
  description: "Register an https endpoint for withdrawal status events. If no secret is given, one is generated and returned ONCE — store it as FIATSEND_WEBHOOK_SECRET.",
  inputSchema: {
    url: z.string().url().startsWith("https://", "Webhook URLs must be https"),
    events: z.array(z.enum(["withdrawal.pending", "withdrawal.processing", "withdrawal.completed", "withdrawal.failed"]))
      .min(1).default(["withdrawal.processing", "withdrawal.completed", "withdrawal.failed"]),
    secret: z.string().min(16).optional(),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
}, (a) => run(async () => {
  const secret = a.secret ?? `whsec_${crypto.randomBytes(24).toString("hex")}`;
  const res = await api().client.request("POST", "/webhooks", { body: { url: a.url, events: a.events, secret } });
  return { ...res, ...(a.secret ? {} : { generated_secret: secret, note: "Save this secret now; it won't be shown again." }) };
}));

server.registerTool("fiatsend_delete_webhook", {
  title: "Delete webhook",
  description: "Delete a registered withdrawal webhook endpoint by webhook_id (wh_…).",
  inputSchema: { webhook_id: z.string().min(1) },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
}, ({ webhook_id }) => run(async () => {
  await api().client.request("DELETE", `/webhooks/${encodeURIComponent(webhook_id)}`);
  return { deleted: webhook_id };
}));

// ── Docs as a resource ────────────────────────────────────────────────────

const here = dirname(fileURLToPath(import.meta.url));
server.registerResource("fiatsend-docs", "fiatsend://docs/llms-full", {
  title: "Fiatsend Partner API reference",
  description: "Every endpoint, field, error code and webhook handler pattern, for writing integration code.",
  mimeType: "text/markdown",
}, async (uri) => {
  let text: string;
  try { text = readFileSync(join(here, "..", "docs", "llms-full.txt"), "utf8"); }
  catch { text = "Full reference: https://developer.fiatsend.com/llms-full.txt and https://developer.fiatsend.com/fiatsend-openapi.yaml"; }
  return { contents: [{ uri: uri.href, mimeType: "text/markdown", text }] };
});

await server.connect(new StdioServerTransport());
console.error(`fiatsend-mcp ${VERSION} running on stdio`);
