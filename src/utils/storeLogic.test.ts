import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPhonePePaymentUri,
  buildUpiPaymentUri,
  calculateCartTotals,
  filterOrders,
  filterProducts,
  formatINR,
  formatOrderDateTime,
  inferMediaTypeFromUrl,
  normalizeCategoryName,
  normalizeFirebaseRtdbUrl,
  normalizeRtdbMap,
  sanitizeCartWithCatalog,
  validateCategoryName,
  validateCheckoutForm,
  validateProductForm,
  type CartItem,
  type Order,
  type Product,
} from './storeLogic';
import {
  createAdminSessionToken,
  isAdminTriggerQuery,
  verifyAdminPasscode,
  verifyAdminSessionToken,
} from '../../server/adminAuth.js';

test('formatINR formats Indian currency cleanly', () => {
  assert.equal(formatINR(1499), '₹1,499');
  assert.equal(formatINR(0), '₹0');
});

test('formatOrderDateTime returns structured date and time', () => {
  const res = formatOrderDateTime('2026-11-15T12:30:00.000Z', 'Asia/Kolkata');
  assert.equal(res.date, '15 Nov 2026');
  assert.ok(res.time.includes('06:00'));
  assert.ok(res.full.includes('15 Nov 2026'));
});

test('calculateCartTotals applies free shipping threshold accurately', () => {
  const below = calculateCartTotals([{ price: 500, quantity: 1 }], 999, 79);
  assert.equal(below.subtotal, 500);
  assert.equal(below.shippingFee, 79);
  assert.equal(below.total, 579);
  assert.equal(below.amountToFreeShipping, 499);

  const above = calculateCartTotals([{ price: 600, quantity: 2 }], 999, 79);
  assert.equal(above.subtotal, 1200);
  assert.equal(above.shippingFee, 0);
  assert.equal(above.total, 1200);
  assert.equal(above.amountToFreeShipping, 0);
});

test('validateCheckoutForm enforces COD and UPI validation rules', () => {
  const invalidCod = validateCheckoutForm({
    customerName: 'A',
    customerPhone: '123',
    address: 'No',
    city: '',
    pincode: '12',
    paymentMethod: 'COD',
  });
  assert.ok(invalidCod.customerName);
  assert.ok(invalidCod.customerPhone);
  assert.ok(invalidCod.address);
  assert.ok(invalidCod.city);
  assert.ok(invalidCod.pincode);
  assert.equal(invalidCod.upiTransactionId, undefined);

  const validCod = validateCheckoutForm({
    customerName: 'Rahul Verma',
    customerPhone: '9876543210',
    address: '42 MG Road, Indiranagar',
    city: 'Bengaluru',
    pincode: '560038',
    paymentMethod: 'COD',
  });
  assert.deepEqual(validCod, {});

  const invalidUpi = validateCheckoutForm({
    customerName: 'Rahul Verma',
    customerPhone: '9876543210',
    address: '42 MG Road, Indiranagar',
    city: 'Bengaluru',
    pincode: '560038',
    paymentMethod: 'UPI',
    upiTransactionId: '123',
  });
  assert.ok(invalidUpi.upiTransactionId);

  const validUpi = validateCheckoutForm({
    customerName: 'Rahul Verma',
    customerPhone: '9876543210',
    address: '42 MG Road, Indiranagar',
    city: 'Bengaluru',
    pincode: '560038',
    paymentMethod: 'UPI',
    upiTransactionId: 'UTR4092817263',
  });
  assert.deepEqual(validUpi, {});
});

test('validateProductForm requires name, price, stock, description, and media', () => {
  const invalid = validateProductForm({
    name: '',
    category: '',
    price: 0,
    stock: -1,
    description: 'short',
    media: [],
  });
  assert.ok(invalid.name);
  assert.ok(invalid.category);
  assert.ok(invalid.price);
  assert.ok(invalid.stock);
  assert.ok(invalid.description);
  assert.ok(invalid.media);

  const valid = validateProductForm({
    name: 'Ceramic Kettle',
    category: 'Home & Living',
    price: 2499,
    stock: 15,
    description: 'Matte stoneware gooseneck pour-over kettle with walnut handle.',
    media: [{ id: 'm1', type: 'image', url: '/uploads/kettle.jpg' }],
  });
  assert.deepEqual(valid, {});
});

test('buildUpiPaymentUri builds standard UPI deeplink and PhonePe deeplink', () => {
  const uri = buildUpiPaymentUri('bantustore@upi', 'Bantu Store', 1899, 'Order BNT-1005');
  assert.ok(uri.startsWith('upi://pay?'));
  assert.ok(uri.includes('pa=bantustore%40upi'));
  assert.ok(uri.includes('am=1899'));
  assert.ok(uri.includes('cu=INR'));

  const phonePeUri = buildPhonePePaymentUri('skiend@axl', 'Bantuu Store Retail', 2499, 'Bantuu Store Order');
  assert.ok(phonePeUri.startsWith('phonepe://pay?'));
  assert.ok(phonePeUri.includes('pa=skiend%40axl'));
  assert.ok(phonePeUri.includes('am=2499'));
  assert.ok(phonePeUri.includes('cu=INR'));
});

test('filterProducts and filterOrders match category, status, payment, and search query', () => {
  const products: Product[] = [
    {
      id: '1',
      name: 'Brass Watch',
      category: 'Watches',
      price: 4999,
      stock: 5,
      description: 'Brushed steel wristwatch.',
      media: [{ id: 'm1', type: 'image', url: '/img1.jpg' }],
      createdAt: '2026-11-15T10:00:00.000Z',
    },
    {
      id: '2',
      name: 'Leather Tote',
      category: 'Carry',
      price: 3499,
      stock: 8,
      description: 'Full-grain cognac leather bag.',
      media: [{ id: 'm2', type: 'image', url: '/img2.jpg' }],
      createdAt: '2026-11-15T10:00:00.000Z',
    },
  ];
  assert.equal(filterProducts(products, 'Watches', '').length, 1);
  assert.equal(filterProducts(products, 'All', 'cognac').length, 1);

  const orders: Order[] = [
    {
      id: 'o1',
      orderNumber: 'BNT-1001',
      customerName: 'Ananya Sharma',
      customerPhone: '9988776655',
      address: '12 Park Street',
      city: 'Kolkata',
      pincode: '700016',
      items: [],
      subtotal: 4999,
      shippingFee: 0,
      total: 4999,
      paymentMethod: 'UPI',
      upiTransactionId: 'UTR99881122',
      status: 'Confirmed',
      createdAt: '2026-11-15T12:00:00.000Z',
    },
  ];
  assert.equal(filterOrders(orders, 'Confirmed', 'UPI', 'ananya').length, 1);
  assert.equal(filterOrders(orders, 'Pending', 'All', '').length, 0);
});

test('inferMediaTypeFromUrl identifies video vs image extensions', () => {
  assert.equal(inferMediaTypeFromUrl('/uploads/demo.mp4'), 'video');
  assert.equal(inferMediaTypeFromUrl('https://example.com/clip.webm?v=1'), 'video');
  assert.equal(inferMediaTypeFromUrl('/uploads/photo.jpg'), 'image');
});

test('normalizeFirebaseRtdbUrl cleans trailing slashes and .json suffix', () => {
  assert.equal(
    normalizeFirebaseRtdbUrl('https://bantuu-store-default-rtdb.firebaseio.com/'),
    'https://bantuu-store-default-rtdb.firebaseio.com',
  );
  assert.equal(
    normalizeFirebaseRtdbUrl('https://bantuu-store-default-rtdb.firebaseio.com/.json'),
    'https://bantuu-store-default-rtdb.firebaseio.com',
  );
  assert.equal(normalizeFirebaseRtdbUrl('not-a-url'), '');
});

test('normalizeRtdbMap converts Firebase RTDB object maps into sorted arrays', () => {
  const mapped = normalizeRtdbMap<{ id?: string; name: string; createdAt?: string }>({
    k1: { name: 'Older', createdAt: '2026-11-14T10:00:00.000Z' },
    k2: { id: 'custom-2', name: 'Newer', createdAt: '2026-11-15T10:00:00.000Z' },
  });
  assert.equal(mapped.length, 2);
  assert.equal(mapped[0].id, 'custom-2');
  assert.equal(mapped[1].id, 'k1');
});

test('server adminAuth verifies trigger, passcode, and signed session tokens', () => {
  assert.equal(isAdminTriggerQuery('bantuustore'), true);
  assert.equal(isAdminTriggerQuery('  BantuuStore '), true);
  assert.equal(isAdminTriggerQuery('leather tote'), false);
  assert.equal(isAdminTriggerQuery(''), false);

  assert.equal(verifyAdminPasscode('12348765'), true);
  assert.equal(verifyAdminPasscode('1234'), false);
  assert.equal(verifyAdminPasscode(''), false);

  const token = createAdminSessionToken(60_000);
  assert.equal(verifyAdminSessionToken(token), true);
  assert.equal(verifyAdminSessionToken(`${token}tampered`), false);
  assert.equal(verifyAdminSessionToken(''), false);
  assert.equal(verifyAdminSessionToken(createAdminSessionToken(-1000)), false);
});

test('sanitizeCartWithCatalog resets tampered prices and caps stock quantities', () => {
  const catalog: Product[] = [
    {
      id: 'p1',
      name: 'Brass Watch',
      category: 'Watches',
      price: 5499,
      stock: 3,
      description: 'Brushed steel wristwatch.',
      media: [{ id: 'm1', type: 'image', url: '/watch.jpg' }],
      createdAt: '2026-11-15T10:00:00.000Z',
    },
    {
      id: 'p2',
      name: 'Sold Out Scarf',
      category: 'Apparel',
      price: 999,
      stock: 0,
      description: 'Out of stock scarf.',
      media: [{ id: 'm2', type: 'image', url: '/scarf.jpg' }],
      createdAt: '2026-11-15T10:00:00.000Z',
    },
  ];
  const tamperedCart: CartItem[] = [
    {
      productId: 'p1',
      name: 'Tampered Watch',
      price: 1,
      quantity: 10,
      imageUrl: '/fake.jpg',
      category: 'Fake',
    },
    {
      productId: 'p2',
      name: 'Sold Out Scarf',
      price: 1,
      quantity: 1,
      imageUrl: '/scarf.jpg',
      category: 'Apparel',
    },
    {
      productId: 'non-existent',
      name: 'Ghost',
      price: 5,
      quantity: 2,
      imageUrl: '/ghost.jpg',
      category: 'Apparel',
    },
  ];

  const clean = sanitizeCartWithCatalog(tamperedCart, catalog);
  assert.equal(clean.length, 1);
  assert.equal(clean[0].price, 5499);
  assert.equal(clean[0].quantity, 3);
  assert.equal(clean[0].name, 'Brass Watch');
  assert.equal(clean[0].imageUrl, '/watch.jpg');
});

test('validateCategoryName enforces uniqueness, length, and reserved All check', () => {
  assert.equal(normalizeCategoryName('  Home   &  Living '), 'Home & Living');
  assert.ok(validateCategoryName('A', ['Apparel']));
  assert.ok(validateCategoryName('All', ['Apparel']));
  assert.ok(validateCategoryName('apparel', ['Apparel', 'Audio']));
  assert.equal(validateCategoryName('Apparel', ['Apparel', 'Audio'], 'Apparel'), null);
  assert.equal(validateCategoryName('Footwear', ['Apparel', 'Audio']), null);
});

