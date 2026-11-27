export type UpiPaymentStatus = 'Pending' | 'Pending Verification' | 'Paid' | 'Failed' | 'Expired';

export const DEFAULT_MERCHANT_UPI_ID = 'paytm.s1ygjj7@pty';
export const DEFAULT_MERCHANT_NAME = 'PREM LAL CHOUDHRI';

export interface UpiPaymentRecord {
  transactionId: string;
  orderId: string;
  amount: number;
  currency: 'INR';
  merchantUpiId: string;
  merchantName: string;
  note: string;
  customerName?: string;
  upiUri: string;
  status: UpiPaymentStatus;
  utr?: string;
  providerRef?: string;
  createdAt: string;
  updatedAt: string;
  paidAt?: string;
}

export interface UpiDeepLinkParams {
  merchantUpiId: string;
  merchantName: string;
  merchantCode?: string;
  amount: number;
  orderId: string;
  transactionId?: string;
  note?: string;
}

const SAFE_TXN_ID_REGEX = /^[A-Za-z0-9_-]{6,64}$/;

export function isSafeTransactionId(id: string): boolean {
  return typeof id === 'string' && SAFE_TXN_ID_REGEX.test(id.trim());
}

export function validateUpiPaymentAmount(raw: unknown): {
  valid: boolean;
  amount: number;
  error?: string;
} {
  const num = typeof raw === 'string' ? Number(raw.trim()) : Number(raw);
  if (!Number.isFinite(num) || num <= 0) {
    return { valid: false, amount: 0, error: 'Enter a valid amount greater than ₹0.' };
  }
  const rounded = Math.round(num * 100) / 100;
  if (rounded < 1) {
    return { valid: false, amount: 0, error: 'Minimum UPI payment amount is ₹1.' };
  }
  if (rounded > 100000) {
    return { valid: false, amount: 0, error: 'Maximum single UPI payment limit is ₹1,00,000.' };
  }
  return { valid: true, amount: rounded };
}

export function formatUpiAmountParam(amount: number): string {
  const rounded = Math.round(Math.max(1, amount) * 100) / 100;
  return rounded.toFixed(2);
}

export function sanitizeUpiText(value: unknown, maxLen = 60): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[^\x20-\x7E]/g, ' ')
    .replace(/[\r\n\t<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

export type UpiAppKey = 'any' | 'phonepe' | 'gpay' | 'paytm';

export const UPI_APP_PACKAGES: Record<UpiAppKey, { label: string; androidPackage: string }> = {
  any: { label: 'UPI App', androidPackage: '' },
  phonepe: { label: 'PhonePe', androidPackage: 'com.phonepe.app' },
  gpay: { label: 'Google Pay', androidPackage: 'com.google.android.apps.nbu.paisa.user' },
  paytm: { label: 'Paytm', androidPackage: 'net.one97.paytm' },
};

export function decodePngDataUrl(dataUrl: string): Uint8Array | null {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/png;base64,')) {
    return null;
  }
  const base64 = dataUrl.slice('data:image/png;base64,'.length);
  if (!base64) return null;
  try {
    if (typeof atob === 'function') {
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) {
        bytes[i] = binary.charCodeAt(i);
      }
      return bytes;
    }
    return new Uint8Array(Buffer.from(base64, 'base64'));
  } catch {
    return null;
  }
}

function encodeUpiParamValue(value: string, preserveAtSign = false): string {
  const encoded = encodeURIComponent(value);
  return preserveAtSign ? encoded.replace(/%40/gi, '@') : encoded;
}

export function sanitizeMerchantCode(value: unknown): string {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  const digits = String(value).replace(/\D/g, '');
  return digits.length === 4 ? digits : '';
}

/**
 * Builds a clean, safe standard UPI Deep Link URI using ONLY:
 * pa, pn, am (2 decimals), cu=INR, tn={orderId}.
 * Intentionally omits tr, url, and sign so UPI apps do not block payments with risk policy errors.
 */
export function buildDynamicUpiDeepLink(input: UpiDeepLinkParams): string {
  const pa = sanitizeUpiText(input.merchantUpiId, 80) || DEFAULT_MERCHANT_UPI_ID;
  const pn = sanitizeUpiText(input.merchantName, 60) || DEFAULT_MERCHANT_NAME;
  const orderId = sanitizeUpiText(input.orderId, 40) || 'ORDER';

  const queryParts = [
    `pa=${encodeUpiParamValue(pa, true)}`,
    `pn=${encodeUpiParamValue(pn)}`,
    `am=${encodeUpiParamValue(formatUpiAmountParam(input.amount))}`,
    'cu=INR',
    `tn=${encodeUpiParamValue(orderId)}`,
  ];

  return `upi://pay?${queryParts.join('&')}`;
}

export function buildAppSpecificUpiLinks(standardUpiUri: string): {
  upi: string;
  gpay: string;
  gpayIos: string;
  phonepe: string;
  paytm: string;
  androidIntent: string;
} {
  const query = standardUpiUri.startsWith('upi://pay?')
    ? standardUpiUri.slice('upi://pay?'.length)
    : '';
  return {
    upi: standardUpiUri,
    gpay: `tez://upi/pay?${query}`,
    gpayIos: `gpay://upi/pay?${query}`,
    phonepe: `phonepe://pay?${query}`,
    paytm: `paytmmp://pay?${query}`,
    androidIntent: `intent://pay?${query}#Intent;scheme=upi;end`,
  };
}

export function isAllowedUpiDeepLink(uri: string): boolean {
  if (typeof uri !== 'string') return false;
  return (
    uri.startsWith('upi://pay?') ||
    uri.startsWith('phonepe://pay?') ||
    uri.startsWith('tez://upi/pay?') ||
    uri.startsWith('gpay://upi/pay?') ||
    uri.startsWith('paytmmp://pay?') ||
    uri.startsWith('intent://pay?')
  );
}
