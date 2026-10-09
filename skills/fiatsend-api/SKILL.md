---
name: fiatsend-api
description: Integrate the Fiatsend Partner API — stablecoin (USDC/USDT) payouts to Ghana mobile money (MTN, Telecel, AirtelTigo), hosted checkout sessions in GHS or USDC, FX rates, and signed webhooks. Use when writing, reviewing or debugging code that calls api.fiatsend.com or sandbox.fiatsend.com, or when the user mentions Fiatsend payouts, withdrawals, checkout, or webhooks.
---

# Fiatsend Partner API

Fiatsend converts USDC/USDT to Ghana cedis (GHS) and delivers them to mobile money wallets, and lets businesses take payments through hosted checkout. This skill is the working reference for building against the **Partner API v1** (spec version 1.3.0).

Canonical sources (check these when in doubt — they win over this file):
- Docs: https://developer.fiatsend.com
- OpenAPI 3.0: https://developer.fiatsend.com/fiatsend-openapi.yaml
- Postman: https://developer.fiatsend.com/fiatsend-postman-collection.json
- Keys and webhooks UI: https://console.fiatsend.com (Developers → API Keys / Webhooks)
- Support: partners@fiatsend.com

## Ground rules (always apply)

1. **Server-side only.** API keys never go in browser, mobile or any client bundle. Read them from `FIATSEND_API_KEY`.
2. **Sandbox first.** Default to `https://sandbox.fiatsend.com/v1` with an `fs_test_` key. Only use `https://api.fiatsend.com/v1` with an `fs_live_` key when the user explicitly says production.
   - Exception: **checkout sessions** use `https://api.fiatsend.com/v1` for both modes; the key prefix decides test vs live.
3. **Money is a string.** Withdrawal and rate amounts are decimal strings (`"50.00"`). Never use floats for arithmetic — use integer minor units or a decimal library. (Checkout `amount` is a JSON number in major units.)
4. **Idempotency = `reference_id`.** Every withdrawal needs a unique, stable `reference_id` derived from your own record (e.g. `payout_<db id>`). Generate it once, persist it, and reuse it on retry. Re-posting the same `reference_id` returns the existing withdrawal instead of creating a second one (confirmed in sandbox, 2026-10-09). Never generate a fresh random ID inside a retry loop.
5. **Phones are E.164 Ghana numbers**: `+233` followed by 9 digits (e.g. `+233241234567`). Normalise `0241234567` → `+233241234567` before sending.
6. **Confirm payment on the server.** Fulfil orders only after the `checkout.session.completed` webhook or a server-side `GET` shows `status: "complete"` — never on a browser redirect or JS event.
7. **Verify every webhook** with HMAC-SHA256 over the **raw** body before parsing (see `references/webhooks.md`).
8. **Never move real money from an AI tool without explicit human confirmation** of amount, recipient phone and network.

## Authentication

```http
Authorization: Bearer fs_test_xxx      # sandbox
Authorization: Bearer fs_live_xxx      # production
Content-Type: application/json
```
`GET /v1/health` needs no auth. The public demo key `fs_test_demo_key_2026` works for sandbox "Try it" calls but **not** for checkout sessions.

## Endpoint map

| Goal | Method & path | Notes |
|---|---|---|
| Health check | `GET /health` | No auth |
| Networks + min/max | `GET /supported-networks` | `status`: operational / degraded / down |
| KYC tier limits | `GET /limits` | basic / standard / enterprise (docs say "verified"; the API returns `standard`) |
| FX quote | `GET /rates?from_currency=USDC&to_currency=GHS&amount=100.00` | Guaranteed until `valid_until`. `fee` is in the stablecoin: `total_ghs = (amount − fee) × rate` |
| Send payout | `POST /withdrawals` | Returns 201, `status: pending` |
| Payout status | `GET /withdrawals/{withdrawal_id}` | Prefer webhooks over polling |
| List payouts | `GET /transactions` | Filters: status, from_date, to_date, page, per_page≤100. `reference_id` filter is currently ignored — filter results yourself |
| Create checkout | `POST /checkout/sessions` | Redirect customer to `url` |
| Get checkout | `GET /checkout/sessions/{id}` | `status`: open / complete / cancelled |
| List checkouts | `GET /checkout/sessions?limit=25` | 1–100 |
| Register webhook | `POST /webhooks` | Withdrawal events only |
| List / delete webhooks | `GET /webhooks`, `DELETE /webhooks/{id}` | Delete returns 204 |
| Payment intents | `POST /payment-intents`, `GET /payment-intents/{id}`, `POST /payment-intents/{id}/cancel` | Consumer approves in the Fiatsend app; not in the OpenAPI file yet |

Full request/response shapes: `references/api-reference.md`.

## The payout flow (most common task)

```
GET /supported-networks   → is the network operational? is the amount within min/max?
GET /rates                → show recipient the GHS they'll get; note valid_until
POST /withdrawals         → persist withdrawal_id + reference_id, status=pending
webhook (or poll GET)     → pending → processing → completed | failed
```

Minimal Node.js (18+, no SDK needed):

```js
const BASE = process.env.FIATSEND_BASE_URL ?? "https://sandbox.fiatsend.com/v1";

async function fiatsend(path, init = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${process.env.FIATSEND_API_KEY}`,
      "Content-Type": "application/json",
      ...init.headers,
    },
  });
  const body = res.status === 204 ? null : await res.json();
  if (!res.ok) {
    const code = body?.code ?? body?.error?.code ?? res.status;
    const err = new Error(`Fiatsend ${code}: ${body?.message ?? body?.error?.message}`);
    err.code = code; err.status = res.status;
    throw err;
  }
  return body;
}

// payout.id comes from YOUR database — that makes reference_id stable across retries
export async function sendPayout(payout) {
  const { data } = await fiatsend("/withdrawals", {
    method: "POST",
    body: JSON.stringify({
      amount: payout.amount,                 // "50.00"
      currency: "USDC",                      // or "USDT"
      recipient_phone: payout.phone,         // "+233241234567"
      mobile_network: payout.network,        // "MTN" | "TELECEL" | "AIRTELTIGO"
      reference_id: `payout_${payout.id}`,
      metadata: { user_id: String(payout.userId) },
    }),
  });
  return data; // { withdrawal_id, status: "pending", ghs_amount, fx_rate, fee, ... }
}
```

Python equivalent and checkout examples: `examples/`.

## Errors and retries

Two error shapes exist — handle both:
- Most endpoints: `{"status":"error","code":"INVALID_PHONE","message":"..."}`
- Checkout endpoints: `{"error":{"code":"invalid_request","message":"..."}}`; a 401 may be just `{"message":"..."}`.

| Retry? | Codes |
|---|---|
| Fix the request, don't retry | `UNAUTHORIZED` 401, `INVALID_PHONE` 400, `INVALID_NETWORK` 400, `BELOW_MINIMUM` 422, `ABOVE_MAXIMUM` 422, `invalid_request`, `account_not_active` 403, `account_not_ready` 422, `not_found` 404 |
| Re-quote, then retry | `RATE_EXPIRED` 422 |
| Retry with backoff, **same reference_id** | `RATE_LIMITED` / `rate_limited` 429, `NETWORK_DOWN` 503, `INSUFFICIENT_LIQUIDITY` 503, `INTERNAL_ERROR` 500, `upstream_unavailable` 502, timeouts |

On a timeout after `POST /withdrawals`, retry the **same request with the same `reference_id`**: the API returns the existing withdrawal rather than creating a new one. Don't use `GET /transactions?reference_id=` to check — that filter is currently ignored and returns other payouts.

Rate limits: sandbox 60/min · 10k/day; production 300/min · 100k/day; checkout 120/min per business.

## Webhooks (summary)

- Header `X-Fiatsend-Signature` = hex HMAC-SHA256 of the raw body with your webhook secret. Compare in constant time.
- **Withdrawal events** (`withdrawal.pending|processing|completed|failed`): event name in `type`, payload in `data`. Registered via `POST /v1/webhooks` (you supply the `secret`). Retries: 1m, 5m, 30m, 2h, 24h.
- **Checkout event** (`checkout.session.completed`): event name in `event`, session in `data.object`, unique `id`. Registered in Console. Up to 3 attempts, 8 s timeout each.
- Read the name with `payload.type ?? payload.event`. Return 2xx fast, process async, and de-duplicate (event `id` for checkout; `withdrawal_id` + `status` for withdrawals).

Full handler code (Express, Next.js, FastAPI): `references/webhooks.md`.

## Testing checklist before go-live

- [ ] Health, networks, rates and a sandbox withdrawal all succeed with an `fs_test_` key
- [ ] Webhook endpoint rejects a bad signature with 401 and accepts a good one
- [ ] Duplicate webhook deliveries don't double-credit
- [ ] Retrying a withdrawal after a simulated timeout doesn't create a second payout
- [ ] `failed` withdrawals surface `failure_reason` to ops / the user
- [ ] Keys only in server env vars; `.env` is git-ignored
- [ ] Live key swap is a config change only (`FIATSEND_BASE_URL`, `FIATSEND_API_KEY`)

## Reference files

- `references/api-reference.md` — every endpoint, field and response
- `references/webhooks.md` — signature verification and handlers in 3 frameworks
- `examples/payout.py`, `examples/checkout.js` — runnable starter code
