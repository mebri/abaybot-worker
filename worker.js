// ========================================================
// TELEGRAM BOT WORKER - 100% ZERO EMOJI & NO DUPLICATES
// Yegna Gebeya (የኛ ገበያ) - @mebrigranite
// ========================================================

const albumCache = new Map();
const processedPosts = new Set();

export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") {
      return new Response("Bot is running", { status: 200 });
    }

    try {
      const update = await request.json();
      ctx.waitUntil(processUpdate(update, env));
      return new Response("OK", { status: 200 });
    } catch (error) {
      return new Response("Error: " + error.message, { status: 200 });
    }
  }
};

async function processUpdate(update, env) {
  // 1. IGNORE EDITED MESSAGES (Prevents loops when bot edits caption)
  if (update.edited_message || update.edited_channel_post) return;

  const message = update.message || update.channel_post;
  if (!message) return;

  // 2. IGNORE BOTS
  if (message.from && message.from.is_bot) return;

  // 3. STOP DUPLICATES: Ignore auto-forwarded posts in linked discussion groups
  if (message.is_automatic_forward || message.forward_from_chat || message.forward_date) {
    return;
  }

  const text = (message.text || message.caption || "").trim();

  // 4. ANTI-LOOP: If already has our signature or website, stop immediately!
  if (
    text.includes("Yegna Gebeya") ||
    text.includes("የኛ ገበያ") ||
    text.includes("0911680790") ||
    text.includes("mebri.yegna.workers.dev") ||
    text.includes("@mebrigranite") ||
    text.includes("#Cars") ||
    text.includes("#Houses") ||
    text.includes("#Rentals") ||
    text.includes("#Electronics") ||
    text.includes("#Furniture") ||
    text.includes("#Clothes") ||
    text.includes("#Labor") ||
    text.includes("#ምንአለሽ_ተራ") ||
    text.includes("#Other")
  ) {
    return;
  }

  // ============================================
  // ALBUM LOGIC (Multiple Photos in one post)
  // ============================================
  if (message.media_group_id) {
    const groupId = message.media_group_id;
    
    if (processedPosts.has(groupId)) return;

    if (!albumCache.has(groupId)) {
      albumCache.set(groupId, { 
        images: [], 
        firstMessage: text.length > 2 ? message : null,
        timerStarted: false
      });
    }
    
    const albumData = albumCache.get(groupId);
    
    if (message.photo && message.photo.length > 0) {
      const photoId = message.photo[message.photo.length - 1].file_id;
      if (!albumData.images.includes(photoId)) {
        albumData.images.push(photoId);
      }
    }

    if (text.length > 2 && !albumData.firstMessage) {
      albumData.firstMessage = message;
    }

    // Start 2.5 second buffer only once per album
    if (!albumData.timerStarted) {
      albumData.timerStarted = true;
      await new Promise(resolve => setTimeout(resolve, 2500));
      
      if (!albumCache.has(groupId)) return;
      const finalData = albumCache.get(groupId);
      albumCache.delete(groupId);
      processedPosts.add(groupId);
      
      if (processedPosts.size > 500) {
        const first = processedPosts.values().next().value;
        processedPosts.delete(first);
      }

      await processFinalAd(
        finalData.firstMessage || message, 
        finalData.images, 
        env,
        groupId
      );
    }
    return;
  }

  // ============================================
  // SINGLE IMAGE OR TEXT-ONLY LOGIC
  // ============================================
  if (text.length < 3) return;
  
  const singleKey = `${message.chat.id}_${message.message_id}`;
  if (processedPosts.has(singleKey)) return;
  processedPosts.add(singleKey);

  const images = [];
  if (message.photo && message.photo.length > 0) {
    images.push(message.photo[message.photo.length - 1].file_id);
  }

  await processFinalAd(message, images, env, null);
}

// ============================================
// MAIN PROCESSING FUNCTION (ZERO EMOJIS)
// ============================================
async function processFinalAd(message, imageFileIds, env, mediaGroupId) {
  const rawText = (message.text || message.caption || "").trim();
  const cleanText = cleanTheText(rawText); // 100% emojis stripped
  const category = detectCategory(cleanText);
  const { title, price } = extractTitleAndPrice(cleanText);

  // 1. Upload ALL images to Cloudinary
  const imageUrls = [];
  for (const fileId of imageFileIds) {
    try {
      const fileRes = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`);
      const fileInfo = await fileRes.json();
      if (fileInfo.ok) {
        const imgRes = await fetch(`https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${fileInfo.result.file_path}`);
        const blob = await imgRes.blob();
        const formData = new FormData();
        formData.append("file", blob);
        formData.append("upload_preset", env.CLOUDINARY_UPLOAD_PRESET);
        const cloudRes = await fetch(`https://api.cloudinary.com/v1_1/${env.CLOUDINARY_CLOUD_NAME}/image/upload`, { 
          method: "POST", 
          body: formData 
        });
        const cloudData = await cloudRes.json();
        if (cloudData.secure_url) {
          imageUrls.push(cloudData.secure_url);
        }
      }
    } catch (e) {}
  }

  // 2. Save to Firebase (DEDUPLICATED VIA DETERMINISTIC DOCUMENT ID)
  const token = await getFirebaseToken(env);
  const projectId = env.FIREBASE_PROJECT_ID;
  const adOwnerId = env.ADMIN_UID || "admin_bot"; 

  const adData = {
    fields: {
      title: { stringValue: title },
      description: { stringValue: cleanText }, 
      price: { stringValue: price || "0" },
      phone: { stringValue: "0911680790" }, 
      city: { stringValue: "" },
      category: { stringValue: category },
      image: { stringValue: imageUrls.length > 0 ? imageUrls[0] : "" },
      images: { arrayValue: imageUrls.length > 0 ? { values: imageUrls.map(url => ({ stringValue: url })) } : { values: [] } },
      status: { stringValue: "available" }, 
      source: { stringValue: "telegram" },
      userId: { stringValue: adOwnerId }, 
      views: { integerValue: "0" },
      createdAt: { timestampValue: new Date().toISOString() },
    },
  };

  // Deterministic docId guarantees zero duplicates even if worker retries
  const docId = mediaGroupId
    ? `album_${mediaGroupId}`
    : `msg_${Math.abs(message.chat.id)}_${message.message_id}`;

  const fbUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/ads/${docId}`;
  await fetch(fbUrl, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(adData),
  });

  // 3. Build Telegram Repost (ZERO EMOJIS - PLAIN TEXT ONLY)
  let hashtag = "#Other";
  if (category === "Cars") hashtag = "#Cars";
  else if (category === "Houses") hashtag = "#Houses";
  else if (category === "Rentals") hashtag = "#Rentals";
  else if (category === "Electronics") hashtag = "#Electronics";
  else if (category === "Furniture") hashtag = "#Furniture";
  else if (category === "Clothes") hashtag = "#Clothes";
  else if (category === "Labor & Services") hashtag = "#Labor";
  else if (category === "ምንአለሽ ተራ") hashtag = "#ምንአለሽ_ተራ";

  let safeDetails = cleanText.substring(0, 500); 
  if (cleanText.length > 500) safeDetails += "...";

  let newPostText = `Title: ${title}\n`;
  if (price && price !== "0") newPostText += `Price: ${price} ETB\n`;
  newPostText += `\nDetails:\n${safeDetails}\n\n`;
  newPostText += `-------------------------------\n`;
  newPostText += `Yegna Gebeya (የኛ ገበያ)\n`;
  newPostText += `Phone: 0911680790\n`;
  newPostText += `Website: mebri.yegna.workers.dev\n`;
  newPostText += `Telegram: @mebrigranite\n`;
  newPostText += `-------------------------------\n\n`;
  newPostText += `${hashtag}`; 

  // 4. Edit message caption in Telegram (Zero emojis = no Telegram API errors)
  try {
    if (message.photo && message.photo.length > 0) {
      await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/editMessageCaption`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
          chat_id: message.chat.id, 
          message_id: message.message_id,
          caption: newPostText.substring(0, 1024)
        }),
      });
    } else {
      await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/editMessageText`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
          chat_id: message.chat.id, 
          message_id: message.message_id,
          text: newPostText.substring(0, 4096)
        }),
      });
    }
  } catch (err) {}
}

// ============================================
// HELPER: STRIP 100% OF EMOJIS & SYMBOLS
// ============================================
function cleanTheText(text) {
  if (!text) return "";
  let clean = text;

  // 1. Remove all Unicode emoji categories (Extended_Pictographic)
  clean = clean.replace(/\p{Extended_Pictographic}/gu, "");
  clean = clean.replace(/\p{Emoji_Presentation}/gu, "");
  clean = clean.replace(/[\uFE00-\uFE0F\u200D\u20E3]/g, "");

  // 2. Remove Dingbats, Box Drawing (══, ▬▬), Geometric shapes, Arrows
  clean = clean.replace(/[\u2190-\u21FF\u2300-\u23FF\u2460-\u24FF\u2500-\u257F\u2580-\u259F\u25A0-\u25FF\u2600-\u27BF\u2900-\u297F\u2B00-\u2BFF\u3030\u3200-\u32FF]/gu, "");

  // 3. Remove Markdown & decorative divider symbols
  clean = clean.replace(/[*_~|═▬]/g, "").replace(/\x60/g, "");

  // 4. Remove external links, telegram channels & usernames
  clean = clean.replace(/https?:\/\/[^\s]+/gi, "");
  clean = clean.replace(/t\.me\/[^\s]+/gi, "");
  clean = clean.replace(/@[a-zA-Z0-9_]+/g, "");

  // 5. Hide other phone numbers
  clean = clean.replace(/(?:\+251|251|0)?[\s.-]?[97]\d(?:[\s.-]?\d){7}/g, "(Phone Hidden)");

  // 6. Clean whitespace & empty lines
  const lines = clean.split("\n")
    .map(line => line.trim())
    .filter(line => line.length > 0 && !/^[-=._:;!?, ]+$/.test(line));
  return lines.join("\n").trim();
}

// ============================================
// CATEGORY DETECTION
// ============================================
function detectCategory(text) {
  const lower = text.toLowerCase();
  if (/(car|toyota|suzuki|honda|bmw|benz|nissan|ford|hyundai|mazda|tucson|elantra|avante|byd|sealion|corolla|yaris|vitz|rav4|chery|tiggo|መኪና|ሱዙኪ|ቶዮታ|ሆንዳ|ባይድ|ተሽከርካሪ)/i.test(lower)) return "Cars";
  if (/(house|villa|condominium|condo|g\+1|g\+2|real estate|compound|ቤት|ቪላ|ኮንዶሚኒየም|ሪል እስቴት)/i.test(lower)) return "Houses";
  if (/(apartment|office|shop|rent|lease|hall|warehouse|አፓርታማ|ቢሮ|ሱቅ|ኪራይ|መጋዘን)/i.test(lower)) return "Rentals";
  if (/(iphone|samsung|laptop|computer|macbook|tv|camera|phone|ipad|ስልክ|ላፕቶፕ|ኮምፒውተር|ቴሌቪዥን)/i.test(lower)) return "Electronics";
  if (/(sofa|bed|table|chair|cupboard|wardrobe|furniture|ሶፋ|አልጋ|ጠረጴዛ|ወንበር|ቁምሳጥን|ፈርኒቸር)/i.test(lower)) return "Furniture";
  if (/(jacket|shoes|dress|suit|t-shirt|clothes|ጫማ|ጃኬት|ቀሚስ|ልብስ)/i.test(lower)) return "Clothes";
  if (/(plumber|electrician|painter|mechanic|driver|cleaner|service|ቧንቧ|ኤሌክትሪክ|ቀለም|ሹፌር|ሰርቪስ)/i.test(lower)) return "Labor & Services";
  return "ምንአለሽ ተራ";
}

// ============================================
// TITLE & PRICE (WITH COMMA FORMATTING)
// ============================================
function extractTitleAndPrice(text) {
  let detectedBrand = "";
  let detectedModel = "";
  let detectedYear = "";

  // 1. Direct field matches (Make: BYD, Model: Sealion 06 Ev, Year: 2025)
  const makeMatch = text.match(/(?:make|የመኪናው\s*ዓይነት)\s*[:=-]\s*([a-zA-Z0-9_-]+)/i);
  if (makeMatch && makeMatch[1]) detectedBrand = makeMatch[1].trim();

  const modelMatch = text.match(/(?:model|ሞዴል)\s*[:=-]\s*([a-zA-Z0-9 _-]+)/i);
  if (modelMatch && modelMatch[1]) detectedModel = modelMatch[1].trim();

  const yearMatch = text.match(/(?:year|ሞዴል\s*ዓመት)\s*[:=-]?\s*(20[0-2][0-9]|19[89][0-9])/i) || text.match(/\b(20[0-2][0-9]|19[89][0-9])\b/);
  if (yearMatch && yearMatch[1]) detectedYear = yearMatch[1].trim();

  const brands = [
    { en: "Toyota", am: "ቶዮታ" },
    { en: "Suzuki", am: "ሱዙኪ" },
    { en: "Hyundai", am: "ሀዩንዳይ" },
    { en: "BYD", am: "ባይድ" },
    { en: "Mercedes-Benz", am: "መርሰዲስ" },
    { en: "BMW", am: "ቢኤምደብሊው" },
    { en: "Honda", am: "ሆንዳ" },
    { en: "Chery", am: "ቼሪ" },
    { en: "Kia", am: "ኪያ" },
    { en: "Nissan", am: "ኒሳን" },
    { en: "Volkswagen", am: "ቮልስዋገን" },
    { en: "Ford", am: "ፎርድ" },
    { en: "Mitsubishi", am: "ሚትሱቢሺ" },
    { en: "Mazda", am: "ማዝዳ" },
    { en: "Lifan", am: "ሊፋን" }
  ];
  
  const models = [
    "Sealion", "Seagull", "Song", "Qin", "Han", "Tang", "Yuan", "Dolphin", "Atto 3", "Seal",
    "Corolla", "ኮሮላ", "Yaris", "ያሪስ", "Vitz", "ቪትዝ", "RAV4", "ራቭ4", "Prado", "ፕራዶ",
    "Land Cruiser", "Hilux", "ሃይሉክስ", "Swift", "ስዊፍት", "Dzire", "ዲዛይር", "Celerio",
    "Alto", "አልቶ", "Vitara", "Tucson", "ቱክሰን", "Elantra", "ኢላንትራ", "Avante", "አቫንቴ",
    "Santa Fe", "Sonata", "Accent", "Tiggo", "ቲጎ", "Camry", "ካምሪ"
  ];

  if (!detectedBrand) {
    for (const b of brands) {
      if (new RegExp(`\\b(${b.en}|${b.am})\\b`, "i").test(text)) {
        detectedBrand = b.en;
        break;
      }
    }
  }

  if (!detectedModel) {
    for (const m of models) {
      if (new RegExp(`\\b${m}\\b`, "i").test(text)) {
        detectedModel = m;
        break;
      }
    }
  }

  let title = "";
  if (detectedBrand) {
    title = [detectedBrand, detectedModel, detectedYear].filter(Boolean).join(" ");
  } else {
    const cleanLines = text
      .split("\n")
      .map(l => l.trim().replace(/^#+/, "").trim())
      .filter(l => l.length > 2 && !/^(urgent|very urgent|sale|አስቸኳይ|የሚሸጥ|ቀጥታ|ቀጥታለውይበትን)$/i.test(l));
    
    title = cleanLines[0] ? cleanLines[0].substring(0, 40) : "Featured Item";
  }

  // Comma-formatted Price: 7.400,000 -> 7,400,000 ETB
  let price = "0";
  const fullMatch = text.match(/(?:ዋጋ|price|etb|ብር)?\s*[:=-]?\s*([0-9]{1,3}(?:[.,][0-9]{3}){1,3}|[0-9]{5,10})\s*(?:ብር|etb|birr|million)?/i);
  if (fullMatch && fullMatch[1]) {
    const cleanDigits = fullMatch[1].replace(/[.,]/g, "");
    const num = parseInt(cleanDigits, 10);
    if (!isNaN(num) && num > 100) {
      price = num.toLocaleString("en-US");
    }
  }

  return { title, price };
}

// ============================================
// GOOGLE CLOUD OAUTH2 JWT FOR FIRESTORE
// ============================================
async function getFirebaseToken(env) {
  const sa = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
  const now = Math.floor(Date.now() / 1000);
  const header = btoa(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claimSet = btoa(JSON.stringify({
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/datastore",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now
  }));

  const pemHeader = "-----BEGIN PRIVATE KEY-----";
  const pemFooter = "-----END PRIVATE KEY-----";
  const pemContents = sa.private_key
    .replace(pemHeader, "")
    .replace(pemFooter, "")
    .replace(/\s+/g, "");
  const binaryDer = Uint8Array.from(atob(pemContents), c => c.charCodeAt(0));

  const key = await crypto.subtle.importKey(
    "pkcs8",
    binaryDer.buffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const unsignedToken = `${header}.${claimSet}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(unsignedToken)
  );

  const signedToken = `${unsignedToken}.${btoa(String.fromCharCode(...new Uint8Array(signature))).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_")}`;

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${signedToken}`
  });
  const tokenData = await tokenRes.json();
  return tokenData.access_token;
}
