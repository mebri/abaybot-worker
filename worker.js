/**
 * Yegna Gebeya Telegram Bot - Cloudflare Worker
 * (With Insta-Block & 1-Hour Strict Deduplication)
 */

const albumCache = new Map();
let cachedFirebaseToken = null;
let tokenExpiresAt = 0;

export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") {
      return new Response("Yegna Gebeya Bot is running ✅", { status: 200 });
    }
    try {
      const update = await request.json();
      ctx.waitUntil(processUpdate(update, env));
      return new Response("OK", { status: 200 });
    } catch (error) {
      return new Response("Error: " + error.message, { status: 500 });
    }
  }
};

async function processUpdate(update, env) {
  if (update.edited_message || update.edited_channel_post) return;

  const message = update.message || update.channel_post;
  if (!message) return;

  const botId = env.TELEGRAM_BOT_TOKEN ? env.TELEGRAM_BOT_TOKEN.split(":")[0] : "";
  if (message.from && String(message.from.id) === botId) return;
  if (message.from && message.from.is_bot) return;

  if (env.REPOST_CHANNEL_ID) {
    const target = String(env.REPOST_CHANNEL_ID).replace("@", "").toLowerCase();
    const currentId = String(message.chat.id);
    const currentUsername = (message.chat.username || "").toLowerCase();
    if (currentId === target || (currentUsername && currentUsername === target)) return;
  }

  if (message.forward_from_chat) {
    const fwdChatId = String(message.forward_from_chat.id);
    const fwdChatUser = (message.forward_from_chat.username || "").toLowerCase();
    const target = env.REPOST_CHANNEL_ID ? String(env.REPOST_CHANNEL_ID).replace("@", "").toLowerCase() : "";
    if (target && (fwdChatId === target || fwdChatUser === target)) return;
  }
  if (message.is_automatic_forward) return;

  const rawText = (message.text || message.caption || "").trim();

  if (
    rawText.includes("🏢 የኛ ገበያ (Yegna Gebeya)") ||
    rawText.includes("📝 Title:") ||
    rawText.includes("💰 Price:") ||
    rawText.includes("@mebrigranite") ||
    rawText.includes("0911680790") ||
    rawText.includes("#YegnaGebeya") ||
    /#(Cars|Houses|Rentals|Electronics|Furniture|Clothes|Labor|ምንአለሽ_ተራ|Other)\b/i.test(rawText)
  ) {
    return;
  }

  // ✅ INSTA-BLOCK: Prevents Auto-Forward duplicates instantly
  const cleanRawTextForHash = rawText.toLowerCase().replace(/\s+/g, '');
  const instantHash = simpleHash(cleanRawTextForHash);
  
  if (!globalThis.recentProcessed) globalThis.recentProcessed = new Map();
  
  if (globalThis.recentProcessed.has(instantHash)) {
    const lastTime = globalThis.recentProcessed.get(instantHash);
    if (Date.now() - lastTime < 60000) { // 60 seconds
      console.log("⏭️ Ignored: Insta-blocked duplicate text.");
      return;
    }
  }
  globalThis.recentProcessed.set(instantHash, Date.now());

  if (message.media_group_id) {
    const groupId = message.media_group_id;
    if (!albumCache.has(groupId)) {
      albumCache.set(groupId, {
        images: [], messageIds: [], firstMessage: rawText.length > 3 ? message : null,
        timerActive: false, timestamp: Date.now()
      });
    }
    const albumData = albumCache.get(groupId);
    if (message.photo && message.photo.length > 0) {
      albumData.images.push(message.photo[message.photo.length - 1].file_id);
      albumData.messageIds.push(message.message_id);
    }
    if (rawText.length > 3 && !albumData.firstMessage) albumData.firstMessage = message;

    if (!albumData.timerActive) {
      albumData.timerActive = true;
      await new Promise((resolve) => setTimeout(resolve, 2500));
      if (!albumCache.has(groupId)) return;
      const finalData = albumCache.get(groupId);
      albumCache.delete(groupId);
      await processFinalAd(finalData.firstMessage || message, Array.from(new Set(finalData.images)), finalData.messageIds, env);
    }
    cleanupStaleAlbums();
    return;
  }

  if (rawText.length < 3) return;

  const images = [];
  if (message.photo && message.photo.length > 0) {
    images.push(message.photo[message.photo.length - 1].file_id);
  }
  await processFinalAd(message, images, [message.message_id], env);
}

function cleanupStaleAlbums() {
  const now = Date.now();
  for (const [key, data] of albumCache.entries()) {
    if (now - data.timestamp > 60000) albumCache.delete(key);
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
  for (const ch of str) {
    if (out.length + ch.length > maxLen) break;
    out += ch;
  }
  return out;
}

async function processFinalAd(message, imageFileIds, messageIds, env) {
  const messageText = (message.text || message.caption || "").trim();
  const cleanText = cleanTheText(messageText);
  if (!cleanText || cleanText.length < 3) return;

  let { brand, model, year, trim, bodyType, fuelType, transmission, subcategory } = detectBrandModelYear(cleanText || messageText);
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
  const { formattedPrice, rawPrice } = parseMathematicalPrice(cleanText || messageText, year);

  const textHash = simpleHash(cleanText.toLowerCase().replace(/\s+/g, ''));
  const imageUrls = await uploadImagesToCloudinary(imageFileIds, env);
  
  try {
    const token = await getFirebaseToken(env);
    const projectId = env.FIREBASE_PROJECT_ID;
    const adOwnerId = env.ADMIN_UID || "admin_bot";
    
    // ✅ FIXED: Strict ID including chat ID
    const docId = message.media_group_id 
      ? `tg_${message.chat.id}_${message.media_group_id}` 
      : `ad_${message.chat.id}_${textHash}`; 
      
    const fbUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/ads/${docId}`;

    let allImages = imageUrls;
    try {
      const checkRes = await fetch(fbUrl, { headers: { Authorization: `Bearer ${token}` } });
      if (checkRes.ok) {
        const existingData = await checkRes.json();
        
        // ✅ 1-Hour Strict Duplicate Check
        if (existingData.fields?.createdAt?.timestampValue) {
          const createdTime = new Date(existingData.fields.createdAt.timestampValue).getTime();
          if (Date.now() - createdTime < 3600000) { // 1 hour in ms
            console.log("⏭️ Ignored: Duplicate ad detected on website.");
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
  } catch (fbErr) {
    console.error("Firebase Error:", fbErr.message);
  }

  const hashtagMap = { 
    Cars: "#Cars", Houses: "#Houses", Rentals: "#Rentals", Electronics: "#Electronics", 
    Furniture: "#Furniture", Clothes: "#Clothes", "Labor & Services": "#Labor", "ምንአለሽ_ተራ": "#ምንአለሽ_ተራ" 
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

  const targetChannel = env.REPOST_CHANNEL_ID;
  if (!targetChannel) return;

  try {
    if (imageFileIds.length === 0) {
      await callTelegram("sendMessage", { chat_id: targetChannel, text: safeSubstring(newPostText, 4096) }, env);
    } else if (imageFileIds.length === 1) {
      await callTelegram("sendPhoto", { chat_id: targetChannel, photo: imageFileIds[0], caption: safeSubstring(newPostText, 1024) }, env);
    } else {
      const media = imageFileIds.slice(0, 10).map((fileId, index) => ({
        type: "photo", media: fileId, ...(index === 0 ? { caption: safeSubstring(newPostText, 1024) } : {})
      }));
      await callTelegram("sendMediaGroup", { chat_id: targetChannel, media: media }, env);
    }
    console.log("✅ Forwarded Clean Ad to Channel!");
  } catch (err) {
    console.error("Broadcast Error:", err.message);
  }
}

// ... (Keep all your other helpers: detectBrandModelYear, arrangeTitle, detectCategory, parseMathematicalPrice, cleanTheText, extractCity, uploadImagesToCloudinary, inspectImageWithGemini, getFirebaseToken, base64UrlEncode) ...
