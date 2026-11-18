import type { FeedItem, InspectorStore, SubscriptionInfo } from "./store.js";
export interface LogOptions {
    out: {
        write(s: string): unknown;
    };
    color: boolean;
    json: boolean;
}
export declare function compact(value: unknown, max?: number): string;
export declare function formatFeedItem(item: FeedItem, color: boolean): string;
export declare function formatSubscription(sub: SubscriptionInfo, color: boolean): string;
/** Print the store's feed and subscription changes as they happen. Returns a detach function. */
export declare function attachTerminalLog(store: InspectorStore, opts: LogOptions): () => void;
