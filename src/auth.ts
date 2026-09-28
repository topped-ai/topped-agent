/**
 * Which credential a call carries. `TOPPED_API_KEY` wins over a stored
 * sign-in (spec §4), so scripts and CI never pick up a founder's login by
 * accident. A stored sign-in's access token lasts an hour: it is refreshed a
 * minute before it runs out, and once more when Topped answers 401, and the
 * rotated refresh token is stored each time. A refused refresh means signing
 * in again.
 */

import { exchange, isRecord, NotReached, type Session } from "./http.js";
import { CliError, EXIT } from "./output.js";
import type { ConfigStore, StoredLogin } from "./store.js";

export type CredentialSource = "TOPPED_API_KEY" | "topped login";

export interface Auth {
  readonly source: CredentialSource;
  /** The bearer token for the next call. */
  token(): Promise<string>;
  /** After a 401: whether a fresh token is ready to try once more. */
  recover(): Promise<boolean>;
  /** The failure for a 401 that recovery did not fix. */
  refused(): CliError;
}

export const SETTINGS_PLACE = "Settings > Connect your agent";
/** Refresh this long before the access token runs out. */
const REFRESH_MARGIN_MS = 60_000;

export function notSignedIn(): CliError {
  return new CliError(
    EXIT.auth,
    "not_signed_in",
    `Run topped login to sign in with your browser, or set TOPPED_API_KEY to a key from Topped (${SETTINGS_PLACE}).`,
  );
}

function signInAgain(): CliError {
  return new CliError(EXIT.auth, "signed_out", "Your Topped sign-in expired or was revoked. Run topped login again.");
}

class KeyAuth implements Auth {
  readonly source = "TOPPED_API_KEY" as const;
  constructor(private readonly key: string) {}

  async token(): Promise<string> {
    return this.key;
  }

  async recover(): Promise<boolean> {
    return false;
  }

  refused(): CliError {
    return new CliError(
      EXIT.auth,
      "invalid_api_key",
      `Topped refused TOPPED_API_KEY: it is wrong or was revoked. Create a new key in Topped (${SETTINGS_PLACE}), or unset TOPPED_API_KEY and run topped login.`,
    );
  }
}

class LoginAuth implements Auth {
  readonly source = "topped login" as const;
  private recovered = false;

  constructor(
    private readonly session: Session,
    private readonly store: ConfigStore,
    private login: StoredLogin,
  ) {
    session.redactor.add(login.accessToken);
    session.redactor.add(login.refreshToken);
  }

  async token(): Promise<string> {
    if (this.login.expiresAt - this.session.deps.now() <= REFRESH_MARGIN_MS) await this.refresh();
    return this.login.accessToken;
  }

  async recover(): Promise<boolean> {
    if (this.recovered) return false;
    this.recovered = true;
    await this.refresh(true);
    return true;
  }

  refused(): CliError {
    return signInAgain();
  }

  private async refresh(force = false): Promise<void> {
    const { session, store } = this;
    // Another topped process may have refreshed already: use what it stored.
    const stored = await store.getLogin(session.baseUrl);
    if (stored === null) throw signInAgain();
    if (stored.refreshToken !== this.login.refreshToken) {
      this.adopt(stored);
      if (!force && stored.expiresAt - session.deps.now() > REFRESH_MARGIN_MS) return;
    }

    const form = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: this.login.refreshToken,
      client_id: this.login.clientId,
      resource: this.login.resource,
    });
    const answer = await exchange(
      session,
      {
        method: "POST",
        url: this.login.tokenEndpoint,
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: form.toString(),
      },
      // A lost answer is safe to repeat: Topped gives a refresh token a short retry window.
      "safe",
    );
    if (answer.status === 400 || answer.status === 401) {
      await store.removeLogin(session.baseUrl);
      throw signInAgain();
    }
    const tokens = readTokenResponse(answer.status, answer.json);
    if (tokens === null) {
      throw new NotReached("unexpected_response", `Topped's sign-in did not answer as expected (${answer.status}). Wait a moment`);
    }
    this.adopt({
      ...this.login,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: session.deps.now() + tokens.expiresInMs,
    });
    await store.setLogin(session.baseUrl, this.login);
  }

  private adopt(login: StoredLogin): void {
    this.login = login;
    this.session.redactor.add(login.accessToken);
    this.session.redactor.add(login.refreshToken);
  }
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresInMs: number;
}

/** A token endpoint's success body (RFC 6749 §5.1), or `null` when it isn't one. */
export function readTokenResponse(status: number, json: unknown): TokenPair | null {
  if (status !== 200 || !isRecord(json)) return null;
  const { access_token: access, refresh_token: refresh, expires_in: expiresIn, token_type: type } = json;
  if (typeof access !== "string" || typeof refresh !== "string" || access === "" || refresh === "") return null;
  if (typeof type === "string" && type.toLowerCase() !== "bearer") return null;
  const seconds = typeof expiresIn === "number" && expiresIn > 0 ? expiresIn : 3600;
  return { accessToken: access, refreshToken: refresh, expiresInMs: seconds * 1000 };
}

/** The credential for this address, or `null` when there is none. */
export async function resolveAuth(session: Session, store: ConfigStore): Promise<Auth | null> {
  const key = session.deps.env.TOPPED_API_KEY?.trim();
  if (key) {
    session.redactor.add(key);
    return new KeyAuth(key);
  }
  const login = await store.getLogin(session.baseUrl);
  return login === null ? null : new LoginAuth(session, store, login);
}
