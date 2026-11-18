/** Every command through the real CLI entry point. */
import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { HELP, main } from "../src/cli.js";
import { getProfile } from "../src/protocol/profiles.js";
import { WebhookReceiver } from "../src/receiver/receiver.js";
import { VERSION } from "../src/version.js";
import { generateSecret } from "../src/webhooks/standard-webhooks.js";
import { fakeIo, sleep, waitFor, withServer } from "./helpers.js";

const tmp = mkdtempSync(join(tmpdir(), "hookbench-test-"));

describe("cli: basics", () => {
  it("prints help, per-command help and the version", async () => {
    const a = fakeIo();
    assert.equal(await main([], a.io), 0);
    assert.equal(a.out(), HELP);
    const b = fakeIo();
    assert.equal(await main(["--version"], b.io), 0);
    assert.equal(b.out().trim(), VERSION);
    for (const cmd of ["demo", "connect", "fire", "check", "serve"]) {
      const h = fakeIo();
      assert.equal(await main([cmd, "--help"], h.io), 0);
      assert.match(h.out(), new RegExp(`hookbench ${cmd}`));
      const t = fakeIo();
      await main(["help", cmd], t.io);
      assert.equal(t.out(), h.out());
    }
  });

  it("exits 2 on usage errors with a pointer to --help", async () => {
    for (const argv of [["nope"], ["check"], ["check", "not a url"], ["check", "http://x", "--format", "xml"], ["connect", "http://x", "--callback-url", "http://insecure"], ["fire"], ["fire", "x", "--to", "http://127.0.0.1:9"], ["serve", "--fault", "bogus"], ["check", "http://x", "--bogus"], ["fire", "x", "--payload", "/nonexistent.json"]]) {
      const f = fakeIo();
      assert.equal(await main(argv, f.io), 2, argv.join(" "));
      assert.ok(f.err().length > 0, argv.join(" "));
    }
  });
});

describe("cli: check", () => {
  it("exits 0 for a compliant server and writes the report files", async () => {
    await withServer({}, async (server) => {
      const out = join(tmp, "report.json");
      const summary = join(tmp, "summary.md");
      writeFileSync(summary, "");
      const f = fakeIo();
      const code = await main(["check", server.url, "--header", "Authorization: Bearer hookbench-dev", "--allow-loopback", "--no-color", "--format", "json", "--output", out, "--summary", summary, "--stream-watch", "2500"], f.io);
      assert.equal(code, 0, f.out());
      assert.equal(JSON.parse(f.out()).passed, true);
      assert.equal(JSON.parse(readFileSync(out, "utf8")).profile, "sep-3415");
      assert.match(readFileSync(summary, "utf8"), /MCP Events conformance: passed/);
    });
  });

  it("exits 1 when a MUST fails, and on warnings with --strict", async () => {
    await withServer({ faults: ["ignore-mcp-name"] }, async (server) => {
      const f = fakeIo();
      assert.equal(await main(["check", server.url, "-H", "Authorization: Bearer hookbench-dev", "--allow-loopback", "--no-color", "--quiet", "--stream-watch", "2500"], f.io), 1);
      assert.match(f.out(), /✗ FAIL {2}headers\.mcp-name/);
    });
    await withServer({ faults: ["poll-missing-fields"] }, async (server) => {
      const args = ["check", server.url, "-H", "Authorization: Bearer hookbench-dev", "--allow-loopback", "--no-color", "--quiet", "--format", "markdown", "--stream-watch", "2500"];
      assert.equal(await main(args, fakeIo().io), 0);
      assert.equal(await main([...args, "--strict"], fakeIo().io), 1);
    });
  });
});

describe("cli: fire", () => {
  it("fires on the reference server, terminates, and explains errors", async () => {
    await withServer({}, async (server) => {
      const payload = join(tmp, "payload.json");
      writeFileSync(payload, JSON.stringify({ ticketId: "T-9", title: "From a file", priority: "high", project: "web" }));
      const f = fakeIo();
      assert.equal(await main(["fire", "ticket.created", "--server", server.url, "--payload", payload, "--no-color"], f.io), 0);
      assert.match(f.out(), /fired ticket\.created evt_/);
      assert.match(f.out(), /poll subscribers get it on their next poll/);
      const j = fakeIo();
      assert.equal(await main(["fire", "alert.fired", "--server", server.origin, "--json", "--data", '{"alertId":"A","severity":"P1","service":"s","summary":"x"}'], j.io), 0);
      assert.deepEqual(JSON.parse(j.out()).modes, ["push", "webhook"]);
      const warn = fakeIo();
      await main(["fire", "ticket.created", "--server", server.url, "--data", '{"ticketId":1}', "--no-color"], warn.io);
      assert.match(warn.out(), /does not match payloadSchema/);
      const t = fakeIo();
      assert.equal(await main(["fire", "alert.fired", "--server", server.url, "--terminate", "--no-color"], t.io), 0);
      assert.match(t.out(), /terminated 0 subscription/);
      const unknown = fakeIo();
      assert.equal(await main(["fire", "nope", "--server", server.url, "--no-color"], unknown.io), 1);
      assert.match(unknown.err(), /Known event types: ticket.created/);
    });
    const down = fakeIo();
    assert.equal(await main(["fire", "ticket.created", "--server", "http://127.0.0.1:9", "--no-color"], down.io), 1);
    assert.match(down.err(), /cannot reach a Hookbench reference server/);
  });

  it("signs a delivery straight to a webhook receiver with --to", async () => {
    const receiver = new WebhookReceiver();
    await receiver.start();
    const secret = generateSecret();
    receiver.addRoute({ token: "t1", label: "ticket.created", secrets: [secret], subscriptionId: "sub_cli", profile: getProfile("sep-3415") });
    try {
      const f = fakeIo();
      const code = await main(["fire", "ticket.created", "--to", receiver.callbackUrl("t1"), "--secret", secret, "--subscription-id", "sub_cli", "--data", '{"a":1}', "--no-color"], f.io);
      assert.equal(code, 0, f.out());
      const d = receiver.deliveries().at(-1);
      assert.equal(d?.verify?.ok, true);
      assert.deepEqual((d?.json as { data: unknown }).data, { a: 1 });
      const wrong = fakeIo();
      assert.equal(await main(["fire", "ticket.created", "--to", receiver.callbackUrl("t1"), "--secret", generateSecret(), "--json"], wrong.io), 1);
      assert.equal(JSON.parse(wrong.out()).status, 401);
      const bad = fakeIo();
      assert.equal(await main(["fire", "x", "--to", receiver.callbackUrl("t1"), "--secret", "whsec_bad"], bad.io), 2);
    } finally {
      await receiver.close();
    }
  });
});

describe("cli: serve, connect and demo", () => {
  it("lists faults", async () => {
    const f = fakeIo();
    assert.equal(await main(["serve", "--list-faults"], f.io), 0);
    assert.match(f.out(), /sign-with-literal-secret/);
  });

  it("serves until interrupted", async () => {
    const f = fakeIo();
    const running = main(["serve", "--port", "0", "--allow-loopback-callbacks", "--fault", "poll-missing-fields", "--no-color"], f.io);
    await waitFor(() => f.out().includes("MCP endpoint"));
    assert.match(f.out(), /dev mode/);
    assert.match(f.out(), /faults on: poll-missing-fields/);
    process.emit("SIGINT");
    assert.equal(await running, 0);
  });

  it("connects, shows deliveries and unsubscribes on Ctrl+C", async () => {
    await withServer({}, async (server) => {
      const f = fakeIo();
      const running = main(["connect", server.url, "-H", "Authorization: Bearer hookbench-dev", "--event", "ticket.created:webhook", "--event", "build.finished:poll", "--args", 'ticket.created={"priority":"urgent"}', "--port", "0", "--no-color"], f.io);
      await waitFor(() => f.out().includes("ticket.created   webhook  active"), 5000);
      assert.match(f.out(), /inspector {2}http:\/\/127\.0\.0\.1:\d+/);
      server.emit("ticket.created", { ticketId: "T-1", title: "skip me", priority: "low", project: "web" });
      server.emit("ticket.created", { ticketId: "T-2", title: "deliver me", priority: "urgent", project: "web" });
      await waitFor(() => f.out().includes("deliver me"), 5000);
      assert.ok(!f.out().includes("skip me"), "arguments filter the subscription");
      process.emit("SIGINT");
      assert.equal(await running, 0);
      assert.match(f.out(), /unsubscribed/);
      assert.deepEqual((server.state()["subscriptions"] as { webhook: unknown[] }).webhook, []);
    });
  });

  it("connects with JSON output and --args for every event type", async () => {
    await withServer({}, async (server) => {
      const f = fakeIo();
      const running = main(["connect", server.url, "--mode", "push", "--args", '{"status":"failed"}', "--no-web", "--json"], f.io);
      await waitFor(() => f.out().split("\n").filter((l) => l.includes('"status":"active"')).length >= 1, 5000);
      process.emit("SIGINT");
      assert.equal(await running, 0);
      const lines = f.out().trim().split("\n").map((l) => JSON.parse(l) as { type: string; arguments?: unknown; name?: string });
      const build = lines.find((l) => l.type === "subscription" && l.name === "build.finished");
      assert.deepEqual(build?.arguments, { status: "failed" });
    });
  });

  it("runs the offline demo with --once", async () => {
    const f = fakeIo();
    assert.equal(await main(["demo", "--once", "--server-port", "0", "--no-color"], f.io), 0, f.out());
    assert.match(f.out(), /demo passed {2}3\/3 event types delivered/);
    assert.match(f.out(), /signed ✓/);
  });

  it("runs the interactive demo until interrupted", async () => {
    const f = fakeIo();
    const running = main(["demo", "--server-port", "0", "--port", "0", "--every", "200", "--no-color"], f.io);
    await waitFor(() => (f.out().match(/signed ✓/g) ?? []).length >= 2, 8000);
    assert.match(f.out(), /inspector {9}http:\/\/127\.0\.0\.1:\d+/);
    process.emit("SIGINT");
    assert.equal(await running, 0);
    await sleep(10);
  });
});
