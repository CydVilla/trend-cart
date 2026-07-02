import { prisma } from "../src/index.js";

/**
 * Seed curated categories, recommendation pages, and placeholder products.
 * Idempotent: categories/pages upsert by slug (page publish state is
 * preserved on re-run), products are matched by (category, name) and only
 * created when missing. Product URLs are Amazon search links — the same
 * dynamic pattern as the amazon-search app; the affiliate tag is applied
 * at render time, never stored.
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

type PageSeed = { slug: string; title: string; intro: string };

const pages: PageSeed[] = [
  {
    slug: "desk-cable-management",
    title: "Fix your desk cable mess",
    intro:
      "Tangled cables under the desk are a solved problem. You don't need a new desk — you need a tray to get the power strip off the floor, ties to bundle the runs, and clips to keep the everyday cables where you can reach them.",
  },
  {
    slug: "home-office-lighting",
    title: "Look human on video calls again",
    intro:
      "Bad lighting makes every call worse and every workday harder on your eyes. A decent lamp in the right position fixes more than a new webcam ever will.",
  },
  {
    slug: "dog-grooming",
    title: "Win the war on dog hair",
    intro:
      "Shedding season doesn't have to mean a fur-covered couch. The right brush for your dog's coat type, used a few minutes a day, keeps most of the hair off your furniture.",
  },
  {
    slug: "travel-backpack",
    title: "Pack a week into a carry-on",
    intro:
      "Overpacking is a gear problem as much as a discipline problem. Compression cubes and a well-organized bag make the carry-on-only trip actually workable.",
  },
  {
    slug: "mechanical-keyboard",
    title: "Type on something that types back",
    intro:
      "If your keyboard mushes, double-types, or just makes you sad, a starter mechanical board is a cheap upgrade you feel every single day.",
  },
  {
    slug: "workout-recovery",
    title: "Sore today, functional tomorrow",
    intro:
      "Post-workout soreness responds well to a few simple tools and ten minutes of effort. These help you move again after leg day.",
  },
  {
    slug: "coffee-setup",
    title: "Make café coffee at home",
    intro:
      "The gap between sad home coffee and café coffee is mostly grind quality and water control. Fix those two and everything improves.",
  },
  {
    slug: "kitchen-organization",
    title: "Reclaim your counter space",
    intro:
      "Kitchen chaos is a containers problem. Dividers, airtight bins, and a lid rack turn junk drawers and avalanche cabinets back into storage.",
  },
];

type ProductSeed = { name: string; description: string; priceRange: string; url: string };

const productsBySlug: Record<string, ProductSeed[]> = {
  "desk-cable-management": [
    {
      name: "Under-desk cable management tray",
      description:
        "Steel mesh tray that screws under the desktop and holds the power strip and slack cable off the floor.",
      priceRange: "$18–$30",
      url: "https://www.amazon.com/s?k=under+desk+cable+management+tray",
    },
    {
      name: "Reusable velcro cable ties, 60-pack",
      description:
        "Adjustable hook-and-loop ties in mixed sizes — bundle cable runs without the one-time-use zip tie regret.",
      priceRange: "$7–$12",
      url: "https://www.amazon.com/s?k=reusable+velcro+cable+ties",
    },
    {
      name: "Magnetic cable clips, 6-pack",
      description:
        "Silicone-capped magnets that stick to the desk frame and hold charging cables at the edge, right where you unplug them.",
      priceRange: "$10–$15",
      url: "https://www.amazon.com/s?k=magnetic+cable+clips+desk",
    },
  ],
  "home-office-lighting": [
    {
      name: "LED desk lamp with color temperature control",
      description:
        "Adjustable warm-to-cool lamp with a swing arm — softens shadows on calls and eases eye strain after dark.",
      priceRange: "$30–$45",
      url: "https://www.amazon.com/s?k=led+desk+lamp+color+temperature",
    },
    {
      name: "Clip-on video call light",
      description:
        "Small ring light that clips to the laptop or monitor and makes webcam lighting flattering instead of forensic.",
      priceRange: "$15–$25",
      url: "https://www.amazon.com/s?k=clip+on+video+conference+light",
    },
    {
      name: "Monitor light bar",
      description:
        "Sits on top of the monitor and lights the desk without glare on the screen — the tidy person's desk lamp.",
      priceRange: "$35–$60",
      url: "https://www.amazon.com/s?k=monitor+light+bar",
    },
  ],
  "dog-grooming": [
    {
      name: "Deshedding brush for double coats",
      description:
        "Reaches the undercoat where the shedding actually happens — a few minutes a day keeps it off the couch.",
      priceRange: "$15–$25",
      url: "https://www.amazon.com/s?k=deshedding+brush+dog+undercoat",
    },
    {
      name: "Pet grooming gloves",
      description:
        "Rubber-tipped gloves that turn petting into brushing — the tool for dogs who hate the brush.",
      priceRange: "$8–$14",
      url: "https://www.amazon.com/s?k=pet+grooming+gloves",
    },
    {
      name: "Quiet dog nail grinder",
      description:
        "Low-noise grinder for gradual nail trims — easier on nervous dogs than clippers, no quick accidents.",
      priceRange: "$20–$30",
      url: "https://www.amazon.com/s?k=quiet+dog+nail+grinder",
    },
  ],
  "travel-backpack": [
    {
      name: "Compression packing cubes, 6-piece set",
      description:
        "Zip-down cubes that halve the volume of clothes and keep the bag organized past day one of the trip.",
      priceRange: "$20–$30",
      url: "https://www.amazon.com/s?k=compression+packing+cubes",
    },
    {
      name: "40L carry-on travel backpack",
      description:
        "Max-legal-size backpack that opens flat like a suitcase — one bag, no checked luggage, no waiting.",
      priceRange: "$60–$100",
      url: "https://www.amazon.com/s?k=40l+carry+on+travel+backpack",
    },
    {
      name: "Hanging toiletry bag",
      description:
        "Hooks onto any door or rail so your toiletries live at eye level instead of the bottom of the bag.",
      priceRange: "$15–$25",
      url: "https://www.amazon.com/s?k=hanging+toiletry+bag",
    },
  ],
  "mechanical-keyboard": [
    {
      name: "Hot-swappable 75% mechanical keyboard",
      description:
        "Compact starter board where switches pop in and out without soldering — try feels until one fits.",
      priceRange: "$70–$110",
      url: "https://www.amazon.com/s?k=hot+swappable+75+mechanical+keyboard",
    },
    {
      name: "Switch sampler pack",
      description:
        "A few of each popular switch type to test before committing a whole board to clicky, tactile, or linear.",
      priceRange: "$10–$18",
      url: "https://www.amazon.com/s?k=mechanical+keyboard+switch+tester",
    },
    {
      name: "Wooden keyboard wrist rest",
      description: "Keeps wrists neutral through long typing sessions; solid wood, no mushy foam.",
      priceRange: "$20–$30",
      url: "https://www.amazon.com/s?k=wooden+keyboard+wrist+rest",
    },
  ],
  "workout-recovery": [
    {
      name: "High-density foam roller",
      description:
        "The basic tool for post-leg-day quads and tight backs — ten slow minutes beats a day of hobbling.",
      priceRange: "$20–$35",
      url: "https://www.amazon.com/s?k=high+density+foam+roller",
    },
    {
      name: "Percussion massage gun",
      description:
        "Handheld deep-tissue massager for the spots the roller can't isolate. Quiet enough for apartment use.",
      priceRange: "$40–$90",
      url: "https://www.amazon.com/s?k=percussion+massage+gun",
    },
    {
      name: "Acupressure massage ball set",
      description:
        "Lacrosse-style balls for feet, glutes, and shoulder knots — the travel-sized recovery kit.",
      priceRange: "$10–$18",
      url: "https://www.amazon.com/s?k=massage+ball+set+trigger+point",
    },
  ],
  "coffee-setup": [
    {
      name: "Conical burr coffee grinder",
      description:
        "Even grounds are the single biggest upgrade from pre-ground — this is where café taste starts.",
      priceRange: "$40–$80",
      url: "https://www.amazon.com/s?k=conical+burr+coffee+grinder",
    },
    {
      name: "Gooseneck pour-over kettle",
      description:
        "Controlled, slow pours for even extraction — the difference between pour-over and just pouring.",
      priceRange: "$30–$60",
      url: "https://www.amazon.com/s?k=gooseneck+pour+over+kettle",
    },
    {
      name: "Digital coffee scale with timer",
      description:
        "Repeatable ratios instead of guessing — the cheapest way to make good coffee happen twice.",
      priceRange: "$15–$25",
      url: "https://www.amazon.com/s?k=coffee+scale+with+timer",
    },
  ],
  "kitchen-organization": [
    {
      name: "Expandable drawer dividers",
      description:
        "Spring-loaded bamboo dividers that turn the junk drawer back into compartments in five minutes.",
      priceRange: "$15–$25",
      url: "https://www.amazon.com/s?k=expandable+drawer+dividers+bamboo",
    },
    {
      name: "Airtight pantry container set",
      description:
        "Stackable clear containers that end the half-open-bag chaos and keep flour and cereal fresh.",
      priceRange: "$25–$45",
      url: "https://www.amazon.com/s?k=airtight+food+storage+containers+set",
    },
    {
      name: "Lid and container organizer rack",
      description:
        "Adjustable rack that ends the tupperware-lid avalanche — every lid upright and findable.",
      priceRange: "$15–$25",
      url: "https://www.amazon.com/s?k=food+container+lid+organizer",
    },
  ],
};

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

  let pagesSeeded = 0;
  for (const p of pages) {
    const category = await prisma.productCategory.findUniqueOrThrow({ where: { slug: p.slug } });
    // update does not touch isPublished, so dashboard publish choices survive re-seeds
    await prisma.recommendationPage.upsert({
      where: { slug: p.slug },
      create: { slug: p.slug, categoryId: category.id, title: p.title, intro: p.intro, isPublished: true },
      update: { title: p.title, intro: p.intro },
    });
    pagesSeeded += 1;
  }

  let productsCreated = 0;
  for (const [slug, items] of Object.entries(productsBySlug)) {
    const category = await prisma.productCategory.findUniqueOrThrow({ where: { slug } });
    for (const item of items) {
      const existing = await prisma.product.findFirst({
        where: { categoryId: category.id, name: item.name },
        select: { id: true },
      });
      if (existing) continue;
      await prisma.product.create({ data: { categoryId: category.id, ...item } });
      productsCreated += 1;
    }
  }

  const totalProducts = await prisma.product.count();
  console.log(
    `Seeded ${categories.length} categories, ${pagesSeeded} pages, ` +
      `${productsCreated} new products (${totalProducts} total).`,
  );
}

main()
  .catch((error) => {
    console.error("Seed failed:", error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
