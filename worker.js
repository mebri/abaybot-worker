// Temporary cache to hold album images
const albumCache = new Map();

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
  // 🚨 1. ANTI-LOOP & DUPLICATE PROTECTION
  if (update.edited_message || update.edited_channel_post) return;

  const message = update.message || update.channel_post;
  if (!message) return;

  if (message.from && message.from.is_bot) return;

  // Stop duplicates from discussion groups and automatic forwards
  if (
    message.is_automatic_forward ||
    message.forward_from_chat ||
    (message.chat && (message.chat.type === "group" || message.chat.type === "supergroup"))
  ) {
    return;
  }
  
  const text = (message.text || message.caption || "").trim();
  if (
    text.includes("#Cars") ||
    text.includes("#Electronics") ||
    text.includes("Yegna Gebeya") ||
    text.includes("የኛ ገበያ") ||
    text.includes("0911680790")
  ) {
    return;
  }

  // ============================================
  // ALBUM LOGIC (Multiple Images)
  // ============================================
  if (message.media_group_id) {
    const groupId = message.media_group_id;
    
    // Add this image to the cache
    if (!albumCache.has(groupId)) {
      albumCache.set(groupId, { 
        images: [], 
        firstMessage: text.length > 3 ? message : null,
        processing: false
      });
    }
    
    const albumData = albumCache.get(groupId);
    
    // Add the image file_id
    if (message.photo && message.photo.length > 0) {
      const fileId = message.photo[message.photo.length - 1].file_id;
      if (!albumData.images.includes(fileId)) {
        albumData.images.push(fileId);
      }
    }

    // If this message has the text, save it as the primary message
    if (text.length > 3 && !albumData.firstMessage) {
      albumData.firstMessage = message;
    }

    // 🕒 Wait 2 seconds only once per album to let all photos arrive, then process
    if (text.length > 3 && !albumData.processing) {
      albumData.processing = true;
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // If the album was deleted from cache by another thread, stop
      if (!albumCache.has(groupId)) return;
      
      const finalData = albumCache.get(groupId);
      albumCache.delete(groupId); // Clear cache
      
      // Process the complete album
      await processFinalAd(
        finalData.firstMessage || message, 
        finalData.images, 
        env
      );
    }
    return;
  }

  // ============================================
  // SINGLE IMAGE OR TEXT-ONLY LOGIC
  // ============================================
  if (text.length < 3) return;
  
  const images = [];
  if (message.photo && message.photo.length > 0) {
    images.push(message.photo[message.photo.length - 1].file_id);
  }

  await processFinalAd(message, images, env);
}

// ============================================
// MAIN PROCESSING FUNCTION
// ============================================
async function processFinalAd(message, imageFileIds, env) {
  const messageText = (message.text || message.caption || "").trim();
  const cleanText = cleanTheText(messageText);
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
        const cloudRes = await fetch(`https://api.cloudinary.com/v1_1/${env.CLOUDINARY_CLOUD_NAME}/image/upload`, { method: "POST", body: formData });
        const cloudData = await cloudRes.json();
        if (cloudData.secure_url) imageUrls.push(cloudData.secure_url);
      }
    } catch (e) {}
  }

  // 2. Save to Firebase (⚡ DEDUPLICATED VIA DETERMINISTIC ID & PATCH)
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

  // ⚡ Deterministic ID prevents duplicate documents in Firestore
  const docId = message.media_group_id 
    ? `album_${message.media_group_id}` 
    : `msg_${Math.abs(message.chat.id)}_${message.message_id}`;

  const fbUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/ads/${docId}`;
  await fetch(fbUrl, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(adData),
  });

  // 3. Build the Telegram Message (With Business Card)
  let hashtag = "#Other";
  if (category === "Cars") hashtag = "#Cars";
  else if (category === "Houses") hashtag = "#Houses";
  else if (category === "Rentals") hashtag = "#Rentals";
  else if (category === "Electronics") hashtag = "#Electronics";
  else if (category === "Furniture") hashtag = "#Furniture";
  else if (category === "Clothes") hashtag = "#Clothes";
  else if (category === "Labor & Services") hashtag = "#Labor";
  else if (category === "ምንአለሽ_ተራ") hashtag = "#ምንአለሽ_ተራ";

  let safeDetails = cleanText.substring(0, 500); 
  if (cleanText.length > 500) safeDetails += "...";

  let newPostText = `📝 Title: ${title}\n`;
  if (price && price !== "0") newPostText += `💰 Price: ${price} ETB\n`;
  newPostText += `\n📄 Details:\n${safeDetails}\n\n`;
  newPostText += `━━━━━━━━━━━━━━━\n`;
  newPostText += `🏢 የኛ ገበያ (Yegna Gebeya)\n`;
  newPostText += `📞 Phone: 0911680790\n`;
  newPostText += `🌐 Website: mebri.yegna.workers.dev\n`;
  newPostText += `✈️ Telegram: @mebrigranite\n`;
  newPostText += `━━━━━━━━━━━━━━━\n\n`;
  newPostText += `${hashtag}`; 

  // 4. Edit the caption
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
// HELPER FUNCTIONS (UNTOUCHED)
// ============================================
function cleanTheText(text) {
  let cleanText = text;
  cleanText = cleanText.replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{2700}-\u{27BF}\u{25A0}-\u{25FF}\u{2B50}\u{1F004}\u{1F0CF}]/gu, "");
  cleanText = cleanText.replace(/[*_~`|]/g, "");
  cleanText = cleanText.replace(/https?:\/\/[^\s]+/gi, "");
  cleanText = cleanText.replace(/t\.me\/[^\s]+/gi, "");
  cleanText = cleanText.replace(/@[a-zA-Z0-9_]+/g, "");
  cleanText = cleanText.replace(/(?:\+251|251|0)?[\s.-]?[97]\d(?:[\s.-]?\d){7}/g, "(Phone Hidden)");
  cleanText = cleanText.replace(/\n{3,}/g, "\n\n").replace(/[ \t]+/g, " ").trim();
  return cleanText;
}

function detectCategory(text) {
  const lowerText = text.toLowerCase();
  if (/(car|toyota|suzuki|honda|bmw|benz|nissan|ford|hyundai|mazda|tucson|elantra|avante|byd|corolla|yaris|vitz|rav4|chery|tiggo|sealion|መኪና|ሱዙኪ|ቶዮታ|ሆንዳ|ባይድ|ተሽከርካሪ)/i.test(lowerText)) return "Cars";
  if (/(house|villa|condominium|condo|g\+1|g\+2|real estate|compound|ቤት|ቪላ|ኮንዶሚኒየም|ሪል እስቴት)/i.test(lowerText)) return "Houses";
  if (/(apartment|office|shop|rent|lease|hall|warehouse|አፓርታማ|ቢሮ|ሱቅ|ኪራይ|መጋዘን)/i.test(lowerText)) return "Rentals";
  if (/(iphone|samsung|laptop|computer|macbook|tv|camera|phone|ipad|ስልክ|ላፕቶፕ|ኮምፒውተር|ቴሌቪዥን)/i.test(lowerText)) return "Electronics";
  if (/(sofa|bed|table|chair|cupboard|wardrobe|furniture|ሶፋ|አልጋ|ጠረጴዛ|ወንበር|ቁምሳጥን|ፈርኒቸር)/i.test(lowerText)) return "Furniture";
  if (/(jacket|shoes|dress|suit|t-shirt|clothes|ጫማ|ጃኬት|ቀሚስ|ልብስ)/i.test(lowerText)) return "Clothes";
  if (/(plumber|electrician|painter|mechanic|driver|cleaner|service|ቧንቧ|ኤሌክትሪክ|ቀለም|ሹፌር|ሰርቪስ)/i.test(lowerText)) return "Labor & Services";
  return "ምንአለሽ_ተራ";
}

function extractTitleAndPrice(text) {
  const brands = [
    "Toyota", "Suzuki", "Hyundai", "Honda", "BYD", "Mercedes-Benz", "Benz",
    "BMW", "Nissan", "Ford", "Kia", "Chery", "Geely", "Volkswagen", "Audi",
    "Mitsubishi", "Mazda", "Land Rover", "Lexus", "Isuzu", "Lifan"
  ];
  
  const models = [
    "Corolla", "Yaris", "Vitz", "RAV4", "Prado", "Land Cruiser", "Hilux", "Camry",
    "Swift", "Dzire", "Celerio", "Alto", "Vitara", "Tucson", "Elantra", "Avante",
    "Santa Fe", "Sonata", "Accent", "Creta", "Civic", "CR-V", "Fit", "Sealion", "Seagull",
    "Tiggo", "Arrizo", "Ranger", "Explorer", "Sportage", "Sorento", "Picanto"
  ];

  let detectedBrand = "";
  let detectedModel = "";
  let detectedYear = "";

  const makeMatch = text.match(/(?:make|የመኪናው\s*ዓይነት)\s*[:=-]\s*([a-zA-Z0-9_-]+)/i);
  if (makeMatch && makeMatch[1]) detectedBrand = makeMatch[1].trim();

  const modelMatch = text.match(/(?:model|ሞዴል)\s*[:=-]\s*([a-zA-Z0-9 _-]+)/i);
  if (modelMatch && modelMatch[1]) detectedModel = modelMatch[1].trim();

  const yearMatch = text.match(/\b(199\d|200\d|201\d|202\d)\b/);
  if (yearMatch) detectedYear = yearMatch[1];

  if (!detectedBrand) {
    for (const b of brands) {
      if (new RegExp(`\\b${b}\\b`, "i").test(text)) {
        detectedBrand = b;
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
    const lines = text.split("\n").map(l => l.trim()).filter(l => l.length > 2 && !l.startsWith("#"));
    title = lines[0] ? lines[0].substring(0, 40) : "Featured Item";
  }

  let price = "0";
  const priceMatches = text.match(/(?:ዋጋ|price|etb|ብር)?\s*[:=-]?\s*([0-9]{1,3}(?:[.,][0-9]{3})+|[0-9]{4,10})\s*(?:ብር|etb|birr|million)?/i);
  if (priceMatches && priceMatches[1]) {
    const rawDigits = priceMatches[1].replace(/[.,]/g, "");
    const num = parseInt(rawDigits, 10);
    if (!isNaN(num) && num > 100) {
      price = num.toLocaleString("en-US");
    }
  }

  return { title, price };
}

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
