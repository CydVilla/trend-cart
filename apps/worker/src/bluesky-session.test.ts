import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { blueskyBackingOff, isPermanentPostError, noteBlueskyUp } from "./bluesky-health.js";
import {
  createBlueskySession,
  LOGIN_RETRY_MS,
  MAX_LOGIN_FAILURES,
  type LoginAgent,
} from "./bluesky-session.js";

const CREDS = { identifier: "bot.test", password: "app-password" };

/** XRPCError-shaped failures, as @atproto/api throws them. */
function xrpc(status: number, error: string, message = error): Error {
  return Object.assign(new Error(message), { status, error });
}

class FakeAgent implements LoginAgent {
  hasSession = false;
  constructor(private readonly outcome: () => Promise<void>) {}
  async login(): Promise<void> {
    await this.outcome();
    this.hasSession = true;
  }
}

/** A session whose logins follow `outcomes` in order; counts agents made. */
function harness(outcomes: Array<() => Promise<void>>) {
  let clock = 1_000_000;
  const made: FakeAgent[] = [];
  const session = createBlueskySession(
    CREDS,
    () => {
      const next = outcomes.shift() ?? (async () => {});
      const agent = new FakeAgent(next);
      made.push(agent);
      return agent;
    },
    () => clock,
  );
  return { session, made, advance: (ms: number) => (clock += ms) };
}

// Backoff is worker-wide module state — never leak an armed window.
afterEach(() => noteBlueskyUp());

test("concurrent loops share one login, and later ticks reuse it", async () => {
  const { session, made } = harness([]);
  const [a, b, c] = await Promise.all([session.agent(), session.agent(), session.agent()]);
  assert.ok(a);
  assert.equal(a, b);
  assert.equal(b, c);
  assert.equal(await session.agent(), a);
  assert.equal(made.length, 1, "six loops at boot must open one session, not six");
});

test("a session the SDK dropped (refresh token expired) logs in again", async () => {
  const { session, made } = harness([]);
  const first = await session.agent();
  assert.ok(first);
  first.hasSession = false; // what CredentialSession does on ExpiredToken refresh
  const second = await session.agent();
  assert.ok(second);
  assert.notEqual(second, first);
  assert.equal(made.length, 2);
});

test("a caller seeing a dead-session error forces a fresh login", async () => {
  const { session, made } = harness([]);
  const first = await session.agent();
  assert.equal(session.noteSessionLost(xrpc(400, "ExpiredToken", "Token has expired")), true);
  assert.notEqual(await session.agent(), first);
  assert.equal(made.length, 2);
  // An ordinary refusal is not a session problem.
  assert.equal(session.noteSessionLost(xrpc(400, "InvalidRequest", "record not found")), false);
});

test("an outage during login backs off and never counts toward the disable", async () => {
  const outage = async () => {
    throw xrpc(504, "GatewayTimeout", "gateway timeout");
  };
  const { session, made } = harness(Array.from({ length: MAX_LOGIN_FAILURES + 1 }, () => outage));
  assert.equal(await session.agent(), null);
  assert.equal(blueskyBackingOff(), true);
  // While backing off, nothing even attempts a login.
  assert.equal(await session.agent(), null);
  assert.equal(made.length, 1);
  for (let i = 0; i < MAX_LOGIN_FAILURES; i++) {
    noteBlueskyUp();
    await session.agent();
  }
  assert.equal(session.disabled(), false, "a 504 spate must never disable posting");
});

test("bad credentials disable login after the limit, spaced by the retry gap", async () => {
  const badPassword = async () => {
    throw xrpc(401, "AuthenticationRequired", "Invalid identifier or password");
  };
  const { session, made, advance } = harness(
    Array.from({ length: MAX_LOGIN_FAILURES + 1 }, () => badPassword),
  );
  assert.equal(await session.agent(), null);
  // Other loops ticking inside the gap must not burn the remaining attempts.
  assert.equal(await session.agent(), null);
  assert.equal(made.length, 1);
  for (let i = 1; i < MAX_LOGIN_FAILURES; i++) {
    advance(LOGIN_RETRY_MS);
    assert.equal(await session.agent(), null);
  }
  assert.equal(made.length, MAX_LOGIN_FAILURES);
  assert.equal(session.disabled(), true);
  advance(LOGIN_RETRY_MS);
  assert.equal(await session.agent(), null);
  assert.equal(made.length, MAX_LOGIN_FAILURES, "disabled means no more createSession calls");
});

test("a login success resets the failure count", async () => {
  const badPassword = async () => {
    throw xrpc(401, "AuthenticationRequired", "Invalid identifier or password");
  };
  const { session, advance } = harness([badPassword, badPassword, async () => {}]);
  await session.agent();
  advance(LOGIN_RETRY_MS);
  await session.agent();
  advance(LOGIN_RETRY_MS);
  const agent = await session.agent();
  assert.ok(agent);
  agent.hasSession = false;
  // Two more failures would have tripped the limit without the reset.
  assert.ok(await session.agent());
  assert.equal(session.disabled(), false);
});

test("isPermanentPostError: refusals fail now; outages and dead sessions never do", () => {
  assert.equal(isPermanentPostError(new Error("Post not found")), true);
  assert.equal(isPermanentPostError(new Error("Reply is blocked by the author")), true);
  // "InvalidToken" contains "invalid" — the old message regex would have
  // permanently failed every reply touched by an expired session.
  assert.equal(isPermanentPostError(xrpc(400, "InvalidToken", "Invalid token")), false);
  assert.equal(isPermanentPostError(xrpc(400, "ExpiredToken", "Token has expired")), false);
  assert.equal(
    isPermanentPostError(xrpc(502, "UpstreamFailure", "upstream invalid response")),
    false,
  );
  assert.equal(isPermanentPostError(new Error("network timeout")), false);
});
