/**
 * The conformance rules `hookbench check` grades. Each one names the requirement it comes
 * from; MUST failures fail the check, SHOULD failures warn, INTEROP findings only inform.
 */
import { CHATGPT_GUIDE_URL, sepSection } from "../protocol/constants.js";
const BASE = "https://modelcontextprotocol.io/specification/2026-07-28";
export const RULES = [
    { id: "discover.responds", group: "discovery", level: "MUST", title: "server/discover answers", reference: `${BASE}/server/discover` },
    { id: "discover.result-type", group: "discovery", level: "MUST", title: 'results carry resultType: "complete"', reference: `${BASE}/basic/index#resulttype` },
    { id: "capability.declared", group: "discovery", level: "MUST", title: "Events is advertised in capabilities", reference: sepSection("capability-negotiation") },
    { id: "list.result", group: "list", level: "MUST", title: "events/list returns an events array", reference: sepSection("request-eventslist") },
    { id: "list.descriptors", group: "list", level: "MUST", title: "every event type has a name, delivery modes and both schemas", reference: sepSection("listing-available-events") },
    { id: "list.pagination", group: "list", level: "MUST", title: "nextCursor pages through the rest of the list", reference: sepSection("request-eventslist") },
    { id: "error.unknown-event", group: "errors", level: "MUST", title: "an unknown event name gets NotFound", reference: sepSection("error-handling") },
    { id: "error.unsupported-mode", group: "errors", level: "MUST", title: "a delivery mode the type does not offer gets Unsupported", reference: sepSection("error-handling") },
    { id: "error.invalid-arguments", group: "errors", level: "MUST", title: "arguments that break inputSchema get InvalidParams", reference: sepSection("error-handling") },
    { id: "headers.mcp-name", group: "errors", level: "MUST", title: "a missing or wrong Mcp-Name header gets 400 HeaderMismatch", reference: sepSection("streamable-http-routing-headers") },
    { id: "poll.bootstrap", group: "poll", level: "MUST", title: "events/poll with cursor null starts from now", reference: sepSection("poll-based-delivery") },
    { id: "poll.result-fields", group: "poll", level: "SHOULD", title: "poll results carry truncated, hasMore and nextPollMs", reference: sepSection("poll-based-delivery") },
    { id: "poll.resume", group: "poll", level: "MUST", title: "polling with the returned cursor works", reference: sepSection("cursor-lifecycle") },
    { id: "poll.occurrence", group: "poll", level: "MUST", title: "polled events are well-formed EventOccurrences", reference: sepSection("event-occurrences") },
    { id: "stream.active", group: "push", level: "MUST", title: "events/stream opens with notifications/events/active", reference: sepSection("push-based-delivery") },
    { id: "stream.subscription-id", group: "push", level: "MUST", title: "stream notifications carry the subscription id", reference: sepSection("push-based-delivery") },
    { id: "stream.heartbeat", group: "push", level: "MUST", title: "a quiet stream sends heartbeats", reference: sepSection("lifecycle") },
    { id: "stream.occurrence", group: "push", level: "MUST", title: "streamed events are well-formed EventOccurrences", reference: sepSection("event-occurrences") },
    { id: "subscribe.requires-auth", group: "webhook", level: "MUST", title: "events/subscribe without a principal gets Forbidden", reference: sepSection("subscription-identity") },
    { id: "subscribe.rejects-http", group: "webhook", level: "MUST", title: "an http:// callback gets InvalidParams", reference: sepSection("webhook-security") },
    { id: "subscribe.rejects-bad-secret", group: "webhook", level: "MUST", title: "a malformed whsec_ secret gets InvalidParams", reference: sepSection("subscribing-eventssubscribe") },
    { id: "subscribe.rejects-private", group: "webhook", level: "SHOULD", title: "a callback on a private address is refused", reference: sepSection("webhook-security") },
    { id: "subscribe.verification", group: "webhook", level: "MUST", title: "the callback is verified before any delivery", reference: sepSection("webhook-security") },
    { id: "subscribe.result", group: "webhook", level: "MUST", title: "the subscribe result has id, refreshBefore, cursor and truncated", reference: sepSection("subscribing-eventssubscribe") },
    { id: "subscribe.ttl", group: "webhook", level: "MUST", title: "the TTL grant respects the client's suggestion", reference: sepSection("subscription-ttl") },
    { id: "subscribe.idempotent", group: "webhook", level: "MUST", title: "subscribing again with the same key returns the same id", reference: sepSection("subscription-identity") },
    { id: "unsubscribe.removes", group: "webhook", level: "MUST", title: "events/unsubscribe ends the subscription", reference: sepSection("unsubscribing-eventsunsubscribe") },
    { id: "unsubscribe.not-found", group: "webhook", level: "MUST", title: "unsubscribing an unknown key gets NotFound", reference: sepSection("error-handling") },
    { id: "delivery.headers", group: "delivery", level: "MUST", title: "deliveries carry the Standard Webhooks headers and X-MCP-Subscription-Id", reference: sepSection("webhook-security") },
    { id: "delivery.signature", group: "delivery", level: "MUST", title: "the v1 HMAC signature verifies over the raw body", reference: sepSection("webhook-security") },
    { id: "delivery.webhook-id", group: "delivery", level: "MUST", title: "webhook-id follows the profile's rule", reference: sepSection("webhook-security") },
    { id: "delivery.timestamp", group: "delivery", level: "SHOULD", title: "webhook-timestamp is fresh Unix seconds", reference: sepSection("webhook-security") },
    { id: "delivery.occurrence", group: "delivery", level: "MUST", title: "the delivered body is a well-formed EventOccurrence", reference: sepSection("webhook-event-delivery") },
    { id: "delivery.size", group: "delivery", level: "SHOULD", title: "delivery bodies stay at or under 256 KiB", reference: sepSection("webhook-security") },
    { id: "interop.consumers", group: "interop", level: "INTEROP", title: "which shipped consumers can use this server", reference: CHATGPT_GUIDE_URL },
];
export const RULE_IDS = RULES.map((r) => r.id);
export function ruleById(id) {
    const r = RULES.find((x) => x.id === id);
    if (!r)
        throw new Error(`unknown rule ${id}`);
    return r;
}
