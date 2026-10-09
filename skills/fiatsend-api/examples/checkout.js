// Fiatsend hosted checkout starter (Node 18+, Express).
// npm i express  ·  FIATSEND_API_KEY=fs_test_... FIATSEND_WEBHOOK_SECRET=... node checkout.js
import express from "express";
import crypto from "node:crypto";

const API = "https://api.fiatsend.com/v1"; // checkout uses this host for test AND live keys
const app = express();

// 1) Create a session on your server, then redirect the customer.
app.post("/pay/:orderId", express.json(), async (req, res) => {
  const order = { id: req.params.orderId, total: 50.0 }; // load from your DB
  const r = await fetch(`${API}/checkout/sessions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.FIATSEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      amount: order.total,
      currency: "GHS",
      description: `Order ${order.id}`,
      client_reference_id: order.id,
      success_url: "https://yourshop.com/thanks?session={SESSION_ID}",
      cancel_url: "https://yourshop.com/cart",
    }),
  });
  const session = await r.json();
  if (!r.ok) return res.status(r.status).json(session);
  res.redirect(303, session.url);
});

// 2) Fulfil only from the signed webhook (or a server-side GET).
app.post("/webhooks/fiatsend", express.raw({ type: "application/json" }), (req, res) => {
  const sig = req.get("x-fiatsend-signature") ?? "";
  const expected = crypto
    .createHmac("sha256", process.env.FIATSEND_WEBHOOK_SECRET)
    .update(req.body)
    .digest("hex");
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    return res.sendStatus(401);
  }
  const evt = JSON.parse(req.body.toString("utf8"));
  if (evt.event === "checkout.session.completed") {
    const s = evt.data.object;
    console.log(`Order ${s.client_reference_id} paid via ${s.paid_via} (event ${evt.id})`);
    // markOrderPaid(s.client_reference_id) — idempotently, keyed on evt.id
  }
  res.sendStatus(200);
});

// 3) Thank-you page: double-check status server-side before showing "paid".
app.get("/thanks", async (req, res) => {
  const r = await fetch(`${API}/checkout/sessions/${encodeURIComponent(req.query.session)}`, {
    headers: { Authorization: `Bearer ${process.env.FIATSEND_API_KEY}` },
  });
  const s = await r.json();
  res.send(s.status === "complete" ? "Payment received!" : "Payment pending…");
});

app.listen(3000, () => console.log("http://localhost:3000"));
