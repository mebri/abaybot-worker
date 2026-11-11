/**
 * Yegna Gebeya Telegram Bot - Double-Post Destroyer & Emoji Breaker
 */

const albumCache = new Map();
const processedUpdates = new Set();
const recentAds = new Map(); 

export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") return new Response("Bot is running ✅", { status: 200 });

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
  const message = update.message || update.channel_post;
  if (!message) return;

  // 🛑 DEFENSE 1: IGNORE WEBHOOK RETRIES
  if (update.update_id) {
    if (processedUpdates.has(update.update_id)) return;
    processedUpdates.add(update.update_id);
    if (processedUpdates.size > 1000) processedUpdates.clear();
  }

  if (!env.TELEGRAM_BOT_TOKEN || !env.REPOST_CHANNEL_ID) {
    await sendErrorToChat(message.chat.id, "❌ MISSING ENV VARS\n\nAdd TELEGRAM_BOT_TOKEN and REPOST_CHANNEL_ID in Cloudflare.", env);
    return;
  }

  try {
    const botId = env.TELEGRAM_BOT_TOKEN.split(":")[0];
    if (message.from && (String(message.from.id) === botId || message.from.is_bot)) return;

    const rawText = (message.text || message.caption || "").trim();

    if (
      rawText.includes("🏢 የኛ ገበያ (Yegna Gebeya)") ||
      rawText.includes("📝 Title:") ||
      rawText.includes("💰 Price:") ||
      rawText.includes("@mebrigranite") ||
      rawText.includes("0911680790") ||
      /#(Cars|Houses|Rentals|Electronics|Furniture|Clothes|Labor|ምንአለሽ_ተራ|Other)\b/i.test(rawText)
    ) {
      return;
    }

    if (message.media_group_id) {
      const groupId = message.media_group_id;
      if (!albumCache.has(groupId)) {
        albumCache.set(groupId, { images: [], messageIds: [], firstMessage: rawText.length > 3 ? message : null, timerActive: false, timestamp: Date.now() });
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

  } catch (globalError) {
    console.error("GLOBAL CRASH:", globalError);
    await sendErrorToChat(message.chat.id, `🚨 BOT CRASHED 🚨\n\nError: ${globalError.message}`, env);
  }
}

async function processFinalAd(message, imageFileIds, messageIds, env) {
  const messageText = (message.text || message.caption || "").trim();
  const cleanText = cleanTheText(messageText);
  if (!cleanText || cleanText.length < 3) return;

  const category = detectCategory(cleanText);
  const title = extractTitle(cleanText);
  const { formattedPrice } = parseMathematicalPrice(cleanText);
  const textHash = simpleHash(cleanText.toLowerCase().replace(/\s+/g, ''));

  const dedupKey = message.media_group_id ? String(message.media_group_id) : textHash;
  if (recentAds.has(dedupKey)) {
    const lastTime = recentAds.get(dedupKey);
    if (Date.now() - lastTime < 3600000) return; 
  }
  recentAds.set(dedupKey, Date.now());
  if (recentAds.size > 1000) {
    const cutoff = Date.now() - 3600000;
    for (const [k, v] of recentAds.entries()) {
      if (v < cutoff) recentAds.delete(k);
    }
  }

  const hashtagMap = { Cars: "#Cars", Houses: "#Houses", Rentals: "#Rentals", Electronics: "#Electronics", Furniture: "#Furniture", Clothes: "#Clothes", "Labor & Services": "#Labor", "ምንአለሽ_ተራ": "#ምንአለሽ_ተራ" };
  const hashtag = hashtagMap[category] || "#Other";
  const displayPriceText = formattedPrice && formattedPrice !== "0" ? `${formattedPrice} ETB` : "Negotiable / ተደራዳሪ";

  let safeDetails = safeSubstring(cleanText, 800);
  if (cleanText.length > 800) safeDetails = safeDetails.trimEnd() + "…";

  let newPostText = `📝 Title: ${title}\n`;
  newPostText += `💰 Price: ${displayPriceText}\n\n`;
  newPostText += `📄 Details:\n${safeDetails}\n\n`;
  newPostText += `━━━━━━━━━━━━━━━\n`;
  newPostText += `🏢 የኛ ገበያ (Yegna Gebeya)\n`;
  newPostText += `📞 Phone: 0911680790\n`;
  newPostText += `🌐 Website: mebri.yegna.workers.dev\n`;
  newPostText += `✈️ Telegram: @mebrigranite\n`;
  newPostText += `━━━━━━━━━━━━━━━\n\n`;
  newPostText += `${hashtag}`;

  const chatId = message.chat.id;
  const targetChannel = env.REPOST_CHANNEL_ID;
  const targetClean = String(targetChannel).replace("@", "").toLowerCase();
  const isTargetChannel = String(chatId) === targetClean || (message.chat.username || "").toLowerCase() === targetClean;

  if (isTargetChannel) {
    let messageHandled = false;
    try {
      if (imageFileIds.length > 0) {
        await callTelegram("editMessageCaption", {
          chat_id: chatId, message_id: message.message_id,
          caption: safeSubstring(newPostText, 1024), 
          caption_entities: [] // 👈 STRIPS PREMIUM EMOJIS
        }, env);
      } else {
        await callTelegram("editMessageText", {
          chat_id: chatId, message_id: message.message_id,
          text: safeSubstring(newPostText, 4096), 
          entities: [] // 👈 STRIPS PREMIUM EMOJIS
        }, env);
      }
      messageHandled = true;
    } catch (e) {}

    if (!messageHandled) {
      try { await callTelegram("deleteMessage", { chat_id: chatId, message_id: message.message_id }, env); } catch (e) {}
      
      if (imageFileIds.length > 0) {
        await callTelegram("sendPhoto", { chat_id: chatId, photo: imageFileIds[0], caption: safeSubstring(newPostText, 1024), caption_entities: [] }, env);
      } else {
        await callTelegram("sendMessage", { chat_id: chatId, text: safeSubstring(newPostText, 4096), entities: [] }, env);
      }
    }
  } else {
    try { await callTelegram("deleteMessage", { chat_id: chatId, message_id: message.message_id }, env); } catch (e) {}

    try {
      if (imageFileIds.length > 0) {
        await callTelegram("sendPhoto", { chat_id: targetChannel, photo: imageFileIds[0], caption: safeSubstring(newPostText, 1024), caption_entities: [] }, env);
      } else {
        await callTelegram("sendMessage", { chat_id: targetChannel, text: safeSubstring(newPostText, 4096), entities: [] }, env);
      }
    } catch (chErr) {}
  }

  try {
    const token = await getFirebaseToken(env);
    if (token) {
      const projectId = env.FIREBASE_PROJECT_ID;
      const docId = message.media_group_id ? `tg_${chatId}_${message.media_group_id}` : `ad_${textHash}`;
      const fbUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/ads/${docId}`;
      const imageUrls = await uploadImagesToCloudinary(imageFileIds, env);

      const adData = {
        fields: {
          title: { stringValue: title },
          description: { stringValue: cleanText },
          price: { stringValue: formattedPrice },
          category: { stringValue: category },
          image: { stringValue: imageUrls.length > 0 ? imageUrls[0] : "" },
          createdAt: { timestampValue: new Date().toISOString() }
        }
      };
      await fetch(fbUrl, { method: "PATCH", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(adData) });
    }
  } catch (fbErr) {}
}

// ============================================
// HELPERS
// ============================================
async function sendErrorToChat(chatId, text, env) {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: chatId, text: text })
  });
}

async function callTelegram(method, body, env) {
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(`${method} → ${data.description || res.statusText}`);
  return data.result;
}

// ============================================
// 🛑 ONLY THIS FUNCTION WAS CHANGED TO KILL PREMIUM EMOJIS
// ============================================
function cleanTheText(text) {
  if (!text) return "";
  try {
    // This is the ULTIMATE V8 Emoji Regex. It physically rips out every single emoji.
    // If there is no emoji character left, Telegram has no base to attach the Premium ID to.
    const EMOJI = /[\p{Extended_Pictographic}\p{Emoji_Presentation}]/gu;
    const PHONE_ET = /(?:\+?251|0)?[\s.\-]*(?:9|7)\d(?:[\s.\-]?\d){8}/g;

    return text
      .replace(/https?:\/\/\S+/gi, "")
      .replace(/\b(?:t\.me|telegram\.me)\/\S+/gi, "")
      .replace(/@[a-zA-Z0-9_]{2,}/g, "")
      .replace(PHONE_ET, "")
      .replace(EMOJI, "") // Destroys all emojis
      .replace(/[*_~`|]/g, "")
      .replace(/[ \t]+/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  } catch (err) {
    return text;
  }
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

function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash = hash & hash;
  }
  return Math.abs(hash).toString();
}

function detectCategory(text) {
  const lowerText = text.toLowerCase();
  if (/(car|toyota|suzuki|honda|bmw|benz|nissan|ford|hyundai|mazda|tucson|elantra|avante|vehicle|engine|mileage|km|መኪና|ሱዙኪ|ቶዮታ|ሆንዳ|ቢኤምደብሊው|ተሽከርካሪ|ሞተር)/i.test(lowerText)) return "Cars";
  if (/(house|villa|condominium|condo|ቤት|ቪላ|ኮንዶሚኒየም)/i.test(lowerText)) return "Houses";
  if (/(apartment|office|shop|አፓርታማ|ቢሮ|ሱቅ|መጋዘን)/i.test(lowerText)) return "Rentals";
  if (/(iphone|samsung|tecno|infinix|phone|smartphone|laptop|computer|tv|camera|ስልክ|ሞባይል|ላፕቶፕ|ኮምፒውተር|ቲቪ|ቴሌቪዥን|ካሜራ)/i.test(lowerText)) return "Electronics";
  if (/(sofa|bed|table|chair|furniture|cabinet|ሶፋ|አልጋ|ጠረጴዛ|ጠረንጴዛ|ወንበር|ቁምሳጥን|እቃ)/i.test(lowerText)) return "Furniture";
  if (/(clothes|shoes|dress|shirt|pants|fashion|ልብስ|ጫማ|ቀሚስ|ሱሪ|ሸሚዝ)/i.test(lowerText)) return "Clothes";
  if (/(construction|electrician|plumber|painter|cleaning|worker|ግንባታ|ኤሌክትሪሺያን|ቧንቧ|ቀለም|ጽዳት|ሰራተኛ|ሠራተኛ)/i.test(lowerText)) return "Labor & Services";
  if (/(used|second-hand|ምንአለሽ ተራ|ያገለገለ)/i.test(lowerText)) return "ምንአለሽ_ተራ";
  return "Other";
}

function extractTitle(text) {
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l.length > 2);
  let title = lines[0] || "New Listing";
  if (/(urgent|አስቸኳይ|sale|ሽያጭ|for sale|የሚሸጥ)/i.test(title) && lines.length > 1) {
    title = lines[1];
  }
  if (title.length > 55) title = safeSubstring(title, 55) + "…";
  return title;
}

function parseMathematicalPrice(text) {
  const millionMatch = text.match(/([\d.]+)\s*(?:million|mil|mln|m|ሚሊዮን)\b/i);
  if (millionMatch) {
    const val = parseFloat(millionMatch[1]);
    if (!isNaN(val) && val > 0 && val < 1000) return { formattedPrice: Math.round(val * 1000000).toLocaleString("en-US") };
  }
  const thousandMatch = text.match(/([\d.]+)\s*(?:k|thousand|ሺህ|ሺ)\b/i);
  if (thousandMatch) {
    const val = parseFloat(thousandMatch[1]);
    if (!isNaN(val) && val > 0 && val < 10000) return { formattedPrice: Math.round(val * 1000).toLocaleString("en-US") };
  }
  const explicitMatch = text.match(/(?:price|peric|pris|ዋጋ|ETB|ብር|Birr)[\s:.]*([\d.,]+)/i);
  if (explicitMatch) {
    const num = parseInt(explicitMatch[1].replace(/[.,]/g, "").trim(), 10);
    if (!isNaN(num) && num > 50) return { formattedPrice: num.toLocaleString("en-US") };
  }
  return { formattedPrice: "0" };
}

async function uploadImagesToCloudinary(fileIds, env) {
  if (!fileIds || fileIds.length === 0 || !env.CLOUDINARY_CLOUD_NAME) return [];
  const uploadPromises = fileIds.map(async (fileId) => {
    try {
      const fileRes = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`);
      const fileInfo = await fileRes.json();
      if (!fileInfo.ok || !fileInfo.result?.file_path) return null;
      const tgFileUrl = `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${fileInfo.result.file_path}`;
      const formData = new FormData();
      formData.append("file", tgFileUrl);
      formData.append("upload_preset", env.CLOUDINARY_UPLOAD_PRESET);
      const cloudRes = await fetch(`https://api.cloudinary.com/v1_1/${env.CLOUDINARY_CLOUD_NAME}/image/upload`, { method: "POST", body: formData });
      const cloudData = await cloudRes.json();
      return cloudData.secure_url || null;
    } catch (err) { return null; }
  });
  const results = await Promise.all(uploadPromises);
  return results.filter(Boolean);
}

async function getFirebaseToken(env) {
  const now = Math.floor(Date.now() / 1000);
  if (!env.FIREBASE_CLIENT_EMAIL || !env.FIREBASE_PRIVATE_KEY) return "";
  const header = { alg: "RS256", typ: "JWT" };
  const payload = { iss: env.FIREBASE_CLIENT_EMAIL, scope: "https://www.googleapis.com/auth/datastore", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 };
  const encHeader = btoa(JSON.stringify(header)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const encPayload = btoa(JSON.stringify(payload)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const signingInput = `${encHeader}.${encPayload}`;
  const pemContents = env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n").replace("-----BEGIN PRIVATE KEY-----", "").replace("-----END PRIVATE KEY-----", "").replace(/\s/g, "");
  const binaryDer = Uint8Array.from(atob(pemContents), (c) => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey("pkcs8", binaryDer, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sigBuffer = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", cryptoKey, new TextEncoder().encode(signingInput));
  const sigBytes = new Uint8Array(sigBuffer);
  let binary = "";
  for (let i = 0; i < sigBytes.length; i++) binary += String.fromCharCode(sigBytes[i]);
  const signature = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const jwt = `${signingInput}.${signature}`;
  const tokRes = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}` });
  const tokData = await tokRes.json();
  return tokData.access_token || "";
}

function cleanupStaleAlbums() {
  const twoMinutesAgo = Date.now() - 120000;
  for (const [key, value] of albumCache.entries()) {
    if (value.timestamp < twoMinutesAgo) albumCache.delete(key);
  }
}
