export {};

const applicationId = required("DISCORD_APPLICATION_ID");
const guildId = required("GUILD_ID");
const botToken = required("DISCORD_BOT_TOKEN");

const commands = [
  {
    name: "issue",
    description: "ボランティア活動証明書をDMで受け取ります",
    type: 1,
  },
  {
    name: "register",
    description: "証明書に表示する正式氏名を登録します",
    type: 1,
    default_member_permissions: "8",
    options: [
      { name: "user", description: "登録するユーザー", type: 6, required: true },
      { name: "name", description: "証明書に表示する正式氏名", type: 3, required: true, max_length: 100 },
    ],
  },
  { name: "start", description: "参加中のボイスチャンネルの録音を開始します", type: 1 },
  { name: "stop", description: "進行中の録音を停止して保存します", type: 1 },
  {
    name: "ban",
    description: "サーバーオーナー専用。指定ユーザーをBANし、メッセージをDMします",
    type: 1,
    default_member_permissions: "0",
    options: [
      { name: "user", description: "BANするユーザー", type: 6, required: true },
    ],
  },
];

for (const command of commands) {
  const response = await fetch(`https://discord.com/api/v10/applications/${applicationId}/guilds/${guildId}/commands`, {
    method: "POST",
    headers: { Authorization: `Bot ${botToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(command),
  });
  if (!response.ok) {
    throw new Error(`Command registration failed for ${command.name} (${response.status}): ${await response.text()}`);
  }
}
console.log("Discord guild commands were registered or updated.");

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} must be set.`);
  return value;
}
