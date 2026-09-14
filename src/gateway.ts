import { DurableObject } from "cloudflare:workers";
import { discordRequest, selectHighestRole, type DiscordRole } from "./discord";
import { saveMemberSnapshot, sendCertificateForSnapshot, type MemberSnapshot, type WorkerEnv } from "./index";

const GUILDS_AND_MEMBERS_INTENTS = (1 << 0) | (1 << 1);
const RECONNECT_DELAY_MS = 10_000;

type GatewaySession = {
  sessionId: string;
  resumeGatewayUrl: string;
  sequence: number | null;
};

type GatewayPayload = {
  op: number;
  d: unknown;
  s?: number | null;
  t?: string | null;
};

type MemberEvent = {
  guild_id: string;
  user: { id: string };
  roles: string[];
  joined_at: string;
};

export class DiscordGateway extends DurableObject<WorkerEnv> {
  private socket: WebSocket | undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private sequence: number | null = null;

  async start(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN || this.socket?.readyState === WebSocket.CONNECTING) return;
    try {
      const response = await discordRequest("/gateway/bot", this.env.DISCORD_BOT_TOKEN);
      const gateway = await response.json<{ url: string }>();
      const socket = new WebSocket(`${gateway.url}?v=10&encoding=json`);
      this.socket = socket;
      socket.addEventListener("message", (event) => {
        void this.handleMessage(typeof event.data === "string" ? event.data : "");
      });
      socket.addEventListener("close", () => {
        this.socket = undefined;
        this.stopHeartbeat();
        void this.scheduleReconnect();
      });
      socket.addEventListener("error", () => {
        console.log(JSON.stringify({ event: "discord_gateway_socket_error" }));
      });
    } catch (error) {
      console.log(JSON.stringify({ event: "discord_gateway_connect_failed", error: errorMessage(error) }));
      await this.scheduleReconnect();
    }
  }

  async alarm(): Promise<void> {
    await this.start();
  }

  private async handleMessage(message: string): Promise<void> {
    try {
      const payload = JSON.parse(message) as GatewayPayload;
      if (payload.s !== undefined && payload.s !== null) {
        this.sequence = payload.s;
      }
      if (payload.op === 10) {
        const heartbeatInterval = (payload.d as { heartbeat_interval: number }).heartbeat_interval;
        this.startHeartbeat(heartbeatInterval);
        await this.identifyOrResume();
        return;
      }
      if (payload.op === 7) {
        this.socket?.close(4000, "Discord requested reconnect");
        return;
      }
      if (payload.op === 9) {
        await this.ctx.storage.delete("session");
        this.sequence = null;
        this.socket?.close(4000, "Discord invalidated session");
        return;
      }
      if (payload.op === 0 && payload.t !== undefined && payload.t !== null) {
        await this.handleDispatch(payload.t, payload.d);
      }
    } catch (error) {
      console.log(JSON.stringify({ event: "discord_gateway_message_failed", error: errorMessage(error) }));
    }
  }

  private async identifyOrResume(): Promise<void> {
    const session = await this.ctx.storage.get<GatewaySession>("session");
    if (session !== undefined && session.sequence !== null) {
      this.sequence = session.sequence;
      this.send({ op: 6, d: { token: this.env.DISCORD_BOT_TOKEN, session_id: session.sessionId, seq: session.sequence } });
      return;
    }
    this.send({
      op: 2,
      d: {
        token: this.env.DISCORD_BOT_TOKEN,
        intents: GUILDS_AND_MEMBERS_INTENTS,
        properties: { os: "cloudflare-workers", browser: "zuikaku-certificate-bot", device: "zuikaku-certificate-bot" },
      },
    });
  }

  private async handleDispatch(type: string, data: unknown): Promise<void> {
    if (type === "READY") {
      const ready = data as { session_id: string; resume_gateway_url: string };
      await this.ctx.storage.put("session", {
        sessionId: ready.session_id,
        resumeGatewayUrl: ready.resume_gateway_url,
        sequence: this.sequence,
      } satisfies GatewaySession);
      console.log(JSON.stringify({ event: "discord_gateway_ready" }));
      return;
    }
    if (type === "RESUMED") {
      console.log(JSON.stringify({ event: "discord_gateway_resumed" }));
      return;
    }
    if (type === "GUILD_MEMBER_ADD" || type === "GUILD_MEMBER_UPDATE") {
      await this.recordMemberSnapshot(data as MemberEvent);
      return;
    }
    if (type === "GUILD_MEMBER_REMOVE") {
      await this.issueOnMemberRemoval(data as { guild_id: string; user: { id: string } });
    }
  }

  private async recordMemberSnapshot(event: MemberEvent): Promise<void> {
    if (event.guild_id !== this.env.GUILD_ID) return;
    const roles = await this.getGuildRoles(event.guild_id);
    await saveMemberSnapshot(this.env, {
      guildId: event.guild_id,
      userId: event.user.id,
      joinedAt: event.joined_at,
      roleName: selectHighestRole(event.roles, roles, event.guild_id),
    });
    console.log(JSON.stringify({ event: "member_snapshot_saved", user_id: event.user.id }));
  }

  private async issueOnMemberRemoval(event: { guild_id: string; user: { id: string } }): Promise<void> {
    if (event.guild_id !== this.env.GUILD_ID) return;
    const snapshot = await this.env.DB.prepare(
      "SELECT joined_at, role_name FROM volunteer_profiles WHERE guild_id = ? AND user_id = ?",
    ).bind(event.guild_id, event.user.id).first<{ joined_at: string | null; role_name: string | null }>();
    if (snapshot?.joined_at === null || snapshot?.joined_at === undefined) {
      console.log(JSON.stringify({ event: "departure_certificate_skipped", user_id: event.user.id, reason: "snapshot_not_found" }));
      return;
    }
    const sent = await sendCertificateForSnapshot(this.env, {
      guildId: event.guild_id,
      userId: event.user.id,
      joinedAt: snapshot.joined_at,
      roleName: snapshot.role_name ?? "役職なし",
    } satisfies MemberSnapshot);
    console.log(JSON.stringify({ event: sent ? "departure_certificate_sent" : "departure_certificate_skipped", user_id: event.user.id }));
  }

  private async getGuildRoles(guildId: string): Promise<DiscordRole[]> {
    const response = await discordRequest(`/guilds/${guildId}/roles`, this.env.DISCORD_BOT_TOKEN);
    return response.json<DiscordRole[]>();
  }

  private startHeartbeat(interval: number): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => this.send({ op: 1, d: this.sequence }), interval);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== undefined) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }

  private send(payload: { op: number; d: unknown }): void {
    try {
      this.socket?.send(JSON.stringify(payload));
    } catch (error) {
      console.log(JSON.stringify({ event: "discord_gateway_send_failed", error: errorMessage(error) }));
    }
  }

  private async scheduleReconnect(): Promise<void> {
    await this.ctx.storage.setAlarm(Date.now() + RECONNECT_DELAY_MS);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown_error";
}
