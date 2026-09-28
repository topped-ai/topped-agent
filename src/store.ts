/**
 * What `topped login` keeps on this machine: `credentials.json`, the
 * signed-in tokens per Topped address (secret: mode 0600), in
 * `$XDG_CONFIG_HOME/topped/` (default `~/.config/topped/`), a directory only
 * its owner can open (0700).
 */

import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

import { CliError, EXIT } from "./output.js";

export interface StoredLogin {
  accessToken: string;
  refreshToken: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  clientId: string;
  tokenEndpoint: string;
  issuer: string;
  resource: string;
}

interface CredentialsFile {
  version: 1;
  logins: Record<string, StoredLogin>;
}

/**
 * `$XDG_CONFIG_HOME/topped`, else `~/.config/topped`. A relative
 * XDG_CONFIG_HOME is ignored, as the XDG Base Directory spec says, so tokens
 * never land under the current folder (a repository, say).
 */
export function configDir(env: Record<string, string | undefined>): string {
  const xdg = env.XDG_CONFIG_HOME?.trim();
  const base = xdg && isAbsolute(xdg) ? xdg : join(env.HOME?.trim() || homedir(), ".config");
  return join(base, "topped");
}

export class ConfigStore {
  readonly dir: string;
  readonly credentialsPath: string;

  constructor(env: Record<string, string | undefined>) {
    this.dir = configDir(env);
    this.credentialsPath = join(this.dir, "credentials.json");
  }

  async getLogin(baseUrl: string): Promise<StoredLogin | null> {
    const file = await this.readCredentials();
    return file.logins[baseUrl] ?? null;
  }

  async setLogin(baseUrl: string, login: StoredLogin): Promise<void> {
    const file = await this.readCredentials();
    file.logins[baseUrl] = login;
    await this.writeSecret(this.credentialsPath, file);
  }

  /** Forget this address's sign-in; the file goes when nothing is left in it. Says whether there was one. */
  async removeLogin(baseUrl: string): Promise<boolean> {
    const file = await this.readCredentials();
    const had = baseUrl in file.logins;
    delete file.logins[baseUrl];
    if (Object.keys(file.logins).length === 0) {
      await this.writing(this.credentialsPath, () => rm(this.credentialsPath, { force: true }));
    } else {
      await this.writeSecret(this.credentialsPath, file);
    }
    return had;
  }

  private async readCredentials(): Promise<CredentialsFile> {
    const file = await readJson<CredentialsFile>(this.credentialsPath);
    return { version: 1, logins: { ...(file?.logins ?? {}) } };
  }

  /** Written whole to a temporary file readable only by its owner, then moved into place. */
  private async writeSecret(path: string, value: unknown): Promise<void> {
    await this.writing(path, async () => {
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      await chmod(this.dir, 0o700);
      const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
      await chmod(temporary, 0o600);
      await rename(temporary, path);
    });
  }

  /** A change to a file here, failing with a fix that names the file. */
  private async writing(path: string, change: () => Promise<void>): Promise<void> {
    try {
      await change();
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      throw new CliError(
        EXIT.refused,
        "config_unwritable",
        `topped could not write ${path}${typeof code === "string" ? ` (${code})` : ""}. Make ${this.dir} a folder you can write to, or set XDG_CONFIG_HOME to one.`,
      );
    }
  }
}

async function readJson<T>(path: string): Promise<T | null> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" ? (parsed as T) : null;
  } catch {
    return null;
  }
}
