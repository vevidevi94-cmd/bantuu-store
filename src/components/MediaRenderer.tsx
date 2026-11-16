import { useState } from 'react';
import { Film, Package } from 'lucide-react';
import type { MediaType } from '../utils/storeLogic';

interface MediaRendererProps {
  url: string;
  type: MediaType;
  alt: string;
  className?: string;
  controls?: boolean;
  autoPlay?: boolean;
  muted?: boolean;
}

export function MediaRenderer({
  url,
  type,
  alt,
  className = 'w-full h-full object-cover',
  controls = true,
  autoPlay = false,
  muted = false,
}: MediaRendererProps) {
  const [hasError, setHasError] = useState(false);

  if (!url || hasError) {
    return (
      <div
        className={`flex flex-col items-center justify-center bg-[#EFECE6] text-[#6B655E] p-4 text-center ${className}`}
        role="img"
        aria-label={alt}
      >
        {type === 'video' ? (
          <Film className="w-7 h-7 mb-2 opacity-60" strokeWidth={1.5} />
        ) : (
          <Package className="w-7 h-7 mb-2 opacity-60" strokeWidth={1.5} />
        )}
        <span className="text-xs font-medium line-clamp-2 max-w-[180px]">{alt}</span>
      </div>
    );
  }

  if (type === 'video') {
    return (
      <video
        src={url}
        controls={controls}
        autoPlay={autoPlay}
        muted={muted}
        playsInline
        preload="metadata"
        aria-label={alt}
        className={className}
        onError={() => setHasError(true)}
      />
    );
  }

  return (
    <img
      src={url}
      alt={alt}
      referrerPolicy="no-referrer"
      className={className}
      onError={() => setHasError(true)}
    />
  );
}
