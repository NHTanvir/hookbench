/**
 * The mock MCP Events consumer behind `hookbench connect`. It discovers the server, lists
 * event types, and keeps one subscription per event type alive in whichever delivery mode
 * fits, the way a client SDK would: poll loops with a floor and hasMore draining, push
 * streams with heartbeat watchdogs and cursor resume, webhook subscriptions with a generated
 * secret, verified deliveries and refresh before refreshBefore.
 */
import { McpEventsClient } from "../client/client.js";
import { ERROR, META, NOTIFICATIONS, POLL_FLOOR_MS } from "../protocol/constants.js";
import { isFailure, isObject, isResponse, RpcError } from "../protocol/jsonrpc.js";
import { getProfile } from "../protocol/profiles.js";
import { occurrenceProblems, WebhookReceiver } from "../receiver/receiver.js";
import { InspectorStore } from "../inspector/store.js";
import { generateSecret } from "../webhooks/standard-webhooks.js";
const sleep = (ms, signal) => new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
        clearTimeout(t);
        resolve();
    }, { once: true });
});
function explainSubscribeError(err, profile, callbackIsLoopback) {
    if (err instanceof RpcError) {
        const data = isObject(err.data) ? err.data : {};
        if (err.code === profile.errors.CallbackEndpointError || err.code === ERROR.CallbackEndpointError) {
            return `the server could not verify the callback (reason: ${String(data["reason"] ?? "unknown")}). The server must be able to reach the callback URL; pass --callback-url with a public https URL that forwards to the local receiver.`;
        }
        if (err.code === profile.errors.Forbidden || err.code === ERROR.Forbidden) {
            return `the server refused the subscription (Forbidden: ${err.message}). Webhook mode needs an authenticated principal: pass --header "Authorization: Bearer <token>".`;
        }
        if (err.code === ERROR.InvalidParams && callbackIsLoopback) {
            return `${err.message}. A conformant server refuses http://127.0.0.1 callbacks; use a server that allows loopback callbacks in development, or pass --callback-url with a public https URL.`;
        }
        return err.message;
    }
    return err.message ?? String(err);
}
export async function startConsumer(opts) {
    const profile = getProfile(opts.profile);
    const store = opts.store ?? new InspectorStore();
    const client = new McpEventsClient({ url: opts.url, headers: opts.headers, timeoutMs: opts.timeoutMs, era: opts.era });
    const stopper = new AbortController();
    const tasks = [];
    const cleanups = [];
    const floor = Math.max(opts.pollFloorMs ?? POLL_FLOOR_MS, 50);
    const discovery = await client.discover();
    store.setServer({
        url: opts.url,
        name: discovery.serverInfo?.name,
        version: discovery.serverInfo?.version,
        protocolVersion: discovery.protocolVersion,
        era: discovery.era,
        capabilityKey: discovery.capabilityKey,
        profile: profile.name,
    });
    if (discovery.fallbackReason)
        store.info(`fell back to the initialize handshake: ${discovery.fallbackReason}`);
    if (discovery.capabilityKey === "none") {
        store.error("the server does not advertise MCP Events (no capabilities.extensions[\"io.modelcontextprotocol/events\"] and no capabilities.events); trying events/list anyway");
    }
    else if (profile.capability === "extensions" && discovery.capabilityKey === "top-level") {
        store.info("the server advertises Events under the top-level capabilities.events key (design sketch / ChatGPT dialect), not under extensions as SEP-3415 says");
    }
    else if (profile.capability === "top-level" && discovery.capabilityKey === "extensions") {
        store.info("the server advertises Events only under capabilities.extensions; ChatGPT and the Vercel AI SDK look for the top-level capabilities.events key");
    }
    const { events } = await client.listEvents();
    store.setCatalog(events);
    const wanted = opts.subscriptions && opts.subscriptions.length > 0
        ? opts.subscriptions
        : events.map((e) => ({ name: e.name, arguments: opts.defaultArguments }));
    let receiver;
    const needReceiver = () => {
        if (!receiver) {
            receiver = new WebhookReceiver({ port: opts.receiverPort, publicUrl: opts.callbackUrl });
        }
        return receiver;
    };
    const chooseMode = (desc, requested) => {
        const offered = desc.delivery.filter((m) => profile.modes.includes(m));
        const want = requested ?? opts.mode ?? "auto";
        if (want !== "auto")
            return offered.includes(want) ? want : undefined;
        const webhookConfigured = Boolean(opts.callbackUrl) || opts.webhook === "on";
        if (webhookConfigured && offered.includes("webhook"))
            return "webhook";
        if (offered.includes("push"))
            return "push";
        if (offered.includes("poll"))
            return "poll";
        if (offered.includes("webhook") && opts.webhook !== "off")
            return "webhook";
        return undefined;
    };
    for (const req of wanted) {
        const desc = events.find((e) => e.name === req.name);
        if (!desc) {
            store.error(`events/list has no event type named "${req.name}"`);
            continue;
        }
        const mode = chooseMode(desc, req.mode);
        if (!mode) {
            store.error(`${desc.name}: offers ${desc.delivery.join(", ") || "no modes"}; none fits ${req.mode && req.mode !== "auto" ? `the requested mode "${req.mode}"` : `the ${profile.name} profile`}`);
            continue;
        }
        const args = req.arguments ?? {};
        const key = `${desc.name}:${mode}:${tasks.length}`;
        store.upsert({ key, name: desc.name, mode, arguments: args, status: "starting", received: 0 });
        if (mode === "poll")
            tasks.push(runPoll(key, desc, args));
        if (mode === "push")
            tasks.push(runPush(key, desc, args));
        if (mode === "webhook") {
            const r = needReceiver();
            if (!r.baseUrl)
                await r.start();
            tasks.push(runWebhook(key, desc, args, r));
        }
    }
    // ---------------- poll ----------------
    async function runPoll(key, desc, args) {
        let cursor = null;
        let failures = 0;
        const seen = new Set();
        while (!stopper.signal.aborted) {
            let wait = floor;
            try {
                const result = await client.poll({ name: desc.name, arguments: args, cursor, maxEvents: 50 }, { signal: stopper.signal });
                failures = 0;
                if (result.truncated)
                    store.add({ kind: "gap", subscription: key, name: desc.name, mode: "poll", cursor: result.cursor ?? null, problems: [], notes: ["truncated: true, events were skipped"] });
                for (const e of Array.isArray(result.events) ? result.events : []) {
                    const id = isObject(e) && typeof e.eventId === "string" ? e.eventId : undefined;
                    const duplicate = id !== undefined && seen.has(id);
                    if (id)
                        seen.add(id);
                    store.add({
                        kind: "event",
                        subscription: key,
                        name: desc.name,
                        mode: "poll",
                        eventId: id,
                        data: isObject(e) ? e.data : undefined,
                        body: e,
                        signature: "n/a",
                        duplicate,
                        problems: occurrenceProblems(e, desc.name, desc.payloadSchema),
                        notes: duplicate ? ["this eventId already arrived on this subscription"] : [],
                    });
                }
                cursor = result.cursor === undefined ? null : result.cursor;
                const next = typeof result.nextPollMs === "number" ? result.nextPollMs : 2000;
                store.patch(key, { status: "active", cursor, nextPollMs: next, detail: undefined });
                wait = result.hasMore ? 0 : Math.max(floor, next);
            }
            catch (err) {
                if (stopper.signal.aborted)
                    return;
                if (err instanceof RpcError && [profile.errors.Forbidden, profile.errors.NotFound, profile.errors.Unsupported, ERROR.InvalidParams, ERROR.Forbidden, ERROR.NotFound].includes(err.code)) {
                    store.patch(key, { status: "terminated", detail: err.message });
                    store.add({ kind: "terminated", subscription: key, name: desc.name, mode: "poll", text: err.message, problems: [], notes: [] });
                    return;
                }
                failures++;
                store.patch(key, { status: "reconnecting", detail: err.message });
                wait = Math.min(30_000, 1000 * 2 ** Math.min(failures, 5));
            }
            if (wait > 0)
                await sleep(wait, stopper.signal);
        }
    }
    // ---------------- push ----------------
    async function runPush(key, desc, args) {
        let cursor = null;
        let failures = 0;
        const seen = new Set();
        while (!stopper.signal.aborted) {
            const run = { ended: "server-closed" };
            try {
                const { stream, requestId } = await client.openStream({ name: desc.name, arguments: args, cursor, heartbeatMs: opts.heartbeatMs }, { signal: stopper.signal });
                if (stream.response || !stream.contentType.includes("text/event-stream")) {
                    const r = stream.response;
                    const msg = r && isFailure(r) ? `${r.error.message} (${r.error.code})` : `the server answered HTTP ${stream.status} instead of an SSE stream`;
                    store.patch(key, { status: "error", detail: msg });
                    store.error(`${desc.name} (push): ${msg}`, { subscription: key, name: desc.name, mode: "push" });
                    return;
                }
                store.patch(key, { serverId: String(requestId) });
                let granted = opts.heartbeatMs ?? 30_000;
                let last = Date.now();
                let first = true;
                const watchdog = setInterval(() => {
                    if (Date.now() - last > granted * 3) {
                        run.ended = "silent";
                        stream.close();
                    }
                }, 500);
                try {
                    for await (const m of stream.messages) {
                        last = Date.now();
                        if (isResponse(m))
                            break;
                        if (!isObject(m) || typeof m.method !== "string")
                            continue;
                        const method = m.method;
                        const params = isObject(m.params) ? (m.params) : {};
                        const meta = isObject(params["_meta"]) ? params["_meta"] : {};
                        const problems = [];
                        if (meta[META.subscriptionId] !== requestId) {
                            problems.push(`_meta["${META.subscriptionId}"] is ${JSON.stringify(meta[META.subscriptionId])}; it must be the events/stream request id ${JSON.stringify(requestId)}`);
                        }
                        if (first && method !== NOTIFICATIONS.active)
                            problems.push(`the first message on the stream was ${method}, not notifications/events/active`);
                        first = false;
                        if (method === NOTIFICATIONS.active) {
                            if (typeof params["heartbeatMs"] === "number" && params["heartbeatMs"] > 0)
                                granted = params["heartbeatMs"];
                            if (params["cursor"] !== undefined)
                                cursor = params["cursor"];
                            store.patch(key, { status: "active", heartbeatMs: granted, cursor, detail: undefined });
                            failures = 0;
                            if (params["truncated"] === true) {
                                store.add({ kind: "gap", subscription: key, name: desc.name, mode: "push", cursor, problems, notes: ["notifications/events/active with truncated: true"] });
                            }
                            else if (problems.length > 0) {
                                store.add({ kind: "info", subscription: key, name: desc.name, mode: "push", text: "stream opened", problems, notes: [] });
                            }
                        }
                        else if (method === NOTIFICATIONS.event) {
                            const e = params;
                            const id = typeof e.eventId === "string" ? e.eventId : undefined;
                            const duplicate = id !== undefined && seen.has(id);
                            if (id)
                                seen.add(id);
                            if ("cursor" in params)
                                cursor = params["cursor"] ?? null;
                            store.patch(key, { cursor });
                            const { _meta: _ignored, ...body } = params;
                            store.add({
                                kind: "event",
                                subscription: key,
                                name: desc.name,
                                mode: "push",
                                eventId: id,
                                cursor,
                                data: e.data,
                                body,
                                signature: "n/a",
                                duplicate,
                                problems: [...problems, ...occurrenceProblems(body, desc.name, desc.payloadSchema)],
                                notes: duplicate ? ["this eventId already arrived on this subscription"] : [],
                            });
                        }
                        else if (method === NOTIFICATIONS.heartbeat) {
                            if (params["cursor"] !== undefined)
                                cursor = params["cursor"];
                            store.heartbeat(key, cursor);
                        }
                        else if (method === NOTIFICATIONS.error) {
                            const e = isObject(params["error"]) ? params["error"] : {};
                            store.add({ kind: "error", subscription: key, name: desc.name, mode: "push", text: `stream error (the subscription stays open): ${String(e["message"] ?? "")}`, problems, notes: [] });
                        }
                        else if (method === NOTIFICATIONS.terminated) {
                            const e = isObject(params["error"]) ? params["error"] : {};
                            run.ended = "terminated";
                            store.patch(key, { status: "terminated", detail: String(e["message"] ?? "") });
                            store.add({ kind: "terminated", subscription: key, name: desc.name, mode: "push", text: `${String(e["message"] ?? "")} (${String(e["code"] ?? "")})`, problems, notes: [] });
                            break;
                        }
                    }
                }
                finally {
                    clearInterval(watchdog);
                    stream.close();
                }
            }
            catch (err) {
                if (stopper.signal.aborted)
                    return;
                run.ended = "error";
                store.patch(key, { status: "reconnecting", detail: err.message });
            }
            if (run.ended === "terminated" || stopper.signal.aborted)
                return;
            failures++;
            if (run.ended === "silent")
                store.info(`${desc.name} (push): no message for 3 heartbeat intervals, reconnecting with the last cursor`, { subscription: key, name: desc.name, mode: "push" });
            store.patch(key, { status: "reconnecting" });
            await sleep(Math.min(30_000, 500 * 2 ** Math.min(failures, 6)) + Math.floor(Math.random() * 400), stopper.signal);
        }
    }
    // ---------------- webhook ----------------
    async function runWebhook(key, desc, args, r) {
        const token = r.newToken();
        const secret = generateSecret();
        const url = r.callbackUrl(token);
        const loopback = !opts.callbackUrl;
        r.addRoute({ token, label: desc.name, secrets: [secret], eventName: desc.name, payloadSchema: desc.payloadSchema, profile });
        store.patch(key, { callbackUrl: url });
        if (loopback && opts.loopbackNotice !== false) {
            store.info(`${desc.name}: callback ${url} is a local http URL. A conformant server refuses it; it works with \`hookbench serve --allow-loopback-callbacks\` or a dev server that allows private networks. For anything else, pass --callback-url https://<tunnel> forwarding to ${r.baseUrl}.`, { name: desc.name, mode: "webhook" });
        }
        let cursor = null;
        let terminated = false;
        const onDelivery = (d) => {
            if (d.token !== token)
                return;
            const item = feedFromDelivery(d, key, desc.name);
            if (d.kind === "terminated" && d.verify?.ok) {
                terminated = true;
                store.patch(key, { status: "terminated", detail: item.text });
            }
            if (d.verify?.ok && (d.kind === "event" || d.kind === "gap") && isObject(d.json) && "cursor" in d.json) {
                const c = d.json["cursor"];
                if (c === null || typeof c === "string")
                    cursor = c;
                store.patch(key, { cursor });
            }
            store.add(item);
        };
        r.on("delivery", onDelivery);
        const subscribe = async () => {
            try {
                const result = await client.subscribe({ name: desc.name, arguments: args, delivery: { mode: "webhook", url, secret }, cursor, ttlMs: opts.ttlMs }, { signal: stopper.signal });
                r.updateRoute(token, { subscriptionId: result.id });
                if (result.cursor !== undefined)
                    cursor = result.cursor;
                const status = result.deliveryStatus;
                store.patch(key, {
                    status: "active",
                    serverId: result.id,
                    refreshBefore: result.refreshBefore,
                    cursor,
                    detail: status && !status.active ? `delivery was suspended (${status.lastError ?? "unknown"}); this refresh reactivated it` : status?.lastError ? `last delivery error: ${status.lastError}` : undefined,
                });
                if (result.truncated)
                    store.add({ kind: "gap", subscription: key, name: desc.name, mode: "webhook", cursor, problems: [], notes: ["the subscribe response says truncated: true"] });
                return result;
            }
            catch (err) {
                if (stopper.signal.aborted)
                    return undefined;
                const why = explainSubscribeError(err, profile, loopback);
                store.patch(key, { status: "error", detail: why });
                store.error(`${desc.name} (webhook): ${why}`, { subscription: key, name: desc.name, mode: "webhook" });
                return undefined;
            }
        };
        cleanups.push(async () => {
            r.off("delivery", onDelivery);
            if (!terminated && store.subscriptions.get(key)?.status !== "error") {
                try {
                    await client.unsubscribe({ name: desc.name, arguments: args, delivery: { mode: "webhook", url } }, { timeoutMs: 3000 });
                    store.patch(key, { status: "closed", detail: "unsubscribed" });
                }
                catch (err) {
                    store.patch(key, { status: "closed", detail: `unsubscribe failed: ${err.message}` });
                }
            }
            r.removeRoute(token);
        });
        let result = await subscribe();
        while (result && !stopper.signal.aborted && !terminated) {
            if (result.refreshBefore === null) {
                await sleep(10 * 60_000, stopper.signal); // no expiry: occasional health check
            }
            else {
                const remaining = Date.parse(result.refreshBefore) - Date.now();
                await sleep(Math.max(1000, Math.floor(remaining * 0.75)), stopper.signal);
            }
            if (stopper.signal.aborted || terminated)
                break;
            result = await subscribe();
        }
    }
    function feedFromDelivery(d, key, name) {
        const headers = {};
        for (const h of ["content-type", "webhook-id", "webhook-timestamp", "webhook-signature", "x-mcp-subscription-id"]) {
            if (d.headers[h] !== undefined)
                headers[h] = d.headers[h];
        }
        const json = isObject(d.json) ? d.json : undefined;
        const base = {
            subscription: key,
            name,
            mode: "webhook",
            webhookId: d.webhookId,
            headers,
            body: json ?? d.body,
            status: d.status,
            signature: d.verify ? (d.verify.ok ? "verified" : "invalid") : "n/a",
            problems: d.problems,
            notes: d.notes,
            duplicate: d.duplicate,
        };
        if (d.status >= 400)
            return { ...base, kind: "rejected", text: d.problems[0] ?? `answered ${d.status}` };
        if (d.kind === "verification")
            return { ...base, kind: "verification" };
        if (d.kind === "gap")
            return { ...base, kind: "gap", cursor: json?.["cursor"] ?? null };
        if (d.kind === "terminated") {
            const e = isObject(json?.["error"]) ? json?.["error"] : {};
            return { ...base, kind: "terminated", text: `${String(e["message"] ?? "")} (${String(e["code"] ?? "")})` };
        }
        return { ...base, kind: "event", eventId: d.occurrence?.eventId, cursor: json?.["cursor"] ?? null, data: d.occurrence?.data };
    }
    return {
        store,
        client,
        get receiver() {
            return receiver;
        },
        discovery,
        events,
        async stop() {
            stopper.abort();
            for (const c of cleanups)
                await c();
            await Promise.allSettled(tasks);
            for (const sub of store.subscriptions.values()) {
                if (sub.status !== "terminated" && sub.status !== "error" && sub.status !== "closed") {
                    store.patch(sub.key, { status: "closed", detail: sub.mode === "push" ? "stream closed" : "stopped polling" });
                }
            }
            if (receiver)
                await receiver.close();
        },
    };
}
