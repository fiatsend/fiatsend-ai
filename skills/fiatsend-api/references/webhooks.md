# Fiatsend webhooks — verification and handlers

## The rules

1. Read the **raw** request body (bytes). Parsing JSON first and re-serialising changes the bytes and breaks the signature.
2. `X-Fiatsend-Signature` = lowercase hex of `HMAC_SHA256(secret, raw_body)`.
3. Compare in constant time, and check lengths first (Node's `timingSafeEqual` throws on unequal lengths).
4. Respond `2xx` quickly (checkout times out at 8 s, withdrawals at 30 s); do slow work in a queue.
5. De-duplicate. Delivery is at-least-once.

## Two payload shapes

Withdrawal events — name in `type`:
```json
{ "type": "withdrawal.completed", "created_at": "2026-03-21T06:59:42Z",
  "data": { "withdrawal_id": "wd_...", "status": "completed", "reference_id": "...", "...": "..." } }
```

Checkout event — name in `event`, object in `data.object`, also header `X-Fiatsend-Event`:
```json
{ "id": "evt_...", "event": "checkout.session.completed", "sentAt": "...", "livemode": true,
  "data": { "object": { "id": "cs_...", "status": "complete", "client_reference_id": "order_1042" } } }
```


Dedup key: checkout → `id`; withdrawal → `${data.withdrawal_id}:${data.status}`.

## Express (Node.js)

```js
import express from "express";
import crypto from "node:crypto";

const app = express();

function isValidSignature(rawBody, header, secret) {
  if (!header) return false;
  // Withdrawal events send "sha256=<hex>"; checkout events send bare hex. Accept both.
  const received = header.startsWith("sha256=") ? header.slice(7) : header;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(received, "hex");
  const b = Buffer.from(expected, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// express.raw MUST be on this route, before any express.json()
app.post("/webhooks/fiatsend", express.raw({ type: "application/json" }), async (req, res) => {
  if (!isValidSignature(req.body, req.get("x-fiatsend-signature"), process.env.FIATSEND_WEBHOOK_SECRET)) {
    return res.status(401).json({ error: "invalid signature" });
  }
  const payload = JSON.parse(req.body.toString("utf8"));
  const name = payload.type ?? payload.event;
  const dedupKey = payload.id ?? `${payload.data?.withdrawal_id}:${payload.data?.status}`;

  if (await alreadyProcessed(dedupKey)) return res.sendStatus(200);

  switch (name) {
    case "withdrawal.processing": await markPayout(payload.data.reference_id, "processing"); break;
    case "withdrawal.completed":  await markPayout(payload.data.reference_id, "completed", payload.data); break;
    case "withdrawal.failed":     await markPayout(payload.data.reference_id, "failed", payload.data); break;
    case "checkout.session.completed": await fulfilOrder(payload.data.object.client_reference_id, payload.data.object); break;
  }
  await rememberProcessed(dedupKey);
  res.sendStatus(200);
});
```

## Next.js App Router

```ts
// app/api/webhooks/fiatsend/route.ts
import crypto from "node:crypto";

export async function POST(req: Request) {
  const raw = await req.text();                       // raw body, not req.json()
  const header = req.headers.get("x-fiatsend-signature") ?? "";
  const sig = header.startsWith("sha256=") ? header.slice(7) : header;  // withdrawal events are prefixed
  const expected = crypto.createHmac("sha256", process.env.FIATSEND_WEBHOOK_SECRET!).update(raw).digest("hex");
  const ok = sig.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(expected, "hex"));
  if (!ok) return new Response("invalid signature", { status: 401 });

  const payload = JSON.parse(raw);
  const name = payload.type ?? payload.event;
  // ...dedupe + handle as above
  return new Response(null, { status: 200 });
}
```

## FastAPI (Python)

```python
import hashlib, hmac, json, os
from fastapi import FastAPI, Request, HTTPException

app = FastAPI()
SECRET = os.environ["FIATSEND_WEBHOOK_SECRET"].encode()

@app.post("/webhooks/fiatsend")
async def fiatsend_webhook(request: Request):
    raw = await request.body()
    sig = request.headers.get("x-fiatsend-signature", "")
    sig = sig[7:] if sig.startswith("sha256=") else sig  # withdrawal events are prefixed
    expected = hmac.new(SECRET, raw, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(sig, expected):
        raise HTTPException(status_code=401, detail="invalid signature")

    payload = json.loads(raw)
    name = payload.get("type") or payload.get("event")
    data = payload.get("data", {})
    dedup = payload.get("id") or f'{data.get("withdrawal_id")}:{data.get("status")}'
    # ...dedupe + handle
    return {"received": True}
```

## Local testing

Sign a fake payload yourself and post it:

```bash
SECRET=whsec_test
BODY='{"type":"withdrawal.completed","data":{"withdrawal_id":"wd_test","status":"completed","reference_id":"payout_1"}}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | sed 's/^.* //')
curl -X POST http://localhost:3000/webhooks/fiatsend \
  -H "Content-Type: application/json" -H "X-Fiatsend-Signature: $SIG" -d "$BODY"
```

To receive real sandbox webhooks locally, expose your port with a tunnel (e.g. `cloudflared tunnel --url http://localhost:3000` or ngrok) and register the https URL.
