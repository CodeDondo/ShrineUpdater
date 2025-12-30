import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const app = express();
const PORT = process.env.PORT || 3000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SHRINE_FILE = path.resolve(__dirname, "data", "shrine.json");
const SOURCES = (process.env.SHRINE_SOURCE || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const DEFAULT_SOURCES = [
  "https://dbd.tricky.lol/api/shrine", // community mirror
  "https://dbd-api.herokuapp.com/shrineofsecrets?pretty=false&branch=live",
];

app.use(cors());

let cache = null;
let lastFetch = 0;
// Shrine rotates weekly; cache for a week to align with the update cadence.
const CACHE_TIME = 1000 * 60 * 60 * 24 * 7;

const FALLBACK = {
  source: "fallback",
  lastUpdated: null,
  perks: [],
};

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

async function loadShrine(force = false) {
  const now = Date.now();
  if (!force && cache && now - lastFetch < CACHE_TIME) {
    return cache;
  }

  console.log(force ? "Weekly refresh: fetching Shrine data..." : "Fetching fresh Shrine data...");
  const { url, payload } = await fetchFromSources();
  const { perksWithImages, images } = enrichPayload(payload);
  cache = {
    fetchedAt: new Date().toISOString(),
    sourceUsed: url,
    sourceTried: SOURCES.length ? SOURCES : DEFAULT_SOURCES,
    data: payload,
    perksWithImages,
    images,
  };
  lastFetch = now;
  return cache;
}

app.get("/shrine", async (req, res) => {
  try {
    const data = await loadShrine();
    res.json(data);
  } catch (err) {
    console.error(err);
    if (!cache) {
      // Serve a minimal fallback so the caller still gets valid JSON.
      res.status(200).json({ ...FALLBACK, error: "Upstream fetch failed" });
      return;
    }
    res.status(500).json({ error: "Could not fetch shrine data" });
  }
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    cacheAgeMs: cache ? Date.now() - lastFetch : null,
    cached: Boolean(cache),
    source: cache ? "cache" : "none",
  });
});

// Serve the last saved shrine JSON file (written by scripts/update-shrine.js or the GitHub Action).
app.get("/shrine.json", (req, res) => {
  try {
    if (!fs.existsSync(SHRINE_FILE)) {
      return res.status(404).json({ error: "shrine.json not generated yet" });
    }
    const data = fs.readFileSync(SHRINE_FILE, "utf8");
    res.type("application/json").send(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not read shrine.json" });
  }
});

// Kick off a weekly refresh to keep data warm even without incoming traffic.
setInterval(() => {
  loadShrine(true).catch((err) => console.error("Weekly refresh failed", err));
}, CACHE_TIME);

// Optional: warm the cache once on startup.
loadShrine(true).catch((err) => console.error("Initial fetch failed", err));

app.listen(PORT, () => {
  console.log(`🟢 Shrine API running on http://localhost:${PORT}/shrine`);
});
