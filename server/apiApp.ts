import fs from 'node:fs';
import path from 'node:path';
import express, { type Express } from 'express';
import QRCode from 'qrcode';
import {
  buildAdminSessionCookie,
  buildClearAdminCookie,
  createAdminSessionToken,
  isAdminTriggerQuery,
  isRequestAdminAuthenticated,
  requireAdminMiddleware,
  shouldUseSecureCookie,
  verifyAdminPasscode,
} from './adminAuth.js';
import { getRtdbSyncState } from './firebaseRtdb.js';
import {
  addCategoryRecord,
  addProductRecord,
  createOrderRecord,
  deleteCategoryRecord,
  deleteOrderRecord,
  deleteProductRecord,
  ensureColdStartSync,
  getStoreSnapshot,
  renameCategoryRecord,
  syncWithRtdbOnBootOrRefresh,
  updateOrderStatusRecord,
  updateProductRecord,
  updateStoreSettingsRecord,
} from './storeDb.js';
import {
  buildUpiPaymentUri,
  normalizeDiscountPercent,
  validateCheckoutForm,
  validateProductForm,
  type OrderStatus,
} from '../src/utils/storeLogic.js';

export function createApiApp(): Express {
  const app = express();
  const isVercel = Boolean(process.env.VERCEL);
  const uploadsDir = isVercel
    ? path.join('/tmp', 'bantuu-store-uploads')
    : path.join(process.cwd(), 'uploads');

  if (!isVercel && !fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
  }

  if (!isVercel) {
    app.use('/uploads', express.static(uploadsDir));
    app.use('/src/assets', express.static(path.join(process.cwd(), 'src/assets')));
  }

  app.use(express.json({ limit: '6mb' }));

  // Admin auth trigger & session endpoints (no secrets shipped to client JS)
  app.post('/api/admin/trigger', (req, res) => {
    const query = typeof req.body?.query === 'string' ? req.body.query : '';
    res.json({ triggered: isAdminTriggerQuery(query) });
  });

  app.post('/api/admin/login', (req, res) => {
    const passcode = typeof req.body?.passcode === 'string' ? req.body.passcode : '';
    if (!verifyAdminPasscode(passcode)) {
      res.status(401).json({ error: 'Incorrect admin password. Please try again.' });
      return;
    }
    const token = createAdminSessionToken();
    res.setHeader('Set-Cookie', buildAdminSessionCookie(token, shouldUseSecureCookie(req)));
    res.json({ authenticated: true, token });
  });

  app.get('/api/admin/session', (req, res) => {
    res.json({ authenticated: isRequestAdminAuthenticated(req) });
  });

  app.post('/api/admin/logout', (req, res) => {
    res.setHeader('Set-Cookie', buildClearAdminCookie(shouldUseSecureCookie(req)));
    res.json({ ok: true });
  });

  app.get('/api/admin/settings', requireAdminMiddleware, async (_req, res) => {
    await ensureColdStartSync();
    const db = getStoreSnapshot();
    res.json({ settings: db.settings, rtdb: getRtdbSyncState() });
  });

  // Protected media upload endpoint (supports JSON base64 or raw binary for photos & videos)
  app.post(
    '/api/upload',
    requireAdminMiddleware,
    express.raw({ type: ['image/*', 'video/*', 'application/octet-stream'], limit: '50mb' }),
    (req, res) => {
      try {
        let rawBuffer: Buffer | null = null;
        let headerName = String(req.headers['x-file-name'] || 'media.bin');
        let contentType = String(req.headers['content-type'] || '').toLowerCase();

        if (Buffer.isBuffer(req.body) && req.body.length > 0) {
          rawBuffer = req.body;
        } else if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
          const payload = req.body as {
            fileName?: unknown;
            mimeType?: unknown;
            base64Data?: unknown;
          };
          if (typeof payload.fileName === 'string' && payload.fileName.trim()) {
            headerName = payload.fileName.trim();
          }
          if (typeof payload.mimeType === 'string' && payload.mimeType.trim()) {
            contentType = payload.mimeType.trim().toLowerCase();
          }
          if (typeof payload.base64Data === 'string' && payload.base64Data.trim()) {
            const stripped = payload.base64Data.replace(/^data:[^;]+;base64,/, '').trim();
            rawBuffer = Buffer.from(stripped, 'base64');
          }
        }

        if (!rawBuffer || rawBuffer.length === 0) {
          res.status(400).json({ error: 'Empty file payload.' });
          return;
        }

        const sanitizedName = headerName.replace(/[^a-zA-Z0-9._-]/g, '_');
        const ext = path.extname(sanitizedName).toLowerCase();

        const isVideo =
          contentType.startsWith('video/') ||
          ['.mp4', '.webm', '.mov', '.m4v', '.ogg'].includes(ext);
        const isImage =
          contentType.startsWith('image/') ||
          ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif'].includes(ext);

        if (!isVideo && !isImage) {
          res.status(400).json({ error: 'Only image and video files are supported.' });
          return;
        }

        if (isVercel) {
          if (rawBuffer.length > 4.2 * 1024 * 1024) {
            res.status(413).json({
              error: 'File too large for serverless upload (max 4MB). Compress file or paste a video/image URL.',
            });
            return;
          }
          const mime =
            contentType &&
            contentType !== 'application/octet-stream' &&
            contentType !== 'application/json'
              ? contentType.split(';')[0]
              : isVideo
                ? 'video/mp4'
                : 'image/jpeg';
          const dataUrl = `data:${mime};base64,${rawBuffer.toString('base64')}`;
          res.status(201).json({
            id: `media-${Date.now()}`,
            type: isVideo ? 'video' : 'image',
            url: dataUrl,
            name: headerName,
          });
          return;
        }

        if (!fs.existsSync(uploadsDir)) {
          fs.mkdirSync(uploadsDir, { recursive: true });
        }
        const finalExt = ext || (isVideo ? '.mp4' : '.jpg');
        const baseName = path.basename(sanitizedName, ext).slice(0, 40) || 'upload';
        const storedFilename = `${Date.now()}-${baseName}${finalExt}`;
        const targetPath = path.join(uploadsDir, storedFilename);

        fs.writeFileSync(targetPath, rawBuffer);

        res.status(201).json({
          id: `media-${Date.now()}`,
          type: isVideo ? 'video' : 'image',
          url: `/uploads/${storedFilename}`,
          name: headerName,
        });
      } catch (err) {
        console.error('Upload error:', err);
        res.status(500).json({ error: 'Failed to save uploaded media.' });
      }
    },
  );

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, rtdb: getRtdbSyncState() });
  });

  app.get('/api/store', async (_req, res) => {
    await syncWithRtdbOnBootOrRefresh().catch(() => undefined);
    const db = getStoreSnapshot();
    const { firebaseRtdbUrl: _omitRtdb, ...publicSettings } = db.settings;
    res.json({
      products: db.products,
      categories: db.categories,
      settings: publicSettings,
      rtdb: getRtdbSyncState(),
    });
  });

  app.get('/api/upi-qr/download', async (req, res) => {
    try {
      await ensureColdStartSync().catch(() => undefined);
      const db = getStoreSnapshot();
      const rawAmount = Number(req.query.amount);
      const dispositionType = req.query.inline === '1' ? 'inline' : 'attachment';
      if (Number.isFinite(rawAmount) && rawAmount > 0) {
        const amount = Math.round(rawAmount);
        const upiUri = buildUpiPaymentUri(
          db.settings.upiId,
          db.settings.merchantName,
          amount,
          `${db.settings.storeName} Order`,
        );
        const qrPng = await QRCode.toBuffer(upiUri, {
          type: 'png',
          width: 640,
          margin: 2,
          color: { dark: '#0F1D32', light: '#FFFFFF' },
          errorCorrectionLevel: 'M',
        });
        res.setHeader('Content-Type', 'image/png');
        res.setHeader(
          'Content-Disposition',
          `${dispositionType}; filename="bantuu-store-upi-qr-rs${amount}.png"`,
        );
        res.setHeader('Cache-Control', 'no-store');
        res.send(qrPng);
        return;
      }

      const qrUrl = (db.settings.upiQrUrl || '/assets/aistudio/47084_f56d5f0a.jpg').trim();

      if (qrUrl.startsWith('data:image/')) {
        const match = qrUrl.match(/^data:(image\/[a-zA-Z0-9+.-]+);base64,(.+)$/);
        if (match) {
          const mime = match[1];
          const ext = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';
          const buffer = Buffer.from(match[2], 'base64');
          res.setHeader('Content-Type', mime);
          res.setHeader(
            'Content-Disposition',
            `attachment; filename="bantuu-store-upi-qr.${ext}"`,
          );
          res.setHeader('Cache-Control', 'no-store');
          res.send(buffer);
          return;
        }
      }

      if (qrUrl.startsWith('/')) {
        const cleanRel = qrUrl.replace(/^\/+/, '');
        const candidates = [
          path.resolve(process.cwd(), 'public', cleanRel),
          path.resolve(process.cwd(), 'dist', cleanRel),
          path.resolve(uploadsDir, path.basename(cleanRel)),
        ];
        const allowedRoots = [
          path.resolve(process.cwd(), 'public'),
          path.resolve(process.cwd(), 'dist'),
          path.resolve(uploadsDir),
        ];

        for (const candidate of candidates) {
          const isInsideAllowed = allowedRoots.some((root) =>
            candidate.startsWith(root + path.sep),
          );
          if (isInsideAllowed && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
            const ext = path.extname(candidate).toLowerCase();
            const mime =
              ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
            const outExt = ext === '.png' ? 'png' : ext === '.webp' ? 'webp' : 'jpg';
            res.setHeader('Content-Type', mime);
            res.setHeader(
              'Content-Disposition',
              `attachment; filename="bantuu-store-upi-qr.${outExt}"`,
            );
            res.setHeader('Cache-Control', 'no-store');
            res.send(fs.readFileSync(candidate));
            return;
          }
        }

        const host = req.get('host');
        if (host) {
          const proto = (req.get('x-forwarded-proto') || req.protocol || 'https').split(',')[0].trim();
          const originRes = await fetch(`${proto}://${host}${qrUrl}`);
          if (originRes.ok) {
            const mime = originRes.headers.get('content-type') || 'image/jpeg';
            const arrayBuf = await originRes.arrayBuffer();
            res.setHeader('Content-Type', mime);
            res.setHeader(
              'Content-Disposition',
              'attachment; filename="bantuu-store-upi-qr.jpg"',
            );
            res.setHeader('Cache-Control', 'no-store');
            res.send(Buffer.from(arrayBuf));
            return;
          }
        }
      }

      if (/^https?:\/\//i.test(qrUrl)) {
        const upstream = await fetch(qrUrl);
        if (upstream.ok) {
          const mime = upstream.headers.get('content-type') || 'image/jpeg';
          const arrayBuf = await upstream.arrayBuffer();
          res.setHeader('Content-Type', mime);
          res.setHeader(
            'Content-Disposition',
            'attachment; filename="bantuu-store-upi-qr.jpg"',
          );
          res.setHeader('Cache-Control', 'no-store');
          res.send(Buffer.from(arrayBuf));
          return;
        }
      }

      res.status(404).json({ error: 'QR image not found.' });
    } catch {
      res.status(500).json({ error: 'Could not prepare QR download.' });
    }
  });

  app.get('/api/upi-qr/share', async (req, res) => {
    try {
      await ensureColdStartSync().catch(() => undefined);
      const db = getStoreSnapshot();
      const rawAmount = Number(req.query.amount);
      const amount = Number.isFinite(rawAmount) && rawAmount > 0 ? Math.round(rawAmount) : 0;
      const esc = (str: string) =>
        str
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;');

      const safeStore = esc(db.settings.storeName || 'Bantuu Store');
      const safeUpiId = esc(db.settings.upiId || 'skiend@axl');
      const amountQuery = amount > 0 ? `amount=${amount}` : '';
      const imgSrc = `/api/upi-qr/download?${amountQuery ? `${amountQuery}&` : ''}inline=1`;
      const dlSrc = `/api/upi-qr/download${amountQuery ? `?${amountQuery}` : ''}`;
      const fileName = amount > 0 ? `bantuu-store-upi-qr-rs${amount}.png` : 'bantuu-store-upi-qr.png';
      const amountBadge = amount > 0 ? `₹${amount}` : 'UPI Payment';

      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${safeStore} — Share UPI QR</title>
  <style>
    body{margin:0;padding:20px;font-family:system-ui,-apple-system,sans-serif;background:#F7F5EE;color:#0F1D32;display:flex;justify-content:center;align-items:center;min-height:100vh;box-sizing:border-box}
    .card{width:100%;max-width:380px;background:#fff;border:1px solid #DED8C8;border-radius:16px;padding:20px;text-align:center;box-shadow:0 12px 30px rgba(15,29,50,.08)}
    .eyebrow{font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#8A6D32;margin:0}
    h1{font-size:19px;margin:6px 0 4px}
    .amt{display:inline-block;margin:8px 0 12px;padding:4px 12px;border-radius:8px;background:#0F1D32;color:#C6A45C;font-weight:700;font-family:ui-monospace,monospace;font-size:14px}
    .qr-wrap{background:#fff;border:1px solid #DED8C8;border-radius:12px;padding:10px;display:inline-block}
    .qr-wrap img{width:230px;height:230px;display:block;object-fit:contain}
    .upi{font-family:ui-monospace,monospace;font-size:13px;background:#F7F5EE;border:1px solid #DED8C8;border-radius:8px;padding:8px 12px;margin:12px 0;font-weight:600}
    .btn{display:block;width:100%;box-sizing:border-box;padding:12px 16px;border-radius:10px;border:0;font-size:14px;font-weight:700;cursor:pointer;text-decoration:none;margin-top:10px}
    .btn-primary{background:#0F1D32;color:#F7F5EE}
    .btn-gold{background:#C6A45C;color:#0F1D32}
    .btn-light{background:#F7F5EE;color:#0F1D32;border:1px solid #DED8C8}
    .note{font-size:12px;color:#5C5852;line-height:1.45;margin:12px 0 0}
  </style>
</head>
<body>
  <div class="card">
    <p class="eyebrow">${safeStore} · UPI Checkout</p>
    <h1>Share or Save QR Code</h1>
    <div class="amt">${amountBadge}</div>
    <div>
      <div class="qr-wrap">
        <img id="qrImg" src="${imgSrc}" alt="UPI QR Code" />
      </div>
    </div>
    <div class="upi">UPI ID: ${safeUpiId}</div>
    <button id="shareBtn" type="button" class="btn btn-primary">Share QR to UPI App</button>
    <a href="${dlSrc}" download="${fileName}" class="btn btn-gold">Save QR to Gallery</a>
    <button id="copyBtn" type="button" class="btn btn-light">Copy UPI ID</button>
    <button id="backBtn" type="button" class="btn btn-light">← Back to Checkout</button>
    <p id="statusMsg" class="note">Tap Share QR to send this QR image directly to PhonePe, Google Pay, or Paytm, then enter your UTR in Bantuu Store.</p>
  </div>
  <script>
    const imgUrl = ${JSON.stringify(imgSrc)};
    const dlFileName = ${JSON.stringify(fileName)};
    const upiId = ${JSON.stringify(db.settings.upiId || 'skiend@axl')};
    const storeName = ${JSON.stringify(db.settings.storeName || 'Bantuu Store')};
    const amountText = ${JSON.stringify(amount > 0 ? `Pay ₹${amount} to ${db.settings.upiId || 'skiend@axl'}` : `Pay via UPI to ${db.settings.upiId || 'skiend@axl'}`)};
    const statusEl = document.getElementById('statusMsg');

    async function shareQrNow() {
      try {
        const res = await fetch(imgUrl);
        const blob = await res.blob();
        const file = new File([blob], dlFileName, { type: blob.type || 'image/png' });
        if (navigator.share && (!navigator.canShare || navigator.canShare({ files: [file] }))) {
          await navigator.share({ title: storeName + ' UPI QR', text: amountText, files: [file] });
          statusEl.textContent = 'QR shared! Complete payment in your UPI app and return to enter UTR.';
          return;
        }
        if (navigator.share) {
          await navigator.share({ title: storeName + ' UPI QR', text: amountText, url: window.location.href });
          return;
        }
        statusEl.textContent = 'Long-press the QR image or take a screenshot, then upload it in PhonePe / GPay / Paytm (Scan from Gallery).';
      } catch (e) {
        if (e && e.name === 'AbortError') return;
        statusEl.textContent = 'Take a screenshot of this QR code, then open PhonePe / GPay and upload from Gallery.';
      }
    }

    document.getElementById('shareBtn').addEventListener('click', shareQrNow);
    document.getElementById('copyBtn').addEventListener('click', async function() {
      try {
        await navigator.clipboard.writeText(upiId);
        this.textContent = 'Copied: ' + upiId;
      } catch (_) {}
    });
    document.getElementById('backBtn').addEventListener('click', function() {
      if (window.history.length > 1) {
        window.history.back();
      } else {
        window.location.href = '/';
      }
    });
  </script>
</body>
</html>`);
    } catch {
      res.status(500).send('Could not load UPI QR share view.');
    }
  });

  app.get('/api/products', async (_req, res) => {
    await syncWithRtdbOnBootOrRefresh().catch(() => undefined);
    const db = getStoreSnapshot();
    res.json({ products: db.products, rtdb: getRtdbSyncState() });
  });

  app.post('/api/products', requireAdminMiddleware, async (req, res) => {
    const body = req.body || {};
    const errors = validateProductForm({
      name: body.name,
      category: body.category,
      price: body.price,
      stock: body.stock,
      description: body.description,
      media: body.media,
      discountPercent: body.discountPercent,
    });
    if (Object.keys(errors).length > 0) {
      res.status(400).json({ error: 'Validation failed', errors });
      return;
    }

    const product = await addProductRecord({
      name: String(body.name),
      category: String(body.category),
      price: Number(body.price),
      stock: Number(body.stock),
      description: String(body.description),
      media: body.media,
      featured: Boolean(body.featured),
      pinned: Boolean(body.pinned),
      discountPercent: normalizeDiscountPercent(body.discountPercent),
    });

    res.status(201).json({ product, rtdb: getRtdbSyncState() });
  });

  app.patch('/api/products/:id', requireAdminMiddleware, async (req, res) => {
    await ensureColdStartSync().catch(() => undefined);
    const productId = String(req.params.id);
    const existing = getStoreSnapshot().products.find((p) => p.id === productId);
    if (!existing) {
      res.status(404).json({ error: 'Product not found.' });
      return;
    }

    const body = req.body || {};
    const merged = {
      name: body.name !== undefined ? String(body.name) : existing.name,
      category: body.category !== undefined ? String(body.category) : existing.category,
      price: body.price !== undefined ? Number(body.price) : existing.price,
      stock: body.stock !== undefined ? Number(body.stock) : existing.stock,
      description: body.description !== undefined ? String(body.description) : existing.description,
      media: Array.isArray(body.media) ? body.media : existing.media,
      discountPercent:
        body.discountPercent !== undefined
          ? body.discountPercent
          : existing.discountPercent ?? 0,
    };

    const errors = validateProductForm(merged);
    if (Object.keys(errors).length > 0) {
      res.status(400).json({ error: 'Validation failed', errors });
      return;
    }

    const updated = await updateProductRecord(productId, {
      name: body.name !== undefined ? String(body.name) : undefined,
      category: body.category !== undefined ? String(body.category) : undefined,
      price: body.price !== undefined ? Number(body.price) : undefined,
      stock: body.stock !== undefined ? Number(body.stock) : undefined,
      description: body.description !== undefined ? String(body.description) : undefined,
      media: Array.isArray(body.media) ? body.media : undefined,
      featured: body.featured !== undefined ? Boolean(body.featured) : undefined,
      pinned: body.pinned !== undefined ? Boolean(body.pinned) : undefined,
      discountPercent:
        body.discountPercent !== undefined
          ? normalizeDiscountPercent(body.discountPercent)
          : undefined,
    });

    if (!updated) {
      res.status(404).json({ error: 'Product not found.' });
      return;
    }

    res.json({ product: updated, rtdb: getRtdbSyncState() });
  });

  app.delete('/api/products/:id', requireAdminMiddleware, async (req, res) => {
    const deleted = await deleteProductRecord(String(req.params.id));
    if (!deleted) {
      res.status(404).json({ error: 'Product not found.' });
      return;
    }
    res.json({ deleted: true, id: req.params.id, rtdb: getRtdbSyncState() });
  });

  app.get('/api/orders', async (req, res) => {
    await syncWithRtdbOnBootOrRefresh().catch(() => undefined);
    const db = getStoreSnapshot();
    const orderNumbersRaw = String(req.query.orderNumbers || '').trim();
    if (orderNumbersRaw) {
      const requested = new Set(
        orderNumbersRaw
          .split(',')
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean),
      );
      const matched = db.orders.filter((o) => requested.has(o.orderNumber.toLowerCase()));
      res.json({ orders: matched, rtdb: getRtdbSyncState() });
      return;
    }
    const lookup = String(req.query.lookup || '').trim().toLowerCase();
    if (lookup) {
      const digitsLookup = lookup.replace(/\D/g, '');
      const matched = db.orders.filter(
        (o) =>
          o.orderNumber.toLowerCase() === lookup ||
          (digitsLookup.length >= 10 && o.customerPhone.replace(/\D/g, '') === digitsLookup),
      );
      res.json({ orders: matched, rtdb: getRtdbSyncState() });
      return;
    }

    if (!isRequestAdminAuthenticated(req)) {
      res.status(401).json({
        error: 'Admin authentication required to view full customer order records.',
      });
      return;
    }

    res.json({ orders: db.orders, rtdb: getRtdbSyncState() });
  });

  app.post('/api/orders', async (req, res) => {
    const body = req.body || {};
    const errors = validateCheckoutForm({
      customerName: body.customerName || '',
      customerPhone: body.customerPhone || '',
      address: body.address || '',
      city: body.city || '',
      pincode: body.pincode || '',
      paymentMethod: body.paymentMethod === 'UPI' ? 'UPI' : 'COD',
      upiCustomerId: body.upiCustomerId || '',
      upiTransactionId: body.upiTransactionId || '',
    });

    if (Object.keys(errors).length > 0) {
      res.status(400).json({ error: 'Please fix the highlighted checkout fields.', errors });
      return;
    }

    // Never trust client-supplied prices or totals; only read productId + quantity
    const requestedItems = Array.isArray(body.items)
      ? body.items.map((item: { productId?: unknown; quantity?: unknown }) => ({
          productId: typeof item?.productId === 'string' ? item.productId : '',
          quantity: Number(item?.quantity),
        }))
      : [];

    const result = await createOrderRecord({
      customerName: String(body.customerName),
      customerPhone: String(body.customerPhone),
      address: String(body.address),
      city: String(body.city),
      pincode: String(body.pincode),
      paymentMethod: body.paymentMethod === 'UPI' ? 'UPI' : 'COD',
      upiCustomerId: body.upiCustomerId ? String(body.upiCustomerId) : undefined,
      upiTransactionId: body.upiTransactionId ? String(body.upiTransactionId) : undefined,
      items: requestedItems,
    });

    if (result.error || !result.order) {
      res.status(400).json({ error: result.error || 'Could not place order.' });
      return;
    }

    res.status(201).json({ order: result.order, rtdb: getRtdbSyncState() });
  });

  app.patch('/api/orders/:id/status', requireAdminMiddleware, async (req, res) => {
    const allowed: OrderStatus[] = ['Pending', 'Confirmed', 'Shipped', 'Delivered', 'Cancelled'];
    const status = req.body?.status as OrderStatus;
    if (!allowed.includes(status)) {
      res.status(400).json({ error: 'Invalid order status.' });
      return;
    }
    const updated = await updateOrderStatusRecord(String(req.params.id), status);
    if (!updated) {
      res.status(404).json({ error: 'Order not found.' });
      return;
    }
    res.json({ order: updated, rtdb: getRtdbSyncState() });
  });

  app.delete('/api/orders/:id', requireAdminMiddleware, async (req, res) => {
    const deleted = await deleteOrderRecord(String(req.params.id));
    if (!deleted) {
      res.status(404).json({ error: 'Order not found.' });
      return;
    }
    res.json({ deleted: true, id: req.params.id, rtdb: getRtdbSyncState() });
  });

  app.patch('/api/settings', requireAdminMiddleware, async (req, res) => {
    const updated = await updateStoreSettingsRecord(req.body || {});
    res.json({ settings: updated, rtdb: getRtdbSyncState() });
  });

  app.get('/api/categories', async (_req, res) => {
    await syncWithRtdbOnBootOrRefresh().catch(() => undefined);
    const db = getStoreSnapshot();
    res.json({ categories: db.categories, rtdb: getRtdbSyncState() });
  });

  app.post('/api/categories', requireAdminMiddleware, async (req, res) => {
    const name = String(req.body?.name || '');
    const result = await addCategoryRecord(name);
    if (result.error) {
      res.status(400).json({ error: result.error, categories: result.categories });
      return;
    }
    res.status(201).json({
      categories: result.categories,
      category: result.category,
      rtdb: getRtdbSyncState(),
    });
  });

  app.patch('/api/categories', requireAdminMiddleware, async (req, res) => {
    const oldName = String(req.body?.oldName || '');
    const newName = String(req.body?.newName || '');
    const result = await renameCategoryRecord(oldName, newName);
    if (result.error) {
      res.status(400).json({ error: result.error, categories: result.categories });
      return;
    }
    res.json({
      categories: result.categories,
      products: result.products,
      newName: result.newName,
      rtdb: getRtdbSyncState(),
    });
  });

  app.delete('/api/categories', requireAdminMiddleware, async (req, res) => {
    const name = String(req.body?.name || req.query.name || '');
    const result = await deleteCategoryRecord(name);
    if (result.error) {
      res.status(400).json({ error: result.error, categories: result.categories });
      return;
    }
    res.json({
      categories: result.categories,
      products: result.products,
      rtdb: getRtdbSyncState(),
    });
  });

  return app;
}
