import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  Check,
  ClipboardList,
  Copy,
  Download,
  Film,
  Pin,
  Search,
  Send,
  ShoppingBag,
  X,
  Zap,
} from 'lucide-react';
import { AdminPanel, type AdminTab } from './components/AdminPanel';
import { AdminPasswordModal } from './components/AdminPasswordModal';
import { BantuuLogo } from './components/BantuuLogo';
import { CartDrawer } from './components/CartDrawer';
import { CheckoutModal } from './components/CheckoutModal';
import { MediaRenderer } from './components/MediaRenderer';
import { ProductDetailModal } from './components/ProductDetailModal';
import { TrackOrderModal } from './components/TrackOrderModal';
import {
  calculateCartTotals,
  calculateOriginalMrp,
  DEFAULT_PROMISE_COPY,
  DEFAULT_STORE_HOURS,
  filterProducts,
  formatINR,
  getPrimaryProductImage,
  normalizeDiscountPercent,
  sanitizeCartWithCatalog,
  type CartItem,
  type Order,
  type Product,
  type StoreSettings,
} from './utils/storeLogic';
import { adminFetch, clearAdminSessionToken } from './utils/adminClientAuth';
import { registerNotificationServiceWorker } from './utils/adminAlerts';
import { useScrollLock } from './utils/useScrollLock';

const CART_STORAGE_KEY = 'bantuu_store_cart_v1';
const ORDERS_STORAGE_KEY = 'bantuu_customer_orders_v1';
const ADMIN_STAY_IN_PANEL_KEY = 'bantuu_admin_active_view';

type StoreOverlay = 'detail' | 'cart' | 'checkout' | 'track' | 'admin-password' | null;

interface BantuuHistoryState {
  bantuuApp: true;
  view: 'store' | 'admin';
  overlay: StoreOverlay;
  productId: string | null;
  adminTab: AdminTab;
  adminOrderId: string | null;
}

const DEFAULT_SETTINGS: StoreSettings = {
  storeName: 'Bantuu Store',
  storeHours: DEFAULT_STORE_HOURS,
  upiId: 'Q605265018@ybl',
  upiQrUrl: '/assets/aistudio/47084_f56d5f0a.jpg',
  merchantName: 'Banti Mahto',
  freeShippingThreshold: 999,
  shippingFee: 79,
  ...DEFAULT_PROMISE_COPY,
};

const DEFAULT_CATEGORIES = [
  'Home & Living',
  'Carry & Leather',
  'Watches',
  'Audio',
  'Apparel',
  'Accessories',
];

function readInitialAdminUrlFlag(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    window.location.pathname === '/admin' ||
    window.location.hash === '#admin' ||
    new URLSearchParams(window.location.search).get('mode') === 'admin'
  );
}

function readStayInAdminView(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return localStorage.getItem(ADMIN_STAY_IN_PANEL_KEY) === '1';
  } catch {
    return false;
  }
}

function saveStayInAdminView(stay: boolean) {
  if (typeof window === 'undefined') return;
  try {
    if (stay) {
      localStorage.setItem(ADMIN_STAY_IN_PANEL_KEY, '1');
    } else {
      localStorage.removeItem(ADMIN_STAY_IN_PANEL_KEY);
    }
  } catch {
    // ignore storage errors
  }
}

function getStoreBaseUrl(): string {
  if (typeof window === 'undefined') return '/';
  const pathname = window.location.pathname === '/admin' ? '/' : window.location.pathname || '/';
  return `${pathname}${window.location.search || ''}`;
}

export default function App() {
  const [isAdminMode, setIsAdminMode] = useState<boolean>(
    () => readInitialAdminUrlFlag() || readStayInAdminView(),
  );
  const [checkingAdminSession, setCheckingAdminSession] = useState<boolean>(
    () => readInitialAdminUrlFlag() || readStayInAdminView(),
  );
  const [isAdminAuthenticated, setIsAdminAuthenticated] = useState(false);
  const [isPasswordModalOpen, setIsPasswordModalOpen] = useState(false);
  const [adminTab, setAdminTab] = useState<AdminTab>(() => {
    if (typeof window !== 'undefined' && window.history.state?.bantuuApp) {
      return (window.history.state as BantuuHistoryState).adminTab || 'orders';
    }
    return 'orders';
  });
  const [adminSelectedOrderId, setAdminSelectedOrderId] = useState<string | null>(() => {
    if (typeof window !== 'undefined' && window.history.state?.bantuuApp) {
      return (window.history.state as BantuuHistoryState).adminOrderId || null;
    }
    return null;
  });

  const [products, setProducts] = useState<Product[]>([]);
  const [storeCategories, setStoreCategories] = useState<string[]>(DEFAULT_CATEGORIES);
  const [settings, setSettings] = useState<StoreSettings>(DEFAULT_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  // Storefront filters
  const [selectedCategory, setSelectedCategory] = useState('All');
  const [searchQuery, setSearchQuery] = useState('');

  // Customer orders placed from this browser (persisted in localStorage)
  const [customerOrders, setCustomerOrders] = useState<Order[]>(() => {
    try {
      const saved = localStorage.getItem(ORDERS_STORAGE_KEY);
      return saved ? (JSON.parse(saved) as Order[]) : [];
    } catch {
      return [];
    }
  });

  // Cart state (persisted in localStorage)
  const [cart, setCart] = useState<CartItem[]>(() => {
    try {
      const saved = localStorage.getItem(CART_STORAGE_KEY);
      return saved ? (JSON.parse(saved) as CartItem[]) : [];
    } catch {
      return [];
    }
  });
  const [isCartOpen, setIsCartOpen] = useState(false);
  const [addedCardId, setAddedCardId] = useState<string | null>(null);

  // Modals
  const [detailProduct, setDetailProduct] = useState<Product | null>(null);
  const [checkoutState, setCheckoutState] = useState<{
    isOpen: boolean;
    items: CartItem[];
    modeLabel: string;
    clearCartOnSuccess: boolean;
  }>({
    isOpen: false,
    items: [],
    modeLabel: 'Checkout',
    clearCartOnSuccess: false,
  });
  const [isTrackOpen, setIsTrackOpen] = useState(false);
  const [webViewLinkModal, setWebViewLinkModal] = useState<'telegram' | 'apk' | null>(null);
  const [copiedSupportKey, setCopiedSupportKey] = useState<string | null>(null);

  const isAndroidWebView =
    typeof navigator !== 'undefined' &&
    /\bwv\b|Android.*Version\/[\d.]+/i.test(navigator.userAgent);

  const hasActiveModal = Boolean(
    !(isAdminMode && isAdminAuthenticated) &&
      (detailProduct ||
        isCartOpen ||
        checkoutState.isOpen ||
        isTrackOpen ||
        isPasswordModalOpen ||
        webViewLinkModal),
  );
  useScrollLock(hasActiveModal);

  const productsRef = useRef<Product[]>(products);
  productsRef.current = products;
  const isAdminAuthenticatedRef = useRef<boolean>(isAdminAuthenticated);
  isAdminAuthenticatedRef.current = isAdminAuthenticated;
  const checkoutCompletedRef = useRef(false);

  const pushHistoryEntry = useCallback(
    (next: Omit<BantuuHistoryState, 'bantuuApp'>, url?: string) => {
      if (typeof window === 'undefined') return;
      try {
        const payload: BantuuHistoryState = { bantuuApp: true, ...next };
        const targetUrl =
          url ?? (next.view === 'admin' ? `${getStoreBaseUrl()}#admin` : getStoreBaseUrl());
        window.history.pushState(payload, '', targetUrl);
      } catch {
        // ignore restricted history API errors
      }
    },
    [],
  );

  const replaceHistoryEntry = useCallback(
    (next: Omit<BantuuHistoryState, 'bantuuApp'>, url?: string) => {
      if (typeof window === 'undefined') return;
      try {
        const payload: BantuuHistoryState = { bantuuApp: true, ...next };
        const targetUrl =
          url ?? (next.view === 'admin' ? `${getStoreBaseUrl()}#admin` : getStoreBaseUrl());
        window.history.replaceState(payload, '', targetUrl);
      } catch {
        // ignore restricted history API errors
      }
    },
    [],
  );

  const loadStore = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setLoadError('');
    try {
      const res = await fetch('/api/store', { credentials: 'include' });
      if (!res.ok) throw new Error('Failed to load store');
      const data = await res.json();
      const loadedProducts: Product[] = Array.isArray(data.products) ? data.products : [];
      setProducts(loadedProducts);
      setCart((prev) => sanitizeCartWithCatalog(prev, loadedProducts));
      if (Array.isArray(data.categories)) setStoreCategories(data.categories);
      if (data.settings) setSettings(data.settings);
    } catch {
      if (!silent) setLoadError('Unable to load Bantuu Store catalog right now.');
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadStore();
    void registerNotificationServiceWorker();
  }, [loadStore]);

  // Verify existing server-side admin cookie or Bearer session when visiting #admin, reloading, or triggering bantuustore
  const checkAdminSessionAndPrompt = useCallback(
    async (options?: { autoOpenPrompt?: boolean; restorePanelIfValid?: boolean }) => {
      const autoOpenPrompt = options?.autoOpenPrompt ?? true;
      const restorePanelIfValid = options?.restorePanelIfValid ?? true;
      try {
        const res = await adminFetch('/api/admin/session');
        const data = await res.json();
        if (res.ok && data?.authenticated) {
          setIsAdminAuthenticated(true);
          isAdminAuthenticatedRef.current = true;
          if (restorePanelIfValid) {
            saveStayInAdminView(true);
            setIsAdminMode(true);
            setIsPasswordModalOpen(false);
            if (
              typeof window !== 'undefined' &&
              window.history.state?.view !== 'admin'
            ) {
              pushHistoryEntry(
                {
                  view: 'admin',
                  overlay: null,
                  productId: null,
                  adminTab: 'orders',
                  adminOrderId: null,
                },
                `${getStoreBaseUrl()}#admin`,
              );
            }
          }
          setCheckingAdminSession(false);
          return true;
        }
      } catch {
        // fall through to unauthenticated handling
      }

      clearAdminSessionToken();
      setIsAdminAuthenticated(false);
      isAdminAuthenticatedRef.current = false;
      saveStayInAdminView(false);
      setCheckingAdminSession(false);

      if (autoOpenPrompt) {
        setIsAdminMode(readInitialAdminUrlFlag());
        setIsPasswordModalOpen(true);
        if (
          typeof window !== 'undefined' &&
          !readInitialAdminUrlFlag() &&
          window.history.state?.overlay !== 'admin-password'
        ) {
          pushHistoryEntry(
            {
              view: 'store',
              overlay: 'admin-password',
              productId: null,
              adminTab: 'orders',
              adminOrderId: null,
            },
            getStoreBaseUrl(),
          );
        }
      } else {
        setIsAdminMode(false);
        setIsPasswordModalOpen(false);
      }
      return false;
    },
    [pushHistoryEntry],
  );

  // Restore admin login state seamlessly across reloads until explicit Logout
  useEffect(() => {
    const wantsAdminUrl = readInitialAdminUrlFlag();
    const wantsStayAdmin = readStayInAdminView();

    if (typeof window !== 'undefined' && !window.history.state?.bantuuApp) {
      replaceHistoryEntry(
        {
          view: wantsAdminUrl ? 'admin' : 'store',
          overlay: null,
          productId: null,
          adminTab: 'orders',
          adminOrderId: null,
        },
        wantsAdminUrl ? `${getStoreBaseUrl()}#admin` : getStoreBaseUrl(),
      );
    }

    if (wantsAdminUrl || wantsStayAdmin) {
      checkAdminSessionAndPrompt({
        autoOpenPrompt: wantsAdminUrl,
        restorePanelIfValid: true,
      });
    } else {
      // Silently pre-warm auth flag so searching `bantuustore` after going back to storefront opens Admin right away
      checkAdminSessionAndPrompt({
        autoOpenPrompt: false,
        restorePanelIfValid: false,
      });
    }
  }, [checkAdminSessionAndPrompt, replaceHistoryEntry]);

  // Refresh public storefront catalog silently on focus and gentle polling (no client RTDB exposure)
  useEffect(() => {
    if (isAdminMode) return;
    const onFocus = () => loadStore(true);
    window.addEventListener('focus', onFocus);
    const interval = window.setInterval(() => loadStore(true), 15000);
    return () => {
      window.removeEventListener('focus', onFocus);
      window.clearInterval(interval);
    };
  }, [isAdminMode, loadStore]);

  useEffect(() => {
    try {
      localStorage.setItem(CART_STORAGE_KEY, JSON.stringify(cart));
    } catch {
      // ignore storage quota failures
    }
  }, [cart]);

  useEffect(() => {
    try {
      localStorage.setItem(ORDERS_STORAGE_KEY, JSON.stringify(customerOrders));
    } catch {
      // ignore storage quota failures
    }
  }, [customerOrders]);

  // Unified 1-step-at-a-time browser Back/Forward navigation across Storefront overlays & Admin views
  useEffect(() => {
    const handlePopState = (event: PopStateEvent) => {
      const state = event.state as BantuuHistoryState | null;

      if (state?.bantuuApp) {
        if (state.view === 'admin') {
          if (isAdminAuthenticatedRef.current) {
            saveStayInAdminView(true);
            setIsAdminMode(true);
            setIsPasswordModalOpen(false);
            setAdminTab(state.adminTab || 'orders');
            setAdminSelectedOrderId(state.adminOrderId || null);
          } else {
            checkAdminSessionAndPrompt({ autoOpenPrompt: true, restorePanelIfValid: true });
          }
          return;
        }

        // Returned to Storefront view (does NOT log out admin session!)
        saveStayInAdminView(false);
        setIsAdminMode(false);
        setAdminTab('orders');
        setAdminSelectedOrderId(null);

        setIsPasswordModalOpen(state.overlay === 'admin-password');
        setIsCartOpen(state.overlay === 'cart');
        setIsTrackOpen(state.overlay === 'track');

        if (state.overlay === 'detail' && state.productId) {
          const found = productsRef.current.find((p) => p.id === state.productId) || null;
          setDetailProduct(found);
        } else {
          setDetailProduct(null);
        }

        if (state.overlay !== 'checkout') {
          setCheckoutState((prev) => ({ ...prev, isOpen: false }));
        } else {
          setCheckoutState((prev) => (prev.items.length > 0 ? { ...prev, isOpen: true } : prev));
        }
        return;
      }

      // Fallback when browser pops to an untagged URL state
      if (readInitialAdminUrlFlag()) {
        checkAdminSessionAndPrompt({ autoOpenPrompt: true, restorePanelIfValid: true });
      } else {
        saveStayInAdminView(false);
        setIsAdminMode(false);
        setAdminTab('orders');
        setAdminSelectedOrderId(null);
        setDetailProduct(null);
        setIsCartOpen(false);
        setIsTrackOpen(false);
        setIsPasswordModalOpen(false);
        setCheckoutState((prev) => ({ ...prev, isOpen: false }));
      }
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [checkAdminSessionAndPrompt]);

  const enterAdminMode = () => {
    setIsAdminAuthenticated(true);
    isAdminAuthenticatedRef.current = true;
    saveStayInAdminView(true);
    setIsAdminMode(true);
    setIsPasswordModalOpen(false);
    setAdminTab('orders');
    setAdminSelectedOrderId(null);

    const curState = window.history.state as BantuuHistoryState | null;
    const adminPayload: Omit<BantuuHistoryState, 'bantuuApp'> = {
      view: 'admin',
      overlay: null,
      productId: null,
      adminTab: 'orders',
      adminOrderId: null,
    };

    if (curState?.overlay === 'admin-password' || window.location.hash === '#admin') {
      // Replace the password modal entry so 1 Back click goes cleanly to Storefront '/'
      replaceHistoryEntry(adminPayload, `${getStoreBaseUrl()}#admin`);
    } else {
      pushHistoryEntry(adminPayload, `${getStoreBaseUrl()}#admin`);
    }
    window.scrollTo({ top: 0 });
  };

  // Navigate back to Storefront WITHOUT logging out admin session
  const handleBackToStorefront = useCallback(() => {
    saveStayInAdminView(false);
    setIsAdminMode(false);
    setAdminTab('orders');
    setAdminSelectedOrderId(null);
    setIsPasswordModalOpen(false);
    replaceHistoryEntry(
      {
        view: 'store',
        overlay: null,
        productId: null,
        adminTab: 'orders',
        adminOrderId: null,
      },
      getStoreBaseUrl(),
    );
    loadStore(true);
    window.scrollTo({ top: 0 });
  }, [loadStore, replaceHistoryEntry]);

  // Explicit Logout: clears server session cookie, Bearer token & client auth completely
  const handleLogoutAdmin = useCallback(() => {
    adminFetch('/api/admin/logout', { method: 'POST' }).catch(() => undefined);
    clearAdminSessionToken();
    saveStayInAdminView(false);
    setIsAdminMode(false);
    setIsAdminAuthenticated(false);
    isAdminAuthenticatedRef.current = false;
    setIsPasswordModalOpen(false);
    setAdminTab('orders');
    setAdminSelectedOrderId(null);
    replaceHistoryEntry(
      {
        view: 'store',
        overlay: null,
        productId: null,
        adminTab: 'orders',
        adminOrderId: null,
      },
      getStoreBaseUrl(),
    );
    loadStore(true);
    window.scrollTo({ top: 0 });
  }, [loadStore, replaceHistoryEntry]);

  const handleAdminSessionExpired = useCallback(() => {
    clearAdminSessionToken();
    setIsAdminAuthenticated(false);
    isAdminAuthenticatedRef.current = false;
    saveStayInAdminView(false);
    setIsPasswordModalOpen(true);
  }, []);

  const handleAdminTabChange = useCallback(
    (nextTab: AdminTab) => {
      if (nextTab === adminTab && !adminSelectedOrderId) return;
      setAdminSelectedOrderId(null);
      setAdminTab(nextTab);
      pushHistoryEntry(
        {
          view: 'admin',
          overlay: null,
          productId: null,
          adminTab: nextTab,
          adminOrderId: null,
        },
        `${getStoreBaseUrl()}#admin`,
      );
      window.scrollTo({ top: 0 });
    },
    [adminSelectedOrderId, adminTab, pushHistoryEntry],
  );

  const handleAdminOrderSelection = useCallback(
    (nextOrderId: string | null) => {
      if (nextOrderId) {
        setAdminSelectedOrderId(nextOrderId);
        pushHistoryEntry(
          {
            view: 'admin',
            overlay: null,
            productId: null,
            adminTab,
            adminOrderId: nextOrderId,
          },
          `${getStoreBaseUrl()}#admin`,
        );
      } else {
        const curState = window.history.state as BantuuHistoryState | null;
        if (curState?.bantuuApp && curState.adminOrderId) {
          window.history.back();
        } else {
          setAdminSelectedOrderId(null);
        }
      }
    },
    [adminTab, pushHistoryEntry],
  );

  const handleCategoriesUpdated = useCallback(
    (nextCategories: string[], nextProducts?: Product[]) => {
      setStoreCategories(nextCategories);
      if (Array.isArray(nextProducts)) {
        setProducts(nextProducts);
      }
    },
    [],
  );

  const handleCatalogSearchSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = searchQuery.trim();
    if (!trimmed) return;
    try {
      const res = await fetch('/api/admin/trigger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ query: trimmed }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data?.triggered) {
          setSearchQuery('');
          await checkAdminSessionAndPrompt({
            autoOpenPrompt: true,
            restorePanelIfValid: true,
          });
        }
      }
    } catch {
      // ignore search trigger network errors so regular search keeps working
    }
  };

  const categories = useMemo(() => {
    const combined = Array.from(
      new Set([
        ...storeCategories,
        ...products.map((p) => p.category).filter(Boolean),
      ]),
    );
    return ['All', ...combined];
  }, [storeCategories, products]);

  useEffect(() => {
    if (selectedCategory !== 'All' && !categories.includes(selectedCategory)) {
      setSelectedCategory('All');
    }
  }, [categories, selectedCategory]);

  const visibleProducts = useMemo(
    () => filterProducts(products, selectedCategory, searchQuery),
    [products, selectedCategory, searchQuery],
  );

  const cartTotals = useMemo(
    () => calculateCartTotals(cart, settings.freeShippingThreshold, settings.shippingFee),
    [cart, settings.freeShippingThreshold, settings.shippingFee],
  );

  const openDetailModal = (product: Product) => {
    setDetailProduct(product);
    pushHistoryEntry(
      {
        view: 'store',
        overlay: 'detail',
        productId: product.id,
        adminTab: 'orders',
        adminOrderId: null,
      },
      getStoreBaseUrl(),
    );
  };

  const closeDetailModal = () => {
    const curState = window.history.state as BantuuHistoryState | null;
    if (curState?.bantuuApp && curState.overlay === 'detail') {
      window.history.back();
    } else {
      setDetailProduct(null);
    }
  };

  const openCartDrawer = () => {
    setIsCartOpen(true);
    pushHistoryEntry(
      {
        view: 'store',
        overlay: 'cart',
        productId: null,
        adminTab: 'orders',
        adminOrderId: null,
      },
      getStoreBaseUrl(),
    );
  };

  const closeCartDrawer = () => {
    const curState = window.history.state as BantuuHistoryState | null;
    if (curState?.bantuuApp && curState.overlay === 'cart') {
      window.history.back();
    } else {
      setIsCartOpen(false);
    }
  };

  const openTrackModal = () => {
    setIsTrackOpen(true);
    pushHistoryEntry(
      {
        view: 'store',
        overlay: 'track',
        productId: null,
        adminTab: 'orders',
        adminOrderId: null,
      },
      getStoreBaseUrl(),
    );
  };

  const closeTrackModal = () => {
    const curState = window.history.state as BantuuHistoryState | null;
    if (curState?.bantuuApp && curState.overlay === 'track') {
      window.history.back();
    } else {
      setIsTrackOpen(false);
    }
  };

  const closeCheckoutModal = () => {
    if (checkoutCompletedRef.current) {
      checkoutCompletedRef.current = false;
      setCheckoutState((prev) => ({ ...prev, isOpen: false }));
      setIsCartOpen(false);
      setDetailProduct(null);
      replaceHistoryEntry(
        {
          view: 'store',
          overlay: null,
          productId: null,
          adminTab: 'orders',
          adminOrderId: null,
        },
        getStoreBaseUrl(),
      );
      return;
    }

    const curState = window.history.state as BantuuHistoryState | null;
    if (curState?.bantuuApp && curState.overlay === 'checkout') {
      window.history.back();
    } else {
      setCheckoutState((prev) => ({ ...prev, isOpen: false }));
    }
  };

  const closePasswordModal = () => {
    const curState = window.history.state as BantuuHistoryState | null;
    if (curState?.bantuuApp && curState.overlay === 'admin-password') {
      window.history.back();
      return;
    }
    setIsPasswordModalOpen(false);
    if (isAdminMode && !isAdminAuthenticated) {
      handleBackToStorefront();
    }
  };

  const handleAddToCart = (product: Product, quantity = 1) => {
    if (product.stock <= 0) return;
    const imgUrl = getPrimaryProductImage(product);

    setCart((prev) => {
      const existing = prev.find((i) => i.productId === product.id);
      if (existing) {
        return prev.map((i) =>
          i.productId === product.id
            ? { ...i, quantity: Math.min(product.stock, i.quantity + quantity) }
            : i,
        );
      }
      return [
        ...prev,
        {
          productId: product.id,
          name: product.name,
          price: product.price,
          quantity: Math.min(product.stock, quantity),
          imageUrl: imgUrl,
          category: product.category,
        },
      ];
    });

    setAddedCardId(product.id);
    window.setTimeout(() => {
      setAddedCardId((curr) => (curr === product.id ? null : curr));
    }, 1500);
  };

  const handleBuyNow = (product: Product, quantity = 1) => {
    if (product.stock <= 0) return;
    checkoutCompletedRef.current = false;
    setDetailProduct(null);
    setIsCartOpen(false);
    setCheckoutState({
      isOpen: true,
      items: [
        {
          productId: product.id,
          name: product.name,
          price: product.price,
          quantity: Math.min(product.stock, quantity),
          imageUrl: getPrimaryProductImage(product),
          category: product.category,
        },
      ],
      modeLabel: 'Express Buy Now',
      clearCartOnSuccess: false,
    });
    pushHistoryEntry(
      {
        view: 'store',
        overlay: 'checkout',
        productId: product.id,
        adminTab: 'orders',
        adminOrderId: null,
      },
      getStoreBaseUrl(),
    );
  };

  const handleCartCheckout = () => {
    const authoritativeItems = sanitizeCartWithCatalog(cart, products);
    setCart(authoritativeItems);
    if (authoritativeItems.length === 0) return;
    checkoutCompletedRef.current = false;
    setIsCartOpen(false);
    setCheckoutState({
      isOpen: true,
      items: authoritativeItems,
      modeLabel: 'Bag Checkout',
      clearCartOnSuccess: true,
    });
    pushHistoryEntry(
      {
        view: 'store',
        overlay: 'checkout',
        productId: null,
        adminTab: 'orders',
        adminOrderId: null,
      },
      getStoreBaseUrl(),
    );
  };

  const handleUpdateCartQuantity = (productId: string, nextQty: number) => {
    if (nextQty <= 0) {
      setCart((prev) => prev.filter((i) => i.productId !== productId));
      return;
    }
    const catalogProd = products.find((p) => p.id === productId);
    const maxStock = catalogProd ? catalogProd.stock : 99;
    setCart((prev) =>
      prev.map((i) =>
        i.productId === productId ? { ...i, quantity: Math.min(maxStock, nextQty) } : i,
      ),
    );
  };

  const handleOrderCreated = (order: Order) => {
    checkoutCompletedRef.current = true;
    setCustomerOrders((prev) => [
      order,
      ...prev.filter((o) => o.orderNumber !== order.orderNumber),
    ]);
    if (checkoutState.clearCartOnSuccess) {
      setCart([]);
    }
    loadStore(true);
  };

  const handleSyncedCustomerOrders = useCallback((orders: Order[]) => {
    setCustomerOrders(orders);
  }, []);

  if (checkingAdminSession && isAdminMode && !isAdminAuthenticated) {
    return (
      <div className="min-h-screen bg-[#0F1D32] text-[#F7F5EE] flex flex-col items-center justify-center gap-4">
        <BantuuLogo variant="dark" size="md" />
        <p className="text-xs font-mono tracking-wider uppercase text-[#C6A45C]">
          Restoring Admin Session...
        </p>
      </div>
    );
  }

  if (isAdminMode && isAdminAuthenticated) {
    return (
      <AdminPanel
        products={products}
        categories={storeCategories}
        settings={settings}
        activeTab={adminTab}
        onTabChange={handleAdminTabChange}
        selectedOrderId={adminSelectedOrderId}
        onSelectedOrderIdChange={handleAdminOrderSelection}
        onBackToStorefront={handleBackToStorefront}
        onLogoutAdmin={handleLogoutAdmin}
        onSessionExpired={handleAdminSessionExpired}
        onProductsChanged={setProducts}
        onCategoriesChanged={handleCategoriesUpdated}
        onSettingsChanged={setSettings}
      />
    );
  }

  return (
    <div className="min-h-screen flex flex-col bg-[#F7F5EE] text-[#0F1D32]">
      {/* Midnight Navy 3-Zone Header matching Bantuu Store Logo */}
      <header className="sticky top-0 z-40 bg-[#0F1D32] text-[#F7F5EE] border-b border-[#223654]">
        <div className="max-w-7xl mx-auto px-4 sm:px-8 h-20 sm:h-24 flex items-center justify-between gap-3 sm:gap-8">
          {/* Zone 1: Bantuu Store Logo */}
          <a
            href="#top"
            aria-label="Bantuu Store home"
            className="whitespace-nowrap shrink-0 focus:outline-none"
          >
            <BantuuLogo variant="dark" size="sm" />
          </a>

          {/* Zone 2: Concise single-line navigation links */}
          <nav
            aria-label="Primary navigation"
            className="hidden md:flex items-center gap-7 text-sm font-medium text-[#CBD3DF]"
          >
            <a
              href="#shop"
              className="hover:text-[#C6A45C] hover:underline underline-offset-4 transition-colors whitespace-nowrap shrink-0"
            >
              Shop
            </a>
            <a
              href="#promise"
              className="hover:text-[#C6A45C] hover:underline underline-offset-4 transition-colors whitespace-nowrap shrink-0"
            >
              Shipping &amp; Pay
            </a>
            <a
              href="/upi-checkout"
              className="hover:text-[#C6A45C] hover:underline underline-offset-4 transition-colors whitespace-nowrap shrink-0"
            >
              Quick UPI Pay
            </a>
          </nav>

          {/* Zone 3: Orders & Bag */}
          <div className="flex items-center gap-2 sm:gap-3 shrink-0">
            <button
              type="button"
              onClick={openTrackModal}
              aria-label={`View your orders (${customerOrders.length})`}
              className="inline-flex items-center gap-1.5 px-2.5 sm:px-3.5 py-2 rounded-lg border border-[#223654] bg-[#172A46] text-[#F7F5EE] text-xs sm:text-sm font-medium hover:border-[#C6A45C] hover:text-[#C6A45C] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <ClipboardList className="w-4 h-4 text-[#C6A45C]" />
              <span>Orders</span>
              {customerOrders.length > 0 && (
                <span className="font-mono text-[11px] tabular-nums text-[#C6A45C]">
                  ({customerOrders.length})
                </span>
              )}
            </button>

            <button
              type="button"
              onClick={openCartDrawer}
              aria-label={`Open shopping bag with ${cartTotals.itemCount} items`}
              className="inline-flex items-center gap-1.5 sm:gap-2 px-3 sm:px-4 py-2 rounded-lg bg-[#C6A45C] text-[#0F1D32] text-xs sm:text-sm font-semibold hover:bg-[#B69249] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <ShoppingBag className="w-4 h-4" />
              <span className="font-mono tabular-nums">Bag ({cartTotals.itemCount})</span>
            </button>
          </div>
        </div>
      </header>

      <main id="top" className="flex-1">
        {/* Product Catalog Section — Opens directly below header */}
        <section id="shop" className="max-w-7xl mx-auto px-3 sm:px-8 pt-6 sm:pt-10 pb-16">
          <div className="flex flex-col md:flex-row md:items-end justify-between gap-4 pb-5 sm:pb-6 border-b border-[#DED8C8]">
            <div>
              <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                <p className="text-xs uppercase tracking-wider text-[#8A6D32] font-semibold">
                  Bantuu Store Catalog
                </p>
                <span className="text-xs sm:text-[13px] font-bold text-[#0F1D32]">
                  ({settings.storeHours || DEFAULT_STORE_HOURS})
                </span>
              </div>
              <h1 className="mt-1 font-display text-2xl sm:text-3xl font-semibold text-[#0F1D32]">
                Featured Collection
              </h1>
            </div>

            <form
              onSubmit={handleCatalogSearchSubmit}
              className="flex items-center gap-2 w-full sm:w-auto"
            >
              <div className="relative flex-1 sm:flex-initial">
                <Search className="w-4 h-4 text-[#5C5852] absolute left-3 top-1/2 -translate-y-1/2" />
                <label htmlFor="store-search" className="sr-only">
                  Search products
                </label>
                <input
                  id="store-search"
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search products..."
                  className="w-full sm:w-60 pl-9 pr-3 py-2 text-sm rounded-lg border border-[#DED8C8] bg-white focus:outline-none focus:border-[#0F1D32]"
                />
              </div>
              <button
                type="submit"
                className="inline-flex items-center justify-center gap-1.5 px-3.5 py-2 rounded-lg bg-[#0F1D32] text-[#F7F5EE] text-xs sm:text-sm font-medium hover:bg-[#172A46] transition-colors cursor-pointer whitespace-nowrap shrink-0"
              >
                <Search className="w-3.5 h-3.5 text-[#C6A45C]" />
                <span>Search</span>
              </button>
            </form>
          </div>

          {/* Category Tabs */}
          <div
            className="flex items-center gap-2 overflow-x-auto py-4 sm:py-5"
            role="tablist"
            aria-label="Product categories"
          >
            {categories.map((cat) => {
              const active = selectedCategory === cat;
              return (
                <button
                  key={cat}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setSelectedCategory(cat)}
                  className={`px-3 sm:px-3.5 py-1.5 sm:py-2 rounded-lg text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    active
                      ? 'bg-[#0F1D32] text-[#F7F5EE]'
                      : 'bg-white border border-[#DED8C8] text-[#3E4756] hover:text-[#0F1D32]'
                  }`}
                >
                  {cat}
                </button>
              );
            })}
          </div>

          {loadError && (
            <div className="p-6 rounded-xl bg-white border border-[#DED8C8] text-center space-y-3">
              <p className="text-sm text-[#991B1B]">{loadError}</p>
              <button
                type="button"
                onClick={() => loadStore()}
                className="px-4 py-2 text-xs font-medium rounded-lg bg-[#0F1D32] text-[#F7F5EE] cursor-pointer"
              >
                Retry
              </button>
            </div>
          )}

          {loading ? (
            <div className="grid grid-cols-2 sm:grid-cols-2 lg:grid-cols-3 gap-2.5 sm:gap-6 lg:gap-7">
              {[1, 2, 3, 4].map((n) => (
                <div
                  key={n}
                  className="bg-white border border-[#DED8C8] rounded-xl overflow-hidden animate-pulse"
                >
                  <div className="aspect-[3/4] bg-[#ECE7DA]" />
                  <div className="p-3 sm:p-5 space-y-2.5 sm:space-y-3">
                    <div className="h-3 w-20 bg-[#ECE7DA] rounded" />
                    <div className="h-4 w-32 sm:w-48 bg-[#ECE7DA] rounded" />
                    <div className="h-8 w-full bg-[#ECE7DA] rounded" />
                  </div>
                </div>
              ))}
            </div>
          ) : visibleProducts.length === 0 ? (
            <div className="p-12 rounded-xl bg-white border border-[#DED8C8] text-center space-y-2">
              <p className="text-base font-medium text-[#0F1D32]">No products match your search</p>
              <p className="text-sm text-[#5C5852]">
                Try another category or clear your search filter.
              </p>
              <button
                type="button"
                onClick={() => {
                  setSelectedCategory('All');
                  setSearchQuery('');
                }}
                className="mt-2 px-4 py-2 text-xs font-medium rounded-lg border border-[#DED8C8] bg-[#F7F5EE] text-[#0F1D32] cursor-pointer"
              >
                Reset Filters
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-2 lg:grid-cols-3 gap-2.5 sm:gap-6 lg:gap-7">
              {visibleProducts.map((product) => {
                const primaryMedia = product.media[0];
                const hasVideo = product.media.some((m) => m.type === 'video');
                const outOfStock = product.stock <= 0;
                const justAdded = addedCardId === product.id;
                const discountPct = normalizeDiscountPercent(product.discountPercent);
                const originalMrp = calculateOriginalMrp(product.price, discountPct);

                return (
                  <article
                    key={product.id}
                    className="group bg-white border border-[#DED8C8] rounded-lg sm:rounded-xl overflow-hidden flex flex-col transition-transform duration-200 hover:-translate-y-0.5 hover:shadow-md"
                  >
                    <button
                      type="button"
                      onClick={() => openDetailModal(product)}
                      aria-label={`Inspect ${product.name} photos and details`}
                      className="relative aspect-[3/4] w-full bg-[#ECE7DA] overflow-hidden text-left cursor-pointer"
                    >
                      {primaryMedia ? (
                        <MediaRenderer
                          url={primaryMedia.url}
                          type={primaryMedia.type}
                          alt={product.name}
                          controls={false}
                          muted
                          className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-[1.02]"
                        />
                      ) : (
                        <MediaRenderer url="" type="image" alt={product.name} />
                      )}

                      {product.pinned && (
                        <span className="absolute top-2 left-2 sm:top-3 sm:left-3 inline-flex items-center gap-1 px-1.5 sm:px-2 py-0.5 rounded bg-[#0F1D32]/90 text-[#C6A45C] text-[10px] font-bold uppercase tracking-wider">
                          <Pin className="w-2.5 h-2.5" />
                          <span>Pinned</span>
                        </span>
                      )}

                      {discountPct > 0 && (
                        <span className="absolute top-2 right-2 sm:top-3 sm:right-3 inline-flex items-center px-1.5 sm:px-2 py-0.5 rounded bg-[#B91C1C] text-white text-[10px] sm:text-[11px] font-bold">
                          {discountPct}% OFF
                        </span>
                      )}

                      {hasVideo && (
                        <span className="absolute bottom-2 left-2 sm:bottom-3 sm:left-3 inline-flex items-center gap-1 px-2 py-0.5 sm:px-2.5 sm:py-1 rounded bg-[#0F1D32]/90 text-[#C6A45C] text-[10px] sm:text-[11px] font-medium">
                          <Film className="w-3 h-3" />
                          <span>Video</span>
                        </span>
                      )}
                    </button>

                    <div className="p-2.5 sm:p-5 flex-1 flex flex-col justify-between gap-2.5 sm:gap-4">
                      <div>
                        <div className="flex items-center justify-between gap-1.5 text-[10px] sm:text-xs text-[#5C5852]">
                          <span className="uppercase tracking-wider font-semibold text-[#8A6D32] truncate">
                            {product.category}
                          </span>
                          <span className="tabular-nums shrink-0">
                            {outOfStock ? 'Out' : `${product.stock} left`}
                          </span>
                        </div>

                        <div className="mt-1 sm:mt-1.5 flex flex-col sm:flex-row sm:items-baseline sm:justify-between gap-1 sm:gap-3">
                          <button
                            type="button"
                            onClick={() => openDetailModal(product)}
                            className="text-left text-xs sm:text-base font-semibold text-[#0F1D32] hover:underline underline-offset-2 line-clamp-2 sm:line-clamp-1 leading-snug cursor-pointer"
                          >
                            {product.name}
                          </button>
                          <div className="flex items-center justify-between gap-2 shrink-0">
                            <div className="flex items-baseline gap-1.5">
                              <span className="font-mono text-sm sm:text-[15px] font-bold sm:font-semibold text-[#0F1D32] tabular-nums">
                                {formatINR(product.price)}
                              </span>
                              {originalMrp && (
                                <span className="font-mono text-[11px] text-[#5C5852] line-through tabular-nums">
                                  {formatINR(originalMrp)}
                                </span>
                              )}
                            </div>
                            <span className="sm:hidden text-[10px] font-mono uppercase tracking-wider text-[#8A6D32] font-semibold">
                              UPI · COD
                            </span>
                          </div>
                        </div>

                        <p className="hidden sm:line-clamp-2 mt-2 text-sm text-[#3E4756] leading-relaxed">
                          {product.description}
                        </p>
                      </div>

                      {/* Both Add to Cart and Buy Now actions */}
                      <div className="grid grid-cols-2 gap-1.5 sm:gap-2.5 pt-2 border-t border-[#DED8C8]">
                        <button
                          type="button"
                          disabled={outOfStock}
                          aria-label={`Add ${product.name} to cart`}
                          onClick={() => handleAddToCart(product, 1)}
                          className="inline-flex items-center justify-center gap-1 sm:gap-1.5 px-1.5 sm:px-3 py-2 sm:py-2.5 rounded-md sm:rounded-lg border border-[#0F1D32] bg-white text-[#0F1D32] text-[11px] sm:text-xs font-medium hover:bg-[#F7F5EE] disabled:opacity-40 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                        >
                          {justAdded ? (
                            <>
                              <Check className="w-3 h-3 sm:w-3.5 sm:h-3.5 text-[#8A6D32]" />
                              <span>Added</span>
                            </>
                          ) : (
                            <>
                              <ShoppingBag className="w-3 h-3 sm:w-3.5 sm:h-3.5" />
                              <span className="sm:hidden">Cart</span>
                              <span className="hidden sm:inline">Add to Cart</span>
                            </>
                          )}
                        </button>

                        <button
                          type="button"
                          disabled={outOfStock}
                          aria-label={`Buy ${product.name} now`}
                          onClick={() => handleBuyNow(product, 1)}
                          className="inline-flex items-center justify-center gap-1 sm:gap-1.5 px-1.5 sm:px-3 py-2 sm:py-2.5 rounded-md sm:rounded-lg bg-[#0F1D32] text-[#F7F5EE] text-[11px] sm:text-xs font-medium hover:bg-[#172A46] disabled:opacity-40 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                        >
                          <Zap className="w-3 h-3 sm:w-3.5 sm:h-3.5 text-[#C6A45C]" />
                          <span>Buy Now</span>
                        </button>
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>

        {/* Shipping & Payment Promise Strip */}
        <section id="promise" className="border-t border-[#DED8C8] bg-white">
          <div className="max-w-7xl mx-auto px-5 sm:px-8 py-12 grid grid-cols-1 md:grid-cols-2 gap-8">
            <div>
              <p className="text-xs uppercase tracking-wider text-[#8A6D32] font-semibold">
                {settings.codEyebrow || DEFAULT_PROMISE_COPY.codEyebrow}
              </p>
              <h3 className="mt-2 text-lg font-semibold text-[#0F1D32]">
                {settings.codTitle || DEFAULT_PROMISE_COPY.codTitle}
              </h3>
              <p className="mt-1.5 text-sm text-[#3E4756] leading-relaxed">
                {settings.codDescription || DEFAULT_PROMISE_COPY.codDescription}
              </p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-wider text-[#8A6D32] font-semibold">
                {settings.upiEyebrow || DEFAULT_PROMISE_COPY.upiEyebrow}
              </p>
              <h3 className="mt-2 text-lg font-semibold text-[#0F1D32]">
                {settings.upiTitle || DEFAULT_PROMISE_COPY.upiTitle}
              </h3>
              <p className="mt-1.5 text-sm text-[#3E4756] leading-relaxed">
                {(settings.upiDescription || DEFAULT_PROMISE_COPY.upiDescription).replace(
                  /\{upiId\}/g,
                  settings.upiId,
                )}
              </p>
            </div>
          </div>
        </section>
      </main>

      {/* Midnight Navy Footer with BantuuLogo */}
      <footer className="border-t border-[#223654] bg-[#0F1D32] text-[#CBD3DF]">
        <div className="max-w-7xl mx-auto px-4 sm:px-8 py-8 flex flex-row items-start sm:items-center justify-between gap-4 sm:gap-8 text-xs">
          <div className="flex flex-col gap-3 min-w-0 flex-1">
            <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-5">
              <BantuuLogo variant="dark" size="sm" />
              <span className="text-[#CBD3DF]/80 leading-relaxed">
                Curated Everyday Retail · UPI: {settings.upiId}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-x-5 gap-y-2 pt-1">
              <button
                type="button"
                onClick={openTrackModal}
                className="hover:text-[#C6A45C] cursor-pointer"
              >
                Track Order
              </button>
              <a href="#shop" className="hover:text-[#C6A45C]">
                Browse Catalog
              </a>
              <a href="/upi-checkout" className="hover:text-[#C6A45C]">
                Quick UPI Pay
              </a>
            </div>
          </div>

          <div className="flex flex-col gap-2.5 shrink-0 items-end">
            <a
              href="https://github.com/banti194raj-svg/bantuustore/raw/refs/heads/main/bantuustore.apk"
              target="_blank"
              rel="external"
              aria-label="Download Bantuu Store APK"
              onClick={(e) => {
                if (!isAndroidWebView) return;
                e.preventDefault();
                const url =
                  'https://github.com/banti194raj-svg/bantuustore/raw/refs/heads/main/bantuustore.apk';
                const win = window as unknown as {
                  AppInventor?: { setWebViewString?: (v: string) => void };
                  Android?: { downloadFile?: (u: string, f: string) => void; openExternal?: (u: string) => void };
                };
                win.AppInventor?.setWebViewString?.(
                  JSON.stringify({ action: 'download_apk', url }),
                );
                if (typeof win.Android?.downloadFile === 'function') {
                  win.Android.downloadFile(url, 'bantuustore.apk');
                  return;
                }
                if (typeof win.Android?.openExternal === 'function') {
                  win.Android.openExternal(url);
                  return;
                }
                setCopiedSupportKey(null);
                setWebViewLinkModal('apk');
              }}
              className="inline-flex items-center justify-center gap-1.5 sm:gap-2 px-3 sm:px-4 py-2 sm:py-2.5 rounded-lg bg-[#C6A45C] text-[#0F1D32] text-[11px] sm:text-xs font-bold hover:bg-[#B69249] transition-colors whitespace-nowrap"
            >
              <Download className="w-3.5 h-3.5 shrink-0" />
              <span>Download Bantuu Store APK</span>
            </a>
            <a
              href="https://t.me/Iamkillerb"
              target="_blank"
              rel="external"
              aria-label="Contact or Support on Telegram"
              onClick={(e) => {
                if (!isAndroidWebView) return;
                e.preventDefault();
                const url = 'https://t.me/Iamkillerb';
                const win = window as unknown as {
                  AppInventor?: { setWebViewString?: (v: string) => void };
                  Android?: { openExternal?: (u: string) => void };
                };
                win.AppInventor?.setWebViewString?.(
                  JSON.stringify({ action: 'open_external', url }),
                );
                if (typeof win.Android?.openExternal === 'function') {
                  win.Android.openExternal(url);
                  return;
                }
                setCopiedSupportKey(null);
                setWebViewLinkModal('telegram');
              }}
              className="inline-flex items-center justify-center gap-1.5 sm:gap-2 px-3 sm:px-4 py-2 sm:py-2.5 rounded-lg border border-[#223654] bg-[#172A46] text-[#F7F5EE] text-[11px] sm:text-xs font-semibold hover:bg-[#1F3659] hover:border-[#C6A45C]/50 transition-colors whitespace-nowrap"
            >
              <Send className="w-3.5 h-3.5 text-[#C6A45C] shrink-0" />
              <span>Contact / Support</span>
            </a>
          </div>
        </div>
      </footer>

      {/* Modals & Drawers */}
      <ProductDetailModal
        product={detailProduct}
        onClose={closeDetailModal}
        onAddToCart={handleAddToCart}
        onBuyNow={handleBuyNow}
      />

      <CartDrawer
        isOpen={isCartOpen}
        items={cart}
        settings={settings}
        onClose={closeCartDrawer}
        onUpdateQuantity={handleUpdateCartQuantity}
        onRemoveItem={(productId) =>
          setCart((prev) => prev.filter((item) => item.productId !== productId))
        }
        onCheckout={handleCartCheckout}
      />

      <CheckoutModal
        isOpen={checkoutState.isOpen}
        items={checkoutState.items}
        modeLabel={checkoutState.modeLabel}
        settings={settings}
        onClose={closeCheckoutModal}
        onOrderCreated={handleOrderCreated}
      />

      <TrackOrderModal
        isOpen={isTrackOpen}
        customerOrders={customerOrders}
        onSyncedOrders={handleSyncedCustomerOrders}
        onClose={closeTrackModal}
      />

      <AdminPasswordModal
        isOpen={isPasswordModalOpen}
        onClose={closePasswordModal}
        onSuccess={enterAdminMode}
      />

      {webViewLinkModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-[#091322]/75 backdrop-blur-xs p-4"
          role="dialog"
          aria-modal="true"
          aria-label={
            webViewLinkModal === 'telegram'
              ? 'Telegram Contact Support'
              : 'Download Bantuu Store APK'
          }
          onClick={() => setWebViewLinkModal(null)}
        >
          <div
            className="w-full max-w-sm bg-white border border-[#DED8C8] rounded-xl overflow-hidden shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-5 py-4 bg-[#0F1D32] text-[#F7F5EE] border-b border-[#223654] flex items-center justify-between">
              <div className="flex items-center gap-2">
                {webViewLinkModal === 'telegram' ? (
                  <Send className="w-4 h-4 text-[#C6A45C]" />
                ) : (
                  <Download className="w-4 h-4 text-[#C6A45C]" />
                )}
                <h2 className="text-sm font-semibold">
                  {webViewLinkModal === 'telegram'
                    ? 'Contact / Support on Telegram'
                    : 'Download Bantuu Store APK'}
                </h2>
              </div>
              <button
                type="button"
                onClick={() => setWebViewLinkModal(null)}
                aria-label="Close support dialog"
                className="w-8 h-8 inline-flex items-center justify-center rounded-lg border border-[#223654] bg-[#172A46] text-[#F7F5EE] cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-5 space-y-3.5 text-sm">
              {webViewLinkModal === 'telegram' ? (
                <>
                  <p className="text-xs text-[#3E4756] leading-relaxed">
                    In-app WebView blocks direct Telegram scheme redirects. Copy our username to message directly on Telegram, or open the link in Chrome:
                  </p>
                  <div className="p-3 rounded-lg bg-[#F7F5EE] border border-[#DED8C8] flex items-center justify-between gap-2">
                    <span className="font-mono font-bold text-[#0F1D32]">@Iamkillerb</span>
                    <button
                      type="button"
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText('@Iamkillerb');
                          setCopiedSupportKey('username');
                        } catch {
                          // ignore clipboard errors
                        }
                      }}
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded bg-[#0F1D32] text-[#F7F5EE] text-xs font-medium cursor-pointer"
                    >
                      {copiedSupportKey === 'username' ? (
                        <>
                          <Check className="w-3.5 h-3.5 text-[#C6A45C]" />
                          <span>Copied</span>
                        </>
                      ) : (
                        <>
                          <Copy className="w-3.5 h-3.5 text-[#C6A45C]" />
                          <span>Copy ID</span>
                        </>
                      )}
                    </button>
                  </div>
                  <div className="flex flex-col gap-2">
                    <button
                      type="button"
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText('https://t.me/Iamkillerb');
                          setCopiedSupportKey('tg-link');
                        } catch {
                          // ignore clipboard errors
                        }
                      }}
                      className="w-full py-2.5 px-4 rounded-lg border border-[#DED8C8] bg-white text-[#0F1D32] text-xs font-semibold hover:bg-[#F7F5EE] cursor-pointer"
                    >
                      {copiedSupportKey === 'tg-link'
                        ? 'Copied https://t.me/Iamkillerb'
                        : 'Copy Support Link (https://t.me/Iamkillerb)'}
                    </button>
                    <a
                      href="https://t.me/Iamkillerb"
                      target="_blank"
                      rel="external"
                      className="w-full py-2.5 px-4 rounded-lg bg-[#C6A45C] text-[#0F1D32] text-xs font-bold text-center"
                    >
                      Open Telegram Link
                    </a>
                  </div>
                </>
              ) : (
                <>
                  <p className="text-xs text-[#3E4756] leading-relaxed">
                    Copy the direct APK link to download in Chrome if your app WebView pauses file downloads, or tap Open Download below:
                  </p>
                  <div className="p-2.5 rounded-lg bg-[#F7F5EE] border border-[#DED8C8] text-[11px] font-mono text-[#0F1D32] break-all">
                    https://github.com/banti194raj-svg/bantuustore/raw/refs/heads/main/bantuustore.apk
                  </div>
                  <div className="flex flex-col gap-2">
                    <button
                      type="button"
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(
                            'https://github.com/banti194raj-svg/bantuustore/raw/refs/heads/main/bantuustore.apk',
                          );
                          setCopiedSupportKey('apk-link');
                        } catch {
                          // ignore clipboard errors
                        }
                      }}
                      className="w-full py-2.5 px-4 rounded-lg border border-[#DED8C8] bg-white text-[#0F1D32] text-xs font-semibold hover:bg-[#F7F5EE] cursor-pointer"
                    >
                      {copiedSupportKey === 'apk-link'
                        ? 'Copied APK Download Link'
                        : 'Copy APK Download Link'}
                    </button>
                    <a
                      href="https://github.com/banti194raj-svg/bantuustore/raw/refs/heads/main/bantuustore.apk"
                      target="_blank"
                      rel="external"
                      className="w-full py-2.5 px-4 rounded-lg bg-[#C6A45C] text-[#0F1D32] text-xs font-bold text-center"
                    >
                      Open APK Download
                    </a>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
