/**
 * POST a webhook the way SEP-3415 asks a server to: no redirects, a bounded timeout, and
 * (unless private networks are allowed) a DNS lookup that refuses non-public addresses,
 * so the address checked is the address connected to.
 */
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";
import { isPublicAddress } from "./net.js";

export type DeliveryErrorCategory = "connection_refused" | "timeout" | "tls_error" | "http_4xx" | "http_5xx" | "challenge_failed";

export interface WebhookResponse {
  ok: boolean;
  status?: number;
  body?: string;
  /** Set when the attempt failed: the SEP's fixed category, never raw endpoint output. */
  category?: DeliveryErrorCategory;
  /** Local detail for logs (not sent anywhere). */
  detail?: string;
}

export interface PostWebhookOptions {
  /** Allow loopback and private-network addresses (dev only). */
  allowPrivateNetworks?: boolean;
  timeoutMs?: number;
  /** Largest response body to read (the verification echo is tiny). */
  maxResponseBytes?: number;
}

export class BlockedAddressError extends Error {
  override name = "BlockedAddressError";
  readonly code = "EBLOCKEDADDRESS";
}

function guardedLookup(allowPrivate: boolean): LookupFunction {
  return ((hostname: string, options: unknown, callback: (...args: unknown[]) => void) => {
    const opts = typeof options === "object" && options !== null ? (options as Record<string, unknown>) : {};
    dnsLookup(hostname, { ...opts, all: true }, (err, addresses) => {
      if (err) return callback(err);
      const list = (addresses as unknown as LookupAddress[]) ?? [];
      const usable = allowPrivate ? list : list.filter((a) => isPublicAddress(a.address));
      if (usable.length === 0) {
        return callback(new BlockedAddressError(`${hostname} resolves only to non-public addresses`));
      }
      if (opts["all"]) return callback(null, usable);
      const first = usable[0] as LookupAddress;
      return callback(null, first.address, first.family);
    });
  }) as LookupFunction;
}

export function categorize(err: unknown): DeliveryErrorCategory {
  const code = (err as { code?: string } | undefined)?.code ?? "";
  if (code === "ETIMEDOUT" || code === "ESOCKETTIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT") return "timeout";
  if (/^(ERR_TLS|ERR_SSL|CERT_|DEPTH_ZERO|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_OSSL)/.test(code)) return "tls_error";
  return "connection_refused";
}

export function postWebhook(
  url: string,
  body: string | Buffer,
  headers: Record<string, string>,
  opts: PostWebhookOptions = {},
): Promise<WebhookResponse> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const maxBytes = opts.maxResponseBytes ?? 64 * 1024;
  return new Promise((resolve) => {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      resolve({ ok: false, category: "connection_refused", detail: "invalid URL" });
      return;
    }
    const send = target.protocol === "https:" ? httpsRequest : httpRequest;
    const payload = typeof body === "string" ? Buffer.from(body, "utf8") : body;
    let settled = false;
    const finish = (r: WebhookResponse) => {
      if (!settled) {
        settled = true;
        resolve(r);
      }
    };

    const req = send(
      target,
      {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": String(payload.length), ...headers },
        lookup: guardedLookup(Boolean(opts.allowPrivateNetworks)),
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size <= maxBytes) chunks.push(c);
        });
        res.on("end", () => {
          const status = res.statusCode ?? 0;
          const text = Buffer.concat(chunks).toString("utf8");
          if (status >= 200 && status < 300) return finish({ ok: true, status, body: text });
          // Redirects are never followed (a redirect can point at an internal address); they count as a failed attempt.
          return finish({ ok: false, status, body: text, category: status >= 500 ? "http_5xx" : "http_4xx" });
        });
        res.on("error", (err) => finish({ ok: false, category: categorize(err), detail: err.message }));
      },
    );
    req.on("timeout", () => {
      req.destroy(Object.assign(new Error(`no response within ${timeoutMs} ms`), { code: "ETIMEDOUT" }));
    });
    req.on("error", (err) => finish({ ok: false, category: categorize(err), detail: err.message }));
    req.end(payload);
  });
}
