import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  buildAppSpecificUpiLinks,
  buildDynamicUpiDeepLink,
  decodePngDataUrl,
  formatUpiAmountParam,
  isAllowedUpiDeepLink,
  isSafeTransactionId,
  sanitizeMerchantCode,
  sanitizeUpiText,
  UPI_APP_PACKAGES,
  validateUpiPaymentAmount,
} from './upiPaymentLogic';
import {
  deriveTransactionStatusToken,
  generateUniqueUpiIds,
  verifyTransactionStatusToken,
  verifyWebhookSignature,
} from '../../server/upiPayments';

test('validateUpiPaymentAmount accepts valid INR amounts and rejects invalid bounds', () => {
  assert.deepEqual(validateUpiPaymentAmount(199), { valid: true, amount: 199 });
  assert.deepEqual(validateUpiPaymentAmount('49.556'), { valid: true, amount: 49.56 });
  assert.equal(validateUpiPaymentAmount(0).valid, false);
  assert.equal(validateUpiPaymentAmount(-15).valid, false);
  assert.equal(validateUpiPaymentAmount(0.5).valid, false);
  assert.equal(validateUpiPaymentAmount(100001).valid, false);
  assert.equal(validateUpiPaymentAmount('abc').valid, false);
});

test('isSafeTransactionId allows clean IDs and blocks path traversal or Firebase illegal chars', () => {
  assert.equal(isSafeTransactionId('TXN-M1A2B3-9F8E7D6C'), true);
  assert.equal(isSafeTransactionId('ORD_123456'), true);
  assert.equal(isSafeTransactionId('../admin'), false);
  assert.equal(isSafeTransactionId('TXN/123456'), false);
  assert.equal(isSafeTransactionId('TXN.123456'), false);
  assert.equal(isSafeTransactionId('short'), false);
});

test('buildDynamicUpiDeepLink produces safe 5-parameter upi://pay URI with literal @, %20 spaces, and NO tr/url/sign', () => {
  const uri = buildDynamicUpiDeepLink({
    merchantUpiId: 'paytm.s1ygjj7@pty',
    merchantName: 'PREM LAL CHOUDHRI',
    merchantCode: '5411',
    amount: 249.5,
    orderId: 'ORD-TEST-01',
    transactionId: 'TXN-TEST-99',
    note: 'Patanjali Biscuits🍪\n<script>',
  });

  assert.equal(
    uri,
    'upi://pay?pa=paytm.s1ygjj7@pty&pn=PREM%20LAL%20CHOUDHRI&am=249.50&cu=INR&tn=ORD-TEST-01',
  );
  assert.equal(uri.includes('+'), false, 'URI should not contain + encoded spaces');
  assert.equal(uri.includes('tr='), false, 'URI must NOT include tr parameter');
  assert.equal(uri.includes('url='), false, 'URI must NOT include url parameter');
  assert.equal(uri.includes('sign='), false, 'URI must NOT include sign parameter');
  assert.equal(uri.includes('mc='), false, 'URI must keep only safe standard 5 parameters');

  const parsed = new URL(uri);
  assert.equal(parsed.searchParams.get('pa'), 'paytm.s1ygjj7@pty');
  assert.equal(parsed.searchParams.get('pn'), 'PREM LAL CHOUDHRI');
  assert.equal(parsed.searchParams.get('am'), '249.50');
  assert.equal(parsed.searchParams.get('cu'), 'INR');
  assert.equal(parsed.searchParams.get('tn'), 'ORD-TEST-01');
  assert.equal(parsed.searchParams.get('tr'), null);
  assert.equal(parsed.searchParams.get('url'), null);
  assert.equal(parsed.searchParams.get('sign'), null);
  assert.equal(formatUpiAmountParam(10), '10.00');
  assert.equal(sanitizeUpiText('  Hello\t<b>World</b>🍪  ', 20), 'Hello b World /b');
  assert.equal(sanitizeMerchantCode('5411'), '5411');
  assert.equal(sanitizeMerchantCode('12'), '');
  assert.equal(sanitizeMerchantCode('abcd'), '');
});

test('decodePngDataUrl decodes valid base64 PNG data URLs and rejects invalid inputs', () => {
  const sample = 'data:image/png;base64,' + Buffer.from([137, 80, 78, 71]).toString('base64');
  const bytes = decodePngDataUrl(sample);
  assert.ok(bytes instanceof Uint8Array);
  assert.deepEqual(Array.from(bytes), [137, 80, 78, 71]);
  assert.equal(decodePngDataUrl('https://evil.example/qr.png'), null);
  assert.equal(UPI_APP_PACKAGES.phonepe.androidPackage, 'com.phonepe.app');
  assert.equal(UPI_APP_PACKAGES.gpay.androidPackage, 'com.google.android.apps.nbu.paisa.user');
  assert.equal(UPI_APP_PACKAGES.paytm.androidPackage, 'net.one97.paytm');
});

test('buildAppSpecificUpiLinks maps safe standard UPI query to PhonePe, Google Pay, Paytm, and Any UPI App', () => {
  const base = buildDynamicUpiDeepLink({
    merchantUpiId: 'paytm.s1ygjj7@pty',
    merchantName: 'PREM LAL CHOUDHRI',
    amount: 149,
    orderId: 'ORD-1001',
  });
  const links = buildAppSpecificUpiLinks(base);
  const expectedQuery = 'pa=paytm.s1ygjj7@pty&pn=PREM%20LAL%20CHOUDHRI&am=149.00&cu=INR&tn=ORD-1001';

  assert.equal(links.upi, `upi://pay?${expectedQuery}`);
  assert.equal(links.phonepe, `phonepe://pay?${expectedQuery}`);
  assert.equal(links.gpay, `tez://upi/pay?${expectedQuery}`);
  assert.equal(links.gpayIos, `gpay://upi/pay?${expectedQuery}`);
  assert.equal(links.paytm, `paytmmp://pay?${expectedQuery}`);
  assert.ok(links.androidIntent.startsWith(`intent://pay?${expectedQuery}`));
  assert.equal(links.phonepe.includes('tr='), false);
  assert.equal(links.gpay.includes('url='), false);
  assert.equal(links.paytm.includes('sign='), false);
  assert.equal(isAllowedUpiDeepLink(links.upi), true);
  assert.equal(isAllowedUpiDeepLink(links.phonepe), true);
  assert.equal(isAllowedUpiDeepLink(links.gpay), true);
  assert.equal(isAllowedUpiDeepLink(links.paytm), true);
  assert.equal(isAllowedUpiDeepLink('javascript:alert(1)'), false);
});

test('generateUniqueUpiIds generates unique ORD and TXN identifiers', () => {
  const first = generateUniqueUpiIds();
  const second = generateUniqueUpiIds();
  assert.ok(first.orderId.startsWith('ORD-'));
  assert.ok(first.transactionId.startsWith('TXN-'));
  assert.equal(isSafeTransactionId(first.transactionId), true);
  assert.notEqual(first.orderId, second.orderId);
  assert.notEqual(first.transactionId, second.transactionId);
});

test('verifyWebhookSignature validates HMAC-SHA256 signatures and secret headers securely', () => {
  const secret = 'test-webhook-signing-secret-123';
  const payload = JSON.stringify({ transactionId: 'TXN-ABC123', status: 'Paid', amount: 199 });
  const hmac = crypto.createHmac('sha256', secret).update(payload).digest('hex');

  assert.equal(verifyWebhookSignature(payload, hmac, undefined, secret), true);
  assert.equal(verifyWebhookSignature(payload, `sha256=${hmac}`, undefined, secret), true);
  assert.equal(verifyWebhookSignature(payload, undefined, secret, secret), true);
  assert.equal(verifyWebhookSignature(payload, 'deadbeef', undefined, secret), false);
  assert.equal(verifyWebhookSignature(payload, hmac, undefined, ''), false);
  assert.equal(verifyWebhookSignature(payload, undefined, 'wrong-secret', secret), false);
});

test('verifyTransactionStatusToken validates derived HMAC token even after serverless cold start', () => {
  const txnId = 'TXN-COLDSTART-9988';
  const token = deriveTransactionStatusToken(txnId);
  const recordWithoutLocalHash = {
    transactionId: txnId,
    orderId: 'ORD-COLDSTART-99',
    amount: 99,
    currency: 'INR' as const,
    merchantUpiId: 'paytm.s1ygjj7@pty',
    merchantName: 'PREM LAL CHOUDHRI',
    note: 'ORD-COLDSTART-99',
    upiUri:
      'upi://pay?pa=paytm.s1ygjj7@pty&pn=PREM%20LAL%20CHOUDHRI&am=99.00&cu=INR&tn=ORD-COLDSTART-99',
    status: 'Pending Verification' as const,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  assert.equal(verifyTransactionStatusToken(recordWithoutLocalHash, token), true);
  assert.equal(verifyTransactionStatusToken(recordWithoutLocalHash, 'forged-token'), false);
  assert.equal(verifyTransactionStatusToken(recordWithoutLocalHash, undefined), false);
});
