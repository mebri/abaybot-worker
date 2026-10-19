export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") {
      return new Response("Bot is running", { status: 200 });
    }

    try {
      const update = await request.json();
      const message = update.message || update.channel_post;

      if (!message || !message.text) {
        return new Response("OK", { status: 200 });
      }

      // Just reply "Hello" to whatever text was sent
      const replyText = `Hello! I received your message: "${message.text}"`;

      await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: message.chat.id,
          text: replyText
        }),
      });

      return new Response("OK", { status: 200 });
    } catch (error) {
      return new Response("Error: " + error.message, { status: 200 });
    }
  }
};
