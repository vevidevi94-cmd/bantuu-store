const ADMIN_TOKEN_STORAGE_KEY = 'bantuu_admin_session_token_v1';

let inMemoryAdminToken: string | null = null;

export function getAdminSessionToken(): string | null {
  if (inMemoryAdminToken) return inMemoryAdminToken;
  if (typeof window === 'undefined') return null;
  try {
    const stored = window.localStorage.getItem(ADMIN_TOKEN_STORAGE_KEY);
    if (stored && stored.trim()) {
      inMemoryAdminToken = stored.trim();
      return inMemoryAdminToken;
    }
  } catch {
    // ignore storage access errors in restricted iframes
  }
  return null;
}

export function setAdminSessionToken(token: string | null | undefined): void {
  const clean = typeof token === 'string' && token.trim() ? token.trim() : null;
  inMemoryAdminToken = clean;
  if (typeof window === 'undefined') return;
  try {
    if (clean) {
      window.localStorage.setItem(ADMIN_TOKEN_STORAGE_KEY, clean);
    } else {
      window.localStorage.removeItem(ADMIN_TOKEN_STORAGE_KEY);
    }
  } catch {
    // ignore storage access errors in restricted iframes
  }
}

export function clearAdminSessionToken(): void {
  setAdminSessionToken(null);
}

export function buildAdminHeaders(extra?: HeadersInit): Headers {
  const headers = new Headers(extra);
  const token = getAdminSessionToken();
  if (token && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  return headers;
}

export function adminFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  return fetch(input, {
    ...init,
    credentials: 'include',
    headers: buildAdminHeaders(init.headers),
  });
}
