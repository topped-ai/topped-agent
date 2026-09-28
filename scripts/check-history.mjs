#!/usr/bin/env node
/**
 * Before this repository is pushed anywhere public: every commit reachable
 * from any ref, and every commit message, must be free of what may not leave
 * the owner's machine. `git log -p` shows text a later commit removed, which
 * the tree checks in test/package.test.ts cannot see.
 *
 * Usage: node scripts/check-history.mjs [repo folder]. Exit 0 when clean,
 * 1 with each finding on stderr. The commit authors are listed on stdout, so
 * whoever pushes can see the addresses that would go public with them.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Text a public commit may never carry: a path on someone's machine, a
 * private pull request, the private app repository's glossary or decision records.
 */
export const PRIVATE_TEXT = [/\/Users\//, /\/home\/[a-z]/, /worktrees\//, /\bPR #\d+/, /\bCONTEXT\.md\b/, /\bADRs? \d{4}\b/, /\bdocs\/adr\//];

/**
 * Run git in `cwd` with none of the caller's GIT_* variables, so it reads the
 * repository asked for and nothing else.
 * @param {string} cwd
 * @param {string[]} args
 * @returns {string}
 */
function git(cwd, args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));
  return execFileSync("git", args, { cwd, env, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
}

/**
 * Each line of the history, patches and messages, that carries private text.
 * @param {string} cwd
 * @returns {{ commit: string, line: string }[]}
 */
export function privateLinesInHistory(cwd) {
  const log = git(cwd, ["log", "--all", "-p", "--no-color", "--no-ext-diff", "--format=commit %H%n%B"]);
  /** @type {{ commit: string, line: string }[]} */
  const findings = [];
  let commit = "";
  for (const line of log.split("\n")) {
    const header = /^commit ([0-9a-f]{40})$/.exec(line);
    if (header) {
      commit = header[1] ?? "";
      continue;
    }
    if (PRIVATE_TEXT.some((pattern) => pattern.test(line))) findings.push({ commit, line });
  }
  return findings;
}

/**
 * Each line of the tracked files as they stand on disk that carries private
 * text: what a squash to one commit would still publish. Binary files are
 * skipped.
 * @param {string} cwd
 * @returns {{ file: string, line: string }[]}
 */
export function privateLinesInTree(cwd) {
  const files = git(cwd, ["ls-files", "-z"]).split("\0").filter((file) => file !== "");
  /** @type {{ file: string, line: string }[]} */
  const findings = [];
  for (const file of files) {
    let bytes;
    try {
      bytes = readFileSync(join(cwd, file));
    } catch {
      continue; // Deleted on disk: a squash of what is there won't carry it.
    }
    if (bytes.includes(0)) continue;
    for (const line of bytes.toString("utf8").split("\n")) {
      if (PRIVATE_TEXT.some((pattern) => pattern.test(line))) findings.push({ file, line });
    }
  }
  return findings;
}

/**
 * Every author and committer identity in the history.
 * @param {string} cwd
 * @returns {string[]}
 */
export function identitiesInHistory(cwd) {
  const lines = git(cwd, ["log", "--all", "--format=%an <%ae>%n%cn <%ce>"]).split("\n");
  return [...new Set(lines.filter((line) => line.trim() !== ""))].sort();
}

function main() {
  const cwd = process.argv[2] ?? process.cwd();
  const findings = privateLinesInHistory(cwd);
  process.stdout.write(`Identities in the history:\n${identitiesInHistory(cwd).map((who) => `  ${who}`).join("\n")}\n`);
  if (findings.length === 0) {
    process.stdout.write("No private text in any commit.\n");
    return 0;
  }
  for (const { commit, line } of findings) process.stderr.write(`${commit.slice(0, 12)}: ${line.trim().slice(0, 160)}\n`);
  process.stderr.write(
    `${findings.length} line${findings.length === 1 ? "" : "s"} of private text in the history. Rewrite it (squash to one commit) before pushing.\n`,
  );
  const inTree = privateLinesInTree(cwd);
  if (inTree.length === 0) {
    process.stderr.write("The files as they stand carry none: squashed to one commit with a clean message, the history passes.\n");
  } else {
    for (const { file, line } of inTree) process.stderr.write(`${file}: ${line.trim().slice(0, 160)}\n`);
    process.stderr.write(`The files themselves still carry ${inTree.length}: remove ${inTree.length === 1 ? "it" : "them"} before squashing.\n`);
  }
  return 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
