"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CalendarDays, Check, CheckCircle2, ChevronDown, ChevronRight, ChevronUp, CircleX, Clock3, Hand, History, Hourglass, Lightbulb, ListChecks, Loader2, Mail, MessageCircle, Pencil,TrendingDown, TrendingUp, UsersRound, X } from "lucide-react";
import { useEngine } from "@/lib/store";
import { getMyPlanSettings, syncMyDuePersonalActions, updateUpcomingPersonalAction, type MyPlanSettings } from "@/app/actions/ai-actions";
import type { ActionCard } from "@/lib/types";
import {
  getMyCommitmentBuddies,
  markMyCommitmentBuddyRevealed,
  type CommitmentBuddyGroup,
  type CommitmentBuddyProgress,
  type CommitmentBuddyTrack,
} from "@/app/actions/commitment-buddies";
import { getMyCommitmentWallet } from "@/app/actions/commitment-wallet";
import { nextMilestoneFor, milestonePoints } from "@/lib/commitment-wallet-milestones";
import { usePageLoading, usePageLoadingControls } from "@/components/PageLoadingProvider";
import ConfettiCelebration from "@/components/ConfettiCelebration";
import PageLoader from "@/components/PageLoader";
import WhatsAppReminderPreview from "@/components/actions/WhatsAppReminderPreview";
import PlanSetup from "@/components/actions/PlanSetup";
import ActionGenerationStory from "@/components/ActionGenerationStory";
import NudgieCoffee from "@/components/actions/NudgieCoffee";
import ActionCheckinModal from "@/components/actions/ActionCheckinModal";
import { clearEmailSequence, startEmailSequencePhase, waitForEmailSequencePhase } from "@/lib/email-link-sequence";

/** Tabs of the Action history popup. Current actions and Next reminders live on the page itself. */
type HistoryTab = "pending-validation" | "not-completed" | "completed" | "archived";
/** Next reminders shown before "See all". */
const UPCOMING_PREVIEW_COUNT = 2;
const editTipKey = (cohortId: string | undefined) => `nudgeable:actions-edit-tip-dismissed:${cohortId ?? "none"}`;
type ArchivedActionEntry = {
  id: string;
  cohortId: string;
  cohortName: string;
  archivedAt: string;
  theme: string;
  title: string;
  how: string;
  why: string;
  timeEstimate: string;
  status: string | null;
  reflection: string | null;
  scheduledAt: string | null;
};
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function formatDate(value?: string) {
  if (!value) return "Scheduled by your plan";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString("en-GB", {
    timeZone: "Asia/Kolkata",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function formatTime(value: string) {
  if (!value) return "Not set";
  const [hours, minutes] = value.split(":").map(Number);
  const suffix = hours >= 12 ? "PM" : "AM";
  return `${hours % 12 || 12}:${String(minutes || 0).padStart(2, "0")} ${suffix}`;
}

function projectedDeliveryDate(settings: MyPlanSettings | null, actionIndex: number) {
  if (!settings?.nextDeliveryAt) return undefined;
  const date = new Date(settings.nextDeliveryAt);
  if (Number.isNaN(date.getTime())) return undefined;
  const periodIndex = Math.floor(actionIndex / Math.max(1, settings.actionCount));
  if (settings.track === "weekly") {
    date.setUTCDate(date.getUTCDate() + periodIndex * 7);
  } else {
    let weekdaysToAdd = periodIndex;
    while (weekdaysToAdd > 0) {
      date.setUTCDate(date.getUTCDate() + 1);
      const weekday = date.getUTCDay();
      if (weekday !== 0 && weekday !== 6) weekdaysToAdd -= 1;
    }
  }
  return date.toISOString();
}

async function fetchArchivedActions(): Promise<ArchivedActionEntry[]> {
  const response = await fetch("/api/archived-actions", { cache: "no-store" });
  if (!response.ok) return [];
  const result = await response.json() as { actions?: ArchivedActionEntry[] };
  return result.actions ?? [];
}

function archivedStatusLabel(status: string | null) {
  if (status === "success" || status === "habit_started" || status === "cemented") return "Completed";
  if (status === "skipped") return "Skipped";
  if (status === "failed") return "Didn’t complete";
  if (status === "scheduled") return "Ready to do";
  return "Not started";
}

function archivedActionIsComplete(status: string | null) {
  return status === "success" || status === "habit_started" || status === "cemented";
}

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "CM";
  return `${parts[0]?.[0] ?? ""}${parts.length > 1 ? parts[parts.length - 1]?.[0] ?? "" : parts[0]?.[1] ?? ""}`.toUpperCase();
}

/** Displays as a whole number; the underlying score keeps decimal precision in calculations. */
function formatCommitmentScore(value: number) {
  const clamped = Math.min(100, Math.max(0, value));
  return String(Math.round(clamped));
}

type BuddyCardState = "pending-plan" | "new" | "dipped" | "steady";

function buddyCardState(buddy: CommitmentBuddyProgress): BuddyCardState {
  if (!buddy.hasFinalisedPlan || buddy.currentScore === null) return "pending-plan";
  if (buddy.previousScore === null) return "new";
  return buddy.currentScore < buddy.previousScore ? "dipped" : "steady";
}

function buddyPeriodLabels(track: CommitmentBuddyTrack) {
  if (track === "daily") return { previous: "Yesterday", current: "Today", sincePhrase: "since yesterday" };
  if (track === "weekly") return { previous: "Last week", current: "This week", sincePhrase: "this week" };
  return { previous: "Last period", current: "Current", sincePhrase: "recently" };
}

function buddyStateMessage(buddy: CommitmentBuddyProgress, state: BuddyCardState) {
  const firstName = buddy.name.split(/\s+/)[0] || buddy.name;
  const { sincePhrase } = buddyPeriodLabels(buddy.track);
  if (state === "pending-plan") return `${firstName} hasn't finalised their Commitment plan yet.`;
  if (state === "new") return `${firstName} just finalised their plan — no comparison yet.`;
  if (state === "dipped") return `${firstName}'s commitment has dipped ${sincePhrase}.`;
  return `${firstName} is keeping their commitment steady.`;
}

/** One line for the collapsed card, e.g. "72% this week · up from 60%". */
function buddySummary(buddy: CommitmentBuddyProgress, state: BuddyCardState) {
  if (state === "pending-plan" || buddy.currentScore === null) return "Hasn't finalised their plan yet";
  const { current } = buddyPeriodLabels(buddy.track);
  const now = `${formatCommitmentScore(buddy.currentScore)}% ${current.toLowerCase()}`;
  if (buddy.previousScore === null) return `${now} · just started`;
  const before = `${formatCommitmentScore(buddy.previousScore)}%`;
  if (buddy.currentScore < buddy.previousScore) return `${now} · down from ${before}`;
  if (buddy.currentScore > buddy.previousScore) return `${now} · up from ${before}`;
  return `${now} · steady`;
}

function buddyContactCopy(buddy: CommitmentBuddyProgress, state: BuddyCardState) {
  const firstName = buddy.name.split(/\s+/)[0] || buddy.name;
  const { sincePhrase } = buddyPeriodLabels(buddy.track);
  if (state === "pending-plan") {
    return {
      label: `Say hi to ${firstName}`,
      title: `Say hi to ${firstName}`,
      message: `Hi ${firstName}, just checking in — let me know if you need a hand finalising your Action plan.`,
    };
  }
  if (state === "new") {
    return {
      label: `Say hi to ${firstName}`,
      title: `Say hi to ${firstName}`,
      message: `Hi ${firstName}, saw you just finalised your Action plan — excited to keep each other on track!`,
    };
  }
  if (state === "dipped") {
    return {
      label: `Check in with ${firstName}`,
      title: `Check in with ${firstName}`,
      message: `Hi ${firstName}, I noticed your Commitment Score dipped ${sincePhrase}. Just checking in to see how things are going. Anything I can help with?`,
    };
  }
  return {
    label: `Congratulate ${firstName}`,
    title: `Congratulate ${firstName}`,
    message: `Hi ${firstName}, great to see you keeping your Commitment Score steady ${sincePhrase}. Nice work keeping the momentum going!`,
  };
}

function CommitmentBuddyScoreCard({
  buddy,
  onContact,
}: {
  buddy: CommitmentBuddyProgress;
  onContact: (buddy: CommitmentBuddyProgress) => void;
}) {
  const state = buddyCardState(buddy);
  const labels = buddyPeriodLabels(buddy.track);
  const contact = buddyContactCopy(buddy, state);
  const isSayHi = state === "new" || state === "pending-plan";
  const cardClass = state === "dipped" ? " dipped" : state === "steady" ? " steady" : "";
  const previousOrbText = buddy.previousScore === null
    ? (buddy.currentScore === null ? "—" : "New")
    : `${formatCommitmentScore(buddy.previousScore)}%`;
  const currentOrbText = buddy.currentScore === null ? "—" : `${formatCommitmentScore(buddy.currentScore)}%`;
  const [expanded, setExpanded] = useState(false);
  const panelId = `buddy-panel-${buddy.id}`;

  return <section className={`commitment-buddy-card${cardClass}${expanded ? "" : " is-collapsed"}`} aria-label={`Commitment score for ${buddy.name}`}>
    <button type="button" className="commitment-buddy-card-head commitment-buddy-toggle" aria-expanded={expanded} aria-controls={panelId} onClick={() => setExpanded((open) => !open)}>
      <span className="commitment-buddy-avatar" aria-hidden="true">{initials(buddy.name)}</span>
      <span className="commitment-buddy-identity">
        <span className="commitment-buddy-eyebrow">Your Commitment Buddy</span>
        <span className="commitment-buddy-name">{buddy.name}</span>
        <span className={`commitment-buddy-relation${expanded ? "" : " commitment-buddy-summary"}`}>{expanded ? "You are their commitment buddy" : buddySummary(buddy, state)}</span>
      </span>
      <ChevronDown size={18} className="commitment-buddy-chevron" aria-hidden="true" />
    </button>

    {expanded && <div id={panelId}>
    <div className="commitment-buddy-score-panel" aria-label="Commitment score comparison">
      <div className="commitment-buddy-score-flow">
        <div className="commitment-buddy-score-block">
          <span className="commitment-buddy-score-label">{labels.previous}</span>
          <div className={`commitment-buddy-score-orb${buddy.previousScore === null ? " commitment-buddy-score-orb--empty" : ""}`}>{previousOrbText}</div>
        </div>
        <div className="commitment-buddy-flow-arrow" aria-hidden="true">
          {state === "dipped" ? <TrendingDown size={17} strokeWidth={2.4} /> : <TrendingUp size={17} strokeWidth={2.4} />}
        </div>
        <div className="commitment-buddy-score-block is-current">
          <span className="commitment-buddy-score-label">{labels.current}</span>
          <div className={`commitment-buddy-score-orb${buddy.currentScore === null ? " commitment-buddy-score-orb--empty" : ""}`}>{currentOrbText}</div>
        </div>
      </div>
    </div>

    <div className="commitment-buddy-state-row">
      <span className="commitment-buddy-state-icon" aria-hidden="true">
        {state === "dipped" ? <TrendingDown size={14} strokeWidth={2.4} /> : <CheckCircle2 size={14} strokeWidth={2.4} />}
      </span>
      <span>{buddyStateMessage(buddy, state)}</span>
    </div>
    </div>}

    <button type="button" className="commitment-buddy-contact" onClick={() => onContact(buddy)}>
      {isSayHi ? <Hand size={16} strokeWidth={2.4} /> : <MessageCircle size={16} strokeWidth={2.4} />}
      <span>{contact.label}</span>
    </button>
  </section>;
}

function CommitmentBuddyCard({
  group,
  onContact,
}: {
  group: CommitmentBuddyGroup;
  onContact: (buddy: CommitmentBuddyProgress) => void;
}) {
  if (group.buddies.length === 0) {
    return <section className="commitment-buddy-card actions-buddy-waiting">
      <div className="actions-buddy-waiting-icon"><UsersRound size={21} /></div>
      <div><span>Your commitment buddy</span><strong>Waiting for another batch member</strong><p>Your pairing will appear here as soon as another unpaired participant joins.</p></div>
    </section>;
  }

  return <>
    {group.buddies.map((buddy) => <CommitmentBuddyScoreCard key={buddy.id} buddy={buddy} onContact={onContact} />)}
  </>;
}

type ReminderPreviewAction = {
  title: string;
  how: string;
  timeEstimate: string;
  imageUrl?: string | null;
};

function ReminderEmailPreview({
  firstName,
  actions,
  companyName,
  companyLogoUrl,
  hasFinalisedPlan,
  commitmentScore,
  buddyName,
  buddyScore,
  teamRank,
  teamSize,
  teamPoints,
  teamMaximumPoints,
  alwaysOpen = false,
}: {
  /** Inside the preview popup: no collapse toggle, plus a From line. */
  alwaysOpen?: boolean;
  firstName: string;
  actions: ReminderPreviewAction[];
  companyName?: string | null;
  companyLogoUrl?: string | null;
  hasFinalisedPlan: boolean;
  commitmentScore: number | null;
  buddyName: string | null;
  buddyScore: number | null;
  teamRank: number | null;
  teamSize: number | null;
  teamPoints: number;
  teamMaximumPoints: number;
}) {
  const [expandedState, setExpanded] = useState(false);
  const expanded = alwaysOpen || expandedState;
  const nextMilestone = nextMilestoneFor(teamPoints, teamMaximumPoints);
  const milestoneThreshold = nextMilestone ? milestonePoints(teamMaximumPoints, nextMilestone.percent) : 0;
  const milestoneProgress = milestoneThreshold > 0
    ? Math.min(100, Math.max(0, Math.round((teamPoints / milestoneThreshold) * 100)))
    : 0;

  return <section className={`actions-reminder-preview${expanded ? " is-open" : ""}${alwaysOpen ? " actions-reminder-preview--modal" : ""}`} aria-label="Sample action reminder email">
    {!alwaysOpen && <button
      type="button"
      className="actions-reminder-preview-toggle"
      aria-expanded={expanded}
      onClick={() => setExpanded((open) => !open)}
    >
      <div>
        <span>Sample email preview</span>
        <h3>Your reminder email</h3>
        <p>See how your next action reminder will arrive.</p>
      </div>
      <span className="actions-reminder-preview-toggle-icons">
        <i aria-hidden="true"><Mail size={17} /></i>
        {expanded ? <ChevronUp size={18} aria-hidden="true" /> : <ChevronDown size={18} aria-hidden="true" />}
      </span>
    </button>}

    {expanded && <>
      {alwaysOpen && <div className="actions-reminder-subject">
        <span>From</span>
        <strong>Team Nudgeable &lt;team@nudgeable.ai&gt;</strong>
      </div>}
      <div className="actions-reminder-subject">
        <span>Subject</span>
        <strong>Hi {firstName} — Your actions are ready</strong>
      </div>

      <div className="actions-reminder-email">
        <div className="actions-reminder-email-hero">
          <div className="actions-reminder-email-hero-top">
            <span>Your action reminder</span>
            {companyLogoUrl && (
              <span className="actions-reminder-email-hero-badge">
                <img src={companyLogoUrl} alt={companyName ?? "Company"} />
              </span>
            )}
          </div>
          <h4>Your next actions<strong>are ready.</strong></h4>
          <p>Hey {firstName}, your next actions are ready when you are.</p>
        </div>
        <div className="actions-reminder-email-body">
          <div className="actions-reminder-metrics">
            <div className="actions-reminder-metric">
              <i aria-hidden="true">&#10003;</i>
              <strong>{hasFinalisedPlan && commitmentScore !== null ? `${formatCommitmentScore(commitmentScore)}%` : "—"}</strong>
              <span>Your Commitment Score</span>
            </div>
            <div className="actions-reminder-metric actions-reminder-metric--buddy">
              <i aria-hidden="true">&#8596;</i>
              <strong>{buddyName && buddyScore !== null ? `${formatCommitmentScore(buddyScore)}%` : "—"}</strong>
              <span>{buddyName ? `${buddyName} · Your Buddy` : "No buddy yet"}</span>
            </div>
            <div className="actions-reminder-metric actions-reminder-metric--rank">
              <i aria-hidden="true">&#9733;</i>
              <strong>{teamRank !== null && teamSize !== null ? <>{teamRank}<em> / {teamSize}</em></> : "—"}</strong>
              <span>Team Contribution Rank</span>
            </div>
          </div>

          <p className="actions-reminder-email-section-label">Your actions</p>
          {actions.map((action, index) => (
            <article className="actions-reminder-email-action" key={index}>
              {action.imageUrl ? (
                <img className="actions-reminder-email-action-image" src={action.imageUrl} alt="" />
              ) : (
                <i aria-hidden="true">→</i>
              )}
              <strong>{action.title}</strong>
              <span className="actions-reminder-email-action-btn">Mark done</span>
            </article>
          ))}

          <p className="actions-reminder-email-tip"><strong>Done an action?</strong> Tap &quot;Mark done&quot; next to it above and in one click update your Commitment Score and add points to your team.</p>

          <p className="actions-reminder-email-login">Prefer to review them in the app? <span>Log in to update each action individually.</span></p>

          <div className="actions-reminder-email-reward">
            <i aria-hidden="true">{nextMilestone ? nextMilestone.icon : teamMaximumPoints === 0 ? "⏳" : "🎉"}</i>
            <div>
              {teamMaximumPoints === 0 ? (
                <strong>Waiting for finalised plans</strong>
              ) : nextMilestone ? (
                <>
                  <small>Next team reward</small>
                  <strong>{nextMilestone.headline}</strong>
                  <div className="actions-reminder-email-reward-bar"><span style={{ width: `${milestoneProgress}%` }} /></div>
                </>
              ) : (
                <strong>Every current reward unlocked!</strong>
              )}
            </div>
          </div>
        </div>
        <div className="actions-reminder-email-footer">Powered by <b>Nudgeable.ai</b></div>
      </div>

      <p className="actions-reminder-preview-note"><span aria-hidden="true" /> Preview only · no email has been sent.</p>
    </>}
  </section>;
}

export default function ActionsClient() {
  const router = useRouter();
  const { profile, cohort, personalPlanState, allActions, userActions, completeAction, dismissPendingValidation, refetch, generationJob } = useEngine();
  const [historyTab, setHistoryTab] = useState<HistoryTab | null>(null);
  const [preview, setPreview] = useState<"email" | "whatsapp" | null>(null);
  const [showAllUpcoming, setShowAllUpcoming] = useState(false);
  const [highlightEdits, setHighlightEdits] = useState(false);
  const [tipDismissed, setTipDismissed] = useState(true);
  const [completingId, setCompletingId] = useState<string | null>(null);
  const [dismissingId, setDismissingId] = useState<string | null>(null);
  const [celebration, setCelebration] = useState<{
    title: string;
    pointsDelta?: number;
    completedLate?: boolean;
  } | null>(null);
  const [reflection, setReflection] = useState("");
  const [busy, setBusy] = useState(false);
  const [skippingId, setSkippingId] = useState<string | null>(null);
  const [completeError, setCompleteError] = useState<string | null>(null);
  const [settings, setSettings] = useState<MyPlanSettings | null>(null);
  const [buddyGroup, setBuddyGroup] = useState<CommitmentBuddyGroup | null>(null);
  const [buddyReady, setBuddyReady] = useState(false);
  const [contactBuddy, setContactBuddy] = useState<CommitmentBuddyProgress | null>(null);
  const [archivedActions, setArchivedActions] = useState<ArchivedActionEntry[]>([]);
  const [archiveReady, setArchiveReady] = useState(false);
  const [ready, setReady] = useState(false);
  // True while a reminder email's "Mark done" link (single action) or the
  // Friday recap's "I completed all" link (every listed action, one request
  // each) is settling in the background — see the completeAction(s) effect
  // below. Holds the count so the overlay can say "action" vs "actions".
  // Shown as a full-pane overlay (portaled to <body>, like every other
  // overlay in this file) so the click doesn't look like it silently
  // stalled while it works.
  const [autoCompleting, setAutoCompleting] = useState<{ count: number } | null>(null);
  const [editingUpcomingAction, setEditingUpcomingAction] = useState<ActionCard | null>(null);
  const [editUpcomingForm, setEditUpcomingForm] = useState<{ title: string; how: string; why: string; category: string } | null>(null);
  const [savingUpcomingEdit, setSavingUpcomingEdit] = useState(false);
  const [upcomingEditError, setUpcomingEditError] = useState<string | null>(null);
  const [commitmentScore, setCommitmentScore] = useState<{
    hasFinalisedPlan: boolean;
    score: number;
    contributionRank: number;
    teamMemberCount: number;
    teamPoints: number;
    teamMaximumPoints: number;
  } | null>(null);

  const { beginNavigation } = usePageLoadingControls();
  // Plan setup (no live plan yet) loads its own data after this page is
  // ready; keep the loading screen up until it says it's ready too.
  const [setupReady, setSetupReady] = useState(false);
  useEffect(() => setSetupReady(false), [cohort?.id]);
  // True from "Your actions are live" until the live plan has loaded, so plan
  // setup stays on screen instead of flashing an empty page.
  const [handingOff, setHandingOff] = useState(false);
  // "Generating your actions" lives here, not in PlanSetup, so it stays up
  // from Activate until Current actions are on screen, even if PlanSetup
  // re-renders or the page reloads its data in between.
  const [generating, setGenerating] = useState(false);
  const loadedCohortId = useRef<string | null | undefined>(undefined);

  const cohortId = cohort?.id;
  const loadActivatedPlan = useCallback(async () => {
    setHandingOff(true);
    setGenerating(true);
    try {
      const [, settingsResult] = await Promise.all([refetch(), getMyPlanSettings(cohortId)]);
      setSettings(settingsResult.settings);
    } finally {
      setHandingOff(false);
      setGenerating(false);
    }
  }, [refetch, cohortId]);

  useEffect(() => {
    let cancelled = false;
    // Only a batch switch blanks the page; a plan-state change (e.g. right
    // after activation) refreshes in place.
    if (loadedCohortId.current !== cohort?.id) setReady(false);
    loadedCohortId.current = cohort?.id;
    void (async () => {
      // Current actions and Next reminders only need these two calls, so
      // resolve just them and let the page paint immediately — commitment
      // buddy and wallet data are fetched separately below and enhance the
      // page once they land, instead of holding up first paint.
      const [syncResult, settingsResult] = await Promise.allSettled([
        // Release any batch whose IST delivery date is today or earlier, so
        // Current actions does not wait for the once-daily cron.
        syncMyDuePersonalActions(cohort?.id),
        getMyPlanSettings(cohort?.id),
      ]);
      if (cancelled) return;
      const assigned = syncResult.status === "fulfilled" ? syncResult.value.assigned : 0;
      if (assigned > 0) await refetch();
      if (cancelled) return;
      setSettings(settingsResult.status === "fulfilled" ? settingsResult.value.settings : null);
      setReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [cohort?.id, personalPlanState, refetch]);

  useEffect(() => {
    let cancelled = false;
    setBuddyReady(false);
    void (async () => {
      // Background enhancement only: these feed the commitment-buddy sidebar
      // and the reminder-email preview, both of which already render
      // conditionally on buddyReady, so they can trail the main page.
      const [buddyResult, walletResult] = await Promise.allSettled([
        cohort?.id ? getMyCommitmentBuddies(cohort.id) : Promise.resolve({ group: null }),
        getMyCommitmentWallet(cohort?.id),
      ]);
      if (cancelled) return;
      setBuddyGroup(buddyResult.status === "fulfilled" ? buddyResult.value.group : null);
      if (walletResult.status === "fulfilled") {
        setCommitmentScore({
          hasFinalisedPlan: walletResult.value.summary.hasFinalisedPlan,
          score: walletResult.value.summary.commitmentScore,
          contributionRank: walletResult.value.summary.contributionRank,
          teamMemberCount: walletResult.value.summary.teamMemberCount,
          teamPoints: walletResult.value.summary.teamPoints,
          teamMaximumPoints: walletResult.value.summary.teamMaximumPoints,
        });
      } else {
        setCommitmentScore(null);
      }
      setBuddyReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [cohort?.id]);

  useEffect(() => {
    let cancelled = false;
    void fetchArchivedActions()
      .then((actions) => {
        if (!cancelled) setArchivedActions(actions);
      })
      .catch(() => {
        if (!cancelled) setArchivedActions([]);
      })
      .finally(() => {
        if (!cancelled) setArchiveReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const actionMap = useMemo(() => new Map(allActions.map((action) => [action.id, action])), [allActions]);
  const planIsActive = settings?.isActive === true;
  const planIsArchived = settings?.isArchived === true;
  const planCanPerform = planIsActive || planIsArchived;
  const scheduled = planCanPerform ? userActions.filter((item) => item.status === "scheduled" && actionMap.has(item.actionId)) : [];
  const completed = userActions.filter((item) => item.status === "success" && actionMap.has(item.actionId));
  // An action retired when the next batch arrived (unfinished Current → Pending
  // validation) is unresolved, not a confirmed miss — it stays out of "Didn't
  // complete" until the participant either validates it as done or confirms the miss.
  const pendingValidation = userActions.filter((item) => item.status === "failed" && item.autoExpired && actionMap.has(item.actionId));
  const notCompleted = userActions.filter((item) => (item.status === "failed" || item.status === "skipped") && !item.autoExpired && actionMap.has(item.actionId));
  const usedActionIds = new Set(userActions.map((item) => item.actionId));
  const totalPlanActions = allActions.filter((action) => action.isPersonal).length;
  const currentActions = scheduled.map((item) => ({ userAction: item, action: actionMap.get(item.actionId)! }));
  const upcoming = planCanPerform ? allActions.filter((action) => action.isPersonal && !usedActionIds.has(action.id)) : [];
  const showPlanSetup = Boolean(cohort) && !planCanPerform && cohort?.isCurrent !== false && personalPlanState !== "active" && personalPlanState !== "archived";
  // The generating screen covers everything, so no second loader underneath it.
  usePageLoading(!generating && (!ready || (showPlanSetup && !setupReady)));
  const fallbackReminderAction: ReminderPreviewAction = {
    title: "Turn one learning into a question",
    how: "Before your next conversation, write one open question that helps you understand the other person's perspective.",
    timeEstimate: "10 minutes",
  };
  const reminderActions: ReminderPreviewAction[] = currentActions.length
    ? currentActions.map(({ action }) => action)
    : upcoming.length
      ? [upcoming[0]]
      : allActions.length
        ? [allActions[0]]
        : [fallbackReminderAction];
  const reminderFirstName = profile.name.trim().split(/\s+/)[0] || "there";

  // One-click "Mark done" links from reminder emails land here already
  // signed in (via /api/auto-login) with ?completeAction=<actionId>. Settle
  // it the same way the in-app "I did it" flow does, then show the same
  // celebration + redirect, so the click needs no further taps.
  //
  // The Friday recap's "I completed all" button instead lands with
  // ?completeActions=<id1,id2,...> — every action still open for the week in
  // one link — so this settles each one in turn and shows a single combined
  // celebration for the batch.
  useEffect(() => {
    if (!ready || typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const targetActionId = params.get("completeAction");
    const targetActionIds = params.get("completeActions");
    if (!targetActionId && !targetActionIds) return;
    // Strip immediately so a refresh or back-navigation can't replay it.
    window.history.replaceState({}, "", window.location.pathname);

    const ids = targetActionIds
      ? [...new Set(targetActionIds.split(",").map((id) => id.trim()).filter(Boolean))]
      : [targetActionId!];
    if (!ids.length) return;
    const singleTitle = ids.length === 1 ? actionMap.get(ids[0])?.title : undefined;

    void (async () => {
      // Saving starts right away; the notebook (step 3 of the email-link
      // sequence) only appears once the door has played through — Layout
      // keeps the door up until then.
      const work = (async () => {
        let completedCount = 0;
        let pointsTotal = 0;
        let anyLate = false;
        const unlockIds: string[] = [];
        for (const id of ids) {
          const result = await completeAction(id, true, "");
          if (!result.error) {
            completedCount += 1;
            pointsTotal += result.pointsDelta ?? 0;
            if (result.completedLate) anyLate = true;
            if (result.surpriseBoxUnlockId) unlockIds.push(result.surpriseBoxUnlockId);
          } else {
            console.error("Auto-complete from email link failed:", id, result.error);
          }
        }
        return { completedCount, pointsTotal, anyLate, unlockIds };
      })();

      await waitForEmailSequencePhase("door");
      startEmailSequencePhase("notebook");
      setAutoCompleting({ count: ids.length });
      let leavingForWallet = false;
      try {
        const [outcome] = await Promise.all([work, waitForEmailSequencePhase("notebook")]);
        if (outcome.completedCount === 0) return;

        // Plans with Surprise Boxes: straight to the Surprise Boxes page with the
        // reveal open. The notebook stays up until this page unmounts.
        if (outcome.unlockIds.length) {
          leavingForWallet = true;
          router.replace(`/surprises?reveal=${outcome.unlockIds.map(encodeURIComponent).join(",")}`);
          return;
        }

        try {
          setArchivedActions(await fetchArchivedActions());
        } catch {
          // Non-fatal — the celebration below doesn't depend on this list.
        }
        setCelebration({
          title: outcome.completedCount === 1 ? singleTitle ?? "Action completed" : `${outcome.completedCount} actions completed!`,
          pointsDelta: outcome.pointsTotal,
          completedLate: outcome.anyLate,
        });
      } finally {
        clearEmailSequence();
        if (!leavingForWallet) setAutoCompleting(null);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  async function finish(success: boolean) {
    if (!completingId) return;
    const actionTitle =
      actionMap.get(completingId)?.title ??
      archivedActions.find((action) => action.id === completingId)?.title;
    setBusy(true);
    setCompleteError(null);
    // Nudgie writes in the notebook while it saves (only as long as the save
    // takes — the minimum play time is for the email-link sequence).
    if (success) setAutoCompleting({ count: 1 });
    let leavingForWallet = false;
    try {
      // A success opens the celebration or the box reveal straight away; the
      // store reloads behind it. ("I didn't complete it" still waits, below.)
      const result = await completeAction(completingId, success, reflection, { waitForRefresh: !success });
      if (!result.error) {
        if (success && result.surpriseBoxUnlockId) {
          leavingForWallet = true;
          router.replace(`/surprises?reveal=${encodeURIComponent(result.surpriseBoxUnlockId)}`);
          return;
        }
        // Refresh the archive list in the background; keep the existing one if
        // that request fails. The celebration doesn't depend on it.
        void fetchArchivedActions().then(setArchivedActions).catch(() => undefined);
        setCompletingId(null);
        setReflection("");
        if (success) {
          setCelebration({
            title: actionTitle ?? "Action completed",
            pointsDelta: result.pointsDelta,
            completedLate: result.completedLate,
          });
        }
      } else {
        console.error("completeAction failed:", result.error);
        setCompleteError(result.error);
      }
    } finally {
      if (!leavingForWallet) {
        setAutoCompleting(null);
        setBusy(false);
      }
    }
  }

  function closeCelebration() {
    setCelebration(null);
    router.push("/wallet");
  }

  /** "Done" on the celebration popup — shows the coin-drop-into-bucket loader while it transfers to the Commitment Points. */
  function continueFromCelebration() {
    setCelebration(null);
    beginNavigation("/wallet", "wallet");
    router.push("/wallet");
  }

  function viewPendingValidationFromCelebration() {
    setCelebration(null);
    setHistoryTab("pending-validation");
  }

  // The buddy reveal popup is gone; mark the pairing as seen so it counts as
  // revealed. The buddy card on this page still introduces them.
  const buddyRevealPending = Boolean(planIsActive && buddyGroup?.revealPending && buddyGroup.buddies.length > 0);
  useEffect(() => {
    if (!buddyRevealPending || !cohort?.id) return;
    setBuddyGroup((current) => current ? { ...current, revealPending: false } : current);
    void markMyCommitmentBuddyRevealed(cohort.id);
  }, [buddyRevealPending, cohort?.id]);

  useEffect(() => {
    try {
      setTipDismissed(window.localStorage.getItem(editTipKey(cohort?.id)) === "1");
    } catch {
      setTipDismissed(false);
    }
  }, [cohort?.id]);

  function dismissTip() {
    setTipDismissed(true);
    try {
      window.localStorage.setItem(editTipKey(cohort?.id), "1");
    } catch {
      // Private mode: the tip simply shows again next visit.
    }
  }

  /** "Edit my actions": open the full upcoming list and point at the ✎ buttons. */
  function startEditingActions() {
    setShowAllUpcoming(true);
    setHighlightEdits(true);
    window.setTimeout(() => setHighlightEdits(false), 2400);
    window.requestAnimationFrame(() => {
      document.getElementById("next-reminders")?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  async function skip(actionId: string) {
    setBusy(true);
    setSkippingId(actionId);
    try {
      // The card leaves Current actions; it is listed in History → Didn't complete.
      await completeAction(actionId, false, "Skipped");
    } finally {
      setBusy(false);
      setSkippingId(null);
    }
  }

  async function confirmNotDone(actionId: string) {
    setBusy(true);
    setDismissingId(actionId);
    try {
      const result = await dismissPendingValidation(actionId);
      if (!result.error) setHistoryTab("not-completed");
    } finally {
      setBusy(false);
      setDismissingId(null);
    }
  }

  const batchCategories = cohort?.actionCategories ?? [];

  function openUpcomingEdit(action: ActionCard) {
    setEditingUpcomingAction(action);
    setEditUpcomingForm({ title: action.title, how: action.how, why: action.why, category: action.category ?? "" });
    setUpcomingEditError(null);
  }

  async function saveUpcomingEdit() {
    if (!editingUpcomingAction || !editUpcomingForm) return;
    setSavingUpcomingEdit(true);
    setUpcomingEditError(null);
    const result = await updateUpcomingPersonalAction(editingUpcomingAction.id, {
      title: editUpcomingForm.title,
      how: editUpcomingForm.how,
      why: editUpcomingForm.why,
      // Only send a picked category; an edit never clears one.
      ...(batchCategories.length && editUpcomingForm.category ? { category: editUpcomingForm.category } : {}),
    });
    setSavingUpcomingEdit(false);
    if (result.error) {
      setUpcomingEditError(result.error);
      return;
    }
    setEditingUpcomingAction(null);
    setEditUpcomingForm(null);
    await refetch();
  }

  const generatingScreen = generating && typeof document !== "undefined"
    ? createPortal(<ActionGenerationStory job={generationJob} />, document.body)
    : null;

  if (!ready) return generatingScreen;

  // No live plan yet in the current batch: write the plan and activate it right here.
  if (showPlanSetup || handingOff) {
    return <>
      {generatingScreen}
      <PlanSetup onReady={() => setSetupReady(true)} onActivated={loadActivatedPlan} onGeneratingChange={setGenerating} />
    </>;
  }

  const visibleUpcoming = planIsArchived || showAllUpcoming ? upcoming : upcoming.slice(0, UPCOMING_PREVIEW_COUNT);
  const hiddenUpcomingCount = upcoming.length - visibleUpcoming.length;
  // Each tab keeps its own colour, as the page tabs did before they moved into this popup.
  const historyTabs: { id: HistoryTab; label: string; count: number | string; color: string }[] = [
    { id: "pending-validation", label: "Pending validation", count: pendingValidation.length, color: "#ED4551" },
    { id: "not-completed", label: "Didn't complete", count: notCompleted.length, color: "#E07B39" },
    { id: "completed", label: "Completed", count: completed.length, color: "#2F9E51" },
    { id: "archived", label: "Old module", count: archiveReady ? archivedActions.length : "…", color: "#E6BE31" },
  ];

  return <div className="reference-actions animate-in fade-in duration-700">
    <div className="actions-overview-head actions-overview-head--v2">
      <div>
        <h1>
          Your practice plan
          {planIsActive ? <span className="actions-plan-live-dot" aria-label="Plan active" role="status" /> : null}
        </h1>
        <p>{planIsActive && settings?.nextDeliveryAt
          ? `Your next actions arrive on ${formatDate(settings.nextDeliveryAt)}.`
          : "One action appears when it is due. Completed actions move to your history."}</p>
      </div>
      <div className="actions-head-buttons">
        <button type="button" className="actions-head-button" onClick={() => setHistoryTab(pendingValidation.length ? "pending-validation" : "completed")}>
          <History size={16} /> History
          {pendingValidation.length > 0 && <span className="actions-head-badge" aria-label={`${pendingValidation.length} pending validation`}>{pendingValidation.length}</span>}
        </button>
        {planIsActive && upcoming.length > 0 && (
          <button type="button" className="actions-head-button actions-head-button--primary" onClick={startEditingActions}>
            <Pencil size={16} /> Edit my actions
          </button>
        )}
      </div>
    </div>

    <div className="actions-reference-layout">
      <section className="actions-current-group">
        <div className="actions-section-heading">
          <div>
            <h3>Current actions</h3>
          </div>
          {currentActions.length > 0 && <span>{currentActions.length} ready</span>}
        </div>
        {currentActions.length === 0 ? (
          <div className="actions-current-card actions-current-card--empty">
            <div className="actions-coffee-break">
              <NudgieCoffee />
              <div className="actions-coffee-bubble" role="status">
                <strong>
                  {planIsArchived
                    ? "No released actions remain"
                    : planIsActive || planCanPerform
                      ? "No actions due right now"
                      : "No action plan made"}
                </strong>
                <p>
                  {planIsArchived
                    ? "This archived batch plan will not release more reminders."
                    : planIsActive || planCanPerform
                      ? "Grab a cup of coffee and relax ☕"
                      : personalPlanState === "draft"
                        ? "Finish reviewing and finalise this batch's draft plan first."
                        : "Build a practice plan for your current batch to generate workplace actions."}
                </p>
                {!planIsArchived && (planIsActive || planCanPerform) && settings?.nextDeliveryAt && (
                  <p className="actions-chill-next-reminder">
                    Your next action arrives on {formatDate(settings.nextDeliveryAt)}
                    {settings.reminderTime && ` at ${formatTime(settings.reminderTime)}`}
                  </p>
                )}
              </div>
            </div>
          </div>
        ) : (
          <div className="actions-current-list" style={{ "--action-cols": Math.min(currentActions.length, 3) } as CSSProperties}>
            {currentActions.map(({ userAction, action }, index) => <article className="actions-current-card" key={userAction.id}>
              <div className="actions-current-top"><span>Action # {(action.planOrder ?? index) + 1}</span><em>{action.timeEstimate}{action.planPoints ? ` · Protect ${action.planPoints} points today` : ""}</em></div>
              {action.category && <span className="actions-current-category">{action.category}</span>}
              <div style={{ display: "flex", alignItems: "flex-start", gap: "10px" }}>
                {action.imageUrl && (
                  <img src={action.imageUrl} alt="" width={88} height={88} style={{ width: 88, height: 88, borderRadius: 16, objectFit: "cover", display: "block", marginRight: 6, flexShrink: 0 }} />
                )}
                <h3 style={{ fontSize: "1.25rem", fontWeight: "bold", margin: 0 }}>{action.title}</h3>
              </div>
              <p style={{ fontSize: "1rem", fontWeight: "normal" }}>{action.how}</p>
              <p style={{ fontSize: "1rem", fontWeight: "normal" }}><span style={{ fontWeight: "bold" }}>Why? </span>{action.why}</p>
              <div className="actions-current-buttons">
                <button className="journey-primary-button" disabled={busy} onClick={() => setCompletingId(userAction.actionId)}><Check size={16} /> I did it</button>
                <button type="button" disabled={busy} aria-busy={skippingId === userAction.actionId} onClick={() => void skip(userAction.actionId)}>
                  {skippingId === userAction.actionId ? <><Loader2 size={16} className="animate-spin" aria-hidden="true" /> Saving…</> : "I didn't complete it"}
                </button>
              </div>
            </article>)}
          </div>
        )}
      </section>

      {pendingValidation.length > 0 && (
        <button type="button" className="actions-pending-strip" onClick={() => setHistoryTab("pending-validation")}>
          <span className="actions-pending-strip-icon" aria-hidden="true"><Hourglass size={17} /></span>
          <span>
            <strong>{pendingValidation.length} earlier action{pendingValidation.length === 1 ? "" : "s"} waiting for you to confirm</strong>
            <small>Did you do {pendingValidation.length === 1 ? "it" : "them"}? Confirm to keep your Commitment Score up to date.</small>
          </span>
          <ChevronRight size={18} aria-hidden="true" />
        </button>
      )}

      {planIsActive && !tipDismissed && (
        <div className="actions-edit-tip">
          <span className="actions-edit-tip-icon" aria-hidden="true"><Lightbulb size={18} /></span>
          <div>
            <strong>You can change your plan anytime</strong>
            <p>Use <b>Edit my actions</b> or tap <b>✎</b> on any upcoming action to reword it.</p>
          </div>
          <button type="button" onClick={dismissTip}>Got it</button>
        </div>
      )}

      <hr className="actions-section-divider" />

      <div className={`actions-secondary-row${planIsActive && buddyReady && buddyGroup ? "" : " actions-secondary-row--solo"}`}>
        <section id="next-reminders" className={`actions-list-card${!planCanPerform && upcoming.length === 0 ? " actions-list-card--empty-reminders" : ""}${highlightEdits ? " is-highlighting-edits" : ""}`}>
          {planCanPerform || upcoming.length > 0 ? (
            <>
              <h3>{planIsArchived ? "Remaining archived actions" : "Next reminders"}</h3>
              <p>{planIsArchived
                ? "Reminder delivery is paused. You can still choose and complete any remaining action."
                : "These unlock automatically on your reminder day. Tap ✎ to edit one."}</p>
              <div className="actions-upcoming-list plan-review-list">
                {upcoming.length === 0 && <div className="actions-inline-empty">{planIsArchived ? "No archived actions remain." : "No additional actions are scheduled yet."}</div>}
                {visibleUpcoming.map((action, index) => {
                  const deliveryDate = projectedDeliveryDate(settings, index);
                  const points = action.planPoints ?? 50;
                  return <article className={`plan-review-action${planIsArchived ? "" : " plan-review-action--reminder"}`} key={action.id}>
                    <div className="plan-action-order">
                      {action.imageUrl
                        ? <div style={{ position: "relative", width: 44, height: 44, marginRight: 14 }}>
                          <img src={action.imageUrl} alt="" width={44} height={44} style={{ width: 44, height: 44, borderRadius: "50%", objectFit: "cover", display: "block" }} />
                          <span style={{ position: "absolute", bottom: -4, right: -4, width: 22, height: 22, borderRadius: "50%", background: "#FFCE00", color: "#221D23", fontSize: 12, fontWeight: 900, lineHeight: "22px", textAlign: "center", boxShadow: "0 0 0 2px #FFFFFF" }}>{index + 1}</span>
                        </div>
                        : <div className="plan-action-number">{index + 1}</div>}
                    </div>
                    <div className="plan-action-copy plan-action-copy--compact">
                      <h3 title={action.title}>{action.title}</h3>
                      <div className="plan-action-meta">
                        {action.category && <span className="plan-action-category">{action.category}</span>}
                        <span><CalendarDays size={13} />{planIsArchived ? "Available to revisit" : formatDate(deliveryDate)}</span>
                        <span className="plan-action-points">{points}<i className="plan-gold-coin" aria-hidden="true" /></span>
                      </div>
                    </div>
                    {planIsArchived
                      ? <div className="plan-action-controls plan-action-controls--compact"><button type="button" disabled={busy} onClick={() => setCompletingId(action.id)}>Mark as done</button></div>
                      : <button type="button" className="plan-action-edit-button" disabled={busy} onClick={() => openUpcomingEdit(action)} aria-label={`Edit ${action.title}`} title="Edit action"><Pencil size={13} /></button>}
                  </article>;
                })}
              </div>
              {!planIsArchived && upcoming.length > UPCOMING_PREVIEW_COUNT && (
                <button type="button" className="actions-see-all" aria-expanded={showAllUpcoming} onClick={() => setShowAllUpcoming((open) => !open)}>
                  <span>
                    {showAllUpcoming ? "Show fewer" : `See all ${upcoming.length} upcoming actions`}
                    {!showAllUpcoming && <small>{hiddenUpcomingCount} more scheduled after these</small>}
                  </span>
                  {showAllUpcoming ? <ChevronUp size={18} aria-hidden="true" /> : <ChevronDown size={18} aria-hidden="true" />}
                </button>
              )}
            </>
          ) : (
            <div className="actions-reminders-empty">
              <div className="actions-reminders-empty-icon" aria-hidden="true"><CalendarDays size={26} /></div>
              <span className="participant-eyebrow">Next reminders</span>
              <strong>No plan for this batch</strong>
              <p>Switch to your current batch from the sidebar to build and activate a plan.</p>
            </div>
          )}
        </section>

        {planIsActive && buddyReady && buddyGroup && (
          <aside className="actions-buddy-sidebar">
            <CommitmentBuddyCard group={buddyGroup} onContact={setContactBuddy} />
            <div className="actions-preview-buttons">
              <span>See your reminders</span>
              <button type="button" onClick={() => setPreview("email")}><Mail size={16} /> Email reminder</button>
              <button type="button" onClick={() => setPreview("whatsapp")}><MessageCircle size={16} /> WhatsApp reminder</button>
            </div>
          </aside>
        )}
      </div>
    </div>

    {typeof document !== "undefined" && historyTab && createPortal(
      <div className="actions-history-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) setHistoryTab(null); }}>
        <section className="actions-history-modal" role="dialog" aria-modal="true" aria-labelledby="actions-history-title">
          <header className="actions-history-head">
            <div>
              <h2 id="actions-history-title">Action history</h2>
              <p>Everything that isn&apos;t due right now.</p>
            </div>
            <button type="button" className="actions-history-close" onClick={() => setHistoryTab(null)} aria-label="Close"><X size={18} /></button>
          </header>
          <nav className="actions-history-tabs" aria-label="History views">
            {historyTabs.map((item) => (
              <button
                type="button"
                key={item.id}
                className={`${historyTab === item.id ? "active" : ""}${item.id === "pending-validation" && pendingValidation.length > 0 ? " has-alert" : ""}`}
                aria-pressed={historyTab === item.id}
                style={{ "--tab-c": item.color } as CSSProperties}
                onClick={() => setHistoryTab(item.id)}
              >
                {item.label} <span>{item.count}</span>
              </button>
            ))}
          </nav>
          <div className="actions-history-body">
            {historyTab === "completed" && <section className="actions-completed-card"><p>A record of the workplace actions you have finished.</p><div className="actions-completed-list">
              {completed.length === 0 && <div className="actions-empty-state"><CheckCircle2 size={28} /><strong>No completed actions yet</strong><p>Your completed workplace actions will appear here.</p></div>}
              {completed.map((item) => { const action = actionMap.get(item.actionId)!; return <div key={item.id}><CheckCircle2 size={19} /><span><strong>{action.title}</strong><small>{item.completedLate ? `Completed late · no Wallet points${item.reflection ? ` · ${item.reflection}` : ""}` : `Completed on time${item.pointsDelta ? ` · +${item.pointsDelta} points` : ""}${item.reflection ? ` · ${item.reflection}` : ""}`}</small></span><em>{formatDate(item.completedAt || item.scheduledAt || item.scheduledDate)}</em></div>; })}
            </div></section>}

            {historyTab === "pending-validation" && <section className="actions-completed-card"><p>These weren&apos;t marked done before your next batch arrived. If you did them, mark them done now.</p><div className="actions-completed-list actions-not-completed-list actions-pending-validation-list">
              {pendingValidation.length === 0 && <div className="actions-empty-state"><Hourglass size={28} /><strong>Nothing awaiting validation</strong><p>Unfinished Current actions move here when your next batch arrives.</p></div>}
              {pendingValidation.map((item) => { const action = actionMap.get(item.actionId)!; return <div key={item.id}><Hourglass size={19} /><span><strong>{action.title}</strong></span><em>{formatDate(item.scheduledAt || item.scheduledDate)}</em><div className="actions-pending-validation-buttons"><button type="button" className="journey-primary-button" disabled={busy} onClick={() => setCompletingId(item.actionId)}><Check size={16} /> I did it</button><button type="button" disabled={busy} aria-busy={dismissingId === item.actionId} onClick={() => void confirmNotDone(item.actionId)}>{dismissingId === item.actionId ? <><Loader2 size={16} className="animate-spin" aria-hidden="true" /> Saving…</> : "No, I didn't"}</button></div></div>; })}
            </div></section>}

            {historyTab === "not-completed" && <section className="actions-completed-card"><p>A record of workplace actions you skipped or could not complete.</p><div className="actions-completed-list actions-not-completed-list">
              {notCompleted.length === 0 && <div className="actions-empty-state"><CircleX size={28} /><strong>No uncompleted actions</strong><p>Actions you don&apos;t complete will appear here.</p></div>}
              {notCompleted.map((item) => { const action = actionMap.get(item.actionId)!; return <div key={item.id}><CircleX size={19} /><span><strong>{action.title}</strong><small>{item.pointsDelta && item.pointsDelta < 0 ? `${item.pointsDelta} points · ` : ""}{item.reflection || (item.status === "skipped" ? "Skipped" : "Not completed")}</small></span><em>{formatDate(item.scheduledAt || item.scheduledDate)}</em><button type="button" disabled={busy} onClick={() => setCompletingId(item.actionId)}>Complete late</button></div>; })}
            </div></section>}

            {historyTab === "archived" && <section className="actions-completed-card actions-archive-card"><p>Actions from all your earlier batch plans stay visible here, whichever batch you are viewing.</p><div className="actions-archive-list">
              {!archiveReady && <div className="actions-empty-state"><span className="actions-inline-loader" /><strong>Loading archived actions</strong></div>}
              {archiveReady && archivedActions.length === 0 && <div className="actions-empty-state"><ListChecks size={28} /><strong>No archived actions</strong><p>Actions from an earlier batch will appear here after its plan is archived.</p></div>}
              {archivedActions.map((action) => {
                const isComplete = archivedActionIsComplete(action.status);
                return <article key={action.id}>
                  <div className="actions-archive-copy"><div className="actions-archive-meta"><span>{action.cohortName}</span><em>{archivedStatusLabel(action.status)}</em></div><strong>{action.title}</strong><p>{action.how}</p><small><Clock3 size={12} /> {action.timeEstimate} · Archived {formatDate(action.archivedAt)}</small>{action.reflection && <blockquote>{action.reflection}</blockquote>}</div>
                  {isComplete ? <CheckCircle2 className="actions-archive-complete" size={21} aria-label="Completed" /> : <button type="button" disabled={busy} onClick={() => setCompletingId(action.id)}>{action.status === "failed" || action.status === "skipped" ? "Try again" : "Mark as done"}</button>}
                </article>;
              })}
            </div></section>}
          </div>
        </section>
      </div>,
      document.body,
    )}

    {typeof document !== "undefined" && preview && createPortal(
      <div className="actions-history-overlay actions-preview-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) setPreview(null); }}>
        <section className="actions-history-modal actions-preview-modal" role="dialog" aria-modal="true" aria-labelledby="actions-preview-title">
          <header className="actions-history-head">
            <div>
              <h2 id="actions-preview-title">{preview === "email" ? "Your reminder email" : "Your WhatsApp reminder"}</h2>
              <p>{preview === "email" ? "Sent from team@nudgeable.ai on your reminder day." : "Sent on your reminder day if WhatsApp reminders are on."}</p>
            </div>
            <button type="button" className="actions-history-close" onClick={() => setPreview(null)} aria-label="Close"><X size={18} /></button>
          </header>
          {preview === "email" ? (
            <ReminderEmailPreview
              alwaysOpen
              firstName={reminderFirstName}
              actions={reminderActions}
              companyName={cohort?.companyName}
              companyLogoUrl={cohort?.companyLogoUrl}
              hasFinalisedPlan={commitmentScore?.hasFinalisedPlan ?? false}
              commitmentScore={commitmentScore?.score ?? null}
              buddyName={buddyGroup?.buddies[0]?.name ?? null}
              buddyScore={buddyGroup?.buddies[0]?.currentScore ?? null}
              teamRank={commitmentScore?.contributionRank ?? null}
              teamSize={commitmentScore?.teamMemberCount ?? null}
              teamPoints={commitmentScore?.teamPoints ?? 0}
              teamMaximumPoints={commitmentScore?.teamMaximumPoints ?? 0}
            />
          ) : (
            <WhatsAppReminderPreview
              firstName={reminderFirstName}
              companyName={cohort?.companyName}
              track={settings?.track === "daily" ? "daily" : "weekly"}
              actionTitles={reminderActions.map((action) => action.title)}
            />
          )}
        </section>
      </div>,
      document.body,
    )}

    {typeof document !== "undefined" && contactBuddy && createPortal((() => {
      const state = buddyCardState(contactBuddy);
      const contact = buddyContactCopy(contactBuddy, state);
      const mailtoHref = contactBuddy.email
        ? `mailto:${encodeURIComponent(contactBuddy.email)}?subject=${encodeURIComponent(contact.title)}&body=${encodeURIComponent(contact.message)}`
        : undefined;
      return <div className="commitment-buddy-contact-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setContactBuddy(null); }}>
        <section className="commitment-buddy-contact-modal" role="dialog" aria-modal="true" aria-labelledby="buddy-contact-title">
          <div className="commitment-buddy-contact-top">
            <div>
              <h2 id="buddy-contact-title">{contact.title}</h2>
              <p className="commitment-buddy-contact-intro">Copy the email and draft below, then send it using your usual email or messaging app.</p>
            </div>
            <button type="button" className="commitment-buddy-contact-close" onClick={() => setContactBuddy(null)} aria-label="Close"><X size={17} strokeWidth={2.5} /></button>
          </div>

          <div className="commitment-buddy-contact-field-label">
            <span>Email</span>
            {mailtoHref && <a href={mailtoHref}>Open in email app</a>}
          </div>
          <div className="commitment-buddy-contact-selectable" tabIndex={0}>{contactBuddy.email ?? "No email on file"}</div>

          <label className="commitment-buddy-contact-field-label" htmlFor="buddy-draft-message">Suggested message</label>
          <textarea id="buddy-draft-message" className="commitment-buddy-contact-selectable" readOnly value={contact.message} />

          <button type="button" className="commitment-buddy-contact-ok" onClick={() => setContactBuddy(null)}>OK</button>
        </section>
      </div>;
    })(), document.body)}

    {typeof document !== "undefined" && editingUpcomingAction && editUpcomingForm && createPortal(<div className="plan-edit-overlay"><div className="plan-edit-modal"><button className="plan-edit-close" onClick={() => { setEditingUpcomingAction(null); setEditUpcomingForm(null); }}><X size={18} /></button><span className="participant-eyebrow">Edit action</span><h3>Edit your action</h3><label>Action title<input value={editUpcomingForm.title} onChange={(event) => setEditUpcomingForm((current) => current ? { ...current, title: event.target.value } : current)} /></label>{batchCategories.length > 0 && <label>Category<select value={editUpcomingForm.category} onChange={(event) => setEditUpcomingForm((current) => current ? { ...current, category: event.target.value } : current)}>{!editUpcomingForm.category && <option value="" disabled>Choose a category</option>}{batchCategories.map((category) => <option key={category} value={category}>{category}</option>)}{editUpcomingForm.category && !batchCategories.includes(editUpcomingForm.category) && <option value={editUpcomingForm.category}>{editUpcomingForm.category}</option>}</select></label>}<div className="plan-edit-how-why"><label><span>How to do it</span><textarea value={editUpcomingForm.how} onChange={(event) => setEditUpcomingForm((current) => current ? { ...current, how: event.target.value } : current)} /></label><label><span>Why it works</span><textarea value={editUpcomingForm.why} onChange={(event) => setEditUpcomingForm((current) => current ? { ...current, why: event.target.value } : current)} /></label></div>{upcomingEditError && <p className="plan-review-error">{upcomingEditError}</p>}<button className="journey-primary-button" disabled={savingUpcomingEdit || !editUpcomingForm.title.trim() || !editUpcomingForm.how.trim() || !editUpcomingForm.why.trim()} onClick={saveUpcomingEdit}>{savingUpcomingEdit ? "Saving…" : "Save"}</button></div></div>, document.body)}

    <ActionCheckinModal
      open={Boolean(completingId)}
      reflection={reflection}
      busy={busy}
      error={completeError}
      onReflectionChange={setReflection}
      onClose={() => { setCompletingId(null); setCompleteError(null); }}
      onComplete={() => void finish(true)}
    />

    {typeof document !== "undefined" && autoCompleting && createPortal(
      <PageLoader
        variant="main"
        theme="email-notebook"
        label={autoCompleting.count === 1 ? "Marking your action as done…" : "Marking your actions as done…"}
        sublabel="Writing it into your plan"
      />,
      document.body,
    )}

    {typeof document !== "undefined" && celebration && createPortal(
      <ConfettiCelebration
        actionTitle={celebration.title}
        pointsDelta={celebration.pointsDelta}
        completedLate={celebration.completedLate}
        pendingValidationCount={pendingValidation.length}
        completedCount={completed.length}
        totalPlanCount={totalPlanActions}
        onContinue={continueFromCelebration}
        onClose={closeCelebration}
        onViewPendingValidation={viewPendingValidationFromCelebration}
      />,
      document.body,
    )}
  </div>;
}
