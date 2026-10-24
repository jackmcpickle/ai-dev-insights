import { verifyWithJwks } from "hono/jwt";

/** JWKS entry from the Access certs endpoint. */
export type AccessKey = JsonWebKey & { kid?: string };

export interface AccessConfig {
  teamDomain: string;
  aud: string;
}

export type FetchKeys = (teamDomain: string) => Promise<AccessKey[]>;

const KEY_TTL_MS = 5 * 60 * 1000;
const keyCache = new Map<string, { keys: AccessKey[]; expires: number }>();

export const fetchAccessKeys: FetchKeys = async (teamDomain) => {
  const cached = keyCache.get(teamDomain);
  if (cached && cached.expires > Date.now()) {
    return cached.keys;
  }
  const response = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!response.ok) {
    throw new Error(`access certs fetch failed: ${response.status}`);
  }
  const { keys } = (await response.json()) as { keys: AccessKey[] };
  keyCache.set(teamDomain, { expires: Date.now() + KEY_TTL_MS, keys });
  return keys;
};

export const accessConfigFromEnv = (env: Env): AccessConfig | null => {
  const teamDomain = env.ACCESS_TEAM_DOMAIN?.trim();
  const aud = env.ACCESS_AUD?.trim();
  return teamDomain && aud ? { aud, teamDomain } : null;
};

/** Returns true when the request carries a valid Cloudflare Access JWT. */
export const isAccessAuthorized = async (
  request: Request,
  config: AccessConfig | null,
  fetchKeys: FetchKeys = fetchAccessKeys
): Promise<boolean> => {
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!config || !token) {
    return false;
  }
  try {
    await verifyWithJwks(token, {
      allowedAlgorithms: ["RS256"],
      keys: await fetchKeys(config.teamDomain),
      verification: { aud: config.aud, iss: `https://${config.teamDomain}` },
    });
    return true;
  } catch {
    return false;
  }
};
