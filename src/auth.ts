const encoder = new TextEncoder();

export const extractBearer = (
  header: string | null | undefined
): string | null => {
  if (!header) {
    return null;
  }
  const match = /^Bearer\s+(?<token>.+)$/iu.exec(header.trim());
  return match?.groups?.token?.trim() ?? null;
};

export const extractToken = (request: Request): string | null => {
  const bearer = extractBearer(request.headers.get("Authorization"));
  if (bearer) {
    return bearer;
  }
  const headerToken =
    request.headers.get("x-insights-token") ??
    request.headers.get("x-ingest-token");
  if (headerToken?.trim()) {
    return headerToken.trim();
  }
  const url = new URL(request.url);
  const queryToken = url.searchParams.get("token");
  return queryToken?.trim() || null;
};

export const timingSafeEqual = (left: string, right: string): boolean => {
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  const len = Math.max(a.length, b.length);
  let mismatch = a.length === b.length ? 0 : 1;
  for (let i = 0; i < len; i += 1) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) {
      mismatch = 1;
    }
  }
  return mismatch === 0;
};

export const isAuthorized = (
  request: Request,
  expected: string | undefined
): boolean => {
  if (!expected) {
    return false;
  }
  const token = extractToken(request);
  if (!token) {
    return false;
  }
  return timingSafeEqual(token, expected);
};
