"use client";

import { useState, useEffect, useCallback, type ComponentType, type ReactNode } from "react";
import {
  BarChart as ReBarChart,
  Bar,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  LabelList,
} from "recharts";
import { ArrowDown, ArrowUp, Check, CircleCheck, Lightbulb, Mail, Target } from "lucide-react";
import { useAdminContext } from "@/components/admin/AdminContext";
import { useBatchOptions } from "@/components/admin/BatchSelector";
import { ParticipantActionsModal } from "@/components/admin/ParticipantActionsModal";
import { weekChartLabelFormatter, weekChartRange } from "@/components/admin/WeekChartTick";
import {
  getActionCompletionWeeklyTrend,
  getCommitmentScoreBuckets,
  getDashboardLeaderboard,
  getBatchCommitmentWeeklyTrend,
  getEmailOpenRates,
  type ActionWeeklyTrendEntry,
  type CommitmentScoreBuckets,
  type DashboardLeaderboardEntry,
  type CommitmentWeeklyTrendEntry,
  type EmailOpenWeeklyEntry,
} from "@/app/actions/admin-dashboard";

// Dashboard chart palette: purple carries the measured value, gray the baseline
// it's read against, and the score bands step light→dark so higher reads stronger.
const CHART_PRIMARY = "#6636E8";
const CHART_BASELINE = "#D4D4D8";
const SCORE_BAND_COLORS = ["#D9D2FB", "#B49EF3", "#8460EC", CHART_PRIMARY];
const TABLE_HEAD_BG = "#EDE9FE";
// Right-hand edge of the frozen Rank / Name column, so scrolled cells read as passing under it.
const FROZEN_COLUMN_EDGE = "1px 0 0 var(--color-border-strong)";
const FROZEN_RIGHT_COLUMN_EDGE = "-1px 0 0 var(--color-border-strong)";

const axisTick = { fontSize: 11, fill: "var(--color-text-muted)" };
const chartCursor = { fill: "rgba(102, 54, 232, 0.06)" };
const barValueLabel = { fontSize: 10, fontWeight: 700, fill: "var(--color-text-primary)" };

const cardStyle = { border: "1px solid var(--color-border)", boxShadow: "var(--shadow-sm)" };

function DashboardCard({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="bg-white rounded-2xl overflow-hidden flex flex-col min-w-0" style={cardStyle}>
      <div className="flex flex-wrap items-center justify-between gap-2 px-5 pt-4 pb-3">
        <h3 className="text-sm font-bold" style={{ color: "var(--color-text-primary)" }}>
          {title}
        </h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

function StatCard({
  label,
  value,
  suffix,
  icon: Icon,
  tint,
  ink,
}: {
  label: string;
  value: ReactNode;
  suffix?: ReactNode;
  icon: ComponentType<{ size?: number }>;
  tint: string;
  ink: string;
}) {
  return (
    <div className="bg-white rounded-2xl p-4 flex justify-between gap-3" style={cardStyle}>
      <div className="flex flex-col justify-between gap-2 min-w-0">
        <span className="flex flex-wrap items-baseline gap-x-1.5">
          <span className="text-4xl font-bold leading-none" style={{ color: "var(--color-text-primary)" }}>
            {value}
          </span>
          {suffix != null && (
            <span className="text-xs font-medium" style={{ color: "var(--color-text-muted)" }}>
              {suffix}
            </span>
          )}
        </span>
        <span className="text-xs font-medium leading-snug" style={{ color: "var(--color-text-secondary)" }}>
          {label}
        </span>
      </div>
      <span className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0 self-start" style={{ background: tint, color: ink }}>
        <Icon size={18} />
      </span>
    </div>
  );
}

function LegendKey({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5 text-xs font-medium" style={{ color: "var(--color-text-secondary)" }}>
      <span className="w-2.5 h-2.5 rounded-sm" style={{ background: color }} />
      {label}
    </span>
  );
}

interface DashboardViewProps {
  companyId: string | null;
}

export function DashboardView({ companyId }: DashboardViewProps) {
  const { selectedCohortId, setViewReady, setContextBarSlot } = useAdminContext();
  const { options: batchOptions, loading: batchOptionsLoading } = useBatchOptions(companyId);
  // ── Batch/module drill-down (selector + buckets, leaderboard, weekly trend, email opens) ──
  const [actionWeeklyTrend, setActionWeeklyTrend] = useState<ActionWeeklyTrendEntry[]>([]);
  const [actionWeeklyLoading, setActionWeeklyLoading] = useState(true);
  const [scoreBuckets, setScoreBuckets] = useState<CommitmentScoreBuckets | null>(null);
  const [scoreBucketsLoading, setScoreBucketsLoading] = useState(true);
  const [leaderboard, setLeaderboard] = useState<DashboardLeaderboardEntry[]>([]);
  const [leaderboardLoading, setLeaderboardLoading] = useState(true);
  const [viewingParticipant, setViewingParticipant] = useState<DashboardLeaderboardEntry | null>(null);
  const closeParticipantModal = useCallback(() => setViewingParticipant(null), []);
  const [weeklyTrend, setWeeklyTrend] = useState<CommitmentWeeklyTrendEntry[]>([]);
  const [weeklyTrendDelta, setWeeklyTrendDelta] = useState<number | null>(null);
  const [weeklyTrendLoading, setWeeklyTrendLoading] = useState(true);
  const [emailWeekly, setEmailWeekly] = useState<EmailOpenWeeklyEntry[]>([]);
  const [emailLoading, setEmailLoading] = useState(true);

  // All sections fetch independently; rather than letting each one pop
  // in on its own timeline, report readiness up to BatchPickerGate once every
  // section has settled at least once for this company/cohort, so its
  // loading screen — not an assumption that picking a batch means the data
  // is there — is what decides when the dashboard actually shows.
  const dashboardReady = !actionWeeklyLoading && !scoreBucketsLoading && !leaderboardLoading && !weeklyTrendLoading && !emailLoading && !batchOptionsLoading;

  useEffect(() => {
    setViewReady(dashboardReady);
  }, [dashboardReady, setViewReady]);

  useEffect(() => () => setViewReady(true), [setViewReady]);

  useEffect(() => {
    if (!companyId) {
      setActionWeeklyTrend([]);
      return;
    }
    setActionWeeklyLoading(true);
    getActionCompletionWeeklyTrend(companyId, selectedCohortId)
      .then(({ entries, error }) => setActionWeeklyTrend(!error ? entries ?? [] : []))
      .finally(() => setActionWeeklyLoading(false));
  }, [companyId, selectedCohortId]);

  useEffect(() => {
    if (!companyId) {
      setScoreBuckets(null);
      return;
    }
    setScoreBucketsLoading(true);
    getCommitmentScoreBuckets(companyId, selectedCohortId)
      .then(({ buckets, error }) => setScoreBuckets(!error ? buckets ?? null : null))
      .finally(() => setScoreBucketsLoading(false));
  }, [companyId, selectedCohortId]);

  useEffect(() => {
    if (!companyId) {
      setLeaderboard([]);
      return;
    }
    setLeaderboardLoading(true);
    getDashboardLeaderboard(companyId, selectedCohortId)
      .then(({ entries, error }) => setLeaderboard(!error ? entries ?? [] : []))
      .finally(() => setLeaderboardLoading(false));
  }, [companyId, selectedCohortId]);

  useEffect(() => {
    if (!companyId) {
      setWeeklyTrend([]);
      setWeeklyTrendDelta(null);
      return;
    }
    setWeeklyTrendLoading(true);
    getBatchCommitmentWeeklyTrend(companyId, selectedCohortId)
      .then(({ entries, deltaPct, error }) => {
        setWeeklyTrend(!error ? entries ?? [] : []);
        setWeeklyTrendDelta(!error ? deltaPct ?? null : null);
      })
      .finally(() => setWeeklyTrendLoading(false));
  }, [companyId, selectedCohortId]);

  useEffect(() => {
    if (!companyId) {
      setEmailWeekly([]);
      return;
    }
    setEmailLoading(true);
    getEmailOpenRates(companyId, selectedCohortId)
      .then(({ weekly, error }) => setEmailWeekly(!error ? weekly ?? [] : []))
      .finally(() => setEmailLoading(false));
  }, [companyId, selectedCohortId]);

  const tooltipStyle = {
    borderRadius: "12px",
    border: "1px solid var(--color-border)",
    boxShadow: "var(--shadow-md)",
    fontFamily: "var(--font-body)",
    fontWeight: 600,
    fontSize: "13px",
    color: "var(--color-text-primary)",
  };

  const emptyState = (msg: string) => (
    <div className="h-full flex items-center justify-center text-sm font-medium" style={{ color: "var(--color-text-muted)" }}>
      {msg}
    </div>
  );

  const actionWeeklyChartData = actionWeeklyTrend.map((e) => ({
    name: `Week ${e.weekNumber}`,
    weekRange: weekChartRange(e.weekStartIst, e.weekEndIst),
    "Actions due": e.due,
    "Actions completed": e.completed,
  }));

  const scoreBucketChartData = scoreBuckets
    ? [
      { name: "Below 50%", Users: scoreBuckets.belowBand50 },
      { name: "50–74%", Users: scoreBuckets.band50to74 },
      { name: "75–89%", Users: scoreBuckets.band75to89 },
      { name: "90–100%", Users: scoreBuckets.band90to100 },
    ]
    : [];

  const weeklyTrendChartData = weeklyTrend.map((e) => ({
    name: `Week ${e.weekNumber}`,
    weekRange: weekChartRange(e.weekStartIst, e.weekEndIst),
    "Avg. commitment %": e.avgCommitmentPct,
  }));

  // Weekly average of unique "either mail" openers/reach, for the "avg of users who
  // open either mail" stat card — averaged per week rather than a lifetime union.
  const eitherWeeklyAvgStats = (() => {
    if (emailWeekly.length === 0) return { avgOpenedUsers: 0, avgReachUsers: 0 };
    const totalOpened = emailWeekly.reduce((sum, e) => sum + e.eitherMailOpenedUsers, 0);
    const totalReach = emailWeekly.reduce((sum, e) => sum + e.eitherMailUsers, 0);
    return {
      avgOpenedUsers: Math.round(totalOpened / emailWeekly.length),
      avgReachUsers: Math.round(totalReach / emailWeekly.length),
    };
  })();

  // Of users who've activated a plan (commitmentMaximum > 0, same signal as the
  // "Activated action plan" card), how many have validated at least one action.
  const validationRateStats = (() => {
    const planned = leaderboard.filter((u) => u.commitmentMaximum > 0);
    const validatedAtLeastOne = planned.filter((u) => u.validatedCount > 0).length;
    return {
      plannedCount: planned.length,
      validatedAtLeastOne,
      pct: planned.length > 0 ? Math.round((validatedAtLeastOne * 100) / planned.length) : 0,
    };
  })();

  const selectedBatch = batchOptions.find((option) => option.cohortId === selectedCohortId);
  const batchSubtitle = selectedBatch
    ? [selectedBatch.batchName, selectedBatch.moduleName].filter(Boolean).join(" — ")
    : selectedCohortId === null
      ? "All batches"
      : null;

  const countCellStyle = (count: number) => ({
    color: count > 0 ? "var(--color-text-primary)" : "var(--color-text-muted)",
  });
  const headCellStyle = { color: "var(--color-text-primary)" };

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500 pb-12">

      {/* ── PAGE HEADER ── */}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 min-w-0">
          <h2 className="text-2xl lg:text-3xl font-bold" style={{ color: "var(--color-text-primary)" }}>
            Admin Dashboard
          </h2>
          {batchSubtitle && (
            <p className="text-sm font-medium" style={{ color: "var(--color-text-muted)" }}>
              {batchSubtitle}
            </p>
          )}
        </div>
        {/* The batch/module selector lands here instead of on its own row above the page. */}
        <div ref={setContextBarSlot} className="w-full sm:w-auto" />
      </div>

      {/* ── BATCH DRILL-DOWN ── */}
      <div className="space-y-4">
        {/* Users who've finalised an action plan — same "made a plan" signal as the
            Leaderboard's "No plan" tag (commitmentMaximum > 0), so the two numbers agree.
            Batch avg sits beside it (mean among activated users only). */}
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-3.5">
          <StatCard
            label="Activated action plan"
            value={scoreBucketsLoading ? "…" : scoreBuckets ? scoreBuckets.totalUsers - scoreBuckets.notStarted : 0}
            suffix={`of ${scoreBucketsLoading ? "…" : scoreBuckets?.totalUsers ?? 0}`}
            icon={Target}
            tint="#DBEAFE"
            ink="#1D4ED8"
          />
          <StatCard
            label="Batch avg commitment"
            value={
              scoreBucketsLoading
                ? "…"
                : scoreBuckets?.avgCommitmentPct != null
                  ? `${scoreBuckets.avgCommitmentPct}%`
                  : "—"
            }
            icon={Lightbulb}
            tint="#FEF3C7"
            ink="#B45309"
          />
          <StatCard
            label="Total actions validated"
            value={leaderboardLoading ? "…" : leaderboard.reduce((sum, u) => sum + u.validatedCount, 0)}
            icon={CircleCheck}
            tint="#DCFCE7"
            ink="#15803D"
          />
          <StatCard
            label="Avg. users who opened either mail / week"
            value={emailLoading ? "…" : eitherWeeklyAvgStats.avgOpenedUsers}
            suffix={`of ${emailLoading ? "…" : eitherWeeklyAvgStats.avgReachUsers}`}
            icon={Mail}
            tint="#EDE9FE"
            ink={CHART_PRIMARY}
          />
          <StatCard
            label="Validated at least 1 action"
            value={leaderboardLoading ? "…" : `${validationRateStats.pct}%`}
            suffix={leaderboardLoading ? "…" : `${validationRateStats.validatedAtLeastOne} of ${validationRateStats.plannedCount}`}
            icon={Check}
            tint="#FFEDD5"
            ink="#C2410C"
          />
        </div>

        {/* Weekly Action Completion (due vs. completed, left) + Commitment Score Distribution (bars, right) */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <DashboardCard
            title="Weekly Action Completion"
            aside={
              <span className="flex items-center gap-3">
                <LegendKey color={CHART_BASELINE} label="Actions due" />
                <LegendKey color={CHART_PRIMARY} label="Actions completed" />
              </span>
            }
          >
            <div className="px-3 pb-3" style={{ height: 260 }}>
              {actionWeeklyLoading ? (
                emptyState("Loading…")
              ) : actionWeeklyChartData.length === 0 ? (
                emptyState("No scheduled actions in scope yet")
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <ReBarChart data={actionWeeklyChartData} barSize={14} barGap={2} margin={{ top: 20, right: 8, left: 0, bottom: 0 }}>
                    <CartesianGrid vertical={false} stroke="var(--color-border)" />
                    <XAxis dataKey="name" interval="preserveStartEnd" tick={axisTick} tickLine={false} axisLine={{ stroke: "var(--color-border)" }} />
                    <YAxis allowDecimals={false} tickCount={4} tick={axisTick} tickLine={false} axisLine={false} width={36} />
                    <Tooltip contentStyle={tooltipStyle} cursor={chartCursor} labelFormatter={weekChartLabelFormatter(actionWeeklyChartData)} />
                    <Bar dataKey="Actions due" fill={CHART_BASELINE} radius={[3, 3, 0, 0]}>
                      <LabelList dataKey="Actions due" position="top" offset={4} style={barValueLabel} />
                    </Bar>
                    <Bar dataKey="Actions completed" fill={CHART_PRIMARY} radius={[3, 3, 0, 0]}>
                      <LabelList dataKey="Actions completed" position="top" offset={4} style={barValueLabel} />
                    </Bar>
                  </ReBarChart>
                </ResponsiveContainer>
              )}
            </div>
          </DashboardCard>

          <DashboardCard
            title="Commitment Score Distribution"
            aside={
              scoreBuckets && scoreBuckets.notStarted > 0 ? (
                <span className="tag tag--yellow">{scoreBuckets.notStarted} not started (no plan yet)</span>
              ) : undefined
            }
          >
            <div className="px-3 pb-3" style={{ height: 260 }}>
              {scoreBucketsLoading ? (
                emptyState("Loading…")
              ) : !scoreBuckets || scoreBuckets.totalUsers === 0 ? (
                emptyState("No commitment data yet")
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <ReBarChart data={scoreBucketChartData} layout="vertical" margin={{ top: 0, right: 32, left: 4, bottom: 0 }}>
                    <XAxis type="number" hide allowDecimals={false} domain={[0, "dataMax"]} />
                    <YAxis type="category" dataKey="name" tick={{ ...axisTick, fontSize: 12 }} tickLine={false} axisLine={false} width={84} />
                    <Tooltip contentStyle={tooltipStyle} cursor={chartCursor} formatter={(value) => [`${value} users`, "Users"]} />
                    <Bar dataKey="Users" barSize={14} radius={[0, 3, 3, 0]}>
                      {scoreBucketChartData.map((entry, index) => (
                        <Cell key={entry.name} fill={SCORE_BAND_COLORS[index]} />
                      ))}
                      <LabelList dataKey="Users" position="right" offset={10} style={{ fontSize: 12, fontWeight: 700, fill: "var(--color-text-primary)" }} />
                    </Bar>
                  </ReBarChart>
                </ResponsiveContainer>
              )}
            </div>
          </DashboardCard>
        </div>

        {/* Leaderboard */}
        <DashboardCard
          title="Leaderboard"
          aside={
            <span className="text-xs font-medium" style={{ color: "var(--color-tag-primary-text)" }}>
              Ranked by commitment score %
            </span>
          }
        >
          {leaderboardLoading ? (
            <div className="p-6 text-center text-sm font-medium" style={{ color: "var(--color-text-muted)" }}>Loading leaderboard…</div>
          ) : leaderboard.length === 0 ? (
            <div className="p-6 text-center text-sm font-medium" style={{ color: "var(--color-text-muted)" }}>No members in scope yet</div>
          ) : (
            <div className="overflow-x-auto max-h-[600px] overflow-y-auto">
              <table className="w-full text-left border-collapse table-fixed min-w-[1180px] text-xs">
                <thead className="sticky top-0 z-10" style={{ background: TABLE_HEAD_BG }}>
                  <tr>
                    <th
                      className="sticky left-0 z-20 px-5 py-3 text-xs font-semibold"
                      style={{ ...headCellStyle, width: "21%", background: TABLE_HEAD_BG, boxShadow: FROZEN_COLUMN_EDGE }}
                    >
                      Rank / Name
                    </th>
                    <th className="px-2 py-3 text-xs font-semibold" style={{ ...headCellStyle, width: "10%" }}>Buddy</th>
                    <th className="px-2 py-3 text-xs font-semibold text-center" style={{ ...headCellStyle, width: "7.5%" }}>Either mail opened</th>
                    <th className="px-2 py-3 text-xs font-semibold text-center" style={{ ...headCellStyle, width: "7.5%" }}>Planned actions</th>
                    <th className="px-2 py-3 text-xs font-semibold text-center" style={{ ...headCellStyle, width: "7.5%" }}>Actions sent</th>
                    <th className="px-2 py-3 text-xs font-semibold text-center" style={{ ...headCellStyle, width: "7.5%" }}>Validated actions</th>
                    <th className="px-2 py-3 text-xs font-semibold text-center" style={{ ...headCellStyle, width: "7.5%" }}>Current actions left</th>
                    <th className="px-2 py-3 text-xs font-semibold text-center" style={{ ...headCellStyle, width: "7.5%" }}>Didn&apos;t complete</th>
                    <th className="px-2 py-3 text-xs font-semibold text-center" style={{ ...headCellStyle, width: "7.5%" }}>Pending validation</th>
                    <th className="px-2 py-3 text-xs font-semibold text-center" style={{ ...headCellStyle, width: "8.5%" }}>Commitment score</th>
                    <th
                      className="sm:sticky sm:right-0 z-20 px-2 py-3 text-xs font-semibold text-center"
                      style={{ ...headCellStyle, width: "8%", background: TABLE_HEAD_BG, boxShadow: FROZEN_RIGHT_COLUMN_EDGE }}
                    >
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {leaderboard.map((user, index) => (
                    <tr key={user.id} style={{ borderBottom: "1px solid var(--color-border)" }}>
                      <td className="sticky left-0 z-[5] bg-white px-5 py-2.5" style={{ boxShadow: FROZEN_COLUMN_EDGE }}>
                        <div className="flex items-center gap-3 min-w-0">
                          <span className="text-xs font-medium w-6 flex-shrink-0" style={{ color: "var(--color-text-muted)" }}>#{index + 1}</span>
                          <div className="min-w-0">
                            <span className="text-xs font-semibold truncate block" style={{ color: "var(--color-text-primary)" }}>{user.name}</span>
                            <span className="text-xs truncate block" style={{ color: "var(--color-text-muted)" }} title={user.email ?? undefined}>
                              {user.email ?? "—"}
                            </span>
                          </div>
                        </div>
                      </td>
                      <td className="px-2 py-2.5">
                        <span className="text-xs font-medium truncate block" style={{ color: "var(--color-text-secondary)" }}>
                          {user.buddyName ?? "—"}
                        </span>
                      </td>
                      <td className="px-2 py-2.5 text-center font-semibold" style={countCellStyle(user.actionsReadCount)}>{user.actionsReadCount}</td>
                      <td className="px-2 py-2.5 text-center font-semibold" style={countCellStyle(user.plannedActions)}>{user.plannedActions}</td>
                      <td className="px-2 py-2.5 text-center font-semibold" style={countCellStyle(user.actionsSentCount)}>{user.actionsSentCount}</td>
                      <td className="px-2 py-2.5 text-center">
                        <span
                          className={`tag ${user.validatedCount > 0 ? "tag--teal" : ""}`}
                          style={
                            user.validatedCount === 0
                              ? { background: "var(--color-tag-red-bg, rgba(237, 69, 81, 0.12))", color: "var(--color-tag-red-text, #8C1C24)" }
                              : undefined
                          }
                        >
                          {user.validatedCount}
                        </span>
                      </td>
                      <td className="px-2 py-2.5 text-center font-semibold" style={countCellStyle(user.currentCount)}>{user.currentCount}</td>
                      <td className="px-2 py-2.5 text-center font-semibold" style={countCellStyle(user.notCompletedCount)}>{user.notCompletedCount}</td>
                      <td className="px-2 py-2.5 text-center font-semibold" style={countCellStyle(user.pendingValidationCount)}>{user.pendingValidationCount}</td>
                      <td className="px-2 py-2.5 text-center">
                        <span className="text-xs font-bold" style={{ color: "var(--color-text-primary)" }}>
                          {user.commitmentMaximum > 0 ? `${user.commitmentPct}%` : "No plan"}
                        </span>
                      </td>
                      <td className="sm:sticky sm:right-0 z-[5] bg-white px-2 py-2.5 text-center" style={{ boxShadow: FROZEN_RIGHT_COLUMN_EDGE }}>
                        <button
                          type="button"
                          onClick={() => setViewingParticipant(user)}
                          aria-label={`View more about ${user.name}`}
                          className="rounded-lg px-2.5 py-1 text-xs font-semibold whitespace-nowrap hover:bg-violet-50"
                          style={{ color: CHART_PRIMARY, border: "1px solid #CFC5F7" }}
                        >
                          View more
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </DashboardCard>

        {viewingParticipant && (
          <ParticipantActionsModal
            userId={viewingParticipant.id}
            name={viewingParticipant.name}
            email={viewingParticipant.email}
            companyId={companyId}
            cohortId={selectedCohortId}
            onClose={closeParticipantModal}
          />
        )}

        {/* Batch Commitment Score (weekly trend + WoW delta, left) + Email Engagement (weekly table, right) */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <DashboardCard
            title="Batch Commitment Score"
            aside={
              weeklyTrendDelta !== null ? (
                <span
                  className="flex items-center gap-1 text-xs font-semibold"
                  style={{ color: weeklyTrendDelta >= 0 ? "#15803D" : "#DC2626" }}
                >
                  {weeklyTrendDelta >= 0 ? <ArrowUp size={13} /> : <ArrowDown size={13} />}
                  {Math.abs(weeklyTrendDelta)} pts vs. last week
                </span>
              ) : undefined
            }
          >
            <div className="px-3 pb-3" style={{ height: 300 }}>
              {weeklyTrendLoading ? (
                emptyState("Loading…")
              ) : weeklyTrend.length === 0 ? (
                emptyState("No finalised plans yet")
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <ReBarChart data={weeklyTrendChartData} barSize={14} margin={{ top: 20, right: 8, left: 0, bottom: 0 }}>
                    <CartesianGrid vertical={false} stroke="var(--color-border)" />
                    <XAxis dataKey="name" interval="preserveStartEnd" tick={axisTick} tickLine={false} axisLine={{ stroke: "var(--color-border)" }} />
                    <YAxis domain={[0, 100]} ticks={[0, 50, 100]} tick={axisTick} tickLine={false} axisLine={false} width={36} />
                    <Tooltip
                      contentStyle={tooltipStyle}
                      cursor={chartCursor}
                      labelFormatter={weekChartLabelFormatter(weeklyTrendChartData)}
                      formatter={(value, name) => [`${value}%`, name]}
                    />
                    <Bar dataKey="Avg. commitment %" fill={CHART_PRIMARY} radius={[3, 3, 0, 0]}>
                      <LabelList
                        dataKey="Avg. commitment %"
                        position="top"
                        offset={4}
                        style={barValueLabel}
                        formatter={(value) => `${value}%`}
                      />
                    </Bar>
                  </ReBarChart>
                </ResponsiveContainer>
              )}
            </div>
          </DashboardCard>

          <DashboardCard
            title="Email Engagement"
            aside={
              <span className="text-xs font-medium" style={{ color: "var(--color-tag-primary-text)" }}>
                Either · Reminder · Friday Weekly Recap
              </span>
            }
          >
            <div className="overflow-auto" style={{ height: 300 }}>
              {emailLoading ? (
                emptyState("Loading…")
              ) : emailWeekly.length === 0 ? (
                emptyState("No week-attributed sends yet")
              ) : (
                <table className="w-full text-left border-collapse min-w-[460px] text-xs">
                  <thead className="sticky top-0 z-10" style={{ background: TABLE_HEAD_BG }}>
                    <tr>
                      <th className="px-5 py-2.5 text-xs font-semibold" style={headCellStyle}>Week</th>
                      <th className="px-2 py-2.5 text-xs font-semibold text-right" style={headCellStyle}>Reminder sent</th>
                      <th className="px-2 py-2.5 text-xs font-semibold text-right" style={headCellStyle}>Reminder opened</th>
                      <th className="px-2 py-2.5 text-xs font-semibold text-right" style={headCellStyle}>Recap sent</th>
                      <th className="px-2 py-2.5 text-xs font-semibold text-right" style={headCellStyle}>Recap opened</th>
                      <th className="pl-2 pr-5 py-2.5 text-xs font-semibold text-right" style={headCellStyle}>Either opened</th>
                    </tr>
                  </thead>
                  <tbody>
                    {emailWeekly.map((week) => (
                      <tr
                        key={week.weekNumber}
                        title={weekChartRange(week.weekStartIst, week.weekEndIst)}
                        style={{ borderBottom: "1px solid var(--color-border)", color: "var(--color-text-secondary)" }}
                      >
                        <td className="px-5 py-3 font-semibold whitespace-nowrap" style={{ color: "var(--color-text-primary)" }}>Week {week.weekNumber}</td>
                        <td className="px-2 py-3 text-right font-medium">{week.reminderSent}</td>
                        <td className="px-2 py-3 text-right font-medium">{week.reminderOpenedUsers}</td>
                        <td className="px-2 py-3 text-right font-medium">{week.recapSent}</td>
                        <td className="px-2 py-3 text-right font-medium">{week.recapOpenedUsers}</td>
                        <td className="pl-2 pr-5 py-3 text-right font-bold" style={{ color: "var(--color-text-primary)" }}>{week.eitherMailOpenedUsers}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </DashboardCard>
        </div>
      </div>
    </div>
  );
}
