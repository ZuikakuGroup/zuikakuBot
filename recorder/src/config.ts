export type RecorderConfig = {
  discordToken: string;
  guildId: string;
  resultChannelId: string;
  sharedSecret: string;
  r2: { endpoint: string; accessKeyId: string; secretAccessKey: string; bucketName: string; publicBaseUrl: string };
  port: number;
  ffmpegPath: string;
};

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") throw new Error(`${name} must be set.`);
  return value;
}

export function getConfig(): RecorderConfig {
  const port = Number(process.env.PORT ?? "10000");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be a valid TCP port.");
  return {
    discordToken: required("DISCORD_BOT_TOKEN"),
    guildId: required("GUILD_ID"),
    resultChannelId: required("RECORDING_RESULT_CHANNEL_ID"),
    sharedSecret: required("RECORDER_SHARED_SECRET"),
    r2: {
      endpoint: required("R2_ENDPOINT"), accessKeyId: required("R2_ACCESS_KEY_ID"), secretAccessKey: required("R2_SECRET_ACCESS_KEY"),
      bucketName: required("R2_BUCKET_NAME"), publicBaseUrl: required("R2_PUBLIC_BASE_URL"),
    },
    port, ffmpegPath: process.env.FFMPEG_PATH ?? "ffmpeg",
  };
}
