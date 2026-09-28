/**
 * Runs the CLI in-process against a {@link FakeTopped}, with a temporary
 * config directory (never the real one), and checks after every run that no
 * secret reached stdout or stderr.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect } from "vitest";

import type { CliDeps } from "../src/deps.js";
import { run } from "../src/main.js";

import { clickAllow, type FakeTopped } from "./fakeTopped.js";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  /** stdout parsed: it must always be exactly one JSON document. */
  json: any;
}

export interface RunOptions {
  env?: Record<string, string | undefined>;
  stdin?: string;
  openBrowser?: (url: string) => void | Promise<void>;
  now?: () => number;
  cwd?: string;
  loginTimeoutMs?: number;
  sleeps?: number[];
  /** Stand in for a request's timer, as if that long had passed. */
  abortAfter?: (ms: number) => AbortSignal;
  readStdin?: () => Promise<string>;
  systemTimeZone?: string;
  /** Sees each stderr write as it happens, like a founder reading the terminal. */
  onStderr?: (text: string) => void;
}

export class Harness {
  configHome = "";
  readonly outputs: string[] = [];
  /** Fresh ids stay unique across runs, as the real CLI's random ones are. */
  private ids = 0;

  constructor(readonly fake: FakeTopped) {}

  async setUp(): Promise<void> {
    this.configHome = await mkdtemp(join(tmpdir(), "topped-cli-test-"));
  }

  async tearDown(): Promise<void> {
    await rm(this.configHome, { recursive: true, force: true });
  }

  get credentialsPath(): string {
    return join(this.configHome, "topped", "credentials.json");
  }

  async run(argv: string[], options: RunOptions = {}): Promise<RunResult> {
    let stdout = "";
    let stderr = "";
    const deps: CliDeps = {
      env: {
        HOME: this.configHome,
        XDG_CONFIG_HOME: this.configHome,
        TOPPED_URL: this.fake.url,
        ...options.env,
      },
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
        options.onStderr?.(text);
      },
      readStdin: options.readStdin ?? (async () => options.stdin ?? ""),
      openBrowser: options.openBrowser ?? ((url) => void clickAllow(url)),
      fetch: globalThis.fetch.bind(globalThis),
      now: options.now ?? (() => Date.now()),
      sleep: async (ms) => {
        options.sleeps?.push(ms);
      },
      abortAfter: options.abortAfter ?? ((ms) => AbortSignal.timeout(ms)),
      randomId: () => `test-${++this.ids}`,
      systemTimeZone: () => options.systemTimeZone ?? "Europe/London",
      cwd: options.cwd ?? process.cwd(),
      loginTimeoutMs: options.loginTimeoutMs ?? 10_000,
    };
    const code = await run(argv, deps);
    this.outputs.push(stdout, stderr);
    for (const secret of this.fake.secrets) {
      expect(stdout).not.toContain(secret);
      expect(stderr).not.toContain(secret);
    }
    expect(stdout).not.toMatch(/tpd_(live|at|rt)_[0-9A-Za-z]{8}/);
    expect(stderr).not.toMatch(/tpd_(live|at|rt)_[0-9A-Za-z]{8}/);
    expect(stdout.endsWith("\n")).toBe(true);
    const json = JSON.parse(stdout);
    return { code, stdout, stderr, json };
  }

  /** Signed in through the browser flow ("Allow" clicked), ready for commands. */
  login(options: RunOptions = {}): Promise<RunResult> {
    return this.run(["login"], options);
  }
}
