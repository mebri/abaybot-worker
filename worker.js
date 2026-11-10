/**
 * Yegna Gebeya Telegram Bot - Cloudflare Worker
 * Main entry + update routing
 */

import {
  detectBrandModelYear,
  arrangeTitle,
  detectCategory,
  parseMathematicalPrice,
  cleanTheText,
  extractCity,
  uploadImagesToCloudinary,
  inspectImageWithGemini,
  getFirebaseToken,
  simpleHash,
  safeSubstring,
  callTelegram
} from "./worker-helpers.js";

const albumCache = new Map();

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

  // Ignore bot's own messages
  const botId = env.TELEGRAM_BOT_TOKEN ? env.TELEGRAM_BOT_TOKEN.split(":")[0] : "";
  if (message.from && String(message.from.id) === botId) return;
  if (message.from && message.from.is_bot) return;

  // Ignore target repost channel
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

  // Watermark check (protects against double-processing bot's own posts)
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

  // Insta-block: 60-second global dedup
  const cleanRawTextForHash = rawText.toLowerCase().replace(/\s+/g, "");
  const instantHash = simpleHash(cleanRawTextForHash);

  if (!globalThis.recentProcessed) globalThis.recentProcessed = new Map();
  if (globalThis.recentProcessed.has(instantHash)) {
    const lastTime = globalThis.recentProcessed.get(instantHash);
    if (Date.now() - lastTime < 60000) {
      console.log("⏭️ Ignored: Insta-blocked duplicate text.");
      return;
    }
  }
  globalThis.recentProcessed.set(instantHash, Date.now());

  if (globalThis.recentProcessed.size > 2000) {
    const cutoff = Date.now() - 120000;
    for (const [k, ts] of globalThis.recentProcessed.entries()) {
      if (ts < cutoff) globalThis.recentProcessed.delete(k);
    }
  }

  // Album handling with 2.5s debounce
  if (message.media_group_id) {
    const groupId = message.media_group_id;

    if (!albumCache.has(groupId)) {
      albumCache.set(groupId, {
        images: [],
        messageIds: [],
        firstMessage: rawText.length > 3 ? message : null,
        timerActive: false,
        timestamp: Date.now()
      });
    }

    const albumData = albumCache.get(groupId);

    if (message.photo && message.photo.length > 0) {
      albumData.images.push(message.photo[message.photo.length - 1].file_id);
      albumData.messageIds.push(message.message_id);
    }
    if (rawText.length > 3 && !albumData.firstMessage) {
      albumData.firstMessage = message;
    }

    if (!albumData.timerActive) {
      albumData.timerActive = true;
      await new Promise((resolve) => setTimeout(resolve, 2500));

      if (!albumCache.has(groupId)) return;
      const finalData = albumCache.get(groupId);
      albumCache.delete(groupId);

      await processFinalAd(
        finalData.firstMessage || message,
        Array.from(new Set(finalData.images)),
        finalData.messageIds,
        env
      );
    }

    cleanupStaleAlbums();
    return;
  }

  // Single post
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

async function processFinalAd(message, imageFileIds, messageIds, env) {
  const messageText = (message.text || message.caption || "").trim();
  
  try {
    // 1. Clean text and extract data
    const cleanText = cleanTheText(messageText);
    if (!cleanText || cleanText.length < 3) return;

    let { brand, model, year, trim, bodyType, fuelType, transmission, subcategory } =
      detectBrandModelYear(cleanText);
    const category = detectCategory(cleanText, brand);
    if (!subcategory) subcategory = bodyType || "Vehicles";

    const arrangedTitle = arrangeTitle({ brand, model, year, trim, cleanText, category, subcategory });
    const { formattedPrice, rawPrice } = parseMathematicalPrice(cleanText, year);
    const textHash = simpleHash(cleanText.toLowerCase().replace(/\s+/g, ""));

    // 2. Build the formatted message (Watermark/Footer Intact)
    const hashtagMap = {
      Cars: "#Cars", Houses: "#Houses", Rentals: "#Rentals", Electronics: "#Electronics",
      Furniture: "#Furniture", Clothes: "#Clothes", "Labor & Services": "#Labor", "ምንአለሽ_ተራ": "#ምንአለሽ_ተራ"
    };
    const hashtag = hashtagMap[category] || "#Other";
    const displayPriceText = formattedPrice && formattedPrice !== "0" ? `${formattedPrice} ETB` : "Negotiable / ተደራዳሪ";

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

    // Footer (Watermark)
    let footerText = `\n━━━━━━━━━━━━━━━\n`;
    footerText += `🏢 የኛ ገበያ (Yegna Gebeya)\n`;
    footerText += `📞 Phone: 0911680790\n`;
    footerText += `🌐 Website: mebri.yegna.workers.dev\n`;
    footerText += `✈️ Telegram: @mebrigranite\n`;
    footerText += `━━━━━━━━━━━━━━━\n\n`;
    footerText += `${hashtag} #YegnaGebeya`;

    // Safely truncate Details so the Footer is never cut off
    const fixedLen = newPostText.length + footerText.length + 15;
    const maxDetailsLen = Math.max(100, 1020 - fixedLen);
    let safeDetails = safeSubstring(cleanText, maxDetailsLen);
    if (cleanText.length > maxDetailsLen) safeDetails = safeDetails.trimEnd() + "…";

    newPostText += `\n📄 Details:\n${safeDetails}${footerText}`;

    // 3. POST TO TELEGRAM FIRST (Bypasses Firebase crashes)
    const targetChannel = env.REPOST_CHANNEL_ID;
    if (!targetChannel) {
       await callTelegram("sendMessage", { chat_id: message.chat.id, text: "ERROR: REPOST_CHANNEL_ID is missing in Cloudflare Environment Variables!" }, env);
       return;
    }

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

    // 4. SAVE TO FIREBASE SECOND (Errors won't block Telegram)
    try {
      const token = await getFirebaseToken(env);
      if (token && env.FIREBASE_PROJECT_ID) {
        const projectId = env.FIREBASE_PROJECT_ID;
        const docId = message.media_group_id ? `tg_${message.chat.id}_${message.media_group_id}` : `ad_${message.chat.id}_${textHash}`;
        const fbUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/ads/${docId}`;
        
        // Upload images for Firebase (Cloudinary)
        let imageUrls = [];
        if (imageFileIds.length > 0) {
          imageUrls = await uploadImagesToCloudinary(imageFileIds, env);
        }

        const adData = {
          fields: {
            title: { stringValue: arrangedTitle },
            brand: { stringValue: brand || "" },
            model: { stringValue: model || "" },
            year: { stringValue: year || "" },
            category: { stringValue: category },
            description: { stringValue: cleanText },
            price: { stringValue: formattedPrice },
            image: { stringValue: imageUrls.length > 0 ? imageUrls[0] : "" },
            images: { arrayValue: { values: imageUrls.map((url) => ({ stringValue: url })) } },
            status: { stringValue: "available" },
            createdAt: { timestampValue: new Date().toISOString() }
          }
        };
        await fetch(fbUrl, { method: "PATCH", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(adData) });
        console.log("✅ Saved to Website (Firebase)");
      }
    } catch (fbErr) {
      console.log("Firebase Error:", fbErr.message);
    }

  } catch (error) {
    // THIS REPLIES TO YOU IN TELEGRAM IF THE BOT FAILS
    console.error("CRASH IN PROCESS FINAL AD:", error);
    await callTelegram("sendMessage", {
      chat_id: message.chat.id,
      text: `🚨 BOT CRASHED 🚨\n\nError: ${error.message}\n\nCheck Cloudflare Logs for more details.`
    }, env);
  }
}
