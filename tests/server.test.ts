/** The reference server's own behaviour, request by request. */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { McpEventsClient } from "../src/client/client.js";
import { RpcError, type JsonRpcMessage } from "../src/protocol/jsonrpc.js";
import { WebhookReceiver } from "../src/receiver/receiver.js";
import { getProfile } from "../src/protocol/profiles.js";
import { generateSecret } from "../src/webhooks/standard-webhooks.js";
import { AUTH, httpServer, sleep, waitFor, withServer } from "./helpers.js";

async function client(url: string, headers: Record<string, string> = AUTH) {
  const c = new McpEventsClient({ url, headers });
  await c.discover();
  await c.listEvents();
  return c;
}

const code = (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => (e instanceof RpcError ? e.code : String(e)));

describe("reference server: transport", () => {
  it("validates the 2026-07-28 request headers", async () => {
    await withServer({}, async (server) => {
      const c = await client(server.url);
      const send = (o: Record<string, string | null>) => c.send("events/poll", { name: "ticket.created", cursor: null }, { overrideHeaders: o });
      for (const [override, needle] of [
        [{ "mcp-protocol-version": null }, /MCP-Protocol-Version header is required/],
        [{ "mcp-protocol-version": "2025-06-18" }, /does not match/],
        [{ "mcp-method": "events/list" }, /Mcp-Method/],
        [{ "mcp-name": null }, /Mcp-Name header is required/],
      ] as const) {
        const r = await send(override as Record<string, string | null>);
        assert.equal(r.status, 400);
        assert.equal((r.response as { error: { code: number } }).error.code, -32020);
        assert.match((r.response as { error: { message: string } }).error.message, needle);
      }
      const param = await c.send("events/poll", { name: "build.finished", arguments: { branch: "main" }, cursor: null }, { overrideHeaders: { "mcp-param-branch": "other" } });
      assert.equal(param.status, 400);
      const encoded = await c.send("events/poll", { name: "ticket.created", cursor: null }, { overrideHeaders: { "mcp-name": `=?base64?${Buffer.from("ticket.created").toString("base64")}?=` } });
      assert.equal(encoded.status, 200);
    });
  });

  it("answers unsupported versions, unknown methods, GET and foreign origins", async () => {
    await withServer({}, async (server) => {
      const res = await fetch(server.url, {
        method: "POST",
        headers: { "content-type": "application/json", "mcp-protocol-version": "1999-01-01", "mcp-method": "events/list" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "events/list", params: { _meta: { "io.modelcontextprotocol/protocolVersion": "1999-01-01" } } }),
      });
      assert.equal(res.status, 400);
      const body = (await res.json()) as { error: { code: number; data: { supported: string[] } } };
      assert.equal(body.error.code, -32022);
      assert.deepEqual(body.error.data.supported, ["2026-07-28"]);
      const c = await client(server.url);
      const unknown = await c.send("tools/call", { name: "x" });
      assert.equal(unknown.status, 404);
      assert.equal((await fetch(server.url)).status, 405);
      assert.equal((await fetch(server.url, { method: "POST", headers: { origin: "https://evil.example" }, body: "{}" })).status, 403);
      const bad = await fetch(server.url, { method: "POST", body: "{not json" });
      assert.equal(bad.status, 400);
      const note = await fetch(server.url, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled" }) });
      assert.equal(note.status, 202);
      const legacy = await c.send("initialize", { protocolVersion: "2025-11-25" });
      assert.equal(legacy.status, 400);
    });
  });
});

describe("reference server: events/list and poll", () => {
  it("pages events/list two at a time", async () => {
    await withServer({}, async (server) => {
      const c = await client(server.url);
      const first = await c.call<{ events: unknown[]; nextCursor?: string }>("events/list");
      assert.equal(first.events.length, 2);
      assert.equal(first.nextCursor, "page_2");
      const second = await c.call<{ events: unknown[]; nextCursor?: string }>("events/list", { cursor: "page_2" });
      assert.equal(second.events.length, 1);
      assert.equal(second.nextCursor, undefined);
      assert.equal(await code(c.call("events/list", { cursor: "garbage" })), -32602);
    });
  });

  it("starts from now, resumes, filters, pages with hasMore and honours maxAgeMs", async () => {
    await withServer({}, async (server) => {
      const c = await client(server.url);
      server.emit("ticket.created");
      const boot = await c.poll({ name: "ticket.created", cursor: null });
      assert.deepEqual(boot.events, []);
      assert.equal(boot.hasMore, false);
      for (const priority of ["high", "low", "high"]) server.emit("ticket.created", { ticketId: "T", title: "t", priority, project: "web" });
      const page = await c.poll({ name: "ticket.created", cursor: boot.cursor, maxEvents: 2 });
      assert.equal(page.events.length, 2);
      assert.equal(page.hasMore, true);
      const rest = await c.poll({ name: "ticket.created", cursor: page.cursor });
      assert.equal(rest.events.length, 1);
      assert.equal(rest.hasMore, false);
      const high = await c.poll({ name: "ticket.created", cursor: boot.cursor, arguments: { priority: "high" } });
      assert.equal(high.events.length, 2);
      await sleep(30);
      const recent = await c.poll({ name: "ticket.created", cursor: boot.cursor, maxAgeMs: 5 });
      assert.equal(recent.truncated, true);
      assert.equal(recent.events.length, 0);
      const foreign = await c.poll({ name: "ticket.created", cursor: "c_00000000.3" });
      assert.equal(foreign.truncated, true);
      assert.equal(await code(c.poll({ name: "ticket.created", cursor: "nonsense" })), -32602);
      assert.equal(await code(c.poll({ name: "alert.fired" })), -32026);
      assert.equal(await code(c.poll({ name: "nope" })), -32023);
      assert.equal(await code(c.poll({ name: "ticket.created", arguments: { priority: 1 } })), -32602);
    });
  });
});

describe("reference server: push", () => {
  it("opens with active, delivers events, heartbeats, and terminates", async () => {
    await withServer({}, async (server) => {
      const c = await client(server.url);
      const { stream, requestId } = await c.openStream({ name: "alert.fired", heartbeatMs: 250 });
      const seen: JsonRpcMessage[] = [];
      const reading = (async () => {
        for await (const m of stream.messages) seen.push(m);
      })();
      await waitFor(() => seen.length >= 1);
      server.emit("alert.fired", { alertId: "A", severity: "P2", service: "s", summary: "x" });
      server.emit("alert.fired", { alertId: "B", severity: "P1", service: "s", summary: "x" });
      await sleep(450);
      server.terminate("alert.fired");
      await reading;
      const methods = seen.map((m) => (m as { method?: string }).method ?? "result");
      assert.equal(methods[0], "notifications/events/active");
      assert.ok(methods.includes("notifications/events/heartbeat"));
      assert.equal(methods.filter((m) => m === "notifications/events/event").length, 2);
      assert.ok(methods.includes("notifications/events/terminated"));
      assert.equal(methods[methods.length - 1], "result");
      for (const m of seen.filter((x) => "method" in x)) {
        assert.equal(((m as unknown as { params: { _meta: Record<string, unknown> } }).params._meta)["io.modelcontextprotocol/subscriptionId"], requestId);
      }
      const active = seen[0] as unknown as { params: { heartbeatMs: number; cursor: unknown } };
      assert.equal(active.params.heartbeatMs, 250);
      assert.equal(active.params.cursor, null, "alert.fired is emit-only");
    });
  });

  it("clamps the heartbeat and replays from a cursor", async () => {
    await withServer({ heartbeat: { defaultMs: 1000, minMs: 500, maxMs: 2000 } }, async (server) => {
      const c = await client(server.url);
      const boot = await c.poll({ name: "ticket.created", cursor: null });
      server.emit("ticket.created");
      const { stream } = await c.openStream({ name: "ticket.created", cursor: boot.cursor, heartbeatMs: 10 });
      const it = stream.messages[Symbol.asyncIterator]();
      const active = (await it.next()).value as { params: { heartbeatMs: number } };
      assert.equal(active.params.heartbeatMs, 500);
      const replay = (await it.next()).value as { method: string };
      assert.equal(replay.method, "notifications/events/event");
      stream.close();
      const { stream: bad } = await c.openStream({ name: "build.finished", arguments: { status: "maybe" } });
      assert.equal((bad.response as { error: { code: number } }).error.code, -32602);
    });
  });
});

describe("reference server: webhooks", () => {
  it("requires a principal, https, a valid secret and a public address", async () => {
    await withServer({ allowLoopbackCallbacks: false }, async (server) => {
      const anon = await client(server.url, {});
      const c = await client(server.url);
      const sub = (cl: McpEventsClient, url: string, secret = generateSecret()) =>
        code(cl.subscribe({ name: "ticket.created", delivery: { mode: "webhook", url, secret } }));
      assert.equal(await sub(anon, "https://example.com/hook"), -32024);
      assert.equal(await sub(c, "http://example.com/hook"), -32602);
      assert.equal(await sub(c, "https://example.com/hook", "whsec_short"), -32602);
      assert.equal(await sub(c, "https://127.0.0.1/hook"), -32602);
      assert.equal(await sub(c, "https://[::1]/hook"), -32602);
      assert.equal(await sub(c, "not a url"), -32602);
      assert.equal(await sub(c, "https://hookbench-test.invalid/hook"), -32027);
      assert.equal(await code(c.subscribe({ name: "build.finished", delivery: { mode: "webhook", url: "https://example.com/h", secret: generateSecret() } })), -32026);
      assert.equal(await code(c.call("events/subscribe", { name: "ticket.created", delivery: { url: "https://example.com/h", secret: generateSecret() } })), -32602);
      assert.equal(await code(c.unsubscribe({ name: "ticket.created", delivery: { url: "https://example.com/h" } })), -32023);
      assert.equal(await code(anon.unsubscribe({ name: "ticket.created", delivery: { url: "https://example.com/h" } })), -32024);
    });
  });

  it("verifies the endpoint, delivers signed events, refreshes idempotently and unsubscribes", async () => {
    await withServer({ ttl: { defaultMs: 60_000, minMs: 1000, maxMs: 120_000 } }, async (server) => {
      const receiver = new WebhookReceiver();
      await receiver.start();
      const token = receiver.newToken();
      const secret = generateSecret();
      const profile = getProfile("sep-3415");
      receiver.addRoute({ token, label: "ticket.created", secrets: [secret], profile });
      const url = receiver.callbackUrl(token);
      try {
        const c = await client(server.url);
        const asked = Date.now();
        const first = await c.subscribe({ name: "ticket.created", delivery: { mode: "webhook", url, secret }, ttlMs: 5000 });
        assert.match(first.id, /^sub_[0-9a-f]{16}$/);
        const granted = Date.parse(String(first.refreshBefore)) - asked;
        assert.ok(granted <= 5500 && granted >= 4000, `granted ${granted}`);
        assert.equal(receiver.deliveries()[0]?.kind, "verification");
        receiver.updateRoute(token, { subscriptionId: first.id });

        server.emit("ticket.created");
        await waitFor(() => receiver.deliveries().some((d) => d.kind === "event"));
        const ev = receiver.deliveries().find((d) => d.kind === "event");
        assert.equal(ev?.verify?.ok, true);
        assert.equal(ev?.subscriptionIdHeader, first.id);
        assert.notEqual(ev?.webhookId, (ev?.json as { eventId: string }).eventId);
        assert.deepEqual(ev?.problems, []);

        const clampUp = await c.subscribe({ name: "ticket.created", delivery: { mode: "webhook", url, secret }, ttlMs: 10 });
        assert.equal(clampUp.id, first.id);
        assert.ok(Date.parse(String(clampUp.refreshBefore)) - Date.now() >= 900, "clamped up to the floor");
        assert.equal(clampUp.deliveryStatus?.active, true);
        const noExpiry = await c.subscribe({ name: "ticket.created", delivery: { mode: "webhook", url, secret }, ttlMs: null });
        assert.notEqual(noExpiry.refreshBefore, null, "an in-memory server never grants no expiry");
        assert.equal(receiver.deliveries().filter((d) => d.kind === "verification").length, 1, "verification is cached per (principal, url)");

        const rotated = generateSecret();
        receiver.updateRoute(token, { secrets: [rotated] });
        await c.subscribe({ name: "ticket.created", delivery: { mode: "webhook", url, secret: rotated } });
        server.emit("ticket.created");
        await waitFor(() => receiver.deliveries().filter((d) => d.kind === "event").length >= 2);
        const after = receiver.deliveries().filter((d) => d.kind === "event")[1];
        assert.equal(after?.verify?.ok, true);
        assert.equal(after?.verify?.v1Count, 2, "dual-signed during the rotation grace window");

        assert.deepEqual(await c.unsubscribe({ name: "ticket.created", delivery: { url } }), { resultType: "complete" });
        server.emit("ticket.created");
        await sleep(200);
        assert.equal(receiver.deliveries().filter((d) => d.kind === "event").length, 2);
      } finally {
        await receiver.close();
      }
    });
  });

  it("fails verification that is not echoed, retries 5xx deliveries and never retries 410", async () => {
    const attempts: Record<string, number> = {};
    const srv = await httpServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as { type?: string; challenge?: string };
        const path = req.url ?? "";
        if (body.type === "verification") {
          if (path === "/no-echo") return res.writeHead(200, { "content-type": "application/json" }).end('{"challenge":"wrong"}');
          if (path === "/five") return res.writeHead(500).end();
          return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ challenge: body.challenge }));
        }
        attempts[path] = (attempts[path] ?? 0) + 1;
        res.writeHead(path === "/gone" ? 410 : 503).end();
      });
    });
    try {
      await withServer({ retry: { attempts: 3, baseDelayMs: 20, timeoutMs: 2000 } }, async (server) => {
        const c = await client(server.url);
        const subscribe = (path: string) =>
          c.subscribe({ name: "ticket.created", delivery: { mode: "webhook", url: `${srv.url}${path}`, secret: generateSecret() } });
        const err = await subscribe("/no-echo").catch((e: unknown) => e as RpcError);
        assert.equal((err as RpcError).code, -32027);
        assert.deepEqual((err as RpcError).data, { reason: "challenge_failed" });
        const err5 = await subscribe("/five").catch((e: unknown) => e as RpcError);
        assert.deepEqual((err5 as RpcError).data, { reason: "http_5xx" });

        await subscribe("/gone");
        await subscribe("/busy");
        server.emit("ticket.created");
        await waitFor(() => (attempts["/busy"] ?? 0) >= 3, 3000);
        await sleep(150);
        assert.equal(attempts["/gone"], 1, "410 is non-retryable");
        assert.equal(attempts["/busy"], 3, "503 is retried up to the attempt cap");
        const refreshed = await subscribe("/busy");
        assert.equal(refreshed.deliveryStatus?.lastError, "http_5xx");
      });
    } finally {
      await srv.close();
    }
  });

  it("expires subscriptions that are not refreshed", async () => {
    await withServer({ ttl: { defaultMs: 1000, minMs: 500 } }, async (server) => {
      const receiver = new WebhookReceiver();
      await receiver.start();
      const token = receiver.newToken();
      const secret = generateSecret();
      receiver.addRoute({ token, label: "x", secrets: [secret], profile: getProfile("sep-3415") });
      try {
        const c = await client(server.url);
        await c.subscribe({ name: "ticket.created", delivery: { mode: "webhook", url: receiver.callbackUrl(token), secret }, ttlMs: 500 });
        assert.equal((server.state()["subscriptions"] as { webhook: unknown[] }).webhook.length, 1);
        await waitFor(() => (server.state()["subscriptions"] as { webhook: unknown[] }).webhook.length === 0, 3000);
      } finally {
        await receiver.close();
      }
    });
  });
});

describe("reference server: chatgpt profile", () => {
  it("speaks ChatGPT's dialect", async () => {
    await withServer({ profile: "chatgpt" }, async (server) => {
      const init = await fetch(server.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } }) });
      const body = (await init.json()) as { result: { capabilities: Record<string, unknown>; protocolVersion: string } };
      assert.deepEqual(body.result.capabilities["events"], {});
      assert.equal(body.result.protocolVersion, "2025-03-26");
      const legacy = new McpEventsClient({ url: server.url, era: "legacy", headers: AUTH });
      const d = await legacy.discover();
      assert.equal(d.capabilityKey, "top-level");
      const list = await legacy.listEvents();
      assert.ok(list.events.every((e) => e.delivery.length === 1 && e.delivery[0] === "webhook"));
      assert.equal(list.pages[0]?.resultType, undefined, "legacy-era results carry no resultType");

      const receiver = new WebhookReceiver();
      await receiver.start();
      const token = receiver.newToken();
      const secret = generateSecret();
      receiver.addRoute({ token, label: "ticket.created", secrets: [secret], profile: getProfile("chatgpt") });
      try {
        const modern = await client(server.url);
        await modern.subscribe({ name: "ticket.created", delivery: { mode: "webhook", url: receiver.callbackUrl(token), secret } });
        server.emit("ticket.created");
        await waitFor(() => receiver.deliveries().some((d) => d.kind === "event"));
        const ev = receiver.deliveries().find((d) => d.kind === "event");
        assert.equal(ev?.webhookId, (ev?.json as { eventId: string }).eventId);
        assert.deepEqual(ev?.problems, []);
        assert.deepEqual(await modern.unsubscribe({ name: "ticket.created", delivery: { url: receiver.callbackUrl(token) } }), {});
        const err = await modern.subscribe({ name: "ticket.created", delivery: { mode: "webhook", url: "https://hookbench-test.invalid/x", secret } }).catch((e: unknown) => e as RpcError);
        assert.equal((err as RpcError).code, -32015);
      } finally {
        await receiver.close();
      }
    });
  });
});

describe("reference server: dev endpoints", () => {
  it("fires, terminates and reports state", async () => {
    await withServer({ autoEmitMs: 0 }, async (server) => {
      const fire = await fetch(server.fireUrl, { method: "POST", body: JSON.stringify({ name: "ticket.created", data: { ticketId: 5 }, eventId: "evt_custom" }) });
      const body = (await fire.json()) as { eventId: string; warnings: string[]; modes: string[] };
      assert.equal(body.eventId, "evt_custom");
      assert.ok(body.warnings.some((w) => w.includes("ticketId")), "warns when data breaks payloadSchema");
      assert.deepEqual(body.modes, ["poll", "push", "webhook"]);
      assert.equal((await fetch(server.fireUrl, { method: "POST", body: JSON.stringify({ name: "nope" }) })).status, 404);
      assert.equal((await fetch(server.fireUrl, { method: "POST", body: "nope" })).status, 400);
      assert.equal((await fetch(server.fireUrl, { method: "POST", body: JSON.stringify({ name: "ticket.created", data: [] }) })).status, 400);
      const term = await fetch(`${server.origin}/hookbench/terminate`, { method: "POST", body: JSON.stringify({ name: "alert.fired" }) });
      assert.deepEqual(await term.json(), { ok: true, terminated: 0 });
      const state = (await (await fetch(`${server.origin}/hookbench`)).json()) as { name: string; profile: string };
      assert.equal(state.name, "hookbench-reference");
      assert.equal((await fetch(`${server.origin}/elsewhere`)).status, 404);
    });
  });

  it("emits on a timer", async () => {
    await withServer({ autoEmitMs: 100 }, async (server) => {
      const c = await client(server.url);
      const boot = await c.poll({ name: "ticket.created", cursor: null });
      await sleep(450);
      const later = await c.poll({ name: "ticket.created", cursor: boot.cursor });
      assert.ok(later.events.length >= 1);
    });
  });
});
