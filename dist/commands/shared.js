import { readFileSync } from "node:fs";
import { isObject } from "../protocol/jsonrpc.js";
import { PROFILE_NAMES } from "../protocol/profiles.js";
import { UsageError } from "../util/args.js";
import { colorWanted } from "../util/color.js";
/** How to run Hookbench from npm until it is published under a public name. */
export const RUN = process.env["npm_command"] === "exec" ? "npx github:NHTanvir/hookbench" : "hookbench";
export const defaultIo = { out: process.stdout, err: process.stderr };
export function useColor(io, noColor) {
    return colorWanted(io.out, noColor);
}
export function parseProfile(v) {
    if (v === undefined)
        return "sep-3415";
    if (!PROFILE_NAMES.includes(v))
        throw new UsageError(`--profile must be ${PROFILE_NAMES.join(" or ")}, got "${v}"`);
    return v;
}
export function parseMode(v, flag = "--mode") {
    if (v === "auto" || v === "poll" || v === "push" || v === "webhook")
        return v;
    throw new UsageError(`${flag} must be auto, poll, push or webhook, got "${v}"`);
}
export function parseJsonObject(text, what) {
    let v;
    try {
        v = JSON.parse(text);
    }
    catch (err) {
        throw new UsageError(`${what} is not valid JSON: ${err.message}`);
    }
    if (!isObject(v))
        throw new UsageError(`${what} must be a JSON object`);
    return v;
}
export function readJsonFile(path, what) {
    let text;
    try {
        text = readFileSync(path, "utf8");
    }
    catch (err) {
        throw new UsageError(`cannot read ${what} ${path}: ${err.message}`);
    }
    return parseJsonObject(text, `${what} ${path}`);
}
export function requireUrl(raw, what) {
    if (!raw)
        throw new UsageError(`missing ${what}`);
    let u;
    try {
        u = new URL(raw);
    }
    catch {
        throw new UsageError(`${what} must be a URL, got "${raw}"`);
    }
    if (u.protocol !== "http:" && u.protocol !== "https:")
        throw new UsageError(`${what} must be http(s), got "${raw}"`);
    return u.toString();
}
/** Resolve when the process is asked to stop (Ctrl+C or SIGTERM). */
export function untilInterrupted() {
    return new Promise((resolve) => {
        const done = (sig) => {
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
