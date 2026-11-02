/**
 * Yegna Gebeya Telegram Bot - Cloudflare Worker
 * Features:
 * 1. Multimodal Gemini Vision: Detects Brand, Model, Year, Body & Color directly from photos
 * 2. Solves "Model 2022" year confusion -> Make: Hyundai, Model: Elantra, Year: 2022
 * 3. Title Arranger: "2022 Hyundai Elantra"
 * 4. Deterministic Firestore Doc IDs: Zero duplicate ads
 * 5. Full emoji stripping & Amharic contact preservation
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
  const message = update.message || update.channel_post;
  if (!message) return;

  // 1. Ignore linked discussion auto-forwards
  if (message.is_automatic_forward) return;

  // 2. Ignore repost target channel
  if (env.REPOST_CHANNEL_ID) {
    const target = String(env.REPOST_CHANNEL_ID).replace("@", "").toLowerCase();
    const currentId = String(message.chat.id);
    const currentUsername = (message.chat.username || "").toLowerCase();
    if (currentId === target || (currentUsername && currentUsername === target)) return;
  }

  // 3. Ignore bot messages
  const botId = env.TELEGRAM_BOT_TOKEN.split(":")[0];
  if (message.from && String(message.from.id) === botId) return;
  if (message.from && message.from.is_bot) return;

  const rawText = (message.text || message.caption || "").trim();

  // 4. Watermark check to avoid loops
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
  if (rawText.length < 3 && (!message.photo || message.photo.length === 0)) return;

  const images = [];
  if (message.photo && message.photo.length > 0) {
    images.push(message.photo[message.photo.length - 1].file_id);
  }

  await processFinalAd(message, images, [message.message_id], env);
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
// MAIN PROCESSING
// ============================================
async function processFinalAd(message, imageFileIds, messageIds, env) {
  const messageText = (message.text || message.caption || "").trim();
  const cleanText = cleanTheText(messageText);

  // 1. Text-based extraction
  let meta = extractBrandModelYear(cleanText || messageText);

  // 2. Upload images
  const imageUrls = await uploadImagesToCloudinary(imageFileIds, env);

  // 3. MULTIMODAL GEMINI VISION: Look at car photo if brand/model/year is missing or for verification
  if (imageUrls.length > 0 && env.GEMINI_API_KEY && (!meta.brand || !meta.model || !meta.year)) {
    try {
      const vision = await analyzeCarImageWithGemini(imageUrls[0], env);
      if (vision) {
        if (!meta.brand && vision.brand) meta.brand = vision.brand;
        if (!meta.model && vision.model) meta.model = vision.model;
        if (!meta.year && vision.year) meta.year = vision.year;
        if (!meta.trim && vision.trim) meta.trim = vision.trim;
        if (!meta.bodyType && vision.bodyType) meta.bodyType = vision.bodyType;
        if (!meta.suggestedSubcategory && vision.subcategory) meta.suggestedSubcategory = vision.subcategory;
      }
    } catch (e) {
      console.warn("Vision check bypassed:", e);
    }
  }

  // 4. Category & Subcategory
  const { category, subcategory } = determineCategoryAndSubcategory(cleanText, meta.brand, meta.model, meta.suggestedSubcategory);

  // 5. Arrange Title
  const title = arrangeTitle(cleanText, meta.brand, meta.model, meta.year, meta.trim, category, subcategory);

  // 6. Parse Price
  const { formattedPrice, rawPrice } = parseMathematicalPrice(cleanText || messageText, meta.year);

  // 7. Save to Firebase (deterministic docId prevents duplicates)
  const textHash = simpleHash((cleanText || title).toLowerCase().replace(/\s+/g, ""));
  try {
    const token = await getFirebaseToken(env);
    const projectId = env.FIREBASE_PROJECT_ID;
    const adOwnerId = env.ADMIN_UID || "admin_bot";

    const docId = message.media_group_id
      ? `tg_${message.chat.id}_${message.media_group_id}`
      : `ad_${textHash}`;

    const firestoreUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/ads/${docId}`;

    const adData = {
      fields: {
        title: { stringValue: title },
        description: { stringValue: cleanText || title },
        price: { doubleValue: parseFloat(rawPrice) || 0 },
        formattedPrice: { stringValue: `${formattedPrice} ETB` },
        category: { stringValue: category },
        subcategory: { stringValue: subcategory },
        brand: { stringValue: meta.brand || "Other" },
        model: { stringValue: meta.model || "" },
        year: { stringValue: meta.year || "" },
        trim: { stringValue: meta.trim || "" },
        images: {
          arrayValue: {
            values: imageUrls.map((url) => ({ stringValue: url }))
          }
        },
        contactPhone: { stringValue: extractPhone(messageText) || "0911680790" },
        location: { stringValue: extractLocation(messageText) },
        status: { stringValue: "approved" },
        createdAt: { timestampValue: new Date().toISOString() },
        userId: { stringValue: adOwnerId },
        source: { stringValue: "telegram_bot" },
        views: { integerValue: 0 }
      }
    };

    await fetch(firestoreUrl, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(adData)
    });
  } catch (err) {
    console.error("Firebase Error:", err);
  }

  // 8. Repost formatted ad to Telegram Channel
  const displayBrand = meta.brand ? meta.brand : "N/A";
  const displayModel = meta.model ? meta.model : "Standard";
  const displayYear = meta.year ? meta.year : "N/A";

  const fullCaption =
    `📝 Title: ${title}\n` +
    `🏷 Make: ${displayBrand} | Model: ${displayModel} | Year: ${displayYear}\n` +
    `📁 Category: ${category} › ${subcategory}\n` +
    `💰 Price: ${formattedPrice} ETB\n\n` +
    `📄 Details:\n${cleanText || title}\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `🏢 የኛ ገበያ (Yegna Gebeya)\n` +
    `📞 Phone: 0911680790\n` +
    `💬 Telegram: @mebrigranite\n` +
    `🌐 Web: https://yegnagebeya.com\n` +
    `#${category.replace(/[^a-zA-Z0-9_]/g, "_")}`;

  const repostTarget = env.REPOST_CHANNEL_ID;
  if (!repostTarget) return;

  if (imageFileIds.length > 1) {
    const media = imageFileIds.map((fileId, index) => {
      const item = { type: "photo", media: fileId };
      if (index === 0) item.caption = safeSubstring(fullCaption, 1024);
      return item;
    });
    await callTelegram("sendMediaGroup", { chat_id: repostTarget, media }, env);
  } else if (imageFileIds.length === 1) {
    await callTelegram("sendPhoto", {
      chat_id: repostTarget,
      photo: imageFileIds[0],
      caption: safeSubstring(fullCaption, 1024)
    }, env);
  } else {
    await callTelegram("sendMessage", {
      chat_id: repostTarget,
      text: safeSubstring(fullCaption, 4096)
    }, env);
  }
}

// ============================================
// GEMINI VISION INSPECTOR (LOOK AT CAR PHOTO)
// ============================================
async function analyzeCarImageWithGemini(imageUrl, env) {
  if (!env.GEMINI_API_KEY || !imageUrl) return null;
  try {
    const imgRes = await fetch(imageUrl);
    if (!imgRes.ok) return null;
    const arrayBuffer = await imgRes.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    const base64Image = btoa(binary);
    const mimeType = (imgRes.headers.get("content-type") || "image/jpeg").split(";")[0];

    const prompt = `Analyze this vehicle or marketplace item image.
Identify:
1. Make / Brand (e.g., Hyundai, BYD, Toyota, Apple)
2. Model (e.g., Elantra, Sealion 06, RAV4, iPhone 16 Pro Max)
3. Production Year or Generation (e.g., 2022)
4. Trim if visible (e.g., Champion Edition, Limited)
5. Body Type (e.g., Sedan, SUV / Crossover, Hatchback, Pickup)
6. Color (e.g., Silver, Dark Green, White)
7. Subcategory (e.g., Sedan, SUV / Crossover, Electric (EV))

Respond ONLY in valid JSON:
{
  "brand": "Hyundai",
  "model": "Elantra",
  "year": "2022",
  "trim": "",
  "bodyType": "Sedan",
  "color": "Silver",
  "subcategory": "Sedan"
}`;

    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${env.GEMINI_API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: prompt },
              {
                inline_data: {
                  mime_type: mimeType,
                  data: base64Image
                }
              }
            ]
          }
        ],
        generationConfig: {
          response_mime_type: "application/json"
        }
      })
    });

    const data = await res.json();
    const rawOutput = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!rawOutput) return null;
    return JSON.parse(rawOutput);
  } catch (err) {
    console.warn("Vision error:", err);
    return null;
  }
}

// ============================================
// BRAND, MODEL, AND YEAR EXTRACTION
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

  // Handle "Model 2022" as production year
  if (model && /^(?:19|20)\d{2}(?:\/\d{1,2})?$/.test(model)) {
    if (!year) year = model;
    model = "";
  }

  const trimMatch = text.match(/(?:Trim|ትሪም|Edition)[\s:=-]+([a-zA-Z0-9\s/._-]+)/i);
  if (trimMatch && trimMatch[1]) trim = trimMatch[1].split("\n")[0].trim();

  const bodyMatch = text.match(/(?:Body\s*Type|የቦዲ\s*ዓይነት)[\s:=-]+([a-zA-Z0-9\s/._-]+)/i);
  if (bodyMatch && bodyMatch[1]) bodyType = bodyMatch[1].split("\n")[0].trim();

  const fuelMatch = text.match(/(?:Fuel|ነዳጅ)[\s:=-]+([a-zA-Z0-9\s/._-]+)/i);
  if (fuelMatch && fuelMatch[1]) fuelType = fuelMatch[1].split("\n")[0].trim();

  const carDatabase = [
    {
      name: "Hyundai",
      pattern: /\b(hyundai|ሂዩንዳይ)\b/i,
      models: [
        { name: "Tucson", pattern: /tucson|ቱክሰን/i, subcategory: "SUV / Crossover" },
        { name: "Elantra", pattern: /elantra|ኤላንትራ/i, subcategory: "Sedan" },
        { name: "Avante", pattern: /avante|አቫንቴ/i, subcategory: "Sedan" },
        { name: "Creta", pattern: /creta|ክሬታ/i, subcategory: "SUV / Crossover" },
        { name: "Santa Fe", pattern: /santa\s*fe|ሳንታፌ/i, subcategory: "SUV / Crossover" }
      ]
    },
    {
      name: "BYD",
      pattern: /\b(byd|ባይድ)\b/i,
      models: [
        { name: "Sealion 06 EV", pattern: /sealion\s*06/i, subcategory: "Electric (EV)" },
        { name: "Sealion 07", pattern: /sealion\s*07/i, subcategory: "Electric (EV)" },
        { name: "Seagull", pattern: /seagull/i, subcategory: "Electric (EV)" },
        { name: "Song Plus", pattern: /song\s*plus/i, subcategory: "Electric (EV)" },
        { name: "Atto 3", pattern: /atto\s*3/i, subcategory: "Electric (EV)" },
        { name: "Han", pattern: /\bhan\b/i, subcategory: "Electric (EV)" },
        { name: "Dolphin", pattern: /dolphin/i, subcategory: "Electric (EV)" }
      ]
    },
    {
      name: "Toyota",
      pattern: /\b(toyota|ቶዮታ)\b/i,
      models: [
        { name: "Corolla", pattern: /corolla|ኮሮላ/i, subcategory: "Sedan" },
        { name: "RAV4", pattern: /rav\s*4|ራቭ\s*4/i, subcategory: "SUV / Crossover" },
        { name: "Land Cruiser", pattern: /land\s*cruiser|ላንድ\s*ክሩዘር/i, subcategory: "SUV / Crossover" },
        { name: "Prado", pattern: /prado|ፕራዶ/i, subcategory: "SUV / Crossover" },
        { name: "Hilux", pattern: /hilux|ሃይሉክስ/i, subcategory: "Pickup / Truck" },
        { name: "Yaris", pattern: /yaris|ያሪስ/i, subcategory: "Hatchback / Compact" },
        { name: "Vitz", pattern: /vitz|ቪትዝ/i, subcategory: "Hatchback / Compact" },
        { name: "Camry", pattern: /camry|ካምሪ/i, subcategory: "Sedan" }
      ]
    },
    {
      name: "Suzuki",
      pattern: /\b(suzuki|ሱዙኪ)\b/i,
      models: [
        { name: "Swift", pattern: /swift|ስዊፍት/i, subcategory: "Hatchback / Compact" },
        { name: "Dzire", pattern: /dzire|ዲዛየር/i, subcategory: "Sedan" },
        { name: "Celerio", pattern: /celerio|ሴሌሪዮ/i, subcategory: "Hatchback / Compact" },
        { name: "Alto", pattern: /alto|አልቶ/i, subcategory: "Hatchback / Compact" },
        { name: "Vitara", pattern: /vitara|ቪታራ/i, subcategory: "SUV / Crossover" }
      ]
    }
  ];

  if (!brand) {
    for (const b of carDatabase) {
      if (b.pattern.test(text)) {
        brand = b.name;
        for (const m of b.models) {
          if (m.pattern.test(text)) {
            if (!model || /^\d+$/.test(model)) model = m.name;
            if (m.subcategory) suggestedSubcategory = m.subcategory;
            break;
          }
        }
        break;
      }
    }
  } else {
    const matchedBrandObj = carDatabase.find((b) => b.name.toLowerCase() === brand.toLowerCase());
    if (matchedBrandObj) {
      for (const m of matchedBrandObj.models) {
        if (m.pattern.test(text)) {
          if (!model || /^\d+$/.test(model)) model = m.name;
          if (m.subcategory) suggestedSubcategory = m.subcategory;
          break;
        }
      }
    }
  }

  if (!model || !brand) {
    for (const b of carDatabase) {
      for (const m of b.models) {
        if (m.pattern.test(text)) {
          if (!brand) brand = b.name;
          if (!model || /^\d+$/.test(model)) model = m.name;
          if (m.subcategory && !suggestedSubcategory) suggestedSubcategory = m.subcategory;
          break;
        }
      }
      if (brand && model) break;
    }
  }

  if (fuelType.toLowerCase().includes("electric") || /kwh|single motor|ev\b/i.test(text)) {
    if (!suggestedSubcategory) suggestedSubcategory = "Electric (EV)";
  } else if (bodyType.toLowerCase().includes("suv") || /suv/i.test(text)) {
    if (!suggestedSubcategory) suggestedSubcategory = "SUV / Crossover";
  }

  return { brand, model, year, trim, bodyType, fuelType, suggestedSubcategory };
}

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

  const cleanLines = text.split("\n").map((l) => l.trim()).filter((l) => l.length > 2 && !/(urgent|sale|ሽያጭ|ይደውሉ|ዋጋ)/i.test(l));
  if (cleanLines.length > 0) {
    let t = cleanLines[0];
    if (t.length > 55) t = safeSubstring(t, 55) + "…";
    return t;
  }
  return "Featured Listing";
}

function determineCategoryAndSubcategory(text, brand, model, suggestedSubcat) {
  const lower = text.toLowerCase();

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

  if (/(villa|condominium|condo|g\+1|g\+2|real estate|for sale|ሽያጭ)\b/i.test(lower) && /(ቤት|ቪላ|ኮንዶሚኒየም|ሪል እስቴት|ካሬ)/i.test(lower)) {
    let subcategory = "Villa / G+1/G+2";
    if (/(condo|condominium|ኮንዶሚኒየም)/i.test(lower)) subcategory = "Condominium";
    else if (/(apartment|አፓርታማ)/i.test(lower)) subcategory = "Apartment Sale";
    return { category: "Houses", subcategory };
  }

  if (/(rent|lease|ኪራይ|የሚከራይ|ለኪራይ|ወርሃዊ)\b/i.test(lower) || /(office|shop|hall|warehouse|ሱቅ|ቢሮ|መጋዘን)/i.test(lower)) {
    let subcategory = "Apartment Rent";
    if (/(office|ቢሮ)/i.test(lower)) subcategory = "Commercial / Office";
    else if (/(shop|ሱቅ)/i.test(lower)) subcategory = "Shop / Store";
    return { category: "Rentals", subcategory };
  }

  if (/(iphone|samsung|laptop|computer|macbook|ipad|phone|smartphone|tv|camera|ስልክ|ላፕቶፕ|ኮምፒውተር|ቴሌቪዥን)/i.test(lower)) {
    let subcategory = suggestedSubcat || "Smartphones & Tablets";
    if (/(laptop|macbook|computer|ላፕቶፕ)/i.test(lower)) subcategory = "Laptops & Computers";
    else if (/(tv|television|audio|ቴሌቪዥን)/i.test(lower)) subcategory = "TV & Home Entertainment";
    return { category: "Electronics", subcategory };
  }

  if (/(sofa|bed|table|chair|cupboard|wardrobe|furniture|ሶፋ|አልጋ|ጠረጴዛ|ወንበር|ቁምሳጥን)/i.test(lower)) {
    return { category: "Furniture", subcategory: "Home & Office Furniture" };
  }

  if (/(shoes|jacket|dress|suit|clothes|pants|ጫማ|ጃኬት|ቀሚስ|ልብስ)/i.test(lower)) {
    return { category: "Clothes", subcategory: "Fashion & Footwear" };
  }

  return { category: "ምንአለሽ_ተራ", subcategory: "General Marketplace" };
}

function parseMathematicalPrice(text, knownYear) {
  if (!text) return { formattedPrice: "0", rawPrice: "0" };

  const detectedYear = (knownYear ? knownYear.split("/")[0] : "") || "";

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
          return { formattedPrice: Math.round(val).toLocaleString("en-US"), rawPrice: Math.round(val).toString() };
        }
      }
    }

    const normalized = rawVal.replace(/\./g, "").replace(/,/g, "");
    const parsed = parseInt(normalized, 10);
    if (!isNaN(parsed) && parsed > 500) {
      return { formattedPrice: parsed.toLocaleString("en-US"), rawPrice: parsed.toString() };
    }
  }

  const millionMatch = text.match(/([0-9]+(?:\.[0-9]+)?)\s*(?:million|mil|mln|ሚሊዮን)\b/i);
  if (millionMatch && millionMatch[1]) {
    const val = parseFloat(millionMatch[1]);
    if (!isNaN(val) && val > 0 && val < 500) {
      const finalNum = Math.round(val * 1000000);
      return { formattedPrice: finalNum.toLocaleString("en-US"), rawPrice: finalNum.toString() };
    }
  }

  const currencyMatches = text.matchAll(/([0-9]{1,3}(?:[,.][0-9]{3})+|[0-9]{4,9})\s*(?:ETB|ብር|Birr)\b/gi);
  for (const m of currencyMatches) {
    const cleanNum = m[1].replace(/[,.]/g, "");
    if (detectedYear && cleanNum === detectedYear) continue;
    const val = parseInt(cleanNum, 10);
    if (!isNaN(val) && val > 500) {
      return { formattedPrice: val.toLocaleString("en-US"), rawPrice: val.toString() };
    }
  }

  return { formattedPrice: "Contact for Price", rawPrice: "0" };
}

function cleanTheText(text) {
  if (!text) return "";
  const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{1F1E6}-\u{1F1FF}\u{200D}\u{20E3}\u{2190}-\u{21FF}\u{25A0}-\u{25FF}\u{2B50}\u{1F004}\u{1F0CF}]/gu;
  return text
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/\b(?:t\.me|telegram\.me)\/\S+/gi, "")
    .replace(/@[a-zA-Z0-9_]{2,}/g, "")
    .replace(/▬+/g, "")
    .replace(/═+/g, "")
    .replace(/_+{3,}/g, "")
    .replace(/[-*#~`]{3,}/g, "")
    .replace(EMOJI, "")
    .replace(/[ \t]+/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function uploadImagesToCloudinary(fileIds, env) {
  if (!fileIds || fileIds.length === 0) return [];
  const urls = [];
  const cloudName = env.CLOUDINARY_CLOUD_NAME;
  const uploadPreset = env.CLOUDINARY_UPLOAD_PRESET;
  const botToken = env.TELEGRAM_BOT_TOKEN;

  for (const fileId of fileIds) {
    try {
      const fileRes = await fetch(`https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`);
      const fileData = await fileRes.json();
      if (!fileData.ok || !fileData.result.file_path) continue;

      const directTgUrl = `https://api.telegram.org/file/bot${botToken}/${fileData.result.file_path}`;
      if (!cloudName || !uploadPreset) {
        urls.push(directTgUrl);
        continue;
      }

      const form = new FormData();
      form.append("file", directTgUrl);
      form.append("upload_preset", uploadPreset);

      const cRes = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/image/upload`, {
        method: "POST",
        body: form
      });
      const cData = await cRes.json();
      if (cData.secure_url) {
        urls.push(cData.secure_url);
      } else {
        urls.push(directTgUrl);
      }
    } catch (e) {
      console.error("Cloudinary upload failed for", fileId, e);
    }
  }
  return urls;
}

function extractPhone(text) {
  const match = text.match(/(?:\+251|0)(9\d{8}|7\d{8})/);
  return match ? match[0] : "";
}

function extractLocation(text) {
  const lower = text.toLowerCase();
  if (/(bole bulbula|ቦሌ\s*ቡልቡላ)/i.test(lower)) return "Bole Bulbula";
  if (/(bole|ቦሌ)/i.test(lower)) return "Bole";
  if (/(cmc|ሲኤምሲ)/i.test(lower)) return "CMC";
  if (/(ayat|አያት)/i.test(lower)) return "Ayat";
  if (/(summit|ሰሚት)/i.test(lower)) return "Summit";
  if (/(sarbet|ሳርቤት)/i.test(lower)) return "Sarbet";
  if (/(gerji|ገርጂ)/i.test(lower)) return "Gerji";
  if (/(piassa|ፒያሳ)/i.test(lower)) return "Piassa";
  if (/(kazanchis|ካዛንቺስ)/i.test(lower)) return "Kazanchis";
  if (/(megenagna|መገናኛ)/i.test(lower)) return "Megenagna";
  if (/(hawassa|ሀዋሳ)/i.test(lower)) return "Hawassa";
  if (/(adama|አዳማ|nazret|ናዝሬት)/i.test(lower)) return "Adama";
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
  const sigBuffer = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", cryptoKey, new TextEncoder().encode(signingInput));
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
