export type MediaType = 'image' | 'video';

export interface ProductMedia {
  id: string;
  type: MediaType;
  url: string;
  name?: string;
}

export interface Product {
  id: string;
  name: string;
  category: string;
  price: number;
  stock: number;
  description: string;
  media: ProductMedia[];
  featured?: boolean;
  createdAt: string;
}

export interface CartItem {
  productId: string;
  name: string;
  price: number;
  quantity: number;
  imageUrl: string;
  category: string;
}

export type PaymentMethod = 'COD' | 'UPI';

export type OrderStatus = 'Pending' | 'Confirmed' | 'Shipped' | 'Delivered' | 'Cancelled';

export interface OrderItem {
  productId: string;
  name: string;
  price: number;
  quantity: number;
  imageUrl: string;
}

export interface Order {
  id: string;
  orderNumber: string;
  customerName: string;
  customerPhone: string;
  address: string;
  city: string;
  pincode: string;
  items: OrderItem[];
  subtotal: number;
  shippingFee: number;
  total: number;
  paymentMethod: PaymentMethod;
  upiCustomerId?: string;
  upiTransactionId?: string;
  status: OrderStatus;
  createdAt: string;
}

export interface StoreSettings {
  storeName: string;
  upiId: string;
  upiQrUrl?: string;
  merchantName: string;
  freeShippingThreshold: number;
  shippingFee: number;
  firebaseRtdbUrl?: string;
}

export interface CheckoutFormInput {
  customerName: string;
  customerPhone: string;
  address: string;
  city: string;
  pincode: string;
  paymentMethod: PaymentMethod;
  upiCustomerId?: string;
  upiTransactionId?: string;
}

export interface ProductFormInput {
  name: string;
  category: string;
  price: string | number;
  stock: string | number;
  description: string;
  media: ProductMedia[];
}

export function formatINR(amount: number): string {
  const safe = Number.isFinite(amount) ? Math.round(amount) : 0;
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0,
  }).format(safe);
}

export function formatOrderDateTime(isoString: string, timeZone = 'Asia/Kolkata'): {
  date: string;
  time: string;
  full: string;
} {
  const parsed = new Date(isoString);
  if (Number.isNaN(parsed.getTime())) {
    return { date: 'Invalid date', time: '--:--', full: 'Invalid date' };
  }

  const date = new Intl.DateTimeFormat('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone,
  }).format(parsed);

  const time = new Intl.DateTimeFormat('en-IN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
    timeZone,
  }).format(parsed);

  return {
    date,
    time: time.toUpperCase(),
    full: `${date} at ${time.toUpperCase()}`,
  };
}

export function calculateCartTotals(
  items: Array<{ price: number; quantity: number }>,
  freeShippingThreshold = 999,
  standardShippingFee = 79,
): {
  itemCount: number;
  subtotal: number;
  shippingFee: number;
  total: number;
  amountToFreeShipping: number;
} {
  const itemCount = items.reduce((sum, item) => sum + Math.max(0, Math.floor(item.quantity)), 0);
  const subtotal = items.reduce(
    (sum, item) => sum + Math.max(0, Number(item.price)) * Math.max(0, Math.floor(item.quantity)),
    0,
  );
  const shippingFee = subtotal === 0 || subtotal >= freeShippingThreshold ? 0 : standardShippingFee;
  const total = subtotal + shippingFee;
  const amountToFreeShipping = subtotal >= freeShippingThreshold ? 0 : Math.max(0, freeShippingThreshold - subtotal);

  return {
    itemCount,
    subtotal,
    shippingFee,
    total,
    amountToFreeShipping,
  };
}

export function validateCheckoutForm(input: CheckoutFormInput): Record<string, string> {
  const errors: Record<string, string> = {};

  if (!input.customerName || input.customerName.trim().length < 2) {
    errors.customerName = 'Please enter your full name (at least 2 characters).';
  }

  const digitsPhone = (input.customerPhone || '').replace(/\D/g, '');
  if (digitsPhone.length !== 10) {
    errors.customerPhone = 'Enter a valid 10-digit mobile number.';
  }

  if (!input.address || input.address.trim().length < 6) {
    errors.address = 'Enter your complete street address or house number.';
  }

  if (!input.city || input.city.trim().length < 2) {
    errors.city = 'Enter your city or town.';
  }

  const digitsPin = (input.pincode || '').replace(/\D/g, '');
  if (digitsPin.length !== 6) {
    errors.pincode = 'Enter a valid 6-digit pincode.';
  }

  if (input.paymentMethod === 'UPI') {
    const utr = (input.upiTransactionId || '').trim();
    if (utr.length < 6) {
      errors.upiTransactionId = 'Enter your UPI Transaction ID / UTR reference (min 6 characters).';
    }
  }

  return errors;
}

export function validateProductForm(input: ProductFormInput): Record<string, string> {
  const errors: Record<string, string> = {};

  if (!input.name || input.name.trim().length < 2) {
    errors.name = 'Product name must be at least 2 characters.';
  }

  if (!input.category || input.category.trim().length < 2) {
    errors.category = 'Please choose or enter a category.';
  }

  const numericPrice = Number(input.price);
  if (!Number.isFinite(numericPrice) || numericPrice <= 0) {
    errors.price = 'Price must be greater than ₹0.';
  }

  const numericStock = Number(input.stock);
  if (!Number.isFinite(numericStock) || numericStock < 0 || !Number.isInteger(numericStock)) {
    errors.stock = 'Stock must be a whole number (0 or more).';
  }

  if (!input.description || input.description.trim().length < 10) {
    errors.description = 'Add a short description (at least 10 characters).';
  }

  if (!Array.isArray(input.media) || input.media.length === 0) {
    errors.media = 'Add at least one photo or video for this product.';
  }

  return errors;
}

export function buildUpiPaymentUri(
  upiId: string,
  merchantName: string,
  amount: number,
  orderNote: string,
): string {
  const params = new URLSearchParams({
    pa: upiId.trim(),
    pn: merchantName.trim() || 'Bantu Store',
    am: Math.max(1, Math.round(amount)).toString(),
    cu: 'INR',
    tn: orderNote.trim() || 'Bantu Store Order',
  });
  return `upi://pay?${params.toString()}`;
}

export function buildPhonePePaymentUri(
  upiId: string,
  merchantName: string,
  amount: number,
  orderNote: string,
): string {
  const params = new URLSearchParams({
    pa: upiId.trim(),
    pn: merchantName.trim() || 'Bantu Store',
    am: Math.max(1, Math.round(amount)).toString(),
    cu: 'INR',
    tn: orderNote.trim() || 'Bantu Store Order',
  });
  return `phonepe://pay?${params.toString()}`;
}

export function filterProducts(products: Product[], category: string, query: string): Product[] {
  const normalizedQuery = query.trim().toLowerCase();
  return products.filter((product) => {
    const matchesCategory = category === 'All' || product.category === category;
    if (!matchesCategory) return false;
    if (!normalizedQuery) return true;
    return (
      product.name.toLowerCase().includes(normalizedQuery) ||
      product.category.toLowerCase().includes(normalizedQuery) ||
      product.description.toLowerCase().includes(normalizedQuery)
    );
  });
}

export function filterOrders(
  orders: Order[],
  statusFilter: string,
  paymentFilter: string,
  query: string,
): Order[] {
  const normalizedQuery = query.trim().toLowerCase();
  return orders.filter((order) => {
    if (statusFilter !== 'All' && order.status !== statusFilter) return false;
    if (paymentFilter !== 'All' && order.paymentMethod !== paymentFilter) return false;
    if (!normalizedQuery) return true;
    return (
      order.orderNumber.toLowerCase().includes(normalizedQuery) ||
      order.customerName.toLowerCase().includes(normalizedQuery) ||
      order.customerPhone.toLowerCase().includes(normalizedQuery) ||
      order.city.toLowerCase().includes(normalizedQuery) ||
      (order.upiTransactionId || '').toLowerCase().includes(normalizedQuery)
    );
  });
}

export function inferMediaTypeFromUrl(url: string): MediaType {
  const clean = url.split('?')[0].toLowerCase();
  if (
    clean.endsWith('.mp4') ||
    clean.endsWith('.webm') ||
    clean.endsWith('.mov') ||
    clean.endsWith('.m4v') ||
    clean.endsWith('.ogg')
  ) {
    return 'video';
  }
  return 'image';
}

export function getPrimaryProductImage(product: Product): string {
  const firstImage = product.media.find((m) => m.type === 'image');
  return firstImage?.url || product.media[0]?.url || '';
}

export function normalizeFirebaseRtdbUrl(url: string): string {
  const trimmed = (url || '').trim().replace(/\/?\.json$/i, '').replace(/\/+$/, '');
  if (!trimmed) return '';
  if (!/^https?:\/\//i.test(trimmed)) return '';
  return trimmed;
}

export function normalizeRtdbMap<T extends { id?: string; createdAt?: string }>(raw: unknown): T[] {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw.filter((item): item is T => Boolean(item && typeof item === 'object'));
  }
  if (typeof raw === 'object') {
    return Object.entries(raw as Record<string, unknown>)
      .filter(([, val]) => Boolean(val && typeof val === 'object'))
      .map(([key, val]) => {
        const record = val as T;
        return {
          ...record,
          id: record.id || key,
        };
      })
      .sort((a, b) => {
        const ta = a.createdAt ? Date.parse(a.createdAt) : 0;
        const tb = b.createdAt ? Date.parse(b.createdAt) : 0;
        return tb - ta;
      });
  }
  return [];
}

export function isAdminSecretSearchQuery(query: string): boolean {
  return (query || '').trim().toLowerCase() === 'bantuustore';
}

export function verifyAdminPassword(passcode: string): boolean {
  return (passcode || '').trim() === '12348765';
}

export function normalizeCategoryName(name: string): string {
  return (name || '').trim().replace(/\s+/g, ' ');
}

export function validateCategoryName(
  name: string,
  existingCategories: string[],
  excludeName?: string,
): string | null {
  const clean = normalizeCategoryName(name);
  if (clean.length < 2) {
    return 'Category name must be at least 2 characters.';
  }
  if (clean.toLowerCase() === 'all') {
    return '"All" is reserved for viewing every product.';
  }
  const duplicate = existingCategories.some(
    (c) =>
      c.toLowerCase() === clean.toLowerCase() &&
      (!excludeName || c.toLowerCase() !== excludeName.trim().toLowerCase()),
  );
  if (duplicate) {
    return `Category "${clean}" already exists.`;
  }
  return null;
}

