/** Message shapes from SEP-3415. Optional fields follow the SEP's "absent means null" rules. */

export type JsonObject = Record<string, unknown>;

export type DeliveryMode = "poll" | "push" | "webhook";

export interface EventDescriptor {
  name: string;
  description?: string;
  delivery: DeliveryMode[];
  inputSchema: JsonObject;
  payloadSchema: JsonObject;
  _meta?: JsonObject;
}

export interface EventOccurrence {
  eventId: string;
  name: string;
  timestamp: string;
  data: JsonObject;
  cursor?: string | null;
  _meta?: JsonObject;
}

export interface ListEventsResult {
  resultType?: string;
  events: EventDescriptor[];
  nextCursor?: string;
}

export interface PollParams {
  name: string;
  arguments?: JsonObject;
  cursor?: string | null;
  maxAgeMs?: number;
  maxEvents?: number;
}

export interface PollResult {
  resultType?: string;
  events: EventOccurrence[];
  cursor?: string | null;
  truncated?: boolean;
  hasMore?: boolean;
  nextPollMs?: number;
}

export interface StreamParams {
  name: string;
  arguments?: JsonObject;
  cursor?: string | null;
  maxAgeMs?: number;
  heartbeatMs?: number;
}

export interface WebhookDeliveryTarget {
  mode: "webhook";
  url: string;
  secret: string;
}

export interface SubscribeParams {
  name: string;
  arguments?: JsonObject;
  delivery: WebhookDeliveryTarget;
  cursor?: string | null;
  maxAgeMs?: number;
  /** Omitted = server default; null = ask for no expiry. */
  ttlMs?: number | null;
}

export interface DeliveryStatus {
  active: boolean;
  lastDeliveryAt?: string | null;
  lastError?: string | null;
  failedSince?: string;
  throttled?: boolean;
  retryAfterMs?: number;
}

export interface SubscribeResult {
  resultType?: string;
  id: string;
  refreshBefore: string | null;
  cursor?: string | null;
  truncated?: boolean;
  deliveryStatus?: DeliveryStatus;
}

export interface UnsubscribeParams {
  name: string;
  arguments?: JsonObject;
  delivery: { mode?: "webhook"; url: string };
}

export interface NestedError {
  code: number;
  message: string;
  data?: unknown;
}

export type ControlEnvelope =
  | { type: "gap"; cursor?: string | null }
  | { type: "terminated"; error: NestedError }
  | { type: "verification"; challenge: string };

export interface ServerIdentity {
  name?: string;
  version?: string;
}
