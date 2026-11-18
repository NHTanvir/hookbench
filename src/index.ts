/**
 * Hookbench as a library: the reference MCP Events server, the conformance check, the mock
 * consumer, the webhook receiver, the inspector and the Standard Webhooks helpers.
 */
export { VERSION } from "./version.js";

export {
  EVENTS_EXTENSION,
  PROTOCOL_VERSION,
  ERROR,
  LEGACY_EVENT_ERROR,
  METHODS,
  NOTIFICATIONS,
  HEADERS,
  MAX_DELIVERY_BYTES,
  SEP_PR_URL,
} from "./protocol/constants.js";
export { PROFILES, getProfile, type Profile, type ProfileName } from "./protocol/profiles.js";
export type * from "./protocol/types.js";
export { RpcError, errorName } from "./protocol/jsonrpc.js";
export { encodeHeaderValue, decodeHeaderValue } from "./protocol/headers.js";
export { validate as validateSchema, sampleFromSchema } from "./protocol/schema-lite.js";

export { McpEventsClient, HttpError, type Discovery, type ClientOptions, type CapabilityKey } from "./client/client.js";

export {
  generateSecret,
  secretProblem,
  signDelivery,
  signatureHeader,
  verifyDelivery,
  makeWebhookId,
  type VerifyResult,
} from "./webhooks/standard-webhooks.js";
export { postWebhook } from "./webhooks/post.js";
export { isPublicAddress } from "./webhooks/net.js";

export { startReferenceServer, FAULTS, type FaultName, type ReferenceServer, type ReferenceServerOptions } from "./server/reference-server.js";
export { CATALOG } from "./server/catalog.js";

export { runCheck, type CheckOptions, type CheckReport, type RuleResult } from "./check/runner.js";
export { RULES, type RuleDef, type Level, type Status } from "./check/rules.js";
export { formatText, formatMarkdown, formatJson, exitCodeFor } from "./check/report.js";

export { startConsumer, type Consumer, type ConsumerOptions, type SubscriptionRequest } from "./consumer/consumer.js";
export { WebhookReceiver, occurrenceProblems, type ReceivedDelivery, type ReceiverRoute } from "./receiver/receiver.js";
export { InspectorStore, type FeedItem, type SubscriptionInfo } from "./inspector/store.js";
export { startInspectorWeb } from "./inspector/web.js";
