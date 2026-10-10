/** Decorative icons: meaning is always carried by adjacent text, so they are hidden from AT. */

interface IconProps {
  readonly className?: string;
}

const base = {
  'aria-hidden': true,
  focusable: false,
  viewBox: '0 0 20 20',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.75,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

export function CheckIcon({ className = 'size-4' }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="M4.5 10.5l3.5 3.5 7.5-8" />
    </svg>
  );
}

export function CrossIcon({ className = 'size-4' }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="M5.5 5.5l9 9M14.5 5.5l-9 9" />
    </svg>
  );
}

export function SpinnerIcon({ className = 'size-4' }: IconProps) {
  return (
    <svg {...base} className={`animate-spin ${className}`}>
      <path d="M10 3a7 7 0 1 1-7 7" />
    </svg>
  );
}

export function PinIcon({ className = 'size-3.5' }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="M10 18s5.5-5.2 5.5-9.5a5.5 5.5 0 0 0-11 0C4.5 12.8 10 18 10 18z" />
      <circle cx="10" cy="8.5" r="2" />
    </svg>
  );
}

export function InfoIcon({ className = 'size-5' }: IconProps) {
  return (
    <svg {...base} className={className}>
      <circle cx="10" cy="10" r="7.5" />
      <path d="M10 9v5M10 6.2v.1" />
    </svg>
  );
}

export function AlertIcon({ className = 'size-5' }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="M10 3.5l7 12.5H3z" />
      <path d="M10 8.5v3.5M10 14.2v.1" />
    </svg>
  );
}

export function PlusIcon({ className = 'size-4' }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="M10 4.5v11M4.5 10h11" />
    </svg>
  );
}

export function SendIcon({ className = 'size-4' }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="M3.5 10h12M11 5.5l4.5 4.5-4.5 4.5" />
    </svg>
  );
}

export function StopIcon({ className = 'size-4' }: IconProps) {
  return (
    <svg {...base} className={className}>
      <rect x="5.5" y="5.5" width="9" height="9" rx="1.5" />
    </svg>
  );
}

export function CompassMark({ className = 'size-7' }: IconProps) {
  return (
    <svg aria-hidden="true" focusable="false" viewBox="0 0 32 32" className={className}>
      <circle cx="16" cy="16" r="14" fill="currentColor" />
      <path d="M16 6l4 10-4 10-4-10z" className="fill-surface" />
      <circle cx="16" cy="16" r="2" fill="currentColor" />
    </svg>
  );
}
