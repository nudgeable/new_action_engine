import React from "react";

type PageLoaderProps = {
  /** Optional status text under the animation */
  label?: string;
  /** Optional second line under the label — lighter weight, for a short explanatory note (e.g. an expected wait time) */
  sublabel?: string;
  /**
   * Where the overlay sits:
   * - main: participant content area (keeps sidebar clear)
   * - admin: admin content area (keeps admin sidebar clear); always a plain
   *   spinner card rather than a themed animation
   * - fullscreen: entire viewport (auth, etc.)
   */
  variant?: "main" | "admin" | "fullscreen";
  /**
   * Which animation to show:
   * - default: Nudgie checking a stack of documents
   * - wallet: coins dropping into the Commitment Points bucket
   * - email-dance / email-door / email-notebook: the three steps after a
   *   reminder email's "Mark done" link — Nudgie dances on the click, walks
   *   through the door while signing in, then writes in the notebook while the
   *   action is saved (timing in lib/email-link-sequence.ts)
   */
  theme?: "default" | "wallet" | "email-dance" | "email-door" | "email-notebook";
};

const NUDGIE_LOADER_SRC = {
  default: "/loader/nudgie-loading.gif",
  "email-dance": "/loader/nudgie-dance.gif",
  "email-door": "/loader/nudgie-door.gif",
  "email-notebook": "/loader/nudgie-notebook.gif",
} as const;

/** Animated Nudgie GIF (public/loader/) on a white card so its black
 * outlines read against the dark backdrop. */
function NudgieLoader({ src }: { src: string }) {
  return (
    <div className="page-loader__nudgie" aria-hidden="true">
      <img src={src} alt="" width={240} height={240} />
    </div>
  );
}

// Static demo fill so the bucket reads as "already holding something" while
// data loads — same two-tone treatment and proportions as the live bucket on
// the Commitment Points page (see TeamBucket in app/(app)/wallet/page.tsx).
const LOADER_PLAN_FILL_HEIGHT = 68;
const LOADER_ACTION_FILL_HEIGHT = 40;
const LOADER_PLAN_FILL_TOP = 249 - LOADER_PLAN_FILL_HEIGHT;
const LOADER_TOTAL_FILL_TOP = LOADER_PLAN_FILL_TOP - LOADER_ACTION_FILL_HEIGHT;

/** Three coins fall into the bucket mouth on a staggered loop, landing on the fill with a ripple. */
function WalletBucketLoader() {
  return (
    <svg className="page-loader__bucket" viewBox="0 0 280 300" role="img" aria-hidden="true">
      <defs>
        <clipPath id="pageLoaderBucketClip">
          <path d="M50 78 L230 78 L207 249 Q140 273 73 249 Z" />
        </clipPath>
        <radialGradient id="pageLoaderCoinGrad" cx="34%" cy="28%" r="75%">
          <stop offset="0%" stopColor="#fff6b8" />
          <stop offset="42%" stopColor="#ffce00" />
          <stop offset="100%" stopColor="#b8860b" />
        </radialGradient>
      </defs>

      <path d="M72 80 Q140 5 208 80" fill="none" stroke="#fff" strokeWidth="7" strokeLinecap="round" opacity=".95" />
      <path d="M50 78 L230 78 L207 249 Q140 273 73 249 Z" fill="#332d34" stroke="#fff" strokeWidth="6" strokeLinejoin="round" />

      <g clipPath="url(#pageLoaderBucketClip)">
        <rect x="45" y={LOADER_PLAN_FILL_TOP} width="190" height={LOADER_PLAN_FILL_HEIGHT + 18} fill="#f3ae45" />
      </g>
      <g clipPath="url(#pageLoaderBucketClip)">
        <rect x="45" y={LOADER_TOTAL_FILL_TOP} width="190" height={LOADER_ACTION_FILL_HEIGHT + 2} fill="#ffce00" />
      </g>
      <g clipPath="url(#pageLoaderBucketClip)">
        <path
          d={`M45 ${LOADER_TOTAL_FILL_TOP + 3} Q76 ${LOADER_TOTAL_FILL_TOP - 7} 107 ${LOADER_TOTAL_FILL_TOP + 3} T169 ${LOADER_TOTAL_FILL_TOP + 3} T235 ${LOADER_TOTAL_FILL_TOP + 3} L235 ${LOADER_TOTAL_FILL_TOP + 15} L45 ${LOADER_TOTAL_FILL_TOP + 15} Z`}
          fill="#ffda33"
        />
      </g>

      <g aria-hidden="true">
        {[-24, 0, 24].map((dx, i) => (
          <g key={dx} transform={`translate(${140 + dx} 0)`}>
            <g className="wallet-bucket-coin" style={{ animationDelay: `${i * 0.85}s` }}>
              <ellipse cx="0" cy="14" rx="8.5" ry="8.5" fill="url(#pageLoaderCoinGrad)" stroke="#fff0a2" strokeWidth="1.3" />
              <circle cx="0" cy="14" r="5.4" fill="none" stroke="rgba(120,85,0,.4)" strokeWidth="1" />
              <ellipse cx="-2.6" cy="11" rx="2.2" ry="1.4" fill="rgba(255,255,255,.65)" />
            </g>
          </g>
        ))}
      </g>

      <g clipPath="url(#pageLoaderBucketClip)" aria-hidden="true">
        {[-24, 0, 24].map((dx, i) => (
          <g key={dx} transform={`translate(${140 + dx} ${LOADER_TOTAL_FILL_TOP})`}>
            <g className="wallet-bucket-splash" style={{ animationDelay: `${i * 0.85}s` }}>
              <ellipse cx="0" cy="0" rx="13" ry="4.5" className="wallet-bucket-splash-ring" />
              <circle cx="-6" cy="-3" r="1.5" className="wallet-bucket-splash-spark" />
              <circle cx="7" cy="-4" r="1.2" className="wallet-bucket-splash-spark" />
              <circle cx="1" cy="-6" r="1.1" className="wallet-bucket-splash-spark" />
            </g>
          </g>
        ))}
      </g>
    </svg>
  );
}

/**
 * Viewport-locked loading state: blurred backdrop, plus a themed centerpiece
 * (Nudgie checking documents, or coins dropping into the Commitment Bank
 * bucket). Position is fixed to
 * the visible area so tab switches don't push the centerpiece into the
 * wrong place.
 */
export default function PageLoader({ label, sublabel, variant = "fullscreen", theme = "default" }: PageLoaderProps) {
  const isAdmin = variant === "admin";
  const resolvedLabel =
    label ?? (isAdmin ? "Loading…" : theme === "wallet" ? "Transferring to your Commitment Points" : undefined);
  return (
    <div
      className={`page-loader page-loader--${variant}`}
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <div className="page-loader__content">
        {isAdmin ? (
          <span className="page-loader__spinner" aria-hidden="true" />
        ) : theme === "wallet" ? (
          <WalletBucketLoader />
        ) : (
          <NudgieLoader src={NUDGIE_LOADER_SRC[theme]} />
        )}
        {resolvedLabel ? <p className="page-loader__label">{resolvedLabel}</p> : null}
        {sublabel ? <p className="page-loader__sublabel">{sublabel}</p> : null}
        <span className="sr-only">{[resolvedLabel, sublabel].filter(Boolean).join(" — ") || "Loading"}</span>
      </div>
    </div>
  );
}
