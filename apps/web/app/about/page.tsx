/**
 * The bot's public transparency page — where @trend-cart.bsky.social's
 * profile link points. Disclosure + opt-out live here; the dashboard behind
 * basic auth is everything else.
 */
export const metadata = {
  title: "About TrendCart",
  description: "TrendCart is a disclosed Bluesky bot that recommends Amazon products.",
};

export default function AboutPage() {
  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <h1 className="text-3xl font-bold">TrendCart</h1>
      <p className="mt-2 text-zinc-500">
        The bot behind{" "}
        <a
          href="https://bsky.app/profile/trend-cart.bsky.social"
          className="underline hover:text-zinc-700"
        >
          @trend-cart.bsky.social
        </a>
      </p>

      <div className="mt-8 space-y-6 text-zinc-700">
        <section>
          <h2 className="text-lg font-semibold">What it is</h2>
          <p className="mt-1">
            TrendCart is an automated account (a bot, and it says so in its bio). When people on
            Bluesky are enthusiastic about a product or asking for recommendations, it may reply
            with a pointer to that product on Amazon. You can also tag the bot in any post to ask
            for a recommendation directly.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold">Affiliate disclosure</h2>
          <p className="mt-1">
            As an Amazon Associate, TrendCart earns from qualifying purchases. Links in the bot&apos;s
            replies go to Amazon and include an affiliate tag — if you buy something after clicking
            one, the operator may earn a commission at no extra cost to you.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold">Don&apos;t want replies?</h2>
          <p className="mt-1">
            Reply to the bot with <em>&ldquo;opt out&rdquo;</em> (or &ldquo;stop replying&rdquo;) and it will never
            reply to you again. Tagging the bot later re-invites it. Every reply is rate-limited,
            never sent under sensitive topics, and each account is contacted at most once a week
            unless it asks.
          </p>
        </section>
      </div>
    </main>
  );
}
