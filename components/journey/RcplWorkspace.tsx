"use client";

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ArrowRight, CalendarDays, Check, FileText, Play, Target, User, X } from "lucide-react";
import CohortChat from "@/components/journey/CohortChat";
import NoticeBoardCard from "@/components/journey/NoticeBoardCard";
import FacilitatorsCard from "@/components/journey/FacilitatorsCard";
import FlipCountdown from "@/components/journey/FlipCountdown";
import { getCohortTeamCommitmentScores, type TeamCommitmentScore } from "@/app/actions/commitment-wallet";
import { getMyCommitmentBuddies, type CommitmentBuddyProgress } from "@/app/actions/commitment-buddies";
import type { Cohort, CohortMember, CohortNotice, Facilitator, PrepareContentItem, ProgramBlock, ProgramDay, ProgramPhase, UserPrepareProgress } from "@/lib/types";
import { resolveVideoEmbed, resolveVideoThumbnail } from "@/lib/video-embed";
import { browserNeedsExternalPdfViewer } from "@/lib/pdf-embed";
import { daysUntil, nextUpcomingCohortDate } from "@/lib/cohort-dates";
import ActionPlanCard from "@/components/journey/ActionPlanCard";

// This component is shared by every company — see prepare-client.tsx, which
// passes `phases` sourced from this batch's own cohorts.program_phases
// (seeded by an admin/superadmin per batch, see CohortManagementView's
// Agenda tab) plus its own hero copy. Surge/RCPL University's SURGE
// curriculum is just seeded data in that same column now (migration
// 070_cohort_program_phases.sql); every batch, Surge included, gets the same
// vertical phase stepper in the hero.
type PhaseBlock = ProgramBlock;
type PhaseDay = ProgramDay;
type RcplPhase = ProgramPhase;

function formatSessionDate(value?: string | null, compact = false) {
  if (!value) return "Date to be announced";
  const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00` : value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString("en-GB", compact
    ? { weekday: "short", day: "numeric", month: "short" }
    : { weekday: "long", day: "numeric", month: "long", year: "numeric" });
}

function initials(name: string | null) {
  if (!name) return "P";
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
}

function isPdfResource(item: PrepareContentItem) {
  return item.type === "preread" && !!item.prereadUrl && /\.pdf(?:$|[?#])/i.test(item.prereadUrl);
}

function resourceKind(item: PrepareContentItem) {
  if (item.type === "video") return "Video";
  if (item.type === "quiz") return "Quiz";
  return isPdfResource(item) ? "PDF" : "Resource";
}

function PdfCardPreview({ url, title }: { url: string; title: string }) {
  const [useNativeIframe, setUseNativeIframe] = useState(false);

  useEffect(() => {
    setUseNativeIframe(!browserNeedsExternalPdfViewer());
  }, []);

  if (!useNativeIframe) return <FileText size={28} />;
  return <iframe src={`${url}#page=1&view=FitH&toolbar=0&navpanes=0`} title={`${title} preview`} tabIndex={-1} loading="lazy" />;
}

function ResourcePreview({ item }: { item: PrepareContentItem }) {
  if (item.type === "video" && item.videoUrl) {
    const thumbnail = resolveVideoThumbnail(item.videoUrl);
    if (thumbnail) return <><img src={thumbnail} alt="" loading="lazy" /><span className="rcpl-resource-play"><Play size={17} fill="currentColor" /></span></>;
    const embed = resolveVideoEmbed(item.videoUrl);
    if (embed.kind === "file") return <><video src={embed.src} muted playsInline preload="metadata" /><span className="rcpl-resource-play"><Play size={17} fill="currentColor" /></span></>;
  }

  if (isPdfResource(item) && item.prereadUrl) {
    return <PdfCardPreview url={item.prereadUrl} title={item.title} />;
  }

  return item.type === "video" ? <Play size={30} fill="currentColor" /> : <FileText size={28} />;
}

/** Vertical programme stepper for the hero: phases before the batch's current
 * one are done (tick), the current one is highlighted (target), later ones are
 * upcoming. Steps rise in one after another and the connector fills up to the
 * current phase. Works for any number of phases. */
function PhaseJourneyGraphic({ phases, currentPhaseId }: { phases: RcplPhase[]; currentPhaseId?: string | null }) {
  const foundIndex = phases.findIndex((item) => item.id === currentPhaseId);
  const currentIndex = foundIndex >= 0 ? foundIndex : 0;
  return (
    <ol className="rcpl-vstepper" aria-label="Programme phases">
      {phases.map((item, index) => {
        const state = index < currentIndex ? "done" : index === currentIndex ? "current" : "upcoming";
        const Icon = state === "done" ? Check : state === "current" ? Target : User;
        return (
          <li
            key={item.id}
            className={`rcpl-vstep rcpl-vstep--${state}`}
            style={{ animationDelay: `${index * 140}ms` }}
            aria-current={state === "current" ? "step" : undefined}
          >
            <span className="rcpl-vstep-dot" aria-hidden="true">
              <Icon size={14} strokeWidth={state === "upcoming" ? 2.2 : 2.8} />
            </span>
            {index < phases.length - 1 && (
              <span className="rcpl-vstep-line" aria-hidden="true">
                <span style={{ animationDelay: `${400 + index * 260}ms` }} />
              </span>
            )}
            <span className="rcpl-vstep-copy">
              <strong>{item.focus || item.label}</strong>
              {item.window && <small>{item.window}</small>}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

type RcplWorkspaceProps = {
  cohort: Cohort;
  roster: CohortMember[];
  items: PrepareContentItem[];
  progress: Record<string, UserPrepareProgress>;
  completedCount: number;
  preparationComplete: boolean;
  nextTitle: string;
  nextCopy: string;
  nextHref: string | null;
  nextIncompleteItem: PrepareContentItem | null;
  onOpenResource: (item: PrepareContentItem) => void;
  notices: CohortNotice[];
  facilitators: Facilitator[];
  /** This batch's program agenda (cohort.programPhases). Empty/omitted hides
   * the agenda section. */
  phases?: RcplPhase[];
  /** No longer used: the hero shows the vertical phase stepper for every batch.
   * Kept so existing callers still type-check. */
  showCurveGraphic?: boolean;
  /** Hero copy overrides — all default to Surge's existing SURGE copy, so
   * passing none of these keeps Surge pixel-identical. */
  programEyebrow?: string;
  heroTitle?: string;
  heroDescription?: string;
};

export default function RcplWorkspace({
  cohort,
  roster,
  items,
  progress,
  completedCount,
  preparationComplete,
  nextTitle,
  nextCopy,
  nextHref,
  nextIncompleteItem,
  onOpenResource,
  notices,
  facilitators,
  phases = [],
  programEyebrow = "RCPL Accelerated Leadership Program",
  heroTitle = "Your 5-month SURGE leadership journey",
  heroDescription = "Build the capability to lead the future, lead yourself, and lead others through immersive learning, practical application, teachbacks, and continued action at work.",
}: RcplWorkspaceProps) {
  const searchParams = useSearchParams();
  const hasPhases = phases.length > 0;
  const phaseId = searchParams.get("phase") ?? cohort.currentPhaseId ?? phases[0]?.id;
  const phase = phases.find((item) => item.id === phaseId) ?? phases[0] ?? null;
  const [buddyInfoOpen, setBuddyInfoOpen] = useState(false);
  const [teamScores, setTeamScores] = useState<TeamCommitmentScore[]>([]);
  // null while loading; only fetched once the batch is unlocked.
  const [buddies, setBuddies] = useState<CommitmentBuddyProgress[] | null>(null);

  useEffect(() => {
    if (cohort.locked) {
      setBuddies(null);
      return;
    }
    let cancelled = false;
    setBuddies(null);
    void getMyCommitmentBuddies(cohort.id).then((result) => {
      if (!cancelled) setBuddies(result.group.buddies);
    });
    return () => {
      cancelled = true;
    };
  }, [cohort.id, cohort.locked]);

  useEffect(() => {
    // The Commitment Wallet (and so any commitment-score data) is hidden
    // entirely while the cohort is locked — same gate as My Plan/Wallet.
    if (cohort.locked) {
      setTeamScores([]);
      return;
    }
    let cancelled = false;
    void getCohortTeamCommitmentScores(cohort.id).then((result) => {
      if (!cancelled) setTeamScores(result.teams);
    });
    return () => {
      cancelled = true;
    };
  }, [cohort.id, cohort.locked]);

  // Only worth showing once participants are actually split into named
  // teams — a single "Unassigned" bucket is just the whole batch, which the
  // roster card below already represents. Hidden while the batch is locked.
  const showTeamScores =
    !cohort.locked &&
    (teamScores.length > 1 || (teamScores.length === 1 && teamScores[0].teamName !== "Unassigned"));
  const sortedTeamScores = useMemo(
    () =>
      [...teamScores].sort((a, b) => {
        if (a.averageScore === null) return b.averageScore === null ? 0 : 1;
        if (b.averageScore === null) return -1;
        return b.averageScore - a.averageScore;
      }),
    [teamScores]
  );

  const sessionDates = useMemo(
    () => [...(cohort.dates ?? [])].filter(Boolean).sort(),
    [cohort.dates],
  );
  const nextSessionDate = useMemo(() => nextUpcomingCohortDate(sessionDates), [sessionDates]);
  const daysToNextSession = nextSessionDate !== null ? daysUntil(nextSessionDate) : null;
  const daysToGoLabel =
    daysToNextSession === null
      ? ""
      : daysToNextSession <= 0
        ? "starts today"
        : daysToNextSession === 1
          ? "day to go"
          : "days to go";

  const rosterRows = useMemo(() => {
    const sorted = [...roster].sort((a, b) => {
      const tagA = a.tag?.name ?? "";
      const tagB = b.tag?.name ?? "";
      if (tagA !== tagB) {
        if (!tagA) return 1; // untagged participants sort last
        if (!tagB) return -1;
        return tagA.localeCompare(tagB);
      }
      return (a.fullName || "").localeCompare(b.fullName || "");
    });
    const distinctTagCount = new Set(sorted.map((member) => member.tag?.name ?? "")).size;
    const rows: ({ kind: "header"; key: string; label: string } | { kind: "member"; key: string; member: CohortMember; colorIndex: number })[] = [];
    let lastTag: string | null | undefined;
    sorted.forEach((member, index) => {
      const tagName = member.tag?.name ?? null;
      if (distinctTagCount > 1 && tagName !== lastTag) {
        rows.push({ kind: "header", key: `header:${tagName ?? "none"}`, label: tagName ?? "Unassigned" });
        lastTag = tagName;
      }
      rows.push({ kind: "member", key: member.id, member, colorIndex: index });
    });
    return rows;
  }, [roster]);

  useEffect(() => {
    if (!buddyInfoOpen) return;
    const previousOverflow = document.body.style.overflow;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setBuddyInfoOpen(false);
    };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [buddyInfoOpen]);

  return (
    <div className="rcpl-workspace animate-in fade-in duration-700">
      <section className="rcpl-program-hero">
        <div className="rcpl-program-copy">
          <small>{programEyebrow}</small>
          <h2>{heroTitle}</h2>
          <p title={heroDescription}>{heroDescription}</p>
          <div className="rcpl-hero-meta">
            {/* Dates come only from the admin-set cohort dates; the agenda
                carries no dates, just "Day 1", "Day 2", etc. */}
            {sessionDates.length === 0 ? (
              <span><CalendarDays size={14} />Date to be announced</span>
            ) : (
              sessionDates.map((date) => (
                <span key={date} className={date === nextSessionDate ? "upcoming" : undefined}>
                  <CalendarDays size={14} />{formatSessionDate(date, true)}
                </span>
              ))
            )}
            {daysToNextSession !== null && daysToNextSession >= 0 && (
              <FlipCountdown days={daysToNextSession} label={daysToGoLabel} />
            )}
          </div>
          {hasPhases && (
            <nav className="rcpl-phase-chips" aria-label="Programme phases">
              {phases.map((item) => <Link key={item.id} href={`/journey?phase=${item.id}`} className={item.id === phase?.id ? "active" : ""}>{item.focus || item.label}</Link>)}
            </nav>
          )}
        </div>
        {hasPhases && (
          <div className="rcpl-hero-steps">
            <PhaseJourneyGraphic phases={phases} currentPhaseId={cohort.currentPhaseId} />
          </div>
        )}
        <div className="rcpl-hero-logo" aria-hidden={!cohort.companyLogoUrl}>
          {cohort.companyLogoUrl ? (
            <img src={cohort.companyLogoUrl} alt={`${cohort.companyName || "Company"} logo`} />
          ) : (
            <span>{initials(cohort.companyName ?? null)}</span>
          )}
        </div>
      </section>

      <ActionPlanCard locked={cohort.locked} />

      <div className="rcpl-content-shell">
        <main>
          {/* <section className={`rcpl-preparation-strip${preparationComplete ? " complete" : ""}`}>
            <span className="rcpl-preparation-icon">{preparationComplete ? <Check size={17} /> : <ArrowRight size={17} />}</span>
            <div><strong>{nextTitle}</strong><p>{nextCopy}</p></div>
            {nextHref ? <Link href={nextHref}>Continue</Link> : <button type="button" disabled={!nextIncompleteItem} onClick={() => nextIncompleteItem && onOpenResource(nextIncompleteItem)}>Open</button>}
          </section> */}

          {phase && (
            <section className="rcpl-card rcpl-agenda" id="rcpl-agenda">
              <header>
                <div><h3>{phase.title}</h3>{phase.subtitle && <p>{phase.subtitle}</p>}</div>
              </header>
              {/* {(phase.focus || phase.summary) && (
                <div className="rcpl-agenda-focus"><div>{phase.focus && <strong>{phase.focus}</strong>}{phase.summary && <p>{phase.summary}</p>}</div></div>
              )} */}
              <div className="rcpl-agenda-days">
                {phase.days.map((day) => (
                  <div className="rcpl-agenda-day" key={day.name}>
                    <h4>{day.name}</h4>
                    <ol>{day.blocks.map((block) => <li key={`${day.name}-${block.time}`}><span>{block.time}</span><strong>{block.name}</strong></li>)}</ol>
                  </div>
                ))}
              </div>
            </section>
          )}



          <section className="rcpl-card rcpl-library" id="preparation">
            <header>
              <div><h3>Pre-reads, videos and session resources</h3></div>
              <strong>{completedCount}/{items.length} complete</strong>
            </header>
            <div className="rcpl-resource-row">
              {items.length === 0 && <div className="journey-inline-empty">No preparation has been assigned yet.</div>}
              {items.map((item) => {
                const done = progress[item.id]?.status === "completed";
                return (
                  <button type="button" className={`rcpl-resource-card${done ? " done" : ""}`} key={item.id} onClick={() => onOpenResource(item)}>
                    <span className={`rcpl-resource-preview ${item.type}`}>
                      <b>{resourceKind(item)}</b>
                      <ResourcePreview item={item} />
                      {done && <em><Check size={12} /> Done</em>}
                    </span>
                    <span className="rcpl-resource-copy">
                      <strong>{item.title}</strong>
                      <span className="rcpl-resource-view">View<ArrowRight size={13} /></span>
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
          {/* Announcements (60%) beside the batch conversation (40%), right under
              the pre-reads and videos. Also a .rcpl-side-rail so the chat keeps
              its rail-scoped styles. */}
          <div className="rcpl-side-rail rcpl-comms-row">
            <NoticeBoardCard notices={notices} trainer={cohort.trainer ?? null} variant="rcpl" />
            <CohortChat cohortId={cohort.id} variant="rcpl" />
          </div>
        </main>

        <aside className="rcpl-side-rail">
          {showTeamScores && (
            <section className="rcpl-card rcpl-team-scores">
              <header><h3>Team avg commitment score</h3></header>
              <div>
                {sortedTeamScores.map((team) => (
                  <div className="rcpl-team-score-row" key={team.teamName}>
                    <span className="rcpl-team-score-name">{team.teamName}</span>
                    <span className="rcpl-team-score-value">
                      {team.averageScore === null ? "—" : `${Math.round(team.averageScore)}%`}
                    </span>
                  </div>
                ))}
              </div>
            </section>
          )}

          <section className="rcpl-card rcpl-participants">
            <header><h3>Your batch</h3></header>
            <div>
              {rosterRows.map((row) =>
                row.kind === "header" ? (
                  <div className="rcpl-tag-group-label" key={row.key}>{row.label}</div>
                ) : (
                  <div className="rcpl-participant" key={row.key}>
                    <b style={{ background: ["#1D3C66", "#B8862B", "#D03A2C", "#2E9E63", "#7A5CC9"][row.colorIndex % 5] }}>{initials(row.member.fullName)}</b>
                    <span><strong>{row.member.fullName || "Participant"}</strong><small>{row.member.email || "—"}</small></span>
                    {row.member.tag && <span className="rcpl-participant-tag">{row.member.tag.name}</span>}
                  </div>
                )
              )}
              {roster.length === 0 && <p className="rcpl-no-results">No participants found.</p>}
            </div>
          </section>



          <section className="rcpl-card rcpl-buddy-card">
            <header>
              <h3>Your commitment buddy</h3>
              <button type="button" onClick={() => setBuddyInfoOpen(true)}>How this works</button>
            </header>
            {cohort.locked ? (
              <p>Your buddy&apos;s name and email will appear here once your batch is unlocked.</p>
            ) : buddies === null ? (
              <p>Loading your buddy…</p>
            ) : buddies.length === 0 ? (
              <p>Your buddy hasn&apos;t been assigned yet. Check back soon.</p>
            ) : (
              <div className="rcpl-buddy-list">
                {buddies.map((buddy, index) => (
                  <div className="rcpl-participant" key={buddy.id}>
                    <b style={{ background: ["#1D3C66", "#B8862B", "#D03A2C", "#2E9E63", "#7A5CC9"][index % 5] }}>{initials(buddy.name)}</b>
                    <span>
                      <strong>{buddy.name}</strong>
                      <small>{buddy.email ? <a href={`mailto:${buddy.email}`}>{buddy.email}</a> : "—"}</small>
                    </span>
                  </div>
                ))}
              </div>
            )}
          </section>

          <FacilitatorsCard facilitators={facilitators} variant="rcpl" />
        </aside>
      </div>

      {typeof document !== "undefined" && buddyInfoOpen && createPortal(
        <div className="rcpl-agenda-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) setBuddyInfoOpen(false); }}>
          <section className="rcpl-buddy-modal" role="dialog" aria-modal="true" aria-labelledby="rcpl-buddy-modal-title">
            <header>
              <div>
                <small>Accountability</small>
                <h3 id="rcpl-buddy-modal-title">How commitment buddies work</h3>
                <p>Everyone in the batch is paired with another person.</p>
              </div>
              <button type="button" onClick={() => setBuddyInfoOpen(false)} aria-label="Close commitment buddy explanation"><X size={17} /></button>
            </header>
            <ol className="rcpl-buddy-modal-body">
              <li>
                <b aria-hidden="true">1</b>
                <span>
                  <strong>Paired within your batch</strong>
                  <p>Your buddy is someone from your own batch. Their name and email appear on this card once your batch is unlocked.</p>
                </span>
              </li>
              <li>
                <b aria-hidden="true">2</b>
                <span>
                  <strong>See overall progress</strong>
                  <p>You can see your buddy&apos;s done, skipped and missed totals, plus points earned and lost. Actions, plans, schedules and reflections stay private.</p>
                </span>
              </li>
              <li>
                <b aria-hidden="true">3</b>
                <span>
                  <strong>Nudge, do not audit</strong>
                  <p>Use the progress view to notice when encouragement or a quick check-in could help — not to police the detail of their work.</p>
                </span>
              </li>
            </ol>
            <footer>
              <button type="button" onClick={() => setBuddyInfoOpen(false)}>Got it</button>
            </footer>
          </section>
        </div>,
        document.body,
      )}
    </div>
  );
}
