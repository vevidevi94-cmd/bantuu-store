import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import QRCode from 'qrcode';
import {
  buildAppSpecificUpiLinks,
  buildDynamicUpiDeepLink,
  isSafeTransactionId,
  sanitizeUpiText,
  validateUpiPaymentAmount,
  type UpiPaymentRecord,
  type UpiPaymentStatus,
} from '../src/utils/upiPaymentLogic.js';
import {
  fetchAllUpiPaymentsFromRtdb,
  fetchUpiPaymentFromRtdb,
  patchUpiPaymentInRtdb,
  pushUpiPaymentToRtdb,
} from './firebaseRtdb.js';
import { getStoreSnapshot } from './storeDb.js';

const DATA_DIR = process.env.VERCEL
  ? path.join('/tmp', 'bantuu-store-data')
  : path.join(process.cwd(), 'data');
const PAYMENTS_FILE = path.join(DATA_DIR, 'upi-payments.json');
const DEFAULT_RTDB_URL = 'https://bantuu-store-default-rtdb.firebaseio.com';

interface StoredUpiPayment extends UpiPaymentRecord {
  statusTokenHash?: string;
}

interface UpiPaymentsDb {
  payments: Record<string, StoredUpiPayment>;
}

function getRtdbUrl(): string {
  const snapshot = getStoreSnapshot();
  return snapshot.settings.firebaseRtdbUrl || DEFAULT_RTDB_URL;
}

function loadLocalPayments(): UpiPaymentsDb {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (!fs.existsSync(PAYMENTS_FILE)) {
      return { payments: {} };
    }
    const raw = fs.readFileSync(PAYMENTS_FILE, 'utf8');
    const parsed = JSON.parse(raw) as Partial<UpiPaymentsDb>;
    return { payments: parsed.payments && typeof parsed.payments === 'object' ? parsed.payments : {} };
  } catch {
    return { payments: {} };
  }
}

function saveLocalPayments(db: UpiPaymentsDb): void {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    fs.writeFileSync(PAYMENTS_FILE, JSON.stringify(db, null, 2), 'utf8');
  } catch {
    // Non-fatal in read-only serverless environments; RTDB remains source of truth
  }
}

function stripInternalFields(record: StoredUpiPayment): UpiPaymentRecord {
  const { statusTokenHash: _omit, ...publicRecord } = record;
  return publicRecord;
}

const EPHEMERAL_STATUS_KEY = crypto.randomBytes(32).toString('hex');

function getStatusSigningSecret(): string {
  return (
    process.env.UPI_STATUS_SIGNING_SECRET?.trim() ||
    process.env.ADMIN_SESSION_SECRET?.trim() ||
    process.env.UPI_WEBHOOK_SECRET?.trim() ||
    EPHEMERAL_STATUS_KEY
  );
}

export function deriveTransactionStatusToken(transactionId: string): string {
  return crypto
    .createHmac('sha256', getStatusSigningSecret())
    .update(`bantuu-upi-status:${transactionId}`)
    .digest('hex');
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function timingSafeEqualStr(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export function verifyWebhookSignature(
  payloadString: string,
  signatureHeader: string | undefined,
  secretHeader: string | undefined,
  configuredSecret: string | undefined,
): boolean {
  const secret = (configuredSecret || '').trim();
  if (!secret) return false;

  if (signatureHeader && signatureHeader.trim()) {
    const provided = signatureHeader.trim().replace(/^sha256=/i, '');
    const expected = crypto
      .createHmac('sha256', secret)
      .update(payloadString)
      .digest('hex');
    if (timingSafeEqualStr(provided.toLowerCase(), expected.toLowerCase())) {
      return true;
    }
  }

  if (secretHeader && secretHeader.trim()) {
    if (timingSafeEqualStr(secretHeader.trim(), secret)) {
      return true;
    }
  }

  return false;
}

export function generateUniqueUpiIds(): { orderId: string; transactionId: string } {
  const now = Date.now().toString(36).toUpperCase();
  const suffixA = crypto.randomBytes(3).toString('hex').toUpperCase();
  const suffixB = crypto.randomBytes(4).toString('hex').toUpperCase();
  return {
    orderId: `ORD-${now}-${suffixA}`,
    transactionId: `TXN-${now}-${suffixB}`,
  };
}

export async function createDynamicUpiPayment(input: {
  amount: unknown;
  note?: unknown;
  customerName?: unknown;
}): Promise<
  | {
      ok: true;
      payment: UpiPaymentRecord;
      qrCodeDataUrl: string;
      appLinks: ReturnType<typeof buildAppSpecificUpiLinks>;
      statusToken: string;
      rtdbSynced: boolean;
    }
  | { ok: false; error: string }
> {
  const amountCheck = validateUpiPaymentAmount(input.amount);
  if (!amountCheck.valid) {
    return { ok: false, error: amountCheck.error || 'Invalid payment amount.' };
  }

  const snapshot = getStoreSnapshot();
  const merchantUpiId = snapshot.settings.upiId || 'paytm.s1ygjj7@pty';
  const merchantName = snapshot.settings.merchantName || 'PREM LAL CHOUDHRI';
  const { orderId, transactionId } = generateUniqueUpiIds();
  const cleanNote = sanitizeUpiText(input.note, 50);
  const cleanCustomer = sanitizeUpiText(input.customerName, 60);
  const nowIso = new Date().toISOString();

  const upiUri = buildDynamicUpiDeepLink({
    merchantUpiId,
    merchantName,
    amount: amountCheck.amount,
    orderId,
  });

  const qrCodeDataUrl = await QRCode.toDataURL(upiUri, {
    width: 640,
    margin: 4,
    color: { dark: '#0F1D32', light: '#FFFFFF' },
    errorCorrectionLevel: 'M',
  });

  const statusToken = deriveTransactionStatusToken(transactionId);
  const publicRecord: UpiPaymentRecord = {
    transactionId,
    orderId,
    amount: amountCheck.amount,
    currency: 'INR',
    merchantUpiId,
    merchantName,
    note: cleanNote || orderId,
    ...(cleanCustomer ? { customerName: cleanCustomer } : {}),
    upiUri,
    status: 'Pending Verification',
    createdAt: nowIso,
    updatedAt: nowIso,
  };

  const storedRecord: StoredUpiPayment = {
    ...publicRecord,
    statusTokenHash: hashToken(statusToken),
  };

  const localDb = loadLocalPayments();
  localDb.payments[transactionId] = storedRecord;
  saveLocalPayments(localDb);

  const rtdbSynced = await pushUpiPaymentToRtdb(getRtdbUrl(), publicRecord);

  return {
    ok: true,
    payment: publicRecord,
    qrCodeDataUrl,
    appLinks: buildAppSpecificUpiLinks(upiUri),
    statusToken,
    rtdbSynced,
  };
}

export async function getDynamicUpiPayment(
  transactionId: string,
): Promise<StoredUpiPayment | null> {
  if (!isSafeTransactionId(transactionId)) return null;
  const localDb = loadLocalPayments();
  const localRecord = localDb.payments[transactionId] || null;

  // Fetch latest status from Firebase RTDB so external webhook/poller updates are reflected immediately
  const remoteRecord = await fetchUpiPaymentFromRtdb<UpiPaymentRecord>(
    getRtdbUrl(),
    transactionId,
  );

  if (remoteRecord) {
    const merged: StoredUpiPayment = {
      ...localRecord,
      ...remoteRecord,
      statusTokenHash: localRecord?.statusTokenHash,
    };
    localDb.payments[transactionId] = merged;
    saveLocalPayments(localDb);
    return merged;
  }

  return localRecord;
}

export async function listRecentUpiPayments(limit = 30): Promise<UpiPaymentRecord[]> {
  const remoteList = await fetchAllUpiPaymentsFromRtdb<UpiPaymentRecord>(getRtdbUrl());
  const localDb = loadLocalPayments();
  const byId = new Map<string, UpiPaymentRecord>();

  for (const item of Object.values(localDb.payments)) {
    byId.set(item.transactionId, stripInternalFields(item));
  }
  for (const item of remoteList) {
    if (item && item.transactionId) {
      byId.set(item.transactionId, item);
    }
  }

  return Array.from(byId.values())
    .sort((a, b) => Date.parse(b.createdAt || '') - Date.parse(a.createdAt || ''))
    .slice(0, Math.max(1, limit));
}

export function verifyTransactionStatusToken(
  stored: StoredUpiPayment,
  providedToken: string | undefined,
): boolean {
  const clean = (providedToken || '').trim();
  if (!clean) {
    return false;
  }
  if (stored.statusTokenHash && timingSafeEqualStr(stored.statusTokenHash, hashToken(clean))) {
    return true;
  }
  const expectedDerived = deriveTransactionStatusToken(stored.transactionId);
  return timingSafeEqualStr(expectedDerived, clean);
}

export async function updateDynamicUpiPaymentStatus(input: {
  transactionId: string;
  status: UpiPaymentStatus;
  utr?: string;
  providerRef?: string;
  expectedAmount?: number;
}): Promise<
  | { ok: true; payment: UpiPaymentRecord; rtdbSynced: boolean }
  | { ok: false; statusCode: number; error: string }
> {
  if (!isSafeTransactionId(input.transactionId)) {
    return { ok: false, statusCode: 400, error: 'Invalid transactionId format.' };
  }

  const existing = await getDynamicUpiPayment(input.transactionId);
  if (!existing) {
    return { ok: false, statusCode: 404, error: 'UPI transaction not found.' };
  }

  if (
    input.expectedAmount !== undefined &&
    Number.isFinite(input.expectedAmount) &&
    Math.abs(Math.round(input.expectedAmount * 100) - Math.round(existing.amount * 100)) > 1
  ) {
    return {
      ok: false,
      statusCode: 400,
      error: 'Webhook amount does not match the recorded transaction amount.',
    };
  }

  const nowIso = new Date().toISOString();
  const cleanUtr = sanitizeUpiText(input.utr, 40) || existing.utr;
  const cleanProviderRef = sanitizeUpiText(input.providerRef, 60) || existing.providerRef;

  const updatedStored: StoredUpiPayment = {
    ...existing,
    status: input.status,
    updatedAt: nowIso,
    ...(cleanUtr ? { utr: cleanUtr } : {}),
    ...(cleanProviderRef ? { providerRef: cleanProviderRef } : {}),
    ...(input.status === 'Paid' ? { paidAt: existing.paidAt || nowIso } : {}),
  };

  const localDb = loadLocalPayments();
  localDb.payments[input.transactionId] = updatedStored;
  saveLocalPayments(localDb);

  const patchPayload: Record<string, unknown> = {
    status: updatedStored.status,
    updatedAt: updatedStored.updatedAt,
  };
  if (updatedStored.utr) patchPayload.utr = updatedStored.utr;
  if (updatedStored.providerRef) patchPayload.providerRef = updatedStored.providerRef;
  if (updatedStored.paidAt) patchPayload.paidAt = updatedStored.paidAt;

  const rtdbSynced = await patchUpiPaymentInRtdb(
    getRtdbUrl(),
    input.transactionId,
    patchPayload,
  );

  return {
    ok: true,
    payment: stripInternalFields(updatedStored),
    rtdbSynced,
  };
}

export function toPublicUpiPayment(stored: StoredUpiPayment): UpiPaymentRecord {
  return stripInternalFields(stored);
}
