export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") {
      return new Response("Bot is running", { status: 200 });
    }

    // 1. Check if the token exists in Cloudflare Secrets
    if (!env.TELEGRAM_BOT_TOKEN) {
      return new Response("ERROR: TELEGRAM_BOT_TOKEN is missing in Cloudflare settings.", { status: 500 });
    }

    try {
      const update = await request.json();
      const message = update.message || update.channel_post;
      
      if (!message) {
        return new Response("No message found", { status: 200 });
      }

      // 2. Try to send a message
      const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
          chat_id: message.chat.id, 
          text: "🤖 TEST: The code is finally running!" 
        }),
      });

      const data = await res.json();
      
      // 3. If Telegram rejects the message, return a 500 error so it shows up in the webhook info
      if (!data.ok) {
         return new Response("Telegram Error: " + JSON.stringify(data), { status: 500 });
      }

      return new Response("OK", { status: 200 });
    } catch (error) {
      return new Response("Worker Error: " + error.message, { status: 500 });
    }
  }
};
