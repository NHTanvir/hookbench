/**
 * `hookbench check` against a compliant reference server and against deliberately broken
 * ones. Each broken server has one fault, and the check must flag exactly the rule that
 * fault breaks, and nothing else.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { exitCodeFor, formatJson, formatMarkdown, formatText } from "../src/check/report.js";
import { RULES } from "../src/check/rules.js";
import { runCheck, type CheckOptions } from "../src/check/runner.js";
import { FAULTS, type FaultName, type ReferenceServerOptions } from "../src/server/reference-server.js";
import { check, describeFlagged, flagged, httpServer, readJson, rule, withServer } from "./helpers.js";

type Case = [FaultName, string, "fail" | "warn", Partial<ReferenceServerOptions>?, Partial<CheckOptions>?];

const CASES: Case[] = [
  ["no-discover", "discover.responds", "fail"],
  ["discover-no-result-type", "discover.result-type", "fail"],
  ["no-capability", "capability.declared", "fail"],
  ["list-not-array", "list.result", "fail"],
  ["descriptor-no-payload-schema", "list.descriptors", "fail"],
  ["bad-pagination", "list.pagination", "fail"],
  ["unknown-event-wrong-code", "error.unknown-event", "fail"],
  ["unsupported-mode-accepted", "error.unsupported-mode", "fail"],
  ["no-argument-validation", "error.invalid-arguments", "fail"],
  ["ignore-mcp-name", "headers.mcp-name", "fail"],
  ["poll-replays-on-null-cursor", "poll.bootstrap", "fail"],
  ["poll-missing-fields", "poll.result-fields", "warn"],
  ["poll-rejects-cursor", "poll.resume", "fail"],
  ["poll-occurrence-missing-timestamp", "poll.occurrence", "fail"],
  ["stream-no-active", "stream.active", "fail"],
  ["stream-no-subscription-id", "stream.subscription-id", "fail"],
  ["stream-no-heartbeat", "stream.heartbeat", "fail"],
  ["stream-occurrence-bad-data", "stream.occurrence", "fail"],
  ["no-auth-required", "subscribe.requires-auth", "fail"],
  ["accept-http-callback", "subscribe.rejects-http", "fail"],
  ["accept-bad-secret", "subscribe.rejects-bad-secret", "fail"],
  ["no-ssrf-check", "subscribe.rejects-private", "warn", { allowLoopbackCallbacks: false }, { allowLoopback: false }],
  ["skip-verification", "subscribe.verification", "fail"],
  ["subscribe-no-refresh-before", "subscribe.result", "fail"],
  ["non-idempotent-subscribe", "subscribe.idempotent", "fail"],
  ["ttl-exceeds-suggestion", "subscribe.ttl", "warn"],
  ["null-refresh-before", "subscribe.ttl", "fail"],
  ["unsubscribe-noop", "unsubscribe.removes", "fail"],
  ["unsubscribe-unknown-ok", "unsubscribe.not-found", "fail"],
  ["no-subscription-id-header", "delivery.headers", "fail"],
  ["sign-with-literal-secret", "delivery.signature", "fail"],
  ["webhook-id-from-event-id", "delivery.webhook-id", "fail"],
  ["stale-timestamp", "delivery.timestamp", "warn"],
  ["delivery-wrong-name", "delivery.occurrence", "fail"],
  ["oversized-delivery", "delivery.size", "warn"],
];

/** Some history first, so faults that replay old events have something to replay. */
async function seeded<T>(opts: Partial<ReferenceServerOptions>, fn: Parameters<typeof withServer<T>>[1]): Promise<T> {
  return withServer(opts, async (server) => {
    server.emit("ticket.created");
    server.emit("build.finished");
    return fn(server);
  });
}

describe("check: compliant servers", () => {
  it("passes the SEP-3415 reference server", async () => {
    await seeded({}, async (server) => {
      const report = await check(server);
      assert.deepEqual(flagged(report), [], describeFlagged(report));
      assert.equal(report.passed, true);
      assert.equal(rule(report, "subscribe.rejects-private").status, "skip");
      assert.equal(rule(report, "interop.consumers").status, "info");
      assert.match(rule(report, "interop.consumers").detail, /ChatGPT and the Vercel AI SDK look for the top-level/);
      const unrun = report.results.filter((r) => r.status === "skip" && r.id !== "subscribe.rejects-private");
      assert.deepEqual(unrun, [], "with a trigger and loopback callbacks every other rule runs");
      assert.equal(report.trigger, `${server.origin}/hookbench/fire`);
    });
  });

  it("passes the ChatGPT-dialect reference server under the chatgpt profile", async () => {
    await seeded({ profile: "chatgpt" }, async (server) => {
      const report = await check(server, { profile: "chatgpt" });
      assert.deepEqual(flagged(report), [], describeFlagged(report));
      assert.equal(rule(report, "delivery.webhook-id").status, "pass");
      assert.equal(rule(report, "poll.bootstrap").status, "skip");
    });
  });

  it("passes a strict server and explains why deliveries could not be tested", async () => {
    await seeded({ allowLoopbackCallbacks: false }, async (server) => {
      const report = await check(server, { allowLoopback: false });
      assert.deepEqual(flagged(report), [], describeFlagged(report));
      assert.equal(rule(report, "subscribe.rejects-private").status, "pass");
      assert.equal(rule(report, "subscribe.result").status, "skip");
      assert.match(rule(report, "subscribe.result").detail, /--callback-url/);
      assert.equal(rule(report, "delivery.signature").status, "skip");
    });
  });
});

describe("check: one broken rule per fault", () => {
  it("covers every fault and every rule", () => {
    assert.deepEqual(new Set(CASES.map((c) => c[0])), new Set(Object.keys(FAULTS)));
    const covered = new Set(CASES.map((c) => c[1]));
    for (const r of RULES) if (r.level !== "INTEROP") assert.ok(covered.has(r.id), `no fixture breaks ${r.id}`);
  });

  for (const [fault, id, status, serverOpts, checkOpts] of CASES) {
    it(`${fault} -> ${id} ${status}`, async () => {
      await seeded({ ...serverOpts, faults: [fault] }, async (server) => {
        const report = await check(server, checkOpts);
        const got = flagged(report).map((r) => `${r.id}=${r.status}`);
        assert.deepEqual(got, [`${id}=${status}`], describeFlagged(report));
        assert.equal(report.passed, status !== "fail");
      });
    });
  }
});

describe("check: dialect mismatches and edge cases", () => {
  it("flags a SEP-3415 server under the chatgpt profile", async () => {
    await seeded({}, async (server) => {
      const report = await check(server, { profile: "chatgpt" });
      const ids = flagged(report).map((r) => r.id);
      assert.ok(ids.includes("capability.declared"));
      assert.ok(ids.includes("delivery.webhook-id"));
    });
  });

  it("flags a ChatGPT-dialect server under the sep-3415 profile", async () => {
    await seeded({ profile: "chatgpt" }, async (server) => {
      const report = await check(server, { profile: "sep-3415" });
      const ids = flagged(report).map((r) => r.id);
      for (const id of ["capability.declared", "error.unknown-event", "delivery.webhook-id"]) assert.ok(ids.includes(id), `${id} in ${ids.join(", ")}`);
      assert.match(rule(report, "error.unknown-event").detail, /pre-2026-10-08 numbering/);
    });
  });

  it("asks for credentials when webhook mode needs them", async () => {
    await seeded({}, async (server) => {
      const report = await check(server, { headers: {} });
      assert.equal(rule(report, "subscribe.requires-auth").status, "pass");
      assert.match(rule(report, "subscribe.result").detail, /Authorization: Bearer/);
      assert.deepEqual(flagged(report), [], describeFlagged(report));
    });
  });

  it("skips occurrence rules without a trigger, and uses a custom one", async () => {
    await seeded({}, async (server) => {
      const noTrigger = await runCheck({ url: server.url, headers: { Authorization: "Bearer hookbench-dev" }, allowLoopback: true, triggerUrl: "http://127.0.0.1:9/none", deliveryWaitMs: 300, streamWatchMs: 2500 });
      assert.equal(rule(noTrigger, "delivery.signature").status, "skip");
      const fired: string[] = [];
      const custom = await check(server, {
        trigger: async (name, data) => {
          fired.push(name);
          server.emit(name, data);
        },
      });
      assert.deepEqual(flagged(custom), [], describeFlagged(custom));
      assert.ok(fired.includes("ticket.created"));
      assert.equal(custom.trigger, "custom trigger");
    });
  });

  it("reports an unreachable server and a server without Events", async () => {
    const down = await runCheck({ url: "http://127.0.0.1:9/mcp", timeoutMs: 1000 });
    assert.equal(rule(down, "discover.responds").status, "fail");
    assert.equal(down.passed, false);
    const srv = await httpServer(async (req, res) => {
      if (req.method !== "POST") return void res.writeHead(404).end();
      const msg = (await readJson(req)) as { id: number };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { resultType: "complete", supportedVersions: ["2026-07-28"], capabilities: { tools: {} } } }));
    });
    try {
      const report = await runCheck({ url: srv.url });
      assert.equal(rule(report, "capability.declared").status, "fail");
      assert.ok(report.results.filter((r) => r.id !== "capability.declared" && r.group !== "discovery").every((r) => r.status === "skip"));
    } finally {
      await srv.close();
    }
  });

  it("renders text, Markdown and JSON and computes exit codes", async () => {
    await seeded({ faults: ["poll-missing-fields"] }, async (server) => {
      const report = await check(server);
      const text = formatText(report, false);
      assert.match(text, /! WARN {2}poll\.result-fields/);
      assert.match(text, /PASS no MUST requirement failed/);
      const md = formatMarkdown(report);
      assert.match(md, /### ✅ MCP Events conformance: passed/);
      assert.match(md, /\| ⚠️ \| \[`poll\.result-fields`\]\(https:\/\/github\.com\//);
      assert.deepEqual(JSON.parse(formatJson(report)).summary, report.summary);
      assert.equal(exitCodeFor(report), 0);
      assert.equal(exitCodeFor(report, true), 1);
    });
  });
});
