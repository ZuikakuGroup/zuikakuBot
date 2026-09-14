import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import worker, { verifyDiscordSignature } from "../src/index";
import { hasAdministratorPermission, selectHighestRole } from "../src/discord";

async function signedRequest(payload: object, privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"]): Promise<Request> {
  const body = JSON.stringify(payload);
  const timestamp = "1735689600";
  return new Request("https://worker.example/interactions", {
    method: "POST",
    headers: {
      "X-Signature-Ed25519": sign(null, Buffer.from(timestamp + body), privateKey).toString("hex"),
      "X-Signature-Timestamp": timestamp,
    },
    body,
  });
}

describe("Discord request validation", () => {
  it("accepts a correctly signed request", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const body = JSON.stringify({ type: 1 });
    const timestamp = "1735689600";
    const signature = sign(null, Buffer.from(timestamp + body), privateKey).toString("hex");
    const publicKeyHex = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex");
    const headers = new Headers({ "X-Signature-Ed25519": signature, "X-Signature-Timestamp": timestamp });
    await expect(verifyDiscordSignature(headers, body, publicKeyHex)).resolves.toBe(true);
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
    const body = JSON.stringify({ type: 1 });
    const timestamp = "1735689600";
    const request = new Request("https://worker.example/interactions", {
      method: "POST",
      headers: {
        "X-Signature-Ed25519": sign(null, Buffer.from(timestamp + body), privateKey).toString("hex"),
        "X-Signature-Timestamp": timestamp,
      },
      body,
    });
    const env = testEnv();
    env.DISCORD_PUBLIC_KEY = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex");
    const response = await worker.fetch(request, env, executionContext());
    expect(await response.json()).toEqual({ type: 1 });
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
    DISCORD_PUBLIC_KEY: "00",
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
