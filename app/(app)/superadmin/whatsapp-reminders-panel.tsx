"use client";

import { useEffect, useMemo, useState } from "react";
import {
  CalendarClock,
  CheckCheck,
  CheckSquare,
  Clock3,
  Loader2,
  MessageCircle,
  RefreshCw,
  Send,
  Square,
  X,
  XCircle,
} from "lucide-react";
import {
  getUpcomingWhatsAppReminders,
  getWhatsAppReminderLogs,
  sendWhatsAppRemindersNow,
  type UpcomingWhatsAppReminder,
  type WhatsAppMessageKind,
  type WhatsAppReminderLog,
  type WhatsAppReminderOverview,
} from "@/app/actions/whatsapp-reminders-admin";
import EmailQueueFilters, { filterQueueEntries, useQueueBatchFilter } from "./email-queue-filters";

function formatIstTime(isoValue: string) {
  return new Date(isoValue).toLocaleString("en-IN", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Kolkata",
    timeZoneName: "short",
  });
}

function ReminderRow({
  reminder,
  selected,
  onSelect,
}: {
  reminder: UpcomingWhatsAppReminder;
  selected: boolean;
  onSelect: (subscriptionId: string, selected: boolean) => void;
}) {
  return (
    <article
      className={`rounded-xl border-2 bg-white p-3 transition-colors ${
        selected ? "border-emerald-500 ring-2 ring-emerald-100" : "border-slate-200"
      }`}
    >
      <div className="flex items-start gap-3">
        <label
          className={`mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md border ${
            reminder.canSend
              ? "cursor-pointer border-slate-300 bg-white hover:bg-emerald-50"
              : "cursor-not-allowed border-slate-200 bg-slate-100"
          }`}
          title={reminder.canSend ? "Select WhatsApp reminder" : reminder.blockedReason ?? "Cannot be sent"}
        >
          <input
            type="checkbox"
            checked={selected}
            disabled={!reminder.canSend}
            onChange={(event) => onSelect(reminder.subscriptionId, event.target.checked)}
            className="h-5 w-5 cursor-pointer accent-emerald-600 disabled:cursor-not-allowed"
            aria-label={`Select WhatsApp reminder for ${reminder.fullName || reminder.email}`}
          />
        </label>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <strong className="truncate text-sm">{reminder.fullName || reminder.email || "Unknown user"}</strong>
            {reminder.phone && <span className="text-sm text-slate-500">{reminder.phone}</span>}
            <span className="rounded bg-violet-100 px-1.5 py-0.5 text-xs font-bold uppercase text-violet-700">
              {reminder.track}
            </span>
            {!reminder.canSend && (
              <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs font-bold uppercase text-amber-700">
                Not sendable
              </span>
            )}
          </div>

          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm text-slate-600">
            <span className="font-semibold">{reminder.cohortName}</span>
            <span>{reminder.scheduleLabel}</span>
          </div>

          {reminder.scheduledFor && (
            <p className="mt-1 flex items-center gap-1 text-sm font-bold text-emerald-700">
              <CalendarClock size={12} />
              Next WhatsApp: {formatIstTime(reminder.scheduledFor)}
            </p>
          )}

          {!reminder.canSend ? (
            <p className="mt-2 text-sm font-semibold text-amber-700">
              {reminder.blockedReason} Automatic delivery will skip this WhatsApp reminder.
            </p>
          ) : (
            <div className="mt-2 text-sm text-slate-600">
              <span className="font-bold">
                {reminder.actionCount} action{reminder.actionCount === 1 ? "" : "s"} · {reminder.templateName}:
              </span>
              <ol className="mt-1 list-decimal space-y-0.5 pl-5">
                {reminder.actions.map((action) => (
                  <li key={action.id}>{action.title}</li>
                ))}
              </ol>
            </div>
          )}
        </div>
      </div>
    </article>
  );
}

const STATUS_STYLES: Record<WhatsAppReminderLog["status"], string> = {
  accepted: "bg-slate-100 text-slate-700",
  sent: "bg-sky-100 text-sky-800",
  delivered: "bg-emerald-100 text-emerald-800",
  read: "bg-emerald-600 text-white",
  failed: "bg-red-100 text-red-800",
};

function LogRow({ log }: { log: WhatsAppReminderLog }) {
  return (
    <div className="flex flex-wrap items-start gap-3 rounded-xl border-2 border-black bg-white p-3">
      <div className="mt-1 flex-shrink-0">
        {log.status === "failed" ? (
          <XCircle size={18} className="text-red-500" />
        ) : log.status === "read" ? (
          <CheckCheck size={18} className="text-emerald-600" />
        ) : (
          <Clock3 size={18} className="text-slate-400" />
        )}
      </div>
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-sm font-bold">{log.fullName || log.phone || "Unknown"}</span>
          {log.fullName && log.phone && <span className="text-[11px] text-slate-400">{log.phone}</span>}
          <span
            className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase ${
              log.kind === "manual" ? "bg-violet-100 text-violet-800" : "bg-amber-100 text-amber-800"
            }`}
          >
            {log.kind === "manual" ? "Sent now" : "Automatic"}
          </span>
          <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase ${STATUS_STYLES[log.status]}`}>
            {log.status}
          </span>
        </div>
        <p className="text-[11px] text-slate-500">
          Sent {formatIstTime(log.createdAt)}
          {log.templateName ? ` · ${log.templateName}` : ""}
          {log.deliveredAt ? ` · delivered ${formatIstTime(log.deliveredAt)}` : ""}
          {log.readAt ? ` · read ${formatIstTime(log.readAt)}` : ""}
        </p>
        {log.status === "failed" && (log.errorTitle || log.errorCode) && (
          <p className="text-[11px] font-semibold text-red-600">
            {log.errorCode ? `${log.errorCode}: ` : ""}
            {log.errorTitle}
          </p>
        )}
      </div>
    </div>
  );
}

export default function WhatsAppRemindersPanel() {
  const [kind, setKind] = useState<WhatsAppMessageKind>("reminder");
  const [overview, setOverview] = useState<WhatsAppReminderOverview | null>(null);
  const [logs, setLogs] = useState<WhatsAppReminderLog[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const batchFilter = useQueueBatchFilter();
  const [search, setSearch] = useState("");

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [queue, history] = await Promise.all([getUpcomingWhatsAppReminders(kind), getWhatsAppReminderLogs()]);
      if ("error" in queue) setError(queue.error);
      else {
        setOverview(queue.data);
        const sendable = new Set(queue.data.reminders.filter((r) => r.canSend).map((r) => r.subscriptionId));
        setSelectedIds((previous) => new Set([...previous].filter((id) => sendable.has(id))));
      }
      if ("error" in history) setError((current) => current ?? history.error);
      else setLogs(history.data);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setSelectedIds(new Set());
    setResult(null);
    void load();
  }, [kind]);

  const reminders = overview?.reminders ?? [];
  const visibleReminders = useMemo(
    () => filterQueueEntries(reminders, batchFilter.scope, search),
    [reminders, batchFilter.scope, search]
  );
  const sendableReminders = visibleReminders.filter((reminder) => reminder.canSend);
  const visibleSelectedIds = sendableReminders.map((r) => r.subscriptionId).filter((id) => selectedIds.has(id));
  const allSelected = sendableReminders.length > 0 && sendableReminders.every((r) => selectedIds.has(r.subscriptionId));

  function selectReminder(subscriptionId: string, selected: boolean) {
    setSelectedIds((previous) => {
      const next = new Set(previous);
      if (selected) next.add(subscriptionId);
      else next.delete(subscriptionId);
      return next;
    });
  }

  function toggleAll() {
    setSelectedIds((previous) => {
      const next = new Set(previous);
      for (const reminder of sendableReminders) {
        if (allSelected) next.delete(reminder.subscriptionId);
        else next.add(reminder.subscriptionId);
      }
      return next;
    });
  }

  async function sendSelectedNow() {
    setSending(true);
    setError(null);
    setResult(null);
    try {
      const response = await sendWhatsAppRemindersNow(visibleSelectedIds, kind);
      if ("error" in response) {
        setError(response.error);
        return;
      }
      setResult(
        `${response.sent} WhatsApp ${kind}${response.sent === 1 ? "" : "s"} sent${
          response.failed ? ` · ${response.failed} failed` : ""
        }${response.skipped ? ` · ${response.skipped} skipped` : ""}. Delivery status appears in the history below.`
      );
      const itemErrors = response.data
        .filter((item) => item.error)
        .map((item) => `${item.fullName || "Participant"}: ${item.error}`);
      setSelectedIds(new Set());
      await load();
      if (itemErrors.length) setError(itemErrors.join(" · "));
    } finally {
      setSending(false);
    }
  }

  const deliveredCount = logs.filter((log) => log.status === "delivered" || log.status === "read").length;
  const readCount = logs.filter((log) => log.status === "read").length;
  const failedCount = logs.filter((log) => log.status === "failed").length;

  return (
    <div className="grid gap-4">
      <section className="overflow-hidden rounded-2xl border-4 border-black bg-emerald-50 shadow-[6px_6px_0px_0px_rgba(0,0,0,1)]">
        <div className="flex items-center justify-between p-4 font-black uppercase tracking-tight">
          <span className="flex items-center gap-2">
            <MessageCircle size={18} />
            {kind === "recap" ? "Upcoming WhatsApp Friday recaps" : "Upcoming WhatsApp reminders"}
            {overview && (
              <span className="rounded-full bg-black px-2 py-0.5 text-xs font-black text-white">
                {reminders.filter((r) => r.canSend).length} ready
              </span>
            )}
          </span>
          <div className="flex gap-1" role="group" aria-label="WhatsApp message type">
            {(["reminder", "recap"] as const).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setKind(option)}
                disabled={loading || sending}
                aria-pressed={kind === option}
                className={`rounded-lg border-2 border-black px-3 py-1.5 text-xs font-bold uppercase disabled:opacity-50 ${
                  kind === option ? "bg-black text-white" : "bg-white text-black hover:bg-emerald-100"
                }`}
              >
                {option === "recap" ? "Friday recap" : "Reminders"}
              </button>
            ))}
          </div>
        </div>

        <div className="border-t-2 border-black">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-emerald-200 bg-emerald-100 px-4 py-3">
            <div>
              <p className="text-xs font-bold uppercase tracking-wider text-emerald-800">
                {kind === "recap"
                  ? "Sent with the Friday recap email · same actions · Fridays 12:30 PM IST"
                  : `Sent with the reminder email · same actions · 11:30 AM IST${
                      overview?.recapEnabled ? " · the recap replaces Friday's reminder" : ""
                    }`}
              </p>
              <p className="mt-1 text-sm text-emerald-800">
                {overview
                  ? `${overview.whatsappOn} of ${overview.activePlans} active plans have WhatsApp on. `
                  : ""}
                Sending now can be repeated and does not use up the automatic send.
              </p>
            </div>
            <button
              type="button"
              onClick={load}
              disabled={loading || sending}
              className="flex items-center gap-1.5 rounded-lg border border-emerald-300 bg-white px-3 py-2 text-xs font-bold uppercase text-emerald-800 hover:bg-emerald-50 disabled:opacity-50"
            >
              {loading ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
              Refresh
            </button>
          </div>

          {overview && !overview.configured && (
            <div className="mx-4 mt-3 rounded-lg border-2 border-amber-300 bg-amber-50 px-3 py-2">
              <p className="text-xs font-bold text-amber-800">
                WhatsApp sending isn&apos;t configured on this deployment — set WHATSAPP_PHONE_NUMBER_ID and
                WHATSAPP_ACCESS_TOKEN. Nothing will be sent until then.
              </p>
            </div>
          )}

          {overview && kind === "recap" && !overview.recapEnabled && (
            <div className="mx-4 mt-3 rounded-lg border-2 border-amber-300 bg-amber-50 px-3 py-2">
              <p className="text-xs font-bold text-amber-800">
                The automatic Friday recap is off, so Friday reminders still go out. Set
                WHATSAPP_WEEKLY_RECAP_ENABLED=true once Meta has approved plan_recap_1 to plan_recap_3.
              </p>
            </div>
          )}

          {result && (
            <div className="mx-4 mt-3 flex items-start justify-between gap-2 rounded-lg border-2 border-emerald-200 bg-white px-3 py-2">
              <p className="text-xs font-semibold text-emerald-800">{result}</p>
              <button type="button" onClick={() => setResult(null)} className="flex-shrink-0 text-emerald-600" aria-label="Dismiss result">
                <X size={14} />
              </button>
            </div>
          )}

          {error && (
            <div className="mx-4 mt-3 rounded-lg border-2 border-red-200 bg-red-50 px-3 py-2">
              <p className="text-xs font-bold text-red-700">{error}</p>
            </div>
          )}

          <div className="p-4">
            {reminders.length > 0 && (
              <EmailQueueFilters
                idPrefix="whatsapp-queue"
                companyId={batchFilter.companyId}
                batches={batchFilter.options}
                batchesLoading={batchFilter.loading}
                batchId={batchFilter.batchId}
                onBatchChange={batchFilter.setBatchId}
                search={search}
                onSearchChange={setSearch}
              />
            )}
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs font-semibold text-slate-600">
                {visibleReminders.length !== reminders.length ? `${visibleReminders.length} of ` : ""}
                {reminders.length} participant{reminders.length === 1 ? "" : "s"} with WhatsApp on
              </p>
              {sendableReminders.length > 0 && (
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={toggleAll}
                    disabled={sending}
                    className="flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-bold uppercase text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                  >
                    {allSelected ? <CheckSquare size={16} /> : <Square size={16} />}
                    {allSelected ? "Clear all" : "Select all ready"}
                  </button>
                  <button
                    type="button"
                    onClick={sendSelectedNow}
                    disabled={sending || visibleSelectedIds.length === 0 || !overview?.configured}
                    className="flex items-center gap-1.5 rounded-lg border-2 border-black bg-black px-3 py-2 text-xs font-bold uppercase text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {sending ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />}
                    Send WhatsApp now{visibleSelectedIds.length ? ` (${visibleSelectedIds.length})` : ""}
                  </button>
                </div>
              )}
            </div>

            {loading && !overview ? (
              <div className="flex items-center gap-2 py-4 text-sm text-slate-500">
                <Loader2 size={16} className="animate-spin" />
                Loading WhatsApp reminders…
              </div>
            ) : reminders.length === 0 ? (
              <p className="py-3 text-sm italic text-slate-500">
                No participants have WhatsApp reminders on yet. They opt in when generating a plan, or from My
                Actions → Plan overview.
              </p>
            ) : visibleReminders.length === 0 ? (
              <p className="py-3 text-sm italic text-slate-500">No members match the current search or batch filter.</p>
            ) : (
              <div className="space-y-3">
                {visibleReminders.map((reminder) => (
                  <ReminderRow
                    key={reminder.subscriptionId}
                    reminder={reminder}
                    selected={selectedIds.has(reminder.subscriptionId)}
                    onSelect={selectReminder}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      </section>

      <section className="overflow-hidden rounded-2xl border-4 border-black bg-amber-50 shadow-[6px_6px_0px_0px_rgba(0,0,0,1)]">
        <div className="flex items-center justify-between p-4 font-black uppercase tracking-tight">
          <span className="flex items-center gap-2">
            <MessageCircle size={18} />
            WhatsApp delivery history
            {logs.length > 0 && (
              <span className="rounded-full bg-black px-2 py-0.5 text-[10px] font-black text-white">
                {deliveredCount} delivered · {readCount} read{failedCount ? ` · ${failedCount} failed` : ""}
              </span>
            )}
          </span>
        </div>
        <div className="space-y-3 border-t-2 border-black p-4">
          {loading && !logs.length ? (
            <div className="flex items-center gap-2 text-sm text-slate-400">
              <Loader2 size={16} className="animate-spin" />
              Loading history…
            </div>
          ) : logs.length === 0 ? (
            <p className="text-sm italic text-slate-500">No WhatsApp reminders sent yet.</p>
          ) : (
            logs.map((log) => <LogRow key={log.wamid} log={log} />)
          )}
        </div>
      </section>
    </div>
  );
}
