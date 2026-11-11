-- eBay deal channel (ADR-0018): a new DealSource, per-post conversions from
-- the Impact Actions API, and the Slickdeals eBay feed that supplies listings.
ALTER TYPE "DealSource" ADD VALUE IF NOT EXISTS 'EBAY';

CREATE TABLE "EbayConversion" (
    "id" TEXT NOT NULL,
    "dealPostId" TEXT,
    "subId" TEXT,
    "state" TEXT NOT NULL,
    "saleCents" INTEGER NOT NULL,
    "payoutCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "eventAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EbayConversion_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "EbayConversion_dealPostId_idx" ON "EbayConversion"("dealPostId");
CREATE INDEX "EbayConversion_eventAt_idx" ON "EbayConversion"("eventAt");

-- Operator edits win: never overwrite an existing row.
INSERT INTO "DealSuggestionSource" ("id", "name", "url", "topic", "includeKeywords", "excludeKeywords", "isActive", "updatedAt")
VALUES
  (
    'src_slickdeals_ebay',
    'eBay deals (Slickdeals)',
    'https://slickdeals.net/newsearch.php?q=ebay&searcharea=deals&searchin=first&rss=1',
    'Deals on eBay listings: video games, consoles and accessories, collectibles and figures, movies, PC gaming gear and storage.',
    ARRAY[]::TEXT[],
    ARRAY['likely an error', 'price error', 'pricing error', 'price mistake', 'ymmv', 'in-store', 'in store only', 'targeted', 'trade-in', 'trade in']::TEXT[],
    true,
    CURRENT_TIMESTAMP
  ),
  (
    'src_ebay_switch_games',
    'eBay search: Nintendo Switch games',
    'https://www.ebay.com/sch/i.html?_nkw=nintendo+switch+game',
    'Physical Nintendo Switch and Switch 2 games.',
    ARRAY[]::TEXT[],
    ARRAY['likely an error', 'price error', 'pricing error', 'price mistake', 'ymmv', 'in-store', 'in store only', 'targeted', 'trade-in', 'trade in']::TEXT[],
    true,
    CURRENT_TIMESTAMP
  ),
  (
    'src_ebay_amiibo',
    'eBay search: amiibo',
    'https://www.ebay.com/sch/i.html?_nkw=amiibo',
    'Nintendo amiibo figures and cards.',
    ARRAY[]::TEXT[],
    ARRAY['likely an error', 'price error', 'pricing error', 'price mistake', 'ymmv', 'in-store', 'in store only', 'targeted', 'trade-in', 'trade in']::TEXT[],
    true,
    CURRENT_TIMESTAMP
  ),
  (
    'src_ebay_ps5_games',
    'eBay search: PS5 games',
    'https://www.ebay.com/sch/i.html?_nkw=ps5+game',
    'Physical PlayStation 5 games.',
    ARRAY[]::TEXT[],
    ARRAY['likely an error', 'price error', 'pricing error', 'price mistake', 'ymmv', 'in-store', 'in store only', 'targeted', 'trade-in', 'trade in']::TEXT[],
    true,
    CURRENT_TIMESTAMP
  ),
  (
    'src_ebay_controllers',
    'eBay search: Controllers',
    'https://www.ebay.com/sch/i.html?_nkw=dualsense+controller',
    'PlayStation DualSense controllers and other console controllers.',
    ARRAY[]::TEXT[],
    ARRAY['likely an error', 'price error', 'pricing error', 'price mistake', 'ymmv', 'in-store', 'in store only', 'targeted', 'trade-in', 'trade in']::TEXT[],
    true,
    CURRENT_TIMESTAMP
  ),
  (
    'src_ebay_nendoroid',
    'eBay search: Nendoroids',
    'https://www.ebay.com/sch/i.html?_nkw=nendoroid',
    'Nendoroid and similar anime figures.',
    ARRAY[]::TEXT[],
    ARRAY['likely an error', 'price error', 'pricing error', 'price mistake', 'ymmv', 'in-store', 'in store only', 'targeted', 'trade-in', 'trade in']::TEXT[],
    true,
    CURRENT_TIMESTAMP
  ),
  (
    'src_ebay_scale_figures',
    'eBay search: Anime scale figures',
    'https://www.ebay.com/sch/i.html?_nkw=anime+scale+figure',
    'Anime scale figures and statues from established makers.',
    ARRAY[]::TEXT[],
    ARRAY['likely an error', 'price error', 'pricing error', 'price mistake', 'ymmv', 'in-store', 'in store only', 'targeted', 'trade-in', 'trade in']::TEXT[],
    true,
    CURRENT_TIMESTAMP
  ),
  (
    'src_ebay_hot_toys',
    'eBay search: Collectible figures',
    'https://www.ebay.com/sch/i.html?_nkw=hot+toys+figure',
    'Collectible and fandom figures, such as Hot Toys and S.H.Figuarts.',
    ARRAY[]::TEXT[],
    ARRAY['likely an error', 'price error', 'pricing error', 'price mistake', 'ymmv', 'in-store', 'in store only', 'targeted', 'trade-in', 'trade in']::TEXT[],
    true,
    CURRENT_TIMESTAMP
  ),
  (
    'src_ebay_steelbooks',
    'eBay search: 4K steelbooks',
    'https://www.ebay.com/sch/i.html?_nkw=4k+steelbook',
    '4K Blu-ray steelbooks and collector editions of movies and TV.',
    ARRAY[]::TEXT[],
    ARRAY['likely an error', 'price error', 'pricing error', 'price mistake', 'ymmv', 'in-store', 'in store only', 'targeted', 'trade-in', 'trade in']::TEXT[],
    true,
    CURRENT_TIMESTAMP
  )
ON CONFLICT ("name") DO NOTHING;
