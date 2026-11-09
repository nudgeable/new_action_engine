"use client";

import { useEffect, useState } from "react";
import { Check } from "lucide-react";

/** Each step "runs" for a random time in this range (ms) before ticking off. */
const STEP_MIN_MS = 1400;
const STEP_MAX_MS = 3000;

/**
 * Admin loading overlay that works through a general checklist (reading,
 * finding, sorting, generating…): finished steps get a tick, the current one
 * spins, later ones wait. It's for engagement, not a real progress readout:
 * steps advance on loose random timers and the last one keeps running until
 * the caller unmounts this, i.e. when the dashboard data is actually ready.
 */
export default function AdminStepLoader({
  title = "Preparing your dashboard",
  subtitle = "Pulling everything together for this batch",
  steps,
}: {
  title?: string;
  subtitle?: string;
  steps: readonly string[];
}) {
  const [active, setActive] = useState(0);

  useEffect(() => {
    // Hold on the last step: it finishes when the real data does.
    if (active >= steps.length - 1) return;
    const delay = STEP_MIN_MS + Math.random() * (STEP_MAX_MS - STEP_MIN_MS);
    const timer = setTimeout(() => setActive((index) => index + 1), delay);
    return () => clearTimeout(timer);
  }, [active, steps.length]);

  // The running step counts as half done so the bar keeps moving.
  const fill = ((active + 0.5) / steps.length) * 100;

  return (
    <div className="page-loader page-loader--admin" role="status" aria-live="polite" aria-busy="true">
      <div className="admin-step-loader">
        <div className="admin-step-loader__head">
          <span className="admin-step-loader__ring" aria-hidden="true">
            <span className="page-loader__spinner" />
          </span>
          <div className="admin-step-loader__heading">
            <p className="admin-step-loader__title">{title}</p>
            <p className="admin-step-loader__subtitle">{subtitle}</p>
          </div>
          <span className="admin-step-loader__count">
            {active + 1}/{steps.length}
          </span>
        </div>

        <div className="admin-step-loader__bar" aria-hidden="true">
          <span style={{ width: `${fill}%` }} />
        </div>

        <ol className="admin-step-loader__list">
          {steps.map((label, index) => {
            const state = index < active ? "done" : index === active ? "running" : "waiting";
            return (
              <li key={label} className={`admin-step-loader__step admin-step-loader__step--${state}`}>
                <span className="admin-step-loader__icon" aria-hidden="true">
                  {state === "done" ? <Check size={11} strokeWidth={3.4} /> : null}
                </span>
                <span className="admin-step-loader__label">{label}</span>
              </li>
            );
          })}
        </ol>

        <p className="admin-step-loader__foot">This usually takes just a few seconds</p>

        <span className="sr-only">{`Step ${active + 1} of ${steps.length}: ${steps[active]}`}</span>
      </div>
    </div>
  );
}
