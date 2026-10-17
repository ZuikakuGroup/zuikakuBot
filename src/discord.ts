export const DISCORD_API = "https://discord.com/api/v10";
export const EPHEMERAL_FLAG = 1 << 6;
export const ADMINISTRATOR_PERMISSION = 1 << 3;
export const BAN_MODAL_ID_PREFIX = "ban:";
export const BAN_MESSAGE_INPUT_ID = "ban_message";

export type DiscordRole = {
  id: string;
  name: string;
  position: number;
};

export type DiscordInteraction = {
  type: number;
  id: string;
  token: string;
  application_id: string;
  guild_id?: string;
  member?: {
    user: { id: string };
    roles: string[];
    joined_at: string;
    permissions?: string;
  };
  user?: { id: string };
  data?: {
    name?: string;
    custom_id?: string;
    options?: Array<{
      name: string;
      value?: string;
      type?: number;
    }>;
    components?: Array<{
      type: number;
      components?: Array<{
        type: number;
        custom_id?: string;
        value?: string;
      }>;
    }>;
  };
};

export class DiscordApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export function getOption(interaction: DiscordInteraction, name: string): string | undefined {
  return interaction.data?.options?.find((option) => option.name === name)?.value;
}

export function getModalTextInput(interaction: DiscordInteraction, customId: string): string | undefined {
  for (const row of interaction.data?.components ?? []) {
    const value = row.components?.find((component) => component.custom_id === customId)?.value;
    if (value !== undefined) return value;
  }
  return undefined;
}

export function parseBanModalTargetUserId(customId: string | undefined): string | undefined {
  if (customId === undefined || !customId.startsWith(BAN_MODAL_ID_PREFIX)) return undefined;
  const userId = customId.slice(BAN_MODAL_ID_PREFIX.length);
  return /^\d+$/u.test(userId) ? userId : undefined;
}

export function banModalResponse(targetUserId: string): Record<string, unknown> {
  return {
    type: 9,
    data: {
      custom_id: `${BAN_MODAL_ID_PREFIX}${targetUserId}`,
      title: "BANメッセージ入力",
      components: [
        {
          type: 1,
          components: [
            {
              type: 4,
              custom_id: BAN_MESSAGE_INPUT_ID,
              label: "対象ユーザーへDMで送るメッセージ",
              style: 2,
              required: true,
              min_length: 1,
              max_length: 2000,
              placeholder: "改行を含めて入力できます",
            },
          ],
        },
      ],
    },
  };
}

export function getInteractionUserId(interaction: DiscordInteraction): string | undefined {
  return interaction.member?.user.id ?? interaction.user?.id;
}

export function hasAdministratorPermission(interaction: DiscordInteraction): boolean {
  const permissions = interaction.member?.permissions;
  if (permissions === undefined) return false;
  return (BigInt(permissions) & BigInt(ADMINISTRATOR_PERMISSION)) !== 0n;
}

export async function getGuildOwnerId(guildId: string, token: string): Promise<string> {
  const response = await discordRequest(`/guilds/${guildId}`, token);
  const guild = await response.json<{ owner_id: string }>();
  return guild.owner_id;
}

export async function sendDirectMessage(userId: string, content: string, token: string): Promise<void> {
  const channelResponse = await discordRequest("/users/@me/channels", token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ recipient_id: userId }),
  });
  const channel = await channelResponse.json<{ id: string }>();
  await discordRequest(`/channels/${channel.id}/messages`, token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
  });
}

export async function banGuildMember(
  guildId: string,
  userId: string,
  token: string,
  reason?: string,
): Promise<void> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (reason !== undefined && reason.length > 0) {
    headers["X-Audit-Log-Reason"] = encodeURIComponent(reason.slice(0, 512));
  }
  await discordRequest(`/guilds/${guildId}/bans/${userId}`, token, {
    method: "PUT",
    headers,
    body: JSON.stringify({ delete_message_seconds: 0 }),
  });
}

export function selectHighestRole(memberRoleIds: string[], roles: DiscordRole[], guildId: string): string {
  const rolesById = new Map(roles.map((role) => [role.id, role]));
  const candidates = memberRoleIds
    .filter((roleId) => roleId !== guildId)
    .map((roleId) => rolesById.get(roleId))
    .filter((role): role is DiscordRole => role !== undefined)
    .sort((left, right) => {
      if (right.position !== left.position) return right.position - left.position;
      return BigInt(right.id) > BigInt(left.id) ? 1 : -1;
    });
  return candidates[0]?.name ?? "役職なし";
}

export async function discordRequest(
  path: string,
  token: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bot ${token}`);
  const response = await fetch(`${DISCORD_API}${path}`, { ...init, headers });
  if (!response.ok) {
    throw new DiscordApiError(`Discord API request failed: ${path}`, response.status);
  }
  return response;
}

export async function updateOriginalInteractionResponse(
  interaction: DiscordInteraction,
  content: string,
): Promise<void> {
  const response = await fetch(
    `${DISCORD_API}/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    },
  );
  if (!response.ok) {
    throw new DiscordApiError("Unable to update interaction response", response.status);
  }
}
