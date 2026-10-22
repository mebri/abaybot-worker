export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") {
      return new Response("Bot is running", { status: 200 });
    }

    try {
      const update = await request.json();
      const message = update.message || update.channel_post || update.edited_message || update.edited_channel_post;
      
      if (!message || (!message.text && !message.caption)) {
        return new Response("OK", { status: 200 });
      }

      const messageText = message.text || message.caption;

      try {
        // ============================================
        // 1. ULTIMATE CLEANUP (No emojis, no symbols)
        // ============================================
        let cleanText = messageText;

        // Remove ALL emojis and symbols
        cleanText = cleanText.replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{2700}-\u{27BF}\u{25A0}-\u{25FF}\u{2B50}\u{1F004}\u{1F0CF}]/gu, "");
        
        // Remove Markdown formatting characters that break Telegram API
        cleanText = cleanText.replace(/[*_~`|]/g, "");
        
        // Remove weird block characters (▬, ▌, etc.)
        cleanText = cleanText.replace(/[\u2580-\u259F]/g, "");

        // Remove Links and @handles
        cleanText = cleanText.replace(/https?:\/\/[^\s]+/gi, "");
        cleanText = cleanText.replace(/www\.[^\s]+/gi, "");
        cleanText = cleanText.replace(/t\.me\/[^\s]+/gi, "");
        cleanText = cleanText.replace(/@[a-zA-Z0-9_]+/g, "");

        // ✅ Remove Phone Numbers (Replace with parentheses, not brackets)
        cleanText = cleanText.replace(/(?:\+251|251|0)?[\s.-]?[97]\d(?:[\s.-]?\d){7}/g, "(Phone Hidden)");

        // Clean up extra blank lines and spaces
        cleanText = cleanText.replace(/\n{3,}/g, "\n\n").replace(/[ \t]+/g, " ").trim();

        // ============================================
        // 2. EXTRACT DETAILS
        // ============================================
        let brand = ""; let model = ""; let year = "";
        const brandMatch = cleanText.match(/(?:make|brand)[\s:.-]+([a-zA-Z\s]+)/i);
        if (brandMatch) brand = brandMatch[1].trim();
        const modelMatch = cleanText.match(/model[\s:.-]+([a-zA-Z0-9\s.-]+)/i);
        if (modelMatch) model = modelMatch[1].trim();
        const yearMatch = cleanText.match(/(?:year|ዓመት|yeras)[\s:.-]+((?:19|20)\d{2})/i);
        if (yearMatch) year = yearMatch[1];
        else {
          const fallbackYear = cleanText.match(/\b(19|20)\d{2}\b/);
          if (fallbackYear) year = fallbackYear[0];
        }

        let title = `${brand} ${model} ${year}`.replace(/\s+/g, " ").trim();
        if (!title) {
          const lines = cleanText.split("\n").map((l) => l.trim()).filter(Boolean);
          title = lines[0] || "Untitled Ad";
          if (/(urgent|አስቸኳይ|sale|ሽያጭ)/i.test(title) && lines.length > 1) title = lines[1];
        }
        if (title.length > 60) title = title.substring(0, 60) + "...";
        title = title.replace(/\b\w/g, (char) => char.toUpperCase());

        let price = "";
        const priceMatch = cleanText.match(/(?:price|peric|pris|ዋጋ|ETB|ብር|Birr)[\s:.]*([\d.,]+)/i);
        if (priceMatch) {
          let rawNum = priceMatch[1];
          let cleanedNum = rawNum.replace(/[.,]/g, "");
          if (cleanedNum && !isNaN(cleanedNum)) price = Number(cleanedNum).toLocaleString("en-US");
        }
        if (!price) {
          const fallbackMatch = cleanText.match(/(\d{1,3}(?:[.,]\d{3})+)/);
          if (fallbackMatch) price = fallbackMatch[1];
        }

        const lowerText = cleanText.toLowerCase();
        let category = "Other"; let condition = "";
        if (/(car|toyota|suzuki|honda|bmw|benz|nissan|ford|hyundai|mazda|vehicle|engine|mileage|km|መኪና|ሱዙኪ|ቶዮታ|ሆንዳ|ቢኤምደብሊው|ተሽከርካሪ|ሞተር)/i.test(lowerText)) {
          category = "Cars";
          if (/(new|አዲስ)/i.test(lowerText)) condition = "New";
          else if (/(electric|ኤሌክትሪክ|ኢቪ)/i.test(lowerText)) condition = "Electric";
          else if (/(rent|ኪራይ)/i.test(lowerText)) condition = "Rent";
          else condition = "Used";
        } else if (/(house|villa|condominium|condo|ቤት|ቪላ|ኮንዶሚኒየም)/i.test(lowerText)) category = "Houses";
        else if (/(apartment|office|shop|አፓርታማ|ቢሮ|ሱቅ|መጋዘን)/i.test(lowerText)) category = "Rentals";
        else if (/(iphone|samsung|tecno|infinix|phone|smartphone|laptop|computer|tv|camera|ስልክ|ሞባይል|ላፕቶፕ|ኮምፒውተር|ቲቪ|ቴሌቪዥን|ካሜራ)/i.test(lowerText)) category = "Electronics";
        else if (/(sofa|bed|table|chair|furniture|cabinet|ሶፋ|አልጋ|ጠረጴዛ|ጠረንጴዛ|ወንበር|ቁምሳጥን|እቃ)/i.test(lowerText)) category = "Furniture";
        else if (/(clothes|shoes|dress|shirt|pants|fashion|ልብስ|ጫማ|ቀሚስ|ሱሪ|ሸሚዝ)/i.test(lowerText)) category = "Clothes";
        
        let city = "";
        const cityMatch = cleanText.match(/(?:city|location|ከተማ)[\s:]+(.+)/i);
        if (cityMatch) city = cityMatch[1].trim();
        else if (/addis|ababa|adama|hawassa/i.test(cleanText)) city = "Addis Ababa";

        // ============================================
        // 3. UPLOAD IMAGE
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

        // ============================================
        // 4. SAVE TO FIREBASE
        // ============================================
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
            condition: { stringValue: condition }, 
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
        // 5. REPOST CLEAN AD & DELETE ORIGINAL
        // ============================================
        let safeDetails = cleanText.substring(0, 800); 

        let newPostText = `✅ Official Ad Posted!\n\n`;
        newPostText += `📂 Category: ${category}\n`;
        newPostText += `📝 Title: ${title}\n`;
        if (price) newPostText += `💰 Price: ${price} ETB\n`;
        if (city) newPostText += `📍 City: ${city}\n`;
        newPostText += `\n📞 Contact: 0911680790\n`; 
        newPostText += `\n📄 Details:\n${safeDetails}`;

        let postSuccess = false;
        let errorMsg = "";

        try {
          let tgRes;
          // Try sending as photo first
          if (imageUrl && message.photo && message.photo.length > 0) {
            tgRes = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendPhoto`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ 
                chat_id: message.chat.id, 
                photo: imageUrl, 
                caption: newPostText.substring(0, 1024),
                parse_mode: "" // ✅ Disable parsing
              }),
            });
          } 
          
          // If no photo, or if photo failed, send as text
          if (!tgRes || !(await tgRes.clone().json()).ok) {
            tgRes = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ 
                chat_id: message.chat.id, 
                text: newPostText.substring(0, 4096),
                parse_mode: "" // ✅ Disable parsing
              }),
            });
          }

          const tgData = await tgRes.json();
          if (tgData.ok) {
            postSuccess = true;
          } else {
            errorMsg = tgData.description; 
          }

        } catch (tgErr) {
          errorMsg = tgErr.message;
        }

        // If successfully posted, wait 3 seconds and delete the original message
        if (postSuccess) {
          await new Promise(resolve => setTimeout(resolve, 3000));
          await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/deleteMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: message.chat.id, message_id: message.message_id }),
          });
        } else {
          // If posting failed, send an error message to the channel so you know why
          await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ 
              chat_id: message.chat.id, 
              text: `⚠️ Bot could not repost clean ad. Error: ${errorMsg}`
            }),
          });
        }

      } catch (error) {
        // If the whole process fails, send a message to the channel
        await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ 
            chat_id: message.chat.id, 
            text: `⚠️ Bot Error: ${error.message}`
          }),
        });
      }

      return new Response("OK", { status: 200 });
    } catch (error) {
      return new Response("Error: " + error.message, { status: 200 });
    }
  }
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
