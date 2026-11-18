/** The inspector's live terminal log (or JSON lines with --json). */
import { padEnd, palette } from "../util/color.js";
import type { EventDescriptor } from "../protocol/types.js";
import type { FeedItem, InspectorStore, ServerSummary, SubscriptionInfo } from "./store.js";

export interface LogOptions {
  out: { write(s: string): unknown };
  color: boolean;
  json: boolean;
}

function clock(iso: string): string {
  const d = new Date(iso);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
}

export function compact(value: unknown, max = 110): string {
  let s: string;
  try {
    s = JSON.stringify(value) ?? "";
  } catch {
    s = String(value);
  }
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export function formatFeedItem(item: FeedItem, color: boolean): string {
  const c = palette(color);
  const t = c.gray(clock(item.at));
  const name = padEnd(c.bold(item.name ?? "-"), 16);
  const mode = padEnd(c.cyan(item.mode ?? ""), 8);
  const lines: string[] = [];
  switch (item.kind) {
    case "event": {
      const sig = item.signature === "verified" ? c.green("signed ✓") : item.signature === "invalid" ? c.red("bad signature") : "";
      const dup = item.duplicate ? c.yellow(" duplicate") : "";
      lines.push(`${t}  ${name} ${mode} ${c.gray(item.eventId ?? "")}  ${sig}${dup}  ${compact(item.data)}`);
      break;
    }
    case "gap":
      lines.push(`${t}  ${name} ${mode} ${c.yellow("gap")}: events were skipped; fresh cursor ${c.gray(String(item.cursor ?? null))}`);
      break;
    case "terminated":
      lines.push(`${t}  ${name} ${mode} ${c.red("terminated")}: ${item.text ?? ""}`);
      break;
    case "verification":
      lines.push(`${t}  ${name} ${mode} ${c.dim("verification challenge answered")}`);
      break;
    case "rejected":
      lines.push(`${t}  ${name} ${mode} ${c.red(`rejected (${item.status ?? "?"})`)} ${item.text ?? ""}`);
      break;
    case "error":
      lines.push(`${t}  ${c.red("error")}  ${item.text ?? ""}`);
      break;
    case "info":
      lines.push(`${t}  ${c.dim(item.text ?? "")}`);
      break;
  }
  for (const p of item.problems) lines.push(`          ${c.red("✗")} ${p}`);
  for (const n of item.notes) lines.push(`          ${c.yellow("·")} ${c.dim(n)}`);
  return lines.join("\n");
}

export function formatSubscription(sub: SubscriptionInfo, color: boolean): string {
  const c = palette(color);
  const status =
    sub.status === "active" ? c.green(sub.status) : sub.status === "error" || sub.status === "terminated" ? c.red(sub.status) : c.yellow(sub.status);
  const extra: string[] = [];
  if (sub.serverId) extra.push(`id ${sub.serverId}`);
  if (sub.mode === "webhook" && sub.refreshBefore !== undefined) extra.push(sub.refreshBefore === null ? "no expiry" : `refresh before ${clock(sub.refreshBefore)}`);
  if (sub.mode === "push" && sub.heartbeatMs) extra.push(`heartbeat ${sub.heartbeatMs} ms`);
  if (sub.mode === "poll" && sub.nextPollMs) extra.push(`every ${sub.nextPollMs} ms`);
  if (sub.detail) extra.push(sub.detail);
  return `${c.gray(clock(new Date().toISOString()))}  ${padEnd(c.bold(sub.name), 16)} ${padEnd(c.cyan(sub.mode), 8)} ${status}${extra.length ? c.dim(`  ${extra.join(", ")}`) : ""}`;
}

/** Print the store's feed and subscription changes as they happen. Returns a detach function. */
export function attachTerminalLog(store: InspectorStore, opts: LogOptions): () => void {
  const printed = new Map<string, string>();
  const onFeed = (item: FeedItem) => {
    opts.out.write(opts.json ? `${JSON.stringify({ type: "feed", ...item })}\n` : `${formatFeedItem(item, opts.color)}\n`);
  };
  const c = palette(opts.color);
  const onChange = (change: { type: string; subscription?: SubscriptionInfo; server?: ServerSummary; events?: EventDescriptor[] }) => {
    if (change.type === "server" && change.server && !opts.json) {
      const sv = change.server;
      const who = [sv.name, sv.version].filter(Boolean).join(" ") || "server";
      opts.out.write(`${c.bold("connected")}  ${sv.url}  ${c.dim(`${who} · protocol ${sv.protocolVersion ?? "?"}${sv.era === "legacy" ? " (initialize)" : ""} · capability ${sv.capabilityKey ?? "?"} · profile ${sv.profile}`)}\n`);
      return;
    }
    if (change.type === "catalog" && change.events && !opts.json) {
      opts.out.write(c.dim(`events/list: ${change.events.length} event type(s)\n`));
      for (const e of change.events) {
        opts.out.write(`  ${padEnd(c.bold(e.name), 18)} ${padEnd(c.cyan(Array.isArray(e.delivery) ? e.delivery.join(" ") : "?"), 20)} ${c.dim(e.description ?? "")}\n`);
      }
      return;
    }
    if (change.type !== "subscription" || !change.subscription) return;
    const sub = change.subscription;
    if (sub.status === "starting") return;
    const sig = `${sub.status}|${sub.detail ?? ""}|${sub.serverId ?? ""}`;
    if (printed.get(sub.key) === sig) return;
    printed.set(sub.key, sig);
    opts.out.write(opts.json ? `${JSON.stringify({ type: "subscription", ...sub })}\n` : `${formatSubscription(sub, opts.color)}\n`);
  };
  store.on("feed", onFeed);
  store.on("change", onChange);
  return () => {
    store.off("feed", onFeed);
    store.off("change", onChange);
  };
}
