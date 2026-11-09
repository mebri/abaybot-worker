/**
 * Yegna Gebeya Telegram Bot - Cloudflare Worker
 * 
 * Production Anti-Double-Post Architecture (v4.0 Bulletproof):
 * 1. Multi-tier Deduplication Lock (Update ID + Chat/Message ID + MediaGroup ID + Text Hash)
 * 2. Three-Layer Distributed Locking:
 *    - Layer A: In-Memory Mutex & LRU Locks per isolate
 *    - Layer B: Cloudflare Edge Cache API (`caches.default`) with worker's actual request hostname
 *    - Layer C: Firestore Global Atomic Precondition Lock (`POST ...?documentId=...` -> 409 Conflict rejection)
 * 3. Absolute Channel & Discussion Reflection Filter:
 *    - Automatically drops ANY `update.channel_post` or `edited_channel_post` (channels are broadcast-only)
 *    - Drops ANY message where `chat.type === "channel"`
 *    - Drops ANY message where `sender_chat.type === "channel"`
 *    - Drops ANY message where `is_automatic_forward` is true (linked discussion groups)
 *    - Drops system bots (GroupAnonymousBot `1087968824`, Telegram `777000`, bot itself)
 * 4. Safe Caption Layout: Truncates description in the middle so the watermark footer is NEVER chopped off!
 * 5. Album Aggregator: Coordinates multi-photo albums so only one atomic broadcast occurs.
 * 6. Mathematical Amharic Price Parser: ሚሊዮን (1,000,000), ሺህ (1,000), protects manufacture years.
 * 7. AI Title Arranger: [Year] [Brand] [Model] [Trim] (e.g. "2025 BYD Sealion 06 EV").
 * 8. Cloudinary Image Upload + Firestore Sync.
 */

// In-Memory Caches (Per-Isolate Fast Path)
const albumCache = new Map();
const processedLocks = new Map();
const updateIdLocks = new Set();
let cachedFirebaseToken = null;
let tokenExpiresAt = 0;

export default {
  async fetch(request, env, ctx) {
    // Health check endpoint
    if (request.method !== "POST") {
      return new Response("Yegna Gebeya Bot is running ✅ (Anti-Duplicate v4.0 Active)", { 
        status: 200,
        headers: { "Content-Type": "text/plain; charset=utf-8" }
      });
    }

    try {
      const update = await request.json();
      
      // Fast ACK to Telegram: Return 200 OK immediately so Telegram never retries the webhook!
      ctx.waitUntil(processUpdateSafe(update, env, request));
      return new Response("OK", { status: 200 });
    } catch (error) {
      console.error("Webhook parse error:", error.message);
      return new Response("OK", { status: 200 }); // Always 200 to prevent retry storms
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
      console.log(`⏭️ Ignored: Duplicate update_id ${update.update_id}`);
      return;
    }
    updateIdLocks.add(update.update_id);
    if (updateIdLocks.size > 3000) {
      const firstKey = updateIdLocks.values().next().value;
      updateIdLocks.delete(firstKey);
    }
  }

  // 2. ABSOLUTE CHANNEL SHIELD: NEVER PROCESS CHANNEL POSTS!
  // Channels (@mebrigranite) are exclusively for broadcasting ads, NOT for user ad submissions!
  // Ignoring channel_post eliminates the #1 cause of infinite loop duplicate posts.
  if (update.channel_post || update.edited_channel_post) {
    return;
  }

  // 3. IGNORE EDITED MESSAGES (Prevents duplicate re-posts when seller fixes typos)
  if (update.edited_message) {
    return;
  }

  const message = update.message;
  if (!message) return;

  // 4. IGNORE IF CHAT IS A CHANNEL
  if (message.chat && message.chat.type === "channel") {
    return;
  }

  // 5. IGNORE AUTOMATIC FORWARDS (Linked discussion groups connected to @mebrigranite)
  if (message.is_automatic_forward) {
    return;
  }

  // 6. IGNORE BOTS & SYSTEM ACCOUNTS
  // 1087968824 = GroupAnonymousBot, 777000 = Telegram Notifications
  const botId = env.TELEGRAM_BOT_TOKEN ? env.TELEGRAM_BOT_TOKEN.split(":")[0] : "";
  if (message.from) {
    const fromIdStr = String(message.from.id);
    if (fromIdStr === botId || message.from.is_bot || fromIdStr === "1087968824" || fromIdStr === "777000") {
      return;
    }
  }

  // 7. IGNORE SENDER_CHAT IF IT IS A CHANNEL (e.g. channel posting into a group)
  if (message.sender_chat) {
    if (message.sender_chat.type === "channel") return;
    const senderUser = (message.sender_chat.username || "").toLowerCase();
    const senderIdStr = String(message.sender_chat.id);
    const targetChannelRaw = env.REPOST_CHANNEL_ID || "@mebrigranite";
    const targetClean = targetChannelRaw.replace("@", "").toLowerCase();
    if (senderUser === targetClean || senderIdStr === targetClean || senderIdStr.includes("mebrigranite")) {
      return;
    }
  }

  // 8. IGNORE FORWARDED FROM TARGET CHANNEL
  if (message.forward_from_chat) {
    const fwdUser = (message.forward_from_chat.username || "").toLowerCase();
    const fwdIdStr = String(message.forward_from_chat.id);
    const targetChannelRaw = env.REPOST_CHANNEL_ID || "@mebrigranite";
    const targetClean = targetChannelRaw.replace("@", "").toLowerCase();
    if (fwdUser === targetClean || fwdIdStr === targetClean) {
      return;
    }
  }

  // 9. IGNORE TARGET CHANNEL IN CHAT USERNAME OR ID
  const targetChannelRaw = env.REPOST_CHANNEL_ID || "@mebrigranite";
  const targetClean = targetChannelRaw.replace("@", "").toLowerCase();
  const chatIdStr = String(message.chat.id);
  const chatUser = (message.chat.username || "").toLowerCase();
  if (chatUser === targetClean || chatIdStr === targetClean) {
    return;
  }

  const rawText = (message.text || message.caption || "").trim();

  // 10. STRICT BOT WATERMARK DETECTION
  if (hasBotWatermark(rawText)) {
    console.log("⏭️ Ignored: Bot watermark signature detected.");
    return;
  }

  // ============================================
  // ALBUM (MEDIA GROUP) MULTI-PHOTO HANDLING
  // ============================================
  if (message.media_group_id) {
    const groupId = String(message.media_group_id);
    const albumLockKey = `album_${message.chat.id}_${groupId}`;

    // Fast check: If this album already finished and was broadcast, drop it immediately!
    if (await isEdgeLocked(albumLockKey, request.url)) {
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
      if (!finalData) return;

      const postMsg = finalData.captionMessage;
      if (!postMsg) {
        console.log(`⏭️ Dropping album ${groupId}: No text caption found on any photo.`);
        return;
      }

      const postText = (postMsg.text || postMsg.caption || "").trim();
      const cleanPostText = cleanTheText(postText);
      if (cleanPostText.length < 3) {
        console.log(`⏭️ Dropping album ${groupId}: Cleaned text is too short.`);
        return;
      }

      // DISTRIBUTED ATOMIC LOCK BEFORE BROADCAST
      const lockAcquired = await acquireGlobalBroadcastLock(albumLockKey, cleanPostText, env, request.url);
      if (!lockAcquired) {
        console.log(`🛑 Album ${groupId} duplicate broadcast blocked by distributed lock!`);
        return;
      }

      await processFinalAd(postMsg, finalData.images, finalData.messageIds, env, groupId, request.url);
    }

    cleanupStaleAlbums();
    return;
  }

  // ============================================
  // SINGLE POST HANDLING
  // ============================================
  const cleanCheck = cleanTheText(rawText);
  if (cleanCheck.length < 3) return;

  const msgLockKey = `msg_${message.chat.id}_${message.message_id}`;
  const textHash = simpleHash(cleanCheck.toLowerCase().replace(/\s+/g, ''));
  const contentLockKey = `content_${textHash}`;

  // Check message-level lock
  if (await isEdgeLocked(msgLockKey, request.url)) {
    console.log(`⏭️ Ignored: Message ${msgLockKey} already processed.`);
    return;
  }

  // Check content hash lock (prevents posting same ad from multiple groups or retries)
  if (await isEdgeLocked(contentLockKey, request.url)) {
    console.log(`⏭️ Ignored: Duplicate content hash ${textHash} already processed.`);
    return;
  }

  // DISTRIBUTED ATOMIC LOCK BEFORE BROADCAST
  const lockAcquired = await acquireGlobalBroadcastLock(msgLockKey, cleanCheck, env, request.url);
  if (!lockAcquired) {
    console.log(`🛑 Message ${msgLockKey} duplicate broadcast blocked by distributed lock!`);
    return;
  }

  const images = [];
  if (message.photo && message.photo.length > 0) {
    images.push(message.photo[message.photo.length - 1].file_id);
  }

  await processFinalAd(message, images, [message.message_id], env, null, request.url);
}

// ============================================
// THREE-TIER DISTRIBUTED LOCKS (EDGE CACHE + MEMORY + FIRESTORE)
// Works across all Cloudflare isolates & instances globally
// ============================================
async function acquireGlobalBroadcastLock(lockKey, contentText, env, requestUrl) {
  const ttlSeconds = 600; // 10 minute lock

  // 1. In-memory per-isolate check
  const now = Date.now();
  if (processedLocks.has(lockKey)) {
    const exp = processedLocks.get(lockKey);
    if (now < exp) return false;
    processedLocks.delete(lockKey);
  }
  processedLocks.set(lockKey, now + (ttlSeconds * 1000));

  // 2. Cloudflare Cache API with Worker's actual request hostname
  if (typeof caches !== "undefined" && caches.default && requestUrl) {
    try {
      const cache = caches.default;
      const parsed = new URL(requestUrl);
      const cacheEndpoint = `https://${parsed.hostname}/__bot_lock__/${encodeURIComponent(lockKey)}`;
      const cacheReq = new Request(cacheEndpoint, { method: "GET" });
      const hit = await cache.match(cacheReq);
      if (hit) {
        return false; // Another isolate in this datacenter already acquired the lock!
      }

      const cacheRes = new Response("1", {
        status: 200,
        headers: {
          "Content-Type": "text/plain",
          "Cache-Control": `public, max-age=${ttlSeconds}, s-maxage=${ttlSeconds}`
        }
      });
      await cache.put(cacheReq, cacheRes);
    } catch (cacheErr) {
      console.warn("Cloudflare Cache lock warning:", cacheErr.message);
    }
  }

  // 3. Firestore Global Atomic Lock (Strict ACID Consensus)
  try {
    const token = await getFirebaseToken(env);
    if (token && env.FIREBASE_PROJECT_ID) {
      const fbLockUrl = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/bot_broadcast_locks?documentId=${encodeURIComponent(lockKey)}`;
      const fbRes = await fetch(fbLockUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          fields: {
            lockedAt: { timestampValue: new Date().toISOString() },
            lockKey: { stringValue: lockKey }
          }
        })
      });

      if (fbRes.status === 409) {
        console.log(`🛑 Firestore atomic 409 conflict: broadcast lock ${lockKey} already held.`);
        return false;
      }
    }
  } catch (fbLockErr) {
    console.warn("Firestore lock check warning:", fbLockErr.message);
  }

  return true;
}

async function isEdgeLocked(lockKey, requestUrl) {
  const now = Date.now();
  if (processedLocks.has(lockKey)) {
    if (now < processedLocks.get(lockKey)) return true;
    processedLocks.delete(lockKey);
  }

  if (typeof caches !== "undefined" && caches.default && requestUrl) {
    try {
      const cache = caches.default;
      const parsed = new URL(requestUrl);
      const cacheEndpoint = `https://${parsed.hostname}/__bot_lock__/${encodeURIComponent(lockKey)}`;
      const cacheReq = new Request(cacheEndpoint, { method: "GET" });
      const hit = await cache.match(cacheReq);
      if (hit) return true;
    } catch (e) {}
  }

  return false;
}

function hasBotWatermark(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  // ✅ FIXED: Removed "yegna gebeya" and "የኛ ገበያ" so real users don't get blocked
  if (
    lower.includes("mebri.yegna.workers.dev") ||
    lower.includes("@mebrigranite") ||
    lower.includes("0911680790") ||
    lower.includes("#yegnagebeya") ||
    lower.includes("📝 title:") ||
    lower.includes("💰 price:") ||
    lower.includes("📂 category:") ||
    lower.includes("website: mebri") ||
    lower.includes("✈️ telegram: @mebrigranite") ||
    /#(cars|houses|rentals|electronics|furniture|clothes|labor|ምንአለሽ_ተራ|other)\b/i.test(text)
  ) {
    return true;
  }
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
      { name: "Staria", regex: /staria|ስታሪያ/i, subcategory: "Van / Minibus" }
    ]
  },
  {
    name: "Volkswagen",
    regex: /\b(volkswagen|vw|ፎልክስዋገን|ቮልስዋገን)\b/i,
    models: [
      { name: "ID.4 Crozz", regex: /id\.?4/i, subcategory: "Electric (EV)" },
      { name: "ID.6 Crozz", regex: /id\.?6/i, subcategory: "Electric (EV)" },
      { name: "Tiguan", regex: /tiguan/i, subcategory: "SUV / Crossover" },
      { name: "Golf", regex: /\bgolf\b/i, subcategory: "Hatchback / Compact" }
    ]
  },
  {
    name: "Geely",
    regex: /\b(geely|ጂሊ)\b/i,
    models: [
      { name: "Coolray", regex: /coolray/i, subcategory: "SUV / Crossover" },
      { name: "Geometry C", regex: /geometry\s*c/i, subcategory: "Electric (EV)" },
      { name: "Monjaro", regex: /monjaro/i, subcategory: "SUV / Crossover" }
    ]
  },
  {
    name: "Changan",
    regex: /\b(changan|ቻንጋን)\b/i,
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
    regex: /\b(jetour|ጄቱር)\b/i,
    models: [
      { name: "Dashing", regex: /dashing/i, subcategory: "SUV / Crossover" },
      { name: "X70 Plus", regex: /x70/i, subcategory: "SUV / Crossover" },
      { name: "Traveler (T2)", regex: /(traveler|t2)/i, subcategory: "SUV / Crossover" }
    ]
  },
  {
    name: "Kia",
    regex: /\b(kia|ኪያ)\b/i,
    models: [
      { name: "Sportage", regex: /sportage|ስፖርቴጅ/i, subcategory: "SUV / Crossover" },
      { name: "Sorento", regex: /sorento|ሶሬንቶ/i, subcategory: "SUV / Crossover" },
      { name: "Picanto", regex: /picanto|ፒካንቶ/i, subcategory: "Hatchback / Compact" },
      { name: "EV6", regex: /ev6/i, subcategory: "Electric (EV)" }
    ]
  },
  {
    name: "Mercedes-Benz",
    regex: /\b(mercedes|benz|መርሴዲስ|ቤንዝ)\b/i,
    models: [
      { name: "C-Class", regex: /c-?class|c200|c180|c300/i, subcategory: "Sedan" },
      { name: "E-Class", regex: /e-?class|e200|e300|e350/i, subcategory: "Sedan" },
      { name: "G-Wagon / G-Class", regex: /g-?wagon|g63|g500/i, subcategory: "SUV / Crossover" },
      { name: "GLE", regex: /gle/i, subcategory: "SUV / Crossover" }
    ]
  },
  {
    name: "Nissan",
    regex: /\b(nissan|ኒሳን)\b/i,
    models: [
      { name: "Patrol", regex: /patrol|ፓትሮል/i, subcategory: "SUV / Crossover" },
      { name: "X-Trail", regex: /x-?trail/i, subcategory: "SUV / Crossover" },
      { name: "Qashqai", regex: /qashqai/i, subcategory: "SUV / Crossover" },
      { name: "Sunny", regex: /sunny/i, subcategory: "Sedan" }
    ]
  },
  {
    name: "Land Rover",
    regex: /\b(range\s*rover|land\s*rover|ሬንጅ\s*ሮቨር)\b/i,
    models: [
      { name: "Defender", regex: /defender|ዲፌንደር/i, subcategory: "SUV / Crossover" },
      { name: "Sport", regex: /range\s*rover\s*sport/i, subcategory: "SUV / Crossover" },
      { name: "Vogue", regex: /vogue/i, subcategory: "SUV / Crossover" },
      { name: "Evoque", regex: /evoque/i, subcategory: "SUV / Crossover" }
    ]
  },
  {
    name: "Chery",
    regex: /\b(chery|ቼሪ)\b/i,
    models: [
      { name: "Tiggo 7 Pro", regex: /tiggo\s*7/i, subcategory: "SUV / Crossover" },
      { name: "Tiggo 8 Pro", regex: /tiggo\s*8/i, subcategory: "SUV / Crossover" },
      { name: "EQ1 / Little Ant", regex: /eq1|little\s*ant/i, subcategory: "Electric (EV)" }
    ]
  },
  {
    name: "Zeekr",
    regex: /\b(zeekr|ዚከር)\b/i,
    models: [
      { name: "001", regex: /001/, subcategory: "Electric (EV)" },
      { name: "007", regex: /007/, subcategory: "Electric (EV)" },
      { name: "009", regex: /009/, subcategory: "Electric (EV)" },
      { name: "X", regex: /\bzeekr\s*x\b/i, subcategory: "Electric (EV)" }
    ]
  },
  {
    name: "Li Auto (Li Xiang)",
    regex: /\b(li\s*auto|lixiang|ሊ\s*አውቶ)\b/i,
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
    regex: /\b(apple|iphone|macbook|ipad|አፕል|አይፎን)\b/i,
    models: [
      { name: "iPhone 16 Pro Max", regex: /16\s*pro\s*max/i, subcategory: "Smartphones & Tablets" },
      { name: "iPhone 16 Pro", regex: /16\s*pro\b/i, subcategory: "Smartphones & Tablets" },
      { name: "iPhone 16", regex: /iphone\s*16/i, subcategory: "Smartphones & Tablets" },
      { name: "iPhone 15 Pro Max", regex: /15\s*pro\s*max/i, subcategory: "Smartphones & Tablets" },
      { name: "iPhone 15 Pro", regex: /15\s*pro\b/i, subcategory: "Smartphones & Tablets" },
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
async function processFinalAd(message, imageFileIds, messageIds, env, mediaGroupId, requestUrl) {
  const messageText = (message.text || message.caption || "").trim();
  const cleanText = cleanTheText(messageText);
  if (!cleanText || cleanText.length < 3) return;

  let { brand, model, year, trim, bodyType, fuelType, transmission, subcategory } = detectBrandModelYear(cleanText || messageText);
  const category = detectCategory(cleanText, brand);
  if (!subcategory) subcategory = bodyType || "Vehicles";

  // Optional: Multimodal Vision enrichment if model or brand is missing
  if (env.GEMINI_API_KEY && (!model || !brand) && imageFileIds.length > 0) {
    try {
