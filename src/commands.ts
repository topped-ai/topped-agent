/**
 * Every command: spec §11's set, each mapping to exactly one Topped tool,
 * plus the sign-in commands, `topped tools` and `topped call`. A command's
 * positional arguments and flags become its tool's input fields, named as
 * the live schema names them (`GET /api/v1/tools`); `--json` carries a
 * structured field where §11 says so. Nothing here decides what Topped
 * accepts: a tool's refusal comes back as it is.
 */

import { isoWeekMonday } from "./week.js";
import { usageError } from "./output.js";

export type FlagKind =
  /** `--flag <value>` */
  | "string"
  /** `--flag <n>`, a whole number */
  | "int"
  /** `--flag <n>`, any number */
  | "number"
  /** `--flag`, true when present */
  | "boolean"
  /** `--flag` true, `--no-flag` false */
  | "negatable"
  /** `--flag a,b` */
  | "list"
  /** `--flag <value>`, or `--no-flag` for null */
  | "nullable";

export interface FlagSpec {
  name: string;
  kind: FlagKind;
  /** The tool input field it sets; absent when the command reads it itself. */
  field?: string;
  value?: string;
  required?: boolean;
  help: string;
}

export interface ArgSpec {
  name: string;
  placeholder: string;
  /** The tool input field it sets; absent when the command reads it itself. */
  field?: string;
  choices?: readonly string[];
}

export interface JsonSpec {
  /** The input field the document fills, or `null` when it is the whole input. */
  field: string | null;
  required: boolean;
  help: string;
}

/** What a command's own reading of the flags adds to the input. */
export type Build = (
  flags: Readonly<Record<string, unknown>>,
  args: Readonly<Record<string, string>>,
) => Record<string, unknown>;

export interface CommandSpec {
  words: readonly string[];
  /** The one tool it runs; `null` for the commands that run none. */
  tool: string | null;
  usage: string;
  summary: string;
  args: readonly ArgSpec[];
  flags: readonly FlagSpec[];
  json?: JsonSpec;
  /** Fixed inputs, such as a positional that names the kind. */
  build?: Build;
  /** Flags whose file the command reads as JSON and merges (only these keys). */
  platformJson?: boolean;
}

const PLATFORMS = ["tiktok", "instagram", "youtube"] as const;

const draftId: ArgSpec = { name: "draftId", placeholder: "<draftId>", field: "draftId" };
const postId: ArgSpec = { name: "postId", placeholder: "<postId>", field: "postId" };
const runId: ArgSpec = { name: "runId", placeholder: "<runId>", field: "publishRunId" };
const mediaId: ArgSpec = { name: "mediaId", placeholder: "<mediaId>", field: "mediaId" };

const cursor: FlagSpec = {
  name: "cursor",
  kind: "string",
  field: "cursor",
  value: "<cursor>",
  help: "The nextCursor from the page before; leave it out for the first page.",
};
const limit: FlagSpec = { name: "limit", kind: "int", field: "limit", value: "<n>", help: "How many to list (1-50)." };
const accounts: FlagSpec = {
  name: "accounts",
  kind: "list",
  field: "connectionIds",
  value: "<a,b>",
  help: "The connected accounts to post to, by connectionId (topped accounts).",
};
const caption: FlagSpec = {
  name: "caption",
  kind: "string",
  field: "caption",
  value: "<text>",
  help: "One caption for every account, up to 2,200 characters.",
};
const platformJson: FlagSpec = {
  name: "platform-json",
  kind: "string",
  value: "<file|->",
  help: 'A JSON file with the platform settings: { "tiktok": [...], "youtube": {...} }. TikTok needs every choice as the founder made it.',
};
const format: FlagSpec = {
  name: "format",
  kind: "string",
  field: "format",
  value: "<slideshow|wall_of_text|demo_video>",
  required: true,
  help: "The Format.",
};
const handle: FlagSpec = {
  name: "handle",
  kind: "string",
  field: "handle",
  value: "<handle>",
  required: true,
  help: "The handle exactly as topped watchlist returned it; nothing changes unless it matches.",
};
const fromSlot: FlagSpec = {
  name: "from-slot",
  kind: "string",
  field: "fromSlot",
  value: "<iso>",
  required: true,
  help: "The slot exactly as topped runs returned it; nothing changes unless the Post is still there.",
};
const at: FlagSpec = {
  name: "at",
  kind: "string",
  field: "at",
  value: "<iso>",
  help: "The new time, an ISO time with its offset, such as 2026-10-02T18:30:00-04:00.",
};
const toDay: FlagSpec = {
  name: "to-day",
  kind: "string",
  field: "toDay",
  value: "<YYYY-MM-DD>",
  help: "Instead of --at: the day, on the founder's own calendar.",
};

/** `--save | --post-now | --schedule <iso>`: exactly one, as the tool's `exit` (and `at`). */
function exitChoice(allowed: readonly ("save" | "post-now" | "schedule")[]): Build {
  return (flags) => {
    const chosen = allowed.filter((name) => flags[name] !== undefined);
    const usage = allowed.map((name) => (name === "schedule" ? "--schedule <iso>" : `--${name}`)).join(" | ");
    if (chosen.length !== 1) throw usageError(`Choose exactly one of ${usage}.`);
    const choice = chosen[0]!;
    if (choice === "schedule") return { exit: "schedule", at: flags.schedule };
    return { exit: choice === "post-now" ? "post_now" : "save" };
  };
}

const saveFlag: FlagSpec = { name: "save", kind: "boolean", help: "Save it to the Library." };
const postNowFlag: FlagSpec = { name: "post-now", kind: "boolean", help: "Post it now to --accounts." };
const scheduleFlag: FlagSpec = {
  name: "schedule",
  kind: "string",
  value: "<iso>",
  help: "Schedule it to --accounts at this time, within 30 days (an ISO time with its offset).",
};

export const COMMANDS: readonly CommandSpec[] = [
  // Signing in
  {
    words: ["login"],
    tool: null,
    usage: "topped login [--no-browser] [--port <n>]",
    summary: "Sign in with your browser (Log in with Topped) and keep the sign-in on this machine.",
    args: [],
    flags: [
      { name: "no-browser", kind: "boolean", help: "Print the sign-in link on stderr without opening a browser." },
      {
        name: "port",
        kind: "int",
        value: "<n>",
        help: "Wait for the browser on this port of 127.0.0.1, so a tunnel from another machine (ssh -L <n>:127.0.0.1:<n>) can reach it.",
      },
    ],
  },
  {
    words: ["logout"],
    tool: null,
    usage: "topped logout",
    summary: "Forget the sign-in kept on this machine.",
    args: [],
    flags: [],
  },
  {
    words: ["whoami"],
    tool: null,
    usage: "topped whoami",
    summary: "Which key or signed-in app this is, whose Product it acts on, and where the credential came from.",
    args: [],
    flags: [],
  },

  // Account
  {
    words: ["balances"],
    tool: "get_balances",
    usage: "topped balances",
    summary: "Credits and content saves left, the plan, and today's For You use.",
    args: [],
    flags: [],
  },
  {
    words: ["product"],
    tool: "get_product",
    usage: "topped product",
    summary: "The Product Profile and Voice settings.",
    args: [],
    flags: [],
  },
  {
    words: ["product", "update"],
    tool: "update_product",
    usage: "topped product update --json <file|->",
    summary: "Change the Product; on a new account, set it up (name and oneLiner).",
    args: [],
    flags: [],
    json: { field: null, required: true, help: "The fields to change, as update_product takes them." },
  },
  {
    words: ["accounts"],
    tool: "list_connected_accounts",
    usage: "topped accounts [--post <postId>]",
    summary: "Connected TikTok, Instagram and YouTube accounts; with --post, what each accepts for that Post.",
    args: [],
    flags: [{ name: "post", kind: "string", field: "postId", value: "<postId>", help: "A Post's id, to read what each account accepts for it." }],
  },
  {
    words: ["accounts", "connect"],
    tool: "connect_account",
    usage: "topped accounts connect <tiktok|instagram|youtube> [--reconnect <connectionId>]",
    summary: "A link the founder opens to connect (or reconnect) an account.",
    args: [{ name: "platform", placeholder: "<tiktok|instagram|youtube>", field: "platform", choices: PLATFORMS }],
    flags: [{ name: "reconnect", kind: "string", field: "connectionId", value: "<connectionId>", help: "Reconnect this account instead." }],
  },
  {
    words: ["accounts", "disconnect"],
    tool: "disconnect_account",
    usage: "topped accounts disconnect <connectionId> --platform <tiktok|instagram|youtube> --handle <handle>|--no-handle",
    summary: "Disconnect an account; its Publications that haven't gone out are cancelled.",
    args: [{ name: "connectionId", placeholder: "<connectionId>", field: "connectionId" }],
    flags: [
      { name: "platform", kind: "string", field: "platform", value: "<tiktok|instagram|youtube>", required: true, help: "The account's platform, as topped accounts returned it." },
      { name: "handle", kind: "nullable", field: "handle", value: "<handle>", required: true, help: "The account's handle as topped accounts returned it; --no-handle when it has none." },
    ],
  },

  // For You
  {
    words: ["for-you"],
    tool: "get_for_you_draft",
    usage: "topped for-you",
    summary: "The current For You Draft, with its Based on and every slide or the video.",
    args: [],
    flags: [],
  },
  {
    words: ["for-you", "edit"],
    tool: "edit_for_you_draft",
    usage: "topped for-you edit <draftId> --json <file|->",
    summary: "Change the current For You Draft's words, looks, photos, Sound or trim.",
    args: [draftId],
    flags: [],
    json: { field: "changes", required: true, help: "The changes, as edit_for_you_draft's changes field takes them." },
  },
  {
    words: ["pass"],
    tool: "pass_draft",
    usage: "topped pass <draftId>",
    summary: "Pass on the current For You Draft. Free, and final.",
    args: [draftId],
    flags: [],
  },
  {
    words: ["approve"],
    tool: "approve_draft",
    usage:
      "topped approve <draftId> --save | --post-now --accounts <a,b> | --schedule <iso> --accounts <a,b> [--caption <text>] [--platform-json <file|->]",
    summary: "Approve a Draft: Save it, Post it now or Schedule it. Spends one content save.",
    args: [draftId],
    flags: [saveFlag, postNowFlag, scheduleFlag, accounts, caption, platformJson],
    build: exitChoice(["save", "post-now", "schedule"]),
    platformJson: true,
  },
  {
    words: ["undo"],
    tool: "undo_approve",
    usage: "topped undo <draftId>",
    summary: "Undo an approval within 5 minutes, while nothing has gone out; the content save comes back.",
    args: [draftId],
    flags: [],
  },

  // Creator
  {
    words: ["sources"],
    tool: "list_source_posts",
    usage: "topped sources --format <slideshow|wall_of_text|demo_video> [--cursor <cursor>]",
    summary: "Source posts Creator offers for a Format, with their raw counts.",
    args: [],
    flags: [format, cursor],
  },
  {
    words: ["starting-points"],
    tool: "list_starting_points",
    usage: "topped starting-points --format <slideshow|wall_of_text|demo_video> [--cursor <cursor>]",
    summary: "Starting points for a Format: photo sets, backgrounds or openers.",
    args: [],
    flags: [format, cursor],
  },
  {
    words: ["sounds"],
    tool: "list_sounds",
    usage: "topped sounds [--cursor <cursor>]",
    summary: "Topped's sounds and the founder's own.",
    args: [],
    flags: [cursor],
  },
  {
    words: ["draft", "create"],
    tool: "create_draft",
    usage: "topped draft create --json <file|->",
    summary: "Make a Creator Draft from a source post, or your own. Free.",
    args: [],
    flags: [],
    json: { field: null, required: true, help: "The Draft, as create_draft takes it: fromSourcePost or makeYourOwn." },
  },
  {
    words: ["draft", "edit"],
    tool: "edit_draft",
    usage: "topped draft edit <draftId> --json <file|->",
    summary: "Change a Draft you made: send the whole Post. Free.",
    args: [draftId],
    flags: [],
    json: { field: "composition", required: true, help: "The whole Post, as edit_draft's composition field takes it." },
  },
  {
    words: ["draft", "rewrite"],
    tool: "rewrite_draft",
    usage: "topped draft rewrite <draftId> [--steer <text>] [--mention | --no-mention] [--previous-idea <ideaId>]",
    summary: "Topped's writer rewrites a Draft's words. Free.",
    args: [draftId],
    flags: [
      { name: "steer", kind: "string", field: "steer", value: "<text>", help: 'What to change, like "shorter" or "about dark mode".' },
      { name: "mention", kind: "negatable", field: "mention", help: "Name the Product in the words (--no-mention keeps it out)." },
      { name: "previous-idea", kind: "string", field: "previousIdeaId", value: "<ideaId>", help: "The ideaId the last rewrite returned, for a different idea." },
    ],
  },
  {
    words: ["caption"],
    tool: "draft_caption",
    usage: "topped caption --format <slideshow|video> [--avoid <text>] [--platforms <a,b>] [--attempt <n>]",
    summary: "Topped writes a caption for a Post. Plus and Pro.",
    args: [],
    flags: [
      { name: "format", kind: "string", field: "format", value: "<slideshow|video>", required: true, help: "slideshow, or video for Wall of text and Demo video." },
      { name: "avoid", kind: "string", field: "avoid", value: "<text>", help: "A caption you already have; Topped writes a different one." },
      { name: "platforms", kind: "list", field: "platforms", value: "<a,b>", help: "Where the Post will go." },
      { name: "attempt", kind: "int", field: "attempt", value: "<n>", help: "1, 2, 3... for a fresh angle each time." },
    ],
  },
  {
    words: ["generate"],
    tool: "generate_media",
    usage:
      "topped generate <image|video> --prompt <text> [--expected-credits <n>] [--model <model>] [--length <seconds>] [--starting-image <mediaId>]",
    summary: "A Playground image or video. Spends credits: without --expected-credits, nothing is made and the price comes back.",
    args: [{ name: "kind", placeholder: "<image|video>", field: "kind", choices: ["image", "video"] }],
    flags: [
      { name: "prompt", kind: "string", field: "prompt", value: "<text>", required: true, help: "What to make." },
      { name: "expected-credits", kind: "int", field: "expectedCredits", value: "<n>", help: "The exact price in credits, from the first call." },
      { name: "model", kind: "string", field: "model", value: "<model>", help: "The model; topped tools lists them with their prices." },
      { name: "length", kind: "int", field: "lengthSeconds", value: "<seconds>", help: "A video's length in whole seconds." },
      { name: "starting-image", kind: "string", field: "startingImageId", value: "<mediaId>", help: "A video only: a Playground image to start from." },
    ],
  },

  // Library
  {
    words: ["saved"],
    tool: "list_saved_posts",
    usage: "topped saved [--cursor <cursor>] [--limit <n>]",
    summary: "Saved Posts in the Library, newest first.",
    args: [],
    flags: [cursor, limit],
  },
  {
    words: ["post"],
    tool: "get_post",
    usage: "topped post <postId>",
    summary: "One Post in full: Poster, slides or video, Based on, render status and Publish runs.",
    args: [postId],
    flags: [],
  },
  {
    words: ["saved", "publish"],
    tool: "publish_saved_post",
    usage:
      "topped saved publish <postId> --post-now | --schedule <iso> --accounts <a,b> [--caption <text>] [--platform-json <file|->]",
    summary: "Post or schedule a Saved Post again. Free.",
    args: [postId],
    flags: [postNowFlag, scheduleFlag, accounts, caption, platformJson],
    build: exitChoice(["post-now", "schedule"]),
    platformJson: true,
  },
  {
    words: ["saved", "edit"],
    tool: "edit_saved_post",
    usage: "topped saved edit <postId> --json <file|-> [--save-as-new]",
    summary: "Re-edit a Saved Post. New media makes a second Saved Post and spends one content save, only with --save-as-new.",
    args: [postId],
    flags: [{ name: "save-as-new", kind: "boolean", field: "saveAsNew", help: "Agree to spend one content save when the changes bring new media." }],
    json: { field: "post", required: true, help: "The post field of topped post's answer, with your changes." },
  },
  {
    words: ["saved", "delete"],
    tool: "delete_saved_post",
    usage: "topped saved delete <postId>",
    summary: "Remove a Saved Post from the Library.",
    args: [postId],
    flags: [],
  },
  {
    words: ["media"],
    tool: "list_media",
    usage: "topped media [--kind <image|clip|demo|sound>] [--cursor <cursor>] [--limit <n>]",
    summary: "Images, clips, Demos and sounds in the Library, with their ids.",
    args: [],
    flags: [
      { name: "kind", kind: "string", field: "kind", value: "<image|clip|demo|sound>", help: "Only this kind." },
      cursor,
      limit,
    ],
  },
  {
    words: ["upload"],
    tool: "upload_media",
    usage:
      "topped upload <file> [--demo] [--duration <seconds>] [--poster <jpg>] [--title <name>] [--rights-confirmed]",
    summary: "Upload an image, clip, Demo or sound to the Library and get its id.",
    args: [{ name: "file", placeholder: "<file>" }],
    flags: [
      { name: "demo", kind: "boolean", help: "A screen recording of the Product (up to 30 seconds), used as a Demo." },
      { name: "duration", kind: "number", value: "<seconds>", help: "A clip's length, when it can't be read from its MP4 or MOV header." },
      { name: "poster", kind: "string", value: "<jpg>", help: "A clip's cover: one JPEG frame, up to 1 MB." },
      { name: "title", kind: "string", value: "<name>", help: "A sound's name in Your sounds." },
      { name: "rights-confirmed", kind: "boolean", help: "A sound: the founder confirms they have the rights to use it wherever they publish it." },
    ],
  },
  {
    words: ["media", "demo"],
    tool: "update_media",
    usage: "topped media demo <mediaId> --on | --off",
    summary: "Use a clip as a Demo, or stop.",
    args: [mediaId],
    flags: [
      { name: "on", kind: "boolean", help: "Use it as a Demo." },
      { name: "off", kind: "boolean", help: "Stop using it as a Demo." },
    ],
    build: (flags) => {
      if ((flags.on === true) === (flags.off === true)) throw usageError("Choose exactly one of --on | --off.");
      return { demo: flags.on === true };
    },
  },
  {
    words: ["media", "delete"],
    tool: "delete_media",
    usage: "topped media delete <mediaId>",
    summary: "Delete an image or clip for good.",
    args: [mediaId],
    flags: [],
  },

  // Calendar and Scoreboard
  {
    words: ["runs"],
    tool: "list_publish_runs",
    usage: "topped runs [--week <YYYY-MM-DD|YYYY-Www>] [--account <connectionId>] [--cursor <cursor>]",
    summary: "Posts on the Calendar - scheduled, posted and failed - for a week, or one account's.",
    args: [],
    flags: [
      { name: "week", kind: "string", value: "<YYYY-MM-DD|YYYY-Www>", help: "Any day of the week, or an ISO week such as 2026-W40. Left out, this week." },
      { name: "account", kind: "string", field: "connectionId", value: "<connectionId>", help: "Only this connected account's Posts." },
      cursor,
    ],
    build: (flags) => (typeof flags.week === "string" ? { week: isoWeekMonday(flags.week) } : {}),
  },
  {
    words: ["run"],
    tool: "get_publish_run",
    usage: "topped run <runId>",
    summary: "One Publish run's accounts and their results.",
    args: [runId],
    flags: [],
  },
  {
    words: ["run", "move"],
    tool: "move_publish_run",
    usage: "topped run move <runId> --from-slot <iso> --at <iso> | --to-day <YYYY-MM-DD> [--to-time <HH:MM>]",
    summary: "Move a scheduled Post to another day and time within 30 days.",
    args: [runId],
    flags: [
      fromSlot,
      at,
      toDay,
      { name: "to-time", kind: "string", field: "toTime", value: "<HH:MM>", help: "With --to-day: the time of day; left out, the Post's own." },
    ],
  },
  {
    words: ["run", "cancel"],
    tool: "cancel_publish_run",
    usage: "topped run cancel <runId> --slot <iso>",
    summary: "Cancel a scheduled Post before it goes out. It stays in the Library; no content save comes back.",
    args: [runId],
    flags: [
      { name: "slot", kind: "string", field: "slot", value: "<iso>", required: true, help: "The slot exactly as topped runs returned it." },
    ],
  },
  {
    words: ["run", "retry"],
    tool: "retry_publish_run",
    usage: "topped run retry <runId> --from-slot <iso> --at <iso> | --to-day <YYYY-MM-DD> --to-time <HH:MM>",
    summary: "Try a Post that couldn't post again at a new time, on the accounts it failed on. Free.",
    args: [runId],
    flags: [
      fromSlot,
      at,
      toDay,
      { name: "to-time", kind: "string", field: "toTime", value: "<HH:MM>", help: "With --to-day: the time of day." },
    ],
  },
  {
    words: ["scoreboard"],
    tool: "get_scoreboard",
    usage: "topped scoreboard [--account <connectionId>]",
    summary: "Real platform-reported counts and totals, overall and per account.",
    args: [],
    flags: [{ name: "account", kind: "string", field: "connectionId", value: "<connectionId>", help: "Only this account's numbers." }],
  },
  {
    words: ["scoreboard", "refresh"],
    tool: "refresh_metrics",
    usage: "topped scoreboard refresh [--accounts <a,b>] [--run <runId>]",
    summary: "Re-read the latest counts from the platforms.",
    args: [],
    flags: [
      { name: "accounts", kind: "list", field: "connectionIds", value: "<a,b>", help: "Only recent Posts on these accounts." },
      { name: "run", kind: "string", field: "publishRunId", value: "<runId>", help: "Every account of this one Post instead." },
    ],
  },

  // Watchlist
  {
    words: ["watchlist"],
    tool: "list_watchlist",
    usage: "topped watchlist",
    summary: "Watched accounts and suggested accounts.",
    args: [],
    flags: [],
  },
  {
    words: ["watchlist", "browse"],
    tool: "browse_watchlist",
    usage: "topped watchlist browse <watchlistHandleId>",
    summary: "A watched Creator's newest Posts with their raw counts.",
    args: [{ name: "watchlistHandleId", placeholder: "<watchlistHandleId>", field: "watchlistHandleId" }],
    flags: [],
  },
  {
    words: ["watchlist", "watch"],
    tool: "watch_account",
    usage: "topped watchlist watch <tiktok|instagram|youtube> <handle>",
    summary: "Watch an account, or accept a suggested one.",
    args: [
      { name: "platform", placeholder: "<tiktok|instagram|youtube>", field: "platform", choices: PLATFORMS },
      { name: "handle", placeholder: "<handle>", field: "handle" },
    ],
    flags: [],
  },
  {
    words: ["watchlist", "unwatch"],
    tool: "unwatch_account",
    usage: "topped watchlist unwatch <watchlistHandleId> --handle <handle>",
    summary: "Stop watching a Creator; their history is kept.",
    args: [{ name: "watchlistHandleId", placeholder: "<watchlistHandleId>", field: "watchlistHandleId" }],
    flags: [handle],
  },
  {
    words: ["watchlist", "dismiss"],
    tool: "dismiss_suggested_account",
    usage: "topped watchlist dismiss <suggestionId> --handle <handle>",
    summary: "Dismiss a suggested account for good.",
    args: [{ name: "suggestionId", placeholder: "<suggestionId>", field: "suggestionId" }],
    flags: [handle],
  },

  // Any tool
  {
    words: ["tools"],
    tool: null,
    usage: "topped tools",
    summary: "Every Topped tool with its input schema, live from Topped.",
    args: [],
    flags: [],
  },
  {
    words: ["call"],
    tool: null,
    usage: "topped call <tool> [--json <file|->]",
    summary: "Run any Topped tool by its own name, with its input as JSON.",
    args: [{ name: "tool", placeholder: "<tool>" }],
    flags: [],
    json: { field: null, required: false, help: "The tool's input, as topped tools lists it." },
  },
];
