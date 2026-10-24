# Design decisions

Why `topped` works the way it does. The CLI and the skill are the public half of Topped's "Connect your agent"; the tools themselves live in Topped, behind `https://app.topped.ai`.

## Signing in

- **`topped login` is "Log in with Topped".** The CLI signs in through the browser with the same OAuth 2.1 flow a chat app's connector uses (PKCE S256, dynamic registration, a `127.0.0.1` loopback redirect), so a founder never copies a key. A `tpd_live_` key in `TOPPED_API_KEY` still works for scripts and CI, and wins over a stored sign-in.
- **Discovery checks where it signs in.** The resource metadata's `resource` must be `<base>/api/mcp` and its authorization server must be `<base>` itself (RFC 9728 §3.3), or `topped login` refuses with `sign_in_unavailable`.
- **A fresh client on every sign-in.** Only `credentials.json` is kept (mode 0600, in a 0700 directory under `$XDG_CONFIG_HOME/topped`). Topped forgets a registration that never produced a sign-in, so a kept client id could leave a later sign-in waiting forever. Each sign-in is its own app on Topped anyway. Signing in again replaces the stored sign-in, and the answer names the older app to revoke under Settings > Connect your agent, because Topped has no door for the CLI to revoke one.
- **The sign-in browser runs on the machine running `topped`,** because the sign-in comes back to `127.0.0.1` there. From a remote machine, set `TOPPED_API_KEY`, or run `topped login --no-browser --port <n>` behind `ssh -L <n>:127.0.0.1:<n>`. `topped login` waits 5 minutes for Allow; an agent running it should give the command 6.
- **`TOPPED_URL` must be https, or http on this machine,** so a credential never crosses the network in the clear.

## A thin client

- **The CLI is a thin client** over `POST /api/v1/tools/{name}` and `GET /api/v1/tools`: no business logic and no second vocabulary. A refusal passes through exactly as Topped wrote it.
- **Where the spec's flags and the live schema differ, the schema wins.**
  - `runs` has no `--status`; each run carries its own. Its `--week` also takes an ISO week, sent as that week's Monday.
  - `run retry` has no `--accounts`: only the failed accounts go again.
  - `scoreboard` and `scoreboard posts` take `--accounts <a,b>` (up to 25 connectionIds), or none for every account.
  - `watchlist browse` takes `--creators <a,b>` (watchlistHandleIds, up to 40), or none for every watched Creator, and pages with `--cursor`.
  - `media --media-id <mediaId>` reads one item, or a video `generate` started. Topped refuses it beside `--kind`, `--cursor` or `--limit`; the CLI sends what it is given and passes that refusal through.
  - `starting-points --photo-set <startingPointId>` lists every photo of one set; `--source yours` lists the founder's own Library images or clips instead of Topped's.
  - `media delete` answers with an `undoToken`.
  - `for-you edit` takes the `draftId` as an argument.
  - The confirmations Topped requires are flags: `accounts disconnect --platform --handle|--no-handle`, `watchlist unwatch|dismiss --handle`, `run move|retry --from-slot` and `run cancel --slot`. `accounts connect --reconnect <connectionId>` reconnects.
- **Where the CLI departs from the spec by choice.** `media restore <mediaId> --undo-token <token>`, not the spec's positional `<undoToken>`: the token is a flag, like the other values Topped requires to confirm a change (`--from-slot`, `--slot`, `--handle`).
- **What the CLI adds to Topped's answers:**
  - the `requestId` it sent, as a top-level `requestId` on the result or refusal;
  - `source` and `url` on `whoami`;
  - for `topped login`: `{ ok, signedIn, app, productName, url }`.

  `--help` is a JSON document like every other answer. A non-JSON answer (a proxy or outage page) is exit 4.
- **Exit codes:**
  - 0: done.
  - 1: Topped refused, or topped's own failure (`internal_error`, or `config_unwritable` naming the file it could not write).
  - 2: bad usage.
  - 3: not signed in, or the sign-in was revoked.
  - 4: Topped could not be reached.
- **What a Post looks like travels as JSON.** `draft create`, `draft edit`, `for-you edit` and `saved edit` take the Post in the editor's own names (`startingPoint`, `behindTheWords`, `images`, `allTextBoxes`, `volumes`) through `--json`, unchanged. The CLI has no flag for any of them, so a renamed field needs no new CLI.
- **No time zone unless one is named.** `runs`, `run move` and `run retry` send `timeZone` only from `--time-zone` or the `--json` input. Left out, Topped reads days and times in the zone the founder saved in Settings, which `topped balances` shows. The machine running `topped` is often a cloud sandbox or CI set to UTC, so its zone says nothing about the founder's. With no zone saved, Topped's `time_zone_required` refusal passes through, and the agent asks the founder.
- **A clip's length goes with `upload_media` begin.** Begin refuses a clip or Demo without it, and finish ignores it. `topped upload` reads it from the MP4 or MOV header (or `--duration`) and sends it before any byte moves, so Topped refuses a clip over 30 seconds before the upload. `--poster` fills begin's second slot: a clip's cover frame, or an image's thumbnail.
- **A For You Draft's words are rewritten only when it was made from a Template:** Topped's writer rewrites through the Template's slots. Every Draft Topped deals comes off its shelf of Templates. The CLI passes any refusal through unchanged.

## Retries

- At most 3 attempts with backoff (or `Retry-After`, up to 10 seconds), within the request's time budget: 5 minutes for a tool call (some tools make an image or write inside the request), and 1 minute for discovery, sign-in and the tool list.
- A read retries on a network failure and on 500, 502, 503 and 504.
- A call carrying a `requestId` retries the same way, except on a 500 carrying Topped's own `{ error, fix }`: that failure's fix says what to check.
- A change without a `requestId` retries only on 503, where Topped says nothing ran.
- **A lost answer.** When an attempt with a `requestId` may have reached Topped but its answer was lost (a network failure, a timeout, a gateway page), and a repeat answers `request_in_progress`, the CLI keeps repeating under the same id until the first result comes back or that attempt's run must have ended.
- **What the fix says.** After exit 4, the fix of a call with a `requestId` says to run it again with `--request-id <id>`; for a change without one, it says to check whether the change happened first. A credential refused after an attempt that may have reached Topped is exit 3, and its fix says the same once you are signed in again.

## The skill

- **The skill is the one place an agent learns Topped.** Setup never asks anyone to edit CLAUDE.md or AGENTS.md.
- It installs three ways:
  - Claude Code's plugin marketplace (`.claude-plugin/`);
  - `npx skills add` (`skills/topped/SKILL.md`);
  - ClawHub, for Hermes and OpenClaw (the `openclaw` block in the skill's frontmatter metadata).
- **Node 20 or later,** ESM, TypeScript compiled to `dist/`, no runtime dependencies.

## Listings

- **`server.json` lists Topped's remote MCP server in the official MCP registry,** as `ai.topped/topped` with one `streamable-http` remote and no package: the server runs in Topped, so there is nothing to install. Its `version` follows `package.json`.
- **`docs/hermes/optional-mcps/topped/manifest.yaml` is the entry for Hermes's curated MCP list,** ready to copy into a pull request there under the same path. It follows that list's shape: an `http` transport and native `oauth`, every tool checked at install.
- Every setup the README and the skill give (Claude Code, Hermes, Grok, chat apps) reaches the same address, `https://app.topped.ai/api/mcp`, with "Log in with Topped" or a key.
