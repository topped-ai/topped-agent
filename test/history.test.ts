/**
 * The pre-push history check: text a later commit removed is still in `git
 * log -p`, so the tree tests alone would let it reach a public repository.
 * Writes only in a temporary repository, with none of the caller's GIT_*
 * variables and no global or system config; of this repository it only reads
 * the list of tracked files.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { identitiesInHistory, privateLinesInHistory, privateLinesInTree } from "../scripts/check-history.mjs";

let repo = "";

const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));

function git(...args: string[]): void {
  const env = cleanEnv();
  execFileSync(
    "git",
    ["-c", "user.name=Test Author", "-c", "user.email=author@example.invalid", "-c", "commit.gpgsign=false", ...args],
    { cwd: repo, env: { ...env, HOME: repo, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }, stdio: "ignore" },
  );
}

async function commit(file: string, text: string | null, message: string): Promise<void> {
  if (text === null) await unlink(join(repo, file));
  else await writeFile(join(repo, file), text);
  git("add", "-A");
  git("commit", "-q", "-m", message);
}

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "topped-history-test-"));
  git("init", "-q", "-b", "main");
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

// Built from parts, so this file itself carries none of it.
const HOME_PATH = ["", "Users", "someone", "repos", "app"].join("/");
const PULL_REQUEST = ["PR", "#12"].join(" ");

describe("the pre-push history check", () => {
  it("finds a path a later commit removed from the tree", async () => {
    await commit("plan.md", `Source: ${HOME_PATH}/docs/spec.md\n`, "Plan it");
    await commit("plan.md", "Source: the spec\n", "Say less");
    const findings = privateLinesInHistory(repo);
    expect(findings.map((finding) => finding.line)).toEqual([`-Source: ${HOME_PATH}/docs/spec.md`, `+Source: ${HOME_PATH}/docs/spec.md`]);
  });

  it("finds a private pull request in a commit message and in a deleted file", async () => {
    await commit("notes.md", `Shipped in ${PULL_REQUEST}\n`, `Follow ${PULL_REQUEST}`);
    await commit("notes.md", null, "Drop the notes");
    const lines = privateLinesInHistory(repo).map((finding) => finding.line.trim());
    expect(lines).toContain(`Follow ${PULL_REQUEST}`);
    expect(lines).toContain(`+Shipped in ${PULL_REQUEST}`);
    expect(lines).toContain(`-Shipped in ${PULL_REQUEST}`);
  });

  it("passes a history that never carried any, and names who wrote it", async () => {
    await commit("README.md", "# topped\n", "Start");
    expect(privateLinesInHistory(repo)).toEqual([]);
    expect(identitiesInHistory(repo)).toEqual(["Test Author <author@example.invalid>"]);
  });

  it("says whether a squash would clear it: only when the files as they stand carry none", async () => {
    await commit("plan.md", `Source: ${HOME_PATH}/docs/spec.md\n`, "Plan it");
    expect(privateLinesInTree(repo)).toEqual([{ file: "plan.md", line: `Source: ${HOME_PATH}/docs/spec.md` }]);
    await commit("plan.md", "Source: the spec\n", "Say less");
    expect(privateLinesInHistory(repo)).not.toEqual([]);
    expect(privateLinesInTree(repo)).toEqual([]);
  });

  // The criterion "npm run check:history exits 0" holds once the owner has
  // squashed the history to one commit (the plan's owner step 3); before
  // that, the plan's own early commits are still in it. This pins that the
  // squash is all it takes: this repository's files, as one commit, pass.
  it("passes this repository's own files squashed to one commit", async () => {
    const root = process.cwd();
    const files = execFileSync("git", ["ls-files", "-z"], { cwd: root, env: cleanEnv(), encoding: "utf8" })
      .split("\0")
      .filter((file) => file !== "");
    expect(files).toContain("scripts/check-history.mjs");
    for (const file of files) {
      await mkdir(dirname(join(repo, file)), { recursive: true });
      await copyFile(join(root, file), join(repo, file));
    }
    git("add", "-A");
    git("commit", "-q", "-m", "topped: the CLI and the skill");
    const check = spawnSync(process.execPath, [join(root, "scripts", "check-history.mjs"), repo], { encoding: "utf8", env: cleanEnv() });
    expect(check.stderr).toBe("");
    expect(check.stdout).toContain("No private text in any commit.");
    expect(check.status).toBe(0);
  });
});
