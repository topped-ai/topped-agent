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
const FIELD_VALUES = new Set(["pre_launch", "wall_of_text", "demo_video", "no_source_post", "topped_idea"]);

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

  it("runs topped login only when whoami says it is not signed in", () => {
    expect(body).toMatch(/Exit code 3 means not signed in\. Run `topped login` only then/);
  });
});

describe("what the skill names is real", () => {
  it("names every one of the 40 tools, and no tool that doesn't exist", () => {
    expect(TOOLS.size).toBe(40);
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
