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

export class InspectorStore extends EventEmitter {
  server: ServerSummary | undefined;
  events: EventDescriptor[] = [];
  readonly subscriptions = new Map<string, SubscriptionInfo>();
  readonly feed: FeedItem[] = [];
  private seq = 0;
  counts = { events: 0, problems: 0, heartbeats: 0 };

  setServer(info: ServerSummary): void {
    this.server = info;
    this.emit("change", { type: "server", server: info });
  }

  setCatalog(events: EventDescriptor[]): void {
    this.events = events;
    this.emit("change", { type: "catalog", events });
  }

  upsert(sub: SubscriptionInfo): void {
    this.subscriptions.set(sub.key, sub);
    this.emit("change", { type: "subscription", subscription: sub });
  }

  patch(key: string, patch: Partial<SubscriptionInfo>): void {
    const sub = this.subscriptions.get(key);
    if (!sub) return;
    Object.assign(sub, patch);
    this.emit("change", { type: "subscription", subscription: sub });
  }

  heartbeat(key: string, cursor: string | null | undefined): void {
    this.counts.heartbeats++;
    const sub = this.subscriptions.get(key);
    if (sub && cursor !== undefined) sub.cursor = cursor;
  }

  add(item: Omit<FeedItem, "seq" | "at"> & { at?: string }): FeedItem {
    const full: FeedItem = { seq: ++this.seq, at: item.at ?? new Date().toISOString(), ...item } as FeedItem;
    this.feed.push(full);
    if (this.feed.length > 1000) this.feed.shift();
    if (full.kind === "event") this.counts.events++;
    if (full.problems.length > 0) this.counts.problems++;
    if (full.kind === "event" && full.subscription) {
      const sub = this.subscriptions.get(full.subscription);
      if (sub && !full.duplicate) {
        sub.received++;
        sub.lastEventAt = full.at;
        this.emit("change", { type: "subscription", subscription: sub });
      }
    }
    this.emit("feed", full);
    this.emit("change", { type: "feed", item: full });
    return full;
  }

  info(text: string, extra: Partial<FeedItem> = {}): FeedItem {
    return this.add({ kind: "info", text, problems: [], notes: [], ...extra });
  }

  error(text: string, extra: Partial<FeedItem> = {}): FeedItem {
    return this.add({ kind: "error", text, problems: [], notes: [], ...extra });
  }

  snapshot(): JsonObject {
    return {
      server: this.server ?? null,
      events: this.events,
      subscriptions: [...this.subscriptions.values()],
      feed: this.feed.slice(-200),
      counts: this.counts,
    };
  }
}
