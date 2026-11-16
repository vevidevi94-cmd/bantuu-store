import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

const COOKIE_NAME = 'bantuu_admin_session';
const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

function getPasscode(): string {
  return (process.env.ADMIN_PASSCODE || '12348765').trim();
}

function getTriggerCode(): string {
  return (process.env.ADMIN_SEARCH_TRIGGER || 'bantuustore').trim().toLowerCase();
}

function getSigningSecret(): string {
  if (process.env.ADMIN_SESSION_SECRET && process.env.ADMIN_SESSION_SECRET.trim()) {
    return process.env.ADMIN_SESSION_SECRET.trim();
  }
  return crypto
    .createHash('sha256')
    .update(`bantuu-store-signing:${getPasscode()}:${getTriggerCode()}`)
    .digest('hex');
}

function sha256Equal(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export function isAdminTriggerQuery(query: string): boolean {
  const normalized = (query || '').trim().toLowerCase();
  if (!normalized) return false;
  return sha256Equal(normalized, getTriggerCode());
}

export function verifyAdminPasscode(passcode: string): boolean {
  const normalized = (passcode || '').trim();
  if (!normalized) return false;
  return sha256Equal(normalized, getPasscode());
}

export function createAdminSessionToken(ttlMs = DEFAULT_TTL_MS): string {
  const payload = {
    role: 'admin',
    exp: Date.now() + ttlMs,
    nonce: crypto.randomBytes(8).toString('hex'),
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = crypto
    .createHmac('sha256', getSigningSecret())
    .update(encodedPayload)
    .digest('base64url');
  return `${encodedPayload}.${signature}`;
}

export function verifyAdminSessionToken(token: string | undefined | null): boolean {
  if (!token || typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [encodedPayload, sig] = parts;
  if (!encodedPayload || !sig) return false;

  const expectedSig = crypto
    .createHmac('sha256', getSigningSecret())
    .update(encodedPayload)
    .digest('base64url');

  const sigBuf = Buffer.from(sig, 'utf8');
  const expectedBuf = Buffer.from(expectedSig, 'utf8');
  if (sigBuf.length !== expectedBuf.length) return false;
  if (!crypto.timingSafeEqual(sigBuf, expectedBuf)) return false;

  try {
    const parsed = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as {
      role?: string;
      exp?: number;
    };
    return parsed.role === 'admin' && typeof parsed.exp === 'number' && parsed.exp > Date.now();
  } catch {
    return false;
  }
}

function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!cookieHeader) return out;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) {
      try {
        out[key] = decodeURIComponent(val);
      } catch {
        out[key] = val;
      }
    }
  }
  return out;
}

export function extractAdminTokenFromRequest(req: Request): string | null {
  const cookies = parseCookies(req.headers.cookie);
  if (cookies[COOKIE_NAME]) return cookies[COOKIE_NAME];

  const auth = req.headers.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    return auth.slice(7).trim();
  }
  const headerToken = req.headers['x-admin-token'];
  if (typeof headerToken === 'string' && headerToken.trim()) {
    return headerToken.trim();
  }
  return null;
}

export function isRequestAdminAuthenticated(req: Request): boolean {
  const token = extractAdminTokenFromRequest(req);
  return verifyAdminSessionToken(token);
}

export function shouldUseSecureCookie(req: Request): boolean {
  if (process.env.VERCEL || process.env.NODE_ENV === 'production') {
    const proto = String(req.headers['x-forwarded-proto'] || '').toLowerCase();
    if (proto === 'http') return false;
    return proto === 'https' || Boolean(process.env.VERCEL);
  }
  return false;
}

export function buildAdminSessionCookie(token: string, secure: boolean): string {
  const maxAgeSec = Math.floor(DEFAULT_TTL_MS / 1000);
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSec}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function buildClearAdminCookie(secure: boolean): string {
  const parts = [
    `${COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function requireAdminMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (!isRequestAdminAuthenticated(req)) {
    res.status(401).json({
      error: 'Admin authentication required. Please re-enter your admin password.',
    });
    return;
  }
  next();
}
