import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { MapPin, Package, Search, X } from 'lucide-react';
import { formatINR, formatOrderDateTime, type Order, type OrderStatus } from '../utils/storeLogic';
import { MediaRenderer } from './MediaRenderer';

interface TrackOrderModalProps {
  isOpen: boolean;
  customerOrders: Order[];
  onSyncedOrders?: (orders: Order[]) => void;
  onClose: () => void;
}

const PROGRESS_STEPS: OrderStatus[] = ['Pending', 'Confirmed', 'Shipped', 'Delivered'];

function StatusProgressBar({ status }: { status: OrderStatus }) {
  if (status === 'Cancelled') {
    return (
      <div className="pt-2">
        <span className="inline-flex items-center px-2.5 py-1 rounded text-[11px] font-semibold bg-[#FEF2F2] text-[#B91C1C] border border-[#DC2626]/30">
          Order Cancelled
        </span>
      </div>
    );
  }

  const normalizedIdx =
    status === 'Pending Verification'
      ? 0
      : status === 'Paid'
        ? 1
        : Math.max(0, PROGRESS_STEPS.indexOf(status));
  const currentIdx = normalizedIdx;
  const stepLabels = [
    status === 'Pending Verification' ? 'Pending Verification' : 'Pending',
    status === 'Paid' ? 'Paid' : 'Confirmed',
    'Shipped',
    'Delivered',
  ];

  return (
    <div className="pt-2.5">
      <div className="grid grid-cols-4 gap-1.5">
        {stepLabels.map((step, idx) => {
          const reached = idx <= currentIdx;
          return (
            <div key={step} className="space-y-1">
              <div
                className={`h-1.5 rounded-full transition-colors ${
                  reached ? 'bg-[#C6A45C]' : 'bg-[#DED8C8]'
                }`}
              />
              <p
                className={`text-[10px] font-medium truncate ${
                  reached ? 'text-[#0F1D32] font-semibold' : 'text-[#7C766E]'
                }`}
              >
                {step}
              </p>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function TrackOrderModal({
  isOpen,
  customerOrders,
  onSyncedOrders,
  onClose,
}: TrackOrderModalProps) {
  const [query, setQuery] = useState('');
  const [searchResults, setSearchResults] = useState<Order[] | null>(null);
  const [liveCustomerOrders, setLiveCustomerOrders] = useState<Order[]>(customerOrders);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLiveCustomerOrders(customerOrders);
  }, [customerOrders]);

  useEffect(() => {
    if (!isOpen) return;
    setSearchResults(null);
    setQuery('');

    // Refresh customer's saved orders live from server / Firebase RTDB
    const numbers = customerOrders.map((o) => o.orderNumber).filter(Boolean);
    if (numbers.length === 0) return;

    let cancelled = false;
    fetch(`/api/orders?orderNumbers=${encodeURIComponent(numbers.join(','))}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (cancelled || !data || !Array.isArray(data.orders)) return;
        const freshByNumber = new Map<string, Order>(
          data.orders.map((o: Order) => [o.orderNumber, o]),
        );
        const merged = customerOrders.map((localOrder) => {
          return freshByNumber.get(localOrder.orderNumber) || localOrder;
        });
        setLiveCustomerOrders(merged);
        if (onSyncedOrders) onSyncedOrders(merged);
      })
      .catch(() => {
        // Keep local snapshot on offline failure
      });

    return () => {
      cancelled = true;
    };
  }, [isOpen, customerOrders, onSyncedOrders]);

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, onClose]);

  const displayedOrders = useMemo(() => {
    if (searchResults !== null) return searchResults;
    return liveCustomerOrders;
  }, [searchResults, liveCustomerOrders]);

  if (!isOpen) return null;

  const handleSearch = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = query.trim();
    if (!trimmed) {
      setSearchResults(null);
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(`/api/orders?lookup=${encodeURIComponent(trimmed)}`);
      const data = await res.json();
      setSearchResults(data.orders || []);
    } catch {
      setSearchResults([]);
    } finally {
      setLoading(false);
    }
  };

  const isShowingSearch = searchResults !== null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[#091322]/70 backdrop-blur-xs p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="track-order-title"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl bg-white border border-[#DED8C8] rounded-xl shadow-2xl overflow-hidden max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-4 bg-[#0F1D32] text-[#F7F5EE] border-b border-[#223654] flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2.5">
            <Package className="w-5 h-5 text-[#C6A45C]" />
            <div>
              <h2 id="track-order-title" className="text-lg font-semibold text-[#F7F5EE]">
                Your Orders &amp; Live Tracking
              </h2>
              <p className="text-xs text-[#CBD3DF]">
                View items you ordered or track any order with Order # or mobile number
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close orders panel"
            className="w-9 h-9 inline-flex items-center justify-center rounded-lg border border-[#223654] bg-[#172A46] text-[#F7F5EE] hover:bg-[#1F3659] cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 sm:p-6 space-y-5 overflow-y-auto overscroll-contain flex-1 min-h-0">
          <form onSubmit={handleSearch} className="flex flex-col sm:flex-row gap-2">
            <label htmlFor="track-query" className="sr-only">
              Order Number or Phone Number
            </label>
            <input
              id="track-query"
              type="text"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                if (!e.target.value.trim()) setSearchResults(null);
              }}
              placeholder="Track by Order # (e.g. BNT-1002) or 10-digit mobile"
              className="flex-1 px-3.5 py-2.5 text-sm rounded-lg border border-[#DED8C8] bg-[#F7F5EE] focus:bg-white focus:outline-none focus:border-[#0F1D32]"
            />
            <div className="flex items-center gap-2">
              <button
                type="submit"
                disabled={loading}
                className="flex-1 sm:flex-initial inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-[#C6A45C] text-[#0F1D32] text-sm font-semibold hover:bg-[#B69249] cursor-pointer whitespace-nowrap shrink-0"
              >
                <Search className="w-4 h-4" />
                <span>{loading ? 'Checking...' : 'Track Order'}</span>
              </button>
              {isShowingSearch && liveCustomerOrders.length > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    setQuery('');
                    setSearchResults(null);
                  }}
                  className="px-3 py-2.5 rounded-lg border border-[#DED8C8] bg-white text-xs font-medium text-[#0F1D32] hover:bg-[#F7F5EE] cursor-pointer whitespace-nowrap"
                >
                  My Orders
                </button>
              )}
            </div>
          </form>

          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-xs uppercase tracking-wider text-[#8A6D32] font-semibold">
                {isShowingSearch
                  ? `Search Results (${displayedOrders.length})`
                  : `Your Recent Orders (${displayedOrders.length})`}
              </p>
            </div>

            {displayedOrders.length === 0 ? (
              <div className="text-sm text-[#5C5852] py-8 px-4 text-center border border-[#DED8C8] rounded-xl bg-[#F7F5EE] space-y-1.5">
                {isShowingSearch ? (
                  <p>
                    No order matched "{query}". Check your Order Number or 10-digit mobile number.
                  </p>
                ) : (
                  <>
                    <p className="font-medium text-[#0F1D32]">You have not placed an order yet.</p>
                    <p className="text-xs">
                      Once you place an order, it will appear right here with live status tracking. Or enter an Order # / mobile number above to look up an earlier order.
                    </p>
                  </>
                )}
              </div>
            ) : (
              <div className="space-y-4">
                {displayedOrders.map((order) => {
                  const dt = formatOrderDateTime(order.createdAt);
                  return (
                    <div
                      key={order.id || order.orderNumber}
                      className="p-4 rounded-xl border border-[#DED8C8] bg-[#F7F5EE] space-y-3 text-sm"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div>
                          <span className="font-mono font-bold text-[#0F1D32] text-base">
                            {order.orderNumber}
                          </span>
                          <span className="ml-2.5 text-xs text-[#5C5852] font-mono tabular-nums">
                            {dt.date} · {dt.time}
                          </span>
                        </div>
                        <span className="px-2.5 py-1 rounded-md bg-[#0F1D32] text-[#C6A45C] text-xs font-semibold">
                          {order.status}
                        </span>
                      </div>

                      <StatusProgressBar status={order.status} />

                      {/* Items ordered */}
                      <div className="bg-white rounded-lg border border-[#DED8C8] divide-y divide-[#DED8C8]">
                        {order.items.map((item, idx) => (
                          <div
                            key={`${item.productId}-${idx}`}
                            className="p-2.5 flex items-center justify-between gap-3"
                          >
                            <div className="flex items-center gap-2.5 min-w-0">
                              <div className="w-10 h-10 rounded overflow-hidden border border-[#DED8C8] bg-[#F7F5EE] shrink-0">
                                <MediaRenderer url={item.imageUrl} type="image" alt={item.name} />
                              </div>
                              <div className="min-w-0">
                                <p className="text-xs sm:text-sm font-medium text-[#0F1D32] truncate">
                                  {item.name}
                                </p>
                                <p className="text-[11px] font-mono text-[#5C5852] tabular-nums">
                                  Qty {item.quantity} × {formatINR(item.price)}
                                </p>
                              </div>
                            </div>
                            <span className="text-xs font-mono font-semibold text-[#0F1D32] tabular-nums shrink-0">
                              {formatINR(item.price * item.quantity)}
                            </span>
                          </div>
                        ))}
                      </div>

                      {/* Address & Payment footer */}
                      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pt-1 text-xs text-[#3E4756]">
                        <div className="flex items-start gap-1.5 min-w-0">
                          <MapPin className="w-3.5 h-3.5 text-[#8A6D32] shrink-0 mt-0.5" />
                          <span className="truncate">
                            {order.customerName} · {order.address}, {order.city} — {order.pincode}
                          </span>
                        </div>
                        <div className="flex items-center gap-3 shrink-0">
                          <span>
                            {order.paymentMethod === 'COD' ? 'Cash on Delivery' : 'UPI'}
                            {order.upiTransactionId ? ` (${order.upiTransactionId})` : ''}
                          </span>
                          <span className="font-mono font-bold text-[#0F1D32] text-sm tabular-nums">
                            {formatINR(order.total)}
                          </span>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
