export const DISCORD_API = "https://discord.com/api/v10";
export const EPHEMERAL_FLAG = 1 << 6;
export const ADMINISTRATOR_PERMISSION = 1 << 3;

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
    options?: Array<{
      name: string;
      value?: string;
      type?: number;
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

export function getInteractionUserId(interaction: DiscordInteraction): string | undefined {
  return interaction.member?.user.id ?? interaction.user?.id;
}

export function hasAdministratorPermission(interaction: DiscordInteraction): boolean {
  const permissions = interaction.member?.permissions;
  if (permissions === undefined) return false;
  return (BigInt(permissions) & BigInt(ADMINISTRATOR_PERMISSION)) !== 0n;
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
