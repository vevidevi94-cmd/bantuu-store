import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import {
  ArrowLeft,
  Bell,
  BellOff,
  Check,
  ClipboardList,
  Database,
  Film,
  Image as ImageIcon,
  Layers,
  LogOut,
  Package,
  Pencil,
  Plus,
  Search,
  Settings,
  Trash2,
  Upload,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import {
  filterOrders,
  formatINR,
  formatOrderDateTime,
  inferMediaTypeFromUrl,
  normalizeFirebaseRtdbUrl,
  validateCategoryName,
  validateProductForm,
  type Order,
  type OrderStatus,
  type Product,
  type ProductMedia,
  type StoreSettings,
} from '../utils/storeLogic';
import { BantuuLogo } from './BantuuLogo';
import { MediaRenderer } from './MediaRenderer';
import { adminFetch } from '../utils/adminClientAuth';
import {
  getAlertPermissionState,
  isAlertSoundMuted,
  playIphoneOrderChime,
  registerNotificationServiceWorker,
  requestSystemNotificationPermission,
  setAlertSoundMuted,
  triggerOrderSystemNotification,
  unlockAlertAudio,
  type AlertPermissionState,
} from '../utils/adminAlerts';

export type AdminTab = 'orders' | 'products' | 'categories' | 'add-product' | 'settings';

interface RtdbStateInfo {
  connected: boolean;
  lastSyncedAt: string | null;
  lastError: string | null;
}

interface AdminPanelProps {
  products: Product[];
  categories: string[];
  settings: StoreSettings;
  activeTab: AdminTab;
  onTabChange: (tab: AdminTab) => void;
  selectedOrderId: string | null;
  onSelectedOrderIdChange: (orderId: string | null) => void;
  onBackToStorefront: () => void;
  onLogoutAdmin: () => void;
  onSessionExpired?: () => void;
  onProductsChanged: (products: Product[]) => void;
  onCategoriesChanged: (categories: string[], nextProducts?: Product[]) => void;
  onSettingsChanged: (settings: StoreSettings) => void;
}

const ORDER_STATUSES: OrderStatus[] = [
  'Pending',
  'Confirmed',
  'Shipped',
  'Delivered',
  'Cancelled',
];

async function parseApiJson<T = Record<string, unknown>>(
  res: Response,
): Promise<{ data: T | null; rawText: string }> {
  const rawText = await res.text();
  if (!rawText) return { data: null, rawText: '' };
  try {
    return { data: JSON.parse(rawText) as T, rawText };
  } catch {
    return { data: null, rawText };
  }
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const idx = result.indexOf(',');
      resolve(idx >= 0 ? result.slice(idx + 1) : result);
    };
    reader.onerror = () => reject(new Error('Could not read file data.'));
    reader.readAsDataURL(blob);
  });
}

async function prepareMediaPayload(file: File): Promise<{
  fileName: string;
  mimeType: string;
  base64Data: string;
}> {
  const isImage = file.type.startsWith('image/');
  const isVideo = file.type.startsWith('video/');

  if (isImage && file.type !== 'image/gif' && typeof document !== 'undefined') {
    try {
      const objectUrl = URL.createObjectURL(file);
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error('Invalid image file'));
        image.src = objectUrl;
      });
      URL.revokeObjectURL(objectUrl);

      const maxDim = 1280;
      const scale = Math.min(1, maxDim / Math.max(img.width || 1, img.height || 1));
      const width = Math.max(1, Math.round((img.width || maxDim) * scale));
      const height = Math.max(1, Math.round((img.height || maxDim) * scale));

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(img, 0, 0, width, height);
        const compressedBlob = await new Promise<Blob | null>((resolve) =>
          canvas.toBlob((blob) => resolve(blob), 'image/jpeg', 0.82),
        );
        if (compressedBlob && compressedBlob.size > 0) {
          const base64Data = await blobToBase64(compressedBlob);
          const cleanName = file.name.replace(/\.[^.]+$/, '') || 'product-photo';
          return {
            fileName: `${cleanName}.jpg`,
            mimeType: 'image/jpeg',
            base64Data,
          };
        }
      }
    } catch {
      // Fallback to direct file encoding below
    }
  }

  if (isVideo && file.size > 3.5 * 1024 * 1024) {
    throw new Error(
      'Video exceeds 3.5MB upload limit. Upload a shorter clip or paste an MP4/WebM URL.',
    );
  }
  if (!isVideo && !isImage) {
    throw new Error('Only photo and video files are supported.');
  }
  if (file.size > 3.5 * 1024 * 1024) {
    throw new Error('File exceeds 3.5MB upload limit after compression.');
  }

  const base64Data = await blobToBase64(file);
  return {
    fileName: file.name,
    mimeType: file.type || (isVideo ? 'video/mp4' : 'image/jpeg'),
    base64Data,
  };
}

export function AdminPanel({
  products,
  categories,
  settings,
  activeTab,
  onTabChange,
  selectedOrderId,
  onSelectedOrderIdChange,
  onBackToStorefront,
  onLogoutAdmin,
  onSessionExpired,
  onProductsChanged,
  onCategoriesChanged,
  onSettingsChanged,
}: AdminPanelProps) {
  const [orders, setOrders] = useState<Order[]>([]);
  const [ordersLoading, setOrdersLoading] = useState(true);
  const [ordersError, setOrdersError] = useState('');
  const [orderActionMsg, setOrderActionMsg] = useState('');
  const [confirmDeleteOrderId, setConfirmDeleteOrderId] = useState<string | null>(null);
  const [deletingOrderId, setDeletingOrderId] = useState<string | null>(null);
  const [rtdbInfo, setRtdbInfo] = useState<RtdbStateInfo | null>(null);

  // Real-time new-order notification & iPhone chime state
  const knownOrderIdsRef = useRef<Set<string> | null>(null);
  const [notifPermission, setNotifPermission] = useState<AlertPermissionState>(() =>
    getAlertPermissionState(),
  );
  const [soundMuted, setSoundMuted] = useState<boolean>(() => isAlertSoundMuted());
  const [incomingOrderToast, setIncomingOrderToast] = useState<Order | null>(null);

  // Orders filters & selection
  const [orderQuery, setOrderQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('All');
  const [paymentFilter, setPaymentFilter] = useState('All');
  const selectedOrder = useMemo(
    () => (selectedOrderId ? orders.find((o) => o.id === selectedOrderId) ?? null : null),
    [orders, selectedOrderId],
  );

  // Products filters & delete state
  const [productQuery, setProductQuery] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // Add Product form state
  const [prodName, setProdName] = useState('');
  const [prodCategory, setProdCategory] = useState(categories[0] || 'Home & Living');
  const [prodPrice, setProdPrice] = useState('');
  const [prodStock, setProdStock] = useState('15');
  const [prodDescription, setProdDescription] = useState('');
  const [prodMedia, setProdMedia] = useState<ProductMedia[]>([]);
  const [mediaUrlInput, setMediaUrlInput] = useState('');
  const [mediaUrlType, setMediaUrlType] = useState<'auto' | 'image' | 'video'>('auto');
  const [uploadingMedia, setUploadingMedia] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [prodErrors, setProdErrors] = useState<Record<string, string>>({});
  const [prodSaving, setProdSaving] = useState(false);
  const [prodSuccessMsg, setProdSuccessMsg] = useState('');
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Category CRUD state
  const [newCategoryName, setNewCategoryName] = useState('');
  const [categoryError, setCategoryError] = useState('');
  const [categorySuccess, setCategorySuccess] = useState('');
  const [categoryBusy, setCategoryBusy] = useState(false);
  const [editingCategory, setEditingCategory] = useState<string | null>(null);
  const [editingCategoryDraft, setEditingCategoryDraft] = useState('');
  const [confirmDeleteCategory, setConfirmDeleteCategory] = useState<string | null>(null);

  // Store & Firebase RTDB Settings state
  const [setStoreName, setSetStoreName] = useState(settings.storeName);
  const [setUpiId, setSetUpiId] = useState(settings.upiId);
  const [setUpiQrUrl, setSetUpiQrUrl] = useState(
    settings.upiQrUrl || '/assets/aistudio/47084_f56d5f0a.jpg',
  );
  const [setMerchantName, setSetMerchantName] = useState(settings.merchantName);
  const [setFreeThreshold, setSetFreeThreshold] = useState(String(settings.freeShippingThreshold));
  const [setShippingFee, setSetShippingFee] = useState(String(settings.shippingFee));
  const [setRtdbUrl, setSetRtdbUrl] = useState(settings.firebaseRtdbUrl || '');
  const [adminRtdbUrl, setAdminRtdbUrl] = useState(settings.firebaseRtdbUrl || '');
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsSaved, setSettingsSaved] = useState(false);
  const [settingsError, setSettingsError] = useState('');

  const handleUnauthorized = useCallback(() => {
    if (onSessionExpired) {
      onSessionExpired();
    }
  }, [onSessionExpired]);

  const loadOrders = useCallback(
    async (silent = false) => {
      if (!silent) setOrdersLoading(true);
      if (!silent) setOrdersError('');
      try {
        const res = await adminFetch('/api/orders');
        if (res.status === 401) {
          handleUnauthorized();
          return;
        }
        const { data } = await parseApiJson<{ orders?: Order[]; rtdb?: RtdbStateInfo; error?: string }>(
          res,
        );
        if (!res.ok || !data) {
          throw new Error(data?.error || 'Failed to load orders');
        }
        const loadedOrders = data.orders || [];

        if (knownOrderIdsRef.current === null) {
          knownOrderIdsRef.current = new Set(loadedOrders.map((o) => o.id));
        } else {
          const newOrders = loadedOrders.filter((o) => !knownOrderIdsRef.current!.has(o.id));
          loadedOrders.forEach((o) => knownOrderIdsRef.current!.add(o.id));
          if (newOrders.length > 0) {
            setIncomingOrderToast(newOrders[0]);
            if (typeof document !== 'undefined') {
              document.title = `(${newOrders.length} New Order) Bantuu Admin`;
            }
            void playIphoneOrderChime();
            for (const newOrder of newOrders) {
              void triggerOrderSystemNotification(newOrder);
            }
          }
        }

        setOrders(loadedOrders);
        if (data.rtdb) setRtdbInfo(data.rtdb);
      } catch (err) {
        if (!silent) {
          setOrdersError(
            err instanceof Error ? err.message : 'Could not load orders from server.',
          );
        }
      } finally {
        if (!silent) setOrdersLoading(false);
      }
    },
    [handleUnauthorized],
  );

  const loadAdminSettings = useCallback(async () => {
    try {
      const res = await adminFetch('/api/admin/settings');
      if (res.status === 401) {
        handleUnauthorized();
        return;
      }
      const { data } = await parseApiJson<{ settings?: StoreSettings; rtdb?: RtdbStateInfo }>(res);
      if (res.ok && data?.settings) {
        onSettingsChanged(data.settings);
        if (data.settings.firebaseRtdbUrl) {
          setAdminRtdbUrl(data.settings.firebaseRtdbUrl);
          setSetRtdbUrl(data.settings.firebaseRtdbUrl);
        }
        if (data.rtdb) setRtdbInfo(data.rtdb);
      }
    } catch {
      // ignore transient network errors
    }
  }, [handleUnauthorized, onSettingsChanged]);

  const refreshCatalog = useCallback(async () => {
    try {
      const res = await adminFetch('/api/store');
      if (!res.ok) return;
      const { data } = await parseApiJson<{
        products?: Product[];
        categories?: string[];
        rtdb?: RtdbStateInfo;
      }>(res);
      if (!data) return;
      if (Array.isArray(data.products)) onProductsChanged(data.products);
      if (Array.isArray(data.categories)) onCategoriesChanged(data.categories, data.products);
      if (data.rtdb) setRtdbInfo(data.rtdb);
    } catch {
      // ignore transient network errors
    }
  }, [onProductsChanged, onCategoriesChanged]);

  useEffect(() => {
    void registerNotificationServiceWorker();
    setNotifPermission(getAlertPermissionState());

    const handleUserGestureUnlock = () => {
      void unlockAlertAudio();
    };
    const handleVisibilityOrFocus = () => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') {
        void loadOrders(true);
        void refreshCatalog();
      }
    };
    window.addEventListener('pointerdown', handleUserGestureUnlock, { passive: true });
    window.addEventListener('keydown', handleUserGestureUnlock, { passive: true });
    window.addEventListener('focus', handleVisibilityOrFocus);
    document.addEventListener('visibilitychange', handleVisibilityOrFocus);

    loadOrders();
    loadAdminSettings();
    const poll = window.setInterval(() => {
      loadOrders(true);
      refreshCatalog();
    }, 5000);
    return () => {
      window.removeEventListener('pointerdown', handleUserGestureUnlock);
      window.removeEventListener('keydown', handleUserGestureUnlock);
      window.removeEventListener('focus', handleVisibilityOrFocus);
      document.removeEventListener('visibilitychange', handleVisibilityOrFocus);
      window.clearInterval(poll);
      if (typeof document !== 'undefined') {
        document.title = 'Bantuu Store — E-Commerce Storefront';
      }
    };
  }, [loadOrders, loadAdminSettings, refreshCatalog]);

  // Real-time Firebase RTDB EventSource subscription (admin-only URL loaded from /api/admin/settings)
  useEffect(() => {
    const cleanRtdb = normalizeFirebaseRtdbUrl(adminRtdbUrl);
    if (!cleanRtdb || typeof EventSource === 'undefined') return;

    let closed = false;
    const source = new EventSource(`${cleanRtdb}/.json`);
    const onStreamUpdate = () => {
      if (closed) return;
      loadOrders(true);
      refreshCatalog();
    };
    source.addEventListener('put', onStreamUpdate);
    source.addEventListener('patch', onStreamUpdate);

    return () => {
      closed = true;
      source.close();
    };
  }, [adminRtdbUrl, loadOrders, refreshCatalog]);

  useEffect(() => {
    if (categories.length > 0 && !categories.includes(prodCategory)) {
      setProdCategory(categories[0]);
    }
  }, [categories, prodCategory]);

  useEffect(() => {
    setSetStoreName(settings.storeName);
    setSetUpiId(settings.upiId);
    setSetUpiQrUrl(settings.upiQrUrl || '/assets/aistudio/47084_f56d5f0a.jpg');
    setSetMerchantName(settings.merchantName);
    setSetFreeThreshold(String(settings.freeShippingThreshold));
    setSetShippingFee(String(settings.shippingFee));
    if (settings.firebaseRtdbUrl) {
      setAdminRtdbUrl(settings.firebaseRtdbUrl);
      setSetRtdbUrl(settings.firebaseRtdbUrl);
    }
  }, [settings]);

  const filteredOrders = useMemo(
    () => filterOrders(orders, statusFilter, paymentFilter, orderQuery),
    [orders, statusFilter, paymentFilter, orderQuery],
  );

  const filteredProducts = useMemo(() => {
    const q = productQuery.trim().toLowerCase();
    if (!q) return products;
    return products.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.category.toLowerCase().includes(q),
    );
  }, [products, productQuery]);

  const metrics = useMemo(() => {
    const totalRevenue = orders
      .filter((o) => o.status !== 'Cancelled')
      .reduce((sum, o) => sum + o.total, 0);
    const pendingCount = orders.filter((o) => o.status === 'Pending').length;
    const codCount = orders.filter((o) => o.paymentMethod === 'COD').length;
    const upiCount = orders.filter((o) => o.paymentMethod === 'UPI').length;
    return { totalRevenue, pendingCount, codCount, upiCount };
  }, [orders]);

  const handleStatusChange = async (orderId: string, nextStatus: OrderStatus) => {
    try {
      const res = await adminFetch(`/api/orders/${orderId}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: nextStatus }),
      });
      if (res.status === 401) {
        handleUnauthorized();
        return;
      }
      const { data } = await parseApiJson<{ order?: Order; rtdb?: RtdbStateInfo }>(res);
      if (!res.ok || !data?.order) return;
      setOrders((prev) => prev.map((o) => (o.id === orderId ? data.order! : o)));
      if (data.rtdb) setRtdbInfo(data.rtdb);
    } catch {
      // keep previous status on failure
    }
  };

  const handleDeleteOrder = async (orderId: string, orderNumber: string) => {
    setDeletingOrderId(orderId);
    setOrdersError('');
    setOrderActionMsg('');
    try {
      const res = await adminFetch(`/api/orders/${orderId}`, {
        method: 'DELETE',
      });
      if (res.status === 401) {
        handleUnauthorized();
        return;
      }
      const { data } = await parseApiJson<{
        deleted?: boolean;
        rtdb?: RtdbStateInfo;
        error?: string;
      }>(res);
      if (!res.ok) {
        setOrdersError(data?.error || 'Could not delete order.');
        return;
      }
      setOrders((prev) => prev.filter((o) => o.id !== orderId));
      knownOrderIdsRef.current?.delete(orderId);
      setConfirmDeleteOrderId(null);
      if (selectedOrderId === orderId) {
        onSelectedOrderIdChange(null);
      }
      if (data?.rtdb) setRtdbInfo(data.rtdb);
      setOrderActionMsg(`Order ${orderNumber} deleted.`);
    } catch {
      setOrdersError('Network error while deleting order.');
    } finally {
      setDeletingOrderId(null);
    }
  };

  const handleEnableNotifications = async () => {
    await unlockAlertAudio();
    const perm = await requestSystemNotificationPermission();
    setNotifPermission(perm);
    if (perm === 'granted') {
      void playIphoneOrderChime();
      setOrderActionMsg('Order notification alerts enabled with iPhone notification chime.');
    } else if (perm === 'denied') {
      setOrderActionMsg(
        'Notification permission is blocked in browser/app settings. Enable notifications in App Info to see OS tray alerts.',
      );
    }
  };

  const handleToggleSound = async () => {
    const nextMuted = !soundMuted;
    setAlertSoundMuted(nextMuted);
    setSoundMuted(nextMuted);
    if (!nextMuted) {
      await unlockAlertAudio();
      void playIphoneOrderChime();
    }
  };

  const handleTestAlert = async () => {
    await unlockAlertAudio();
    let perm = getAlertPermissionState();
    if (perm === 'default') {
      perm = await requestSystemNotificationPermission();
      setNotifPermission(perm);
    }
    if (soundMuted) {
      setAlertSoundMuted(false);
      setSoundMuted(false);
    }
    const played = await playIphoneOrderChime();
    const previewOrder: Order = {
      id: `test-${Date.now()}`,
      orderNumber: 'BNT-TEST',
      customerName: 'Bantuu Test Customer',
      customerPhone: '9876543210',
      address: 'Sample Address',
      city: 'Jaipur',
      pincode: '302001',
      paymentMethod: 'COD',
      items: [
        {
          productId: 'test',
          name: 'Test Notification Order',
          price: 499,
          quantity: 1,
          imageUrl: '/assets/aistudio/47084_f56d5f0a.jpg',
        },
      ],
      subtotal: 499,
      shippingFee: 0,
      total: 499,
      status: 'Pending',
      createdAt: new Date().toISOString(),
    };
    setIncomingOrderToast(previewOrder);
    const notified = await triggerOrderSystemNotification(previewOrder);
    if (notified) {
      setOrderActionMsg('Test OS notification & iPhone chime sent! Check your notification tray.');
    } else if (played) {
      setOrderActionMsg(
        'Test iPhone chime played! Allow Notification permission in browser/app settings for OS tray alerts.',
      );
    } else {
      setOrderActionMsg('Test order alert banner triggered.');
    }
  };

  const dismissIncomingToast = () => {
    setIncomingOrderToast(null);
    if (typeof document !== 'undefined') {
      document.title = 'Bantuu Store — E-Commerce Storefront';
    }
  };

  const handleDeleteProduct = async (productId: string, productName: string) => {
    setDeletingId(productId);
    try {
      const res = await adminFetch(`/api/products/${productId}`, {
        method: 'DELETE',
      });
      if (res.status === 401) {
        handleUnauthorized();
        return;
      }
      if (res.ok) {
        onProductsChanged(products.filter((p) => p.id !== productId));
        setConfirmDeleteId(null);
        setProdSuccessMsg(`"${productName}" removed from Bantuu Store.`);
      }
    } finally {
      setDeletingId(null);
    }
  };

  const handleFileUpload = async (e: ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    setUploadError('');
    setUploadingMedia(true);

    try {
      const uploadedItems: ProductMedia[] = [];
      for (const file of Array.from(files)) {
        const prepared = await prepareMediaPayload(file);
        const res = await adminFetch('/api/upload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(prepared),
        });
        if (res.status === 401) {
          handleUnauthorized();
          return;
        }
        const { data } = await parseApiJson<{
          id?: string;
          type?: ProductMedia['type'];
          url?: string;
          name?: string;
          error?: string;
        }>(res);
        if (!res.ok || !data?.url || !data?.type) {
          setUploadError(
            data?.error ||
              (res.status === 413
                ? 'File is too large for upload. Please try a smaller photo or paste a video URL.'
                : `Failed to upload ${file.name} (HTTP ${res.status}).`),
          );
          continue;
        }
        uploadedItems.push({
          id: data.id || `med-${Date.now()}-${Math.random()}`,
          type: data.type,
          url: data.url,
          name: data.name || prepared.fileName,
        });
      }
      if (uploadedItems.length > 0) {
        setProdMedia((prev) => [...prev, ...uploadedItems]);
      }
    } catch (err) {
      setUploadError(
        err instanceof Error
          ? err.message
          : 'Upload failed. Ensure file is an image or video under 3.5MB.',
      );
    } finally {
      setUploadingMedia(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleAddMediaUrl = () => {
    const trimmed = mediaUrlInput.trim();
    if (!trimmed) return;
    setUploadError('');
    const detectedType =
      mediaUrlType === 'auto' ? inferMediaTypeFromUrl(trimmed) : mediaUrlType;
    setProdMedia((prev) => [
      ...prev,
      {
        id: `med-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        type: detectedType,
        url: trimmed,
        name: trimmed.split('/').pop() || 'External media',
      },
    ]);
    setMediaUrlInput('');
  };

  const handleCreateProduct = async (e: FormEvent) => {
    e.preventDefault();
    setProdSuccessMsg('');

    const validation = validateProductForm({
      name: prodName,
      category: prodCategory,
      price: prodPrice,
      stock: prodStock,
      description: prodDescription,
      media: prodMedia,
    });

    if (Object.keys(validation).length > 0) {
      setProdErrors(validation);
      return;
    }

    setProdErrors({});
    setProdSaving(true);
    try {
      const res = await adminFetch('/api/products', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: prodName,
          category: prodCategory,
          price: Number(prodPrice),
          stock: Number(prodStock),
          description: prodDescription,
          media: prodMedia,
          featured: true,
        }),
      });
      if (res.status === 401) {
        handleUnauthorized();
        return;
      }
      const { data } = await parseApiJson<{
        product?: Product;
        rtdb?: RtdbStateInfo;
        errors?: Record<string, string>;
        error?: string;
      }>(res);
      if (!res.ok || !data?.product) {
        setProdErrors(
          data?.errors || {
            submit: data?.error || `Could not save product (HTTP ${res.status}).`,
          },
        );
        return;
      }

      onProductsChanged([data.product, ...products]);
      if (data.rtdb) setRtdbInfo(data.rtdb);
      setProdName('');
      setProdPrice('');
      setProdStock('15');
      setProdDescription('');
      setProdMedia([]);
      setProdSuccessMsg(`"${data.product.name}" published to Bantuu Store & Firebase RTDB.`);
      onTabChange('products');
    } catch {
      setProdErrors({ submit: 'Could not reach the server to save product. Please try again.' });
    } finally {
      setProdSaving(false);
    }
  };

  const handleAddCategory = async (e: FormEvent) => {
    e.preventDefault();
    setCategoryError('');
    setCategorySuccess('');
    const err = validateCategoryName(newCategoryName, categories);
    if (err) {
      setCategoryError(err);
      return;
    }

    setCategoryBusy(true);
    try {
      const res = await adminFetch('/api/categories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newCategoryName }),
      });
      if (res.status === 401) {
        handleUnauthorized();
        return;
      }
      const { data } = await parseApiJson<{
        categories?: string[];
        category?: string;
        rtdb?: RtdbStateInfo;
        error?: string;
      }>(res);
      if (!res.ok || !data) {
        setCategoryError(data?.error || `Could not add category (HTTP ${res.status}).`);
        return;
      }
      onCategoriesChanged(data.categories || []);
      if (data.rtdb) setRtdbInfo(data.rtdb);
      setNewCategoryName('');
      setCategorySuccess(`Category "${data.category || newCategoryName.trim()}" added.`);
    } catch {
      setCategoryError('Unable to reach server while adding category.');
    } finally {
      setCategoryBusy(false);
    }
  };

  const handleRenameCategory = async (oldName: string) => {
    setCategoryError('');
    setCategorySuccess('');
    const err = validateCategoryName(editingCategoryDraft, categories, oldName);
    if (err) {
      setCategoryError(err);
      return;
    }

    setCategoryBusy(true);
    try {
      const res = await adminFetch('/api/categories', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ oldName, newName: editingCategoryDraft }),
      });
      if (res.status === 401) {
        handleUnauthorized();
        return;
      }
      const { data } = await parseApiJson<{
        categories?: string[];
        products?: Product[];
        newName?: string;
        rtdb?: RtdbStateInfo;
        error?: string;
      }>(res);
      if (!res.ok || !data) {
        setCategoryError(data?.error || `Could not rename category (HTTP ${res.status}).`);
        return;
      }
      onCategoriesChanged(data.categories || [], data.products);
      if (data.rtdb) setRtdbInfo(data.rtdb);
      setEditingCategory(null);
      setEditingCategoryDraft('');
      setCategorySuccess(`Category renamed to "${data.newName || editingCategoryDraft.trim()}".`);
    } catch {
      setCategoryError('Unable to reach server while renaming category.');
    } finally {
      setCategoryBusy(false);
    }
  };

  const handleDeleteCategory = async (name: string) => {
    setCategoryError('');
    setCategorySuccess('');
    setCategoryBusy(true);
    try {
      const res = await adminFetch(`/api/categories?name=${encodeURIComponent(name)}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (res.status === 401) {
        handleUnauthorized();
        return;
      }
      const { data } = await parseApiJson<{
        categories?: string[];
        products?: Product[];
        rtdb?: RtdbStateInfo;
        error?: string;
      }>(res);
      if (!res.ok || !data) {
        setCategoryError(data?.error || `Could not delete category (HTTP ${res.status}).`);
        return;
      }
      onCategoriesChanged(data.categories || [], data.products);
      if (data.rtdb) setRtdbInfo(data.rtdb);
      setConfirmDeleteCategory(null);
      setCategorySuccess(`Category "${name}" deleted.`);
    } catch {
      setCategoryError('Unable to reach server while deleting category.');
    } finally {
      setCategoryBusy(false);
    }
  };

  const handleSaveSettings = async (e: FormEvent) => {
    e.preventDefault();
    setSettingsSaving(true);
    setSettingsSaved(false);
    setSettingsError('');
    try {
      const res = await adminFetch('/api/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          storeName: setStoreName,
          upiId: setUpiId,
          upiQrUrl: setUpiQrUrl,
          merchantName: setMerchantName,
          freeShippingThreshold: Number(setFreeThreshold) || 0,
          shippingFee: Number(setShippingFee) || 0,
          firebaseRtdbUrl: setRtdbUrl,
        }),
      });
      if (res.status === 401) {
        handleUnauthorized();
        return;
      }
      const { data } = await parseApiJson<{
        settings?: StoreSettings;
        rtdb?: RtdbStateInfo;
        error?: string;
      }>(res);
      if (!res.ok || !data?.settings) {
        setSettingsError(data?.error || 'Could not save settings.');
        return;
      }
      onSettingsChanged(data.settings);
      if (data.settings.firebaseRtdbUrl) setAdminRtdbUrl(data.settings.firebaseRtdbUrl);
      if (data.rtdb) setRtdbInfo(data.rtdb);
      setSettingsSaved(true);
      window.setTimeout(() => setSettingsSaved(false), 2500);
    } catch {
      setSettingsError('Unable to reach server while saving settings.');
    } finally {
      setSettingsSaving(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#F7F5EE] text-[#0F1D32] flex flex-col lg:flex-row">
      {/* Midnight Navy Brand Sidebar */}
      <aside className="w-full lg:w-64 bg-[#0F1D32] text-[#F7F5EE] border-b lg:border-b-0 lg:border-r border-[#223654] flex flex-col justify-between shrink-0">
        <div>
          <div className="px-4 sm:px-6 py-4 sm:py-5 border-b border-[#223654] flex items-center justify-between gap-2 lg:block">
            <div className="min-w-0">
              <BantuuLogo variant="dark" size="sm" />
              <p className="text-[11px] uppercase tracking-wider text-[#C6A45C] font-medium mt-2 lg:mt-3">
                Admin Studio
              </p>
            </div>
            <div className="flex lg:hidden items-center gap-1.5 shrink-0">
              <button
                type="button"
                onClick={onBackToStorefront}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-medium rounded-lg border border-[#223654] bg-[#172A46] text-[#F7F5EE] cursor-pointer whitespace-nowrap"
              >
                <ArrowLeft className="w-3 h-3 text-[#C6A45C]" />
                <span>Storefront</span>
              </button>
              <button
                type="button"
                onClick={onLogoutAdmin}
                aria-label="Logout admin session"
                className="inline-flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-medium rounded-lg border border-[#DC2626]/40 bg-[#2A1924] text-[#FCA5A5] cursor-pointer whitespace-nowrap"
              >
                <LogOut className="w-3 h-3" />
                <span>Logout</span>
              </button>
            </div>
          </div>

          <nav className="p-3 flex lg:flex-col gap-1 overflow-x-auto" aria-label="Admin sections">
            <button
              type="button"
              onClick={() => onTabChange('orders')}
              className={`flex items-center justify-between gap-3 px-3.5 py-2.5 rounded-lg text-sm font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                activeTab === 'orders'
                  ? 'bg-[#C6A45C] text-[#0F1D32]'
                  : 'text-[#CBD3DF] hover:bg-[#172A46] hover:text-[#F7F5EE]'
              }`}
            >
              <span className="inline-flex items-center gap-2.5">
                <ClipboardList className="w-4 h-4" />
                <span>Orders</span>
              </span>
              <span className="font-mono text-xs tabular-nums opacity-85">{orders.length}</span>
            </button>

            <button
              type="button"
              onClick={() => onTabChange('products')}
              className={`flex items-center justify-between gap-3 px-3.5 py-2.5 rounded-lg text-sm font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                activeTab === 'products'
                  ? 'bg-[#C6A45C] text-[#0F1D32]'
                  : 'text-[#CBD3DF] hover:bg-[#172A46] hover:text-[#F7F5EE]'
              }`}
            >
              <span className="inline-flex items-center gap-2.5">
                <Package className="w-4 h-4" />
                <span>Products</span>
              </span>
              <span className="font-mono text-xs tabular-nums opacity-85">{products.length}</span>
            </button>

            <button
              type="button"
              onClick={() => {
                setCategoryError('');
                setCategorySuccess('');
                onTabChange('categories');
              }}
              className={`flex items-center justify-between gap-3 px-3.5 py-2.5 rounded-lg text-sm font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                activeTab === 'categories'
                  ? 'bg-[#C6A45C] text-[#0F1D32]'
                  : 'text-[#CBD3DF] hover:bg-[#172A46] hover:text-[#F7F5EE]'
              }`}
            >
              <span className="inline-flex items-center gap-2.5">
                <Layers className="w-4 h-4" />
                <span>Categories</span>
              </span>
              <span className="font-mono text-xs tabular-nums opacity-85">{categories.length}</span>
            </button>

            <button
              type="button"
              onClick={() => {
                setProdSuccessMsg('');
                onTabChange('add-product');
              }}
              className={`flex items-center gap-2.5 px-3.5 py-2.5 rounded-lg text-sm font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                activeTab === 'add-product'
                  ? 'bg-[#C6A45C] text-[#0F1D32]'
                  : 'text-[#CBD3DF] hover:bg-[#172A46] hover:text-[#F7F5EE]'
              }`}
            >
              <Plus className="w-4 h-4" />
              <span>Add Product</span>
            </button>

            <button
              type="button"
              onClick={() => onTabChange('settings')}
              className={`flex items-center gap-2.5 px-3.5 py-2.5 rounded-lg text-sm font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                activeTab === 'settings'
                  ? 'bg-[#C6A45C] text-[#0F1D32]'
                  : 'text-[#CBD3DF] hover:bg-[#172A46] hover:text-[#F7F5EE]'
              }`}
            >
              <Settings className="w-4 h-4" />
              <span>UPI, RTDB &amp; Settings</span>
            </button>
          </nav>
        </div>

        <div className="hidden lg:flex flex-col gap-2 p-4 border-t border-[#223654]">
          <button
            type="button"
            onClick={onBackToStorefront}
            className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg border border-[#223654] bg-[#172A46] text-sm font-medium text-[#F7F5EE] hover:bg-[#1F3659] transition-colors cursor-pointer"
          >
            <ArrowLeft className="w-4 h-4 text-[#C6A45C]" />
            <span>Back to Storefront</span>
          </button>
          <button
            type="button"
            onClick={onLogoutAdmin}
            className="w-full inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg border border-[#DC2626]/40 bg-[#2A1924] text-xs font-medium text-[#FCA5A5] hover:bg-[#3A1F2F] transition-colors cursor-pointer"
          >
            <LogOut className="w-3.5 h-3.5" />
            <span>Logout Admin</span>
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 min-w-0 p-4 sm:p-6 lg:p-8 max-w-7xl">
        {incomingOrderToast && (
          <div
            role="status"
            aria-live="polite"
            className="mb-5 p-4 rounded-xl border border-[#C6A45C] bg-[#0F1D32] text-[#F7F5EE] shadow-lg flex flex-col sm:flex-row sm:items-center justify-between gap-3"
          >
            <div className="flex items-start gap-3">
              <span className="w-9 h-9 rounded-lg bg-[#C6A45C] text-[#0F1D32] inline-flex items-center justify-center shrink-0">
                <Bell className="w-4 h-4" />
              </span>
              <div>
                <p className="text-xs uppercase tracking-wider text-[#C6A45C] font-semibold">
                  New Customer Order Received
                </p>
                <p className="text-sm font-semibold mt-0.5">
                  {incomingOrderToast.orderNumber} · {incomingOrderToast.customerName} ·{' '}
                  <span className="font-mono text-[#C6A45C]">
                    {formatINR(incomingOrderToast.total)}
                  </span>{' '}
                  ({incomingOrderToast.paymentMethod})
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {!incomingOrderToast.id.startsWith('test-') && (
                <button
                  type="button"
                  onClick={() => {
                    onTabChange('orders');
                    onSelectedOrderIdChange(incomingOrderToast.id);
                    dismissIncomingToast();
                  }}
                  className="px-3 py-1.5 rounded-lg bg-[#C6A45C] text-[#0F1D32] text-xs font-semibold hover:bg-[#B69249] cursor-pointer"
                >
                  Open Order
                </button>
              )}
              <button
                type="button"
                onClick={dismissIncomingToast}
                aria-label="Dismiss new order alert"
                className="w-8 h-8 inline-flex items-center justify-center rounded-lg border border-[#223654] bg-[#172A46] text-[#F7F5EE] hover:bg-[#1F3659] cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}

        {/* ORDERS TAB */}
        {activeTab === 'orders' && (
          <div className="space-y-6">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
              <div>
                <p className="text-xs uppercase tracking-wider text-[#8A6D32] font-semibold">
                  Admin / Realtime Orders Ledger
                </p>
                <h1 className="text-2xl font-semibold text-[#0F1D32] mt-1">
                  Customer Orders, Addresses &amp; Timestamps
                </h1>
              </div>
              <div className="flex flex-wrap items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={handleEnableNotifications}
                  className={`inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border transition-colors cursor-pointer whitespace-nowrap ${
                    notifPermission === 'granted'
                      ? 'border-[#C6A45C] bg-[#0F1D32] text-[#F7F5EE]'
                      : 'border-[#0F1D32] bg-[#C6A45C] text-[#0F1D32] hover:bg-[#B69249] font-semibold'
                  }`}
                >
                  {notifPermission === 'denied' ? (
                    <BellOff className="w-3.5 h-3.5" />
                  ) : (
                    <Bell className="w-3.5 h-3.5" />
                  )}
                  <span>
                    {notifPermission === 'granted'
                      ? 'Alerts On'
                      : notifPermission === 'denied'
                        ? 'Alerts Blocked'
                        : 'Enable Alerts'}
                  </span>
                </button>

                <button
                  type="button"
                  onClick={handleToggleSound}
                  aria-label={soundMuted ? 'Unmute order chime' : 'Mute order chime'}
                  className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border border-[#DED8C8] bg-white hover:bg-[#ECE7DA] transition-colors cursor-pointer whitespace-nowrap"
                >
                  {soundMuted ? (
                    <VolumeX className="w-3.5 h-3.5 text-[#B91C1C]" />
                  ) : (
                    <Volume2 className="w-3.5 h-3.5 text-[#8A6D32]" />
                  )}
                  <span>{soundMuted ? 'Muted' : 'Sound On'}</span>
                </button>

                <button
                  type="button"
                  onClick={handleTestAlert}
                  className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border border-[#DED8C8] bg-white hover:bg-[#ECE7DA] transition-colors cursor-pointer whitespace-nowrap"
                >
                  <Bell className="w-3.5 h-3.5 text-[#8A6D32]" />
                  <span>Test Alert</span>
                </button>

                <button
                  type="button"
                  onClick={() => loadOrders()}
                  className="inline-flex items-center justify-center px-3.5 py-2 text-xs font-medium rounded-lg border border-[#DED8C8] bg-white hover:bg-[#ECE7DA] transition-colors cursor-pointer whitespace-nowrap"
                >
                  Sync Now
                </button>
              </div>
            </div>

            {rtdbInfo?.lastError && (
              <div
                role="alert"
                className="p-4 rounded-xl border border-[#DC2626]/30 bg-[#FEF2F2] text-xs text-[#991B1B]"
              >
                {rtdbInfo.lastError}
              </div>
            )}

            {/* 4-column Summary Strip */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <div className="p-4 rounded-xl bg-white border border-[#DED8C8]">
                <p className="text-xs text-[#5C5852]">Total Orders</p>
                <p className="mt-1.5 text-2xl font-mono font-semibold tabular-nums text-[#0F1D32]">
                  {orders.length}
                </p>
              </div>
              <div className="p-4 rounded-xl bg-white border border-[#DED8C8]">
                <p className="text-xs text-[#5C5852]">Pending Fulfillment</p>
                <p className="mt-1.5 text-2xl font-mono font-semibold tabular-nums text-[#8A6D32]">
                  {metrics.pendingCount}
                </p>
              </div>
              <div className="p-4 rounded-xl bg-white border border-[#DED8C8]">
                <p className="text-xs text-[#5C5852]">Gross Revenue</p>
                <p className="mt-1.5 text-2xl font-mono font-semibold tabular-nums text-[#0F1D32]">
                  {formatINR(metrics.totalRevenue)}
                </p>
              </div>
              <div className="p-4 rounded-xl bg-white border border-[#DED8C8]">
                <p className="text-xs text-[#5C5852]">Payment Split (COD / UPI)</p>
                <p className="mt-1.5 text-2xl font-mono font-semibold tabular-nums text-[#0F1D32]">
                  {metrics.codCount} / {metrics.upiCount}
                </p>
              </div>
            </div>

            {/* Filters */}
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 bg-white p-3.5 rounded-xl border border-[#DED8C8]">
              <div className="relative flex-1 max-w-sm">
                <Search className="w-4 h-4 text-[#5C5852] absolute left-3 top-1/2 -translate-y-1/2" />
                <label htmlFor="admin-order-search" className="sr-only">
                  Search orders
                </label>
                <input
                  id="admin-order-search"
                  type="text"
                  value={orderQuery}
                  onChange={(e) => setOrderQuery(e.target.value)}
                  placeholder="Search Order #, customer, phone, city, UTR..."
                  className="w-full pl-9 pr-3 py-2 text-sm rounded-lg border border-[#DED8C8] bg-[#F7F5EE] focus:bg-white focus:outline-none focus:border-[#0F1D32]"
                />
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <label htmlFor="order-status-filter" className="sr-only">
                  Filter by status
                </label>
                <select
                  id="order-status-filter"
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value)}
                  className="px-3 py-2 text-xs font-medium rounded-lg border border-[#DED8C8] bg-[#F7F5EE] text-[#0F1D32]"
                >
                  <option value="All">All Statuses</option>
                  {ORDER_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>

                <div className="inline-flex items-center p-1 rounded-lg bg-[#F7F5EE] border border-[#DED8C8]">
                  {['All', 'COD', 'UPI'].map((pm) => (
                    <button
                      key={pm}
                      type="button"
                      onClick={() => setPaymentFilter(pm)}
                      className={`px-3 py-1 text-xs font-medium rounded-md transition-colors cursor-pointer ${
                        paymentFilter === pm
                          ? 'bg-[#0F1D32] text-[#F7F5EE]'
                          : 'text-[#5C5852] hover:text-[#0F1D32]'
                      }`}
                    >
                      {pm}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {ordersError && (
              <div className="p-4 rounded-xl border border-[#DC2626]/30 bg-[#FEF2F2] text-sm text-[#991B1B]">
                {ordersError}
              </div>
            )}

            {orderActionMsg && (
              <div className="p-4 rounded-xl border border-[#C6A45C]/50 bg-[#F7F5EE] text-sm font-medium text-[#0F1D32]">
                {orderActionMsg}
              </div>
            )}

            {/* Orders Table */}
            <div className="bg-white border border-[#DED8C8] rounded-xl overflow-hidden">
              {ordersLoading ? (
                <div className="p-8 text-center text-sm text-[#5C5852]">Loading orders...</div>
              ) : filteredOrders.length === 0 ? (
                <div className="p-10 text-center text-sm text-[#5C5852]">
                  No orders match the current filter.
                </div>
              ) : (
                <>
                  {/* Mobile Order Cards (< md): Status, View Details & Delete always visible without horizontal scroll */}
                  <div className="md:hidden divide-y divide-[#DED8C8]">
                    {filteredOrders.map((order) => {
                      const dt = formatOrderDateTime(order.createdAt);
                      const itemCount = order.items.reduce((s, i) => s + i.quantity, 0);
                      return (
                        <div key={order.id} className="p-4 space-y-3">
                          <div className="flex items-start justify-between gap-2">
                            <div>
                              <span className="font-mono font-semibold text-sm text-[#0F1D32]">
                                {order.orderNumber}
                              </span>
                              <p className="text-[11px] font-mono text-[#5C5852] mt-0.5">
                                {dt.date} · {dt.time}
                              </p>
                            </div>
                            <span className="font-mono font-semibold text-sm text-[#0F1D32] tabular-nums">
                              {formatINR(order.total)}
                            </span>
                          </div>

                          <div className="text-xs text-[#3E4756] space-y-0.5">
                            <p className="font-medium text-[#0F1D32]">
                              {order.customerName} · <span className="font-mono">{order.customerPhone}</span>
                            </p>
                            <p className="leading-snug">
                              {order.address}, {order.city} — {order.pincode}
                            </p>
                            <p className="pt-1">
                              <span className="font-mono font-medium text-[#0F1D32]">
                                {itemCount} {itemCount === 1 ? 'item' : 'items'}
                              </span>{' '}
                              · {order.items.map((i) => i.name).join(', ')}
                            </p>
                            <p>
                              {order.paymentMethod === 'COD' ? 'Cash on Delivery' : 'UPI'}
                              {order.upiTransactionId ? ` · UTR: ${order.upiTransactionId}` : ''}
                            </p>
                          </div>

                          <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-[#DED8C8]/70">
                            <select
                              aria-label={`Mobile order status for ${order.orderNumber}`}
                              value={order.status}
                              onChange={(e) =>
                                handleStatusChange(order.id, e.target.value as OrderStatus)
                              }
                              className="px-2.5 py-1.5 text-xs font-medium rounded-md border border-[#DED8C8] bg-[#F7F5EE] text-[#0F1D32]"
                            >
                              {ORDER_STATUSES.map((s) => (
                                <option key={s} value={s}>
                                  {s}
                                </option>
                              ))}
                            </select>

                            <div className="flex items-center gap-1.5">
                              <button
                                type="button"
                                onClick={() => onSelectedOrderIdChange(order.id)}
                                className="px-2.5 py-1.5 text-xs font-medium rounded-md border border-[#DED8C8] bg-white text-[#0F1D32]"
                              >
                                View Details
                              </button>
                              {confirmDeleteOrderId === order.id ? (
                                <>
                                  <button
                                    type="button"
                                    disabled={deletingOrderId === order.id}
                                    onClick={() => handleDeleteOrder(order.id, order.orderNumber)}
                                    className="px-2.5 py-1.5 text-xs font-medium rounded-md bg-[#B91C1C] text-white disabled:opacity-50 cursor-pointer"
                                  >
                                    {deletingOrderId === order.id ? 'Deleting...' : 'Confirm'}
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => setConfirmDeleteOrderId(null)}
                                    className="px-2 py-1.5 text-xs rounded-md border border-[#DED8C8] bg-white text-[#3E4756]"
                                  >
                                    Cancel
                                  </button>
                                </>
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => setConfirmDeleteOrderId(order.id)}
                                  aria-label={`Delete order ${order.orderNumber} mobile`}
                                  className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded-md border border-[#DED8C8] text-[#B91C1C] hover:bg-[#FEF2F2]"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                  <span>Delete</span>
                                </button>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {/* Desktop Orders Table */}
                  <div className="hidden md:block overflow-x-auto">
                    <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="border-b border-[#DED8C8] bg-[#F7F5EE] text-[11px] uppercase tracking-wider text-[#5C5852]">
                        <th className="py-3 px-3 font-medium">Order</th>
                        <th className="py-3 px-3 font-medium">Date &amp; Time</th>
                        <th className="py-3 px-3 font-medium">Customer &amp; Address</th>
                        <th className="py-3 px-3 font-medium">Items</th>
                        <th className="py-3 px-3 font-medium">Payment</th>
                        <th className="py-3 px-3 font-medium text-right">Total</th>
                        <th className="py-3 px-3 font-medium">Status</th>
                        <th className="py-3 px-3 font-medium text-right">Action</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#DED8C8] text-sm">
                      {filteredOrders.map((order) => {
                        const dt = formatOrderDateTime(order.createdAt);
                        const itemCount = order.items.reduce((s, i) => s + i.quantity, 0);
                        return (
                          <tr key={order.id} className="hover:bg-[#F7F5EE]/70 transition-colors">
                            <td className="py-3.5 px-3 font-mono font-semibold text-[#0F1D32] whitespace-nowrap">
                              {order.orderNumber}
                            </td>
                            <td className="py-3.5 px-3 font-mono text-xs text-[#3E4756] whitespace-nowrap tabular-nums">
                              <div className="text-[#0F1D32] font-medium">{dt.date}</div>
                              <div className="text-[#5C5852]">{dt.time}</div>
                            </td>
                            <td className="py-3.5 px-3 max-w-[220px]">
                              <div className="font-medium text-[#0F1D32]">{order.customerName}</div>
                              <div className="text-xs font-mono text-[#5C5852]">
                                {order.customerPhone}
                              </div>
                              <div className="text-xs text-[#3E4756] leading-snug mt-0.5">
                                {order.address}, {order.city} — {order.pincode}
                              </div>
                            </td>
                            <td className="py-3.5 px-3 text-xs text-[#3E4756] max-w-[160px]">
                              <span className="font-mono font-medium text-[#0F1D32]">
                                {itemCount} {itemCount === 1 ? 'item' : 'items'}
                              </span>{' '}
                              · {order.items.map((i) => i.name).join(', ')}
                            </td>
                            <td className="py-3.5 px-3 text-xs">
                              <div className="font-medium text-[#0F1D32]">
                                {order.paymentMethod === 'COD' ? 'Cash on Delivery' : 'UPI'}
                              </div>
                              {order.upiTransactionId && (
                                <div className="font-mono text-[11px] text-[#5C5852]">
                                  UTR: {order.upiTransactionId}
                                </div>
                              )}
                            </td>
                            <td className="py-3.5 px-3 text-right font-mono font-semibold text-[#0F1D32] tabular-nums whitespace-nowrap">
                              {formatINR(order.total)}
                            </td>
                            <td className="py-3.5 px-3">
                              <select
                                aria-label={`Order status for ${order.orderNumber}`}
                                value={order.status}
                                onChange={(e) =>
                                  handleStatusChange(order.id, e.target.value as OrderStatus)
                                }
                                className="px-2 py-1.5 text-xs font-medium rounded-md border border-[#DED8C8] bg-white text-[#0F1D32]"
                              >
                                {ORDER_STATUSES.map((s) => (
                                  <option key={s} value={s}>
                                    {s}
                                  </option>
                                ))}
                              </select>
                            </td>
                            <td className="py-3.5 px-3 text-right whitespace-nowrap">
                              <div className="inline-flex items-center justify-end gap-1.5">
                                <button
                                  type="button"
                                  onClick={() => onSelectedOrderIdChange(order.id)}
                                  className="px-2.5 py-1.5 text-xs font-medium rounded-md border border-[#DED8C8] bg-white text-[#0F1D32] hover:bg-[#ECE7DA] cursor-pointer"
                                >
                                  View Details
                                </button>
                                {confirmDeleteOrderId === order.id ? (
                                  <>
                                    <button
                                      type="button"
                                      disabled={deletingOrderId === order.id}
                                      onClick={() => handleDeleteOrder(order.id, order.orderNumber)}
                                      className="px-2 py-1.5 text-xs font-medium rounded-md bg-[#B91C1C] text-white disabled:opacity-50 cursor-pointer"
                                    >
                                      {deletingOrderId === order.id ? 'Deleting...' : 'Confirm'}
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => setConfirmDeleteOrderId(null)}
                                      className="px-2 py-1.5 text-xs rounded-md border border-[#DED8C8] bg-white text-[#3E4756] cursor-pointer"
                                    >
                                      Cancel
                                    </button>
                                  </>
                                ) : (
                                  <button
                                    type="button"
                                    onClick={() => setConfirmDeleteOrderId(order.id)}
                                    aria-label={`Delete order ${order.orderNumber}`}
                                    className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded-md border border-[#DED8C8] text-[#B91C1C] hover:bg-[#FEF2F2] cursor-pointer"
                                  >
                                    <Trash2 className="w-3.5 h-3.5" />
                                    <span>Delete</span>
                                  </button>
                                )}
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  </div>
                </>
              )}
            </div>
          </div>
        )}

        {/* PRODUCTS TAB */}
        {activeTab === 'products' && (
          <div className="space-y-6">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
              <div>
                <p className="text-xs uppercase tracking-wider text-[#8A6D32] font-semibold">
                  Admin / Catalog
                </p>
                <h1 className="text-2xl font-semibold text-[#0F1D32] mt-1">
                  Manage Products ({products.length})
                </h1>
              </div>
              <button
                type="button"
                onClick={() => {
                  setProdSuccessMsg('');
                  onTabChange('add-product');
                }}
                className="inline-flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-semibold rounded-lg bg-[#C6A45C] text-[#0F1D32] hover:bg-[#B69249] transition-colors cursor-pointer whitespace-nowrap shrink-0"
              >
                <Plus className="w-4 h-4" />
                <span>Add Product</span>
              </button>
            </div>

            {prodSuccessMsg && (
              <div
                role="status"
                className="p-3.5 rounded-lg border border-[#C6A45C]/50 bg-white text-sm text-[#0F1D32] flex items-center gap-2"
              >
                <Check className="w-4 h-4 text-[#8A6D32] shrink-0" />
                <span>{prodSuccessMsg}</span>
              </div>
            )}

            <div className="bg-white p-3.5 rounded-xl border border-[#DED8C8]">
              <div className="relative max-w-sm">
                <Search className="w-4 h-4 text-[#5C5852] absolute left-3 top-1/2 -translate-y-1/2" />
                <label htmlFor="admin-product-search" className="sr-only">
                  Search catalog products
                </label>
                <input
                  id="admin-product-search"
                  type="text"
                  value={productQuery}
                  onChange={(e) => setProductQuery(e.target.value)}
                  placeholder="Search products by name or category..."
                  className="w-full pl-9 pr-3 py-2 text-sm rounded-lg border border-[#DED8C8] bg-[#F7F5EE] focus:bg-white focus:outline-none focus:border-[#0F1D32]"
                />
              </div>
            </div>

            <div className="bg-white border border-[#DED8C8] rounded-xl overflow-hidden">
              {filteredProducts.length === 0 ? (
                <div className="p-10 text-center text-sm text-[#5C5852]">
                  No products found. Click "Add Product" to add an item with photos and videos.
                </div>
              ) : (
                <div className="divide-y divide-[#DED8C8]">
                  {filteredProducts.map((product) => {
                    const photoCount = product.media.filter((m) => m.type === 'image').length;
                    const videoCount = product.media.filter((m) => m.type === 'video').length;
                    const firstMedia = product.media[0];
                    const isConfirming = confirmDeleteId === product.id;

                    return (
                      <div
                        key={product.id}
                        className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4 hover:bg-[#F7F5EE]/60 transition-colors"
                      >
                        <div className="flex items-center gap-4 min-w-0">
                          <div className="w-20 h-16 rounded-lg overflow-hidden bg-[#ECE7DA] border border-[#DED8C8] shrink-0">
                            {firstMedia ? (
                              <MediaRenderer
                                url={firstMedia.url}
                                type={firstMedia.type}
                                alt={product.name}
                                controls={false}
                                muted
                                className="w-full h-full object-cover"
                              />
                            ) : (
                              <MediaRenderer url="" type="image" alt={product.name} />
                            )}
                          </div>
                          <div className="min-w-0">
                            <p className="text-[11px] uppercase tracking-wider text-[#8A6D32] font-medium">
                              {product.category} · {photoCount} photo{photoCount === 1 ? '' : 's'}
                              {videoCount > 0 ? ` · ${videoCount} video${videoCount === 1 ? '' : 's'}` : ''}
                            </p>
                            <h3 className="text-base font-semibold text-[#0F1D32] truncate">
                              {product.name}
                            </h3>
                            <p className="text-xs text-[#5C5852] line-clamp-1 mt-0.5">
                              {product.description}
                            </p>
                          </div>
                        </div>

                        <div className="flex items-center justify-between sm:justify-end gap-5 shrink-0">
                          <div className="text-right">
                            <p className="font-mono text-sm font-semibold text-[#0F1D32] tabular-nums">
                              {formatINR(product.price)}
                            </p>
                            <p className="font-mono text-xs text-[#5C5852] tabular-nums">
                              Stock: {product.stock}
                            </p>
                          </div>

                          {isConfirming ? (
                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                disabled={deletingId === product.id}
                                onClick={() => handleDeleteProduct(product.id, product.name)}
                                className="px-3 py-2 text-xs font-medium rounded-lg bg-[#B91C1C] text-white hover:bg-[#991B1B] cursor-pointer whitespace-nowrap"
                              >
                                {deletingId === product.id ? 'Deleting...' : 'Confirm Delete'}
                              </button>
                              <button
                                type="button"
                                onClick={() => setConfirmDeleteId(null)}
                                className="px-3 py-2 text-xs font-medium rounded-lg border border-[#DED8C8] bg-white text-[#0F1D32] cursor-pointer"
                              >
                                Cancel
                              </button>
                            </div>
                          ) : (
                            <button
                              type="button"
                              aria-label={`Delete ${product.name}`}
                              onClick={() => setConfirmDeleteId(product.id)}
                              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border border-[#DED8C8] bg-white text-[#B91C1C] hover:bg-[#FEF2F2] hover:border-[#DC2626]/40 transition-colors cursor-pointer whitespace-nowrap shrink-0"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                              <span>Delete</span>
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}

        {/* CATEGORIES TAB */}
        {activeTab === 'categories' && (
          <div className="space-y-6 max-w-3xl">
            <div>
              <p className="text-xs uppercase tracking-wider text-[#8A6D32] font-semibold">
                Admin / Storefront Organization
              </p>
              <h1 className="text-2xl font-semibold text-[#0F1D32] mt-1">
                Manage Categories ({categories.length})
              </h1>
              <p className="text-sm text-[#5C5852] mt-1">
                Add new categories, rename existing ones across all products, or delete categories you no longer need.
              </p>
            </div>

            {categorySuccess && (
              <div
                role="status"
                className="p-3.5 rounded-lg border border-[#C6A45C]/50 bg-white text-sm text-[#0F1D32] flex items-center gap-2"
              >
                <Check className="w-4 h-4 text-[#8A6D32] shrink-0" />
                <span>{categorySuccess}</span>
              </div>
            )}

            {categoryError && (
              <div
                role="alert"
                className="p-3.5 rounded-lg border border-[#DC2626]/30 bg-[#FEF2F2] text-sm text-[#991B1B]"
              >
                {categoryError}
              </div>
            )}

            <form
              onSubmit={handleAddCategory}
              className="bg-white border border-[#DED8C8] rounded-xl p-4 sm:p-5 flex flex-col sm:flex-row gap-3"
            >
              <div className="flex-1">
                <label htmlFor="new-category-name" className="sr-only">
                  New category name
                </label>
                <input
                  id="new-category-name"
                  type="text"
                  value={newCategoryName}
                  onChange={(e) => {
                    setNewCategoryName(e.target.value);
                    if (categoryError) setCategoryError('');
                  }}
                  placeholder="Enter new category name (e.g. Footwear, Gifts)..."
                  className="w-full px-3.5 py-2.5 text-sm rounded-lg border border-[#DED8C8] bg-[#F7F5EE] focus:bg-white focus:outline-none focus:border-[#0F1D32]"
                />
              </div>
              <button
                type="submit"
                disabled={categoryBusy}
                className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-lg bg-[#C6A45C] text-[#0F1D32] text-sm font-semibold hover:bg-[#B69249] disabled:opacity-50 cursor-pointer whitespace-nowrap shrink-0"
              >
                <Plus className="w-4 h-4" />
                <span>Add Category</span>
              </button>
            </form>

            <div className="bg-white border border-[#DED8C8] rounded-xl overflow-hidden">
              {categories.length === 0 ? (
                <div className="p-8 text-center text-sm text-[#5C5852]">
                  No categories defined yet. Add one above.
                </div>
              ) : (
                <div className="divide-y divide-[#DED8C8]">
                  {categories.map((cat) => {
                    const count = products.filter((p) => p.category === cat).length;
                    const isEditing = editingCategory === cat;
                    const isConfirmingDelete = confirmDeleteCategory === cat;

                    return (
                      <div
                        key={cat}
                        className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 hover:bg-[#F7F5EE]/60 transition-colors"
                      >
                        <div className="flex-1 min-w-0">
                          {isEditing ? (
                            <div className="flex items-center gap-2">
                              <label htmlFor={`edit-cat-${cat}`} className="sr-only">
                                Rename category {cat}
                              </label>
                              <input
                                id={`edit-cat-${cat}`}
                                type="text"
                                value={editingCategoryDraft}
                                onChange={(e) => setEditingCategoryDraft(e.target.value)}
                                className="flex-1 max-w-xs px-3 py-1.5 text-sm rounded-lg border border-[#0F1D32] bg-white focus:outline-none"
                              />
                              <button
                                type="button"
                                disabled={categoryBusy}
                                onClick={() => handleRenameCategory(cat)}
                                className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-[#0F1D32] text-[#F7F5EE] hover:bg-[#172A46] cursor-pointer whitespace-nowrap"
                              >
                                Save
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  setEditingCategory(null);
                                  setEditingCategoryDraft('');
                                  setCategoryError('');
                                }}
                                className="px-3 py-1.5 text-xs font-medium rounded-lg border border-[#DED8C8] bg-white text-[#0F1D32] cursor-pointer"
                              >
                                Cancel
                              </button>
                            </div>
                          ) : (
                            <div className="flex items-center gap-3">
                              <span className="text-sm font-semibold text-[#0F1D32]">{cat}</span>
                              <span className="font-mono text-xs text-[#5C5852] tabular-nums">
                                {count} {count === 1 ? 'product' : 'products'}
                              </span>
                            </div>
                          )}
                        </div>

                        {!isEditing && (
                          <div className="flex items-center gap-2 shrink-0">
                            {isConfirmingDelete ? (
                              <>
                                <button
                                  type="button"
                                  disabled={categoryBusy}
                                  onClick={() => handleDeleteCategory(cat)}
                                  className="px-3 py-1.5 text-xs font-medium rounded-lg bg-[#B91C1C] text-white hover:bg-[#991B1B] cursor-pointer whitespace-nowrap"
                                >
                                  Confirm Delete
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setConfirmDeleteCategory(null)}
                                  className="px-3 py-1.5 text-xs font-medium rounded-lg border border-[#DED8C8] bg-white text-[#0F1D32] cursor-pointer"
                                >
                                  Cancel
                                </button>
                              </>
                            ) : (
                              <>
                                <button
                                  type="button"
                                  aria-label={`Edit category ${cat}`}
                                  onClick={() => {
                                    setConfirmDeleteCategory(null);
                                    setCategoryError('');
                                    setCategorySuccess('');
                                    setEditingCategory(cat);
                                    setEditingCategoryDraft(cat);
                                  }}
                                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-[#DED8C8] bg-white text-[#0F1D32] hover:bg-[#F7F5EE] cursor-pointer whitespace-nowrap"
                                >
                                  <Pencil className="w-3.5 h-3.5" />
                                  <span>Edit</span>
                                </button>
                                <button
                                  type="button"
                                  aria-label={`Delete category ${cat}`}
                                  onClick={() => {
                                    setEditingCategory(null);
                                    setCategoryError('');
                                    setCategorySuccess('');
                                    setConfirmDeleteCategory(cat);
                                  }}
                                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-[#DED8C8] bg-white text-[#B91C1C] hover:bg-[#FEF2F2] hover:border-[#DC2626]/40 cursor-pointer whitespace-nowrap"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                  <span>Delete</span>
                                </button>
                              </>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ADD PRODUCT TAB */}
        {activeTab === 'add-product' && (
          <div className="space-y-6 max-w-3xl">
            <div>
              <p className="text-xs uppercase tracking-wider text-[#8A6D32] font-semibold">
                Admin / New Product
              </p>
              <h1 className="text-2xl font-semibold text-[#0F1D32] mt-1">
                Add Product with Photos &amp; Videos
              </h1>
            </div>

            <form
              onSubmit={handleCreateProduct}
              className="bg-white border border-[#DED8C8] rounded-xl p-6 space-y-5"
            >
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label htmlFor="prod-name" className="block text-xs font-medium text-[#3E4756] mb-1.5">
                    Product Name *
                  </label>
                  <input
                    id="prod-name"
                    type="text"
                    value={prodName}
                    onChange={(e) => setProdName(e.target.value)}
                    placeholder="e.g. Brass Desk Lamp"
                    className="w-full px-3.5 py-2.5 text-sm rounded-lg border border-[#DED8C8] bg-white focus:outline-none focus:border-[#0F1D32]"
                  />
                  {prodErrors.name && (
                    <p className="mt-1 text-xs text-[#B91C1C]">{prodErrors.name}</p>
                  )}
                </div>

                <div>
                  <label htmlFor="prod-category" className="block text-xs font-medium text-[#3E4756] mb-1.5">
                    Category *
                  </label>
                  <select
                    id="prod-category"
                    value={prodCategory}
                    onChange={(e) => setProdCategory(e.target.value)}
                    className="w-full px-3.5 py-2.5 text-sm rounded-lg border border-[#DED8C8] bg-white focus:outline-none focus:border-[#0F1D32]"
                  >
                    {(categories.length > 0 ? categories : ['Home & Living']).map((cat) => (
                      <option key={cat} value={cat}>
                        {cat}
                      </option>
                    ))}
                  </select>
                  {prodErrors.category && (
                    <p className="mt-1 text-xs text-[#B91C1C]">{prodErrors.category}</p>
                  )}
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label htmlFor="prod-price" className="block text-xs font-medium text-[#3E4756] mb-1.5">
                    Price (₹) *
                  </label>
                  <input
                    id="prod-price"
                    type="number"
                    min="1"
                    value={prodPrice}
                    onChange={(e) => setProdPrice(e.target.value)}
                    placeholder="1999"
                    className="w-full px-3.5 py-2.5 text-sm font-mono rounded-lg border border-[#DED8C8] bg-white focus:outline-none focus:border-[#0F1D32]"
                  />
                  {prodErrors.price && (
                    <p className="mt-1 text-xs text-[#B91C1C]">{prodErrors.price}</p>
                  )}
                </div>

                <div>
                  <label htmlFor="prod-stock" className="block text-xs font-medium text-[#3E4756] mb-1.5">
                    Stock Quantity *
                  </label>
                  <input
                    id="prod-stock"
                    type="number"
                    min="0"
                    value={prodStock}
                    onChange={(e) => setProdStock(e.target.value)}
                    className="w-full px-3.5 py-2.5 text-sm font-mono rounded-lg border border-[#DED8C8] bg-white focus:outline-none focus:border-[#0F1D32]"
                  />
                  {prodErrors.stock && (
                    <p className="mt-1 text-xs text-[#B91C1C]">{prodErrors.stock}</p>
                  )}
                </div>
              </div>

              <div>
                <label htmlFor="prod-desc" className="block text-xs font-medium text-[#3E4756] mb-1.5">
                  Product Description *
                </label>
                <textarea
                  id="prod-desc"
                  rows={3}
                  value={prodDescription}
                  onChange={(e) => setProdDescription(e.target.value)}
                  placeholder="Describe material, dimensions, and key features..."
                  className="w-full px-3.5 py-2.5 text-sm rounded-lg border border-[#DED8C8] bg-white focus:outline-none focus:border-[#0F1D32]"
                />
                {prodErrors.description && (
                  <p className="mt-1 text-xs text-[#B91C1C]">{prodErrors.description}</p>
                )}
              </div>

              {/* Photo & Video Upload Section */}
              <div className="pt-2 border-t border-[#DED8C8] space-y-4">
                <div>
                  <h3 className="text-sm font-semibold text-[#0F1D32]">
                    Product Photos &amp; Videos *
                  </h3>
                  <p className="text-xs text-[#5C5852] mt-0.5">
                    Upload image files (JPG, PNG, WebP) and product demo videos (MP4, WebM, MOV), or paste media URLs below.
                  </p>
                </div>

                <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
                  <input
                    ref={fileInputRef}
                    id="prod-media-upload"
                    type="file"
                    accept="image/*,video/*"
                    multiple
                    onChange={handleFileUpload}
                    className="hidden"
                  />
                  <button
                    type="button"
                    disabled={uploadingMedia}
                    onClick={() => fileInputRef.current?.click()}
                    className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg border border-[#0F1D32] text-[#0F1D32] bg-[#F7F5EE] hover:bg-[#ECE7DA] text-sm font-medium transition-colors cursor-pointer whitespace-nowrap"
                  >
                    <Upload className="w-4 h-4" />
                    <span>{uploadingMedia ? 'Uploading...' : 'Upload Photo or Video File'}</span>
                  </button>

                  <div className="flex-1 flex gap-2">
                    <label htmlFor="prod-media-url" className="sr-only">
                      Photo or Video URL
                    </label>
                    <input
                      id="prod-media-url"
                      type="text"
                      value={mediaUrlInput}
                      onChange={(e) => setMediaUrlInput(e.target.value)}
                      placeholder="Or paste photo / video URL (e.g. .jpg or .mp4)"
                      className="flex-1 px-3 py-2 text-xs rounded-lg border border-[#DED8C8] bg-white focus:outline-none focus:border-[#0F1D32]"
                    />
                    <select
                      aria-label="Media URL type"
                      value={mediaUrlType}
                      onChange={(e) =>
                        setMediaUrlType(e.target.value as 'auto' | 'image' | 'video')
                      }
                      className="px-2.5 py-2 text-xs rounded-lg border border-[#DED8C8] bg-[#F7F5EE]"
                    >
                      <option value="auto">Auto</option>
                      <option value="image">Photo</option>
                      <option value="video">Video</option>
                    </select>
                    <button
                      type="button"
                      onClick={handleAddMediaUrl}
                      className="px-3 py-2 text-xs font-medium rounded-lg border border-[#DED8C8] bg-white hover:bg-[#F7F5EE] cursor-pointer whitespace-nowrap"
                    >
                      Add URL
                    </button>
                  </div>
                </div>

                {uploadError && <p className="text-xs text-[#B91C1C]">{uploadError}</p>}
                {prodErrors.media && <p className="text-xs text-[#B91C1C]">{prodErrors.media}</p>}
                {prodErrors.submit && (
                  <p role="alert" className="text-xs text-[#B91C1C] font-medium">
                    {prodErrors.submit}
                  </p>
                )}

                {prodMedia.length > 0 && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2">
                    {prodMedia.map((item) => (
                      <div
                        key={item.id}
                        className="relative rounded-lg border border-[#DED8C8] bg-[#F7F5EE] overflow-hidden"
                      >
                        <div className="aspect-[4/3] w-full bg-[#ECE7DA]">
                          <MediaRenderer
                            url={item.url}
                            type={item.type}
                            alt={item.name || 'Product media'}
                            className="w-full h-full object-cover"
                            controls
                          />
                        </div>
                        <div className="px-3 py-2 flex items-center justify-between gap-2 bg-white border-t border-[#DED8C8] text-xs">
                          <span className="inline-flex items-center gap-1.5 text-[#3E4756] truncate">
                            {item.type === 'video' ? (
                              <Film className="w-3.5 h-3.5 text-[#8A6D32] shrink-0" />
                            ) : (
                              <ImageIcon className="w-3.5 h-3.5 text-[#8A6D32] shrink-0" />
                            )}
                            <span className="truncate">{item.name || item.url}</span>
                          </span>
                          <button
                            type="button"
                            onClick={() =>
                              setProdMedia((prev) => prev.filter((m) => m.id !== item.id))
                            }
                            aria-label={`Remove media ${item.name || item.url}`}
                            className="text-[#B91C1C] hover:underline shrink-0 cursor-pointer"
                          >
                            Remove
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="pt-3 border-t border-[#DED8C8] flex items-center justify-end gap-3">
                <button
                  type="button"
                  onClick={() => onTabChange('products')}
                  className="px-4 py-2.5 text-sm font-medium rounded-lg border border-[#DED8C8] bg-white text-[#0F1D32] hover:bg-[#F7F5EE] cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={prodSaving || uploadingMedia}
                  className="px-5 py-2.5 text-sm font-semibold rounded-lg bg-[#C6A45C] text-[#0F1D32] hover:bg-[#B69249] disabled:opacity-50 transition-colors cursor-pointer"
                >
                  {prodSaving ? 'Publishing...' : 'Publish Product'}
                </button>
              </div>
            </form>
          </div>
        )}

        {/* SETTINGS TAB */}
        {activeTab === 'settings' && (
          <div className="space-y-6 max-w-2xl">
            <div>
              <p className="text-xs uppercase tracking-wider text-[#8A6D32] font-semibold">
                Admin / Configuration
              </p>
              <h1 className="text-2xl font-semibold text-[#0F1D32] mt-1">
                UPI, Firebase RTDB &amp; Store Settings
              </h1>
            </div>

            <form
              onSubmit={handleSaveSettings}
              className="bg-white border border-[#DED8C8] rounded-xl p-6 space-y-5"
            >
              <div className="p-4 rounded-lg bg-[#F7F5EE] border border-[#DED8C8] space-y-2">
                <div className="flex items-center gap-2 text-xs font-semibold text-[#0F1D32]">
                  <Database className="w-4 h-4 text-[#8A6D32]" />
                  <span>Firebase Realtime Database Link</span>
                </div>
                <label htmlFor="set-rtdb-url" className="sr-only">
                  Firebase Realtime Database URL
                </label>
                <input
                  id="set-rtdb-url"
                  type="url"
                  value={setRtdbUrl}
                  onChange={(e) => setSetRtdbUrl(e.target.value)}
                  placeholder="https://your-project-default-rtdb.firebaseio.com"
                  className="w-full px-3.5 py-2.5 text-xs font-mono rounded-lg border border-[#DED8C8] bg-white focus:outline-none focus:border-[#0F1D32]"
                />
                <p className="text-[11px] text-[#5C5852]">
                  Orders, customer delivery addresses, and products sync in real time to{' '}
                  <span className="font-mono">/orders</span> and{' '}
                  <span className="font-mono">/products</span> at this database URL.
                </p>
              </div>

              <div>
                <label htmlFor="set-store-name" className="block text-xs font-medium text-[#3E4756] mb-1.5">
                  Store Name
                </label>
                <input
                  id="set-store-name"
                  type="text"
                  value={setStoreName}
                  onChange={(e) => setSetStoreName(e.target.value)}
                  className="w-full px-3.5 py-2.5 text-sm rounded-lg border border-[#DED8C8] focus:outline-none focus:border-[#0F1D32]"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label htmlFor="set-upi-id" className="block text-xs font-medium text-[#3E4756] mb-1.5">
                    Merchant UPI ID (shown at checkout)
                  </label>
                  <input
                    id="set-upi-id"
                    type="text"
                    value={setUpiId}
                    onChange={(e) => setSetUpiId(e.target.value)}
                    placeholder="skiend@axl"
                    className="w-full px-3.5 py-2.5 text-sm font-mono rounded-lg border border-[#DED8C8] focus:outline-none focus:border-[#0F1D32]"
                  />
                </div>
                <div>
                  <label htmlFor="set-merchant-name" className="block text-xs font-medium text-[#3E4756] mb-1.5">
                    UPI Merchant Display Name
                  </label>
                  <input
                    id="set-merchant-name"
                    type="text"
                    value={setMerchantName}
                    onChange={(e) => setSetMerchantName(e.target.value)}
                    className="w-full px-3.5 py-2.5 text-sm rounded-lg border border-[#DED8C8] focus:outline-none focus:border-[#0F1D32]"
                  />
                </div>
              </div>

              <div className="p-4 rounded-lg bg-[#F7F5EE] border border-[#DED8C8] flex flex-col sm:flex-row items-start sm:items-center gap-4">
                <div
                  className={`w-20 h-20 rounded-lg overflow-hidden border border-[#DED8C8] shrink-0 ${
                    (setUpiQrUrl || '').includes('47084_35196505') ? 'bg-white' : 'bg-black'
                  }`}
                >
                  <img
                    src={setUpiQrUrl || '/assets/aistudio/47084_f56d5f0a.jpg'}
                    alt="Merchant UPI QR Barcode"
                    className={
                      (setUpiQrUrl || '').includes('47084_35196505')
                        ? 'w-full h-full object-cover object-[50%_52%] scale-[1.28]'
                        : 'w-full h-full object-contain p-1'
                    }
                  />
                </div>
                <div className="flex-1 w-full space-y-1.5">
                  <label htmlFor="set-upi-qr-url" className="block text-xs font-semibold text-[#0F1D32]">
                    UPI QR Barcode Image URL
                  </label>
                  <input
                    id="set-upi-qr-url"
                    type="text"
                    value={setUpiQrUrl}
                    onChange={(e) => setSetUpiQrUrl(e.target.value)}
                    placeholder="/assets/aistudio/47084_f56d5f0a.jpg"
                    className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-[#DED8C8] bg-white focus:outline-none focus:border-[#0F1D32]"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label htmlFor="set-threshold" className="block text-xs font-medium text-[#3E4756] mb-1.5">
                    Free Shipping Threshold (₹)
                  </label>
                  <input
                    id="set-threshold"
                    type="number"
                    min="0"
                    value={setFreeThreshold}
                    onChange={(e) => setSetFreeThreshold(e.target.value)}
                    className="w-full px-3.5 py-2.5 text-sm font-mono rounded-lg border border-[#DED8C8] focus:outline-none focus:border-[#0F1D32]"
                  />
                </div>
                <div>
                  <label htmlFor="set-shipping" className="block text-xs font-medium text-[#3E4756] mb-1.5">
                    Standard Delivery Fee (₹)
                  </label>
                  <input
                    id="set-shipping"
                    type="number"
                    min="0"
                    value={setShippingFee}
                    onChange={(e) => setSetShippingFee(e.target.value)}
                    className="w-full px-3.5 py-2.5 text-sm font-mono rounded-lg border border-[#DED8C8] focus:outline-none focus:border-[#0F1D32]"
                  />
                </div>
              </div>

              <div className="pt-3 border-t border-[#DED8C8] flex items-center justify-between gap-3">
                <span className="text-xs font-semibold">
                  {settingsError ? (
                    <span className="text-[#B91C1C]">{settingsError}</span>
                  ) : settingsSaved ? (
                    <span className="text-[#8A6D32]">Settings saved &amp; synced to Firebase RTDB.</span>
                  ) : null}
                </span>
                <button
                  type="submit"
                  disabled={settingsSaving}
                  className="px-5 py-2.5 text-sm font-semibold rounded-lg bg-[#C6A45C] text-[#0F1D32] hover:bg-[#B69249] disabled:opacity-50 cursor-pointer"
                >
                  {settingsSaving ? 'Saving...' : 'Save Settings'}
                </button>
              </div>
            </form>
          </div>
        )}
      </main>

      {/* Order Detail Drawer */}
      {selectedOrder && (
        <div
          className="fixed inset-0 z-50 flex justify-end bg-[#091322]/65 backdrop-blur-xs"
          role="dialog"
          aria-modal="true"
          aria-label={`Details for order ${selectedOrder.orderNumber}`}
          onClick={() => onSelectedOrderIdChange(null)}
        >
          <div
            className="w-full max-w-lg bg-white h-full border-l border-[#DED8C8] flex flex-col shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-6 py-4 bg-[#0F1D32] text-[#F7F5EE] border-b border-[#223654] flex items-center justify-between">
              <div>
                <p className="text-xs font-mono text-[#C6A45C]">
                  {formatOrderDateTime(selectedOrder.createdAt).full}
                </p>
                <h3 className="text-lg font-mono font-semibold text-[#F7F5EE]">
                  {selectedOrder.orderNumber}
                </h3>
              </div>
              <button
                type="button"
                onClick={() => onSelectedOrderIdChange(null)}
                aria-label="Close order details"
                className="w-9 h-9 inline-flex items-center justify-center rounded-lg border border-[#223654] bg-[#172A46] text-[#F7F5EE] cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-6 flex-1 overflow-y-auto space-y-5 text-sm">
              <div className="p-4 rounded-lg bg-[#F7F5EE] border border-[#DED8C8] space-y-1">
                <p className="text-xs uppercase tracking-wider text-[#8A6D32] font-semibold">
                  Customer &amp; Delivery Address
                </p>
                <p className="font-semibold text-[#0F1D32]">{selectedOrder.customerName}</p>
                <p className="font-mono text-xs text-[#3E4756]">
                  Phone: {selectedOrder.customerPhone}
                </p>
                <p className="text-[#3E4756] pt-1">{selectedOrder.address}</p>
                <p className="text-[#3E4756]">
                  {selectedOrder.city} — {selectedOrder.pincode}
                </p>
              </div>

              <div className="p-4 rounded-lg bg-[#F7F5EE] border border-[#DED8C8] space-y-1.5">
                <p className="text-xs uppercase tracking-wider text-[#8A6D32] font-semibold">
                  Payment Details
                </p>
                <p className="font-medium text-[#0F1D32]">
                  {selectedOrder.paymentMethod === 'COD'
                    ? 'Cash on Delivery (COD)'
                    : 'UPI Payment'}
                </p>
                {selectedOrder.upiTransactionId && (
                  <p className="font-mono text-xs text-[#3E4756]">
                    UTR / Transaction ID: {selectedOrder.upiTransactionId}
                  </p>
                )}
                {selectedOrder.upiCustomerId && (
                  <p className="font-mono text-xs text-[#3E4756]">
                    Customer UPI ID: {selectedOrder.upiCustomerId}
                  </p>
                )}
              </div>

              <div className="space-y-2">
                <p className="text-xs uppercase tracking-wider text-[#8A6D32] font-semibold">
                  Ordered Items
                </p>
                <div className="border border-[#DED8C8] rounded-lg divide-y divide-[#DED8C8]">
                  {selectedOrder.items.map((item) => (
                    <div key={item.productId} className="p-3 flex items-center justify-between gap-3">
                      <div className="flex items-center gap-3">
                        <div className="w-11 h-11 rounded overflow-hidden border border-[#DED8C8] bg-[#F7F5EE] shrink-0">
                          <MediaRenderer url={item.imageUrl} type="image" alt={item.name} />
                        </div>
                        <div>
                          <p className="font-medium text-[#0F1D32]">{item.name}</p>
                          <p className="text-xs font-mono text-[#5C5852]">
                            {item.quantity} × {formatINR(item.price)}
                          </p>
                        </div>
                      </div>
                      <p className="font-mono font-semibold text-[#0F1D32] tabular-nums">
                        {formatINR(item.price * item.quantity)}
                      </p>
                    </div>
                  ))}
                </div>
              </div>

              <div className="pt-3 border-t border-[#DED8C8] space-y-1.5">
                <div className="flex justify-between text-[#5C5852]">
                  <span>Subtotal</span>
                  <span className="font-mono text-[#0F1D32] tabular-nums">
                    {formatINR(selectedOrder.subtotal)}
                  </span>
                </div>
                <div className="flex justify-between text-[#5C5852]">
                  <span>Delivery</span>
                  <span className="font-mono text-[#0F1D32] tabular-nums">
                    {selectedOrder.shippingFee === 0
                      ? 'FREE'
                      : formatINR(selectedOrder.shippingFee)}
                  </span>
                </div>
                <div className="flex justify-between font-semibold text-base text-[#0F1D32] pt-1">
                  <span>Total</span>
                  <span className="font-mono tabular-nums">{formatINR(selectedOrder.total)}</span>
                </div>
              </div>
            </div>

            <div className="px-6 py-4 border-t border-[#DED8C8] bg-[#F7F5EE] flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <label htmlFor="drawer-order-status" className="text-xs font-medium text-[#5C5852]">
                  Status:
                </label>
                <select
                  id="drawer-order-status"
                  value={selectedOrder.status}
                  onChange={(e) =>
                    handleStatusChange(selectedOrder.id, e.target.value as OrderStatus)
                  }
                  className="px-2.5 py-1.5 text-xs font-medium rounded-md border border-[#DED8C8] bg-white text-[#0F1D32]"
                >
                  {ORDER_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex items-center gap-2">
                {confirmDeleteOrderId === selectedOrder.id ? (
                  <>
                    <button
                      type="button"
                      disabled={deletingOrderId === selectedOrder.id}
                      onClick={() => handleDeleteOrder(selectedOrder.id, selectedOrder.orderNumber)}
                      className="px-3 py-1.5 text-xs font-semibold rounded-md bg-[#B91C1C] text-white disabled:opacity-50 cursor-pointer"
                    >
                      {deletingOrderId === selectedOrder.id ? 'Deleting...' : 'Confirm Delete'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmDeleteOrderId(null)}
                      className="px-3 py-1.5 text-xs rounded-md border border-[#DED8C8] bg-white text-[#3E4756] cursor-pointer"
                    >
                      Cancel
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={() => setConfirmDeleteOrderId(selectedOrder.id)}
                    aria-label={`Delete order ${selectedOrder.orderNumber} from drawer`}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border border-[#DC2626]/40 bg-white text-[#B91C1C] hover:bg-[#FEF2F2] cursor-pointer"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    <span>Delete Order</span>
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
