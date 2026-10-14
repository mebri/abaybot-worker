export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") {
      return new Response("Bot is running ✅", { status: 200 });
    }

    try {
      const update = await request.json();
      console.log("📩 New Telegram update:", JSON.stringify(update));

      const message = update.message || update.channel_post;

      if (message && message.text) {
        console.log("📝 Message text:", message.text);
        console.log("👤 From chat:", message.chat.title || message.chat.username);
        console.log("🖼 Has photo:", !!message.photo);
      }

      return new Response("OK", { status: 200 });
    } catch (error) {
      console.error("❌ Error:", error.message);
      return new Response("Error", { status: 200 });
    }
  },
};
