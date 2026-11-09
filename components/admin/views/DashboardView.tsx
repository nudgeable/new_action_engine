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
  PieChart,
  Pie,
} from "recharts";
import { ArrowDown, ArrowUp, CalendarRange, CircleCheck, ListChecks, Target, TrendingUp } from "lucide-react";
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
  getProgramProgress,
  type ProgramProgress,
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
// Activity groups: inactive reads as baseline gray, then purple deepens with activity.
const ACTIVITY_COLORS = { inactive: CHART_BASELINE, somewhat: "#B49EF3", highly: CHART_PRIMARY };
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

/** User count drawn in the middle of each donut slice; skipped for empty or very thin slices. */
function renderActivitySliceLabel(props: {
  cx?: number;
  cy?: number;
  midAngle?: number;
  innerRadius?: number;
  outerRadius?: number;
  percent?: number;
  value?: number;
  payload?: { key?: string };
}) {
  const { cx = 0, cy = 0, midAngle = 0, innerRadius = 0, outerRadius = 0, percent = 0, value = 0, payload } = props;
  if (!value || percent < 0.04) return null;
  const radius = innerRadius + (outerRadius - innerRadius) / 2;
  const angle = (-midAngle * Math.PI) / 180;
  // Light slices (inactive gray, light purple) need dark text; the deep purple slice takes white.
  const fill = payload?.key === "highly" ? "#FFFFFF" : "#1F1B2E";
  return (
    <text
      x={cx + radius * Math.cos(angle)}
      y={cy + radius * Math.sin(angle)}
      fill={fill}
      textAnchor="middle"
      dominantBaseline="central"
      style={{ fontSize: 12, fontWeight: 700 }}
    >
      {value}
    </text>
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
  const [programProgress, setProgramProgress] = useState<ProgramProgress | null>(null);
  const [programProgressLoading, setProgramProgressLoading] = useState(true);

  // All sections fetch independently; rather than letting each one pop
  // in on its own timeline, report readiness up to BatchPickerGate once every
  // section has settled at least once for this company/cohort, so its
  // loading screen — not an assumption that picking a batch means the data
  // is there — is what decides when the dashboard actually shows.
  const dashboardReady = !actionWeeklyLoading && !scoreBucketsLoading && !leaderboardLoading && !weeklyTrendLoading && !emailLoading && !programProgressLoading && !batchOptionsLoading;

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

  useEffect(() => {
    if (!companyId) {
      setProgramProgress(null);
      return;
    }
    setProgramProgressLoading(true);
    getProgramProgress(companyId, selectedCohortId)
      .then(({ progress, error }) => setProgramProgress(!error ? progress : null))
      .finally(() => setProgramProgressLoading(false));
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

  // Participant activity split, from validated vs. sent actions per member:
  // inactive = nothing validated; highly active = more than half of sent actions
  // validated; partly active = everyone in between (above 0%, up to 50%).
  const activityChartData = (() => {
    let inactive = 0;
    let somewhat = 0;
    let highly = 0;
    for (const u of leaderboard) {
      if (u.validatedCount === 0) inactive++;
      else if (u.actionsSentCount > 0 && u.validatedCount / u.actionsSentCount > 0.5) highly++;
      else somewhat++;
    }
    return [
      { key: "inactive", name: "Inactive", hint: "0 actions validated", Users: inactive, color: ACTIVITY_COLORS.inactive },
      { key: "somewhat", name: "Partly active", hint: "Up to 50% validated", Users: somewhat, color: ACTIVITY_COLORS.somewhat },
      { key: "highly", name: "Highly active", hint: "Over 50% validated", Users: highly, color: ACTIVITY_COLORS.highly },
    ];
  })();
  const activityTotal = leaderboard.length;
  const highlyActiveCount = activityChartData.find((d) => d.key === "highly")?.Users ?? 0;

  const weeklyTrendChartData = weeklyTrend.map((e) => ({
    name: `Week ${e.weekNumber}`,
    weekRange: weekChartRange(e.weekStartIst, e.weekEndIst),
    "Avg. commitment %": e.avgCommitmentPct,
  }));

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
  // A rate cell: bold % with the underlying count on hover; "—" when nothing went out that week.
  const engagementRate = (rate: number, hits: number, sent: number, verb: string) =>
    sent === 0 ? (
      <span style={{ color: "var(--color-text-muted)" }}>—</span>
    ) : (
      <span className="font-bold" style={{ color: "var(--color-text-primary)" }} title={`${hits} of ${sent} ${verb}`}>
        {rate}%
      </span>
    );

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
            Leaderboard's "No plan" tag (commitmentMaximum > 0), so the two numbers agree. */}
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
            label="Total actions generated"
            value={leaderboardLoading ? "…" : leaderboard.reduce((sum, u) => sum + u.plannedActions, 0)}
            icon={ListChecks}
            tint="#FEF3C7"
            ink="#B45309"
          />
          <StatCard
            label="Total actions validated"
            value={leaderboardLoading ? "…" : leaderboard.reduce((sum, u) => sum + u.validatedCount, 0)}
            suffix={`of ${leaderboardLoading ? "…" : leaderboard.reduce((sum, u) => sum + u.actionsSentCount, 0)} sent`}
            icon={CircleCheck}
            tint="#DCFCE7"
            ink="#15803D"
          />
          <StatCard
            label="Validated over 50% of actions sent"
            value={leaderboardLoading ? "…" : highlyActiveCount}
            suffix={`of ${leaderboardLoading ? "…" : activityTotal} users`}
            icon={TrendingUp}
            tint="#EDE9FE"
            ink={CHART_PRIMARY}
          />
          <StatCard
            label={programProgress?.ended ? "Current week of program · completed" : "Current week of program"}
            value={programProgressLoading ? "…" : programProgress ? programProgress.currentWeek : "—"}
            suffix={
              programProgressLoading || !programProgress
                ? undefined
                : programProgress.maxWeeks
                  ? `of ${programProgress.maxWeeks} weeks`
                  : "no length set"
            }
            icon={CalendarRange}
            tint="#FFEDD5"
            ink="#C2410C"
          />
        </div>

        {/* Weekly Action Completion (due vs. completed, left) + Participant Activity (pie, right) */}
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
            title="Participant Activity"
            aside={
              <span className="text-xs font-medium" style={{ color: "var(--color-tag-primary-text)" }}>
                By share of sent actions validated
              </span>
            }
          >
            <div className="px-3 pb-3" style={{ height: 260 }}>
              {leaderboardLoading ? (
                emptyState("Loading…")
              ) : activityTotal === 0 ? (
                emptyState("No members in scope yet")
              ) : (
                <div className="h-full flex items-center gap-4">
                  <div className="relative h-full flex-1 min-w-0">
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Tooltip
                          contentStyle={tooltipStyle}
                          formatter={(value, name) => [`${value} users`, name]}
                        />
                        <Pie
                          data={activityChartData}
                          dataKey="Users"
                          nameKey="name"
                          innerRadius="58%"
                          outerRadius="88%"
                          paddingAngle={activityChartData.filter((d) => d.Users > 0).length > 1 ? 2 : 0}
                          stroke="none"
                          isAnimationActive={false}
                          labelLine={false}
                          label={renderActivitySliceLabel}
                        >
                          {activityChartData.map((entry) => (
                            <Cell key={entry.key} fill={entry.color} />
                          ))}
                        </Pie>
                      </PieChart>
                    </ResponsiveContainer>
                    <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                      <span className="text-2xl font-bold leading-none" style={{ color: "var(--color-text-primary)" }}>{activityTotal}</span>
                      <span className="text-xs font-medium mt-1" style={{ color: "var(--color-text-muted)" }}>members</span>
                    </div>
                  </div>
                  <ul className="flex flex-col gap-3 pr-3 flex-shrink-0">
                    {activityChartData.map((entry) => (
                      <li key={entry.key} className="flex items-start gap-2">
                        <span className="w-2.5 h-2.5 rounded-sm mt-1 flex-shrink-0" style={{ background: entry.color }} />
                        <span className="flex flex-col">
                          <span className="text-xs font-semibold" style={{ color: "var(--color-text-primary)" }}>
                            {entry.name} · {entry.Users}{" "}
                            <span className="font-medium" style={{ color: "var(--color-text-muted)" }}>
                              ({Math.round((entry.Users * 100) / activityTotal)}%)
                            </span>
                          </span>
                          <span className="text-xs" style={{ color: "var(--color-text-muted)" }}>{entry.hint}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
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

        {/* Batch Commitment Score (weekly trend + WoW delta, left) + Email & WhatsApp Engagement (weekly table, right) */}
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
            title="Email & WhatsApp Engagement"
            aside={
              <span className="text-xs font-medium" style={{ color: "var(--color-tag-primary-text)" }}>
                Email opened · WhatsApp read, per week
              </span>
            }
          >
            <div className="overflow-auto" style={{ height: 300 }}>
              {emailLoading ? (
                emptyState("Loading…")
              ) : emailWeekly.length === 0 ? (
                emptyState("No week-attributed sends yet")
              ) : (
                <table className="w-full text-left border-collapse min-w-[320px] text-xs">
                  <thead className="sticky top-0 z-10" style={{ background: TABLE_HEAD_BG }}>
                    <tr>
                      <th className="px-5 py-2.5 text-xs font-semibold" style={headCellStyle}>Week</th>
                      <th className="px-2 py-2.5 text-xs font-semibold text-right" style={headCellStyle}>Email open %</th>
                      <th className="pl-2 pr-5 py-2.5 text-xs font-semibold text-right" style={headCellStyle}>WhatsApp read %</th>
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
                        <td className="px-2 py-3 text-right">
                          {engagementRate(week.emailOpenRate, week.emailOpened, week.emailSent, "opened")}
                        </td>
                        <td className="pl-2 pr-5 py-3 text-right">
                          {engagementRate(week.whatsappReadRate, week.whatsappRead, week.whatsappSent, "read")}
                        </td>
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
