import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import fetch from "node-fetch";

const SOURCES = (process.env.SHRINE_SOURCE || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const DEFAULT_SOURCES = [
  "https://dbd.tricky.lol/api/shrine", // community mirror
  "https://dbd-api.herokuapp.com/shrineofsecrets?pretty=false&branch=live",
];

const PERK_CATALOG_SOURCES = [
  "https://dbd.tricky.lol/api/perks", // includes icon info
];

function normalizeImageUrl(image) {
  if (!image) return null;
  if (image.startsWith("http")) return image;
  return `https://dbd.tricky.lol${image.startsWith("/") ? "" : "/"}${image}`;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const outputPath = path.resolve(__dirname, "..", "data", "shrine.json");

const PERK_OVERRIDES = {
  k28p02: { name: "Darkness Revealed" },
  k32p02: { name: "Forced Hesitation" },
};

async function fetchFromSources() {
  const candidates = SOURCES.length ? SOURCES : DEFAULT_SOURCES;
  const errors = [];

  for (const url of candidates) {
    console.log(`Trying source: ${url}`);
    try {
      const response = await fetch(url);
      if (!response.ok) {
        errors.push(`${url} -> ${response.status}`);
        continue;
      }
      const payload = await response.json();
      return { url, payload };
    } catch (err) {
      errors.push(`${url} -> ${err.message}`);
    }
  }

  throw new Error(`All shrine sources failed: ${errors.join(" | ")}`);
}

function extractImage(perk) {
  if (!perk || typeof perk !== "object") return null;
  const candidates = [
    perk.icon,
    perk.iconUrl,
    perk.iconPath,
    perk.image,
    perk.perkImage,
    perk.perkIcon,
  ];
  return candidates.find(Boolean) || null;
}

function enrichPayload(payload) {
  const perks = Array.isArray(payload?.perks) ? payload.perks : [];
  const perksWithImages = perks.map((perk) => {
    const image = extractImage(perk);
    return image ? { ...perk, image } : perk;
  });

  const images = perksWithImages
    .map((p) => ({
      name: p.name || p.perkName || p.displayName || p.id || null,
      image: p.image || extractImage(p) || null,
    }))
    .filter((p) => p.image);

  return { perksWithImages, images };
}

async function fetchPerkCatalog() {
  const errors = [];
  for (const url of PERK_CATALOG_SOURCES) {
    console.log(`Trying perk catalog: ${url}`);
    try {
      const response = await fetch(url);
      if (!response.ok) {
        errors.push(`${url} -> ${response.status}`);
        continue;
      }
      const payload = await response.json();
      const fromArray = (arr) => (Array.isArray(arr) ? arr : []);
      const fromObject = (obj) =>
        typeof obj === "object" && obj
          ? Object.entries(obj).map(([id, value]) => ({ id, ...value }))
          : [];

      const list = Array.isArray(payload?.data)
        ? fromArray(payload.data)
        : Array.isArray(payload)
          ? fromArray(payload)
          : fromObject(payload);
      return list;
    } catch (err) {
      errors.push(`${url} -> ${err.message}`);
    }
  }
  throw new Error(`All perk catalog sources failed: ${errors.join(" | ")}`);
}

function mapPerksWithCatalog(shrinePerks, catalog) {
  const byId = new Map();
  for (const perk of catalog) {
    if (!perk) continue;
    const key = (perk.id || perk.perkId || perk.name || "").toString().toLowerCase();
    if (key) byId.set(key, perk);
  }

  return shrinePerks.map((perk) => {
    const key = (perk.id || "").toString().toLowerCase();
    const found = byId.get(key);
    const override = PERK_OVERRIDES[key] || {};
    if (!found && !override.name) return perk;
    const image = normalizeImageUrl(found ? extractImage(found) : null);
    return {
      ...perk,
      name: override.name || found?.name || found?.displayName || perk.name || key,
      description: found?.description || perk.description,
      role: found?.role || found?.roleCategory,
      character: found?.character || found?.owner || found?.survivor || found?.killer,
      image: image || perk.image,
    };
  });
}

async function main() {
  console.log("Fetching Shrine of Secrets...");
  const { url, payload } = await fetchFromSources();
  let perksWithImages, images;
  try {
    const catalog = await fetchPerkCatalog();
    const merged = mapPerksWithCatalog(payload?.perks || [], catalog);
    const enriched = enrichPayload({ perks: merged });
    perksWithImages = enriched.perksWithImages;
    images = enriched.images;
  } catch (catalogErr) {
    console.warn(`Perk catalog enrich failed: ${catalogErr.message}`);
    ({ perksWithImages, images } = enrichPayload(payload));
  }
  const wrapped = {
    fetchedAt: new Date().toISOString(),
    sourceTried: SOURCES.length ? SOURCES : DEFAULT_SOURCES,
    sourceUsed: url,
    data: payload,
    perksWithImages,
    images,
  };

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(wrapped, null, 2), "utf8");
  console.log(`Saved shrine data to ${outputPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
