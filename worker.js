/**
 * Yegna Gebeya Telegram Bot & Search Engine - Cloudflare Worker
 */

// In-Memory Caches
const albumCache = new Map();
const processedLocks = new Map();
const updateIdLocks = new Set();
let cachedFirebaseToken = null;
let tokenExpiresAt = 0;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // ✅ SEARCH ENGINE API
    if (url.pathname === "/api/search" && request.method === "GET") {
      const query = url.searchParams.get("q") || "";
      if (!query) return new Response(JSON.stringify({ internal: [], external: [] }), { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });

      const internal = await searchFirebaseAds(query, env);
      const external = await searchExternalMarketplaces(query, env);

      return new Response(JSON.stringify({ internal, external }), {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }

    // EXISTING TELEGRAM BOT LOGIC
    if (request.method !== "POST") {
      return new Response("Yegna Gebeya Bot is running ✅", { 
        status: 200,
        headers: { "Content-Type": "text/plain; charset=utf-8" }
      });
    }

    try {
      const update = await request.json();
      ctx.waitUntil(processUpdateSafe(update, env, request));
      return new Response("OK", { status: 200 });
    } catch (error) {
      console.error("Webhook parse error:", error.message);
      return new Response("OK", { status: 200 });
    }
  }
};

// ==========================================
// SEARCH ENGINE HELPERS
// ==========================================
async function searchFirebaseAds(query, env) {
  try {
    const token = await getFirebaseToken(env);
    const fbUrl = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents:runQuery`;
    
    const res = await fetch(fbUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ structuredQuery: { from: [{ collectionId: "ads" }], limit: 50 } })
    });
    
    const data = await res.json();
    if (!Array.isArray(data)) return [];
    
    const ads = data.map(d => d.document).filter(Boolean).map(doc => {
      const f = doc.fields;
      return {
        id: doc.name.split('/').pop(),
        title: f.title?.stringValue || "",
        price: f.price?.stringValue || "0",
        city: f.city?.stringValue || "Ethiopia",
        image: f.image?.stringValue || "",
        source: "Yegna Gebeya"
      };
    });

    const lowerQ = query.toLowerCase();
    return ads.filter(a => a.title.toLowerCase().includes(lowerQ));
  } catch (e) { return []; }
}

async function searchExternalMarketplaces(query, env) {
  try {
    // 🔴 TO MAKE REAL: Replace this mock data with Apify API calls.
    return [
      {
        id: "jiji_" + Date.now(),
        title: `[Jiji] ${query} - Excellent Condition`,
        price: "4,500,000",
        city: "Addis Ababa",
        image: "https://images.unsplash.com/photo-1552519507-da3b142c6e3d?w=500&q=80",
        source: "Jiji Ethiopia",
        url: "https://jiji.com.et"
      },
      {
        id: "fb_" + Date.now(),
        title: `[Facebook] ${query} for sale`,
        price: "3,200,000",
        city: "Adama",
        image: "https://images.unsplash.com/photo-1549317661-bd32c8ce0db2?w=500&q=80",
        source: "Facebook",
        url: "https://facebook.com/marketplace"
      }
    ];
  } catch (e) { return []; }
}

// ==========================================
// YOUR EXISTING BOT LOGIC (UNTOUCHED)
// ==========================================
async function processUpdateSafe(update, env, request) {
  try {
    await processUpdate(update, env, request);
  } catch (err) {
    console.error("Unhandled processUpdate error:", err.message);
  }
}

async function processUpdate(update, env, request) {
  if (update.update_id) {
    if (updateIdLocks.has(update.update_id)) return;
    updateIdLocks.add(update.update_id);
    if (updateIdLocks.size > 4000) {
      updateIdLocks.delete(updateIdLocks.values().next().value);
    }
  }

  const message = update.channel_post || update.message;
  if (!message || update.edited_message || update.edited_channel_post || message.is_automatic_forward) return;

  const targetChannelRaw = env.REPOST_CHANNEL_ID || "@mebrigranite";
  const targetClean = targetChannelRaw.replace("@", "").toLowerCase();
  const chatUser = (message.chat?.username || "").toLowerCase();
  const chatIdStr = String(message.chat?.id || "");
  if (chatUser === targetClean || chatIdStr === targetClean) return;

  const botId = env.TELEGRAM_BOT_TOKEN ? env.TELEGRAM_BOT_TOKEN.split(":")[0] : "";
  if (message.from && (String(message.from.id) === botId || message.from.is_bot || ["1087968824", "777000"].includes(String(message.from.id)))) return;

  const rawText = (message.text || message.caption || "").trim();
  if (hasBotWatermark(rawText)) return;

  if (message.media_group_id) {
    const groupId = String(message.media_group_id);
    const albumBroadcastKey = `album_done_${groupId}`;

    if (completedLocks.has(albumBroadcastKey) || await isEdgeLocked(albumBroadcastKey, request.url)) return;

    if (!albumStore.has(groupId)) {
      albumStore.set(groupId, { images: [], caption: "", captionMsg: null, messageIds: [], timerStarted: false, timestamp: Date.now() });
    }

    const album = albumStore.get(groupId);
    if (message.photo && message.photo.length > 0) {
      const bestPhoto = message.photo[message.photo.length - 1].file_id;
      if (!album.images.includes(bestPhoto)) album.images.push(bestPhoto);
      album.messageIds.push(message.message_id);
    }

    if (rawText.length > 3 && !album.caption) {
      album.caption = rawText;
      album.captionMsg = message;
    }

    if (!album.timerStarted) {
      album.timerStarted = true;
      await new Promise((resolve) => setTimeout(resolve, 3500));

      if (completedLocks.has(albumBroadcastKey)) { albumStore.delete(groupId); return; }
      if (!(await claimEdgeLock(albumBroadcastKey, 600, request.url))) { albumStore.delete(groupId); return; }
      completedLocks.add(albumBroadcastKey);

      const finalAlbumData = albumStore.get(groupId) || album;
      albumStore.delete(groupId);
      
      const postMsg = finalAlbumData.captionMsg || message;
      const postText = finalAlbumData.caption || rawText;
      const cleanText = cleanTheText(postText);
      
      if (cleanText.length > 3) {
        await processFinalAd(postMsg, finalAlbumData.images, cleanText, env, groupId);
      }
    }
    cleanupOldStores();
    return;
  }

  const cleanText = cleanTheText(rawText);
  if (!cleanText || cleanText.length < 3) return;

  const textHash = simpleHash(cleanText.toLowerCase().replace(/\s+/g, ''));
  const singleAdLockKey = `single_${message.chat?.id || ""}_${textHash}`;

  if (completedLocks.has(singleAdLockKey) || await isEdgeLocked(singleAdLockKey, request.url)) return;
  if (!(await claimEdgeLock(singleAdLockKey, 600, request.url))) return;
  completedLocks.add(singleAdLockKey);

  const images = [];
  if (message.photo && message.photo.length > 0) images.push(message.photo[message.photo.length - 1].file_id);
  await processFinalAd(message, images, cleanText, env, null);
  cleanupOldStores();
}

// ==========================================
// LOCKS & UTILS
// ==========================================
async function claimEdgeLock(key, ttlSeconds = 600, requestUrl = null) {
  if (completedLocks.has(key)) return false;
  if (typeof caches !== "undefined" && caches.default && requestUrl) {
    try {
      const cache = caches.default;
      const parsed = new URL(requestUrl);
      const lockEndpoint = `https://${parsed.hostname}/__ad_lock__/${encodeURIComponent(key)}`;
      const lockReq = new Request(lockEndpoint, { method: "GET" });
      if (await cache.match(lockReq)) return false;
      const res = new Response("1", { status: 200, headers: { "Cache-Control": `public, max-age=${ttlSeconds}` } });
      await cache.put(lockReq, res);
      return true;
    } catch (e) {}
  }
  return true;
}

async function isEdgeLocked(key, requestUrl) {
  if (completedLocks.has(key)) return true;
  if (typeof caches !== "undefined" && caches.default && requestUrl) {
    try {
      const cache = caches.default;
      const parsed = new URL(requestUrl);
      const lockEndpoint = `https://${parsed.hostname}/__ad_lock__/${encodeURIComponent(key)}`;
      if (await cache.match(new Request(lockEndpoint, { method: "GET" }))) return true;
    } catch (e) {}
  }
  return false;
}

function hasBotWatermark(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return (
    lower.includes("mebri.yegna.workers.dev") ||
    lower.includes("@mebrigranite") ||
    lower.includes("0911680790") ||
    lower.includes("#yegnagebeya") ||
    lower.includes("📝 title:") ||
    lower.includes("💰 price:")
  );
}

function cleanupOldStores() {
  const now = Date.now();
  for (const [k, v] of albumStore.entries()) { if (now - v.timestamp > 60000) albumStore.delete(k); }
  if (completedLocks.size > 2000) completedLocks.delete(completedLocks.values().next().value);
}

function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) { hash = ((hash << 5) - hash) + str.charCodeAt(i); hash = hash & hash; }
  return Math.abs(hash).toString();
}

async function callTelegram(method, body, env) {
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(`${method} → ${data.description || res.statusText}`);
  return data.result;
}

function safeSubstring(str, maxLen) {
  if (!str) return "";
  if (str.length <= maxLen) return str;
  let out = "";
  for (const ch of str) { if (out.length + ch.length > maxLen) break; out += ch; }
  return out;
}

// [Keep your CAR_DATABASE, ELECTRONICS_DATABASE, detectBrandModelYear, arrangeTitle, detectCategory, parseMathematicalPrice, cleanTheText, extractCity, uploadImagesToCloudinary, inspectImageWithGemini, getFirebaseToken, base64UrlEncode HERE as they were in your original file]

async function processFinalAd(message, imageFileIds, cleanText, env, mediaGroupId = null) {
  let { brand, model, year, trim, bodyType, fuelType, transmission, subcategory } = detectBrandModelYear(cleanText);
  const category = detectCategory(cleanText, brand);
  if (!subcategory) subcategory = bodyType || "Vehicles";

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
    } catch (vErr) {}
  }

  const arrangedTitle = arrangeTitle({ brand, model, year, trim, cleanText, category, subcategory });
  const { formattedPrice, rawPrice } = parseMathematicalPrice(cleanText, year);
  const textHash = simpleHash(cleanText.toLowerCase().replace(/\s+/g, ''));
  const imageUrls = await uploadImagesToCloudinary(imageFileIds.slice(0, 4), env);
  
  try {
    const token = await getFirebaseToken(env);
    if (token && env.FIREBASE_PROJECT_ID) {
      const projectId = env.FIREBASE_PROJECT_ID;
      const adOwnerId = env.ADMIN_UID || "admin_bot";
      const docId = mediaGroupId ? `tg_${mediaGroupId}` : `ad_${textHash}`; 
      const fbUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/ads/${docId}`;

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
          image: { stringValue: imageUrls.length > 0 ? imageUrls[0] : "" },
          images: { arrayValue: { values: imageUrls.map((url) => ({ stringValue: url })) } },
          status: { stringValue: "available" },
          source: { stringValue: "telegram" },
          userId: { stringValue: adOwnerId },
          views: { integerValue: "0" },
          createdAt: { timestampValue: new Date().toISOString() }
        }
      };
      await fetch(fbUrl, { method: "PATCH", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(adData) });
    }
  } catch (fbErr) {}

  const hashtagMap = { Cars: "#Cars", Houses: "#Houses", Rentals: "#Rentals", Electronics: "#Electronics", Furniture: "#Furniture", Clothes: "#Clothes", "Labor & Services": "#Labor", "ምንአለሽ_ተራ": "#ምንአለሽ_ተራ" };
  const hashtag = hashtagMap[category] || "#Other";
  const displayPriceText = formattedPrice && formattedPrice !== "0" ? `${formattedPrice} ETB` : "Negotiable / ተደራዳሪ";

  let headerText = `📝 Title: ${arrangedTitle}\n`;
  if (brand || model || year) headerText += `🏷️ Make: ${brand || "-"} | Model: ${model || "-"} | Year: ${year || "-"}\n`;
  headerText += `📂 Category: ${category}${subcategory ? ` › ${subcategory}` : ""}\n`;
  headerText += `💰 Price: ${displayPriceText}\n`;
  if (transmission || fuelType) headerText += `⚙️ ${transmission || ""} | ⛽ ${fuelType || ""}\n`;

  let footerText = `\n━━━━━━━━━━━━━━━\n🏢 የኛ ገበያ (Yegna Gebeya)\n📞 Phone: 0911680790\n🌐 Website: mebri.yegna.workers.dev\n✈️ Telegram: @mebrigranite\n━━━━━━━━━━━━━━━\n\n${hashtag} #YegnaGebeya`;

  const maxDetailsLen = Math.max(100, 1020 - (headerText.length + footerText.length + 15));
  let safeDetails = safeSubstring(cleanText, maxDetailsLen);
  const newPostText = `${headerText}\n📄 Details:\n${safeDetails}${footerText}`;
  const targetChannel = env.REPOST_CHANNEL_ID || "@mebrigranite";

  try {
    if (imageFileIds.length === 0) await callTelegram("sendMessage", { chat_id: targetChannel, text: safeSubstring(newPostText, 4096) }, env);
    else if (imageFileIds.length === 1) await callTelegram("sendPhoto", { chat_id: targetChannel, photo: imageFileIds[0], caption: safeSubstring(newPostText, 1024) }, env);
    else {
      const media = imageFileIds.slice(0, 10).map((fileId, index) => ({ type: "photo", media: fileId, ...(index === 0 ? { caption: safeSubstring(newPostText, 1024) } : {}) }));
      await callTelegram("sendMediaGroup", { chat_id: targetChannel, media }, env);
    }
  } catch (err) {}
}
