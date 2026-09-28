/**
 * `topped login` - "Log in with Topped" from a terminal: the same OAuth 2.1
 * flow a chat app's connector runs, so the founder never copies a key.
 *
 * 1. Discovery from `<base>/api/mcp`: its 401 names the protected-resource
 *    metadata (RFC 9728), which names the authorization server, whose
 *    metadata (RFC 8414) has the endpoints.
 * 2. Dynamic client registration (RFC 7591) on every sign-in, as a public
 *    client with a loopback redirect. No client id is kept for next time:
 *    Topped deletes a registration with no sign-in behind it (an abandoned
 *    one, a deleted account, a reset local server), and a dead client id
 *    would leave the next sign-in on an error page. Each sign-in is its own
 *    app on Topped anyway.
 * 3. PKCE S256 with a `state` and the `resource`; the browser opens and the
 *    URL is also printed on stderr. The browser must run on this machine:
 *    the sign-in comes back to 127.0.0.1. From another machine, `--port`
 *    fixes the port so an SSH tunnel (`ssh -L <n>:127.0.0.1:<n>`) can carry
 *    it back.
 * 4. A one-shot local listener checks `state` and `iss`, the code is
 *    exchanged, and the tokens are stored, mode 0600. Only then does the
 *    browser tab say how it went.
 */

import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { readTokenResponse } from "./auth.js";
import { exchange, isRecord, isSafeUrl, type Session } from "./http.js";
import { CliError, EXIT, usageError } from "./output.js";
import type { ConfigStore, StoredLogin } from "./store.js";

export const CLIENT_NAME = "Topped CLI";
const CALLBACK_PATH = "/callback";
const MCP_PATH = "/api/mcp";
/**
 * How long the browser tab's answer may take to go out. A tab the founder
 * already closed never finishes taking it, and the sign-in must not wait on it.
 */
const TAB_ANSWER_MS = 2_000;

interface Discovery {
  resource: string;
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string;
}

function discoveryFailed(session: Session, what: string): CliError {
  return new CliError(
    EXIT.unreachable,
    "sign_in_unavailable",
    `Could not start signing in to Topped at ${session.baseUrl}: ${what}. Wait a moment and run topped login again.`,
  );
}

async function getJson(session: Session, url: string): Promise<Record<string, unknown> | null> {
  const answer = await exchange(session, { method: "GET", url, headers: { accept: "application/json" } }, "safe");
  return answer.status === 200 && isRecord(answer.json) ? answer.json : null;
}

/** `resource_metadata="…"` from a `WWW-Authenticate: Bearer …` challenge. */
export function resourceMetadataFromChallenge(header: string | null): string | null {
  if (header === null) return null;
  const match = /resource_metadata="([^"]+)"/i.exec(header);
  return match?.[1] ?? null;
}

async function discover(session: Session): Promise<Discovery> {
  const challenge = await exchange(
    session,
    { method: "GET", url: `${session.baseUrl}${MCP_PATH}`, headers: { accept: "application/json" } },
    "safe",
  );
  const named = resourceMetadataFromChallenge(challenge.headers.get("www-authenticate"));
  const metadataUrl = named ?? `${session.baseUrl}/.well-known/oauth-protected-resource${MCP_PATH}`;
  if (!isSafeUrl(metadataUrl)) throw discoveryFailed(session, "its resource metadata address is not https");

  const resourceMetadata = await getJson(session, metadataUrl);
  const resource = resourceMetadata?.resource;
  const servers = resourceMetadata?.authorization_servers;
  const authorizationServer = Array.isArray(servers) ? servers[0] : undefined;
  if (typeof resource !== "string" || typeof authorizationServer !== "string" || !isSafeUrl(authorizationServer)) {
    throw discoveryFailed(session, "its resource metadata is missing");
  }
  // RFC 9728 §3.3: the metadata must be about the resource asked for, and
  // Topped signs in at its own address. Anything else would send the founder
  // to another server's consent page and keep its tokens under this address.
  const expected = `${session.baseUrl}${MCP_PATH}`;
  const namesItself = resource.replace(/\/+$/, "") === expected && new URL(authorizationServer).origin === session.baseUrl;
  if (!namesItself) {
    throw new CliError(
      EXIT.unreachable,
      "sign_in_unavailable",
      `Topped at ${session.baseUrl} says it signs in for ${resource} at ${authorizationServer}, not at ${session.baseUrl}. Point TOPPED_URL at the address that server answers as, then run topped login again.`,
    );
  }

  const issuerUrl = authorizationServer.replace(/\/+$/, "");
  const metadata = await getJson(session, `${issuerUrl}/.well-known/oauth-authorization-server`);
  if (metadata === null) throw discoveryFailed(session, "its sign-in metadata is missing");
  const issuer = metadata.issuer;
  const authorizationEndpoint = metadata.authorization_endpoint;
  const tokenEndpoint = metadata.token_endpoint;
  const registrationEndpoint = metadata.registration_endpoint;
  const methods = metadata.code_challenge_methods_supported;
  if (
    typeof issuer !== "string" ||
    issuer.replace(/\/+$/, "") !== issuerUrl ||
    typeof authorizationEndpoint !== "string" ||
    typeof tokenEndpoint !== "string" ||
    typeof registrationEndpoint !== "string" ||
    ![authorizationEndpoint, tokenEndpoint, registrationEndpoint].every(isSafeUrl) ||
    !(Array.isArray(methods) && methods.includes("S256"))
  ) {
    throw discoveryFailed(session, "its sign-in metadata is not what the CLI expects");
  }
  return { resource, issuer, authorizationEndpoint, tokenEndpoint, registrationEndpoint };
}

async function register(session: Session, discovery: Discovery, redirectUri: string): Promise<string> {
  const answer = await exchange(
    session,
    {
      method: "POST",
      url: discovery.registrationEndpoint,
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        client_name: CLIENT_NAME,
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    },
    "once",
  );
  const clientId = isRecord(answer.json) ? answer.json.client_id : undefined;
  if ((answer.status !== 200 && answer.status !== 201) || typeof clientId !== "string" || clientId === "") {
    const why = isRecord(answer.json) && typeof answer.json.error_description === "string" ? answer.json.error_description : `it answered ${answer.status}`;
    throw new CliError(EXIT.refused, "registration_refused", `Topped did not register this CLI (${why}). Wait a moment and run topped login again.`);
  }
  return clientId;
}

function base64url(bytes: Buffer): string {
  return bytes.toString("base64url");
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  return { verifier, challenge: createHash("sha256").update(verifier, "ascii").digest("base64url") };
}

/** The browser came back with a code; its tab waits for {@link Callback.answer}. */
interface Callback {
  code: string;
  /** Tell the browser tab how the sign-in ended. */
  answer(signedIn: boolean): Promise<void>;
}

const PAGE = (title: string, line: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem"><h1 style="font-size:1.25rem">${title}</h1><p>${line}</p></body>`;

/** Answer the tab; settles once the page is out, the tab has gone, or {@link TAB_ANSWER_MS} has passed. */
function respond(response: ServerResponse, signedIn: boolean): Promise<void> {
  const page = signedIn
    ? PAGE("Signed in to Topped", "You can close this tab and go back to your terminal.")
    : PAGE("Sign-in did not finish", "Go back to your terminal to see why.");
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, TAB_ANSWER_MS);
    response.once("close", done);
    if (response.destroyed || response.socket === null || response.socket.destroyed) {
      done();
      return;
    }
    response.writeHead(signedIn ? 200 : 400, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(page, done);
  });
}

function waited(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes >= 1) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const seconds = Math.max(1, Math.round(ms / 1000));
  return `${seconds} second${seconds === 1 ? "" : "s"}`;
}

/** The loopback listener, on `port` when the founder named one, else on any free port. */
function listen(port: number | undefined): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (port === undefined) {
        reject(error);
        return;
      }
      reject(
        usageError(
          `topped login could not listen on 127.0.0.1:${port}${error.code ? ` (${error.code})` : ""}. Pick another --port, or leave it out.`,
          error.code === "EADDRINUSE" ? "port_in_use" : "port_unavailable",
        ),
      );
    });
    server.listen(port ?? 0, "127.0.0.1", () => resolve(server));
  });
}

/** The callback URL a request asked for, or `null` when its target is not one. */
function requestedUrl(request: IncomingMessage): URL | null {
  try {
    return new URL(request.url ?? "/", "http://127.0.0.1");
  } catch {
    return null;
  }
}

/**
 * Wait for the one browser redirect back to the loopback listener. Whatever
 * it carries decides the sign-in; any other request gets a 404 (a 400 when
 * its target is not even a URL). A refusal is answered at once; a code's tab
 * waits until the code has been exchanged.
 */
function waitForCallback(
  server: Server,
  expected: { state: string; issuer: string },
  timeoutMs: number,
): Promise<Callback> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      reject(
        new CliError(
          EXIT.auth,
          "sign_in_timed_out",
          `Nobody finished signing in within ${waited(timeoutMs)}. Run topped login again and click Allow in the browser.`,
        ),
      );
    }, timeoutMs);
    timer.unref?.();

    server.on("request", (request: IncomingMessage, response: ServerResponse) => {
      const url = requestedUrl(request);
      if (url === null) {
        response.writeHead(400).end();
        return;
      }
      if (settled || request.method !== "GET" || url.pathname !== CALLBACK_PATH) {
        response.writeHead(404).end();
        return;
      }
      settled = true;
      clearTimeout(timer);
      const params = url.searchParams;
      const fail = (error: string, fix: string) => {
        void respond(response, false);
        reject(new CliError(EXIT.auth, error, fix));
      };

      if (params.get("state") !== expected.state) {
        fail("state_mismatch", "The browser came back from a different sign-in. Run topped login again.");
        return;
      }
      if (params.get("iss") !== expected.issuer) {
        fail("issuer_mismatch", "The sign-in came back from a server other than the one it started with. Run topped login again.");
        return;
      }
      const error = params.get("error");
      if (error !== null) {
        fail(
          error === "access_denied" ? "access_denied" : "sign_in_refused",
          error === "access_denied"
            ? "The sign-in was cancelled in the browser. Run topped login again and click Allow."
            : "Topped did not finish the sign-in. Run topped login again.",
        );
        return;
      }
      const code = params.get("code");
      if (!code) {
        fail("sign_in_refused", "The browser came back without a sign-in code. Run topped login again.");
        return;
      }
      resolve({ code, answer: (signedIn) => respond(response, signedIn) });
    });
  });
}

function openInBrowser(session: Session, url: string): void {
  // Not awaited: the browser comes back through the listener, whenever it does.
  try {
    void Promise.resolve(session.deps.openBrowser(url)).catch(() => {});
  } catch {
    // The URL is on stderr.
  }
}

export interface LoginOptions {
  openBrowser: boolean;
  /** The loopback port to listen on; any free one when absent. */
  port?: number;
}

export async function runLogin(session: Session, store: ConfigStore, options: LoginOptions): Promise<void> {
  const discovery = await discover(session);
  const server = await listen(options.port);
  try {
    const port = (server.address() as AddressInfo).port;
    const redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`;

    const clientId = await register(session, discovery, redirectUri);

    const { verifier, challenge } = pkcePair();
    const state = base64url(randomBytes(24));
    const authorize = new URL(discovery.authorizationEndpoint);
    for (const [name, value] of Object.entries({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
      resource: discovery.resource,
    })) {
      authorize.searchParams.set(name, value);
    }

    const waiting = waitForCallback(server, { state, issuer: discovery.issuer }, session.deps.loginTimeoutMs);
    // The browser may come back before the link is even printed; the outcome is read below.
    waiting.catch(() => {});
    // The sign-in comes back to 127.0.0.1 here, so the browser must run on
    // this machine, or reach this port through a tunnel.
    session.hint(
      options.openBrowser
        ? `Opening your browser to sign in to Topped. If it doesn't open, visit this link in a browser on this machine:\n${authorize.toString()}`
        : `Open this link in a browser on this machine, signed in to Topped, then click Allow. It comes back to 127.0.0.1:${port}, so from another machine forward that port first (ssh -L ${port}:127.0.0.1:${port}):\n${authorize.toString()}`,
    );
    if (options.openBrowser) openInBrowser(session, authorize.toString());

    const callback = await waiting;
    let signedIn = false;
    try {
      await exchangeCode(session, store, discovery, { clientId, redirectUri, verifier, code: callback.code });
      signedIn = true;
    } finally {
      await callback.answer(signedIn);
    }
  } finally {
    server.close();
    server.closeAllConnections?.();
  }
}

/** Trade the code for the tokens and keep them. */
async function exchangeCode(
  session: Session,
  store: ConfigStore,
  discovery: Discovery,
  grant: { clientId: string; redirectUri: string; verifier: string; code: string },
): Promise<void> {
  const answer = await exchange(
    session,
    {
      method: "POST",
      url: discovery.tokenEndpoint,
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: grant.code,
        code_verifier: grant.verifier,
        redirect_uri: grant.redirectUri,
        client_id: grant.clientId,
        resource: discovery.resource,
      }).toString(),
    },
    "once",
  );
  const tokens = readTokenResponse(answer.status, answer.json);
  if (tokens === null) {
    throw new CliError(EXIT.auth, "sign_in_refused", "Topped did not accept the sign-in code. Run topped login again.");
  }
  session.redactor.add(tokens.accessToken);
  session.redactor.add(tokens.refreshToken);

  const login: StoredLogin = {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: session.deps.now() + tokens.expiresInMs,
    clientId: grant.clientId,
    tokenEndpoint: discovery.tokenEndpoint,
    issuer: discovery.issuer,
    resource: discovery.resource,
  };
  await store.setLogin(session.baseUrl, login);
}
