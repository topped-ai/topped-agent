/**
 * The two fixtures come from one `GET /api/v1/tools` listing:
 * `fixtures/tools.json` keeps each tool's top-level fields, which the command
 * and flag tests read, and `fixtures/schemas.json` keeps the whole input schema
 * of the tools whose nested JSON the skill teaches by example. A refresh that
 * updates only one of them fails here, instead of leaving the nested checks on
 * a stale schema.
 */

import { describe, expect, it } from "vitest";

import { TOOL_LISTING } from "./fakeTopped.js";
import { LIVE_INPUT_SCHEMAS } from "./jsonSchema.js";

type Schema = Record<string, unknown>;

/** What `fixtures/tools.json` keeps of a whole input schema: each field's name and `type`, and `required`. */
function topLevel(schema: Schema): Schema {
  const properties = Object.fromEntries(
    Object.entries((schema.properties ?? {}) as Record<string, Schema>).map(([name, field]) => [
      name,
      field.type === undefined ? {} : { type: field.type },
    ]),
  );
  return {
    type: schema.type,
    properties,
    ...(schema.required === undefined ? {} : { required: schema.required }),
  };
}

describe("the tool fixtures", () => {
  const listed = new Map(TOOL_LISTING.tools.map((tool) => [tool.name, tool.inputSchema as Schema]));

  it("hold whole schemas for the tools the skill shows nested JSON for", () => {
    expect([...LIVE_INPUT_SCHEMAS.keys()].sort()).toEqual(["approve_draft", "create_draft", "edit_for_you_draft"]);
  });

  for (const [name, schema] of LIVE_INPUT_SCHEMAS) {
    it(`agree on ${name}'s top-level fields, their types and what is required`, () => {
      expect(listed.has(name)).toBe(true);
      expect(listed.get(name)).toEqual(topLevel(schema as Schema));
    });
  }
});
