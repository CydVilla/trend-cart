import { AtpAgent } from "@atproto/api";
import { createBlueskySession } from "./bluesky-session.js";
import { config } from "./config.js";

/**
 * The worker's one Bluesky session (see bluesky-session.ts for the policy).
 * Nothing logs in at import: the first loop to need it does, so a boot with
 * every Bluesky loop disabled never opens a session at all.
 */
const session = createBlueskySession(
  { identifier: config.bluesky.handle, password: config.bluesky.appPassword },
  () => new AtpAgent({ service: "https://bsky.social" }),
);

export const blueskyAgent = session.agent;
export const blueskyLoginDisabled = session.disabled;
export const noteBlueskySessionLost = session.noteSessionLost;
