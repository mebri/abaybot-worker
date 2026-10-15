export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") {
      return new Response("Bot is running ✅", { status: 200 });
    }

    const debug = {
      timestamp: new Date().toISOString(),
      env: {},
      steps: {},
      errors: [],
      chatId: null,
    };

    try {
      // ============================================
      // STEP 0: Check all environment variables
      // ============================================
      debug.env = {
        telegramToken: env.TELEGRAM_BOT_TOKEN
          ? `set (${env.TELEGRAM_BOT_TOKEN.length} chars)`
          : "❌ MISSING",
        projectId: env.FIREBASE_PROJECT_ID || "❌ MISSING",
        clientEmail: env.FIREBASE_CLIENT_EMAIL
          ? env.FIREBASE_CLIENT_EMAIL.substring(0, 50) + "..."
          : "❌ MISSING",
        privateKey: env.FIREBASE_PRIVATE_KEY
          ? `set (${env.FIREBASE_PRIVATE_KEY.length} chars, starts: ${env.FIREBASE_PRIVATE_KEY.substring(0, 30)})`
          : "❌ MISSING",
        cloudName: env.CLOUDINARY_CLOUD_NAME || "❌ MISSING",
        uploadPreset: env.CLOUDINARY_UPLOAD_PRESET || "❌ MISSING",
      };

      // ============================================
      // STEP 1: Parse Telegram update
      // ============================================
      const update = await request.json();
      const message = update.message || update.channel_post;

      if (!message) {
        debug.steps.parse = "❌ No message in update";
        return new Response("OK", { status: 200 });
      }

      debug.chatId = message.chat?.id;
      debug.steps.messageText = message.text
        ? message.text.substring(0, 100)
        : "none";
      debug.steps.hasPhoto = !!message.photo;

      // ============================================
      // STEP 2: Test Firebase Token
      // ============================================
      let firebaseToken = null;
      try {
        firebaseToken = await getFirebaseToken(env);
        debug.steps.firebaseToken = "✅ Got token";
      } catch (e) {
        debug.steps.firebaseToken = "❌ FAILED";
        debug.errors.push("Firebase token error: " + e.message);
      }

      // ============================================
      // STEP 3: Try saving to Firebase
      // ============================================
      if (firebaseToken) {
        try {
          const adData = {
            fields: {
              title: { stringValue: "BOT DEBUG TEST" },
              description: { stringValue: "If you see this, the bot works!" },
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

          const url = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/ads`;

          const saveRes = await fetch(url, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${firebaseToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(adData),
          });

          const responseText = await saveRes.text();

          if (saveRes.ok) {
            debug.steps.firebaseSave = "✅ SAVED";
          } else {
            debug.steps.firebaseSave = `❌ FAILED (HTTP ${saveRes.status})`;
            debug.errors.push("Firebase response: " + responseText.substring(0, 500));
          }
        } catch (e) {
          debug.steps.firebaseSave = "❌ EXCEPTION";
          debug.errors.push("Save exception: " + e.message);
        }
      } else {
        debug.steps.firebaseSave = "⏭️ SKIPPED (no token)";
      }

      // ============================================
      // STEP 4: Send debug report to Telegram
      // ============================================
      if (debug.chatId && env.TELEGRAM_BOT_TOKEN) {
        try {
          const reportText = formatDebugReport(debug);
          await fetch(
            `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                chat_id: debug.chatId,
                text: reportText,
                parse_mode: "HTML",
              }),
            }
          );
        } catch (e) {
          // Silent fail — we don't want to break the webhook
        }
      }

      return new Response("OK", { status: 200 });
    } catch (error) {
      debug.errors.push("Main error: " + error.message);

      // Try to send error to Telegram
      const update = await request.clone().json().catch(() => ({}));
      const message = update.message || update.channel_post;
      if (message?.chat?.id && env.TELEGRAM_BOT_TOKEN) {
        try {
          await fetch(
            `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                chat_id: message.chat.id,
                text: "🚨 Bot error:\n\n" + debug.errors.join("\n\n"),
              }),
            }
          );
        } catch (e) {}
      }

      return new Response("OK", { status: 200 });
    }
  },
};

// ===============================================
// DEBUG: Format the report for Telegram
// ===============================================
function formatDebugReport(debug) {
  let text = "🤖 <b>BOT DEBUG REPORT</b>\n\n";

  text += "<b>📋 Environment:</b>\n";
  for (const [key, val] of Object.entries(debug.env)) {
    text += `• <code>${key}</code>: ${val}\n`;
  }

  text += "\n<b>🔧 Steps:</b>\n";
  for (const [key, val] of Object.entries(debug.steps)) {
    text += `• <code>${key}</code>: ${val}\n`;
  }

  if (debug.errors.length > 0) {
    text += "\n<b>❌ Errors:</b>\n";
    debug.errors.forEach((e) => {
      text += `• ${e.substring(0, 500)}\n\n`;
    });
  }

  return text;
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
