import { readFileSync } from "node:fs";
import { isObject } from "../protocol/jsonrpc.js";
import { PROFILE_NAMES, type ProfileName } from "../protocol/profiles.js";
import type { DeliveryMode, JsonObject } from "../protocol/types.js";
import { UsageError } from "../util/args.js";
import { colorWanted } from "../util/color.js";

/** How to run Hookbench from npm until it is published under a public name. */
export const RUN = process.env["npm_command"] === "exec" ? "npx github:NHTanvir/hookbench" : "hookbench";

export interface Io {
  out: { write(s: string): unknown; isTTY?: boolean };
  err: { write(s: string): unknown; isTTY?: boolean };
}

export const defaultIo: Io = { out: process.stdout, err: process.stderr };

export function useColor(io: Io, noColor: boolean): boolean {
  return colorWanted(io.out, noColor);
}

export function parseProfile(v: string | undefined): ProfileName {
  if (v === undefined) return "sep-3415";
  if (!(PROFILE_NAMES as string[]).includes(v)) throw new UsageError(`--profile must be ${PROFILE_NAMES.join(" or ")}, got "${v}"`);
  return v as ProfileName;
}

export function parseMode(v: string, flag = "--mode"): DeliveryMode | "auto" {
  if (v === "auto" || v === "poll" || v === "push" || v === "webhook") return v;
  throw new UsageError(`${flag} must be auto, poll, push or webhook, got "${v}"`);
}

export function parseJsonObject(text: string, what: string): JsonObject {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch (err) {
    throw new UsageError(`${what} is not valid JSON: ${(err as Error).message}`);
  }
  if (!isObject(v)) throw new UsageError(`${what} must be a JSON object`);
  return v;
}

export function readJsonFile(path: string, what: string): JsonObject {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new UsageError(`cannot read ${what} ${path}: ${(err as Error).message}`);
  }
  return parseJsonObject(text, `${what} ${path}`);
}

export function requireUrl(raw: string | undefined, what: string): string {
  if (!raw) throw new UsageError(`missing ${what}`);
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new UsageError(`${what} must be a URL, got "${raw}"`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new UsageError(`${what} must be http(s), got "${raw}"`);
  return u.toString();
}

/** Resolve when the process is asked to stop (Ctrl+C or SIGTERM). */
export function untilInterrupted(): Promise<string> {
  return new Promise((resolve) => {
    const done = (sig: string) => {
      process.off("SIGINT", onInt);
      process.off("SIGTERM", onTerm);
      resolve(sig);
    };
    const onInt = () => done("SIGINT");
    const onTerm = () => done("SIGTERM");
    process.once("SIGINT", onInt);
    process.once("SIGTERM", onTerm);
  });
}
