
export type ActionTheme = 'Collaboration' | 'Feedback' | 'Accountability' | 'Connection' | 'Coaching';

export interface ActionCard {
  id: string;
  cohortId?: string | null;
  /** Zero-based sequence chosen during draft-plan review. */
  planOrder?: number | null;
  theme: ActionTheme;
  title: string;
  how: string;
  why: string;
  timeEstimate: string;
  /** True for AI-generated personal actions (visible only to their creator). */
  isPersonal?: boolean;
  /** Whole-number share of the cohort plan's 1,000-point starting balance. */
  planPoints?: number;
  /** Public URL of the closest-matching action-image library illustration, or null/undefined if none was matched. */
  imageUrl?: string | null;
  /** One of the batch's action categories (Cohort.actionCategories), or null when uncategorised. */
  category?: string | null;
}

export interface UserAction {
  id: string;
  actionId: string;
  cohortId?: string | null;
  status: 'scheduled' | 'success' | 'failed' | 'skipped';
  scheduledDate?: string;
  scheduledTime?: string;
  scheduledAt?: string; // ISO string for validation queue filter
  /** When user committed (with or without schedule). Used for "Accepted on xyz" in validation queue. */
  acceptedAt?: string;
  acceptedDate?: string;
  acceptedTime?: string;
  completedAt?: string;
  completedLate?: boolean;
  missedAt?: string;
  /** True only while this failure is an unresolved auto-retire (next batch arrived before check-in) — routes to "Pending validation" instead of "Didn't complete". */
  autoExpired?: boolean;
  isCalendarSynced?: boolean;
  reflection?: string;
  pointsDelta?: number;
  pointsSettledAt?: string;
}

export interface FeedItem {
  id: string;
  cohortId?: string | null;
  userId: string;
  userName: string;
  actionTitle: string;
  type: 'READ' | 'ACCEPTED' | 'SCHEDULED' | 'DECLINED' | 'SUCCESS';
  timestamp: number;
  likes: number;
}

export interface UserProfile {
  name: string;
  /** League index (0–4) derived from profiles.league_index for DB-backed store; legacy clients may treat this as an importance slider. */
  importanceRating: number;
  weeklyGoal: number;
  totalPoints: number;
  onboarded: boolean;
  streak: number;
}

/** DB profile row (profiles table): multi-tenant company_id and role */
export interface DbProfile {
  id: string;
  full_name: string | null;
  avatar_url: string | null;
  company_id: string | null;
  role: "user" | "admin" | "superadmin";
  /** For user roles, league index: 0=Starter,1=Bronze,2=Silver,3=Gold,4=Diamond. */
  league_index: number;
  weekly_goal: number;
  total_points: number;
  streak: number;
  last_active_at: string | null;
  created_at: string;
}

export enum League {
  Starter = 'Starter',
  Bronze = 'Bronze',
  Silver = 'Silver',
  Gold = 'Gold',
  Diamond = 'Diamond'
}

/** A trainer's display profile (name + photo). No login of their own — company
 * admins and superadmins read what participants send them. */
export interface Trainer {
  id: string;
  name: string;
  imageUrl?: string | null;
}

/** A superadmin-managed label assignable to a participant's cohort membership. */
export interface ParticipantTag {
  id: string;
  name: string;
}

/** A group of users within a company sharing Prepare content and an action plan. */
export interface Cohort {
  id: string;
  /** Derived legacy composite of batchName and moduleName ("batch — module", or just "batch"). */
  name: string;
  /** Required first part of the cohort's two-part name, e.g. the batch/group name. */
  batchName: string;
  /** Optional second part of the cohort's two-part name, e.g. the training module. */
  moduleName?: string | null;
  description?: string | null;
  trainingContent?: string | null;
  businessContext?: string | null;
  /** Every date attached to this cohort (session days, milestones, etc.), sorted ascending as ISO "YYYY-MM-DD" strings. */
  dates: string[];
  memberCount: number;
  logoUrl?: string | null;
  companyName?: string | null;
  companyLogoUrl?: string | null;
  /** This batch's seeded program agenda, if any. Empty/undefined means the
   * generic Journey workspace shows no agenda section. */
  programPhases?: ProgramPhase[];
  /** The id (ProgramPhase.id) of the phase this batch is currently in — the
   * Journey/Home page defaults to this phase when no ?phase= is in the URL.
   * Null/undefined falls back to the first phase. */
  currentPhaseId?: string | null;
  trainerId?: string | null;
  trainer?: Trainer | null;
  /** Optional override for the email "From" display name on this batch's
   * communications. Falls back to the assigned trainer's name, then
   * "Nudgeable", when unset — see lib/email-send.ts. */
  senderName?: string | null;
  /** When true, participants lose access to My Plan, action creation, and the
   * Commitment Wallet until a superadmin unlocks the cohort. Defaults to true
   * for new cohorts (see migration 061_cohort_lock.sql). */
  locked: boolean;
  /** Optional admin-set cap (in weeks) on how long a participant's action
   * plan for this batch may run. Null/undefined falls back to the global
   * 2-24 week range enforced in app/actions/ai-actions.ts. */
  maxWeeks?: number | null;
  /** Superadmin-set subject overrides for this batch's recurring emails
   * (lib/batch-email-subjects.ts). Missing keys use the default subject. */
  emailSubjects?: Partial<Record<"daily_reminder" | "weekly_recap", string>>;
  /** Superadmin-set categories (max 5) the AI assigns to this batch's
   * generated actions and participants pick from when editing one. Empty
   * means actions are not categorised (lib/action-categories.ts). */
  actionCategories?: string[];
}

/** One row backing Cohort.dates, with the id needed to remove it individually
 * from the cohort management "manage dates" list. */
export interface CohortDate {
  id: string;
  date: string;
}

/** A dated notice the trainer (or an admin standing in) posts to a cohort's
 * notice board — replaces the old participant -> trainer TrainerExpectation. */
export interface CohortNotice {
  id: string;
  cohortId: string;
  message: string;
  createdAt: string;
  authorName: string;
  /** The posting trainer's roster photo, if the author is logged in as the
   * cohort's trainer (null for an admin/superadmin standing in). */
  authorImageUrl?: string | null;
}

/** A cohort-specific facilitator: name, designation, and an optional PDF
 * participants can view. Not a reusable roster like Trainer — entered per cohort. */
export interface Facilitator {
  id: string;
  cohortId: string;
  name: string;
  designation: string;
  pdfUrl?: string | null;
  pdfName?: string | null;
}

export interface CompanyBrand {
  id: string;
  name: string;
  logoUrl: string | null;
}

/** One timed segment within a program day, e.g. "9.30–11.00 · Workshop title". */
export interface ProgramBlock {
  time: string;
  name: string;
  description: string;
}

/** One day within a program phase, made up of session blocks. */
export interface ProgramDay {
  name: string;
  date: string;
  takeaway: string;
  blocks: ProgramBlock[];
}

/** One phase of a batch's seeded program agenda (cohorts.program_phases).
 * Set by an admin/superadmin per batch (cohort), and rendered on the generic
 * Journey workspace's agenda section — Surge's own SURGE curriculum is just
 * seeded data in this same shape (see migration 070_cohort_program_phases.sql). */
export interface ProgramPhase {
  id: string;
  label: string;
  window: string;
  title: string;
  subtitle?: string;
  focus: string;
  summary: string;
  days: ProgramDay[];
}

/** A cohort available in the participant-wide cohort switcher. */
export interface CohortOption extends Cohort {
  companyId: string;
  archivedAt?: string | null;
  isCurrent: boolean;
  isSelected: boolean;
}

export interface CohortMember {
  id: string;
  fullName: string | null;
  email: string | null;
  /** The tag assigned to this participant for this specific cohort membership, if any. */
  tag?: ParticipantTag | null;
}

export interface CohortMessage {
  id: string;
  cohortId: string;
  senderId: string;
  senderName: string;
  senderRole: 'participant' | 'trainer';
  message: string;
  createdAt: string;
}

export interface JourneyData {
  error?: string;
  cohort: Cohort | null;
  roster: CohortMember[];
  items: PrepareContentItem[];
  progress: UserPrepareProgress[];
  notices: CohortNotice[];
  facilitators: Facilitator[];
}

export type PrepareContentType = 'video' | 'quiz' | 'preread';

export interface QuizOption {
  id: string;
  optionText: string;
  /** Only ever populated server-side for the authoring UI; never sent to a regular user's browser. */
  isCorrect?: boolean;
}

export interface QuizQuestion {
  id: string;
  questionText: string;
  options: QuizOption[];
}

export interface PrepareContentItem {
  id: string;
  type: PrepareContentType;
  title: string;
  description: string | null;
  /** Short eyebrow pill shown above the title (e.g. "CEO WELCOME"). Falls back to a type-based default when unset. */
  badgeLabel?: string | null;
  isActive: boolean;
  videoUrl?: string | null;
  videoDurationSeconds?: number | null;
  prereadUrl?: string | null;
  prereadBody?: string | null;
  questions?: QuizQuestion[];
  /** Number of questions in a quiz item, populated by listCohortContent for the Prepare page. */
  questionCount?: number;
}

export interface UserPrepareProgress {
  contentItemId: string;
  status: 'not_started' | 'in_progress' | 'completed';
  completedAt?: string | null;
  /** Only present for quiz items with at least one attempt. */
  lastScore?: number | null;
  lastTotalQuestions?: number | null;
}
