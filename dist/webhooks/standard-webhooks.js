/**
 * Standard Webhooks, as MCP Events profiles it (SEP-3415, "Webhook security"):
 *   webhook-signature: v1,<base64 HMAC-SHA256(key, webhook-id + "." + webhook-timestamp + "." + body)>
 * where key is the base64-decoded bytes after `whsec_` and body is the raw request bytes.
 *
 * When a signature does not verify, `verifyDelivery` tests the mistakes we know about
 * (the literal secret as the key, a re-serialized body, signing the eventId, hex output, ...)
 * and names the one that matches, so "signature verification failed" comes with a reason.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { TIMESTAMP_TOLERANCE_SECONDS } from "../protocol/constants.js";
export const SECRET_PREFIX = "whsec_";
const STANDARD_B64 = /^[A-Za-z0-9+/]+={0,2}$/;
const URL_SAFE_B64 = /^[A-Za-z0-9_-]+={0,2}$/;
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
/** `whsec_` + standard base64 of CSPRNG bytes (32 by default; the scheme allows 24 to 64). */
export function generateSecret(bytes = 32) {
    if (bytes < 24 || bytes > 64)
        throw new RangeError("Standard Webhooks secrets are 24 to 64 bytes");
    return SECRET_PREFIX + randomBytes(bytes).toString("base64");
}
/** Why a value is not a valid Standard Webhooks symmetric secret, or null when it is. */
export function secretProblem(secret) {
    if (typeof secret !== "string")
        return "the secret must be a string";
    if (!secret.startsWith(SECRET_PREFIX))
        return 'the secret must start with "whsec_"';
    const body = secret.slice(SECRET_PREFIX.length);
    if (body.length === 0)
        return "nothing follows whsec_";
    if (!STANDARD_B64.test(body)) {
        return URL_SAFE_B64.test(body)
            ? "the part after whsec_ is URL-safe base64, but the scheme uses standard base64 (+ and /)"
            : "the part after whsec_ is not base64";
    }
    const decoded = Buffer.from(body, "base64");
    if (decoded.toString("base64").replace(/=+$/, "") !== body.replace(/=+$/, ""))
        return "the part after whsec_ is not valid base64";
    if (decoded.length < 24 || decoded.length > 64)
        return `the secret decodes to ${decoded.length} bytes; it must be 24 to 64`;
    return null;
}
/** The HMAC key for a secret: the base64-decoded bytes after the prefix. */
export function secretKey(secret) {
    return Buffer.from(secret.slice(SECRET_PREFIX.length), "base64");
}
export function hmacBase64(key, webhookId, timestamp, body) {
    return createHmac("sha256", key).update(`${webhookId}.${timestamp}.`, "utf8").update(body).digest("base64");
}
/** A `webhook-signature` header value. Several secrets give a space-delimited list (rotation). */
export function signatureHeader(secrets, webhookId, timestamp, body) {
    return secrets.map((s) => `v1,${hmacBase64(secretKey(s), webhookId, timestamp, body)}`).join(" ");
}
/** A high-entropy, header-safe message id: `msg_` + 24 base62 characters (or msg_<type>_ for envelopes). */
export function makeWebhookId(type) {
    const bytes = randomBytes(24);
    let id = "";
    for (const b of bytes)
        id += BASE62[b % 62];
    return type ? `msg_${type}_${id}` : `msg_${id}`;
}
export function isHeaderSafeId(id) {
    return /^[A-Za-z0-9_-]+$/.test(id);
}
export function signDelivery(opts) {
    const webhookId = opts.webhookId ?? makeWebhookId();
    const timestamp = String(opts.timestamp ?? Math.floor(Date.now() / 1000));
    return {
        "webhook-id": webhookId,
        "webhook-timestamp": timestamp,
        "webhook-signature": signatureHeader(opts.secrets, webhookId, timestamp, opts.body),
    };
}
function safeEqual(a, b) {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    return ab.length === bb.length && timingSafeEqual(ab, bb);
}
function parseSignatures(header) {
    const raw = header.split(" ").filter((s) => s.length > 0);
    const v1 = [];
    let v1a = false;
    for (const entry of raw) {
        const comma = entry.indexOf(",");
        if (comma === -1)
            continue;
        const version = entry.slice(0, comma);
        if (version === "v1")
            v1.push(entry.slice(comma + 1));
        else if (version === "v1a" || version === "v2a")
            v1a = true;
    }
    return { v1, v1a, raw };
}
export function verifyDelivery(input) {
    const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
    const tolerance = input.toleranceSeconds ?? TIMESTAMP_TOLERANCE_SECONDS;
    const { webhookId, timestamp, signature, body } = input;
    if (!webhookId || !timestamp || !signature) {
        const missing = [!webhookId && "webhook-id", !timestamp && "webhook-timestamp", !signature && "webhook-signature"].filter(Boolean);
        return { ok: false, failure: "missing-headers", message: `missing ${missing.join(", ")}`, v1Count: 0, v1aPresent: false };
    }
    const parsed = parseSignatures(signature);
    if (!/^\d+$/.test(timestamp)) {
        return {
            ok: false,
            failure: "bad-timestamp",
            message: `webhook-timestamp "${timestamp}" is not a Unix time in seconds`,
            v1Count: parsed.v1.length,
            v1aPresent: parsed.v1a,
        };
    }
    const ageSeconds = now - Number(timestamp);
    if (parsed.v1.length === 0) {
        const diagnosis = parsed.raw.length > 0 && !signature.includes(",")
            ? 'the header has no "v1," prefix; write it as v1,<base64 signature>'
            : undefined;
        return {
            ok: false,
            failure: "no-v1-signature",
            message: "no v1 signature in webhook-signature",
            diagnosis,
            v1Count: 0,
            v1aPresent: parsed.v1a,
            ageSeconds,
        };
    }
    const matched = input.secrets.some((secret) => {
        if (secretProblem(secret) !== null)
            return false;
        const expected = hmacBase64(secretKey(secret), webhookId, timestamp, body);
        return parsed.v1.some((sig) => safeEqual(sig, expected));
    });
    if (!matched) {
        return {
            ok: false,
            failure: "signature-mismatch",
            message: "no v1 signature matches the subscription secret",
            diagnosis: diagnoseMismatch(input.secrets, webhookId, timestamp, parsed.v1, body),
            v1Count: parsed.v1.length,
            v1aPresent: parsed.v1a,
            ageSeconds,
        };
    }
    if (Number(timestamp) > 1e11) {
        return {
            ok: false,
            failure: "bad-timestamp",
            message: "webhook-timestamp looks like milliseconds; Standard Webhooks uses seconds",
            v1Count: parsed.v1.length,
            v1aPresent: parsed.v1a,
            ageSeconds,
        };
    }
    if (ageSeconds > tolerance) {
        return {
            ok: false,
            failure: "stale-timestamp",
            message: `webhook-timestamp is ${ageSeconds}s old (receivers reject anything older than ${tolerance}s); retries must re-sign with a fresh timestamp`,
            v1Count: parsed.v1.length,
            v1aPresent: parsed.v1a,
            ageSeconds,
        };
    }
    if (ageSeconds < -tolerance) {
        return {
            ok: false,
            failure: "future-timestamp",
            message: `webhook-timestamp is ${-ageSeconds}s in the future; check the sender's clock`,
            v1Count: parsed.v1.length,
            v1aPresent: parsed.v1a,
            ageSeconds,
        };
    }
    return { ok: true, message: "signature verified", v1Count: parsed.v1.length, v1aPresent: parsed.v1a, ageSeconds };
}
/** Reproduce the sender's signature with known mistakes. Returns a fix, or a generic hint. */
export function diagnoseMismatch(secrets, webhookId, timestamp, sent, body) {
    const usable = secrets.filter((s) => secretProblem(s) === null);
    const matches = (key, id, ts, payload, encoding = "base64") => sent.some((sig) => {
        const mac = createHmac("sha256", key).update(`${id}.${ts}.`, "utf8").update(payload).digest(encoding);
        return safeEqual(sig, mac);
    });
    let eventId;
    let reserialized;
    try {
        const json = JSON.parse(body.toString("utf8"));
        if (json && typeof json === "object" && !Array.isArray(json)) {
            const maybe = json["eventId"];
            if (typeof maybe === "string")
                eventId = maybe;
        }
        const again = JSON.stringify(json);
        if (again !== body.toString("utf8"))
            reserialized = again;
    }
    catch {
        // not JSON; the body checks below still apply
    }
    for (const secret of usable) {
        const key = secretKey(secret);
        if (matches(Buffer.from(secret, "utf8"), webhookId, timestamp, body)) {
            return 'the sender used the literal "whsec_…" string as the HMAC key; decode the base64 after the prefix and use those bytes';
        }
        if (matches(Buffer.from(secret.slice(SECRET_PREFIX.length), "utf8"), webhookId, timestamp, body)) {
            return "the sender used the base64 text as the HMAC key; decode it to bytes first";
        }
        if (matches(key, webhookId, timestamp, body, "hex")) {
            return "the sender encoded the HMAC as hex; Standard Webhooks signatures are base64";
        }
        if (reserialized !== undefined && matches(key, webhookId, timestamp, reserialized)) {
            return "the sender signed a re-serialized copy of the JSON, not the bytes it sent; sign the exact body bytes";
        }
        if (eventId !== undefined && eventId !== webhookId && matches(key, eventId, timestamp, body)) {
            return "the sender signed over the eventId, but sent a different webhook-id header; sign the webhook-id you send";
        }
        if (matches(key, webhookId, String(Number(timestamp) * 1000), body)) {
            return "the sender signed a millisecond timestamp but sent seconds in webhook-timestamp";
        }
        if (matches(key, "", timestamp, body) || matches(key, webhookId, "", body)) {
            return "the sender left the webhook-id or webhook-timestamp out of the signed content (it must be id.timestamp.body)";
        }
    }
    return "none of the common mistakes reproduce it: the sender probably signed with a different secret (after a rotation, sign with the newest one, or both during the grace window)";
}
