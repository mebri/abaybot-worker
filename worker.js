// ===============================================
// ABAY GEBEYA BOT - Reads Telegram messages
// Uploads photos to Cloudinary + Saves ads to Firebase
// ===============================================

export default {
  async fetch(request, env, ctx) {
    // Health check
    if (request.method !== "POST") {
      return new Response("Bot is running ✅", { status: 200 });
    }

    try {
      const update = await request.json();
      const message = update.message || update.channel_post;

      if (!message || !message.text) {
        return new Response("OK", { status: 200 });
      }

      console.log("📩 New message:", message.text);

      // ============================================
      // STEP 1: Parse the Telegram message
      // ============================================
      const parsedAd = parseMessage(message.text);

      if (!parsedAd.title) {
        console.log("⚠️ Skipping: no title found");
        return new Response("OK", { status: 200 });
      }

      // ============================================
      // STEP 2: Download photo from Telegram (if exists)
      // ============================================
      let imageUrl = "";
      if (message.photo && message.photo.length > 0) {
        try {
          const largestPhoto = message.photo[message.photo.length - 1];
          const fileId = largestPhoto.file_id;

          const fileInfoRes = await fetch(
            `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`
          );
          const fileInfo = await fileInfoRes.json();

          if (fileInfo.ok) {
            const filePath = fileInfo.result.file_path;
            const telegramFileUrl = `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${filePath}`;

            const imageRes = await fetch(telegramFileUrl);
            const imageBlob = await imageRes.blob();

            const formData = new FormData();
            formData.append("file", imageBlob);
            formData.append("upload_preset", env.CLOUDINARY_UPLOAD_PRESET);

            const cloudRes = await fetch(
              `https://api.cloudinary.com/v1_1/${env.CLOUDINARY_CLOUD_NAME}/image/upload`,
              { method: "POST", body: formData }
            );
            const cloudData = await cloudRes.json();

            if (cloudData.secure_url) {
              imageUrl = cloudData.secure_url;
              console.log("✅ Image uploaded:", imageUrl);
            }
          }
        } catch (imgErr) {
          console.error("❌ Image upload failed:", imgErr.message);
        }
      }

      // ============================================
      // STEP 3: Save to Firebase Firestore
      // ============================================
      const firebaseToken = await getFirebaseToken(env);
      const projectId = env.FIREBASE_PROJECT_ID;

      const adData = {
        fields: {
          title: { stringValue: parsedAd.title },
          description: { stringValue: parsedAd.description || parsedAd.title },
          price: { stringValue: parsedAd.price || "0" },
          phone: { stringValue: parsedAd.phone || "" },
          city: { stringValue: parsedAd.city || "" },
          category: { stringValue: "Telegram" },
          image: { stringValue: imageUrl },
          images: {
            arrayValue: imageUrl
              ? { values: [{ stringValue: imageUrl }] }
              : { values: [] },
          },
          status: { stringValue: "draft" },
          source: { stringValue: "telegram" },
          telegramMessageId: { integerValue: String(message.message_id) },
          views: { integerValue: "0" },
          createdAt: { timestampValue: new Date().toISOString() },
        },
      };

      const firebaseUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/ads`;

      const saveRes = await fetch(firebaseUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${firebaseToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(adData),
      });

      if (saveRes.ok) {
        console.log("✅ Ad saved to Firebase!");
      } else {
        const errText = await saveRes.text();
        console.error("❌ Firebase save failed:", errText);
      }

      return new Response("OK", { status: 200 });
    } catch (error) {
      console.error("❌ Error:", error.message);
      return new Response("Error", { status: 200 });
    }
  },
};

// ===============================================
// HELPER: Parse Telegram message into ad fields
// ===============================================
function parseMessage(text) {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const result = {
    title: "",
    description: text,
    price: "",
    phone: "",
    city: "",
  };

  result.title = lines[0] || "";

  const priceRegex = /(?:price|ዋጋ|ብር|ETB)[\s:]*([\d,]+)/i;
  const phoneRegex = /(?:\+251|0)[\s-]?9[\d\s-]{8,}/;
  const cityKeywords = [
    "addis", "ababa", "addis ababa", "adama", "hawassa", "bahir dar",
    "mekelle", "dire dawa", "gondar", "jimma", "bishoftu", "shashemene",
  ];
  const cityRegex = new RegExp(`(?:city|location|ከተማ)[:\\s]*([^\\n]+)`, "i");

  for (const line of lines) {
    const priceMatch = line.match(priceRegex);
    if (priceMatch && !result.price) {
      result.price = priceMatch[1].replace(/,/g, "");
    }

    const phoneMatch = line.match(phoneRegex);
    if (phoneMatch && !result.phone) {
      result.phone = phoneMatch[0].replace(/[\s-]/g, "");
    }

    const cityMatch = line.match(cityRegex);
    if (cityMatch && !result.city) {
      result.city = cityMatch[1].trim();
    }

    if (!result.city) {
      const lowerLine = line.toLowerCase();
      for (const kw of cityKeywords) {
        if (lowerLine.includes(kw)) {
          result.city = line;
          break;
        }
      }
    }
  }

  return result;
}

// ===============================================
// HELPER: Get Firebase Access Token
// ===============================================
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

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const signature = await signRS256(signingInput, privateKey);
  const jwt = `${signingInput}.${signature}`;

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });

  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) {
    throw new Error("Failed to get Firebase token: " + JSON.stringify(tokenData));
  }
  return tokenData.access_token;
}

// ===============================================
// HELPER: Base64 URL Encode
// ===============================================
function base64UrlEncode(str) {
  const base64 = btoa(unescape(encodeURIComponent(str)));
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ===============================================
// HELPER: Sign JWT with RS256 (using Web Crypto API)
// ===============================================
async function signRS256(data, privateKeyPem) {
  const pemContents = privateKeyPem
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

  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    new TextEncoder().encode(data)
  );

  return base64UrlEncode(String.fromCharCode(...new Uint8Array(signature)));
}
