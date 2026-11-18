/** The webhook receiver: verification, envelopes, dedup, dialect checks and status codes. */
import { strict as assert } from "node:assert";
import { after, before, describe, it } from "node:test";
import { getProfile } from "../src/protocol/profiles.js";
import { occurrenceProblems, WebhookReceiver } from "../src/receiver/receiver.js";
import { generateSecret, hmacBase64, signDelivery } from "../src/webhooks/standard-webhooks.js";

const secret = generateSecret();
const receiver = new WebhookReceiver({ maxBodyBytes: 400 * 1024 });
let sepUrl = "";
let gptUrl = "";

before(async () => {
  await receiver.start();
  receiver.addRoute({ token: "sep", label: "ticket.created", secrets: [secret], subscriptionId: "sub_1", eventName: "ticket.created", payloadSchema: { type: "object", required: ["n"] }, profile: getProfile("sep-3415") });
  receiver.addRoute({ token: "gpt", label: "ticket.created", secrets: [secret], subscriptionId: "sub_2", profile: getProfile("chatgpt") });
  sepUrl = receiver.callbackUrl("sep");
  gptUrl = receiver.callbackUrl("gpt");
});
after(() => receiver.close());

let counter = 0;
function event(extra: Record<string, unknown> = {}) {
  return { eventId: `evt_${++counter}`, name: "ticket.created", timestamp: new Date().toISOString(), data: { n: 1 }, cursor: "c1", ...extra };
}

async function post(url: string, body: unknown, opts: { webhookId?: string; subId?: string | null; signWith?: string; timestamp?: number; raw?: string } = {}) {
  const text = opts.raw ?? JSON.stringify(body);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...signDelivery({ secrets: [opts.signWith ?? secret], body: text, webhookId: opts.webhookId, timestamp: opts.timestamp }),
  };
  if (opts.subId !== null) headers["x-mcp-subscription-id"] = opts.subId ?? "sub_1";
  const res = await fetch(url, { method: "POST", headers, body: text });
  const reply = await res.text();
  const last = receiver.deliveries().at(-1);
  return { status: res.status, reply, d: last };
}

describe("WebhookReceiver", () => {
  it("accepts a well-formed signed event", async () => {
    const r = await post(sepUrl, event());
    assert.equal(r.status, 204);
    assert.equal(r.d?.kind, "event");
    assert.equal(r.d?.verify?.ok, true);
    assert.deepEqual(r.d?.problems, []);
  });

  it("rejects bad signatures with a diagnosis, and stale timestamps", async () => {
    const body = JSON.stringify(event());
    const id = "msg_x";
    const ts = String(Math.floor(Date.now() / 1000));
    const res = await fetch(sepUrl, {
      method: "POST",
      headers: { "content-type": "application/json", "webhook-id": id, "webhook-timestamp": ts, "webhook-signature": `v1,${hmacBase64(Buffer.from(secret), id, ts, body)}`, "x-mcp-subscription-id": "sub_1" },
      body,
    });
    assert.equal(res.status, 401);
    assert.match(String(receiver.deliveries().at(-1)?.problems[0]), /literal "whsec_…" string/);
    const stale = await post(sepUrl, event(), { timestamp: Math.floor(Date.now() / 1000) - 900 });
    assert.equal(stale.status, 401);
    assert.match(String(stale.d?.problems[0]), /old/);
  });

  it("answers verification challenges", async () => {
    const ok = await post(sepUrl, { type: "verification", challenge: "nonce-1" }, { webhookId: "msg_verification_abc" });
    assert.equal(ok.status, 200);
    assert.deepEqual(JSON.parse(ok.reply), { challenge: "nonce-1" });
    assert.deepEqual(ok.d?.notes, []);
    const odd = await post(sepUrl, { type: "verification", challenge: "n2" }, { webhookId: "msg_other" });
    assert.match(String(odd.d?.notes[0]), /msg_<type>_<random>/);
    assert.equal((await post(sepUrl, { type: "verification" })).status, 400);
  });

  it("handles gap, terminated and unknown envelopes", async () => {
    assert.equal((await post(sepUrl, { type: "gap", cursor: "c9" }, { webhookId: "msg_gap_1" })).status, 204);
    const term = await post(sepUrl, { type: "terminated", error: { code: -32024, message: "Forbidden" } }, { webhookId: "msg_terminated_1" });
    assert.equal(term.status, 204);
    assert.equal(term.d?.kind, "terminated");
    assert.match(String((await post(sepUrl, { type: "terminated" })).d?.problems.join()), /no error object/);
    assert.equal((await post(sepUrl, { type: "mystery" })).status, 400);
    assert.match(String((await post(gptUrl, { type: "gap", cursor: null }, { subId: "sub_2" })).d?.notes.join()), /ChatGPT does not support gap/);
  });

  it("dedupes on webhook-id and notes a repeated eventId", async () => {
    const e = event();
    await post(sepUrl, e, { webhookId: "msg_dup" });
    const again = await post(sepUrl, e, { webhookId: "msg_dup" });
    assert.equal(again.status, 204);
    assert.equal(again.d?.duplicate, true);
    const other = await post(sepUrl, e, { webhookId: "msg_dup_2" });
    assert.match(String(other.d?.notes.join()), /eventId already arrived/);
  });

  it("applies each profile's webhook-id rule", async () => {
    const e = event();
    const sep = await post(sepUrl, e, { webhookId: e.eventId });
    assert.match(String(sep.d?.problems.join()), /MUST NOT be derived from eventId/);
    const gpt = await post(gptUrl, event(), { subId: "sub_2" });
    assert.match(String(gpt.d?.problems.join()), /ChatGPT's guide requires them to match/);
    const e2 = event();
    assert.deepEqual((await post(gptUrl, e2, { webhookId: e2.eventId, subId: "sub_2" })).d?.problems, []);
  });

  it("flags missing or wrong subscription ids, bad bodies and schema problems", async () => {
    assert.match(String((await post(sepUrl, event(), { subId: null })).d?.problems.join()), /X-MCP-Subscription-Id header is missing/);
    assert.match(String((await post(sepUrl, event(), { subId: "sub_other" })).d?.problems.join()), /events\/subscribe returned "sub_1"/);
    assert.equal((await post(sepUrl, null, { raw: "not json" })).status, 400);
    assert.match(String((await post(sepUrl, event({ data: {} }))).d?.problems.join()), /payloadSchema: data.n: required/);
    assert.match(String((await post(sepUrl, event({ name: "other.event" }))).d?.problems.join()), /this subscription is for/);
  });

  it("notes large bodies, refuses huge ones, and only accepts POST on known paths", async () => {
    const big = await post(sepUrl, event({ data: { n: 1, pad: "x".repeat(300 * 1024) } }));
    assert.equal(big.status, 204);
    assert.match(String(big.d?.notes.join()), /256 KiB/);
    const gptBig = await post(gptUrl, event({ data: { pad: "x".repeat(300 * 1024) } }), { subId: "sub_2" });
    assert.match(String(gptBig.d?.problems.join()), /ChatGPT rejects/);
    assert.equal((await post(sepUrl, event({ data: { pad: "x".repeat(500 * 1024) } }))).status, 413);
    assert.equal((await fetch(receiver.callbackUrl("nope"), { method: "POST", body: "{}" })).status, 404);
    assert.equal((await fetch(sepUrl)).status, 405);
  });

  it("publishes the receiver well-known document", async () => {
    const res = await fetch(`${receiver.baseUrl}/.well-known/mcp-webhook-receiver.json`);
    assert.deepEqual(await res.json(), { receivers: ["/hooks/"] });
  });
});

describe("occurrenceProblems", () => {
  it("names each problem", () => {
    assert.deepEqual(occurrenceProblems({ eventId: "e", name: "n", timestamp: "2026-11-18T10:00:00.123+02:00", data: {}, cursor: null }), []);
    const p = occurrenceProblems({ name: 3, timestamp: "yesterday", data: "x", cursor: 4 });
    assert.equal(p.length, 5);
    assert.deepEqual(occurrenceProblems([]), ["the body is not a JSON object"]);
  });
});
