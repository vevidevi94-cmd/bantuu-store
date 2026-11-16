import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  Check,
  ClipboardList,
  Film,
  Search,
  ShoppingBag,
  Zap,
} from 'lucide-react';
import { AdminPanel } from './components/AdminPanel';
import { AdminPasswordModal } from './components/AdminPasswordModal';
import { BantuuLogo } from './components/BantuuLogo';
import { CartDrawer } from './components/CartDrawer';
import { CheckoutModal } from './components/CheckoutModal';
import { MediaRenderer } from './components/MediaRenderer';
import { ProductDetailModal } from './components/ProductDetailModal';
import { TrackOrderModal } from './components/TrackOrderModal';
import {
  calculateCartTotals,
  filterProducts,
  formatINR,
  getPrimaryProductImage,
  isAdminSecretSearchQuery,
  normalizeFirebaseRtdbUrl,
  type CartItem,
  type Order,
  type Product,
  type StoreSettings,
} from './utils/storeLogic';

const CART_STORAGE_KEY = 'bantuu_store_cart_v1';
const ORDERS_STORAGE_KEY = 'bantuu_customer_orders_v1';

const DEFAULT_SETTINGS: StoreSettings = {
  storeName: 'Bantuu Store',
  upiId: 'skiend@axl',
  upiQrUrl: '/assets/aistudio/47084_35196505.jpg',
  merchantName: 'Bantuu Store Retail',
  freeShippingThreshold: 999,
  shippingFee: 79,
  firebaseRtdbUrl: 'https://bantuu-store-default-rtdb.firebaseio.com',
};

const DEFAULT_CATEGORIES = [
  'Home & Living',
  'Carry & Leather',
  'Watches',
  'Audio',
  'Apparel',
  'Accessories',
];

function readInitialAdminMode(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    window.location.pathname === '/admin' ||
    window.location.hash === '#admin' ||
    new URLSearchParams(window.location.search).get('mode') === 'admin'
  );
}

export default function App() {
  const [isAdminMode, setIsAdminMode] = useState<boolean>(readInitialAdminMode);
  const [isAdminAuthenticated, setIsAdminAuthenticated] = useState(false);
  const [isPasswordModalOpen, setIsPasswordModalOpen] = useState<boolean>(readInitialAdminMode);
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

  const loadStore = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setLoadError('');
    try {
      const res = await fetch('/api/store');
      if (!res.ok) throw new Error('Failed to load store');
      const data = await res.json();
      setProducts(data.products || []);
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
  }, [loadStore]);

  // Real-time Firebase RTDB stream listener for products, categories & settings changes
  useEffect(() => {
    const cleanRtdb = normalizeFirebaseRtdbUrl(settings.firebaseRtdbUrl || '');
    if (!cleanRtdb || typeof EventSource === 'undefined') return;

    let closed = false;
    const source = new EventSource(`${cleanRtdb}/.json`);
    const handleStream = () => {
      if (!closed) loadStore(true);
    };
    source.addEventListener('put', handleStream);
    source.addEventListener('patch', handleStream);

    return () => {
      closed = true;
      source.close();
    };
  }, [settings.firebaseRtdbUrl, loadStore]);

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

  useEffect(() => {
    const syncHash = () => {
      if (window.location.hash === '#admin' || window.location.pathname === '/admin') {
        setIsAdminMode(true);
        setIsPasswordModalOpen(true);
      }
    };
    window.addEventListener('hashchange', syncHash);
    return () => window.removeEventListener('hashchange', syncHash);
  }, []);

  const enterAdminMode = () => {
    setIsAdminAuthenticated(true);
    setIsAdminMode(true);
    setIsPasswordModalOpen(false);
    if (window.location.hash !== '#admin') {
      window.history.replaceState(null, '', '#admin');
    }
    window.scrollTo({ top: 0 });
  };

  const exitAdminMode = () => {
    setIsAdminMode(false);
    setIsAdminAuthenticated(false);
    setIsPasswordModalOpen(false);
    if (window.location.hash === '#admin') {
      window.history.replaceState(null, '', window.location.pathname === '/admin' ? '/' : '#');
    }
    loadStore(true);
    window.scrollTo({ top: 0 });
  };

  const handleCategoriesUpdated = useCallback(
    (nextCategories: string[], nextProducts?: Product[]) => {
      setStoreCategories(nextCategories);
      if (Array.isArray(nextProducts)) {
        setProducts(nextProducts);
      }
    },
    [],
  );

  const handleCatalogSearchSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (isAdminSecretSearchQuery(searchQuery)) {
      setSearchQuery('');
      setIsPasswordModalOpen(true);
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
  };

  const handleCartCheckout = () => {
    if (cart.length === 0) return;
    setIsCartOpen(false);
    setCheckoutState({
      isOpen: true,
      items: cart,
      modeLabel: 'Bag Checkout',
      clearCartOnSuccess: true,
    });
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

  if (isAdminMode && isAdminAuthenticated) {
    return (
      <AdminPanel
        products={products}
        categories={storeCategories}
        settings={settings}
        onExitAdmin={exitAdminMode}
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
          </nav>

          {/* Zone 3: Orders & Bag */}
          <div className="flex items-center gap-2 sm:gap-3 shrink-0">
            <button
              type="button"
              onClick={() => setIsTrackOpen(true)}
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
              onClick={() => setIsCartOpen(true)}
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
              <p className="text-xs uppercase tracking-wider text-[#8A6D32] font-semibold">
                Bantuu Store Catalog
              </p>
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
                  <div className="aspect-square sm:aspect-[4/3] bg-[#ECE7DA]" />
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

                return (
                  <article
                    key={product.id}
                    className="group bg-white border border-[#DED8C8] rounded-lg sm:rounded-xl overflow-hidden flex flex-col transition-transform duration-200 hover:-translate-y-0.5 hover:shadow-md"
                  >
                    <button
                      type="button"
                      onClick={() => setDetailProduct(product)}
                      aria-label={`Inspect ${product.name} photos and details`}
                      className="relative aspect-square sm:aspect-[4/3] w-full bg-[#ECE7DA] overflow-hidden text-left cursor-pointer"
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
                            onClick={() => setDetailProduct(product)}
                            className="text-left text-xs sm:text-base font-semibold text-[#0F1D32] hover:underline underline-offset-2 line-clamp-2 sm:line-clamp-1 leading-snug cursor-pointer"
                          >
                            {product.name}
                          </button>
                          <div className="flex items-center justify-between gap-2 shrink-0">
                            <span className="font-mono text-sm sm:text-[15px] font-bold sm:font-semibold text-[#0F1D32] tabular-nums">
                              {formatINR(product.price)}
                            </span>
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
                01. Cash on Delivery
              </p>
              <h3 className="mt-2 text-lg font-semibold text-[#0F1D32]">
                Pay when your parcel arrives
              </h3>
              <p className="mt-1.5 text-sm text-[#3E4756] leading-relaxed">
                Select Cash on Delivery at checkout for doorstep cash payment across serviceable Indian pincodes.
              </p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-wider text-[#8A6D32] font-semibold">
                02. Instant UPI Checkout
              </p>
              <h3 className="mt-2 text-lg font-semibold text-[#0F1D32]">
                Direct transfer via any UPI app
              </h3>
              <p className="mt-1.5 text-sm text-[#3E4756] leading-relaxed">
                Pay via Google Pay, PhonePe, Paytm, or BHIM directly to {settings.upiId} and attach your UTR reference.
              </p>
            </div>
          </div>
        </section>
      </main>

      {/* Midnight Navy Footer with BantuuLogo */}
      <footer className="border-t border-[#223654] bg-[#0F1D32] text-[#CBD3DF]">
        <div className="max-w-7xl mx-auto px-5 sm:px-8 py-8 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-6 text-xs">
          <div className="flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-5">
            <BantuuLogo variant="dark" size="sm" />
            <span className="text-[#CBD3DF]/80">
              Curated Everyday Retail · UPI: {settings.upiId}
            </span>
          </div>
          <div className="flex items-center gap-5">
            <button
              type="button"
              onClick={() => setIsTrackOpen(true)}
              className="hover:text-[#C6A45C] cursor-pointer"
            >
              Track Order
            </button>
            <a href="#shop" className="hover:text-[#C6A45C]">
              Browse Catalog
            </a>
          </div>
        </div>
      </footer>

      {/* Modals & Drawers */}
      <ProductDetailModal
        product={detailProduct}
        onClose={() => setDetailProduct(null)}
        onAddToCart={handleAddToCart}
        onBuyNow={handleBuyNow}
      />

      <CartDrawer
        isOpen={isCartOpen}
        items={cart}
        settings={settings}
        onClose={() => setIsCartOpen(false)}
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
        onClose={() => setCheckoutState((prev) => ({ ...prev, isOpen: false }))}
        onOrderCreated={handleOrderCreated}
      />

      <TrackOrderModal
        isOpen={isTrackOpen}
        customerOrders={customerOrders}
        onSyncedOrders={handleSyncedCustomerOrders}
        onClose={() => setIsTrackOpen(false)}
      />

      <AdminPasswordModal
        isOpen={isPasswordModalOpen}
        onClose={() => {
          setIsPasswordModalOpen(false);
          if (isAdminMode && !isAdminAuthenticated) {
            exitAdminMode();
          }
        }}
        onSuccess={enterAdminMode}
      />
    </div>
  );
}
