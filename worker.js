export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // ============================================
    // TEST MODE: Visit /test in browser
    // ============================================
    if (url.pathname === "/test") {
      const report = {
        envCheck: {
          hasTelegramToken: !!env.TELEGRAM_BOT_TOKEN,
          telegramTokenLength: env.TELEGRAM_BOT_TOKEN?.length || 0,
          hasServiceAccount: !!env.FIREBASE_SERVICE_ACCOUNT,
          serviceAccountLength: env.FIREBASE_SERVICE_ACCOUNT?.length || 0,
          hasCloudName: !!env.CLOUDINARY_CLOUD_NAME,
          cloudNameValue: env.CLOUDINARY_CLOUD_NAME || "MISSING",
          hasUploadPreset: !!env.CLOUDINARY_UPLOAD_PRESET,
          uploadPresetValue: env.CLOUDINARY_UPLOAD_PRESET || "MISSING",
        },
        serviceAccountInfo: {},
        firebaseTest: {},
      };

      // Decode service account
      try {
        const sa = JSON.parse(atob(env.FIREBASE_SERVICE_ACCOUNT));
        report.serviceAccountInfo = {
          projectId: sa.project_id || "MISSING",
          clientEmail: sa.client_email || "MISSING",
          privateKeyLength: sa.private_key?.length || 0,
          privateKeyStart: sa.private_key?.substring(0, 40) || "MISSING",
        };
      } catch (e) {
        report.serviceAccountInfo = { error: "Cannot decode: " + e.message };
        return jsonResponse(report);
      }

      // Test Firebase token
      try {
        const token = await getFirebaseToken(env);
        report.firebaseTest.token = "✅ Got token";

        // Test save
        const sa = JSON.parse(atob(env.FIREBASE_SERVICE_ACCOUNT));
        const adData = {
          fields: {
            title: { stringValue: "TEST FROM /test" },
            description: { stringValue: "If you see this in Firebase, it works!" },
            price: { stringValue: "0" },
            phone: { stringValue: "" },
            city: { stringValue: "" },
            category: { stringValue: "Telegram" },
            image: { stringValue: "" },
            status: { stringValue: "draft" },
            source: { stringValue: "telegram" },
            views: { integerValue: "0" },
            createdAt: { timestampValue: new Date().toISOString() },
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

        const saveText = await saveRes.text();
        report.firebaseTest.saveStatus = saveRes.status;
        report.firebaseTest.saveOk = saveRes.ok;
        report.firebaseTest.saveResponse = saveText.substring(0, 300);
      } catch (e) {
        report.firebaseTest.error = e.message;
      }

      return jsonResponse(report);
    }

    // ============================================
    // NORMAL WEBHOOK MODE
    // ============================================
    if (request.method !== "POST") {
      return new Response("Bot is running ✅", { status: 200 });
    }

    try {
      const update = await request.json();
      const message = update.message || update.channel_post;

      if (!message || !message.text) {
        return new Response("OK", { status: 200 });
      }

      // ============================================
      // STEP 1: Parse the message
      // ============================================
      const lines = message.text.split("\n").filter((l) => l.trim());
      const title = lines[0] || "Untitled Ad";
      let price = "";
      let phone = "";
      let city = "";

      for (const line of lines) {
        const priceMatch = line.match(/(?:price|ዋጋ|ETB)[\s:]*([\d,]+)/i);
        if (priceMatch && !price) price = priceMatch[1].replace(/,/g, "");

        const phoneMatch = line.match(/(?:\+251|0)[\s-]?9[\d\s-]{8,}/);
        if (phoneMatch && !phone) phone = phoneMatch[0].replace(/[\s-]/g, "");

        if (
          /addis|ababa|adama|hawassa|bahir dar|mekelle|gondar|jimma|dire dawa/i.test(
            line
          ) &&
          !city
        ) {
          city = line;
        }
      }

      // ============================================
      // STEP 2: Upload photo to Cloudinary (if exists)
      // ============================================
      let imageUrl = "";
      if (message.photo && message.photo.length > 0) {
        try {
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
            }
          }
        } catch (e) {
          console.error("Image error:", e.message);
        }
      }

      // ============================================
      // STEP 3: Save to Firebase Firestore
      // ============================================
      const token = await getFirebaseToken(env);
      const sa = JSON.parse(atob(env.FIREBASE_SERVICE_ACCOUNT));

      const adData = {
        fields: {
          title: { stringValue: title },
          description: { stringValue: message.text },
          price: { stringValue: price || "0" },
          phone: { stringValue: phone },
          city: { stringValue: city },
          category: { stringValue: "Telegram" },
          image: { stringValue: imageUrl },
          images: {
            arrayValue: imageUrl
              ? { values: [{ stringValue: imageUrl }] }
              : { values: [] },
          },
          status: { stringValue: "draft" },
          source: { stringValue: "telegram" },
          views: { integerValue: "0" },
          createdAt: { timestampValue: new Date().toISOString() },
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

      // Reply to Telegram
      if (env.TELEGRAM_BOT_TOKEN && message.chat?.id) {
        const replyText = saveRes.ok
          ? "✅ Ad received and saved to drafts!"
          : "⚠️ Ad received but save failed. Check /test page.";

        await fetch(
          `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chat_id: message.chat.id,
              text: replyText,
            }),
          }
        );
      }

      return new Response("OK", { status: 200 });
    } catch (error) {
      console.error("Main error:", error.message);
      return new Response("Error: " + error.message, { status: 200 });
    }
  },
};

// ===============================================
// HELPER: JSON Response
// ===============================================
function jsonResponse(obj) {
  return new Response(JSON.stringify(obj, null, 2), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

// ===============================================
// HELPER: Get Firebase Access Token
// ===============================================
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

  const h = base64UrlEncode(JSON.stringify(header));
  const p = base64UrlEncode(JSON.stringify(payload));
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

  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(signingInput)
  );

  const jwt = `${signingInput}.${base64UrlEncode(
    String.fromCharCode(...new Uint8Array(sig))
  )}`;

  const tokRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });

  const tokData = await tokRes.json();
  if (!tokData.access_token) {
    throw new Error(JSON.stringify(tokData));
  }
  return tokData.access_token;
}

// ===============================================
// HELPER: Base64 URL Encode
// ===============================================
function base64UrlEncode(str) {
  const base64 = btoa(unescape(encodeURIComponent(str)));
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
