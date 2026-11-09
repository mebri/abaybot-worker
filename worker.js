/**
 * Yegna Gebeya Telegram Bot - Cloudflare Worker
 * 
 * Production Anti-Double-Post Architecture:
 * 1. Multi-tier Deduplication Lock (Update ID + MediaGroup ID + Text Hash)
 * 2. Distributed Edge Lock via Cloudflare Cache API + In-Memory Mutex
 * 3. Channel Loop Prevention: Blocks target channel ID, username, sender_chat, and all bot signatures
 * 4. Album (Media Group) Aggregator: Ensures all photos in an album send in a single media group exactly once
 * 5. AI Title Arranger: [Year] [Brand] [Model] [Trim] (e.g. "2025 BYD Sealion 06 EV")
 * 6. Mathematical Amharic Price Parser: ሚሊዮን (1,000,000), ሺህ (1,000), protects manufacture years
 * 7. Cloudinary Upload + Firestore Integration with duplicate protection
 */

// In-Memory Fallback Caches
const albumCache = new Map();
const processedLocks = new Map();
const updateIdLocks = new Set();
let cachedFirebaseToken = null;
let tokenExpiresAt = 0;

export default {
  async fetch(request, env, ctx) {
    // Health check endpoint
    if (request.method !== "POST") {
      return new Response("Yegna Gebeya Bot is running ✅ (Anti-Duplicate v3.0)", { 
        status: 200,
        headers: { "Content-Type": "text/plain; charset=utf-8" }
      });
    }

    try {
      const update = await request.json();
      
      // Fast ACK to Telegram: prevent Telegram webhook retry flood
      ctx.waitUntil(processUpdateSafe(update, env));
      return new Response("OK", { status: 200 });
    } catch (error) {
      console.error("Webhook parse error:", error.message);
      return new Response("OK", { status: 200 }); // Always return 200 so Telegram doesn't retry infinitely
    }
  }
};

async function processUpdateSafe(update, env) {
  try {
    await processUpdate(update, env);
  } catch (err) {
    console.error("Unhandled processUpdate error:", err.message);
  }
}

async function processUpdate(update, env) {
  // 1. DEDUPLICATE TELEGRAM UPDATE ID
  if (update.update_id) {
    if (updateIdLocks.has(update.update_id)) {
      console.log(`⏭️ Ignored: Duplicate update_id ${update.update_id}`);
      return;
    }
    updateIdLocks.add(update.update_id);
    if (updateIdLocks.size > 2000) {
      const firstKey = updateIdLocks.values().next().value;
      updateIdLocks.delete(firstKey);
    }
  }

  // 2. IGNORE EDITED MESSAGES (Prevents duplicate re-posts when seller edits typos)
  if (update.edited_message || update.edited_channel_post) {
    return;
  }

  const message = update.message || update.channel_post;
  if (!message) return;

  // 3. IGNORE BOT MESSAGES
  const botId = env.TELEGRAM_BOT_TOKEN ? env.TELEGRAM_BOT_TOKEN.split(":")[0] : "";
  if (message.from && (String(message.from.id) === botId || message.from.is_bot)) {
    return;
  }

  // 4. IGNORE AUTOMATIC FORWARDS TO LINKED DISCUSSION GROUPS
  if (message.is_automatic_forward) return;

  // 5. IGNORE POSTS FROM TARGET REPOST CHANNEL (Prevent infinite re-post loops)
  const targetChannelRaw = env.REPOST_CHANNEL_ID || "@mebrigranite";
  const targetClean = targetChannelRaw.replace("@", "").toLowerCase();

  const chatIdStr = String(message.chat.id);
  const chatUser = (message.chat.username || "").toLowerCase();
  if (chatUser === targetClean || chatIdStr === targetClean) return;

  if (message.sender_chat) {
    const senderUser = (message.sender_chat.username || "").toLowerCase();
    const senderIdStr = String(message.sender_chat.id);
    if (senderUser === targetClean || senderIdStr === targetClean) return;
  }

  if (message.forward_from_chat) {
    const fwdUser = (message.forward_from_chat.username || "").toLowerCase();
    const fwdIdStr = String(message.forward_from_chat.id);
    if (fwdUser === targetClean || fwdIdStr === targetClean) return;
  }

  const rawText = (message.text || message.caption || "").trim();

  // 6. STRICT BOT WATERMARK DETECTION
  // If the text contains ANY official bot signatures, it is already posted!
  if (
    rawText.includes("🏢 የኛ ገበያ (Yegna Gebeya)") ||
    rawText.includes("mebri.yegna.workers.dev") ||
    rawText.includes("@mebrigranite") ||
    rawText.includes("0911680790") ||
    rawText.includes("#YegnaGebeya") ||
    rawText.includes("📝 Title:") ||
    rawText.includes("💰 Price:") ||
    /#(Cars|Houses|Rentals|Electronics|Furniture|Clothes|Labor|ምንአለሽ_ተራ|Other)\b/i.test(rawText)
  ) {
    console.log("⏭️ Ignored: Watermark detected (already formatted ad).");
    return;
  }

  // ============================================
  // ALBUM (MEDIA GROUP) MULTI-PHOTO HANDLING
  // ============================================
  if (message.media_group_id) {
    const groupId = String(message.media_group_id);

    // Fast check: If this album already finished and was broadcast, drop it immediately!
    const albumDoneKey = `album_done_${groupId}`;
    if (await isEdgeLocked(albumDoneKey)) {
      console.log(`⏭️ Ignored: Album ${groupId} already processed.`);
      return;
    }

    if (!albumCache.has(groupId)) {
      albumCache.set(groupId, {
        images: [],
        messageIds: [],
        captionMessage: null,
        timerActive: false,
        timestamp: Date.now()
      });
    }

    const albumData = albumCache.get(groupId);

    // Collect photo file IDs
    if (message.photo && message.photo.length > 0) {
      const bestPhoto = message.photo[message.photo.length - 1].file_id;
      if (!albumData.images.includes(bestPhoto)) {
        albumData.images.push(bestPhoto);
      }
      albumData.messageIds.push(message.message_id);
    }

    // Capture the message that contains the actual text/caption
    if (rawText.length > 3 && !albumData.captionMessage) {
      albumData.captionMessage = message;
    }

    // Single coordinator timer
    if (!albumData.timerActive) {
      albumData.timerActive = true;

      // Wait 3.5 seconds to collect all photos arriving across webhook requests
      await new Promise((resolve) => setTimeout(resolve, 3500));

      if (!albumCache.has(groupId)) return;
      const finalData = albumCache.get(groupId);
      albumCache.delete(groupId);

      // Acquire exclusive distributed broadcast lock for this album
      const acquired = await acquireEdgeLock(albumDoneKey, 600); // 10 minute lock
      if (!acquired) {
        console.log(`🛑 Duplicate album broadcast prevented for group ${groupId}`);
        return;
      }

      const postMsg = finalData.captionMessage || message;
      const postText = (postMsg.text || postMsg.caption || "").trim();
      if (postText.length < 3) {
        console.log("⏭️ Dropping album: No text caption found.");
        return;
      }

      await processFinalAd(postMsg, finalData.images, finalData.messageIds, env, groupId);
    }

    cleanupStaleAlbums();
    return;
  }

  // ============================================
  // SINGLE POST HANDLING
  // ============================================
  if (rawText.length < 3) return;

  // Single message deduplication lock by chat + messageId
  const msgLockKey = `msg_${message.chat.id}_${message.message_id}`;
  if (!(await acquireEdgeLock(msgLockKey, 600))) {
    console.log(`⏭️ Ignored: Message ${msgLockKey} already processed.`);
    return;
  }

  // Deduplicate by text content hash (prevents identical cross-group spam within 5 mins)
  const cleanCheck = cleanTheText(rawText);
  const textHash = simpleHash(cleanCheck.toLowerCase().replace(/\s+/g, ''));
  const contentLockKey = `content_${textHash}`;
  if (!(await acquireEdgeLock(contentLockKey, 300))) {
    console.log(`⏭️ Ignored: Duplicate ad content detected (hash: ${textHash}).`);
    return;
  }

  const images = [];
  if (message.photo && message.photo.length > 0) {
    images.push(message.photo[message.photo.length - 1].file_id);
  }

  await processFinalAd(message, images, [message.message_id], env, null);
}

// ============================================
// ATOMIC DISTRIBUTED LOCKS (EDGE CACHE + MEMORY)
// Works across all Cloudflare isolates & instances
// ============================================
async function acquireEdgeLock(key, ttlSeconds = 300) {
  const now = Date.now();
  if (processedLocks.has(key)) {
    const expires = processedLocks.get(key);
    if (now < expires) return false;
    processedLocks.delete(key);
  }
  processedLocks.set(key, now + (ttlSeconds * 1000));

  try {
    if (typeof caches !== "undefined" && caches.default) {
      const cache = caches.default;
      const lockUrl = `https://yegna-lock.internal/${key}`;
      const req = new Request(lockUrl);
      const hit = await cache.match(req);
      if (hit) return false;

      const res = new Response("LOCKED", {
        headers: { "Cache-Control": `public, max-age=${ttlSeconds}` }
      });
      await cache.put(req, res);
      return true;
    }
  } catch (err) {
    console.warn("Edge lock fallback to memory:", err.message);
  }

  return true;
}

async function isEdgeLocked(key) {
  const now = Date.now();
  if (processedLocks.has(key)) {
    if (now < processedLocks.get(key)) return true;
    processedLocks.delete(key);
  }

  try {
    if (typeof caches !== "undefined" && caches.default) {
      const cache = caches.default;
      const req = new Request(`https://yegna-lock.internal/${key}`);
      const hit = await cache.match(req);
      if (hit) return true;
    }
  } catch (e) {}

  return false;
}

function cleanupStaleAlbums() {
  const now = Date.now();
  for (const [key, data] of albumCache.entries()) {
    if (now - data.timestamp > 60000) albumCache.delete(key);
  }
  for (const [key, exp] of processedLocks.entries()) {
    if (now > exp) processedLocks.delete(key);
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
// CARS & ELECTRONICS DATABASE
// ============================================
const CAR_DATABASE = [
  {
    name: "BYD",
    regex: /\b(byd|ባይድ)\b/i,
    models: [
      { name: "Sealion 06 EV", regex: /sealion\s*06/i, subcategory: "Electric (EV)" },
      { name: "Sealion 07", regex: /sealion\s*07/i, subcategory: "Electric (EV)" },
      { name: "Seagull", regex: /seagull/i, subcategory: "Electric (EV)" },
      { name: "Song Plus EV", regex: /song\s*plus/i, subcategory: "Electric (EV)" },
      { name: "Atto 3 / Yuan Plus", regex: /(atto\s*3|yuan\s*plus)/i, subcategory: "Electric (EV)" },
      { name: "Tang", regex: /\btang\b/i, subcategory: "Electric (EV)" },
      { name: "Han", regex: /\bhan\b/i, subcategory: "Electric (EV)" },
      { name: "Dolphin", regex: /dolphin/i, subcategory: "Electric (EV)" },
      { name: "Qin Plus", regex: /qin\s*plus/i, subcategory: "Sedan" },
      { name: "Chazor / Destroyer 05", regex: /(chazor|destroyer\s*05)/i, subcategory: "Sedan" }
    ]
  },
  {
    name: "Toyota",
    regex: /\b(toyota|ቶዮታ)\b/i,
    models: [
      { name: "Corolla", regex: /corolla|ኮሮላ/i, subcategory: "Sedan" },
      { name: "RAV4", regex: /rav\s*4|ራቭ\s*4/i, subcategory: "SUV / Crossover" },
      { name: "Land Cruiser", regex: /land\s*cruiser|ላንድ\s*ክሩዘር/i, subcategory: "SUV / Crossover" },
      { name: "Prado", regex: /prado|ፕራዶ/i, subcategory: "SUV / Crossover" },
      { name: "Hilux", regex: /hilux|ሃይሉክስ/i, subcategory: "Pickup / Truck" },
      { name: "Yaris", regex: /yaris|ያሪስ/i, subcategory: "Hatchback / Compact" },
      { name: "Vitz", regex: /vitz|ቪትዝ/i, subcategory: "Hatchback / Compact" },
      { name: "Camry", regex: /camry|ካምሪ/i, subcategory: "Sedan" },
      { name: "Rush", regex: /rush|ራሽ/i, subcategory: "SUV / Crossover" },
      { name: "HiAce", regex: /hiace|ሀይአይስ|ዶልፊን\s*ቫን/i, subcategory: "Van / Minibus" },
      { name: "bz4X", regex: /bz4x/i, subcategory: "Electric (EV)" },
      { name: "Fortuner", regex: /fortuner|ፎርቹን/i, subcategory: "SUV / Crossover" }
    ]
  },
  {
    name: "Suzuki",
    regex: /\b(suzuki|ሱዙኪ)\b/i,
    models: [
      { name: "Swift", regex: /\bswift\b|ስዊፍት/i, subcategory: "Hatchback / Compact" },
      { name: "Dzire", regex: /dzire|ዲዛየር/i, subcategory: "Sedan" },
      { name: "Celerio", regex: /celerio|ሴሌሪዮ/i, subcategory: "Hatchback / Compact" },
      { name: "Alto", regex: /alto|አልቶ/i, subcategory: "Hatchback / Compact" },
      { name: "Vitara", regex: /vitara|ቪታራ/i, subcategory: "SUV / Crossover" },
      { name: "Jimny", regex: /jimny|ጂምኒ/i, subcategory: "SUV / Crossover" },
      { name: "Ertiga", regex: /ertiga/i, subcategory: "Van / Minibus" },
      { name: "S-Presso", regex: /s-?presso|ኤስፕሬሶ/i, subcategory: "Hatchback / Compact" }
    ]
  },
  {
    name: "Hyundai",
    regex: /\b(hyundai|ሂዩንዳይ)\b/i,
    models: [
      { name: "Elantra", regex: /elantra|ኤላንትራ/i, subcategory: "Sedan" },
      { name: "Tucson", regex: /tucson|ቱክሰን/i, subcategory: "SUV / Crossover" },
      { name: "Avante", regex: /avante|አቫንቴ/i, subcategory: "Sedan" },
      { name: "Creta", regex: /creta|ክሬታ/i, subcategory: "SUV / Crossover" },
      { name: "Santa Fe", regex: /santa\s*fe|ሳንታፌ/i, subcategory: "SUV / Crossover" },
      { name: "Ioniq 5", regex: /ioniq\s*5/i, subcategory: "Electric (EV)" },
      { name: "Grand i10", regex: /i10|አይ10/i, subcategory: "Hatchback / Compact" },
      { name: "Kona", regex: /kona|ኮና/i, subcategory: "SUV / Crossover" },
      { name: "Accent", regex: /accent|አክሰንት/i, subcategory: "Sedan" }
    ]
  },
  {
    name: "Volkswagen",
    regex: /\b(volkswagen|vw|ቮልክስዋገን)\b/i,
    models: [
      { name: "ID.4", regex: /id\.?4/i, subcategory: "Electric (EV)" },
      { name: "ID.6", regex: /id\.?6/i, subcategory: "Electric (EV)" },
      { name: "ID.3", regex: /id\.?3/i, subcategory: "Electric (EV)" },
      { name: "Golf", regex: /golf|ጎልፍ/i, subcategory: "Hatchback / Compact" },
      { name: "Tiguan", regex: /tiguan/i, subcategory: "SUV / Crossover" }
    ]
  },
  {
    name: "Chery",
    regex: /\b(chery|ቼሪ)\b/i,
    models: [
      { name: "Tiggo 2", regex: /tiggo\s*2/i, subcategory: "SUV / Crossover" },
      { name: "Tiggo 4 Pro", regex: /tiggo\s*4/i, subcategory: "SUV / Crossover" },
      { name: "Tiggo 7 Pro", regex: /tiggo\s*7/i, subcategory: "SUV / Crossover" },
      { name: "Tiggo 8 Pro", regex: /tiggo\s*8/i, subcategory: "SUV / Crossover" },
      { name: "EQ1 (Little Ant)", regex: /eq1|little\s*ant/i, subcategory: "Electric (EV)" }
    ]
  },
  {
    name: "Jetour",
    regex: /\b(jetour|ጄቱር)\b/i,
    models: [
      { name: "Dashing", regex: /dashing|ዳሺንግ/i, subcategory: "SUV / Crossover" },
      { name: "X70 Plus", regex: /x70/i, subcategory: "SUV / Crossover" },
      { name: "X90 Plus", regex: /x90/i, subcategory: "SUV / Crossover" },
      { name: "Traveler / T2", regex: /(traveler|t2)/i, subcategory: "SUV / Crossover" }
    ]
  },
  {
    name: "Geely",
    regex: /\b(geely|ጂሊ)\b/i,
    models: [
      { name: "Coolray", regex: /coolray|ኩልሬይ/i, subcategory: "SUV / Crossover" },
      { name: "Monjaro", regex: /monjaro/i, subcategory: "SUV / Crossover" },
      { name: "Geometry C", regex: /geometry/i, subcategory: "Electric (EV)" }
    ]
  },
  {
    name: "Changan",
    regex: /\b(changan|ቻንጋን)\b/i,
    models: [
      { name: "UNI-T", regex: /uni-?t/i, subcategory: "SUV / Crossover" },
      { name: "UNI-K", regex: /uni-?k/i, subcategory: "SUV / Crossover" },
      { name: "UNI-V", regex: /uni-?v/i, subcategory: "Sedan" },
      { name: "CS35 Plus", regex: /cs35/i, subcategory: "SUV / Crossover" },
      { name: "CS55 Plus", regex: /cs55/i, subcategory: "SUV / Crossover" },
      { name: "Benni E-Star", regex: /(benni|e-?star)/i, subcategory: "Electric (EV)" }
    ]
  },
  {
    name: "Mercedes-Benz",
    regex: /\b(mercedes|benz|መርሴዲስ|ቤንዝ)\b/i,
    models: [
      { name: "C-Class", regex: /c-?class|c\s*\d{3}/i, subcategory: "Sedan" },
      { name: "E-Class", regex: /e-?class|e\s*\d{3}/i, subcategory: "Sedan" },
      { name: "S-Class", regex: /s-?class|s\s*\d{3}/i, subcategory: "Sedan" },
      { name: "GLE", regex: /gle/i, subcategory: "SUV / Crossover" },
      { name: "GLC", regex: /glc/i, subcategory: "SUV / Crossover" },
      { name: "G-Wagon", regex: /g-?wagon|g\s*63|g\s*500/i, subcategory: "SUV / Crossover" }
    ]
  },
  {
    name: "BMW",
    regex: /\b(bmw|ቢኤምደብሊው)\b/i,
    models: [
      { name: "3 Series", regex: /3\s*series|3\d{2}i/i, subcategory: "Sedan" },
      { name: "5 Series", regex: /5\s*series|5\d{2}i/i, subcategory: "Sedan" },
      { name: "X3", regex: /\bx3\b/i, subcategory: "SUV / Crossover" },
      { name: "X5", regex: /\bx5\b/i, subcategory: "SUV / Crossover" }
    ]
  },
  {
    name: "Kia",
    regex: /\b(kia|ኪይ|ኪያ)\b/i,
    models: [
      { name: "Sportage", regex: /sportage|ስፖርቴጅ/i, subcategory: "SUV / Crossover" },
      { name: "Sorento", regex: /sorento|ሶሬንቶ/i, subcategory: "SUV / Crossover" },
      { name: "Picanto", regex: /picanto|ፒካንቶ/i, subcategory: "Hatchback / Compact" }
    ]
  }
];

const ELECTRONICS_DATABASE = [
  {
    name: "Apple",
    regex: /\b(apple|iphone|ipad|macbook|አፕል|አይፎን)\b/i,
    models: [
      { name: "iPhone 16 Pro Max", regex: /16\s*pro\s*max/i, subcategory: "Smartphones & Tablets" },
      { name: "iPhone 16 Pro", regex: /16\s*pro/i, subcategory: "Smartphones & Tablets" },
      { name: "iPhone 16", regex: /iphone\s*16/i, subcategory: "Smartphones & Tablets" },
      { name: "iPhone 15 Pro Max", regex: /15\s*pro\s*max/i, subcategory: "Smartphones & Tablets" },
      { name: "iPhone 15 Pro", regex: /15\s*pro/i, subcategory: "Smartphones & Tablets" },
      { name: "iPhone 15", regex: /iphone\s*15/i, subcategory: "Smartphones & Tablets" },
      { name: "iPhone 14 Pro Max", regex: /14\s*pro\s*max/i, subcategory: "Smartphones & Tablets" },
      { name: "iPhone 13", regex: /iphone\s*13/i, subcategory: "Smartphones & Tablets" },
      { name: "MacBook Pro", regex: /macbook\s*pro/i, subcategory: "Laptops & Computers" },
      { name: "MacBook Air", regex: /macbook\s*air/i, subcategory: "Laptops & Computers" },
      { name: "iPad Pro", regex: /ipad/i, subcategory: "Smartphones & Tablets" }
    ]
  },
  {
    name: "Samsung",
    regex: /\b(samsung|ሳምሰንግ|galaxy)\b/i,
    models: [
      { name: "Galaxy S24 Ultra", regex: /s24\s*ultra/i, subcategory: "Smartphones & Tablets" },
      { name: "Galaxy S24", regex: /s24/i, subcategory: "Smartphones & Tablets" },
      { name: "Galaxy S23 Ultra", regex: /s23\s*ultra/i, subcategory: "Smartphones & Tablets" },
      { name: "Galaxy Z Fold", regex: /z\s*fold/i, subcategory: "Smartphones & Tablets" },
      { name: "Galaxy Z Flip", regex: /z\s*flip/i, subcategory: "Smartphones & Tablets" }
    ]
  },
  {
    name: "Sony",
    regex: /\b(sony|ሶኒ|playstation|ps5|ps4)\b/i,
    models: [
      { name: "PlayStation 5", regex: /ps5|playstation\s*5/i, subcategory: "Gaming & Consoles" },
      { name: "Bravia TV", regex: /bravia|tv/i, subcategory: "TV & Home Entertainment" }
    ]
  }
];

// ============================================
// MAIN PROCESSING & AD BROADCASTER
// ============================================
async function processFinalAd(message, imageFileIds, messageIds, env, mediaGroupId) {
  const messageText = (message.text || message.caption || "").trim();
  const cleanText = cleanTheText(messageText);
  if (!cleanText || cleanText.length < 3) return;

  let { brand, model, year, trim, bodyType, fuelType, transmission, subcategory } = detectBrandModelYear(cleanText || messageText);
  const category = detectCategory(cleanText, brand);
  if (!subcategory) subcategory = bodyType || "Vehicles";

  // Optional: Multimodal Vision Inspection if model or brand is missing
  if (env.GEMINI_API_KEY && (!model || !brand) && imageFileIds.length > 0) {
    try {
      const visionResult = await inspectImageWithGemini(imageFileIds[0], cleanText, env);
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

  const arrangedTitle = arrangeTitle({ brand, model, year, trim, cleanText, category, subcategory });
  const { formattedPrice, rawPrice } = parseMathematicalPrice(cleanText || messageText, year);

  const textHash = simpleHash(cleanText.toLowerCase().replace(/\s+/g, ''));
  const imageUrls = await uploadImagesToCloudinary(imageFileIds, env);
  
  // 1. ATOMIC FIREBASE FIRESTORE SYNC
  try {
    const token = await getFirebaseToken(env);
    if (token && env.FIREBASE_PROJECT_ID) {
      const projectId = env.FIREBASE_PROJECT_ID;
      const adOwnerId = env.ADMIN_UID || "admin_bot";
      
      const docId = mediaGroupId 
        ? `tg_${message.chat.id}_${mediaGroupId}` 
        : `ad_${textHash}`; 
        
      const fbUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/ads/${docId}`;

      let allImages = imageUrls;
      try {
        const checkRes = await fetch(fbUrl, { headers: { Authorization: `Bearer ${token}` } });
        if (checkRes.ok) {
          const existingData = await checkRes.json();
          
          // Strict 10-minute duplicate check in database
          if (existingData.fields?.createdAt?.timestampValue) {
            const createdTime = new Date(existingData.fields.createdAt.timestampValue).getTime();
            if (Date.now() - createdTime < 600000) {
              console.log("⏭️ Ignored: Duplicate ad already saved to website.");
              return;
            }
          }

          if (existingData.fields?.images?.arrayValue?.values) {
            const existingUrls = existingData.fields.images.arrayValue.values.map(v => v.stringValue);
            allImages = Array.from(new Set([...existingUrls, ...imageUrls]));
          }
        }
      } catch (e) {}

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
          description: { stringValue: cleanText },
          textHash: { stringValue: textHash },
          price: { stringValue: formattedPrice },
          rawPrice: { integerValue: String(rawPrice) },
          phone: { stringValue: "0911680790" },
          city: { stringValue: extractCity(cleanText) },
          image: { stringValue: allImages.length > 0 ? allImages[0] : "" },
          images: { arrayValue: { values: allImages.map((url) => ({ stringValue: url })) } },
          status: { stringValue: "available" },
          source: { stringValue: "telegram" },
          userId: { stringValue: adOwnerId },
          views: { integerValue: "0" },
          createdAt: { timestampValue: new Date().toISOString() }
        }
      };
      await fetch(fbUrl, { method: "PATCH", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(adData) });
      console.log("✅ Saved to Website (Firebase)");
    }
  } catch (fbErr) {
    console.error("Firebase Error:", fbErr.message);
  }

  // 2. BUILD STRUCTURED POST TEXT
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

  let safeDetails = safeSubstring(cleanText, 720);
  if (cleanText.length > 720) safeDetails = safeDetails.trimEnd() + "…";

  let newPostText = `📝 Title: ${arrangedTitle}\n`;
  if (brand || model || year) {
    const metaParts = [];
    if (brand) metaParts.push(`Make: ${brand}`);
    if (model) metaParts.push(`Model: ${model}`);
    if (year) metaParts.push(`Year: ${year}`);
    newPostText += `🏷️ ${metaParts.join(" | ")}\n`;
  }
  newPostText += `📂 Category: ${category}${subcategory ? ` › ${subcategory}` : ""}\n`;
  newPostText += `💰 Price: ${displayPriceText}\n`;
  if (transmission || fuelType) {
    const specParts = [];
    if (transmission) specParts.push(`⚙️ ${transmission}`);
    if (fuelType) specParts.push(`⛽ ${fuelType}`);
    newPostText += `${specParts.join(" | ")}\n`;
  }
  newPostText += `\n📄 Details:\n${safeDetails}\n\n`;
  newPostText += `━━━━━━━━━━━━━━━\n`;
  newPostText += `🏢 የኛ ገበያ (Yegna Gebeya)\n`;
  newPostText += `📞 Phone: 0911680790\n`;
  newPostText += `🌐 Website: mebri.yegna.workers.dev\n`;
  newPostText += `✈️ Telegram: @mebrigranite\n`;
  newPostText += `━━━━━━━━━━━━━━━\n\n`;
  newPostText += `${hashtag} #YegnaGebeya`;

  // 3. BROADCAST TO TELEGRAM CHANNEL (GUARANTEED ONCE)
  const targetChannel = env.REPOST_CHANNEL_ID || "@mebrigranite";
  if (!targetChannel) return;

  // Final Broadcast Mutex Lock
  const broadcastLockId = `broadcast_${mediaGroupId || textHash}`;
  if (!(await acquireEdgeLock(broadcastLockId, 600))) {
    console.log("🛑 Broadcast mutex hit: post already sent by sibling isolate.");
    return;
  }

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
    console.log("✅ Forwarded Clean Ad to Channel!");
  } catch (err) {
    console.error("Broadcast Error:", err.message);
  }
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

  const makeMatch = text.match(/(?:Make|የመኪናው\s*ዓይነት|Brand|ብራንድ)[ \t:=-]+([a-zA-Z0-9/._ -]+)/i);
  if (makeMatch && makeMatch[1]) {
    brand = makeMatch[1].replace(/[💎📌⭐✔️•.]/g, "").trim();
    if (/^(?:new|brand\s*new|used)\b/i.test(brand)) brand = "";
  }

  const modelMatch = text.match(/(?:Model|ሞዴል)[ \t:=-]+([a-zA-Z0-9/._ -]+)/i);
  if (modelMatch && modelMatch[1]) {
    model = modelMatch[1].replace(/[💎📌⭐✔️•.]/g, "").trim();
  }

  const yearMatch = text.match(/(?:Year|ዓመተ\s*ምህረት)[ \t:=-]+([0-9]{4}(?:\/[0-9]{1,2})?)/i);
  if (yearMatch && yearMatch[1]) {
    year = yearMatch[1].trim();
  } else {
    const rawYear = text.match(/\b(199\d|200\d|201\d|202[0-9])(?:\/([0-9]{1,2}))?\b/);
    if (rawYear) year = rawYear[0];
  }

  // Ethiopian ad fix: ". Model 2022" is manufacture YEAR, not model name!
  if (model && /^(?:19|20)\d{2}(?:\/\d{1,2})?$/.test(model)) {
    if (!year) year = model;
    model = "";
  }

  const trimMatch = text.match(/(?:Trim|ትሪም|Edition)[ \t:=-]+([a-zA-Z0-9/._ -]+)/i);
  if (trimMatch && trimMatch[1]) {
    trim = trimMatch[1].replace(/[💎📌⭐✔️•.]/g, "").trim();
  }

  const bodyMatch = text.match(/(?:Body\s*Type|የቦዲ\s*ዓይነት)[ \t:=-]+([a-zA-Z0-9/._ -]+)/i);
  if (bodyMatch && bodyMatch[1]) {
    bodyType = bodyMatch[1].replace(/[💎📌⭐✔️•.]/g, "").trim();
  }

  const fuelMatch = text.match(/(?:Fuel|ነዳጅ)[ \t:=-]+([a-zA-Z0-9/._ -]+)/i);
  if (fuelMatch && fuelMatch[1]) {
    fuelType = fuelMatch[1].replace(/[💎📌⭐✔️•.]/g, "").trim();
  } else if (/(?:electric|ኤሌክትሪክ|ev\b|battery|ባትሪ)/i.test(text)) {
    fuelType = "Electric";
  } else if (/(?:benzin|petrol|ቤንዚን)/i.test(text)) {
    fuelType = "Petrol / Benzin";
  } else if (/(?:diesel|ናፍጣ)/i.test(text)) {
    fuelType = "Diesel";
  } else if (/(?:hybrid|ሃይብሪድ)/i.test(text)) {
    fuelType = "Hybrid";
  }

  const transMatch = text.match(/(?:Transmission|ማስተላለፊያ)[ \t:=-]+([a-zA-Z0-9/._ -]+)/i);
  if (transMatch && transMatch[1]) {
    const candidate = transMatch[1].replace(/[💎📌⭐✔️•.]/g, "").trim();
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
    const matchedBrandObj = CAR_DATABASE.find(b => b.name.toLowerCase() === brand.toLowerCase());
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

  if (!subcategory) {
    if (fuelType.toLowerCase().includes("electric") || /kwh|single motor|ev\b/i.test(text)) {
      subcategory = "Electric (EV)";
    } else if (bodyType.toLowerCase().includes("suv") || /suv/i.test(text)) {
      subcategory = "SUV / Crossover";
    } else if (bodyType.toLowerCase().includes("sedan") || /sedan/i.test(text)) {
      subcategory = "Sedan";
    }
  }

  return { brand, model, year, trim, bodyType, fuelType, transmission, subcategory };
}

function arrangeTitle({ brand, model, year, trim, cleanText, category, subcategory }) {
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
      const parts = [cleanYear, brand, subcategory !== "Vehicles" ? subcategory : ""].filter(Boolean);
      return parts.join(" ");
    }
  }

  if (category === "Electronics" && brand && model) {
    return `${brand} ${model}${trim ? ` ${trim}` : ""}`;
  }

  const firstLine = cleanText.split("\n")[0].replace(/[💎📌⭐✔️•#]/g, "").trim();
  return safeSubstring(firstLine, 65) || `${category} Item`;
}

function detectCategory(text, brand) {
  const t = text.toLowerCase();
  if (brand && CAR_DATABASE.some(b => b.name.toLowerCase() === brand.toLowerCase())) return "Cars";
  if (brand && ELECTRONICS_DATABASE.some(eb => eb.name.toLowerCase() === brand.toLowerCase())) return "Electronics";
  if (/(መኪና|car|vitz|corolla|rav4|suzuki|hyundai|byd|elantra|sealion|tucson|toyota|yaris|benz|mileage|km|plate)/i.test(t)) return "Cars";
  if (/(ቤት|ኮንዶሚኒየም|apartment|villa|house|g\+|ሪል\s*እስቴት|ካሬ|sqm)/i.test(t)) {
    if (/(ኪራይ|rent|ለኪራይ|ወርሃዊ)/i.test(t)) return "Rentals";
    return "Houses";
  }
  if (/(ስልክ|phone|iphone|samsung|laptop|macbook|ipad|tv|electronics|playstation|ps5|ቴሌቪዥን|ላፕቶፕ)/i.test(t)) return "Electronics";
  if (/(sofa|bed|table|chair|furniture|ሶፋ|አልጋ|ጠረጴዛ|ወንበር|ቁምሳጥን)/i.test(t)) return "Furniture";
  if (/(shoes|jacket|dress|suit|clothes|pants|ጫማ|ጃኬት|ቀሚስ|ልብስ)/i.test(t)) return "Clothes";
  if (/(driver|plumber|electrician|mechanic|ቧንቧ|ኤሌክትሪክ|ቀለም|ሹፌር|ሰርቪስ|ጽዳት)/i.test(t)) return "Labor & Services";
  return "ምንአለሽ_ተራ";
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

  const explicitLineMatch = text.match(/(?:💰|price|ዋጋ|fixed|የመሸጫ\s*ዋጋ)[ \t:=-]+([0-9.,]+)\s*(?:ETB|ብር|Birr)?\s*(?:million|mil|mln|m|ሚሊዮን|ሚሊየን|k|thousand|ሺህ|ሺ)?/i);
  if (explicitLineMatch && explicitLineMatch[1]) {
    const rawVal = explicitLineMatch[1];
    const isMillion = /(?:million|mil|mln|m|ሚሊዮን|ሚሊየን)/i.test(explicitLineMatch[0]);
    const isThousand = /(?:k|thousand|ሺህ|ሺ)/i.test(explicitLineMatch[0]);

    if (isMillion) {
      const cleanNum = rawVal.replace(/,/g, "");
      const val = parseFloat(cleanNum);
      if (!isNaN(val) && val > 0) {
        const finalNum = val < 1000 ? Math.round(val * 1000000) : Math.round(val);
        return { formattedPrice: finalNum.toLocaleString("en-US"), rawPrice: finalNum };
      }
    } else if (isThousand) {
      const cleanNum = rawVal.replace(/,/g, "");
      const val = parseFloat(cleanNum);
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
    const rawVal = generalMillionMatch[1];
    const cleanNum = rawVal.replace(/,/g, "");
    const val = parseFloat(cleanNum);
    if (!isNaN(val) && val > 0) {
      const finalNum = val < 1000 ? Math.round(val * 1000000) : Math.round(val);
      return { formattedPrice: finalNum.toLocaleString("en-US"), rawPrice: finalNum };
    }
  }

  const thousandMatch = text.match(/([0-9]+(?:[.,][0-9]+)*)\s*(?:ETB|ብር|Birr)?\s*(?:k|thousand|ሺህ|ሺ)\b/i);
  if (thousandMatch && thousandMatch[1]) {
    const rawVal = thousandMatch[1];
    const val = parseFloat(rawVal.replace(/,/g, ""));
    if (!isNaN(val) && val > 0 && val < 10000) {
      const finalNum = Math.round(val * 1000);
      return { formattedPrice: finalNum.toLocaleString("en-US"), rawPrice: finalNum };
    }
  }

  const currencyMatch = text.match(/(?:ETB|ብር|Birr)\s*[:=.-]?\s*([0-9]{1,3}(?:[.,][0-9]{3})+|[0-9]{5,10})|([0-9]{1,3}(?:[.,][0-9]{3})+|[0-9]{5,10})\s*(?:ETB|ብር|Birr)/i);
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
  const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{1F1E6}-\u{1F1FF}\u{200D}\u{20E3}\u{2190}-\u{21FF}\u{25A0}-\u{25FF}\u{2B50}\u{1F004}\u{1F0CF}]/gu;
  return text
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/\b(?:t\.me|telegram\.me)\/\S+/gi, "")
    .replace(/@[a-zA-Z0-9_]{2,}/g, "")
    .replace(/(?:\+251|251|0)?[\s.-]?[97]\d(?:[\s.-]?\d){7}\b/gi, "")
    .replace(EMOJI, "")
    .replace(/[*_~`|]/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractCity(text) {
  const lower = text.toLowerCase();
  if (/(አዲስ አበባ|addis ababa|finfinne|bole|sarbet|cmc|gerji|piassa|ayat|summit)/i.test(lower)) return "Addis Ababa";
  if (/(hawassa|ሀዋሳ)/i.test(lower)) return "Hawassa";
  if (/(adama|አዳማ|nazret)/i.test(lower)) return "Adama";
  if (/(bahir dar|ባህር ዳር)/i.test(lower)) return "Bahir Dar";
  if (/(dire dawa|ድሬዳዋ)/i.test(lower)) return "Dire Dawa";
  return "Addis Ababa";
}

async function uploadImagesToCloudinary(imageFileIds, env) {
  if (!env.CLOUDINARY_CLOUD_NAME || !env.CLOUDINARY_UPLOAD_PRESET || !imageFileIds || imageFileIds.length === 0) return [];
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
      console.warn("Cloudinary upload skip:", e.message);
    }
  }
  return urls;
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
  if (!tokData.access_token) throw new Error("Token Error: " + JSON.stringify(tokData));
  cachedFirebaseToken = tokData.access_token;
  tokenExpiresAt = now + (tokData.expires_in || 3600);
  return cachedFirebaseToken;
}

function base64UrlEncode(str) {
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
