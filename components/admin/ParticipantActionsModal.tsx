"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import {
  getParticipantActionTimeline,
  type ParticipantActionRow,
  type ParticipantActionStatus,
} from "@/app/actions/admin-dashboard";

const IST = "Asia/Kolkata";
const dateFormat = new Intl.DateTimeFormat("en-GB", { timeZone: IST, day: "numeric", month: "short", year: "numeric" });
const timeFormat = new Intl.DateTimeFormat("en-IN", { timeZone: IST, hour: "numeric", minute: "2-digit", hour12: true });

const STATUS_DISPLAY: Record<ParticipantActionStatus, { label: string; background: string; color: string }> = {
  completed: { label: "Completed", background: "#DCFCE7", color: "#166534" },
  current: { label: "Current", background: "#DBEAFE", color: "#1E40AF" },
  pending_validation: { label: "Pending validation", background: "#FEE2E2", color: "#991B1B" },
  not_completed: { label: "Didn't complete", background: "#FEE2E2", color: "#991B1B" },
  not_sent: { label: "Not sent yet", background: "#F1F2F6", color: "#4A4047" },
};

const CHANNEL_LABEL = { whatsapp: "WhatsApp", app: "App" } as const;

const SEEN_VIA_DISPLAY = {
  email: { label: "Email opened", background: "#EDE9FE", color: "#5B21B6" },
  whatsapp: { label: "WhatsApp read", background: "#DCFCE7", color: "#166534" },
} as const;

function SeenCell({ row }: { row: ParticipantActionRow }) {
  if (!row.seenAt || !row.seenVia) return <DateCell value={null} />;
  const via = SEEN_VIA_DISPLAY[row.seenVia];
  return (
    <span className="flex flex-col items-start gap-1">
      <DateCell value={row.seenAt} />
      <span
        className="inline-block rounded-full px-1.5 py-px text-[10px] font-semibold whitespace-nowrap"
        style={{ background: via.background, color: via.color }}
      >
        {via.label}
      </span>
    </span>
  );
}

/** Stored numbers are digits with country code (e.g. 919876543210); show them with a leading +. */
function formatPhone(phone: string) {
  const trimmed = phone.trim();
  return /^\d+$/.test(trimmed) ? `+${trimmed}` : trimmed;
}

function DateCell({ value }: { value: string | null }) {
  if (!value) return <span style={{ color: "var(--color-text-muted)" }}>—</span>;
  const date = new Date(value);
  return (
    <span className="whitespace-nowrap">
      <span className="block font-medium" style={{ color: "var(--color-text-primary)" }}>{dateFormat.format(date)}</span>
      <span className="block" style={{ color: "var(--color-text-muted)" }}>{timeFormat.format(date)}</span>
    </span>
  );
}

function SummaryStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl px-4 py-2.5" style={{ background: "#F5F6FA" }}>
      <div className="text-xl font-bold leading-tight" style={{ color: "var(--color-text-primary)" }}>{value}</div>
      <div className="text-xs font-medium" style={{ color: "var(--color-text-secondary)" }}>{label}</div>
    </div>
  );
}

/** Placeholder shaped like the loaded popup (stat tiles + table rows), so the dialog
 * opens at its real size and doesn't jump when the actions arrive. */
const LOADING_MESSAGES = [
  "Fetching this participant's actions…",
  "Checking reminder emails and WhatsApp…",
  "Working out when each action was seen…",
  "Calculating completion stats…",
  "Almost ready…",
] as const;
const LOADING_MESSAGE_INTERVAL_MS = 1600;

function LoadingSkeleton() {
  // Same stepped status lines as the admin page loader, holding on the last one.
  const [step, setStep] = useState(0);
  useEffect(() => {
    const timer = setInterval(
      () => setStep((current) => Math.min(current + 1, LOADING_MESSAGES.length - 1)),
      LOADING_MESSAGE_INTERVAL_MS
    );
    return () => clearInterval(timer);
  }, []);

  const bar = (width: string, height = 10) => (
    <span className="block rounded-full animate-pulse" style={{ width, height, background: "#ECEAF3" }} />
  );
  return (
    <div role="status" aria-live="polite" aria-busy="true" className="flex flex-col min-h-0">
      <div className="mx-5 mb-4 rounded-xl px-4 py-3 flex items-center gap-3" style={{ background: "#F5F3FF", border: "1px solid #E4DEFB" }}>
        <span className="page-loader__spinner participant-loader__spinner flex-shrink-0" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p key={step} className="participant-loader__label text-sm font-semibold" style={{ color: "var(--color-text-primary)" }}>
            {LOADING_MESSAGES[step]}
          </p>
          <div className="flex items-center gap-1 mt-1.5" aria-hidden="true">
            {LOADING_MESSAGES.map((message, i) => (
              <span
                key={message}
                className="h-1 rounded-full transition-all duration-300"
                style={{ width: i === step ? 18 : 6, background: i <= step ? "#6636E8" : "#DDD6FE" }}
              />
            ))}
          </div>
        </div>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 px-5 pb-4" aria-hidden="true">
        {Array.from({ length: 5 }, (_, i) => (
          <div key={i} className="rounded-xl px-4 py-3 flex flex-col gap-2" style={{ background: "#F5F6FA" }}>
            {bar("32px", 18)}
            {bar("64px", 8)}
          </div>
        ))}
      </div>
      <div aria-hidden="true">
        <div className="h-9" style={{ background: "#EDE9FE" }} />
        {["68%", "54%", "76%", "48%", "62%"].map((width, i) => (
          <div
            key={i}
            className="grid items-center gap-3 pl-5 pr-5 py-3.5"
            style={{ gridTemplateColumns: "2.2fr 1fr 1fr 1fr 1fr 0.8fr", borderBottom: "1px solid var(--color-border)" }}
          >
            {bar(width)}
            {bar("72px", 16)}
            {bar("70%")}
            {bar("70%")}
            {bar("70%")}
            {bar("60%")}
          </div>
        ))}
      </div>
    </div>
  );
}

interface ParticipantActionsModalProps {
  userId: string;
  name: string;
  email: string | null;
  companyId: string | null;
  cohortId: string | null;
  onClose: () => void;
}

/** One participant's planned actions with when each was planned, sent and completed, and where. */
export function ParticipantActionsModal({ userId, name, email, companyId, cohortId, onClose }: ParticipantActionsModalProps) {
  const [rows, setRows] = useState<ParticipantActionRow[] | null>(null);
  const [whatsappPhone, setWhatsappPhone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let stale = false;
    getParticipantActionTimeline(userId, companyId, cohortId)
      .then((result) => {
        if (stale) return;
        if (result.error) setError(result.error);
        else {
          setRows(result.rows);
          setWhatsappPhone(result.whatsappPhone ?? null);
        }
      })
      .catch(() => {
        if (!stale) setError("Couldn't load this participant's actions");
      });
    return () => {
      stale = true;
    };
  }, [userId, companyId, cohortId]);

  // Focus moves into the dialog on open and back to the row's button on close.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    closeButtonRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      opener?.focus();
    };
  }, [onClose]);

  const sent = rows?.filter((row) => row.sentAt).length ?? 0;
  const completed = rows?.filter((row) => row.completedAt).length ?? 0;
  const onWhatsApp = rows?.filter((row) => row.completedVia === "whatsapp").length ?? 0;
  const inApp = rows?.filter((row) => row.completedVia === "app").length ?? 0;
  // Plan finalised date(s), earliest first — one per plan, usually just one.
  const planDates = [...new Set((rows ?? []).map((row) => row.plannedAt).filter((v): v is string => !!v))]
    .sort()
    .map((iso) => `${dateFormat.format(new Date(iso))}, ${timeFormat.format(new Date(iso))}`);
  const uniquePlanDates = [...new Set(planDates)];

  const headCell = "px-3 py-2.5 text-xs font-semibold whitespace-nowrap";

  return createPortal(
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center p-4"
      style={{ background: "rgba(12,15,20,0.5)" }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="participant-actions-title"
        className="bg-white rounded-2xl w-full max-w-4xl max-h-[85vh] flex flex-col overflow-hidden"
        style={{ boxShadow: "var(--shadow-lg)" }}
      >
        <div className="flex items-start justify-between gap-4 px-5 pt-5 pb-4">
          <div className="min-w-0">
            <h3 id="participant-actions-title" className="text-lg font-bold truncate" style={{ color: "var(--color-text-primary)" }}>
              {name}
            </h3>
            {email && (
              <p className="text-xs truncate" style={{ color: "var(--color-text-muted)" }}>{email}</p>
            )}
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 hover:bg-gray-100"
            style={{ color: "var(--color-text-secondary)" }}
          >
            <X size={18} />
          </button>
        </div>

        {error ? (
          <p className="px-5 pb-8 pt-4 text-sm text-center font-medium" style={{ color: "#991B1B" }}>{error}</p>
        ) : rows === null ? (
          <LoadingSkeleton />
        ) : rows.length === 0 ? (
          <p className="px-5 pb-8 pt-4 text-sm text-center font-medium" style={{ color: "var(--color-text-muted)" }}>No actions planned yet</p>
        ) : (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 px-5 pb-4">
              <SummaryStat label="Planned" value={rows.length} />
              <SummaryStat label="Sent" value={sent} />
              <SummaryStat label="Completed" value={completed} />
              <SummaryStat label="On WhatsApp" value={onWhatsApp} />
              <SummaryStat label="In app" value={inApp} />
            </div>
            <div className="overflow-auto flex-1 min-h-0">
              <table className="w-full text-left border-collapse min-w-[760px] text-xs">
                <thead className="sticky top-0 z-10" style={{ background: "#EDE9FE", color: "var(--color-text-primary)" }}>
                  <tr>
                    <th className={`${headCell} pl-5`}>Action</th>
                    <th className={headCell}>Status</th>
                    <th className={headCell}>Sent on</th>
                    <th className={headCell}>Seen on</th>
                    <th className={headCell}>Completed on</th>
                    <th className={`${headCell} pr-5`}>Completed via</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const status = STATUS_DISPLAY[row.status];
                    return (
                      <tr key={row.id} style={{ borderBottom: "1px solid var(--color-border)" }}>
                        <td className="pl-5 pr-3 py-2.5 font-medium align-top" style={{ color: "var(--color-text-primary)" }}>{row.title}</td>
                        <td className="px-3 py-2.5 align-top">
                          <span
                            className="inline-block rounded-full px-2 py-0.5 font-semibold whitespace-nowrap"
                            style={{ background: status.background, color: status.color }}
                          >
                            {status.label}
                          </span>
                        </td>
                        <td className="px-3 py-2.5 align-top"><DateCell value={row.sentAt} /></td>
                        <td className="px-3 py-2.5 align-top"><SeenCell row={row} /></td>
                        <td className="px-3 py-2.5 align-top"><DateCell value={row.completedAt} /></td>
                        <td className="pl-3 pr-5 py-2.5 align-top font-medium" style={{ color: "var(--color-text-primary)" }}>
                          {row.completedVia ? CHANNEL_LABEL[row.completedVia] : <span style={{ color: "var(--color-text-muted)" }}>—</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div
              className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-5 py-2.5 text-xs"
              style={{ color: "var(--color-text-muted)", borderTop: "1px solid var(--color-border)" }}
            >
              <span>
                {uniquePlanDates.length === 0 ? (
                  "Plan not finalised yet"
                ) : (
                  <>
                    Plan finalised on{" "}
                    <span className="font-semibold" style={{ color: "var(--color-text-primary)" }}>
                      {uniquePlanDates.join(" · ")}
                    </span>
                  </>
                )}
              </span>
              <span className="inline-flex items-center gap-1.5">
                WhatsApp:{" "}
                <span className="font-semibold" style={{ color: whatsappPhone ? "var(--color-text-primary)" : "var(--color-text-muted)" }}>
                  {whatsappPhone ? formatPhone(whatsappPhone) : "NA"}
                </span>
              </span>
              <span>All times in IST</span>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body
  );
}
