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
      const targetChatId = "-1001674587108"; 

      try {
        // ============================================
        // 1. CLEAN TEXT
        // ============================================
        let cleanText = messageText;
        cleanText = cleanText.replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{2700}-\u{27BF}\u{25A0}-\u{25FF}\u{2B50}\u{1F004}\u{1F0CF}]/gu, "");
        cleanText = cleanText.replace(/[*_~`|]/g, "");
        cleanText = cleanText.replace(/https?:\/\/[^\s]+/gi, "");
        cleanText = cleanText.replace(/t\.me\/[^\s]+/gi, "");
        cleanText = cleanText.replace(/@[a-zA-Z0-9_]+/g, "");
        cleanText = cleanText.replace(/(?:\+251|251|0)?[\s.-]?[97]\d(?:[\s.-]?\d){7}/g, "(Phone Hidden)");
        cleanText = cleanText.replace(/\n{3,}/g, "\n\n").replace(/[ \t]+/g, " ").trim();

        // ============================================
        // 2. AI TEXT ANALYSIS (Llama 3)
        // ============================================
        let title = "Untitled Ad";
        let price = "";
        let category = "Other";
        let condition = "";
        let brand = "";
        let itemName = "";

        try {
          const aiPrompt = `
            You are an expert marketplace categorizer for an Ethiopian marketplace.
            Analyze this ad text and return ONLY a JSON object with these keys:
            "category" (choose exactly one: Cars, Houses, Rentals, Electronics, Furniture, Clothes, Labor & Services, ምንአለሽ ተራ, Other),
            "brand" (e.g., Toyota, Samsung, Nike),
            "itemName" (e.g., Corolla, Galaxy S21, Sofa),
            "condition" (e.g., New, Used),
            "price" (number only).
            
            Text: "${cleanText}"
            
            ONLY return the JSON. Do not include any other text.
          `;

          const aiResponse = await env.AI.run('@cf/meta/llama-3-8b-instruct', {
            messages: [{ role: "user", content: aiPrompt }]
          });

          // Parse the AI response
          const jsonMatch = aiResponse.response.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            category = parsed.category || "Other";
            brand = parsed.brand || "";
            itemName = parsed.itemName || "";
            condition = parsed.condition || "";
            if (parsed.price) price = Number(parsed.price).toLocaleString("en-US");
          }
        } catch (aiError) {
          console.error("AI Text Error:", aiError);
        }

        // Build the Title
        title = `${brand} ${itemName}`.replace(/\s+/g, " ").trim();
        if (!title) {
          const lines = cleanText.split("\n").map((l) => l.trim()).filter(Boolean);
          title = lines[0] || "Untitled Ad";
          if (/(urgent|አስቸኳይ|sale|ሽያጭ)/i.test(title) && lines.length > 1) title = lines[1];
        }
        if (title.length > 60) title = title.substring(0, 60) + "...";
        title = title.replace(/\b\w/g, (char) => char.toUpperCase());

        // Fallback if AI missed the price
        if (!price) {
          const priceMatch = cleanText.match(/(?:price|peric|pris|ዋጋ|ETB|ብር|Birr)[\s:.]*([\d.,]+)/i);
          if (priceMatch) {
            let cleanedNum = priceMatch[1].replace(/[.,]/g, "");
            if (cleanedNum && !isNaN(cleanedNum)) price = Number(cleanedNum).toLocaleString("en-US");
          }
        }

        let city = "";
        const cityMatch = cleanText.match(/(?:city|location|ከተማ)[\s:]+(.+)/i);
        if (cityMatch) city = cityMatch[1].trim();
        else if (/addis|ababa|adama|hawassa/i.test(cleanText)) city = "Addis Ababa";

        // ============================================
        // 3. DOWNLOAD IMAGE & UPLOAD TO CLOUDINARY
        // ============================================
        let imageUrl = "";
        let imageBlob = null;
        if (message.photo && message.photo.length > 0) {
          try {
            const largest = message.photo[message.photo.length - 1];
            const fileRes = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getFile?file_id=${largest.file_id}`);
            const fileInfo = await fileRes.json();

            if (fileInfo.ok) {
              const imgRes = await fetch(`https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${fileInfo.result.file_path}`);
              imageBlob = await imgRes.blob();
              
              const formData = new FormData();
              formData.append("file", imageBlob);
              formData.append("upload_preset", env.CLOUDINARY_UPLOAD_PRESET);

              const cloudRes = await fetch(`https://api.cloudinary.com/v1_1/${env.CLOUDINARY_CLOUD_NAME}/image/upload`, { method: "POST", body: formData });
              const cloudData = await cloudRes.json();
              if (cloudData.secure_url) imageUrl = cloudData.secure_url;
            }
          } catch (e) {
            console.error("Image Error:", e);
          }
        }

        // ============================================
        // 4. AI VISION ANALYSIS (LLaVA) - Optional check
        // ============================================
        // If the AI wasn't sure about the category (e.g. Other), we look at the image
        if (imageBlob && category === "Other") {
          try {
            // Convert blob to array for Cloudflare AI
            const arrayBuffer = await imageBlob.arrayBuffer();
            const uint8Array = new Uint8Array(arrayBuffer);
            const imageArray = Array.from(uint8Array); // Note: LLaVA in CF Workers requires a specific format, this is a conceptual test

            const visionPrompt = `Look at this image. Is it a car, phone, furniture, or clothes? Reply with ONE word.`;
            const visionResponse = await env.AI.run('@cf/llava-hf/llava-1.5-7b-hf', {
              image: imageArray,
              prompt: visionPrompt,
              max_tokens: 10
            });
            
            const detectedObject = visionResponse.description.toLowerCase();
            if (detectedObject.includes("car")) category = "Cars";
            else if (detectedObject.includes("phone")) category = "Electronics";
            else if (detectedObject.includes("furniture")) category = "Furniture";
            else if (detectedObject.includes("clothes")) category = "Clothes";
            
          } catch (visError) {
             console.error("Vision AI Error:", visError);
          }
        }

        // ============================================
        // 5. SAVE TO FIREBASE
        // ============================================
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
        // 6. REPOST CLEAN AD & DELETE ORIGINAL
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
          if (imageUrl && message.photo && message.photo.length > 0) {
            tgRes = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendPhoto`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ 
                chat_id: targetChatId, 
                photo: imageUrl, 
                caption: newPostText.substring(0, 1024)
              }),
            });
          } else {
            tgRes = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ 
                chat_id: targetChatId, 
                text: newPostText.substring(0, 4096)
              }),
            });
          }

          const tgData = await tgRes.json();
          if (tgData.ok) postSuccess = true;
          else errorMsg = tgData.description;

        } catch (tgErr) {
          errorMsg = tgErr.message;
        }

        if (postSuccess) {
          await new Promise(resolve => setTimeout(resolve, 3000));
          await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/deleteMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: message.chat.id, message_id: message.message_id }),
          });
        } else {
          await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ 
              chat_id: targetChatId, 
              text: `⚠️ Failed to repost clean ad. Reason: ${errorMsg}`
            }),
          });
        }

      } catch (error) {
        console.error("Main Error:", error);
      }

      return new Response("OK", { status: 200 });
    } catch (error) {
      return new Response("Error: " + error.message, { status: 200 });
    }
  }
};

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
