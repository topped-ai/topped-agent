# Changelog

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
