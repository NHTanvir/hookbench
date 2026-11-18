import { type Profile, type ProfileName } from "../protocol/profiles.js";
import type { DeliveryMode, JsonObject } from "../protocol/types.js";
/** Each fault breaks one conformance rule. The fixtures in tests/ use them. */
export declare const FAULTS: {
    readonly "no-discover": "server/discover is not implemented";
    readonly "discover-no-result-type": "server/discover leaves out resultType";
    readonly "no-capability": "server/discover does not advertise Events";
    readonly "list-not-array": "events/list returns events as an object, not an array";
    readonly "descriptor-no-payload-schema": "an event type has no payloadSchema";
    readonly "bad-pagination": "events/list hands out a nextCursor that then fails";
    readonly "unknown-event-wrong-code": "an unknown event name gets InvalidParams instead of NotFound";
    readonly "unsupported-mode-accepted": "a delivery mode an event type does not list is served anyway";
    readonly "no-argument-validation": "subscription arguments are not checked against inputSchema";
    readonly "ignore-mcp-name": "the Mcp-Name header is not checked against params.name";
    readonly "poll-replays-on-null-cursor": "a poll with cursor null returns past events";
    readonly "poll-missing-fields": "poll results leave out hasMore, nextPollMs and truncated";
    readonly "poll-rejects-cursor": "a poll with the cursor the server just returned fails";
    readonly "poll-occurrence-missing-timestamp": "polled events have no timestamp";
    readonly "stream-no-active": "events/stream does not open with notifications/events/active";
    readonly "stream-no-subscription-id": "stream notifications leave out the subscription id";
    readonly "stream-no-heartbeat": "events/stream never sends a heartbeat";
    readonly "stream-occurrence-bad-data": "streamed events carry data that breaks payloadSchema";
    readonly "no-auth-required": "events/subscribe works without an authenticated principal";
    readonly "accept-http-callback": "events/subscribe accepts an http:// callback";
    readonly "accept-bad-secret": "events/subscribe accepts a malformed whsec_ secret";
    readonly "no-ssrf-check": "events/subscribe accepts a callback on a loopback address";
    readonly "skip-verification": "the callback is never verified before deliveries start";
    readonly "subscribe-no-refresh-before": "the subscribe result has no refreshBefore";
    readonly "non-idempotent-subscribe": "subscribing twice with the same key creates two subscriptions";
    readonly "ttl-exceeds-suggestion": "the granted TTL is longer than the client asked for";
    readonly "null-refresh-before": "a finite ttlMs is granted no expiry";
    readonly "unsubscribe-noop": "events/unsubscribe answers success but deliveries continue";
    readonly "unsubscribe-unknown-ok": "unsubscribing an unknown subscription succeeds";
    readonly "no-subscription-id-header": "event deliveries leave out X-MCP-Subscription-Id";
    readonly "sign-with-literal-secret": "event deliveries are signed with the literal whsec_ string as the key";
    readonly "webhook-id-from-event-id": "webhook-id is the eventId (the ChatGPT dialect, against SEP-3415)";
    readonly "stale-timestamp": "event deliveries carry a webhook-timestamp ten minutes old";
    readonly "delivery-wrong-name": "event deliveries name a different event type than the subscription";
    readonly "oversized-delivery": "event deliveries are larger than 256 KiB";
};
export type FaultName = keyof typeof FAULTS;
export interface ReferenceServerOptions {
    port?: number;
    host?: string;
    profile?: ProfileName;
    /** Accept http:// and private-network callbacks. Dev only: a conformant server refuses them. */
    allowLoopbackCallbacks?: boolean;
    /** Bearer token -> principal. Default { "hookbench-dev": "dev" }. */
    tokens?: Record<string, string>;
    heartbeat?: {
        defaultMs?: number;
        minMs?: number;
        maxMs?: number;
    };
    ttl?: {
        defaultMs?: number;
        minMs?: number;
        maxMs?: number;
    };
    nextPollMs?: number;
    retry?: {
        attempts?: number;
        baseDelayMs?: number;
        timeoutMs?: number;
    };
    faults?: FaultName[];
    /** Emit a sample event every N ms. */
    autoEmitMs?: number;
    log?: (line: string) => void;
}
export interface EmitResult {
    eventId: string;
    name: string;
    /** The delivery modes this event type offers. */
    modes: DeliveryMode[];
    cursor: string | null;
    delivered: {
        push: number;
        webhook: number;
    };
    warnings: string[];
}
export interface ReferenceServer {
    /** The MCP endpoint. */
    url: string;
    origin: string;
    fireUrl: string;
    profile: Profile;
    token: string | undefined;
    emit(name: string, data?: JsonObject, eventId?: string): EmitResult;
    terminate(name: string, reason?: string): number;
    state(): JsonObject;
    close(): Promise<void>;
}
export declare function startReferenceServer(opts?: ReferenceServerOptions): Promise<ReferenceServer>;
