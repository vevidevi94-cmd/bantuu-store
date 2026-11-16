import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Order, OrderStatus, Product, StoreSettings } from '../src/utils/storeLogic';
import {
  calculateCartTotals,
  normalizeCategoryName,
  normalizeFirebaseRtdbUrl,
  validateCategoryName,
} from '../src/utils/storeLogic';
import {
  deleteProductFromRtdb,
  fetchAllFromRtdb,
  pushCategoriesToRtdb,
  pushInitialSnapshotToRtdb,
  pushOrderToRtdb,
  pushProductToRtdb,
  pushSettingsToRtdb,
  updateOrderStatusInRtdb,
} from './firebaseRtdb';

export interface StoreDatabase {
  products: Product[];
  orders: Order[];
  settings: StoreSettings;
  categories: string[];
  nextOrderSeq: number;
}

const DATA_DIR = path.join(process.cwd(), 'data');
const DB_FILE = path.join(DATA_DIR, 'store.json');
const DEFAULT_RTDB_URL = 'https://bantuu-store-default-rtdb.firebaseio.com';
const DEFAULT_UPI_ID = 'skiend@axl';
const DEFAULT_UPI_QR_URL = '/assets/aistudio/47084_35196505.jpg';
const DEFAULT_CATEGORIES = [
  'Home & Living',
  'Carry & Leather',
  'Watches',
  'Audio',
  'Apparel',
  'Accessories',
];

const SEED_DATA: StoreDatabase = {
  settings: {
    storeName: 'Bantuu Store',
    upiId: DEFAULT_UPI_ID,
    upiQrUrl: DEFAULT_UPI_QR_URL,
    merchantName: 'Bantuu Store Retail',
    freeShippingThreshold: 999,
    shippingFee: 79,
    firebaseRtdbUrl: DEFAULT_RTDB_URL,
  },
  categories: DEFAULT_CATEGORIES,
  nextOrderSeq: 1003,
  products: [
    {
      id: 'prod-kettle-01',
      name: 'Matte Ceramic Pour-Over Kettle',
      category: 'Home & Living',
      price: 2499,
      stock: 18,
      description:
        'Stoneware-finish precision gooseneck kettle with solid walnut handle and balanced heat retention for slow-pour morning coffee.',
      media: [
        {
          id: 'med-1',
          type: 'image',
          url: '/src/assets/images/product_ceramic_kettle_1794794602619.jpg',
          name: 'Ceramic Kettle Front',
        },
      ],
      featured: true,
      createdAt: '2026-11-10T09:15:00.000Z',
    },
    {
      id: 'prod-tote-02',
      name: 'Cognac Full-Grain Leather Tote',
      category: 'Carry & Leather',
      price: 4299,
      stock: 11,
      description:
        'Vegetable-tanned full-grain leather everyday carryall with brass rivets, padded 14-inch laptop sleeve, and top zip closure.',
      media: [
        {
          id: 'med-2',
          type: 'image',
          url: '/src/assets/images/product_leather_tote_1794794601940.jpg',
          name: 'Cognac Leather Tote',
        },
      ],
      featured: true,
      createdAt: '2026-11-11T11:30:00.000Z',
    },
    {
      id: 'prod-watch-03',
      name: 'Field Brushed Steel Watch',
      category: 'Watches',
      price: 5499,
      stock: 9,
      description:
        '38mm brushed stainless steel case with sapphire crystal, warm ivory dial, and stitched tan calfskin strap.',
      media: [
        {
          id: 'med-3',
          type: 'image',
          url: '/src/assets/images/product_brass_watch_1794794599021.jpg',
          name: 'Field Watch Dial',
        },
      ],
      featured: true,
      createdAt: '2026-11-12T14:00:00.000Z',
    },
    {
      id: 'prod-audio-04',
      name: 'Studio Obsidian Wireless Headphones',
      category: 'Audio',
      price: 6999,
      stock: 14,
      description:
        'Active noise-cancelling over-ear headphones with anodized aluminum yokes, memory-foam earcups, and 40-hour battery life.',
      media: [
        {
          id: 'med-4',
          type: 'image',
          url: '/src/assets/images/product_studio_headphones_1794794599341.jpg',
          name: 'Studio Headphones',
        },
      ],
      featured: true,
      createdAt: '2026-11-13T10:45:00.000Z',
    },
    {
      id: 'prod-apparel-05',
      name: 'Heavyweight Olive Linen Overshirt',
      category: 'Apparel',
      price: 1899,
      stock: 24,
      description:
        'Breathable 240gsm washed European flax linen overshirt finished with natural corozo buttons and relaxed tailored shoulders.',
      media: [
        {
          id: 'med-5',
          type: 'image',
          url: '/src/assets/images/product_linen_shirt_1794794599684.jpg',
          name: 'Olive Linen Overshirt',
        },
      ],
      featured: false,
      createdAt: '2026-11-14T08:20:00.000Z',
    },
  ],
  orders: [
    {
      id: 'ord-seed-1002',
      orderNumber: 'BNT-1002',
      customerName: 'Priya Nair',
      customerPhone: '9820112233',
      address: '14 Pali Hill, Bandra West',
      city: 'Mumbai',
      pincode: '400050',
      items: [
        {
          productId: 'prod-tote-02',
          name: 'Cognac Full-Grain Leather Tote',
          price: 4299,
          quantity: 1,
          imageUrl: '/src/assets/images/product_leather_tote_1794794601940.jpg',
        },
      ],
      subtotal: 4299,
      shippingFee: 0,
      total: 4299,
      paymentMethod: 'UPI',
      upiCustomerId: 'priya.nair@okicici',
      upiTransactionId: 'UTR631928475012',
      status: 'Confirmed',
      createdAt: '2026-11-15T11:42:00.000Z',
    },
    {
      id: 'ord-seed-1001',
      orderNumber: 'BNT-1001',
      customerName: 'Rohan Malhotra',
      customerPhone: '9811445566',
      address: 'B-28 Defence Colony',
      city: 'New Delhi',
      pincode: '110024',
      items: [
        {
          productId: 'prod-kettle-01',
          name: 'Matte Ceramic Pour-Over Kettle',
          price: 2499,
          quantity: 1,
          imageUrl: '/src/assets/images/product_ceramic_kettle_1794794602619.jpg',
        },
        {
          productId: 'prod-apparel-05',
          name: 'Heavyweight Olive Linen Overshirt',
          price: 1899,
          quantity: 1,
          imageUrl: '/src/assets/images/product_linen_shirt_1794794599684.jpg',
        },
      ],
      subtotal: 4398,
      shippingFee: 0,
      total: 4398,
      paymentMethod: 'COD',
      status: 'Pending',
      createdAt: '2026-11-15T06:18:00.000Z',
    },
  ],
};

function ensureDbInitialized(): StoreDatabase {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify(SEED_DATA, null, 2), 'utf8');
    return structuredClone(SEED_DATA);
  }
  const raw = fs.readFileSync(DB_FILE, 'utf8');
  const parsed = JSON.parse(raw) as StoreDatabase;
  if (!parsed.settings.firebaseRtdbUrl) {
    parsed.settings.firebaseRtdbUrl = DEFAULT_RTDB_URL;
  }
  if (parsed.settings.storeName === 'Bantu Store') {
    parsed.settings.storeName = 'Bantuu Store';
  }
  if (!parsed.settings.upiId || parsed.settings.upiId === 'bantustore@upi') {
    parsed.settings.upiId = DEFAULT_UPI_ID;
  }
  if (!parsed.settings.upiQrUrl) {
    parsed.settings.upiQrUrl = DEFAULT_UPI_QR_URL;
  }
  if (!Array.isArray(parsed.categories) || parsed.categories.length === 0) {
    const derived = new Set<string>(DEFAULT_CATEGORIES);
    for (const prod of parsed.products || []) {
      if (prod.category) derived.add(prod.category.trim());
    }
    parsed.categories = Array.from(derived);
  }
  return parsed;
}

function saveDb(db: StoreDatabase): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
}

export async function syncWithRtdbOnBootOrRefresh(): Promise<StoreDatabase> {
  const db = ensureDbInitialized();
  const rtdbUrl = normalizeFirebaseRtdbUrl(db.settings.firebaseRtdbUrl || DEFAULT_RTDB_URL);
  if (!rtdbUrl) return db;

  const remote = await fetchAllFromRtdb(rtdbUrl);
  if (!remote.ok) return db;

  // If RTDB hasn't been initialized with settings yet, merge any partial remote orders/products
  // with our local seed catalog and push the complete snapshot up to RTDB.
  if (remote.isEmpty || !remote.settings) {
    if (remote.products && remote.products.length > 0) {
      const mergedProducts = new Map<string, Product>();
      for (const p of db.products) mergedProducts.set(p.id, p);
      for (const p of remote.products) {
        mergedProducts.set(p.id, {
          ...p,
          media: Array.isArray(p.media) ? p.media : [],
          price: Number(p.price) || 0,
          stock: Number(p.stock) || 0,
          createdAt: p.createdAt || new Date().toISOString(),
        });
      }
      db.products = Array.from(mergedProducts.values()).sort(
        (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
      );
    }

    if (remote.orders && remote.orders.length > 0) {
      const mergedOrders = new Map<string, Order>();
      for (const o of db.orders) mergedOrders.set(o.id, o);
      for (const o of remote.orders) {
        mergedOrders.set(o.id, {
          ...o,
          items: Array.isArray(o.items) ? o.items : [],
          subtotal: Number(o.subtotal) || 0,
          shippingFee: Number(o.shippingFee) || 0,
          total: Number(o.total) || 0,
          createdAt: o.createdAt || new Date().toISOString(),
        });
      }
      db.orders = Array.from(mergedOrders.values()).sort(
        (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
      );
      const maxSeq = db.orders.reduce((max, o) => {
        const m = /^BNT-(\d+)$/i.exec(o.orderNumber || '');
        return m ? Math.max(max, Number(m[1])) : max;
      }, 1000);
      db.nextOrderSeq = Math.max(db.nextOrderSeq, maxSeq + 1);
    }

    saveDb(db);
    await pushInitialSnapshotToRtdb(rtdbUrl, {
      products: db.products,
      orders: db.orders,
      settings: db.settings,
      categories: db.categories,
    });
    return db;
  }

  let changed = false;

  if (remote.products) {
    db.products = remote.products.map((p) => ({
      ...p,
      media: Array.isArray(p.media) ? p.media : [],
      price: Number(p.price) || 0,
      stock: Number(p.stock) || 0,
      createdAt: p.createdAt || new Date().toISOString(),
    }));
    changed = true;
  }

  if (remote.orders) {
    db.orders = remote.orders.map((o) => ({
      ...o,
      items: Array.isArray(o.items) ? o.items : [],
      subtotal: Number(o.subtotal) || 0,
      shippingFee: Number(o.shippingFee) || 0,
      total: Number(o.total) || 0,
      createdAt: o.createdAt || new Date().toISOString(),
    }));
    const maxSeq = db.orders.reduce((max, o) => {
      const m = /^BNT-(\d+)$/i.exec(o.orderNumber || '');
      return m ? Math.max(max, Number(m[1])) : max;
    }, 1000);
    db.nextOrderSeq = Math.max(db.nextOrderSeq, maxSeq + 1);
    changed = true;
  }

  if (remote.settings) {
    const needsUpiMigration =
      !remote.settings.upiId ||
      remote.settings.upiId === 'bantustore@upi' ||
      !remote.settings.upiQrUrl;
    db.settings = {
      ...db.settings,
      ...remote.settings,
      upiId:
        !remote.settings.upiId || remote.settings.upiId === 'bantustore@upi'
          ? DEFAULT_UPI_ID
          : remote.settings.upiId,
      upiQrUrl: remote.settings.upiQrUrl || DEFAULT_UPI_QR_URL,
      firebaseRtdbUrl: remote.settings.firebaseRtdbUrl || db.settings.firebaseRtdbUrl || DEFAULT_RTDB_URL,
    };
    changed = true;
    if (needsUpiMigration) {
      await pushSettingsToRtdb(rtdbUrl, db.settings);
    }
  }

  if (remote.categories && remote.categories.length > 0) {
    db.categories = remote.categories;
    changed = true;
  } else if (db.categories.length > 0) {
    await pushCategoriesToRtdb(rtdbUrl, db.categories);
  }

  if (changed) {
    saveDb(db);
  }
  return db;
}

export function getStoreSnapshot(): StoreDatabase {
  const db = ensureDbInitialized();
  return {
    ...db,
    orders: [...db.orders].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)),
  };
}

export async function addProductRecord(input: {
  name: string;
  category: string;
  price: number;
  stock: number;
  description: string;
  media: Product['media'];
  featured?: boolean;
}): Promise<Product> {
  const db = ensureDbInitialized();
  const product: Product = {
    id: `prod-${crypto.randomUUID().slice(0, 8)}`,
    name: input.name.trim(),
    category: input.category.trim(),
    price: Math.round(input.price),
    stock: Math.max(0, Math.floor(input.stock)),
    description: input.description.trim(),
    media: input.media,
    featured: Boolean(input.featured),
    createdAt: new Date().toISOString(),
  };
  db.products.unshift(product);
  let categoriesChanged = false;
  if (!db.categories.some((c) => c.toLowerCase() === product.category.toLowerCase())) {
    db.categories.push(product.category);
    categoriesChanged = true;
  }
  saveDb(db);

  const rtdbUrl = db.settings.firebaseRtdbUrl || DEFAULT_RTDB_URL;
  await pushProductToRtdb(rtdbUrl, product);
  if (categoriesChanged) {
    await pushCategoriesToRtdb(rtdbUrl, db.categories);
  }
  return product;
}

export async function deleteProductRecord(productId: string): Promise<boolean> {
  const db = ensureDbInitialized();
  const before = db.products.length;
  db.products = db.products.filter((p) => p.id !== productId);
  if (db.products.length === before) return false;
  saveDb(db);

  const rtdbUrl = db.settings.firebaseRtdbUrl || DEFAULT_RTDB_URL;
  await deleteProductFromRtdb(rtdbUrl, productId);
  return true;
}

export async function createOrderRecord(input: {
  customerName: string;
  customerPhone: string;
  address: string;
  city: string;
  pincode: string;
  paymentMethod: 'COD' | 'UPI';
  upiCustomerId?: string;
  upiTransactionId?: string;
  items: Array<{ productId: string; quantity: number }>;
}): Promise<{ order?: Order; error?: string }> {
  const db = ensureDbInitialized();

  if (!Array.isArray(input.items) || input.items.length === 0) {
    return { error: 'Cart is empty. Add at least one item before placing an order.' };
  }

  const resolvedItems: Order['items'] = [];
  const updatedProducts: Product[] = [];

  for (const requested of input.items) {
    const product = db.products.find((p) => p.id === requested.productId);
    if (!product) {
      return { error: `Product "${requested.productId}" is no longer available.` };
    }
    const qty = Math.max(1, Math.floor(requested.quantity));
    if (product.stock < qty) {
      return { error: `Only ${product.stock} unit(s) left in stock for "${product.name}".` };
    }
    const firstImage = product.media.find((m) => m.type === 'image')?.url || product.media[0]?.url || '';
    resolvedItems.push({
      productId: product.id,
      name: product.name,
      price: product.price,
      quantity: qty,
      imageUrl: firstImage,
    });
  }

  // Decrement stock
  for (const item of resolvedItems) {
    const prod = db.products.find((p) => p.id === item.productId);
    if (prod) {
      prod.stock = Math.max(0, prod.stock - item.quantity);
      updatedProducts.push(prod);
    }
  }

  const totals = calculateCartTotals(
    resolvedItems,
    db.settings.freeShippingThreshold,
    db.settings.shippingFee,
  );

  const orderNumber = `BNT-${db.nextOrderSeq}`;
  db.nextOrderSeq += 1;

  const order: Order = {
    id: `ord-${crypto.randomUUID().slice(0, 8)}`,
    orderNumber,
    customerName: input.customerName.trim(),
    customerPhone: input.customerPhone.replace(/\D/g, ''),
    address: input.address.trim(),
    city: input.city.trim(),
    pincode: input.pincode.replace(/\D/g, ''),
    items: resolvedItems,
    subtotal: totals.subtotal,
    shippingFee: totals.shippingFee,
    total: totals.total,
    paymentMethod: input.paymentMethod,
    upiCustomerId: input.paymentMethod === 'UPI' ? (input.upiCustomerId || '').trim() || undefined : undefined,
    upiTransactionId: input.paymentMethod === 'UPI' ? (input.upiTransactionId || '').trim() : undefined,
    status: 'Pending',
    createdAt: new Date().toISOString(),
  };

  db.orders.unshift(order);
  saveDb(db);

  const rtdbUrl = db.settings.firebaseRtdbUrl || DEFAULT_RTDB_URL;
  await pushOrderToRtdb(rtdbUrl, order);
  await Promise.all(updatedProducts.map((p) => pushProductToRtdb(rtdbUrl, p)));

  return { order };
}

export async function updateOrderStatusRecord(
  orderId: string,
  status: OrderStatus,
): Promise<Order | null> {
  const db = ensureDbInitialized();
  const order = db.orders.find((o) => o.id === orderId);
  if (!order) return null;
  order.status = status;
  saveDb(db);

  const rtdbUrl = db.settings.firebaseRtdbUrl || DEFAULT_RTDB_URL;
  await updateOrderStatusInRtdb(rtdbUrl, orderId, status);
  return order;
}

export async function updateStoreSettingsRecord(
  patch: Partial<StoreSettings>,
): Promise<StoreSettings> {
  const db = ensureDbInitialized();
  const nextRtdbUrl =
    patch.firebaseRtdbUrl !== undefined
      ? normalizeFirebaseRtdbUrl(patch.firebaseRtdbUrl) || db.settings.firebaseRtdbUrl
      : db.settings.firebaseRtdbUrl;

  db.settings = {
    ...db.settings,
    storeName: patch.storeName?.trim() || db.settings.storeName,
    upiId: patch.upiId?.trim() || db.settings.upiId,
    upiQrUrl:
      patch.upiQrUrl !== undefined
        ? patch.upiQrUrl.trim() || DEFAULT_UPI_QR_URL
        : db.settings.upiQrUrl || DEFAULT_UPI_QR_URL,
    merchantName: patch.merchantName?.trim() || db.settings.merchantName,
    freeShippingThreshold:
      typeof patch.freeShippingThreshold === 'number' && patch.freeShippingThreshold >= 0
        ? Math.round(patch.freeShippingThreshold)
        : db.settings.freeShippingThreshold,
    shippingFee:
      typeof patch.shippingFee === 'number' && patch.shippingFee >= 0
        ? Math.round(patch.shippingFee)
        : db.settings.shippingFee,
    firebaseRtdbUrl: nextRtdbUrl,
  };
  saveDb(db);

  const rtdbUrl = db.settings.firebaseRtdbUrl || DEFAULT_RTDB_URL;
  await pushSettingsToRtdb(rtdbUrl, db.settings);
  return db.settings;
}

export async function addCategoryRecord(
  name: string,
): Promise<{ categories: string[]; error?: string }> {
  const db = ensureDbInitialized();
  const validationError = validateCategoryName(name, db.categories);
  if (validationError) {
    return { categories: db.categories, error: validationError };
  }
  const clean = normalizeCategoryName(name);
  db.categories.push(clean);
  saveDb(db);

  const rtdbUrl = db.settings.firebaseRtdbUrl || DEFAULT_RTDB_URL;
  await pushCategoriesToRtdb(rtdbUrl, db.categories);
  return { categories: db.categories };
}

export async function renameCategoryRecord(
  oldName: string,
  newName: string,
): Promise<{ categories: string[]; products: Product[]; error?: string }> {
  const db = ensureDbInitialized();
  const cleanOld = normalizeCategoryName(oldName);
  const idx = db.categories.findIndex((c) => c.toLowerCase() === cleanOld.toLowerCase());
  if (idx === -1) {
    return { categories: db.categories, products: db.products, error: 'Category not found.' };
  }

  const validationError = validateCategoryName(newName, db.categories, db.categories[idx]);
  if (validationError) {
    return { categories: db.categories, products: db.products, error: validationError };
  }

  const cleanNew = normalizeCategoryName(newName);
  const previousExact = db.categories[idx];
  db.categories[idx] = cleanNew;

  const updatedProducts: Product[] = [];
  for (const prod of db.products) {
    if (prod.category.toLowerCase() === previousExact.toLowerCase()) {
      prod.category = cleanNew;
      updatedProducts.push(prod);
    }
  }
  saveDb(db);

  const rtdbUrl = db.settings.firebaseRtdbUrl || DEFAULT_RTDB_URL;
  await pushCategoriesToRtdb(rtdbUrl, db.categories);
  await Promise.all(updatedProducts.map((p) => pushProductToRtdb(rtdbUrl, p)));
  return { categories: db.categories, products: db.products };
}

export async function deleteCategoryRecord(
  name: string,
): Promise<{ categories: string[]; products: Product[]; error?: string }> {
  const db = ensureDbInitialized();
  const clean = normalizeCategoryName(name);
  const idx = db.categories.findIndex((c) => c.toLowerCase() === clean.toLowerCase());
  if (idx === -1) {
    return { categories: db.categories, products: db.products, error: 'Category not found.' };
  }

  const removedExact = db.categories[idx];
  const remaining = db.categories.filter((_, i) => i !== idx);
  const fallbackCategory = remaining[0] || 'General';
  if (remaining.length === 0) {
    remaining.push(fallbackCategory);
  }
  db.categories = remaining;

  const updatedProducts: Product[] = [];
  for (const prod of db.products) {
    if (prod.category.toLowerCase() === removedExact.toLowerCase()) {
      prod.category = fallbackCategory;
      updatedProducts.push(prod);
    }
  }
  saveDb(db);

  const rtdbUrl = db.settings.firebaseRtdbUrl || DEFAULT_RTDB_URL;
  await pushCategoriesToRtdb(rtdbUrl, db.categories);
  await Promise.all(updatedProducts.map((p) => pushProductToRtdb(rtdbUrl, p)));
  return { categories: db.categories, products: db.products };
}

