export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/test") {
      const report = { envCheck: {}, serviceAccountInfo: {}, firebaseTest: {} };
      report.envCheck = {
        hasTelegramToken: !!env.TELEGRAM_BOT_TOKEN,
        hasServiceAccount: !!env.FIREBASE_SERVICE_ACCOUNT,
        hasCloudName: !!env.CLOUDINARY_CLOUD_NAME,
        hasUploadPreset: !!env.CLOUDINARY_UPLOAD_PRESET,
      };
      try {
        const sa = JSON.parse(atob(env.FIREBASE_SERVICE_ACCOUNT));
        report.serviceAccountInfo = {
          projectId: sa.project_id,
          clientEmail: sa.client_email,
          privateKeyLength: sa.private_key?.length || 0,
        };
      } catch (e) {
        report.serviceAccountInfo.error = e.message;
        return jsonResponse(report);
      }
      try {
        const token = await getFirebaseToken(env);
        report.firebaseTest.token = "✅ Got token";

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
        report.firebaseTest.saveStatus = saveRes.status;
        report.firebaseTest.saveOk = saveRes.ok;
        report.firebaseTest.saveResponse = (await saveRes.text()).substring(0, 300);
      } catch (e) {
        report.firebaseTest.error = e.message;
      }
      return jsonResponse(report);
    }

    if (request.method !== "POST") {
      return new Response("Bot is running ✅", { status: 200 });
    }

    try {
      const update = await request.json();
      const message = update.message || update.channel_post;
      if (!message || !message.text) {
        return new Response("OK", { status: 200 });
      }

      const lines = message.text.split("\n").filter((l) => l.trim());
      const title = lines[0] || "Untitled Ad";
      let price = "", phone = "", city = "";

      for (const line of lines) {
        const priceMatch = line.match(/(?:price|ዋጋ|ETB)[\s:]*([\d,]+)/i);
        if (priceMatch && !price) price = priceMatch[1].replace(/,/g, "");
        const phoneMatch = line.match(/(?:\+251|0)[\s-]?9[\d\s-]{8,}/);
        if (phoneMatch && !phone) phone = phoneMatch[0].replace(/[\s-]/g, "");
        if (/addis|ababa|adama|hawassa|bahir dar|mekelle|gondar|jimma|dire dawa/i.test(line) && !city) city = line;
      }

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
            if (cloudData.secure_url) imageUrl = cloudData.secure_url;
          }
        } catch (e) {
          console.error("Image error:", e.message);
        }
      }

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
          images: { arrayValue: imageUrl ? { values: [{ stringValue: imageUrl }] } : { values: [] } },
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

      if (env.TELEGRAM_BOT_TOKEN && message.chat?.id) {
        await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: message.chat.id,
            text: saveRes.ok ? "✅ Ad saved to drafts!" : "⚠️ Save failed.",
          }),
        });
      }

      return new Response("OK", { status: 200 });
    } catch (error) {
      return new Response("Error: " + error.message, { status: 200 });
    }
  },
};

function jsonResponse(obj) {
  return new Response(JSON.stringify(obj, null, 2), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

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

  // ✅ FIXED: encode signature byte-by-byte (not as UTF-8 string)
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

// For JSON strings (ASCII) — uses the safe trick
function base64UrlEncodeString(str) {
  const base64 = btoa(unescape(encodeURIComponent(str)));
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ✅ For binary data (signatures, etc.) — encodes each byte directly
function base64UrlEncodeBytes(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
