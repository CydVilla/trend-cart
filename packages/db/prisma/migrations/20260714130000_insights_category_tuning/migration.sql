-- Data migration: apply the 2026-07-14 insights recommendations that are
-- directly supported by the funnel data. Everything is guarded so it no-ops
-- on fresh installs (slugs absent) and never overwrites a value the operator
-- has since set in the dashboard.

-- Retro-gaming and video-games are the operator's highest-conviction
-- categories (strongest approval rates) AND the ones hit hardest by
-- candidate expiration (89 and 64 worth-replying vs 33 posted each).
-- Lower their engagement floor to 8 so their candidates enter evaluation
-- sooner; every other category keeps the global MIN_ENGAGEMENT_SCORE.
UPDATE "ProductCategory"
SET "minEngagementScore" = 8
WHERE "slug" IN ('retro-gaming', 'video-games')
  AND "minEngagementScore" IS NULL;

-- Books-reading converts well (63% all-time, 72% last 7d) with pure operator
-- approval (3 GOOD, 0 BAD) — widen its discovery with intent-heavy queries.
-- Appended (not prepended) so existing tuned queries keep their slots; each
-- guarded against duplicates.
UPDATE "ProductCategory"
SET "keywords" = array_append("keywords", 'book recommendation')
WHERE "slug" = 'books-reading' AND NOT ("keywords" @> ARRAY['book recommendation']);

UPDATE "ProductCategory"
SET "keywords" = array_append("keywords", 'just finished reading')
WHERE "slug" = 'books-reading' AND NOT ("keywords" @> ARRAY['just finished reading']);

UPDATE "ProductCategory"
SET "keywords" = array_append("keywords", 'favorite author')
WHERE "slug" = 'books-reading' AND NOT ("keywords" @> ARRAY['favorite author']);
