import https from 'node:https';
import {
  normalizeFirebaseRtdbUrl,
  normalizeRtdbMap,
  type Order,
  type OrderStatus,
  type Product,
  type StoreSettings,
} from '../src/utils/storeLogic.js';

export interface RtdbSyncState {
  connected: boolean;
  lastSyncedAt: string | null;
  lastError: string | null;
}

const syncState: RtdbSyncState = {
  connected: false,
  lastSyncedAt: null,
  lastError: null,
};

export function getRtdbSyncState(): RtdbSyncState {
  return { ...syncState };
}

function sendHttpsJson(
  urlStr: string,
  method: 'GET' | 'PUT' | 'PATCH' | 'DELETE',
  body?: unknown,
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlStr);
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const req = https.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || 443,
        path: `${parsed.pathname}${parsed.search}`,
        method,
        family: 4,
        timeout: 8000,
        headers:
          payload !== undefined
            ? {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload),
              }
            : undefined,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        res.on('end', () => {
          resolve({
            status: res.statusCode || 0,
            text: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );

    req.on('timeout', () => {
      req.destroy(new Error('Firebase RTDB request timed out'));
    });
    req.on('error', reject);

    if (payload !== undefined) {
      req.write(payload);
    }
    req.end();
  });
}

async function rtdbRequest(
  baseUrl: string,
  path: string,
  method: 'GET' | 'PUT' | 'PATCH' | 'DELETE',
  body?: unknown,
): Promise<{ ok: boolean; status: number; data?: unknown; error?: string }> {
  const cleanBase = normalizeFirebaseRtdbUrl(baseUrl);
  if (!cleanBase) {
    return { ok: false, status: 0, error: 'Firebase Realtime Database URL is not configured.' };
  }

  const normalizedPath = !path ? '/' : path.startsWith('/') ? path : `/${path}`;
  const endpoint = `${cleanBase}${normalizedPath}.json`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const res = await sendHttpsJson(endpoint, method, body);

      if (res.status < 200 || res.status >= 300) {
        const msg =
          res.status === 401 || res.status === 403
            ? 'Firebase RTDB Rules blocked access (401/403). Enable read/write in Firebase Realtime Database Rules.'
            : `Firebase RTDB HTTP ${res.status}: ${res.text || 'Request failed'}`;
        syncState.connected = false;
        syncState.lastError = msg;
        return { ok: false, status: res.status, error: msg };
      }

      let data: unknown = null;
      if (res.text) {
        try {
          data = JSON.parse(res.text);
        } catch {
          data = null;
        }
      }
      syncState.connected = true;
      syncState.lastSyncedAt = new Date().toISOString();
      syncState.lastError = null;
      return { ok: true, status: res.status, data };
    } catch (err) {
      if (attempt === 0) continue;
      const msg = err instanceof Error ? err.message : 'Network error reaching Firebase RTDB';
      syncState.connected = false;
      syncState.lastError = msg;
      return { ok: false, status: 0, error: msg };
    }
  }
  return { ok: false, status: 0, error: 'Firebase RTDB request failed' };
}

export async function fetchAllFromRtdb(baseUrl: string): Promise<{
  ok: boolean;
  products?: Product[];
  orders?: Order[];
  settings?: Partial<StoreSettings>;
  categories?: string[];
  isEmpty?: boolean;
}> {
  const res = await rtdbRequest(baseUrl, '', 'GET');
  if (!res.ok) return { ok: false };
  if (res.data === null || typeof res.data !== 'object') {
    return { ok: true, isEmpty: true };
  }

  const root = res.data as {
    products?: unknown;
    orders?: unknown;
    settings?: Partial<StoreSettings>;
    categories?: unknown;
  };

  const categories = Array.isArray(root.categories)
    ? root.categories.filter((c): c is string => typeof c === 'string' && c.trim().length > 0)
    : undefined;

  return {
    ok: true,
    isEmpty: !root.products && !root.orders && !root.settings && !root.categories,
    products: root.products ? normalizeRtdbMap<Product>(root.products) : undefined,
    orders: root.orders ? normalizeRtdbMap<Order>(root.orders) : undefined,
    settings: root.settings || undefined,
    categories,
  };
}

export async function pushInitialSnapshotToRtdb(
  baseUrl: string,
  payload: {
    products: Product[];
    orders: Order[];
    settings: StoreSettings;
    categories?: string[];
  },
): Promise<boolean> {
  const productsMap: Record<string, Product> = {};
  for (const p of payload.products) {
    productsMap[p.id] = p;
  }
  const ordersMap: Record<string, Order> = {};
  for (const o of payload.orders) {
    ordersMap[o.id] = o;
  }

  const res = await rtdbRequest(baseUrl, '', 'PATCH', {
    products: productsMap,
    orders: ordersMap,
    settings: payload.settings,
    ...(payload.categories ? { categories: payload.categories } : {}),
  });
  return res.ok;
}

export async function pushProductToRtdb(baseUrl: string, product: Product): Promise<boolean> {
  const res = await rtdbRequest(baseUrl, `/products/${product.id}`, 'PUT', product);
  return res.ok;
}

export async function deleteProductFromRtdb(baseUrl: string, productId: string): Promise<boolean> {
  const res = await rtdbRequest(baseUrl, `/products/${productId}`, 'DELETE');
  return res.ok;
}

export async function pushOrderToRtdb(baseUrl: string, order: Order): Promise<boolean> {
  const res = await rtdbRequest(baseUrl, `/orders/${order.id}`, 'PUT', order);
  return res.ok;
}

export async function updateOrderStatusInRtdb(
  baseUrl: string,
  orderId: string,
  status: OrderStatus,
): Promise<boolean> {
  const res = await rtdbRequest(baseUrl, `/orders/${orderId}`, 'PATCH', { status });
  return res.ok;
}

export async function pushSettingsToRtdb(
  baseUrl: string,
  settings: StoreSettings,
): Promise<boolean> {
  const res = await rtdbRequest(baseUrl, '/settings', 'PUT', settings);
  return res.ok;
}

export async function pushCategoriesToRtdb(
  baseUrl: string,
  categories: string[],
): Promise<boolean> {
  const res = await rtdbRequest(baseUrl, '/categories', 'PUT', categories);
  return res.ok;
}
