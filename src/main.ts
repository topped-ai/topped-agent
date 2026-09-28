/**
 * One run of `topped`: read the command line, run the one tool the command
 * maps to (or the sign-in commands), and write exactly one JSON document to
 * stdout. Returns the exit code.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { ToppedApi } from "./api.js";
import { parseArgs, type FlagValue, type GlobalOptions, type Parsed } from "./args.js";
import { resolveAuth, SETTINGS_PLACE } from "./auth.js";
import type { CommandSpec, FlagSpec } from "./commands.js";
import type { CliDeps } from "./deps.js";
import { helpDocument } from "./help.js";
import { isRecord, NotReached, type Repeat, resolveBaseUrl, type Session } from "./http.js";
import { CLIENT_NAME, runLogin } from "./login.js";
import { CliError, EXIT, formatJson, Redactor, usageError } from "./output.js";
import { ConfigStore } from "./store.js";
import { factsFromListing, REQUEST_ID_INPUT, TIME_ZONE_INPUT, TOOLS, type ToolFacts, type ToolListing } from "./tools.js";
import { runUpload } from "./upload.js";
import { VERSION } from "./version.js";

async function readJsonArgument(deps: CliDeps, source: string, flag: string): Promise<unknown> {
  let text: string;
  if (source === "-") {
    text = await deps.readStdin();
  } else {
    try {
      text = await readFile(resolve(deps.cwd, source), "utf8");
    } catch {
      throw usageError(`Could not read ${flag} ${source}. Give a JSON file, or - for stdin.`, "file_not_found");
    }
  }
  try {
    return JSON.parse(text);
  } catch {
    throw usageError(`${flag} ${source === "-" ? "(stdin)" : source} is not valid JSON.`, "invalid_json");
  }
}

function convertFlag(spec: FlagSpec, value: FlagValue): unknown {
  switch (spec.kind) {
    case "int": {
      const n = Number(value);
      if (typeof value !== "string" || value.trim() === "" || !Number.isInteger(n)) {
        throw usageError(`--${spec.name} must be a whole number.`);
      }
      return n;
    }
    case "number": {
      const n = Number(value);
      if (typeof value !== "string" || value.trim() === "" || !Number.isFinite(n)) {
        throw usageError(`--${spec.name} must be a number.`);
      }
      return n;
    }
    default:
      return value;
  }
}

/** The tool input a command line names: --json, then arguments, flags and the command's own reading. */
async function buildInput(deps: CliDeps, parsed: Parsed, command: CommandSpec): Promise<Record<string, unknown>> {
  let input: Record<string, unknown> = {};
  if (command.json && parsed.globals.json !== undefined) {
    const document = await readJsonArgument(deps, parsed.globals.json, "--json");
    if (command.json.field === null) {
      if (!isRecord(document)) throw usageError("--json must hold one JSON object: the tool's input.");
      input = { ...document };
    } else {
      input[command.json.field] = document;
    }
  }
  for (const arg of command.args) {
    if (arg.field) input[arg.field] = parsed.args[arg.name];
  }
  const flags: Record<string, unknown> = {};
  for (const spec of command.flags) {
    if (!(spec.name in parsed.flags)) continue;
    const value = convertFlag(spec, parsed.flags[spec.name]!);
    flags[spec.name] = value;
    if (spec.field) input[spec.field] = value;
  }
  if (command.build) Object.assign(input, command.build(flags, parsed.args));
  if (command.platformJson && typeof flags["platform-json"] === "string") {
    const settings = await readJsonArgument(deps, flags["platform-json"], "--platform-json");
    if (!isRecord(settings) || Object.keys(settings).some((key) => key !== "tiktok" && key !== "youtube")) {
      throw usageError('--platform-json must hold { "tiktok": [...], "youtube": {...} } and nothing else.');
    }
    Object.assign(input, settings);
  }
  return input;
}

/**
 * The inputs the transport adds (spec §11): the founder's time zone for a
 * tool that takes one, and a requestId for a tool that takes one - the
 * caller's, or a fresh one per run, echoed back.
 */
function addTransportInputs(
  deps: CliDeps,
  tool: string,
  facts: ToolFacts,
  globals: GlobalOptions,
  input: Record<string, unknown>,
): string | undefined {
  if (facts.timeZone) {
    const sent = typeof input[TIME_ZONE_INPUT] === "string" ? (input[TIME_ZONE_INPUT] as string) : undefined;
    const zone = globals.timeZone ?? sent ?? deps.systemTimeZone();
    if (zone) input[TIME_ZONE_INPUT] = zone;
  } else if (globals.timeZone !== undefined) {
    throw usageError(`${tool} takes no time zone. Leave out --time-zone.`);
  }
  if (facts.requestId) {
    const sent = typeof input[REQUEST_ID_INPUT] === "string" ? (input[REQUEST_ID_INPUT] as string) : undefined;
    const id = globals.requestId ?? sent ?? `cli-${deps.randomId()}`;
    input[REQUEST_ID_INPUT] = id;
    return id;
  }
  if (globals.requestId !== undefined) throw usageError(`${tool} takes no request id. Leave out --request-id.`);
  return undefined;
}

/** The requestId a call ran under, beside its result, so the caller can repeat it safely. */
function withRequestId(value: unknown, requestId: string | undefined): unknown {
  if (requestId === undefined || !isRecord(value) || REQUEST_ID_INPUT in value) return value;
  return { ...value, [REQUEST_ID_INPUT]: requestId };
}

async function runTool(
  session: Session,
  api: ToppedApi,
  parsed: Parsed,
  tool: string,
  facts: ToolFacts,
  input: Record<string, unknown>,
): Promise<unknown> {
  const requestId = addTransportInputs(session.deps, tool, facts, parsed.globals, input);
  const repeat: Repeat = !facts.changes ? "safe" : requestId !== undefined ? "keyed" : "once";
  try {
    const result = await api.callTool(tool, input, repeat);
    return withRequestId(result, requestId);
  } catch (error) {
    // The call may have reached Topped with only its answer lost: a plain
    // rerun would carry a fresh requestId and could act twice.
    if (error instanceof NotReached && facts.changes) {
      error.thenDo(
        requestId !== undefined
          ? `run it again with --request-id ${requestId}: the same id never acts twice`
          : "check whether it happened before running it again, since it may have reached Topped",
      );
    }
    // Refused credential after an attempt that may have run: once signed in
    // again, only a repeat under the same requestId is safe.
    if (error instanceof CliError && error.exitCode === EXIT.auth && error.mayHaveRun && requestId !== undefined) {
      error.body.fix = `${String(error.body.fix)} Then run it again with --request-id ${requestId}: an earlier try may have reached Topped, and the same id never acts twice.`;
    }
    if (error instanceof CliError && requestId !== undefined && isRecord(error.body) && !(REQUEST_ID_INPUT in error.body)) {
      (error as { body: Record<string, unknown> }).body = { ...error.body, [REQUEST_ID_INPUT]: requestId };
    }
    throw error;
  }
}

/** A tool this build does not know: its facts from the live list, so `topped call` never lags Topped. */
async function liveFacts(api: ToppedApi, tool: string): Promise<ToolFacts> {
  const known = TOOLS[tool];
  if (known) return known;
  const listed = await api.listTools();
  const tools = isRecord(listed) && Array.isArray(listed.tools) ? (listed.tools as ToolListing[]) : [];
  const entry = tools.find((candidate) => isRecord(candidate) && candidate.name === tool);
  // Unknown to Topped too: Topped's own answer to the call says so.
  return entry ? factsFromListing(entry) : { changes: true };
}

async function execute(parsed: Parsed, command: CommandSpec, session: Session, store: ConfigStore): Promise<unknown> {
  const env = session.deps.env;
  const keyInEnv = Boolean(env.TOPPED_API_KEY?.trim());
  const name = command.words.join(" ");

  if (name === "login") {
    if (keyInEnv) session.hint("TOPPED_API_KEY is set, and it wins over this sign-in until you unset it.");
    // Each sign-in is its own app on Topped, and Topped has no door for the
    // CLI to revoke one: the replaced app stays until the founder revokes it.
    const replaced = (await store.getLogin(session.baseUrl)) !== null;
    await runLogin(session, store, { openBrowser: parsed.flags["no-browser"] !== true, ...loginPort(command, parsed) });
    let who: Record<string, unknown> = {};
    try {
      const answer = await new ToppedApi(session, await resolveAuthForLogin(session, store)).whoami();
      if (isRecord(answer)) who = answer;
    } catch {
      // Signed in; naming the Product is a courtesy.
    }
    return {
      ok: true,
      signedIn: true,
      app: typeof who.keyName === "string" ? who.keyName : CLIENT_NAME,
      productName: who.productName ?? null,
      url: session.baseUrl,
      message: `Signed in to Topped. The sign-in is kept in ${store.credentialsPath}.`,
      ...(replaced
        ? {
            fix: `This replaced an earlier sign-in from this machine. It stays on Topped until you revoke the older "${CLIENT_NAME}" (the earlier Connected date) under ${SETTINGS_PLACE}.`,
          }
        : {}),
    };
  }

  if (name === "logout") {
    const had = await store.removeLogin(session.baseUrl);
    if (keyInEnv) session.hint("TOPPED_API_KEY is still set; topped keeps using it until you unset it.");
    return {
      ok: true,
      signedOut: had,
      url: session.baseUrl,
      message: had ? "Signed out on this machine." : "There was no sign-in kept on this machine.",
      fix: `To remove the app from Topped too, revoke "${CLIENT_NAME}" in Topped under ${SETTINGS_PLACE}.`,
    };
  }

  const api = new ToppedApi(session, await resolveAuth(session, store));

  if (name === "whoami") {
    const answer = await api.whoami();
    return isRecord(answer) ? { ...answer, source: api.source, url: session.baseUrl } : answer;
  }
  if (name === "tools") return api.listTools();

  if (name === "call") {
    const tool = parsed.args.tool!;
    const input =
      parsed.globals.json === undefined ? {} : await readJsonArgument(session.deps, parsed.globals.json, "--json");
    if (!isRecord(input)) throw usageError("--json must hold one JSON object: the tool's input.");
    return runTool(session, api, parsed, tool, await liveFacts(api, tool), { ...input });
  }

  if (name === "upload") {
    if (parsed.globals.timeZone !== undefined || parsed.globals.requestId !== undefined) {
      throw usageError("upload_media takes no time zone and no request id.");
    }
    const flags = parsed.flags;
    const duration = flags.duration === undefined ? undefined : convertFlag(command.flags.find((f) => f.name === "duration")!, flags.duration);
    return runUpload(session, api, {
      file: parsed.args.file!,
      demo: flags.demo === true,
      ...(duration !== undefined ? { duration: duration as number } : {}),
      ...(typeof flags.poster === "string" ? { poster: flags.poster } : {}),
      ...(typeof flags.title === "string" ? { title: flags.title } : {}),
      rightsConfirmed: flags["rights-confirmed"] === true,
    });
  }

  const tool = command.tool!;
  const facts = TOOLS[tool]!;
  return runTool(session, api, parsed, tool, facts, await buildInput(session.deps, parsed, command));
}

/** `--port`, a TCP port a listener can take. */
function loginPort(command: CommandSpec, parsed: Parsed): { port?: number } {
  const value = parsed.flags.port;
  if (value === undefined) return {};
  const port = convertFlag(command.flags.find((flag) => flag.name === "port")!, value) as number;
  if (port < 1 || port > 65535) throw usageError("--port must be a port number from 1 to 65535.");
  return { port };
}

async function resolveAuthForLogin(session: Session, store: ConfigStore) {
  // Right after signing in, name what the new sign-in reaches - not an env key.
  const env = { ...session.deps.env, TOPPED_API_KEY: undefined };
  return resolveAuth({ ...session, deps: { ...session.deps, env } }, store);
}

export async function run(argv: readonly string[], deps: CliDeps): Promise<number> {
  const redactor = new Redactor();
  let pretty = argv.includes("--pretty");
  const write = (value: unknown) => deps.writeStdout(redactor.redact(formatJson(value, pretty)));
  const hint = (text: string) => deps.writeStderr(redactor.redact(text.endsWith("\n") ? text : `${text}\n`));

  try {
    const parsed = parseArgs(argv);
    pretty = parsed.globals.pretty;
    if (parsed.globals.version) {
      write({ name: "topped", version: VERSION });
      return EXIT.ok;
    }
    if (parsed.globals.help || parsed.command === null) {
      write(helpDocument(parsed.command));
      return EXIT.ok;
    }
    const session: Session = {
      deps,
      baseUrl: resolveBaseUrl(deps.env),
      redactor,
      verbose: parsed.globals.verbose,
      hint,
    };
    const result = await execute(parsed, parsed.command, session, new ConfigStore(deps.env));
    write(result);
    return EXIT.ok;
  } catch (error) {
    if (error instanceof CliError) {
      write(error.body);
      return error.exitCode;
    }
    write({
      error: "internal_error",
      fix: `topped itself failed (${error instanceof Error ? error.message : "unknown error"}). If the command changes something, check whether it happened before running it again; if this keeps happening, update topped.`,
    });
    return EXIT.refused;
  }
}
