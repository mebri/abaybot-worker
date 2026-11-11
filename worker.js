/**
 * Yegna Gebeya - FIREBASE INTEGRATION TESTER
 */

export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") return new Response("Bot is running ✅", { status: 200 });
    try {
      const update = await request.json();
      ctx.waitUntil(processUpdate(update, env));
      return new Response("OK", { status: 200 });
    } catch (error) {
      return new Response("Error: " + error.message, { status: 500 });
    }
  }
};

async function processUpdate(update, env) {
  const message = update.message || update.channel_post;
  if (!message) return;

  const chatId = message.chat.id;
  const rawText = (message.text || message.caption || "").trim();

  // Ignore bot messages
  const botId = env.TELEGRAM_BOT_TOKEN ? env.TELEGRAM_BOT_TOKEN.split(":")[0] : "";
  if (message.from && (String(message.from.id) === botId || message.from.is_bot)) return;

  if (!rawText || rawText.length < 3) return;

  // STEP 1: CONFIRM RECEIPT
  await reply(chatId, `✅ BOT RECEIVED MESSAGE.\n\nStarting Firebase Diagnostic...`, env);

  // STEP 2: CHECK ENVIRONMENT VARIABLES
  const projectId = env.FIREBASE_PROJECT_ID;
  const clientEmail = env.FIREBASE_CLIENT_EMAIL;
  let privateKey = env.FIREBASE_PRIVATE_KEY;

  if (!projectId || !clientEmail || !privateKey) {
    await reply(chatId, `❌ MISSING ENV VARS\n\nProjectID: ${projectId ? "✅" : "❌"}\nEmail: ${clientEmail ? "✅" : "❌"}\nPrivate Key: ${privateKey ? "✅" : "❌"}\n\nPlease check Cloudflare Settings > Variables.`, env);
    return;
  }

  await reply(chatId, `✅ ENV VARS FOUND.\n\nProject ID: ${projectId}\nEmail: ${clientEmail.substring(0, 10)}...\nKey length: ${privateKey.length} chars`, env);

  // STEP 3: FORMAT THE PRIVATE KEY
  // Cloudflare often saves the key with literal \n or with quotes. We must clean it.
  if (privateKey.startsWith('"') && privateKey.endsWith('"')) {
    privateKey = privateKey.slice(1, -1);
  }
  privateKey = privateKey.replace(/\\n/g, "\n");

  if (!privateKey.includes("-----BEGIN PRIVATE KEY-----")) {
    await reply(chatId, `❌ PRIVATE KEY FORMAT ERROR\n\nThe key is missing the "-----BEGIN PRIVATE KEY-----" header. Check how you pasted it into Cloudflare.`, env);
    return;
  }

  // STEP 4: GENERATE FIREBASE TOKEN (JWT)
  let token = "";
  try {
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: "RS256", typ: "JWT" };
    const payload = { iss: clientEmail, scope: "https://www.googleapis.com/auth/datastore", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 };
    
    // Safe Base64 URL Encoding
    const encHeader = base64UrlEncode(JSON.stringify(header));
    const encPayload = base64UrlEncode(JSON.stringify(payload));
    const signingInput = `${encHeader}.${encPayload}`;
    
    // Prepare Key
    const pemContents = privateKey.replace("-----BEGIN PRIVATE KEY-----", "").replace("-----END PRIVATE KEY-----", "").replace(/\s/g, "");
    const binaryDer = Uint8Array.from(atob(pemContents), (c) => c.charCodeAt(0));
    
    // Sign
    const cryptoKey = await crypto.subtle.importKey("pkcs8", binaryDer, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
    const sigBuffer = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", cryptoKey, new TextEncoder().encode(signingInput));
    const sigBytes = new Uint8Array(sigBuffer);
    
    let binary = "";
    for (let i = 0; i < sigBytes.length; i++) binary += String.fromCharCode(sigBytes[i]);
    const signature = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const jwt = `${signingInput}.${signature}`;

    // Fetch Token from Google
    const tokRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`
    });
    const tokData = await tokRes.json();
    
    if (!tokData.access_token) {
      await reply(chatId, `❌ GOOGLE AUTH FAILED\n\nGoogle rejected the Private Key. Make sure the key belongs to the Client Email.\n\nGoogle Response:\n${JSON.stringify(tokData).substring(0, 200)}`, env);
      return;
    }
    
    token = tokData.access_token;
    await reply(chatId, `✅ GOOGLE AUTH SUCCESS.\n\nToken generated successfully. Now testing Firestore save...`, env);
  } catch (err) {
    await reply(chatId, `❌ JWT GENERATION CRASH\n\n${err.message}`, env);
    return;
  }

  // STEP 5: TEST FIRESTORE WRITE
  try {
    const docId = `test_${Date.now()}`;
    const fbUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/ads/${docId}`;
    
    const adData = {
      fields: {
        title: { stringValue: "Integration Test" },
        description: { stringValue: rawText },
        createdAt: { timestampValue: new Date().toISOString() }
      }
    };

    const fbRes = await fetch(fbUrl, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(adData)
    });

    if (!fbRes.ok) {
      const errText = await fbRes.text();
      await reply(chatId, `❌ FIRESTORE WRITE FAILED.\n\nStatus: ${fbRes.status}\nError: ${errText.substring(0, 300)}\n\nThis usually means Firestore security rules are blocking the bot, or the Project ID is wrong.`, env);
      return;
    }

    await reply(chatId, `🎉 WEBSITE INTEGRATION SUCCESSFUL!\n\nThe bot successfully saved the test message to Firestore. Check your website database.`, env);

  } catch (err) {
    await reply(chatId, `❌ FIRESTORE FETCH CRASH\n\n${err.message}`, env);
  }
}

// ============================================
// HELPERS
// ============================================
async function reply(chatId, text, env) {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: text })
  });
}

function base64UrlEncode(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
