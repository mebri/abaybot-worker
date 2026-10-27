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
  const message = update.message || update.channel_post;
  if (!message) return;

  // 🚨 1. ANTI-LOOP & EMPTY PROTECTION
  if (message.from && message.from.is_bot) return;
  
  const text = (message.text || message.caption || "").trim();
  if (text.includes("#Cars") || text.includes("#Electronics")) return;

  // ============================================
  // ALBUM LOGIC (Multiple Images)
  // ============================================
  if (message.media_group_id) {
    const groupId = message.media_group_id;
    
    // Add this image to the cache
    if (!albumCache.has(groupId)) {
      albumCache.set(groupId, { 
        images: [], 
        firstMessage: text.length > 3 ? message : null 
      });
    }
    
    const albumData = albumCache.get(groupId);
    
    // Add the image file_id
    if (message.photo && message.photo.length > 0) {
      albumData.images.push(message.photo[message.photo.length - 1].file_id);
    }

    // If this message has the text, save it as the primary message
    if (text.length > 3 && !albumData.firstMessage) {
      albumData.firstMessage = message;
    }

    // 🕒 Wait 2 seconds to let all album photos arrive, then process
    if (text.length > 3) {
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

  // 2. Save to Firebase
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

  const fbUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/ads`;
  await fetch(fbUrl, {
    method: "POST",
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
// HELPER FUNCTIONS
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

function extractTitleAndPrice(text) {
  let price = "";
  const priceMatch = text.match(/(?:price|peric|pris|ዋጋ|ETB|ብር|Birr)[\s:.]*([\d.,]+)/i);
  if (priceMatch) {
    let cleanedNum = priceMatch[1].replace(/[.,]/g, "");
    if (cleanedNum && !isNaN(cleanedNum)) price = Number(cleanedNum).toLocaleString("en-US");
  }
  if (!price || price === "0") {
    const fallbackMatch = text.match(/(\d{1,3}(?:[.,]\d{3})+)/);
    if (fallbackMatch) {
       let cleanedNum = fallbackMatch[1].replace(/[.,]/g, "");
       if (cleanedNum && !isNaN(cleanedNum)) price = Number(cleanedNum).toLocaleString("en-US");
    }
  }

  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  let title = lines[0] || "Untitled Ad";
  if (/(urgent|አስቸኳይ|sale|ሽያጭ|for sale)/i.test(title) && lines.length > 1) title = lines[1];
  if (title.length > 60) title = title.substring(0, 60) + "...";

  return { title, price };
}

async function getFirebaseToken(env) {
  const clientEmail = env.FIREBASE_CLIENT_EMAIL;
  const privateKey = env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n");
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = { iss: clientEmail, scope: "https://www.googleapis.com/auth/datastore", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 };
  const h = base64UrlEncodeString(JSON.stringify(header));
  const p = base64UrlEncodeString(JSON.stringify(payload));
  const signingInput = `${h}.${p}`;
  const pemContents = privateKey.replace("-----BEGIN PRIVATE KEY-----", "").replace("-----END PRIVATE KEY-----", "").replace(/\s/g, "");
  const binaryDer = Uint8Array.from(atob(pemContents), (c) => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey("pkcs8", binaryDer, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sigBuffer = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", cryptoKey, new TextEncoder().encode(signingInput));
  let binary = "";
  const bytes = new Uint8Array(sigBuffer);
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  const signature = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const jwt = `${signingInput}.${signature}`;
  const tokRes = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}` });
  const tokData = await tokRes.json();
  if (!tokData.access_token) throw new Error(JSON.stringify(tokData));
  return tokData.access_token;
}

function base64UrlEncodeString(str) {
  const base64 = btoa(unescape(encodeURIComponent(str)));
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
