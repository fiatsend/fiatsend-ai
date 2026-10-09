// Thin, dependency-free client for the Fiatsend Partner API.
import crypto from "node:crypto";

export type Mode = "test" | "live";

export interface Config {
  apiKey: string;
  mode: Mode;
  baseUrl: string;      // withdrawals, rates, networks, webhooks…
  checkoutUrl: string;  // checkout sessions (same host for test and live)
  allowLivePayouts: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const apiKey = env.FIATSEND_API_KEY?.trim() ?? "";
  if (!apiKey) {
    throw new Error("FIATSEND_API_KEY is not set. Create a sandbox key (fs_test_…) at https://console.fiatsend.com → Developers → API Keys.");
  }
  if (!/^fs_(test|live)_/.test(apiKey)) {
    throw new Error("FIATSEND_API_KEY must start with fs_test_ (sandbox) or fs_live_ (production).");
  }
  const mode: Mode = apiKey.startsWith("fs_live_") ? "live" : "test";
  const defaultBase = mode === "live" ? "https://api.fiatsend.com/v1" : "https://sandbox.fiatsend.com/v1";
  return {
    apiKey,
    mode,
    baseUrl: (env.FIATSEND_BASE_URL || defaultBase).replace(/\/+$/, ""),
    checkoutUrl: (env.FIATSEND_CHECKOUT_URL || "https://api.fiatsend.com/v1").replace(/\/+$/, ""),
    allowLivePayouts: env.FIATSEND_ALLOW_LIVE_PAYOUTS === "true",
  };
}

export class FiatsendError extends Error {
  constructor(public status: number, public code: string, message: string, public body?: unknown) {
    super(`Fiatsend ${status} ${code}: ${message}`);
  }
  get retryable(): boolean {
    return [429, 500, 502, 503].includes(this.status);
  }
}

type Query = Record<string, string | number | undefined>;

export class FiatsendClient {
  constructor(private cfg: Config, private fetchImpl: typeof fetch = fetch) {}

  get mode() { return this.cfg.mode; }

  async request<T = any>(
    method: string,
    path: string,
    opts: { query?: Query; body?: unknown; checkout?: boolean; auth?: boolean } = {},
  ): Promise<T> {
    const base = opts.checkout ? this.cfg.checkoutUrl : this.cfg.baseUrl;
    const url = new URL(base + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    }
    const headers: Record<string, string> = { Accept: "application/json", "User-Agent": "fiatsend-mcp/0.1.0" };
    if (opts.auth !== false) headers.Authorization = `Bearer ${this.cfg.apiKey}`;
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";

    const res = await this.fetchImpl(url, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 204) return null as T;
    const text = await res.text();
    let body: any = text;
    try { body = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }

    if (!res.ok) {
      // Two documented shapes: {status,code,message} and {error:{code,message}}
      const err = body?.error ?? body ?? {};
      throw new FiatsendError(res.status, err.code ?? `HTTP_${res.status}`, err.message ?? String(text).slice(0, 300), body);
    }
    return body as T;
  }
}

/** Normalise a Ghana mobile number to E.164 (+233XXXXXXXXX). Throws if it can't. */
export function normaliseGhanaPhone(input: string): string {
  let d = input.replace(/\D/g, "");
  if (d.startsWith("233")) d = d.slice(3);
  else if (d.startsWith("0")) d = d.slice(1);
  if (!/^\d{9}$/.test(d)) throw new Error(`"${input}" is not a valid Ghana mobile number (expected +233 followed by 9 digits).`);
  return `+233${d}`;
}

/** Verify X-Fiatsend-Signature: hex HMAC-SHA256 of the raw body. */
export function verifySignature(rawBody: string, signature: string, secret: string): boolean {
  const expected = crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  const a = Buffer.from(signature.trim().toLowerCase(), "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
