/**
 * The REST door: `GET /api/v1/tools`, `POST /api/v1/tools/{name}` and
 * `GET /api/v1/whoami`, with the credential from {@link resolveAuth}. What
 * Topped answers is passed through: a result as it came, a refusal as its
 * own `{ error, fix }` (exit 1), a refused credential as exit 3.
 */

import { type Auth, notSignedIn } from "./auth.js";
import {
  exchange,
  isRecord,
  isRefusal,
  type HttpAnswer,
  type Repeat,
  type Session,
  TOOL_TIMEOUT_MS,
  unexpected,
} from "./http.js";
import { CliError, EXIT } from "./output.js";

/** Topped's answer to a requestId whose first call has not finished. */
const IN_PROGRESS = "request_in_progress";
const FIRST_WAIT_MS = 2_000;
const MAX_WAIT_MS = 10_000;

export class ToppedApi {
  constructor(
    private readonly session: Session,
    private readonly auth: Auth | null,
  ) {}

  get source(): Auth["source"] | null {
    return this.auth?.source ?? null;
  }

  listTools(): Promise<unknown> {
    return this.send("GET", "/api/v1/tools", undefined, "safe");
  }

  whoami(): Promise<unknown> {
    return this.send("GET", "/api/v1/whoami", undefined, "safe");
  }

  callTool(name: string, input: Record<string, unknown>, repeat: Repeat): Promise<unknown> {
    return this.send("POST", `/api/v1/tools/${encodeURIComponent(name)}`, JSON.stringify(input), repeat, TOOL_TIMEOUT_MS);
  }

  private async send(
    method: "GET" | "POST",
    path: string,
    body: string | undefined,
    repeat: Repeat,
    timeoutMs?: number,
  ): Promise<unknown> {
    const auth = this.auth;
    if (auth === null) throw notSignedIn();
    const ask = async (): Promise<HttpAnswer> =>
      exchange(
        this.session,
        {
          method,
          url: `${this.session.baseUrl}${path}`,
          headers: {
            authorization: `Bearer ${await auth.token()}`,
            accept: "application/json",
            ...(body === undefined ? {} : { "content-type": "application/json" }),
          },
          ...(body === undefined ? {} : { body }),
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        },
        repeat,
      );

    // The latest attempt of this call that may have reached Topped with its
    // answer lost, across every exchange below, a refused credential's included.
    const lost: { at: number | null } = { at: null };
    const heard = (answer: HttpAnswer): HttpAnswer => {
      if (answer.lostAttemptAt !== null) lost.at = Math.max(lost.at ?? answer.lostAttemptAt, answer.lostAttemptAt);
      return { ...answer, lostAttemptAt: lost.at };
    };

    // Topped may refuse the credential on any attempt, a repeat under a
    // requestId included (the app revoked meanwhile): recover once, else exit 3.
    const attempt = async (): Promise<HttpAnswer> => {
      const first = heard(await ask());
      if (first.status !== 401) return first;
      if (!(await auth.recover())) throw auth.refused();
      const again = heard(await ask());
      if (again.status === 401) throw auth.refused();
      return again;
    };

    let answer: HttpAnswer;
    try {
      answer = await attempt();
      if (repeat === "keyed") answer = await this.awaitFirstResult(answer, attempt);
    } catch (error) {
      // Refused after an attempt that may have run: say so, so the caller can
      // repeat the call under its requestId once signed in again.
      if (error instanceof CliError && error.exitCode === EXIT.auth && lost.at !== null) error.mayHaveRun = true;
      throw error;
    }

    if (answer.status >= 200 && answer.status < 300) {
      if (answer.json === undefined) throw unexpected(this.session, answer.status);
      return answer.json;
    }
    if (isRefusal(answer.json)) throw CliError.passThrough(EXIT.refused, answer.json);
    if (isRecord(answer.json) && typeof answer.json.error === "string") {
      throw new CliError(EXIT.refused, answer.json.error, "Topped refused this call. Check the command's arguments and try again.");
    }
    throw unexpected(this.session, answer.status);
  }

  /**
   * A call carrying a requestId whose answer was lost on the way back may
   * still be running on Topped, and a repeat under the same id hears that it
   * has not finished. Keep repeating, with backoff, until the first result
   * comes back - at most until that lost attempt's run must have ended. Only
   * then is "not finished" the answer.
   */
  private async awaitFirstResult(answer: HttpAnswer, attempt: () => Promise<HttpAnswer>): Promise<HttpAnswer> {
    const { deps, verbose } = this.session;
    for (let wait = 1; isRecord(answer.json) && answer.json.error === IN_PROGRESS && answer.lostAttemptAt !== null; wait++) {
      const left = answer.lostAttemptAt + TOOL_TIMEOUT_MS - deps.now();
      if (left <= 0) break;
      const delay = Math.min(FIRST_WAIT_MS * 2 ** (wait - 1), MAX_WAIT_MS, left);
      if (verbose) this.session.hint(`Topped is still running this call; asking again in ${delay} ms.`);
      await deps.sleep(delay);
      answer = await attempt();
    }
    return answer;
  }
}
