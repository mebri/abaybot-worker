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
          hasProjectId: !!env.FIREBASE_PROJECT_ID,
          projectIdValue: env.FIREBASE_PROJECT_ID || "MISSING",
          hasClientEmail: !!env.FIREBASE_CLIENT_EMAIL,
          clientEmailValue: env.FIREBASE_CLIENT_EMAIL || "MISSING",
          hasPrivateKey: !!env.FIREBASE_PRIVATE_KEY,
          privateKeyLength: env.FIREBASE_PRIVATE_KEY?.length || 0,
          privateKeyStart: env.FIREBASE_PRIVATE_KEY?.substring(0, 40) || "MISSING",
          hasCloudName: !!env.CLOUDINARY_CLOUD_NAME,
          cloudNameValue: env.CLOUDINARY_CLOUD_NAME || "MISSING",
          hasUploadPreset: !!env.CLOUDINARY_UPLOAD_PRESET,
          uploadPresetValue: env.CLOUDINARY_UPLOAD_PRESET || "MISSING",
        },
        firebaseTest: {},
      };

      // Test Firebase token
      try {
        const token = await getFirebaseToken(env);
        report.firebaseTest.token = "✅ Got token: " + token.substring(0, 30) + "...";

        // Test save
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

        const fbUrl = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/ads`;
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

      return new Response(JSON.stringify(report, null, 2), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
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

      // Parse ad
      const lines = message.text.split("\n").filter((l) => l.trim());
      const title = lines[0] || "";
      let price = "";
      let phone = "";

      for (const line of lines) {
        const priceMatch = line.match(/(?:price|ዋጋ|ETB)[\s:]*([\d,]+)/i);
        if (priceMatch && !price) price = priceMatch[1].replace(/,/g, "");

        const phoneMatch = line.match(/(?:\+251|0)[\s-]?9[\d\s-]{8,}/);
        if (phoneMatch && !phone) phone = phoneMatch[0].replace(/[\s-]/g, "");
      }

      // Save to Firebase
      const token = await getFirebaseToken(env);
      const adData = {
        fields: {
          title: { stringValue: title },
          description: { stringValue: message.text },
          price: { stringValue: price || "0" },
          phone: { stringValue: phone },
          city: { stringValue: "" },
          category: { stringValue: "Telegram" },
          image: { stringValue: "" },
          status: { stringValue: "draft" },
          source: { stringValue: "telegram" },
          views: { integerValue: "0" },
          createdAt: { timestampValue: new Date().toISOString() },
        },
      };

      const fbUrl = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/ads`;
      await fetch(fbUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(adData),
      });

      // Send a reply to Telegram so we know it worked
      if (env.TELEGRAM_BOT_TOKEN && message.chat?.id) {
        await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: message.chat.id,
            text: "✅ Ad received and saved!",
          }),
        });
      }

      return new Response("OK", { status: 200 });
    } catch (error) {
      return new Response("Error: " + error.message, { status: 200 });
    }
  },
};

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
    throw new Error(JSON.stringify(tokenData));
  }
  return tokenData.access_token;
}

function base64UrlEncode(str) {
  const base64 = btoa(unescape(encodeURIComponent(str)));
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

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
