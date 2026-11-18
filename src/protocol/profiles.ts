/**
 * Dialect profiles. SEP-3415 is the spec; ChatGPT ships a dialect that differs from it
 * (see docs/RESEARCH.md, "Three dialects in the wild").
 */
import {
  CHATGPT_GUIDE_URL,
  ERROR,
  LEGACY_EVENT_ERROR,
  MAX_DELIVERY_BYTES,
  SEP_PR_URL,
} from "./constants.js";
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

export const PROFILES: Record<ProfileName, Profile> = {
  "sep-3415": {
    name: "sep-3415",
    title: "SEP-3415 (MCP Events extension, protocol 2026-07-28)",
    capability: "extensions",
    webhookId: "independent",
    errors: {
      NotFound: ERROR.NotFound,
      Forbidden: ERROR.Forbidden,
      ResourceExhausted: ERROR.ResourceExhausted,
      Unsupported: ERROR.Unsupported,
      CallbackEndpointError: ERROR.CallbackEndpointError,
    },
    strictErrorCodes: true,
    modes: ["poll", "push", "webhook"],
    resultType: true,
    controlEnvelopes: true,
    maxBodyBytes: MAX_DELIVERY_BYTES,
    hardBodyLimit: false,
    reference: SEP_PR_URL,
  },
  chatgpt: {
    name: "chatgpt",
    title: "ChatGPT (OpenAI's MCP Events guide)",
    capability: "top-level",
    webhookId: "event-id",
    errors: { ...LEGACY_EVENT_ERROR },
    strictErrorCodes: false,
    modes: ["webhook"],
    resultType: false,
    controlEnvelopes: false,
    maxBodyBytes: MAX_DELIVERY_BYTES,
    hardBodyLimit: true,
    reference: CHATGPT_GUIDE_URL,
  },
};

export function getProfile(name: string | undefined): Profile {
  if (name === undefined) return PROFILES["sep-3415"];
  const p = (PROFILES as Record<string, Profile | undefined>)[name];
  if (!p) throw new Error(`unknown profile "${name}" (use sep-3415 or chatgpt)`);
  return p;
}

export const PROFILE_NAMES = Object.keys(PROFILES) as ProfileName[];
