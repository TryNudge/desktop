export default function GradientSpinner({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className="animate-[spin_1.2s_linear_infinite]"
    >
      <defs>
        <linearGradient id="nudge-gradient" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#7a00b4" />
          <stop offset="25%" stopColor="#be05c6" />
          <stop offset="50%" stopColor="#ee3e1e" />
          <stop offset="75%" stopColor="#f16f08" />
          <stop offset="100%" stopColor="#f7c709" />
        </linearGradient>
      </defs>
      <circle
        cx="12"
        cy="12"
        r="10"
        fill="none"
        stroke="url(#nudge-gradient)"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeDasharray="45 20"
      />
    </svg>
  )
}
