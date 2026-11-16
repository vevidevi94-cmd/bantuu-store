import { useEffect } from 'react';
import { Minus, Plus, ShoppingBag, Trash2, X } from 'lucide-react';
import { calculateCartTotals, formatINR, type CartItem, type StoreSettings } from '../utils/storeLogic';
import { MediaRenderer } from './MediaRenderer';

interface CartDrawerProps {
  isOpen: boolean;
  items: CartItem[];
  settings: StoreSettings;
  onClose: () => void;
  onUpdateQuantity: (productId: string, quantity: number) => void;
  onRemoveItem: (productId: string) => void;
  onCheckout: () => void;
}

export function CartDrawer({
  isOpen,
  items,
  settings,
  onClose,
  onUpdateQuantity,
  onRemoveItem,
  onCheckout,
}: CartDrawerProps) {
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

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-[#091322]/65 backdrop-blur-xs"
      role="dialog"
      aria-modal="true"
      aria-label="Shopping Cart"
      onClick={onClose}
    >
      <aside
        className="w-full max-w-md bg-white h-full border-l border-[#DED8C8] flex flex-col shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-5 bg-[#0F1D32] text-[#F7F5EE] border-b border-[#223654] flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-[#F7F5EE]">Your Shopping Bag</h2>
            <p className="text-xs text-[#C6A45C] mt-0.5 tabular-nums">
              {totals.itemCount} {totals.itemCount === 1 ? 'item' : 'items'}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close shopping bag"
            className="w-10 h-10 inline-flex items-center justify-center rounded-lg border border-[#223654] bg-[#172A46] text-[#F7F5EE] hover:bg-[#1F3659] transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {items.length > 0 && (
          <div className="px-6 py-3 bg-[#F7F5EE] border-b border-[#DED8C8] text-xs text-[#3E4756]">
            {totals.amountToFreeShipping === 0
              ? 'You unlocked complimentary delivery on this order.'
              : `Add ${formatINR(totals.amountToFreeShipping)} more for complimentary delivery.`}
          </div>
        )}

        <div className="flex-1 overflow-y-auto px-6 py-5 divide-y divide-[#DED8C8]">
          {items.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-center py-16">
              <div className="w-12 h-12 rounded-full bg-[#0F1D32] text-[#C6A45C] flex items-center justify-center mb-4">
                <ShoppingBag className="w-5 h-5" />
              </div>
              <p className="text-base font-medium text-[#0F1D32]">Your bag is empty</p>
              <p className="text-sm text-[#5C5852] mt-1 max-w-xs">
                Browse Bantuu Store essentials and add items to your bag or click Buy Now directly.
              </p>
            </div>
          ) : (
            items.map((item) => (
              <div key={item.productId} className="py-4 first:pt-0 last:pb-0 flex gap-4">
                <div className="w-20 h-20 rounded-lg overflow-hidden bg-[#F7F5EE] border border-[#DED8C8] shrink-0">
                  <MediaRenderer
                    url={item.imageUrl}
                    type="image"
                    alt={item.name}
                    className="w-full h-full object-cover"
                  />
                </div>
                <div className="flex-1 min-w-0 flex flex-col justify-between">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="text-[11px] uppercase tracking-wider text-[#8A6D32] font-medium">
                        {item.category}
                      </p>
                      <h3 className="text-sm font-medium text-[#0F1D32] leading-snug line-clamp-1">
                        {item.name}
                      </h3>
                    </div>
                    <button
                      type="button"
                      onClick={() => onRemoveItem(item.productId)}
                      aria-label={`Remove ${item.name} from bag`}
                      className="p-1.5 text-[#5C5852] hover:text-[#B91C1C] transition-colors cursor-pointer"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>

                  <div className="flex items-center justify-between mt-3">
                    <div className="inline-flex items-center border border-[#DED8C8] rounded-md bg-[#F7F5EE]">
                      <button
                        type="button"
                        onClick={() => onUpdateQuantity(item.productId, item.quantity - 1)}
                        aria-label={`Decrease quantity of ${item.name}`}
                        className="w-8 h-8 inline-flex items-center justify-center hover:bg-[#ECE7DA] rounded-l-md cursor-pointer"
                      >
                        <Minus className="w-3.5 h-3.5" />
                      </button>
                      <span className="w-8 text-center text-xs font-mono font-medium tabular-nums">
                        {item.quantity}
                      </span>
                      <button
                        type="button"
                        onClick={() => onUpdateQuantity(item.productId, item.quantity + 1)}
                        aria-label={`Increase quantity of ${item.name}`}
                        className="w-8 h-8 inline-flex items-center justify-center hover:bg-[#ECE7DA] rounded-r-md cursor-pointer"
                      >
                        <Plus className="w-3.5 h-3.5" />
                      </button>
                    </div>
                    <span className="text-sm font-mono font-semibold text-[#0F1D32] tabular-nums">
                      {formatINR(item.price * item.quantity)}
                    </span>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>

        {items.length > 0 && (
          <div className="px-6 py-5 border-t border-[#DED8C8] bg-[#F7F5EE] space-y-4">
            <div className="space-y-1.5 text-sm">
              <div className="flex items-center justify-between text-[#5C5852]">
                <span>Subtotal</span>
                <span className="font-mono tabular-nums text-[#0F1D32]">
                  {formatINR(totals.subtotal)}
                </span>
              </div>
              <div className="flex items-center justify-between text-[#5C5852]">
                <span>Delivery</span>
                <span className="font-mono tabular-nums text-[#0F1D32]">
                  {totals.shippingFee === 0 ? 'FREE' : formatINR(totals.shippingFee)}
                </span>
              </div>
              <div className="pt-2 border-t border-[#DED8C8] flex items-center justify-between font-semibold text-[#0F1D32]">
                <span>Total</span>
                <span className="font-mono text-base tabular-nums">{formatINR(totals.total)}</span>
              </div>
            </div>

            <button
              type="button"
              onClick={onCheckout}
              className="w-full py-3 px-4 rounded-lg bg-[#0F1D32] text-[#F7F5EE] text-sm font-medium hover:bg-[#172A46] transition-colors cursor-pointer"
            >
              Proceed to Checkout (COD / UPI)
            </button>
          </div>
        )}
      </aside>
    </div>
  );
}
