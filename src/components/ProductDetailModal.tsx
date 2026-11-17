import { useEffect, useState } from 'react';
import { Check, Film, Minus, Plus, ShoppingBag, X, Zap } from 'lucide-react';
import { formatINR, type Product } from '../utils/storeLogic';
import { MediaRenderer } from './MediaRenderer';

interface ProductDetailModalProps {
  product: Product | null;
  onClose: () => void;
  onAddToCart: (product: Product, quantity: number) => void;
  onBuyNow: (product: Product, quantity: number) => void;
}

export function ProductDetailModal({
  product,
  onClose,
  onAddToCart,
  onBuyNow,
}: ProductDetailModalProps) {
  const [activeMediaIndex, setActiveMediaIndex] = useState(0);
  const [quantity, setQuantity] = useState(1);
  const [addedFeedback, setAddedFeedback] = useState(false);

  useEffect(() => {
    setActiveMediaIndex(0);
    setQuantity(1);
    setAddedFeedback(false);
  }, [product?.id]);

  useEffect(() => {
    if (!product) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [product, onClose]);

  if (!product) return null;

  const mediaList = product.media.length > 0 ? product.media : [];
  const activeMedia = mediaList[activeMediaIndex] || mediaList[0];
  const outOfStock = product.stock <= 0;

  const handleAdd = () => {
    if (outOfStock) return;
    onAddToCart(product, quantity);
    setAddedFeedback(true);
    window.setTimeout(() => setAddedFeedback(false), 1600);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[#091322]/70 backdrop-blur-xs p-4 sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="pdp-title"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-4xl bg-white border border-[#DED8C8] rounded-xl overflow-hidden shadow-2xl max-h-[90vh] flex flex-col md:flex-row"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label={`Close ${product.name} details`}
          className="absolute top-4 right-4 z-10 inline-flex items-center justify-center w-10 h-10 rounded-lg bg-[#0F1D32] border border-[#223654] text-[#F7F5EE] hover:bg-[#172A46] transition-colors cursor-pointer"
        >
          <X className="w-5 h-5" />
        </button>

        {/* Left Media Gallery (Photos & Videos) */}
        <div className="w-full md:w-[54%] bg-[#F7F5EE] p-5 flex flex-col gap-4 border-b md:border-b-0 md:border-r border-[#DED8C8]">
          <div className="relative aspect-[3/4] w-full max-w-[340px] mx-auto rounded-lg overflow-hidden bg-[#ECE7DA] border border-[#DED8C8]">
            {activeMedia ? (
              <MediaRenderer
                key={activeMedia.url}
                url={activeMedia.url}
                type={activeMedia.type}
                alt={product.name}
                className="w-full h-full object-cover"
                controls
              />
            ) : (
              <MediaRenderer url="" type="image" alt={product.name} />
            )}
          </div>

          {mediaList.length > 1 && (
            <div className="flex items-center gap-2.5 overflow-x-auto pb-1">
              {mediaList.map((item, idx) => {
                const isSelected = idx === activeMediaIndex;
                return (
                  <button
                    key={item.id || idx}
                    type="button"
                    onClick={() => setActiveMediaIndex(idx)}
                    aria-label={`View ${item.type} ${idx + 1} for ${product.name}`}
                    className={`relative w-12 aspect-[3/4] rounded-md overflow-hidden shrink-0 border transition-all cursor-pointer ${
                      isSelected
                        ? 'border-[#C6A45C] ring-2 ring-[#C6A45C]/40'
                        : 'border-[#DED8C8] opacity-75 hover:opacity-100'
                    }`}
                  >
                    {item.type === 'video' ? (
                      <div className="w-full h-full bg-[#0F1D32] text-[#C6A45C] flex flex-col items-center justify-center gap-0.5">
                        <Film className="w-4 h-4" />
                        <span className="text-[10px] font-medium text-[#F7F5EE]">Video</span>
                      </div>
                    ) : (
                      <img
                        src={item.url}
                        alt={`${product.name} thumbnail ${idx + 1}`}
                        referrerPolicy="no-referrer"
                        className="w-full h-full object-cover"
                      />
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Right Contiguous Purchase Module */}
        <div className="w-full md:w-[46%] p-6 sm:p-8 flex flex-col justify-between overflow-y-auto">
          <div>
            <div className="flex items-center gap-2 text-xs text-[#8A6D32] uppercase tracking-wider font-semibold">
              <span>{product.category}</span>
              <span aria-hidden="true">·</span>
              <span className="text-[#5C5852] font-normal">
                {outOfStock ? 'Out of stock' : `${product.stock} in stock`}
              </span>
            </div>

            <h2
              id="pdp-title"
              className="mt-2 text-2xl sm:text-3xl font-semibold text-[#0F1D32] leading-tight"
            >
              {product.name}
            </h2>

            <p className="mt-3 text-2xl font-mono font-semibold text-[#0F1D32] tabular-nums">
              {formatINR(product.price)}
            </p>

            <p className="mt-4 text-sm sm:text-base text-[#3E4756] leading-relaxed">
              {product.description}
            </p>

            <div className="mt-6 pt-5 border-t border-[#DED8C8] flex items-center justify-between text-xs text-[#5C5852]">
              <span>Cash on Delivery &amp; UPI accepted</span>
              <span>Free delivery over ₹999</span>
            </div>
          </div>

          <div className="mt-8 space-y-4">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-[#0F1D32]">Quantity</span>
              <div className="inline-flex items-center border border-[#DED8C8] rounded-lg bg-[#F7F5EE]">
                <button
                  type="button"
                  onClick={() => setQuantity((q) => Math.max(1, q - 1))}
                  disabled={quantity <= 1 || outOfStock}
                  aria-label="Decrease quantity"
                  className="w-10 h-10 inline-flex items-center justify-center text-[#0F1D32] disabled:opacity-40 hover:bg-[#ECE7DA] rounded-l-lg transition-colors cursor-pointer"
                >
                  <Minus className="w-4 h-4" />
                </button>
                <span className="w-10 text-center font-mono text-sm font-medium tabular-nums">
                  {quantity}
                </span>
                <button
                  type="button"
                  onClick={() => setQuantity((q) => Math.min(Math.max(1, product.stock), q + 1))}
                  disabled={quantity >= product.stock || outOfStock}
                  aria-label="Increase quantity"
                  className="w-10 h-10 inline-flex items-center justify-center text-[#0F1D32] disabled:opacity-40 hover:bg-[#ECE7DA] rounded-r-lg transition-colors cursor-pointer"
                >
                  <Plus className="w-4 h-4" />
                </button>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <button
                type="button"
                disabled={outOfStock}
                onClick={handleAdd}
                className="inline-flex items-center justify-center gap-2 px-4 py-3 text-sm font-medium rounded-lg border border-[#0F1D32] text-[#0F1D32] bg-white hover:bg-[#F7F5EE] disabled:opacity-40 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                {addedFeedback ? (
                  <>
                    <Check className="w-4 h-4 text-[#8A6D32]" />
                    <span>Added</span>
                  </>
                ) : (
                  <>
                    <ShoppingBag className="w-4 h-4" />
                    <span>Add to Cart</span>
                  </>
                )}
              </button>

              <button
                type="button"
                disabled={outOfStock}
                onClick={() => onBuyNow(product, quantity)}
                className="inline-flex items-center justify-center gap-2 px-4 py-3 text-sm font-semibold rounded-lg bg-[#C6A45C] text-[#0F1D32] hover:bg-[#B69249] disabled:opacity-40 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Zap className="w-4 h-4" />
                <span>Buy Now</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
