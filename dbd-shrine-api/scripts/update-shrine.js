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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const outputPath = path.resolve(__dirname, "..", "data", "shrine.json");

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

async function main() {
  console.log("Fetching Shrine of Secrets...");
  const { url, payload } = await fetchFromSources();
  const { perksWithImages, images } = enrichPayload(payload);
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
