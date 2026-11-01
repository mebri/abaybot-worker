/**
 * Yegna Gebeya Telegram Bot - Cloudflare Worker
 * 
 * FIXES:
 * 1. ZERO DUPLICATES: Uses deterministic Document IDs with Firestore PATCH
 * 2. SMART TITLE: Automatically extracts Brand + Model + Year (No hashtags or "urgent")
 * 3. FULL ALBUM GALLERY: Collects all album images into Firestore images array
 * 4. MATHEMATICAL PRICES: 2380000 -> 2,380,000 ETB / 17000000 -> 17,000,000 ETB
 */

const albumCache = new Map();
const processedGroups = new Set();
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

  // 1. Anti-bot protection
  if (message.from && message.from.is_bot) return;

  const rawText = (message.text || message.caption || "").trim();

  // 2. Anti-Loop: Skip if message was already edited by bot
  if (
    rawText.includes("የኛ ገበያ") ||
    rawText.includes("@mebrigranite") ||
    /#(Cars|Houses|Rentals|Electronics|Furniture|Clothes|Labor|ምንአለሽ_ተራ|Other)\b/i.test(rawText)
  ) {
    return;
  }

  // ============================================
  // ALBUM PROCESSING (Multiple Photos)
  // ============================================
  if (message.media_group_id) {
    const groupId = message.media_group_id;

    // Prevent duplicate processing of the same media group
    if (processedGroups.has(groupId)) return;

    if (!albumCache.has(groupId)) {
      albumCache.set(groupId, {
        images: [],
        firstMessage: rawText.length > 2 ? message : null,
        timerStarted: false,
        timestamp: Date.now()
      });
    }

    const album = albumCache.get(groupId);

    // Collect highest resolution photo file_id from each webhook
    if (message.photo && message.photo.length > 0) {
      const bestPhoto = message.photo[message.photo.length - 1].file_id;
      if (!album.images.includes(bestPhoto)) {
        album.images.push(bestPhoto);
      }
    }

    // Save message with text caption
    if (rawText.length > 2 && !album.firstMessage) {
      album.firstMessage = message;
    }

    // Wait 4 seconds so ALL photos in the Telegram album arrive
    if (!album.timerStarted) {
      album.timerStarted = true;
      await new Promise((resolve) => setTimeout(resolve, 4000));

      processedGroups.add(groupId);

      const finalAlbum = albumCache.get(groupId);
      albumCache.delete(groupId);

      if (finalAlbum && finalAlbum.images.length > 0) {
        await processFinalAd(
          finalAlbum.firstMessage || message,
          finalAlbum.images,
          groupId,
          env
        );
      }
    }

    cleanupMemory();
    return;
  }

  // ============================================
  // SINGLE PHOTO OR TEXT POST
  // ============================================
  if (rawText.length < 3) return;

  const images = [];
  if (message.photo && message.photo.length > 0) {
    images.push(message.photo[message.photo.length - 1].file_id);
  }

  await processFinalAd(message, images, null, env);
}

// ============================================
// MAIN PROCESSING & DEDUPLICATED FIRESTORE SYNC
// ============================================
async function processFinalAd(message, imageFileIds, groupId, env) {
  const messageText = (message.text || message.caption || "").trim();
  const cleanText = cleanTheText(messageText);
  const category = detectCategory(cleanText);

  // 1. SMART TITLE: Extracts "Brand Model Year" (Never uses #hashtags or "urgent")
  const title = extractSmartTitle(cleanText, category);

  // 2. MATHEMATICAL PRICE FORMATTING (2380000 -> 2,380,000)
  const { formattedPrice, rawPrice } = parseMathematicalPrice(cleanText);

  // 3. Upload ALL images in PARALLEL to Cloudinary
  const imageUrls = await uploadImagesToCloudinary(imageFileIds, env);

  // 4. Save to Firebase Firestore with Deterministic Document ID (KILLS DUPLICATES)
  try {
    const token = await getFirebaseToken(env);
    const projectId = env.FIREBASE_PROJECT_ID;
    const adOwnerId = env.ADMIN_UID || "admin_bot";

    // DETERMINISTIC DOCUMENT ID:
    // If it's an album, use tg_album_${groupId}. If single post, use tg_msg_${chatId}_${messageId}.
    const documentId = groupId
      ? `tg_album_${groupId}`
      : `tg_msg_${message.chat.id}_${message.message_id}`;

    const adData = {
      fields: {
        title: { stringValue: title },
        description: { stringValue: cleanText },
        price: { stringValue: formattedPrice }, // "2,380,000"
        rawPrice: { integerValue: rawPrice },   // "2380000" (numeric for sorting)
        phone: { stringValue: "0911680790" },
        city: { stringValue: extractCity(cleanText) },
        category: { stringValue: category },
        image: { stringValue: imageUrls.length > 0 ? imageUrls[0] : "" },
        images: {
          arrayValue: {
            values: imageUrls.map((url) => ({ stringValue: url }))
          }
        },
        status: { stringValue: "available" },
        source: { stringValue: "telegram" },
        userId: { stringValue: adOwnerId },
        views: { integerValue: "0" },
        createdAt: { timestampValue: new Date().toISOString() }
      }
    };

    // PATCH creates the document if new, or updates it if existing (NEVER DUPLICATES)
    const fbUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/ads/${documentId}`;
    await fetch(fbUrl, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(adData)
    });
  } catch (fbErr) {
    console.error("Firestore Save Error:", fbErr);
  }

  // 5. Update the Telegram Post with Business Card
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

  let safeDetails = cleanText.substring(0, 480);
  if (cleanText.length > 480) safeDetails += "...";

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

  try {
    if (message.photo && message.photo.length > 0) {
      await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/editMessageCaption`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: message.chat.id,
          message_id: message.message_id,
          caption: newPostText.substring(0, 1024)
        })
      });
    } else {
      await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/editMessageText`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: message.chat.id,
          message_id: message.message_id,
          text: newPostText.substring(0, 4096)
        })
      });
    }
  } catch (editErr) {
    console.error("Telegram Edit Error:", editErr);
  }
}

// ============================================
// SMART TITLE: EXTRACT BRAND + MODEL + YEAR
// ============================================
function extractSmartTitle(text, category) {
  // 1. CAR BRANDS & MODELS
  if (category === "Cars") {
    const brands = [
      { name: "Toyota", regex: /(toyota|ቶዮታ)/i },
      { name: "Suzuki", regex: /(suzuki|ሱዙኪ)/i },
      { name: "Hyundai", regex: /(hyundai|ሃዩንዳይ|ሂዩንዳይ)/i },
      { name: "Kia", regex: /(kia|ኪያ)/i },
      { name: "Honda", regex: /(honda|ሆንዳ)/i },
      { name: "Nissan", regex: /(nissan|ኒሳን)/i },
      { name: "Ford", regex: /(ford|ፎርድ)/i },
      { name: "Mercedes-Benz", regex: /(mercedes|benz|መርሴዲስ|ቤንዝ)/i },
      { name: "BMW", regex: /(bmw|ቢኤምደብሊው)/i },
      { name: "Volkswagen", regex: /(volkswagen|vw|ቮልስዋገን)/i },
      { name: "Mitsubishi", regex: /(mitsubishi|ሚትሱቢሺ)/i },
      { name: "Isuzu", regex: /(isuzu|ኢሱዙ)/i },
      { name: "BYD", regex: /(byd|ቢዋይዲ)/i },
      { name: "Jetour", regex: /(jetour|ጄቱር)/i },
      { name: "Geely", regex: /(geely|ጂሊ)/i },
      { name: "Chery", regex: /(chery|ቼሪ)/i },
      { name: "Mazda", regex: /(mazda|ማዝዳ)/i },
      { name: "Peugeot", regex: /(peugeot|ፔጆ)/i },
      { name: "Land Rover", regex: /(land rover|range rover|ሬንጅ ሮቨር)/i },
      { name: "Jeep", regex: /(jeep|ጂፕ)/i }
    ];

    const models = [
      { name: "4Runner", regex: /(4runner|ፎርረነር|4 runner)/i },
      { name: "Prado", regex: /(prado|ፕራዶ)/i },
      { name: "Land Cruiser", regex: /(land cruiser|ላንድክሩዘር|ላንድ ክሩዘር)/i },
      { name: "RAV4", regex: /(rav4|rav 4|ራቭ4|ራቭ 4)/i },
      { name: "Hilux", regex: /(hilux|ሃይሉክስ)/i },
      { name: "Yaris", regex: /(yaris|ያሪስ)/i },
      { name: "Corolla", regex: /(corolla|ኮሮላ)/i },
      { name: "Vitz", regex: /(vitz|ቪትዝ)/i },
      { name: "Rush", regex: /(rush|ሩሽ)/i },
      { name: "Fortuner", regex: /(fortuner|ፎርቹን)/i },
      { name: "Dzire", regex: /(dzire|ዲዛይር|desire)/i },
      { name: "Swift", regex: /(swift|ስዊፍት)/i },
      { name: "Celerio", regex: /(celerio|ሴሌሪዮ)/i },
      { name: "Alto", regex: /(alto|አልቶ)/i },
      { name: "Tucson", regex: /(tucson|ቱክሰን)/i },
      { name: "Creta", regex: /(creta|ክሬታ)/i },
      { name: "Santa Fe", regex: /(santa fe|ሳንታፌ|ሳንታ ፌ)/i },
      { name: "Elantra", regex: /(elantra|ኤላንትራ)/i },
      { name: "Avante", regex: /(avante|አቫንቴ)/i },
      { name: "Sonata", regex: /(sonata|ሶናታ)/i },
      { name: "Accent", regex: /(accent|አክሰንት)/i },
      { name: "Atto 3", regex: /(atto 3|atto3)/i },
      { name: "Dashing", regex: /(dashing|ዳሺንግ)/i },
      { name: "Tiggo", regex: /(tiggo|ቲጎ)/i }
    ];

    let foundBrand = "";
    let foundModel = "";

    for (const b of brands) {
      if (b.regex.test(text)) {
        foundBrand = b.name;
        break;
      }
    }
    for (const m of models) {
      if (m.regex.test(text)) {
        foundModel = m.name;
        break;
      }
    }

    const yearMatch = text.match(/\b(19\d{2}|20\d{2})\b/);
    const year = yearMatch ? yearMatch[1] : "";

    if (foundBrand && foundModel) {
      return `${foundBrand} ${foundModel} ${year}`.trim();
    }
    if (foundBrand) {
      return `${foundBrand} ${year ? year : "Car"}`.trim();
    }
  }

  // 2. PHONES & LAPTOPS
  if (category === "Electronics") {
    const devices = [
      "iPhone 16 Pro Max", "iPhone 16 Pro", "iPhone 16", "iPhone 15 Pro Max", "iPhone 15 Pro", "iPhone 15",
      "iPhone 14 Pro Max", "iPhone 14 Pro", "iPhone 14", "iPhone 13 Pro Max", "iPhone 13 Pro", "iPhone 13",
      "iPhone 12 Pro Max", "iPhone 12 Pro", "iPhone 12", "iPhone 11",
      "Samsung Galaxy S24 Ultra", "Samsung Galaxy S24", "Samsung Galaxy S23 Ultra", "Samsung S23",
      "MacBook Pro", "MacBook Air", "iPad Pro", "iPad Air", "HP Victus", "HP Pavilion", "Dell XPS", "Lenovo ThinkPad"
    ];
    for (const d of devices) {
      if (new RegExp(d.replace(/\s+/g, "\\s*"), "i").test(text)) {
        return d;
      }
    }
  }

  // 3. HOUSES & CONDOS
  if (category === "Houses" || category === "Rentals") {
    const houseTypes = ["Villa", "Condominium", "Apartment", "G+2", "G+1", "Studio", "ኮንዶሚኒየም", "ቪላ", "አፓርታማ"];
    for (const h of houseTypes) {
      if (new RegExp(`\\b${h}\\b`, "i").test(text)) {
        const city = extractCity(text);
        return `${h} ${city !== "Addis Ababa" ? city : ""}`.trim();
      }
    }
  }

  // Fallback: Strip hashtags and spam words like "urgent" or "#ቀጥታውይበተን"
  const cleanLines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 2 && !l.startsWith("#") && !/^(urgent|አስቸኳይ|sale|ሽያጭ|for sale|የሚሸጥ|ቀጥታ)/i.test(l));

  let fallback = cleanLines[0] || "New Listing";
  return fallback.length > 45 ? fallback.substring(0, 45) + "..." : fallback;
}

// ============================================
// MATHEMATICAL PRICE RULES (2380000 -> 2,380,000)
// ============================================
function parseMathematicalPrice(text) {
  // Million shorthands (3.5M, 3.5 million, 3.5 ሚሊዮን)
  const millionMatch = text.match(/([\d.]+)\s*(?:million|mil|mln|m|ሚሊዮን)\b/i);
  if (millionMatch) {
    const val = parseFloat(millionMatch[1]);
    if (!isNaN(val) && val > 0 && val < 1000) {
      const calculated = Math.round(val * 1000000);
      return {
        formattedPrice: calculated.toLocaleString("en-US"), // "3,500,000"
        rawPrice: calculated.toString()
      };
    }
  }

  // Thousand shorthands (500k, 500 ሺህ)
  const thousandMatch = text.match(/([\d.]+)\s*(?:k|thousand|ሺህ|ሺ)\b/i);
  if (thousandMatch) {
    const val = parseFloat(thousandMatch[1]);
    if (!isNaN(val) && val > 0 && val < 10000) {
      const calculated = Math.round(val * 1000);
      return {
        formattedPrice: calculated.toLocaleString("en-US"), // "500,000"
        rawPrice: calculated.toString()
      };
    }
  }

  // Explicit Price labels (ዋጋ: 2380000, Price: 17000000, 2380000 ETB, 2380000 ብር)
  const explicitMatch = text.match(/(?:price|peric|pris|ዋጋ|ETB|ብር|Birr)[\s:.]*([\d.,]+)/i);
  if (explicitMatch) {
    const digitsOnly = explicitMatch[1].replace(/[.,]/g, "").trim();
    const num = parseInt(digitsOnly, 10);
    if (!isNaN(num) && num > 50) {
      return {
        formattedPrice: num.toLocaleString("en-US"), // "2,380,000"
        rawPrice: num.toString()
      };
    }
  }

  // Standalone numbers >= 500 (e.g. 2380000 or 17000000)
  const standaloneMatch = text.match(/\b(\d{1,3}(?:,\d{3})+|\d{4,10})\b/);
  if (standaloneMatch) {
    const digitsOnly = standaloneMatch[1].replace(/[.,]/g, "").trim();
    const num = parseInt(digitsOnly, 10);
    if (!isNaN(num) && num >= 500) {
      return {
        formattedPrice: num.toLocaleString("en-US"),
        rawPrice: num.toString()
      };
    }
  }

  return { formattedPrice: "0", rawPrice: "0" };
}

// ============================================
// PARALLEL CLOUDINARY UPLOADER (ALL PHOTOS)
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
      console.error("Cloudinary upload failed for fileId:", fileId, err);
      return null;
    }
  });

  const results = await Promise.all(uploadPromises);
  return results.filter(Boolean);
}

// ============================================
// CLEANING & HELPER FUNCTIONS
// ============================================
function cleanTheText(text) {
  return text
    .replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{2700}-\u{27BF}\u{25A0}-\u{25FF}\u{2B50}\u{1F004}\u{1F0CF}]/gu, "")
    .replace(/[*_~`|]/g, "")
    .replace(/https?:\/\/[^\s]+/gi, "")
    .replace(/t\.me\/[^\s]+/gi, "")
    .replace(/@[a-zA-Z0-9_]+/g, "")
    .replace(/(?:\+251|251|0)?[\s.-]?[97]\d(?:[\s.-]?\d){7}/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function detectCategory(text) {
  const lowerText = text.toLowerCase();
  if (/(car|toyota|suzuki|hyundai|kia|honda|bmw|benz|nissan|ford|mazda|tucson|elantra|avante|vehicle|engine|mileage|km|መኪና|ሱዙኪ|ቶዮታ|ሆንዳ|ቢኤምደብሊው|ተሽከርካሪ|ሞተር)/i.test(lowerText)) return "Cars";
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

// ============================================
// CACHED GOOGLE / FIREBASE AUTH TOKEN
// ============================================
async function getFirebaseToken(env) {
  const now = Math.floor(Date.now() / 1000);

  if (cachedFirebaseToken && tokenExpiresAt > now + 300) {
    return cachedFirebaseToken;
  }

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
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`
  });

  const tokData = await tokRes.json();
  if (!tokData.access_token) {
    throw new Error("Token Error: " + JSON.stringify(tokData));
  }

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

function cleanupMemory() {
  const threeMinutesAgo = Date.now() - 180000;
  for (const [key, value] of albumCache.entries()) {
    if (value.timestamp < threeMinutesAgo) {
      albumCache.delete(key);
    }
  }
  if (processedGroups.size > 500) {
    processedGroups.clear();
  }
}
