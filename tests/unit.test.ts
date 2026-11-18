/** Pure modules: argument parsing, headers, schemas, profiles, version. */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { flagBool, flagInt, flagList, flagString, parseArgs, parseDuration, parseHeaders, UsageError } from "../src/util/args.js";
import { padEnd, palette, visibleLength } from "../src/util/color.js";
import { annotatedProperties, decodeHeaderValue, encodeHeaderValue, paramHeaders } from "../src/protocol/headers.js";
import { invalidArguments, sampleFromSchema, validate } from "../src/protocol/schema-lite.js";
import { errorName, isFailure, isNotification, isRequest, isResponse, RpcError } from "../src/protocol/jsonrpc.js";
import { getProfile, PROFILES } from "../src/protocol/profiles.js";
import { CATALOG, catalogFor, matchesArguments } from "../src/server/catalog.js";
import { VERSION } from "../src/version.js";

describe("args", () => {
  const spec = { header: { value: true, repeat: true, alias: "H" }, port: { value: true }, json: {}, color: {} };

  it("parses values, repeats, aliases, booleans and --no-", () => {
    const a = parseArgs(["url", "--header", "A: 1", "-H", "B: 2", "--port=4100", "--json", "--no-color", "rest"], spec);
    assert.deepEqual(a.positionals, ["url", "rest"]);
    assert.deepEqual(flagList(a, "header"), ["A: 1", "B: 2"]);
    assert.equal(flagString(a, "port"), "4100");
    assert.equal(flagBool(a, "json"), true);
    assert.equal(flagBool(a, "color", true), false);
    assert.equal(flagInt(a, "port", 0), 4100);
  });

  it("stops at -- and keeps the rest as positionals", () => {
    const a = parseArgs(["--json", "--", "--port", "x"], spec);
    assert.deepEqual(a.positionals, ["--port", "x"]);
  });

  it("rejects unknown flags, missing values and values on booleans", () => {
    assert.throws(() => parseArgs(["--nope"], spec), UsageError);
    assert.throws(() => parseArgs(["--port"], spec), /needs a value/);
    assert.throws(() => parseArgs(["--json=1"], spec), /does not take a value/);
    assert.throws(() => parseArgs(["-x"], spec), /unknown option -x/);
  });

  it("reads durations and headers", () => {
    assert.equal(parseDuration("1500"), 1500);
    assert.equal(parseDuration("2s"), 2000);
    assert.equal(parseDuration("1m"), 60000);
    assert.equal(parseDuration("abc"), undefined);
    assert.throws(() => flagInt(parseArgs(["--port", "-5"], spec), "port", 0), UsageError);
    assert.deepEqual(parseHeaders(["Authorization: Bearer a:b"]), { Authorization: "Bearer a:b" });
    assert.throws(() => parseHeaders(["no colon"]), UsageError);
    assert.throws(() => parseHeaders(["bad name: x"]), UsageError);
  });
});

describe("color", () => {
  it("wraps only when enabled and measures visible width", () => {
    assert.equal(palette(false).red("x"), "x");
    const red = palette(true).red("abc");
    assert.notEqual(red, "abc");
    assert.equal(visibleLength(red), 3);
    assert.equal(visibleLength(padEnd(red, 6)), 6);
  });
});

describe("Mcp-Name and Mcp-Param headers", () => {
  it("leaves plain ASCII alone and Base64-encodes the rest", () => {
    assert.equal(encodeHeaderValue("ticket.created"), "ticket.created");
    assert.equal(encodeHeaderValue("Hello, 世界"), "=?base64?SGVsbG8sIOS4lueVjA==?=");
    assert.equal(encodeHeaderValue(" padded "), "=?base64?IHBhZGRlZCA=?=");
    assert.equal(encodeHeaderValue("line1\nline2"), "=?base64?bGluZTEKbGluZTI=?=");
    assert.equal(encodeHeaderValue("=?base64?literal?="), "=?base64?PT9iYXNlNjQ/bGl0ZXJhbD89?=");
    for (const v of ["ticket.created", "Hello, 世界", " padded ", "=?base64?literal?="]) assert.equal(decodeHeaderValue(encodeHeaderValue(v)), v);
  });

  it("mirrors x-mcp-header arguments into Mcp-Param headers", () => {
    const schema = { type: "object", properties: { region: { type: "string", "x-mcp-header": "Region" }, n: { type: "integer", "x-mcp-header": "N" }, flag: { type: "boolean", "x-mcp-header": "Flag" }, other: { type: "string" } } };
    assert.deepEqual(paramHeaders(schema, { region: "us-west1", n: 42, flag: false, other: "x" }), { "Mcp-Param-Region": "us-west1", "Mcp-Param-N": "42", "Mcp-Param-Flag": "false" });
    assert.deepEqual(paramHeaders(schema, {}), {});
    assert.deepEqual([...annotatedProperties(schema)], [["region", "region"], ["n", "n"], ["flag", "flag"]]);
  });
});

describe("schema-lite", () => {
  const schema = {
    type: "object",
    required: ["id", "when"],
    properties: { id: { type: "string", minLength: 2 }, when: { type: "string", format: "date-time" }, n: { type: "integer", minimum: 0, maximum: 5 }, tag: { enum: ["a", "b"] }, list: { type: "array", items: { type: "number" } } },
    additionalProperties: false,
  };

  it("accepts a valid value and reports each kind of problem", () => {
    assert.deepEqual(validate({ id: "ab", when: "2026-11-18T10:00:00Z", n: 3, tag: "a", list: [1, 2.5] }, schema), []);
    const errors = validate({ id: "x", when: "yesterday", n: 9, tag: "c", list: ["no"], extra: 1 }, schema);
    for (const needle of ["shorter than 2", "not a date-time", "above 5", "must be one of", "expected number", "not allowed"]) {
      assert.ok(errors.some((e) => e.includes(needle)), `missing "${needle}" in ${JSON.stringify(errors)}`);
    }
    assert.ok(validate({}, schema).some((e) => e.endsWith("id: required")));
    assert.deepEqual(validate("text", { type: ["string", "null"] }), []);
    assert.deepEqual(validate(1.5, { type: "integer" }).length, 1);
    assert.deepEqual(validate({ a: 1 }, { anyOf: [{ type: "string" }, { type: "object" }] }), []);
    assert.equal(validate(1, false).length, 1);
  });

  it("builds samples that validate", () => {
    for (const entry of CATALOG) {
      const sample = sampleFromSchema(entry.descriptor.payloadSchema);
      assert.deepEqual(validate(sample, entry.descriptor.payloadSchema), [], entry.descriptor.name);
      assert.deepEqual(validate(entry.sample(3), entry.descriptor.payloadSchema), [], `${entry.descriptor.name} sample()`);
    }
    assert.equal(sampleFromSchema({ type: "integer", minimum: 3.2 }), 4);
    assert.equal(sampleFromSchema({ default: "d", type: "string" }), "d");
  });

  it("builds arguments that break a schema, or says it cannot", () => {
    assert.deepEqual(invalidArguments({ properties: { p: { type: "string", enum: ["a"] } } })?.args, { p: "__hookbench_not_in_enum__" });
    assert.deepEqual(invalidArguments({ properties: { p: { type: "string" } } })?.args, { p: 12345 });
    assert.deepEqual(invalidArguments({ properties: { p: { type: "integer" } } })?.args, { p: "not-a-number" });
    assert.deepEqual(invalidArguments({ properties: { p: { type: "boolean" } } })?.args, { p: "yes" });
    assert.deepEqual(invalidArguments({ type: "object", additionalProperties: false })?.args, { __hookbench_unknown__: true });
    assert.equal(invalidArguments({ type: "object" }), undefined);
    for (const entry of CATALOG) {
      const bad = invalidArguments(entry.descriptor.inputSchema);
      assert.ok(bad, entry.descriptor.name);
      assert.ok(validate(bad.args, entry.descriptor.inputSchema).length > 0, entry.descriptor.name);
    }
  });
});

describe("JSON-RPC helpers", () => {
  it("classifies messages and names error codes", () => {
    assert.ok(isRequest({ jsonrpc: "2.0", id: 1, method: "m" }));
    assert.ok(isNotification({ jsonrpc: "2.0", method: "m" }));
    assert.ok(isResponse({ jsonrpc: "2.0", id: 1, result: {} }));
    assert.ok(isFailure({ jsonrpc: "2.0", id: 1, error: { code: -1, message: "x" } }));
    assert.ok(!isResponse({ jsonrpc: "2.0", method: "m", result: {} }));
    assert.equal(errorName(-32023), "NotFound");
    assert.equal(errorName(-32015), "CallbackEndpointError (pre-SEP numbering)");
    assert.equal(errorName(12), "Error");
    const e = new RpcError({ code: -32024, message: "no" }, 200);
    assert.equal(e.code, -32024);
    assert.match(e.message, /Forbidden \(-32024\): no/);
  });
});

describe("profiles and the sample catalog", () => {
  it("keeps the two dialects apart", () => {
    assert.equal(getProfile(undefined).name, "sep-3415");
    assert.equal(PROFILES["sep-3415"].errors.CallbackEndpointError, -32027);
    assert.equal(PROFILES.chatgpt.errors.CallbackEndpointError, -32015);
    assert.deepEqual(PROFILES.chatgpt.modes, ["webhook"]);
    assert.throws(() => getProfile("nope"), /unknown profile/);
  });

  it("serves the catalog per dialect and matches arguments", () => {
    assert.deepEqual(catalogFor(["webhook"]).map((e) => e.descriptor.delivery), [["webhook"], ["webhook"], ["webhook"]]);
    assert.deepEqual(catalogFor(["poll", "push", "webhook"]).map((e) => e.descriptor.delivery), CATALOG.map((e) => e.descriptor.delivery));
    assert.ok(matchesArguments({ priority: "high" }, { priority: "high" }));
    assert.ok(!matchesArguments({ priority: "low" }, { priority: "high" }));
    assert.ok(matchesArguments({ priority: "low" }, {}));
    assert.ok(matchesArguments({ priority: "low" }, undefined));
  });
});

describe("version", () => {
  it("matches package.json", () => {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };
    assert.equal(VERSION, pkg.version);
  });
});
