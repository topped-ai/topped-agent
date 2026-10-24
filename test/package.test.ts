/**
 * What ships, and what this public repository may say: the package's shape,
 * the version, the README's command list, and no host but Topped's own (or
 * this machine), none of Topped's engine words, in anything the CLI prints,
 * the README, the skill or the plugin.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { PRIVATE_TEXT } from "../scripts/check-history.mjs";
import { COMMANDS } from "../src/commands.js";
import { helpDocument } from "../src/help.js";
import { VERSION } from "../src/version.js";

const root = process.cwd();
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

function filesUnder(dir: string): string[] {
  return readdirSync(join(root, dir)).flatMap((name) => {
    const path = join(dir, name);
    return statSync(join(root, path)).isDirectory() ? filesUnder(path) : [path];
  });
}

/** Topped's engine words, which never reach anything a founder or an agent reads. */
const ENGINE_WORDS = /\b(hooks?|batch(es)?|queues?|baselines?|winners?|allotments?|outliers?|receipts?)\b/i;

const TEXT_FILES = [
  ...filesUnder("src"),
  ...filesUnder("test").filter((path) => !path.endsWith(".png")),
  ...filesUnder("docs"),
  ...filesUnder("scripts"),
  "README.md",
  "CHANGELOG.md",
  "package.json",
  "server.json",
  "skills/topped/SKILL.md",
  ".claude-plugin/plugin.json",
  ".claude-plugin/marketplace.json",
];

describe("the package", () => {
  it("is topped, with its bin, engines and only what ships", () => {
    expect(pkg.name).toBe("topped");
    expect(pkg.version).toBe("0.2.0");
    expect(pkg.type).toBe("module");
    expect(pkg.bin).toEqual({ topped: "dist/cli.js" });
    expect(pkg.engines).toEqual({ node: ">=20" });
    expect(pkg.files).toEqual(["dist/**/*.js", "README.md", "CHANGELOG.md", "LICENSE"]);
    expect(pkg.dependencies ?? {}).toEqual({});
    for (const script of ["build", "test", "typecheck"]) expect(pkg.scripts[script]).toBeTruthy();
  });

  it("has a CHANGELOG entry for this version", () => {
    expect(readFileSync(join(root, "CHANGELOG.md"), "utf8")).toMatch(new RegExp(`^## ${pkg.version.replace(/\./g, "\\.")} \\(\\d{4}-\\d{2}-\\d{2}\\)$`, "m"));
  });

  it("tells a 0.1.0 founder every input today's Topped refuses, and to update the CLI and the skill together", () => {
    const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
    const upgrade = /^### Upgrade from 0\.1\.0\n([\s\S]*?)\n### /m.exec(changelog)?.[1] ?? "";
    for (const refused of ["upload_media", "topped scoreboard --account", "topped watchlist browse <watchlistHandleId>", "startingPointId", "`look`", "sameLookOnEverySlide"]) {
      expect(upgrade).toContain(refused);
    }
    expect(upgrade).toContain("update the CLI and the skill together");
  });

  it("prints the version package.json names", () => {
    expect(VERSION).toBe(pkg.version);
  });

  it("the bin starts with a node shebang", () => {
    expect(readFileSync(join(root, "src", "cli.ts"), "utf8").startsWith("#!/usr/bin/env node\n")).toBe(true);
  });

  it("the license is MIT", () => {
    expect(readFileSync(join(root, "LICENSE"), "utf8")).toContain("Copyright (c) 2026 Lior Cohen");
  });
});

describe("the MCP registry entry", () => {
  const server = JSON.parse(readFileSync(join(root, "server.json"), "utf8"));

  it("lists Topped's remote server at the server's own version, with no package and no source repository", () => {
    expect(server.$schema).toBe("https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json");
    expect(server.name).toBe("ai.topped/topped");
    expect(server.title).toBe("Topped");
    // The version the remote server reports as its serverInfo, not the CLI's.
    expect(server.version).toBe("1.0.0");
    expect(server.version).not.toBe(pkg.version);
    expect(server.websiteUrl).toBe("https://app.topped.ai");
    // This repository holds the client and the skill, not the server's source.
    expect(server.repository).toBeUndefined();
    expect(server.remotes).toEqual([{ type: "streamable-http", url: "https://app.topped.ai/api/mcp" }]);
    expect(server.packages).toBeUndefined();
  });

  it("describes it within the registry's 100 characters, in Topped's words", () => {
    expect(server.description.length).toBeGreaterThan(0);
    expect(server.description.length).toBeLessThanOrEqual(100);
    expect(server.description).not.toMatch(ENGINE_WORDS);
  });

  it("matches the Hermes list entry: the same address, native OAuth, the same description", () => {
    const manifest = readFileSync(join(root, "docs/hermes/optional-mcps/topped/manifest.yaml"), "utf8");
    expect(manifest).toMatch(/^name: topped$/m);
    expect(manifest).toMatch(/^transport:\n  type: http\n  url: (\S+)$/m);
    expect(/^  url: (\S+)$/m.exec(manifest)?.[1]).toBe(server.remotes[0].url);
    expect(manifest).toMatch(/^auth:\n  type: oauth$/m);
    expect(manifest).toContain(`description: ${server.description}`);
  });
});

describe("the README", () => {
  const readme = readFileSync(join(root, "README.md"), "utf8").replace(/\\\|/g, "|");

  it("lists every command's usage", () => {
    for (const command of COMMANDS) expect(readme, command.usage).toContain(command.usage);
  });

  it("covers install, topped login, the output contract, TOPPED_API_KEY and TOPPED_URL", () => {
    for (const needle of ["npm i -g topped", "topped login", "exactly one JSON document", "TOPPED_API_KEY", "TOPPED_URL"]) {
      expect(readme).toContain(needle);
    }
  });

  it("links only to files that ship beside it, so no link is dead in an installed copy", () => {
    const links = [...readme.matchAll(/\]\(([^)\s]+)\)/g)].map((match) => match[1]!).filter((target) => !/^[a-z]+:|^#/i.test(target));
    expect(links).toContain("CHANGELOG.md");
    for (const target of links) expect(pkg.files, target).toContain(target.split("#")[0]);
  });

  it("says the sign-in browser must be on the machine running topped, and how to sign in from another", () => {
    expect(readme).toContain("The browser must run on the same machine as `topped`");
    expect(readme).toContain("topped login --no-browser --port");
    expect(readme).not.toMatch(/open it anywhere/i);
  });
});

describe("a public repository", () => {
  it("names no host but Topped's own, this repository's, this machine and the MCP registry's schema", () => {
    // The MCP registry's schema, which server.json must name.
    const allowed = new Set(["app.topped.ai", "localhost", "127.0.0.1", "static.modelcontextprotocol.io"]);
    const ownRepository = /^github\.com\/topped-ai\/topped-agent(?:[/.#]|$)/i;
    for (const file of TEXT_FILES) {
      const text = readFileSync(join(root, file), "utf8");
      for (const match of text.matchAll(/https?:\/\/([a-z0-9.-]+)([^\s"'`]*)/gi)) {
        const host = match[1]!.toLowerCase();
        expect(allowed.has(host) || ownRepository.test(host + match[2]), `${file}: ${match[0]}`).toBe(true);
      }
    }
  });

  it("names no path on the owner's machine and nothing from Topped's private repository", () => {
    for (const file of TEXT_FILES) {
      const text = readFileSync(join(root, file), "utf8");
      for (const pattern of PRIVATE_TEXT) expect(text, file).not.toMatch(pattern);
    }
  });

  it("uses none of Topped's engine words in what the CLI prints, the README, the skill or the plugin", () => {
    const printed = JSON.stringify([helpDocument(null), ...COMMANDS.map((command) => helpDocument(command))]);
    expect(printed).not.toMatch(ENGINE_WORDS);
    for (const file of ["README.md", "CHANGELOG.md", "skills/topped/SKILL.md", ".claude-plugin/plugin.json", ".claude-plugin/marketplace.json"]) {
      expect(readFileSync(join(root, file), "utf8"), file).not.toMatch(ENGINE_WORDS);
    }
    for (const file of filesUnder("src")) {
      const strings = readFileSync(join(root, file), "utf8").match(/"[^"\n]*"|`[^`\n]*`/g) ?? [];
      for (const literal of strings) expect(literal, file).not.toMatch(ENGINE_WORDS);
    }
  });
});
