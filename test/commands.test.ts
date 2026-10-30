import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { COMMANDS, type CommandSpec } from "../src/commands.js";
import { factsFromListing, TOOLS } from "../src/tools.js";

import { FakeTopped, TOOL_LISTING } from "./fakeTopped.js";
import { Harness } from "./harness.js";
import { LIVE_INPUT_SCHEMAS, schemaErrors } from "./jsonSchema.js";

/** The 41 tools Topped lists, in its order. */
const SPEC_TOOLS = [
  "get_balances",
  "get_product",
  "update_product",
  "list_connected_accounts",
  "connect_account",
  "disconnect_account",
  "get_for_you_draft",
  "pass_draft",
  "approve_draft",
  "undo_approve",
  "list_source_posts",
  "list_starting_points",
  "list_sounds",
  "create_draft",
  "edit_draft",
  "rewrite_draft",
  "draft_caption",
  "generate_media",
  "list_saved_posts",
  "get_post",
  "publish_saved_post",
  "edit_saved_post",
  "delete_saved_post",
  "list_media",
  "upload_media",
  "update_media",
  "delete_media",
  "restore_media",
  "list_publish_runs",
  "get_publish_run",
  "move_publish_run",
  "cancel_publish_run",
  "retry_publish_run",
  "get_scoreboard",
  "list_scoreboard_posts",
  "refresh_metrics",
  "list_watchlist",
  "browse_watchlist",
  "watch_account",
  "unwatch_account",
  "dismiss_suggested_account",
] as const;

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const SLOT = "2026-10-02T17:00:00.000Z";

/** A Slideshow started on one of the founder's Library images, in the editor's names: sent through as it is. */
const OWN_SLIDESHOW = {
  format: "slideshow",
  startingPoint: { mediaId: A },
  slides: [
    { words: "Dark mode is here", style: { behindTheWords: "none", outline: { width: "none" }, size: "large" } },
    { words: "Easier at night", photo: { photoSetId: B, photo: 3 }, images: [{ mediaId: A, position: "top", opacity: 0.8 }] },
  ],
  allTextBoxes: true,
};

/** A Wall of text: `draft edit` sends it as edit_draft's composition, `saved edit` as edit_saved_post's post. */
const WALL_OF_TEXT = { format: "wall_of_text", startingPoint: { startingPointId: A }, text: { words: "Hello" } };

/** New words on the For You Draft's slide 1, on its own photo set: `draft edit` sends it as edit_draft's composition. */
const FOR_YOU_CHANGES = { format: "slideshow", startingPoint: { startingPointId: A }, slides: [{ slide: 1, words: "Hi" }] };

/** `--platform-json` files: TikTok and YouTube together, and YouTube with a privacy and no title. */
const PLATFORM = { tiktok: [{ connectionId: A, sendToDrafts: true }], youtube: { title: "T", privacy: "public" } };
const YOUTUBE_ONLY = { youtube: { privacy: "unlisted" } };

describe("the Posts these tests send", () => {
  const schema = (tool: string) => LIVE_INPUT_SCHEMAS.get(tool)!;

  // edit_draft's composition and edit_saved_post's post are the same Post shape as create_draft's makeYourOwn.
  it.each([
    ["your own Slideshow", OWN_SLIDESHOW],
    ["a Wall of text", WALL_OF_TEXT],
  ])("%s fits Topped's whole live Post schema, nested fields included", (_name, post) => {
    expect(schemaErrors({ makeYourOwn: post }, schema("create_draft"))).toEqual([]);
  });

  it("the For You Draft's changes fit edit_draft's whole live input schema", () => {
    expect(schemaErrors({ draftId: A, composition: FOR_YOU_CHANGES }, schema("edit_draft"))).toEqual([]);
  });

  it.each([
    ["TikTok and YouTube", PLATFORM],
    ["YouTube alone", YOUTUBE_ONLY],
  ])("the %s --platform-json file fits approve_draft's whole live input schema", (_name, platform) => {
    const input = { draftId: A, exit: "post_now", connectionIds: [A, B], caption: "New!", ...platform };
    expect(schemaErrors(input, schema("approve_draft"))).toEqual([]);
  });

  it("would catch a Wall of text in the shape these tests used to send", () => {
    expect(schemaErrors({ makeYourOwn: { format: "wall_of_text", text: "Hello" } }, schema("create_draft"))).not.toEqual([]);
  });
});

/** The commands that run a tool, by tool name. */
function commandsByTool(): Map<string, CommandSpec[]> {
  const map = new Map<string, CommandSpec[]>();
  for (const command of COMMANDS) {
    if (command.tool === null) continue;
    map.set(command.tool, [...(map.get(command.tool) ?? []), command]);
  }
  return map;
}

describe("the command table", () => {
  it("pins exactly one command to each of the 41 tools", () => {
    expect(SPEC_TOOLS).toHaveLength(41);
    const byTool = commandsByTool();
    for (const tool of SPEC_TOOLS) {
      expect(byTool.get(tool), tool).toHaveLength(1);
    }
    expect([...byTool.keys()].sort()).toEqual([...SPEC_TOOLS].sort());
  });

  it("knows the same 41 tools as the live list, with the live list's transport facts", () => {
    expect(Object.keys(TOOLS)).toEqual([...SPEC_TOOLS]);
    expect(TOOL_LISTING.tools.map((tool) => tool.name)).toEqual([...SPEC_TOOLS]);
    for (const listing of TOOL_LISTING.tools) {
      expect(TOOLS[listing.name], listing.name).toEqual(factsFromListing(listing));
    }
  });

  it("maps every flag and argument to a field the tool's live schema has", () => {
    for (const command of COMMANDS) {
      if (command.tool === null) continue;
      const schema = TOOL_LISTING.tools.find((tool) => tool.name === command.tool)!.inputSchema;
      const fields = Object.keys(schema.properties);
      for (const arg of command.args) if (arg.field) expect(fields, `${command.usage} ${arg.field}`).toContain(arg.field);
      for (const flag of command.flags) if (flag.field) expect(fields, `${command.usage} --${flag.name}`).toContain(flag.field);
      if (command.json?.field) expect(fields).toContain(command.json.field);
    }
  });

  it("names no command twice", () => {
    const names = COMMANDS.map((command) => command.words.join(" "));
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("each command runs its one tool with the input its flags name", () => {
  const fake = new FakeTopped();
  const harness = new Harness(fake);
  let files = "";

  beforeAll(async () => {
    await fake.start();
    files = await mkdtemp(join(tmpdir(), "topped-cli-files-"));
    await writeFile(join(files, "profile.json"), JSON.stringify({ name: "Nightowl", oneLiner: "Sleep better." }));
    await writeFile(join(files, "spec.json"), JSON.stringify({ fromSourcePost: { sourcePostId: A } }));
    await writeFile(join(files, "composition.json"), JSON.stringify(WALL_OF_TEXT));
    await writeFile(join(files, "own.json"), JSON.stringify({ makeYourOwn: OWN_SLIDESHOW }));
    await writeFile(join(files, "youtube.json"), JSON.stringify(YOUTUBE_ONLY));
    await writeFile(join(files, "platform.json"), JSON.stringify(PLATFORM));
  });
  afterAll(async () => {
    await fake.stop();
    await rm(files, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await harness.setUp();
    fake.calls.length = 0;
  });

  const env = () => ({ TOPPED_API_KEY: fake.apiKey });

  const cases: [string, string[], string, Record<string, unknown>][] = [
    ["balances", ["balances"], "get_balances", {}],
    ["product", ["product"], "get_product", {}],
    ["product update", ["product", "update", "--json", "profile.json"], "update_product", { name: "Nightowl", oneLiner: "Sleep better." }],
    ["accounts", ["accounts"], "list_connected_accounts", {}],
    ["accounts --post", ["accounts", "--post", A], "list_connected_accounts", { postId: A }],
    ["accounts connect", ["accounts", "connect", "tiktok"], "connect_account", { platform: "tiktok" }],
    ["accounts connect --reconnect", ["accounts", "connect", "youtube", "--reconnect", A], "connect_account", { platform: "youtube", connectionId: A }],
    [
      "accounts disconnect",
      ["accounts", "disconnect", A, "--platform", "instagram", "--handle", "nightowl"],
      "disconnect_account",
      { connectionId: A, platform: "instagram", handle: "nightowl" },
    ],
    [
      "accounts disconnect --no-handle",
      ["accounts", "disconnect", A, "--platform", "youtube", "--no-handle"],
      "disconnect_account",
      { connectionId: A, platform: "youtube", handle: null },
    ],
    ["for-you", ["for-you"], "get_for_you_draft", {}],
    ["pass", ["pass", A], "pass_draft", { draftId: A }],
    ["approve --save", ["approve", A, "--save"], "approve_draft", { draftId: A, exit: "save" }],
    [
      "approve --post-now",
      ["approve", A, "--post-now", "--accounts", `${A},${B}`, "--caption", "New!", "--platform-json", "platform.json"],
      "approve_draft",
      {
        draftId: A,
        exit: "post_now",
        connectionIds: [A, B],
        caption: "New!",
        tiktok: [{ connectionId: A, sendToDrafts: true }],
        youtube: { title: "T", privacy: "public" },
      },
    ],
    [
      "approve to YouTube with a privacy and no title",
      ["approve", A, "--post-now", "--accounts", B, "--caption", "Dark mode is here", "--platform-json", "youtube.json"],
      "approve_draft",
      { draftId: A, exit: "post_now", connectionIds: [B], caption: "Dark mode is here", youtube: { privacy: "unlisted" } },
    ],
    [
      "approve --schedule",
      ["approve", A, "--schedule", "2026-10-02T18:30:00-04:00", "--accounts", A],
      "approve_draft",
      { draftId: A, exit: "schedule", at: "2026-10-02T18:30:00-04:00", connectionIds: [A] },
    ],
    ["undo", ["undo", A], "undo_approve", { draftId: A }],
    ["sources", ["sources", "--format", "slideshow"], "list_source_posts", { format: "slideshow" }],
    ["sources --cursor", ["sources", "--format", "demo_video", "--cursor", "c2"], "list_source_posts", { format: "demo_video", cursor: "c2" }],
    ["starting-points", ["starting-points", "--format", "wall_of_text"], "list_starting_points", { format: "wall_of_text" }],
    [
      "starting-points --tag",
      ["starting-points", "--format", "slideshow", "--source", "topped", "--tag", "cozy", "--cursor", "c3"],
      "list_starting_points",
      { format: "slideshow", source: "topped", tag: "cozy", cursor: "c3" },
    ],
    [
      "starting-points --source yours",
      ["starting-points", "--format", "demo_video", "--source", "yours"],
      "list_starting_points",
      { format: "demo_video", source: "yours" },
    ],
    [
      "starting-points --photo-set",
      ["starting-points", "--format", "slideshow", "--photo-set", A],
      "list_starting_points",
      { format: "slideshow", startingPointId: A },
    ],
    ["sounds", ["sounds"], "list_sounds", {}],
    ["draft create", ["draft", "create", "--json", "spec.json"], "create_draft", { fromSourcePost: { sourcePostId: A } }],
    [
      "draft create from your own Library media",
      ["draft", "create", "--json", "own.json"],
      "create_draft",
      { makeYourOwn: OWN_SLIDESHOW },
    ],
    [
      "draft edit",
      ["draft", "edit", A, "--json", "composition.json"],
      "edit_draft",
      { draftId: A, composition: WALL_OF_TEXT },
    ],
    ["draft rewrite", ["draft", "rewrite", A], "rewrite_draft", { draftId: A }],
    [
      "draft rewrite with a steer",
      ["draft", "rewrite", A, "--steer", "shorter", "--no-mention", "--previous-idea", "idea-7"],
      "rewrite_draft",
      { draftId: A, steer: "shorter", mention: false, previousIdeaId: "idea-7" },
    ],
    [
      "caption",
      ["caption", "--format", "video", "--avoid", "Old one", "--platforms", "tiktok,youtube", "--attempt", "2"],
      "draft_caption",
      { format: "video", avoid: "Old one", platforms: ["tiktok", "youtube"], attempt: 2 },
    ],
    ["generate image", ["generate", "image", "--prompt", "a cat"], "generate_media", { kind: "image", prompt: "a cat" }],
    [
      "generate video",
      ["generate", "video", "--prompt", "a cat", "--expected-credits", "180", "--model", "video-model-a", "--length", "6", "--starting-image", A],
      "generate_media",
      { kind: "video", prompt: "a cat", expectedCredits: 180, model: "video-model-a", lengthSeconds: 6, startingImageId: A },
    ],
    ["saved", ["saved"], "list_saved_posts", {}],
    ["saved --limit", ["saved", "--limit", "10", "--cursor", "n1"], "list_saved_posts", { limit: 10, cursor: "n1" }],
    ["post", ["post", A], "get_post", { postId: A }],
    [
      "saved publish --post-now",
      ["saved", "publish", A, "--post-now", "--accounts", B],
      "publish_saved_post",
      { postId: A, exit: "post_now", connectionIds: [B] },
    ],
    [
      "saved publish --schedule",
      ["saved", "publish", A, "--schedule", "2026-10-03T09:00:00Z", "--accounts", B, "--caption", "Again"],
      "publish_saved_post",
      { postId: A, exit: "schedule", at: "2026-10-03T09:00:00Z", connectionIds: [B], caption: "Again" },
    ],
    [
      "saved edit",
      ["saved", "edit", A, "--json", "composition.json", "--save-as-new"],
      "edit_saved_post",
      { postId: A, post: WALL_OF_TEXT, saveAsNew: true },
    ],
    ["saved delete", ["saved", "delete", A], "delete_saved_post", { postId: A }],
    ["media", ["media"], "list_media", {}],
    ["media --kind", ["media", "--kind", "demo", "--limit", "5"], "list_media", { kind: "demo", limit: 5 }],
    ["media --media-id", ["media", "--media-id", A], "list_media", { mediaId: A }],
    ["media demo --on", ["media", "demo", A, "--on"], "update_media", { mediaId: A, demo: true }],
    ["media demo --off", ["media", "demo", A, "--off"], "update_media", { mediaId: A, demo: false }],
    ["media delete", ["media", "delete", A], "delete_media", { mediaId: A }],
    ["media restore", ["media", "restore", A, "--undo-token", B], "restore_media", { mediaId: A, undoToken: B }],
    ["runs", ["runs"], "list_publish_runs", {}],
    ["runs --week day", ["runs", "--week", "2026-09-30"], "list_publish_runs", { week: "2026-09-30" }],
    ["runs --week ISO", ["runs", "--week", "2026-W40"], "list_publish_runs", { week: "2026-09-28" }],
    ["runs --account", ["runs", "--account", A, "--cursor", "p2"], "list_publish_runs", { connectionId: A, cursor: "p2" }],
    ["run", ["run", A], "get_publish_run", { publishRunId: A }],
    [
      "run move --at",
      ["run", "move", A, "--from-slot", SLOT, "--at", "2026-10-04T18:30:00-04:00"],
      "move_publish_run",
      { publishRunId: A, fromSlot: SLOT, at: "2026-10-04T18:30:00-04:00" },
    ],
    [
      "run move --to-day",
      ["run", "move", A, "--from-slot", SLOT, "--to-day", "2026-10-05", "--to-time", "09:15"],
      "move_publish_run",
      { publishRunId: A, fromSlot: SLOT, toDay: "2026-10-05", toTime: "09:15" },
    ],
    ["run cancel", ["run", "cancel", A, "--slot", SLOT], "cancel_publish_run", { publishRunId: A, slot: SLOT }],
    [
      "run retry",
      ["run", "retry", A, "--from-slot", SLOT, "--to-day", "2026-10-06", "--to-time", "10:00"],
      "retry_publish_run",
      { publishRunId: A, fromSlot: SLOT, toDay: "2026-10-06", toTime: "10:00" },
    ],
    ["scoreboard", ["scoreboard"], "get_scoreboard", {}],
    ["scoreboard --accounts", ["scoreboard", "--accounts", `${A},${B}`], "get_scoreboard", { connectionIds: [A, B] }],
    ["scoreboard posts", ["scoreboard", "posts"], "list_scoreboard_posts", {}],
    [
      "scoreboard posts --accounts --cursor",
      ["scoreboard", "posts", "--accounts", A, "--cursor", "s2"],
      "list_scoreboard_posts",
      { connectionIds: [A], cursor: "s2" },
    ],
    ["scoreboard refresh", ["scoreboard", "refresh", "--accounts", `${A},${B}`], "refresh_metrics", { connectionIds: [A, B] }],
    ["scoreboard refresh --run", ["scoreboard", "refresh", "--run", A], "refresh_metrics", { publishRunId: A }],
    ["watchlist", ["watchlist"], "list_watchlist", {}],
    ["watchlist browse", ["watchlist", "browse"], "browse_watchlist", {}],
    [
      "watchlist browse --creators --cursor",
      ["watchlist", "browse", "--creators", `${A},${B}`, "--cursor", "w2"],
      "browse_watchlist",
      { watchlistHandleIds: [A, B], cursor: "w2" },
    ],
    ["watchlist watch", ["watchlist", "watch", "tiktok", "sleepcoach"], "watch_account", { platform: "tiktok", handle: "sleepcoach" }],
    ["watchlist unwatch", ["watchlist", "unwatch", A, "--handle", "sleepcoach"], "unwatch_account", { watchlistHandleId: A, handle: "sleepcoach" }],
    ["watchlist dismiss", ["watchlist", "dismiss", A, "--handle", "sleepcoach"], "dismiss_suggested_account", { suggestionId: A, handle: "sleepcoach" }],
  ];

  it.each(cases)("%s", async (_name, argv, tool, expected) => {
    const result = await harness.run(argv, { env: env(), cwd: files });
    expect(result.code, result.stdout).toBe(0);
    expect(fake.calls).toHaveLength(1);
    const call = fake.calls[0]!;
    expect(call.name).toBe(tool);
    const { requestId, ...input } = call.input;
    // No time zone unless --time-zone names one: Topped reads the founder's saved zone.
    expect(input).toEqual(expected);
    // The requestId only where the tool takes one.
    expect(requestId !== undefined).toBe(TOOLS[tool]!.requestId === true);
    expect(call.authorization).toBe(`Bearer ${fake.apiKey}`);
  });

  it("covers every tool but upload_media, which topped upload drives in its own test", () => {
    const covered = new Set(cases.map(([, , tool]) => tool));
    expect(SPEC_TOOLS.filter((tool) => !covered.has(tool))).toEqual(["upload_media"]);
  });

  it.each([
    [["scoreboard", "--account", A], "--account"],
    [["watchlist", "browse", A], "Too many arguments"],
    [["media", "restore", A], "--undo-token"],
    [["starting-points", "--format", "slideshow", "--set", A], "--set"],
  ])("refuses %j before anything is sent", async (argv, mention) => {
    const result = await harness.run(argv, { env: env() });
    expect(result.code).toBe(2);
    expect(`${result.json.error} ${result.json.fix ?? ""}`).toContain(mention);
    expect(fake.calls).toHaveLength(0);
  });

  it("passes a refused --media-id with other flags through as Topped wrote it", async () => {
    fake.on("list_media", () => ({
      status: 422,
      body: { error: "mediaId reads one item on its own.", fix: "Send mediaId alone, or leave it out to list." },
    }));
    const result = await harness.run(["media", "--media-id", A, "--kind", "image"], { env: env() });
    expect(result.code).toBe(1);
    expect(result.json).toEqual({ error: "mediaId reads one item on its own.", fix: "Send mediaId alone, or leave it out to list." });
    expect(fake.calls[0]!.input).toEqual({ mediaId: A, kind: "image" });
  });

  it("reads --json from stdin with -", async () => {
    const result = await harness.run(["product", "update", "--json", "-"], { env: env(), stdin: '{"stage":"live"}' });
    expect(result.code).toBe(0);
    expect(fake.calls[0]!.input).toEqual({ stage: "live" });
  });

  it("topped call runs any tool by its own name", async () => {
    fake.on("get_balances", () => ({ credits: 120, contentSaves: 4 }));
    const viaCommand = await harness.run(["balances"], { env: env() });
    const viaCall = await harness.run(["call", "get_balances"], { env: env() });
    expect(viaCall.code).toBe(0);
    expect(viaCall.json).toEqual(viaCommand.json);
  });

  it("topped call reads the live list for a tool this build doesn't know", async () => {
    fake.on("brand_new_tool", (input) => ({ echoed: input }));
    const result = await harness.run(["call", "brand_new_tool", "--json", "-"], { env: env(), stdin: '{"a":1}' });
    expect(result.code).toBe(0);
    expect(fake.calls.map((call) => call.name)).toEqual(["brand_new_tool"]);
    expect(result.json).toEqual({ echoed: { a: 1 } });
  });

  it("topped tools lists the live tools", async () => {
    const result = await harness.run(["tools"], { env: env() });
    expect(result.code).toBe(0);
    expect(result.json.tools).toHaveLength(41);
  });
});
