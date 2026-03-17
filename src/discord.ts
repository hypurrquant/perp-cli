/**
 * Discord Bot DM client.
 *
 * Sends direct messages to a user via the Discord Bot API (REST only, no gateway).
 * Requires: bot token + user ID.
 */

const DISCORD_API = "https://discord.com/api/v10";

export interface DiscordConfig {
  botToken: string;
  userId: string;
  channelId?: string; // cached DM channel ID
}

/**
 * Open (or retrieve cached) DM channel with a user.
 * Returns the channel ID for sending messages.
 */
export async function openDMChannel(config: DiscordConfig): Promise<string> {
  if (config.channelId) return config.channelId;

  const res = await fetch(`${DISCORD_API}/users/@me/channels`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${config.botToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ recipient_id: config.userId }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Discord DM channel failed (${res.status}): ${body}`);
  }

  const data = (await res.json()) as { id: string };
  return data.id;
}

/**
 * Send a DM to the configured user.
 * Automatically opens a DM channel if needed.
 */
export async function sendDiscordDM(
  config: DiscordConfig,
  message: string,
): Promise<void> {
  const channelId = await openDMChannel(config);

  const res = await fetch(`${DISCORD_API}/channels/${channelId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${config.botToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ content: message }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Discord send failed (${res.status}): ${body}`);
  }
}

/**
 * Validate bot token by fetching bot user info.
 * Returns the bot's username if valid.
 */
export async function validateBotToken(token: string): Promise<{ valid: boolean; username: string }> {
  try {
    const res = await fetch(`${DISCORD_API}/users/@me`, {
      headers: { Authorization: `Bot ${token}` },
    });
    if (!res.ok) return { valid: false, username: "" };
    const data = (await res.json()) as { username: string; discriminator: string };
    return { valid: true, username: `${data.username}#${data.discriminator}` };
  } catch {
    return { valid: false, username: "" };
  }
}
