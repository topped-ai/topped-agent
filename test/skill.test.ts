/**
 * The topped skill and the Claude Code plugin that carries it: the
 * frontmatter every installer reads (Claude Code, `npx skills add`, ClawHub's
 * `metadata.openclaw`), the manifests, and that every tool, input, command and
 * flag the skill names is one the server and this CLI really have.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { COMMANDS, type CommandSpec } from "../src/commands.js";
import { LOGIN_TIMEOUT_MS } from "../src/deps.js";
import { GLOBAL_FLAGS as HELP_GLOBAL_FLAGS } from "../src/help.js";
import { TOOL_LISTING } from "./fakeTopped.js";
import { LIVE_INPUT_SCHEMAS, schemaErrors } from "./jsonSchema.js";

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");
const pkg = JSON.parse(read("package.json"));
const plugin = JSON.parse(read(".claude-plugin/plugin.json"));
const marketplace = JSON.parse(read(".claude-plugin/marketplace.json"));

const SKILL_PATH = "skills/topped/SKILL.md";
const skill = read(SKILL_PATH);
const [, frontmatter = "", body = ""] = skill.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/) ?? [];

const TOOLS = new Map(TOOL_LISTING.tools.map((tool) => [tool.name, tool]));

/** Values the skill names in backticks that look like tool names but are field values. */
const FIELD_VALUES = new Set(["pre_launch", "wall_of_text", "demo_video", "no_source_post", "topped_idea", "in_playground", "time_zone_required"]);

/** Top-level `key: value` lines of the frontmatter (every value here is one line). */
function frontmatterFields(): Record<string, string> {
  return Object.fromEntries(
    frontmatter.split("\n").map((line) => {
      const at = line.indexOf(":");
      return [line.slice(0, at), line.slice(at + 1).trim()];
    }),
  );
}

/** Every inline code span and fenced block's text, with the table's `\|` read as `|`. */
function codeTexts(): string[] {
  const text = body.replace(/\\\|/g, "|");
  const fenced = [...text.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map((match) => match[1]!);
  const inline = [...text.replace(/```[a-z]*\n[\s\S]*?```/g, "").matchAll(/`([^`\n]+)`/g)].map((match) => match[1]!);
  return [...inline, ...fenced];
}

/** Each `topped ...` command line the skill writes, as tokens after `topped`. */
function cliLines(): string[][] {
  return codeTexts()
    .flatMap((code) => code.split(/&&|\n/))
    .map((piece) => piece.trim())
    .filter((piece) => /^topped\s/.test(piece))
    .map((piece) =>
      piece
        .split(/\s+/)
        .slice(1)
        .map((token) => token.replace(/^\[|\]$/g, "")) // an optional part, as a usage line writes it
        .filter((token) => token !== "" && token !== "|"),
    );
}

function commandFor(tokens: string[]): { command: CommandSpec; rest: string[] } | null {
  let best: CommandSpec | null = null;
  for (const command of COMMANDS) {
    if (command.words.every((word, i) => tokens[i] === word) && command.words.length > (best?.words.length ?? 0)) {
      best = command;
    }
  }
  return best === null ? null : { command: best, rest: tokens.slice(best.words.length) };
}

/** `pretty`, `time-zone`, `request-id` and the rest: the flags every command takes. */
const GLOBAL_FLAGS = new Set(HELP_GLOBAL_FLAGS.map((entry) => entry.flag.split(" ")[0]!.slice(2)));

function knownFlag(command: CommandSpec, name: string): boolean {
  if (GLOBAL_FLAGS.has(name) || (name === "json" && command.json !== undefined)) return true;
  if (command.flags.some((flag) => flag.name === name)) return true;
  return command.flags.some(
    (flag) => `no-${flag.name}` === name && (flag.kind === "negatable" || flag.kind === "nullable"),
  );
}

describe("the skill's frontmatter", () => {
  const fields = frontmatterFields();

  it("opens the file and carries only name, description and metadata", () => {
    expect(skill.startsWith("---\n")).toBe(true);
    expect(Object.keys(fields)).toEqual(["name", "description", "metadata"]);
  });

  it("is named topped, like its folder", () => {
    expect(fields.name).toBe("topped");
    expect(readdirSync(join(root, "skills"))).toEqual(["topped"]);
  });

  it("describes it in the founder's own phrasing, within the Agent Skills limit", () => {
    const description = fields.description!;
    expect(description.length).toBeLessThanOrEqual(1024);
    for (const phrase of ["post about my app", "what should I post today", "schedule a TikTok", "how did my posts do"]) {
      expect(description).toContain(phrase);
    }
  });

  it("carries the openclaw block as one line of JSON: the topped CLI, installed from npm, and optional env", () => {
    const metadata = JSON.parse(fields.metadata!);
    expect(Object.keys(metadata)).toEqual(["openclaw"]);
    const openclaw = metadata.openclaw;
    expect(openclaw.requires).toEqual({ bins: ["topped"] });
    expect(openclaw.install).toEqual([
      { id: "node", kind: "node", package: pkg.name, bins: ["topped"], label: "Install the topped CLI (npm)" },
    ]);
    expect(openclaw.primaryEnv).toBe("TOPPED_API_KEY");
    expect(openclaw.envVars.map((env: { name: string; required: boolean }) => [env.name, env.required])).toEqual([
      ["TOPPED_API_KEY", false],
      ["TOPPED_URL", false],
    ]);
    expect(openclaw.homepage).toBe("https://app.topped.ai");
  });
});

describe("the skill's body", () => {
  it("puts the hard rules first", () => {
    expect(body.match(/^## .+$/m)?.[0]).toBe("## Hard rules");
  });

  it("gives topped login longer than it waits for Allow, and keeps the browser on the machine the sign-in comes back to", () => {
    expect(body).toContain(`up to ${LOGIN_TIMEOUT_MS / 60_000} minutes`);
    // Longer than the wait, which starts only after discovery and registration,
    // so the agent reads topped's own answer rather than killing it first;
    // within the 10 minutes Claude Code's Bash tool allows.
    const commandTimeoutMs = Number(/Bash timeout of (\d+) ms/.exec(body)?.[1]);
    expect(commandTimeoutMs).toBeGreaterThanOrEqual(LOGIN_TIMEOUT_MS + 60_000);
    expect(commandTimeoutMs).toBeLessThanOrEqual(600_000);
    expect(body).toContain(`at least ${commandTimeoutMs / 60_000} minutes`);
    expect(body).toContain("The browser must be on the machine running topped");
    expect(body).toContain("--port");
    expect(body).not.toMatch(/link is on stderr: hand it/i);
  });

  it("stays near 300 lines, not a 26 KB manual", () => {
    const lines = skill.split("\n").length;
    expect(lines).toBeGreaterThan(200);
    expect(lines).toBeLessThan(330);
  });

  it("has the recipes spec §12 names, over MCP and the CLI", () => {
    for (const recipe of ["Morning check", "Shipped-it post", "Demo from the simulator", "Fill the week", "Set up from the repo"]) {
      expect(body).toMatch(new RegExp(`^### ${recipe}`, "m"));
    }
  });

  it("gives the three ways to connect", () => {
    expect(body).toContain(
      'claude mcp add --transport http topped https://app.topped.ai/api/mcp --header "Authorization: Bearer <your key>"',
    );
    expect(body).toContain("npm i -g topped && topped login");
    expect(body).toContain("custom connector with the address `https://app.topped.ai/api/mcp`");
  });

  it("never asks anyone to edit an agent's instruction files", () => {
    expect(skill).not.toMatch(/CLAUDE\.md|AGENTS\.md/);
  });
});

describe("the skill on repeating a call", () => {
  it("repeats a refused call unchanged only when its fix says to, never as a rule against Topped's own fixes", () => {
    expect(body).not.toMatch(/never repeat a refused call/i);
    expect(body).toContain("repeat a call unchanged only when its fix says to");
  });

  it("after exit 4, repeats with the same --request-id, never a plain rerun", () => {
    expect(body).toMatch(/Exit 4:[^\n]*same `--request-id`/);
  });

  it("after exit 3, signs in and then repeats with the same --request-id when the fix says so", () => {
    expect(body).toMatch(/Exit 3: run `topped login`, then do what `fix` says[^\n]*same `--request-id`/);
  });

  it("leaves the time zone to the one the founder saved, over the CLI and MCP alike", () => {
    expect(body).toContain("Leave `timeZone` out, over the CLI and MCP alike");
    expect(body).toMatch(/`get_balances` \(`topped balances`\) shows it as `timeZone`/);
    expect(body).toMatch(/only when the founder names another zone/);
    expect(body).not.toMatch(/this machine's zone;|CLI sends this machine's zone/);
  });

  it("runs topped login only when whoami says it is not signed in", () => {
    expect(body).toMatch(/Exit code 3 means not signed in\. Run `topped login` only then/);
  });
});

/** The tool a fenced JSON example is for, and the whole input it stands in: the file `--json` takes, with the arguments around it. */
function exampleInput(block: Record<string, unknown>): [string, Record<string, unknown>] {
  if ("fromSourcePost" in block || "makeYourOwn" in block) return ["create_draft", block];
  if ("tiktok" in block || "youtube" in block) return ["approve_draft", { draftId: "<draftId>", exit: "post_now", ...block }];
  if ("format" in block) return ["edit_for_you_draft", { draftId: "<draftId>", changes: block }];
  throw new Error(`No tool takes this example: ${JSON.stringify(block)}`);
}

describe("what the skill names is real", () => {
  it("names every one of the 42 tools, and no tool that doesn't exist", () => {
    expect(TOOLS.size).toBe(42);
    const named = new Set(
      codeTexts()
        .flatMap((code) => code.match(/\b[a-z]+(?:_[a-z]+)+\b/g) ?? [])
        .filter((word) => !FIELD_VALUES.has(word)),
    );
    for (const word of named) expect(TOOLS.has(word), word).toBe(true);
    for (const name of TOOLS.keys()) expect(named.has(name), name).toBe(true);
  });

  it("sends each tool only inputs its schema has", () => {
    const calls = [...body.matchAll(/`([a-z]+(?:_[a-z]+)+) \{ ([^`]*) \}`/g)];
    expect(calls.length).toBeGreaterThan(10);
    for (const [, name, inside] of calls) {
      const properties = Object.keys(TOOLS.get(name!)!.inputSchema.properties);
      // Top-level keys only: `key` or `key: value`, split at the commas outside quotes.
      const keys = inside!.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map((part) => part.split(":")[0]!.trim());
      for (const key of keys) expect(properties, `${name} ${key}`).toContain(key);
    }
  });

  it("runs only commands and flags the CLI has", () => {
    const lines = cliLines();
    expect(lines.length).toBeGreaterThan(30);
    for (const tokens of lines) {
      const line = `topped ${tokens.join(" ")}`;
      if (tokens[0]!.startsWith("<")) {
        for (const token of tokens.filter((t) => t.startsWith("--"))) expect(GLOBAL_FLAGS.has(token.slice(2)), line).toBe(true);
        continue;
      }
      const found = commandFor(tokens);
      expect(found, line).not.toBeNull();
      const { command, rest } = found!;
      const firstFlag = rest.findIndex((t) => t.startsWith("--"));
      const positionals = firstFlag === -1 ? rest : rest.slice(0, firstFlag);
      expect(positionals.length, line).toBeLessThanOrEqual(command.args.length);
      positionals.forEach((token, i) => {
        const choices = command.args[i]?.choices;
        if (choices && !token.startsWith("<")) expect(choices, line).toContain(token);
      });
      for (const token of rest.filter((t) => t.startsWith("--"))) expect(knownFlag(command, token.slice(2)), line).toBe(true);
    }
  });

  it("writes Posts in the editor's names, never the retired ones", () => {
    const code = codeTexts().join("\n");
    for (const retired of [/"look"/, /\bsameLookOnEverySlide\b/, /\bstickers?\b/, /"music"/, /"demo":/, /`plates`|`band`/]) {
      expect(code).not.toMatch(retired);
    }
    for (const name of ["behindTheWords", "allTextBoxes", "didNotFit", "images", "opacity", "photoSetId", "demoSound"]) {
      expect(code, name).toContain(name);
    }
    expect(body).not.toMatch(/\bsticker/i);
  });

  it("writes every JSON example so it fits the tool's whole live input schema", () => {
    const blocks = [...body.matchAll(/```json\n([\s\S]*?)```/g)].map((match) => JSON.parse(match[1]!) as Record<string, unknown>);
    expect(blocks.length).toBeGreaterThanOrEqual(7);
    for (const block of blocks) {
      const [tool, input] = exampleInput(block);
      expect(schemaErrors(input, LIVE_INPUT_SCHEMAS.get(tool)!), `${tool}: ${JSON.stringify(block)}`).toEqual([]);
    }
  });

  it("checks examples deeply enough to catch a renamed nested field", () => {
    const create = LIVE_INPUT_SCHEMAS.get("create_draft")!;
    const slideshow = { format: "slideshow", startingPoint: { startingPointId: "<startingPointId>" }, slides: [{ words: "Hi" }] };
    expect(schemaErrors({ makeYourOwn: slideshow }, create)).toEqual([]);
    const retired = [
      { ...slideshow, startingPoint: undefined, startingPointId: "<startingPointId>" },
      { ...slideshow, slides: [{ words: "Hi", style: { look: "plates" } }] },
      { ...slideshow, slides: [{ words: "Hi", stickers: [{ mediaId: "<mediaId>" }] }] },
      { ...slideshow, sameLookOnEverySlide: true },
      { format: "demo_video", startingPoint: { startingPointId: "<openerId>" }, demoMediaId: "<demoMediaId>", volumes: { music: 0.5 } },
    ];
    for (const makeYourOwn of retired) {
      expect(schemaErrors(JSON.parse(JSON.stringify({ makeYourOwn })), create), JSON.stringify(makeYourOwn)).not.toEqual([]);
    }
  });

  it("states the Slideshow slide cap the live schema has, for every platform alike", () => {
    type Shape = { properties: { format: { const?: string }; slides?: { maxItems?: number } } };
    const { makeYourOwn } = LIVE_INPUT_SCHEMAS.get("create_draft")!.properties as { makeYourOwn: { oneOf: Shape[] } };
    const cap = makeYourOwn.oneOf.find((shape) => shape.properties.format.const === "slideshow")?.properties.slides?.maxItems;
    expect(typeof cap).toBe("number");
    const stated = [...body.matchAll(/up to (\d+) slides/g)].map((match) => Number(match[1]));
    expect(stated).toEqual([cap]);
    expect(body).toContain(`A Slideshow has up to ${cap} slides`);
    expect(body).not.toMatch(/slide limit/i);
  });

  it("starts every Post of your own on a startingPoint: Topped's by startingPointId, or the founder's Library media by mediaId", () => {
    const fenced = [...body.matchAll(/```json\n([\s\S]*?)```/g)].map((match) => match[1]!);
    const posts = fenced
      .filter((code) => code.includes('"makeYourOwn"'))
      .map((code) => JSON.parse(code).makeYourOwn as Record<string, unknown>);
    expect(posts.length).toBeGreaterThanOrEqual(4);
    for (const post of posts) {
      expect(post).not.toHaveProperty("startingPointId");
      expect(Object.keys(post.startingPoint as object)).toHaveLength(1);
    }
    const kinds = posts.map((post) => Object.keys(post.startingPoint as object)[0]);
    expect(kinds).toContain("startingPointId");
    expect(kinds).toContain("mediaId");
    expect(body).toContain("topped starting-points --format slideshow --source yours");
  });

  it("puts a removed image or clip back with its undoToken, and never polls a video that stays in the Playground", () => {
    expect(body).toContain("topped media restore <mediaId> --undo-token <token>");
    expect(body).toMatch(/`in_playground`[^\n]*never check again/);
    expect(body).toContain("topped media --media-id <mediaId>");
  });

  it("reports a failed video's message and balances, and never promises its credits back", () => {
    const step = body.split("\n").find((line) => line.startsWith("4. A video finishes in the background."));
    expect(step).toBeDefined();
    expect(step).toMatch(/`failed` \(tell the founder its `message`; the `balances` beside it show where the credits stand/);
    expect(body).not.toMatch(/credits (come|comes|came) back|refund/i);
  });

  it("writes --platform-json files with only tiktok and youtube", () => {
    const platform = codeTexts().filter((code) => code.includes('"tiktok"'));
    expect(platform).toHaveLength(1);
    expect(Object.keys(JSON.parse(platform[0]!))).toEqual(["tiktok", "youtube"]);
  });
});

describe("the Claude Code plugin", () => {
  it("is topped, at the package's version and license, with the skill in the default skills/ folder", () => {
    expect(plugin.name).toBe("topped");
    expect(plugin.version).toBe(pkg.version);
    expect(plugin.license).toBe(pkg.license);
    expect(plugin.homepage).toBe("https://app.topped.ai");
    expect(plugin.skills).toBeUndefined();
  });

  it("is the one plugin its marketplace lists, from this repository's root", () => {
    expect(marketplace.name).toBe("topped-agent");
    expect(marketplace.owner.name).toBeTruthy();
    expect(marketplace.plugins).toHaveLength(1);
    const [entry] = marketplace.plugins;
    expect(entry.name).toBe(plugin.name);
    expect(entry.source).toBe("./");
    expect(entry.version).toBeUndefined();
  });

  it("has nothing at the plugin root that Claude Code would load besides the skill", () => {
    for (const name of ["commands", "agents", "hooks", "bin", ".mcp.json", "settings.json", "CLAUDE.md"]) {
      expect(readdirSync(root), name).not.toContain(name);
    }
  });
});
