/**
 * Yegna Gebeya Telegram Bot - Cloudflare Worker
 * 
 * Features:
 * 1. Title Arranger: [Year] [Brand] [Model] [Trim]
 * 2. Brand, Model & Production Year Extractor
 * 3. Deep Category & Subcategory Classifier (Electric EV, SUV, Sedan, etc.)
 * 4. Real Ad Price Reference: Accurately calculates 7,400,000 ETB (Never guesses year 2025 as ETB 2,025)
 * 5. Zero Duplicates: Deterministic ad_${textHash} docId & auto-forward filtering
 * 6. Full Emoji & Text Cleaning (Preserves Amharic characters)
 */

const albumCache = new Map();
let cachedFirebaseToken = null;
let tokenExpiresAt = 0;

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
  // 1. ANTI-DUPLICATE: Ignore edited messages
  if (update.edited_message || update.edited_channel_post) return;

  const message = update.message || update.channel_post;
  if (!message) return;

  // 2. Ignore bot messages
  const botId = env.TELEGRAM_BOT_TOKEN ? env.TELEGRAM_BOT_TOKEN.split(":")[0] : "";
  if (message.from && String(message.from.id) === botId) return;
  if (message.from && message.from.is_bot) return;

  // 3. Ignore target channel
  if (env.REPOST_CHANNEL_ID) {
    const target = String(env.REPOST_CHANNEL_ID).replace("@", "").toLowerCase();
    const currentId = String(message.chat.id);
    const currentUsername = (message.chat.username || "").toLowerCase();
    if (currentId === target || (currentUsername && currentUsername === target)) return;
  }

  // 4. ANTI-DUPLICATE: Ignore automatic forwards to linked discussion groups & group chats
  if (message.is_automatic_forward || message.forward_from_chat) return;
  if (message.chat && (message.chat.type === "group" || message.chat.type === "supergroup")) return;

  const rawText = (message.text || message.caption || "").trim();

  // 5. Strict Watermark Check
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

      await processFinalAd(finalData.firstMessage || message, Array.from(new Set(finalData.images)), finalData.messageIds, env);
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
// HASH FUNCTION (DETERMINISTIC DOCUMENT ID)
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

  // 1. Extract Brand, Model, Year, Trim, Body, Fuel
  const meta = extractBrandModelYear(cleanText || messageText);

  // 2. Determine Category and Subcategory
  const { category, subcategory } = determineCategoryAndSubcategory(cleanText, meta.brand, meta.model, meta.suggestedSubcategory);

  // 3. Arrange Standardized Title
  const title = arrangeTitle(cleanText, meta.brand, meta.model, meta.year, meta.trim, category, subcategory);

  // 4. Parse Real Price from Ad (Never guesses year 2025 as price)
  const { formattedPrice, rawPrice } = parseMathematicalPrice(cleanText || messageText, meta.year);

  // 5. Upload images to Cloudinary
  const imageUrls = await uploadImagesToCloudinary(imageFileIds, env);
  const textHash = simpleHash(cleanText.toLowerCase().replace(/\s+/g, ''));
  
  // 6. SAVE TO WEBSITE (FIREBASE) WITH STRUCTURED METADATA
  try {
    const token = await getFirebaseToken(env);
    const projectId = env.FIREBASE_PROJECT_ID;
    const adOwnerId = env.ADMIN_UID || "admin_bot";
    
    // Deterministic Document ID by textHash
    const docId = `ad_${textHash}`; 
    const fbUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/ads/${docId}`;

    let allImages = imageUrls;
    try {
      const checkRes = await fetch(fbUrl, { headers: { Authorization: `Bearer ${token}` } });
      if (checkRes.ok) {
        const existingData = await checkRes.json();
        
        // Strict duplicate check: If created in last 10 minutes, merge photos and skip duplicate repost
        if (existingData.fields?.createdAt?.timestampValue) {
          const createdTime = new Date(existingData.fields.createdAt.timestampValue).getTime();
          if (Date.now() - createdTime < 600000) {
            console.log("⏭️ Ignored: Duplicate text detected on website.");
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
        title: { stringValue: title },
        description: { stringValue: cleanText },
        brand: { stringValue: meta.brand || "" },
        model: { stringValue: meta.model || "" },
        year: { stringValue: meta.year || "" },
        trim: { stringValue: meta.trim || "" },
        bodyType: { stringValue: meta.bodyType || "" },
        fuelType: { stringValue: meta.fuelType || "" },
        category: { stringValue: category },
        subcategory: { stringValue: subcategory },
        textHash: { stringValue: textHash },
        price: { stringValue: formattedPrice },
        rawPrice: { integerValue: rawPrice },
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
    console.log("✅ Saved to Website (Firebase) with Brand, Model, Year & Price");
  } catch (fbErr) {
    console.error("Firebase Error:", fbErr.message);
  }

  // 7. Build Telegram Post with Arranged Title, Brand/Model and Subcategory
  const hashtagMap = { Cars: "#Cars", Houses: "#Houses", Rentals: "#Rentals", Electronics: "#Electronics", Furniture: "#Furniture", Clothes: "#Clothes", "Labor & Services": "#Labor", "ምንአለሽ_ተራ": "#ምንአለሽ_ተራ" };
  const hashtag = hashtagMap[category] || "#Other";
  const displayPriceText = formattedPrice && formattedPrice !== "0" ? `${formattedPrice} ETB` : "Negotiable / ተደራዳሪ";

  let safeDetails = safeSubstring(cleanText, 700);
  if (cleanText.length > 700) safeDetails = safeDetails.trimEnd() + "…";

  let newPostText = `📝 Title: ${title}\n`;
  if (meta.brand || meta.model || meta.year) {
    const metaParts = [];
    if (meta.brand) metaParts.push(`Make: ${meta.brand}`);
    if (meta.model) metaParts.push(`Model: ${meta.model}`);
    if (meta.year) metaParts.push(`Year: ${meta.year}`);
    newPostText += `🏷️ ${metaParts.join(" | ")}\n`;
  }
  newPostText += `📂 Category: ${category} › ${subcategory}\n`;
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

  let messageHandled = false;

  // 8. TRY TO EDIT IN PLACE
  try {
    if (isPhoto) {
      await callTelegram("editMessageCaption", { 
        chat_id: chatId, 
        message_id: message.message_id, 
        caption: safeSubstring(newPostText, 1024),
        caption_entities: []
      }, env);
    } else {
      await callTelegram("editMessageText", { 
        chat_id: chatId, 
        message_id: message.message_id, 
        text: safeSubstring(newPostText, 4096),
        entities: []
      }, env);
    }
    console.log("✅ Edited in place.");
    messageHandled = true;
  } catch (editErr) {
    console.log("⚠️ Edit failed. Deleting & Reposting...", editErr.message);
  }

  // 9. IF EDIT FAILED, DELETE AND REPOST
  if (!messageHandled) {
    try {
      if (messageIds.length === 1) {
        await callTelegram("deleteMessage", { chat_id: chatId, message_id: messageIds[0] }, env);
      } else {
        await callTelegram("deleteMessages", { chat_id: chatId, message_ids: messageIds }, env);
      }
    } catch (delErr) {}

    try {
      if (isPhoto) {
        await callTelegram("sendPhoto", { chat_id: chatId, photo: lastPhotoFileId, caption: safeSubstring(newPostText, 1024), caption_entities: [] }, env);
      } else {
        await callTelegram("sendMessage", { chat_id: chatId, text: safeSubstring(newPostText, 4096), entities: [] }, env);
      }
      console.log("✅ Sent clean message to main chat");
    } catch (repostErr) {
      console.error("❌ Failed to send clean message:", repostErr.message);
    }
  }

  // 10. SEND TO REPOST CHANNEL
  if (env.REPOST_CHANNEL_ID) {
    try {
      if (isPhoto) {
        await callTelegram("sendPhoto", { chat_id: env.REPOST_CHANNEL_ID, photo: lastPhotoFileId, caption: safeSubstring(newPostText, 1024), caption_entities: [] }, env);
      } else {
        await callTelegram("sendMessage", { chat_id: env.REPOST_CHANNEL_ID, text: safeSubstring(newPostText, 4096), entities: [] }, env);
      }
    } catch (chErr) {}
  }
}

// ============================================
// BRAND, MODEL & YEAR EXTRACTOR
// ============================================
function extractBrandModelYear(text) {
  let brand = "";
  let model = "";
  let year = "";
  let trim = "";
  let bodyType = "";
  let fuelType = "";
  let suggestedSubcategory = "";

  const makeMatch = text.match(/(?:Make|የመኪናው\s*ዓይነት|Brand|ብራንድ)[\s:=-]+([a-zA-Z0-9\s/._-]+)/i);
  if (makeMatch && makeMatch[1]) brand = makeMatch[1].split("\n")[0].trim();

  const modelMatch = text.match(/(?:Model|ሞዴል)[\s:=-]+([a-zA-Z0-9\s/._-]+)/i);
  if (modelMatch && modelMatch[1]) model = modelMatch[1].split("\n")[0].trim();

  const yearMatch = text.match(/(?:Year|ዓመተ\s*ምህረት)[\s:=-]+([0-9]{4}(?:\/[0-9]{1,2})?)/i);
  if (yearMatch && yearMatch[1]) {
    year = yearMatch[1].trim();
  } else {
    const rawYear = text.match(/\b(199\d|200\d|201\d|202[0-9])(?:\/([0-9]{1,2}))?\b/);
    if (rawYear) year = rawYear[0];
  }

  const trimMatch = text.match(/(?:Trim|ትሪም|Edition)[\s:=-]+([a-zA-Z0-9\s/._-]+)/i);
  if (trimMatch && trimMatch[1]) trim = trimMatch[1].split("\n")[0].trim();

  const bodyMatch = text.match(/(?:Body\s*Type|የቦዲ\s*ዓይነት)[\s:=-]+([a-zA-Z0-9\s/._-]+)/i);
  if (bodyMatch && bodyMatch[1]) bodyType = bodyMatch[1].split("\n")[0].trim();

  const fuelMatch = text.match(/(?:Fuel|ነዳጅ)[\s:=-]+([a-zA-Z0-9\s/._-]+)/i);
  if (fuelMatch && fuelMatch[1]) fuelType = fuelMatch[1].split("\n")[0].trim();

  const carDatabase = [
    { name: "BYD", pattern: /\b(byd|ባይድ)\b/i, models: [
      { name: "Sealion 06 EV", pattern: /sealion\s*06/i, subcategory: "Electric (EV)" },
      { name: "Sealion 07", pattern: /sealion\s*07/i, subcategory: "Electric (EV)" },
      { name: "Seagull", pattern: /seagull/i, subcategory: "Electric (EV)" },
      { name: "Song Plus", pattern: /song\s*plus/i, subcategory: "Electric (EV)" },
      { name: "Atto 3", pattern: /atto\s*3/i, subcategory: "Electric (EV)" },
      { name: "Han", pattern: /\bhan\b/i, subcategory: "Electric (EV)" },
      { name: "Dolphin", pattern: /dolphin/i, subcategory: "Electric (EV)" }
    ]},
    { name: "Toyota", pattern: /\b(toyota|ቶዮታ)\b/i, models: [
      { name: "Corolla", pattern: /corolla|ኮሮላ/i, subcategory: "Sedan" },
      { name: "RAV4", pattern: /rav\s*4|ራቭ\s*4/i, subcategory: "SUV / Crossover" },
      { name: "Land Cruiser", pattern: /land\s*cruiser|ላንድ\s*ክሩዘር/i, subcategory: "SUV / Crossover" },
      { name: "Prado", pattern: /prado|ፕራዶ/i, subcategory: "SUV / Crossover" },
      { name: "Hilux", pattern: /hilux|ሃይሉክስ/i, subcategory: "Pickup / Truck" },
      { name: "Yaris", pattern: /yaris|ያሪስ/i, subcategory: "Hatchback / Compact" },
      { name: "Vitz", pattern: /vitz|ቪትዝ/i, subcategory: "Hatchback / Compact" },
      { name: "Camry", pattern: /camry|ካምሪ/i, subcategory: "Sedan" }
    ]},
    { name: "Suzuki", pattern: /\b(suzuki|ሱዙኪ)\b/i, models: [
      { name: "Swift", pattern: /swift|ስዊፍት/i, subcategory: "Hatchback / Compact" },
      { name: "Dzire", pattern: /dzire|ዲዛየር/i, subcategory: "Sedan" },
      { name: "Celerio", pattern: /celerio|ሴሌሪዮ/i, subcategory: "Hatchback / Compact" },
      { name: "Alto", pattern: /alto|አልቶ/i, subcategory: "Hatchback / Compact" },
      { name: "Vitara", pattern: /vitara|ቪታራ/i, subcategory: "SUV / Crossover" }
    ]},
    { name: "Hyundai", pattern: /\b(hyundai|ሂዩንዳይ)\b/i, models: [
      { name: "Tucson", pattern: /tucson|ቱክሰን/i, subcategory: "SUV / Crossover" },
      { name: "Elantra", pattern: /elantra|ኤላንትራ/i, subcategory: "Sedan" },
      { name: "Avante", pattern: /avante|አቫንቴ/i, subcategory: "Sedan" },
      { name: "Creta", pattern: /creta|ክሬታ/i, subcategory: "SUV / Crossover" }
    ]},
    { name: "Apple", pattern: /\b(apple|iphone|ipad|macbook|አፕል|አይፎን)\b/i, models: [
      { name: "iPhone 16 Pro Max", pattern: /16\s*pro\s*max/i, subcategory: "Smartphones & Tablets" },
      { name: "iPhone 15 Pro Max", pattern: /15\s*pro\s*max/i, subcategory: "Smartphones & Tablets" },
      { name: "iPhone 15", pattern: /iphone\s*15/i, subcategory: "Smartphones & Tablets" },
      { name: "MacBook Pro", pattern: /macbook\s*pro/i, subcategory: "Laptops & Computers" }
    ]}
  ];

  if (!brand) {
    for (const b of carDatabase) {
      if (b.pattern.test(text)) {
        brand = b.name;
        for (const m of b.models) {
          if (m.pattern.test(text)) {
            if (!model) model = m.name;
            if (m.subcategory) suggestedSubcategory = m.subcategory;
            break;
          }
        }
        break;
      }
    }
  }

  if (fuelType.toLowerCase().includes("electric") || /kwh|single motor|ev\b/i.test(text)) {
    if (!suggestedSubcategory) suggestedSubcategory = "Electric (EV)";
  } else if (bodyType.toLowerCase().includes("suv") || /suv/i.test(text)) {
    if (!suggestedSubcategory) suggestedSubcategory = "SUV / Crossover";
  }

  return { brand, model, year, trim, bodyType, fuelType, suggestedSubcategory };
}

// ============================================
// ARRANGE CLEAN STANDARDIZED TITLE
// ============================================
function arrangeTitle(text, brand, model, year, trim, category, subcategory) {
  if (brand && model) {
    const cleanYear = year ? year.split("/")[0] : "";
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
    const cleanYear = year ? year.split("/")[0] : "";
    return [cleanYear, brand, subcategory].filter(Boolean).join(" ");
  }

  const cleanLines = text.split("\n").map(l => l.trim()).filter(l => l.length > 2 && !/(urgent|sale|ሽያጭ|ይደውሉ|ዋጋ)/i.test(l));
  if (cleanLines.length > 0) {
    let t = cleanLines[0];
    if (t.length > 55) t = safeSubstring(t, 55) + "…";
    return t;
  }
  return "Featured Listing";
}

// ============================================
// CATEGORY & SUBCATEGORY CLASSIFIER
// ============================================
function determineCategoryAndSubcategory(text, brand, model, suggestedSubcat) {
  const lower = text.toLowerCase();

  // CARS
  if (/(car|toyota|suzuki|honda|bmw|benz|byd|hyundai|mazda|tucson|elantra|avante|sealion|seagull|vehicle|engine|mileage|km|መኪና|ሱዙኪ|ቶዮታ|ሆንዳ|ባይድ|ተሽከርካሪ|ሞተር)/i.test(lower)) {
    let subcategory = suggestedSubcat || "Sedan";
    if (suggestedSubcat) {
      subcategory = suggestedSubcat;
    } else if (/(electric|kwh|battery|single motor|ev|ባትሪ|ቻርጅ)/i.test(lower)) {
      subcategory = "Electric (EV)";
    } else if (/(suv|crossover|4wd|4x4|rav4|prado|land cruiser|tucson)/i.test(lower)) {
      subcategory = "SUV / Crossover";
    } else if (/(pickup|truck|hilux|ranger|isuzu|d-max|ፒክአፕ)/i.test(lower)) {
      subcategory = "Pickup / Truck";
    } else if (/(hatchback|compact|vitz|swift|celerio|yaris|alto)/i.test(lower)) {
      subcategory = "Hatchback / Compact";
    }
    return { category: "Cars", subcategory };
  }

  // HOUSES
  if (/(villa|condominium|condo|g\+1|g\+2|real estate|for sale|ሽያጭ)\b/i.test(lower) && /(ቤት|ቪላ|ኮንዶሚኒየም|ሪል እስቴት|ካሬ)/i.test(lower)) {
    let subcategory = "Villa / G+1/G+2";
    if (/(condo|condominium|ኮንዶሚኒየም)/i.test(lower)) subcategory = "Condominium";
    else if (/(apartment|አፓርታማ)/i.test(lower)) subcategory = "Apartment Sale";
    return { category: "Houses", subcategory };
  }

  // RENTALS
  if (/(rent|lease|ኪራይ|የሚከራይ|ለኪራይ|ወርሃዊ)\b/i.test(lower) || /(office|shop|hall|warehouse|ሱቅ|ቢሮ|መጋዘን)/i.test(lower)) {
    let subcategory = "Apartment Rent";
    if (/(office|ቢሮ)/i.test(lower)) subcategory = "Commercial / Office";
    else if (/(shop|ሱቅ)/i.test(lower)) subcategory = "Shop / Store";
    return { category: "Rentals", subcategory };
  }

  // ELECTRONICS
  if (/(iphone|samsung|laptop|computer|macbook|ipad|phone|smartphone|tv|camera|ስልክ|ላፕቶፕ|ኮምፒውተር|ቴሌቪዥን)/i.test(lower)) {
    let subcategory = suggestedSubcat || "Smartphones & Tablets";
    if (/(laptop|macbook|computer|ላፕቶፕ)/i.test(lower)) subcategory = "Laptops & Computers";
    else if (/(tv|television|audio|ቴሌቪዥን)/i.test(lower)) subcategory = "TV & Home Entertainment";
    return { category: "Electronics", subcategory };
  }

  // FURNITURE
  if (/(sofa|bed|table|chair|cupboard|wardrobe|furniture|ሶፋ|አልጋ|ጠረጴዛ|ወንበር|ቁምሳጥን)/i.test(lower)) {
    return { category: "Furniture", subcategory: "Home & Office Furniture" };
  }

  // CLOTHES
  if (/(shoes|jacket|dress|suit|clothes|pants|ጫማ|ጃኬት|ቀሚስ|ልብስ)/i.test(lower)) {
    return { category: "Clothes", subcategory: "Fashion & Footwear" };
  }

  return { category: "ምንአለሽ_ተራ", subcategory: "General Marketplace" };
}

// ============================================
// ACCURATE PRICE PARSER (NEVER GUESSES YEARS)
// ============================================
function parseMathematicalPrice(text, knownYear) {
  if (!text) return { formattedPrice: "0", rawPrice: "0" };

  const detectedYear = (knownYear ? knownYear.split("/")[0] : "") || "";

  // 1. Check EXPLICIT PRICE line first (with 💰, Price, ዋጋ, fixed, etc.)
  // Matches: 💰Price: 7.400,000 ETB Million OR Price: 7.4 Million OR ዋጋ 7.4 ሚሊዮን
  const explicitLineMatch = text.match(/(?:💰|price|ዋጋ|fixed|የመሸጫ\s*ዋጋ)\s*[:=.-]?\s*([0-9.,]+)\s*(?:ETB|ብር|Birr)?\s*(?:million|mil|mln|m|ሚሊዮን)?/i);
  if (explicitLineMatch && explicitLineMatch[1]) {
    const rawVal = explicitLineMatch[1];
    const isMillion = /(?:million|mil|mln|m|ሚሊዮን)/i.test(explicitLineMatch[0]);

    if (isMillion) {
      const cleanNum = rawVal.replace(/,/g, "");
      const val = parseFloat(cleanNum);
      if (!isNaN(val) && val > 0) {
        if (val < 1000) {
          const finalNum = Math.round(val * 1000000);
          return { formattedPrice: finalNum.toLocaleString("en-US"), rawPrice: finalNum.toString() };
        } else {
          const finalNum = Math.round(val);
          return { formattedPrice: finalNum.toLocaleString("en-US"), rawPrice: finalNum.toString() };
        }
      }
    } else {
      const num = parseInt(rawVal.replace(/[.,]/g, ""), 10);
      if (!isNaN(num) && num > 100 && num.toString() !== detectedYear) {
        return { formattedPrice: num.toLocaleString("en-US"), rawPrice: num.toString() };
      }
    }
  }

  // 2. Matches general Million patterns: "7.400,000 ETB Million", "7.4 Million", "7.4 ሚሊዮን"
  const generalMillionMatch = text.match(/([0-9]+(?:[.,][0-9]+)*)\s*(?:ETB|ብር|Birr)?\s*(?:million|mil|mln|m|ሚሊዮን)\b/i);
  if (generalMillionMatch && generalMillionMatch[1]) {
    const rawVal = generalMillionMatch[1];
    const cleanNum = rawVal.replace(/,/g, "");
    const val = parseFloat(cleanNum);
    if (!isNaN(val) && val > 0) {
      if (val < 1000) {
        const finalNum = Math.round(val * 1000000);
        return { formattedPrice: finalNum.toLocaleString("en-US"), rawPrice: finalNum.toString() };
      } else {
        const finalNum = Math.round(val);
        return { formattedPrice: finalNum.toLocaleString("en-US"), rawPrice: finalNum.toString() };
      }
    }
  }

  // 3. Matches general Thousand patterns: "850k", "500 thousand", "500 ሺህ"
  const thousandMatch = text.match(/([0-9]+(?:[.,][0-9]+)*)\s*(?:ETB|ብር|Birr)?\s*(?:k|thousand|ሺህ|ሺ)\b/i);
  if (thousandMatch && thousandMatch[1]) {
    const rawVal = thousandMatch[1];
    const val = parseFloat(rawVal.replace(/,/g, ""));
    if (!isNaN(val) && val > 0 && val < 10000) {
      const finalNum = Math.round(val * 1000);
      return { formattedPrice: finalNum.toLocaleString("en-US"), rawPrice: finalNum.toString() };
    }
  }

  // 4. Matches explicit currency tags: "7,400,000 ETB", "ETB 7,400,000", "7,400,000 ብር"
  const currencyMatch = text.match(/(?:ETB|ብር|Birr)\s*[:=.-]?\s*([0-9]{1,3}(?:[.,][0-9]{3})+|[0-9]{5,10})|([0-9]{1,3}(?:[.,][0-9]{3})+|[0-9]{5,10})\s*(?:ETB|ብር|Birr)/i);
  if (currencyMatch) {
    const rawVal = currencyMatch[1] || currencyMatch[2];
    if (rawVal) {
      const num = parseInt(rawVal.replace(/[.,]/g, ""), 10);
      if (!isNaN(num) && num > 100 && num.toString() !== detectedYear) {
        return { formattedPrice: num.toLocaleString("en-US"), rawPrice: num.toString() };
      }
    }
  }

  // 5. DO NOT GUESS STANDALONE NUMBERS!
  // If no price or currency keyword is present in the ad, return 0 (Negotiable / ተደራዳሪ).
  // Never guess years like 2025 or mileage 3,000 as price!
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
  if (/(አዲስ አበባ|addis ababa|finfinne|bole|sarbet|cmc|gerji|piassa)/i.test(lower)) return "Addis Ababa";
  if (/(hawassa|ሀዋሳ)/i.test(lower)) return "Hawassa";
  if (/(adama|አዳማ|nazret)/i.test(lower)) return "Adama";
  if (/(bahir dar|ባህር ዳር)/i.test(lower)) return "Bahir Dar";
  if (/(dire dawa|ድሬዳዋ)/i.test(lower)) return "Dire Dawa";
  return "Addis Ababa";
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
