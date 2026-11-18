/**
 * The bundled reference MCP Events server.
 *
 * Strict by default: callbacks must be https and publicly routable, secrets must be valid
 * whsec_ values, and webhook subscriptions need an authenticated principal (a bearer token).
 * `allowLoopbackCallbacks` relaxes exactly the callback checks so a local receiver works
 * offline, which is what `hookbench demo` uses. Every fault in FAULTS breaks one rule, for
 * the deliberately broken fixtures in the test suite.
 *
 * Dev-only endpoints, outside the MCP endpoint:
 *   POST /hookbench/fire       {name, data?, eventId?}  emit an event now
 *   POST /hookbench/terminate  {name, reason?}          end every subscription to an event type
 *   GET  /hookbench                                     server state, as JSON
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import { createServer } from "node:http";
import { isIP } from "node:net";
import { ERROR, EVENTS_EXTENSION, META, METHODS, NAMED_METHODS, NOTIFICATIONS, PROTOCOL_VERSION, } from "../protocol/constants.js";
import { annotatedProperties, decodeHeaderValue, headerForm } from "../protocol/headers.js";
import { isObject, rpcError, rpcResult } from "../protocol/jsonrpc.js";
import { getProfile } from "../protocol/profiles.js";
import { validate } from "../protocol/schema-lite.js";
import { closeServer, headerMap, hostForUrl, listen, readBody, sendEmpty, sendJson } from "../util/http.js";
import { VERSION } from "../version.js";
import { isLoopbackHost, isPublicAddress } from "../webhooks/net.js";
import { postWebhook } from "../webhooks/post.js";
import { hmacBase64, makeWebhookId, secretProblem, signatureHeader, signDelivery, } from "../webhooks/standard-webhooks.js";
import { catalogFor, matchesArguments } from "./catalog.js";
/** Each fault breaks one conformance rule. The fixtures in tests/ use them. */
export const FAULTS = {
    "no-discover": "server/discover is not implemented",
    "discover-no-result-type": "server/discover leaves out resultType",
    "no-capability": "server/discover does not advertise Events",
    "list-not-array": "events/list returns events as an object, not an array",
    "descriptor-no-payload-schema": "an event type has no payloadSchema",
    "bad-pagination": "events/list hands out a nextCursor that then fails",
    "unknown-event-wrong-code": "an unknown event name gets InvalidParams instead of NotFound",
    "unsupported-mode-accepted": "a delivery mode an event type does not list is served anyway",
    "no-argument-validation": "subscription arguments are not checked against inputSchema",
    "ignore-mcp-name": "the Mcp-Name header is not checked against params.name",
    "poll-replays-on-null-cursor": "a poll with cursor null returns past events",
    "poll-missing-fields": "poll results leave out hasMore, nextPollMs and truncated",
    "poll-rejects-cursor": "a poll with the cursor the server just returned fails",
    "poll-occurrence-missing-timestamp": "polled events have no timestamp",
    "stream-no-active": "events/stream does not open with notifications/events/active",
    "stream-no-subscription-id": "stream notifications leave out the subscription id",
    "stream-no-heartbeat": "events/stream never sends a heartbeat",
    "stream-occurrence-bad-data": "streamed events carry data that breaks payloadSchema",
    "no-auth-required": "events/subscribe works without an authenticated principal",
    "accept-http-callback": "events/subscribe accepts an http:// callback",
    "accept-bad-secret": "events/subscribe accepts a malformed whsec_ secret",
    "no-ssrf-check": "events/subscribe accepts a callback on a loopback address",
    "skip-verification": "the callback is never verified before deliveries start",
    "subscribe-no-refresh-before": "the subscribe result has no refreshBefore",
    "non-idempotent-subscribe": "subscribing twice with the same key creates two subscriptions",
    "ttl-exceeds-suggestion": "the granted TTL is longer than the client asked for",
    "null-refresh-before": "a finite ttlMs is granted no expiry",
    "unsubscribe-noop": "events/unsubscribe answers success but deliveries continue",
    "unsubscribe-unknown-ok": "unsubscribing an unknown subscription succeeds",
    "no-subscription-id-header": "event deliveries leave out X-MCP-Subscription-Id",
    "sign-with-literal-secret": "event deliveries are signed with the literal whsec_ string as the key",
    "webhook-id-from-event-id": "webhook-id is the eventId (the ChatGPT dialect, against SEP-3415)",
    "stale-timestamp": "event deliveries carry a webhook-timestamp ten minutes old",
    "delivery-wrong-name": "event deliveries name a different event type than the subscription",
    "oversized-delivery": "event deliveries are larger than 256 KiB",
};
class Failure extends Error {
    code;
    data;
    httpStatus;
    constructor(code, message, data, httpStatus = 200) {
        super(message);
        this.code = code;
        this.data = data;
        this.httpStatus = httpStatus;
    }
}
function canonical(value) {
    if (Array.isArray(value))
        return `[${value.map(canonical).join(",")}]`;
    if (isObject(value)) {
        return `{${Object.keys(value)
            .sort()
            .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
            .join(",")}}`;
    }
    return JSON.stringify(value) ?? "null";
}
function safeEqual(a, b) {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    return ab.length === bb.length && timingSafeEqual(ab, bb);
}
function isLocalOrigin(origin) {
    try {
        return isLoopbackHost(new URL(origin).hostname);
    }
    catch {
        return false;
    }
}
export async function startReferenceServer(opts = {}) {
    const profile = getProfile(opts.profile);
    const faults = new Set(opts.faults ?? []);
    for (const f of faults)
        if (!(f in FAULTS))
            throw new Error(`unknown fault "${f}"`);
    const has = (f) => faults.has(f);
    const log = opts.log ?? (() => { });
    const tokens = opts.tokens ?? { "hookbench-dev": "dev" };
    const hb = { defaultMs: 30_000, minMs: 1000, maxMs: 60_000, ...opts.heartbeat };
    const ttl = { defaultMs: 30 * 60_000, minMs: 10_000, maxMs: 24 * 60 * 60_000, ...opts.ttl };
    const retry = { attempts: 3, baseDelayMs: 500, timeoutMs: 5000, ...opts.retry };
    const nextPollMs = opts.nextPollMs ?? 2000;
    const allowLoopback = Boolean(opts.allowLoopbackCallbacks);
    const errors = profile.errors;
    const legacyCodes = profile.name === "chatgpt";
    const catalog = catalogFor(profile.modes);
    const epoch = randomBytes(4).toString("hex");
    const logs = new Map();
    for (const e of catalog)
        logs.set(e.descriptor.name, { entries: [], head: 0 });
    const counters = new Map();
    const pushSubs = new Set();
    const webhookSubs = new Map();
    const verified = new Map();
    const timers = [];
    const entryFor = (name) => catalog.find((e) => e.descriptor.name === name);
    const cursorString = (seq) => `c_${epoch}.${seq}`;
    const parseCursor = (c) => {
        const m = /^c_([0-9a-f]+)\.(\d+)$/.exec(c);
        return m ? { epoch: m[1], seq: Number(m[2]) } : undefined;
    };
    const complete = (result, era) => era === "modern" ? { resultType: "complete", ...result } : result;
    function capabilities() {
        const caps = { tools: {} };
        if (has("no-capability"))
            return caps;
        if (profile.capability === "top-level")
            caps["events"] = {};
        else
            caps["extensions"] = { [EVENTS_EXTENSION]: {} };
        return caps;
    }
    function principalOf(h) {
        const auth = h["authorization"];
        const m = auth ? /^Bearer\s+(.+)$/i.exec(auth) : null;
        const token = m?.[1]?.trim();
        return token !== undefined && tokens[token] !== undefined ? tokens[token] : null;
    }
    function target(params, mode) {
        const name = params["name"];
        if (typeof name !== "string" || name.length === 0)
            throw new Failure(ERROR.InvalidParams, "params.name is required");
        const entry = entryFor(name);
        if (!entry) {
            if (has("unknown-event-wrong-code"))
                throw new Failure(ERROR.InvalidParams, `unknown event type "${name}"`);
            throw new Failure(errors.NotFound, `unknown event type "${name}"`, { kind: "event" });
        }
        if (!entry.descriptor.delivery.includes(mode) && !has("unsupported-mode-accepted")) {
            throw new Failure(errors.Unsupported, `${name} does not offer ${mode} delivery`, { feature: "deliveryMode", value: mode });
        }
        const rawArgs = params["arguments"];
        if (rawArgs !== undefined && rawArgs !== null && !isObject(rawArgs))
            throw new Failure(ERROR.InvalidParams, "arguments must be an object");
        const args = isObject(rawArgs) ? rawArgs : {};
        if (!has("no-argument-validation")) {
            const problems = validate(args, entry.descriptor.inputSchema, "arguments");
            if (problems.length > 0)
                throw new Failure(ERROR.InvalidParams, `arguments do not match inputSchema: ${problems.join("; ")}`, { errors: problems });
        }
        return { entry, args };
    }
    /** Where delivery starts for a cursor: { seq, truncated }. */
    function startFrom(name, cursor, maxAgeMs) {
        const l = logs.get(name);
        if (cursor === null || cursor === undefined)
            return { seq: l.head, truncated: false };
        if (typeof cursor !== "string")
            throw new Failure(ERROR.InvalidParams, "cursor must be a string or null");
        const parsed = parseCursor(cursor);
        if (!parsed)
            throw new Failure(ERROR.InvalidParams, "unknown cursor", { cursor });
        if (parsed.epoch !== epoch)
            return { seq: l.head, truncated: true };
        if (parsed.seq > l.head)
            throw new Failure(ERROR.InvalidParams, "cursor is ahead of this server", { cursor });
        let seq = parsed.seq;
        let truncated = false;
        const oldest = l.entries[0]?.seq;
        if (oldest !== undefined && seq < oldest - 1) {
            seq = oldest - 1;
            truncated = true;
        }
        if (typeof maxAgeMs === "number" && maxAgeMs >= 0) {
            const floor = Date.now() - maxAgeMs;
            const skipped = l.entries.filter((e) => e.seq > seq && e.at < floor);
            if (skipped.length > 0) {
                seq = skipped[skipped.length - 1].seq;
                truncated = true;
            }
        }
        return { seq, truncated };
    }
    // ---------- events/list ----------
    function listEvents(params) {
        const descriptors = catalog.map((e) => ({ ...e.descriptor }));
        if (has("descriptor-no-payload-schema") && descriptors[0])
            delete descriptors[0]["payloadSchema"];
        const pageSize = 2;
        const cursor = params["cursor"];
        let start = 0;
        if (cursor !== undefined && cursor !== null) {
            const m = typeof cursor === "string" ? /^page_(\d+)$/.exec(cursor) : null;
            if (!m)
                throw new Failure(ERROR.InvalidParams, "unknown events/list cursor", { cursor });
            start = Number(m[1]);
        }
        const page = descriptors.slice(start, start + pageSize);
        const result = { events: page };
        if (start + pageSize < descriptors.length)
            result["nextCursor"] = has("bad-pagination") ? "broken_cursor" : `page_${start + pageSize}`;
        if (has("list-not-array"))
            result["events"] = Object.fromEntries(page.map((d) => [String(d["name"]), d]));
        return result;
    }
    // ---------- events/poll ----------
    function poll(params) {
        const { entry, args } = target(params, "poll");
        const name = entry.descriptor.name;
        const l = logs.get(name);
        const maxEvents = typeof params["maxEvents"] === "number" && params["maxEvents"] > 0 ? Math.min(params["maxEvents"], 500) : 50;
        const cursor = params["cursor"];
        let events = [];
        let truncated = false;
        let hasMore = false;
        let position = l.head;
        if (cursor === null || cursor === undefined) {
            if (has("poll-replays-on-null-cursor")) {
                events = l.entries.filter((e) => matchesArguments(e.occurrence.data, args)).slice(-3).map((e) => e.occurrence);
            }
        }
        else {
            if (has("poll-rejects-cursor"))
                throw new Failure(ERROR.InvalidParams, "unknown cursor", { cursor });
            const start = startFrom(name, cursor, params["maxAgeMs"]);
            truncated = start.truncated;
            const pending = l.entries.filter((e) => e.seq > start.seq);
            position = start.seq;
            for (const e of pending) {
                if (events.length >= maxEvents) {
                    hasMore = true;
                    break;
                }
                position = e.seq;
                if (matchesArguments(e.occurrence.data, args))
                    events.push(e.occurrence);
            }
            if (!hasMore)
                position = l.head;
        }
        const shaped = events.map((o) => {
            const copy = { ...o };
            if (has("poll-occurrence-missing-timestamp"))
                delete copy["timestamp"];
            return copy;
        });
        const result = { events: shaped, cursor: entry.replay ? cursorString(position) : null };
        if (!has("poll-missing-fields")) {
            result["truncated"] = truncated;
            result["hasMore"] = hasMore;
            result["nextPollMs"] = nextPollMs;
        }
        log(`events/poll ${name} -> ${shaped.length} event(s)`);
        return result;
    }
    // ---------- events/stream ----------
    function writeSse(sub, message) {
        if (sub.closed)
            return;
        sub.res.write(`data: ${JSON.stringify(message)}\n\n`);
        sub.lastWrite = Date.now();
    }
    function streamMeta(sub) {
        return has("stream-no-subscription-id") ? undefined : { [META.subscriptionId]: sub.id };
    }
    function streamNotification(sub, method, params) {
        const meta = streamMeta(sub);
        writeSse(sub, { jsonrpc: "2.0", method, params: meta ? { ...params, _meta: meta } : params });
    }
    function pushEvent(sub, entry, ev) {
        const occurrence = { ...ev.occurrence, cursor: entry.replay ? cursorString(ev.seq) : null };
        if (has("stream-occurrence-bad-data"))
            occurrence["data"] = { unexpected: 42 };
        streamNotification(sub, NOTIFICATIONS.event, occurrence);
    }
    function closePush(sub) {
        if (sub.closed)
            return;
        sub.closed = true;
        if (sub.timer)
            clearInterval(sub.timer);
        pushSubs.delete(sub);
    }
    function openStream(id, params, res) {
        const { entry, args } = target(params, "push");
        const name = entry.descriptor.name;
        const start = entry.replay ? startFrom(name, params["cursor"], params["maxAgeMs"]) : { seq: logs.get(name).head, truncated: false };
        const suggested = typeof params["heartbeatMs"] === "number" ? params["heartbeatMs"] : hb.defaultMs;
        const heartbeatMs = Math.min(Math.max(suggested, hb.minMs), hb.maxMs);
        res.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-store",
            "x-accel-buffering": "no",
            connection: "keep-alive",
        });
        const sub = { id, name, args, res, heartbeatMs, lastWrite: Date.now(), closed: false };
        pushSubs.add(sub);
        res.on("close", () => closePush(sub));
        const position = () => (entry.replay ? cursorString(logs.get(name).head) : null);
        if (!has("stream-no-active")) {
            streamNotification(sub, NOTIFICATIONS.active, {
                cursor: entry.replay ? cursorString(start.seq) : null,
                truncated: start.truncated,
                heartbeatMs,
            });
        }
        const l = logs.get(name);
        for (const ev of l.entries) {
            if (ev.seq > start.seq && matchesArguments(ev.occurrence.data, args))
                pushEvent(sub, entry, ev);
        }
        if (!has("stream-no-heartbeat")) {
            sub.timer = setInterval(() => {
                if (Date.now() - sub.lastWrite >= heartbeatMs)
                    streamNotification(sub, NOTIFICATIONS.heartbeat, { cursor: position() });
            }, Math.max(50, Math.min(1000, Math.floor(heartbeatMs / 4))));
        }
        log(`events/stream ${name} open (heartbeat ${heartbeatMs} ms)`);
    }
    // ---------- webhook: subscribe / unsubscribe / deliver ----------
    async function checkCallback(url) {
        if (allowLoopback || has("no-ssrf-check"))
            return;
        const host = url.hostname.replace(/^\[|\]$/g, "");
        if (isIP(host)) {
            if (!isPublicAddress(host))
                throw new Failure(ERROR.InvalidParams, "delivery.url points at a non-public address", { reason: "callback_not_routable" });
            return;
        }
        let addresses;
        try {
            addresses = await lookup(host, { all: true });
        }
        catch {
            throw new Failure(errors.CallbackEndpointError, "callback endpoint could not be reached", { reason: "connection_refused" });
        }
        if (addresses.length === 0 || addresses.some((a) => !isPublicAddress(a.address))) {
            throw new Failure(ERROR.InvalidParams, "delivery.url resolves to a non-public address", { reason: "callback_not_routable" });
        }
    }
    async function verifyEndpoint(sub, secret) {
        const cacheKey = `${sub.principal}\u0000${sub.url}`;
        const cachedUntil = verified.get(cacheKey);
        if (has("skip-verification") || (cachedUntil !== undefined && cachedUntil > Date.now()))
            return;
        const challenge = randomBytes(18).toString("base64url");
        const body = JSON.stringify({ type: "verification", challenge });
        const headers = {
            ...signDelivery({ secrets: [secret], body, webhookId: makeWebhookId("verification") }),
            "x-mcp-subscription-id": sub.id,
        };
        const resp = await postWebhook(sub.url, body, headers, { allowPrivateNetworks: allowLoopback, timeoutMs: retry.timeoutMs });
        if (!resp.ok) {
            log(`verification of ${sub.url} failed: ${resp.category}`);
            throw new Failure(errors.CallbackEndpointError, "callback endpoint failed verification", { reason: resp.category });
        }
        let echoed;
        try {
            echoed = isObject(JSON.parse(resp.body ?? "")) ? JSON.parse(resp.body ?? "")["challenge"] : undefined;
        }
        catch {
            echoed = undefined;
        }
        if (typeof echoed !== "string" || !safeEqual(echoed, challenge)) {
            log(`verification of ${sub.url} failed: challenge not echoed`);
            throw new Failure(errors.CallbackEndpointError, "callback endpoint did not echo the challenge", { reason: "challenge_failed" });
        }
        verified.set(cacheKey, Date.now() + 60 * 60_000);
    }
    function grant(ttlMs) {
        if (has("null-refresh-before"))
            return null;
        let ms;
        if (ttlMs === undefined)
            ms = ttl.defaultMs;
        else if (ttlMs === null)
            ms = ttl.maxMs; // held in memory: never grant no expiry
        else if (typeof ttlMs !== "number" || !Number.isFinite(ttlMs) || ttlMs < 0)
            throw new Failure(ERROR.InvalidParams, "ttlMs must be a non-negative number or null");
        else
            ms = Math.min(Math.max(ttlMs, ttl.minMs), ttl.maxMs);
        if (has("ttl-exceeds-suggestion"))
            ms = (typeof ttlMs === "number" ? ttlMs : ttl.defaultMs) * 2 + 60_000;
        return Date.now() + ms;
    }
    function deliveryStatus(sub) {
        const s = {
            active: sub.active,
            lastDeliveryAt: sub.lastDeliveryAt ? new Date(sub.lastDeliveryAt).toISOString() : null,
            lastError: sub.lastError,
        };
        if (sub.failedSince)
            s["failedSince"] = new Date(sub.failedSince).toISOString();
        return s;
    }
    async function subscribe(params, h) {
        let principal = principalOf(h);
        if (principal === null) {
            if (!has("no-auth-required"))
                throw new Failure(errors.Forbidden, "events/subscribe needs an authenticated principal", { reason: "unauthenticated" });
            principal = "anonymous";
        }
        const { entry, args } = target(params, "webhook");
        const name = entry.descriptor.name;
        const delivery = params["delivery"];
        if (!isObject(delivery))
            throw new Failure(ERROR.InvalidParams, "delivery is required");
        if (delivery["mode"] !== "webhook")
            throw new Failure(ERROR.InvalidParams, 'delivery.mode must be "webhook"');
        if (typeof delivery["url"] !== "string")
            throw new Failure(ERROR.InvalidParams, "delivery.url is required");
        let url;
        try {
            url = new URL(delivery["url"]);
        }
        catch {
            throw new Failure(ERROR.InvalidParams, "delivery.url is not a valid URL");
        }
        const loopbackHttp = url.protocol === "http:" && allowLoopback && isLoopbackHost(url.hostname);
        if (url.protocol !== "https:" && !loopbackHttp && !(url.protocol === "http:" && has("accept-http-callback"))) {
            throw new Failure(ERROR.InvalidParams, "delivery.url must use https");
        }
        const secret = delivery["secret"];
        const problem = secretProblem(secret);
        if (problem && !has("accept-bad-secret"))
            throw new Failure(ERROR.InvalidParams, `delivery.secret is invalid: ${problem}`);
        await checkCallback(url);
        const urlString = delivery["url"];
        const key = createHash("sha256").update(canonical([principal, urlString, name, args])).digest("hex");
        const id = `sub_${key.slice(0, 16)}`;
        const refreshBefore = grant(params["ttlMs"]);
        const existing = webhookSubs.get(key);
        if (existing && !existing.removed) {
            const now = Date.now();
            existing.secrets = existing.secrets.filter((s) => s.until === undefined || s.until > now);
            const current = existing.secrets[existing.secrets.length - 1];
            if (typeof secret === "string" && current?.value !== secret) {
                if (current)
                    current.until = now + 60_000;
                existing.secrets.push({ value: secret });
            }
            existing.refreshBefore = refreshBefore;
            existing.active = true;
            // The fault: a refresh hands out a new id (deliveries follow it), so the upsert is not idempotent.
            if (has("non-idempotent-subscribe"))
                existing.id = `sub_${randomBytes(8).toString("hex")}`;
            const result = {
                id: existing.id,
                refreshBefore: refreshBefore === null ? null : new Date(refreshBefore).toISOString(),
                cursor: entry.replay ? cursorString(existing.watermark) : null,
                truncated: false,
                deliveryStatus: deliveryStatus(existing),
            };
            if (has("subscribe-no-refresh-before"))
                delete result["refreshBefore"];
            log(`events/subscribe ${name} refreshed ${existing.id}`);
            return result;
        }
        await verifyEndpoint({ id, url: urlString, principal }, String(secret));
        const start = entry.replay ? startFrom(name, params["cursor"], params["maxAgeMs"]) : { seq: logs.get(name).head, truncated: false };
        const sub = {
            key,
            id,
            principal,
            name,
            args,
            url: urlString,
            secrets: [{ value: String(secret) }],
            refreshBefore,
            active: true,
            lastError: null,
            queue: [],
            pumping: false,
            watermark: start.seq,
            removed: false,
        };
        webhookSubs.set(key, sub);
        const backlog = logs.get(name).entries.filter((e) => e.seq > start.seq && matchesArguments(e.occurrence.data, args));
        if (backlog.length > 0) {
            sub.queue.push(...backlog);
            void pump(sub);
        }
        const result = {
            id,
            refreshBefore: refreshBefore === null ? null : new Date(refreshBefore).toISOString(),
            cursor: entry.replay ? cursorString(start.seq) : null,
            truncated: start.truncated,
        };
        if (has("subscribe-no-refresh-before"))
            delete result["refreshBefore"];
        log(`events/subscribe ${name} -> ${id} (${urlString})`);
        return result;
    }
    function unsubscribe(params, h) {
        let principal = principalOf(h);
        if (principal === null) {
            if (!has("no-auth-required"))
                throw new Failure(errors.Forbidden, "events/unsubscribe needs an authenticated principal", { reason: "unauthenticated" });
            principal = "anonymous";
        }
        const name = params["name"];
        if (typeof name !== "string")
            throw new Failure(ERROR.InvalidParams, "params.name is required");
        const delivery = params["delivery"];
        if (!isObject(delivery) || typeof delivery["url"] !== "string")
            throw new Failure(ERROR.InvalidParams, "delivery.url is required");
        const args = isObject(params["arguments"]) ? params["arguments"] : {};
        const key = createHash("sha256").update(canonical([principal, delivery["url"], name, args])).digest("hex");
        const sub = webhookSubs.get(key);
        if (!sub || sub.removed) {
            if (has("unsubscribe-unknown-ok"))
                return {};
            throw new Failure(errors.NotFound, "no subscription matches this key", { kind: "subscription" });
        }
        if (!has("unsubscribe-noop")) {
            sub.removed = true;
            webhookSubs.delete(key);
        }
        log(`events/unsubscribe ${name} ${sub.id}`);
        return {};
    }
    async function deliver(sub, entry, ev) {
        const occurrence = { ...ev.occurrence, cursor: entry.replay ? cursorString(ev.seq) : null };
        if (has("delivery-wrong-name"))
            occurrence["name"] = `${ev.occurrence.name}.other`;
        if (has("oversized-delivery"))
            occurrence["data"] = { ...ev.occurrence.data, padding: "x".repeat(300 * 1024) };
        const body = JSON.stringify(occurrence);
        const webhookId = profile.webhookId === "event-id" || has("webhook-id-from-event-id") ? ev.occurrence.eventId : makeWebhookId();
        for (let attempt = 1; attempt <= retry.attempts; attempt++) {
            if (sub.removed)
                return false;
            const now = Date.now();
            sub.secrets = sub.secrets.filter((s) => s.until === undefined || s.until > now);
            const secrets = sub.secrets.map((s) => s.value);
            const ts = String(Math.floor(now / 1000) - (has("stale-timestamp") ? 600 : 0));
            const signature = has("sign-with-literal-secret")
                ? secrets.map((s) => `v1,${hmacBase64(Buffer.from(s, "utf8"), webhookId, ts, body)}`).join(" ")
                : signatureHeader(secrets, webhookId, ts, body);
            const headers = {
                "webhook-id": webhookId,
                "webhook-timestamp": ts,
                "webhook-signature": signature,
            };
            if (!has("no-subscription-id-header"))
                headers["x-mcp-subscription-id"] = sub.id;
            const resp = await postWebhook(sub.url, body, headers, { allowPrivateNetworks: allowLoopback, timeoutMs: retry.timeoutMs });
            if (resp.ok) {
                sub.lastDeliveryAt = Date.now();
                sub.lastError = null;
                sub.failedSince = undefined;
                log(`delivered ${ev.occurrence.name} ${ev.occurrence.eventId} to ${sub.id} (attempt ${attempt})`);
                return true;
            }
            sub.lastError = resp.category ?? "connection_refused";
            sub.failedSince ??= Date.now();
            log(`delivery of ${ev.occurrence.eventId} to ${sub.id} failed (${resp.status ?? resp.category}), attempt ${attempt}/${retry.attempts}`);
            if (resp.status === 410 || resp.status === 413)
                return false;
            if (attempt < retry.attempts)
                await new Promise((r) => setTimeout(r, retry.baseDelayMs * 2 ** (attempt - 1)));
        }
        return false;
    }
    async function pump(sub) {
        if (sub.pumping)
            return;
        sub.pumping = true;
        const entry = entryFor(sub.name);
        try {
            while (sub.queue.length > 0 && !sub.removed) {
                const ev = sub.queue[0];
                const ok = await deliver(sub, entry, ev);
                sub.queue.shift();
                if (ok || !sub.removed)
                    sub.watermark = Math.max(sub.watermark, ev.seq);
            }
        }
        finally {
            sub.pumping = false;
        }
    }
    // ---------- emit / terminate ----------
    function emit(name, data, eventId) {
        const entry = entryFor(name);
        if (!entry)
            throw new Failure(errors.NotFound, `unknown event type "${name}"`, { kind: "event" });
        const n = counters.get(name) ?? 0;
        counters.set(name, n + 1);
        const payload = data ?? entry.sample(n);
        const warnings = validate(payload, entry.descriptor.payloadSchema, "data");
        const l = logs.get(name);
        const seq = ++l.head;
        const ev = {
            seq,
            at: Date.now(),
            occurrence: {
                eventId: eventId ?? `evt_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
                name,
                timestamp: new Date().toISOString(),
                data: payload,
            },
        };
        l.entries.push(ev);
        if (l.entries.length > 1000)
            l.entries.shift();
        let push = 0;
        for (const sub of pushSubs) {
            if (sub.name === name && matchesArguments(payload, sub.args)) {
                pushEvent(sub, entry, ev);
                push++;
            }
        }
        let webhook = 0;
        const now = Date.now();
        for (const sub of webhookSubs.values()) {
            if (sub.removed || sub.name !== name || !matchesArguments(payload, sub.args))
                continue;
            if (sub.refreshBefore !== null && sub.refreshBefore < now)
                continue;
            sub.queue.push(ev);
            void pump(sub);
            webhook++;
        }
        log(`emitted ${name} ${ev.occurrence.eventId} -> push ${push}, webhook ${webhook}`);
        return {
            eventId: ev.occurrence.eventId,
            name,
            modes: entry.descriptor.delivery,
            cursor: entry.replay ? cursorString(seq) : null,
            delivered: { push, webhook },
            warnings,
        };
    }
    function terminate(name, reason = "Access revoked") {
        const error = { code: errors.Forbidden, message: "Forbidden", data: { reason } };
        let count = 0;
        for (const sub of [...pushSubs]) {
            if (sub.name !== name)
                continue;
            streamNotification(sub, NOTIFICATIONS.terminated, { error });
            writeSse(sub, { jsonrpc: "2.0", id: sub.id, result: { resultType: "complete", _meta: { [META.subscriptionId]: sub.id } } });
            sub.res.end();
            closePush(sub);
            count++;
        }
        for (const [key, sub] of [...webhookSubs]) {
            if (sub.name !== name)
                continue;
            sub.removed = true;
            webhookSubs.delete(key);
            count++;
            if (profile.controlEnvelopes) {
                const body = JSON.stringify({ type: "terminated", error });
                const headers = {
                    ...signDelivery({ secrets: sub.secrets.map((s) => s.value), body, webhookId: makeWebhookId("terminated") }),
                    "x-mcp-subscription-id": sub.id,
                };
                void postWebhook(sub.url, body, headers, { allowPrivateNetworks: allowLoopback, timeoutMs: retry.timeoutMs });
            }
        }
        log(`terminated ${count} subscription(s) to ${name}`);
        return count;
    }
    // ---------- HTTP ----------
    function respond(res, status, message) {
        sendJson(res, status, message);
    }
    async function handleMcp(req, res) {
        if (req.method !== "POST") {
            sendEmpty(res, 405, { allow: "POST" });
            return;
        }
        let raw;
        try {
            raw = await readBody(req, 1024 * 1024);
        }
        catch {
            sendJson(res, 413, rpcError(null, ERROR.InvalidRequest, "request body too large"));
            return;
        }
        let msg;
        try {
            msg = JSON.parse(raw.toString("utf8"));
        }
        catch {
            respond(res, 400, rpcError(null, ERROR.ParseError, "invalid JSON"));
            return;
        }
        if (!isObject(msg) || msg["jsonrpc"] !== "2.0" || typeof msg["method"] !== "string") {
            respond(res, 400, rpcError(null, ERROR.InvalidRequest, "expected one JSON-RPC 2.0 request"));
            return;
        }
        const method = msg["method"];
        if (!("id" in msg)) {
            sendEmpty(res, 202);
            return;
        }
        const id = msg["id"];
        const params = isObject(msg["params"]) ? msg["params"] : {};
        const h = headerMap(req);
        if (method === METHODS.initialize) {
            if (profile.name !== "chatgpt") {
                respond(res, 400, rpcError(id, ERROR.UnsupportedProtocolVersion, "Unsupported protocol version", {
                    supported: [PROTOCOL_VERSION],
                    requested: params["protocolVersion"] ?? null,
                }));
                return;
            }
            respond(res, 200, rpcResult(id, {
                protocolVersion: typeof params["protocolVersion"] === "string" ? params["protocolVersion"] : "2025-03-26",
                capabilities: capabilities(),
                serverInfo: { name: "hookbench-reference", version: VERSION },
            }));
            return;
        }
        const meta = isObject(params["_meta"]) ? params["_meta"] : undefined;
        const metaVersion = meta?.[META.protocolVersion];
        const headerVersion = h["mcp-protocol-version"];
        let era = "modern";
        if (typeof metaVersion === "string") {
            if (!headerVersion)
                return respond(res, 400, rpcError(id, ERROR.HeaderMismatch, "MCP-Protocol-Version header is required"));
            if (headerVersion !== metaVersion) {
                return respond(res, 400, rpcError(id, ERROR.HeaderMismatch, `MCP-Protocol-Version header "${headerVersion}" does not match _meta "${metaVersion}"`));
            }
            if (metaVersion !== PROTOCOL_VERSION) {
                return respond(res, 400, rpcError(id, ERROR.UnsupportedProtocolVersion, "Unsupported protocol version", { supported: [PROTOCOL_VERSION], requested: metaVersion }));
            }
            if (h["mcp-method"] !== method) {
                return respond(res, 400, rpcError(id, ERROR.HeaderMismatch, h["mcp-method"] ? `Mcp-Method header "${h["mcp-method"]}" does not match "${method}"` : "Mcp-Method header is required"));
            }
            if (NAMED_METHODS.has(method) && !has("ignore-mcp-name")) {
                const raw = h["mcp-name"];
                if (raw === undefined)
                    return respond(res, 400, rpcError(id, ERROR.HeaderMismatch, "Mcp-Name header is required"));
                if (decodeHeaderValue(raw) !== params["name"]) {
                    return respond(res, 400, rpcError(id, ERROR.HeaderMismatch, `Mcp-Name header "${raw}" does not match params.name`));
                }
                const entry = typeof params["name"] === "string" ? entryFor(params["name"]) : undefined;
                const args = isObject(params["arguments"]) ? params["arguments"] : {};
                for (const [header, prop] of annotatedProperties(entry?.descriptor.inputSchema)) {
                    const sent = h[`mcp-param-${header}`];
                    const expected = headerForm(args[prop]);
                    if ((expected === undefined) !== (sent === undefined) || (sent !== undefined && decodeHeaderValue(sent) !== expected)) {
                        return respond(res, 400, rpcError(id, ERROR.HeaderMismatch, `Mcp-Param-${header} header does not match arguments.${prop}`));
                    }
                }
            }
        }
        else if (profile.name === "chatgpt") {
            era = "legacy";
        }
        else {
            return respond(res, 400, rpcError(id, ERROR.UnsupportedProtocolVersion, "Unsupported protocol version", {
                supported: [PROTOCOL_VERSION],
                requested: headerVersion ?? null,
            }));
        }
        try {
            switch (method) {
                case METHODS.discover: {
                    if (has("no-discover"))
                        return respond(res, 404, rpcError(id, ERROR.MethodNotFound, "Method not found: server/discover"));
                    const result = {
                        supportedVersions: [PROTOCOL_VERSION],
                        capabilities: capabilities(),
                        _meta: { [META.serverInfo]: { name: "hookbench-reference", version: VERSION } },
                        instructions: "Hookbench reference server: sample MCP Events (ticket.created, build.finished, alert.fired).",
                        ttlMs: 60_000,
                        cacheScope: "private",
                    };
                    return respond(res, 200, rpcResult(id, has("discover-no-result-type") ? result : complete(result, era)));
                }
                case "tools/list":
                    return respond(res, 200, rpcResult(id, complete({ tools: [], ttlMs: 60_000, cacheScope: "public" }, era)));
                case METHODS.list:
                    return respond(res, 200, rpcResult(id, complete(listEvents(params), era)));
                case METHODS.poll:
                    return respond(res, 200, rpcResult(id, complete(poll(params), era)));
                case METHODS.stream:
                    openStream(id, params, res);
                    return;
                case METHODS.subscribe:
                    return respond(res, 200, rpcResult(id, complete(await subscribe(params, h), era)));
                case METHODS.unsubscribe: {
                    const result = unsubscribe(params, h);
                    return respond(res, 200, rpcResult(id, legacyCodes ? result : complete(result, era)));
                }
                default:
                    return respond(res, 404, rpcError(id, ERROR.MethodNotFound, `Method not found: ${method}`));
            }
        }
        catch (err) {
            if (err instanceof Failure)
                return respond(res, err.httpStatus, rpcError(id, err.code, err.message, err.data));
            log(`internal error in ${method}: ${err.message}`);
            return respond(res, 200, rpcError(id, ERROR.InternalError, "internal error"));
        }
    }
    async function handleDev(req, res, path) {
        if (path === "/hookbench" && req.method === "GET")
            return sendJson(res, 200, state());
        if (req.method !== "POST")
            return sendEmpty(res, 405, { allow: "POST" });
        let body = {};
        try {
            const raw = await readBody(req, 512 * 1024);
            body = raw.length > 0 ? JSON.parse(raw.toString("utf8")) : {};
        }
        catch {
            return sendJson(res, 400, { ok: false, error: "body must be JSON" });
        }
        const name = body["name"];
        if (typeof name !== "string")
            return sendJson(res, 400, { ok: false, error: "name is required" });
        if (!entryFor(name)) {
            return sendJson(res, 404, { ok: false, error: `unknown event type "${name}"`, known: catalog.map((e) => e.descriptor.name) });
        }
        if (path === "/hookbench/fire") {
            const data = body["data"];
            if (data !== undefined && !isObject(data))
                return sendJson(res, 400, { ok: false, error: "data must be an object" });
            const eventId = typeof body["eventId"] === "string" ? body["eventId"] : undefined;
            return sendJson(res, 200, { ok: true, ...emit(name, data, eventId) });
        }
        if (path === "/hookbench/terminate") {
            const reason = typeof body["reason"] === "string" ? body["reason"] : undefined;
            return sendJson(res, 200, { ok: true, terminated: terminate(name, reason) });
        }
        return sendJson(res, 404, { ok: false, error: "not found" });
    }
    function state() {
        return {
            name: "hookbench-reference",
            version: VERSION,
            profile: profile.name,
            faults: [...faults],
            allowLoopbackCallbacks: allowLoopback,
            mcp: `${origin}/mcp`,
            events: catalog.map((e) => ({ name: e.descriptor.name, delivery: e.descriptor.delivery, replay: e.replay })),
            subscriptions: {
                push: [...pushSubs].map((s) => ({ name: s.name, id: s.id })),
                webhook: [...webhookSubs.values()].map((s) => ({
                    name: s.name,
                    id: s.id,
                    url: s.url,
                    refreshBefore: s.refreshBefore === null ? null : new Date(s.refreshBefore).toISOString(),
                })),
            },
        };
    }
    const server = createServer((req, res) => {
        const path = new URL(req.url ?? "/", "http://localhost").pathname;
        const origin = req.headers.origin;
        if (origin && !isLocalOrigin(origin)) {
            sendJson(res, 403, rpcError(null, ERROR.InvalidRequest, "Origin not allowed"));
            return;
        }
        const handler = path === "/mcp" ? handleMcp(req, res) : path.startsWith("/hookbench") ? handleDev(req, res, path) : Promise.resolve(sendJson(res, 404, { error: "not found", mcp: "/mcp" }));
        handler.catch((err) => {
            log(`unhandled: ${err.message}`);
            if (!res.headersSent)
                sendJson(res, 500, { error: "internal error" });
        });
    });
    const host = opts.host ?? "127.0.0.1";
    const port = await listen(server, opts.port ?? 0, host);
    const origin = `http://${hostForUrl(host)}:${port}`;
    timers.push(setInterval(() => {
        const now = Date.now();
        for (const [key, sub] of webhookSubs) {
            if (sub.refreshBefore !== null && sub.refreshBefore < now) {
                sub.removed = true;
                webhookSubs.delete(key);
                log(`subscription ${sub.id} expired`);
            }
        }
    }, 1000));
    if (opts.autoEmitMs && opts.autoEmitMs > 0) {
        let i = 0;
        timers.push(setInterval(() => {
            const entry = catalog[i++ % catalog.length];
            emit(entry.descriptor.name);
        }, opts.autoEmitMs));
    }
    for (const t of timers)
        t.unref();
    return {
        url: `${origin}/mcp`,
        origin,
        fireUrl: `${origin}/hookbench/fire`,
        profile,
        token: Object.keys(tokens)[0],
        emit,
        terminate,
        state,
        async close() {
            for (const t of timers)
                clearInterval(t);
            for (const sub of [...pushSubs]) {
                closePush(sub);
                sub.res.end();
            }
            for (const sub of webhookSubs.values())
                sub.removed = true;
            webhookSubs.clear();
            await closeServer(server);
        },
    };
}
