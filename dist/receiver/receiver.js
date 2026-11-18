/**
 * A local MCP Events webhook receiver. It verifies Standard Webhooks signatures over the raw
 * body, answers verification challenges, handles gap / terminated envelopes, deduplicates on
 * webhook-id, and records every request, with a plain-language reason when one is wrong.
 *
 * Each subscription gets its own callback path (/hooks/<token>), so the receiver knows which
 * secret to use before the server has told anyone the subscription id.
 */
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { MAX_DELIVERY_BYTES, TIMESTAMP_TOLERANCE_SECONDS } from "../protocol/constants.js";
import { isObject } from "../protocol/jsonrpc.js";
import { validate } from "../protocol/schema-lite.js";
import { BodyTooLargeError, closeServer, headerMap, hostForUrl, listen, readBody, sendEmpty, sendJson } from "../util/http.js";
import { isHeaderSafeId, verifyDelivery } from "../webhooks/standard-webhooks.js";
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;
/** Problems with an EventOccurrence body, in plain language. */
export function occurrenceProblems(body, expectedName, payloadSchema) {
    const out = [];
    if (!isObject(body))
        return ["the body is not a JSON object"];
    if (typeof body["eventId"] !== "string" || body["eventId"].length === 0)
        out.push("eventId is missing or not a string");
    if (typeof body["name"] !== "string")
        out.push("name is missing or not a string");
    else if (expectedName !== undefined && body["name"] !== expectedName)
        out.push(`name is "${body["name"]}", but this subscription is for "${expectedName}"`);
    if (typeof body["timestamp"] !== "string")
        out.push("timestamp is missing or not a string");
    else if (!ISO.test(body["timestamp"]))
        out.push(`timestamp "${body["timestamp"]}" is not ISO 8601 with a timezone`);
    if (!isObject(body["data"]))
        out.push("data is missing or not an object");
    else if (payloadSchema) {
        for (const p of validate(body["data"], payloadSchema, "data").slice(0, 5))
            out.push(`payloadSchema: ${p}`);
    }
    if ("cursor" in body && body["cursor"] !== null && typeof body["cursor"] !== "string")
        out.push("cursor must be a string, null, or absent");
    return out;
}
export class WebhookReceiver extends EventEmitter {
    opts;
    server;
    base = "";
    routes = new Map();
    seenWebhookIds = new Map();
    seenEventIds = new Map();
    log = [];
    seq = 0;
    constructor(opts = {}) {
        super();
        this.opts = opts;
    }
    get baseUrl() {
        return this.base;
    }
    async start() {
        this.server = createServer((req, res) => {
            this.handle(req, res).catch(() => {
                if (!res.headersSent)
                    sendEmpty(res, 500);
            });
        });
        const host = this.opts.host ?? "127.0.0.1";
        const port = await listen(this.server, this.opts.port ?? 0, host);
        this.base = `http://${hostForUrl(host)}:${port}`;
        return this.base;
    }
    newToken() {
        return randomBytes(9).toString("base64url");
    }
    callbackUrl(token) {
        const base = (this.opts.publicUrl ?? this.base).replace(/\/+$/, "");
        return `${base}/hooks/${token}`;
    }
    addRoute(route) {
        this.routes.set(route.token, route);
    }
    updateRoute(token, patch) {
        const r = this.routes.get(token);
        if (r)
            Object.assign(r, patch);
    }
    removeRoute(token) {
        this.routes.delete(token);
    }
    route(token) {
        return this.routes.get(token);
    }
    deliveries() {
        return [...this.log];
    }
    async close() {
        if (this.server)
            await closeServer(this.server);
    }
    record(d) {
        const full = { seq: ++this.seq, at: new Date().toISOString(), ...d };
        this.log.push(full);
        if (this.log.length > 2000)
            this.log.shift();
        this.emit("delivery", full);
        return full;
    }
    async handle(req, res) {
        const path = new URL(req.url ?? "/", "http://localhost").pathname;
        const headers = headerMap(req);
        if (path === "/.well-known/mcp-webhook-receiver.json" && req.method === "GET") {
            // Publishing this document is the receiver's standing consent (SEP-3415, endpoint verification option 4).
            sendJson(res, 200, { receivers: ["/hooks/"] }, { "cache-control": "max-age=300" });
            this.emit("well-known");
            return;
        }
        const m = /^\/hooks\/([A-Za-z0-9_-]+)\/?$/.exec(path);
        const base = { method: req.method ?? "", path, headers, body: "", bodyBytes: 0, duplicate: false, notes: [] };
        if (req.method !== "POST") {
            sendEmpty(res, 405, { allow: "POST" });
            this.record({ ...base, status: 405, kind: "invalid", problems: [`deliveries are POST only, got ${req.method}`] });
            return;
        }
        const route = m ? this.routes.get(m[1]) : undefined;
        if (!route) {
            req.resume();
            sendEmpty(res, 404);
            this.record({ ...base, status: 404, kind: "invalid", problems: ["no subscription uses this callback path"] });
            return;
        }
        let raw;
        try {
            raw = await readBody(req, this.opts.maxBodyBytes ?? 1024 * 1024);
        }
        catch (err) {
            if (err instanceof BodyTooLargeError) {
                sendEmpty(res, 413);
                this.record({ ...base, token: route.token, label: route.label, status: 413, kind: "invalid", problems: ["the body is larger than this receiver accepts"] });
                return;
            }
            throw err;
        }
        const bodyText = raw.toString("utf8");
        const problems = [];
        const notes = [];
        let json;
        try {
            json = JSON.parse(bodyText);
        }
        catch {
            json = undefined;
        }
        const envelopeType = isObject(json) && typeof json["type"] === "string" ? json["type"] : undefined;
        const kind = json === undefined || !isObject(json)
            ? "invalid"
            : envelopeType === undefined
                ? "event"
                : envelopeType === "verification" || envelopeType === "gap" || envelopeType === "terminated"
                    ? envelopeType
                    : "envelope";
        const webhookId = headers["webhook-id"];
        const subscriptionIdHeader = headers["x-mcp-subscription-id"];
        const verify = verifyDelivery({
            secrets: route.secrets,
            webhookId,
            timestamp: headers["webhook-timestamp"],
            signature: headers["webhook-signature"],
            body: raw,
            toleranceSeconds: this.opts.toleranceSeconds ?? TIMESTAMP_TOLERANCE_SECONDS,
        });
        const common = {
            ...base,
            token: route.token,
            label: route.label,
            body: bodyText.length > 65_536 ? `${bodyText.slice(0, 65_536)}…` : bodyText,
            bodyBytes: raw.length,
            json,
            kind,
            verify,
            webhookId,
            subscriptionIdHeader,
        };
        if (!(headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
            problems.push(`Content-Type is "${headers["content-type"] ?? "(none)"}", deliveries are application/json`);
        }
        if (subscriptionIdHeader === undefined)
            problems.push("X-MCP-Subscription-Id header is missing (every delivery MUST carry it)");
        if (raw.length > route.profile.maxBodyBytes) {
            const msg = `the body is ${raw.length} bytes; ${route.profile.hardBodyLimit ? "ChatGPT rejects anything over" : "SEP-3415 asks servers to stay at or under"} ${MAX_DELIVERY_BYTES} bytes (256 KiB)`;
            (route.profile.hardBodyLimit ? problems : notes).push(msg);
        }
        if (!verify.ok) {
            problems.unshift(`${verify.message}${verify.diagnosis ? `: ${verify.diagnosis}` : ""}`);
            // Verify before processing: an unverified body is never acted on.
            sendEmpty(res, 401);
            this.record({ ...common, status: 401, duplicate: false, problems, notes });
            return;
        }
        if (webhookId && !isHeaderSafeId(webhookId))
            problems.push(`webhook-id "${webhookId}" has characters outside A-Z a-z 0-9 _ -`);
        if (route.subscriptionId && subscriptionIdHeader && subscriptionIdHeader !== route.subscriptionId) {
            problems.push(`X-MCP-Subscription-Id is "${subscriptionIdHeader}", but events/subscribe returned "${route.subscriptionId}"`);
        }
        if (kind === "verification") {
            const challenge = isObject(json) ? json["challenge"] : undefined;
            if (!route.subscriptionId && subscriptionIdHeader)
                route.subscriptionId = subscriptionIdHeader;
            if (typeof challenge !== "string" || challenge.length === 0) {
                problems.push("verification envelope has no challenge");
                sendEmpty(res, 400);
                this.record({ ...common, status: 400, duplicate: false, problems, notes });
                return;
            }
            if (webhookId && !webhookId.startsWith("msg_verification_"))
                notes.push(`control envelopes use webhook-id msg_<type>_<random>; got "${webhookId}"`);
            sendJson(res, 200, { challenge });
            this.record({ ...common, status: 200, duplicate: false, problems, notes });
            return;
        }
        const seenIds = this.seenWebhookIds.get(route.token) ?? new Set();
        this.seenWebhookIds.set(route.token, seenIds);
        const duplicate = webhookId !== undefined && seenIds.has(webhookId);
        if (webhookId)
            seenIds.add(webhookId);
        if (kind === "gap" || kind === "terminated") {
            if (!route.profile.controlEnvelopes)
                notes.push(`ChatGPT does not support ${kind} envelopes`);
            if (webhookId && !webhookId.startsWith(`msg_${kind}_`))
                notes.push(`control envelopes use webhook-id msg_${kind}_<random>; got "${webhookId}"`);
            if (kind === "terminated" && !(isObject(json) && isObject(json["error"])))
                problems.push("terminated envelope has no error object");
            sendEmpty(res, 204);
            this.record({ ...common, status: 204, duplicate, problems, notes });
            return;
        }
        if (kind === "envelope") {
            problems.push(`unknown control envelope type "${envelopeType}"`);
            sendEmpty(res, 400);
            this.record({ ...common, status: 400, duplicate, problems, notes });
            return;
        }
        if (kind === "invalid") {
            problems.push("the body is not a JSON object");
            sendEmpty(res, 400);
            this.record({ ...common, status: 400, duplicate, problems, notes });
            return;
        }
        const occurrence = json;
        problems.push(...occurrenceProblems(json, route.eventName, route.payloadSchema));
        if (typeof occurrence.eventId === "string" && webhookId !== undefined) {
            if (route.profile.webhookId === "independent" && webhookId === occurrence.eventId) {
                problems.push("webhook-id equals the eventId; SEP-3415 says webhook-id identifies the message and MUST NOT be derived from eventId");
            }
            if (route.profile.webhookId === "event-id" && webhookId !== occurrence.eventId) {
                problems.push("webhook-id differs from eventId; ChatGPT's guide requires them to match (the Vercel AI SDK and TanStack AI reject the delivery too)");
            }
        }
        const scope = `${subscriptionIdHeader ?? route.token}`;
        const seenEvents = this.seenEventIds.get(scope) ?? new Set();
        this.seenEventIds.set(scope, seenEvents);
        if (!duplicate && typeof occurrence.eventId === "string") {
            if (seenEvents.has(occurrence.eventId))
                notes.push("this eventId already arrived on this subscription under another webhook-id");
            seenEvents.add(occurrence.eventId);
        }
        if (duplicate)
            notes.push("duplicate webhook-id: a retry of a message already accepted, acknowledged without processing");
        sendEmpty(res, 204);
        this.record({ ...common, status: 204, duplicate, problems, notes, occurrence });
    }
}
