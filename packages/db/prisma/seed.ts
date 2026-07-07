import { prisma } from "../src/index.js";

/**
 * Seed the discovery categories. Idempotent: upsert by slug, dashboard edits
 * to isActive survive re-runs. Keywords double as the Bluesky search queries
 * polled each discovery cycle.
 */

type CategorySeed = {
  slug: string;
  name: string;
  description: string;
  keywords: string[];
  negativeKeywords: string[];
  exampleProblems: string[];
};

const categories: CategorySeed[] = [
  {
    slug: "desk-cable-management",
    name: "Desk Cable Management",
    description: "Under-desk trays, reusable ties, and clips that tame messy cables.",
    keywords: [
      "cable management",
      "cables everywhere",
      "cable mess",
      "tangled cables",
      "tangled wires",
      "cords everywhere",
      "messy desk",
      "desk setup",
      "under desk",
    ],
    negativeKeywords: ["guitar cable", "cable tv", "cable news", "internet outage"],
    exampleProblems: [
      "My desk setup is such a mess, these cables are driving me insane",
      "Working from home would be great if my desk didn't look like a wire jungle",
    ],
  },
  {
    slug: "home-office-lighting",
    name: "Home Office Lighting",
    description: "Desk lamps, ring lights, and bias lighting for better video calls and less eye strain.",
    keywords: [
      "desk lamp",
      "ring light",
      "home office lighting",
      "bad lighting",
      "eye strain",
      "glare on my screen",
      "too dark on zoom",
      "look like a shadow on calls",
    ],
    negativeKeywords: ["stage lighting", "photography studio"],
    exampleProblems: [
      "Every video call I look like I'm in witness protection, my lighting is so bad",
      "My eyes are killing me after a day at this dim desk",
    ],
  },
  {
    slug: "dog-grooming",
    name: "Dog Grooming",
    description: "Deshedding brushes, grooming gloves, and nail tools for keeping dogs (and homes) tidy.",
    keywords: [
      "dog hair everywhere",
      "shedding season",
      "dog is shedding",
      "sheds so much",
      "dog grooming",
      "fur all over",
      "dog nails",
      "matted fur",
    ],
    negativeKeywords: ["cat", "vet bill", "groomer appointment"],
    exampleProblems: [
      "My couch is 90% dog hair at this point",
      "Shedding season has turned my apartment into a fur tornado",
    ],
  },
  {
    slug: "travel-backpack",
    name: "Travel & Packing",
    description: "Carry-on backpacks, packing cubes, and organizers for lighter, saner travel.",
    keywords: [
      "packing cubes",
      "travel backpack",
      "overpacked",
      "can't fit in my carry on",
      "carry on only",
      "one bag travel",
      "packing for a trip",
      "suitcase is a disaster",
    ],
    negativeKeywords: ["flight delayed", "flight cancelled", "lost my luggage"],
    exampleProblems: [
      "Packing for a week in a carry-on feels physically impossible",
      "My backpack is a black hole, I can never find anything in it",
    ],
  },
  {
    slug: "mechanical-keyboard",
    name: "Mechanical Keyboards",
    description: "Boards, switches, and keycaps for people whose keyboard is ruining their day.",
    keywords: [
      "mechanical keyboard",
      "keycaps",
      "keyboard switches",
      "keyboard died",
      "keyboard is mushy",
      "membrane keyboard",
      "keys stopped working",
      "hate this keyboard",
    ],
    negativeKeywords: ["piano keyboard", "midi keyboard", "synth"],
    exampleProblems: [
      "This laptop keyboard is turning my fingers into sadness",
      "My keyboard double-types every other letter, I'm done",
    ],
  },
  {
    slug: "workout-recovery",
    name: "Workout Recovery",
    description: "Foam rollers, massage tools, and stretching gear for sore-but-healthy muscles.",
    keywords: [
      "sore muscles",
      "so sore from",
      "foam roller",
      "post workout",
      "leg day destroyed me",
      "massage gun",
      "doms",
      "recovery day",
    ],
    negativeKeywords: ["injury", "injured", "surgery", "physical therapy", "doctor"],
    exampleProblems: [
      "Leg day was two days ago and I still can't sit down like a normal person",
      "Everything hurts and I need my muscles to forgive me",
    ],
  },
  {
    slug: "coffee-setup",
    name: "Coffee Setup",
    description: "Grinders, pour-over gear, and espresso accessories for better home coffee.",
    keywords: [
      "coffee setup",
      "espresso machine",
      "pour over",
      "coffee grinder",
      "french press",
      "cold brew",
      "coffee at home tastes",
      "bad coffee",
    ],
    negativeKeywords: ["coffee shop hiring", "coffee date", "gift card"],
    exampleProblems: [
      "My home coffee tastes like disappointment compared to the cafe",
      "I need a grinder that doesn't sound like a jet engine at 6am",
    ],
  },
  {
    slug: "video-games",
    name: "Video Games",
    description:
      "Games and gaming hardware people are asking about or raving over — served by dynamic Amazon search links rather than a fixed product list.",
    keywords: [
      "what should i play",
      "game recommendations",
      "any game recs",
      "worth buying the game",
      "just finished the game",
      "game of the year",
      "nintendo switch",
      "steam deck",
      "ps5",
      "xbox series",
    ],
    negativeKeywords: ["gambling", "casino", "crypto"],
    exampleProblems: [
      "Just rolled credits on this game, absolute masterpiece, everyone should play it",
      "Beat the whole game in one weekend — what should I play next?",
    ],
  },
  {
    slug: "kitchen-organization",
    name: "Kitchen Organization",
    description: "Pantry bins, drawer organizers, and racks that reclaim kitchen space.",
    keywords: [
      "kitchen organization",
      "pantry is a mess",
      "tupperware avalanche",
      "spice rack",
      "no counter space",
      "kitchen counter clutter",
      "junk drawer",
      "cabinets are chaos",
    ],
    negativeKeywords: ["renovation", "remodel", "landlord"],
    exampleProblems: [
      "Opening my tupperware cabinet is a game of Jenga I always lose",
      "My kitchen has zero counter space and infinite clutter",
    ],
  },
];

/**
 * Starter deal feeds for the Wario64-style discovery loop (create-only:
 * dashboard edits survive re-runs). Harmless until DEALS_ENABLED + PA-API
 * keys exist — the discovery loop stands down without them.
 */
type FeedSeed = {
  name: string;
  keywords: string;
  searchIndex: string;
  minSavingPercent: number;
  minPriceCents: number;
};

const dealFeeds: FeedSeed[] = [
  {
    name: "Video game deals",
    keywords: "video games",
    searchIndex: "VideoGames",
    minSavingPercent: 25,
    minPriceCents: 1500,
  },
  {
    name: "Tech deals",
    keywords: "electronics",
    searchIndex: "Electronics",
    minSavingPercent: 30,
    minPriceCents: 2000,
  },
  {
    name: "LEGO deals",
    keywords: "lego set",
    searchIndex: "ToysAndGames",
    minSavingPercent: 20,
    minPriceCents: 2000,
  },
];

/**
 * Starter RSS suggestion sources — the no-PA-API path. Both read the
 * Slickdeals frontpage feed; the lane (topic + keyword prefilter) does the
 * separation. Create-only: dashboard edits survive re-runs.
 */
type SourceSeed = {
  name: string;
  url: string;
  topic: string;
  includeKeywords: string[];
  excludeKeywords: string[];
  minPriceCents?: number;
};

const SLICKDEALS_FRONTPAGE_RSS =
  "https://slickdeals.net/newsearch.php?mode=frontpage&searcharea=deals&searchin=first&rss=1";

const suggestionSources: SourceSeed[] = [
  {
    name: "Tech & electronics (Slickdeals)",
    url: SLICKDEALS_FRONTPAGE_RSS,
    topic:
      "Consumer tech and electronics: computers and PC parts, monitors, TVs, audio " +
      "(headphones, earbuds, speakers), smart home, phones and tablets, gaming hardware " +
      "and accessories (consoles, controllers, headsets), storage, networking, chargers " +
      "and cables. Software subscriptions, gift cards, and non-tech household goods do " +
      "NOT match.",
    includeKeywords: [],
    excludeKeywords: ["gift card", "subscription", "refurbished", "renewed", "pre-owned"],
    minPriceCents: 1500,
  },
  {
    name: "Pop-culture apparel (Slickdeals)",
    url: SLICKDEALS_FRONTPAGE_RSS,
    topic:
      "Clothing and apparel tied to TV shows, movies, video games, anime, comics, or " +
      "pop-culture fandoms: graphic tees, hoodies, sweatshirts, jerseys, hats, socks, " +
      "pajamas, costumes — items branded with a franchise or character (Star Wars, " +
      "Marvel, Zelda, Pokémon, Mario, etc.). Plain unbranded clothing does NOT match.",
    // Cheap prefilter: only clothing headlines reach the LLM lane judgment.
    includeKeywords: [
      "shirt",
      "tee",
      "t-shirt",
      "hoodie",
      "sweatshirt",
      "sweater",
      "jacket",
      "jersey",
      "hat",
      "cap",
      "beanie",
      "socks",
      "pajama",
      "costume",
      "apparel",
    ],
    excludeKeywords: ["refurbished", "renewed", "pre-owned"],
  },
  {
    name: "Video games & gaming (Slickdeals)",
    url: SLICKDEALS_FRONTPAGE_RSS,
    topic:
      "Video games and gaming hardware: physical and digital game titles for PlayStation, " +
      "Xbox, Nintendo Switch, and PC; consoles and handhelds (PS5, Xbox Series, Switch, " +
      "Steam Deck); controllers, headsets, and gaming accessories. Gaming-branded apparel, " +
      "gift cards, and in-game currency do NOT match.",
    includeKeywords: [
      "game",
      "games",
      "ps5",
      "playstation",
      "xbox",
      "nintendo",
      "switch",
      "steam deck",
      "console",
      "controller",
    ],
    excludeKeywords: [
      "gift card",
      "subscription",
      "in-game",
      "refurbished",
      "renewed",
      "pre-owned",
    ],
    minPriceCents: 1000,
  },
  {
    name: "Home office & desk setup (Slickdeals)",
    url: SLICKDEALS_FRONTPAGE_RSS,
    topic:
      "Home-office and desk gear: standing and sit-stand desks, ergonomic and office chairs, " +
      "monitor arms and stands, desk lamps and lighting, cable management, keyboard and mouse " +
      "peripherals, and desk organizers. General furniture and home decor unrelated to a work " +
      "desk do NOT match.",
    includeKeywords: [
      "desk",
      "chair",
      "monitor arm",
      "monitor stand",
      "standing desk",
      "office",
      "keyboard",
      "mouse",
      "lamp",
      "cable",
    ],
    excludeKeywords: ["gift card", "subscription", "refurbished", "renewed", "pre-owned"],
    minPriceCents: 2000,
  },
  {
    name: "LEGO & building sets (Slickdeals)",
    url: SLICKDEALS_FRONTPAGE_RSS,
    topic:
      "LEGO and building-brick sets, especially licensed pop-culture themes (Star Wars, " +
      "Marvel, Harry Potter, Nintendo, Icons). Generic non-LEGO toys, minifigure blind bags, " +
      "and used or incomplete sets do NOT match.",
    includeKeywords: ["lego", "building set", "brick set"],
    excludeKeywords: ["used", "incomplete", "refurbished", "renewed", "pre-owned"],
    minPriceCents: 2000,
  },
  {
    name: "Coffee & kitchen gear (Slickdeals)",
    url: SLICKDEALS_FRONTPAGE_RSS,
    topic:
      "Home coffee and kitchen equipment: espresso machines, coffee grinders, pour-over and " +
      "cold-brew gear, kettles, and small kitchen appliances and organization. Groceries, " +
      "consumable coffee beans, and gift cards do NOT match.",
    includeKeywords: [
      "coffee",
      "espresso",
      "grinder",
      "kettle",
      "french press",
      "air fryer",
      "kitchen",
    ],
    excludeKeywords: [
      "gift card",
      "subscription",
      "k-cup",
      "coffee beans",
      "refurbished",
      "renewed",
      "pre-owned",
    ],
    minPriceCents: 1500,
  },
];

async function main(): Promise<void> {
  for (const c of categories) {
    await prisma.productCategory.upsert({
      where: { slug: c.slug },
      create: { ...c, isActive: true },
      update: {
        name: c.name,
        description: c.description,
        keywords: c.keywords,
        negativeKeywords: c.negativeKeywords,
        exampleProblems: c.exampleProblems,
      },
    });
    console.log(`  upserted category: ${c.slug}`);
  }
  console.log(`Seeded ${categories.length} categories (keywords double as Bluesky search queries).`);

  for (const f of dealFeeds) {
    await prisma.dealFeed.upsert({
      where: { name: f.name },
      create: { ...f, isActive: true },
      update: {}, // operator tuning wins over re-seeds
    });
    console.log(`  upserted deal feed: ${f.name}`);
  }
  console.log(`Seeded ${dealFeeds.length} deal feeds (idle until DEALS_ENABLED + PA-API keys).`);

  for (const s of suggestionSources) {
    await prisma.dealSuggestionSource.upsert({
      where: { name: s.name },
      create: { ...s, isActive: true },
      update: {}, // operator tuning wins over re-seeds
    });
    console.log(`  upserted suggestion source: ${s.name}`);
  }
  console.log(
    `Seeded ${suggestionSources.length} RSS suggestion sources (run under DEALS_ENABLED, no PA-API needed).`,
  );
}

main()
  .catch((error) => {
    console.error("Seed failed:", error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
