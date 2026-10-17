import { Hibiki } from "@hibiki-js/core";
import { discord } from "@hibiki-js/discord";
import {
  BAN_MESSAGE_INPUT_ID,
  DiscordApiError,
  type DiscordInteraction,
  type DiscordRole,
  EPHEMERAL_FLAG,
  banGuildMember,
  banModalResponse,
  discordRequest,
  getGuildOwnerId,
  getInteractionUserId,
  getModalTextInput,
  getOption,
  hasAdministratorPermission,
  parseBanModalTargetUserId,
  selectHighestRole,
  sendDirectMessage,
  updateOriginalInteractionResponse,
} from "./discord";
import { createCertificatePdf } from "./pdf";
import { DiscordGateway } from "./gateway";

const PING = 1;
const APPLICATION_COMMAND = 2;
const MODAL_SUBMIT = 5;
const DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE = 5; // InteractionCallbackType; same numeric value as MODAL_SUBMIT
const FONT_OBJECT_KEY = "fonts/NotoSansJP-Regular.ttf";
export type WorkerSecrets = {
  DISCORD_BOT_TOKEN: string;
  DISCORD_PUBLIC_KEY: string;
  GUILD_ID: string;
  ORGANIZATION_NAME: string;
  ORGANIZATION_ADDRESS: string;
  ISSUER_TITLE: string;
  ISSUER_NAME: string;
  CONTACT_EMAIL: string;
  RECORDER_SERVICE_URL: string;
  RECORDER_SHARED_SECRET: string;
};
export type WorkerEnv = Env & WorkerSecrets;
export { DiscordGateway };

export type MemberSnapshot = {
  guildId: string;
  userId: string;
  joinedAt: string;
  roleName: string;
};

export default {
  async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("Not found", { status: 404 });
    }

    try {
      return await createDiscordInteractionApp(env, ctx).handle(request, { provider: "discord" });
    } catch {
      console.error(JSON.stringify({ event: "interaction_configuration_error" }));
      return new Response("configuration error", { status: 500 });
    }
  },
};

export function createDiscordInteractionApp(env: WorkerEnv, ctx: ExecutionContext) {
  const handle = ({ event }: { event: unknown }) => {
    if (!isDiscordInteraction(event)) return new Response("Invalid interaction", { status: 400 });
    return handleVerifiedInteraction(event, env, ctx);
  };
  return new Hibiki({ strictEvents: true })
    .use(discord({ publicKey: env.DISCORD_PUBLIC_KEY }))
    .on("discord.ping", () => {
      ctx.waitUntil(env.DISCORD_GATEWAY.getByName(env.GUILD_ID).start());
      return json({ type: PING });
    })
    .on("discord.application_command", handle)
    .on("discord.modal_submit", handle)
    .on("discord.message_component", handle)
    .on("discord.application_command_autocomplete", handle);
}

async function handleVerifiedInteraction(interaction: DiscordInteraction, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
  if (interaction.guild_id !== env.GUILD_ID || interaction.member === undefined) {
    return ephemeral("このコマンドは指定されたサーバー内でのみ利用できます。");
  }
  if (interaction.type === MODAL_SUBMIT) {
    if (parseBanModalTargetUserId(interaction.data?.custom_id) === undefined) {
      return ephemeral("未対応のフォームです。");
    }
    ctx.waitUntil(completeBanFromModal(interaction, env));
    return deferredEphemeral();
  }
  if (interaction.type !== APPLICATION_COMMAND) {
    return new Response("Unsupported interaction", { status: 400 });
  }

  const commandName = interaction.data?.name;
  if (commandName === "issue") {
    ctx.waitUntil(issueCertificate(interaction, env));
    return deferredEphemeral();
  }
  if (commandName === "register") {
    ctx.waitUntil(registerVolunteerName(interaction, env));
    return deferredEphemeral();
  }
  if (commandName === "start" || commandName === "stop") {
    ctx.waitUntil(dispatchRecordingCommand(interaction, env, commandName));
    return deferredEphemeral();
  }
  if (commandName === "ban") {
    return openBanModal(interaction, env);
  }
  return ephemeral("未対応のコマンドです。");
}

async function dispatchRecordingCommand(
  interaction: DiscordInteraction,
  env: WorkerEnv,
  action: "start" | "stop",
): Promise<void> {
  const userId = getInteractionUserId(interaction);
  const guildId = interaction.guild_id;
  if (userId === undefined || guildId === undefined) return;
  try {
    const response = await fetch(`${env.RECORDER_SERVICE_URL.replace(/\/$/, "")}/commands`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Recorder-Secret": env.RECORDER_SHARED_SECRET },
      body: JSON.stringify({ action, guildId, userId, applicationId: interaction.application_id, interactionToken: interaction.token }),
    });
    if (!response.ok) throw new Error(`recorder responded ${response.status}`);
  } catch (error) {
    console.log(JSON.stringify({ event: "recording_command_dispatch_failed", action, user_id: userId, error: errorMessage(error) }));
    await safelyUpdate(interaction, "録音サービスに接続できませんでした。しばらくしてからもう一度お試しください。");
  }
}

async function issueCertificate(interaction: DiscordInteraction, env: WorkerEnv): Promise<void> {
  const userId = getInteractionUserId(interaction);
  const guildId = interaction.guild_id;
  if (userId === undefined || guildId === undefined || interaction.member === undefined) {
    return;
  }

  try {
    const profile = await env.DB.prepare(
      "SELECT full_name FROM volunteer_profiles WHERE guild_id = ? AND user_id = ?",
    ).bind(guildId, userId).first<{ full_name: string }>();
    if (profile === null) {
      await updateOriginalInteractionResponse(interaction, "氏名が未登録です。管理者に氏名登録を依頼してください。");
      logOutcome("certificate_not_issued", userId, "profile_not_found");
      return;
    }
    const roles = await getGuildRoles(guildId, env.DISCORD_BOT_TOKEN);
    const roleName = selectHighestRole(interaction.member.roles, roles, guildId);
    await sendCertificateForSnapshot(env, {
      guildId,
      userId,
      joinedAt: interaction.member.joined_at,
      roleName,
    }, profile.full_name);
    await updateOriginalInteractionResponse(interaction, "ボランティア活動証明書をDMでお送りしました。");
    logOutcome("certificate_issued", userId);
  } catch (error) {
    const message = error instanceof DiscordApiError && (error.status === 403 || error.status === 404)
      ? "DMを送信できませんでした。BotからのDMを許可してから、もう一度お試しください。"
      : "証明書の作成中にエラーが発生しました。管理者にお問い合わせください。";
    try {
      await updateOriginalInteractionResponse(interaction, message);
    } catch (updateError) {
      console.log(JSON.stringify({ event: "interaction_response_update_failed", error: errorMessage(updateError) }));
    }
    logOutcome("certificate_not_issued", userId, errorMessage(error));
  }
}

async function registerVolunteerName(interaction: DiscordInteraction, env: WorkerEnv): Promise<void> {
  if (!hasAdministratorPermission(interaction)) {
    await safelyUpdate(interaction, "このコマンドを実行する権限がありません。");
    return;
  }
  const userId = getOption(interaction, "user");
  const fullName = getOption(interaction, "name")?.trim();
  const guildId = interaction.guild_id;
  if (userId === undefined || fullName === undefined || fullName.length === 0 || guildId === undefined) {
    await safelyUpdate(interaction, "ユーザーと氏名を正しく指定してください。");
    return;
  }

  try {
    const member = await getGuildMember(guildId, userId, env.DISCORD_BOT_TOKEN);
    const roles = await getGuildRoles(guildId, env.DISCORD_BOT_TOKEN);
    await saveMemberSnapshot(env, {
      guildId,
      userId,
      joinedAt: member.joined_at,
      roleName: selectHighestRole(member.roles, roles, guildId),
    }, fullName);
    await safelyUpdate(interaction, "氏名を登録しました。");
    logOutcome("profile_updated", userId);
  } catch (error) {
    await safelyUpdate(interaction, "氏名の登録中にエラーが発生しました。");
    logOutcome("profile_update_failed", userId, errorMessage(error));
  }
}

async function openBanModal(interaction: DiscordInteraction, env: WorkerEnv): Promise<Response> {
  const actorId = getInteractionUserId(interaction);
  const targetUserId = getOption(interaction, "user");
  const guildId = interaction.guild_id;
  if (actorId === undefined || targetUserId === undefined || guildId === undefined) {
    return ephemeral("ユーザーを正しく指定してください。");
  }

  try {
    const ownerId = await getGuildOwnerId(guildId, env.DISCORD_BOT_TOKEN);
    if (actorId !== ownerId) {
      logOutcome("ban_denied", targetUserId, "not_guild_owner");
      return ephemeral("このコマンドはサーバーオーナーのみが使用できます。");
    }
    if (targetUserId === actorId || targetUserId === ownerId) {
      return ephemeral("サーバーオーナーはBANできません。");
    }
    if (targetUserId === interaction.application_id) {
      return ephemeral("このBot自身はBANできません。");
    }
    return json(banModalResponse(targetUserId));
  } catch (error) {
    logOutcome("ban_modal_open_failed", targetUserId, errorMessage(error));
    return ephemeral("BANフォームを開けませんでした。しばらくしてからもう一度お試しください。");
  }
}

async function completeBanFromModal(interaction: DiscordInteraction, env: WorkerEnv): Promise<void> {
  const actorId = getInteractionUserId(interaction);
  const targetUserId = parseBanModalTargetUserId(interaction.data?.custom_id);
  const message = getModalTextInput(interaction, BAN_MESSAGE_INPUT_ID)?.trim();
  const guildId = interaction.guild_id;
  if (actorId === undefined || targetUserId === undefined || message === undefined || message.length === 0 || guildId === undefined) {
    await safelyUpdate(interaction, "ユーザーとメッセージを正しく指定してください。");
    return;
  }

  try {
    const ownerId = await getGuildOwnerId(guildId, env.DISCORD_BOT_TOKEN);
    if (actorId !== ownerId) {
      await safelyUpdate(interaction, "このコマンドはサーバーオーナーのみが使用できます。");
      logOutcome("ban_denied", targetUserId, "not_guild_owner");
      return;
    }
    if (targetUserId === actorId || targetUserId === ownerId) {
      await safelyUpdate(interaction, "サーバーオーナーはBANできません。");
      return;
    }
    if (targetUserId === interaction.application_id) {
      await safelyUpdate(interaction, "このBot自身はBANできません。");
      return;
    }

    let dmSent = true;
    try {
      await sendDirectMessage(targetUserId, message, env.DISCORD_BOT_TOKEN);
    } catch (error) {
      dmSent = false;
      console.log(JSON.stringify({ event: "ban_dm_failed", user_id: targetUserId, error: errorMessage(error) }));
    }

    await banGuildMember(guildId, targetUserId, env.DISCORD_BOT_TOKEN, message);
    await safelyUpdate(
      interaction,
      dmSent
        ? `<@${targetUserId}> をBANし、指定メッセージをDMで送信しました。`
        : `<@${targetUserId}> をBANしました。DMは送信できませんでした（相手がDMを拒否している可能性があります）。`,
    );
    logOutcome("member_banned", targetUserId, dmSent ? "dm_sent" : "dm_failed");
  } catch (error) {
    const messageText = error instanceof DiscordApiError && error.status === 403
      ? "BANに失敗しました。BotにBAN権限があるか、対象より上位のロールかを確認してください。"
      : "BAN処理中にエラーが発生しました。";
    await safelyUpdate(interaction, messageText);
    logOutcome("ban_failed", targetUserId, errorMessage(error));
  }
}

async function safelyUpdate(interaction: DiscordInteraction, content: string): Promise<void> {
  try {
    await updateOriginalInteractionResponse(interaction, content);
  } catch (error) {
    console.log(JSON.stringify({ event: "interaction_response_update_failed", error: errorMessage(error) }));
  }
}

async function getGuildRoles(guildId: string, token: string): Promise<DiscordRole[]> {
  const response = await discordRequest(`/guilds/${guildId}/roles`, token);
  return response.json<DiscordRole[]>();
}

async function getGuildMember(guildId: string, userId: string, token: string): Promise<{ joined_at: string; roles: string[] }> {
  const response = await discordRequest(`/guilds/${guildId}/members/${userId}`, token);
  return response.json<{ joined_at: string; roles: string[] }>();
}

export async function saveMemberSnapshot(env: WorkerEnv, snapshot: MemberSnapshot, fullName?: string): Promise<void> {
  const now = new Date().toISOString();
  if (fullName !== undefined) {
    await env.DB.prepare(
      `INSERT INTO volunteer_profiles (guild_id, user_id, full_name, joined_at, role_name, last_seen_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(guild_id, user_id) DO UPDATE SET full_name = excluded.full_name, joined_at = excluded.joined_at, role_name = excluded.role_name, last_seen_at = excluded.last_seen_at, updated_at = excluded.updated_at`,
    ).bind(snapshot.guildId, snapshot.userId, fullName, snapshot.joinedAt, snapshot.roleName, now, now).run();
    return;
  }
  await env.DB.prepare(
    `UPDATE volunteer_profiles
     SET joined_at = ?, role_name = ?, last_seen_at = ?
     WHERE guild_id = ? AND user_id = ?`,
  ).bind(snapshot.joinedAt, snapshot.roleName, now, snapshot.guildId, snapshot.userId).run();
}

export async function sendCertificateForSnapshot(env: WorkerEnv, snapshot: MemberSnapshot, fullName?: string): Promise<boolean> {
  const profile = fullName === undefined
    ? await env.DB.prepare(
      "SELECT full_name FROM volunteer_profiles WHERE guild_id = ? AND user_id = ?",
    ).bind(snapshot.guildId, snapshot.userId).first<{ full_name: string }>()
    : { full_name: fullName };
  if (profile === null) return false;
  await saveMemberSnapshot(env, snapshot);
  const fontObject = await env.CERTIFICATE_ASSETS.get(FONT_OBJECT_KEY);
  if (fontObject === null) throw new Error(`Required font object is missing: ${FONT_OBJECT_KEY}`);
  const now = new Date();
  const pdf = await createCertificatePdf({
    fullName: profile.full_name,
    activityPeriod: `${formatJapaneseDate(snapshot.joinedAt)} ～ ${formatJapaneseDate(now.toISOString())}`,
    roleName: snapshot.roleName,
    issuedOn: formatJapaneseDate(now.toISOString()),
    organizationName: env.ORGANIZATION_NAME,
    organizationAddress: env.ORGANIZATION_ADDRESS,
    issuerTitle: env.ISSUER_TITLE,
    issuerName: env.ISSUER_NAME,
    contactEmail: env.CONTACT_EMAIL,
  }, await fontObject.arrayBuffer());
  await sendCertificateDm(snapshot.userId, pdf, env.DISCORD_BOT_TOKEN);
  return true;
}

export async function sendCertificateDm(userId: string, pdf: Uint8Array, token: string): Promise<void> {
  const channelResponse = await discordRequest("/users/@me/channels", token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ recipient_id: userId }),
  });
  const channel = await channelResponse.json<{ id: string }>();
  const form = new FormData();
  form.set("payload_json", JSON.stringify({
    content: "ボランティア活動証明書をお送りします。",
    allowed_mentions: { parse: [] },
    attachments: [{ id: 0, filename: "volunteer-certificate.pdf" }],
  }));
  form.set("files[0]", new File([toArrayBuffer(pdf)], "volunteer-certificate.pdf", { type: "application/pdf" }));
  await discordRequest(`/channels/${channel.id}/messages`, token, { method: "POST", body: form });
}

function deferredEphemeral(): Response {
  return json({ type: DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE, data: { flags: EPHEMERAL_FLAG } });
}

function ephemeral(content: string): Response {
  return json({ type: 4, data: { content, flags: EPHEMERAL_FLAG } });
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
}

function formatJapaneseDate(value: string): string {
  const formatter = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  return formatter.format(new Date(value));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown_error";
}

function logOutcome(event: string, userId: string, reason?: string): void {
  console.log(JSON.stringify({ event, user_id: userId, ...(reason === undefined ? {} : { reason }) }));
}

// Hibiki verifies the envelope; validate the fields consumed by command handlers.
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isDiscordInteraction(value: unknown): value is DiscordInteraction {
  if (!isRecord(value) || typeof value.type !== "number" || typeof value.id !== "string"
    || typeof value.token !== "string" || typeof value.application_id !== "string") return false;
  if (value.guild_id !== undefined && typeof value.guild_id !== "string") return false;
  if (value.user !== undefined && (!isRecord(value.user) || typeof value.user.id !== "string")) return false;
  if (value.member !== undefined) {
    const member = value.member;
    if (!isRecord(member) || !isRecord(member.user) || typeof member.user.id !== "string"
      || !Array.isArray(member.roles) || !member.roles.every(role => typeof role === "string")
      || typeof member.joined_at !== "string"
      || (member.permissions !== undefined && typeof member.permissions !== "string")) return false;
  }
  if (value.data !== undefined) {
    const data = value.data;
    if (!isRecord(data) || (data.name !== undefined && typeof data.name !== "string")
      || (data.custom_id !== undefined && typeof data.custom_id !== "string")) return false;
    if (data.options !== undefined && (!Array.isArray(data.options) || !data.options.every(option =>
      isRecord(option) && typeof option.name === "string"
      && (option.value === undefined || typeof option.value === "string")
      && (option.type === undefined || typeof option.type === "number")))) return false;
    if (data.components !== undefined && (!Array.isArray(data.components) || !data.components.every(row =>
      isRecord(row) && typeof row.type === "number"
      && (row.components === undefined || (Array.isArray(row.components) && row.components.every(component =>
        isRecord(component) && typeof component.type === "number"
        && (component.custom_id === undefined || typeof component.custom_id === "string")
        && (component.value === undefined || typeof component.value === "string"))))))) return false;
  }
  return true;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const output = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(output).set(bytes);
  return output;
}
