# Changelog

## 0.3.3 (2026-11-02)

### Changed

- `topped caption <postId>` (`draft_caption`) writes the caption for one Post, from that Post's on-screen words and the caption of the post it copies, in that caption's shape. It takes the Post's id instead of `--format`, and `--attempt` is gone: "write a different one" is `--avoid` with the caption you have. An older CLI's `topped caption --format …` is refused.

## 0.3.2 (2026-11-01)

### Changed

- Posting no longer asks the founder each TikTok and YouTube choice. A choice left out of `tiktok` or `youtube` (`--platform-json`) takes the default Topped's own Scheduler starts on: TikTok posts to Everyone when the account offers it, with comments on unless the account has them off, Duet and Stitch off, music added to a slideshow, no commercial disclosure and the AI-generated label on; YouTube posts public with the AI-generated label on. The skill tells the agent to say those choices to the founder in one line before posting. A TikTok account without Everyone still needs its `privacy` stated.

## 0.3.1 (2026-11-01)

### Changed

- A Wall of text's words now run up to 250 characters (they were 200), as long as the Source post a Draft copies; a Demo video's opener stays one short line. In the skill.
- `get_post` and `get_for_you_draft` (`topped post`, `topped for-you`) group a Post's picture and video URLs under `media` (`posterUrl`, `slides`, `videoUrl`); a For You video's length is `draft.seconds`. Over MCP, a chat that draws Topped's Post card gets `media` as a note (the card shows the Post), and so does a client on the older MCP revision, which can't say whether it draws one; `topped post <postId>` always prints the URLs.

## 0.3.0 (2026-10-30)

Brought in line with the 41 tools Topped lists today.

### Upgrade from 0.2.0

- Today's Topped refuses 0.2.0's `topped for-you edit` and the skill's `edit_for_you_draft` (an unknown tool). Update the CLI and the skill together.

### Changed

- `topped for-you edit` is gone: Topped folded `edit_for_you_draft` into `edit_draft`, which changes any Draft. Change the For You Draft with `topped draft edit <draftId> --json <file|->`, sending `get_for_you_draft`'s `draft.current` back with your changes; its `startingPoint` and Demo stay as read. `draft edit` now carries a request id.

### Set up

- Hermes: `hermes mcp add --url https://app.topped.ai/api/mcp --auth oauth topped`, or the `~/.hermes/config.yaml` entry, with "Log in with Topped" or a key. In the README and the skill.
- Grok: a custom connector on grok.com, the Grok Build CLI (`grok mcp add --transport http topped https://app.topped.ai/api/mcp`), or the xAI API's remote MCP tool. In the README and the skill.

### Listings

- `server.json`: Topped's remote MCP server for the official MCP registry, at the remote server's own version (1.0.0), not the CLI's.
- `docs/hermes/optional-mcps/topped/manifest.yaml`: the entry for Hermes's curated MCP list.

## 0.2.0 (2026-10-24)

Brought in line with the 42 tools Topped lists today.

### Upgrade from 0.1.0

- Today's Topped refuses clip and Demo uploads from 0.1.0: `upload_media` begin now needs the clip's length, which 0.1.0 sent only with finish. Upgrade to upload clips and Demos.
- Today's Topped also refuses 0.1.0's `topped scoreboard --account <connectionId>`, `topped watchlist browse <watchlistHandleId>`, and the Post names the 0.1.0 skill taught (a top-level `startingPointId`, `look` and `sameLookOnEverySlide`). The skill installs apart from the CLI, so update the CLI and the skill together.

### New commands

- `topped media restore <mediaId> --undo-token <token>` (`restore_media`): puts a removed image or clip back. `topped media delete` now answers with the `undoToken`.
- `topped scoreboard posts [--accounts <a,b>] [--cursor <cursor>]` (`list_scoreboard_posts`): every published Post, newest first, with its accounts and real platform-reported counts.

### Changed commands

- `topped starting-points` takes `--source <topped|yours>` (your own Library images or clips of 30 seconds or less), `--tag <tag>`, and `--photo-set <startingPointId>` for every photo of one set.
- `topped media --media-id <mediaId>` reads one item, or whether a video `topped generate` started is still being made, failed, or is only in the Playground.
- `topped scoreboard --accounts <a,b>` replaces `--account <connectionId>`: one or several accounts.
- `topped watchlist browse [--creators <a,b>] [--cursor <cursor>]` reads every watched Creator's newest Posts at once, or only some, paged. It no longer takes a `<watchlistHandleId>` argument.
- `topped upload` sends a clip's length with the first step, so a clip over 30 seconds is refused before it uploads. `--poster` also takes an image's thumbnail.
- `--accounts` takes up to 25 accounts, and a YouTube title is optional in `--platform-json` (it defaults to the caption's first line).
- `topped runs`, `run move` and `run retry` no longer send this machine's time zone. Topped reads days and times in the zone the founder saved in Settings (`topped balances` shows it); `--time-zone <zone>` names another.

### The skill

- Leave `timeZone` out: Topped uses the zone the founder saved, and `get_balances` shows it. Send one only when the founder names another.
- Posts start from your own Library media: `startingPoint` is `{ "startingPointId" }` or `{ "mediaId" }`.
- The editor's names: `behindTheWords` (`white`, `none`, `snapchat`), outline width `none`, `images` with `opacity` (they were stickers), `allTextBoxes` with `didNotFit`, `volumes.sound` and `volumes.demoSound`, and a slide photo from any set as `{ "photoSetId", "photo" }`.
- Restore after a delete; never check again on a video that is `in_playground`; Scoreboard per Post; the Product's logo.
- A Slideshow has up to 10 slides, wherever it posts (Instagram's carousel limit), not 20.
