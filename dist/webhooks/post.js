/**
 * POST a webhook the way SEP-3415 asks a server to: no redirects, a bounded timeout, and
 * (unless private networks are allowed) a DNS lookup that refuses non-public addresses,
 * so the address checked is the address connected to.
 */
import { lookup as dnsLookup } from "node:dns";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isPublicAddress } from "./net.js";
export class BlockedAddressError extends Error {
    name = "BlockedAddressError";
    code = "EBLOCKEDADDRESS";
}
function guardedLookup(allowPrivate) {
    return ((hostname, options, callback) => {
        const opts = typeof options === "object" && options !== null ? options : {};
        dnsLookup(hostname, { ...opts, all: true }, (err, addresses) => {
            if (err)
                return callback(err);
            const list = addresses ?? [];
            const usable = allowPrivate ? list : list.filter((a) => isPublicAddress(a.address));
            if (usable.length === 0) {
                return callback(new BlockedAddressError(`${hostname} resolves only to non-public addresses`));
            }
            if (opts["all"])
                return callback(null, usable);
            // One address wanted (Node 18 has no happy-eyeballs fallback): prefer IPv4, as Node did before v17,
            // so "localhost" reaches a receiver bound to 127.0.0.1 instead of failing on ::1.
            const first = (usable.find((a) => a.family === 4) ?? usable[0]);
            return callback(null, first.address, first.family);
        });
    });
}
export function categorize(err) {
    const code = err?.code ?? "";
    if (code === "ETIMEDOUT" || code === "ESOCKETTIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT")
        return "timeout";
    if (/^(ERR_TLS|ERR_SSL|CERT_|DEPTH_ZERO|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_OSSL)/.test(code))
        return "tls_error";
    return "connection_refused";
}
export function postWebhook(url, body, headers, opts = {}) {
    const timeoutMs = opts.timeoutMs ?? 5000;
    const maxBytes = opts.maxResponseBytes ?? 64 * 1024;
    return new Promise((resolve) => {
        let target;
        try {
            target = new URL(url);
        }
        catch {
            resolve({ ok: false, category: "connection_refused", detail: "invalid URL" });
            return;
        }
        const send = target.protocol === "https:" ? httpsRequest : httpRequest;
        const payload = typeof body === "string" ? Buffer.from(body, "utf8") : body;
        let settled = false;
        const finish = (r) => {
            if (!settled) {
                settled = true;
                resolve(r);
            }
        };
        const req = send(target, {
            method: "POST",
            headers: { "content-type": "application/json", "content-length": String(payload.length), ...headers },
            lookup: guardedLookup(Boolean(opts.allowPrivateNetworks)),
            timeout: timeoutMs,
        }, (res) => {
            const chunks = [];
            let size = 0;
            res.on("data", (c) => {
                size += c.length;
                if (size <= maxBytes)
                    chunks.push(c);
            });
            res.on("end", () => {
                const status = res.statusCode ?? 0;
                const text = Buffer.concat(chunks).toString("utf8");
                if (status >= 200 && status < 300)
                    return finish({ ok: true, status, body: text });
                // Redirects are never followed (a redirect can point at an internal address); they count as a failed attempt.
                return finish({ ok: false, status, body: text, category: status >= 500 ? "http_5xx" : "http_4xx" });
            });
            res.on("error", (err) => finish({ ok: false, category: categorize(err), detail: err.message }));
        });
        req.on("timeout", () => {
            req.destroy(Object.assign(new Error(`no response within ${timeoutMs} ms`), { code: "ETIMEDOUT" }));
        });
        req.on("error", (err) => finish({ ok: false, category: categorize(err), detail: err.message }));
        req.end(payload);
    });
}
