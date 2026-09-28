/**
 * One HTTP exchange with Topped, with the CLI's one retry rule: only network
 * failures and 5xx answers are retried, a bounded number of times with
 * backoff, within the request's time budget, and only as far as a second
 * arrival is harmless (see {@link Repeat}). A refusal is never retried.
 */

import type { CliDeps } from "./deps.js";
import { CliError, EXIT, type Redactor } from "./output.js";

export const DEFAULT_BASE_URL = "https://app.topped.ai";

export interface Session {
  deps: CliDeps;
  baseUrl: string;
  redactor: Redactor;
  verbose: boolean;
  /** A line for people, on stderr - never a secret, never on stdout. */
  hint(text: string): void;
}

export interface HttpRequest {
  method: "GET" | "POST" | "PUT";
  url: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  /** The whole exchange, retries included; tool calls and uploads get longer. */
  timeoutMs?: number;
}

export interface HttpAnswer {
  status: number;
  /** The parsed JSON body, or `undefined` when it was not JSON. */
  json: unknown;
  headers: Headers;
  /**
   * When the latest attempt that may have reached Topped without its answer
   * coming back (a network failure, a timeout, a gateway's page) was sent, or
   * `null` when every attempt was answered by Topped itself.
   */
  lostAttemptAt: number | null;
}

/**
 * How safe it is for one request to arrive twice:
 * - `safe`: a read, a signed upload, a token refresh. Retried on a network
 *   failure and on 500, 502, 503 and 504.
 * - `keyed`: a change carrying a requestId, which Topped runs once per id.
 *   Retried like `safe`, except a 500 carrying Topped's own `{ error, fix }`:
 *   Topped leaves that call unfinished on purpose, a repeat would only hear
 *   that it has not finished, and its fix says what to check instead.
 * - `once`: any other change. Retried only on 503, where Topped says nothing ran.
 */
export type Repeat = "safe" | "keyed" | "once";

/** How many times one call is tried in all. */
export const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 10_000;
/** Discovery, sign-in and the tool list: quick answers. */
const DEFAULT_TIMEOUT_MS = 60_000;
/**
 * `POST /api/v1/tools/{name}`: as long as Topped lets one call run, since
 * some tools (making an image, writing a Post) work inside the request.
 */
export const TOOL_TIMEOUT_MS = 300_000;

class NetworkFailure extends Error {}

/**
 * Where the CLI points: `TOPPED_URL`, or Topped itself. Only https, or plain
 * http on this machine (a local server) - a key never crosses the network in
 * the clear.
 */
export function resolveBaseUrl(env: Record<string, string | undefined>): string {
  const raw = env.TOPPED_URL?.trim();
  if (!raw) return DEFAULT_BASE_URL;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CliError(EXIT.usage, "invalid_topped_url", `TOPPED_URL must be a URL such as ${DEFAULT_BASE_URL}; unset it to use Topped itself.`);
  }
  if (isSafeUrl(url.href)) return url.origin;
  throw new CliError(
    EXIT.usage,
    "invalid_topped_url",
    "TOPPED_URL must be https, or http on localhost or 127.0.0.1; unset it to use Topped itself.",
  );
}

export function isLoopback(hostname: string): boolean {
  return ["localhost", "127.0.0.1", "[::1]", "::1"].includes(hostname.toLowerCase());
}

/** A URL Topped handed back that the CLI may send a request to. */
export function isSafeUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || (url.protocol === "http:" && isLoopback(url.hostname));
  } catch {
    return false;
  }
}

/** What a verbose line names: the path on Topped, only the host anywhere else (signed URLs carry secrets). */
function describe(session: Session, request: HttpRequest): string {
  const url = new URL(request.url);
  return url.origin === session.baseUrl ? `${request.method} ${url.pathname}` : `${request.method} ${url.host}`;
}

async function once(session: Session, request: HttpRequest, timeoutMs: number): Promise<Omit<HttpAnswer, "lostAttemptAt">> {
  const started = session.deps.now();
  let response: Response;
  try {
    response = await session.deps.fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      redirect: "manual",
      signal: session.deps.abortAfter(timeoutMs),
    });
  } catch (error) {
    if (session.verbose) session.hint(`${describe(session, request)} failed: ${networkReason(error)}`);
    throw new NetworkFailure(networkReason(error));
  }
  const text = await response.text().catch(() => "");
  if (session.verbose) session.hint(`${describe(session, request)} ${response.status} (${session.deps.now() - started} ms)`);
  let json: unknown;
  try {
    json = text.trim() === "" ? undefined : JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: response.status, json, headers: response.headers };
}

function networkReason(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as { cause?: { code?: string } }).cause;
    if (cause?.code) return cause.code;
    if (error.name === "TimeoutError") return "timed out";
    return error.name;
  }
  return "network error";
}

function retryDelay(attempt: number, answer: { headers: Headers } | null): number {
  const retryAfter = Number(answer?.headers.get("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(retryAfter * 1000, MAX_DELAY_MS);
  return Math.min(BASE_DELAY_MS * 3 ** (attempt - 1), MAX_DELAY_MS);
}

/** Whether an answer is worth trying again under `repeat`. */
function retryable(repeat: Repeat, status: number, json: unknown): boolean {
  if (status === 503) return true;
  if (repeat === "once") return false;
  if (status === 502 || status === 504) return true;
  if (status === 500) return repeat === "safe" || !isRefusal(json);
  return false;
}

/** An answer that may not be Topped's own: its run may have happened, or be happening. */
function mayBeLost(status: number, json: unknown): boolean {
  return status === 502 || status === 504 || (status === 500 && !isRefusal(json));
}

/** Send `request`, retrying per {@link Repeat}, within its time budget. */
export async function exchange(session: Session, request: HttpRequest, repeat: Repeat): Promise<HttpAnswer> {
  const { now } = session.deps;
  const started = now();
  const deadline = started + (request.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  let lostAttemptAt: number | null = null;
  for (let attempt = 1; ; attempt++) {
    const sentAt = attempt === 1 ? started : now();
    let answer: Omit<HttpAnswer, "lostAttemptAt"> | null = null;
    let failure: NetworkFailure | null = null;
    try {
      answer = await once(session, request, Math.max(1, deadline - sentAt));
    } catch (error) {
      if (!(error instanceof NetworkFailure)) throw error;
      failure = error;
    }
    if (failure !== null || mayBeLost(answer!.status, answer!.json)) lostAttemptAt = sentAt;
    const delay = retryDelay(attempt, answer);
    const last = attempt >= MAX_ATTEMPTS || now() + delay >= deadline;
    if (answer !== null) {
      if (!retryable(repeat, answer.status, answer.json) || last) return { ...answer, lostAttemptAt };
    } else if (repeat === "once" || last) {
      throw unreachable(session, request, failure);
    }
    if (session.verbose) session.hint(`Retrying in ${delay} ms.`);
    await session.deps.sleep(delay);
  }
}

/**
 * Exit 4: Topped could not be reached, or did not answer as Topped. The fix
 * says what happened, then what to do next; a caller that knows what the
 * call was can make that next step precise ({@link NotReached.thenDo}).
 */
export class NotReached extends CliError {
  constructor(
    error: string,
    private readonly situation: string,
  ) {
    super(EXIT.unreachable, error, `${situation}, then run the same command again.`);
  }

  thenDo(next: string): this {
    this.body.fix = `${this.situation}, then ${next}.`;
    return this;
  }
}

function unreachable(session: Session, request: HttpRequest, failure: NetworkFailure | null): NotReached {
  const host = new URL(request.url).host;
  const where = new URL(request.url).origin === session.baseUrl ? `Topped at ${session.baseUrl}` : host;
  return new NotReached(
    "unreachable",
    `Could not reach ${where}${failure ? ` (${failure.message})` : ""}. Check the connection${
      session.baseUrl === DEFAULT_BASE_URL ? "" : " and TOPPED_URL"
    }`,
  );
}

/** Topped answered with something that is not Topped's JSON (a proxy page, an outage page). */
export function unexpected(session: Session, status: number): NotReached {
  return new NotReached("unexpected_response", `Topped at ${session.baseUrl} answered ${status} without its usual JSON. Wait a moment`);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Topped's own refusal shape. */
export function isRefusal(value: unknown): value is Record<string, unknown> & { error: string; fix: string } {
  return isRecord(value) && typeof value.error === "string" && typeof value.fix === "string";
}
