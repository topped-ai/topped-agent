/**
 * Just enough JSON Schema to check an example against a tool's live input
 * schema, with no dependency: `$ref` into `$defs`, `type`, `properties`,
 * `required`, `additionalProperties`, `items`, `anyOf`, `oneOf`, `not`,
 * `enum`, `const`, `pattern` and the length, count and range limits.
 * `format` is not checked, so `"<mediaId>"` may stand in for an id.
 */

import { readFileSync } from "node:fs";

type Schema = Record<string, unknown>;

/**
 * The whole input schema Topped lists today (`GET /api/v1/tools`, without
 * descriptions) for the tools whose nested JSON the skill teaches by example.
 * `fixtures/tools.json` keeps only each tool's top-level fields.
 */
export const LIVE_INPUT_SCHEMAS = new Map(
  (
    JSON.parse(readFileSync(new URL("./fixtures/schemas.json", import.meta.url), "utf8")) as {
      tools: { name: string; inputSchema: Schema }[];
    }
  ).tools.map((tool) => [tool.name, tool.inputSchema]),
);

/** Every way `value` breaks `schema`, each with its JSON path; empty when it fits. */
export function schemaErrors(value: unknown, schema: Schema, root: Schema = schema, path = "$"): string[] {
  if (typeof schema.$ref === "string") {
    const name = /^#\/\$defs\/(.+)$/.exec(schema.$ref)?.[1];
    const target = name === undefined ? undefined : (root.$defs as Record<string, Schema> | undefined)?.[name];
    if (target === undefined) return [`${path}: cannot resolve ${schema.$ref}`];
    return schemaErrors(value, target, root, path);
  }
  const errors: string[] = [];
  const fits = (sub: Schema) => schemaErrors(value, sub, root, path).length === 0;

  if (schema.not !== undefined && fits(schema.not as Schema)) errors.push(`${path}: is not allowed`);
  if (Array.isArray(schema.anyOf) && !(schema.anyOf as Schema[]).some(fits)) {
    errors.push(`${path}: matches none of its anyOf shapes`);
  }
  if (Array.isArray(schema.oneOf)) {
    const matched = (schema.oneOf as Schema[]).filter(fits).length;
    if (matched !== 1) errors.push(`${path}: matches ${matched} of its oneOf shapes, not exactly 1`);
  }
  if ("const" in schema && !same(value, schema.const)) errors.push(`${path}: must be ${JSON.stringify(schema.const)}`);
  if (Array.isArray(schema.enum) && !schema.enum.some((option) => same(value, option))) {
    errors.push(`${path}: must be one of ${JSON.stringify(schema.enum)}`);
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? (schema.type as string[]) : [schema.type as string];
    if (!types.some((type) => isType(value, type))) {
      errors.push(`${path}: must be ${types.join(" or ")}`);
      return errors;
    }
  }

  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) errors.push(`${path}: shorter than ${schema.minLength}`);
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) errors.push(`${path}: longer than ${schema.maxLength}`);
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern, "u").test(value)) errors.push(`${path}: does not match ${schema.pattern}`);
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) errors.push(`${path}: below ${schema.minimum}`);
    if (typeof schema.maximum === "number" && value > schema.maximum) errors.push(`${path}: above ${schema.maximum}`);
    if (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum) errors.push(`${path}: not above ${schema.exclusiveMinimum}`);
    if (typeof schema.exclusiveMaximum === "number" && value >= schema.exclusiveMaximum) errors.push(`${path}: not below ${schema.exclusiveMaximum}`);
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) errors.push(`${path}: fewer than ${schema.minItems} items`);
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) errors.push(`${path}: more than ${schema.maxItems} items`);
    if (isObject(schema.items)) value.forEach((item, i) => errors.push(...schemaErrors(item, schema.items as Schema, root, `${path}[${i}]`)));
  }
  if (isObject(value)) {
    const properties = (schema.properties ?? {}) as Record<string, Schema>;
    for (const key of (schema.required ?? []) as string[]) {
      if (!(key in value)) errors.push(`${path}: needs ${key}`);
    }
    for (const [key, item] of Object.entries(value)) {
      if (key in properties) errors.push(...schemaErrors(item, properties[key]!, root, `${path}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${path}: has no field ${key}`);
      else if (isObject(schema.additionalProperties)) errors.push(...schemaErrors(item, schema.additionalProperties as Schema, root, `${path}.${key}`));
    }
  }
  return errors;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isType(value: unknown, type: string): boolean {
  switch (type) {
    case "object":
      return isObject(value);
    case "array":
      return Array.isArray(value);
    case "integer":
      return Number.isInteger(value);
    case "null":
      return value === null;
    default:
      return typeof value === type;
  }
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
