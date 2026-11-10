/**
 * Yegna Gebeya Telegram Bot - Cloudflare Worker
 * Integrated: original logic + double-post fix + album grouping + dedup cache
 */

// ============================================
// GLOBAL CACHES
// ============================================
const albumCache = new Map();         // media_group_id -> album data
const processedCache = new Map();     // message_id -> timestamp (webhook retry guard)
const textDedupCache = new Map();     // textHash -> timestamp (5-min duplicate window)

let cachedFirebaseToken = null;
let tokenExpiresAt = 0;

// ============================================
// ENTRY POINT
// ============================================
export default {
  async fetch(request, env, ctx) {
    // Health check / browser visit
    if (request.method !== "POST") {
      return new Response("Bot is running ✅ (Channel Aggregator v6.0 Active)", {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" }
      });
    }

    let update;
    try {
      update = await request.json();
    } catch (e) {
      return new Response("Bad JSON", { status: 400 });
    }

    // CRITICAL: Always return 200 quickly so Telegram doesn't retry.
    // Process async via waitUntil.
    ctx.waitUntil(processUpdate(update, env));
    return new Response("OK", { status: 200 });
  }
};

// ============================================
// UPDATE PROCESSOR
// ============================================
async function processUpdate(update, env) {
  const message = update.message || update.channel_post;
  if (!message) return;

  // --- Guard 1: Ignore target repost channel ---
  if (env.REPOST_CHANNEL_ID) {
    const target = String(env.REPOST_CHANNEL_ID).replace("@", "").toLowerCase();
    const currentId = String(message.chat.id);
    const currentUsername = (message.chat.username || "").toLowerCase();
    if (currentId === target || (currentUsername && currentUsername === target)) return;
  }

  // --- Guard 2: Ignore bot messages ---
  const botId = env.TELEGRAM_BOT_TOKEN.split(":")[0];
  if (message.from && String(message.from.id) === botId) return;
  if (message.from && message.from.is_bot) return;

  // --- Guard 3: Webhook retry guard (same message_id processed within 15 min) ---
  const dedupKey = `${message.chat.id}_${message.message_id}`;
  const now = Date.now();
  if (processedCache.has(dedupKey) && now - processedCache.get(dedupKey) < 15 * 60 * 1000) {
    console.log("⏭️ Skipped webhook retry:", dedupKey);
    return;
  }
  processedCache.set(dedupKey, now);
  cleanupProcessedCache();

  const rawText = (message.text || message.caption || "").trim();

  // --- Guard 4: Watermark / already-formatted check ---
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

  // ============================================
  // ALBUM HANDLING
  // ============================================
  if (message.media_group_id) {
    const groupId = message.media_group_id;

    if (!albumCache.has(groupId)) {
      albumCache.set(groupId, {
        images: [],
        messageIds: [],
        firstMessage: rawText.length > 3 ? message : null,
        timerActive: false,
        timestamp: now
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

    // Only the FIRST webhook for this album starts the debounce timer
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

  // ============================================
  // SINGLE POST
  // ============================================
  if (rawText.length < 3) return;

  const images = [];
  if (message.photo && message.photo.length > 0) {
    images.push(message.photo[message.photo.length - 1].file_id);
  }

  await processFinalAd(message, images, [message.message_id], env);
}

// ============================================
// HASH
// ============================================
function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash = hash & hash;
  }
  return Math.abs(hash).toString();
}

// ============================================
// SAFE TELEGRAM API WRAPPER
// ============================================
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
// MAIN PROCESSING
// ============================================
async function processFinalAd(message, imageFileIds, messageIds, env) {
  const messageText = (message.text || message.caption || "").trim();
  const cleanText = cleanTheText(messageText);
  if (!cleanText || cleanText.length < 3) return;

  const category = detectCategory(cleanText);
  const title = extractTitle(cleanText);
  const { formattedPrice, rawPrice } = parseMathematicalPrice(cleanText);

  // --- STEP 1: Save to Firebase ---
  const imageUrls = await uploadImagesToCloudinary(imageFileIds, env);
  const textHash = simpleHash(cleanText.toLowerCase().replace(/\s+/g, ''));

  // In-memory text dedup: block exact same text within 5 minutes
  if (textDedupCache.has(textHash) && Date.now() - textDedupCache.get(textHash) < 5 * 60 * 1000) {
    console.log("⏭️ Skipped duplicate text (in-memory):", textHash);
    return;
  }
  textDedupCache.set(textHash, Date.now());
  cleanupTextDedupCache();

  try {
    const token = await getFirebaseToken(env);
    const projectId = env.FIREBASE_PROJECT_ID;
    const adOwnerId = env.ADMIN_UID || "admin_bot";

    // Stable docId: albums use media_group_id (idempotent), singles use textHash
    const docId = message.media_group_id
      ? `tg_${message.chat.id}_${message.media_group_id}`
      : `ad_${textHash}`;

    const fbUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/ads/${docId}`;

    let allImages = imageUrls;
    let existingCreatedAt = null;

    try {
      const checkRes = await fetch(fbUrl, { headers: { Authorization: `Bearer ${token}` } });
      if (checkRes.ok) {
        const existingData = await checkRes.json();

        // If this doc was created < 5 minutes ago, it's a duplicate – skip
        if (existingData.fields?.createdAt?.timestampValue) {
          existingCreatedAt = existingData.fields.createdAt.timestampValue;
          const createdTime = new Date(existingCreatedAt).getTime();
          if (Date.now() - createdTime < 300000) {
            console.log("⏭️ Ignored: Duplicate text detected on website.");
            return;
          }
        }

        // Merge existing images with new ones
        if (existingData.fields?.images?.arrayValue?.values) {
          const existingUrls = existingData.fields.images.arrayValue.values.map(v => v.stringValue);
          allImages = Array.from(new Set([...existingUrls, ...imageUrls]));
        }
      }
    } catch (e) { /* first time – ignore */ }

    const adData = {
      fields: {
        title: { stringValue: title },
        description: { stringValue: cleanText },
        textHash: { stringValue: textHash },
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
        // Preserve original createdAt on update (so sorting/scroll stays stable)
        createdAt: { timestampValue: existingCreatedAt || new Date().toISOString() }
      }
    };

    await fetch(fbUrl, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(adData)
    });
    console.log("✅ Saved to Website (Firebase)");
  } catch (fbErr) {
    console.error("Firebase Error:", fbErr.message);
  }

  // --- STEP 2: Build the formatted message ---
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
  const displayPriceText = formattedPrice && formattedPrice !== "0"
    ? `${formattedPrice} ETB`
    : "Negotiable / ተደራዳሪ";

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

  // --- STEP 3: Edit in place (strip hidden premium entities) ---
  let messageHandled = false;
  try {
    if (isPhoto && messageIds.length === 1) {
      await callTelegram("editMessageCaption", {
        chat_id: chatId,
        message_id: message.message_id,
        caption: safeSubstring(newPostText, 1024),
        caption_entities: [] // strips premium/AI hidden entities
      }, env);
    } else if (!isPhoto) {
      await callTelegram("editMessageText", {
        chat_id: chatId,
        message_id: message.message_id,
        text: safeSubstring(newPostText, 4096),
        entities: []
      }, env);
    }
    if (isPhoto || !isPhoto) {
      console.log("✅ Edited in place.");
      messageHandled = true;
    }
  } catch (editErr) {
    console.log("⚠️ Edit failed. Deleting & Reposting...", editErr.message);
  }

  // --- STEP 4: If edit failed → delete original(s) & repost ---
  if (!messageHandled) {
    try {
      if (messageIds.length === 1) {
        await callTelegram("deleteMessage", { chat_id: chatId, message_id: messageIds[0] }, env);
      } else {
        // Telegram supports up to 100 message_ids per call
        await callTelegram("deleteMessages", { chat_id: chatId, message_ids: messageIds.slice(0, 100) }, env);
      }
      console.log("✅ Deleted original dirty post(s)");
    } catch (delErr) {
      console.log("⚠️ Could not delete original. Bot needs Admin delete rights:", delErr.message);
    }

    try {
      if (imageFileIds.length > 1) {
        // --- MULTI-IMAGE: send as an album (single grouped post) ---
        const media = imageFileIds.slice(0, 10).map((fileId, idx) => ({
          type: "photo",
          media: fileId,
          ...(idx === 0 ? { caption: safeSubstring(newPostText, 1024), caption_entities: [] } : {})
        }));
        await callTelegram("sendMediaGroup", {
          chat_id: chatId,
          media
        }, env);
      } else if (isPhoto && lastPhotoFileId) {
        await callTelegram("sendPhoto", {
          chat_id: chatId,
          photo: lastPhotoFileId,
          caption: safeSubstring(newPostText, 1024),
          caption_entities: []
        }, env);
      } else {
        await callTelegram("sendMessage", {
          chat_id: chatId,
          text: safeSubstring(newPostText, 4096),
          entities: []
        }, env);
      }
      console.log("✅ Sent clean message to main chat");
    } catch (repostErr) {
      console.error("❌ Failed to send clean message:", repostErr.message);
    }
  }

  // --- STEP 5: Send to repost channel ---
  if (env.REPOST_CHANNEL_ID) {
    try {
      if (imageFileIds.length > 1) {
        const media = imageFileIds.slice(0, 10).map((fileId, idx) => ({
          type: "photo",
          media: fileId,
          ...(idx === 0 ? { caption: safeSubstring(newPostText, 1024), caption_entities: [] } : {})
        }));
        await callTelegram("sendMediaGroup", {
          chat_id: env.REPOST_CHANNEL_ID,
          media
        }, env);
      } else if (isPhoto && lastPhotoFileId) {
        await callTelegram("sendPhoto", {
          chat_id: env.REPOST_CHANNEL_ID,
          photo: lastPhotoFileId,
          caption: safeSubstring(newPostText, 1024),
          caption_entities: []
        }, env);
      } else {
        await callTelegram("sendMessage", {
          chat_id: env.REPOST_CHANNEL_ID,
          text: safeSubstring(newPostText, 4096),
          entities: []
        }, env);
      }
    } catch (chErr) {
      console.log("Repost channel error:", chErr.message);
    }
  }
}

// ============================================
// PRICE PARSER
// ============================================
function parseMathematicalPrice(text) {
  const millionMatch = text.match(/([\d.]+)\s*(?:million|mil|mln|m|ሚሊዮን)\b/i);
  if (millionMatch) {
    const val = parseFloat(millionMatch[1]);
    if (!isNaN(val) && val > 0 && val < 1000) {
      return {
        formattedPrice: Math.round(val * 1000000).toLocaleString("en-US"),
        rawPrice: Math.round(val * 1000000).toString()
      };
    }
  }
  const thousandMatch = text.match(/([\d.]+)\s*(?:k|thousand|ሺህ|ሺ)\b/i);
  if (thousandMatch) {
    const val = parseFloat(thousandMatch[1]);
    if (!isNaN(val) && val > 0 && val < 10000) {
      return {
        formattedPrice: Math.round(val * 1000).toLocaleString("en-US"),
        rawPrice: Math.round(val * 1000).toString()
      };
    }
  }
  const explicitMatch = text.match(/(?:price|peric|pris|ዋጋ|ETB|ብር|Birr)[\s:.]*([\d.,]+)/i);
  if (explicitMatch) {
    const num = parseInt(explicitMatch[1].replace(/[.,]/g, "").trim(), 10);
    if (!isNaN(num) && num > 50) {
      return { formattedPrice: num.toLocaleString("en-US"), rawPrice: num.toString() };
    }
  }
  const standaloneMatch = text.match(/\b(\d{1,3}(?:,\d{3})+|\d{4,9})\b/);
  if (standaloneMatch) {
    const num = parseInt(standaloneMatch[1].replace(/[.,]/g, "").trim(), 10);
    if (!isNaN(num) && num >= 500) {
      return { formattedPrice: num.toLocaleString("en-US"), rawPrice: num.toString() };
    }
  }
  return { formattedPrice: "0", rawPrice: "0" };
}

// ============================================
// CLOUDINARY UPLOAD
// ============================================
async function uploadImagesToCloudinary(fileIds, env) {
  if (!fileIds || fileIds.length === 0) return [];

  const uploadPromises = fileIds.map(async (fileId) => {
    try {
      const fileRes = await fetch(
        `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`
      );
      const fileInfo = await fileRes.json();
      if (!fileInfo.ok || !fileInfo.result?.file_path) return null;

      const tgFileUrl = `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${fileInfo.result.file_path}`;

      const formData = new FormData();
      formData.append("file", tgFileUrl);
      formData.append("upload_preset", env.CLOUDINARY_UPLOAD_PRESET);

      const cloudRes = await fetch(
        `https://api.cloudinary.com/v1_1/${env.CLOUDINARY_CLOUD_NAME}/image/upload`,
        { method: "POST", body: formData }
      );
      const cloudData = await cloudRes.json();
      return cloudData.secure_url || null;
    } catch (err) {
      return null;
    }
  });

  const results = await Promise.all(uploadPromises);
  return results.filter(Boolean);
}

// ============================================
// TEXT CLEANER
// ============================================
function cleanTheText(text) {
  if (!text) return "";
  const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{1F1E6}-\u{1F1FF}\u{200D}\u{20E3}\u{2190}-\u{21FF}\u{25A0}-\u{25FF}\u{2B50}\u{1F004}\u{1F0CF}]/gu;
  return text
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/\b(?:t\.me|telegram\.me)\S*/gi, "")
    .replace(/@[a-zA-Z0-9_]{2,}/g, "")
    .replace(/(?:\+251|251|0)?[\s.-]?[97]\d(?:[\s.-]?\d){7}\b/gi, "")
    .replace(EMOJI, "")
    .replace(/[*_~`|]/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ============================================
// CATEGORY DETECTOR
// ============================================
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

// ============================================
// CITY EXTRACTOR
// ============================================
function extractCity(text) {
  const lower = text.toLowerCase();
  if (/(አዲስ አበባ|addis ababa|finfinne|bole|sarbet|cmc|gerji|piassa)/i.test(lower)) return "Addis Ababa";
  if (/(hawassa|ሀዋሳ)/i.test(lower)) return "Hawassa";
  if (/(adama|አዳማ|nazret)/i.test(lower)) return "Adama";
  if (/(bahir dar|ባህር ዳር)/i.test(lower)) return "Bahir Dar";
  if (/(dire dawa|ድሬዳዋ)/i.test(lower)) return "Dire Dawa";
  return "Addis Ababa";
}

// ============================================
// TITLE EXTRACTOR
// ============================================
function extractTitle(text) {
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l.length > 2);
  let title = lines[0] || "New Listing";
  if (/(urgent|አስቸኳይ|sale|ሽያጭ|for sale|የሚሸጥ)/i.test(title) && lines.length > 1) {
    title = lines[1];
  }
  if (title.length > 55) title = safeSubstring(title, 55) + "…";
  return title;
}

// ============================================
// FIREBASE TOKEN
// ============================================
async function getFirebaseToken(env) {
  const now = Math.floor(Date.now() / 1000);
  if (cachedFirebaseToken && tokenExpiresAt > now + 300) return cachedFirebaseToken;

  const clientEmail = env.FIREBASE_CLIENT_EMAIL;
  const privateKey = env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n");

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
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\s/g, "");

  const binaryDer = Uint8Array.from(atob(pemContents), (c) => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    binaryDer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const sigBuffer = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    new TextEncoder().encode(signingInput)
  );

  const sigBytes = new Uint8Array(sigBuffer);
  let binary = "";
  for (let i = 0; i < sigBytes.length; i++) binary += String.fromCharCode(sigBytes[i]);
  const signature = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

  const jwt = `${signingInput}.${signature}`;

  const tokRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt
    })
  });

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

// ============================================
// CACHE CLEANUP
// ============================================
function cleanupStaleAlbums() {
  const twoMinutesAgo = Date.now() - 120000;
  for (const [key, value] of albumCache.entries()) {
    if (value.timestamp < twoMinutesAgo) albumCache.delete(key);
  }
}

function cleanupProcessedCache() {
  const fifteenMinutesAgo = Date.now() - 15 * 60 * 1000;
  for (const [key, ts] of processedCache.entries()) {
    if (ts < fifteenMinutesAgo) processedCache.delete(key);
  }
}

function cleanupTextDedupCache() {
  const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
  for (const [key, ts] of textDedupCache.entries()) {
    if (ts < fiveMinutesAgo) textDedupCache.delete(key);
  }
}
