/**
 * The command line, read against the command table: which command, its
 * positional arguments, its flags, and the flags every command takes.
 */

import { COMMANDS, type CommandSpec, type FlagSpec } from "./commands.js";
import { usageError } from "./output.js";

export type FlagValue = string | boolean | null | string[];

export interface GlobalOptions {
  pretty: boolean;
  verbose: boolean;
  help: boolean;
  version: boolean;
  timeZone?: string;
  requestId?: string;
  json?: string;
}

export interface Parsed {
  /** `null` for `topped` alone, `topped --help` or `topped --version`. */
  command: CommandSpec | null;
  args: Record<string, string>;
  flags: Record<string, FlagValue>;
  globals: GlobalOptions;
}

/** The value flags every command takes: the option each one sets, and its value placeholder. */
export const GLOBAL_VALUE_FLAGS = {
  "time-zone": { key: "timeZone", placeholder: "<zone>" },
  "request-id": { key: "requestId", placeholder: "<id>" },
} as const satisfies Record<string, { key: keyof GlobalOptions; placeholder: string }>;

type GlobalValueFlag = keyof typeof GLOBAL_VALUE_FLAGS;

function isGlobalValueFlag(name: string): name is GlobalValueFlag {
  return Object.hasOwn(GLOBAL_VALUE_FLAGS, name);
}

function commandFor(words: string[]): { command: CommandSpec | null; consumed: number } {
  let best: CommandSpec | null = null;
  let consumed = 0;
  for (const command of COMMANDS) {
    const n = command.words.length;
    if (n > words.length || n <= consumed) continue;
    if (command.words.every((word, i) => words[i] === word)) {
      best = command;
      consumed = n;
    }
  }
  return { command: best, consumed };
}

function flagByName(command: CommandSpec | null, name: string): { spec: FlagSpec; negated: boolean } | null {
  const flags = command?.flags ?? [];
  const direct = flags.find((flag) => flag.name === name);
  if (direct) return { spec: direct, negated: false };
  if (name.startsWith("no-")) {
    const negated = flags.find(
      (flag) => flag.name === name.slice(3) && (flag.kind === "negatable" || flag.kind === "nullable"),
    );
    if (negated) return { spec: negated, negated: true };
  }
  return null;
}

function helpFor(command: CommandSpec | null): string {
  return command === null ? "Run topped --help for the commands." : `Run topped ${command.words.join(" ")} --help for its usage.`;
}

/** A flag token split into its name and its `=value`, when it has one. */
function splitFlag(token: string): { name: string; inline: string | undefined } {
  const eq = token.indexOf("=");
  return { name: token.slice(2, eq === -1 ? undefined : eq), inline: eq === -1 ? undefined : token.slice(eq + 1) };
}

export function parseArgs(argv: readonly string[]): Parsed {
  const globals: GlobalOptions = { pretty: false, verbose: false, help: false, version: false };
  const flags: Record<string, FlagValue> = {};
  const seen = new Set<string>();
  const once = (name: string) => {
    if (seen.has(name)) throw usageError(`--${name} was given twice. Give it once.`);
    seen.add(name);
  };

  let index = 0;
  /** The value of the flag at `index`: its `=value`, else the next token, which it then consumes. */
  const takeValue = (name: string, inline: string | undefined, placeholder: string): string => {
    if (inline !== undefined) return inline;
    const next = argv[index + 1];
    if (next === undefined || (next.startsWith("--") && next !== "--")) {
      throw usageError(`--${name} needs a value: --${name} ${placeholder}.`);
    }
    index++;
    return next;
  };
  const noValue = (name: string, inline: string | undefined) => {
    if (inline !== undefined) throw usageError(`--${name} takes no value.`);
  };
  /** Read `token` when it is a flag every command takes, before or after the command; says whether it was one. */
  const readGlobal = (token: string): boolean => {
    if (token === "-h") {
      globals.help = true;
      return true;
    }
    if (!token.startsWith("--")) return false;
    const { name, inline } = splitFlag(token);
    if (name === "pretty" || name === "verbose" || name === "help" || name === "version") {
      noValue(name, inline);
      globals[name] = true;
      return true;
    }
    if (!isGlobalValueFlag(name)) return false;
    const { key, placeholder } = GLOBAL_VALUE_FLAGS[name];
    once(name);
    const value = takeValue(name, inline, placeholder);
    if (value.trim() === "") throw usageError(`--${name} needs a value: --${name} ${placeholder}.`);
    globals[key] = value;
    return true;
  };

  // Leading words pick the command, with the flags every command takes
  // allowed among them; everything after is read against the command.
  const words: string[] = [];
  for (; index < argv.length; index++) {
    const token = argv[index]!;
    if (readGlobal(token)) continue;
    if (token.startsWith("-")) break;
    words.push(token);
  }
  const { command, consumed } = commandFor(words);
  const pending: string[] = words.slice(consumed);
  if (command === null && words.length > 0) {
    throw usageError(`"${words[0]}" is not a topped command. Run topped --help for the commands.`, "unknown_command");
  }

  let positionalOnly = false;
  for (; index < argv.length; index++) {
    const token = argv[index]!;
    if (positionalOnly || !token.startsWith("-") || token === "-") {
      pending.push(token);
      continue;
    }
    if (token === "--") {
      positionalOnly = true;
      continue;
    }
    if (readGlobal(token)) continue;
    if (!token.startsWith("--")) throw usageError(`Unknown flag ${token}. ${helpFor(command)}`);
    const { name, inline } = splitFlag(token);
    if (name === "json" && command?.json) {
      once(name);
      globals.json = takeValue(name, inline, "<file|->");
      continue;
    }

    const found = flagByName(command, name);
    if (found === null) throw usageError(`Unknown flag --${name}. ${helpFor(command)}`, "unknown_flag");
    const { spec, negated } = found;
    once(spec.name);
    if (negated) {
      noValue(name, inline);
      flags[spec.name] = spec.kind === "nullable" ? null : false;
    } else if (spec.kind === "boolean" || spec.kind === "negatable") {
      noValue(name, inline);
      flags[spec.name] = true;
    } else {
      const value = takeValue(name, inline, spec.value ?? "<value>");
      flags[spec.name] =
        spec.kind === "list"
          ? value
              .split(",")
              .map((item) => item.trim())
              .filter((item) => item !== "")
          : value;
    }
  }

  const args: Record<string, string> = {};
  if (command !== null && !globals.help) {
    const specs = command.args;
    if (pending.length > specs.length) {
      throw usageError(`Too many arguments: ${pending.slice(specs.length).join(" ")}. Usage: ${command.usage}`);
    }
    specs.forEach((spec, i) => {
      const value = pending[i];
      if (value === undefined) throw usageError(`Missing ${spec.placeholder}. Usage: ${command.usage}`);
      if (spec.choices && !spec.choices.includes(value)) {
        throw usageError(`${spec.placeholder} must be one of ${spec.choices.join(", ")}. Usage: ${command.usage}`);
      }
      args[spec.name] = value;
    });
    for (const spec of command.flags) {
      if (spec.required && !(spec.name in flags)) {
        const how = spec.kind === "nullable" ? `--${spec.name} ${spec.value ?? "<value>"} (or --no-${spec.name})` : `--${spec.name} ${spec.value ?? ""}`.trim();
        throw usageError(`Add ${how}. Usage: ${command.usage}`);
      }
    }
    if (command.json?.required && globals.json === undefined) {
      throw usageError(`Add --json <file|->: ${command.json.help} Usage: ${command.usage}`);
    }
  } else if (command === null && pending.length > 0 && !globals.help) {
    throw usageError(`Unexpected ${pending[0]}. Run topped --help for the commands.`);
  }

  return { command, args, flags, globals };
}
