/**
 * Yegna Gebeya Telegram Bot - Cloudflare Worker
 *
 * Production Complete Edition (v8.0 AI-Powered Category & Spec Engine):
 * 1. Dual AI Category + Vision Classification:
 *    - Primary: Google Gemini (`gemini-4-hydrogen` via env.GEMINI_API_KEY) with strict JSON schema + photo vision.
 *    - Built-in Key-Free Fallback: Cloudflare Workers AI (`env.AI` binding) using Vision + Llama 3.1 8B Instruct.
 *    - Final Safety Net: Context-weighted Ethiopian Bilingual Classifier (English + Amharic + Ethiopic numerals).
 * 2. Eliminates Common Misclassifications:
 *    - Houses/Rentals mentioning "granite kitchen", "ceramic tiles", or "TV/sofa" stay Houses/Rentals.
 *    - Cars mentioning "new tires", "new battery", or "bumper" stay Cars (not Spare Parts).
 *    - Missing hashtags (#BuildingMaterials, #SpareParts) fixed + category-matched default subcategories.
 * 3. Precision Bot Watermark Shield & In-Memory Deduplication.
 * 4. Instant Website Sync (/api/ads) + Firestore Persistent Sync.
 */

// In-Memory Aggregators & Deduplication Stores
const albumStore = new Map(); // groupId -> { images: [], messageIds: [], caption: "", captionMsg: null, timerActive: false, timestamp: number }
const memoryLocks = new Map(); // key -> expireTimestamp
const updateIdLocks = new Set(); // Telegram update_id deduplication
let cachedFirebaseToken = null;
let tokenExpiresAt = 0;
let cachedAdminUid = null;
let cachedAdminEmailForUid = "";

const MARKETPLACE_CATEGORIES = [
  "Cars",
  "Houses",
  "Rentals",
  "Electronics",
  "Furniture",
  "Clothes",
  "Building Materials",
  "Spare Parts",
  "Labor & Services",
  "ምንአለሽ_ተራ"
];

const DEFAULT_SUBCATEGORIES = {
  Cars: "Vehicles",
  Houses: "Villa / House",
  Rentals: "Apartment Rent",
  Electronics: "Smartphones & Gadgets",
  Furniture: "Living Room / Sofa",
  Clothes: "Clothing & Apparel",
  "Building Materials": "Construction & Finishing",
  "Spare Parts": "Auto & Machine Parts",
  "Labor & Services": "Professional Services",
  "ምንአለሽ_ተራ": "General Marketplace"
};

const DEFAULT_CATEGORY_IMAGES = {
  Cars: "https://images.unsplash.com/photo-1549399542-7e3f8b79c341?auto=format&fit=crop&w=900&q=80",
  Houses: "https://images.unsplash.com/photo-1600585154340-be6161a56a0c?auto=format&fit=crop&w=900&q=80",
  Rentals: "https://images.unsplash.com/photo-1522708323590-d24dbb6b0267?auto=format&fit=crop&w=900&q=80",
  Electronics: "https://images.unsplash.com/photo-1511707171634-5f897ff02aa9?auto=format&fit=crop&w=900&q=80",
  Furniture: "https://images.unsplash.com/photo-1555041469-a586c61ea9bc?auto=format&fit=crop&w=900&q=80",
  Clothes: "https://images.unsplash.com/photo-1489987707025-afc232f7ea0f?auto=format&fit=crop&w=900&q=80",
  "Building Materials": "https://images.unsplash.com/photo-1504307651254-35680f356dfd?auto=format&fit=crop&w=900&q=80",
  "Spare Parts": "https://images.unsplash.com/photo-1486262715619-67b85e0b08d3?auto=format&fit=crop&w=900&q=80",
  "Labor & Services": "https://images.unsplash.com/photo-1581578731548-c6464695cc69?auto=format&fit=crop&w=900&q=80",
  "ምንአለሽ_ተራ": "https://images.unsplash.com/photo-1472851294608-062f824d29cc?auto=format&fit=crop&w=900&q=80"
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Interactive AI classifier test endpoint: GET /?test=ai&q=...
    if (request.method === "GET" && url.searchParams.get("test") === "ai") {
      const sampleText = (url.searchParams.get("q") || "Bole G+2 Villa for sale 500 sqm with granite kitchen 85 million").trim();
      const normalized = normalizeEthiopicNumerals(sampleText);
      const specs = detectBrandModelYear(normalized);
      const ruleResult = detectCategoryWeighted(normalized, specs.brand, specs.subcategory);
      const aiResult = await classifyAdWithAI(normalized, null, specs, ruleResult, env);
      return new Response(
        JSON.stringify({ input: sampleText, specs, ruleResult, aiResult }, null, 2),
        { status: 200, headers: { "Content-Type": "application/json; charset=utf-8" } }
      );
    }

    // Live Firebase Firestore connection diagnostic: GET /?test=firebase
    if (request.method === "GET" && url.searchParams.get("test") === "firebase") {
      const projectId = cleanEnv(env.FIREBASE_PROJECT_ID) || "yeegna-gebeya";
      const tokenResult = await getFirebaseTokenDetailed(env);
      if (!tokenResult.token) {
        return new Response(
          JSON.stringify({ ok: false, projectId, step: "auth_token", error: tokenResult.error }, null, 2),
          { status: 500, headers: { "Content-Type": "application/json; charset=utf-8" } }
        );
      }
      try {
        const checkRes = await fetch(
          `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/ads?pageSize=1`,
          { headers: { Authorization: `Bearer ${tokenResult.token}` } }
        );
        const bodyText = await checkRes.text();
        let parsedBody = bodyText;
        try { parsedBody = JSON.parse(bodyText); } catch {}
        return new Response(
          JSON.stringify({
            ok: checkRes.ok,
            status: checkRes.status,
            projectId,
            docsFound: Array.isArray(parsedBody?.documents) ? parsedBody.documents.length : 0,
            error: checkRes.ok ? null : parsedBody
          }, null, 2),
          { status: checkRes.ok ? 200 : checkRes.status, headers: { "Content-Type": "application/json; charset=utf-8" } }
        );
      } catch (e) {
        return new Response(
          JSON.stringify({ ok: false, projectId, step: "firestore_read", error: e.message }, null, 2),
          { status: 500, headers: { "Content-Type": "application/json; charset=utf-8" } }
        );
      }
    }

    // Health & diagnostics endpoint on GET
    if (request.method !== "POST") {
      const botToken = cleanEnv(env.TELEGRAM_BOT_TOKEN);
      const geminiKey = cleanEnv(env.GEMINI_API_KEY);
      const cloudName = cleanEnv(env.CLOUDINARY_CLOUD_NAME);
      const uploadPreset = cleanEnv(env.CLOUDINARY_UPLOAD_PRESET);
      const fbProjectId = cleanEnv(env.FIREBASE_PROJECT_ID) || "yeegna-gebeya";
      const botConfigured = Boolean(botToken);
      const geminiConfigured = Boolean(geminiKey);
      const workersAiConfigured = Boolean(env.AI);
      const cloudinaryConfigured = Boolean(cloudName && cloudName !== "your_cloud_name" && uploadPreset);
      const targetChannel = cleanEnv(env.REPOST_CHANNEL_ID) || "@mebrigranite";
      const websiteUrl = cleanEnv(env.WEBSITE_URL) || "https://mebri.yegna.workers.dev";

      let webhookStatus = "Unknown (TELEGRAM_BOT_TOKEN missing)";
      if (botConfigured) {
        try {
          const whRes = await fetch(`https://api.telegram.org/bot${botToken}/getWebhookInfo`);
          const whData = await whRes.json();
          if (whData.ok && whData.result) {
            const currentWh = whData.result.url || "(NOT SET)";
            const errMsg = whData.result.last_error_message ? ` | Last Error: ${whData.result.last_error_message}` : "";
            webhookStatus = `${currentWh}${errMsg}`;
          } else {
            webhookStatus = `Invalid Bot Token (${whData.description || "unauthorized"}) ❌`;
          }
        } catch (e) {
          webhookStatus = `Check failed: ${e.message}`;
        }
      }

      const fbAuth = await getFirebaseTokenDetailed(env);
      const firebaseStatus = fbAuth.token
        ? `YES ✅ (Project: ${fbProjectId})`
        : `NO ❌ (${fbAuth.error})`;

      return new Response(
        `Yegna Gebeya Telegram Bot is Active ✅\n\n` +
        `• Worker URL: ${url.origin}\n` +
        `• Bot Token Configured: ${botConfigured ? "YES ✅" : "NO ❌ (Add TELEGRAM_BOT_TOKEN in Cloudflare Settings > Variables and Secrets!)"}\n` +
        `• Telegram Webhook URL: ${webhookStatus}\n` +
        `• AI Classification: ${geminiConfigured ? "Gemini 4 Hydrogen ✅" : workersAiConfigured ? "Cloudflare Workers AI (Free Built-in) ✅" : "Weighted Rule Classifier Only ⚠️"}\n` +
        `• Firebase Firestore Sync: ${firebaseStatus}\n` +
        `• Cloudinary Photo Upload: ${cloudinaryConfigured ? `YES ✅ (${cloudName} / ${uploadPreset})` : "NO ⚠️ (Set CLOUDINARY_CLOUD_NAME)"}\n` +
        `• Repost Channel: ${targetChannel}\n` +
        `• Website API: ${websiteUrl}/api/ads\n` +
        `• Version: v8.2 Firestore Sync Fix\n` +
        `\nDiagnostics:\n` +
        `• Test Firebase: ${url.origin}/?test=firebase\n` +
        `• Test AI: ${url.origin}/?test=ai&q=Toyota+Corolla+2020\n`,
        {
          status: 200,
          headers: { "Content-Type": "text/plain; charset=utf-8" }
        }
      );
    }

    try {
      const update = await request.json();

      // Fast ACK to Telegram: Return 200 OK immediately so Telegram never retries
      if (ctx && ctx.waitUntil) {
        ctx.waitUntil(processUpdateSafe(update, env, request));
      } else {
        processUpdateSafe(update, env, request);
      }
      return new Response("OK", { status: 200 });
    } catch (error) {
      console.error("Webhook parse error:", error.message);
      return new Response("OK", { status: 200 });
    }
  }
};

async function processUpdateSafe(update, env, request) {
  try {
    await processUpdate(update, env, request);
  } catch (err) {
    console.error("Unhandled processUpdate error:", err.message);
  }
}

async function processUpdate(update, env, request) {
  // 1. DEDUPLICATE TELEGRAM UPDATE ID
  if (update.update_id) {
    if (updateIdLocks.has(update.update_id)) {
      return;
    }
    updateIdLocks.add(update.update_id);
    if (updateIdLocks.size > 4000) {
      const firstKey = updateIdLocks.values().next().value;
      updateIdLocks.delete(firstKey);
    }
  }

  // 2. EXTRACT MESSAGE (Supports BOTH channel posts & group/private messages)
  const message = update.channel_post || update.message;
  if (!message) return;

  // Drop edited messages (prevents duplicate reposting on minor typos)
  if (update.edited_message || update.edited_channel_post) {
    return;
  }

  // Drop automatic forwards (Telegram forwards from channel into linked discussion group)
  if (message.is_automatic_forward) {
    return;
  }

  // 3. EXTRACT TEXT & CAPTION
  const rawText = (message.text || message.caption || "").trim();

  // 4. PRECISE WATERMARK LOOPBACK SHIELD
  if (hasBotWatermark(rawText)) {
    console.log("⏭️ Ignored: Post already has official bot watermark footer.");
    return;
  }

  // 5. IGNORE BOT'S OWN MESSAGES
  const botToken = cleanEnv(env.TELEGRAM_BOT_TOKEN);
  const botId = botToken ? botToken.split(":")[0] : "";
  if (message.from && botId) {
    const fromIdStr = String(message.from.id);
    if (fromIdStr === botId) {
      return;
    }
  }

  // 6. TARGET CHANNEL CLEANING AWARENESS
  const targetChannelRaw = env.REPOST_CHANNEL_ID || "@mebrigranite";
  const targetClean = targetChannelRaw.replace("@", "").toLowerCase();
  const currentChatUser = (message.chat?.username || "").toLowerCase();
  const currentChatIdStr = String(message.chat?.id || "");
  const isInsideTargetChannel = (currentChatUser === targetClean || currentChatIdStr === targetClean);

  // ============================================
  // MULTI-PHOTO ALBUM AGGREGATOR
  // ============================================
  if (message.media_group_id) {
    const groupId = String(message.media_group_id);
    const albumBroadcastKey = `album_done_${groupId}`;

    if (isMemoryLocked(albumBroadcastKey)) {
      return;
    }

    if (!albumStore.has(groupId)) {
      albumStore.set(groupId, {
        images: [],
        messageIds: [],
        caption: "",
        captionMsg: null,
        timerActive: false,
        timestamp: Date.now()
      });
    }

    const album = albumStore.get(groupId);

    if (message.photo && message.photo.length > 0) {
      const bestPhoto = message.photo[message.photo.length - 1].file_id;
      if (!album.images.includes(bestPhoto)) {
        album.images.push(bestPhoto);
      }
      if (!album.messageIds.includes(message.message_id)) {
        album.messageIds.push(message.message_id);
      }
    }

    if (rawText.length > 2 && !album.caption) {
      album.caption = rawText;
      album.captionMsg = message;
    }

    if (!album.timerActive) {
      album.timerActive = true;

      // Wait 2.5 seconds to collect all photos in the album from Telegram
      await new Promise((resolve) => setTimeout(resolve, 2500));

      const finalAlbumData = albumStore.get(groupId) || album;
      const allImages = Array.from(new Set(finalAlbumData.images || []));
      const messageIds = finalAlbumData.messageIds || [message.message_id];
      const postMsg = finalAlbumData.captionMsg || message;
      const postText = finalAlbumData.caption || rawText;

      const cleanText = cleanTheText(postText);
      if (cleanText.length < 2 && allImages.length === 0) {
        albumStore.delete(groupId);
        return;
      }

      if (isMemoryLocked(albumBroadcastKey)) {
        albumStore.delete(groupId);
        return;
      }

      claimMemoryLock(albumBroadcastKey, 300);
      albumStore.delete(groupId);

      console.log(`🚀 Processing album ${groupId} (${allImages.length} images)`);
      await processFinalAd(postMsg, allImages, messageIds, cleanText, env, groupId, isInsideTargetChannel);
    }

    cleanupOldStores();
    return;
  }

  // ============================================
  // SINGLE POST HANDLING (1 PHOTO OR TEXT ONLY)
  // ============================================
  const cleanText = cleanTheText(rawText);
  if (cleanText.length < 2 && (!message.photo || message.photo.length === 0)) return;

  const textHash = simpleHash((cleanText || "photo_ad").toLowerCase().replace(/\s+/g, " "));
  const singleAdLockKey = `single_${message.chat?.id || ""}_${textHash}`;

  if (isMemoryLocked(singleAdLockKey)) {
    console.log(`⏭️ Ignored: Duplicate single ad ${textHash}.`);
    return;
  }

  claimMemoryLock(singleAdLockKey, 180);

  const images = [];
  if (message.photo && message.photo.length > 0) {
    images.push(message.photo[message.photo.length - 1].file_id);
  }

  await processFinalAd(message, images, [message.message_id], cleanText, env, null, isInsideTargetChannel);
  cleanupOldStores();
}

// ============================================
// MEMORY LOCKING
// ============================================
function claimMemoryLock(key, ttlSeconds = 180) {
  const now = Date.now();
  const exp = memoryLocks.get(key);
  if (exp && exp > now) return false;
  memoryLocks.set(key, now + ttlSeconds * 1000);
  return true;
}

function isMemoryLocked(key) {
  const now = Date.now();
  const exp = memoryLocks.get(key);
  return Boolean(exp && exp > now);
}

function hasBotWatermark(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return (
    lower.includes("mebri.yegna.workers.dev") ||
    lower.includes("#yegnagebeya") ||
    (lower.includes("የኛ ገበያ") && lower.includes("@mebrigranite") && lower.includes("0911680790"))
  );
}

function cleanupOldStores() {
  const now = Date.now();
  const twoMinutesAgo = now - 120000;
  for (const [k, v] of albumStore.entries()) {
    if (v.timestamp < twoMinutesAgo) albumStore.delete(k);
  }
  if (memoryLocks.size > 2000) {
    for (const [k, v] of memoryLocks.entries()) {
      if (v <= now) memoryLocks.delete(k);
    }
  }
}

function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash = hash & hash;
  }
  return Math.abs(hash).toString();
}

function cleanEnv(val) {
  return typeof val === "string" ? val.trim() : "";
}

async function callTelegram(method, body, env) {
  const botToken = cleanEnv(env.TELEGRAM_BOT_TOKEN);
  if (!botToken) {
    console.error("❌ TELEGRAM_BOT_TOKEN is missing! Set it in Cloudflare Dashboard Variables.");
    throw new Error("TELEGRAM_BOT_TOKEN is missing");
  }

  const res = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(`${method} → ${data.description || res.statusText}`);
  return data.result;
}

function safeSubstring(str, maxLen) {
  if (!str) return "";
  if (str.length <= maxLen) return str;
  let out = "";
  for (const ch of str) {
    if (out.length + ch.length > maxLen) break;
    out += ch;
  }
  return out;
}

// ============================================
// ETHIOPIC NUMERAL & TEXT NORMALIZER
// ============================================
const ETHIOPIC_ONES = { "፩": 1, "፪": 2, "፫": 3, "፬": 4, "፭": 5, "፮": 6, "፯": 7, "፰": 8, "፱": 9 };
const ETHIOPIC_TENS = { "፲": 10, "፳": 20, "፴": 30, "፵": 40, "፶": 50, "፷": 60, "፸": 70, "፹": 80, "፺": 90 };

function normalizeEthiopicNumerals(text) {
  if (!text) return "";
  return text.replace(/[፩-፼]+/g, (token) => {
    let total = 0;
    let current = 0;
    for (const ch of token) {
      if (ETHIOPIC_ONES[ch] !== undefined) current += ETHIOPIC_ONES[ch];
      else if (ETHIOPIC_TENS[ch] !== undefined) current += ETHIOPIC_TENS[ch];
      else if (ch === "፻") {
        total += (current || 1) * 100;
        current = 0;
      } else if (ch === "፼") {
        total = (total + (current || 1)) * 10000;
        current = 0;
      }
    }
    return String(total + current);
  });
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

// ============================================
// CARS & ELECTRONICS DATABASE (No \b around Amharic!)
// ============================================
const CAR_DATABASE = [
  {
    name: "BYD",
    regex: /(?:\bbyd\b|ባይድ|ቢዋይዲ)/i,
    models: [
      { name: "Sealion 06 EV", regex: /sealion\s*06|ሲላየን\s*06/i, subcategory: "Electric (EV)" },
      { name: "Sealion 07", regex: /sealion\s*07|ሲላየን\s*07/i, subcategory: "Electric (EV)" },
      { name: "Seagull", regex: /seagull|ሲገል/i, subcategory: "Electric (EV)" },
      { name: "Seal", regex: /\bseal\b/i, subcategory: "Electric (EV)" },
      { name: "Song Plus EV", regex: /song\s*plus|ሶንግ\s*ፕላስ/i, subcategory: "Electric (EV)" },
      { name: "Atto 3 / Yuan Plus", regex: /(?:atto\s*3|yuan\s*plus|አቶ\s*3|ዩአን\s*ፕላስ)/i, subcategory: "Electric (EV)" },
      { name: "Tang", regex: /\btang\b|ታንግ/i, subcategory: "Electric (EV)" },
      { name: "Han", regex: /\bhan\b/i, subcategory: "Electric (EV)" },
      { name: "Dolphin", regex: /dolphin|ዶልፊን/i, subcategory: "Electric (EV)" },
      { name: "Qin Plus", regex: /qin\s*plus|ቺን\s*ፕላስ/i, subcategory: "Sedan" },
      { name: "Chazor / Destroyer 05", regex: /(?:chazor|destroyer\s*05)/i, subcategory: "Sedan" }
    ]
  },
  {
    name: "Toyota",
    regex: /(?:\btoyota\b|ቶዮታ|ቶዬታ)/i,
    models: [
      { name: "Corolla", regex: /corolla|ኮሮላ/i, subcategory: "Sedan" },
      { name: "RAV4", regex: /rav\s*4|ራቭ\s*4|ራቭ4/i, subcategory: "SUV / Crossover" },
      { name: "Land Cruiser", regex: /land\s*cruiser|ላንድ\s*ክሩዘር|ላንድክሩዘር/i, subcategory: "SUV / Crossover" },
      { name: "Prado", regex: /prado|ፕራዶ/i, subcategory: "SUV / Crossover" },
      { name: "Hilux", regex: /hilux|ሃይሉክስ|ሀይሉክስ/i, subcategory: "Pickup / Truck" },
      { name: "Yaris", regex: /yaris|ያሪስ/i, subcategory: "Hatchback / Compact" },
      { name: "Vitz", regex: /vitz|ቪትዝ/i, subcategory: "Hatchback / Compact" },
      { name: "Camry", regex: /camry|ካምሪ/i, subcategory: "Sedan" },
      { name: "Rush", regex: /rush|ራሽ/i, subcategory: "SUV / Crossover" },
      { name: "HiAce", regex: /hiace|ሀይአይስ|ሃይኤስ|ዶልፊን\s*ቫን/i, subcategory: "Van / Minibus" },
      { name: "bz4X", regex: /bz4x|ቢዜድ4ኤክስ/i, subcategory: "Electric (EV)" },
      { name: "Fortuner", regex: /fortuner|ፎርቹነር|ፎርቹን/i, subcategory: "SUV / Crossover" }
    ]
  },
  {
    name: "Suzuki",
    regex: /(?:\bsuzuki\b|ሱዙኪ|ሱዚኪ)/i,
    models: [
      { name: "Swift", regex: /\bswift\b|ስዊፍት/i, subcategory: "Hatchback / Compact" },
      { name: "Dzire", regex: /dzire|ዲዛየር|ድዛየር/i, subcategory: "Sedan" },
      { name: "Celerio", regex: /celerio|ሴሌሪዮ/i, subcategory: "Hatchback / Compact" },
      { name: "Alto", regex: /\balto\b|አልቶ/i, subcategory: "Hatchback / Compact" },
      { name: "Vitara", regex: /vitara|ቪታራ/i, subcategory: "SUV / Crossover" },
      { name: "Jimny", regex: /jimny|ጂምኒ/i, subcategory: "SUV / Crossover" },
      { name: "Ertiga", regex: /ertiga|ኤርቲጋ/i, subcategory: "Van / Minibus" },
      { name: "S-Presso", regex: /s-?presso|ኤስፕሬሶ/i, subcategory: "Hatchback / Compact" }
    ]
  },
  {
    name: "Hyundai",
    regex: /(?:\bhyundai\b|ሂዩንዳይ|ሃዩንዳይ|ሀዩንዳይ)/i,
    models: [
      { name: "Elantra", regex: /elantra|ኤላንትራ|ኢላንትራ/i, subcategory: "Sedan" },
      { name: "Tucson", regex: /tucson|ቱክሰን|ቱሰን/i, subcategory: "SUV / Crossover" },
      { name: "Avante", regex: /avante|አቫንቴ/i, subcategory: "Sedan" },
      { name: "Creta", regex: /creta|ክሬታ/i, subcategory: "SUV / Crossover" },
      { name: "Santa Fe", regex: /santa\s*fe|ሳንታፌ|ሳንታ\s*ፌ/i, subcategory: "SUV / Crossover" },
      { name: "Ioniq 5", regex: /ioniq\s*5|አዮኒክ\s*5/i, subcategory: "Electric (EV)" },
      { name: "Ioniq 6", regex: /ioniq\s*6/i, subcategory: "Electric (EV)" },
      { name: "Grand i10", regex: /i10|አይ10|አይ\s*10/i, subcategory: "Hatchback / Compact" },
      { name: "Kona", regex: /kona|ኮና/i, subcategory: "SUV / Crossover" },
      { name: "Staria", regex: /staria|ስታሪያ/i, subcategory: "Van / Minibus" }
    ]
  },
  {
    name: "Volkswagen",
    regex: /(?:\bvolkswagen\b|\bvw\b|ፎልክስዋገን|ቮልስዋገን|ቮልክስዋገን)/i,
    models: [
      { name: "ID.4 Crozz", regex: /id\.?\s*4|አይዲ\s*4/i, subcategory: "Electric (EV)" },
      { name: "ID.6 Crozz", regex: /id\.?\s*6|አይዲ\s*6/i, subcategory: "Electric (EV)" },
      { name: "ID.3", regex: /id\.?\s*3|አይዲ\s*3/i, subcategory: "Electric (EV)" },
      { name: "Tiguan", regex: /tiguan|ቲጓን/i, subcategory: "SUV / Crossover" },
      { name: "Golf", regex: /\bgolf\b|ጎልፍ/i, subcategory: "Hatchback / Compact" }
    ]
  },
  {
    name: "Geely",
    regex: /(?:\bgeely\b|ጂሊ)/i,
    models: [
      { name: "Coolray", regex: /coolray|ኩልሬይ/i, subcategory: "SUV / Crossover" },
      { name: "Geometry C", regex: /geometry\s*c/i, subcategory: "Electric (EV)" },
      { name: "Monjaro", regex: /monjaro/i, subcategory: "SUV / Crossover" }
    ]
  },
  {
    name: "Changan",
    regex: /(?:\bchangan\b|ቻንጋን)/i,
    models: [
      { name: "CS35 Plus", regex: /cs35/i, subcategory: "SUV / Crossover" },
      { name: "CS55 Plus", regex: /cs55/i, subcategory: "SUV / Crossover" },
      { name: "UNI-T", regex: /uni-?t/i, subcategory: "SUV / Crossover" },
      { name: "UNI-K", regex: /uni-?k/i, subcategory: "SUV / Crossover" },
      { name: "BenBen E-Star", regex: /benben/i, subcategory: "Electric (EV)" }
    ]
  },
  {
    name: "Jetour",
    regex: /(?:\bjetour\b|ጄቱር)/i,
    models: [
      { name: "Dashing", regex: /dashing|ዳሺንግ/i, subcategory: "SUV / Crossover" },
      { name: "X70 Plus", regex: /x70/i, subcategory: "SUV / Crossover" },
      { name: "Traveler (T2)", regex: /(?:traveler|\bt2\b)/i, subcategory: "SUV / Crossover" }
    ]
  },
  {
    name: "Kia",
    regex: /(?:\bkia\b|ኪያ|ኪአ)/i,
    models: [
      { name: "Sportage", regex: /sportage|ስፖርቴጅ/i, subcategory: "SUV / Crossover" },
      { name: "Sorento", regex: /sorento|ሶሬንቶ/i, subcategory: "SUV / Crossover" },
      { name: "Picanto", regex: /picanto|ፒካንቶ/i, subcategory: "Hatchback / Compact" },
      { name: "EV6", regex: /\bev6\b/i, subcategory: "Electric (EV)" }
    ]
  },
  {
    name: "Mercedes-Benz",
    regex: /(?:\bmercedes\b|\bbenz\b|መርሴዲስ|ሜርሴዲስ|ቤንዝ)/i,
    models: [
      { name: "C-Class", regex: /\b(?:c-?class|c\s*[123]\d{2})\b/i, subcategory: "Sedan" },
      { name: "E-Class", regex: /\b(?:e-?class|e\s*[234]\d{2})\b/i, subcategory: "Sedan" },
      { name: "S-Class", regex: /\b(?:s-?class|s\s*[456]\d{2})\b/i, subcategory: "Sedan" },
      { name: "G-Wagon / G-Class", regex: /g-?wagon|g\s*63|g\s*500|ጂ\s*ክላስ/i, subcategory: "SUV / Crossover" },
      { name: "GLE", regex: /\bgle\b/i, subcategory: "SUV / Crossover" }
    ]
  },
  {
    name: "Nissan",
    regex: /(?:\bnissan\b|ኒሳን)/i,
    models: [
      { name: "Patrol", regex: /patrol|ፓትሮል/i, subcategory: "SUV / Crossover" },
      { name: "X-Trail", regex: /x-?trail|ኤክስትሬል/i, subcategory: "SUV / Crossover" },
      { name: "Qashqai", regex: /qashqai/i, subcategory: "SUV / Crossover" },
      { name: "Sunny", regex: /sunny|ሳኒ/i, subcategory: "Sedan" }
    ]
  },
  {
    name: "Land Rover",
    regex: /(?:\brange\s*rover\b|\bland\s*rover\b|ሬንጅ\s*ሮቨር)/i,
    models: [
      { name: "Defender", regex: /defender|ዲፌንደር/i, subcategory: "SUV / Crossover" },
      { name: "Sport", regex: /range\s*rover\s*sport/i, subcategory: "SUV / Crossover" },
      { name: "Vogue", regex: /vogue/i, subcategory: "SUV / Crossover" },
      { name: "Evoque", regex: /evoque/i, subcategory: "SUV / Crossover" }
    ]
  },
  {
    name: "Chery",
    regex: /(?:\bchery\b|ቼሪ|ቸሪ)/i,
    models: [
      { name: "Tiggo 4 Pro", regex: /tiggo\s*4|ቲጎ\s*4/i, subcategory: "SUV / Crossover" },
      { name: "Tiggo 7 Pro", regex: /tiggo\s*7|ቲጎ\s*7/i, subcategory: "SUV / Crossover" },
      { name: "Tiggo 8 Pro", regex: /tiggo\s*8|ቲጎ\s*8/i, subcategory: "SUV / Crossover" },
      { name: "EQ1 / Little Ant", regex: /eq1|little\s*ant/i, subcategory: "Electric (EV)" }
    ]
  },
  {
    name: "Zeekr",
    regex: /(?:\bzeekr\b|ዚከር)/i,
    models: [
      { name: "001", regex: /\bzeekr\s*001\b/i, subcategory: "Electric (EV)" },
      { name: "007", regex: /\bzeekr\s*007\b/i, subcategory: "Electric (EV)" },
      { name: "009", regex: /\bzeekr\s*009\b/i, subcategory: "Electric (EV)" },
      { name: "X", regex: /\bzeekr\s*x\b/i, subcategory: "Electric (EV)" }
    ]
  },
  {
    name: "Li Auto (Li Xiang)",
    regex: /(?:\bli\s*auto\b|\blixiang\b|ሊ\s*አውቶ)/i,
    models: [
      { name: "L6", regex: /\b(?:li\s*)?l6\b/i, subcategory: "SUV / Crossover", requireBrand: true },
      { name: "L7", regex: /\b(?:li\s*)?l7\b/i, subcategory: "SUV / Crossover", requireBrand: true },
      { name: "L8", regex: /\b(?:li\s*)?l8\b/i, subcategory: "SUV / Crossover", requireBrand: true },
      { name: "L9", regex: /\b(?:li\s*)?l9\b/i, subcategory: "SUV / Crossover", requireBrand: true }
    ]
  },
  {
    name: "Isuzu",
    regex: /(?:\bisuzu\b|ኢሱዙ)/i,
    models: [
      { name: "FSR / NPR Truck", regex: /(?:\bfsr\b|\bnpr\b|ኤፍኤስአር|ኤንፒአር)/i, subcategory: "Pickup / Truck" },
      { name: "D-Max", regex: /d-?max|ዲማክስ/i, subcategory: "Pickup / Truck" }
    ]
  }
];

const ELECTRONICS_DATABASE = [
  {
    name: "Apple",
    regex: /(?:\bapple\b|\biphone\b|\bmacbook\b|\bipad\b|አፕል|አይፎን|ማክቡክ|አይፓድ)/i,
    models: [
      { name: "iPhone 16 Pro Max", regex: /16\s*pro\s*max|16\s*ፕሮ\s*ማክስ/i, subcategory: "Smartphones & Tablets" },
      { name: "iPhone 16 Pro", regex: /16\s*pro\b|16\s*ፕሮ/i, subcategory: "Smartphones & Tablets" },
      { name: "iPhone 16", regex: /iphone\s*16|አይፎን\s*16/i, subcategory: "Smartphones & Tablets" },
      { name: "iPhone 15 Pro Max", regex: /15\s*pro\s*max|15\s*ፕሮ\s*ማክስ/i, subcategory: "Smartphones & Tablets" },
      { name: "iPhone 15 Pro", regex: /15\s*pro\b|15\s*ፕሮ/i, subcategory: "Smartphones & Tablets" },
      { name: "iPhone 15", regex: /iphone\s*15\b|አይፎን\s*15/i, subcategory: "Smartphones & Tablets" },
      { name: "iPhone 14 Pro Max", regex: /14\s*pro\s*max|14\s*ፕሮ\s*ማክስ/i, subcategory: "Smartphones & Tablets" },
      { name: "iPhone 13", regex: /iphone\s*13|አይፎን\s*13/i, subcategory: "Smartphones & Tablets" },
      { name: "MacBook Pro", regex: /macbook\s*pro|ማክቡክ\s*ፕሮ/i, subcategory: "Laptops & Computers" },
      { name: "MacBook Air", regex: /macbook\s*air|ማክቡክ\s*ኤር/i, subcategory: "Laptops & Computers" },
      { name: "iPad Pro", regex: /ipad|አይፓድ/i, subcategory: "Smartphones & Tablets" }
    ]
  },
  {
    name: "Samsung",
    regex: /(?:\bsamsung\b|\bgalaxy\b|ሳምሰንግ|ጋላክሲ)/i,
    models: [
      { name: "Galaxy S24 Ultra", regex: /s24\s*ultra|ኤስ\s*24\s*አልትራ/i, subcategory: "Smartphones & Tablets" },
      { name: "Galaxy S24", regex: /s24|ኤስ\s*24/i, subcategory: "Smartphones & Tablets" },
      { name: "Galaxy S23 Ultra", regex: /s23\s*ultra|ኤስ\s*23\s*አልትራ/i, subcategory: "Smartphones & Tablets" },
      { name: "Galaxy Z Fold", regex: /z\s*fold/i, subcategory: "Smartphones & Tablets" },
      { name: "Galaxy Z Flip", regex: /z\s*flip/i, subcategory: "Smartphones & Tablets" }
    ]
  },
  {
    name: "Sony",
    regex: /(?:\bsony\b|\bplaystation\b|\bps5\b|\bps4\b|ሶኒ|ፕሌይስቴሽን)/i,
    models: [
      { name: "PlayStation 5", regex: /ps5|playstation\s*5/i, subcategory: "Gaming & Consoles" },
      { name: "Bravia TV", regex: /bravia|\btv\b|ቴሌቪዥን/i, subcategory: "TV & Home Entertainment" }
    ]
  }
];

// ============================================
// MAIN PROCESSING & AD BROADCASTER
// ============================================
async function processFinalAd(message, imageFileIds, messageIds, cleanText, env, mediaGroupId = null, isInsideTargetChannel = false) {
  const normalizedText = normalizeEthiopicNumerals(cleanText);
  let specs = detectBrandModelYear(normalizedText);
  const ruleResult = detectCategoryWeighted(normalizedText, specs.brand, specs.subcategory);

  let category = ruleResult.category;
  let subcategory = ruleResult.subcategory;
  let aiTitle = "";
  let aiSource = "rules";

  // AI Classification (Runs for BOTH text-only & photo ads via Gemini or Cloudflare Workers AI)
  const aiResult = await classifyAdWithAI(normalizedText, imageFileIds[0] || null, specs, ruleResult, env);
  if (aiResult) {
    aiSource = aiResult.provider || "ai";
    const validatedCategory = normalizeCategory(aiResult.category);
    if (validatedCategory && (aiResult.confidence === undefined || aiResult.confidence >= 0.45)) {
      category = validatedCategory;
    }
    if (aiResult.subcategory && typeof aiResult.subcategory === "string") {
      subcategory = aiResult.subcategory.trim();
    } else if (category !== ruleResult.category) {
      subcategory = DEFAULT_SUBCATEGORIES[category] || "General";
    }

    if (!specs.brand && aiResult.brand) specs.brand = cleanSpecValue(aiResult.brand);
    if (!specs.model && aiResult.model) specs.model = cleanSpecValue(aiResult.model);
    if (!specs.year && aiResult.year) specs.year = cleanSpecValue(aiResult.year);
    if (!specs.trim && aiResult.trim) specs.trim = cleanSpecValue(aiResult.trim);
    if (!specs.bodyType && aiResult.bodyType) specs.bodyType = cleanSpecValue(aiResult.bodyType);
    if (!specs.fuelType && aiResult.fuelType) specs.fuelType = cleanSpecValue(aiResult.fuelType);
    if (!specs.transmission && aiResult.transmission) specs.transmission = cleanSpecValue(aiResult.transmission);
    if (aiResult.suggestedTitle) aiTitle = cleanSpecValue(aiResult.suggestedTitle);
  }

  // Only keep vehicle/electronics brand metadata when category matches Cars / Electronics / Spare Parts
  if (!["Cars", "Electronics", "Spare Parts"].includes(category)) {
    if (category === "Houses" || category === "Rentals" || category === "Furniture" || category === "Clothes" || category === "Building Materials" || category === "Labor & Services") {
      specs.brand = "";
      specs.model = "";
      specs.fuelType = "";
      specs.transmission = "";
    }
  }

  if (!subcategory || subcategory === "Vehicles" && category !== "Cars") {
    subcategory = DEFAULT_SUBCATEGORIES[category] || "General Marketplace";
  }

  const arrangedTitle = arrangeTitle({
    brand: specs.brand,
    model: specs.model,
    year: specs.year,
    trim: specs.trim,
    cleanText,
    category,
    subcategory,
    aiTitle
  });

  const { formattedPrice, rawPrice } = parseMathematicalPrice(normalizedText, specs.year);
  const { city, subcity } = extractCityAndSubcity(normalizedText);
  const textHash = simpleHash((cleanText || arrangedTitle).toLowerCase().replace(/\s+/g, " "));

  console.log(`🏷️ Classified [${aiSource}] -> ${category} > ${subcategory} | Title: ${arrangedTitle}`);

  // Upload photos to Cloudinary if configured
  const imageUrls = await uploadImagesToCloudinary(imageFileIds.slice(0, 4), env);
  const finalDisplayImages = imageUrls.length > 0
    ? imageUrls
    : [DEFAULT_CATEGORY_IMAGES[category] || DEFAULT_CATEGORY_IMAGES["ምንአለሽ_ተራ"]];

  // ============================================
  // 1. SAVE TO WEBSITE DIRECTLY (/api/ads)
  // ============================================
  const websiteBaseUrl = (env.WEBSITE_URL || "https://mebri.yegna.workers.dev").replace(/\/$/, "");
  const adOwnerEmail = env.ADMIN_EMAIL || "marbatu1@gmail.com";
  const adDocId = mediaGroupId ? `tg_${message.chat?.id || ""}_${mediaGroupId}` : `tg_${textHash}`;

  try {
    const webAdPayload = {
      id: adDocId,
      title: arrangedTitle,
      category,
      subcategory,
      price: rawPrice,
      city,
      subcity,
      condition: /(brand\s*new|zero\s*km|0\s*km|አዲስ)/i.test(normalizedText) ? "New" : "Used",
      images: finalDisplayImages,
      description: cleanText,
      phone: "0911680790",
      sellerName: "የኛ ገበያ (Telegram Bot)",
      featured: true,
      source: "telegram",
      ownerEmail: adOwnerEmail,
      userEmail: adOwnerEmail,
      status: "available"
    };

    await fetch(`${websiteBaseUrl}/api/ads`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(webAdPayload)
    });
    console.log(`✅ Ad synced to website (${adOwnerEmail}): ${websiteBaseUrl}/api/ads`);
  } catch (webApiErr) {
    console.warn("Website API sync skipped:", webApiErr.message);
  }

  // ============================================
  // 2. SAVE TO FIREBASE FIRESTORE (IF CONFIGURED)
  // ============================================
  try {
    const projectId = cleanEnv(env.FIREBASE_PROJECT_ID) || "yeegna-gebeya";
    const fbAuth = await getFirebaseTokenDetailed(env);
    if (!fbAuth.token) {
      console.warn("Firebase sync skipped:", fbAuth.error);
    } else {
      const token = fbAuth.token;
      const adOwnerId = await resolveAdminUidByEmail(token, projectId, adOwnerEmail, env.ADMIN_UID || "admin_bot");
      const fbUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/ads/${adDocId}`;
      const adCondition = /(brand\s*new|zero\s*km|0\s*km|አዲስ)/i.test(normalizedText) ? "New" : "Used";

      const adData = {
        fields: {
          title: { stringValue: arrangedTitle },
          brand: { stringValue: specs.brand || "" },
          model: { stringValue: specs.model || "" },
          year: { stringValue: specs.year || "" },
          trim: { stringValue: specs.trim || "" },
          bodyType: { stringValue: specs.bodyType || "" },
          fuelType: { stringValue: specs.fuelType || "" },
          transmission: { stringValue: specs.transmission || "" },
          category: { stringValue: category },
          subcategory: { stringValue: subcategory },
          condition: { stringValue: adCondition },
          description: { stringValue: cleanText },
          textHash: { stringValue: textHash },
          price: { stringValue: String(rawPrice || 0) },
          formattedPrice: { stringValue: formattedPrice },
          rawPrice: { integerValue: String(rawPrice || 0) },
          phone: { stringValue: "0911680790" },
          sellerName: { stringValue: "የኛ ገበያ (Telegram Bot)" },
          city: { stringValue: city },
          subcity: { stringValue: subcity },
          image: { stringValue: finalDisplayImages[0] },
          images: { arrayValue: { values: finalDisplayImages.map((url) => ({ stringValue: url })) } },
          status: { stringValue: "available" },
          featured: { booleanValue: true },
          source: { stringValue: "telegram" },
          isBotPost: { booleanValue: true },
          userId: { stringValue: adOwnerId },
          uid: { stringValue: adOwnerId },
          ownerId: { stringValue: adOwnerId },
          userEmail: { stringValue: adOwnerEmail },
          email: { stringValue: adOwnerEmail },
          ownerEmail: { stringValue: adOwnerEmail },
          views: { integerValue: "0" },
          createdAt: { timestampValue: new Date().toISOString() }
        }
      };

      const fbRes = await fetch(fbUrl, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(adData)
      });
      if (!fbRes.ok) {
        const fbErrText = await fbRes.text().catch(() => fbRes.statusText);
        console.error(`❌ Firestore PATCH failed (${fbRes.status}) on ${projectId}:`, fbErrText);
      } else {
        console.log(`✅ Saved to Website Firestore (${projectId}) for ${adOwnerEmail} (${adOwnerId})`);
      }
    }
  } catch (fbErr) {
    console.warn("Firebase sync skipped:", fbErr.message);
  }

  // ============================================
  // 3. BUILD STRUCTURED POST TEXT WITH BOT FOOTER
  // ============================================
  const hashtagMap = {
    Cars: "#Cars",
    Houses: "#Houses",
    Rentals: "#Rentals",
    Electronics: "#Electronics",
    Furniture: "#Furniture",
    Clothes: "#Clothes",
    "Building Materials": "#BuildingMaterials",
    "Spare Parts": "#SpareParts",
    "Labor & Services": "#Labor",
    "ምንአለሽ_ተራ": "#ምንአለሽ_ተራ"
  };
  const hashtag = hashtagMap[category] || "#ምንአለሽ_ተራ";
  const displayPriceText = formattedPrice && formattedPrice !== "0" ? `${formattedPrice} ETB` : "Negotiable / ተደራዳሪ";

  let headerText = `📝 Title: ${arrangedTitle}\n`;
  if (specs.brand || specs.model || specs.year) {
    const metaParts = [];
    if (specs.brand) metaParts.push(`Make: ${specs.brand}`);
    if (specs.model) metaParts.push(`Model: ${specs.model}`);
    if (specs.year && category === "Cars") metaParts.push(`Year: ${specs.year}`);
    if (metaParts.length > 0) headerText += `🏷️ ${metaParts.join(" | ")}\n`;
  }
  headerText += `📂 Category: ${category}${subcategory ? ` › ${subcategory}` : ""}\n`;
  headerText += `📍 Location: ${subcity ? `${subcity}, ${city}` : city}\n`;
  headerText += `💰 Price: ${displayPriceText}\n`;
  if (category === "Cars" && (specs.transmission || specs.fuelType)) {
    const specParts = [];
    if (specs.transmission) specParts.push(`⚙️ ${specs.transmission}`);
    if (specs.fuelType) specParts.push(`⛽ ${specs.fuelType}`);
    headerText += `${specParts.join(" | ")}\n`;
  }

  let footerText = `\n━━━━━━━━━━━━━━━\n`;
  footerText += `🏢 የኛ ገበያ (Yegna Gebeya)\n`;
  footerText += `📞 Phone: 0911680790\n`;
  footerText += `🌐 Website: mebri.yegna.workers.dev\n`;
  footerText += `✈️ Telegram: @mebrigranite\n`;
  footerText += `━━━━━━━━━━━━━━━\n\n`;
  footerText += `${hashtag} #YegnaGebeya`;

  const fixedLen = headerText.length + footerText.length + 15;
  const maxDetailsLen = Math.max(100, 1020 - fixedLen);
  let safeDetails = safeSubstring(cleanText, maxDetailsLen);
  if (cleanText.length > maxDetailsLen) safeDetails = safeDetails.trimEnd() + "…";

  const newPostText = `${headerText}\n📄 Details:\n${safeDetails}${footerText}`;

  const isPhoto = imageFileIds && imageFileIds.length > 0;
  const chatId = message.chat.id;
  const lastPhotoFileId = isPhoto ? imageFileIds[imageFileIds.length - 1] : null;

  // ============================================
  // 4. IN-CHANNEL CLEANING VS GROUP CLEANING
  // ============================================
  if (isInsideTargetChannel) {
    try {
      if (isPhoto) {
        await callTelegram("editMessageCaption", {
          chat_id: chatId,
          message_id: message.message_id,
          caption: safeSubstring(newPostText, 1024)
        }, env);
      } else {
        await callTelegram("editMessageText", {
          chat_id: chatId,
          message_id: message.message_id,
          text: safeSubstring(newPostText, 4096)
        }, env);
      }
      console.log("✅ Cleaned in-place directly inside target channel!");
      return;
    } catch (chanEditErr) {
      console.warn("In-channel edit failed (check bot admin rights in channel):", chanEditErr.message);
      return;
    }
  }

  // ============================================
  // 5. CLEANING IN SOURCE GROUP / PRIVATE CHAT
  // ============================================
  let messageHandledInSource = false;

  try {
    if (isPhoto) {
      await callTelegram("editMessageCaption", {
        chat_id: chatId,
        message_id: message.message_id,
        caption: safeSubstring(newPostText, 1024)
      }, env);
    } else {
      await callTelegram("editMessageText", {
        chat_id: chatId,
        message_id: message.message_id,
        text: safeSubstring(newPostText, 4096)
      }, env);
    }
    console.log("✅ Edited in place in source chat.");
    messageHandledInSource = true;
  } catch (editErr) {
    // Normal for user messages in groups
  }

  if (!messageHandledInSource) {
    try {
      if (messageIds.length === 1) {
        await callTelegram("deleteMessage", { chat_id: chatId, message_id: messageIds[0] }, env);
      } else if (messageIds.length > 1) {
        try {
          await callTelegram("deleteMessages", { chat_id: chatId, message_ids: messageIds }, env);
        } catch {
          for (const mid of messageIds) {
            await callTelegram("deleteMessage", { chat_id: chatId, message_id: mid }, env).catch(() => {});
          }
        }
      }
      console.log(`✅ Deleted ${messageIds.length} dirty post(s) from group`);
    } catch (delErr) {
      console.warn("Delete original failed (bot needs 'Delete Messages' admin permission in group):", delErr.message);
    }

    try {
      if (imageFileIds.length === 0) {
        await callTelegram("sendMessage", {
          chat_id: chatId,
          text: safeSubstring(newPostText, 4096)
        }, env);
      } else if (imageFileIds.length === 1) {
        await callTelegram("sendPhoto", {
          chat_id: chatId,
          photo: lastPhotoFileId,
          caption: safeSubstring(newPostText, 1024)
        }, env);
      } else {
        const media = imageFileIds.slice(0, 10).map((fileId, index) => ({
          type: "photo",
          media: fileId,
          ...(index === 0 ? { caption: safeSubstring(newPostText, 1024) } : {})
        }));
        await callTelegram("sendMediaGroup", { chat_id: chatId, media }, env);
      }
      console.log("✅ Sent clean message to source chat");
    } catch (repostErr) {
      console.error("❌ Failed to send clean message to source chat:", repostErr.message);
    }
  }

  // ============================================
  // 6. BROADCAST TO REPOST CHANNEL (@mebrigranite)
  // ============================================
  const targetChannel = env.REPOST_CHANNEL_ID || "@mebrigranite";

  if (targetChannel && !isInsideTargetChannel) {
    try {
      if (imageFileIds.length === 0) {
        await callTelegram("sendMessage", {
          chat_id: targetChannel,
          text: safeSubstring(newPostText, 4096)
        }, env);
      } else if (imageFileIds.length === 1) {
        await callTelegram("sendPhoto", {
          chat_id: targetChannel,
          photo: imageFileIds[0],
          caption: safeSubstring(newPostText, 1024)
        }, env);
      } else {
        const media = imageFileIds.slice(0, 10).map((fileId, index) => ({
          type: "photo",
          media: fileId,
          ...(index === 0 ? { caption: safeSubstring(newPostText, 1024) } : {})
        }));

        await callTelegram("sendMediaGroup", {
          chat_id: targetChannel,
          media
        }, env);
      }
      console.log(`✅ Broadcasted Clean Ad to Channel ${targetChannel} (${imageFileIds.length} photos)`);
    } catch (chErr) {
      console.error(`❌ Repost Channel Error (${targetChannel}):`, chErr.message);
    }
  }
}

// ============================================
// AI CATEGORY + VISION CLASSIFIER
// ============================================
function cleanSpecValue(val) {
  if (typeof val !== "string") return "";
  const cleaned = val.trim();
  if (/^(null|none|n\/a|unknown|na)$/i.test(cleaned)) return "";
  return cleaned;
}

function normalizeCategory(raw) {
  if (!raw) return null;
  const c = String(raw).trim().toLowerCase();
  if (c === "cars" || c === "car" || c === "vehicles" || c === "auto" || c.includes("መኪና")) return "Cars";
  if (c === "houses" || c === "house" || c === "real estate" || c === "property" || c.includes("ቤት")) return "Houses";
  if (c === "rentals" || c === "rental" || c === "rent" || c.includes("ኪራይ")) return "Rentals";
  if (c === "electronics" || c === "electronic" || c === "phones" || c.includes("ኤሌክትሮኒክ")) return "Electronics";
  if (c === "furniture" || c.includes("ፈርኒቸር")) return "Furniture";
  if (c === "clothes" || c === "fashion" || c === "clothing" || c.includes("ልብስ")) return "Clothes";
  if (c === "building materials" || c === "construction" || c.includes("ግንባታ")) return "Building Materials";
  if (c === "spare parts" || c === "auto parts" || c === "parts" || c.includes("መለዋወጫ")) return "Spare Parts";
  if (c === "labor & services" || c === "services" || c === "service" || c.includes("አገልግሎት")) return "Labor & Services";
  if (c === "ምንአለሽ_ተራ" || c === "ምንአለሽ ተራ" || c === "general" || c === "other") return "ምንአለሽ_ተራ";
  return null;
}

function parseJsonObjectSafe(rawText) {
  if (!rawText) return null;
  if (typeof rawText === "object") return rawText;
  let str = String(rawText).trim();
  str = str.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const firstBrace = str.indexOf("{");
  const lastBrace = str.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    str = str.slice(firstBrace, lastBrace + 1);
  }
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

function getTimeoutSignal(ms) {
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    return AbortSignal.timeout(ms);
  }
  return undefined;
}

async function fetchTelegramPhotoBase64(fileId, env) {
  const botToken = cleanEnv(env.TELEGRAM_BOT_TOKEN);
  if (!fileId || !botToken) return null;
  try {
    const fileRes = await callTelegram("getFile", { file_id: fileId }, env);
    if (!fileRes?.file_path) return null;
    const tgUrl = `https://api.telegram.org/file/bot${botToken}/${fileRes.file_path}`;
    const imgFetch = await fetch(tgUrl, { signal: getTimeoutSignal(6000) });
    if (!imgFetch.ok) return null;
    const arrayBuffer = await imgFetch.arrayBuffer();
    if (arrayBuffer.byteLength > 4 * 1024 * 1024) return null; // Keep memory bounded on Worker
    const ext = fileRes.file_path.split(".").pop()?.toLowerCase();
    const mimeType = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
    return { base64: arrayBufferToBase64(arrayBuffer), mimeType };
  } catch {
    return null;
  }
}

function buildClassifierPrompt(cleanText, imageDescription = "") {
  return `You are an expert Ethiopian marketplace (Yegna Gebeya) ad classifier for English and Amharic listings.
Classify the PRIMARY item/service being sold or rented into EXACTLY ONE category from this list:
- "Cars": Whole cars, SUVs, pickups, trucks, EVs, minibuses for sale (even if mentioning new tires/battery/parts).
- "Houses": Houses, villas, condominiums, apartments, buildings, or land/plots FOR SALE (even if mentioning granite kitchen, ceramic floor, gypsum ceiling, or furnished items).
- "Rentals": Apartments, houses, rooms, villas, offices, shops, or warehouses FOR RENT / LEASE (monthly/ኪራይ/ለኪራይ), even if furnished with TV/sofa/bed.
- "Electronics": Smartphones, laptops, TVs, gaming consoles, cameras, fridges, washing machines, solar/inverters.
- "Furniture": Sofas, beds, mattresses, dining tables, chairs, wardrobes, cabinets, office desks sold separately.
- "Clothes": Clothing, shoes, sneakers, jackets, dresses, suits, watches, handbags, traditional habesha kemis.
- "Building Materials": Standalone construction/finishing materials sold as supply (granite/marble slabs, ceramic tiles per sqm, cement bags, rebar, steel, gypsum board, paint buckets, sand, gravel, pipes).
- "Spare Parts": Standalone auto/machine replacement parts sold individually (car battery, tires/rims, headlights, bumpers, shock absorbers, brake pads, filters, engine oil) when NOT selling a whole car.
- "Labor & Services": Jobs or skilled services (driver, plumber, electrician, painter, mechanic, cleaner, tutor, delivery, construction contractor, brokerage service).
- "ምንአለሽ_ተራ": Any other legitimate general merchandise (bicycles, gym equipment, kitchenware, perfumes, tools, farm goods, etc.).

Subcategory examples:
- Cars: "Electric (EV)", "SUV / Crossover", "Sedan", "Pickup / Truck", "Hatchback / Compact", "Van / Minibus"
- Houses: "Villa / House", "Condominium", "Apartment", "Plot / Land"
- Rentals: "Apartment Rent", "Villa Rent", "Commercial / Office", "Shop / Store", "Warehouse / Hall"
- Electronics: "Smartphones & Tablets", "Laptops & Computers", "TV & Home Entertainment", "Gaming & Consoles", "Home Appliances"
- Building Materials: "Granite, Marble & Tiles", "Cement & Steel", "Paint, Wood & Gypsum", "Plumbing & Electrical"
- Spare Parts: "Tires & Rims", "Electrical & Lights", "Engine & Filters", "Body & Suspension"

Listing text:
"""
${cleanText.slice(0, 1200)}
"""${imageDescription ? `\nPhoto visual description:\n"""\n${imageDescription}\n"""` : ""}

Return ONLY valid JSON with keys: category, subcategory, brand, model, year, trim, bodyType, fuelType, transmission, suggestedTitle, confidence (0.0 to 1.0).`;
}

async function classifyAdWithAI(cleanText, firstImageFileId, specs, ruleResult, env) {
  const geminiKey = cleanEnv(env.GEMINI_API_KEY);
  // Fetch photo once if either Gemini or Workers AI needs visual context
  const needsImage = Boolean(firstImageFileId && (geminiKey || env.AI));
  const photoData = needsImage ? await fetchTelegramPhotoBase64(firstImageFileId, env) : null;

  // 1. Primary AI: Google Gemini (`gemini-4-hydrogen`) when GEMINI_API_KEY is configured
  if (geminiKey) {
    try {
      const parts = [{ text: buildClassifierPrompt(cleanText) }];
      if (photoData) {
        parts.push({ inlineData: { mimeType: photoData.mimeType, data: photoData.base64 } });
      }

      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-4-hydrogen:generateContent?key=${encodeURIComponent(geminiKey)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: getTimeoutSignal(9000),
          body: JSON.stringify({
            contents: [{ parts }],
            generationConfig: {
              temperature: 0.1,
              responseMimeType: "application/json",
              responseSchema: {
                type: "OBJECT",
                properties: {
                  category: { type: "STRING", enum: MARKETPLACE_CATEGORIES },
                  subcategory: { type: "STRING" },
                  brand: { type: "STRING" },
                  model: { type: "STRING" },
                  year: { type: "STRING" },
                  trim: { type: "STRING" },
                  bodyType: { type: "STRING" },
                  fuelType: { type: "STRING" },
                  transmission: { type: "STRING" },
                  suggestedTitle: { type: "STRING" },
                  confidence: { type: "NUMBER" }
                },
                required: ["category", "subcategory"]
              }
            }
          })
        }
      );

      if (res.ok) {
        const data = await res.json();
        const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        const parsed = parseJsonObjectSafe(raw);
        if (parsed && parsed.category) {
          return { ...parsed, provider: "gemini-4-hydrogen" };
        }
      }
    } catch (err) {
      console.warn("Gemini classification fallback:", err.message);
    }
  }

  // 2. Built-in Key-Free AI: Cloudflare Workers AI (`env.AI` binding)
  if (env.AI) {
    let imageDescription = "";

    // If post has an image (especially helpful when caption is short/missing or ambiguous), inspect photo via Llama 3.2 Vision
    if (photoData && (cleanText.length < 40 || ruleResult.confidence < 0.8 || (!specs.brand && ruleResult.category === "Cars"))) {
      try {
        const visionOut = await Promise.race([
          env.AI.run("@cf/meta/llama-3.2-11b-vision-instruct", {
            messages: [
              {
                role: "user",
                content: [
                  {
                    type: "text",
                    text: "Briefly describe what item is for sale in this image (e.g., car brand/model/body type, house/apartment, smartphone/laptop, sofa/furniture, shoes/clothes, granite/tiles/cement, or car spare part/tire) in 1-2 short sentences."
                  },
                  {
                    type: "image_url",
                    image_url: { url: `data:${photoData.mimeType};base64,${photoData.base64}` }
                  }
                ]
              }
            ],
            max_tokens: 120
          }),
          new Promise((_, reject) => setTimeout(() => reject(new Error("vision_timeout")), 6500))
        ]);
        imageDescription = String(visionOut?.response || visionOut?.description || "").trim();
      } catch (vErr) {
        console.warn("Workers AI vision skipped:", vErr.message);
      }
    }

    try {
      const llmOut = await Promise.race([
        env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
          messages: [
            {
              role: "system",
              content: "You are an accurate JSON-only Ethiopian marketplace classifier. Never output markdown or explanations, only valid JSON."
            },
            {
              role: "user",
              content: buildClassifierPrompt(cleanText, imageDescription)
            }
          ],
          temperature: 0.1,
          max_tokens: 300
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error("llm_timeout")), 7000))
      ]);

      const parsed = parseJsonObjectSafe(llmOut?.response ?? llmOut);
      if (parsed && parsed.category) {
        return {
          ...parsed,
          provider: imageDescription ? "workers-ai-vision+llama3.1" : "workers-ai-llama3.1"
        };
      }
    } catch (aiErr) {
      console.warn("Workers AI text classification fallback:", aiErr.message);
    }
  }

  return null;
}

// ============================================
// BRAND / MODEL / YEAR / SPECS PARSER
// ============================================
function detectBrandModelYear(text) {
  let brand = "";
  let model = "";
  let year = "";
  let trim = "";
  let bodyType = "";
  let fuelType = "";
  let transmission = "";
  let subcategory = "";

  const makeMatch = text.match(/(?:Make|የመኪናው\s*ዓይነት|Brand|ብራንድ)[ \t:=-]+([a-zA-Z0-9\u1200-\u137F/._ -]+)/i);
  if (makeMatch && makeMatch[1]) {
    brand = makeMatch[1].split("\n")[0].replace(/[💎📌⭐✔️•.]/g, "").trim();
    if (/^(?:new|brand\s*new|used|አዲስ|ያገለገለ)\b/i.test(brand)) brand = "";
  }

  const modelMatch = text.match(/(?:Model|ሞዴል)[ \t:=-]+([a-zA-Z0-9\u1200-\u137F/._ -]+)/i);
  if (modelMatch && modelMatch[1]) {
    model = modelMatch[1].split("\n")[0].replace(/[💎📌⭐✔️•.]/g, "").trim();
  }

  const yearMatch = text.match(/(?:Year|ዓመተ\s*ምህረት|ዓ\.ም|ዘመን)[ \t:=-]+([0-9]{4}(?:\/[0-9]{1,2})?)/i);
  if (yearMatch && yearMatch[1]) {
    year = yearMatch[1].trim();
  } else {
    const rawYear = text.match(/\b(199\d|200\d|201\d|202[0-9])(?:\/([0-9]{1,2}))?\b/);
    if (rawYear) year = rawYear[0];
  }

  if (model && /^(?:19|20)\d{2}(?:\/\d{1,2})?$/.test(model)) {
    if (!year) year = model;
    model = "";
  }

  const trimMatch = text.match(/(?:Trim|ትሪም|Edition)[ \t:=-]+([a-zA-Z0-9/._ -]+)/i);
  if (trimMatch && trimMatch[1]) {
    trim = trimMatch[1].split("\n")[0].replace(/[💎📌⭐✔️•.]/g, "").trim();
  }

  const bodyMatch = text.match(/(?:Body\s*Type|የቦዲ\s*ዓይነት)[ \t:=-]+([a-zA-Z0-9/._ -]+)/i);
  if (bodyMatch && bodyMatch[1]) {
    bodyType = bodyMatch[1].split("\n")[0].replace(/[💎📌⭐✔️•.]/g, "").trim();
  }

  const fuelMatch = text.match(/(?:Fuel|ነዳጅ)[ \t:=-]+([a-zA-Z0-9\u1200-\u137F/._ -]+)/i);
  if (fuelMatch && fuelMatch[1]) {
    fuelType = fuelMatch[1].split("\n")[0].replace(/[💎📌⭐✔️•.]/g, "").trim();
  } else if (/(?:electric|ኤሌክትሪክ|\bev\b|ቻርጅ)/i.test(text)) {
    fuelType = "Electric";
  } else if (/(?:benzin|petrol|ቤንዚን)/i.test(text)) {
    fuelType = "Petrol / Benzin";
  } else if (/(?:diesel|ናፍጣ)/i.test(text)) {
    fuelType = "Diesel";
  } else if (/(?:hybrid|ሃይብሪድ)/i.test(text)) {
    fuelType = "Hybrid";
  }

  const transMatch = text.match(/(?:Transmission|ማስተላለፊያ)[ \t:=-]+([a-zA-Z0-9\u1200-\u137F/._ -]+)/i);
  if (transMatch && transMatch[1]) {
    const candidate = transMatch[1].split("\n")[0].replace(/[💎📌⭐✔️•.]/g, "").trim();
    if (/(?:automatic|ኦቶማቲክ)/i.test(candidate)) transmission = "Automatic";
    else if (/(?:manual|ማኑዋል)/i.test(candidate)) transmission = "Manual";
    else if (candidate.length < 20 && !/^(?:19|20)\d{2}/.test(candidate)) transmission = candidate;
  }
  if (!transmission) {
    if (/(?:automatic\s*transmission|ኦቶማቲክ)/i.test(text)) transmission = "Automatic";
    else if (/(?:manual\s*transmission|ማኑዋል)/i.test(text)) transmission = "Manual";
  }

  if (!brand) {
    for (const b of CAR_DATABASE) {
      if (b.regex.test(text)) {
        brand = b.name;
        for (const m of b.models) {
          if (m.regex.test(text)) {
            if (!model || /^\d+$/.test(model)) model = m.name;
            if (m.subcategory) subcategory = m.subcategory;
            break;
          }
        }
        break;
      }
    }
  } else {
    const matchedBrandObj = CAR_DATABASE.find((b) => b.name.toLowerCase() === brand.toLowerCase());
    if (matchedBrandObj) {
      for (const m of matchedBrandObj.models) {
        if (m.regex.test(text)) {
          if (!model || /^\d+$/.test(model)) model = m.name;
          if (m.subcategory) subcategory = m.subcategory;
          break;
        }
      }
    }
  }

  if (!model || !brand) {
    for (const b of CAR_DATABASE) {
      for (const m of b.models) {
        if (m.requireBrand) continue;
        if (m.regex.test(text)) {
          if (!brand) brand = b.name;
          if (!model || /^\d+$/.test(model)) model = m.name;
          if (m.subcategory && !subcategory) subcategory = m.subcategory;
          break;
        }
      }
      if (brand && model) break;
    }
  }

  if (!brand) {
    for (const eb of ELECTRONICS_DATABASE) {
      if (eb.regex.test(text)) {
        brand = eb.name;
        for (const m of eb.models) {
          if (m.regex.test(text)) {
            if (!model) model = m.name;
            if (m.subcategory) subcategory = m.subcategory;
            break;
          }
        }
        break;
      }
    }
  }

  if (!subcategory && bodyType) {
    if (bodyType.toLowerCase().includes("suv") || /\bsuv\b/i.test(text)) subcategory = "SUV / Crossover";
    else if (bodyType.toLowerCase().includes("sedan") || /\bsedan\b/i.test(text)) subcategory = "Sedan";
  }

  return { brand, model, year, trim, bodyType, fuelType, transmission, subcategory };
}

// ============================================
// CONTEXT-WEIGHTED FALLBACK CATEGORY CLASSIFIER
// ============================================
function detectCategoryWeighted(text, brand = "", suggestedSubcat = "") {
  const t = (text || "").toLowerCase();
  const scores = {
    Cars: 0,
    Houses: 0,
    Rentals: 0,
    Electronics: 0,
    Furniture: 0,
    Clothes: 0,
    "Building Materials": 0,
    "Spare Parts": 0,
    "Labor & Services": 0
  };

  const hasCarBrand = Boolean(brand && CAR_DATABASE.some((b) => b.name.toLowerCase() === brand.toLowerCase()));
  const hasElecBrand = Boolean(brand && ELECTRONICS_DATABASE.some((eb) => eb.name.toLowerCase() === brand.toLowerCase()));

  // Whole-vehicle indicators vs spare part indicators
  const wholeCarSignals = /(መኪና|አውቶሞቢል|ተሽከርካሪ|ታርጋ|ኮድ\s*[1234]|mileage|odometer|\bkm\b|automatic|manual|ኦቶማቲክ|ማኑዋል|kwh|single\s*motor|dual\s*motor|\bsuv\b|\bsedan\b|hatchback|pickup)/gi;
  const wholeCarMatches = (t.match(wholeCarSignals) || []).length;
  const partSignals = /(spare\s*part|auto\s*part|car\s*part|brake\s*pad|shock\s*absorber|alternator|radiator|headlight|bumper|engine\s*oil|car\s*battery|tyre|\btire\b|alloy\s*rim|መለዋወጫ|ስፔር\s*ፓርት|ጎማ|የመኪና\s*ባትሪ|ፍሬን|ፋሮ|ፓራውልት|ቦምፐር|ራዲያተር|ፊልተር|ሞተር\s*ዘይት)/gi;
  const partMatches = (t.match(partSignals) || []).length;

  if (hasCarBrand) scores.Cars += 4;
  scores.Cars += wholeCarMatches * 3;
  if (/(?:\bcar\b|vitz|corolla|rav4|suzuki|hyundai|byd|elantra|sealion|tucson|toyota|yaris|hilux|dzire|isuzu)/i.test(t)) {
    scores.Cars += 3;
  }

  if (partMatches > 0) {
    // If whole car specs are strong (mileage, transmission, plate code), mentions like "new tires/battery" are features of the car!
    if (wholeCarMatches >= 2 || (hasCarBrand && /(mileage|\bkm\b|ታርጋ|ኮድ|plate|year|20\d{2}|ሞዴል)/i.test(t) && !/(spare\s*part|መለዋወጫ|ስፔር\s*ፓርት)/i.test(t))) {
      scores["Spare Parts"] += 1;
    } else {
      scores["Spare Parts"] += partMatches * 4 + (hasCarBrand ? 2 : 0);
    }
  }

  // Real Estate (Houses / Rentals) vs Building Materials / Furnished items
  const propertySignals = /(house|villa|condominium|condo|apartment|g\+\d|real\s*estate|compound|bedroom|office|shop|store|warehouse|hall|land|plot|ቤት|ቪላ|ኮንዶሚኒየም|ኮንዶ|አፓርታማ|ሪል\s*እስቴት|መኝታ|ቦታ|መሬት|ሱቅ|ቢሮ|መጋዘን|አዳራሽ|ካርታ)/gi;
  const propertyMatches = (t.match(propertySignals) || []).length;
  const rentalSignals = /(for\s*rent|\brent\b|\blease\b|\bmonthly\b|ኪራይ|የሚከራይ|ለኪራይ|ወርሃዊ|በወር)/gi;
  const rentalMatches = (t.match(rentalSignals) || []).length;

  const materialSignals = /(cement|rebar|granite|marble|ceramic|porcelain|gypsum|corrugated|steel\s*bar|plywood|paint\s*bucket|building\s*material|construction\s*material|ሲሚንቶ|ብረት|ሪባር|ግራናይት|ማርብል|ሴራሚክ|ብሎኬት|ቆርቆሮ|አሸዋ|ጠጠር|ጂፕሰም|የግንባታ\s*እቃ|ቀለም\s*ባልዲ|ቧንቧ\s*እቃ)/gi;
  const materialMatches = (t.match(materialSignals) || []).length;
  const bulkSupplySignals = /(per\s*sqm|per\s*m2|slab|quintal|ton\b|factory|warehouse\s*stock|በካሬ|በኩንታል|ፋብሪካ|ስላብ|ባልዲ|በብዛት)/i.test(t);

  if (propertyMatches > 0) {
    if (rentalMatches > 0) {
      scores.Rentals += propertyMatches * 3 + rentalMatches * 4;
    } else {
      scores.Houses += propertyMatches * 3 + (/\b(sqm|m2|ካሬ)\b/i.test(t) ? 2 : 0);
    }
  } else if (rentalMatches > 0 && /(room|flat|ክፍል)/i.test(t)) {
    scores.Rentals += 5;
  }

  if (materialMatches > 0) {
    // Only boost Building Materials above Houses if property sale/rent cues aren't dominant OR bulk supply cues exist
    if (propertyMatches >= 2 && !bulkSupplySignals && !/(building\s*material|የግንባታ\s*እቃ)/i.test(t)) {
      scores["Building Materials"] += 1;
    } else {
      scores["Building Materials"] += materialMatches * 4 + (bulkSupplySignals ? 3 : 0);
    }
  }

  // Electronics (don't let "furnished with TV/fridge" override Rentals/Houses)
  const elecMatches = (t.match(/(iphone|samsung|laptop|computer|macbook|ipad|smartphone|tablet|smart\s*tv|television|camera|ps5|playstation|xbox|fridge|refrigerator|washing\s*machine|ስልክ|ሞባይል|ላፕቶፕ|ኮምፒውተር|ቴሌቪዥን|ቲቪ|ካሜራ|ፍሪጅ|የልብስ\s*ማጠቢያ)/gi) || []).length;
  if (hasElecBrand) scores.Electronics += 4;
  if (elecMatches > 0) {
    scores.Electronics += propertyMatches >= 2 ? 1 : elecMatches * 3;
  }

  // Furniture (don't let "furnished apartment with sofa/bed" override Rentals/Houses)
  const furnMatches = (t.match(/(sofa|bed|mattress|table|chair|cupboard|wardrobe|furniture|cabinet|shelf|desk|ሶፋ|አልጋ|ፍራሽ|ጠረጴዛ|ወንበር|ቁምሳጥን|ፈርኒቸር|ቡፌ|መደርደሪያ)/gi) || []).length;
  if (furnMatches > 0) {
    scores.Furniture += propertyMatches >= 2 ? 1 : furnMatches * 3;
  }

  // Clothes
  const clothMatches = (t.match(/(shoes|sneakers|boots|jacket|dress|suit|t-?shirt|clothes|pants|hoodie|handbag|watch|ጫማ|ጃኬት|ቀሚስ|ልብስ|ሱሪ|ቲሸርት|ኮት|ቦርሳ|ሀበሻ\s*ቀሚስ)/gi) || []).length;
  scores.Clothes += clothMatches * 3;

  // Labor & Services
  const serviceMatches = (t.match(/(driver|plumber|electrician|painter|mechanic|cleaner|carpenter|technician|tutor|delivery|maintenance|service|ቧንቧ|ኤሌክትሪክ\s*ባለሙያ|ቀለም\s*ቀቢ|ሹፌር|መካኒክ|ጽዳት|ሠራተኛ|አገልግሎት|ጥገና)/gi) || []).length;
  scores["Labor & Services"] += serviceMatches * 3;

  // Pick highest scoring category
  let bestCategory = "ምንአለሽ_ተራ";
  let bestScore = 0;
  for (const [cat, score] of Object.entries(scores)) {
    if (score > bestScore) {
      bestScore = score;
      bestCategory = cat;
    }
  }

  const confidence = bestScore >= 6 ? 0.9 : bestScore >= 3 ? 0.72 : 0.35;
  const subcategory = pickSubcategory(bestCategory, t, suggestedSubcat);
  return { category: bestCategory, subcategory, confidence };
}

function pickSubcategory(category, lowerText, suggestedSubcat = "") {
  if (category === "Cars") {
    if (suggestedSubcat) return suggestedSubcat;
    if (/(electric|kwh|single motor|dual motor|\bev\b|ኤሌክትሪክ|ቻርጅ)/i.test(lowerText)) return "Electric (EV)";
    if (/(suv|crossover|4wd|4x4|rav4|prado|land cruiser|tucson|tiggo|santa fe)/i.test(lowerText)) return "SUV / Crossover";
    if (/(pickup|truck|hilux|ranger|isuzu|d-max|ፒክአፕ|ጭነት|ኤፍኤስአር)/i.test(lowerText)) return "Pickup / Truck";
    if (/(hatchback|compact|vitz|swift|celerio|yaris|alto|i10)/i.test(lowerText)) return "Hatchback / Compact";
    if (/(minibus|van|hiace|damas|ሚኒባስ|ቫን)/i.test(lowerText)) return "Van / Minibus";
    return "Sedan";
  }
  if (category === "Houses") {
    if (/(condo|condominium|ኮንዶ)/i.test(lowerText)) return "Condominium";
    if (/(apartment|አፓርታማ)/i.test(lowerText)) return "Apartment";
    if (/(land|plot|ቦታ|መሬት|ካርታ)/i.test(lowerText)) return "Plot / Land";
    return "Villa / House";
  }
  if (category === "Rentals") {
    if (/(office|ቢሮ)/i.test(lowerText)) return "Commercial / Office";
    if (/(shop|store|ሱቅ)/i.test(lowerText)) return "Shop / Store";
    if (/(warehouse|hall|መጋዘን|አዳራሽ)/i.test(lowerText)) return "Warehouse / Hall";
    if (/(villa|g\+1|g\+2|ቪላ)/i.test(lowerText)) return "Villa Rent";
    return "Apartment Rent";
  }
  if (category === "Electronics") {
    if (suggestedSubcat) return suggestedSubcat;
    if (/(laptop|macbook|computer|\bpc\b|desktop|ላፕቶፕ|ኮምፒውተር)/i.test(lowerText)) return "Laptops & Computers";
    if (/(\btv\b|television|audio|soundbar|ቴሌቪዥን|ቲቪ|ስፒከር)/i.test(lowerText)) return "TV & Home Entertainment";
    if (/(ps5|ps4|playstation|xbox|nintendo|ጌም)/i.test(lowerText)) return "Gaming & Consoles";
    if (/(fridge|refrigerator|washing\s*machine|oven|ፍሪጅ|ማጠቢያ)/i.test(lowerText)) return "Home Appliances";
    return "Smartphones & Tablets";
  }
  if (category === "Furniture") {
    if (/(bed|mattress|አልጋ|ፍራሽ)/i.test(lowerText)) return "Bedroom & Mattresses";
    if (/(office|desk|ቢሮ)/i.test(lowerText)) return "Office Furniture";
    if (/(kitchen|dining|buffet|መመገቢያ|ቡፌ)/i.test(lowerText)) return "Kitchen & Dining";
    return "Living Room / Sofa";
  }
  if (category === "Clothes") {
    if (/(shoes|sneakers|boots|ጫማ)/i.test(lowerText)) return "Shoes & Footwear";
    if (/(bag|watch|ቦርሳ|ሰዓት)/i.test(lowerText)) return "Bags & Accessories";
    return "Clothing & Apparel";
  }
  if (category === "Building Materials") {
    if (/(granite|marble|ceramic|porcelain|ግራናይት|ማርብል|ሴራሚክ)/i.test(lowerText)) return "Granite, Marble & Tiles";
    if (/(cement|rebar|steel|block|ሲሚንቶ|ብረት|ሪባር|ብሎኬት)/i.test(lowerText)) return "Cement & Steel";
    if (/(paint|gypsum|wood|ጂፕሰም|ቀለም)/i.test(lowerText)) return "Paint, Wood & Gypsum";
    return "Construction & Finishing";
  }
  if (category === "Spare Parts") {
    if (/(tire|tyre|rim|ጎማ|ቸርኬ)/i.test(lowerText)) return "Tires & Rims";
    if (/(battery|alternator|headlight|ባትሪ|ፋሮ)/i.test(lowerText)) return "Electrical & Lights";
    if (/(engine|oil|filter|radiator|ሞተር|ፊልተር|ዘይት)/i.test(lowerText)) return "Engine & Filters";
    return "Auto Spare Parts";
  }
  return DEFAULT_SUBCATEGORIES[category] || "General Marketplace";
}

function arrangeTitle({ brand, model, year, trim, cleanText, category, subcategory, aiTitle = "" }) {
  if (category === "Cars") {
    const cleanYear = year ? year.split("/")[0] : "";
    if (brand && model) {
      const parts = [];
      if (cleanYear) parts.push(cleanYear);
      parts.push(brand, model);
      if (trim && !model.toLowerCase().includes(trim.toLowerCase())) {
        parts.push(`(${trim})`);
      }
      return parts.join(" ");
    }
    if (brand) {
      const parts = [cleanYear, brand, subcategory && subcategory !== "Vehicles" ? subcategory : ""].filter(Boolean);
      if (parts.length > 0) return parts.join(" ");
    }
  }

  if (category === "Electronics" && brand && model) {
    return `${brand} ${model}${trim ? ` ${trim}` : ""}`;
  }

  const cleanLines = cleanText
    .split("\n")
    .map((l) => l.replace(/[💎📌⭐✔️•#🚨]/g, "").trim())
    .filter((l) => l.length > 2 && !/^(?:urgent|very urgent|sale|for sale|አስቸኳይ|ሽያጭ|ለሽያጭ|ይደውሉ|ዋጋ|price)[:!.\s]*$/i.test(l));

  if (aiTitle && aiTitle.length >= 6 && aiTitle.length <= 72) {
    return safeSubstring(aiTitle, 70);
  }

  if (cleanLines.length > 0) {
    const best = cleanLines[0]
      .replace(/^(?:urgent\s*(?:sale|sell)?|very\s*urgent\s*(?:sale)?|አስቸኳይ\s*(?:ሽያጭ)?)[ \t:!.-]*/i, "")
      .trim();
    if (best) return safeSubstring(best, 70);
  }
  return `${category === "ምንአለሽ_ተራ" ? "Marketplace" : category} Item`;
}

function parseMathematicalPrice(text, knownYear) {
  if (!text) return { formattedPrice: "0", rawPrice: 0 };
  const detectedYear = (knownYear ? knownYear.split("/")[0] : "") || "";

  const isExcluded = (num, rawStr) => {
    if (detectedYear && (num.toString() === detectedYear || rawStr.includes(detectedYear))) return true;
    if (num >= 1970 && num <= 2035) {
      const yearPattern = new RegExp(`(?:year|ዓመተ|model|ሞዴል|month|ወር)?\\s*${num}`, "i");
      if (yearPattern.test(text)) return true;
    }
    return false;
  };

  const compoundMatch = text.match(/([0-9]+(?:\.[0-9]+)?)\s*(?:ሚሊዮን|ሚሊየን|million)\s*(?:ከ\s*|እና\s*)?([0-9]+(?:\.[0-9]+)?)\s*(?:ሺህ|ሺ|k|thousand)/i);
  if (compoundMatch) {
    const mVal = parseFloat(compoundMatch[1]);
    const kVal = parseFloat(compoundMatch[2]);
    if (!isNaN(mVal) && !isNaN(kVal)) {
      const total = Math.round(mVal * 1000000 + kVal * 1000);
      return { formattedPrice: total.toLocaleString("en-US"), rawPrice: total };
    }
  }

  const explicitLineMatch = text.match(/(?:💰|price|ዋጋ|fixed|የመሸጫ\s*ዋጋ)[ \t:=-]+([0-9.,]+)\s*(?:ETB|ብር|Birr)?\s*(?:million|mil|mln|m|ሚሊዮን|ሚሊየን|k|thousand|ሺህ|ሺ)?/i);
  if (explicitLineMatch && explicitLineMatch[1]) {
    const rawVal = explicitLineMatch[1];
    const isMillion = /(?:million|mil|mln|m|ሚሊዮን|ሚሊየን)/i.test(explicitLineMatch[0]);
    const isThousand = /(?:k|thousand|ሺህ|ሺ)/i.test(explicitLineMatch[0]);

    if (isMillion) {
      const val = parseFloat(rawVal.replace(/,/g, ""));
      if (!isNaN(val) && val > 0) {
        const finalNum = val < 1000 ? Math.round(val * 1000000) : Math.round(val);
        return { formattedPrice: finalNum.toLocaleString("en-US"), rawPrice: finalNum };
      }
    } else if (isThousand) {
      const val = parseFloat(rawVal.replace(/,/g, ""));
      if (!isNaN(val) && val > 0) {
        const finalNum = val < 10000 ? Math.round(val * 1000) : Math.round(val);
        return { formattedPrice: finalNum.toLocaleString("en-US"), rawPrice: finalNum };
      }
    } else {
      const num = parseInt(rawVal.replace(/[.,]/g, ""), 10);
      if (!isNaN(num) && num > 100 && !isExcluded(num, rawVal)) {
        return { formattedPrice: num.toLocaleString("en-US"), rawPrice: num };
      }
    }
  }

  const generalMillionMatch = text.match(/([0-9]+(?:[.,][0-9]+)*)\s*(?:ETB|ብር|Birr)?\s*(?:million|mil|mln|m|ሚሊዮን|ሚሊየን)\b/i);
  if (generalMillionMatch && generalMillionMatch[1]) {
    const val = parseFloat(generalMillionMatch[1].replace(/,/g, ""));
    if (!isNaN(val) && val > 0) {
      const finalNum = val < 1000 ? Math.round(val * 1000000) : Math.round(val);
      return { formattedPrice: finalNum.toLocaleString("en-US"), rawPrice: finalNum };
    }
  }

  const thousandMatch = text.match(/([0-9]+(?:[.,][0-9]+)*)\s*(?:ETB|ብር|Birr)?\s*(?:k|thousand|ሺህ|ሺ)\b/i);
  if (thousandMatch && thousandMatch[1]) {
    const val = parseFloat(thousandMatch[1].replace(/,/g, ""));
    if (!isNaN(val) && val > 0 && val < 10000) {
      const finalNum = Math.round(val * 1000);
      return { formattedPrice: finalNum.toLocaleString("en-US"), rawPrice: finalNum };
    }
  }

  const currencyMatch = text.match(/(?:ETB|ብር|Birr)\s*[:=.-]?\s*([0-9]{1,3}(?:[.,][0-9]{3})+|[0-9]{4,10})|([0-9]{1,3}(?:[.,][0-9]{3})+|[0-9]{4,10})\s*(?:ETB|ብር|Birr)/i);
  if (currencyMatch) {
    const rawVal = currencyMatch[1] || currencyMatch[2];
    if (rawVal) {
      const num = parseInt(rawVal.replace(/[.,]/g, ""), 10);
      if (!isNaN(num) && num > 100 && !isExcluded(num, rawVal)) {
        return { formattedPrice: num.toLocaleString("en-US"), rawPrice: num };
      }
    }
  }

  const lines = text.split("\n");
  for (const line of lines) {
    if (/(?:price|ዋጋ)/i.test(line)) {
      const nums = line.match(/\b([0-9]{1,3}(?:[.,][0-9]{3})+|[0-9]{5,9})\b/);
      if (nums) {
        const num = parseInt(nums[1].replace(/[.,]/g, ""), 10);
        if (!isNaN(num) && num > 1000 && !isExcluded(num, nums[1])) {
          return { formattedPrice: num.toLocaleString("en-US"), rawPrice: num };
        }
      }
    }
  }

  return { formattedPrice: "0", rawPrice: 0 };
}

function cleanTheText(text) {
  if (!text) return "";
  const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{1F1E6}-\u{1F1FF}\u{200D}\u{20E3}\u{2190}-\u{21FF}\u{2300}-\u{23FF}\u{25A0}-\u{25FF}\u{2B50}\u{1F004}\u{1F0CF}\u{3030}\u{303D}\u{3297}\u{3299}]/gu;
  return text
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/\b(?:t\.me|telegram\.me)\/\S+/gi, "")
    .replace(/@[a-zA-Z0-9_]{2,}/g, "")
    .replace(/(?:\+251|251|0)?[\s.-]?[97]\d(?:[\s.-]?\d){7}\b/gi, "")
    .replace(EMOJI, "")
    .replace(/[*_~`|]/g, "")
    .replace(/(?:phone|call|mobile|ስልክ|ቴሌግራም|telegram|contact|ይደውሉ|ይደውሉልን)[ \t:=-]+(?:or|\/)?\s*(?=\n|$)/gi, "")
    .replace(/[ \t]+/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractCityAndSubcity(text) {
  const lower = (text || "").toLowerCase();
  const subcityMap = [
    { regex: /bole\s*bulbula|ቦሌ\s*ቡልቡላ/i, label: "Bole Bulbula" },
    { regex: /bole\s*medhanialem|ቦሌ\s*መድሃኒያለም/i, label: "Bole Medhanialem" },
    { regex: /bole\s*atlas|ቦሌ\s*አትላስ/i, label: "Bole Atlas" },
    { regex: /bole\s*arabsa|ቦሌ\s*አራብሳ/i, label: "Bole Arabsa" },
    { regex: /bole|ቦሌ/i, label: "Bole" },
    { regex: /summit|ሰሚት/i, label: "Summit" },
    { regex: /\bcmc\b|ሲኤምሲ/i, label: "CMC" },
    { regex: /ayat|አያት/i, label: "Ayat" },
    { regex: /kazanchis|ካዛንቺስ/i, label: "Kazanchis" },
    { regex: /sarbet|ሳርቤት/i, label: "Sarbet" },
    { regex: /gerji|ገርጂ/i, label: "Gerji" },
    { regex: /megenagna|መገናኛ/i, label: "Megenagna" },
    { regex: /piassa|piazza|ፒያሳ/i, label: "Piassa" },
    { regex: /lebu|ለቡ/i, label: "Lebu" },
    { regex: /jemo|ጀሞ/i, label: "Jemo" },
    { regex: /figa|ፊጋ/i, label: "Figa" },
    { regex: /hayahulet|22\s*mazoria|ሃያ\s*ሁለት|ሀያሁለት/i, label: "Hayahulet" },
    { regex: /saris|ሳሪስ/i, label: "Saris" },
    { regex: /kality|akaki|ቃሊቲ|አቃቂ/i, label: "Akaki Kality" },
    { regex: /tulu\s*dimtu|ቱሉ\s*ዲምቱ/i, label: "Tulu Dimtu" },
    { regex: /tafo|ጣፎ/i, label: "Tafo" },
    { regex: /yeka|የካ/i, label: "Yeka" },
    { regex: /lemi\s*kura|ለሚ\s*ኩራ/i, label: "Lemi Kura" },
    { regex: /kirkos|ቂርቆስ/i, label: "Kirkos" },
    { regex: /lideta|ልደታ/i, label: "Lideta" },
    { regex: /merkato|መርካቶ/i, label: "Merkato" },
    { regex: /mexico|ሜክሲኮ/i, label: "Mexico" },
    { regex: /gotera|ጎተራ/i, label: "Gotera" },
    { regex: /kera|ቄራ/i, label: "Kera" },
    { regex: /4\s*kilo|አራት\s*ኪሎ/i, label: "4 Kilo" },
    { regex: /6\s*kilo|ስድስት\s*ኪሎ/i, label: "6 Kilo" }
  ];

  let subcity = "";
  for (const s of subcityMap) {
    if (s.regex.test(text || "")) {
      subcity = s.label;
      break;
    }
  }

  if (/(hawassa|awassa|ሀዋሳ|አዋሳ)/i.test(lower)) return { city: "Hawassa", subcity };
  if (/(adama|nazret|nazreth|አዳማ|ናዝሬት)/i.test(lower)) return { city: "Adama", subcity };
  if (/(bahir\s*dar|ባህር\s*ዳር|ባሕር\s*ዳር)/i.test(lower)) return { city: "Bahir Dar", subcity };
  if (/(dire\s*dawa|ድሬዳዋ|ድሬ\s*ዳዋ)/i.test(lower)) return { city: "Dire Dawa", subcity };
  if (/(mekelle|mekele|መቐለ|መቀሌ)/i.test(lower)) return { city: "Mekelle", subcity };
  if (/(gondar|gonder|ጎንደር)/i.test(lower)) return { city: "Gondar", subcity };
  if (/(jimma|ጅማ)/i.test(lower)) return { city: "Jimma", subcity };
  if (/(dessie|desse|ደሴ)/i.test(lower)) return { city: "Dessie", subcity };
  if (/(bishoftu|debre\s*zeit|ቢሾፍቱ|ደብረ\s*ዘይት)/i.test(lower)) return { city: "Bishoftu", subcity };
  if (/(shashemene|shashamane|ሻሸመኔ)/i.test(lower)) return { city: "Shashemene", subcity };
  if (/(jigjiga|jijiga|ጅግጅጋ)/i.test(lower)) return { city: "Jigjiga", subcity };
  if (/(harar|ሐረር|ሀረር)/i.test(lower)) return { city: "Harar", subcity };
  if (/(arba\s*minch|arbaminch|አርባ\s*ምንጭ)/i.test(lower)) return { city: "Arba Minch", subcity };
  return { city: "Addis Ababa", subcity };
}

async function uploadImagesToCloudinary(imageFileIds, env) {
  const cloudName = cleanEnv(env.CLOUDINARY_CLOUD_NAME);
  const uploadPreset = cleanEnv(env.CLOUDINARY_UPLOAD_PRESET);
  const botToken = cleanEnv(env.TELEGRAM_BOT_TOKEN);
  if (!cloudName || cloudName === "your_cloud_name" || !uploadPreset || !botToken || !imageFileIds || imageFileIds.length === 0) {
    return [];
  }
  const urls = [];
  for (const fileId of imageFileIds.slice(0, 4)) {
    try {
      const getFileRes = await callTelegram("getFile", { file_id: fileId }, env);
      if (!getFileRes || !getFileRes.file_path) continue;
      const tgFileUrl = `https://api.telegram.org/file/bot${botToken}/${getFileRes.file_path}`;
      const form = new FormData();
      form.append("file", tgFileUrl);
      form.append("upload_preset", uploadPreset);
      const uploadRes = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/image/upload`, {
        method: "POST",
        body: form
      });
      const data = await uploadRes.json();
      if (data.secure_url) urls.push(data.secure_url);
    } catch (e) {
      console.warn("Cloudinary upload skip for", fileId, ":", e.message);
    }
  }
  return urls;
}

async function getFirebaseTokenDetailed(env) {
  const now = Math.floor(Date.now() / 1000);
  if (cachedFirebaseToken && tokenExpiresAt > now + 300) {
    return { token: cachedFirebaseToken, error: null };
  }

  let clientEmail = cleanEnv(env.FIREBASE_CLIENT_EMAIL);
  let rawKey = cleanEnv(env.FIREBASE_PRIVATE_KEY);

  // Support accidental paste of full Service Account JSON into FIREBASE_PRIVATE_KEY
  if (rawKey.startsWith("{")) {
    try {
      const sa = JSON.parse(rawKey);
      if (sa.private_key) rawKey = String(sa.private_key);
      if (!clientEmail && sa.client_email) clientEmail = String(sa.client_email).trim();
    } catch {}
  }

  // Strip accidental surrounding quotes / trailing comma from JSON line copy-paste
  rawKey = rawKey.replace(/^["']|["'],?$/g, "").trim();
  const privateKey = rawKey.replace(/\\n/g, "\n");

  if (!clientEmail || !privateKey) {
    const missing = [];
    if (!clientEmail) missing.push("FIREBASE_CLIENT_EMAIL");
    if (!privateKey) missing.push("FIREBASE_PRIVATE_KEY");
    return { token: "", error: `Missing ${missing.join(" and ")}` };
  }

  try {
    const header = { alg: "RS256", typ: "JWT" };
    const payload = {
      iss: clientEmail,
      scope: "https://www.googleapis.com/auth/datastore",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600
    };
    const encHeader = base64UrlEncode(JSON.stringify(header));
    const encPayload = base64UrlEncode(JSON.stringify(payload));
    const signingInput = `${encHeader}.${encPayload}`;
    const pemContents = privateKey
      .replace(/-----BEGIN PRIVATE KEY-----/g, "")
      .replace(/-----END PRIVATE KEY-----/g, "")
      .replace(/\s/g, "");
    const binaryDer = Uint8Array.from(atob(pemContents), (c) => c.charCodeAt(0));
    const cryptoKey = await crypto.subtle.importKey(
      "pkcs8",
      binaryDer,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const sigBuffer = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", cryptoKey, new TextEncoder().encode(signingInput));
    const sigBytes = new Uint8Array(sigBuffer);
    let binary = "";
    for (let i = 0; i < sigBytes.length; i++) binary += String.fromCharCode(sigBytes[i]);
    const signature = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const jwt = `${signingInput}.${signature}`;
    const tokRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`
    });
    const tokData = await tokRes.json().catch(() => ({}));
    if (!tokData.access_token) {
      return { token: "", error: tokData.error_description || tokData.error || `OAuth HTTP ${tokRes.status}` };
    }
    cachedFirebaseToken = tokData.access_token;
    tokenExpiresAt = now + (tokData.expires_in || 3600);
    return { token: cachedFirebaseToken, error: null };
  } catch (err) {
    console.warn("Failed to generate Firebase token:", err.message);
    return { token: "", error: err.message };
  }
}

async function getFirebaseToken(env) {
  const res = await getFirebaseTokenDetailed(env);
  return res.token;
}

function base64UrlEncode(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function resolveAdminUidByEmail(token, projectId, email, fallbackUid = "admin_bot") {
  if (fallbackUid && fallbackUid !== "admin_bot") {
    return fallbackUid;
  }
  if (!email) return fallbackUid;
  if (cachedAdminUid && cachedAdminEmailForUid === email) {
    return cachedAdminUid;
  }

  try {
    const queryUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents:runQuery`;
    const res = await fetch(queryUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        structuredQuery: {
          from: [{ collectionId: "users" }],
          where: {
            fieldFilter: {
              field: { fieldPath: "email" },
              op: "EQUAL",
              value: { stringValue: email }
            }
          },
          limit: 1
        }
      })
    });

    if (res.ok) {
      const results = await res.json();
      if (Array.isArray(results)) {
        const doc = results.find((r) => r && r.document && r.document.name);
        if (doc) {
          const parts = doc.document.name.split("/");
          const uid = parts[parts.length - 1];
          if (uid) {
            cachedAdminUid = uid;
            cachedAdminEmailForUid = email;
            return uid;
          }
        }
      }
    }
  } catch (err) {
    console.warn("Admin UID lookup skipped:", err.message);
  }

  return fallbackUid;
}
