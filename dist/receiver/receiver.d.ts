/**
 * A local MCP Events webhook receiver. It verifies Standard Webhooks signatures over the raw
 * body, answers verification challenges, handles gap / terminated envelopes, deduplicates on
 * webhook-id, and records every request, with a plain-language reason when one is wrong.
 *
 * Each subscription gets its own callback path (/hooks/<token>), so the receiver knows which
 * secret to use before the server has told anyone the subscription id.
 */
import { EventEmitter } from "node:events";
import type { Profile } from "../protocol/profiles.js";
import type { EventOccurrence, JsonObject } from "../protocol/types.js";
import { type VerifyResult } from "../webhooks/standard-webhooks.js";
export interface ReceiverRoute {
    token: string;
    /** Usually the event type name. */
    label: string;
    /** Accepted secrets, newest last (rotation keeps the old one for a while). */
    secrets: string[];
    /** The server's subscription id, once known. */
    subscriptionId?: string;
    /** The event type this route expects, and its payloadSchema. */
    eventName?: string;
    payloadSchema?: JsonObject;
    profile: Profile;
}
export type ReceivedKind = "event" | "verification" | "gap" | "terminated" | "envelope" | "invalid";
export interface ReceivedDelivery {
    seq: number;
    at: string;
    token?: string;
    label?: string;
    method: string;
    path: string;
    /** The HTTP status Hookbench answered with. */
    status: number;
    headers: Record<string, string>;
    body: string;
    bodyBytes: number;
    json?: unknown;
    kind: ReceivedKind;
    verify?: VerifyResult;
    webhookId?: string;
    subscriptionIdHeader?: string;
    duplicate: boolean;
    /** Spec problems found in this request, in plain language. */
    problems: string[];
    /** Interop notes that are not spec violations (for example dialect mismatches). */
    notes: string[];
    occurrence?: EventOccurrence;
}
export interface ReceiverOptions {
    port?: number;
    host?: string;
    /** Public base URL that forwards to this receiver (an https tunnel), used in callback URLs. */
    publicUrl?: string;
    maxBodyBytes?: number;
    toleranceSeconds?: number;
}
/** Problems with an EventOccurrence body, in plain language. */
export declare function occurrenceProblems(body: unknown, expectedName?: string, payloadSchema?: JsonObject): string[];
export declare class WebhookReceiver extends EventEmitter {
    private readonly opts;
    private server;
    private base;
    private readonly routes;
    private readonly seenWebhookIds;
    private readonly seenEventIds;
    private readonly log;
    private seq;
    constructor(opts?: ReceiverOptions);
    get baseUrl(): string;
    start(): Promise<string>;
    newToken(): string;
    callbackUrl(token: string): string;
    addRoute(route: ReceiverRoute): void;
    updateRoute(token: string, patch: Partial<ReceiverRoute>): void;
    removeRoute(token: string): void;
    route(token: string): ReceiverRoute | undefined;
    deliveries(): ReceivedDelivery[];
    close(): Promise<void>;
    private record;
    private handle;
}
