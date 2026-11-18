/**
 * The mock MCP Events consumer behind `hookbench connect`. It discovers the server, lists
 * event types, and keeps one subscription per event type alive in whichever delivery mode
 * fits, the way a client SDK would: poll loops with a floor and hasMore draining, push
 * streams with heartbeat watchdogs and cursor resume, webhook subscriptions with a generated
 * secret, verified deliveries and refresh before refreshBefore.
 */
import { McpEventsClient, type Discovery } from "../client/client.js";
import { type ProfileName } from "../protocol/profiles.js";
import type { DeliveryMode, EventDescriptor, JsonObject } from "../protocol/types.js";
import { WebhookReceiver } from "../receiver/receiver.js";
import { InspectorStore } from "../inspector/store.js";
export interface SubscriptionRequest {
    name: string;
    mode?: DeliveryMode | "auto";
    arguments?: JsonObject;
}
export interface ConsumerOptions {
    url: string;
    profile?: ProfileName;
    headers?: Record<string, string>;
    /** Which event types to subscribe to. Default: all of them, mode chosen automatically. */
    subscriptions?: SubscriptionRequest[];
    /** Default mode for event types without one. */
    mode?: DeliveryMode | "auto";
    /** Arguments for event types subscribed without their own (when `subscriptions` is not given). */
    defaultArguments?: JsonObject;
    /** Public https URL that forwards to the local receiver (a tunnel). */
    callbackUrl?: string;
    /** "auto": webhook only when a callback URL is given or nothing else is offered. */
    webhook?: "auto" | "on" | "off";
    receiverPort?: number;
    /** Explain that a local http callback only works with servers that allow it (default true). */
    loopbackNotice?: boolean;
    ttlMs?: number;
    heartbeatMs?: number;
    pollFloorMs?: number;
    timeoutMs?: number;
    era?: "modern" | "legacy";
    store?: InspectorStore;
}
export interface Consumer {
    store: InspectorStore;
    client: McpEventsClient;
    receiver: WebhookReceiver | undefined;
    discovery: Discovery;
    events: EventDescriptor[];
    stop(): Promise<void>;
}
export declare function startConsumer(opts: ConsumerOptions): Promise<Consumer>;
