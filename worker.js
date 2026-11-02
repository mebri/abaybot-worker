/**
 * Yegna Gebeya Telegram Bot - Cloudflare Worker
 * Features:
 * - Strict Channel Loop Protection
 * - Delete original & repost fresh message (Ensures clean text & correct phone)
 */

const albumCache = new Map();
let cachedFirebaseToken = null;
let tokenExpiresAt = 0;

export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") {
      return new Response("Bot is running ✅", { status: 200 });
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
  const message = update.message || update.channel_post;
  if (!message) return;

  // 1. Anti-bot protection (prevents bot replying to its own reposts)
  if (message.from && message.from.is_bot) return;

  // 2. Hard block for Channel Posts (stops infinite loops)
  if (update.channel_post) return;
  if (env.REPOST_CHANNEL_ID && String(message.chat.id) === String(env.REPOST_CHANNEL_ID)) return;

  const rawText = (message.text || message.caption || "").trim();

  // 3. Anti-Loop Text Check
  if (
    rawText.includes("የኛ ገበያ") ||
    rawText.includes("@mebrigranite") ||
    rawText.includes("Yegna Gebeya") ||
    /#(Cars|Houses|Rentals|Electronics|Furniture|Clothes|Labor|ምንአለሽ_ተራ|Other)\b/i.test(rawText)
  ) {
    return;
  }

  // ============================================
  // ALBUM HANDLING (Media Groups)
  // ============================================
  if (message.media_group_id) {
    const groupId = message.media_group_id;

    if (!albumCache.has(groupId)) {
      albumCache.set(groupId, {
        images: [],
        firstMessage: rawText.length > 3 ? message : null,
        timerActive: false,
        timestamp: Date.now()
      });
    }

    const albumData = albumCache.get(groupId);

    if (message.photo && message.photo.length > 0) {
      albumData.images.push(message.photo[message.photo.length - 1].file_id);
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
        env
      );
    }

    cleanupStaleAlbums();
    return;
  }

  // ============================================
  // SINGLE IMAGE OR TEXT-ONLY POST
  // ============================================
  if (rawText.length < 3) return;

  const images = [];
  if (message.photo && message.photo.length > 0) {
    images.push(message.photo[message.photo.length - 1].file_id);
  }

  await processFinalAd(message, images, env);
}

// ============================================
// SAFE TELEGRAM API WRAPPER
// ============================================
async function callTelegram(method, body, env) {
  const res = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    throw new Error(`${method} → ${data.description || res.statusText} (${res.status})`);
  }
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
// MAIN PROCESSING
// ============================================
async function processFinalAd(message, imageFileIds, env) {
  const messageText = (message.text || message.caption || "").trim();
  const cleanText = cleanTheText(messageText);

  if (!cleanText || cleanText.length < 3) return;

  const category = detectCategory(cleanText);
  const title = extractTitle(cleanText);
  const { formattedPrice, rawPrice } = parseMathematicalPrice(cleanText);

  const imageUrls = await uploadImagesToCloudinary(imageFileIds, env);

  // Save to Firebase
  try {
    const token = await getFirebaseToken(env);
    const projectId = env.FIREBASE_PROJECT_ID;
    const adOwnerId = env.ADMIN_UID || "admin_bot";

    const docId = message.media_group_id
      ? `tg_${message.chat.id}_${message.media_group_id}`
      : `tg_${message.chat.id}_${message.message_id}`;

    const fbUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/ads/${docId}`;

    let allImages = imageUrls;
    try {
      const checkRes = await fetch(fbUrl, { headers: { Authorization: `Bearer ${token}` } });
      if (checkRes.ok) {
        const existingData = await checkRes.json();
        if (!message.media_group_id && existingData.fields?.createdAt?.timestampValue) {
          const createdTime = new Date(existingData.fields.createdAt.timestampValue).getTime();
          if (Date.now() - createdTime < 30000) return; // Skip duplicate webhooks
        }
        if (existingData.fields?.images?.arrayValue?.values) {
          const existingUrls = existingData.fields.images.arrayValue.values.map(v => v.stringValue);
          allImages = Array.from(new Set([...existingUrls, ...imageUrls]));
        }
      }
    } catch (e) {}

    const adData = {
      fields: {
        title: { stringValue: title },
        description: { stringValue: cleanText },
        price: { stringValue: formattedPrice },
        rawPrice: { integerValue: rawPrice },
        phone: { stringValue: "0911680790" },
        city: { stringValue: extractCity(cleanText) },
        category: { stringValue: category },
        image: { stringValue: allImages.length > 0 ? allImages[0] : "" },
        images: { arrayValue: { values: allImages.map((url) => ({ stringValue: url })) } },
        status: { stringValue: "available" },
        source: { stringValue: "telegram" },
        userId: { stringValue: adOwnerId },
        views: { integerValue: "0" },
        createdAt: { timestampValue: new Date().toISOString() }
      }
    };

    await fetch(fbUrl, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(adData)
    });
  } catch (fbErr) {}

  // Build Message
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

  const isPhoto = message.photo && message.photo.length > 0;
  const chatId = message.chat.id;
  const lastPhotoFileId = isPhoto ? message.photo[message.photo.length - 1].file_id : null;

  // --- DELETE ORIGINAL AND SEND CLEAN MESSAGE ---
  // This guarantees we don't get "Not enough rights to edit" errors.
  try {
    // 1. Try to delete the original message (If bot is admin)
    try {
      await callTelegram("deleteMessage", {
        chat_id: chatId,
        message_id: message.message_id
      }, env);
      console.log("✅ Original message deleted.");
    } catch (delErr) {
      console.warn("⚠️ Could not delete original (Bot may not be admin):", delErr.message);
    }

    // 2. Send the newly formatted message
    if (isPhoto) {
      await callTelegram("sendPhoto", {
        chat_id: chatId,
        photo: lastPhotoFileId,
        caption: safeSubstring(newPostText, 1024)
      }, env);
    } else {
      await callTelegram("sendMessage", {
        chat_id: chatId,
        text: safeSubstring(newPostText, 4096)
      }, env);
    }
    console.log("✅ Sent clean message to main chat");

  } catch (error) {
    console.error("❌ Failed to process main chat message:", error.message);
  }

  // --- SEND TO REPOST CHANNEL ---
  if (env.REPOST_CHANNEL_ID) {
    try {
      if (isPhoto) {
        await callTelegram("sendPhoto", {
          chat_id: env.REPOST_CHANNEL_ID,
          photo: lastPhotoFileId,
          caption: safeSubstring(newPostText, 1024)
        }, env);
      } else {
        await callTelegram("sendMessage", {
          chat_id: env.REPOST_CHANNEL_ID,
          text: safeSubstring(newPostText, 4096)
        }, env);
      }
      console.log("✅ Sent to channel");
    } catch (chErr) {
      console.error("❌ Channel send failed:", chErr.message);
    }
  }
}

// ============================================
// HELPERS
// ============================================
function parseMathematicalPrice(text) {
  const millionMatch = text.match(/([\d.]+)\s*(?:million|mil|mln|m|ሚሊዮን)\b/i);
  if (millionMatch) {
    const val = parseFloat(millionMatch[1]);
    if (!isNaN(val) && val > 0 && val < 1000) return { formattedPrice: Math.round(val * 1000000).toLocaleString("en-US"), rawPrice: Math.round(val * 1000000).toString() };
  }
  const thousandMatch = text.match(/([\d.]+)\s*(?:k|thousand|ሺህ|ሺ)\b/i);
  if (thousandMatch) {
    const val = parseFloat(thousandMatch[1]);
    if (!isNaN(val) && val > 0 && val < 10000) return { formattedPrice: Math.round(val * 1000).toLocaleString("en-US"), rawPrice: Math.round(val * 1000).toString() };
  }
  const explicitMatch = text.match(/(?:price|peric|pris|ዋጋ|ETB|ብር|Birr)[\s:.]*([\d.,]+)/i);
  if (explicitMatch) {
    const num = parseInt(explicitMatch[1].replace(/[.,]/g, "").trim(), 10);
    if (!isNaN(num) && num > 50) return { formattedPrice: num.toLocaleString("en-US"), rawPrice: num.toString() };
  }
  const standaloneMatch = text.match(/\b(\d{1,3}(?:,\d{3})+|\d{4,9})\b/);
  if (standaloneMatch) {
    const num = parseInt(standaloneMatch[1].replace(/[.,]/g, "").trim(), 10);
    if (!isNaN(num) && num >= 500) return { formattedPrice: num.toLocaleString("en-US"), rawPrice: num.toString() };
  }
  return { formattedPrice: "0", rawPrice: "0" };
}

async function uploadImagesToCloudinary(fileIds, env) {
  if (!fileIds || fileIds.length === 0) return [];
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

function cleanTheText(text) {
  if (!text) return "";
  const EMOJI = /[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}\u{E0020}-\u{E007F}\u{1F1E6}-\u{1F1FF}]/gu;
  return text
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/\b(?:t\.me|telegram\.me)\/\S+/gi, "")
    .replace(/@[a-zA-Z0-9_]{2,}/g, "")
    .replace(/(?:\b(?:tel|phone|call|ስልክ|ደውል)\b[\s:.]*)?(?:\+251|251|0)?[\s.-]?[97]\d(?:[\s.-]?\d){7}\b/gi, (m) => (/tel|phone|call|ስልክ|ደውል/i.test(m) ? "" : m))
    .replace(EMOJI, "")
    .replace(/[*_~`|]/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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

function extractCity(text) {
  const lower = text.toLowerCase();
  if (/(አዲስ አበባ|addis ababa|finfinne|bole|sarbet|cmc|gerji|piassa)/i.test(lower)) return "Addis Ababa";
  if (/(hawassa|ሀዋሳ)/i.test(lower)) return "Hawassa";
  if (/(adama|አዳማ|nazret)/i.test(lower)) return "Adama";
  if (/(bahir dar|ባህር ዳር)/i.test(lower)) return "Bahir Dar";
  if (/(dire dawa|ድሬዳዋ)/i.test(lower)) return "Dire Dawa";
  return "Addis Ababa";
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

async function getFirebaseToken(env) {
  const now = Math.floor(Date.now() / 1000);
  if (cachedFirebaseToken && tokenExpiresAt > now + 300) return cachedFirebaseToken;
  const clientEmail = env.FIREBASE_CLIENT_EMAIL;
  const privateKey = env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n");
  const header = { alg: "RS256", typ: "JWT" };
  const payload = { iss: clientEmail, scope: "https://www.googleapis.com/auth/datastore", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 };
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
  const tokRes = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}` });
  const tokData = await tokRes.json();
  if (!tokData.access_token) throw new Error("Token Error: " + JSON.stringify(tokData));
  cachedFirebaseToken = tokData.access_token;
  tokenExpiresAt = now + (tokData.expires_in || 3600);
  return cachedFirebaseToken;
}

function base64UrlEncode(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function cleanupStaleAlbums() {
  const twoMinutesAgo = Date.now() - 120000;
  for (const [key, value] of albumCache.entries()) {
    if (value.timestamp < twoMinutesAgo) albumCache.delete(key);
  }
}
