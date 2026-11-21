export type UpiPaymentStatus = 'Pending' | 'Paid' | 'Failed' | 'Expired';

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
  amount: number;
  orderId: string;
  transactionId: string;
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
  return Number.isInteger(rounded) ? rounded.toFixed(2) : rounded.toFixed(2);
}

export function sanitizeUpiText(value: unknown, maxLen = 60): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\r\n\t<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

export function buildDynamicUpiDeepLink(input: UpiDeepLinkParams): string {
  const pa = sanitizeUpiText(input.merchantUpiId, 80);
  const pn = sanitizeUpiText(input.merchantName, 60) || 'Bantuu Store';
  const tr = sanitizeUpiText(input.transactionId, 40);
  const orderId = sanitizeUpiText(input.orderId, 40);
  const customNote = sanitizeUpiText(input.note, 50);
  const tn = customNote ? `${orderId} - ${customNote}`.slice(0, 80) : `Order ${orderId}`;

  const params = new URLSearchParams({
    pa,
    pn,
    am: formatUpiAmountParam(input.amount),
    cu: 'INR',
    tr,
    tn,
  });

  return `upi://pay?${params.toString()}`;
}

export function buildAppSpecificUpiLinks(standardUpiUri: string): {
  upi: string;
  gpay: string;
  phonepe: string;
  paytm: string;
} {
  const query = standardUpiUri.startsWith('upi://pay?')
    ? standardUpiUri.slice('upi://pay?'.length)
    : '';
  return {
    upi: standardUpiUri,
    gpay: `tez://upi/pay?${query}`,
    phonepe: `phonepe://pay?${query}`,
    paytm: `paytmmp://pay?${query}`,
  };
}
