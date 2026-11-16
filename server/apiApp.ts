import fs from 'node:fs';
import path from 'node:path';
import express, { type Express } from 'express';
import {
  addCategoryRecord,
  addProductRecord,
  createOrderRecord,
  deleteCategoryRecord,
  deleteProductRecord,
  getStoreSnapshot,
  renameCategoryRecord,
  syncWithRtdbOnBootOrRefresh,
  updateOrderStatusRecord,
  updateStoreSettingsRecord,
} from './storeDb';
import { getRtdbSyncState } from './firebaseRtdb';
import {
  validateCheckoutForm,
  validateProductForm,
  type OrderStatus,
} from '../src/utils/storeLogic';

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

  // Raw media upload endpoint (supports photos and videos)
  app.post(
    '/api/upload',
    express.raw({ type: ['image/*', 'video/*', 'application/octet-stream'], limit: '50mb' }),
    (req, res) => {
      try {
        const rawBody = req.body;
        if (!Buffer.isBuffer(rawBody) || rawBody.length === 0) {
          res.status(400).json({ error: 'Empty file payload.' });
          return;
        }

        const headerName = String(req.headers['x-file-name'] || 'media.bin');
        const contentType = String(req.headers['content-type'] || '').toLowerCase();
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
          const mime =
            contentType && contentType !== 'application/octet-stream'
              ? contentType
              : isVideo
                ? 'video/mp4'
                : 'image/jpeg';
          const dataUrl = `data:${mime};base64,${rawBody.toString('base64')}`;
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

        fs.writeFileSync(targetPath, rawBody);

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

  app.use(express.json({ limit: '5mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, rtdb: getRtdbSyncState() });
  });

  app.get('/api/store', async (_req, res) => {
    await syncWithRtdbOnBootOrRefresh().catch(() => undefined);
    const db = getStoreSnapshot();
    res.json({
      products: db.products,
      categories: db.categories,
      settings: db.settings,
      rtdb: getRtdbSyncState(),
    });
  });

  app.get('/api/products', async (_req, res) => {
    await syncWithRtdbOnBootOrRefresh().catch(() => undefined);
    const db = getStoreSnapshot();
    res.json({ products: db.products, rtdb: getRtdbSyncState() });
  });

  app.post('/api/products', async (req, res) => {
    const body = req.body || {};
    const errors = validateProductForm({
      name: body.name,
      category: body.category,
      price: body.price,
      stock: body.stock,
      description: body.description,
      media: body.media,
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
    });

    res.status(201).json({ product, rtdb: getRtdbSyncState() });
  });

  app.delete('/api/products/:id', async (req, res) => {
    const deleted = await deleteProductRecord(req.params.id);
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
      const matched = db.orders.filter(
        (o) =>
          o.orderNumber.toLowerCase() === lookup ||
          o.customerPhone.replace(/\D/g, '') === lookup.replace(/\D/g, ''),
      );
      res.json({ orders: matched, rtdb: getRtdbSyncState() });
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

    const result = await createOrderRecord({
      customerName: String(body.customerName),
      customerPhone: String(body.customerPhone),
      address: String(body.address),
      city: String(body.city),
      pincode: String(body.pincode),
      paymentMethod: body.paymentMethod === 'UPI' ? 'UPI' : 'COD',
      upiCustomerId: body.upiCustomerId ? String(body.upiCustomerId) : undefined,
      upiTransactionId: body.upiTransactionId ? String(body.upiTransactionId) : undefined,
      items: Array.isArray(body.items) ? body.items : [],
    });

    if (result.error || !result.order) {
      res.status(400).json({ error: result.error || 'Could not place order.' });
      return;
    }

    res.status(201).json({ order: result.order, rtdb: getRtdbSyncState() });
  });

  app.patch('/api/orders/:id/status', async (req, res) => {
    const allowed: OrderStatus[] = ['Pending', 'Confirmed', 'Shipped', 'Delivered', 'Cancelled'];
    const status = req.body?.status as OrderStatus;
    if (!allowed.includes(status)) {
      res.status(400).json({ error: 'Invalid order status.' });
      return;
    }
    const updated = await updateOrderStatusRecord(req.params.id, status);
    if (!updated) {
      res.status(404).json({ error: 'Order not found.' });
      return;
    }
    res.json({ order: updated, rtdb: getRtdbSyncState() });
  });

  app.patch('/api/settings', async (req, res) => {
    const updated = await updateStoreSettingsRecord(req.body || {});
    res.json({ settings: updated, rtdb: getRtdbSyncState() });
  });

  app.get('/api/categories', async (_req, res) => {
    await syncWithRtdbOnBootOrRefresh().catch(() => undefined);
    const db = getStoreSnapshot();
    res.json({ categories: db.categories, rtdb: getRtdbSyncState() });
  });

  app.post('/api/categories', async (req, res) => {
    const name = String(req.body?.name || '');
    const result = await addCategoryRecord(name);
    if (result.error) {
      res.status(400).json({ error: result.error, categories: result.categories });
      return;
    }
    res.status(201).json({ categories: result.categories, rtdb: getRtdbSyncState() });
  });

  app.patch('/api/categories', async (req, res) => {
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
      rtdb: getRtdbSyncState(),
    });
  });

  app.delete('/api/categories', async (req, res) => {
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
