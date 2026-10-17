export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/test") {
      return new Response("Worker is live", { status: 200 });
    }

    if (request.method !== "POST") {
      return new Response("Bot is running", { status: 200 });
    }

    try {
      const update = await request.json();
      const message = update.message || update.channel_post;
      if (!message) return new Response("OK", { status: 200 });

      const messageText = message.text || message.caption;
      if (!messageText) return new Response("OK", { status: 200 });

      // ============================================
      // ✅ 1. BULLETPROOF CLEANUP
      // ============================================
      let cleanText = messageText;

      // Remove Telegram links
      cleanText = cleanText.replace(/https?:\/\/t\.me\/[^\s]+/gi, "");
      // Remove general web links
      cleanText = cleanText.replace(/(https?:\/\/[^\s]+|www\.[^\s]+)/gi, "");
      // Remove @username handles
      cleanText = cleanText.replace(/@[a-zA-Z0-9_]+/g, "");
      // Remove phone numbers (handles +251, 09, 07, and spaces/dots)
      cleanText = cleanText.replace(/(?:\+251|251|0)[\s.-]?9[\d\s.-]{7,}/g, "");
      cleanText = cleanText.replace(/(?:\+251|251|0)[\s.-]?7[\d\s.-]{7,}/g, "");
      // Clean up extra blank lines
      cleanText = cleanText.replace(/\n{3,}/g, "\n\n").trim();

      const lowerText = cleanText.toLowerCase();

      // 2. DETECT LANGUAGE
      const isAmharic = /[\u1200-\u137F]/.test(cleanText);
      const language = isAmharic ? "am" : "en";

      // 3. SMART CATEGORY DETECTION
      let category = "Other";
      let subcategory = "";
      let condition = "";

      if (/#cars/i.test(cleanText) || /#መኪና/i.test(cleanText)) category = "Cars";
      else if (/#houses/i.test(cleanText) || /#ቤት/i.test(cleanText)) category = "Houses";
      else if (/#apartments/i.test(cleanText) || /#rentals/i.test(cleanText) || /#ኪራይ/i.test(cleanText)) category = "Rentals";
      else if (/#electronics/i.test(cleanText) || /#ኤሌክትሮኒክስ/i.test(cleanText)) category = "Electronics";
      else if (/#furniture/i.test(cleanText) || /#እቃ/i.test(cleanText)) category = "Furniture";
      else if (/#clothes/i.test(cleanText) || /#ልብስ/i.test(cleanText)) category = "Clothes";
      else if (/#labor/i.test(cleanText) || /#ሰራተኛ/i.test(cleanText)) category = "Labor & Services";
      else if (/#used/i.test(cleanText) || /#ምንአለሽ/i.test(cleanText)) category = "ምንአለሽ ተራ";

      if (category === "Other") {
        if (/(car|toyota|suzuki|honda|bmw|benz|nissan|ford|hyundai|mazda|vehicle|engine|mileage|km|መኪና|ሱዙኪ|ቶዮታ|ሆንዳ|ቢኤምደብሊው|ተሽከርካሪ|ሞተር)/i.test(lowerText)) category = "Cars";
        else if (/(house|villa|condominium|condo|ቤት|ቪላ|ኮንዶሚኒየም)/i.test(lowerText)) category = "Houses";
        else if (/(apartment|office|shop|አፓርታማ|ቢሮ|ሱቅ|መጋዘን)/i.test(lowerText)) category = "Rentals";
        else if (/(iphone|samsung|tecno|infinix|phone|smartphone|laptop|computer|tv|camera|ስልክ|ሞባይል|ላፕቶፕ|ኮምፒውተር|ቲቪ|ቴሌቪዥን|ካሜራ)/i.test(lowerText)) category = "Electronics";
        else if (/(sofa|bed|table|chair|furniture|cabinet|ሶፋ|አልጋ|ጠረጴዛ|ጠረንጴዛ|ወንበር|ቁምሳጥን|እቃ)/i.test(lowerText)) category = "Furniture";
        else if (/(clothes|shoes|dress|shirt|pants|fashion|ልብስ|ጫማ|ቀሚስ|ሱሪ|ሸሚዝ)/i.test(lowerText)) category = "Clothes";
        else if (/(construction|electrician|plumber|painter|cleaning|worker|ግንባታ|ኤሌክትሪሺያን|ቧንቧ|ቀለም|ጽዳት|ሰራተኛ|ሠራተኛ)/i.test(lowerText)) category = "Labor & Services";
        else if (/(used|second-hand|ምንአለሽ ተራ|ያገለገለ)/i.test(lowerText)) category = "ምንአለሽ ተራ";
      }

      // 4. DETECT SUBCATEGORY & CONDITION
      if (category === "Cars") {
        if (/(new|አዲስ)/i.test(lowerText)) condition = "New";
        else if (/(electric|ኤሌክትሪክ|ኢቪ)/i.test(lowerText)) condition = "Electric";
        else if (/(rent|ኪራይ)/i.test(lowerText)) condition = "Rent";
        else condition = "Used";
      } else if (category === "Electronics") {
        if (/(phone|smartphone|ስልክ|ሞባይል)/i.test(lowerText)) subcategory = "Phones";
        else if (/(laptop|computer|ላፕቶፕ|ኮምፒውተር)/i.test(lowerText)) subcategory = "Computers";
        else if (/(tv|television|ቲቪ)/i.test(lowerText)) subcategory = "TVs";
        if (/(new|አዲስ)/i.test(lowerText)) condition = "New";
        else condition = "Used";
      } else if (category === "Houses") {
        if (/(sale|ሽያጭ)/i.test(lowerText)) subcategory = "sale";
        else if (/(rent|ኪራይ)/i.test(lowerText)) subcategory = "rent";
      } else if (category === "Furniture") {
        if (/(sofa|ሶፋ)/i.test(lowerText)) subcategory = "Sofas";
        else if (/(bed|አልጋ)/i.test(lowerText)) subcategory = "Beds";
        else if (/(chair|table|ጠረጴዛ|ወንበር)/i.test(lowerText)) subcategory = "Chairs and Tables";
        if (/(new|አዲስ)/i.test(lowerText)) condition = "New";
        else condition = "Used";
      }

      // 5. PARSE MESSAGE
      const lines = cleanText.split("\n").map((l) => l.trim()).filter(Boolean);
      let title = lines[0] || "Untitled Ad";
      title = title.replace(/[‼️✅👉👇💥🔥⚡✨📌📢]+/g, "").trim();
      if (title.length > 60) title = title.substring(0, 60) + "...";

      let price = "";
      let city = "";

      for (const line of lines) {
        const priceMatch = line.match(/(?:price|peric|pris|ዋጋ|ETB|ብር)[\s:.\-]*([\d.,\s]+)\s*(MILLION|Million|BILLION|Billion|K\b|Thousand|THOUSAND|ሚሊዮን|ቢሊዮን|ሺህ)?/i);
        if (priceMatch && !price) {
          const rawNum = priceMatch[1].trim();
          const unit = (priceMatch[2] || "").toUpperCase();
          const cleaned = rawNum.replace(/\s/g, "");
          const thousandPattern = /^\d{1,3}([.,]\d{3})+$/;

          let numVal;
          if (thousandPattern.test(cleaned)) numVal = parseFloat(cleaned.replace(/[.,]/g, ""));
          else numVal = parseFloat(cleaned.replace(/,/g, ""));

          if (unit.includes("MILLION") || unit.includes("ሚሊዮን")) {
            if (numVal < 100000) numVal *= 1000000;
          } else if (unit.includes("BILLION") || unit.includes("ቢሊዮን")) {
            if (numVal < 100000) numVal *= 1000000000;
          } else if (unit.includes("THOUSAND") || unit === "K" || unit.includes("ሺህ")) {
            if (numVal < 1000) numVal *= 1000;
          }

          if (!isNaN(numVal) && numVal > 0) price = Math.round(numVal).toLocaleString("en-US");
        }

        const cityMatch = line.match(/(?:city|location|ከተማ)[\s:]+(.+)/i);
        if (cityMatch && !city) city = cityMatch[1].trim();
        else if (/addis|ababa|adama|hawassa|bahir dar|mekelle|gondar|jimma|dire dawa|bishoftu/i.test(line) && !city) city = line.trim();
      }

      // 6. UPLOAD IMAGE
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

      // 7. SAVE TO FIREBASE
      const token = await getFirebaseToken(env);
      const sa = JSON.parse(atob(env.FIREBASE_SERVICE_ACCOUNT));
      const adOwnerId = env.ADMIN_UID || "admin_bot"; 

      const adData = {
        fields: {
          title: { stringValue: title },
          description: { stringValue: cleanText },
          price: { stringValue: price || "0" },
          phone: { stringValue: "0911680790" }, 
          city: { stringValue: city },
          category: { stringValue: category },
          subcategory: { stringValue: subcategory }, 
          condition: { stringValue: condition }, 
          language: { stringValue: language },
          image: { stringValue: imageUrl },
          images: { arrayValue: imageUrl ? { values: [{ stringValue: imageUrl }] } : { values: [] } },
          status: { stringValue: "available" }, 
          source: { stringValue: "telegram" },
          userId: { stringValue: adOwnerId }, 
          views: { integerValue: "0" },
          createdAt: { timestampValue: new Date().toISOString() },
        },
      };

      const fbUrl = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/ads`;
      await fetch(fbUrl, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(adData),
      });

      // ============================================
      // ✅ 8. POST THE CLEAN AD BACK TO TELEGRAM CHANNEL
      // ============================================
      if (env.TELEGRAM_BOT_TOKEN && message.chat?.id) {
        
        // Wait 3 seconds so Telegram doesn't think it's spam
        await new Promise(resolve => setTimeout(resolve, 3000));

        // Build the clean message text
        let newPostText = `✅ Clean Ad Posted!\n\n`;
        newPostText += `📂 Category: ${category}${subcategory ? " > " + subcategory : ""}\n`;
        newPostText += `📝 Title: ${title}\n`;
        if (price) newPostText += `💰 Price: ${price} ETB\n`;
        if (city) newPostText += `📍 City: ${city}\n`;
        newPostText += `\n📞 Contact: 0911680790\n`; 
        newPostText += `\n📄 Details:\n${cleanText}`;

        try {
          // Send as plain text to avoid Telegram anti-spam limits
          const tgRes = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ 
              chat_id: message.chat.id, 
              text: newPostText.substring(0, 4096)
            }),
          });
          
          const tgData = await tgRes.json();
          if (!tgData.ok) {
            console.error("Telegram Repost Error:", JSON.stringify(tgData));
          }
        } catch (err) {
          console.error("Fetch Error:", err.message);
        }
      }

      return new Response("OK", { status: 200 });
    } catch (error) {
      return new Response("Error: " + error.message, { status: 200 });
    }
  },
};

async function getFirebaseToken(env) {
  const sa = JSON.parse(atob(env.FIREBASE_SERVICE_ACCOUNT));
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = { iss: sa.client_email, scope: "https://www.googleapis.com/auth/datastore", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 };

  const h = base64UrlEncodeString(JSON.stringify(header));
  const p = base64UrlEncodeString(JSON.stringify(payload));
  const signingInput = `${h}.${p}`;

  const pem = sa.private_key.replace("-----BEGIN PRIVATE KEY-----", "").replace("-----END PRIVATE KEY-----", "").replace(/\s/g, "");
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sigBuffer = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(signingInput));

  const signature = base64UrlEncodeBytes(new Uint8Array(sigBuffer));
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

function base64UrlEncodeBytes(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
