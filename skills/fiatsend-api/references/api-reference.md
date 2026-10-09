# Fiatsend Partner API v1 — full reference

Source: https://developer.fiatsend.com and `fiatsend-openapi.yaml` (v1.3.0), captured 2026-10-09.

Base URLs
- Sandbox: `https://sandbox.fiatsend.com/v1`
- Production: `https://api.fiatsend.com/v1`
- Checkout sessions: `https://api.fiatsend.com/v1` for both test (`fs_test_`) and live (`fs_live_`) keys

Auth: `Authorization: Bearer <key>` on everything except `/health`.

---

## Withdrawals (payouts)

### POST /withdrawals
Locks the FX rate, converts stablecoin → GHS, sends to the mobile wallet.

| Field | Type | Req | Notes |
|---|---|---|---|
| amount | string | ✓ | Source-currency amount, e.g. `"50.00"` |
| currency | string | ✓ | `USDC` \| `USDT` |
| recipient_phone | string | ✓ | E.164, Ghana: `+233XXXXXXXXX` |
| mobile_network | string | ✓ | `MTN` \| `TELECEL` \| `AIRTELTIGO` |
| reference_id | string | ✓ | Your unique ID; acts as idempotency key |
| metadata | object | | Free-form key/values |

201:
```json
{ "status": "success", "data": {
  "withdrawal_id": "wd_9f8e7d6c5b4a", "status": "pending",
  "amount": "50.00", "currency": "USDC", "ghs_amount": "750.00",
  "fx_rate": "15.00", "fee": "0.50",
  "recipient_phone": "+233241234567", "mobile_network": "MTN",
  "reference_id": "deel-txn-abc123",
  "estimated_completion": "2026-03-21T07:00:00Z", "created_at": "2026-03-21T06:59:30Z" } }
```
Errors: 400 `INVALID_PHONE`/`INVALID_NETWORK`, 401, 422 `BELOW_MINIMUM`/`ABOVE_MAXIMUM`/`RATE_EXPIRED`, 429, 503.

Duplicate `reference_id`: returns success with the **existing** withdrawal (same `withdrawal_id`, current status) — no second payout. Verified against the sandbox on 2026-10-09. Safe to retry after a timeout.

Status lifecycle: `pending` → `processing` → `completed` | `failed` (funds returned to source).

### GET /withdrawals/{withdrawal_id}
200 adds: `on_chain_tx_hash`, `mobile_money_reference`, `processing_at`, `completed_at`, `failed_at`, `failure_reason`. 404 if unknown.

### GET /transactions
Query: `status`, `from_date`, `to_date` (ISO 8601), `reference_id`, `page` (1), `per_page` (25, max 100).

> **Known issue (sandbox, 2026-10-09):** `reference_id` is ignored — the response includes withdrawals with other references. Filter `data` by `reference_id` in your own code.
Response: `{ status, data: [WithdrawalDetail], pagination: { page, per_page, total, total_pages } }`.

---

## Rates and networks

### GET /rates
Query (all required): `from_currency` (`USDC`|`USDT`), `to_currency` (`GHS`), `amount` (string).
```json
{ "status": "success", "data": { "from_currency": "USDC", "to_currency": "GHS",
  "amount": "100.00", "rate": "15.02", "fee": "1.00", "total_ghs": "1501.00",
  "valid_until": "2026-03-21T07:05:00Z" } }
```
Rate is guaranteed until `valid_until`. `fee` is in the source stablecoin: `total_ghs = (amount − fee) × rate`, rounded to 2 places (sandbox: 10.00 USDC, fee 0.10, rate 11.65 → 115.34). Example values are illustrative — always use the live response.

### GET /supported-networks
Each item: `network_id`, `name`, `country` (`GH`), `currency` (`GHS`), `status` (`operational`|`degraded`|`down`), `min_amount`, `max_amount`.
Documented examples: MTN 5–10,000; TELECEL 5–5,000; AIRTELTIGO 5–5,000. Read live values; don't hard-code.

### GET /limits
Per KYC tier: `tier`, `daily_limit`, `monthly_limit`, `per_transaction_max`. Tiers returned by the API: `basic`, `standard`, `enterprise` (the docs call the middle tier `verified`).

---

## Checkout sessions (accept payments)

### POST /checkout/sessions
| Field | Type | Req | Notes |
|---|---|---|---|
| amount | number | ✓ | Major units, > 0 |
| currency | string | | `GHS` (default) \| `USDC` |
| description | string | | ≤200 chars, shown to customer |
| client_reference_id | string | | ≤100 chars, your order ID |
| customer | object | | `name`, `email`, `phone` (E.164); email → receipt |
| success_url / cancel_url | string | | https only (`http://localhost` OK in test). `{SESSION_ID}` placeholder is replaced; otherwise `session_id` query param is appended |
| metadata | object | | ≤20 string pairs, keys ≤40, values ≤500 |
| accepted_methods | string[] | | `fiatsend`, `mobile_money` (GHS only), `bank_transfer` |

201 → session object. Send the customer to `url`.

### GET /checkout/sessions/{session_id}
`session_id` pattern `^cs_[a-f0-9]{48}$`. `status: "complete"` = paid.

### GET /checkout/sessions?limit=N
`{ "object": "list", "data": [session, ...] }`, newest first, same mode as the key.

Session object: `id`, `object` (`checkout.session`), `status` (`open`|`complete`|`cancelled`), `url`, `amount`, `currency`, `description`, `client_reference_id`, `metadata`, `customer`, `accepted_methods`, `success_url`, `cancel_url`, `paid_at`, `paid_via` (`fiatsend`|`mobile_money`|`bank_transfer`|`manual`), `livemode`, `created_at`.

Checkout errors: `{"error":{"code","message"}}` — `invalid_request` 400, 401 (`{"message"}`), `account_not_active` 403 (live key before activation), `not_found` 404, `account_not_ready` 422 (e.g. no Stellar wallet connected), `rate_limited` 429, `upstream_unavailable` 502. Limit: 120 req/min per business.

Embedded popup instead of redirect:
```html
<script src="https://console.fiatsend.com/fiatsend-checkout.js"></script>
<script>
  Fiatsend.checkout.open({ session: "cs_..." });
  Fiatsend.checkout.on("paid", () => { /* UI hint only — confirm server-side */ });
</script>
```
No-code buttons: https://docs.fiatsend.com/docs/payments/website-checkout

---

## Payment intents (consumer approves in Fiatsend app)

Documented on the portal; not in the OpenAPI file yet — confirm with partners@fiatsend.com before relying on it.

- `POST /payment-intents` — `amount` (string), `currency` (usually `GHS`), `consumer_phone` (E.164), `merchant_reference` (idempotency), optional `terminal_id`, `description`. 201 → `payment_intent_id`, `status: "pending_approval"`, `expires_at` (≈90 s after creation in the example).
- `GET /payment-intents/{id}`
- `POST /payment-intents/{id}/cancel`
- `/internal/payment-intents/*` routes use `X-Internal-Token` and are for Fiatsend's own services — partners should not call them.

---

## Webhook endpoints

- `POST /webhooks` — `url` (uri), `events` (subset of `withdrawal.pending|processing|completed|failed`), `secret`. 201 → `webhook_id`, `active`, `created_at`.
- `GET /webhooks` — list.
- `DELETE /webhooks/{webhook_id}` — 204.

Checkout webhooks are configured in Console, not here.

## Health

`GET /health` (no auth) → `status`, `version`, `uptime_seconds`, `environment`, `services.{blockchain,mobile_money,database}`.

## Error codes (non-checkout)

| Code | HTTP | Meaning |
|---|---|---|
| UNAUTHORIZED | 401 | Invalid or missing API key |
| INVALID_PHONE | 400 | Bad phone format |
| INVALID_NETWORK | 400 | Unsupported network |
| BELOW_MINIMUM | 422 | Amount below network minimum |
| ABOVE_MAXIMUM | 422 | Amount above network maximum |
| RATE_EXPIRED | 422 | Quote expired |
| NETWORK_DOWN | 503 | Mobile money network unavailable |
| INSUFFICIENT_LIQUIDITY | 503 | Not enough liquidity |
| RATE_LIMITED | 429 | Too many requests |
| INTERNAL_ERROR | 500 | Server error |

## Rate limits

| | per minute | per day |
|---|---|---|
| Sandbox | 60 | 10,000 |
| Production | 300 | 100,000 |
| Checkout (any) | 120 per business | — |
