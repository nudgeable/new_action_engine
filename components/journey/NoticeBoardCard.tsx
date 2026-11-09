"use client";

import { Megaphone, UserRound } from "lucide-react";
import type { CohortNotice, Trainer } from "@/lib/types";

function formatNoticeDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  return date.toLocaleString("en-GB", sameDay
    ? { hour: "2-digit", minute: "2-digit" }
    : { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

/** Read-only feed of dated notices the trainer posts to the cohort. Replaces
 * TrainerExpectationCard: the direction is now trainer -> cohort, not
 * participant -> trainer, so there is no composer here. */
export default function NoticeBoardCard({
  notices,
  trainer = null,
  variant = "default",
}: {
  notices: CohortNotice[];
  trainer?: Trainer | null;
  variant?: "default" | "rcpl";
}) {
  return (
    <article className={`journey-module-card journey-trainer-card${variant === "rcpl" ? " journey-trainer-card--rcpl" : ""}`}>
      <div className="journey-trainer-heading">
        <small>Announcements</small>
      </div>

      {/* Who posts these: a full-width facilitator card above the notices. */}
      {trainer && (
        <div className="journey-trainer-profile journey-trainer-profile--footer">
          <span className="journey-trainer-card-avatar">{trainer.imageUrl ? <img src={trainer.imageUrl} alt="" /> : <UserRound size={13} />}</span>
          <div><strong>{trainer.name}</strong><small>Master Facilitator</small></div>
        </div>
      )}

      <div className="journey-notice-body" aria-live="polite" aria-label="Notices from your trainer">
        {notices.length === 0 ? (
          <div className="journey-chat-state">
            <Megaphone size={22} />
            <strong>No announcements yet</strong>
            <small>Anything your facilitator posts here will show up with the date it was sent.</small>
          </div>
        ) : (
          <ul className="journey-notice-list">
            {notices.map((notice) => (
              <li className="journey-notice-item" key={notice.id}>
                <div className="journey-notice-item-row">
                  <p>{notice.message}</p>
                  <span className="journey-notice-date">{formatNoticeDate(notice.createdAt)}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </article>
  );
}
