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
      // ✅ 1. SUPER AGGRESSIVE CLEANUP
      // ============================================
      let cleanText = messageText;

      // Remove all emojis (Unicode ranges)
      cleanText = cleanText.replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F1E6}-\u{1F1FF}\u{FE0F}\u{200D}\u{20E3}]/gu, "");

      // Remove Telegram and Web Links
      cleanText = cleanText.replace(/https?:\/\/[^\s]+/gi, "");
      cleanText = cleanText.replace(/www\.[^\s]+/gi, "");
      cleanText = cleanText.replace(/t\.me\/[^\s]+/gi, "");

      // Remove @handles
      cleanText = cleanText.replace(/@[a-zA-Z0-9_]+/g, "");

      // Remove Phone numbers (Even without the word "Phone" next to them)
      cleanText = cleanText.replace(/(?:\+251|251|0)[\s.-]?9[\d\s.-]{7,}/g, "[Phone Hidden]");
      cleanText = cleanText.replace(/(?:\+251|251|0)[\s.-]?7[\d\s.-]{7,}/g, "[Phone Hidden]");

      // Clean up extra blank lines and weird spacing left behind
      cleanText = cleanText.replace(/\n{3,}/g, "\n\n").replace(/[ \t]+/g, " ").trim();

      // ============================================
      // 2. PRICE EXTRACTION (Fixed for "2,500,000..Birr")
      // ============================================
      let price = "";
      // This looks specifically for Price/ዋጋ/Birr/ETB followed by numbers, ignoring dots
      const priceMatch = cleanText.match(/(?:price|peric|pris|ዋጋ|ETB|ብር|Birr)[\s:.]*([\d.,]+)/i);
      
      if (priceMatch) {
        let rawNum = priceMatch[1];
        // Clean the number (remove all commas and dots)
        let cleanedNum = rawNum.replace(/[.,]/g, "");
        // If it ends up being a valid number, format it
        if (cleanedNum && !isNaN(cleanedNum)) {
          price = Number(cleanedNum).toLocaleString("en-US");
        }
      }

      // Fallback if no explicit price word is found
      if (!price) {
        const fallbackMatch = cleanText.match(/(\d{1,3}(?:[.,]\d{3})+)/);
        if (fallbackMatch) {
          price = fallbackMatch[1];
        }
      }

      const lowerText = cleanText.toLowerCase();

      // 3. DETECT LANGUAGE
      const isAmharic = /[\u1200-\u137F]/.test(cleanText);
      const language = isAmharic ? "am" : "en";

      // 4. SMART CATEGORY DETECTION
      let category = "Other";
      let subcategory = "";
      let condition = "";

      if (/(car|toyota|suzuki|honda|bmw|benz|nissan|ford|hyundai|mazda|vehicle|engine|mileage|km|መኪና|ሱዙኪ|ቶዮታ|ሆንዳ|ቢኤምደብሊው|ተሽከርካሪ|ሞተር)/i.test(lowerText)) category = "Cars";
      else if (/(house|villa|condominium|condo|ቤት|ቪላ|ኮንዶሚኒየም)/i.test(lowerText)) category = "Houses";
      else if (/(apartment|office|shop|አፓርታማ|ቢሮ|ሱቅ|መጋዘን)/i.test(lowerText)) category = "Rentals";
      else if (/(iphone|samsung|tecno|infinix|phone|smartphone|laptop|computer|tv|camera|ስልክ|ሞባይል|ላፕቶፕ|ኮምፒውተር|ቲቪ|ቴሌቪዥን|ካሜራ)/i.test(lowerText)) category = "Electronics";
      else if (/(sofa|bed|table|chair|furniture|cabinet|ሶፋ|አልጋ|ጠረጴዛ|ጠረንጴዛ|ወንበር|ቁምሳጥን|እቃ)/i.test(lowerText)) category = "Furniture";
      else if (/(clothes|shoes|dress|shirt|pants|fashion|ልብስ|ጫማ|ቀሚስ|ሱሪ|ሸሚዝ)/i.test(lowerText)) category = "Clothes";
      else if (/(construction|electrician|plumber|painter|cleaning|worker|ግንባታ|ኤሌክትሪሺያን|ቧንቧ|ቀለም|ጽዳት|ሰራተኛ|ሠራተኛ)/i.test(lowerText)) category = "Labor & Services";
      else if (/(used|second-hand|ምንአለሽ ተራ|ያገለገለ)/i.test(lowerText)) category = "ምንአለሽ ተራ";

      // 5. DETECT SUBCATEGORY & CONDITION
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

      // 6. PARSE TITLE AND CITY
      const lines = cleanText.split("\n").map((l) => l.trim()).filter(Boolean);
      let title = lines[0] || "Untitled Ad";
      if (title.length > 60) title = title.substring(0, 60) + "...";
      let city = "";

      for (const line of lines) {
        const cityMatch = line.match(/(?:city|location|ከተማ)[\s:]+(.+)/i);
        if (cityMatch && !city) city = cityMatch[1].trim();
        else if (/addis|ababa|adama|hawassa|bahir dar|mekelle|gondar|jimma|dire dawa|bishoftu/i.test(line) && !city) city = line.trim();
      }

      // 7. UPLOAD IMAGE
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

      // 8. SAVE TO FIREBASE
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
      // ✅ 9. POST THE CLEAN AD BACK TO TELEGRAM
      // ============================================
      if (env.TELEGRAM_BOT_TOKEN && message.chat?.id) {
        
        // Wait 3 seconds so Telegram doesn't think it's spam
        await new Promise(resolve => setTimeout(resolve, 3000));

        let newPostText = `✅ Clean Ad Posted!\n\n`;
        newPostText += `📂 Category: ${category}${subcategory ? " > " + subcategory : ""}\n`;
        newPostText += `📝 Title: ${title}\n`;
        if (price) newPostText += `💰 Price: ${price} ETB\n`;
        if (city) newPostText += `📍 City: ${city}\n`;
        newPostText += `\n📞 Contact: 0911680790\n`; 
        newPostText += `\n📄 Details:\n${cleanText}`;

        try {
          const tgRes = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ 
              chat_id: message.chat.id, 
              text: newPostText.substring(0, 4096)
            }),
          });
          
          const tgData = await tgRes.json();
          
          // ✅ 10. DELETE THE ORIGINAL MESSAGE
          if (tgData.ok) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/deleteMessage`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ 
                chat_id: message.chat.id, 
                message_id: message.message_id 
              }),
            });
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
