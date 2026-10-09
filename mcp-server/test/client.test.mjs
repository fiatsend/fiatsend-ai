import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { FiatsendClient, FiatsendError, loadConfig, normaliseGhanaPhone, verifySignature } from "../dist/client.js";

test("loadConfig picks sandbox for fs_test_ and live for fs_live_", () => {
  assert.equal(loadConfig({ FIATSEND_API_KEY: "fs_test_x" }).baseUrl, "https://sandbox.fiatsend.com/v1");
  const live = loadConfig({ FIATSEND_API_KEY: "fs_live_x" });
  assert.equal(live.mode, "live");
  assert.equal(live.baseUrl, "https://api.fiatsend.com/v1");
  assert.equal(live.allowLivePayouts, false);
  assert.equal(live.checkoutUrl, "https://api.fiatsend.com/v1");
});

test("loadConfig rejects missing or malformed keys", () => {
  assert.throws(() => loadConfig({}), /FIATSEND_API_KEY is not set/);
  assert.throws(() => loadConfig({ FIATSEND_API_KEY: "sk_123" }), /must start with/);
});

test("normaliseGhanaPhone handles common formats", () => {
  for (const p of ["0241234567", "+233241234567", "233 24 123 4567", "(024) 123-4567"]) {
    assert.equal(normaliseGhanaPhone(p), "+233241234567");
  }
  assert.throws(() => normaliseGhanaPhone("12345"));
  assert.throws(() => normaliseGhanaPhone("+2332412345678"));
});

test("verifySignature matches hex HMAC-SHA256 and rejects tampering", () => {
  const body = '{"type":"withdrawal.completed","data":{"withdrawal_id":"wd_1"}}';
  const sig = crypto.createHmac("sha256", "whsec_abc").update(body).digest("hex");
  assert.equal(verifySignature(body, sig, "whsec_abc"), true);
  assert.equal(verifySignature(body, sig.toUpperCase(), "whsec_abc"), true);
  assert.equal(verifySignature(body + " ", sig, "whsec_abc"), false);
  assert.equal(verifySignature(body, "short", "whsec_abc"), false); // no throw on length mismatch
});

test("verifySignature accepts the sha256= prefix withdrawal events use", () => {
  const body = '{"id":"evt_1","type":"withdrawal.completed","data":{"withdrawal_id":"wd_1"}}';
  const sig = crypto.createHmac("sha256", "whsec_abc").update(body).digest("hex");
  assert.equal(verifySignature(body, `sha256=${sig}`, "whsec_abc"), true);
  assert.equal(verifySignature(body, `sha256=${sig.slice(0, -1)}0`, "whsec_abc"), false);
});

function fakeFetch(status, body, seen) {
  return async (url, init) => {
    seen?.push({ url: String(url), init });
    return new Response(body === null ? null : JSON.stringify(body), { status });
  };
}

test("client sends bearer auth, query params and JSON body", async () => {
  const seen = [];
  const c = new FiatsendClient(loadConfig({ FIATSEND_API_KEY: "fs_test_k" }), fakeFetch(200, { status: "success", data: {} }, seen));
  await c.request("GET", "/rates", { query: { from_currency: "USDC", to_currency: "GHS", amount: "10.00", skip: undefined } });
  assert.equal(seen[0].url, "https://sandbox.fiatsend.com/v1/rates?from_currency=USDC&to_currency=GHS&amount=10.00");
  assert.equal(seen[0].init.headers.Authorization, "Bearer fs_test_k");

  await c.request("POST", "/checkout/sessions", { body: { amount: 5 }, checkout: true });
  assert.equal(seen[1].url, "https://api.fiatsend.com/v1/checkout/sessions");
  assert.equal(seen[1].init.body, '{"amount":5}');

  await c.request("GET", "/health", { auth: false });
  assert.equal(seen[2].init.headers.Authorization, undefined);
});

test("client parses both documented error shapes", async () => {
  const cfg = loadConfig({ FIATSEND_API_KEY: "fs_test_k" });
  const a = new FiatsendClient(cfg, fakeFetch(400, { status: "error", code: "INVALID_PHONE", message: "bad phone" }));
  await assert.rejects(a.request("POST", "/withdrawals", { body: {} }), (e) =>
    e instanceof FiatsendError && e.code === "INVALID_PHONE" && e.status === 400 && !e.retryable);

  const b = new FiatsendClient(cfg, fakeFetch(429, { error: { code: "rate_limited", message: "slow down" } }));
  await assert.rejects(b.request("GET", "/checkout/sessions", { checkout: true }), (e) =>
    e.code === "rate_limited" && e.retryable);

  const c = new FiatsendClient(cfg, fakeFetch(401, { message: "Invalid key" }));
  await assert.rejects(c.request("GET", "/limits"), (e) => e.code === "HTTP_401" && /Invalid key/.test(e.message));
});

test("204 returns null", async () => {
  const c = new FiatsendClient(loadConfig({ FIATSEND_API_KEY: "fs_test_k" }), fakeFetch(204, null));
  assert.equal(await c.request("DELETE", "/webhooks/wh_1"), null);
});
