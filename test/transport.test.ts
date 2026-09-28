import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { MAX_ATTEMPTS, TOOL_TIMEOUT_MS } from "../src/http.js";

import { FakeTopped } from "./fakeTopped.js";
import { Harness } from "./harness.js";

const fake = new FakeTopped();
const harness = new Harness(fake);
const A = "11111111-1111-4111-8111-111111111111";

beforeAll(async () => {
  await fake.start();
});
afterAll(async () => {
  await fake.stop();
});
beforeEach(async () => {
  await harness.setUp();
  fake.calls.length = 0;
  fake.failures.length = 0;
  fake.handlers.clear();
});
afterEach(async () => {
  await harness.tearDown();
});

const env = () => ({ TOPPED_API_KEY: fake.apiKey });

describe("the output contract", () => {
  it("--help is one JSON document naming every command, exit 0", async () => {
    const result = await harness.run(["--help"]);
    expect(result.code).toBe(0);
    const names = result.json.commands.map((command: { command: string }) => command.command);
    for (const name of ["login", "logout", "whoami", "balances", "approve", "upload", "tools", "call", "watchlist dismiss"]) {
      expect(names).toContain(name);
    }
    expect(result.json.exitCodes).toHaveProperty("3");
  });

  it("--help before a command describes that command", async () => {
    for (const argv of [["--help", "approve"], ["-h", "approve"], ["--pretty", "--help", "approve"]]) {
      const result = await harness.run(argv);
      expect(result.code).toBe(0);
      expect(result.json).toMatchObject({ command: "approve", tool: "approve_draft" });
    }
  });

  it("saved edit's --json names the part of topped post's answer to send", async () => {
    const result = await harness.run(["saved", "edit", "--help"]);
    const json = result.json.flags.find((flag: { flag: string }) => flag.flag === "--json <file|->");
    expect(json).toMatchObject({ field: "post" });
    expect(json.help).toContain("post field of topped post's answer");
  });

  it("topped alone prints the same help", async () => {
    const result = await harness.run([]);
    expect(result.code).toBe(0);
    expect(result.json.name).toBe("topped");
  });

  it("<command> --help describes that command and its tool", async () => {
    const result = await harness.run(["approve", "--help"]);
    expect(result.code).toBe(0);
    expect(result.json).toMatchObject({ command: "approve", tool: "approve_draft" });
    expect(result.json.flags.map((flag: { flag: string }) => flag.flag)).toContain("--accounts <a,b>");
    expect(result.json.requestId).toBeDefined();
  });

  it("--version", async () => {
    const result = await harness.run(["--version"]);
    expect(result.json).toEqual({ name: "topped", version: "0.1.0" });
  });

  it("one line by default, indented with --pretty, and nothing on stderr", async () => {
    fake.on("get_balances", () => ({ credits: 12, contentSaves: 3 }));
    const plain = await harness.run(["balances"], { env: env() });
    expect(plain.stdout).toBe('{"credits":12,"contentSaves":3}\n');
    expect(plain.stderr).toBe("");
    const pretty = await harness.run(["balances", "--pretty"], { env: env() });
    expect(pretty.stdout).toBe(`${JSON.stringify({ credits: 12, contentSaves: 3 }, null, 2)}\n`);
    const before = await harness.run(["--pretty", "balances"], { env: env() });
    expect(before.stdout).toBe(pretty.stdout);
  });

  it("no sign-in and no key: exit 3 and a fix naming topped login", async () => {
    const result = await harness.run(["balances"]);
    expect(result.code).toBe(3);
    expect(result.json).toEqual({ error: "not_signed_in", fix: expect.stringContaining("topped login") });
  });

  it("a tool's refusal passes through as Topped wrote it: exit 1", async () => {
    const refusal = {
      error: "That TikTok post is missing the founder's choices.",
      fix: "Ask the founder for privacy, comments, Duet, Stitch, music, disclosure and the AI label.",
      missing: ["privacy"],
    };
    fake.on("approve_draft", () => ({ status: 422, body: refusal }));
    const result = await harness.run(["approve", A, "--post-now", "--accounts", A], { env: env() });
    expect(result.code).toBe(1);
    expect(result.json).toEqual({ ...refusal, requestId: fake.calls[0]!.input.requestId });
    expect(result.json.requestId).toMatch(/^cli-/);
  });

  // A For You Draft is rewritten only when it was made from a Template (every
  // Draft on Topped's shelf is); Topped's writer refuses one that wasn't, and
  // the CLI adds nothing to either answer but the words or the refusal.
  it("draft rewrite: the new words as Topped wrote them, or Topped's refusal unchanged", async () => {
    const rewritten = { changed: true, draftId: A, slides: [{ slide: 1, words: "New words" }], message: "Topped wrote new words." };
    fake.on("rewrite_draft", () => rewritten);
    const done = await harness.run(["draft", "rewrite", A], { env: env() });
    expect(done.code).toBe(0);
    expect(done.json).toEqual(rewritten);

    const refusal = { error: "This post can't be edited anymore.", fix: "Read the Draft again with get_for_you_draft before changing it." };
    fake.on("rewrite_draft", () => ({ status: 422, body: refusal }));
    const refused = await harness.run(["draft", "rewrite", A], { env: env() });
    expect(refused.code).toBe(1);
    expect(refused.json).toEqual(refusal);
    expect(fake.calls.map((call) => call.input)).toEqual([{ draftId: A }, { draftId: A }]);
  });

  it("the transport's own refusals pass through too, and are never retried", async () => {
    fake.failures.push({ status: 400, body: { error: "invalid_input", fix: "Fix these arguments and call again: draftId: Invalid UUID." } });
    const result = await harness.run(["pass", "nope"], { env: env() });
    expect(result.code).toBe(1);
    expect(result.json.error).toBe("invalid_input");
    expect(fake.calls).toHaveLength(1);
  });

  it("a rate limit is a refusal: exit 1, not retried", async () => {
    fake.failures.push({ status: 429, body: { error: "rate_limited", fix: "Wait 5 seconds, then retry." }, headers: { "retry-after": "5" } });
    const result = await harness.run(["balances"], { env: env() });
    expect(result.code).toBe(1);
    expect(fake.calls).toHaveLength(1);
  });

  it.each([
    [["approve", A], "Choose exactly one"],
    [["approve", A, "--save", "--post-now"], "exactly one"],
    [["pass"], "<draftId>"],
    [["pass", A, "extra"], "Too many"],
    [["balances", "--nope"], "--nope"],
    [["frobnicate"], "not a topped command"],
    [["generate", "gif", "--prompt", "x"], "image, video"],
    [["generate", "image"], "--prompt"],
    [["saved", "--limit", "ten"], "whole number"],
    [["runs", "--week", "W40"], "ISO week"],
    [["media", "demo", A], "--on | --off"],
    [["accounts", "disconnect", A, "--platform", "tiktok"], "--no-handle"],
    [["for-you", "edit", A], "--json"],
    [["balances", "--time-zone", "Europe/Paris"], "takes no time zone"],
    [["balances", "--request-id", "x"], "takes no request id"],
    [["--time-zone", "UTC", "balances"], "takes no time zone"],
    [["--request-id", "x", "balances"], "takes no request id"],
    [["--request-id"], "--request-id <id>"],
    [["runs", "--time-zone"], "--time-zone <zone>"],
    [["--time-zone=", "runs"], "--time-zone <zone>"],
    [["runs", "--time-zone", " "], "--time-zone <zone>"],
    [["approve", A, "--save", "--request-id="], "--request-id <id>"],
    [["--time-zone", "UTC", "--time-zone", "UTC", "runs"], "given twice"],
    [["--time-zone", "UTC", "runs", "--time-zone", "UTC"], "given twice"],
    [["run", "cancel", A], "--slot"],
    [["product", "update", "--json", "missing.json"], "missing.json"],
  ])("bad usage %j: exit 2 with a fix, and nothing is called", async (argv, fixMentions) => {
    const result = await harness.run(argv as string[], { env: env() });
    expect(result.code).toBe(2);
    expect(Object.keys(result.json).sort()).toEqual(["error", "fix"]);
    expect(result.json.fix).toContain(fixMentions);
    expect(fake.calls).toHaveLength(0);
  });

  it("stdin that isn't JSON is bad usage", async () => {
    const result = await harness.run(["call", "get_balances", "--json", "-"], { env: env(), stdin: "{nope" });
    expect(result.code).toBe(2);
    expect(result.json.error).toBe("invalid_json");
  });

  it("TOPPED_URL must be https or this machine", async () => {
    const result = await harness.run(["balances"], { env: { ...env(), TOPPED_URL: "http://app.topped.ai" } });
    expect(result.code).toBe(2);
    expect(result.json.error).toBe("invalid_topped_url");
  });
});

describe("reaching Topped", () => {
  it("nothing listening: exit 4", async () => {
    const result = await harness.run(["balances"], { env: { ...env(), TOPPED_URL: "http://127.0.0.1:9" } });
    expect(result.code).toBe(4);
    expect(result.json.error).toBe("unreachable");
  });

  it("a read is retried on a 5xx, a bounded number of times with backoff", async () => {
    const sleeps: number[] = [];
    fake.failures.push({ status: 502, raw: "<html>bad gateway</html>" }, { status: 500 });
    fake.on("get_balances", () => ({ credits: 1 }));
    const result = await harness.run(["balances"], { env: env(), sleeps });
    expect(result.code).toBe(0);
    expect(fake.calls).toHaveLength(3);
    expect(sleeps).toHaveLength(2);
    expect(sleeps[1]!).toBeGreaterThan(sleeps[0]!);
  });

  it("gives up after the last attempt with Topped's own answer", async () => {
    for (let i = 0; i < MAX_ATTEMPTS; i++) fake.failures.push({ status: 503, headers: { "retry-after": "1" } });
    const sleeps: number[] = [];
    const result = await harness.run(["balances"], { env: env(), sleeps });
    expect(result.code).toBe(1);
    expect(result.json.error).toBe("unavailable");
    expect(fake.calls).toHaveLength(MAX_ATTEMPTS);
    expect(sleeps).toEqual([1000, 1000]);
  });

  it("a page that isn't Topped's JSON is exit 4", async () => {
    for (let i = 0; i < MAX_ATTEMPTS; i++) fake.failures.push({ status: 502, raw: "<html>bad gateway</html>" });
    const result = await harness.run(["balances"], { env: env() });
    expect(result.code).toBe(4);
    expect(result.json.error).toBe("unexpected_response");
  });

  it("a change without a requestId is not retried on a 500: it might have happened", async () => {
    fake.failures.push({ status: 500, body: { error: "tool_failed", fix: "Topped could not confirm whether this happened." } });
    const result = await harness.run(["pass", A], { env: env() });
    expect(result.code).toBe(1);
    expect(fake.calls).toHaveLength(1);
  });

  it("a change without a requestId is retried on a 503: nothing ran", async () => {
    fake.failures.push({ status: 503 });
    const result = await harness.run(["pass", A], { env: env() });
    expect(result.code).toBe(0);
    expect(fake.calls).toHaveLength(2);
  });

  it("a change with a requestId is not retried on Topped's own 500: its fix says what to check", async () => {
    const failed = {
      error: "tool_failed",
      fix: "Topped could not confirm whether this happened. Check get_balances, and use a new requestId if it did not.",
    };
    fake.failures.push({ status: 500, body: failed });
    const result = await harness.run(["approve", A, "--save"], { env: env() });
    expect(result.code).toBe(1);
    expect(result.json).toEqual({ ...failed, requestId: fake.calls[0]!.input.requestId });
    expect(fake.calls).toHaveLength(1);
  });

  it("a change with a requestId is retried on a 500 that isn't Topped's answer", async () => {
    fake.failures.push({ status: 500, raw: "<html>internal error</html>" });
    const result = await harness.run(["approve", A, "--save"], { env: env() });
    expect(result.code).toBe(0);
    expect(fake.calls).toHaveLength(2);
  });

  it("exit 4 on a call with a requestId says to repeat it with that id, not a plain rerun", async () => {
    for (let i = 0; i < MAX_ATTEMPTS; i++) fake.failures.push({ status: 502, raw: "<html>bad gateway</html>" });
    const result = await harness.run(["generate", "image", "--prompt", "a cat", "--expected-credits", "12"], { env: env() });
    expect(result.code).toBe(4);
    const requestId = fake.calls[0]!.input.requestId;
    expect(result.json.requestId).toBe(requestId);
    expect(result.json.fix).toContain(`--request-id ${requestId}`);
    expect(result.json.fix).not.toContain("run the same command again");
  });

  it("exit 4 on a change without a requestId says to check whether it happened", async () => {
    const result = await harness.run(["pass", A], { env: { ...env(), TOPPED_URL: "http://127.0.0.1:9" } });
    expect(result.code).toBe(4);
    expect(result.json.fix).toContain("check whether it happened");
    expect(result.json.fix).not.toContain("run the same command again");
  });

  it("exit 4 on a read says to run it again", async () => {
    const result = await harness.run(["balances"], { env: { ...env(), TOPPED_URL: "http://127.0.0.1:9" } });
    expect(result.code).toBe(4);
    expect(result.json.fix).toContain("run the same command again");
  });

  it("a change with a requestId is retried under the same id", async () => {
    fake.failures.push({ status: 502, raw: "gateway" });
    const result = await harness.run(["approve", A, "--save"], { env: env() });
    expect(result.code).toBe(0);
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[0]!.input.requestId).toBe(fake.calls[1]!.input.requestId);
  });
});

describe("a slow call", () => {
  const inProgress = {
    status: 409,
    body: { error: "request_in_progress", fix: "A call with this requestId has not finished. Wait a few seconds and repeat it with the same requestId." },
  };
  /** A clock that moves only when the CLI waits. */
  const clockOn = (sleeps: number[]) => () => 1_000_000 + sleeps.reduce((sum, ms) => sum + ms, 0);

  it("a tool call is given as long as Topped lets it run; the tool list keeps a minute", async () => {
    const timers: number[] = [];
    const abortAfter = (ms: number) => {
      timers.push(ms);
      return AbortSignal.timeout(ms);
    };
    await harness.run(["tools"], { env: env(), abortAfter });
    expect(timers).toEqual([60_000]);
    timers.length = 0;
    await harness.run(["balances"], { env: env(), abortAfter });
    expect(timers).toEqual([TOOL_TIMEOUT_MS]);
    expect(TOOL_TIMEOUT_MS).toBeGreaterThanOrEqual(300_000);
  });

  it("a tool that answers after 70 seconds is waited for, not cut off and repeated", async () => {
    // As if 70 seconds pass inside the call: any timer shorter than that fires.
    const abortAfter = (ms: number) =>
      ms < 70_000 ? AbortSignal.abort(new DOMException("The operation timed out.", "TimeoutError")) : AbortSignal.timeout(ms);
    fake.on("generate_media", () => ({ changed: true, mediaId: A }));
    const result = await harness.run(["generate", "image", "--prompt", "a cat", "--expected-credits", "12"], { env: env(), abortAfter });
    expect(result.code, result.stdout).toBe(0);
    expect(result.json).toMatchObject({ changed: true, mediaId: A });
    expect(fake.calls).toHaveLength(1);
  });

  it("an answer lost on the way back: repeats under the same requestId until the first result comes back", async () => {
    const sleeps: number[] = [];
    fake.failures.push({ status: 504, raw: "<html>gateway timeout</html>" }, inProgress, inProgress);
    fake.on("generate_media", () => ({ changed: true, mediaId: A }));
    const result = await harness.run(["generate", "image", "--prompt", "a cat", "--expected-credits", "12"], {
      env: env(),
      sleeps,
      now: clockOn(sleeps),
    });
    expect(result.code, result.stdout).toBe(0);
    expect(result.json).toMatchObject({ changed: true, mediaId: A });
    expect(fake.calls).toHaveLength(4);
    expect(new Set(fake.calls.map((call) => call.input.requestId)).size).toBe(1);
    expect(sleeps.slice(1)).toEqual([2_000, 4_000]);
  });

  it("stops asking once the lost call's run must have ended, and then says it has not finished", async () => {
    const sleeps: number[] = [];
    fake.failures.push({ status: 504, raw: "<html>gateway timeout</html>" }, ...Array.from({ length: 100 }, () => inProgress));
    const result = await harness.run(["approve", A, "--save"], { env: env(), sleeps, now: clockOn(sleeps) });
    expect(result.code).toBe(1);
    expect(result.json).toMatchObject({ error: "request_in_progress", requestId: fake.calls[0]!.input.requestId });
    const waited = sleeps.reduce((sum, ms) => sum + ms, 0);
    expect(waited).toBeGreaterThanOrEqual(TOOL_TIMEOUT_MS - 1_000);
    expect(waited).toBeLessThanOrEqual(TOOL_TIMEOUT_MS + 1_000);
    expect(fake.calls.length).toBeLessThan(60);
  });

  it("a credential refused while asking again under the requestId is exit 3, and says to repeat it under that id", async () => {
    const sleeps: number[] = [];
    const refused = { status: 401, body: { error: "invalid_api_key", fix: "This key or sign-in is wrong, expired or was revoked." } };
    fake.failures.push({ status: 504, raw: "<html>gateway timeout</html>" }, inProgress, refused);
    const result = await harness.run(["approve", A, "--save"], { env: env(), sleeps, now: clockOn(sleeps) });
    expect(result.code, result.stdout).toBe(3);
    const requestId = fake.calls[0]!.input.requestId;
    expect(result.json).toEqual({ error: "invalid_api_key", fix: expect.stringContaining("TOPPED_API_KEY"), requestId });
    // The lost attempt may have run: a rerun under a fresh id could act twice.
    expect(result.json.fix).toContain(`run it again with --request-id ${requestId}`);
  });

  it("a credential refused on a call that reached Topped nowhere else says only to sign in", async () => {
    fake.failures.push({ status: 401, body: { error: "invalid_api_key", fix: "This key or sign-in is wrong, expired or was revoked." } });
    const result = await harness.run(["approve", A, "--save"], { env: env() });
    expect(result.code, result.stdout).toBe(3);
    expect(result.json.requestId).toBe(fake.calls[0]!.input.requestId);
    expect(result.json.fix).not.toContain("--request-id");
  });

  it("an answer lost before a refused sign-in is refreshed: still waits for the first result under the same requestId", async () => {
    const sleeps: number[] = [];
    await harness.login();
    const refused = { status: 401, body: { error: "invalid_api_key", fix: "This key or sign-in is wrong, expired or was revoked." } };
    fake.failures.push({ status: 504, raw: "<html>gateway timeout</html>" }, refused, inProgress);
    fake.on("approve_draft", () => ({ changed: true }));
    const result = await harness.run(["approve", A, "--save"], { sleeps, now: clockOn(sleeps) });
    expect(result.code, result.stdout).toBe(0);
    expect(result.json).toMatchObject({ changed: true });
    expect(fake.calls).toHaveLength(4);
    expect(new Set(fake.calls.map((call) => call.input.requestId)).size).toBe(1);
    expect(sleeps.slice(1)).toEqual([2_000]);
  });

  it("an answer lost, then the refreshed sign-in refused too: exit 3 says to repeat under the same requestId", async () => {
    const sleeps: number[] = [];
    await harness.login();
    const refused = { status: 401, body: { error: "invalid_api_key", fix: "This key or sign-in is wrong, expired or was revoked." } };
    fake.failures.push({ status: 504, raw: "<html>gateway timeout</html>" }, refused, refused);
    const result = await harness.run(["approve", A, "--save"], { sleeps, now: clockOn(sleeps) });
    expect(result.code, result.stdout).toBe(3);
    expect(result.json.error).toBe("signed_out");
    expect(result.json.fix).toContain(`run it again with --request-id ${fake.calls[0]!.input.requestId}`);
  });

  it("a stored sign-in refused while asking again is refreshed once, and the call goes on under the same requestId", async () => {
    const sleeps: number[] = [];
    await harness.login();
    const refreshes = () => fake.tokenRequests.filter((form) => form.get("grant_type") === "refresh_token").length;
    const before = refreshes();
    const refused = { status: 401, body: { error: "invalid_api_key", fix: "This key or sign-in is wrong, expired or was revoked." } };
    fake.failures.push({ status: 504, raw: "<html>gateway timeout</html>" }, inProgress, refused);
    fake.on("approve_draft", () => ({ changed: true }));
    const result = await harness.run(["approve", A, "--save"], { sleeps, now: clockOn(sleeps) });
    expect(result.code, result.stdout).toBe(0);
    expect(result.json).toMatchObject({ changed: true });
    expect(refreshes()).toBe(before + 1);
    expect(new Set(fake.calls.map((call) => call.input.requestId)).size).toBe(1);

    fake.failures.push({ status: 504, raw: "<html>gateway timeout</html>" }, inProgress, refused, refused);
    const signedOut = await harness.run(["approve", A, "--save"], { sleeps, now: clockOn(sleeps) });
    expect(signedOut.code, signedOut.stdout).toBe(3);
    expect(signedOut.json.error).toBe("signed_out");
  });

  it("not finished on the first try is Topped's answer at once: this run sent nothing that could still be running", async () => {
    fake.failures.push(inProgress);
    const result = await harness.run(["approve", A, "--save", "--request-id", "acc-1"], { env: env() });
    expect(result.code).toBe(1);
    expect(result.json).toMatchObject({ error: "request_in_progress", requestId: "acc-1" });
    expect(fake.calls).toHaveLength(1);
  });
});

describe("timeZone and requestId", () => {
  it("a tool that takes timeZone gets the system's zone", async () => {
    await harness.run(["runs"], { env: env(), systemTimeZone: "America/New_York" });
    expect(fake.calls[0]!.input.timeZone).toBe("America/New_York");
  });

  it("--time-zone overrides it", async () => {
    await harness.run(["run", "move", A, "--from-slot", "2026-10-02T17:00:00Z", "--to-day", "2026-10-03", "--time-zone", "Asia/Tokyo"], {
      env: env(),
    });
    expect(fake.calls[0]!.input.timeZone).toBe("Asia/Tokyo");
  });

  it("a tool without it never gets one", async () => {
    await harness.run(["for-you"], { env: env() });
    expect(fake.calls[0]!.input).toEqual({});
  });

  it("topped call adds the zone and keeps one the input already names", async () => {
    await harness.run(["call", "list_publish_runs"], { env: env() });
    expect(fake.calls[0]!.input.timeZone).toBe("Europe/London");
    await harness.run(["call", "list_publish_runs", "--json", "-"], { env: env(), stdin: '{"timeZone":"Australia/Sydney"}' });
    expect(fake.calls[1]!.input.timeZone).toBe("Australia/Sydney");
  });

  it("--time-zone and --request-id may come before the command, bare or with =", async () => {
    fake.on("approve_draft", () => ({ changed: true }));
    const approve = await harness.run(["--request-id", "acc-first", "approve", A, "--save"], { env: env() });
    expect(approve.code, approve.stdout).toBe(0);
    expect(fake.calls[0]!.input).toMatchObject({ draftId: A, requestId: "acc-first" });
    const runs = await harness.run(["--time-zone", "UTC", "runs"], { env: env() });
    expect(runs.code, runs.stdout).toBe(0);
    expect(fake.calls[1]!.input.timeZone).toBe("UTC");
    const move = await harness.run(
      ["--time-zone=Asia/Tokyo", "--verbose", "run", "move", A, "--from-slot", "2026-10-02T17:00:00Z", "--to-day", "2026-10-03"],
      { env: env() },
    );
    expect(move.code, move.stdout).toBe(0);
    expect(fake.calls[2]!.input.timeZone).toBe("Asia/Tokyo");
  });

  it("a fresh requestId per run, echoed in the output", async () => {
    fake.on("approve_draft", () => ({ changed: true, message: "Saved to the Library." }));
    const first = await harness.run(["approve", A, "--save"], { env: env() });
    expect(first.json.requestId).toMatch(/^cli-/);
    expect(fake.calls[0]!.input.requestId).toBe(first.json.requestId);
    const second = await harness.run(["approve", A, "--save"], { env: env() });
    expect(second.json.requestId).not.toBe(first.json.requestId);
  });

  it("--request-id repeats a call safely: the second run returns the first result", async () => {
    let saves = 5;
    fake.on("approve_draft", () => {
      saves -= 1;
      return { changed: true, balances: { contentSaves: saves } };
    });
    const first = await harness.run(["approve", A, "--save", "--request-id", "acc-1"], { env: env() });
    const second = await harness.run(["approve", A, "--save", "--request-id", "acc-1"], { env: env() });
    expect(first.code).toBe(0);
    expect(second.json).toEqual(first.json);
    expect(first.json.requestId).toBe("acc-1");
    expect(saves).toBe(4);
  });

  it("the price comes back without --expected-credits, and the confirming run carries a new id", async () => {
    fake.on("generate_media", (input) =>
      input.expectedCredits === 12
        ? { changed: true, mediaId: A }
        : { changed: false, status: "price", price: 12, message: "Nothing was made yet. This costs 12 credits." },
    );
    const quote = await harness.run(["generate", "image", "--prompt", "a cat"], { env: env() });
    expect(quote.code).toBe(0);
    expect(quote.json).toMatchObject({ status: "price", price: 12 });
    const made = await harness.run(["generate", "image", "--prompt", "a cat", "--expected-credits", "12"], { env: env() });
    expect(made.json).toMatchObject({ changed: true, mediaId: A });
    expect(fake.calls[0]!.input.requestId).not.toBe(fake.calls[1]!.input.requestId);
  });
});

describe("when topped itself fails", () => {
  it("exit 1 says topped failed and what happened, never a plain rerun", async () => {
    const result = await harness.run(["call", "get_balances", "--json", "-"], {
      env: env(),
      readStdin: async () => {
        throw new Error("stdin closed");
      },
    });
    expect(result.code).toBe(1);
    expect(result.json.error).toBe("internal_error");
    expect(result.json.fix).toContain("stdin closed");
    expect(result.json.fix).not.toMatch(/run the same command again/i);
    expect(fake.calls).toHaveLength(0);
  });

  it("--help documents exit 1 as a refusal or topped's own failure", async () => {
    const result = await harness.run(["--help"]);
    expect(result.json.exitCodes["1"]).toMatch(/topped itself/);
  });
});

describe("no secret ever reaches stdout or stderr", () => {
  it("not under --verbose, which names each request", async () => {
    const result = await harness.run(["balances", "--verbose"], { env: env() });
    expect(result.stderr).toContain("POST /api/v1/tools/get_balances 200");
    // The harness checks every run for the key and every token.
  });

  it("not when Topped echoes one back", async () => {
    fake.on("get_balances", () => ({ note: `you sent ${fake.apiKey}` }));
    const result = await harness.run(["balances"], { env: env() });
    expect(result.json.note).toBe("you sent [redacted]");
  });

  it("not across a whole sign-in, refresh and sign-out", async () => {
    const outputs: string[] = [];
    const record = (r: { stdout: string; stderr: string }) => outputs.push(r.stdout, r.stderr);
    record(await harness.run(["login", "--verbose"]));
    record(await harness.run(["whoami", "--verbose"]));
    fake.expireAccessTokens();
    record(await harness.run(["balances", "--verbose"]));
    record(await harness.run(["logout", "--verbose"]));
    const all = outputs.join("\n");
    for (const secret of fake.secrets) expect(all).not.toContain(secret);
    expect(all).not.toMatch(/tpd_(live|at|rt)_/);
  });
});
