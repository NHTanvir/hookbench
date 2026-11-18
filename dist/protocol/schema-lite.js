/**
 * A deliberately small JSON Schema subset: type, enum, const, required, properties,
 * additionalProperties, items, min/max length, minimum/maximum, anyOf, and the
 * date-time format. Unknown keywords are ignored, so this can only under-report.
 * Hookbench uses it to check payloads against payloadSchema and to build sample
 * and deliberately invalid subscription arguments.
 */
import { isObject } from "./jsonrpc.js";
function typeOf(v) {
    if (v === null)
        return "null";
    if (Array.isArray(v))
        return "array";
    if (typeof v === "number")
        return Number.isInteger(v) ? "integer" : "number";
    return typeof v;
}
function typeMatches(v, t) {
    const actual = typeOf(v);
    if (t === "number")
        return actual === "number" || actual === "integer";
    return actual === t;
}
function same(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
}
export function validate(value, schema, path = "$") {
    if (schema === true || schema === undefined)
        return [];
    if (schema === false)
        return [`${path}: no value is allowed here`];
    if (!isObject(schema))
        return [];
    const errors = [];
    const t = schema["type"];
    if (typeof t === "string" || Array.isArray(t)) {
        const types = (Array.isArray(t) ? t : [t]).filter((x) => typeof x === "string");
        if (types.length > 0 && !types.some((x) => typeMatches(value, x))) {
            errors.push(`${path}: expected ${types.join(" or ")}, got ${typeOf(value)}`);
            return errors;
        }
    }
    if (Array.isArray(schema["enum"]) && !schema["enum"].some((e) => same(e, value))) {
        errors.push(`${path}: must be one of ${schema["enum"].map((e) => JSON.stringify(e)).join(", ")}`);
    }
    if ("const" in schema && !same(schema["const"], value)) {
        errors.push(`${path}: must equal ${JSON.stringify(schema["const"])}`);
    }
    if (typeof value === "string") {
        if (typeof schema["minLength"] === "number" && value.length < schema["minLength"]) {
            errors.push(`${path}: shorter than ${schema["minLength"]} characters`);
        }
        if (typeof schema["maxLength"] === "number" && value.length > schema["maxLength"]) {
            errors.push(`${path}: longer than ${schema["maxLength"]} characters`);
        }
        if (schema["format"] === "date-time" && Number.isNaN(Date.parse(value))) {
            errors.push(`${path}: not a date-time`);
        }
    }
    if (typeof value === "number") {
        if (typeof schema["minimum"] === "number" && value < schema["minimum"])
            errors.push(`${path}: below ${schema["minimum"]}`);
        if (typeof schema["maximum"] === "number" && value > schema["maximum"])
            errors.push(`${path}: above ${schema["maximum"]}`);
    }
    if (isObject(value)) {
        const props = isObject(schema["properties"]) ? schema["properties"] : {};
        if (Array.isArray(schema["required"])) {
            for (const key of schema["required"]) {
                if (typeof key === "string" && !(key in value))
                    errors.push(`${path}.${key}: required`);
            }
        }
        for (const [key, sub] of Object.entries(props)) {
            if (key in value)
                errors.push(...validate(value[key], sub, `${path}.${key}`));
        }
        const extra = schema["additionalProperties"];
        if (extra !== undefined && extra !== true) {
            for (const key of Object.keys(value)) {
                if (key in props)
                    continue;
                if (extra === false)
                    errors.push(`${path}.${key}: not allowed (additionalProperties is false)`);
                else
                    errors.push(...validate(value[key], extra, `${path}.${key}`));
            }
        }
    }
    if (Array.isArray(value) && schema["items"] !== undefined) {
        value.forEach((item, i) => errors.push(...validate(item, schema["items"], `${path}[${i}]`)));
    }
    if (Array.isArray(schema["anyOf"])) {
        const branches = schema["anyOf"];
        if (branches.length > 0 && !branches.some((b) => validate(value, b, path).length === 0)) {
            errors.push(`${path}: matches none of anyOf`);
        }
    }
    return errors;
}
/** A plausible value for a schema: default, const, first enum value, or a typed placeholder. */
export function sampleFromSchema(schema, depth = 0) {
    if (!isObject(schema) || depth > 6)
        return {};
    if ("default" in schema)
        return schema["default"];
    if ("const" in schema)
        return schema["const"];
    if (Array.isArray(schema["enum"]) && schema["enum"].length > 0)
        return schema["enum"][0];
    const t = Array.isArray(schema["type"]) ? schema["type"][0] : schema["type"];
    switch (t) {
        case "string":
            if (schema["format"] === "date-time")
                return new Date().toISOString();
            if (schema["format"] === "uri")
                return "https://example.com/item/1";
            return "example";
        case "integer":
            return typeof schema["minimum"] === "number" ? Math.ceil(schema["minimum"]) : 1;
        case "number":
            return typeof schema["minimum"] === "number" ? schema["minimum"] : 1;
        case "boolean":
            return true;
        case "array":
            return [sampleFromSchema(schema["items"], depth + 1)];
        case "null":
            return null;
        default: {
            const out = {};
            const props = isObject(schema["properties"]) ? schema["properties"] : {};
            for (const [key, sub] of Object.entries(props))
                out[key] = sampleFromSchema(sub, depth + 1);
            return out;
        }
    }
}
/**
 * Arguments that violate an inputSchema, plus a short description of why,
 * or undefined when the schema accepts everything Hookbench knows how to send.
 */
export function invalidArguments(inputSchema) {
    if (!isObject(inputSchema))
        return undefined;
    const props = isObject(inputSchema["properties"]) ? inputSchema["properties"] : {};
    for (const [key, sub] of Object.entries(props)) {
        if (!isObject(sub))
            continue;
        const t = sub["type"];
        if (Array.isArray(sub["enum"]) && (t === "string" || t === undefined)) {
            return { args: { [key]: "__hookbench_not_in_enum__" }, why: `"${key}" set to a value outside its enum` };
        }
        if (t === "string")
            return { args: { [key]: 12345 }, why: `"${key}" set to a number where the schema wants a string` };
        if (t === "integer" || t === "number") {
            return { args: { [key]: "not-a-number" }, why: `"${key}" set to a string where the schema wants a ${t}` };
        }
        if (t === "boolean")
            return { args: { [key]: "yes" }, why: `"${key}" set to a string where the schema wants a boolean` };
    }
    if (inputSchema["additionalProperties"] === false) {
        return { args: { __hookbench_unknown__: true }, why: "an unknown property where additionalProperties is false" };
    }
    return undefined;
}
