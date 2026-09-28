/**
 * The output contract (spec §11): stdout is always exactly one JSON document,
 * human hints go to stderr, a failure exits non-zero with `{ error, fix }` on
 * stdout, and no token or key ever reaches either stream.
 */

export const EXIT = {
  /** Done. */
  ok: 0,
  /** Topped refused: its own `{ error, fix }` is on stdout. */
  refused: 1,
  /** The command line was wrong. */
  usage: 2,
  /** Not signed in, or the sign-in or key was refused. */
  auth: 3,
  /** Topped could not be reached, or answered with something that is not Topped. */
  unreachable: 4,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** A failure the CLI reports: the exit code, and the body stdout carries. */
export class CliError extends Error {
  readonly exitCode: ExitCode;
  readonly body: Record<string, unknown>;
  /** An earlier attempt of the failed call may have reached Topped and run. */
  mayHaveRun = false;

  constructor(exitCode: ExitCode, error: string, fix: string, extras: Record<string, unknown> = {}) {
    super(error);
    this.exitCode = exitCode;
    this.body = { error, fix, ...extras };
  }

  /** A failure whose body is Topped's own answer, passed through as it came. */
  static passThrough(exitCode: ExitCode, body: Record<string, unknown>): CliError {
    const failure = new CliError(exitCode, String(body.error), String(body.fix));
    (failure as { body: Record<string, unknown> }).body = body;
    return failure;
  }
}

export function usageError(fix: string, error = "usage"): CliError {
  return new CliError(EXIT.usage, error, fix);
}

/** Every secret Topped hands out starts with one of these prefixes. */
const SECRET_PATTERN = /tpd_(?:live|at|rt)_[0-9A-Za-z]+/g;

/**
 * The last line of defence: whatever is written, a Topped key or token in it
 * is replaced, and so is any secret this process holds in memory.
 */
export class Redactor {
  private readonly secrets = new Set<string>();

  add(secret: string | null | undefined): void {
    if (secret && secret.length >= 8) this.secrets.add(secret);
  }

  redact(text: string): string {
    let out = text.replace(SECRET_PATTERN, "[redacted]");
    for (const secret of this.secrets) out = out.split(secret).join("[redacted]");
    return out;
  }
}

export function formatJson(value: unknown, pretty: boolean): string {
  return `${JSON.stringify(value, null, pretty ? 2 : undefined)}\n`;
}
