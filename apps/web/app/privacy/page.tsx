/**
 * Public privacy policy. Required by third-party developer platforms
 * (e.g. Pinterest app registration) and honest on its own terms: the public
 * surface collects almost nothing, and what it does collect is spelled out.
 */
export const metadata = {
  title: "TrendCart privacy policy",
  description: "What TrendCart's public pages and links collect, and what they don't.",
};

const CONTACT_EMAIL = "villacv@gmail.com";

export default function PrivacyPage() {
  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <p className="text-sm font-medium uppercase tracking-wide text-blue-700">TrendCart</p>
      <h1 className="mt-2 text-3xl font-bold tracking-tight">Privacy policy</h1>
      <p className="mt-2 text-sm text-zinc-500">Last updated July 29, 2026</p>

      <div className="mt-8 space-y-7 leading-7 text-zinc-700">
        <section>
          <h2 className="text-lg font-semibold">What TrendCart is</h2>
          <p className="mt-1">
            TrendCart is a single-operator, automated product-recommendation account. It posts
            product links on social platforms (such as Bluesky and Pinterest) and serves the
            short link redirects behind them. It has no user accounts, no sign-up, and no
            third-party users.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold">What is collected</h2>
          <p className="mt-1">
            When a shared link (a <code>/r/…</code> URL) is clicked, TrendCart records that a
            click happened: a timestamp, an aggregate counter, and whether the request looked
            automated (based on the user-agent header). That&apos;s the whole record. No name, no
            account, no IP address, no location, and no advertising identifier is stored.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold">Cookies</h2>
          <p className="mt-1">
            TrendCart&apos;s public pages and redirects set no cookies and use no trackers,
            analytics scripts, or fingerprinting. Amazon, and any social platform you reach
            TrendCart through, apply their own policies once you&apos;re on their sites.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold">Third parties</h2>
          <p className="mt-1">
            Product links lead to Amazon and carry an affiliate tag; as an Amazon Associate,
            TrendCart earns from qualifying purchases. Platform data TrendCart reads through
            official APIs (for example, engagement counts on its own posts) stays within those
            platforms&apos; developer terms and is used only to improve what the account posts.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold">Data sharing and retention</h2>
          <p className="mt-1">
            Nothing collected is sold, shared, or transferred to anyone. Aggregate click counts
            are kept indefinitely; they contain nothing personal.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold">Contact</h2>
          <p className="mt-1">
            Questions or requests:{" "}
            <a className="text-blue-700 underline" href={`mailto:${CONTACT_EMAIL}`}>
              {CONTACT_EMAIL}
            </a>
            .
          </p>
        </section>
      </div>
    </main>
  );
}
