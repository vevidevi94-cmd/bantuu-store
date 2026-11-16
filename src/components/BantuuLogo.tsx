interface BantuuLogoProps {
  variant?: 'dark' | 'light';
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

export function BantuuLogo({
  variant = 'dark',
  size = 'md',
  className = '',
}: BantuuLogoProps) {
  const textColor = variant === 'dark' ? '#FFFFFF' : '#0F1D32';
  const subColor = variant === 'dark' ? '#F7F5EE' : '#3E4756';
  const goldColor = '#C6A45C';

  const dimensions =
    size === 'sm'
      ? {
          gap: 'gap-2 sm:gap-3',
          icon: 'w-10 h-10 sm:w-12 sm:h-12',
          title: 'text-[26px] sm:text-[34px]',
          sub: 'text-[11px] sm:text-[14px]',
          storeGap: '-mt-0.5 sm:-mt-1',
        }
      : size === 'lg'
        ? {
            gap: 'gap-3 sm:gap-4',
            icon: 'w-14 h-14 sm:w-16 sm:h-16',
            title: 'text-[38px] sm:text-[48px]',
            sub: 'text-[15px] sm:text-[18px]',
            storeGap: '-mt-1',
          }
        : {
            gap: 'gap-2.5 sm:gap-3.5',
            icon: 'w-11 h-11 sm:w-14 sm:h-14',
            title: 'text-[30px] sm:text-[40px]',
            sub: 'text-[12px] sm:text-[16px]',
            storeGap: '-mt-0.5 sm:-mt-1',
          };

  return (
    <span className={`inline-flex items-center ${dimensions.gap} select-none shrink-0 ${className}`}>
      {/* Gold Arched B Monogram matching brand mark */}
      <svg
        viewBox="0 0 64 64"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className={`${dimensions.icon} shrink-0`}
        aria-hidden="true"
      >
        {/* Outer arch with top stem & open bottom base */}
        <path
          d="M12 52V28C12 16.954 20.954 8 32 8C43.046 8 52 16.954 52 28V52H41.5"
          stroke={goldColor}
          strokeWidth="4.2"
          strokeLinecap="square"
          strokeLinejoin="miter"
        />
        <path
          d="M12 52H17"
          stroke={goldColor}
          strokeWidth="4.2"
          strokeLinecap="square"
        />
        {/* Top connector notch */}
        <path
          d="M32 8V14.5"
          stroke={goldColor}
          strokeWidth="4.2"
          strokeLinecap="square"
        />
        {/* Inner stylized B monogram */}
        <path
          d="M20.5 52V25.5C20.5 19.2 25.5 14.8 31.8 14.8C37.2 14.8 41.2 18.2 41.2 23.2C41.2 27.1 38.6 30 34.8 31.1C39.8 32.3 43.2 36.1 43.2 41.4C43.2 47.6 38.2 52 31.4 52H20.5Z"
          stroke={goldColor}
          strokeWidth="4.2"
          strokeLinejoin="round"
        />
        <path
          d="M20.5 31.5H33.5"
          stroke={goldColor}
          strokeWidth="4.2"
          strokeLinecap="square"
        />
      </svg>

      <span className="inline-flex flex-col items-start leading-none">
        <span
          style={{ color: textColor }}
          className={`${dimensions.title} font-display font-normal tracking-tight leading-[0.88] lowercase whitespace-nowrap`}
        >
          bantuu
        </span>
        {/* Nest lowercase serif 'store' directly below 'uu' */}
        <span className={`${dimensions.storeGap} inline-flex items-baseline leading-none whitespace-nowrap`}>
          <span
            aria-hidden="true"
            className={`${dimensions.title} font-display font-normal tracking-tight invisible select-none leading-none h-0 overflow-hidden`}
          >
            bant
          </span>
          <span
            style={{ color: subColor }}
            className={`${dimensions.sub} font-display font-normal tracking-[0.04em] lowercase whitespace-nowrap leading-none`}
          >
            store
          </span>
        </span>
      </span>
    </span>
  );
}
