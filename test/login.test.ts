import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer as createNetServer, connect, type AddressInfo } from "node:net";
import { join } from "node:path";

import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from "vitest";

import { configDir } from "../src/store.js";

import { clickAllow, clickAllowThenClose, FakeTopped } from "./fakeTopped.js";
import { Harness } from "./harness.js";

const fake = new FakeTopped();
const harness = new Harness(fake);

beforeAll(async () => {
  await fake.start();
});
afterAll(async () => {
  await fake.stop();
});
beforeEach(async () => {
  await harness.setUp();
  fake.authorizeOutcome = {};
  fake.refuseRefresh = false;
  fake.refuseCode = false;
  fake.codeDelayMs = 0;
  fake.advertisedOrigin = null;
  fake.accessTtlSeconds = 3600;
  fake.calls.length = 0;
  fake.registrations.length = 0;
  fake.tokenRequests.length = 0;
  fake.authorizeRequests.length = 0;
});
afterEach(async () => {
  await harness.tearDown();
});

/** A port nothing on this machine listens on right now. */
async function freePort(): Promise<number> {
  const probe = createNetServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

/** Send `raw` to the loopback listener the authorize link redirects to; resolves with what came back. */
function sendRaw(authorizeUrl: string, raw: string): Promise<string> {
  const redirect = new URL(new URL(authorizeUrl).searchParams.get("redirect_uri")!);
  return new Promise((resolve) => {
    let answer = "";
    const socket = connect(Number(redirect.port), "127.0.0.1", () => socket.write(raw));
    socket.on("data", (chunk) => {
      answer += chunk.toString("latin1");
    });
    socket.on("close", () => resolve(answer));
    socket.on("error", () => resolve(answer));
  });
}

async function storedLogin() {
  const file = JSON.parse(await readFile(harness.credentialsPath, "utf8"));
  return file.logins[fake.url];
}

describe("topped login", () => {
  it("discovers, registers, signs in with PKCE and keeps the tokens readable only by the founder", async () => {
    const opened: string[] = [];
    const result = await harness.run(["login"], {
      openBrowser: async (url) => {
        opened.push(url);
        await clickAllow(url);
      },
    });
    expect(result.code, result.stdout).toBe(0);
    expect(result.json).toMatchObject({ ok: true, signedIn: true, app: "Topped CLI", productName: "Nightowl", url: fake.url });

    // Registration: a public client named Topped CLI with a loopback redirect.
    expect(fake.registrations).toHaveLength(1);
    const registration = fake.registrations[0]!;
    expect(registration.client_name).toBe("Topped CLI");
    expect(registration.token_endpoint_auth_method).toBe("none");
    expect(registration.redirect_uris).toEqual([expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)]);

    // The authorize link: PKCE S256, a state, the resource - opened, and printed on stderr.
    const authorize = new URL(opened[0]!);
    expect(authorize.origin + authorize.pathname).toBe(`${fake.url}/oauth/authorize`);
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorize.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(authorize.searchParams.get("state")?.length).toBeGreaterThanOrEqual(16);
    expect(authorize.searchParams.get("resource")).toBe(fake.resource);
    expect(result.stderr).toContain(opened[0]!);

    // The code exchange carries the verifier and the resource.
    const exchange = fake.tokenRequests[0]!;
    expect(exchange.get("grant_type")).toBe("authorization_code");
    expect(exchange.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(exchange.get("resource")).toBe(fake.resource);

    const credentials = await stat(harness.credentialsPath);
    expect(credentials.mode & 0o777).toBe(0o600);
    const dir = await stat(`${harness.configHome}/topped`);
    expect(dir.mode & 0o777).toBe(0o700);
    const login = await storedLogin();
    expect(login.accessToken).toMatch(/^tpd_at_/);
    expect(login.refreshToken).toMatch(/^tpd_rt_/);
    expect(login.resource).toBe(fake.resource);
  });

  it("with --no-browser, prints the link on stderr and opens nothing", async () => {
    const result = await harness.run(["login", "--no-browser"], {
      openBrowser: () => {
        throw new Error("opened a browser");
      },
      onStderr: (text) => {
        const link = /(http:\/\/127\.0\.0\.1:\d+\/oauth\/authorize\S+)/.exec(text)?.[1];
        if (link) void clickAllow(link);
      },
    });
    expect(result.code, result.stdout).toBe(0);
    expect(result.json.signedIn).toBe(true);
  });

  it("registers afresh on every sign-in and keeps nothing but the credentials", async () => {
    await harness.login();
    await harness.run(["logout"]);
    await harness.login();
    expect(fake.registrations).toHaveLength(2);
    const [first, second] = fake.authorizeRequests;
    expect(second!.get("client_id")).not.toBe(first!.get("client_id"));
    expect(await readdir(join(harness.configHome, "topped"))).toEqual(["credentials.json"]);
  });

  it("signing in again over a stored sign-in names the older app left on Topped", async () => {
    const first = await harness.login();
    expect(first.code, first.stdout).toBe(0);
    expect(first.json.fix).toBeUndefined();
    const second = await harness.login();
    expect(second.code, second.stdout).toBe(0);
    expect(second.json.signedIn).toBe(true);
    expect(second.json.fix).toContain("replaced an earlier sign-in");
    expect(second.json.fix).toContain('"Topped CLI"');
    expect(second.json.fix).toContain("Settings > Connect your agent");
    await harness.run(["logout"]);
    expect((await harness.login()).json.fix).toBeUndefined();
  });

  it("signs in again after Topped forgot its registration, without waiting out the timeout", async () => {
    expect((await harness.login()).code).toBe(0);
    fake.forgetClients();
    const result = await harness.login({ loginTimeoutMs: 2_000 });
    expect(result.code, result.stdout).toBe(0);
    expect(result.json.signedIn).toBe(true);
    expect(fake.registrations).toHaveLength(2);
    expect((await harness.run(["balances"])).code).toBe(0);
  });

  it("refuses a callback whose state doesn't match, and keeps nothing", async () => {
    fake.authorizeOutcome = { state: "someone-elses-state" };
    const result = await harness.login();
    expect(result.code).toBe(3);
    expect(result.json).toEqual({ error: "state_mismatch", fix: expect.stringContaining("topped login") });
    expect(fake.tokenRequests).toHaveLength(0);
    await expect(stat(harness.credentialsPath)).rejects.toThrow();
  });

  it("refuses a callback from another issuer", async () => {
    fake.authorizeOutcome = { iss: "http://localhost:1" };
    const result = await harness.login();
    expect(result.code).toBe(3);
    expect(result.json.error).toBe("issuer_mismatch");
    expect(fake.tokenRequests).toHaveLength(0);
  });

  it("says so when the founder cancels in the browser", async () => {
    fake.authorizeOutcome = { decision: "deny" };
    const result = await harness.login();
    expect(result.code).toBe(3);
    expect(result.json).toEqual({ error: "access_denied", fix: expect.stringContaining("Allow") });
  });

  it("gives up after the wait and keeps nothing", async () => {
    const result = await harness.run(["login"], { openBrowser: () => {}, loginTimeoutMs: 200 });
    expect(result.code).toBe(3);
    expect(result.json.error).toBe("sign_in_timed_out");
    await expect(stat(join(harness.configHome, "topped"))).rejects.toThrow();
  });

  it("refuses metadata that names another server, and signs in nowhere", async () => {
    const other = await new FakeTopped().start();
    try {
      fake.advertisedOrigin = other.url;
      const result = await harness.login();
      expect(result.code).toBe(4);
      expect(result.json.error).toBe("sign_in_unavailable");
      expect(result.json.fix).toContain(other.url);
      expect(other.registrations).toHaveLength(0);
      expect(other.authorizeRequests).toHaveLength(0);
      expect(fake.registrations).toHaveLength(0);
      await expect(stat(harness.credentialsPath)).rejects.toThrow();
    } finally {
      await other.stop();
    }
  });

  it("the browser tab says signed in only once the code is exchanged", async () => {
    let page: Promise<string> = Promise.resolve("");
    const result = await harness.run(["login"], {
      openBrowser: (url) => {
        page = clickAllow(url);
      },
    });
    expect(result.code).toBe(0);
    expect(await page).toContain("Signed in to Topped");
  });

  it("when Topped refuses the code, the browser tab says the sign-in did not finish", async () => {
    fake.refuseCode = true;
    let page: Promise<string> = Promise.resolve("");
    const result = await harness.run(["login"], {
      openBrowser: (url) => {
        page = clickAllow(url);
      },
    });
    expect(result.code).toBe(3);
    expect(result.json.error).toBe("sign_in_refused");
    const text = await page;
    expect(text).toContain("did not finish");
    expect(text).not.toContain("Signed in");
    await expect(stat(harness.credentialsPath)).rejects.toThrow();
  });

  it.each([
    ["signs in", false, 0, "Signed in"],
    ["refuses the code", true, 3, "sign_in_refused"],
  ])(
    "prints its JSON and exits when the browser closes the tab before Topped %s",
    async (_what, refuse, code, marker) => {
      fake.codeDelayMs = 1000;
      fake.refuseCode = refuse;
      const result = await harness.run(["login"], { openBrowser: (url) => void clickAllowThenClose(url, 200) });
      expect(result.code, result.stdout).toBe(code);
      expect(JSON.stringify(result.json)).toContain(marker);
    },
    8000,
  );

  it("answers a malformed request to its listener with 400 and keeps waiting for the browser", async () => {
    let answer = "";
    const result = await harness.run(["login"], {
      openBrowser: async (url) => {
        answer = await sendRaw(url, "GET http://[ HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
        await clickAllow(url);
      },
    });
    expect(answer).toMatch(/^HTTP\/1\.1 400/);
    expect(result.code, result.stdout).toBe(0);
    expect(result.json.signedIn).toBe(true);
  });

  it("with --port, listens there, so an SSH tunnel to that port can carry the sign-in back", async () => {
    const port = await freePort();
    const result = await harness.run(["login", "--no-browser", "--port", String(port)], {
      onStderr: (text) => {
        const link = /(http:\/\/127\.0\.0\.1:\d+\/oauth\/authorize\S+)/.exec(text)?.[1];
        if (link) void clickAllow(link);
      },
    });
    expect(result.code, result.stdout).toBe(0);
    expect(fake.registrations[0]!.redirect_uris).toEqual([`http://127.0.0.1:${port}/callback`]);
    expect(result.stderr).toContain("127.0.0.1");
  });

  it("a --port already in use is exit 2, before anything is registered", async () => {
    const busy = createNetServer();
    await new Promise<void>((resolve) => busy.listen(0, "127.0.0.1", resolve));
    try {
      const port = (busy.address() as AddressInfo).port;
      const result = await harness.run(["login", "--port", String(port)], { openBrowser: () => {} });
      expect(result.code).toBe(2);
      expect(result.json.error).toBe("port_in_use");
      expect(result.json.fix).toContain(String(port));
      expect(fake.registrations).toHaveLength(0);
    } finally {
      await new Promise<void>((resolve) => busy.close(() => resolve()));
    }
  });

  it.each(["0", "65536", "80.5", "port"])("--port %s is exit 2", async (port) => {
    const result = await harness.run(["login", "--port", port], { openBrowser: () => {} });
    expect(result.code).toBe(2);
    expect(result.json.fix).toContain("--port");
    expect(fake.registrations).toHaveLength(0);
  });

  it("a config folder it cannot write names the file, and the tab says it did not finish", async () => {
    const blocked = join(harness.configHome, "blocked");
    await writeFile(blocked, "not a folder");
    let page: Promise<string> = Promise.resolve("");
    const result = await harness.run(["login"], {
      env: { XDG_CONFIG_HOME: blocked },
      openBrowser: (url) => {
        page = clickAllow(url);
      },
    });
    expect(result.code).toBe(1);
    expect(result.json.error).toBe("config_unwritable");
    expect(result.json.fix).toContain(join(blocked, "topped", "credentials.json"));
    expect(await page).toContain("did not finish");
  });

  it("warns on stderr when TOPPED_API_KEY will still win", async () => {
    const result = await harness.run(["login"], { env: { TOPPED_API_KEY: fake.apiKey } });
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("TOPPED_API_KEY is set");
  });
});

describe("a stored sign-in", () => {
  it("calls the REST door with the access token", async () => {
    await harness.login();
    const result = await harness.run(["balances"]);
    expect(result.code).toBe(0);
    const login = await storedLogin();
    expect(fake.calls[0]!.authorization).toBe(`Bearer ${login.accessToken}`);
  });

  it("refreshes before the hour runs out and stores the rotated refresh token", async () => {
    await harness.login();
    const before = await storedLogin();
    const later = before.expiresAt - 30_000;
    const result = await harness.run(["balances"], { now: () => later });
    expect(result.code).toBe(0);
    const after = await storedLogin();
    expect(after.refreshToken).not.toBe(before.refreshToken);
    expect(after.accessToken).not.toBe(before.accessToken);
    const refresh = fake.tokenRequests.at(-1)!;
    expect(refresh.get("grant_type")).toBe("refresh_token");
    expect(refresh.get("refresh_token")).toBe(before.refreshToken);
    expect(refresh.get("resource")).toBe(fake.resource);
    expect(fake.calls[0]!.authorization).toBe(`Bearer ${after.accessToken}`);
    expect((await stat(harness.credentialsPath)).mode & 0o777).toBe(0o600);
  });

  it("refreshes once on a 401 and repeats the call", async () => {
    await harness.login();
    fake.expireAccessTokens();
    const result = await harness.run(["balances"]);
    expect(result.code, result.stdout).toBe(0);
    // The refused call never reached the tool; the repeat did, with the new token.
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.authorization).toBe(`Bearer ${(await storedLogin()).accessToken}`);
    expect(fake.tokenRequests.filter((form) => form.get("grant_type") === "refresh_token")).toHaveLength(1);
  });

  it("refreshes only once: a second 401 is exit 3", async () => {
    await harness.login();
    fake.expireAccessTokens();
    fake.accessTtlSeconds = 0; // the refreshed token is refused too
    const result = await harness.run(["balances"]);
    expect(result.code).toBe(3);
    expect(result.json.error).toBe("signed_out");
    expect(fake.tokenRequests.filter((form) => form.get("grant_type") === "refresh_token")).toHaveLength(1);
    expect(fake.calls).toHaveLength(0);
  });

  it("a refused refresh means signing in again: exit 3, and the stored sign-in is gone", async () => {
    await harness.login();
    fake.expireAccessTokens();
    fake.refuseRefresh = true;
    const result = await harness.run(["balances"]);
    expect(result.code).toBe(3);
    expect(result.json).toEqual({ error: "signed_out", fix: expect.stringContaining("topped login") });
    await expect(stat(harness.credentialsPath)).rejects.toThrow();
  });

  it("a revoked app is exit 3", async () => {
    await harness.login();
    fake.revokeEverything();
    const result = await harness.run(["balances"]);
    expect(result.code).toBe(3);
  });

  it("uses a sign-in another topped process just refreshed instead of refreshing again", async () => {
    await harness.login();
    const first = await storedLogin();
    // Another process refreshed: its pair is on disk.
    await harness.run(["balances"], { now: () => first.expiresAt - 30_000 });
    const second = await storedLogin();
    const file = JSON.parse(await readFile(harness.credentialsPath, "utf8"));
    file.logins[fake.url] = second;
    await writeFile(harness.credentialsPath, JSON.stringify(file), { mode: 0o600 });
    const refreshes = fake.tokenRequests.length;
    const result = await harness.run(["balances"]);
    expect(result.code).toBe(0);
    expect(fake.tokenRequests.length).toBe(refreshes);
  });
});

describe("topped logout and whoami", () => {
  it("logout forgets the sign-in; the file goes and commands exit 3", async () => {
    await harness.login();
    const result = await harness.run(["logout"]);
    expect(result.code).toBe(0);
    expect(result.json).toMatchObject({ ok: true, signedOut: true });
    expect(result.json.fix).toContain("Settings > Connect your agent");
    await expect(stat(harness.credentialsPath)).rejects.toThrow();
    const after = await harness.run(["balances"]);
    expect(after.code).toBe(3);
    expect(after.json.fix).toContain("topped login");
  });

  it("whoami names the signed-in app and where the credential came from", async () => {
    await harness.login();
    const result = await harness.run(["whoami"]);
    expect(result.json).toMatchObject({ ok: true, keyName: "Topped CLI", productName: "Nightowl", source: "topped login" });
  });
});

describe("TOPPED_API_KEY", () => {
  it("wins over a stored sign-in", async () => {
    await harness.login();
    const result = await harness.run(["whoami"], { env: { TOPPED_API_KEY: fake.apiKey } });
    expect(result.json).toMatchObject({ keyName: "Laptop key", source: "TOPPED_API_KEY" });
    await harness.run(["balances"], { env: { TOPPED_API_KEY: fake.apiKey } });
    expect(fake.calls.at(-1)!.authorization).toBe(`Bearer ${fake.apiKey}`);
  });

  it("works with no stored sign-in", async () => {
    const result = await harness.run(["whoami"], { env: { TOPPED_API_KEY: fake.apiKey } });
    expect(result.code).toBe(0);
    expect(result.json.productName).toBe("Nightowl");
  });

  it("a refused key is exit 3 and never refreshes", async () => {
    const result = await harness.run(["balances"], { env: { TOPPED_API_KEY: `tpd_live_${"x".repeat(32)}` } });
    expect(result.code).toBe(3);
    expect(result.json).toEqual({ error: "invalid_api_key", fix: expect.stringContaining("TOPPED_API_KEY") });
    expect(fake.tokenRequests).toHaveLength(0);
  });
});

describe("where the sign-in is kept", () => {
  it("in $XDG_CONFIG_HOME/topped, or ~/.config/topped", () => {
    expect(configDir({ XDG_CONFIG_HOME: "/xdg", HOME: "/h" })).toBe(join("/xdg", "topped"));
    expect(configDir({ HOME: "/h" })).toBe(join("/h", ".config", "topped"));
  });

  it("never under the current folder: a relative XDG_CONFIG_HOME is ignored, as the XDG spec says", () => {
    expect(configDir({ XDG_CONFIG_HOME: "cfg", HOME: "/h" })).toBe(join("/h", ".config", "topped"));
    expect(configDir({ XDG_CONFIG_HOME: "./cfg", HOME: "/h" })).toBe(join("/h", ".config", "topped"));
  });
});
