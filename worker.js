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

  // 🚨 1. IGNORE EMPTY MESSAGES (Fixes Album issue)
  if (!message.text && !message.caption) return;
  const messageText = (message.text || message.caption || "").trim();
  if (messageText.length < 3) return; 

  // 🚨 2. ANTI-LOOP PROTECTION
  if (message.from && message.from.is_bot) return;
  if (messageText.includes("#Cars") || messageText.includes("#Electronics")) return;

  try {
    // ============================================
    // 3. CLEAN TEXT
    // ============================================
    let cleanText = messageText;
    cleanText = cleanText.replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{2700}-\u{27BF}\u{25A0}-\u{25FF}\u{2B50}\u{1F004}\u{1F0CF}]/gu, "");
    cleanText = cleanText.replace(/[*_~`|]/g, "");
    cleanText = cleanText.replace(/https?:\/\/[^\s]+/gi, "");
    cleanText = cleanText.replace(/t\.me\/[^\s]+/gi, "");
    cleanText = cleanText.replace(/@[a-zA-Z0-9_]+/g, "");
    cleanText = cleanText.replace(/(?:\+251|251|0)?[\s.-]?[97]\d(?:[\s.-]?\d){7}/g, "(Phone Hidden)");
    cleanText = cleanText.replace(/\n{3,}/g, "\n\n").replace(/[ \t]+/g, " ").trim();

    const lowerText = cleanText.toLowerCase();
    let category = "Other";
    let condition = "";
    let brand = "";
    let itemName = "";
    let price = "";
    let city = "";

    // ============================================
    // 4. CATEGORY DETECTION
    // ============================================
    if (/(car|toyota|suzuki|honda|bmw|benz|nissan|ford|hyundai|mazda|tucson|vehicle|engine|mileage|km|መኪና|ሱዙኪ|ቶዮታ|ሆንዳ|ቢኤምደብሊው|ተሽከርካሪ|ሞተር)/i.test(lowerText)) {
      category = "Cars";
    } else if (/(house|villa|condominium|condo|ቤት|ቪላ|ኮንዶሚኒየም)/i.test(lowerText)) {
      category = "Houses";
    } else if (/(apartment|office|shop|አፓርታማ|ቢሮ|ሱቅ|መጋዘን)/i.test(lowerText)) {
      category = "Rentals";
    } else if (/(iphone|samsung|tecno|infinix|phone|smartphone|laptop|computer|tv|camera|ስልክ|ሞባይል|ላፕቶፕ|ኮምፒውተር|ቲቪ|ቴሌቪዥን|ካሜራ)/i.test(lowerText)) {
      category = "Electronics";
    } else if (/(sofa|bed|table|chair|furniture|cabinet|ሶፋ|አልጋ|ጠረጴዛ|ጠረንጴዛ|ወንበር|ቁምሳጥን|እቃ)/i.test(lowerText)) {
      category = "Furniture";
    } else if (/(clothes|shoes|dress|shirt|pants|fashion|ልብስ|ጫማ|ቀሚስ|ሱሪ|ሸሚዝ)/i.test(lowerText)) {
      category = "Clothes";
    } else if (/(construction|electrician|plumber|painter|cleaning|worker|ግንባታ|ኤሌክትሪሺያን|ቧንቧ|ቀለም|ጽዳት|ሰራተኛ|ሠራተኛ)/i.test(lowerText)) {
      category = "Labor & Services";
    } else if (/(used|second-hand|ምንአለሽ ተራ|ያገለገለ)/i.test(lowerText)) {
      category = "ምንአለሽ_ተራ";
    }

    // ============================================
    // 5. CONDITION DETECTION
    // ============================================
    if (category === "Cars") {
      if (/(brand new|new|አዲስ|አዲስ መኪና)/i.test(lowerText)) condition = "New";
      else if (/(electric|ኤሌክትሪክ|ኢቪ|ev)/i.test(lowerText)) condition = "Electric";
      else if (/(rent|ኪራይ|for rent)/i.test(lowerText)) condition = "Rent";
      else condition = "Used";
    } else if (category === "Electronics" || category === "Furniture" || category === "Clothes") {
      if (/(brand new|new|አዲስ)/i.test(lowerText)) condition = "New";
      else condition = "Used";
    }

    // ============================================
    // 6. EXTRACT TITLE, PRICE, CITY
    // ============================================
    const makeMatch = cleanText.match(/(?:make|brand)[\s:.-]+([a-zA-Z\s]+)/i);
    if (makeMatch && !brand) brand = makeMatch[1].trim();
    
    const modelMatch = cleanText.match(/(?:model)[\s:.-]+([a-zA-Z0-9\s.-]+)/i);
    if (modelMatch && !itemName) itemName = modelMatch[1].trim();

    let title = `${brand} ${itemName}`.replace(/\s+/g, " ").trim();
    
    if (!title || title.length < 3) {
      const lines = cleanText.split("\n").map((l) => l.trim()).filter(Boolean);
      title = lines[0] || "Untitled Ad";
      if (/(urgent|አስቸኳይ|sale|ሽያጭ)/i.test(title) && lines.length > 1) title = lines[1];
    }
    if (title.length > 60) title = title.substring(0, 60) + "...";

    const priceMatch = cleanText.match(/(?:price|peric|pris|ዋጋ|ETB|ብር|Birr)[\s:.]*([\d.,]+)/i);
    if (priceMatch) {
      let cleanedNum = priceMatch[1].replace(/[.,]/g, "");
      if (cleanedNum && !isNaN(cleanedNum)) price = Number(cleanedNum).toLocaleString("en-US");
    }

    // ============================================
    // 7. UPLOAD IMAGE & SAVE TO FIREBASE
    // ============================================
    let imageUrl = "";
    if (message.photo && message.photo.length > 0) {
      try {
        const largest = message.photo[message.photo.length - 1];
        const fileRes = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getFile?file_id=${largest.file_id}`);
        const fileInfo = await fileRes.json();

        if (fileInfo.ok) {
          const imgRes = await fetch(`https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${fileInfo.result.file_path}`);
          const blob = await imgRes.blob();
          const formData = new FormData();
          formData.append("file", blob);
          formData.append("upload_preset", env.CLOUDINARY_UPLOAD_PRESET);

          const cloudRes = await fetch(`https://api.cloudinary.com/v1_1/${env.CLOUDINARY_CLOUD_NAME}/image/upload`, { method: "POST", body: formData });
          const cloudData = await cloudRes.json();
          if (cloudData.secure_url) imageUrl = cloudData.secure_url;
        }
      } catch (e) {}
    }

    const token = await getFirebaseToken(env);
    const projectId = env.FIREBASE_PROJECT_ID;
    const adOwnerId = env.ADMIN_UID || "admin_bot"; 

    const adData = {
      fields: {
        title: { stringValue: title },
        description: { stringValue: cleanText }, 
        price: { stringValue: price || "0" },
        phone: { stringValue: "0911680790" }, 
        city: { stringValue: city },
        category: { stringValue: category },
        condition: { stringValue: condition }, 
        brand: { stringValue: brand },
        itemName: { stringValue: itemName },
        image: { stringValue: imageUrl },
        images: { arrayValue: imageUrl ? { values: [{ stringValue: imageUrl }] } : { values: [] } },
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

    // ============================================
    // 8. EDIT CAPTION (WITH ERROR CHECKING)
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

    let newPostText = `${cleanText}\n\n${hashtag}`; 

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
      
      // ✅ If the edit fails, tell the channel why
      if (!editData.ok) {
         await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ 
              chat_id: message.chat.id, 
              text: `⚠️ Edit failed: ${editData.description}` 
            }),
         });
      }

    } catch (err) {
       console.error("Failed to edit message", err);
    }

  } catch (error) {
    console.error("Main Error:", error);
  }
}

// ============================================
// FIREBASE AUTH HELPER
// ============================================
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
    exp: now + 3600,
  };

  const h = base64UrlEncodeString(JSON.stringify(header));
  const p = base64UrlEncodeString(JSON.stringify(payload));
  const signingInput = `${h}.${p}`;

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

  let binary = "";
  const bytes = new Uint8Array(sigBuffer);
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const signature = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const jwt = `${signingInput}.${signature}`;

  const tokRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });

  const tokData = await tokRes.json();
  if (!tokData.access_token) throw new Error(JSON.stringify(tokData));
  return tokData.access_token;
}

function base64UrlEncodeString(str) {
  const base64 = btoa(unescape(encodeURIComponent(str)));
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
