/**
 * The built binary, as `npx topped` runs it: a real process, real stdout and
 * exit codes, against the local fake Topped. `npm test` builds first.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { FakeTopped } from "./fakeTopped.js";

const CLI = join(process.cwd(), "dist", "cli.js");
const fake = new FakeTopped();
let home = "";

beforeAll(async () => {
  if (!existsSync(CLI)) throw new Error("dist/cli.js is missing: run npm run build (npm test does).");
  await fake.start();
  home = await mkdtemp(join(tmpdir(), "topped-cli-bin-"));
});
afterAll(async () => {
  await fake.stop();
  await rm(home, { recursive: true, force: true });
});

function topped(args: string[], env: Record<string, string> = {}, stdin?: string) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    const child = execFile(
      process.execPath,
      [CLI, ...args],
      {
        // Only what the test names: never the developer's own key, sign-in or TOPPED_URL.
        env: { PATH: process.env.PATH ?? "", HOME: home, XDG_CONFIG_HOME: home, TOPPED_URL: fake.url, ...env },
      },
      (error, stdout, stderr) => resolve({ code: error ? Number(error.code ?? 1) : 0, stdout, stderr }),
    );
    if (stdin !== undefined) child.stdin?.end(stdin);
  });
}

describe("the topped binary", () => {
  it("--help: one JSON document naming the commands, exit 0", async () => {
    const { code, stdout } = await topped(["--help"]);
    expect(code).toBe(0);
    const help = JSON.parse(stdout);
    expect(help.commands.length).toBeGreaterThanOrEqual(45);
  });

  it("no sign-in: exit 3, { error, fix } naming topped login", async () => {
    const { code, stdout } = await topped(["balances"]);
    expect(code).toBe(3);
    const body = JSON.parse(stdout);
    expect(Object.keys(body).sort()).toEqual(["error", "fix"]);
    expect(body.fix).toContain("topped login");
  });

  it("a key in TOPPED_API_KEY: the result on stdout, one line, and nothing secret anywhere", async () => {
    fake.on("get_balances", () => ({ credits: 40, contentSaves: 2 }));
    const { code, stdout, stderr } = await topped(["balances", "--verbose"], { TOPPED_API_KEY: fake.apiKey });
    expect(code).toBe(0);
    expect(stdout).toBe('{"credits":40,"contentSaves":2}\n');
    expect(stdout + stderr).not.toContain(fake.apiKey);
  });

  it("--pretty indents", async () => {
    const { stdout } = await topped(["balances", "--pretty"], { TOPPED_API_KEY: fake.apiKey });
    expect(stdout).toBe(`${JSON.stringify({ credits: 40, contentSaves: 2 }, null, 2)}\n`);
  });

  it("--json - reads stdin", async () => {
    const { code, stdout } = await topped(["call", "get_balances", "--json", "-"], { TOPPED_API_KEY: fake.apiKey }, "{}");
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ credits: 40, contentSaves: 2 });
  });

  it("bad usage: exit 2", async () => {
    const { code, stdout } = await topped(["approve"]);
    expect(code).toBe(2);
    expect(JSON.parse(stdout).error).toBe("usage");
  });

  it("nothing to reach: exit 4", async () => {
    const { code, stdout } = await topped(["balances"], { TOPPED_API_KEY: fake.apiKey, TOPPED_URL: "http://127.0.0.1:9" });
    expect(code).toBe(4);
    expect(JSON.parse(stdout).error).toBe("unreachable");
  });
});
