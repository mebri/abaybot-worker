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

      const lowerText = messageText.toLowerCase();

      // 1. DETECT LANGUAGE
      const isAmharic = /[\u1200-\u137F]/.test(messageText);
      const language = isAmharic ? "am" : "en";

      // 2. SMART CATEGORY & SUBCATEGORY DETECTION
      let category = "Other";
      let subcategory = "";

      if (/(car|toyota|suzuki|honda|bmw|benz|nissan|ford|hyundai|mazda|vehicle|engine|mileage|km|መኪና|ሱዙኪ|ቶዮታ|ሆንዳ|ቢኤምደብሊው|ተሽከርካሪ|ሞተር)/i.test(lowerText)) {
        category = "Cars";
      } 
      else if (/(house|apartment|condo|rent|real estate|ቤት|ኪራይ|አፓርታማ|መኖሪያ|ሪል እስቴት|መሬት)/i.test(lowerText)) {
        category = "Houses";
      } 
      else if (/(iphone|samsung|tecno|infinix|phone|smartphone|ስልክ|ሞባይል)/i.test(lowerText)) {
        category = "Electronics";
        subcategory = "Phones";
      } else if (/(laptop|computer|macbook|dell|hp|lenovo|ላፕቶፕ|ኮምፒውተር)/i.test(lowerText)) {
        category = "Electronics";
        subcategory = "Computers";
      } else if (/(tv|television|screen|ሳምሰንግ ቲቪ|ቲቪ|ቴሌቪዥን)/i.test(lowerText)) {
        category = "Electronics";
        subcategory = "TVs";
      } else if (/(fridge|refrigerator|stove|microwave|washing machine|ማቀዝቀዣ|ምድጃ|ማይክሮዌቭ|ልብስ ማጠቢያ)/i.test(lowerText)) {
        category = "Electronics";
        subcategory = "Appliances"; // Home Appliances
      } else if (/(playstation|ps4|ps5|xbox|nintendo|gaming|ጌም)/i.test(lowerText)) {
        category = "Electronics";
        subcategory = "Gaming";
      } else if (/(headphone|speaker|audio|camera|accessory|ማጉያ|ስፒከር|ካሜራ)/i.test(lowerText)) {
        category = "Electronics";
        subcategory = "Audio & Accessories";
      } else if (/(electronics|camera|ኤሌክትሮኒክስ)/i.test(lowerText)) {
        category = "Electronics";
        subcategory = "Other Electronics";
      }
      else if (/(sofa|bed|table|chair|furniture|cabinet|ሶፋ|አልጋ|ጠረጴዛ|ጠረንጴዛ|ወንበር|ቁምሳጥን|እቃ)/i.test(lowerText)) {
        category = "Furniture";
      } 
      else if (/(job|hiring|service|plumber|electrician|worker|ሰራተኛ|ሠራተኛ|ግንባታ|ቧንቧ|ኤሌክትሪሺያን|አገልግሎት)/i.test(lowerText)) {
        category = "Labor & Services";
      } 
      else if (/(used|second-hand|ምንአለሽ ተራ|ያገለገለ)/i.test(lowerText)) {
        category = "ምንአለሽ ተራ";
      }

      // 3. PARSE MESSAGE
      const lines = messageText.split("\n").map((l) => l.trim()).filter(Boolean);
      let title = lines[0] || "Untitled Ad";
      title = title.replace(/[‼️✅👉👇💥🔥⚡✨📌📢]+/g, "").trim();
      if (title.length > 60) title = title.substring(0, 60) + "...";

      let price = "";
      let phone = "";
      let city = "";

      for (const line of lines) {
        const priceMatch = line.match(/(?:price|peric|pris|ዋጋ|ETB|ብር)[\s:.\-]*([\d.,\s]+)\s*(MILLION|Million|BILLION|Billion|K\b|Thousand|THOUSAND|ሚሊዮን|ቢሊዮን|ሺህ)?/i);
        if (priceMatch && !price) {
          const rawNum = priceMatch[1].trim();
          const unit = (priceMatch[2] || "").toUpperCase();
          const cleaned = rawNum.replace(/\s/g, "");
          const thousandPattern = /^\d{1,3}([.,]\d{3})+$/;

          let numVal;
          if (thousandPattern.test(cleaned)) {
            numVal = parseFloat(cleaned.replace(/[.,]/g, ""));
          } else {
            numVal = parseFloat(cleaned.replace(/,/g, ""));
          }

          if (unit.includes("MILLION") || unit.includes("ሚሊዮን")) {
            if (numVal < 100000) numVal *= 1000000;
          } else if (unit.includes("BILLION") || unit.includes("ቢሊዮን")) {
            if (numVal < 100000) numVal *= 1000000000;
          } else if (unit.includes("THOUSAND") || unit === "K" || unit.includes("ሺህ")) {
            if (numVal < 1000) numVal *= 1000;
          }

          if (!isNaN(numVal) && numVal > 0) {
            price = Math.round(numVal).toLocaleString("en-US");
          }
        }

        const phoneMatch = line.match(/(?:\+251|0)[\s-]?9[\d\s-]{7,}/);
        if (phoneMatch && !phone) {
          phone = phoneMatch[0].replace(/[\s-]/g, "");
        }

        const cityMatch = line.match(/(?:city|location|ከተማ)[\s:]+(.+)/i);
        if (cityMatch && !city) {
          city = cityMatch[1].trim();
        } else if (/addis|ababa|adama|hawassa|bahir dar|mekelle|gondar|jimma|dire dawa|bishoftu/i.test(line) && !city) {
          city = line.trim();
        }
      }

      // 4. UPLOAD IMAGE
      let imageUrl = "";
      let imageDebug = "";

      if (message.photo && message.photo.length > 0) {
        try {
          const largest = message.photo[message.photo.length - 1];
          const fileRes = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getFile?file_id=${largest.file_id}`);
          const fileInfo = await fileRes.json();
          imageDebug += "getFile=" + (fileInfo.ok ? "ok" : "fail") + ". ";

          if (fileInfo.ok) {
            const imgRes = await fetch(`https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${fileInfo.result.file_path}`);
            const blob = await imgRes.blob();
            const formData = new FormData();
            formData.append("file", blob);
            formData.append("upload_preset", env.CLOUDINARY_UPLOAD_PRESET);

            const cloudRes = await fetch(`https://api.cloudinary.com/v1_1/${env.CLOUDINARY_CLOUD_NAME}/image/upload`, { method: "POST", body: formData });
            const cloudData = await cloudRes.json();

            if (cloudData.secure_url) {
              imageUrl = cloudData.secure_url;
              imageDebug += "uploaded";
            } else {
              imageDebug += "cloud_error: " + (cloudData.error?.message || "unknown");
            }
          }
        } catch (e) {
          imageDebug += "exception: " + e.message;
        }
      } else {
        imageDebug = "no photo";
      }

      // 5. SAVE TO FIREBASE
      const token = await getFirebaseToken(env);
      const sa = JSON.parse(atob(env.FIREBASE_SERVICE_ACCOUNT));

      const adOwnerId = env.ADMIN_UID || "admin_bot"; 

      const adData = {
        fields: {
          title: { stringValue: title },
          description: { stringValue: messageText },
          price: { stringValue: price || "0" },
          phone: { stringValue: phone },
          city: { stringValue: city },
          category: { stringValue: category },
          subcategory: { stringValue: subcategory }, // ✅ NEW: Saves the specific type (e.g., "Phones")
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
      const saveRes = await fetch(fbUrl, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(adData),
      });

      // 6. REPLY TO TELEGRAM
      if (env.TELEGRAM_BOT_TOKEN && message.chat?.id) {
        const replyText =
          (saveRes.ok ? "Ad saved successfully.\n\n" : "Save failed.\n\n") +
          "Category: " + category + (subcategory ? " > " + subcategory : "") + "\n" +
          "Title: " + title + "\n" +
          "Price: " + (price || "not found") + " ETB\n";

        try {
          await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: message.chat.id, text: replyText }),
          });
        } catch (err) {
          console.error("Fetch Error:", err.message);
        }
      }

      return new Response("OK", { status: 200 });
    } catch (error) {
      console.error("Main error:", error.message);
      return new Response("Error: " + error.message, { status: 200 });
    }
  },
};

function jsonResponse(obj) {
  return new Response(JSON.stringify(obj, null, 2), { status: 200, headers: { "Content-Type": "application/json" } });
}

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
