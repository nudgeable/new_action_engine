"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Loader2, Sparkles, X } from "lucide-react";
import { isIndianMobile } from "@/lib/whatsapp-contacts";

export type PlanFormValues = {
  designation: string;
  skillGoal: string;
  phoneDigits: string;
  whatsappOn: boolean;
};

const SAMPLE_ANSWER =
  "e.g. I want to get better at speaking up confidently in meetings, especially sharing my ideas early instead of waiting. I can practise in our Monday team meetings, weekly 1:1s with my manager and cross-team reviews.";
const MIN_ANSWER_LENGTH = 20;
const MAX_ANSWER_LENGTH = 2000;

/**
 * The plan popup on My Actions: function, WhatsApp number and one question.
 * The name comes from the profile and is only used in the greeting.
 */
export default function PlanFormModal({
  open,
  name,
  initial,
  whatsappAvailable,
  onClose,
  onSave,
  onRefine,
}: {
  open: boolean;
  name: string;
  initial: PlanFormValues;
  whatsappAvailable: boolean;
  onClose: () => void;
  /** Resolves to an error message, or nothing on success. */
  onSave: (values: PlanFormValues) => Promise<string | void>;
  /** "Refine with AI": the clearer wording to show for review, or an error message. Doesn't save. */
  onRefine: (values: PlanFormValues) => Promise<{ designation: string; skillGoal: string } | string>;
}) {
  const [values, setValues] = useState(initial);
  const [placeholder, setPlaceholder] = useState(SAMPLE_ANSWER);
  const [saving, setSaving] = useState(false);
  const [refining, setRefining] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = saving || refining;

  useEffect(() => {
    if (!open) return;
    setValues(initial);
    setError(null);
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // Reset only when the popup opens, not while the participant types.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open || typeof document === "undefined") return null;

  const needsPhone = whatsappAvailable && values.whatsappOn;
  const phoneValid = !needsPhone || isIndianMobile(values.phoneDigits);
  const valid = values.designation.trim().length > 0 && values.skillGoal.trim().length >= MIN_ANSWER_LENGTH && phoneValid;

  async function refine() {
    if (busy || !values.skillGoal.trim()) return;
    setRefining(true);
    setError(null);
    const result = await onRefine(values);
    setRefining(false);
    if (typeof result === "string") {
      setError(result);
      return;
    }
    setValues((current) => ({ ...current, designation: result.designation || current.designation, skillGoal: result.skillGoal || current.skillGoal }));
  }

  async function save() {
    if (!valid || busy) return;
    setSaving(true);
    setError(null);
    const result = await onSave({ ...values, designation: values.designation.trim(), skillGoal: values.skillGoal.trim() });
    setSaving(false);
    if (result) setError(result);
  }

  return createPortal(
    <div className="actions-history-overlay plan-form-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
      <form
        className="actions-history-modal plan-form-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="plan-form-title"
        onSubmit={(event) => { event.preventDefault(); void save(); }}
      >
        <header className="actions-history-head">
          <div>
            <h2 id="plan-form-title">Hi {name} 👋</h2>
            <p>Answer in your own words. We&apos;ll turn it into small actions for your work week.</p>
          </div>
          <button type="button" className="actions-history-close" onClick={onClose} disabled={busy} aria-label="Close"><X size={18} /></button>
        </header>

        <div className="plan-form-body">
          <div className={`plan-form-row${whatsappAvailable ? "" : " plan-form-row--single"}`}>
            <label className="plan-form-field" htmlFor="plan-form-function">
              <span>Your function</span>
              <input
                id="plan-form-function"
                value={values.designation}
                onChange={(event) => setValues((current) => ({ ...current, designation: event.target.value }))}
                placeholder="e.g. Sales · Team Lead"
                maxLength={200}
                autoFocus={!values.designation}
              />
            </label>
            {whatsappAvailable && (
              <label className="plan-form-field" htmlFor="plan-form-phone">
                <span>WhatsApp number</span>
                <span className={`plan-form-phone${values.whatsappOn ? "" : " is-off"}`}>
                  <b>+91</b>
                  <input
                    id="plan-form-phone"
                    type="tel"
                    inputMode="numeric"
                    autoComplete="tel-national"
                    value={values.phoneDigits}
                    onChange={(event) => setValues((current) => ({ ...current, phoneDigits: event.target.value.replace(/\D/g, "").slice(0, 10) }))}
                    placeholder="10-digit mobile number"
                    disabled={!values.whatsappOn}
                    aria-invalid={needsPhone && values.phoneDigits.length === 10 && !phoneValid}
                  />
                </span>
              </label>
            )}
          </div>

          <label className="plan-form-field" htmlFor="plan-form-answer">
            <strong className="plan-form-question">What skill do you want to build, and where at work will you practise it?</strong>
            <span className="plan-form-hint">Be specific: not &quot;communication&quot; but &quot;speaking up early in our Monday team meetings&quot;.</span>
            <textarea
              id="plan-form-answer"
              value={values.skillGoal}
              onChange={(event) => setValues((current) => ({ ...current, skillGoal: event.target.value }))}
              onFocus={() => setPlaceholder("")}
              onBlur={() => setPlaceholder(SAMPLE_ANSWER)}
              placeholder={placeholder}
              maxLength={MAX_ANSWER_LENGTH}
              rows={5}
            />
          </label>

          <div className="plan-form-below">
            {whatsappAvailable ? (
              <label className="plan-form-optin" htmlFor="plan-form-whatsapp">
                <input
                  id="plan-form-whatsapp"
                  type="checkbox"
                  checked={values.whatsappOn}
                  onChange={(event) => setValues((current) => ({ ...current, whatsappOn: event.target.checked }))}
                />
                <span>Get reminders and a Friday recap on WhatsApp <em>· reply STOP anytime</em></span>
              </label>
            ) : <span />}
            <span className="plan-form-count">{values.skillGoal.length}/{MAX_ANSWER_LENGTH}</span>
          </div>

          {needsPhone && values.phoneDigits.length === 10 && !phoneValid && (
            <p className="plan-form-error" role="alert">Enter a 10-digit Indian mobile number starting with 6, 7, 8 or 9.</p>
          )}
          {error && <p className="plan-form-error" role="alert">{error}</p>}
        </div>

        <footer className="plan-form-actions">
          <button type="button" className="plan-form-cancel plan-form-refine" onClick={() => void refine()} disabled={busy || !values.skillGoal.trim()}>
            {refining ? <><Loader2 size={15} className="animate-spin" aria-hidden="true" /> Refining…</> : <><Sparkles size={15} aria-hidden="true" /> Refine with AI</>}
          </button>
          <button type="submit" className="journey-primary-button" disabled={!valid || busy}>{saving ? "Saving…" : "Save my plan"}</button>
        </footer>
      </form>
    </div>,
    document.body
  );
}
