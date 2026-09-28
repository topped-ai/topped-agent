/**
 * A local stand-in for Topped: the REST door, "Log in with Topped" (discovery,
 * registration, authorize, token) and a signed-upload target, on 127.0.0.1.
 * Tests never reach a real Topped. Secrets are made fresh per server, so none
 * is written in this repository.
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

const FIXTURE = JSON.parse(readFileSync(new URL("./fixtures/tools.json", import.meta.url), "utf8")) as {
  tools: { name: string; annotations: { readOnlyHint: boolean }; inputSchema: { properties: Record<string, unknown>; required?: string[] } }[];
};

export const TOOL_LISTING = FIXTURE;

function secret(prefix: string): string {
  const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  const bytes = randomBytes(32);
  return prefix + Array.from(bytes, (b) => alphabet[b % 62]).join("");
}

export interface ToolCall {
  name: string;
  input: Record<string, unknown>;
  authorization: string | null;
}

export interface Answer {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  /** Send this text instead of JSON. */
  raw?: string;
}

type ToolHandler = (input: Record<string, unknown>, call: ToolCall) => Answer | unknown;

interface Client {
  clientId: string;
  clientName: string | undefined;
  redirectUris: string[];
}

interface Code {
  clientId: string;
  redirectUri: string;
  challenge: string;
  resource: string;
}

export interface AuthorizeOutcome {
  /** What the founder clicks. */
  decision?: "allow" | "deny";
  /** Replace what comes back to the CLI. */
  state?: string;
  iss?: string;
}

export class FakeTopped {
  readonly apiKey = secret("tpd_live_");
  url = "";
  readonly calls: ToolCall[] = [];
  readonly puts: { path: string; headers: IncomingMessage["headers"]; bytes: Buffer }[] = [];
  readonly registrations: Record<string, unknown>[] = [];
  readonly authorizeRequests: URLSearchParams[] = [];
  readonly tokenRequests: URLSearchParams[] = [];
  readonly clients = new Map<string, Client>();
  readonly handlers = new Map<string, ToolHandler>();
  /** Answers the tool door gives before any handler runs, one per request. */
  readonly failures: Answer[] = [];
  /** Every secret this server has handed out. */
  readonly secrets: string[] = [this.apiKey];
  authorizeOutcome: AuthorizeOutcome = {};
  refuseRefresh = false;
  /** Refuse every sign-in code at the token endpoint. */
  refuseCode = false;
  /** Take this long to answer a sign-in code, like a slow token endpoint. */
  codeDelayMs = 0;
  /** Name this origin in the sign-in metadata instead of the server's own, like a server configured for another address. */
  advertisedOrigin: string | null = null;
  accessTtlSeconds = 3600;
  whoamiProduct: string | null = "Nightowl";

  private readonly codes = new Map<string, Code>();
  private readonly access = new Map<string, { clientId: string; expiresAt: number }>();
  private readonly refresh = new Map<string, string>();
  private readonly requestResults = new Map<string, unknown>();
  private server: Server | null = null;

  async start(): Promise<this> {
    this.server = createServer((request, response) => {
      void this.handle(request, response).catch((error: unknown) => {
        response.writeHead(500, { "content-type": "text/plain" });
        response.end(String(error));
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) => this.server?.close(() => resolve()) ?? resolve());
  }

  get resource(): string {
    return `${this.origin}/api/mcp`;
  }

  /** The address the sign-in metadata names. */
  get origin(): string {
    return this.advertisedOrigin ?? this.url;
  }

  /** Make every access token handed out so far stop working, as if it expired. */
  expireAccessTokens(): void {
    for (const token of this.access.keys()) this.access.get(token)!.expiresAt = 0;
  }

  /**
   * Forget every registration and every sign-in made through one, as Topped
   * does after an account is deleted or a local server is reset. Its consent
   * page then refuses the old client ids and never comes back.
   */
  forgetClients(): void {
    this.clients.clear();
    this.codes.clear();
    this.revokeEverything();
  }

  /** Revoke the app: every token stops working, refresh included. */
  revokeEverything(): void {
    this.access.clear();
    this.refresh.clear();
  }

  on(tool: string, handler: ToolHandler): void {
    this.handlers.set(tool, handler);
  }

  toolCalls(name: string): ToolCall[] {
    return this.calls.filter((call) => call.name === name);
  }

  private json(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
    response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
    response.end(JSON.stringify(body));
  }

  private async body(request: IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks);
  }

  private authorized(request: IncomingMessage): boolean {
    const header = request.headers.authorization ?? "";
    const match = /^Bearer (.+)$/.exec(header);
    if (!match) return false;
    const token = match[1]!;
    if (token === this.apiKey) return true;
    const access = this.access.get(token);
    return access !== undefined && access.expiresAt > Date.now();
  }

  private refuse401(response: ServerResponse, request: IncomingMessage): void {
    const metadata = `resource_metadata="${this.url}/.well-known/oauth-protected-resource/api/mcp"`;
    const missing = !request.headers.authorization;
    this.json(
      response,
      401,
      missing
        ? { error: "missing_api_key", fix: "Send your Topped key as the header Authorization: Bearer." }
        : { error: "invalid_api_key", fix: "This key or sign-in is wrong, expired or was revoked." },
      { "www-authenticate": missing ? `Bearer ${metadata}` : `Bearer error="invalid_token", ${metadata}` },
    );
  }

  private issuePair(clientId: string): Record<string, unknown> {
    const access = secret("tpd_at_");
    const refresh = secret("tpd_rt_");
    this.secrets.push(access, refresh);
    this.access.set(access, { clientId, expiresAt: Date.now() + this.accessTtlSeconds * 1000 });
    this.refresh.set(refresh, clientId);
    return { access_token: access, token_type: "Bearer", expires_in: this.accessTtlSeconds, refresh_token: refresh };
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", this.url);
    const path = url.pathname;

    if (path === "/api/mcp") return this.refuse401(response, request);
    if (path === "/.well-known/oauth-protected-resource/api/mcp") {
      return this.json(response, 200, { resource: this.resource, authorization_servers: [this.origin], bearer_methods_supported: ["header"] });
    }
    if (path === "/.well-known/oauth-authorization-server") {
      return this.json(response, 200, {
        issuer: this.origin,
        authorization_endpoint: `${this.url}/oauth/authorize`,
        token_endpoint: `${this.url}/api/oauth/token`,
        registration_endpoint: `${this.url}/api/oauth/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
        authorization_response_iss_parameter_supported: true,
      });
    }
    if (path === "/api/oauth/register" && request.method === "POST") {
      const metadata = JSON.parse((await this.body(request)).toString("utf8")) as Record<string, unknown>;
      this.registrations.push(metadata);
      const uris = metadata.redirect_uris as string[];
      if (!Array.isArray(uris) || !uris.every((uri) => /^http:\/\/127\.0\.0\.1:\d+\/callback$/.test(uri))) {
        return this.json(response, 400, { error: "invalid_redirect_uri", error_description: "loopback only" });
      }
      const clientId = randomUUID();
      this.clients.set(clientId, { clientId, clientName: metadata.client_name as string | undefined, redirectUris: uris });
      return this.json(response, 201, { client_id: clientId, redirect_uris: uris, token_endpoint_auth_method: "none" });
    }
    if (path === "/oauth/authorize" && request.method === "GET") {
      const params = url.searchParams;
      this.authorizeRequests.push(params);
      const client = this.clients.get(params.get("client_id") ?? "");
      const redirect = params.get("redirect_uri") ?? "";
      const sameExceptPort = (a: string, b: string) => {
        const x = new URL(a);
        const y = new URL(b);
        return x.hostname === y.hostname && x.pathname === y.pathname && x.protocol === y.protocol;
      };
      if (
        !client ||
        !client.redirectUris.some((uri) => sameExceptPort(uri, redirect)) ||
        params.get("response_type") !== "code" ||
        params.get("code_challenge_method") !== "S256" ||
        !/^[A-Za-z0-9_-]{43}$/.test(params.get("code_challenge") ?? "") ||
        params.get("resource") !== this.resource
      ) {
        response.writeHead(400, { "content-type": "text/html" });
        return void response.end("<p>This sign-in link isn't valid.</p>");
      }
      const back = new URL(redirect);
      const outcome = this.authorizeOutcome;
      if (outcome.decision === "deny") {
        back.searchParams.set("error", "access_denied");
      } else {
        const code = randomBytes(24).toString("base64url");
        this.codes.set(code, {
          clientId: client.clientId,
          redirectUri: redirect,
          challenge: params.get("code_challenge")!,
          resource: this.resource,
        });
        back.searchParams.set("code", code);
      }
      back.searchParams.set("state", outcome.state ?? params.get("state") ?? "");
      back.searchParams.set("iss", outcome.iss ?? this.url);
      response.writeHead(302, { location: back.toString() });
      return void response.end();
    }
    if (path === "/api/oauth/token" && request.method === "POST") {
      const form = new URLSearchParams((await this.body(request)).toString("utf8"));
      this.tokenRequests.push(form);
      const clientId = form.get("client_id") ?? "";
      // As Topped does: invalid_client only for a client_id that is not even
      // a registration's shape; a client it no longer knows has no code or
      // refresh token to match, so that is invalid_grant below.
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clientId)) {
        return this.json(response, 400, { error: "invalid_client", error_description: "client_id is not a registered client." });
      }
      if (form.get("resource") !== null && form.get("resource") !== this.resource) {
        return this.json(response, 400, { error: "invalid_target", error_description: "wrong resource" });
      }
      if (form.get("grant_type") === "authorization_code") {
        if (this.codeDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.codeDelayMs));
        if (this.refuseCode) return this.json(response, 400, { error: "invalid_grant", error_description: "bad code" });
        const code = this.codes.get(form.get("code") ?? "");
        const verifier = form.get("code_verifier") ?? "";
        const challenge = createHash("sha256").update(verifier, "ascii").digest("base64url");
        if (!code || code.clientId !== clientId || code.redirectUri !== form.get("redirect_uri") || code.challenge !== challenge) {
          return this.json(response, 400, { error: "invalid_grant", error_description: "bad code" });
        }
        this.codes.delete(form.get("code")!);
        return this.json(response, 200, this.issuePair(clientId));
      }
      if (form.get("grant_type") === "refresh_token") {
        const token = form.get("refresh_token") ?? "";
        if (this.refuseRefresh || this.refresh.get(token) !== clientId) {
          return this.json(response, 400, { error: "invalid_grant", error_description: "revoked" });
        }
        this.refresh.delete(token);
        return this.json(response, 200, this.issuePair(clientId));
      }
      return this.json(response, 400, { error: "unsupported_grant_type", error_description: "no" });
    }
    if (path.startsWith("/storage/") && request.method === "PUT") {
      this.puts.push({ path, headers: request.headers, bytes: await this.body(request) });
      response.writeHead(200);
      return void response.end();
    }

    if (path.startsWith("/api/v1/")) {
      if (!this.authorized(request)) return this.refuse401(response, request);
      if (path === "/api/v1/tools" && request.method === "GET") return this.json(response, 200, TOOL_LISTING);
      if (path === "/api/v1/whoami" && request.method === "GET") {
        const header = request.headers.authorization ?? "";
        const isKey = header === `Bearer ${this.apiKey}`;
        const clientId = isKey ? null : this.access.get(header.slice(7))?.clientId;
        const keyName = isKey ? "Laptop key" : (this.clients.get(clientId ?? "")?.clientName ?? "127.0.0.1");
        return this.json(response, 200, { ok: true, keyName, productName: this.whoamiProduct });
      }
      const match = /^\/api\/v1\/tools\/([^/]+)$/.exec(path);
      if (match && request.method === "POST") {
        const name = decodeURIComponent(match[1]!);
        const text = (await this.body(request)).toString("utf8");
        const input = text.trim() === "" ? {} : (JSON.parse(text) as Record<string, unknown>);
        const call: ToolCall = { name, input, authorization: request.headers.authorization ?? null };
        this.calls.push(call);
        const failure = this.failures.shift();
        if (failure) {
          if (failure.raw !== undefined) {
            response.writeHead(failure.status, { "content-type": "text/html", ...failure.headers });
            return void response.end(failure.raw);
          }
          return this.json(response, failure.status, failure.body ?? { error: "unavailable", fix: "Retry in a few seconds." }, failure.headers);
        }
        if (!TOOL_LISTING.tools.some((tool) => tool.name === name) && !this.handlers.has(name)) {
          return this.json(response, 404, { error: "unknown_tool", fix: `There is no Topped tool named "${name}".` });
        }
        const requestId = typeof input.requestId === "string" ? input.requestId : null;
        const key = requestId === null ? null : `${name}:${requestId}`;
        if (key !== null && this.requestResults.has(key)) return this.json(response, 200, this.requestResults.get(key));
        const handler = this.handlers.get(name);
        const outcome = handler ? handler(input, call) : { ok: true, tool: name };
        const answer: Answer =
          outcome !== null && typeof outcome === "object" && "status" in outcome && typeof (outcome as Answer).status === "number"
            ? (outcome as Answer)
            : { status: 200, body: outcome };
        if (answer.status === 200 && key !== null) this.requestResults.set(key, answer.body);
        return this.json(response, answer.status, answer.body, answer.headers);
      }
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not_found", fix: "No such route." }));
  }
}

/**
 * What the founder's browser does: follow the authorize link, then the
 * redirect back to the CLI. Returns the page the tab ends on.
 */
export async function clickAllow(authorizeUrl: string): Promise<string> {
  const first = await fetch(authorizeUrl, { redirect: "manual" });
  const location = first.headers.get("location");
  if (!location) return first.text();
  return fetch(location).then((response) => response.text());
}

/**
 * A browser that follows the authorize link, then gives up on the redirect
 * back after `ms` (the founder closed the tab), dropping its connection.
 */
export async function clickAllowThenClose(authorizeUrl: string, ms: number): Promise<void> {
  const first = await fetch(authorizeUrl, { redirect: "manual" });
  const location = first.headers.get("location");
  if (!location) return;
  await fetch(location, { signal: AbortSignal.timeout(ms) }).then(
    (response) => response.text(),
    () => "",
  );
}
