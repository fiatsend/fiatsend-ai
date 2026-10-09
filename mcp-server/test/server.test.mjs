// End-to-end: start the server over stdio and talk MCP to it.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const entry = fileURLToPath(new URL("../dist/index.js", import.meta.url));

async function connect(env) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry], env: { PATH: process.env.PATH, ...env }, stderr: "ignore" });
  const client = new Client({ name: "test", version: "0" });
  await client.connect(transport);
  return client;
}

test("lists every tool with annotations and the docs resource", async () => {
  const c = await connect({ FIATSEND_API_KEY: "fs_test_x" });
  const { tools } = await c.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    "fiatsend_cancel_payment_intent", "fiatsend_create_checkout_session", "fiatsend_create_payment_intent",
    "fiatsend_create_withdrawal", "fiatsend_delete_webhook", "fiatsend_get_checkout_session", "fiatsend_get_limits",
    "fiatsend_get_payment_intent", "fiatsend_get_rate", "fiatsend_get_withdrawal", "fiatsend_health",
    "fiatsend_list_checkout_sessions", "fiatsend_list_networks", "fiatsend_list_transactions",
    "fiatsend_list_webhooks", "fiatsend_quote_payout", "fiatsend_register_webhook", "fiatsend_verify_webhook_signature",
  ]);
  const cancel = tools.find((t) => t.name === "fiatsend_cancel_payment_intent");
  assert.equal(cancel.annotations.destructiveHint, true);
  assert.equal(tools.find((t) => t.name === "fiatsend_get_payment_intent").annotations.readOnlyHint, true);
  const payout = tools.find((t) => t.name === "fiatsend_create_withdrawal");
  assert.equal(payout.annotations.destructiveHint, true);
  assert.ok(payout.inputSchema.required.includes("user_confirmed"));

  const { resources } = await c.listResources();
  assert.equal(resources[0].uri, "fiatsend://docs/llms-full");
  const doc = await c.readResource({ uri: "fiatsend://docs/llms-full" });
  assert.match(doc.contents[0].text, /X-Fiatsend-Signature/);
  await c.close();
});

test("live payouts are blocked without FIATSEND_ALLOW_LIVE_PAYOUTS", async () => {
  const c = await connect({ FIATSEND_API_KEY: "fs_live_x" });
  const r = await c.callTool({ name: "fiatsend_create_withdrawal", arguments: {
    amount: "10.00", currency: "USDC", recipient_phone: "0241234567", mobile_network: "MTN",
    reference_id: "t1", user_confirmed: true,
  } });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /Live payouts are disabled/);
  await c.close();
});

test("missing key gives a clear error instead of crashing", async () => {
  const c = await connect({});
  const r = await c.callTool({ name: "fiatsend_list_networks", arguments: {} });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /FIATSEND_API_KEY is not set/);
  await c.close();
});

test("input validation rejects bad amounts and phones before any network call", async () => {
  const c = await connect({ FIATSEND_API_KEY: "fs_test_x" });
  const bad = await c.callTool({ name: "fiatsend_get_rate", arguments: { amount: "ten" } });
  assert.equal(bad.isError, true);
  const phone = await c.callTool({ name: "fiatsend_create_withdrawal", arguments: {
    amount: "10.00", currency: "USDC", recipient_phone: "123", mobile_network: "MTN", reference_id: "t2", user_confirmed: true,
  } });
  assert.equal(phone.isError, true);
  assert.match(phone.content[0].text, /not a valid Ghana mobile number/);
  await c.close();
});

test("verify_webhook_signature tool works locally", async () => {
  const c = await connect({ FIATSEND_API_KEY: "fs_test_x" });
  const body = '{"event":"checkout.session.completed","id":"evt_1"}';
  const sig = crypto.createHmac("sha256", "whsec_s").update(body).digest("hex");
  const r = await c.callTool({ name: "fiatsend_verify_webhook_signature", arguments: { raw_body: body, signature: sig, secret: "whsec_s" } });
  assert.equal(JSON.parse(r.content[0].text).valid, true);
  await c.close();
});
