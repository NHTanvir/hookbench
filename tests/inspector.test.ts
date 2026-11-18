/** The inspector: state store, terminal log formatting and the web view. */
import { strict as assert } from "node:assert";
import { request } from "node:http";
import { describe, it } from "node:test";
import { attachTerminalLog, compact, formatFeedItem, formatSubscription } from "../src/inspector/log.js";
import { InspectorStore } from "../src/inspector/store.js";
import { startInspectorWeb } from "../src/inspector/web.js";

function sample(store: InspectorStore) {
  store.setServer({ url: "http://x/mcp", name: "srv", version: "1", protocolVersion: "2026-07-28", era: "modern", capabilityKey: "extensions", profile: "sep-3415" });
  store.setCatalog([{ name: "ticket.created", delivery: ["poll"], inputSchema: {}, payloadSchema: {}, description: "d" }]);
  store.upsert({ key: "k", name: "ticket.created", mode: "webhook", arguments: {}, status: "active", received: 0, serverId: "sub_1", refreshBefore: new Date().toISOString() });
}

describe("InspectorStore", () => {
  it("counts events and problems and updates subscriptions", () => {
    const store = new InspectorStore();
    sample(store);
    store.add({ kind: "event", subscription: "k", name: "ticket.created", mode: "webhook", eventId: "e1", data: { a: 1 }, signature: "verified", problems: [], notes: [] });
    store.add({ kind: "event", subscription: "k", name: "ticket.created", mode: "webhook", eventId: "e1", data: { a: 1 }, duplicate: true, problems: [], notes: [] });
    store.add({ kind: "rejected", name: "ticket.created", problems: ["bad"], notes: [], status: 401 });
    store.heartbeat("k", "c5");
    assert.equal(store.subscriptions.get("k")?.received, 1, "duplicates do not count");
    assert.equal(store.subscriptions.get("k")?.cursor, "c5");
    assert.deepEqual(store.counts, { events: 2, problems: 1, heartbeats: 1 });
    const snap = store.snapshot() as { feed: unknown[]; subscriptions: unknown[] };
    assert.equal(snap.feed.length, 3);
    store.patch("missing", { status: "closed" });
  });
});

describe("terminal log", () => {
  it("formats every kind of feed item", () => {
    const base = { seq: 1, at: new Date().toISOString(), problems: [] as string[], notes: [] as string[] };
    const text = [
      formatFeedItem({ ...base, kind: "event", name: "n", mode: "webhook", eventId: "e1", signature: "verified", data: { a: 1 } }, false),
      formatFeedItem({ ...base, kind: "event", name: "n", mode: "webhook", signature: "invalid", duplicate: true }, false),
      formatFeedItem({ ...base, kind: "gap", name: "n", mode: "poll", cursor: "c" }, false),
      formatFeedItem({ ...base, kind: "terminated", name: "n", mode: "push", text: "Forbidden" }, false),
      formatFeedItem({ ...base, kind: "verification", name: "n", mode: "webhook" }, false),
      formatFeedItem({ ...base, kind: "rejected", name: "n", mode: "webhook", status: 401, text: "bad", problems: ["p1"], notes: ["n1"] }, false),
      formatFeedItem({ ...base, kind: "error", text: "boom" }, false),
      formatFeedItem({ ...base, kind: "info", text: "fyi" }, false),
    ].join("\n");
    for (const needle of ["signed ✓", "bad signature", "duplicate", "gap", "terminated: Forbidden", "verification challenge answered", "rejected (401)", "✗ p1", "· n1", "error  boom", "fyi"]) {
      assert.ok(text.includes(needle), needle);
    }
    assert.equal(compact({ long: "x".repeat(300) }).length, 110);
    assert.match(formatSubscription({ key: "k", name: "n", mode: "push", arguments: {}, status: "active", received: 0, heartbeatMs: 5 }, false), /heartbeat 5 ms/);
    assert.match(formatSubscription({ key: "k", name: "n", mode: "webhook", arguments: {}, status: "active", received: 0, refreshBefore: null }, false), /no expiry/);
  });

  it("prints JSON lines in json mode and stops after detach", () => {
    const store = new InspectorStore();
    const lines: string[] = [];
    const detach = attachTerminalLog(store, { out: { write: (s: string) => lines.push(s) }, color: false, json: true });
    sample(store);
    store.info("hello");
    detach();
    store.info("after");
    const parsed = lines.map((l) => JSON.parse(l) as { type: string; text?: string });
    assert.ok(parsed.some((p) => p.type === "subscription"));
    assert.ok(parsed.some((p) => p.type === "feed" && p.text === "hello"));
    assert.ok(!parsed.some((p) => p.text === "after"));
  });

  it("prints the server, catalog and status changes in human mode", () => {
    const store = new InspectorStore();
    const lines: string[] = [];
    attachTerminalLog(store, { out: { write: (s: string) => lines.push(s) }, color: false, json: false });
    sample(store);
    store.upsert({ key: "k2", name: "x", mode: "poll", arguments: {}, status: "starting", received: 0 });
    const out = lines.join("");
    assert.match(out, /connected {2}http:\/\/x\/mcp/);
    assert.match(out, /events\/list: 1 event type/);
    assert.match(out, /ticket\.created +webhook +active/);
    assert.ok(!out.includes("starting"));
  });
});

describe("web view", () => {
  it("serves the page, state and a live stream, only to its own host", async () => {
    const store = new InspectorStore();
    sample(store);
    const web = await startInspectorWeb(store, { port: 0 });
    try {
      const page = await fetch(web.url);
      assert.equal(page.status, 200);
      assert.match(await page.text(), /Hookbench<\/span> inspector/);
      assert.match(String(page.headers.get("content-security-policy")), /default-src 'none'/);
      const state = (await (await fetch(`${web.url}/api/state`)).json()) as { server: { name: string } };
      assert.equal(state.server.name, "srv");

      const ac = new AbortController();
      const live = await fetch(`${web.url}/api/events`, { signal: ac.signal });
      const reader = (live.body as ReadableStream<Uint8Array>).getReader();
      const first = new TextDecoder().decode((await reader.read()).value);
      assert.match(first, /^event: state\ndata: /);
      store.info("live!");
      let text = "";
      while (!text.includes("live!")) text += new TextDecoder().decode((await reader.read()).value);
      assert.match(text, /event: change/);
      ac.abort();

      const port = Number(new URL(web.url).port);
      const evil = await new Promise<number>((resolve, reject) => {
        const req = request({ host: "127.0.0.1", port, path: "/api/state", headers: { host: `evil.example:${port}` } }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.on("error", reject);
        req.end();
      });
      assert.equal(evil, 403, "a rebinding Host header is refused");
      assert.equal((await fetch(web.url, { method: "POST" })).status, 405);
      assert.equal((await fetch(`${web.url}/nope`)).status, 404);
    } finally {
      await web.close();
    }
  });
});
