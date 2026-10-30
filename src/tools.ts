/**
 * What the transport needs to know about each Topped tool, read from the live
 * schema (`GET /api/v1/tools`): whether it changes anything (read-only calls
 * are safe to repeat), whether it takes the founder's `timeZone`, and whether
 * it takes a `requestId`. Nothing else:
 * the tools' own rules stay on the server. `topped call` reads the live list
 * for a tool this table does not know yet, so the CLI never lags the server.
 */

export interface ToolFacts {
  changes: boolean;
  timeZone?: boolean;
  requestId?: boolean;
}

const read: ToolFacts = { changes: false };
const change: ToolFacts = { changes: true };
const spend: ToolFacts = { changes: true, requestId: true };

/** The 41 tools, in the order Topped lists them. */
export const TOOLS: Readonly<Record<string, ToolFacts>> = {
  // Account
  get_balances: read,
  get_product: read,
  update_product: change,
  list_connected_accounts: read,
  connect_account: read,
  disconnect_account: change,
  // For You
  get_for_you_draft: read,
  pass_draft: change,
  approve_draft: spend,
  undo_approve: change,
  // Creator
  list_source_posts: read,
  list_starting_points: read,
  list_sounds: read,
  create_draft: change,
  edit_draft: spend,
  rewrite_draft: change,
  draft_caption: read,
  generate_media: spend,
  // Library
  list_saved_posts: read,
  get_post: read,
  publish_saved_post: spend,
  edit_saved_post: spend,
  delete_saved_post: change,
  list_media: read,
  upload_media: change,
  update_media: change,
  delete_media: change,
  restore_media: change,
  // Calendar and Scoreboard
  list_publish_runs: { changes: false, timeZone: true },
  get_publish_run: read,
  move_publish_run: { changes: true, timeZone: true },
  cancel_publish_run: change,
  retry_publish_run: { changes: true, timeZone: true, requestId: true },
  get_scoreboard: read,
  list_scoreboard_posts: read,
  refresh_metrics: read,
  // Watchlist
  list_watchlist: read,
  browse_watchlist: read,
  watch_account: change,
  unwatch_account: change,
  dismiss_suggested_account: change,
};

export const TIME_ZONE_INPUT = "timeZone";
export const REQUEST_ID_INPUT = "requestId";

/** One tool as `GET /api/v1/tools` lists it. */
export interface ToolListing {
  name: string;
  description?: string;
  inputSchema?: { properties?: Record<string, unknown> };
  annotations?: { readOnlyHint?: boolean };
}

/** The same facts, read from a live listing entry - for a tool this build does not know. */
export function factsFromListing(listing: ToolListing): ToolFacts {
  const properties = listing.inputSchema?.properties ?? {};
  const facts: ToolFacts = { changes: listing.annotations?.readOnlyHint !== true };
  if (TIME_ZONE_INPUT in properties) facts.timeZone = true;
  if (REQUEST_ID_INPUT in properties) facts.requestId = true;
  return facts;
}
