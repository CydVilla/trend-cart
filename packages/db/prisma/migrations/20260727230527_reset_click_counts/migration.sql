-- One-time reset (operator call, 2026-07-27): pre-filter click counts were
-- overwhelmingly firehose crawlers (median 0.4s post-to-first-click), so the
-- human counter starts from zero at the moment counting became honest.
-- The old totals are folded into botClickCount rather than deleted — the raw
-- volume stays observable, just labeled for what it (almost entirely) was.
UPDATE "TrackedLink"
SET "botClickCount" = "botClickCount" + "clickCount",
    "clickCount"    = 0,
    "firstClickAt"  = NULL,
    "lastClickAt"   = NULL
WHERE "clickCount" > 0;
