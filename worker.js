/**
 * Yegna Gebeya Telegram Bot - Cloudflare Worker
 * 
 * Production Complete Edition (v7.4 Amharic NLP + Resilient Web & Telegram Sync + Admin Profile):
 * 1. Amharic Title, Category, Brand, Model, Price & Location Intelligence:
 *    - Correctly parses Amharic brand/model names without ASCII \b regex bugs.
 *    - Extracts clean Amharic titles (skipping greetings/price-only lines) & supports explicit ርዕስ:/አይነት: labels.
 *    - Parses compound Amharic prices (e.g. "4 ሚሊዮን 500 ሺህ" -> 4,500,000, Ethiopic numerals, ሺ/ሚ/ብር).
 *    - Detects Amharic categories, subcategories, condition (አዲስ/ለኪራይ), cities & Addis subcities.
 *    - Optional Gemini Flash Amharic text fallback when GEMINI_API_KEY is configured.
 * 2. Instant Website & Profile Sync (marbatu1@gmail.com):
 *    - Posts directly to Website API (/api/ads) tagged to marbatu1@gmail.com for profile edit/delete.
 *    - Resolves marbatu1@gmail.com UID in Firestore & includes ?migrate=old_bot_posts GET route.
 * 3. Precision Bot Watermark Shield & In-Memory Locking:
 *    - Prevents loopback without dropping legitimate seller ads.
 * 4. Dual Ingestion, Multi-Photo Album Aggregation & Complete Emoji/Contact Stripping.
 */

// In-Memory Aggregators & Deduplication Stores
const albumStore = new Map(); // groupId -> { images: [], messageIds: [], caption: "", captionMsg: null, timerActive: false, timestamp: number }
const memoryLocks = new Map(); // key -> expireTimestamp
const updateIdLocks = new Set(); // Telegram update_id deduplication
let cachedFirebaseToken = null;
let tokenExpiresAt = 0;
let cachedAdminUid = null;
let cachedAdminEmailForUid = "";

export default {
  async fetch(request, env, ctx) {
    // Health check & one-click old post migration endpoint on GET
    if (request.method !== "POST") {
      const url = new URL(request.url);
      if (url.searchParams.get("migrate") === "old_bot_posts") {
        const result = await migrateOldBotPostsToProfile(env);
        return new Response(JSON.stringify(result, null, 2), {
          status: result.ok ? 200 : 500,
          headers: { "Content-Type": "application/json; charset=utf-8" }
        });
      }

      const botConfigured = Boolean(env.TELEGRAM_BOT_TOKEN);
      const targetChannel = env.REPOST_CHANNEL_ID || "@mebrigranite";
      const websiteUrl = env.WEBSITE_URL || "https://ais-dev-ligixirxwi2nidlsx5j5hb-166746593299.europe-west3.run.app";

      return new Response(
        `Yegna Gebeya Telegram Bot is Active ✅\n\n` +
        `• Status: Running\n` +
        `• Bot Token Configured: ${botConfigured ? "YES ✅" : "NO ❌ (Add TELEGRAM_BOT_TOKEN in Cloudflare Settings > Variables!)"}\n` +
        `• Repost Channel: ${targetChannel}\n` +
        `• Website API: ${websiteUrl}/api/ads\n` +
        `• Admin Profile: ${env.ADMIN_EMAIL || "marbatu1@gmail.com"}\n` +
        `• Amharic NLP Parser: Enabled ✅\n` +
        `• Version: v7.4 Production Resilient\n` +
        `• Old Post Migration: Visit ?migrate=old_bot_posts once to assign old bot posts to your profile\n`,
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
  const botId = env.TELEGRAM_BOT_TOKEN ? env.TELEGRAM_BOT_TOKEN.split(":")[0] : "";
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

  const textHash = simpleHash((cleanText || "photo_ad").toLowerCase().replace(/\s+/g, ''));
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
// MEMORY LOCKING (ZERO DEPENDENCE ON FAILING CACHE APIS)
// ============================================
function claimMemoryLock(key, ttlSeconds = 180) {
  const now = Date.now();
  const exp = memoryLocks.get(key);
  if (exp && exp > now) return false;
  memoryLocks.set(key, now + (ttlSeconds * 1000));
  return true;
}

function isMemoryLocked(key) {
  const now = Date.now();
  const exp = memoryLocks.get(key);
  if (exp && exp > now) return true;
  return false;
}

function hasBotWatermark(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  if (
    lower.includes("mebri.yegna.workers.dev") ||
    lower.includes("#yegnagebeya") ||
    (lower.includes("የኛ ገበያ") && lower.includes("@mebrigranite") && lower.includes("0911680790"))
  ) {
    return true;
  }
  return false;
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

async function callTelegram(method, body, env) {
  if (!env.TELEGRAM_BOT_TOKEN) {
    console.error(`❌ TELEGRAM_BOT_TOKEN is missing! Set it in Cloudflare Dashboard Variables.`);
    throw new Error("TELEGRAM_BOT_TOKEN is missing");
  }

  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
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
// CARS & ELECTRONICS DATABASE (ENGLISH + AMHARIC)
// Note: Amharic words are NOT wrapped in \b because \b only matches ASCII [a-zA-Z0-9_].
// ============================================
const CAR_DATABASE = [
  {
    name: "BYD",
    regex: /\bbyd\b|ባይድ|ቢዋይዲ/i,
    models: [
      { name: "Sealion 06 EV", regex: /sealion\s*06|ሲሊዮን\s*0?6/i, subcategory: "Electric (EV)" },
      { name: "Sealion 07", regex: /sealion\s*07|ሲሊዮን\s*0?7/i, subcategory: "Electric (EV)" },
      { name: "Seagull", regex: /seagull|ሲገል|ሲጋል/i, subcategory: "Electric (EV)" },
      { name: "Song Plus EV", regex: /song\s*plus|ሶንግ\s*ፕላስ/i, subcategory: "Electric (EV)" },
      { name: "Atto 3 / Yuan Plus", regex: /atto\s*3|yuan\s*plus|አቶ\s*3|ዩአን\s*ፕላስ/i, subcategory: "Electric (EV)" },
      { name: "Tang", regex: /\btang\b|ታንግ/i, subcategory: "Electric (EV)" },
      { name: "Han", regex: /\bhan\b/i, subcategory: "Electric (EV)" },
      { name: "Dolphin", regex: /dolphin|ዶልፊን\s*ኢቪ/i, subcategory: "Electric (EV)" },
      { name: "Qin Plus", regex: /qin\s*plus|ቺን\s*ፕላስ/i, subcategory: "Sedan" },
      { name: "Chazor / Destroyer 05", regex: /chazor|destroyer\s*05|ቻዞር/i, subcategory: "Sedan" }
    ]
  },
  {
    name: "Toyota",
    regex: /\btoyota\b|ቶዮታ|ቶየታ/i,
    models: [
      { name: "Corolla Cross", regex: /corolla\s*cross|ኮሮላ\s*ክሮስ/i, subcategory: "SUV / Crossover" },
      { name: "Corolla", regex: /corolla|ኮሮላ/i, subcategory: "Sedan" },
      { name: "RAV4", regex: /rav\s*4|ራቭ\s*4/i, subcategory: "SUV / Crossover" },
      { name: "Land Cruiser", regex: /land\s*cruiser|ላንድ\s*ክሩዘር|ላንድክሩዘር/i, subcategory: "SUV / Crossover" },
      { name: "Prado", regex: /prado|ፕራዶ/i, subcategory: "SUV / Crossover" },
      { name: "Hilux", regex: /hilux|ሃይሉክስ|ሀይሉክስ/i, subcategory: "Pickup / Truck" },
      { name: "Yaris", regex: /yaris|ያሪስ/i, subcategory: "Hatchback / Compact" },
      { name: "Vitz", regex: /vitz|ቪትዝ|ቪዝ/i, subcategory: "Hatchback / Compact" },
      { name: "Camry", regex: /camry|ካምሪ/i, subcategory: "Sedan" },
      { name: "Rush", regex: /rush|ራሽ/i, subcategory: "SUV / Crossover" },
      { name: "HiAce", regex: /hiace|ሀይአይስ|ሃይኤስ|ዶልፊን\s*ቫን|ዶልፊን/i, subcategory: "Van / Minibus" },
      { name: "bz4X", regex: /bz4x|ቢዜድ4ኤክስ/i, subcategory: "Electric (EV)" },
      { name: "Fortuner", regex: /fortuner|ፎርቹነር|ፎርቹን/i, subcategory: "SUV / Crossover" },
      { name: "Avanza", regex: /avanza|አቫንዛ/i, subcategory: "Van / Minibus" }
    ]
  },
  {
    name: "Suzuki",
    regex: /\bsuzuki\b|ሱዙኪ|ሱዚኪ/i,
    models: [
      { name: "Swift", regex: /\bswift\b|ስዊፍት/i, subcategory: "Hatchback / Compact" },
      { name: "Dzire", regex: /dzire|ዲዛየር|ዲዛይር/i, subcategory: "Sedan" },
      { name: "Celerio", regex: /celerio|ሴሌሪዮ|ሰሌሪዮ/i, subcategory: "Hatchback / Compact" },
      { name: "Alto", regex: /\balto\b|አልቶ/i, subcategory: "Hatchback / Compact" },
      { name: "Vitara", regex: /vitara|ቪታራ/i, subcategory: "SUV / Crossover" },
      { name: "Jimny", regex: /jimny|ጂምኒ/i, subcategory: "SUV / Crossover" },
      { name: "Ertiga", regex: /ertiga|ኤርቲጋ/i, subcategory: "Van / Minibus" },
      { name: "Baleno", regex: /baleno|ባሌኖ/i, subcategory: "Hatchback / Compact" },
      { name: "S-Presso", regex: /s-?presso|ኤስፕሬሶ|ኤስ-?ፕሬሶ/i, subcategory: "Hatchback / Compact" }
    ]
  },
  {
    name: "Hyundai",
    regex: /\bhyundai\b|ሂዩንዳይ|ሃዩንዳይ|ሁንዳይ/i,
    models: [
      { name: "Elantra", regex: /elantra|ኤላንትራ|ኢላንትራ/i, subcategory: "Sedan" },
      { name: "Tucson", regex: /tucson|ቱክሰን|ታክሰን/i, subcategory: "SUV / Crossover" },
      { name: "Avante", regex: /avante|አቫንቴ|አቫንተ/i, subcategory: "Sedan" },
      { name: "Accent", regex: /accent|አክሰንት/i, subcategory: "Sedan" },
      { name: "Creta", regex: /creta|ክሬታ/i, subcategory: "SUV / Crossover" },
      { name: "Santa Fe", regex: /santa\s*fe|ሳንታፌ|ሳንታ\s*ፌ/i, subcategory: "SUV / Crossover" },
      { name: "Ioniq 5", regex: /ioniq\s*5|አዮኒክ\s*5/i, subcategory: "Electric (EV)" },
      { name: "Grand i10", regex: /\bi10\b|አይ\s*10/i, subcategory: "Hatchback / Compact" },
      { name: "Kona", regex: /\bkona\b|ኮና/i, subcategory: "SUV / Crossover" },
      { name: "Staria", regex: /staria|ስታሪያ/i, subcategory: "Van / Minibus" }
    ]
  },
  {
    name: "Volkswagen",
    regex: /\bvolkswagen\b|\bvw\b|ፎልክስዋገን|ቮልስዋገን|ቮልክስዋገን/i,
    models: [
      { name: "ID.4 Crozz", regex: /id\.?\s*4|አይዲ\.?\s*4/i, subcategory: "Electric (EV)" },
      { name: "ID.6 Crozz", regex: /id\.?\s*6|አይዲ\.?\s*6/i, subcategory: "Electric (EV)" },
      { name: "Tiguan", regex: /tiguan|ቲጓን/i, subcategory: "SUV / Crossover" },
      { name: "Golf", regex: /\bgolf\b|ጎልፍ/i, subcategory: "Hatchback / Compact" }
    ]
  },
  {
    name: "Geely",
    regex: /\bgeely\b|ጂሊ/i,
    models: [
      { name: "Coolray", regex: /coolray|ኩልሬይ/i, subcategory: "SUV / Crossover" },
      { name: "Geometry C", regex: /geometry\s*c|ጂኦሜትሪ/i, subcategory: "Electric (EV)" },
      { name: "Monjaro", regex: /monjaro|ሞንጃሮ/i, subcategory: "SUV / Crossover" }
    ]
  },
  {
    name: "Changan",
    regex: /\bchangan\b|ቻንጋን/i,
    models: [
      { name: "CS35 Plus", regex: /cs\s*35|ሲኤስ\s*35/i, subcategory: "SUV / Crossover" },
      { name: "CS55 Plus", regex: /cs\s*55|ሲኤስ\s*55/i, subcategory: "SUV / Crossover" },
      { name: "UNI-T", regex: /uni-?t|ዩኒቲ/i, subcategory: "SUV / Crossover" },
      { name: "UNI-K", regex: /uni-?k|ዩኒኬ/i, subcategory: "SUV / Crossover" },
      { name: "BenBen E-Star", regex: /benben|ቤንቤን/i, subcategory: "Electric (EV)" }
    ]
  },
  {
    name: "Jetour",
    regex: /\bjetour\b|ጄቱር|ጀቱር/i,
    models: [
      { name: "Dashing", regex: /dashing|ዳሽንግ/i, subcategory: "SUV / Crossover" },
      { name: "X70 Plus", regex: /x70|ኤክስ\s*70/i, subcategory: "SUV / Crossover" },
      { name: "Traveler (T2)", regex: /traveler|\bt2\b|ትራቭለር/i, subcategory: "SUV / Crossover" }
    ]
  },
  {
    name: "Kia",
    regex: /\bkia\b|ኪያ/i,
    models: [
      { name: "Sportage", regex: /sportage|ስፖርቴጅ|ስፖርተጅ/i, subcategory: "SUV / Crossover" },
      { name: "Sorento", regex: /sorento|ሶሬንቶ/i, subcategory: "SUV / Crossover" },
      { name: "Picanto", regex: /picanto|ፒካንቶ/i, subcategory: "Hatchback / Compact" },
      { name: "Rio", regex: /\brio\b|ሪዮ/i, subcategory: "Sedan" },
      { name: "EV6", regex: /\bev6\b|ኢቪ6/i, subcategory: "Electric (EV)" }
    ]
  },
  {
    name: "Mercedes-Benz",
    regex: /\bmercedes\b|\bbenz\b|መርሴዲስ|መርሰዲስ|ቤንዝ/i,
    models: [
      { name: "C-Class", regex: /c-?class|c200|c180|c300|ሲ\s*ክላስ/i, subcategory: "Sedan" },
      { name: "E-Class", regex: /e-?class|e200|e300|e350|ኢ\s*ክላስ/i, subcategory: "Sedan" },
      { name: "G-Wagon / G-Class", regex: /g-?wagon|g63|g500|ጂ\s*ዋገን/i, subcategory: "SUV / Crossover" },
      { name: "GLE", regex: /\bgle\b/i, subcategory: "SUV / Crossover" }
    ]
  },
  {
    name: "Nissan",
    regex: /\bnissan\b|ኒሳን/i,
    models: [
      { name: "Patrol", regex: /patrol|ፓትሮል/i, subcategory: "SUV / Crossover" },
      { name: "X-Trail", regex: /x-?trail|ኤክስትሬል/i, subcategory: "SUV / Crossover" },
      { name: "Qashqai", regex: /qashqai|ካሽካይ/i, subcategory: "SUV / Crossover" },
      { name: "Sunny", regex: /sunny|ሳኒ/i, subcategory: "Sedan" }
    ]
  },
  {
    name: "Mitsubishi",
    regex: /\bmitsubishi\b|ሚትሱቢሺ|ሚጽቡሺ/i,
    models: [
      { name: "Pajero", regex: /pajero|ፓጄሮ|ፓጀሮ/i, subcategory: "SUV / Crossover" },
      { name: "L200", regex: /l200|ኤል\s*200/i, subcategory: "Pickup / Truck" },
      { name: "Outlander", regex: /outlander|አውትላንደር/i, subcategory: "SUV / Crossover" }
    ]
  },
  {
    name: "Isuzu",
    regex: /\bisuzu\b|አይሱዙ|ኢሱዙ/i,
    models: [
      { name: "NPR", regex: /\bnpr\b|ኤንፒአር/i, subcategory: "Pickup / Truck" },
      { name: "FSR", regex: /\bfsr\b|ኤፍኤስአር/i, subcategory: "Pickup / Truck" },
      { name: "D-Max", regex: /d-?max|ዲማክስ/i, subcategory: "Pickup / Truck" }
    ]
  },
  {
    name: "Sinotruk",
    regex: /\bsinotruk\b|\bhowo\b|ሳይኖትራክ|ሲኖትራክ|ሆዎ/i,
    models: [
      { name: "HOWO Dump Truck", regex: /howo|ሆዎ|ገልባጭ/i, subcategory: "Pickup / Truck" }
    ]
  },
  {
    name: "Land Rover",
    regex: /range\s*rover|land\s*rover|ሬንጅ\s*ሮቨር|ላንድ\s*ሮቨር/i,
    models: [
      { name: "Defender", regex: /defender|ዲፌንደር/i, subcategory: "SUV / Crossover" },
      { name: "Sport", regex: /range\s*rover\s*sport|ስፖርት/i, subcategory: "SUV / Crossover" },
      { name: "Vogue", regex: /vogue|ቮግ/i, subcategory: "SUV / Crossover" },
      { name: "Evoque", regex: /evoque|ኢቮክ/i, subcategory: "SUV / Crossover" }
    ]
  },
  {
    name: "Chery",
    regex: /\bchery\b|ቼሪ|ቸሪ/i,
    models: [
      { name: "Tiggo 7 Pro", regex: /tiggo\s*7|ቲጎ\s*7/i, subcategory: "SUV / Crossover" },
      { name: "Tiggo 8 Pro", regex: /tiggo\s*8|ቲጎ\s*8/i, subcategory: "SUV / Crossover" },
      { name: "EQ1 / Little Ant", regex: /eq1|little\s*ant/i, subcategory: "Electric (EV)" }
    ]
  },
  {
    name: "Zeekr",
    regex: /\bzeekr\b|ዚከር/i,
    models: [
      { name: "001", regex: /001/, subcategory: "Electric (EV)" },
      { name: "007", regex: /007/, subcategory: "Electric (EV)" },
      { name: "009", regex: /009/, subcategory: "Electric (EV)" },
      { name: "X", regex: /\bzeekr\s*x\b/i, subcategory: "Electric (EV)" }
    ]
  },
  {
    name: "Li Auto (Li Xiang)",
    regex: /li\s*auto|lixiang|ሊ\s*አውቶ|ሊ\s*ዢያንግ/i,
    models: [
      { name: "L6", regex: /\bl6\b/i, subcategory: "SUV / Crossover" },
      { name: "L7", regex: /\bl7\b/i, subcategory: "SUV / Crossover" },
      { name: "L8", regex: /\bl8\b/i, subcategory: "SUV / Crossover" },
      { name: "L9", regex: /\bl9\b/i, subcategory: "SUV / Crossover" }
    ]
  }
];

const ELECTRONICS_DATABASE = [
  {
    name: "Apple",
    regex: /\b(apple|iphone|macbook|ipad)\b|አፕል|አይፎን|ማክቡክ|አይፓድ/i,
    models: [
      { name: "iPhone 16 Pro Max", regex: /(?:16|፲፮)\s*(?:pro\s*max|ፕሮ\s*ማክስ)/i, subcategory: "Smartphones & Tablets" },
      { name: "iPhone 16 Pro", regex: /(?:16|፲፮)\s*(?:pro\b|ፕሮ)/i, subcategory: "Smartphones & Tablets" },
      { name: "iPhone 16", regex: /(?:iphone|አይፎን)\s*16/i, subcategory: "Smartphones & Tablets" },
      { name: "iPhone 15 Pro Max", regex: /15\s*(?:pro\s*max|ፕሮ\s*ማክስ)/i, subcategory: "Smartphones & Tablets" },
      { name: "iPhone 15 Pro", regex: /15\s*(?:pro\b|ፕሮ)/i, subcategory: "Smartphones & Tablets" },
      { name: "iPhone 15", regex: /(?:iphone|አይፎን)\s*15/i, subcategory: "Smartphones & Tablets" },
      { name: "iPhone 14 Pro Max", regex: /14\s*(?:pro\s*max|ፕሮ\s*ማክስ)/i, subcategory: "Smartphones & Tablets" },
      { name: "iPhone 14", regex: /(?:iphone|አይፎን)\s*14/i, subcategory: "Smartphones & Tablets" },
      { name: "iPhone 13", regex: /(?:iphone|አይፎን)\s*13/i, subcategory: "Smartphones & Tablets" },
      { name: "MacBook Pro", regex: /macbook\s*pro|ማክቡክ\s*ፕሮ/i, subcategory: "Laptops & Computers" },
      { name: "MacBook Air", regex: /macbook\s*air|ማክቡክ\s*ኤር/i, subcategory: "Laptops & Computers" },
      { name: "iPad Pro", regex: /ipad|አይፓድ/i, subcategory: "Smartphones & Tablets" }
    ]
  },
  {
    name: "Samsung",
    regex: /\b(samsung|galaxy)\b|ሳምሰንግ|ጋላክሲ/i,
    models: [
      { name: "Galaxy S24 Ultra", regex: /s24\s*(?:ultra|አልትራ)/i, subcategory: "Smartphones & Tablets" },
      { name: "Galaxy S24", regex: /s24/i, subcategory: "Smartphones & Tablets" },
      { name: "Galaxy S23 Ultra", regex: /s23\s*(?:ultra|አልትራ)/i, subcategory: "Smartphones & Tablets" },
      { name: "Galaxy Z Fold", regex: /z\s*fold/i, subcategory: "Smartphones & Tablets" },
      { name: "Galaxy Z Flip", regex: /z\s*flip/i, subcategory: "Smartphones & Tablets" }
    ]
  },
  {
    name: "Tecno",
    regex: /\btecno\b|ቴክኖ/i,
    models: [
      { name: "Camon", regex: /camon|ካሞን/i, subcategory: "Smartphones & Tablets" },
      { name: "Spark", regex: /spark|ስፓርክ/i, subcategory: "Smartphones & Tablets" },
      { name: "Phantom", regex: /phantom|ፋንተም/i, subcategory: "Smartphones & Tablets" }
    ]
  },
  {
    name: "Infinix",
    regex: /\binfinix\b|ኢንፊኒክስ/i,
    models: [
      { name: "Note", regex: /\bnote\b|ኖት/i, subcategory: "Smartphones & Tablets" },
      { name: "Hot", regex: /\bhot\b|ሆት/i, subcategory: "Smartphones & Tablets" }
    ]
  },
  {
    name: "Xiaomi",
    regex: /\b(xiaomi|redmi|poco)\b|ሺያኦሚ|ሬድሚ|ፖኮ/i,
    models: [
      { name: "Redmi Note", regex: /redmi\s*note|ሬድሚ\s*ኖት/i, subcategory: "Smartphones & Tablets" }
    ]
  },
  {
    name: "HP",
    regex: /\bhp\b|ኤችፒ/i,
    models: [
      { name: "EliteBook", regex: /elitebook|ኢሊትቡክ/i, subcategory: "Laptops & Computers" },
      { name: "Pavilion", regex: /pavilion|ፓቪሊዮን/i, subcategory: "Laptops & Computers" },
      { name: "ProBook", regex: /probook|ፕሮቡክ/i, subcategory: "Laptops & Computers" }
    ]
  },
  {
    name: "Dell",
    regex: /\bdell\b|ዴል/i,
    models: [
      { name: "XPS", regex: /\bxps\b/i, subcategory: "Laptops & Computers" },
      { name: "Latitude", regex: /latitude|ላቲቲዩድ/i, subcategory: "Laptops & Computers" }
    ]
  },
  {
    name: "Lenovo",
    regex: /\blenovo\b|ሌኖቮ/i,
    models: [
      { name: "ThinkPad", regex: /thinkpad|ቲንክፓድ/i, subcategory: "Laptops & Computers" }
    ]
  },
  {
    name: "LG",
    regex: /\blg\b|ኤልጂ/i,
    models: [
      { name: "Smart TV", regex: /tv|ቴሌቪዥን|ቲቪ/i, subcategory: "TV & Home Entertainment" }
    ]
  },
  {
    name: "Hisense",
    regex: /\bhisense\b|ሃይሴንስ|ሀይሴንስ/i,
    models: [
      { name: "Smart TV", regex: /tv|ቴሌቪዥን|ቲቪ/i, subcategory: "TV & Home Entertainment" },
      { name: "Refrigerator", regex: /fridge|ፍሪጅ|ማቀዝቀዣ/i, subcategory: "Home Appliances" }
    ]
  },
  {
    name: "Sony",
    regex: /\b(sony|playstation|ps5|ps4)\b|ሶኒ|ፕሌይስቴሽን/i,
    models: [
      { name: "PlayStation 5", regex: /ps5|playstation\s*5|ፕሌይስቴሽን\s*5/i, subcategory: "Gaming & Consoles" },
      { name: "Bravia TV", regex: /bravia|tv|ቴሌቪዥን|ቲቪ/i, subcategory: "TV & Home Entertainment" }
    ]
  }
];

// ============================================
// MAIN PROCESSING & AD BROADCASTER
// ============================================
async function processFinalAd(message, imageFileIds, messageIds, cleanText, env, mediaGroupId = null, isInsideTargetChannel = false) {
  const normalizedText = normalizeEthiopicNumerals(cleanText);
  let { brand, model, year, trim, bodyType, fuelType, transmission, subcategory } = detectBrandModelYear(normalizedText);
  let category = detectCategory(normalizedText, brand);
  let { formattedPrice, rawPrice } = parseMathematicalPrice(normalizedText, year);
  let condition = detectCondition(normalizedText, category);
  let city = extractCity(normalizedText);
  const subcity = extractSubcity(normalizedText);

  if (!subcategory) {
    subcategory = detectAmharicSubcategory(normalizedText, category) || bodyType || (category === "Cars" ? "Vehicles" : category);
  }

  let aiTitle = "";

  // Optional Gemini Amharic Text Intelligence (fills gaps for Amharic titles, brands, categories, prices)
  const hasAmharicChars = /[\u1200-\u137F]/.test(normalizedText);
  if (env.GEMINI_API_KEY && hasAmharicChars && (!brand || !rawPrice || category === "ምንአለሽ_ተራ")) {
    try {
      const amharicAi = await analyzeAmharicAdWithGemini(normalizedText, env);
      if (amharicAi) {
        if (!brand && amharicAi.brand) brand = amharicAi.brand;
        if (!model && amharicAi.model) model = amharicAi.model;
        if (!year && amharicAi.year) year = String(amharicAi.year);
        if (!trim && amharicAi.trim) trim = amharicAi.trim;
        if (category === "ምንአለሽ_ተራ" && amharicAi.category) category = amharicAi.category;
        if ((!subcategory || subcategory === category || subcategory === "Vehicles") && amharicAi.subcategory) {
          subcategory = amharicAi.subcategory;
        }
        if (amharicAi.title && amharicAi.title.trim().length > 2) aiTitle = amharicAi.title.trim();
        if (!rawPrice && amharicAi.priceETB && Number(amharicAi.priceETB) > 0) {
          rawPrice = Math.round(Number(amharicAi.priceETB));
          formattedPrice = rawPrice.toLocaleString("en-US");
        }
        if (amharicAi.city && city === "Addis Ababa") city = amharicAi.city;
        if (amharicAi.condition) condition = amharicAi.condition;
      }
    } catch (aiErr) {
      console.warn("Gemini Amharic NLP skipped:", aiErr.message);
    }
  }

  // Optional Gemini Vision enrichment for vehicle photos
  if (env.GEMINI_API_KEY && (!model || !brand) && category === "Cars" && imageFileIds.length > 0) {
    try {
      const visionResult = await inspectImageWithGemini(imageFileIds[0], normalizedText, env);
      if (visionResult) {
        if (!brand && visionResult.brand) brand = visionResult.brand;
        if (!model && visionResult.model) model = visionResult.model;
        if (!year && visionResult.year) year = visionResult.year;
        if (!trim && visionResult.trim) trim = visionResult.trim;
        if (visionResult.bodyType && !bodyType) bodyType = visionResult.bodyType;
        if (visionResult.subcategory && (!subcategory || subcategory === "Vehicles")) subcategory = visionResult.subcategory;
      }
    } catch (vErr) {
      console.warn("Vision enrichment skipped:", vErr.message);
    }
  }

  const arrangedTitle = arrangeTitle({
    brand,
    model,
    year,
    trim,
    cleanText: normalizedText,
    category,
    subcategory,
    subcity,
    aiTitle
  });
  const textHash = simpleHash(normalizedText.toLowerCase().replace(/\s+/g, ''));

  // Upload photos to Cloudinary if configured
  const imageUrls = await uploadImagesToCloudinary(imageFileIds.slice(0, 4), env);
  const finalDisplayImages = imageUrls.length > 0 
    ? imageUrls 
    : ["https://images.unsplash.com/photo-1549399542-7e3f8b79c341?auto=format&fit=crop&w=900&q=80"];

  // Profile ownership & document ID for website + Firebase profile management
  const websiteBaseUrl = (env.WEBSITE_URL || "https://ais-dev-ligixirxwi2nidlsx5j5hb-166746593299.europe-west3.run.app").replace(/\/$/, "");
  const adOwnerEmail = env.ADMIN_EMAIL || "marbatu1@gmail.com";
  const adDocId = mediaGroupId ? `tg_${message.chat?.id || ""}_${mediaGroupId}` : `tg_${textHash}`;

  // ============================================
  // 1. SAVE TO WEBSITE DIRECTLY (/api/ads)
  // ============================================
  try {
    const webAdPayload = {
      id: adDocId,
      title: arrangedTitle,
      category: category,
      subcategory: subcategory,
      brand: brand || "",
      price: rawPrice,
      city: city,
      subcity: subcity,
      condition: condition,
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
    const token = await getFirebaseToken(env);
    if (token && env.FIREBASE_PROJECT_ID) {
      const projectId = env.FIREBASE_PROJECT_ID;
      const adOwnerId = await resolveAdminUidByEmail(token, projectId, adOwnerEmail, env.ADMIN_UID || "admin_bot");
      const fbUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/ads/${adDocId}`;

      const adData = {
        fields: {
          title: { stringValue: arrangedTitle },
          brand: { stringValue: brand || "" },
          model: { stringValue: model || "" },
          year: { stringValue: year || "" },
          trim: { stringValue: trim || "" },
          bodyType: { stringValue: bodyType || "" },
          fuelType: { stringValue: fuelType || "" },
          transmission: { stringValue: transmission || "" },
          category: { stringValue: category },
          subcategory: { stringValue: subcategory },
          condition: { stringValue: condition },
          description: { stringValue: cleanText },
          textHash: { stringValue: textHash },
          price: { stringValue: formattedPrice },
          rawPrice: { integerValue: String(rawPrice) },
          phone: { stringValue: "0911680790" },
          city: { stringValue: city },
          subcity: { stringValue: subcity },
          image: { stringValue: finalDisplayImages[0] },
          images: { arrayValue: { values: finalDisplayImages.map((url) => ({ stringValue: url })) } },
          status: { stringValue: "available" },
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

      await fetch(fbUrl, { 
        method: "PATCH", 
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, 
        body: JSON.stringify(adData) 
      });
      console.log(`✅ Saved to Website (Firebase Firestore) for ${adOwnerEmail} (${adOwnerId})`);
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
    "Labor & Services": "#Labor", 
    "ምንአለሽ_ተራ": "#ምንአለሽ_ተራ" 
  };
  const hashtag = hashtagMap[category] || "#Other";
  const displayPriceText = formattedPrice && formattedPrice !== "0" ? `${formattedPrice} ETB` : "Negotiable / ተደራዳሪ";

  // Build the Header
  let headerText = `📝 Title: ${arrangedTitle}\n`;
  if (brand || model || year) {
    const metaParts = [];
    if (brand) metaParts.push(`Brand: ${brand}`);
    if (model) metaParts.push(`Model: ${model}`);
    if (year) metaParts.push(`Year: ${year}`);
    headerText += `🏷️ ${metaParts.join(" | ")}\n`;
  }
  headerText += `📂 Category: ${category}${subcategory && subcategory !== category ? ` › ${subcategory}` : ""}\n`;
  headerText += `💰 Price: ${displayPriceText}\n`;
  if (city || subcity) {
    headerText += `📍 Location: ${city}${subcity ? ` (${subcity})` : ""}\n`;
  }
  if (transmission || fuelType) {
    const specParts = [];
    if (transmission) specParts.push(`⚙️ ${transmission}`);
    if (fuelType) specParts.push(`⛽ ${fuelType}`);
    headerText += `${specParts.join(" | ")}\n`;
  }

  // Build the Protected Footer
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
        } catch (delManyErr) {
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
          media: media
        }, env);
      }
      console.log(`✅ Broadcasted Clean Ad to Channel ${targetChannel} (${imageFileIds.length} photos)`);
    } catch (chErr) {
      console.error(`❌ Repost Channel Error (${targetChannel}):`, chErr.message);
    }
  }
}

// ============================================
// ETHIOPIC NUMERAL NORMALIZER
// ============================================
function normalizeEthiopicNumerals(text) {
  if (!text) return "";
  const map = {
    "፩": "1", "፪": "2", "፫": "3", "፬": "4", "፭": "5",
    "፮": "6", "፯": "7", "፰": "8", "፱": "9", "፲": "10",
    "፳": "20", "፴": "30", "፵": "40", "፶": "50",
    "፷": "60", "፸": "70", "፹": "80", "፺": "90", "፻": "100"
  };
  return text.replace(/[፩-፻]+/g, (seq) => {
    if (seq.length === 1 && map[seq]) return map[seq];
    let total = 0;
    let current = 0;
    for (const ch of seq) {
      const val = Number(map[ch] || 0);
      if (val === 100) {
        total += (current || 1) * 100;
        current = 0;
      } else {
        current += val;
      }
    }
    return String(total + current);
  });
}

// ============================================
// BRAND / MODEL / YEAR / SPECS PARSER (AMHARIC + ENGLISH)
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

  const makeMatch = text.match(/(?:Make|የመኪናው\s*ዓይነት|የመኪና\s*ዓይነት|Brand|ብራንድ|አይነት)[ \t:=-]+([^\n,;()]+)/i);
  if (makeMatch && makeMatch[1]) {
    const candidate = makeMatch[1].replace(/[💎📌⭐✔️•.]/g, "").trim();
    if (!/^(?:new|brand\s*new|used|አዲስ|ያገለገለ)\b/i.test(candidate) && candidate.length < 30) {
      brand = candidate;
    }
  }

  const modelMatch = text.match(/(?:Model|ሞዴል)[ \t:=-]+([a-zA-Z0-9\u1200-\u137F/._ -]+)/i);
  if (modelMatch && modelMatch[1]) {
    model = modelMatch[1].replace(/[💎📌⭐✔️•.]/g, "").trim();
  }

  const yearMatch = text.match(/(?:Year|ዓመተ\s*ምህረት|የተሰራበት\s*ዓመት|ዓ\.?ም)[ \t:=-]+([0-9]{4}(?:\/[0-9]{1,2})?)/i);
  if (yearMatch && yearMatch[1]) {
    year = yearMatch[1].trim();
  } else {
    const ecYearMatch = text.match(/\b(200\d|201\d)\s*(?:ዓ\.?ም|E\.?C)/i);
    if (ecYearMatch) {
      year = `${ecYearMatch[1]} E.C`;
    } else {
      const rawYear = text.match(/\b(199\d|200\d|201\d|202[0-9])(?:\/([0-9]{1,2}))?\b/);
      if (rawYear) year = rawYear[0];
    }
  }

  // Ethiopian ad convention: "Model 2022" or "ሞዴል 2022" is manufacture YEAR, not model name!
  if (model && /^(?:19|20)\d{2}(?:\/\d{1,2})?$/.test(model)) {
    if (!year) year = model;
    model = "";
  }

  const trimMatch = text.match(/(?:Trim|ትሪም|Edition)[ \t:=-]+([a-zA-Z0-9/._ -]+)/i);
  if (trimMatch && trimMatch[1]) {
    trim = trimMatch[1].replace(/[💎📌⭐✔️•.]/g, "").trim();
  }

  const bodyMatch = text.match(/(?:Body\s*Type|የቦዲ\s*ዓይነት)[ \t:=-]+([a-zA-Z0-9\u1200-\u137F/._ -]+)/i);
  if (bodyMatch && bodyMatch[1]) {
    bodyType = bodyMatch[1].replace(/[💎📌⭐✔️•.]/g, "").trim();
  }

  const fuelMatch = text.match(/(?:Fuel|ነዳጅ)[ \t:=-]+([a-zA-Z0-9\u1200-\u137F/._ -]+)/i);
  if (fuelMatch && fuelMatch[1]) {
    fuelType = fuelMatch[1].replace(/[💎📌⭐✔️•.]/g, "").trim();
  }
  if (!fuelType || /[\u1200-\u137F]/.test(fuelType)) {
    if (/\bev\b|electric|ኤሌክትሪክ|በኤሌክትሪክ|በቻርጅ|ባትሪ/i.test(text)) {
      fuelType = "Electric";
    } else if (/benzin|petrol|ቤንዚን|በንዚን/i.test(text)) {
      fuelType = "Petrol / Benzin";
    } else if (/diesel|ናፍጣ/i.test(text)) {
      fuelType = "Diesel";
    } else if (/hybrid|ሃይብሪድ|ሀይብሪድ/i.test(text)) {
      fuelType = "Hybrid";
    }
  }

  const transMatch = text.match(/(?:Transmission|ማስተላለፊያ|ጊር)[ \t:=-]+([a-zA-Z0-9\u1200-\u137F/._ -]+)/i);
  if (transMatch && transMatch[1]) {
    const candidate = transMatch[1].replace(/[💎📌⭐✔️•.]/g, "").trim();
    if (/automatic|ኦቶማቲክ|አውቶማቲክ|አውቶ/i.test(candidate)) transmission = "Automatic";
    else if (/manual|ማኑዋል|ማንዋል/i.test(candidate)) transmission = "Manual";
    else if (candidate.length < 20 && !/^(?:19|20)\d{2}/.test(candidate)) transmission = candidate;
  }
  if (!transmission) {
    if (/automatic|ኦቶማቲክ|አውቶማቲክ/i.test(text)) transmission = "Automatic";
    else if (/manual|ማኑዋል|ማንዋል/i.test(text)) transmission = "Manual";
  }

  // Match car brand & model from CAR_DATABASE (including Amharic brand/model spellings)
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
    const matchedBrandObj = CAR_DATABASE.find(
      b => b.name.toLowerCase() === brand.toLowerCase() || b.regex.test(brand)
    );
    if (matchedBrandObj) {
      brand = matchedBrandObj.name;
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

  // Match electronics brand & model
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
    if (/suv|ኤስዩቪ/i.test(bodyType) || /\bsuv\b/i.test(text)) {
      subcategory = "SUV / Crossover";
    } else if (/sedan|ሴዳን/i.test(bodyType) || /\bsedan\b/i.test(text)) {
      subcategory = "Sedan";
    }
  }

  return { brand, model, year, trim, bodyType, fuelType, transmission, subcategory };
}

// ============================================
// AMHARIC TITLE EXTRACTOR & ARRANGER
// ============================================
function extractAmharicTitle(cleanText, category, subcity) {
  if (!cleanText) return "";

  // 1. Check explicit Amharic or English title labels
  const explicitMatch = cleanText.match(
    /(?:^|\n)[ \t]*(?:Title|ርዕስ|ስም|የእቃው\s*ስም|የእቃው\s*አይነት|የቤቱ\s*አይነት|አይነት)[ \t:：=-]+([^\n]+)/i
  );
  if (explicitMatch && explicitMatch[1]) {
    const candidate = cleanTitleLine(explicitMatch[1]);
    if (candidate.length >= 3) {
      return appendSubcityIfMissing(candidate, subcity);
    }
  }

  // 2. Score lines to skip greetings, standalone phone/price/contact lines, and pick descriptive Amharic title
  const lines = cleanText.split("\n").map((l) => l.trim()).filter(Boolean);
  const fillerLineRegex = /^(?:ሰላም(?:\s+ለሁላችሁ)?|እንዴት\s+ናችሁ|በአስቸኳይ|አስቸኳይ|ለበለጠ\s+መረጃ|ስልክ|አድራሻ|ዋጋ|የመሸጫ\s*ዋጋ|price|contact|call|location)[ \t:：=-]*$/i;
  const priceOnlyRegex = /^(?:ዋጋ|የመሸጫ\s*ዋጋ|price|በ|ብር|ETB)?[ \t:：=-]*[0-9.,]+[ \t]*(?:ETB|ብር|Birr|ሚሊዮን|ሚሊየን|ሚ|ሺህ|ሺ|k|m)?[ \t]*$/i;

  for (const rawLine of lines) {
    if (fillerLineRegex.test(rawLine) || priceOnlyRegex.test(rawLine)) continue;
    // Strip leading labels like "መግለጫ፡" or bullet prefixes
    const cleaned = cleanTitleLine(
      rawLine
        .replace(/^(?:አስቸኳይ\s*የሚሸጥ|በአስቸኳይ\s*የሚሸጥ|የሚሸጥ|ለሽያጭ\s*የቀረበ|ለኪራይ\s*የቀረበ)[ \t:：-]+/i, "")
        .replace(/^(?:ዋጋ|price)[ \t:：=-]+.*$/i, "")
    );
    if (cleaned.length >= 4) {
      return appendSubcityIfMissing(cleaned, subcity);
    }
  }

  return "";
}

function cleanTitleLine(str) {
  return (str || "")
    .replace(/[💎📌⭐✔️•#*_~`]/g, "")
    .replace(/\s+/g, " ")
    .replace(/^[:：\-–—.,\s]+|[:：\-–—.,\s]+$/g, "")
    .trim();
}

function appendSubcityIfMissing(title, subcity) {
  if (!subcity) return safeSubstring(title, 68);
  if (title.toLowerCase().includes(subcity.toLowerCase())) return safeSubstring(title, 68);
  const combined = `${title} (${subcity})`;
  return combined.length <= 68 ? combined : safeSubstring(title, 68);
}

function arrangeTitle({ brand, model, year, trim, cleanText, category, subcategory, subcity, aiTitle }) {
  if (category === "Cars") {
    const cleanYear = year ? year.split("/")[0] : "";
    if (brand && model) {
      const parts = [];
      if (cleanYear) parts.push(cleanYear);
      parts.push(brand);
      parts.push(model);
      if (trim && !model.toLowerCase().includes(trim.toLowerCase())) {
        parts.push(`(${trim})`);
      }
      return parts.join(" ");
    }
    if (brand) {
      const parts = [cleanYear, brand, subcategory && subcategory !== "Vehicles" ? subcategory : ""].filter(Boolean);
      return parts.join(" ");
    }
  }

  if (category === "Electronics" && brand && model) {
    return `${brand} ${model}${trim ? ` ${trim}` : ""}`;
  }

  if (aiTitle) {
    return safeSubstring(aiTitle, 68);
  }

  const amharicTitle = extractAmharicTitle(cleanText, category, subcity);
  if (amharicTitle) {
    return amharicTitle;
  }

  const firstLine = cleanTitleLine((cleanText.split("\n")[0] || ""));
  return safeSubstring(firstLine, 65) || `${category} Item`;
}

// ============================================
// AMHARIC + ENGLISH CATEGORY, SUBCATEGORY & CONDITION
// ============================================
function detectCategory(text, brand) {
  const t = text.toLowerCase();
  if (brand && CAR_DATABASE.some(b => b.name.toLowerCase() === brand.toLowerCase())) return "Cars";
  if (brand && ELECTRONICS_DATABASE.some(eb => eb.name.toLowerCase() === brand.toLowerCase())) return "Electronics";

  // Rentals vs Sales
  const isRentIntent = /(ኪራይ|ለኪራይ|የሚከራይ|ይከራያል|በወር|ወርሃዊ|\brent\b|\bfor\s*rent\b)/i.test(t);
  const isHouseTerm = /(ቤት|ኮንዶሚኒየም|አፓርታማ|ቪላ|መኝታ|ህንጻ|ህንፃ|ሱቅ|ቢሮ|መጋዘን|ቦታ|መሬት|ሪል\s*እስቴት|ካሬ|apartment|villa|house|condominium|g\+|sqm|bedroom)/i.test(t);
  const isCarTerm = /(መኪና|ተሽከርካሪ|አውቶሞቢል|ፒክአፕ|ቫን|ሚኒባስ|ባጃጅ|ታርጋ|ሰሌዳ|ኪሎ\s*ሜትር|ኮድ\s*[12345]|\bcar\b|vitz|corolla|rav4|suzuki|hyundai|byd|elantra|sealion|tucson|toyota|yaris|benz|mileage|\bkm\b|plate)/i.test(t);

  if (isCarTerm) return "Cars";
  if (isHouseTerm) {
    if (isRentIntent) return "Rentals";
    return "Houses";
  }
  if (isRentIntent) return "Rentals";

  if (/(ስልክ|ሞባይል|አይፎን|ሳምሰንግ|ላፕቶፕ|ኮምፒውተር|ታብሌት|ቴሌቪዥን|ቲቪ|ፕሌይስቴሽን|ፍሪጅ|ልብስ\s*ማጠቢያ|ማይክሮዌቭ|ስፒከር|ካሜራ|phone|iphone|samsung|laptop|macbook|ipad|\btv\b|electronics|playstation|ps5)/i.test(t)) {
    return "Electronics";
  }
  if (/(ሶፋ|አልጋ|ጠረጴዛ|ወንበር|ቁምሳጥን|ፍራሽ|መጋረጃ|ምንጣፍ|ፈርኒቸር|የቤት\s*እቃ|sofa|bed|table|chair|furniture|wardrobe|mattress)/i.test(t)) {
    return "Furniture";
  }
  if (/(ጫማ|ጃኬት|ቀሚስ|ልብስ|ሱፍ|ሸሚዝ|ቦርሳ|ሰዓት|ሽቶ|ቲሸርት|shoes|jacket|dress|suit|clothes|pants)/i.test(t)) {
    return "Clothes";
  }
  if (/(ቧንቧ|ኤሌክትሪክ\s*ሰራተኛ|ቀለም\s*ቀቢ|ሹፌር|ሰርቪስ|ጽዳት|ጥገና|ሞግዚት|አስተማሪ|ዲዛይን|driver|plumber|electrician|mechanic)/i.test(t)) {
    return "Labor & Services";
  }
  return "ምንአለሽ_ተራ";
}

function detectAmharicSubcategory(text, category) {
  if (category === "Cars") {
    if (/ኤሌክትሪክ|በቻርጅ|\bev\b|electric/i.test(text)) return "Electric (EV)";
    if (/ፒክአፕ|ገልባጭ|ትራክ|pickup|truck/i.test(text)) return "Pickup / Truck";
    if (/ቫን|ሚኒባስ|ዶልፊን|van|minibus/i.test(text)) return "Van / Minibus";
    if (/suv|ኤስዩቪ/i.test(text)) return "SUV / Crossover";
    if (/sedan|ሴዳን/i.test(text)) return "Sedan";
    return "Vehicles";
  }
  if (category === "Houses" || category === "Rentals") {
    if (/ኮንዶሚኒየም|condo/i.test(text)) return "Condominium";
    if (/አፓርታማ|apartment/i.test(text)) return "Apartment";
    if (/ቪላ|villa/i.test(text)) return "Villa";
    if (/ቦታ|መሬት|ይዞታ|land|plot/i.test(text)) return "Land / Plot";
    if (/ቢሮ|ሱቅ|መጋዘን|ህንጻ|commercial|office|shop/i.test(text)) return "Commercial / Office";
    return category === "Rentals" ? "For Rent" : "Residential";
  }
  if (category === "Electronics") {
    if (/ስልክ|ሞባይል|አይፎን|ታብሌት|phone|tablet/i.test(text)) return "Smartphones & Tablets";
    if (/ላፕቶፕ|ኮምፒውተር|laptop|computer/i.test(text)) return "Laptops & Computers";
    if (/ቴሌቪዥን|ቲቪ|tv/i.test(text)) return "TV & Home Entertainment";
    if (/ፍሪጅ|ማጠቢያ|ማይክሮዌቭ|fridge/i.test(text)) return "Home Appliances";
    return "Electronics";
  }
  if (category === "Furniture") {
    if (/ሶፋ|sofa/i.test(text)) return "Living Room";
    if (/አልጋ|ፍራሽ|ቁምሳጥን|bed/i.test(text)) return "Bedroom";
    if (/ጠረጴዛ|ወንበር|table|chair/i.test(text)) return "Dining & Office";
    return "Furniture";
  }
  return category;
}

function detectCondition(text, category) {
  if (category === "Rentals" || /(?:ለኪራይ|የሚከራይ|ይከራያል|\bfor\s*rent\b)/i.test(text)) {
    return "For Rent";
  }
  if (/(?:ብራንድ\s*ኒው|አዲስ|ዜሮ\s*ኪሎ|00\s*km|\bbrand\s*new\b)/i.test(text) && !/ያገለገለ|used/i.test(text)) {
    return "New";
  }
  return "Used";
}

// ============================================
// MATHEMATICAL AMHARIC + ENGLISH PRICE PARSER
// ============================================
function parseMathematicalPrice(text, knownYear) {
  if (!text) return { formattedPrice: "0", rawPrice: 0 };
  const detectedYear = (knownYear ? knownYear.split("/")[0].replace(/\D/g, "") : "") || "";

  const isExcluded = (num, rawStr) => {
    if (detectedYear && (num.toString() === detectedYear || rawStr.includes(detectedYear))) return true;
    if (num >= 1970 && num <= 2035) {
      const yearPattern = new RegExp(`(?:year|ዓመተ|ዓ\\.?ም|model|ሞዴል|month|ወር)?\\s*${num}`, "i");
      if (yearPattern.test(text)) return true;
    }
    return false;
  };

  // 1. Compound Amharic/English Million + Thousand (e.g. "4 ሚሊዮን 500 ሺህ" -> 4,500,000)
  const compoundMillionMatch = text.match(
    /([0-9]+(?:[.,][0-9]+)?)\s*(?:ETB|ብር|Birr)?\s*(?:million|mil|mln|ሚሊዮን|ሚሊየን|ሚ\.?)(?:\s*(?:ከ|እና)?\s*([0-9]+(?:[.,][0-9]+)?)\s*(?:thousand|ሺህ|ሺ|k))?/i
  );
  if (compoundMillionMatch && compoundMillionMatch[1]) {
    const milVal = parseFloat(compoundMillionMatch[1].replace(/,/g, ""));
    const thouVal = compoundMillionMatch[2] ? parseFloat(compoundMillionMatch[2].replace(/,/g, "")) : 0;
    if (!isNaN(milVal) && milVal > 0 && milVal < 1000) {
      const finalNum = Math.round(milVal * 1000000 + (isNaN(thouVal) ? 0 : thouVal * 1000));
      return { formattedPrice: finalNum.toLocaleString("en-US"), rawPrice: finalNum };
    }
  }

  // 2. Explicit price label line (ዋጋ, የመሸጫ ዋጋ, መሸጫ, ኪራይ, Price, Fixed)
  const explicitLineMatch = text.match(
    /(?:💰|price|ዋጋ|fixed|የመሸጫ\s*ዋጋ|መሸጫ|ጠቅላላ\s*ዋጋ|ወርሃዊ\s*ኪራይ|ኪራይ)[ \t:：=-]+(?:በ\s*)?([0-9.,]+)\s*(?:ETB|ብር|Birr)?\s*(?:million|mil|mln|m|ሚሊዮን|ሚሊየን|ሚ|k|thousand|ሺህ|ሺ)?/i
  );
  if (explicitLineMatch && explicitLineMatch[1]) {
    const rawVal = explicitLineMatch[1];
    const isMillion = /(?:million|mil|mln|\bm\b|ሚሊዮን|ሚሊየን|ሚ(?:\s|$))/i.test(explicitLineMatch[0]);
    const isThousand = /(?:\bk\b|thousand|ሺህ|ሺ)/i.test(explicitLineMatch[0]);

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

  // 3. Thousand patterns anywhere (e.g. "450 ሺህ", "250ሺ", "35k")
  const thousandMatch = text.match(/([0-9]+(?:[.,][0-9]+)*)\s*(?:ETB|ብር|Birr)?\s*(?:k\b|thousand|ሺህ|ሺ)/i);
  if (thousandMatch && thousandMatch[1]) {
    const rawVal = thousandMatch[1];
    const val = parseFloat(rawVal.replace(/,/g, ""));
    if (!isNaN(val) && val > 0 && val < 10000) {
      const finalNum = Math.round(val * 1000);
      return { formattedPrice: finalNum.toLocaleString("en-US"), rawPrice: finalNum };
    }
  }

  // 4. Currency adjacent numbers ("ETB 5,650,000", "45,000 ብር")
  const currencyMatch = text.match(
    /(?:ETB|ብር|Birr)\s*[:=.-]?\s*([0-9]{1,3}(?:[.,][0-9]{3})+|[0-9]{4,10})|([0-9]{1,3}(?:[.,][0-9]{3})+|[0-9]{4,10})\s*(?:ETB|ብር|Birr)/i
  );
  if (currencyMatch) {
    const rawVal = currencyMatch[1] || currencyMatch[2];
    if (rawVal) {
      const num = parseInt(rawVal.replace(/[.,]/g, ""), 10);
      if (!isNaN(num) && num > 100 && !isExcluded(num, rawVal)) {
        return { formattedPrice: num.toLocaleString("en-US"), rawPrice: num };
      }
    }
  }

  // 5. Fallback scan on lines containing ዋጋ or price
  const lines = text.split("\n");
  for (const line of lines) {
    if (/(?:price|ዋጋ|መሸጫ|ኪራይ)/i.test(line)) {
      const nums = line.match(/\b([0-9]{1,3}(?:[.,][0-9]{3})+|[0-9]{4,9})\b/);
      if (nums) {
        const num = parseInt(nums[1].replace(/[.,]/g, ""), 10);
        if (!isNaN(num) && num > 500 && !isExcluded(num, nums[1])) {
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
    .replace(/(?:phone|call|mobile|ስልክ|ቴሌግራም|telegram|contact|ይደውሉ|ይደውሉልን|ለበለጠ\s*መረጃ)[ \t:：=-]+(?:or|\/|ወይም)?\s*(?=\n|$)/gi, "")
    .replace(/[ \t]+/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractCity(text) {
  const lower = text.toLowerCase();
  if (/(አዲስ\s*አበባ|addis\s*ababa|finfinne|ቦሌ|ሳርቤት|ሲኤምሲ|ገርጂ|ፒያሳ|አያት|ሰሚት|መገናኛ|ለቡ|ጀሞ|bole|sarbet|cmc|gerji|piassa|ayat|summit)/i.test(lower)) return "Addis Ababa";
  if (/(hawassa|ሀዋሳ|ሐዋሳ)/i.test(lower)) return "Hawassa";
  if (/(adama|አዳማ|ናዝሬት|nazret)/i.test(lower)) return "Adama";
  if (/(bahir\s*dar|ባህር\s*ዳር)/i.test(lower)) return "Bahir Dar";
  if (/(dire\s*dawa|ድሬ\s*ዳዋ|ድሬዳዋ)/i.test(lower)) return "Dire Dawa";
  if (/(gondar|ጎንደር)/i.test(lower)) return "Gondar";
  if (/(mekelle|መቀሌ|መቀለ)/i.test(lower)) return "Mekelle";
  if (/(jimma|ጅማ)/i.test(lower)) return "Jimma";
  if (/(bishoftu|ቢሾፍቱ|ደብረ\s*ዘይት)/i.test(lower)) return "Bishoftu";
  if (/(dessie|ደሴ)/i.test(lower)) return "Dessie";
  if (/(harar|ሀረር|ሐረር)/i.test(lower)) return "Harar";
  return "Addis Ababa";
}

function extractSubcity(text) {
  const map = [
    [/ቦሌ|\bbole\b/i, "Bole"],
    [/ሰሚት|\bsummit\b/i, "Summit"],
    [/ሲኤምሲ|\bcmc\b/i, "CMC"],
    [/ገርጂ|\bgerji\b/i, "Gerji"],
    [/አያት|\bayat\b/i, "Ayat"],
    [/ሳር\s*ቤት|ሳርቤት|\bsarbet\b/i, "Sarbet"],
    [/መገናኛ|\bmegenagna\b/i, "Megenagna"],
    [/ካዛንቺስ|\bkazanchis\b/i, "Kazanchis"],
    [/ለቡ|\blebu\b/i, "Lebu"],
    [/ጀሞ|\bjemo\b/i, "Jemo"],
    [/ፒያሳ|\bpiassa\b/i, "Piassa"],
    [/የካ|\byeka\b/i, "Yeka"],
    [/ቃሊቲ|\bkaliti\b/i, "Kaliti"],
    [/መርካቶ|\bmerkato\b/i, "Merkato"],
    [/4\s*ኪሎ|አራት\s*ኪሎ/i, "Arat Kilo"],
    [/22|ሃያ\s*ሁለት/i, "Haya Hulet"]
  ];
  for (const [regex, label] of map) {
    if (regex.test(text)) return label;
  }
  return "";
}

async function uploadImagesToCloudinary(imageFileIds, env) {
  if (!env.CLOUDINARY_CLOUD_NAME || env.CLOUDINARY_CLOUD_NAME === "your_cloud_name" || !env.CLOUDINARY_UPLOAD_PRESET || !imageFileIds || imageFileIds.length === 0) {
    return [];
  }
  const urls = [];
  for (const fileId of imageFileIds.slice(0, 4)) {
    try {
      const getFileRes = await callTelegram("getFile", { file_id: fileId }, env);
      if (!getFileRes || !getFileRes.file_path) continue;
      const tgFileUrl = `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${getFileRes.file_path}`;
      const form = new FormData();
      form.append("file", tgFileUrl);
      form.append("upload_preset", env.CLOUDINARY_UPLOAD_PRESET);
      const uploadRes = await fetch(`https://api.cloudinary.com/v1_1/${env.CLOUDINARY_CLOUD_NAME}/image/upload`, {
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

async function analyzeAmharicAdWithGemini(cleanText, env) {
  if (!env.GEMINI_API_KEY || !cleanText) return null;
  try {
    const prompt = `You are an Ethiopian marketplace classifier for Amharic and English Telegram ads.
Extract structured details from this listing text:
"""
${cleanText.substring(0, 900)}
"""
Return ONLY valid JSON:
{
  "title": "concise clean listing title (keep key Amharic or English product name, max 60 chars)",
  "category": "one of: Cars, Houses, Rentals, Electronics, Furniture, Clothes, Labor & Services, ምንአለሽ_ተራ",
  "subcategory": "concise subcategory",
  "brand": "brand name in English if present, else empty string",
  "model": "model name if present, else empty string",
  "year": "4-digit year if present, else empty string",
  "trim": "",
  "priceETB": 0,
  "city": "Addis Ababa",
  "condition": "New or Used or For Rent"
}`;

    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${env.GEMINI_API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { response_mime_type: "application/json" }
      })
    });
    const data = await res.json();
    const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

async function inspectImageWithGemini(fileId, contextText, env) {
  if (!env.GEMINI_API_KEY) return null;
  try {
    const fileRes = await callTelegram("getFile", { file_id: fileId }, env);
    if (!fileRes?.file_path) return null;
    const tgUrl = `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${fileRes.file_path}`;
    const imgFetch = await fetch(tgUrl);
    const arrayBuffer = await imgFetch.arrayBuffer();
    const base64Image = btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)));

    const prompt = `Analyze this vehicle photo for an Ethiopian marketplace ad.
Context: "${contextText.substring(0, 200)}"
Return ONLY valid JSON matching this schema:
{
  "brand": "Hyundai",
  "model": "Elantra",
  "year": "2022",
  "trim": "",
  "bodyType": "Sedan",
  "subcategory": "Sedan"
}`;

    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${env.GEMINI_API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: "image/jpeg", data: base64Image } }] }],
        generationConfig: { response_mime_type: "application/json" }
      })
    });
    const data = await res.json();
    const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    return null;
  }
}

async function getFirebaseToken(env) {
  const now = Math.floor(Date.now() / 1000);
  if (cachedFirebaseToken && tokenExpiresAt > now + 300) return cachedFirebaseToken;
  const clientEmail = env.FIREBASE_CLIENT_EMAIL;
  const privateKey = (env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n");
  if (!clientEmail || !privateKey) return "";

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
    const pemContents = privateKey.replace("-----BEGIN PRIVATE KEY-----", "").replace("-----END PRIVATE KEY-----", "").replace(/\s/g, "");
    const binaryDer = Uint8Array.from(atob(pemContents), (c) => c.charCodeAt(0));
    const cryptoKey = await crypto.subtle.importKey("pkcs8", binaryDer, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
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
    const tokData = await tokRes.json();
    if (!tokData.access_token) return "";
    cachedFirebaseToken = tokData.access_token;
    tokenExpiresAt = now + (tokData.expires_in || 3600);
    return cachedFirebaseToken;
  } catch (err) {
    console.warn("Failed to generate Firebase token:", err.message);
    return "";
  }
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

async function migrateOldBotPostsToProfile(env) {
  const token = await getFirebaseToken(env);
  const projectId = env.FIREBASE_PROJECT_ID;
  const adOwnerEmail = env.ADMIN_EMAIL || "marbatu1@gmail.com";

  if (!token || !projectId) {
    return {
      ok: false,
      error: "Missing FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY, or FIREBASE_PROJECT_ID in Cloudflare Variables."
    };
  }

  const adOwnerId = await resolveAdminUidByEmail(token, projectId, adOwnerEmail, env.ADMIN_UID || "admin_bot");
  const baseAdsUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/ads`;
  const maskParams = [
    "userId",
    "uid",
    "ownerId",
    "userEmail",
    "email",
    "ownerEmail",
    "source",
    "isBotPost"
  ].map((f) => `updateMask.fieldPaths=${f}`).join("&");

  let pageToken = "";
  let scanned = 0;
  let updated = 0;
  let skippedAlreadyOwned = 0;
  let errors = 0;

  do {
    const listUrl = `${baseAdsUrl}?pageSize=100${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`;
    const listRes = await fetch(listUrl, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const listData = await listRes.json();

    if (!listRes.ok) {
      return {
        ok: false,
        error: listData?.error?.message || `Firestore list failed (${listRes.status})`
      };
    }

    const docs = listData.documents || [];
    for (const doc of docs) {
      scanned++;
      const docId = doc.name.split("/").pop() || "";
      const f = doc.fields || {};
      const existingUid = f.userId?.stringValue || "";
      const existingEmail = f.userEmail?.stringValue || f.ownerEmail?.stringValue || "";
      const source = f.source?.stringValue || "";

      const isOldBotPost =
        source === "telegram" ||
        existingUid === "admin_bot" ||
        docId.startsWith("tg_") ||
        (docId.startsWith("ad_") && (!existingUid || existingUid === "admin_bot") && !existingEmail);

      if (!isOldBotPost) continue;

      const alreadyOwned = existingEmail === adOwnerEmail && existingUid === adOwnerId;
      if (alreadyOwned) {
        skippedAlreadyOwned++;
        continue;
      }

      const patchRes = await fetch(`${baseAdsUrl}/${encodeURIComponent(docId)}?${maskParams}`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          fields: {
            userId: { stringValue: adOwnerId },
            uid: { stringValue: adOwnerId },
            ownerId: { stringValue: adOwnerId },
            userEmail: { stringValue: adOwnerEmail },
            email: { stringValue: adOwnerEmail },
            ownerEmail: { stringValue: adOwnerEmail },
            source: { stringValue: "telegram" },
            isBotPost: { booleanValue: true }
          }
        })
      });

      if (patchRes.ok) {
        updated++;
      } else {
        errors++;
      }
    }

    pageToken = listData.nextPageToken || "";
  } while (pageToken);

  return {
    ok: true,
    adminEmail: adOwnerEmail,
    resolvedUid: adOwnerId,
    uidAutoMatched: adOwnerId !== "admin_bot",
    scanned,
    updated,
    skippedAlreadyOwned,
    errors,
    note:
      adOwnerId === "admin_bot"
        ? "UID not found in Firestore users collection; set ADMIN_UID in Cloudflare Variables to your Firebase Auth UID and re-run if your profile filters only by UID."
        : "All old bot posts now match your profile UID and email."
  };
}
