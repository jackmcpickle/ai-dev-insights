const encoder = new TextEncoder();

export function extractBearer(header: string | null | undefined): string | null {
    if (!header) return null;
    const match = /^Bearer\s+(.+)$/iu.exec(header.trim());
    return match?.[1]?.trim() ?? null;
}

export function extractToken(request: Request): string | null {
    const bearer = extractBearer(request.headers.get("Authorization"));
    if (bearer) return bearer;
    const headerToken =
        request.headers.get("x-insights-token") ??
        request.headers.get("x-ingest-token");
    if (headerToken?.trim()) return headerToken.trim();
    const url = new URL(request.url);
    const queryToken = url.searchParams.get("token");
    return queryToken?.trim() || null;
}

export function timingSafeEqual(left: string, right: string): boolean {
    const a = encoder.encode(left);
    const b = encoder.encode(right);
    const len = Math.max(a.length, b.length);
    let mismatch = a.length === b.length ? 0 : 1;
    for (let i = 0; i < len; i += 1) {
        mismatch |= (a[i] ?? 0) ^ (b[i] ?? 0);
    }
    return mismatch === 0;
}

export function isAuthorized(request: Request, expected: string | undefined): boolean {
    if (!expected) return false;
    const token = extractToken(request);
    if (!token) return false;
    return timingSafeEqual(token, expected);
}
