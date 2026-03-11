/*
  Telegram bot helper for Espaco Serena backend.
  Usage:
    node telegram-setup.js check <BOT_TOKEN>
    node telegram-setup.js updates <BOT_TOKEN>
    node telegram-setup.js send <BOT_TOKEN> <CHAT_ID> [message]
*/

function usage() {
  console.log("Usage:");
  console.log("  node telegram-setup.js check <BOT_TOKEN>");
  console.log("  node telegram-setup.js updates <BOT_TOKEN>");
  console.log("  node telegram-setup.js send <BOT_TOKEN> <CHAT_ID> [message]");
}

async function callTelegram(token, method, body) {
  const url = "https://api.telegram.org/bot" + token + "/" + method;
  const response = await fetch(url, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });

  const data = await response.json().catch(function () {
    return null;
  });

  if (!response.ok || !data || data.ok !== true) {
    const msg = (data && data.description) || "Telegram API request failed";
    throw new Error(msg);
  }

  return data.result;
}

async function run() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command) {
    usage();
    process.exit(1);
  }

  if (command === "check") {
    const token = args[1];
    if (!token) {
      usage();
      process.exit(1);
    }

    const me = await callTelegram(token, "getMe");
    console.log("Bot validated successfully.");
    console.log("username:", me.username || "-");
    console.log("id:", me.id);
    return;
  }

  if (command === "updates") {
    const token = args[1];
    if (!token) {
      usage();
      process.exit(1);
    }

    const updates = await callTelegram(token, "getUpdates");
    if (!updates.length) {
      console.log("No updates found yet.");
      console.log("Send a message to your bot first, then run this again.");
      return;
    }

    console.log("Latest chats detected:");
    const seen = new Set();

    for (let i = updates.length - 1; i >= 0; i -= 1) {
      const msg = updates[i].message || updates[i].channel_post;
      if (!msg || !msg.chat) continue;

      const key = String(msg.chat.id);
      if (seen.has(key)) continue;
      seen.add(key);

      console.log("chat_id:", msg.chat.id, "| type:", msg.chat.type, "| title/user:", msg.chat.title || msg.chat.username || msg.chat.first_name || "-");
    }
    return;
  }

  if (command === "send") {
    const token = args[1];
    const chatId = args[2];
    const text = args.slice(3).join(" ") || "Espaco Serena: teste de mensagem 2FA";

    if (!token || !chatId) {
      usage();
      process.exit(1);
    }

    await callTelegram(token, "sendMessage", {
      chat_id: chatId,
      text: text
    });

    console.log("Message sent successfully.");
    return;
  }

  usage();
  process.exit(1);
}

run().catch(function (error) {
  console.error("Error:", error.message || error);
  process.exit(1);
});
