/** Public conversion + transparency page linked from the bot's profile. */
export const metadata = {
  title: "Ask TrendCart for a product recommendation",
  description:
    "Ask TrendCart on Bluesky for one relevant Amazon recommendation by product, budget, and device or use.",
  openGraph: {
    title: "Ask TrendCart for a product recommendation",
    description:
      "Tell the bot what you need, your budget, and where you'll use it. Automated, affiliate-funded, and easy to opt out.",
    type: "website",
  },
};

const handle = process.env.BOT_ACCOUNT_HANDLE || "trend-cart.bsky.social";
const profileUrl = `https://bsky.app/profile/${handle}`;
const askTemplate =
  `@${handle} I'm looking for [product] under $[budget] for [device/use]. ` +
  "Must-have: [feature].";
const composeUrl = `https://bsky.app/intent/compose?text=${encodeURIComponent(askTemplate)}`;

const examples = [
  "Switch controller under $50 for smaller hands",
  "1TB SSD for PS5 under $100",
  "Gift for a Zelda fan under $75",
];

export default function AboutPage() {
  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <p className="text-sm font-medium uppercase tracking-wide text-blue-700">TrendCart</p>
      <h1 className="mt-2 text-3xl font-bold tracking-tight sm:text-4xl">
        Tell the bot what you&apos;re shopping for.
      </h1>
      <p className="mt-4 text-lg leading-8 text-zinc-600">
        Give TrendCart a product, a budget, and the device or situation it needs to fit. If there
        is one confident match, the bot will reply on Bluesky with one relevant Amazon link.
      </p>

      <div className="mt-7 flex flex-wrap gap-3">
        <a
          href={composeUrl}
          className="rounded-lg bg-blue-700 px-5 py-3 text-sm font-semibold text-white shadow-sm hover:bg-blue-600"
        >
          Ask TrendCart on Bluesky
        </a>
        <a
          href={profileUrl}
          className="rounded-lg border border-zinc-300 bg-white px-5 py-3 text-sm font-semibold text-zinc-800 hover:bg-zinc-100"
        >
          See the latest verified deals
        </a>
      </div>

      <section className="mt-9 rounded-xl border border-zinc-200 bg-white p-5">
        <h2 className="font-semibold">A useful request includes three things</h2>
        <ol className="mt-3 grid gap-2 text-sm text-zinc-700 sm:grid-cols-3">
          <li><strong>1. Product</strong><br />What you need</li>
          <li><strong>2. Budget</strong><br />Your comfortable maximum</li>
          <li><strong>3. Fit</strong><br />Device, use, or must-have feature</li>
        </ol>
        <div className="mt-5 space-y-2 border-t border-zinc-100 pt-4 text-sm text-zinc-600">
          {examples.map((example) => (
            <p key={example}>&ldquo;{example}&rdquo;</p>
          ))}
        </div>
      </section>

      <div className="mt-10 space-y-7 text-zinc-700">
        <section>
          <h2 className="text-lg font-semibold">Affiliate disclosure</h2>
          <p className="mt-1 leading-7">
            TrendCart is an automated account. As an Amazon Associate, TrendCart earns from
            qualifying purchases made through its links, at no extra cost to the buyer. Commercial
            profile posts carry an in-post <strong>#ad</strong> disclosure.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold">How autonomous deals are checked</h2>
          <p className="mt-1 leading-7">
            Without Amazon&apos;s Product Advertising API, TrendCart never repeats a third-party
            price or percentage. An autonomous alert posts only when strict verification finds
            fresh evidence that the exact Amazon product is currently discounted. If that cannot
            be established, the bot stays silent. Always confirm the current price and
            availability on Amazon before buying.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold">Don&apos;t want replies?</h2>
          <p className="mt-1 leading-7">
            Reply to the bot with <em>&ldquo;opt out&rdquo;</em> or &ldquo;stop replying&rdquo; and it will
            stop. Tagging the bot later re-invites it. Unsolicited replies are tightly
            rate-limited; direct requests are treated as solicited conversations.
          </p>
        </section>
      </div>
    </main>
  );
}
