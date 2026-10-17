import { createWebhookTest } from "@hibiki-js/testing";
import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import worker, { createDiscordInteractionApp } from "../src/index";
import { hasAdministratorPermission, selectHighestRole } from "../src/discord";

async function signedRequest(payload: object, privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"], timestamp = String(Math.floor(Date.now() / 1000))): Promise<Request> {
  const body = JSON.stringify(payload);
  return new Request("https://worker.example/interactions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Signature-Ed25519": sign(null, Buffer.from(timestamp + body), privateKey).toString("hex"),
      "X-Signature-Timestamp": timestamp,
    },
    body,
  });
}

describe("Discord request validation", () => {
  it("accepts a correctly signed request", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const env = testEnv({ DISCORD_PUBLIC_KEY: publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex") });
    const getByName = vi.spyOn(env.DISCORD_GATEWAY, "getByName");
    const ctx = executionContext();
    const webhook = createWebhookTest(createDiscordInteractionApp(env, ctx));
    const response = await webhook.emit(await signedRequest({ type: 1, id: "ping", application_id: "app" }, privateKey), "discord");
    expect(await response.json()).toEqual({ type: 1 });
    await ctx.done();
    expect(getByName).toHaveBeenCalledExactlyOnceWith("guild");
  });

  it("returns 401 for an invalid signature", async () => {
    const request = new Request("https://worker.example/interactions", {
      method: "POST",
      headers: { "X-Signature-Ed25519": "00", "X-Signature-Timestamp": "1735689600" },
      body: JSON.stringify({ type: 1 }),
    });
    const response = await worker.fetch(request, testEnv(), executionContext());
    expect(response.status).toBe(401);
  });

  it("answers Discord PING after validation", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const request = await signedRequest({ type: 1, id: "ping", application_id: "app" }, privateKey);
    const env = testEnv();
    env.DISCORD_PUBLIC_KEY = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex");
    const response = await worker.fetch(request, env, executionContext());
    expect(await response.json()).toEqual({ type: 1 });
  });

  it.each(["wrong-key", "tampered", "stale", "future", "missing-signature", "invalid-timestamp"])("rejects %s without starting background work", async (kind) => {
    const keys = generateKeyPairSync("ed25519");
    const env = testEnv({ DISCORD_PUBLIC_KEY: keys.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex") });
    const ctx = executionContext();
    const timestamp = kind === "stale" ? String(Math.floor(Date.now() / 1000) - 600)
      : kind === "future" ? String(Math.floor(Date.now() / 1000) + 600)
      : kind === "invalid-timestamp" ? "not-a-timestamp" : String(Math.floor(Date.now() / 1000));
    const key = kind === "wrong-key" ? generateKeyPairSync("ed25519").privateKey : keys.privateKey;
    let request = await signedRequest({ type: 1, id: "rejected", application_id: "app" }, key, timestamp);
    if (kind === "tampered") request = new Request(request.url, { method: "POST", headers: request.headers, body: JSON.stringify({ type: 1, id: "changed" }) });
    if (kind === "missing-signature") request.headers.delete("X-Signature-Ed25519");
    const response = await worker.fetch(request, env, ctx);
    expect(response.status).toBe(401);
    expect(ctx.waitUntil).not.toHaveBeenCalled();
  });

  it.each([
    [{ type: 99 }, 400],
    [{ type: 2, id: "bad", token: "t", application_id: "app", member: { user: null } }, 400],
  ])("rejects invalid interaction %j", async (payload, status) => {
    const keys = generateKeyPairSync("ed25519");
    const env = testEnv({ DISCORD_PUBLIC_KEY: keys.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex") });
    const ctx = executionContext();
    const webhook = createWebhookTest(createDiscordInteractionApp(env, ctx));
    expect((await webhook.emit(await signedRequest(payload, keys.privateKey), "discord")).status).toBe(status);
    expect(ctx.waitUntil).not.toHaveBeenCalled();
  });

  it("requires JSON content type and rejects malformed JSON", async () => {
    const keys = generateKeyPairSync("ed25519");
    const env = testEnv({ DISCORD_PUBLIC_KEY: keys.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex") });
    const request = await signedRequest({ type: 1, id: "ping" }, keys.privateKey);
    request.headers.set("Content-Type", "text/plain");
    expect((await worker.fetch(request, env, executionContext())).status).toBe(415);
    const body = "{";
    const timestamp = String(Math.floor(Date.now() / 1000));
    const malformed = new Request(request.url, { method: "POST", body, headers: {
      "Content-Type": "application/json", "X-Signature-Timestamp": timestamp,
      "X-Signature-Ed25519": sign(null, Buffer.from(timestamp + body), keys.privateKey).toString("hex"),
    } });
    expect((await worker.fetch(malformed, env, executionContext())).status).toBe(400);
  });

  it("keeps commands limited to the configured guild", async () => {
    const keys = generateKeyPairSync("ed25519");
    const env = testEnv({ DISCORD_PUBLIC_KEY: keys.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex") });
    const ctx = executionContext();
    const webhook = createWebhookTest(createDiscordInteractionApp(env, ctx));
    const response = await webhook.emit(await signedRequest({
      type: 2, id: "wrong-guild", token: "token", application_id: "app", guild_id: "other",
      member: { user: { id: "user" }, roles: [], joined_at: "2026-01-01T00:00:00.000Z" }, data: { name: "start" },
    }, keys.privateKey), "discord");
    expect(await response.json()).toMatchObject({ type: 4, data: { content: "このコマンドは指定されたサーバー内でのみ利用できます。", flags: 64 } });
    expect(ctx.waitUntil).not.toHaveBeenCalled();
  });

  it("returns a safe failure if a verified handler throws", async () => {
    const keys = generateKeyPairSync("ed25519");
    const env = testEnv({ DISCORD_PUBLIC_KEY: keys.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex") });
    vi.spyOn(env.DISCORD_GATEWAY, "getByName").mockImplementation(() => { throw new Error("private binding details"); });
    const webhook = createWebhookTest(createDiscordInteractionApp(env, executionContext()));
    const response = await webhook.emit(await signedRequest({ type: 1, id: "failed-ping", application_id: "app" }, keys.privateKey), "discord");
    expect(response.status).toBe(500);
    expect(await response.text()).toBe("HIBIKI_HANDLER_FAILED");
  });

  it("gives an ephemeral registration message when a certificate profile is absent", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const env = testEnv({
      DISCORD_PUBLIC_KEY: publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex"),
      DB: { prepare: () => ({ bind: () => ({ first: async () => null }) }) } as unknown as D1Database,
    });
    const update = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response("{}"));
    vi.stubGlobal("fetch", update);
    const ctx = executionContext();
    const response = await worker.fetch(await signedRequest({
      type: 2,
      id: "interaction",
      token: "token",
      application_id: "app",
      guild_id: "guild",
      member: { user: { id: "user" }, roles: ["guild"], joined_at: "2026-01-01T00:00:00.000Z" },
      data: { name: "issue" },
    }, privateKey), env, ctx);

    expect(await response.json()).toEqual({ type: 5, data: { flags: 64 } });
    await ctx.done();
    expect(update).toHaveBeenCalledOnce();
    expect(String(update.mock.calls[0]?.[0])).toContain("/webhooks/app/token/messages/@original");
    vi.unstubAllGlobals();
  });

  it("forwards a deferred start command to the recorder service", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const fetchMock = vi.fn(async () => new Response("", { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    const env = testEnv({ DISCORD_PUBLIC_KEY: publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex") });
    const ctx = executionContext();
    const response = await worker.fetch(await signedRequest({
      type: 2, id: "interaction", token: "interaction-token", application_id: "app", guild_id: "guild",
      member: { user: { id: "user" }, roles: ["guild"], joined_at: "2026-01-01T00:00:00.000Z" }, data: { name: "start" },
    }, privateKey), env, ctx);
    expect(await response.json()).toEqual({ type: 5, data: { flags: 64 } });
    await ctx.done();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toBe("https://recorder.example/commands");
    expect(JSON.parse(String(init.body))).toMatchObject({ action: "start", guildId: "guild", userId: "user" });
    vi.unstubAllGlobals();
  });

  it("upserts a name only for an administrator", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const run = vi.fn(async () => ({ success: true }));
    const env = testEnv({
      DISCORD_PUBLIC_KEY: publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex"),
      DB: { prepare: () => ({ bind: () => ({ run }) }) } as unknown as D1Database,
    });
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/members/")) return Response.json({ joined_at: "2026-01-01T00:00:00.000Z", roles: ["guild"] });
      if (url.endsWith("/roles")) return Response.json([]);
      return Response.json({});
    }));
    const ctx = executionContext();
    await worker.fetch(await signedRequest({
      type: 2,
      id: "interaction",
      token: "token",
      application_id: "app",
      guild_id: "guild",
      member: { user: { id: "admin" }, roles: ["guild"], joined_at: "2026-01-01T00:00:00.000Z", permissions: "8" },
      data: { name: "register", options: [{ name: "user", value: "user" }, { name: "name", value: "山田 太郎" }] },
    }, privateKey), env, ctx);

    await ctx.done();
    expect(run).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });

  it("opens a multiline ban modal for the guild owner", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/guilds/guild")) return Response.json({ owner_id: "owner" });
      return Response.json({});
    });
    vi.stubGlobal("fetch", fetchMock);
    const env = testEnv({ DISCORD_PUBLIC_KEY: publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex") });
    const response = await worker.fetch(await signedRequest({
      type: 2,
      id: "interaction",
      token: "token",
      application_id: "app",
      guild_id: "guild",
      member: { user: { id: "owner" }, roles: ["guild"], joined_at: "2026-01-01T00:00:00.000Z" },
      data: { name: "ban", options: [{ name: "user", value: "123456789012345678" }] },
    }, privateKey), env, executionContext());

    expect(await response.json()).toEqual({
      type: 9,
      data: {
        custom_id: "ban:123456789012345678",
        title: "BANメッセージ入力",
        components: [
          {
            type: 1,
            components: [
              {
                type: 4,
                custom_id: "ban_message",
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
    });
    vi.unstubAllGlobals();
  });

  it("bans a member after the owner submits the modal message", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/guilds/guild")) return Response.json({ owner_id: "owner" });
      if (url.endsWith("/users/@me/channels")) return Response.json({ id: "dm-channel" });
      if (url.includes("/bans/")) return new Response(null, { status: 204 });
      return Response.json({});
    });
    vi.stubGlobal("fetch", fetchMock);
    const env = testEnv({ DISCORD_PUBLIC_KEY: publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex") });
    const ctx = executionContext();
    const response = await worker.fetch(await signedRequest({
      type: 5,
      id: "interaction",
      token: "token",
      application_id: "app",
      guild_id: "guild",
      member: { user: { id: "owner" }, roles: ["guild"], joined_at: "2026-01-01T00:00:00.000Z" },
      data: {
        custom_id: "ban:123456789012345678",
        components: [
          {
            type: 1,
            components: [
              {
                type: 4,
                custom_id: "ban_message",
                value: "利用規約違反のためBANしました。\n詳細は運営まで。",
              },
            ],
          },
        ],
      },
    }, privateKey), env, ctx);

    expect(await response.json()).toEqual({ type: 5, data: { flags: 64 } });
    await ctx.done();
    const urls = fetchMock.mock.calls.map(([input]) => String(input));
    expect(urls.some((url) => url.endsWith("/users/@me/channels"))).toBe(true);
    expect(urls.some((url) => url.includes("/channels/dm-channel/messages"))).toBe(true);
    expect(urls.some((url) => url.includes("/guilds/guild/bans/123456789012345678"))).toBe(true);
    const banCall = fetchMock.mock.calls.find(([input]) => String(input).includes("/bans/123456789012345678")) as unknown as [string, RequestInit];
    expect(banCall[1].method).toBe("PUT");
    const dmCall = fetchMock.mock.calls.find(([input]) => String(input).includes("/channels/dm-channel/messages")) as unknown as [string, RequestInit];
    expect(JSON.parse(String(dmCall[1].body))).toMatchObject({
      content: "利用規約違反のためBANしました。\n詳細は運営まで。",
    });
    vi.unstubAllGlobals();
  });

  it("rejects ban when the invoker is not the guild owner", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/guilds/guild")) return Response.json({ owner_id: "owner" });
      return Response.json({});
    });
    vi.stubGlobal("fetch", fetchMock);
    const env = testEnv({ DISCORD_PUBLIC_KEY: publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex") });
    const response = await worker.fetch(await signedRequest({
      type: 2,
      id: "interaction",
      token: "token",
      application_id: "app",
      guild_id: "guild",
      member: { user: { id: "moderator" }, roles: ["guild"], joined_at: "2026-01-01T00:00:00.000Z", permissions: "8" },
      data: { name: "ban", options: [{ name: "user", value: "123456789012345678" }] },
    }, privateKey), env, executionContext());

    expect(await response.json()).toEqual({
      type: 4,
      data: { content: "このコマンドはサーバーオーナーのみが使用できます。", flags: 64 },
    });
    const urls = fetchMock.mock.calls.map(([input]) => String(input));
    expect(urls.some((url) => url.includes("/bans/"))).toBe(false);
    vi.unstubAllGlobals();
  });
});

describe("certificate data", () => {
  it("selects the highest non-everyone role", () => {
    expect(selectHighestRole(
      ["guild", "helper", "coordinator"],
      [
        { id: "guild", name: "@everyone", position: 0 },
        { id: "helper", name: "スタッフ", position: 2 },
        { id: "coordinator", name: "コーディネーター", position: 5 },
      ],
      "guild",
    )).toBe("コーディネーター");
  });

  it("uses the role-free label and checks administrator permission", () => {
    expect(selectHighestRole(["guild"], [], "guild")).toBe("役職なし");
    expect(hasAdministratorPermission({ type: 2, id: "1", token: "t", application_id: "a", member: { user: { id: "u" }, roles: [], joined_at: "2026-01-01T00:00:00.000Z", permissions: "8" } })).toBe(true);
  });
});

function testEnv(overrides: Partial<Parameters<typeof worker.fetch>[1]> = {}): Parameters<typeof worker.fetch>[1] {
  return {
    GUILD_ID: "guild",
    DISCORD_PUBLIC_KEY: "00".repeat(32),
    ORGANIZATION_NAME: "団体",
    ORGANIZATION_ADDRESS: "住所",
    ISSUER_TITLE: "代表",
    ISSUER_NAME: "発行者",
    CONTACT_EMAIL: "contact@example.com",
    RECORDER_SERVICE_URL: "https://recorder.example",
    RECORDER_SHARED_SECRET: "test-recorder-secret",
    DISCORD_BOT_TOKEN: "token",
    DB: {} as D1Database,
    CERTIFICATE_ASSETS: {} as R2Bucket,
    DISCORD_GATEWAY: {
      getByName: () => ({ start: async () => undefined }),
    } as unknown as DurableObjectNamespace<import("../src/index").DiscordGateway>,
    ...overrides,
  };
}

function executionContext(): ExecutionContext & { done(): Promise<void> } {
  const promises: Promise<unknown>[] = [];
  return {
    props: {},
    waitUntil: vi.fn((promise: Promise<unknown>) => promises.push(promise)),
    passThroughOnException: vi.fn(),
    exports: {} as Cloudflare.Exports,
    tracing: {} as Tracing,
    abort: vi.fn(),
    done: () => Promise.all(promises).then(() => undefined),
  };
}
