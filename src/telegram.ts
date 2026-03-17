/**
 * Telegram Bot API client.
 *
 * Sends messages to a user via Telegram Bot API (REST only).
 * Requires: bot token (from @BotFather) + chat ID.
 */

const TG_API = "https://api.telegram.org";

export interface TelegramConfig {
  botToken: string;
  chatId: string;
}

/**
 * Send a message to the configured chat.
 */
export async function sendTelegramMessage(
  config: TelegramConfig,
  message: string,
  opts?: { parseMode?: "Markdown" | "HTML" },
): Promise<void> {
  const res = await fetch(`${TG_API}/bot${config.botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: config.chatId,
      text: message,
      parse_mode: opts?.parseMode,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Telegram send failed (${res.status}): ${body}`);
  }

  const data = (await res.json()) as { ok: boolean; description?: string };
  if (!data.ok) {
    throw new Error(`Telegram API error: ${data.description ?? "unknown"}`);
  }
}

/**
 * Validate bot token by calling getMe.
 * Returns the bot's username if valid.
 */
export async function validateTelegramBot(token: string): Promise<{ valid: boolean; username: string }> {
  try {
    const res = await fetch(`${TG_API}/bot${token}/getMe`);
    if (!res.ok) return { valid: false, username: "" };
    const data = (await res.json()) as { ok: boolean; result?: { username: string } };
    if (!data.ok || !data.result) return { valid: false, username: "" };
    return { valid: true, username: `@${data.result.username}` };
  } catch {
    return { valid: false, username: "" };
  }
}

/**
 * Get recent updates to find the chat ID from a user who messaged the bot.
 * User must send /start to the bot first.
 */
export async function getRecentChatId(token: string): Promise<{ chatId: string; firstName: string } | null> {
  try {
    const res = await fetch(`${TG_API}/bot${token}/getUpdates?limit=10&offset=-10`);
    if (!res.ok) return null;
    const data = (await res.json()) as {
      ok: boolean;
      result?: Array<{ message?: { chat: { id: number; first_name?: string }; text?: string } }>;
    };
    if (!data.ok || !data.result?.length) return null;

    // Find the most recent /start message or any message
    for (const update of data.result.reverse()) {
      if (update.message?.chat?.id) {
        return {
          chatId: String(update.message.chat.id),
          firstName: update.message.chat.first_name ?? "",
        };
      }
    }
    return null;
  } catch {
    return null;
  }
}
