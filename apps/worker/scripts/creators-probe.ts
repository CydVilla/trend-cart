/**
 * Amazon Creators API eligibility probe.
 *
 * Usage:
 *   pnpm --filter @trendcart/worker probe:catalog
 *   pnpm --filter @trendcart/worker probe:catalog B0BXQGCYQ7 B08N5WRWNW
 *
 * Answers one question: can we actually call the catalog yet? Access needs an
 * approved Associates account AND 10 qualifying sales in the trailing 30 days,
 * with up to 48h of review after an app is created — so `AssociateNotEligible`
 * is the expected answer until Amazon opens the gate, and it says nothing
 * about whether the credentials are right.
 *
 * The exit code is the point: it makes this pollable rather than something to
 * remember to re-run.
 *
 *   0  eligible — the catalog answered
 *   1  not eligible yet (AssociateNotEligible) — credentials are fine, wait
 *   2  credential/auth problem — this one needs you, not time
 *   3  transient (network, 429, 5xx) — retry
 *   4  not configured (no CREATORS_API_CLIENT_ID / _SECRET)
 *
 * Poll until it opens:
 *   until pnpm --filter @trendcart/worker probe:catalog; do sleep 1800; done
 *
 * On success it prints the MAPPED item and the raw offers shape (the client
 * logs that once per process). Read both before trusting the price path:
 * mapItem()'s offersV2 field names were written against the docs, not against
 * a real response, so the first real payload is the thing that confirms them.
 */
import { config } from "../src/config.js";
import {
  CatalogAuthError,
  CatalogNotEligibleError,
  CatalogTransientError,
  createCatalogClient,
} from "../src/creators-api.js";

/** Zelda: Tears of the Kingdom — stable, always in catalog, always in stock. */
const DEFAULT_ASINS = ["B0BXQGCYQ7"];

async function main(): Promise<number> {
  const asins = process.argv.slice(2).filter((a) => /^[A-Z0-9]{10}$/i.test(a));
  const targets = asins.length > 0 ? asins.map((a) => a.toUpperCase()) : DEFAULT_ASINS;

  console.log("Amazon Creators API probe");
  console.log(`  credentials:  ${config.creatorsApi.enabled ? "present" : "MISSING"}`);
  console.log(`  partner tag:  ${config.creatorsApi.partnerTag || "(unset)"}`);
  console.log(`  marketplace:  ${config.creatorsApi.marketplace}`);
  console.log(`  region:       version ${config.creatorsApi.version}`);
  console.log(`  probing:      ${targets.join(", ")}\n`);

  const client = createCatalogClient();
  if (!client) {
    console.log("NOT CONFIGURED — set CREATORS_API_CLIENT_ID and CREATORS_API_CLIENT_SECRET.");
    console.log("These are a Credential ID/Secret pair from affiliate-program.amazon.com/creatorsapi,");
    console.log("NOT AWS keys — the old PA_API_ACCESS_KEY/SECRET_KEY path is dead.");
    return 4;
  }

  try {
    const items = await client.getItemsByAsin(targets);
    console.log(`ELIGIBLE — getItems returned ${items.size}/${targets.length} item(s).\n`);
    for (const [asin, item] of items) {
      console.log(`${asin}:`);
      console.log(JSON.stringify(item, null, 2));
    }
    const missing = targets.filter((a) => !items.has(a));
    if (missing.length > 0) {
      console.log(`\n(no data for ${missing.join(", ")} — bad ASIN, or not in this marketplace)`);
    }
    console.log(
      "\nNext: check the mapped price/availability fields above against the raw offers shape " +
        "logged by the client before flipping REPLY_PRODUCT_LINKS_ENABLED on.",
    );
    return 0;
  } catch (error) {
    if (error instanceof CatalogNotEligibleError) {
      console.log("NOT ELIGIBLE YET — AssociateNotEligible.");
      console.log("The OAuth token minted fine, so credentials and transport are good; this is");
      console.log("purely Amazon's gate: up to 48h of review after the app is created, plus a");
      console.log("standing requirement of 10 qualifying sales in the trailing 30 days.");
      return 1;
    }
    if (error instanceof CatalogAuthError) {
      console.log(`AUTH FAILED — ${error.message}`);
      console.log("This is a credential problem, not a waiting problem: re-check the Credential");
      console.log("ID/Secret pair and that the region (CREATORS_API_VERSION) matches the account.");
      return 2;
    }
    if (error instanceof CatalogTransientError) {
      console.log(`TRANSIENT — ${error.message}. Retry.`);
      return 3;
    }
    console.log(`UNEXPECTED — ${error instanceof Error ? error.message : String(error)}`);
    return 3;
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error);
    process.exit(3);
  },
);
