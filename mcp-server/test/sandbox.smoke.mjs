// Live smoke test against https://sandbox.fiatsend.com through the MCP protocol.
// Run: FIATSEND_API_KEY=fs_test_... node test/sandbox.smoke.mjs
// Sandbox only: refuses to run with a live key. Creates one sandbox withdrawal (no real money).
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const key = process.env.FIATSEND_API_KEY ?? "";
if (!key.startsWith("fs_test_")) {
  console.error("Set FIATSEND_API_KEY to a sandbox key (fs_test_...). Live keys are refused.");
  process.exit(2);
}

const entry = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const client = new Client({ name: "sandbox-smoke", version: "0" });
await client.connect(new StdioClientTransport({
  command: process.execPath, args: [entry],
  env: { PATH: process.env.PATH, FIATSEND_API_KEY: key }, stderr: "inherit",
}));

let failures = 0;
const lines = [];
const log = (l) => { console.log(l); lines.push(l); };
async function step(name, args, check) {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content?.[0]?.text ?? "";
  let data; try { data = JSON.parse(text); } catch { data = text; }
  let problem = res.isError ? "tool returned an error" : null;
  if (!problem && check) { try { problem = check(data) || null; } catch (e) { problem = e.message; } }
  log(`${problem ? "FAIL" : "ok  "} ${name}${problem ? ` — ${problem}` : ""}`);
  log("     " + text.replace(/\n\s*/g, " ").slice(0, 400));
  if (problem) failures++;
  return data;
}

await step("fiatsend_health", {}, (d) => d.key_mode !== "test" && "expected sandbox mode");
await step("fiatsend_list_networks", {}, (d) => !Array.isArray(d.data) && "no data array");
await step("fiatsend_get_limits", {});
await step("fiatsend_get_rate", { from_currency: "USDC", amount: "10.00" }, (d) => !d.data?.rate && "no rate");
await step("fiatsend_quote_payout", { amount: "10.00", currency: "USDC", recipient_phone: "0241234567", mobile_network: "MTN" },
  (d) => d.payout?.recipient_phone !== "+233241234567" && "phone not normalised");

const ref = `smoke_${process.env.GITHUB_RUN_ID ?? Date.now()}`;
const created = await step("fiatsend_create_withdrawal", {
  amount: "10.00", currency: "USDC", recipient_phone: "+233241234567", mobile_network: "MTN",
  reference_id: ref, user_confirmed: true, metadata: { source: "ai-kit-smoke-test" },
}, (d) => !d.data?.withdrawal_id && "no withdrawal_id");

// Same reference_id again: tells us how the API treats duplicates (an open question in the guide).
const dup = await client.callTool({ name: "fiatsend_create_withdrawal", arguments: {
  amount: "10.00", currency: "USDC", recipient_phone: "+233241234567", mobile_network: "MTN",
  reference_id: ref, user_confirmed: true,
} });
log(`info duplicate reference_id → ${dup.isError ? "error" : "success"}: ${dup.content?.[0]?.text.replace(/\n\s*/g, " ").slice(0, 300)}`);

const id = created?.data?.withdrawal_id;
if (id) await step("fiatsend_get_withdrawal", { withdrawal_id: id }, (d) => d.data?.withdrawal_id !== id && "id mismatch");
await step("fiatsend_list_transactions", { reference_id: ref });
await step("fiatsend_list_webhooks", {});

await client.close();
log(failures ? `${failures} step(s) failed` : "All sandbox steps passed");
// On GitHub Actions, also attach the results to the run as an annotation (readable via the API).
if (process.env.GITHUB_ACTIONS) {
  const esc = (t) => t.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
  console.log(`::notice title=Sandbox smoke results::${esc(lines.join("\n"))}`);
}
process.exit(failures ? 1 : 0);
