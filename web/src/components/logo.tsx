/**
 * Brand mark: a gateway arch inside a rounded square. Drawn as inline SVG so it
 * inherits the page's colour system, prints crisply at any size, and adds zero
 * image requests. The standalone favicon twin lives at web/public/assets/.
 */
export function LogoMark({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={className}
      role="img"
      aria-label="LeuwongRR Gateway"
    >
      <rect width="24" height="24" rx="6" fill="#3584e4" />
      <path
        d="M7 17v-6a5 5 0 0 1 10 0v6"
        fill="none"
        stroke="#ffffff"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path d="M5 17h14" stroke="#ffffff" strokeWidth="2" strokeLinecap="round" />
      <circle cx="12" cy="11" r="1.4" fill="#ffffff" />
    </svg>
  );
}

export function LogoWordmark({ compact = false }: { compact?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2">
      <LogoMark size={22} />
      <span className="leading-tight">
        <span className="block text-sm font-semibold tracking-tight">LeuwongRR</span>
        {!compact && <span className="block text-[11px] text-muted">Gateway</span>}
      </span>
    </span>
  );
}
