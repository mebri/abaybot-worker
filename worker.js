export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") {
      return new Response("Bot is running ✅", { status: 200 });
    }

    const report = {
      timestamp: new Date().toISOString(),
      envCheck: {},
      steps: {},
      errors: [],
    };

    try {
      // ============================================
      // STEP 0: Check all environment variables
      // ============================================
      report.envCheck = {
        hasTelegramToken: !!env.TELEGRAM_BOT_TOKEN,
        hasProjectId: !!env.FIREBASE_PROJECT_ID,
        hasClientEmail: !!env.FIREBASE_CLIENT_EMAIL,
        hasPrivateKey: !!env.FIREBASE_PRIVATE_KEY,
        hasCloudName: !!env.CLOUDINARY_CLOUD_NAME,
        hasUploadPreset: !!env.CLOUDINARY_UPLOAD_PRESET,
        projectId: env.FIREBASE_PROJECT_ID || "MISSING",
        clientEmail: env.FIREBASE_CLIENT_EMAIL
          ? env.FIREBASE_CLIENT_EMAIL.substring(0, 40) + "..."
          : "MISSING",
        cloudName: env.CLOUDINARY_CLOUD_NAME || "MISSING",
        uploadPreset: env.CLOUDINARY_UPLOAD_PRESET || "MISSING",
        privateKeyStart: env.FIREBASE_PRIVATE_KEY
          ? env.FIREBASE_PRIVATE_KEY.substring(0, 40)
          : "MISSING",
        privateKeyLength: env.FIREBASE_PRIVATE_KEY
          ? env.FIREBASE_PRIVATE_KEY.length
          : 0,
      };

      const update = await request.json();
      const message = update.message || update.channel_post;

      if (!message) {
        report.steps.parse = "no message object";
        return new Response(JSON.stringify(report), { status: 200 });
      }

      report.steps.messageType = message.photo ? "photo" : "text";
      report.steps.messageText = message.text
        ? message.text.substring(0, 100)
        : "none";
      report.steps.hasPhoto = !!message.photo;

      if (!message.text) {
        report.steps.parse = "no text in message";
        return new Response(JSON.stringify(report), { status: 200 });
      }

      // ============================================
      // TEST 1: Can we get a Firebase token?
      // ============================================
      try {
        const token = await getFirebaseToken(env);
        report.steps.firebaseToken = token ? "✅ OK" : "❌ empty";
      } catch (e) {
        report.steps.firebaseToken = "❌ FAILED";
        report.errors.push("Firebase token: " + e.message);
      }

      // ============================================
      // TEST 2: Try saving a simple ad
      // ============================================
      try {
        const token = await getFirebaseToken(env);
        const projectId = env.FIREBASE_PROJECT_ID;

        const adData = {
          fields: {
            title: { stringValue: "TEST AD FROM BOT" },
            description: { stringValue: "Debug test" },
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

        const firebaseUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/ads`;

        const saveRes = await fetch(firebaseUrl, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(adData),
        });

        const responseText = await saveRes.text();

        if (saveRes.ok) {
          report.steps.firebaseSave = "✅ OK";
          report.steps.firebaseResponse = responseText.substring(0, 200);
        } else {
          report.steps.firebaseSave = "❌ FAILED (" + saveRes.status + ")";
          report.errors.push("Firebase save: " + responseText.substring(0, 300));
        }
      } catch (e) {
        report.steps.firebaseSave = "❌ EXCEPTION";
        report.errors.push("Save exception: " + e.message);
      }

      return new Response(JSON.stringify(report, null, 2), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    } catch (error) {
      report.errors.push("Main error: " + error.message);
      return new Response(JSON.stringify(report, null, 2), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
  },
};

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
