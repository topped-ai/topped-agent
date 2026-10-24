/**
 * Everything the CLI takes from the outside world, in one place, so tests run
 * it in-process against a local fake Topped with a temporary config directory.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

export interface CliDeps {
  env: Record<string, string | undefined>;
  writeStdout(text: string): void;
  writeStderr(text: string): void;
  readStdin(): Promise<string>;
  /** Open a URL in the founder's browser; failure is fine, the URL is also on stderr. */
  openBrowser(url: string): void | Promise<void>;
  fetch: typeof fetch;
  now(): number;
  sleep(ms: number): Promise<void>;
  /** The one timer on a request: a signal that aborts after `ms`. */
  abortAfter(ms: number): AbortSignal;
  randomId(): string;
  cwd: string;
  /** How long `topped login` waits for the browser to come back. */
  loginTimeoutMs: number;
}

/** How long `topped login` waits for the founder to click Allow. */
export const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

export function realDeps(): CliDeps {
  return {
    env: process.env,
    writeStdout: (text) => process.stdout.write(text),
    writeStderr: (text) => process.stderr.write(text),
    readStdin,
    openBrowser,
    fetch: globalThis.fetch.bind(globalThis),
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    abortAfter: (ms) => AbortSignal.timeout(ms),
    randomId: () => randomUUID(),
    cwd: process.cwd(),
    loginTimeoutMs: LOGIN_TIMEOUT_MS,
  };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString("utf8");
}

function openBrowser(url: string): void {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // The URL is on stderr; the founder can open it by hand.
  }
}
