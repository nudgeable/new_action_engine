"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { BellRing, CheckCircle2, Send, X } from "lucide-react";
import { getNudgeSender, sendParticipantNudge, type NudgeSender } from "@/app/actions/admin-nudge";

// Brand: Bright Amber on near-black (docs/nudgeable-design-rulebook.md).
export const NUDGE_YELLOW = "#FFCE00";
export const NUDGE_INK = "#221D23";

const DEFAULT_SUBJECT = "Let's get your actions moving again";

/** Pre-filled message with the participant's and admin's real names; the admin can edit it before sending. */
function defaultMessage(participantName: string, senderName: string) {
  return [
    `Hi ${participantName},`,
    "",
    "We've noticed you've stopped taking actions lately. That's okay, it happens to everyone!",
    "",
    "If you've completed any of your actions, please mark them Done in your plan so your progress is counted.",
    "",
    "Need any support with your actions? Just reply to this email and we'll help you out.",
    "",
    "Cheers,",
    senderName,
  ].join("\n");
}

interface NudgeParticipantModalProps {
  participantId: string;
  name: string;
  email: string | null;
  companyId: string | null;
  onClose: () => void;
}

export function NudgeParticipantModal({ participantId, name, email, companyId, onClose }: NudgeParticipantModalProps) {
  const [sender, setSender] = useState<NudgeSender | null>(null);
  const [senderError, setSenderError] = useState<string | null>(null);
  const [subject, setSubject] = useState(DEFAULT_SUBJECT);
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const messageRef = useRef<HTMLTextAreaElement>(null);

  const fullName = name.trim() || "there";

  useEffect(() => {
    let cancelled = false;
    getNudgeSender().then(({ sender: s, error }) => {
      if (cancelled) return;
      if (s) {
        setSender(s);
        setMessage(defaultMessage(fullName, s.name));
      } else {
        setSenderError(error ?? "Couldn't load your admin details");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [fullName]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !sending) onClose();
    };
    document.addEventListener("keydown", onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose, sending]);

  useEffect(() => {
    if (sender) messageRef.current?.focus();
  }, [sender]);

  const canSend = !!sender && !!email && subject.trim().length > 0 && message.trim().length > 0 && !sending;

  const handleSend = async () => {
    if (!canSend) return;
    setSending(true);
    setSendError(null);
    const { success, error } = await sendParticipantNudge({ companyId, participantId, subject, message });
    setSending(false);
    if (success) setSent(true);
    else setSendError(error ?? "Couldn't send the nudge");
  };

  const fieldLabel = "block text-xs font-semibold mb-1.5";
  const readOnlyField = "w-full rounded-xl px-3.5 py-2.5 text-sm font-medium break-all";

  return createPortal(
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center p-4"
      style={{ background: "rgba(12,15,20,0.5)" }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !sending) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="nudge-dialog-title"
        className="bg-white rounded-2xl w-full max-w-lg max-h-[90vh] flex flex-col overflow-hidden"
        style={{ boxShadow: "var(--shadow-lg, 0 20px 50px rgba(0,0,0,0.25))" }}
      >
        <div className="flex items-center justify-between gap-3 px-5 py-4" style={{ background: NUDGE_INK }}>
          <div className="flex items-center gap-3 min-w-0">
            <span
              className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0"
              style={{ background: NUDGE_YELLOW, color: NUDGE_INK }}
            >
              <BellRing size={18} />
            </span>
            <div className="min-w-0">
              <h3 id="nudge-dialog-title" className="text-base font-bold text-white leading-tight">
                Nudge {name}
              </h3>
              <p className="text-xs font-medium" style={{ color: "rgba(255,255,255,0.65)" }}>
                Sends an email from your admin account
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={sending}
            aria-label="Close"
            className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 hover:bg-white/10 disabled:opacity-50"
            style={{ color: "#FFFFFF" }}
          >
            <X size={18} />
          </button>
        </div>
        <div className="h-1 flex-shrink-0" style={{ background: NUDGE_YELLOW }} />

        {sent ? (
          <div className="flex flex-col items-center text-center gap-3 px-6 py-10">
            <CheckCircle2 size={44} style={{ color: "#15803D" }} />
            <p className="text-base font-bold" style={{ color: "var(--color-text-primary)" }}>
              Nudge sent to {fullName}
            </p>
            <p className="text-sm" style={{ color: "var(--color-text-secondary)" }}>
              It went to {email}. Replies will come to {sender?.email}.
            </p>
            <button
              type="button"
              onClick={onClose}
              className="mt-2 rounded-full px-6 py-2.5 text-sm font-bold"
              style={{ background: NUDGE_YELLOW, color: NUDGE_INK }}
            >
              Done
            </button>
          </div>
        ) : (
          <>
            <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="min-w-0">
                  <span className={fieldLabel} style={{ color: "var(--color-text-secondary)" }}>From</span>
                  <div className={readOnlyField} style={{ background: "#F5F6FA", color: "var(--color-text-primary)" }}>
                    {sender ? sender.email : senderError ? "—" : "Loading…"}
                  </div>
                </div>
                <div className="min-w-0">
                  <span className={fieldLabel} style={{ color: "var(--color-text-secondary)" }}>To</span>
                  <div className={readOnlyField} style={{ background: "#F5F6FA", color: "var(--color-text-primary)" }}>
                    {email ?? "No email address"}
                  </div>
                </div>
              </div>

              <div>
                <label htmlFor="nudge-subject" className={fieldLabel} style={{ color: "var(--color-text-secondary)" }}>
                  Subject
                </label>
                <input
                  id="nudge-subject"
                  type="text"
                  value={subject}
                  maxLength={200}
                  onChange={(event) => setSubject(event.target.value)}
                  disabled={sending}
                  className="w-full rounded-xl px-3.5 py-2.5 text-sm font-medium outline-none focus:ring-2"
                  style={{ border: "1px solid var(--color-border-strong, #D4D4D8)", color: "var(--color-text-primary)", ["--tw-ring-color" as string]: NUDGE_YELLOW }}
                />
              </div>

              <div>
                <label htmlFor="nudge-message" className={fieldLabel} style={{ color: "var(--color-text-secondary)" }}>
                  Message
                </label>
                <textarea
                  id="nudge-message"
                  ref={messageRef}
                  value={message}
                  maxLength={5000}
                  rows={10}
                  onChange={(event) => setMessage(event.target.value)}
                  disabled={!sender || sending}
                  placeholder={sender ? "" : "Loading…"}
                  className="w-full rounded-xl px-3.5 py-2.5 text-sm leading-relaxed outline-none focus:ring-2 resize-y"
                  style={{ border: "1px solid var(--color-border-strong, #D4D4D8)", color: "var(--color-text-primary)", ["--tw-ring-color" as string]: NUDGE_YELLOW }}
                />
              </div>

              {(senderError || sendError || !email) && (
                <p role="alert" className="rounded-xl px-3.5 py-2.5 text-sm font-medium" style={{ background: "#FEE2E2", color: "#991B1B" }}>
                  {senderError ?? sendError ?? "This participant has no email address, so they can't be nudged by email."}
                </p>
              )}
            </div>

            <div className="flex items-center justify-end gap-2 px-5 py-4" style={{ borderTop: "1px solid var(--color-border)" }}>
              <button
                type="button"
                onClick={onClose}
                disabled={sending}
                className="rounded-full px-5 py-2.5 text-sm font-semibold hover:bg-gray-50 disabled:opacity-50"
                style={{ color: NUDGE_INK, border: "1px solid var(--color-border-strong, #D4D4D8)" }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSend}
                disabled={!canSend}
                className="inline-flex items-center gap-2 rounded-full px-5 py-2.5 text-sm font-bold disabled:opacity-50 disabled:cursor-not-allowed hover:brightness-95"
                style={{ background: NUDGE_YELLOW, color: NUDGE_INK, boxShadow: "0 4px 20px rgba(245, 197, 24, 0.35)" }}
              >
                <Send size={15} />
                {sending ? "Sending…" : "Send mail"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body
  );
}
