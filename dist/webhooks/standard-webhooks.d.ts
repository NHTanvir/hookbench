export declare const SECRET_PREFIX = "whsec_";
/** `whsec_` + standard base64 of CSPRNG bytes (32 by default; the scheme allows 24 to 64). */
export declare function generateSecret(bytes?: number): string;
/** Why a value is not a valid Standard Webhooks symmetric secret, or null when it is. */
export declare function secretProblem(secret: unknown): string | null;
/** The HMAC key for a secret: the base64-decoded bytes after the prefix. */
export declare function secretKey(secret: string): Buffer;
export declare function hmacBase64(key: Buffer, webhookId: string, timestamp: string, body: Buffer | string): string;
/** A `webhook-signature` header value. Several secrets give a space-delimited list (rotation). */
export declare function signatureHeader(secrets: string[], webhookId: string, timestamp: string, body: Buffer | string): string;
/** A high-entropy, header-safe message id: `msg_` + 24 base62 characters (or msg_<type>_ for envelopes). */
export declare function makeWebhookId(type?: string): string;
export declare function isHeaderSafeId(id: string): boolean;
export interface SignedHeaders {
    "webhook-id": string;
    "webhook-timestamp": string;
    "webhook-signature": string;
}
export declare function signDelivery(opts: {
    secrets: string[];
    body: Buffer | string;
    webhookId?: string;
    timestamp?: number;
}): SignedHeaders;
export type VerifyFailure = "missing-headers" | "bad-timestamp" | "stale-timestamp" | "future-timestamp" | "no-v1-signature" | "signature-mismatch";
export interface VerifyResult {
    ok: boolean;
    failure?: VerifyFailure;
    message: string;
    /** For a mismatch: which known mistake reproduces the signature the sender sent. */
    diagnosis?: string;
    /** Number of `v1,` signatures in the header. */
    v1Count: number;
    /** An asymmetric `v1a,` signature was present (ignored: Hookbench does not enforce server identity). */
    v1aPresent: boolean;
    /** Seconds between webhook-timestamp and now (positive = in the past). */
    ageSeconds?: number;
}
export interface VerifyInput {
    secrets: string[];
    webhookId: string | undefined;
    timestamp: string | undefined;
    signature: string | undefined;
    body: Buffer;
    nowSeconds?: number;
    toleranceSeconds?: number;
}
export declare function verifyDelivery(input: VerifyInput): VerifyResult;
/** Reproduce the sender's signature with known mistakes. Returns a fix, or a generic hint. */
export declare function diagnoseMismatch(secrets: string[], webhookId: string, timestamp: string, sent: string[], body: Buffer): string;
