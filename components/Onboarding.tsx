"use client";

import React, { useEffect, useState } from "react";
import { X, Zap, CalendarDays, Mail, MessageCircle, NotebookPen } from "lucide-react";
import { saveGeneratedActions, skipSelfOnboarding } from "@/app/actions/ai-actions";
import { getMyWhatsAppSettings } from "@/app/actions/whatsapp";
import { computeTotalActionsNeeded, DAILY_DELIVERY_DAYS, type DeliveryTrack } from "@/lib/personal-action-generation";

const WEEKDAYS = [
  { value: 0, label: "Sunday" },
  { value: 1, label: "Monday" },
  { value: 2, label: "Tuesday" },
  { value: 3, label: "Wednesday" },
  { value: 4, label: "Thursday" },
  { value: 5, label: "Friday" },
  { value: 6, label: "Saturday" },
];

const DURATIONS = [2, 4, 6, 8, 10, 12] as const;

const Onboarding: React.FC<{
  onComplete: () => void | Promise<void>;
  onGeneratingChange?: (generating: boolean) => void;
  initialTrainingText?: string;
  inline?: boolean;
  /** Batch-level cap on plan duration (see cohorts.max_weeks). Null/undefined
   * leaves every preset duration available. */
  maxWeeks?: number | null;
}> = ({ onComplete, onGeneratingChange, initialTrainingText = "", inline = false, maxWeeks = null }) => {
  const availableDurations = maxWeeks ? DURATIONS.filter((weeks) => weeks <= maxWeeks) : DURATIONS;
  const [durationWeeks, setDurationWeeks] = useState<number>(() => (
    availableDurations.includes(6) ? 6 : availableDurations[availableDurations.length - 1] ?? DURATIONS[0]
  ));
  const [track, setTrack] = useState<DeliveryTrack>("weekly");
  const [daysOfWeek, setDaysOfWeek] = useState<number[]>([2]);
  const [weeklyActionCount, setWeeklyActionCount] = useState<1 | 2 | 3>(2);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // WhatsApp reminders: ticked by default with the admin-saved number
  // pre-filled; stays hidden until WhatsApp is configured on the server.
  const [whatsappAvailable, setWhatsappAvailable] = useState(false);
  const [whatsappEnabled, setWhatsappEnabled] = useState(true);
  const [whatsappNumber, setWhatsappNumber] = useState("");

  useEffect(() => {
    let cancelled = false;
    getMyWhatsAppSettings().then(({ settings }) => {
      if (cancelled || !settings?.available) return;
      setWhatsappAvailable(true);
      setWhatsappNumber(settings.phone ?? "");
      // Someone who replied STOP shouldn't be silently opted back in.
      setWhatsappEnabled(!settings.optedOut);
    });
    return () => { cancelled = true; };
  }, []);

  const trainingText = initialTrainingText.trim();
  const actionCount = track === "daily" ? 1 : weeklyActionCount;

  const selectTrack = (next: DeliveryTrack) => {
    setTrack(next);
    setErrorMsg(null);
    if (next === "weekly") setDaysOfWeek((previous) => [previous[0] ?? 2]);
    else setDaysOfWeek([...DAILY_DELIVERY_DAYS]);
  };

  const handleSkip = async () => {
    setSaving(true);
    await skipSelfOnboarding();
    setSaving(false);
    await onComplete();
  };

  const handleFinish = async () => {
    if (!trainingText) {
      setErrorMsg("Answer at least one My Plan question first. Your answers are the personal input for this plan.");
      return;
    }
    if (whatsappAvailable && whatsappEnabled && !whatsappNumber.trim()) {
      setErrorMsg("Enter your WhatsApp number, or untick WhatsApp reminders.");
      return;
    }
    setSaving(true);
    setErrorMsg(null);
    onGeneratingChange?.(true);
    try {
      const { error } = await saveGeneratedActions({
        userNotes: trainingText,
        focusThemes: [],
        track,
        dailyActionCount: actionCount,
        daysOfWeek,
        durationWeeks,
        emailRemindersEnabled: true,
        whatsappRemindersEnabled: whatsappAvailable && whatsappEnabled,
        whatsappNumber: whatsappAvailable && whatsappEnabled ? whatsappNumber : undefined,
      });
      setSaving(false);
      if (error) {
        setErrorMsg(error);
        return;
      }
      await onComplete();
    } finally {
      onGeneratingChange?.(false);
    }
  };

  const totalActions = computeTotalActionsNeeded(durationWeeks, actionCount, track, daysOfWeek);
  const cadenceSummary = track === "weekly"
    ? `${actionCount} action${actionCount === 1 ? "" : "s"} each week for ${durationWeeks} weeks`
    : `1 action each weekday for ${durationWeeks} weeks`;
  const planWarning = totalActions > 100
    ? "This is a long daily plan. Consider a shorter duration if that feels more realistic."
    : totalActions > 50
      ? "This is a busy plan. Make sure this duration feels realistic for your schedule."
      : null;

  return (
    <div className={inline ? "plan-setup-inline" : "plan-setup-overlay"}>
      <div className="plan-setup-modal" role={inline ? undefined : "dialog"} aria-modal={inline ? undefined : true} aria-labelledby="plan-setup-title">
        <div className="plan-setup-head">
          <div>
            <h2 id="plan-setup-title">Turn your answers into actions</h2>
            <p>Convert what you wrote into daily or weekly workplace actions.</p>
          </div>
          {!inline && <button type="button" onClick={handleSkip} disabled={saving} aria-label="Close plan setup"><X size={19} /></button>}
        </div>

        {!trainingText && <div className="plan-notes-source missing">
          <span><NotebookPen size={20} /></span>
          <div><strong>Answer my plan questions first</strong><p>{inline ? "Answer the private questions above, then choose a schedule here." : "Close this setup, answer my plan questions, then return here."}</p></div>
        </div>}

        <div className="plan-setup-field">
          <label>Frequency</label>
          <div className="plan-track-segmented">
            <button type="button" className={track === "weekly" ? "active" : ""} onClick={() => selectTrack("weekly")}><CalendarDays size={18} /><span><strong>Weekly</strong><small>On one selected day</small></span></button>
            <button type="button" className={track === "daily" ? "active" : ""} onClick={() => selectTrack("daily")}><Zap size={18} /><span><strong>Daily</strong><small>Monday to Friday</small></span></button>
          </div>
        </div>

        <div className={`plan-setup-grid ${track === "weekly" ? "weekly" : "daily"}`}>
          <label className="plan-setup-field"><span>Duration</span><select value={durationWeeks} onChange={(event) => setDurationWeeks(Number(event.target.value))}>{availableDurations.map((weeks) => <option key={weeks} value={weeks}>{weeks} weeks</option>)}</select></label>

          {track === "weekly" ? <label className="plan-setup-field"><span>Actions per week</span><select value={weeklyActionCount} onChange={(event) => setWeeklyActionCount(Number(event.target.value) as 1 | 2 | 3)}>{([1, 2, 3] as const).map((count) => <option key={count} value={count}>{count} action{count === 1 ? "" : "s"}</option>)}</select></label> : <div className="plan-setup-field"><span>Actions per weekday</span><div className="plan-fixed-action-count"><strong>1 action</strong><small>Fixed for a realistic daily pace</small></div></div>}

          {track === "weekly" && <label className="plan-setup-field"><span>Reminder day</span><select value={daysOfWeek[0]} onChange={(event) => setDaysOfWeek([Number(event.target.value)])}>{WEEKDAYS.map(({ value, label }) => <option key={value} value={value}>{label}</option>)}</select></label>}

          <div className="plan-setup-field"><span>Reminder time</span><div className="plan-fixed-action-count"><strong>11:30 AM IST</strong><small>Fixed processing time</small></div></div>
        </div>

        <div className="plan-setup-summary"><div><strong>{cadenceSummary}</strong><small>Generated from your answers and batch context</small></div><b>{totalActions} actions</b></div>

        {whatsappAvailable && <div className={`plan-whatsapp-optin${whatsappEnabled ? " is-on" : ""}`}>
          <label className="plan-whatsapp-check">
            <input type="checkbox" checked={whatsappEnabled} onChange={(event) => { setWhatsappEnabled(event.target.checked); setErrorMsg(null); }} />
            <MessageCircle size={18} />
            <span><strong>Send my reminders on WhatsApp</strong><small>As well as email, plus a Friday recap. Reply STOP on WhatsApp anytime to turn them off.</small></span>
          </label>
          {whatsappEnabled && <label className="plan-setup-field plan-whatsapp-number"><span>WhatsApp number</span><input type="tel" inputMode="tel" autoComplete="tel" placeholder="+91 98000 00000" value={whatsappNumber} onChange={(event) => setWhatsappNumber(event.target.value)} /></label>}
        </div>}

        {planWarning && <p className="plan-setup-warning">{planWarning}</p>}
        {errorMsg && <p className="plan-setup-error">{errorMsg}</p>}

        <button type="button" className="journey-primary-button plan-generate-button" onClick={handleFinish} disabled={saving || !trainingText}>{saving ? "Generating…" : "Generate my actions"}</button>
        {/* <div className="plan-email-note"><Mail size={18} /><div><strong>Email reminders included</strong><p>We&apos;ll email you on {track === "weekly" ? "your selected day" : "weekdays"} when the next action is ready.</p></div></div> */}
      </div>
    </div>
  );
};

export default Onboarding;
