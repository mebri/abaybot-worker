export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") {
      return new Response("Bot is running", { status: 200 });
    }

    try {
      const update = await request.json();
      const message = update.message || update.channel_post;
      
      if (!message) {
        return new Response("OK", { status: 200 });
      }

      // 1. SEND A SUCCESS MESSAGE
      await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
          chat_id: message.chat.id, 
          text: "🤖 TEST: I received your message. Waiting 2 seconds to delete it..."
        }),
      });

      // 2. WAIT 2 SECONDS
      await new Promise(resolve => setTimeout(resolve, 2000));

      // 3. TRY TO DELETE THE ORIGINAL MESSAGE
      const delRes = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/deleteMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
          chat_id: message.chat.id, 
          message_id: message.message_id 
        }),
      });

      const delData = await delRes.json();
      
      // 4. IF DELETE FAILED, TELL US WHY
      if (!delData.ok) {
        await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ 
            chat_id: message.chat.id, 
            text: `❌ DELETE FAILED. Reason: ${delData.description}`
          }),
        });
      }

      return new Response("OK", { status: 200 });
    } catch (error) {
      return new Response("Error: " + error.message, { status: 200 });
    }
  }
};
