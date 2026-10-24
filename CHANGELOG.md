# Changelog

## 0.2.0 (2026-10-24)

Brought in line with the 42 tools Topped lists today.

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

### The skill

- Posts start from your own Library media: `startingPoint` is `{ "startingPointId" }` or `{ "mediaId" }`.
- The editor's names: `behindTheWords` (`white`, `none`, `snapchat`), outline width `none`, `images` with `opacity` (they were stickers), `allTextBoxes` with `didNotFit`, `volumes.sound` and `volumes.demoSound`, and a slide photo from any set as `{ "photoSetId", "photo" }`.
- Restore after a delete; never check again on a video that is `in_playground`; Scoreboard per Post; the Product's logo.
