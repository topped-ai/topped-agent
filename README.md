# topped

Let your AI agent run [Topped](https://app.topped.ai): make, approve, schedule and check your Posts the way you do in the app. This repository holds two things:

- **the `topped` CLI**, for coding agents that run shell commands (Claude Code, Codex, OpenClaw, Hermes). Every command prints exactly one JSON document on stdout, so an agent reads every answer the same way;
- **the `topped` skill**, which teaches your agent Topped's workflows: the morning check of your For You Draft, a post about what you just shipped, a Demo video from the simulator, filling the week, and setting up your Product from its repo. Nothing to paste into your agent's instructions: install the skill instead.

## Set up your agent

Pick the way your agent talks to Topped, then [add the skill](#the-skill).

| Your agent | How it connects |
|---|---|
| A coding agent in a terminal | `npm i -g topped && topped login` (below). Coding agents do best with the CLI: it costs nothing in the agent's context until a command runs. |
| Claude Code, over MCP | Create a key in Topped under **Settings > Connect your agent**, then run `claude mcp add --transport http topped https://app.topped.ai/api/mcp --header "Authorization: Bearer <your key>"`. |
| Hermes | `hermes mcp add --url https://app.topped.ai/api/mcp --auth oauth topped`, or the config below. |
| Grok | A custom connector on grok.com, the Grok Build CLI, or the xAI API's remote MCP tool (below). |
| A chat app (Claude.ai, ChatGPT) | Add a custom connector with the address `https://app.topped.ai/api/mcp`, then sign in with "Log in with Topped". |

### Hermes

Add Topped to `~/.hermes/config.yaml`. With "Log in with Topped", Hermes opens your browser on first connect, registers itself, and keeps the sign-in under `~/.hermes/mcp-tokens/`; no key goes in the file:

```yaml
mcp_servers:
  topped:
    url: https://app.topped.ai/api/mcp
    auth: oauth
```

Or with a key from **Settings > Connect your agent**:

```yaml
mcp_servers:
  topped:
    url: https://app.topped.ai/api/mcp
    headers:
      Authorization: "Bearer <your key>"
```

Restart your Hermes session so the tools load. Hermes also runs the CLI: `npm i -g topped && topped login`.

### Grok

- **grok.com:** open grok.com/connectors, choose **New Connector**, then **Custom**, and give it the address `https://app.topped.ai/api/mcp`. Sign in with "Log in with Topped".
- **Grok Build CLI:** `grok mcp add --transport http topped https://app.topped.ai/api/mcp`. It signs in with "Log in with Topped" on first use. With a key instead, add `--header "Authorization: Bearer <your key>"`.
- **The xAI API:** give the request Topped as a remote MCP tool, with a key from **Settings > Connect your agent**:

  ```json
  {
    "type": "mcp",
    "server_url": "https://app.topped.ai/api/mcp",
    "server_label": "topped",
    "authorization": "<your key>"
  }
  ```

The CLI and the MCP server run the same tools, with the same answers. Everything an agent does acts as you: there is no second approval inside Topped, so your conversation with your agent is where you say yes. **Settings > Connect your agent** lists every key and signed-in app, with Revoke.

## The skill

`skills/topped/SKILL.md` is the one place your agent learns Topped: the rules first (state the price before anything that spends, uploads only through Topped, your TikTok choices are yours, show what a For You Draft is based on), then recipes that work over the CLI or MCP. Install it the way your agent takes skills:

- **Claude Code:** add this repository as a plugin marketplace and install the plugin:

  ```sh
  claude plugin marketplace add topped-ai/topped-agent
  claude plugin install topped@topped-agent
  ```

  Or inside a session: `/plugin marketplace add topped-ai/topped-agent`, then `/plugin install topped@topped-agent`.
- **Codex, Cursor, OpenClaw and other agents that read skills:** `npx skills add topped-ai/topped-agent`.
- **ClawHub (OpenClaw, Hermes):** find `topped` on ClawHub and install it the way ClawHub shows. Its metadata names the `topped` CLI as a requirement, with an npm installer for it.

The skill's version follows the CLI's (`package.json` and `.claude-plugin/plugin.json` carry the same one).

## Install

```sh
npm i -g topped
topped login
```

Or run it without installing: `npx topped <command>`. Node 20 or later.

## Sign in

`topped login` opens your browser at Topped's "Log in with Topped" page. Click **Allow**, and the CLI keeps the sign-in on this machine. No key to copy. The link is also printed on stderr, and `--no-browser` only prints it.

The browser must run on the same machine as `topped`, because the sign-in comes back to `127.0.0.1` there. `topped login` waits up to 5 minutes for it. On a remote machine (SSH, a server), either set [`TOPPED_API_KEY`](#topped_api_key), or pick a port and forward it before opening the link:

```sh
ssh -L 8765:127.0.0.1:8765 you@server   # from your own machine
topped login --no-browser --port 8765   # on the server; open the link in your own browser
```

- The sign-in is stored in `$XDG_CONFIG_HOME/topped/credentials.json` (by default `~/.config/topped/credentials.json`; a relative `XDG_CONFIG_HOME` is ignored), readable only by you (mode 0600).
- It renews itself. If you revoke it in Topped, the next command exits 3 and says to run `topped login` again.
- `topped logout` forgets it on this machine. To remove it from Topped too, revoke "Topped CLI" under **Settings > Connect your agent**.
- Each `topped login` is its own app on Topped. Signing in again replaces this machine's sign-in but not the older app, which stays on Topped until you revoke it there; `topped login` says so when it replaces one.
- `topped whoami` names the key or app in use, the Product it acts on, and where the credential came from.

### `TOPPED_API_KEY`

For scripts and CI, create a key in Topped under **Settings > Connect your agent** and set it:

```sh
export TOPPED_API_KEY=tpd_live_...
topped balances
```

`TOPPED_API_KEY` wins over a stored `topped login`. The key is sent only as an `Authorization: Bearer` header, never in a URL, and the CLI never prints it.

### `TOPPED_URL`

The CLI talks to `https://app.topped.ai`. `TOPPED_URL` points it elsewhere, such as a local server (`TOPPED_URL=http://localhost:3000`). It must be https, or http on this machine. Sign-ins are kept per address.

## The output contract

- **stdout is always exactly one JSON document.** No banners, no progress. `--pretty` indents it for people.
- **Hints for people go to stderr**, such as the sign-in link.
- **A failure exits non-zero with `{ "error", "fix" }` on stdout.** `fix` is one line saying what to do instead. When Topped refuses a call, its own answer is passed through as it came.
- **Exit codes:**

| Code | Meaning |
|---|---|
| 0 | Done. |
| 1 | Topped refused: stdout is Topped's own `{ error, fix }`. Or topped itself failed: `fix` names what failed. |
| 2 | Bad usage: stdout names what to change. |
| 3 | Not signed in, or the sign-in or key was refused: run `topped login`, then do what `fix` says (for a call that may have reached Topped, repeat it with the same `--request-id`). |
| 4 | Could not reach Topped: `fix` says how to repeat the command safely. |

- **No token or key is ever printed**, on stdout or stderr, including under `--verbose` (which names each request and its status on stderr).

## Money

Two meters, never confused. **Credits** pay for Playground images and videos (`topped generate`). One **content save** is spent when a Post is approved (`topped approve`: Save, Post now or Schedule) or when a Re-edit brings new media (`topped saved edit --save-as-new`). Everything else is free. `topped balances` shows both.

`topped generate` never spends without the price: run it without `--expected-credits` and nothing is made; the answer carries the price. Run it again with `--expected-credits <price>` to make it.

## Safe to repeat

Commands that spend or publish (`approve`, `saved publish`, `saved edit`, `for-you edit`, `generate`, `run retry`) carry a request id: a fresh one per run, echoed in the output as `requestId`. Pass the same `--request-id <id>` again and Topped returns the first result instead of acting twice. The CLI retries network failures and Topped outages on its own, a few times with backoff, and never a refusal. A command gets up to five minutes, as long as Topped lets one call run. When a command with a request id loses its answer on the way back, the CLI asks again under the same id until the first result comes back. After exit 4, do what `fix` says: for a command with a request id, run it again with that `--request-id`; a plain rerun gets a fresh id and could act twice.

Commands that read days and times (`runs`, `run move`, `run retry`) read them in the time zone the founder saved in Topped's Settings, never this machine's; `topped balances` shows it. `--time-zone <IANA zone>` names another, only when the founder asks for one. With no zone saved, Topped refuses with `time_zone_required`: ask the founder for theirs and pass it with `--time-zone`.

## Commands

Each command runs one Topped tool. Arguments and flags become the tool's input; `--json <file|->` takes a structured input from a file, or from stdin with `-`. `topped <command> --help` describes one command as JSON.

### Signing in

| Command | Tool | What it does |
|---|---|---|
| `topped login [--no-browser] [--port <n>]` |  | Sign in with your browser (Log in with Topped) and keep the sign-in on this machine. |
| `topped logout` |  | Forget the sign-in kept on this machine. |
| `topped whoami` |  | Which key or signed-in app this is, whose Product it acts on, and where the credential came from. |

### Account

| Command | Tool | What it does |
|---|---|---|
| `topped balances` | `get_balances` | Credits and content saves left, the plan, and today's For You use. |
| `topped product` | `get_product` | The Product Profile and Voice settings. |
| `topped product update --json <file\|->` | `update_product` | Change the Product, or its logo (logoMediaId); on a new account, set it up (name and oneLiner). |
| `topped accounts [--post <postId>]` | `list_connected_accounts` | Connected TikTok, Instagram and YouTube accounts and how many the plan allows; with --post, what each accepts for that Post. |
| `topped accounts connect <tiktok\|instagram\|youtube> [--reconnect <connectionId>]` | `connect_account` | A link the founder opens to connect (or reconnect) an account. |
| `topped accounts disconnect <connectionId> --platform <tiktok\|instagram\|youtube> --handle <handle>\|--no-handle` | `disconnect_account` | Disconnect an account; its Publications that haven't gone out are cancelled. |

### For You

| Command | Tool | What it does |
|---|---|---|
| `topped for-you` | `get_for_you_draft` | The current For You Draft, with its Based on and every slide or the video. |
| `topped for-you edit <draftId> --json <file\|->` | `edit_for_you_draft` | Change the current For You Draft's words, text boxes, looks, images, photos, Sound, trim or volumes. |
| `topped pass <draftId>` | `pass_draft` | Pass on the current For You Draft. Free, and final. |
| `topped approve <draftId> --save \| --post-now --accounts <a,b> \| --schedule <iso> --accounts <a,b> [--caption <text>] [--platform-json <file\|->]` | `approve_draft` | Approve a Draft: Save it, Post it now or Schedule it. Spends one content save. |
| `topped undo <draftId>` | `undo_approve` | Undo an approval within 5 minutes, while nothing has gone out; the content save comes back. |

### Creator

| Command | Tool | What it does |
|---|---|---|
| `topped sources --format <slideshow\|wall_of_text\|demo_video> [--cursor <cursor>]` | `list_source_posts` | Source posts Creator offers for a Format, with their raw counts. |
| `topped starting-points --format <slideshow\|wall_of_text\|demo_video> [--source <topped\|yours>] [--tag <tag>] [--photo-set <startingPointId>] [--cursor <cursor>]` | `list_starting_points` | Starting points for a Format: Topped's photo sets, backgrounds or openers, or with --source yours, your Library images or clips. |
| `topped sounds [--cursor <cursor>]` | `list_sounds` | Topped's sounds and the founder's own. |
| `topped draft create --json <file\|->` | `create_draft` | Make a Creator Draft from a source post, or your own. Free. |
| `topped draft edit <draftId> --json <file\|->` | `edit_draft` | Change a Draft you made: send the whole Post. Free. |
| `topped draft rewrite <draftId> [--steer <text>] [--mention \| --no-mention] [--previous-idea <ideaId>]` | `rewrite_draft` | Topped's writer rewrites a Draft's words. Free. |
| `topped caption --format <slideshow\|video> [--avoid <text>] [--platforms <a,b>] [--attempt <n>]` | `draft_caption` | Topped writes a caption for a Post. Plus and Pro. |
| `topped generate <image\|video> --prompt <text> [--expected-credits <n>] [--model <model>] [--length <seconds>] [--starting-image <mediaId>]` | `generate_media` | A Playground image or video. Spends credits: without --expected-credits, nothing is made and the price comes back. A video finishes in the background: topped media --media-id <mediaId>. |

### Library

| Command | Tool | What it does |
|---|---|---|
| `topped saved [--cursor <cursor>] [--limit <n>]` | `list_saved_posts` | Saved Posts in the Library, newest first. |
| `topped post <postId>` | `get_post` | One Post in full: Poster, slides or video, Based on, render status and Publish runs. |
| `topped saved publish <postId> --post-now \| --schedule <iso> --accounts <a,b> [--caption <text>] [--platform-json <file\|->]` | `publish_saved_post` | Post or schedule a Saved Post again. Free. |
| `topped saved edit <postId> --json <file\|-> [--save-as-new]` | `edit_saved_post` | Re-edit a Saved Post. New media makes a second Saved Post and spends one content save, only with --save-as-new. |
| `topped saved delete <postId>` | `delete_saved_post` | Remove a Saved Post from the Library. |
| `topped media [--kind <image\|clip\|demo\|sound>] [--cursor <cursor>] [--limit <n>] \| --media-id <mediaId>` | `list_media` | Images, clips, Demos and sounds in the Library, with their ids. --media-id reads one item, or whether a video topped generate started is still being made. |
| `topped upload <file> [--demo] [--duration <seconds>] [--poster <jpg>] [--title <name>] [--rights-confirmed]` | `upload_media` | Upload an image, clip, Demo or sound to the Library and get its id. A clip or Demo plays 30 seconds at most. |
| `topped media demo <mediaId> --on \| --off` | `update_media` | Use a clip as a Demo, or stop. |
| `topped media delete <mediaId>` | `delete_media` | Remove an image or clip from the Library, and from the Playground for one made there. The answer's undoToken puts it back. |
| `topped media restore <mediaId> --undo-token <token>` | `restore_media` | Put a removed image or clip back, with the undoToken topped media delete returned. |

### Calendar and Scoreboard

| Command | Tool | What it does |
|---|---|---|
| `topped runs [--week <YYYY-MM-DD\|YYYY-Www>] [--account <connectionId>] [--cursor <cursor>]` | `list_publish_runs` | Posts on the Calendar - scheduled, posted and failed - for a week, or one account's. |
| `topped run <runId>` | `get_publish_run` | One Publish run's accounts and their results. |
| `topped run move <runId> --from-slot <iso> --at <iso> \| --to-day <YYYY-MM-DD> [--to-time <HH:MM>]` | `move_publish_run` | Move a scheduled Post to another day and time within 30 days. |
| `topped run cancel <runId> --slot <iso>` | `cancel_publish_run` | Cancel a scheduled Post before it goes out. It stays in the Library; no content save comes back. |
| `topped run retry <runId> --from-slot <iso> --at <iso> \| --to-day <YYYY-MM-DD> --to-time <HH:MM>` | `retry_publish_run` | Try a Post that couldn't post again at a new time, on the accounts it failed on. Free. |
| `topped scoreboard [--accounts <a,b>]` | `get_scoreboard` | Real platform-reported counts and totals, overall and per account. |
| `topped scoreboard posts [--accounts <a,b>] [--cursor <cursor>]` | `list_scoreboard_posts` | Every published Post, newest first, 20 a page, with its accounts and real platform-reported counts. |
| `topped scoreboard refresh [--accounts <a,b>] [--run <runId>]` | `refresh_metrics` | Re-read the latest counts from the platforms. |

### Watchlist

| Command | Tool | What it does |
|---|---|---|
| `topped watchlist` | `list_watchlist` | Watched accounts and suggested accounts. |
| `topped watchlist browse [--creators <a,b>] [--cursor <cursor>]` | `browse_watchlist` | Watched Creators' newest Posts, 20 a page, with their raw counts. |
| `topped watchlist watch <tiktok\|instagram\|youtube> <handle>` | `watch_account` | Watch an account, or accept a suggested one. |
| `topped watchlist unwatch <watchlistHandleId> --handle <handle>` | `unwatch_account` | Stop watching a Creator; their history is kept. |
| `topped watchlist dismiss <suggestionId> --handle <handle>` | `dismiss_suggested_account` | Dismiss a suggested account for good. |

### Any tool

| Command | Tool | What it does |
|---|---|---|
| `topped tools` |  | Every Topped tool with its input schema, live from Topped. |
| `topped call <tool> [--json <file\|->]` |  | Run any Topped tool by its own name, with its input as JSON. |

`topped tools` lists every tool with its input schema, live from Topped, and `topped call <tool> --json <file|->` runs any of them by name, so the CLI never lags Topped.

### Global flags

| Flag | What it does |
|---|---|
| `--pretty` | Indent the JSON. |
| `--verbose` | Name each request and its status on stderr. |
| `--time-zone <zone>` | An IANA time zone for commands that take one, when the founder names one. Left out, Topped uses the zone saved in Settings. |
| `--request-id <id>` | For commands that spend or publish: repeat a call safely. |
| `--help` | All commands, or one command's usage, as JSON. |
| `--version` | The CLI's version. |

## Examples

```sh
topped for-you --pretty                     # the current For You Draft and its Based on
topped draft rewrite <draftId> --steer "shorter"
topped approve <draftId> --schedule 2026-10-02T18:30:00-04:00 --accounts <connectionId>
topped undo <draftId>                       # within 5 minutes: the content save comes back
topped upload recording.mov --demo          # a screen recording of your Product, as a Demo
topped starting-points --format slideshow --source yours   # your own Library images, to start a Slideshow on
topped media delete <mediaId>               # the answer carries an undoToken
topped media restore <mediaId> --undo-token <token>        # puts it back
topped runs --week 2026-W40
topped scoreboard posts --accounts <connectionId>          # each Post's own counts, newest first
```

TikTok posts need every posting choice the founder made (privacy, comments, Duet, Stitch, music, disclosure, the AI-generated label) in `--platform-json`, or "send to TikTok drafts". YouTube needs a privacy there; its title defaults to the caption's first line. `topped accounts --post <postId>` lists what each account allows.

What changed between versions: [CHANGELOG.md](CHANGELOG.md).

## Development

```sh
npm install
npm run typecheck
npm test        # builds, then runs the tests against a local fake Topped
claude plugin validate .   # the plugin marketplace and the plugin, when Claude Code is installed
```

The tests never reach a real Topped and never touch your own sign-in.

## License

MIT. See [LICENSE](LICENSE).
