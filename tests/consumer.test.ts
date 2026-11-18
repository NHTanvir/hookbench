/** `hookbench connect`'s mock consumer, in every delivery mode. */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { startConsumer } from "../src/consumer/consumer.js";
import { InspectorStore } from "../src/inspector/store.js";
import { signDelivery } from "../src/webhooks/standard-webhooks.js";
import { AUTH, sleep, waitFor, withServer } from "./helpers.js";

const received = (store: InspectorStore, name: string) => [...store.subscriptions.values()].find((s) => s.name === name)?.received ?? 0;
const sub = (store: InspectorStore, name: string) => [...store.subscriptions.values()].find((s) => s.name === name);

describe("consumer", () => {
  it("receives by webhook, poll and push, then unsubscribes on stop", async () => {
    await withServer({ ttl: { defaultMs: 1500, minMs: 500 } }, async (server) => {
      const store = new InspectorStore();
      const c = await startConsumer({
        url: server.url,
        headers: AUTH,
        store,
        pollFloorMs: 100,
        subscriptions: [
          { name: "ticket.created", mode: "webhook" },
          { name: "build.finished", mode: "poll" },
          { name: "alert.fired", mode: "push" },
        ],
      });
      await waitFor(() => [...store.subscriptions.values()].every((s) => s.status === "active"));
      const firstRefresh = sub(store, "ticket.created")?.refreshBefore;
      server.emit("ticket.created");
      server.emit("build.finished");
      server.emit("alert.fired");
      await waitFor(() => ["ticket.created", "build.finished", "alert.fired"].every((n) => received(store, n) === 1));
      const webhookEvent = store.feed.find((f) => f.kind === "event" && f.mode === "webhook");
      assert.equal(webhookEvent?.signature, "verified");
      assert.deepEqual(store.feed.filter((f) => f.problems.length > 0), []);
      assert.ok(store.feed.some((f) => f.kind === "verification"));
      await waitFor(() => sub(store, "ticket.created")?.refreshBefore !== firstRefresh, 3000);
      await c.stop();
      assert.equal(sub(store, "ticket.created")?.status, "closed");
      assert.equal(sub(store, "build.finished")?.status, "closed");
      assert.deepEqual((server.state()["subscriptions"] as { webhook: unknown[] }).webhook, []);
    });
  });

  it("picks push, then poll, then webhook in auto mode, and webhook first when configured", async () => {
    await withServer({}, async (server) => {
      const store = new InspectorStore();
      const c = await startConsumer({ url: server.url, headers: AUTH, store });
      assert.deepEqual([...store.subscriptions.values()].map((s) => [s.name, s.mode]), [["ticket.created", "push"], ["build.finished", "push"], ["alert.fired", "push"]]);
      await c.stop();
      const store2 = new InspectorStore();
      const c2 = await startConsumer({ url: server.url, headers: AUTH, store: store2, webhook: "on", mode: "auto" });
      assert.deepEqual([...store2.subscriptions.values()].map((s) => s.mode), ["webhook", "push", "webhook"]);
      await c2.stop();
    });
  });

  it("filters with arguments and reports unknown event types", async () => {
    await withServer({}, async (server) => {
      const store = new InspectorStore();
      const c = await startConsumer({ url: server.url, headers: AUTH, store, subscriptions: [{ name: "alert.fired", mode: "push", arguments: { severity: "P1" } }, { name: "nope" }] });
      assert.ok(store.feed.some((f) => f.kind === "error" && /no event type named "nope"/.test(String(f.text))));
      await waitFor(() => sub(store, "alert.fired")?.status === "active");
      server.emit("alert.fired", { alertId: "1", severity: "P3", service: "s", summary: "x" });
      server.emit("alert.fired", { alertId: "2", severity: "P1", service: "s", summary: "x" });
      await waitFor(() => received(store, "alert.fired") === 1);
      await sleep(100);
      assert.equal(received(store, "alert.fired"), 1);
      await c.stop();
    });
  });

  it("handles termination on push and webhook, and gap envelopes", async () => {
    await withServer({}, async (server) => {
      const store = new InspectorStore();
      const c = await startConsumer({ url: server.url, headers: AUTH, store, subscriptions: [{ name: "alert.fired", mode: "push" }, { name: "ticket.created", mode: "webhook" }] });
      await waitFor(() => [...store.subscriptions.values()].every((s) => s.status === "active"));
      const hook = sub(store, "ticket.created");
      const token = String(hook?.callbackUrl).split("/").pop() as string;
      const route = c.receiver?.route(token);
      assert.ok(route);
      const body = JSON.stringify({ type: "gap", cursor: "c_fresh" });
      await fetch(String(hook?.callbackUrl), { method: "POST", headers: { "content-type": "application/json", ...signDelivery({ secrets: route.secrets, body, webhookId: "msg_gap_x" }), "x-mcp-subscription-id": String(hook?.serverId) }, body });
      await waitFor(() => store.feed.some((f) => f.kind === "gap"));
      assert.equal(sub(store, "ticket.created")?.cursor, "c_fresh");

      server.terminate("alert.fired");
      server.terminate("ticket.created");
      await waitFor(() => sub(store, "alert.fired")?.status === "terminated" && sub(store, "ticket.created")?.status === "terminated");
      await c.stop();
      assert.equal(sub(store, "ticket.created")?.status, "terminated", "a terminated subscription is not unsubscribed again");
    });
  });

  it("reconnects a push stream that goes silent", async () => {
    await withServer({ faults: ["stream-no-heartbeat"], heartbeat: { defaultMs: 150, minMs: 100 } }, async (server) => {
      const store = new InspectorStore();
      const c = await startConsumer({ url: server.url, headers: AUTH, store, heartbeatMs: 150, subscriptions: [{ name: "alert.fired", mode: "push" }] });
      await waitFor(() => store.feed.some((f) => /no message for 3 heartbeat intervals/.test(String(f.text))), 4000);
      await c.stop();
    });
  });

  it("explains why a strict server refuses a local webhook callback", async () => {
    await withServer({ allowLoopbackCallbacks: false }, async (server) => {
      const store = new InspectorStore();
      const c = await startConsumer({ url: server.url, headers: AUTH, store, subscriptions: [{ name: "ticket.created", mode: "webhook" }] });
      await waitFor(() => sub(store, "ticket.created")?.status === "error");
      assert.match(String(sub(store, "ticket.created")?.detail), /--callback-url/);
      await c.stop();
    });
    await withServer({}, async (server) => {
      const store = new InspectorStore();
      const c = await startConsumer({ url: server.url, store, subscriptions: [{ name: "ticket.created", mode: "webhook" }] });
      await waitFor(() => sub(store, "ticket.created")?.status === "error");
      assert.match(String(sub(store, "ticket.created")?.detail), /Authorization: Bearer/);
      await c.stop();
    });
  });

  it("speaks ChatGPT's dialect with the chatgpt profile", async () => {
    await withServer({ profile: "chatgpt" }, async (server) => {
      const store = new InspectorStore();
      const c = await startConsumer({ url: server.url, headers: AUTH, store, profile: "chatgpt" });
      assert.ok([...store.subscriptions.values()].every((s) => s.mode === "webhook"));
      await waitFor(() => [...store.subscriptions.values()].every((s) => s.status === "active"));
      server.emit("ticket.created");
      await waitFor(() => received(store, "ticket.created") === 1);
      assert.deepEqual(store.feed.filter((f) => f.problems.length > 0), []);
      await c.stop();
    });
  });

  it("explains a server that does not advertise Events", async () => {
    await withServer({ faults: ["no-capability"] }, async (server) => {
      const store = new InspectorStore();
      const c = await startConsumer({ url: server.url, headers: AUTH, store, subscriptions: [{ name: "build.finished", mode: "poll" }] });
      assert.ok(store.feed.some((f) => f.kind === "error" && /does not advertise MCP Events/.test(String(f.text))));
      await c.stop();
    });
  });
});
