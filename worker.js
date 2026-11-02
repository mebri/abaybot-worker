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
  if (update.edited_message || update.edited_channel_post) return;

  const message = update.message || update.channel_post;
  if (!message) return;

  if (message.from && message.from.is_bot) return;
  if (
    message.is_automatic_forward ||
    message.forward_from_chat ||
    (message.chat && (message.chat.type === "group" || message.chat.type === "supergroup"))
  ) {
    return;
  }
  
  const text = (message.text || message.caption || "").trim();
  
  // Anti-loop protection
  if (
    text.includes("✅ Official Ad Posted") ||
    text.includes("⚠️ Debug") ||
    text.includes("Yegna Gebeya")
  ) {
    return;
  }

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
  
  // ✅ ULTIMATE EMOJI KILLER (Removes ALL emojis, flags, symbols)
  let cleanText = messageText.replace(/\p{Extended_Pictographic}/gu, "");
  
  // Remove other formatting
  cleanText = cleanText.replace(/[*_~`|]/g, "");
  cleanText = cleanText.replace(/https?:\/\/[^\s]+/gi, "");
  cleanText = cleanText.replace(/t\.me\/[^\s]+/gi, "");
  cleanText = cleanText.replace(/@[a-zA-Z0-9_]+/g, "");
  cleanText = cleanText.replace(/(?:\+251|251|0)?[\s.-]?[97]\d(?:[\s.-]?\d){7}/g, "(Phone Hidden)");
  cleanText = cleanText.replace(/\n{3,}/g, "\n\n").replace(/[ \t]+/g, " ").trim();

  const category = detectCategory(cleanText);
  const { title, price } = extractTitleAndPrice(cleanText);

  // ============================================
  // DEBUG MESSAGE: Tell the channel what the bot is doing
  // ============================================
  try {
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ 
        chat_id: message.chat.id, 
        text: `⚠️ Debug: I am processing this ad.\nCleaned Text:\n${cleanText.substring(0, 100)}...` 
      }),
    });
  } catch (e) {}

  // ============================================
  // 1. Upload images to Cloudinary
  // ============================================
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

  // ============================================
  // 2. Save to Firebase
  // ============================================
  try {
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

    const docId = message.media_group_id 
      ? `album_${message.media_group_id}` 
      : `msg_${Math.abs(message.chat.id)}_${message.message_id}`;

    const fbUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/ads/${docId}`;
    await fetch(fbUrl, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(adData),
    });
  } catch (fbError) {
    console.error("Firebase save failed:", fbError);
  }

  // ============================================
  // 3. Build the Telegram Message
  // ============================================
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

  let newPostText = `✅ Official Ad Posted!\n\n`;
  newPostText += `📝 Title: ${title}\n`;
  if (price && price !== "0") newPostText += `💰 Price: ${price} ETB\n`;
  newPostText += `\n📄 Details:\n${safeDetails}\n\n`;
  newPostText += `━━━━━━━━━━━━━━━\n`;
  newPostText += `🏢 የኛ ገበያ (Yegna Gebeya)\n`;
  newPostText += `📞 Phone: 0911680790\n`;
  newPostText += `🌐 Website: mebri.yegna.workers.dev\n`;
  newPostText += `✈️ Telegram: @mebrigranite\n`;
  newPostText += `━━━━━━━━━━━━━━━\n\n`;
  newPostText += `${hashtag}`; 

  // ============================================
  // 4. Edit the caption (WITH FALLBACK)
  // ============================================
  try {
    let editRes;
    if (message.photo && message.photo.length > 0) {
      editRes = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/editMessageCaption`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
          chat_id: message.chat.id, 
          message_id: message.message_id,
          caption: newPostText.substring(0, 1024)
        }),
      });
    } else {
      editRes = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/editMessageText`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
          chat_id: message.chat.id, 
          message_id: message.message_id,
          text: newPostText.substring(0, 4096)
        }),
      });
    }
    
    const editData = await editRes.json();
    
    // 🚨 IF EDIT FAILS, DELETE AND REPOST
    if (!editData.ok) {
       await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/deleteMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: message.chat.id, message_id: message.message_id }),
       });

       if (imageUrls.length > 0) {
          await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendPhoto`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ 
              chat_id: message.chat.id, 
              photo: imageUrls[0], 
              caption: newPostText.substring(0, 1024)
            }),
          });
       } else {
          await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ 
              chat_id: message.chat.id, 
              text: newPostText.substring(0, 4096)
            }),
          });
       }
    }
  } catch (err) {
    console.error("Edit failed:", err);
  }
}

// ============================================
// HELPER FUNCTIONS
// ============================================
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
  const brands = ["Toyota", "Suzuki", "Hyundai", "Honda", "BYD", "Mercedes-Benz", "Benz", "BMW", "Nissan", "Ford", "Kia", "Chery", "Geely", "Volkswagen", "Audi", "Mitsubishi", "Mazda", "Land Rover", "Lexus", "Isuzu", "Lifan"];
  const models = ["Corolla", "Yaris", "Vitz", "RAV4", "Prado", "Land Cruiser", "Hilux", "Camry", "Swift", "Dzire", "Celerio", "Alto", "Vitara", "Tucson", "Elantra", "Avante", "Santa Fe", "Sonata", "Accent", "Creta", "Civic", "CR-V", "Fit", "Sealion", "Seagull", "Tiggo", "Arrizo", "Ranger", "Explorer", "Sportage", "Sorento", "Picanto"];

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
  const clientEmail = env.FIREBASE_CLIENT_EMAIL;
  const privateKey = env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n");
  const now = Math.floor(Date.now() / 1000);
  
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iss: clientEmail,
    scope: "https://www.googleapis.com/auth/datastore",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600
  };

  const h = base64UrlEncodeString(JSON.stringify(header));
  const p = base64UrlEncodeString(JSON.stringify(payload));
  const signingInput = `${h}.${p}`;

  const pemContents = privateKey.replace("-----BEGIN PRIVATE KEY-----", "").replace("-----END PRIVATE KEY-----", "").replace(/\s/g, "");
  const binaryDer = Uint8Array.from(atob(pemContents), c => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey("pkcs8", binaryDer, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  
  const sigBuffer = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", cryptoKey, new TextEncoder().encode(signingInput));
  const signature = base64UrlEncodeBytes(new Uint8Array(sigBuffer));
  const jwt = `${signingInput}.${signature}`;

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`
  });
  
  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) throw new Error(JSON.stringify(tokenData));
  return tokenData.access_token;
}

function base64UrlEncodeString(str) {
  const base64 = btoa(unescape(encodeURIComponent(str)));
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlEncodeBytes(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
