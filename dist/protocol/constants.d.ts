/**
 * Wire constants for MCP Events (SEP-3415) on MCP protocol revision 2026-07-28.
 * Source notes: docs/RESEARCH.md.
 */
export declare const EVENTS_EXTENSION = "io.modelcontextprotocol/events";
/** The revision SEP-3415 is defined for. */
export declare const PROTOCOL_VERSION = "2026-07-28";
/** Latest initialize-based revision, used only when falling back to a legacy server. */
export declare const LEGACY_PROTOCOL_VERSION = "2025-11-25";
export declare const KNOWN_LEGACY_VERSIONS: string[];
export declare const META: {
    readonly protocolVersion: "io.modelcontextprotocol/protocolVersion";
    readonly clientCapabilities: "io.modelcontextprotocol/clientCapabilities";
    readonly clientInfo: "io.modelcontextprotocol/clientInfo";
    readonly serverInfo: "io.modelcontextprotocol/serverInfo";
    readonly subscriptionId: "io.modelcontextprotocol/subscriptionId";
};
export declare const METHODS: {
    readonly discover: "server/discover";
    readonly initialize: "initialize";
    readonly initialized: "notifications/initialized";
    readonly cancelled: "notifications/cancelled";
    readonly list: "events/list";
    readonly poll: "events/poll";
    readonly stream: "events/stream";
    readonly subscribe: "events/subscribe";
    readonly unsubscribe: "events/unsubscribe";
};
/** events/* requests that carry params.name and therefore an Mcp-Name header. */
export declare const NAMED_METHODS: ReadonlySet<string>;
export declare const NOTIFICATIONS: {
    readonly listChanged: "notifications/events/list_changed";
    readonly active: "notifications/events/active";
    readonly event: "notifications/events/event";
    readonly heartbeat: "notifications/events/heartbeat";
    readonly error: "notifications/events/error";
    readonly terminated: "notifications/events/terminated";
};
/** JSON-RPC and MCP error codes. Event codes are SEP-3415's (provisional until merged). */
export declare const ERROR: {
    readonly ParseError: -32700;
    readonly InvalidRequest: -32600;
    readonly MethodNotFound: -32601;
    readonly InvalidParams: -32602;
    readonly InternalError: -32603;
    readonly HeaderMismatch: -32020;
    readonly MissingRequiredClientCapability: -32021;
    readonly UnsupportedProtocolVersion: -32022;
    readonly NotFound: -32023;
    readonly Forbidden: -32024;
    readonly ResourceExhausted: -32025;
    readonly Unsupported: -32026;
    readonly CallbackEndpointError: -32027;
};
/**
 * The numbering design-sketch revisions used before 2026-10-08, in the same order.
 * OpenAI's ChatGPT guide still uses -32015 for CallbackEndpointError.
 */
export declare const LEGACY_EVENT_ERROR: {
    readonly NotFound: -32011;
    readonly Forbidden: -32012;
    readonly ResourceExhausted: -32013;
    readonly Unsupported: -32014;
    readonly CallbackEndpointError: -32015;
};
/** Header names, lower-cased (HTTP header names are case-insensitive). */
export declare const HEADERS: {
    readonly protocolVersion: "mcp-protocol-version";
    readonly method: "mcp-method";
    readonly name: "mcp-name";
    readonly sessionId: "mcp-session-id";
    readonly paramPrefix: "mcp-param-";
    readonly webhookId: "webhook-id";
    readonly webhookTimestamp: "webhook-timestamp";
    readonly webhookSignature: "webhook-signature";
    readonly subscriptionId: "x-mcp-subscription-id";
};
export declare const DELIVERY_MODES: readonly ["poll", "push", "webhook"];
/** The only values `deliveryStatus.lastError` and `CallbackEndpointError.data.reason` may take. */
export declare const CALLBACK_ERROR_REASONS: readonly ["connection_refused", "timeout", "tls_error", "http_4xx", "http_5xx", "challenge_failed"];
/** SEP-3415: servers SHOULD keep delivery bodies at or under 256 KiB; ChatGPT enforces it. */
export declare const MAX_DELIVERY_BYTES: number;
/** SEP-3415: receivers SHOULD reject deliveries whose timestamp is more than 5 minutes old. */
export declare const TIMESTAMP_TOLERANCE_SECONDS = 300;
/** SEP-3415: clients SHOULD apply a poll floor, default 1000 ms. */
export declare const POLL_FLOOR_MS = 1000;
export declare const SEP_PR_URL = "https://github.com/modelcontextprotocol/modelcontextprotocol/pull/3415";
/** Pinned text of the SEP as read for this release (PR head 60b15c1). */
export declare const SEP_TEXT_URL = "https://github.com/pja-ant/modelcontextprotocol/blob/60b15c16f2e7265ea34ac51099dc5be62f734692/seps/3415-events-extension.md";
export declare const CHATGPT_GUIDE_URL = "https://developers.openai.com/plugins/build/mcp-events";
export declare function sepSection(anchor: string): string;
