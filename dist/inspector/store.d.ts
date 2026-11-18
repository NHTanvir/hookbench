/**
 * The inspector's state: the server, its event types, every active subscription and a feed
 * of everything that arrived. The terminal log and the web view both render from here.
 */
import { EventEmitter } from "node:events";
import type { DeliveryMode, EventDescriptor, JsonObject } from "../protocol/types.js";
export type SubscriptionStatus = "starting" | "active" | "reconnecting" | "error" | "closed" | "terminated";
export interface SubscriptionInfo {
    key: string;
    name: string;
    mode: DeliveryMode;
    arguments: JsonObject;
    status: SubscriptionStatus;
    /** Webhook subscription id, or the events/stream request id. */
    serverId?: string;
    cursor?: string | null;
    refreshBefore?: string | null;
    heartbeatMs?: number;
    nextPollMs?: number;
    callbackUrl?: string;
    received: number;
    lastEventAt?: string;
    detail?: string;
}
export type FeedKind = "event" | "gap" | "terminated" | "verification" | "error" | "rejected" | "info";
export interface FeedItem {
    seq: number;
    at: string;
    kind: FeedKind;
    subscription?: string;
    name?: string;
    mode?: DeliveryMode;
    eventId?: string;
    webhookId?: string;
    cursor?: string | null;
    data?: unknown;
    /** The whole payload as it arrived (parsed). */
    body?: unknown;
    headers?: Record<string, string>;
    signature?: "verified" | "invalid" | "n/a";
    status?: number;
    problems: string[];
    notes: string[];
    duplicate?: boolean;
    text?: string;
}
export interface ServerSummary {
    url: string;
    name?: string;
    version?: string;
    protocolVersion?: string;
    era?: string;
    capabilityKey?: string;
    profile: string;
}
export declare class InspectorStore extends EventEmitter {
    server: ServerSummary | undefined;
    events: EventDescriptor[];
    readonly subscriptions: Map<string, SubscriptionInfo>;
    readonly feed: FeedItem[];
    private seq;
    counts: {
        events: number;
        problems: number;
        heartbeats: number;
    };
    setServer(info: ServerSummary): void;
    setCatalog(events: EventDescriptor[]): void;
    upsert(sub: SubscriptionInfo): void;
    patch(key: string, patch: Partial<SubscriptionInfo>): void;
    heartbeat(key: string, cursor: string | null | undefined): void;
    add(item: Omit<FeedItem, "seq" | "at"> & {
        at?: string;
    }): FeedItem;
    info(text: string, extra?: Partial<FeedItem>): FeedItem;
    error(text: string, extra?: Partial<FeedItem>): FeedItem;
    snapshot(): JsonObject;
}
