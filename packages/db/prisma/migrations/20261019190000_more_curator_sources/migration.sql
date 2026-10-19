-- More curator accounts (ADR-0017). Picked 2026-10-19 by running each
-- account's last 40 Amazon-linked posts through the real curator pipeline
-- (single-ASIN resolution, product extraction, heuristic lanes):
--   Nintendeal   27/29 relayable, 26 in a high-conversion lane (Switch-heavy)
--   preternia    13/16 relayable, 10 in a lane (figures, LEGO, collectibles)
--   Frack's Sonic Deals  3/5 relayable, low volume, on-lane
-- Overlap with Wario64 is harmless: the per-ASIN listing cooldown posts a
-- deal once whichever curator surfaces it first. All share the CURATED
-- budget (DEAL_CURATED_MAX_POSTS_PER_DAY). Operator edits win: never
-- overwrite an existing row.
INSERT INTO "DealSuggestionSource" ("id", "name", "url", "topic", "includeKeywords", "excludeKeywords", "isActive", "updatedAt")
VALUES
  (
    'src_bsky_nintendeal',
    'Nintendeal (Bluesky)',
    'https://bsky.app/profile/nintendeal.com',
    'Deals the Nintendeal curator account posts: Nintendo Switch and Switch 2 games (physical releases), pre-orders, amiibo and accessories, plus some PlayStation/Xbox games and physical movies.',
    ARRAY[]::TEXT[],
    ARRAY['likely an error', 'price error', 'pricing error', 'price mistake', 'ymmv', 'in-store', 'in store only', 'targeted', 'trade-in', 'trade in', 'digital code', 'eshop']::TEXT[],
    true,
    CURRENT_TIMESTAMP
  ),
  (
    'src_bsky_preternia',
    'preternia (Bluesky)',
    'https://bsky.app/profile/preternia.com',
    'Deals and pre-orders the preternia toy-news account posts: action figures, LEGO sets, collectibles and fandom merchandise.',
    ARRAY[]::TEXT[],
    ARRAY['likely an error', 'price error', 'pricing error', 'price mistake', 'ymmv', 'in-store', 'in store only', 'targeted', 'trade-in', 'trade in', 'ebay']::TEXT[],
    true,
    CURRENT_TIMESTAMP
  ),
  (
    'src_bsky_frack_deals',
    'Frack''s Sonic Deals (Bluesky)',
    'https://bsky.app/profile/frack.deals',
    'Sonic the Hedgehog deals the Frack curator account posts: figures, games, Blu-rays and steelbooks, and collectibles.',
    ARRAY[]::TEXT[],
    ARRAY['likely an error', 'price error', 'pricing error', 'price mistake', 'ymmv', 'in-store', 'in store only', 'targeted', 'trade-in', 'trade in']::TEXT[],
    true,
    CURRENT_TIMESTAMP
  )
ON CONFLICT ("name") DO NOTHING;
