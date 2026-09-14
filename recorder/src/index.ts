import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";
import { Client, ChannelType, Events, GatewayIntentBits, type TextChannel, type User, type VoiceBasedChannel } from "discord.js";
import { EndBehaviorType, StreamType, VoiceConnectionStatus, AudioPlayerStatus, createAudioPlayer, createAudioResource, entersState, joinVoiceChannel, type VoiceConnection } from "@discordjs/voice";
import prism from "prism-media";
import { createRecordingDirectory, mixTracks, outputPath, PcmTrack, removeRecordingDirectory, trackPath } from "./audio.js";
import { getConfig, type RecorderConfig } from "./config.js";
import { RecordingStorage } from "./storage.js";

type Command = { action: "start" | "stop"; guildId: string; userId: string; applicationId: string; interactionToken: string };
type StreamHandle = { destroy(): void };

class RecordingSession {
  private readonly tracks = new Map<string, PcmTrack>();
  private readonly streams: StreamHandle[] = [];
  private readonly directoryPromise: Promise<string>;
  private connection: VoiceConnection | undefined;
  private startedAt = new Date();
  private startedAtMs = this.startedAt.getTime();
  private stopping = false;

  constructor(
    private readonly client: Client,
    private readonly config: RecorderConfig,
    private readonly storage: RecordingStorage,
    readonly voiceChannel: VoiceBasedChannel,
    private readonly startedBy: User,
  ) { this.directoryPromise = createRecordingDirectory(`${Date.now()}-${voiceChannel.id}`); }

  async start(): Promise<void> {
    this.connection = joinVoiceChannel({ channelId: this.voiceChannel.id, guildId: this.voiceChannel.guild.id, adapterCreator: this.voiceChannel.guild.voiceAdapterCreator, selfDeaf: false, selfMute: false });
    try {
      await entersState(this.connection, VoiceConnectionStatus.Ready, 30_000);
      await this.playCue(880);
      this.startedAt = new Date(); this.startedAtMs = this.startedAt.getTime();
      this.connection.receiver.speaking.on("start", this.onSpeakingStart);
      for (const [userId, member] of this.voiceChannel.members) if (!member.user.bot) void this.subscribe(userId);
    } catch (error) {
      this.disconnect(); throw new Error("VCへの接続に失敗しました。Botの閲覧・接続・発言権限を確認してください。", { cause: error });
    }
  }

  async stop(reason: "command" | "empty"): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    const durationMs = Date.now() - this.startedAtMs;
    const directory = await this.directoryPromise;
    const resultChannel = this.resultChannel();
    let resultMessage: Awaited<ReturnType<TextChannel["send"]>> | undefined;
    try {
      this.connection?.receiver.speaking.off("start", this.onSpeakingStart);
      for (const stream of this.streams) stream.destroy();
      if (reason === "command") await this.playCue(440);
      this.disconnect(); await Promise.all([...this.tracks.values()].map((track) => track.close(durationMs)));
      resultMessage = await resultChannel.send({ embeds: [embed("録音ファイルを準備中です", `録音時間: ${duration(durationMs)}\nCloudflare R2へ保存しています。`, 0x5865f2)] });
      try { await this.startedBy.send({ embeds: [embed("録音ファイルを準備中です", "Cloudflare R2へ保存しています。完了後にURLをお送りします。", 0x5865f2)] }); } catch { /* DM settings must not block recording. */ }
      const destination = outputPath(directory);
      await mixTracks(this.config.ffmpegPath, [...this.tracks.values()], durationMs, destination);
      const name = `recording-${this.startedAt.toISOString().replaceAll(/[:.]/g, "-")}-${this.voiceChannel.id}.mp3`;
      const url = await this.storage.uploadWithRetry(destination, name);
      await resultMessage.edit({ embeds: [embed("録音ファイルを保存しました", `録音時間: ${duration(durationMs)}\n[録音を再生](${url})\n公開URLは30日後に削除されます。`, 0x22c55e)] });
      await this.startedBy.send({ embeds: [embed("録音ファイルを保存しました", `[録音を再生](${url})\n公開URLは30日後に削除されます。`, 0x22c55e)] }).catch(() => undefined);
    } catch (error) {
      console.error("recording_finalization_failed", error);
      const payload = { embeds: [embed("録音ファイルの保存に失敗しました", "管理者は録音サービスのログを確認してください。", 0xdc2626)] };
      if (resultMessage) await resultMessage.edit(payload).catch(() => undefined); else await resultChannel.send(payload).catch(() => undefined);
      await this.startedBy.send(payload).catch(() => undefined);
      throw error;
    } finally { this.disconnect(); await removeRecordingDirectory(directory).catch(console.error); }
  }

  async abort(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true; this.connection?.receiver.speaking.off("start", this.onSpeakingStart);
    for (const stream of this.streams) stream.destroy(); this.disconnect();
    await removeRecordingDirectory(await this.directoryPromise).catch(console.error);
  }

  private resultChannel(): TextChannel {
    const channel = this.client.channels.cache.get(this.config.resultChannelId);
    if (!channel || channel.type !== ChannelType.GuildText) throw new Error("RECORDING_RESULT_CHANNEL_ID must reference a text channel.");
    return channel;
  }
  private onSpeakingStart = (userId: string): void => { if (!this.stopping && !this.tracks.has(userId) && userId !== this.client.user?.id) void this.subscribe(userId); };
  private async subscribe(userId: string): Promise<void> {
    try {
      const connection = this.connection; if (!connection || this.stopping || this.tracks.has(userId)) return;
      const track = new PcmTrack(userId, trackPath(await this.directoryPromise, userId), this.startedAtMs); this.tracks.set(userId, track);
      const opus = connection.receiver.subscribe(userId, { end: { behavior: EndBehaviorType.Manual } });
      const decoder = new prism.opus.Decoder({ rate: 48_000, channels: 2, frameSize: 960 }); opus.pipe(decoder);
      decoder.on("data", (chunk: Buffer) => track.write(chunk)); decoder.on("error", (error: Error) => console.warn("audio_decoder_error", userId, error));
      this.streams.push(opus, decoder);
    } catch (error) { console.warn("speaker_subscription_failed", userId, error); }
  }
  private async playCue(frequency: number): Promise<void> {
    if (!this.connection) return;
    const samples = 48_000 / 5; const pcm = Buffer.alloc(samples * 4);
    for (let i = 0; i < samples; i += 1) { const value = Math.round(Math.sin((2 * Math.PI * frequency * i) / 48_000) * 0x2500); pcm.writeInt16LE(value, i * 4); pcm.writeInt16LE(value, i * 4 + 2); }
    const player = createAudioPlayer(); this.connection.subscribe(player);
    player.play(createAudioResource(Readable.from([pcm]), { inputType: StreamType.Raw }));
    await entersState(player, AudioPlayerStatus.Idle, 3_000).catch(() => undefined);
  }
  private disconnect(): void { this.connection?.destroy(); this.connection = undefined; }
}

class RecordingManager {
  private active: RecordingSession | undefined;
  constructor(private readonly client: Client, private readonly config: RecorderConfig, private readonly storage: RecordingStorage) {}
  async start(userId: string): Promise<void> {
    if (this.active) throw new Error("このサーバーでは、すでに別の録音が進行中です。");
    const guild = await this.client.guilds.fetch(this.config.guildId); const member = await guild.members.fetch(userId);
    const channel = member.voice.channel;
    if (!channel || !channel.isVoiceBased()) throw new Error("録音を開始するには、先にボイスチャンネルへ参加してください。");
    const session = new RecordingSession(this.client, this.config, this.storage, channel, member.user); this.active = session;
    try { await session.start(); } catch (error) { this.active = undefined; throw error; }
  }
  async stop(userId: string, reason: "command" | "empty" = "command"): Promise<void> {
    const session = this.active; if (!session) throw new Error("現在、録音は進行していません。");
    if (reason === "command") { const guild = await this.client.guilds.fetch(this.config.guildId); const member = await guild.members.fetch(userId); if (member.voice.channelId !== session.voiceChannel.id) throw new Error("録音を停止するには、録音中のVCに参加してください。"); }
    try { await session.stop(reason); } finally { this.active = undefined; }
  }
  async stopWhenEmpty(): Promise<void> { const session = this.active; if (!session) return; const humans = session.voiceChannel.members.filter((member) => !member.user.bot); if (humans.size === 0) await this.stop("", "empty"); }
  async abort(): Promise<void> { const session = this.active; this.active = undefined; await session?.abort(); }
}

function embed(title: string, description: string, color: number): { title: string; description: string; color: number } { return { title, description, color }; }
function duration(ms: number): string { const seconds = Math.floor(ms / 1000); return `${Math.floor(seconds / 60)}分${String(seconds % 60).padStart(2, "0")}秒`; }
function equalSecret(actual: string | undefined, expected: string): boolean { if (!actual) return false; const left = Buffer.from(actual); const right = Buffer.from(expected); return left.length === right.length && timingSafeEqual(left, right); }
async function body(request: IncomingMessage): Promise<unknown> { const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); return JSON.parse(Buffer.concat(chunks).toString()); }
async function editInteraction(command: Command, content: string): Promise<void> { await fetch(`https://discord.com/api/v10/webhooks/${command.applicationId}/${command.interactionToken}/messages/@original`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content }) }); }

const config = getConfig();
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
const manager = new RecordingManager(client, config, new RecordingStorage(config.r2));
client.once(Events.ClientReady, () => console.info("recorder_ready"));
client.on(Events.VoiceStateUpdate, () => { void manager.stopWhenEmpty().catch((error) => console.error("automatic_stop_failed", error)); });
const server = createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/healthz") { response.writeHead(client.isReady() ? 200 : 503).end(client.isReady() ? "ok" : "discord_not_ready"); return; }
  if (request.method !== "POST" || request.url !== "/commands") { response.writeHead(404).end(); return; }
  const suppliedSecret = request.headers["x-recorder-secret"];
  if (!equalSecret(Array.isArray(suppliedSecret) ? suppliedSecret[0] : suppliedSecret, config.sharedSecret)) { response.writeHead(401).end(); return; }
  let command: Command;
  try { command = await body(request) as Command; if (!["start", "stop"].includes(command.action) || command.guildId !== config.guildId || !command.userId || !command.applicationId || !command.interactionToken) throw new Error("invalid command"); } catch { response.writeHead(400).end(); return; }
  response.writeHead(202).end();
  try { if (command.action === "start") { await manager.start(command.userId); await editInteraction(command, "録音を開始しました。このVCは録音中です。"); } else { void manager.stop(command.userId).catch((error) => console.error("recording_stop_failed", error)); await editInteraction(command, "録音を停止し、ファイルを保存しています。"); } }
  catch (error) { await editInteraction(command, error instanceof Error ? error.message : "録音処理に失敗しました。").catch(console.error); }
});
server.listen(config.port, "0.0.0.0", () => console.info(`recorder_listening:${config.port}`));
client.login(config.discordToken).catch((error) => { console.error("discord_login_failed", error); process.exitCode = 1; });
async function shutdown(): Promise<void> { server.close(); await manager.abort(); client.destroy(); }
process.once("SIGTERM", () => { void shutdown(); }); process.once("SIGINT", () => { void shutdown(); });
