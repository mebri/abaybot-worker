export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/test") {
      const report = { envCheck: {} };
      report.envCheck = {
        hasTelegramToken: !!env.TELEGRAM_BOT_TOKEN,
        hasServiceAccount: !!env.FIREBASE_SERVICE_ACCOUNT,
        hasCloudName: !!env.CLOUDINARY_CLOUD_NAME,
        hasUploadPreset: !!env.CLOUDINARY_UPLOAD_PRESET,
        hasTelegramUserId: !!env.TELEGRAM_USER_ID,
      };
      return new Response(JSON.stringify(report, null, 2), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (request.method !== "POST") {
      return new Response("Bot is running ✅", { status: 200 });
    }

    try {
      const update = await request.json();
      const message = update.message || update.channel_post;
      if (!message) return new Response("OK", { status: 200 });

      const messageText = message.text || message.caption;
      if (!messageText) return new Response("OK", { status: 200 });

      const lines = messageText.split("\n").map((l) => l.trim()).filter(Boolean);
      const title = lines[0] || "Untitled Ad";
      let price = "";
      let phone = "";
      let city = "";
      let category = "";
      let subcategory = "";
      let condition = "";
      let type = "";
      let furnitureType = "";
      let laborType = "";

      // ============================================
      // PARSE FIELDS
      // ============================================
      for (const line of lines) {
        // Price
        const priceMatch = line.match(
          /(?:price|ዋጋ|ETB|ብር)[\s:]*([\d,.]+)\s*(MILLION|Million|M|K|Thousand|THOUSAND|ሚሊዮን|ሺህ)?/i
        );
        if (priceMatch && !price) {
          let val = parseFloat(priceMatch[1].replace(/,/g, ""));
          const unit = (priceMatch[2] || "").toUpperCase();
          if (unit.includes("MILLION") || unit === "M" || unit.includes("ሚሊዮን")) val *= 1000000;
          else if (unit.includes("THOUSAND") || unit === "K" || unit.includes("ሺህ")) val *= 1000;
          price = String(Math.round(val));
        }

        // Phone
        const phoneMatch = line.match(/(?:\+251|0)[\s-]?9[\d\s-]{7,}/);
        if (phoneMatch && !phone) phone = phoneMatch[0].replace(/[\s-]/g, "");

        // City
        const cityMatch = line.match(/(?:city|location|ከተማ)[\s:]+(.+)/i);
        if (cityMatch && !city) city = cityMatch[1].trim();
        else if (/addis|ababa|adama|hawassa|bahir dar|mekelle|gondar|jimma|dire dawa|bishoftu/i.test(line) && !city) {
          city = line.trim();
        }
      }

      // ============================================
      // AUTO-DETECT CATEGORY
      // ============================================
      const lowerText = messageText.toLowerCase();

      // Cars
      if (/\b(car|toyota|nissan|honda|hyundai|mazda|ford|mitsubishi|suzuki|isuzu|hilux|corolla|vitz|prado|rav4|crv|civic|benz|bmw|kia|chevrolet|land cruiser|pickup|sedan|suv)\b/i.test(lowerText)) {
        category = "Cars";
        if (/\b(rent|rental)\b/i.test(lowerText)) condition = "Rent";
        else if (/\b(electric|ev)\b/i.test(lowerText)) condition = "Electric";
        else if (/\b(new|brand new|0 km)\b/i.test(lowerText)) condition = "New";
        else if (/\b(used|second|km)\b/i.test(lowerText)) condition = "Used";
      }
      // Houses
      else if (/\b(house|home|villa|bungalow|real estate|ቤት)\b/i.test(lowerText)) {
        category = "Houses";
        if (/\b(rent)\b/i.test(lowerText)) type = "rent";
        else if (/\b(sale|sell)\b/i.test(lowerText)) type = "sale";
      }
      // Rentals (apartments, shops, offices)
      else if (/\b(apartment|condominium|shop|store|office|rental|studio)\b/i.test(lowerText)) {
        category = "Rentals";
        if (/\b(apartment|condo|studio)\b/i.test(lowerText)) type = "apartment";
        else if (/\b(shop|store)\b/i.test(lowerText)) type = "shop";
        else if (/\b(office)\b/i.test(lowerText)) type = "office";
      }
      // Electronics
      else if (/\b(phone|iphone|samsung|tecno|infinix|huawei|oppo|laptop|computer|pc|macbook|tv|television|speaker|headphone|earphone|airpod|tablet|ipad|camera|electronics)\b/i.test(lowerText)) {
        category = "Electronics";
        if (/\b(phone|iphone|samsung|tecno|infinix|huawei|oppo)\b/i.test(lowerText)) subcategory = "Phones";
        else if (/\b(laptop|computer|pc|macbook)\b/i.test(lowerText)) subcategory = "Computers";
        else if (/\b(tv|television)\b/i.test(lowerText)) subcategory = "TVs";
        else if (/\b(speaker|headphone|earphone|airpod|audio)\b/i.test(lowerText)) subcategory = "Audio";
        else subcategory = "Other";

        if (/\b(new|brand new|sealed)\b/i.test(lowerText)) condition = "New";
        else if (/\b(used|second)\b/i.test(lowerText)) condition = "Used";
      }
      // Furniture
      else if (/\b(sofa|couch|chair|table|bed|mattress|cabinet|wardrobe|furniture|shelf|desk)\b/i.test(lowerText)) {
        category = "Furniture";
        if (/\b(sofa|couch)\b/i.test(lowerText)) furnitureType = "Sofas";
        else if (/\b(bed|mattress)\b/i.test(lowerText)) furnitureType = "Beds";
        else if (/\b(chair|table|desk)\b/i.test(lowerText)) furnitureType = "Chairs and Tables";
        else if (/\b(cabinet|wardrobe|shelf)\b/i.test(lowerText)) furnitureType = "Cabinets";
        else furnitureType = "Other";

        if (/\b(new)\b/i.test(lowerText)) condition = "New";
        else if (/\b(used)\b/i.test(lowerText)) condition = "Used";
      }
      // Labor & Services
      else if (/\b(electrician|plumber|painter|cleaning|construction|worker|technician|carpenter|welder|driver)\b/i.test(lowerText)) {
        category = "Labor & Services";
        if (/\b(electrician)\b/i.test(lowerText)) laborType = "Electrician";
        else if (/\b(plumber)\b/i.test(lowerText)) laborType = "Plumber";
        else if (/\b(painter)\b/i.test(lowerText)) laborType = "Painter";
        else if (/\b(cleaning)\b/i.test(lowerText)) laborType = "Cleaning";
        else if (/\b(construction|worker)\b/i.test(lowerText)) laborType = "Construction";
        else laborType = "Other";
      }
      // Fallback
      else {
        category = "ምንአለሽ ተራ";
        condition = "Used";
      }

      // ============================================
      // UPLOAD IMAGE
      // ============================================
      let imageUrl = "";
      let imageDebug = "";

      if (message.photo && message.photo.length > 0) {
        try {
          imageDebug = "ok. ";
          const largest = message.photo[message.photo.length - 1];
          const fileRes = await fetch(
            `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getFile?file_id=${largest.file_id}`
          );
          const fileInfo = await fileRes.json();

          if (fileInfo.ok) {
            const imgRes = await fetch(
              `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${fileInfo.result.file_path}`
            );
            const blob = await imgRes.blob();

            const formData = new FormData();
            formData.append("file", blob);
            formData.append("upload_preset", env.CLOUDINARY_UPLOAD_PRESET);

            const cloudRes = await fetch(
              `https://api.cloudinary.com/v1_1/${env.CLOUDINARY_CLOUD_NAME}/image/upload`,
              { method: "POST", body: formData }
            );
            const cloudData = await cloudRes.json();
            if (cloudData.secure_url) {
              imageUrl = cloudData.secure_url;
              imageDebug += "✅ uploaded";
            } else {
              imageDebug += "❌ " + (cloudData.error?.message || "unknown");
            }
          }
        } catch (e) {
          imageDebug += "exception: " + e.message;
        }
      } else {
        imageDebug = "❌ no photo";
      }

      // ============================================
      // SAVE — LIKE A NORMAL USER AD
      // ============================================
      const token = await getFirebaseToken(env);
      const sa = JSON.parse(atob(env.FIREBASE_SERVICE_ACCOUNT));

      const adData = {
        fields: {
          title: { stringValue: title },
          description: { stringValue: messageText },
          price: { stringValue: price || "0" },
          phone: { stringValue: phone },
          city: { stringValue: city },
          category: { stringValue: category }, // ✅ Auto-detected, not "Telegram"
          subcategory: { stringValue: subcategory },
          condition: { stringValue: condition },
          type: { stringValue: type },
          furnitureType: { stringValue: furnitureType },
          laborType: { stringValue: laborType },
          image: { stringValue: imageUrl },
          images: {
            arrayValue: imageUrl
              ? { values: [{ stringValue: imageUrl }] }
              : { values: [] },
          },
          status: { stringValue: "available" },
          source: { stringValue: "telegram" }, // internal marker (not shown on cards)
          views: { integerValue: "0" },
          createdAt: { timestampValue: new Date().toISOString() },
          // ✅ Owned by the Telegram user account
          userId: { stringValue: env.TELEGRAM_USER_ID || "" },
          userEmail: { stringValue: env.TELEGRAM_EMAIL || "telegram@yegnagebeya.com" },
          userName: { stringValue: env.TELEGRAM_NAME || "Yegna Gebeya" },
        },
      };

      const fbUrl = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/documents/ads`;
      const saveRes = await fetch(fbUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(adData),
      });

      if (env.TELEGRAM_BOT_TOKEN && message.chat?.id) {
        const replyText =
          (saveRes.ok ? "✅ Posted live on marketplace!\n" : "⚠️ Save failed.\n") +
          "📂 Category: " + category + "\n" +
          "💰 Price: " + (price || "0") + " ETB\n" +
          "📸 Image: " + imageDebug;

        await fetch(
          `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: message.chat.id, text: replyText }),
          }
        );
      }

      return new Response("OK", { status: 200 });
    } catch (error) {
      return new Response("Error: " + error.message, { status: 200 });
    }
  },
};

async function getFirebaseToken(env) {
  const sa = JSON.parse(atob(env.FIREBASE_SERVICE_ACCOUNT));
  const clientEmail = sa.client_email;
  const privateKey = sa.private_key;

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

  const pem = privateKey
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\s/g, "");

  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const sigBuffer = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(signingInput)
  );

  const signature = base64UrlEncodeBytes(new Uint8Array(sigBuffer));
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

function base64UrlEncodeBytes(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
