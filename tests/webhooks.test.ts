/** Standard Webhooks signing and verification, SSRF address checks, and webhook POSTs. */
import { strict as assert } from "node:assert";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";
import { isLoopbackHost, isPublicAddress } from "../src/webhooks/net.js";
import { postWebhook } from "../src/webhooks/post.js";
import {
  generateSecret,
  hmacBase64,
  isHeaderSafeId,
  makeWebhookId,
  secretKey,
  secretProblem,
  signatureHeader,
  signDelivery,
  verifyDelivery,
} from "../src/webhooks/standard-webhooks.js";
import { httpServer } from "./helpers.js";

const secret = "whsec_" + Buffer.alloc(32, 7).toString("base64");
const body = Buffer.from('{"eventId":"evt_1","name":"ticket.created","timestamp":"2026-11-18T10:00:00Z","data":{"a":1}}');
const now = 1_763_460_000;

function verify(signature: string, opts: { id?: string; ts?: string; secrets?: string[]; payload?: Buffer } = {}) {
  return verifyDelivery({
    secrets: opts.secrets ?? [secret],
    webhookId: opts.id ?? "msg_abc",
    timestamp: opts.ts ?? String(now),
    signature,
    body: opts.payload ?? body,
    nowSeconds: now,
  });
}

describe("secrets", () => {
  it("generates valid standard-base64 secrets", () => {
    const s = generateSecret();
    assert.match(s, /^whsec_[A-Za-z0-9+/]+=*$/);
    assert.equal(secretProblem(s), null);
    assert.equal(secretKey(s).length, 32);
    assert.throws(() => generateSecret(8), RangeError);
  });

  it("explains every invalid secret", () => {
    assert.match(String(secretProblem("abc")), /start with "whsec_"/);
    assert.match(String(secretProblem("whsec_")), /nothing follows/);
    assert.match(String(secretProblem("whsec_" + Buffer.alloc(9).toString("base64"))), /9 bytes; it must be 24 to 64/);
    assert.match(String(secretProblem("whsec_" + Buffer.alloc(65).toString("base64"))), /65 bytes/);
    assert.match(String(secretProblem("whsec_" + Buffer.alloc(32, 255).toString("base64url"))), /URL-safe base64/);
    assert.match(String(secretProblem("whsec_!!!!")), /not base64/);
    assert.match(String(secretProblem(42)), /must be a string/);
  });
});

describe("signing", () => {
  it("signs id.timestamp.body with the decoded key", () => {
    const expected = createHmac("sha256", Buffer.alloc(32, 7)).update(`msg_abc.${now}.`).update(body).digest("base64");
    assert.equal(signatureHeader([secret], "msg_abc", String(now), body), `v1,${expected}`);
    const headers = signDelivery({ secrets: [secret], body, webhookId: "msg_abc", timestamp: now });
    assert.deepEqual(headers, { "webhook-id": "msg_abc", "webhook-timestamp": String(now), "webhook-signature": `v1,${expected}` });
  });

  it("makes header-safe, high-entropy ids", () => {
    const a = makeWebhookId();
    assert.match(a, /^msg_[A-Za-z0-9]{24}$/);
    assert.notEqual(a, makeWebhookId());
    assert.match(makeWebhookId("verification"), /^msg_verification_[A-Za-z0-9]{24}$/);
    assert.ok(isHeaderSafeId("msg_a-b_c"));
    assert.ok(!isHeaderSafeId("evt 1"));
  });
});

describe("verifyDelivery", () => {
  const good = signatureHeader([secret], "msg_abc", String(now), body);

  it("accepts a valid signature, one of several, and ignores v1a", () => {
    assert.equal(verify(good).ok, true);
    const other = "whsec_" + Buffer.alloc(32, 9).toString("base64");
    const rotated = `${signatureHeader([other], "msg_abc", String(now), body)} ${good}`;
    const r = verify(rotated);
    assert.equal(r.ok, true);
    assert.equal(r.v1Count, 2);
    assert.equal(verify(`v1a,AAAA ${good}`).v1aPresent, true);
    assert.equal(verify(rotated, { secrets: [other] }).ok, true);
  });

  it("rejects missing headers, bad and stale timestamps", () => {
    assert.equal(verifyDelivery({ secrets: [secret], webhookId: undefined, timestamp: "1", signature: good, body }).failure, "missing-headers");
    assert.equal(verify(good, { ts: "soon" }).failure, "bad-timestamp");
    const stale = signatureHeader([secret], "msg_abc", String(now - 600), body);
    const r = verify(stale, { ts: String(now - 600) });
    assert.equal(r.failure, "stale-timestamp");
    assert.equal(r.ageSeconds, 600);
    const future = signatureHeader([secret], "msg_abc", String(now + 600), body);
    assert.equal(verify(future, { ts: String(now + 600) }).failure, "future-timestamp");
    const ms = String(now * 1000);
    assert.match(verify(signatureHeader([secret], "msg_abc", ms, body), { ts: ms }).message, /milliseconds/);
  });

  it("rejects a tampered body", () => {
    assert.equal(verify(good, { payload: Buffer.from(body.toString().replace('"a":1', '"a":2')) }).failure, "signature-mismatch");
  });

  const diagnoses: Array<[string, () => string, RegExp]> = [
    ["the literal secret as the key", () => `v1,${hmacBase64(Buffer.from(secret, "utf8"), "msg_abc", String(now), body)}`, /literal "whsec_…" string/],
    ["the base64 text as the key", () => `v1,${hmacBase64(Buffer.from(secret.slice(6), "utf8"), "msg_abc", String(now), body)}`, /base64 text as the HMAC key/],
    ["hex output", () => `v1,${createHmac("sha256", secretKey(secret)).update(`msg_abc.${now}.`).update(body).digest("hex")}`, /hex/],
    ["a re-serialized body", () => `v1,${hmacBase64(secretKey(secret), "msg_abc", String(now), JSON.stringify(JSON.parse(body.toString())))}`, /re-serialized/],
    ["the eventId instead of the webhook-id", () => `v1,${hmacBase64(secretKey(secret), "evt_1", String(now), body)}`, /signed over the eventId/],
    ["a millisecond timestamp", () => `v1,${hmacBase64(secretKey(secret), "msg_abc", String(now * 1000), body)}`, /millisecond timestamp/],
    ["no id in the signed content", () => `v1,${hmacBase64(secretKey(secret), "", String(now), body)}`, /left the webhook-id or webhook-timestamp out/],
    ["a different secret", () => signatureHeader(["whsec_" + Buffer.alloc(32, 1).toString("base64")], "msg_abc", String(now), body), /different secret/],
  ];
  for (const [label, sig, expected] of diagnoses) {
    it(`diagnoses ${label}`, () => {
      // A body that re-serializes differently, so the re-serialization check has something to find.
      const spaced = label === "a re-serialized body" ? Buffer.from(JSON.stringify(JSON.parse(body.toString()), null, 1)) : body;
      const signature = label === "a re-serialized body" ? `v1,${hmacBase64(secretKey(secret), "msg_abc", String(now), JSON.stringify(JSON.parse(spaced.toString())))}` : sig();
      const r = verify(signature, { payload: spaced });
      assert.equal(r.ok, false);
      assert.match(String(r.diagnosis), expected);
    });
  }

  it("diagnoses a missing v1 prefix", () => {
    const bare = hmacBase64(secretKey(secret), "msg_abc", String(now), body);
    const r = verify(bare);
    assert.equal(r.failure, "no-v1-signature");
    assert.match(String(r.diagnosis), /no "v1," prefix/);
  });
});

describe("addresses", () => {
  it("knows what is publicly routable", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) assert.ok(isPublicAddress(ip), ip);
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255", "192.0.2.10", "::1", "::", "fc00::1", "fd12::1", "fe80::1", "ff02::1", "2001:db8::1", "::ffff:127.0.0.1", "64:ff9b::1", "not-an-ip"]) {
      assert.ok(!isPublicAddress(ip), ip);
    }
    assert.ok(isPublicAddress("172.32.0.1"));
    assert.ok(isLoopbackHost("localhost"));
    assert.ok(isLoopbackHost("127.0.0.9"));
    assert.ok(isLoopbackHost("[::1]"));
    assert.ok(!isLoopbackHost("example.com"));
  });
});

describe("postWebhook", () => {
  it("reports 2xx, 4xx, 5xx and redirects without following them", async () => {
    const srv = await httpServer((req, res) => {
      if (req.url === "/ok") res.writeHead(204).end();
      else if (req.url === "/gone") res.writeHead(410).end();
      else if (req.url === "/boom") res.writeHead(503).end();
      else res.writeHead(302, { location: "http://169.254.169.254/" }).end();
    });
    try {
      assert.deepEqual((await postWebhook(`${srv.url}/ok`, "{}", {}, { allowPrivateNetworks: true })).ok, true);
      const gone = await postWebhook(`${srv.url}/gone`, "{}", {}, { allowPrivateNetworks: true });
      assert.equal(gone.status, 410);
      assert.equal(gone.category, "http_4xx");
      assert.equal((await postWebhook(`${srv.url}/boom`, "{}", {}, { allowPrivateNetworks: true })).category, "http_5xx");
      const redirect = await postWebhook(`${srv.url}/redirect`, "{}", {}, { allowPrivateNetworks: true });
      assert.equal(redirect.ok, false);
      assert.equal(redirect.status, 302);
    } finally {
      await srv.close();
    }
  });

  it("refuses private addresses unless allowed, and classifies connection failures", async () => {
    const srv = await httpServer((_req, res) => res.writeHead(200).end());
    const port = srv.port;
    try {
      const blocked = await postWebhook(`http://localhost:${port}/`, "{}", {});
      assert.equal(blocked.ok, false);
      assert.equal(blocked.category, "connection_refused");
      assert.match(String(blocked.detail), /non-public/);
      assert.equal((await postWebhook(`http://localhost:${port}/`, "{}", {}, { allowPrivateNetworks: true })).ok, true);
    } finally {
      await srv.close();
    }
    const refused = await postWebhook(`http://127.0.0.1:${port}/`, "{}", {}, { allowPrivateNetworks: true });
    assert.equal(refused.category, "connection_refused");
  });

  it("times out on a silent endpoint", async () => {
    const srv = await httpServer(() => {
      /* never answers */
    });
    try {
      const r = await postWebhook(`${srv.url}/`, "{}", {}, { allowPrivateNetworks: true, timeoutMs: 150 });
      assert.equal(r.category, "timeout");
    } finally {
      await srv.close();
    }
  });
});
