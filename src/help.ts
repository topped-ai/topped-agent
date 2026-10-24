/**
 * `topped --help` and `topped <command> --help`: one JSON document, like
 * every other answer, so an agent reads the commands the way it reads results.
 */

import { GLOBAL_VALUE_FLAGS } from "./args.js";
import type { CommandSpec, FlagSpec } from "./commands.js";
import { COMMANDS } from "./commands.js";
import { DEFAULT_BASE_URL } from "./http.js";
import { TOOLS } from "./tools.js";
import { VERSION } from "./version.js";

export const GLOBAL_FLAGS = [
  { flag: "--pretty", help: "Indent the JSON for people." },
  { flag: "--verbose", help: "Name each request and its status on stderr (never a token)." },
  { flag: `--time-zone ${GLOBAL_VALUE_FLAGS["time-zone"].placeholder}`, help: "An IANA time zone for tools that take one, only when the founder names one. Left out, Topped uses the zone the founder saved in Settings." },
  { flag: `--request-id ${GLOBAL_VALUE_FLAGS["request-id"].placeholder}`, help: "For tools that spend or publish: repeating the call with the same id returns the first result." },
  { flag: "--help", help: "This document, or one command's." },
  { flag: "--version", help: "The CLI's version." },
];

const EXIT_CODES = {
  "0": "Done.",
  "1": "Topped refused: stdout is Topped's own { error, fix }. Or topped itself failed: fix names what failed.",
  "2": "Bad usage: stdout is { error, fix } naming what to change.",
  "3": "Not signed in, or the sign-in or key was refused: run topped login, then do what fix says (for a call that may have reached Topped, repeat it with the same --request-id).",
  "4": "Could not reach Topped: fix says how to repeat the command safely.",
};

function flagLine(flag: FlagSpec): string {
  const value = flag.kind === "boolean" || flag.kind === "negatable" ? "" : ` ${flag.value ?? "<value>"}`;
  return `--${flag.name}${value}`;
}

function commandHelp(command: CommandSpec) {
  const facts = command.tool === null ? undefined : TOOLS[command.tool];
  return {
    command: command.words.join(" "),
    usage: command.usage,
    summary: command.summary,
    tool: command.tool,
    arguments: command.args.map((arg) => ({
      name: arg.placeholder,
      ...(arg.field ? { field: arg.field } : {}),
      ...(arg.choices ? { choices: arg.choices } : {}),
    })),
    flags: [
      ...command.flags.map((flag) => ({
        flag: flagLine(flag),
        ...(flag.kind === "negatable" || flag.kind === "nullable" ? { negation: `--no-${flag.name}` } : {}),
        ...(flag.field ? { field: flag.field } : {}),
        ...(flag.required ? { required: true } : {}),
        help: flag.help,
      })),
      ...(command.json
        ? [{ flag: "--json <file|->", field: command.json.field ?? "(the whole input)", ...(command.json.required ? { required: true } : {}), help: `${command.json.help} "-" reads stdin.` }]
        : []),
    ],
    ...(facts?.timeZone ? { timeZone: "Days and times read in the zone the founder saved in Settings (topped balances shows it); --time-zone <zone> names another." } : {}),
    ...(facts?.requestId ? { requestId: "A fresh id per run, echoed in the output; --request-id <id> repeats a call safely." } : {}),
  };
}

export function helpDocument(command: CommandSpec | null) {
  if (command !== null) return commandHelp(command);
  return {
    name: "topped",
    version: VERSION,
    summary: "Run Topped from a terminal or a coding agent. Every command prints exactly one JSON document on stdout.",
    usage: "topped <command> [arguments] [flags]",
    commands: COMMANDS.map((c) => ({ command: c.words.join(" "), usage: c.usage, tool: c.tool, summary: c.summary })),
    globalFlags: GLOBAL_FLAGS,
    environment: {
      TOPPED_API_KEY: "A tpd_live_ key for scripts and CI. It wins over a stored topped login.",
      TOPPED_URL: `Where Topped is. Default ${DEFAULT_BASE_URL}.`,
      XDG_CONFIG_HOME: "Where topped login keeps its sign-in (topped/credentials.json), when it is an absolute path. Default ~/.config.",
    },
    output: "stdout is one JSON document. A failure exits non-zero with { error, fix } on stdout. Hints for people go to stderr.",
    exitCodes: EXIT_CODES,
  };
}
