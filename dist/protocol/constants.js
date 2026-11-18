/**
 * Wire constants for MCP Events (SEP-3415) on MCP protocol revision 2026-07-28.
 * Source notes: docs/RESEARCH.md.
 */
export const EVENTS_EXTENSION = "io.modelcontextprotocol/events";
/** The revision SEP-3415 is defined for. */
export const PROTOCOL_VERSION = "2026-07-28";
/** Latest initialize-based revision, used only when falling back to a legacy server. */
export const LEGACY_PROTOCOL_VERSION = "2025-11-25";
export const KNOWN_LEGACY_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
export const META = {
    protocolVersion: "io.modelcontextprotocol/protocolVersion",
    clientCapabilities: "io.modelcontextprotocol/clientCapabilities",
    clientInfo: "io.modelcontextprotocol/clientInfo",
    serverInfo: "io.modelcontextprotocol/serverInfo",
    subscriptionId: "io.modelcontextprotocol/subscriptionId",
};
export const METHODS = {
    discover: "server/discover",
    initialize: "initialize",
    initialized: "notifications/initialized",
    cancelled: "notifications/cancelled",
    list: "events/list",
    poll: "events/poll",
    stream: "events/stream",
    subscribe: "events/subscribe",
    unsubscribe: "events/unsubscribe",
};
/** events/* requests that carry params.name and therefore an Mcp-Name header. */
export const NAMED_METHODS = new Set([
    METHODS.poll,
    METHODS.stream,
    METHODS.subscribe,
    METHODS.unsubscribe,
]);
export const NOTIFICATIONS = {
    listChanged: "notifications/events/list_changed",
    active: "notifications/events/active",
    event: "notifications/events/event",
    heartbeat: "notifications/events/heartbeat",
    error: "notifications/events/error",
    terminated: "notifications/events/terminated",
};
/** JSON-RPC and MCP error codes. Event codes are SEP-3415's (provisional until merged). */
export const ERROR = {
    ParseError: -32700,
    InvalidRequest: -32600,
    MethodNotFound: -32601,
    InvalidParams: -32602,
    InternalError: -32603,
    HeaderMismatch: -32020,
    MissingRequiredClientCapability: -32021,
    UnsupportedProtocolVersion: -32022,
    NotFound: -32023,
    Forbidden: -32024,
    ResourceExhausted: -32025,
    Unsupported: -32026,
    CallbackEndpointError: -32027,
};
/**
 * The numbering design-sketch revisions used before 2026-10-08, in the same order.
 * OpenAI's ChatGPT guide still uses -32015 for CallbackEndpointError.
 */
export const LEGACY_EVENT_ERROR = {
    NotFound: -32011,
    Forbidden: -32012,
    ResourceExhausted: -32013,
    Unsupported: -32014,
    CallbackEndpointError: -32015,
};
/** Header names, lower-cased (HTTP header names are case-insensitive). */
export const HEADERS = {
    protocolVersion: "mcp-protocol-version",
    method: "mcp-method",
    name: "mcp-name",
    sessionId: "mcp-session-id",
    paramPrefix: "mcp-param-",
    webhookId: "webhook-id",
    webhookTimestamp: "webhook-timestamp",
    webhookSignature: "webhook-signature",
    subscriptionId: "x-mcp-subscription-id",
};
export const DELIVERY_MODES = ["poll", "push", "webhook"];
/** The only values `deliveryStatus.lastError` and `CallbackEndpointError.data.reason` may take. */
export const CALLBACK_ERROR_REASONS = [
    "connection_refused",
    "timeout",
    "tls_error",
    "http_4xx",
    "http_5xx",
    "challenge_failed",
];
/** SEP-3415: servers SHOULD keep delivery bodies at or under 256 KiB; ChatGPT enforces it. */
export const MAX_DELIVERY_BYTES = 256 * 1024;
/** SEP-3415: receivers SHOULD reject deliveries whose timestamp is more than 5 minutes old. */
export const TIMESTAMP_TOLERANCE_SECONDS = 300;
/** SEP-3415: clients SHOULD apply a poll floor, default 1000 ms. */
export const POLL_FLOOR_MS = 1000;
export const SEP_PR_URL = "https://github.com/modelcontextprotocol/modelcontextprotocol/pull/3415";
/** Pinned text of the SEP as read for this release (PR head 60b15c1). */
export const SEP_TEXT_URL = "https://github.com/pja-ant/modelcontextprotocol/blob/60b15c16f2e7265ea34ac51099dc5be62f734692/seps/3415-events-extension.md";
export const CHATGPT_GUIDE_URL = "https://developers.openai.com/plugins/build/mcp-events";
export function sepSection(anchor) {
    return `${SEP_TEXT_URL}#${anchor}`;
}
