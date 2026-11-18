export type DeliveryErrorCategory = "connection_refused" | "timeout" | "tls_error" | "http_4xx" | "http_5xx" | "challenge_failed";
export interface WebhookResponse {
    ok: boolean;
    status?: number;
    body?: string;
    /** Set when the attempt failed: the SEP's fixed category, never raw endpoint output. */
    category?: DeliveryErrorCategory;
    /** Local detail for logs (not sent anywhere). */
    detail?: string;
}
export interface PostWebhookOptions {
    /** Allow loopback and private-network addresses (dev only). */
    allowPrivateNetworks?: boolean;
    timeoutMs?: number;
    /** Largest response body to read (the verification echo is tiny). */
    maxResponseBytes?: number;
}
export declare class BlockedAddressError extends Error {
    name: string;
    readonly code = "EBLOCKEDADDRESS";
}
export declare function categorize(err: unknown): DeliveryErrorCategory;
export declare function postWebhook(url: string, body: string | Buffer, headers: Record<string, string>, opts?: PostWebhookOptions): Promise<WebhookResponse>;
