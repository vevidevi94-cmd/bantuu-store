import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Banknote, Check, CheckCircle2, Copy, ExternalLink, QrCode, Smartphone, X } from 'lucide-react';
import {
  buildPhonePePaymentUri,
  buildUpiPaymentUri,
  calculateCartTotals,
  formatINR,
  formatOrderDateTime,
  validateCheckoutForm,
  type CartItem,
  type Order,
  type PaymentMethod,
  type StoreSettings,
} from '../utils/storeLogic';
import { MediaRenderer } from './MediaRenderer';

interface CheckoutModalProps {
  isOpen: boolean;
  items: CartItem[];
  modeLabel: string;
  settings: StoreSettings;
  onClose: () => void;
  onOrderCreated: (order: Order) => void;
}

function DeterministicUpiQr({ seed }: { seed: string }) {
  const cells = useMemo(() => {
    let hash = 2166136261;
    for (let i = 0; i < seed.length; i += 1) {
      hash ^= seed.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    const grid: boolean[] = [];
    for (let r = 0; r < 11; r += 1) {
      for (let c = 0; c < 11; c += 1) {
        const inTopLeft = r < 3 && c < 3;
        const inTopRight = r < 3 && c >= 8;
        const inBottomLeft = r >= 8 && c < 3;
        if (inTopLeft || inTopRight || inBottomLeft) {
          const lr = r >= 8 ? r - 8 : r;
          const lc = c >= 8 ? c - 8 : c;
          grid.push(lr === 0 || lr === 2 || lc === 0 || lc === 2 || (lr === 1 && lc === 1));
        } else {
          hash ^= (r * 31 + c * 17) & 0xff;
          hash = Math.imul(hash, 16777619);
          grid.push((hash & 1) === 1);
        }
      }
    }
    return grid;
  }, [seed]);

  return (
    <svg
      viewBox="0 0 110 110"
      className="w-28 h-28 bg-white p-2 rounded-lg border border-[#DED8C8] shrink-0"
      role="img"
      aria-label="UPI Payment QR Preview"
    >
      {cells.map((filled, idx) => {
        if (!filled) return null;
        const row = Math.floor(idx / 11);
        const col = idx % 11;
        return (
          <rect
            key={idx}
            x={col * 10}
            y={row * 10}
            width={9.2}
            height={9.2}
            rx={1.5}
            fill="#0F1D32"
          />
        );
      })}
    </svg>
  );
}

export function CheckoutModal({
  isOpen,
  items,
  modeLabel,
  settings,
  onClose,
  onOrderCreated,
}: CheckoutModalProps) {
  const [customerName, setCustomerName] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [address, setAddress] = useState('');
  const [city, setCity] = useState('');
  const [pincode, setPincode] = useState('');
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('COD');
  const [upiCustomerId, setUpiCustomerId] = useState('');
  const [upiTransactionId, setUpiTransactionId] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [serverError, setServerError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [confirmedOrder, setConfirmedOrder] = useState<Order | null>(null);
  const [copiedUpi, setCopiedUpi] = useState(false);
  const [qrLoadError, setQrLoadError] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setErrors({});
    setServerError('');
    setConfirmedOrder(null);
    setSubmitting(false);
    setQrLoadError(false);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const totals = calculateCartTotals(
    items,
    settings.freeShippingThreshold,
    settings.shippingFee,
  );
  const upiUri = buildUpiPaymentUri(
    settings.upiId,
    settings.merchantName,
    totals.total,
    `${settings.storeName} Order`,
  );
  const phonePeUri = buildPhonePePaymentUri(
    settings.upiId,
    settings.merchantName,
    totals.total,
    `${settings.storeName} Order`,
  );

  const handleCopyUpi = async () => {
    try {
      await navigator.clipboard.writeText(settings.upiId);
      setCopiedUpi(true);
      window.setTimeout(() => setCopiedUpi(false), 1800);
    } catch {
      // Clipboard blocked in non-HTTPS contexts; ignore silently
    }
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setServerError('');

    const validation = validateCheckoutForm({
      customerName,
      customerPhone,
      address,
      city,
      pincode,
      paymentMethod,
      upiCustomerId,
      upiTransactionId,
    });
    if (Object.keys(validation).length > 0) {
      setErrors(validation);
      return;
    }

    setErrors({});
    setSubmitting(true);

    try {
      const response = await fetch('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customerName,
          customerPhone,
          address,
          city,
          pincode,
          paymentMethod,
          upiCustomerId: paymentMethod === 'UPI' ? upiCustomerId : undefined,
          upiTransactionId: paymentMethod === 'UPI' ? upiTransactionId : undefined,
          items: items.map((item) => ({
            productId: item.productId,
            quantity: item.quantity,
          })),
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        if (data.errors) setErrors(data.errors);
        setServerError(data.error || 'Could not complete order.');
        setSubmitting(false);
        return;
      }

      setConfirmedOrder(data.order);
      onOrderCreated(data.order);
      setCustomerName('');
      setCustomerPhone('');
      setAddress('');
      setCity('');
      setPincode('');
      setUpiCustomerId('');
      setUpiTransactionId('');
    } catch {
      setServerError('Network error while placing order. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[#091322]/70 backdrop-blur-xs p-4 sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="checkout-modal-title"
      onClick={onClose}
    >
      <div
        className="w-full max-w-4xl bg-white border border-[#DED8C8] rounded-xl overflow-hidden shadow-2xl max-h-[92vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-4 bg-[#0F1D32] text-[#F7F5EE] border-b border-[#223654] flex items-center justify-between">
          <div>
            <p className="text-xs text-[#C6A45C] uppercase tracking-wider font-medium">
              {confirmedOrder ? 'Order Confirmation' : modeLabel}
            </p>
            <h2 id="checkout-modal-title" className="text-lg font-semibold text-[#F7F5EE]">
              {confirmedOrder ? `Order ${confirmedOrder.orderNumber} Confirmed` : 'Complete Your Order'}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close checkout"
            className="w-10 h-10 inline-flex items-center justify-center rounded-lg border border-[#223654] bg-[#172A46] text-[#F7F5EE] hover:bg-[#1F3659] transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {confirmedOrder ? (
          <div className="p-6 sm:p-8 overflow-y-auto space-y-6">
            <div className="flex items-start gap-4 pb-6 border-b border-[#DED8C8]">
              <div className="w-11 h-11 rounded-full bg-[#0F1D32] text-[#C6A45C] flex items-center justify-center shrink-0">
                <CheckCircle2 className="w-6 h-6" />
              </div>
              <div>
                <h3 className="text-xl font-semibold text-[#0F1D32]">
                  Thank you, {confirmedOrder.customerName}
                </h3>
                <p className="text-sm text-[#3E4756] mt-1">
                  Your order <span className="font-mono font-semibold">{confirmedOrder.orderNumber}</span>{' '}
                  has been received on{' '}
                  <span className="font-mono font-medium">
                    {formatOrderDateTime(confirmedOrder.createdAt).full}
                  </span>
                  .
                </p>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 text-sm">
              <div className="p-4 rounded-lg bg-[#F7F5EE] border border-[#DED8C8] space-y-1.5">
                <p className="text-xs uppercase tracking-wider text-[#8A6D32] font-semibold">
                  Delivery Details
                </p>
                <p className="font-medium text-[#0F1D32]">{confirmedOrder.customerName}</p>
                <p className="text-[#3E4756]">{confirmedOrder.address}</p>
                <p className="text-[#3E4756]">
                  {confirmedOrder.city} — {confirmedOrder.pincode}
                </p>
                <p className="font-mono text-xs text-[#5C5852] pt-1">
                  Phone: {confirmedOrder.customerPhone}
                </p>
              </div>

              <div className="p-4 rounded-lg bg-[#F7F5EE] border border-[#DED8C8] space-y-1.5">
                <p className="text-xs uppercase tracking-wider text-[#8A6D32] font-semibold">
                  Payment &amp; Status
                </p>
                <p className="font-medium text-[#0F1D32]">
                  {confirmedOrder.paymentMethod === 'COD'
                    ? 'Cash on Delivery (Pay at doorstep)'
                    : 'UPI Payment'}
                </p>
                {confirmedOrder.upiTransactionId && (
                  <p className="font-mono text-xs text-[#3E4756]">
                    UTR / Ref: {confirmedOrder.upiTransactionId}
                  </p>
                )}
                <p className="text-xs text-[#5C5852]">
                  Status: <span className="font-medium text-[#0F1D32]">{confirmedOrder.status}</span>
                </p>
                <p className="font-mono text-base font-semibold text-[#0F1D32] pt-1 tabular-nums">
                  Total: {formatINR(confirmedOrder.total)}
                </p>
              </div>
            </div>

            <div className="border border-[#DED8C8] rounded-lg divide-y divide-[#DED8C8]">
              {confirmedOrder.items.map((item) => (
                <div key={item.productId} className="p-3.5 flex items-center justify-between gap-4">
                  <div className="flex items-center gap-3">
                    <div className="w-12 h-12 rounded-md overflow-hidden border border-[#DED8C8] bg-[#F7F5EE] shrink-0">
                      <MediaRenderer url={item.imageUrl} type="image" alt={item.name} />
                    </div>
                    <div>
                      <p className="text-sm font-medium text-[#0F1D32]">{item.name}</p>
                      <p className="text-xs text-[#5C5852] font-mono tabular-nums">
                        Qty {item.quantity} × {formatINR(item.price)}
                      </p>
                    </div>
                  </div>
                  <p className="text-sm font-mono font-semibold text-[#0F1D32] tabular-nums">
                    {formatINR(item.price * item.quantity)}
                  </p>
                </div>
              ))}
            </div>

            <div className="flex justify-end">
              <button
                type="button"
                onClick={onClose}
                className="px-6 py-2.5 rounded-lg bg-[#0F1D32] text-[#F7F5EE] text-sm font-medium hover:bg-[#172A46] transition-colors cursor-pointer"
              >
                Continue Shopping
              </button>
            </div>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto grid grid-cols-1 lg:grid-cols-12">
            {/* Left Form */}
            <div className="lg:col-span-7 p-6 space-y-6 border-b lg:border-b-0 lg:border-r border-[#DED8C8]">
              {serverError && (
                <div
                  role="alert"
                  className="p-3.5 rounded-lg border border-[#DC2626]/30 bg-[#FEF2F2] text-sm text-[#991B1B]"
                >
                  {serverError}
                </div>
              )}

              <div className="space-y-4">
                <h3 className="text-sm font-semibold text-[#0F1D32]">1. Shipping Details</h3>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label htmlFor="chk-name" className="block text-xs font-medium text-[#3E4756] mb-1.5">
                      Full Name
                    </label>
                    <input
                      id="chk-name"
                      type="text"
                      value={customerName}
                      onChange={(e) => setCustomerName(e.target.value)}
                      placeholder="e.g. Aarav Patel"
                      className="w-full px-3.5 py-2.5 text-sm rounded-lg border border-[#DED8C8] bg-white focus:outline-none focus:border-[#0F1D32]"
                    />
                    {errors.customerName && (
                      <p className="mt-1 text-xs text-[#B91C1C]">{errors.customerName}</p>
                    )}
                  </div>

                  <div>
                    <label htmlFor="chk-phone" className="block text-xs font-medium text-[#3E4756] mb-1.5">
                      Mobile Number (10 digits)
                    </label>
                    <input
                      id="chk-phone"
                      type="tel"
                      value={customerPhone}
                      onChange={(e) => setCustomerPhone(e.target.value)}
                      placeholder="9876543210"
                      className="w-full px-3.5 py-2.5 text-sm font-mono rounded-lg border border-[#DED8C8] bg-white focus:outline-none focus:border-[#0F1D32]"
                    />
                    {errors.customerPhone && (
                      <p className="mt-1 text-xs text-[#B91C1C]">{errors.customerPhone}</p>
                    )}
                  </div>
                </div>

                <div>
                  <label htmlFor="chk-address" className="block text-xs font-medium text-[#3E4756] mb-1.5">
                    Delivery Address
                  </label>
                  <input
                    id="chk-address"
                    type="text"
                    value={address}
                    onChange={(e) => setAddress(e.target.value)}
                    placeholder="House / Flat No., Street, Landmark"
                    className="w-full px-3.5 py-2.5 text-sm rounded-lg border border-[#DED8C8] bg-white focus:outline-none focus:border-[#0F1D32]"
                  />
                  {errors.address && (
                    <p className="mt-1 text-xs text-[#B91C1C]">{errors.address}</p>
                  )}
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label htmlFor="chk-city" className="block text-xs font-medium text-[#3E4756] mb-1.5">
                      City
                    </label>
                    <input
                      id="chk-city"
                      type="text"
                      value={city}
                      onChange={(e) => setCity(e.target.value)}
                      placeholder="Jaipur"
                      className="w-full px-3.5 py-2.5 text-sm rounded-lg border border-[#DED8C8] bg-white focus:outline-none focus:border-[#0F1D32]"
                    />
                    {errors.city && (
                      <p className="mt-1 text-xs text-[#B91C1C]">{errors.city}</p>
                    )}
                  </div>

                  <div>
                    <label htmlFor="chk-pincode" className="block text-xs font-medium text-[#3E4756] mb-1.5">
                      Pincode (6 digits)
                    </label>
                    <input
                      id="chk-pincode"
                      type="text"
                      value={pincode}
                      onChange={(e) => setPincode(e.target.value)}
                      placeholder="302001"
                      className="w-full px-3.5 py-2.5 text-sm font-mono rounded-lg border border-[#DED8C8] bg-white focus:outline-none focus:border-[#0F1D32]"
                    />
                    {errors.pincode && (
                      <p className="mt-1 text-xs text-[#B91C1C]">{errors.pincode}</p>
                    )}
                  </div>
                </div>
              </div>

              {/* Payment Method Selection */}
              <div className="space-y-3 pt-2 border-t border-[#DED8C8]">
                <h3 className="text-sm font-semibold text-[#0F1D32] pt-2">
                  2. Select Payment Option
                </h3>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <button
                    type="button"
                    onClick={() => setPaymentMethod('COD')}
                    aria-pressed={paymentMethod === 'COD'}
                    className={`p-4 rounded-lg border text-left transition-all cursor-pointer ${
                      paymentMethod === 'COD'
                        ? 'border-[#0F1D32] bg-[#F7F5EE] ring-1 ring-[#C6A45C]'
                        : 'border-[#DED8C8] bg-white hover:bg-[#F7F5EE]'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <Banknote className="w-5 h-5 text-[#8A6D32]" />
                      <span className="text-xs font-semibold text-[#0F1D32]">
                        {paymentMethod === 'COD' ? 'Selected' : 'Select'}
                      </span>
                    </div>
                    <p className="mt-2.5 text-sm font-semibold text-[#0F1D32]">Cash on Delivery</p>
                    <p className="mt-0.5 text-xs text-[#5C5852]">
                      Pay cash when your parcel arrives
                    </p>
                  </button>

                  <button
                    type="button"
                    onClick={() => setPaymentMethod('UPI')}
                    aria-pressed={paymentMethod === 'UPI'}
                    className={`p-4 rounded-lg border text-left transition-all cursor-pointer ${
                      paymentMethod === 'UPI'
                        ? 'border-[#0F1D32] bg-[#F7F5EE] ring-1 ring-[#C6A45C]'
                        : 'border-[#DED8C8] bg-white hover:bg-[#F7F5EE]'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <Smartphone className="w-5 h-5 text-[#8A6D32]" />
                      <span className="text-xs font-semibold text-[#0F1D32]">
                        {paymentMethod === 'UPI' ? 'Selected' : 'Select'}
                      </span>
                    </div>
                    <p className="mt-2.5 text-sm font-semibold text-[#0F1D32]">UPI Payment</p>
                    <p className="mt-0.5 text-xs text-[#5C5852]">
                      GPay, PhonePe, Paytm, BHIM
                    </p>
                  </button>
                </div>

                {paymentMethod === 'COD' ? (
                  <div className="p-4 rounded-lg bg-[#F7F5EE] border border-[#DED8C8] text-xs text-[#3E4756]">
                    Pay <span className="font-mono font-semibold text-[#0F1D32]">{formatINR(totals.total)}</span>{' '}
                    in cash or doorstep QR scan at delivery time. No advance fee required.
                  </div>
                ) : (
                  <div className="p-4 rounded-lg bg-[#F7F5EE] border border-[#DED8C8] space-y-4">
                    <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4">
                      {(() => {
                        const qrUrl = settings.upiQrUrl || '/assets/aistudio/47084_35196505.jpg';
                        const isPhonePeFullScreen = qrUrl.includes('47084_35196505');
                        if (!qrUrl || qrLoadError) {
                          return <DeterministicUpiQr seed={upiUri} />;
                        }
                        return (
                          <div className="w-40 h-40 sm:w-44 sm:h-44 rounded-xl overflow-hidden border border-[#DED8C8] bg-white shrink-0">
                            <img
                              src={qrUrl}
                              alt={`Scan to pay ${settings.upiId} via UPI`}
                              onError={() => setQrLoadError(true)}
                              className={
                                isPhonePeFullScreen
                                  ? 'w-full h-full object-cover object-[50%_52%] scale-[1.28]'
                                  : 'w-full h-full object-contain p-1.5'
                              }
                            />
                          </div>
                        );
                      })()}
                      <div className="space-y-2.5 flex-1 min-w-0">
                        <div className="flex items-center gap-1.5 text-xs font-semibold text-[#0F1D32]">
                          <QrCode className="w-3.5 h-3.5 text-[#8A6D32]" />
                          <span>Scan QR with PhonePe, GPay, Paytm or BHIM</span>
                        </div>
                        <p className="text-[11px] text-[#5C5852]">
                          India Post Payment Bank · Bantuu Store
                        </p>
                        <div className="flex flex-wrap items-center gap-2">
                          <code className="px-2.5 py-1.5 rounded bg-white border border-[#DED8C8] text-xs font-mono font-semibold text-[#0F1D32]">
                            {settings.upiId}
                          </code>
                          <button
                            type="button"
                            onClick={handleCopyUpi}
                            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded border border-[#DED8C8] bg-white text-xs font-medium text-[#0F1D32] hover:bg-[#ECE7DA] cursor-pointer"
                          >
                            {copiedUpi ? (
                              <>
                                <Check className="w-3.5 h-3.5 text-[#8A6D32]" />
                                <span>Copied</span>
                              </>
                            ) : (
                              <>
                                <Copy className="w-3.5 h-3.5" />
                                <span>Copy</span>
                              </>
                            )}
                          </button>
                          <a
                            href={settings.upiQrUrl || '/assets/aistudio/47084_35196505.jpg'}
                            download="bantuu-store-upi-qr.jpg"
                            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded border border-[#DED8C8] bg-white text-xs font-medium text-[#0F1D32] hover:bg-[#ECE7DA]"
                          >
                            Save QR
                          </a>
                        </div>
                        <p className="text-xs text-[#5C5852]">
                          Payable Amount:{' '}
                          <span className="font-mono font-semibold text-[#0F1D32]">
                            {formatINR(totals.total)}
                          </span>
                        </p>
                      </div>
                    </div>

                    {/* Direct PhonePe & UPI App Deep Links (no payment gateway required) */}
                    <div className="pt-3 border-t border-[#DED8C8] space-y-2">
                      <p className="text-xs font-semibold text-[#0F1D32]">
                        Direct App Payment (Opens installed app directly — no payment gateway):
                      </p>
                      <div className="flex flex-col sm:flex-row gap-2.5">
                        <a
                          href={phonePeUri}
                          className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-[#5F259F] text-white text-xs sm:text-sm font-semibold hover:bg-[#4D1D82] transition-colors whitespace-nowrap"
                        >
                          <Smartphone className="w-4 h-4 shrink-0" />
                          <span>Pay {formatINR(totals.total)} via PhonePe</span>
                          <ExternalLink className="w-3.5 h-3.5 shrink-0 opacity-90" />
                        </a>
                        <a
                          href={upiUri}
                          className="inline-flex items-center justify-center gap-1.5 px-3.5 py-2.5 rounded-lg border border-[#0F1D32] bg-white text-[#0F1D32] text-xs font-semibold hover:bg-[#ECE7DA] transition-colors whitespace-nowrap"
                        >
                          <span>Other UPI App (GPay / Paytm)</span>
                          <ExternalLink className="w-3.5 h-3.5 shrink-0" />
                        </a>
                      </div>
                      <p className="text-[11px] text-[#5C5852]">
                        After completing payment in PhonePe or your UPI app, enter the 12-digit UTR / Transaction ID below.
                      </p>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2 border-t border-[#DED8C8]">
                      <div>
                        <label
                          htmlFor="chk-upi-utr"
                          className="block text-xs font-medium text-[#3E4756] mb-1"
                        >
                          UPI Transaction ID / UTR *
                        </label>
                        <input
                          id="chk-upi-utr"
                          type="text"
                          value={upiTransactionId}
                          onChange={(e) => setUpiTransactionId(e.target.value)}
                          placeholder="e.g. 432198765012"
                          className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-[#DED8C8] bg-white focus:outline-none focus:border-[#0F1D32]"
                        />
                        {errors.upiTransactionId && (
                          <p className="mt-1 text-xs text-[#B91C1C]">{errors.upiTransactionId}</p>
                        )}
                      </div>

                      <div>
                        <label
                          htmlFor="chk-upi-id"
                          className="block text-xs font-medium text-[#3E4756] mb-1"
                        >
                          Your UPI ID (Optional)
                        </label>
                        <input
                          id="chk-upi-id"
                          type="text"
                          value={upiCustomerId}
                          onChange={(e) => setUpiCustomerId(e.target.value)}
                          placeholder="yourname@okaxis"
                          className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-[#DED8C8] bg-white focus:outline-none focus:border-[#0F1D32]"
                        />
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Right Order Summary */}
            <div className="lg:col-span-5 p-6 bg-[#F7F5EE] flex flex-col justify-between space-y-6">
              <div className="space-y-4">
                <h3 className="text-sm font-semibold text-[#0F1D32]">Order Summary</h3>
                <div className="divide-y divide-[#DED8C8] border border-[#DED8C8] rounded-lg bg-white">
                  {items.map((item) => (
                    <div key={item.productId} className="p-3 flex items-center justify-between gap-3">
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="w-12 h-12 rounded-md overflow-hidden bg-[#F7F5EE] border border-[#DED8C8] shrink-0">
                          <MediaRenderer url={item.imageUrl} type="image" alt={item.name} />
                        </div>
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-[#0F1D32] truncate">{item.name}</p>
                          <p className="text-xs font-mono text-[#5C5852] tabular-nums">
                            Qty {item.quantity} × {formatINR(item.price)}
                          </p>
                        </div>
                      </div>
                      <span className="text-sm font-mono font-medium text-[#0F1D32] tabular-nums shrink-0">
                        {formatINR(item.price * item.quantity)}
                      </span>
                    </div>
                  ))}
                </div>

                <div className="space-y-2 text-sm pt-2">
                  <div className="flex items-center justify-between text-[#5C5852]">
                    <span>Subtotal</span>
                    <span className="font-mono text-[#0F1D32] tabular-nums">
                      {formatINR(totals.subtotal)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-[#5C5852]">
                    <span>Shipping</span>
                    <span className="font-mono text-[#0F1D32] tabular-nums">
                      {totals.shippingFee === 0 ? 'FREE' : formatINR(totals.shippingFee)}
                    </span>
                  </div>
                  <div className="pt-3 border-t border-[#DED8C8] flex items-center justify-between font-semibold text-[#0F1D32]">
                    <span>Total Payable</span>
                    <span className="font-mono text-lg tabular-nums">{formatINR(totals.total)}</span>
                  </div>
                </div>
              </div>

              <button
                type="submit"
                disabled={submitting || items.length === 0}
                className="w-full py-3.5 px-5 rounded-lg bg-[#C6A45C] text-[#0F1D32] text-sm font-semibold hover:bg-[#B69249] disabled:opacity-50 transition-colors cursor-pointer"
              >
                {submitting
                  ? 'Placing Order...'
                  : `Place Order (${paymentMethod}) — ${formatINR(totals.total)}`}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
