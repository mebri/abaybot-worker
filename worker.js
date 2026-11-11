/**
 * Yegna Gebeya Telegram Bot - DIAGNOSTIC MODE
 * This will reply to you with exactly what it's doing.
 */

const albumCache = new Map();

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

  // Only respond to commands to avoid spam
  const rawText = (message.text || message.caption || "").trim();
  if (!rawText || rawText.length < 3) return;

  const botId = env.TELEGRAM_BOT_TOKEN ? env.TELEGRAM_BOT_TOKEN.split(":")[0] : "";
  if (message.from && (String(message.from.id) === botId || message.from.is_bot)) return;

  // Watermark skip
  if (rawText.includes("📝 Title:") || rawText.includes("@mebrigranite")) return;

  const chatId = message.chat.id;

  // STEP 1: CONFIRM RECEIPT
  await diagSend(chatId, `✅ RECEIVED\n\n"${rawText.substring(0, 100)}"`, env);

  // STEP 2: CLEAN TEXT
  let cleanText = "";
  let cleanError = "";
  try {
    cleanText = cleanTheText(rawText);
  } catch (e) {
    cleanError = e.message;
  }
  await diagSend(chatId, cleanError ? `❌ CLEAN FAILED: ${cleanError}` : `🧹 CLEANED\n\n"${cleanText.substring(0, 100)}"`, env);

  // STEP 3: CHECK ENV
  const channelId = env.REPOST_CHANNEL_ID;
  if (!channelId) {
    await diagSend(chatId, `❌ REPOST_CHANNEL_ID IS MISSING IN CLOUDFLARE`, env);
    return;
  }
  await diagSend(chatId, `📤 POSTING TO CHANNEL: ${channelId}`, env);

  // STEP 4: POST TO TELEGRAM
  try {
    if (message.photo && message.photo.length > 0) {
      await callTelegram("sendPhoto", {
        chat_id: channelId,
        photo: message.photo[message.photo.length - 1].file_id,
        caption: cleanText.substring(0, 1024),
        caption_entities: []
      }, env);
    } else {
      await callTelegram("sendMessage", {
        chat_id: channelId,
        text: cleanText.substring(0, 4096),
        entities: []
      }, env);
    }
    await diagSend(chatId, `✅ POSTED TO CHANNEL SUCCESSFULLY`, env);
  } catch (e) {
    await diagSend(chatId, `❌ TELEGRAM POST FAILED:\n\n${e.message}`, env);
  }

  // STEP 5: TEST FIREBASE
  try {
    const token = await getFirebaseToken(env);
    if (!token) {
      await diagSend(chatId, `❌ FIREBASE TOKEN EMPTY\n\nCheck FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY`, env);
    } else {
      await diagSend(chatId, `💾 FIREBASE TOKEN OK`, env);
      const projectId = env.FIREBASE_PROJECT_ID;
      const fbUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/ads/diag_test`;
      const res = await fetch(fbUrl, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ fields: { test: { stringValue: new Date().toISOString() } } })
      });
      if (res.ok) {
        await diagSend(chatId, `✅ FIREBASE SAVE SUCCESSFUL`, env);
      } else {
        const errText = await res.text();
        await diagSend(chatId, `❌ FIREBASE SAVE FAILED:\n\n${errText.substring(0, 200)}`, env);
      }
    }
  } catch (e) {
    await diagSend(chatId, `❌ FIREBASE ERROR: ${e.message}`, env);
  }
}

async function diagSend(chatId, text, env) {
  try {
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: text })
    });
  } catch (e) {}
}

async function callTelegram(method, body, env) {
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(`${method} → ${data.description || res.statusText}`);
  return data.result;
}

function cleanTheText(text) {
  if (!text) return "";
  const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{1F1E6}-\u{1F1FF}\u{200D}\u{20E3}\u{2190}-\u{21FF}\u{25A0}-\u{25FF}\u{2B50}\u{1F004}\u{1F0CF}]/gu;
  return text
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/@[a-zA-Z0-9_]{2,}/g, "")
    .replace(/(?:\+?251|0)?[\s.\-]*(?:9|7)\d(?:[\s.\-]?\d){8}/g, "")
    .replace(EMOJI, "")
    .replace(/[*_~`|]/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function getFirebaseToken(env) {
  const now = Math.floor(Date.now() / 1000);
  if (!env.FIREBASE_CLIENT_EMAIL || !env.FIREBASE_PRIVATE_KEY) return "";
  const header = { alg: "RS256", typ: "JWT" };
  const payload = { iss: env.FIREBASE_CLIENT_EMAIL, scope: "https://www.googleapis.com/auth/datastore", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 };
  const encHeader = btoa(JSON.stringify(header)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const encPayload = btoa(JSON.stringify(payload)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const signingInput = `${encHeader}.${encPayload}`;
  const pemContents = env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n").replace("-----BEGIN PRIVATE KEY-----", "").replace("-----END PRIVATE KEY-----", "").replace(/\s/g, "");
  const binaryDer = Uint8Array.from(atob(pemContents), (c) => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey("pkcs8", binaryDer, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sigBuffer = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", cryptoKey, new TextEncoder().encode(signingInput));
  const sigBytes = new Uint8Array(sigBuffer);
  let binary = "";
  for (let i = 0; i < sigBytes.length; i++) binary += String.fromCharCode(sigBytes[i]);
  const signature = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const jwt = `${signingInput}.${signature}`;
  const tokRes = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}` });
  const tokData = await tokRes.json();
  return tokData.access_token || "";
}
