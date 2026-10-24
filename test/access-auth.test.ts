import { sign } from "hono/jwt";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  accessConfigFromEnv,
  fetchAccessKeys,
  isAccessAuthorized,
} from "../src/access";
import type { AccessKey } from "../src/access";
import { createApp } from "../src/app";
import { createMemoryStore } from "../src/store";

const TOKEN = "test-ingest-token";
const TEAM = "team.cloudflareaccess.com";
const AUD = "test-aud";
const KID = "test-kid";

let privateJwk: JsonWebKey;
let publicJwk: AccessKey;

const accessJwt = (overrides: Record<string, unknown> = {}) => {
  const now = Math.floor(Date.now() / 1000);
  return sign(
    {
      aud: [AUD],
      email: "dev@example.com",
      exp: now + 300,
      iat: now,
      iss: `https://${TEAM}`,
      ...overrides,
    },
    { ...privateJwk, kid: KID },
    "RS256"
  );
};

const env = (access = true): Env => ({
  DB: {} as D1Database,
  INGEST_TOKEN: TOKEN,
  ...(access ? { ACCESS_AUD: AUD, ACCESS_TEAM_DOMAIN: TEAM } : {}),
});

const makeApp = () =>
  createApp({
    fetchAccessKeys: () => Promise.resolve([publicJwk]),
    store: createMemoryStore(),
  });

const get = (path: string, headers: Record<string, string>, access = true) =>
  makeApp().request(path, { headers }, env(access));

describe("dashboard auth", () => {
  beforeAll(async () => {
    const pair = (await crypto.subtle.generateKey(
      {
        hash: "SHA-256",
        modulusLength: 2048,
        name: "RSASSA-PKCS1-v1_5",
        publicExponent: new Uint8Array([1, 0, 1]),
      },
      true,
      ["sign", "verify"]
    )) as CryptoKeyPair;
    privateJwk = (await crypto.subtle.exportKey(
      "jwk",
      pair.privateKey
    )) as JsonWebKey;
    publicJwk = {
      ...((await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey),
      kid: KID,
    };
  });

  it.each(["/", "/insights"])("rejects %s without credentials", async (p) => {
    const res = await get(p, {});
    expect(res.status).toBe(401);
  });

  it.each(["/", "/insights"])("accepts %s with the ingest token", async (p) => {
    const res = await get(p, { authorization: `Bearer ${TOKEN}` });
    expect(res.status).toBe(200);
  });

  it.each(["/", "/insights"])("accepts %s with an Access JWT", async (p) => {
    const res = await get(p, { "cf-access-jwt-assertion": await accessJwt() });
    expect(res.status).toBe(200);
  });

  it.each([
    ["wrong audience", { aud: ["other-aud"] }],
    ["wrong issuer", { iss: "https://evil.cloudflareaccess.com" }],
    ["expired", { exp: Math.floor(Date.now() / 1000) - 60 }],
  ])("rejects an Access JWT with %s", async (_label, overrides) => {
    const res = await get("/", {
      "cf-access-jwt-assertion": await accessJwt(overrides),
    });
    expect(res.status).toBe(401);
  });

  it("ignores Access JWTs when Access is not configured", async () => {
    const res = await get(
      "/",
      { "cf-access-jwt-assertion": await accessJwt() },
      false
    );
    expect(res.status).toBe(401);
  });

  it("does not let an Access JWT reach the token-only API", async () => {
    const res = await get("/v1/usage", {
      "cf-access-jwt-assertion": await accessJwt(),
    });
    expect(res.status).toBe(401);
  });

  it("fails closed when the certs fetch throws", async () => {
    const req = new Request("https://x.test/", {
      headers: { "cf-access-jwt-assertion": await accessJwt() },
    });
    const ok = await isAccessAuthorized(req, accessConfigFromEnv(env()), () =>
      Promise.reject(new Error("down"))
    );
    expect(ok).toBeFalsy();
  });
});

describe(fetchAccessKeys, () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches team certs once and caches them", async () => {
    const keys = [{ kid: "k1", kty: "RSA" }];
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(Response.json({ keys }))
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      fetchAccessKeys("cache.cloudflareaccess.com")
    ).resolves.toStrictEqual(keys);
    await expect(
      fetchAccessKeys("cache.cloudflareaccess.com")
    ).resolves.toStrictEqual(keys);
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      "https://cache.cloudflareaccess.com/cdn-cgi/access/certs"
    );
  });

  it("throws when the certs endpoint fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(() =>
        Promise.resolve(new Response("nope", { status: 503 }))
      )
    );
    await expect(fetchAccessKeys("down.cloudflareaccess.com")).rejects.toThrow(
      "503"
    );
  });
});
