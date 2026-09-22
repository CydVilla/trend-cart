-- Curator-account deal channel (ADR-0017): posts mirrored from a Bluesky deal
-- curator get their own DealSource so they carry a separate budget/cooldown.
ALTER TYPE "DealSource" ADD VALUE 'CURATED';

-- Seed the first curator. Operator edits win: never overwrite an existing row.
INSERT INTO "DealSuggestionSource" ("id", "name", "url", "topic", "includeKeywords", "excludeKeywords", "isActive", "updatedAt")
VALUES (
  'src_bsky_wario64',
  'Wario64 (Bluesky)',
  'https://bsky.app/profile/wario64.bsky.social',
  'Deals the Wario64 curator account posts: video games and pre-orders, consoles, controllers and accessories, storage, PC gaming gear, figures, LEGO and collectibles, and physical movies/TV (Blu-ray, 4K UHD, steelbooks).',
  ARRAY[]::TEXT[],
  ARRAY['likely an error', 'price error', 'pricing error', 'price mistake', 'ymmv', 'in-store', 'in store only', 'targeted', 'trade-in', 'trade in']::TEXT[],
  true,
  CURRENT_TIMESTAMP
)
ON CONFLICT ("name") DO NOTHING;
