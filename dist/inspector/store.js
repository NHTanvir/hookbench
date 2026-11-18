/**
 * The inspector's state: the server, its event types, every active subscription and a feed
 * of everything that arrived. The terminal log and the web view both render from here.
 */
import { EventEmitter } from "node:events";
export class InspectorStore extends EventEmitter {
    server;
    events = [];
    subscriptions = new Map();
    feed = [];
    seq = 0;
    counts = { events: 0, problems: 0, heartbeats: 0 };
    setServer(info) {
        this.server = info;
        this.emit("change", { type: "server", server: info });
    }
    setCatalog(events) {
        this.events = events;
        this.emit("change", { type: "catalog", events });
    }
    upsert(sub) {
        this.subscriptions.set(sub.key, sub);
        this.emit("change", { type: "subscription", subscription: sub });
    }
    patch(key, patch) {
        const sub = this.subscriptions.get(key);
        if (!sub)
            return;
        Object.assign(sub, patch);
        this.emit("change", { type: "subscription", subscription: sub });
    }
    heartbeat(key, cursor) {
        this.counts.heartbeats++;
        const sub = this.subscriptions.get(key);
        if (sub && cursor !== undefined)
            sub.cursor = cursor;
    }
    add(item) {
        const full = { seq: ++this.seq, at: item.at ?? new Date().toISOString(), ...item };
        this.feed.push(full);
        if (this.feed.length > 1000)
            this.feed.shift();
        if (full.kind === "event")
            this.counts.events++;
        if (full.problems.length > 0)
            this.counts.problems++;
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
    info(text, extra = {}) {
        return this.add({ kind: "info", text, problems: [], notes: [], ...extra });
    }
    error(text, extra = {}) {
        return this.add({ kind: "error", text, problems: [], notes: [], ...extra });
    }
    snapshot() {
        return {
            server: this.server ?? null,
            events: this.events,
            subscriptions: [...this.subscriptions.values()],
            feed: this.feed.slice(-200),
            counts: this.counts,
        };
    }
}
