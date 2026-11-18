import type { DeliveryMode } from "./types.js";
export type ProfileName = "sep-3415" | "chatgpt";
export interface EventErrorCodes {
    NotFound: number;
    Forbidden: number;
    ResourceExhausted: number;
    Unsupported: number;
    CallbackEndpointError: number;
}
export interface Profile {
    name: ProfileName;
    title: string;
    /** Where a server advertises Events. */
    capability: "extensions" | "top-level";
    /** How webhook-id relates to eventId on event deliveries. */
    webhookId: "independent" | "event-id";
    /** Error codes servers of this dialect return. */
    errors: EventErrorCodes;
    /** Whether a check should insist on these exact codes (false: any JSON-RPC error passes). */
    strictErrorCodes: boolean;
    /** Delivery modes a consumer of this dialect uses. */
    modes: DeliveryMode[];
    /** Results carry resultType: "complete". */
    resultType: boolean;
    /** gap and terminated envelopes are part of the dialect. */
    controlEnvelopes: boolean;
    maxBodyBytes: number;
    /** true when going over maxBodyBytes is a hard failure, not a SHOULD. */
    hardBodyLimit: boolean;
    reference: string;
}
export declare const PROFILES: Record<ProfileName, Profile>;
export declare function getProfile(name: string | undefined): Profile;
export declare const PROFILE_NAMES: ProfileName[];
