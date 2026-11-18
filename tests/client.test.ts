/** The Streamable HTTP transport and the MCP Events client. */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { capabilityKeyOf, HttpError, McpEventsClient, unwrap } from "../src/client/client.js";
import { postRpc, readSse, TransportError } from "../src/client/transport.js";
import { RpcError } from "../src/protocol/jsonrpc.js";
import { AUTH, httpServer, readJson, withServer } from "./helpers.js";

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
}

async function collect(chunks: string[]) {
  const out = [];
  for await (const ev of readSse(streamOf(chunks))) out.push(ev);
  return out;
}

describe("SSE parsing", () => {
  it("handles split chunks, CRLF, comments, multi-line data and a missing final blank line", async () => {
    const events = await collect([": keepalive\r\n\r\nda", "ta: {\"a\":1}\r", "\n\r\nevent: x\ndata: line1\ndata: line2\nid: 7\n\n", "data: tail"]);
    assert.deepEqual(events, [
      { event: undefined, data: '{"a":1}', id: undefined },
      { event: "x", data: "line1\nline2", id: "7" },
      { event: undefined, data: "tail", id: undefined },
    ]);
  });

  it("survives a byte-at-a-time stream", async () => {
    const text = "data: {\"n\":1}\n\ndata: {\"n\":2}\n\n";
    const events = await collect(text.split(""));
    assert.deepEqual(events.map((e) => e.data), ['{"n":1}', '{"n":2}']);
  });
});

describe("postRpc", () => {
  it("reads a JSON response, an SSE response and plain text", async () => {
    const srv = await httpServer(async (req, res) => {
      const msg = (await readJson(req)) as { id: number; method: string };
      if (msg.method === "json") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { ok: true } }));
      } else if (msg.method === "sse") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: { p: 1 } })}\n\n`);
        res.write(`data: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { streamed: true } })}\n\n`);
        // Keep the stream open: the client must stop reading once the result arrives.
      } else {
        res.writeHead(404, { "content-type": "text/html" });
        res.end("<h1>nope</h1>");
      }
    });
    try {
      const a = await postRpc(srv.url, { jsonrpc: "2.0", id: 1, method: "json" }, { "content-type": "application/json" });
      assert.deepEqual(a.response, { jsonrpc: "2.0", id: 1, result: { ok: true } });
      const b = await postRpc(srv.url, { jsonrpc: "2.0", id: 2, method: "sse" }, { "content-type": "application/json" });
      assert.deepEqual(b.response, { jsonrpc: "2.0", id: 2, result: { streamed: true } });
      assert.equal(b.notifications.length, 1);
      const c = await postRpc(srv.url, { jsonrpc: "2.0", id: 3, method: "html" }, {});
      assert.equal(c.status, 404);
      assert.equal(c.response, undefined);
      assert.match(String(c.bodyText), /nope/);
      assert.throws(() => unwrap(c), (e: unknown) => e instanceof HttpError && /no MCP endpoint/.test(e.message));
    } finally {
      await srv.close();
    }
  });

  it("times out and reports unreachable servers", async () => {
    const srv = await httpServer(() => {
      /* never answers */
    });
    try {
      await assert.rejects(postRpc(srv.url, { jsonrpc: "2.0", id: 1, method: "x" }, {}, { timeoutMs: 100 }), TransportError);
    } finally {
      await srv.close();
    }
    await assert.rejects(postRpc("http://127.0.0.1:9/", { jsonrpc: "2.0", id: 1, method: "x" }, {}), /could not reach/);
  });
});

describe("McpEventsClient", () => {
  it("discovers a 2026-07-28 server and sends the per-request _meta and headers", async () => {
    await withServer({}, async (server) => {
      const c = new McpEventsClient({ url: server.url, headers: AUTH });
      const d = await c.discover();
      assert.equal(d.era, "modern");
      assert.equal(d.capabilityKey, "extensions");
      assert.equal(d.resultType, "complete");
      assert.deepEqual(d.serverInfo?.name, "hookbench-reference");
      const req = c.buildRequest("events/poll", { name: "build.finished", arguments: { branch: "main" } });
      const meta = req.params?.["_meta"] as Record<string, unknown>;
      assert.equal(meta["io.modelcontextprotocol/protocolVersion"], "2026-07-28");
      assert.deepEqual(meta["io.modelcontextprotocol/clientCapabilities"], { extensions: { "io.modelcontextprotocol/events": {} } });
      const { events } = await c.listEvents();
      assert.equal(events.length, 3);
      const headers = c.buildHeaders(c.buildRequest("events/poll", { name: "build.finished", arguments: { branch: "main" } }));
      assert.equal(headers["mcp-method"], "events/poll");
      assert.equal(headers["mcp-name"], "build.finished");
      assert.equal(headers["mcp-param-branch"], "main");
      assert.equal(headers["authorization"], "Bearer hookbench-dev");
      assert.equal(c.buildHeaders(req, { withoutConfiguredHeaders: true })["authorization"], undefined);
      assert.equal(c.buildHeaders(req, { overrideHeaders: { "mcp-name": null } })["mcp-name"], undefined);
    });
  });

  it("falls back to initialize when server/discover is not implemented", async () => {
    let initialized = false;
    const srv = await httpServer(async (req, res) => {
      const msg = (await readJson(req)) as { id?: number; method: string };
      res.setHeader("content-type", "application/json");
      if (msg.method === "server/discover") return res.writeHead(404).end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } }));
      if (msg.method === "initialize") {
        res.setHeader("mcp-session-id", "sess-1");
        return res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-03-26", capabilities: { events: {} }, serverInfo: { name: "legacy", version: "1" } } }));
      }
      if (msg.method === "notifications/initialized") {
        initialized = true;
        return res.writeHead(202).end();
      }
      assert.equal(req.headers["mcp-session-id"], "sess-1");
      return res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { events: [] } }));
    });
    try {
      const c = new McpEventsClient({ url: srv.url });
      const d = await c.discover();
      assert.equal(d.era, "legacy");
      assert.equal(d.protocolVersion, "2025-03-26");
      assert.equal(d.capabilityKey, "top-level");
      assert.match(String(d.fallbackReason), /-32601/);
      assert.ok(initialized);
      const list = await c.listEvents();
      assert.deepEqual(list.events, []);
      assert.equal(c.buildRequest("events/list").params?.["_meta"], undefined);
    } finally {
      await srv.close();
    }
  });

  it("raises RpcError with the code for JSON-RPC errors", async () => {
    await withServer({}, async (server) => {
      const c = new McpEventsClient({ url: server.url });
      await c.discover();
      await assert.rejects(c.poll({ name: "nope" }), (e: unknown) => e instanceof RpcError && e.code === -32023);
    });
  });

  it("names where Events is advertised", () => {
    assert.equal(capabilityKeyOf({ extensions: { "io.modelcontextprotocol/events": {} }, events: {} }).key, "both");
    assert.equal(capabilityKeyOf({ events: { listChanged: true } }).key, "top-level");
    assert.equal(capabilityKeyOf({ tools: {} }).key, "none");
    assert.equal(capabilityKeyOf(null).key, "none");
  });
});
