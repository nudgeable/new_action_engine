"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Building2,
  CalendarDays,
  Check,
  ChevronRight,
  FileSpreadsheet,
  FileText,
  Handshake,
  Info,
  ImagePlus,
  Loader2,
  Lock,
  LockOpen,
  Megaphone,
  MessageSquareText,
  NotebookPen,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Trash2,
  UserPlus,
  UserRound,
  Users,
  X,
} from "lucide-react";
import {
  addCohortDate,
  addMembersToCohort,
  createCohort,
  deleteCohort,
  getCohortDetail,
  getCompanyUsers,
  listCohortDates,
  removeCohortDate,
  removeMembersFromCohort,
  setCohortLock,
  updateCohort,
} from "@/app/actions/cohorts";
import {
  listCommitmentBuddyRoster,
  removeCommitmentBuddyAssignment,
  saveCommitmentBuddyCircle,
  type BuddyMappingMember,
} from "@/app/actions/commitment-buddies-admin";
import { nextUpcomingCohortDate } from "@/lib/cohort-dates";
import {
  BATCH_EMAIL_SUBJECT_KEYS,
  BATCH_EMAIL_SUBJECT_MAX,
  BATCH_EMAIL_SUBJECT_OPTIONS,
  BATCH_EMAIL_SUBJECT_VARIABLES,
  type BatchEmailSubjectKey,
  type BatchEmailSubjects,
} from "@/lib/batch-email-subjects";
import { ACTION_CATEGORY_MAX_LENGTH, MAX_ACTION_CATEGORIES } from "@/lib/action-categories";
import { uploadCohortLogo } from "@/lib/cohort-logo-upload";
import {
  assignContentToCohort,
  listCohortContent,
  removeContentFromCohort,
} from "@/app/actions/prepare-content";
import { getCohortNotices, postCohortNotice, deleteCohortNotice } from "@/app/actions/cohort-notices";
import { fetchAdminJson, isAbortError } from "@/lib/admin-fetch";
import { createFacilitator, deleteFacilitator, listFacilitators } from "@/app/actions/facilitators";
import { assignMemberTag, createParticipantTag, getCohortTeamNameOverrides, setCohortTeamName } from "@/app/actions/participant-tags";
import { FacilitatorPdfUploadField } from "@/components/admin/content/FacilitatorPdfUploadField";
import { useSelectedAdminBatch } from "@/components/admin/AdminContext";
import type { CohortDate, CohortMember, CohortNotice, CompanyBrand, Facilitator, ParticipantTag, PrepareContentItem, ProgramPhase, Trainer } from "@/lib/types";
import { exportCohortMembersExcel } from "@/lib/export-cohort-members";

interface CohortManagementViewProps {
  companyId: string | null;
  role: string;
}

type CohortSummary = {
  id: string;
  name: string;
  batchName: string;
  moduleName?: string | null;
  description?: string | null;
  trainingContent?: string | null;
  businessContext?: string | null;
  dates: string[];
  memberCount: number;
  contentCount: number;
  logoUrl?: string | null;
  trainerId?: string | null;
  trainer?: Trainer | null;
  senderName?: string | null;
  locked: boolean;
  programPhases?: ProgramPhase[];
  currentPhaseId?: string | null;
  maxWeeks?: number | null;
  emailSubjects?: BatchEmailSubjects;
  actionCategories?: string[];
};

type CompanyUser = { id: string; full_name: string | null; email: string | null };

function formatStartDate(date: string | null | undefined) {
  if (!date) return "No dates set";
  return new Intl.DateTimeFormat("en", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(`${date}T00:00:00`));
}

function initials(value: string | null | undefined) {
  const words = (value || "Unnamed user").trim().split(/\s+/).slice(0, 2);
  return words.map((word) => word[0]?.toUpperCase()).join("") || "U";
}

/** The distinct teams currently in use within one batch, derived from its own
 * roster rather than every team used anywhere in the company. Merges into
 * `previous` (instead of replacing it) so a team just created this session —
 * which has no member wearing it yet, and so can never come back from the
 * roster — isn't dropped from the list before it's had a chance to be assigned. */
function mergeTagsFromMembers(members: CohortMember[], previous: ParticipantTag[]): ParticipantTag[] {
  const byId = new Map(previous.map((tag) => [tag.id, tag]));
  for (const member of members) {
    if (member.tag) byId.set(member.tag.id, member.tag);
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Preview text for a buddy selection in click order, e.g. ["Riya", "Aman"]
 * -> "Riya → Aman → Riya" (mutual pair) and ["Riya", "Aman", "Priya"] ->
 * "Riya → Aman → Priya → Riya" (cycle) — the loop always closes back to the
 * first person, matching what saveCommitmentBuddyCircle will create. */
function buddyCirclePreview(firstNames: string[]): string {
  if (firstNames.length === 0) return "";
  return [...firstNames, firstNames[0]].join(" → ");
}

function CohortListSkeleton() {
  return (
    <div className="cohort-admin-list" aria-label="Loading batches" aria-busy="true">
      {[0, 1, 2].map((item) => (
        <div key={item} className="cohort-admin-row cohort-admin-row--skeleton">
          <span className="cohort-admin-skeleton cohort-admin-skeleton--avatar" />
          <span className="cohort-admin-skeleton-copy">
            <span className="cohort-admin-skeleton cohort-admin-skeleton--title" />
            <span className="cohort-admin-skeleton cohort-admin-skeleton--text" />
          </span>
        </div>
      ))}
    </div>
  );
}

export function CohortManagementView({ companyId, role }: CohortManagementViewProps) {
  const [cohorts, setCohorts] = useState<CohortSummary[]>([]);
  const [company, setCompany] = useState<CompanyBrand | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [creatingBusy, setCreatingBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [batchName, setBatchName] = useState("");
  const [moduleName, setModuleName] = useState("");
  const [description, setDescription] = useState("");
  const [trainingContent, setTrainingContent] = useState("");
  const [businessContext, setBusinessContext] = useState("");
  const [initialDates, setInitialDates] = useState<string[]>([]);
  const [pendingDateValue, setPendingDateValue] = useState("");

  const duplicateCohort = useMemo(() => {
    const bn = batchName.trim().toLowerCase();
    if (!bn) return false;
    const mn = moduleName.trim().toLowerCase();
    return cohorts.some(
      (existing) => existing.batchName.trim().toLowerCase() === bn && (existing.moduleName ?? "").trim().toLowerCase() === mn
    );
  }, [cohorts, batchName, moduleName]);

  function addPendingDate() {
    if (!pendingDateValue || initialDates.includes(pendingDateValue)) return;
    setInitialDates((current) => [...current, pendingDateValue].sort());
    setPendingDateValue("");
  }

  function removePendingDate(date: string) {
    setInitialDates((current) => current.filter((existing) => existing !== date));
  }

  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (!companyId) return;
    setLoading(true);
    setError(null);
    try {
      const result = await fetchAdminJson<{
        error?: string;
        company?: CompanyBrand | null;
        cohorts?: CohortSummary[];
      }>(`/api/admin/cohorts?companyId=${encodeURIComponent(companyId)}`, signal);
      if (result.error) {
        setError(result.error);
        return;
      }
      setCompany(result.company ?? null);
      setCohorts(result.cohorts ?? []);
    } catch (caughtError) {
      if (isAbortError(caughtError)) return;
      setError(caughtError instanceof Error ? caughtError.message : "Failed to load batches");
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [companyId]);

  useEffect(() => {
    const controller = new AbortController();
    setCohorts([]);
    setCompany(null);
    setCreating(false);
    setQuery("");
    void refresh(controller.signal);
    return () => controller.abort();
  }, [companyId, refresh]);

  const filteredCohorts = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return cohorts;
    return cohorts.filter((cohort) =>
      `${cohort.batchName} ${cohort.moduleName ?? ""} ${cohort.description ?? ""}`.toLowerCase().includes(needle)
    );
  }, [cohorts, query]);

  const { selectedCohortId, setSelectedCohortId, selectedCohort } = useSelectedAdminBatch(cohorts);

  const totals = useMemo(
    () => ({
      members: cohorts.reduce((sum, cohort) => sum + cohort.memberCount, 0),
      content: cohorts.reduce((sum, cohort) => sum + cohort.contentCount, 0),
    }),
    [cohorts]
  );

  function closeCreateDialog() {
    if (creatingBusy) return;
    setCreating(false);
    setBatchName("");
    setModuleName("");
    setDescription("");
    setTrainingContent("");
    setBusinessContext("");
    setInitialDates([]);
    setPendingDateValue("");
  }

  async function handleCreate(event: React.FormEvent) {
    event.preventDefault();
    if (!companyId || !batchName.trim() || creatingBusy) return;
    setCreatingBusy(true);
    setError(null);
    try {
      const result = await createCohort({
        batchName,
        moduleName: moduleName || undefined,
        description: description || undefined,
        trainingContent: role === "superadmin" ? trainingContent || undefined : undefined,
        businessContext: role === "superadmin" ? businessContext || undefined : undefined,
        initialDate: initialDates[0] || undefined,
        companyId,
      });
      if (result.error) {
        setError(result.error);
        return;
      }
      if (result.id && initialDates.length > 1) {
        // First date was already seeded by createCohort; add the rest.
        await Promise.all(initialDates.slice(1).map((date) => addCohortDate(result.id!, date)));
      }
      setBatchName("");
      setModuleName("");
      setDescription("");
      setTrainingContent("");
      setBusinessContext("");
      setInitialDates([]);
      setPendingDateValue("");
      setCreating(false);
      await refresh();
      if (result.id) setSelectedCohortId(result.id);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Failed to create batch");
    } finally {
      setCreatingBusy(false);
    }
  }

  if (!companyId) return null;

  return (
    <section className="cohort-admin-page">
      <header className="cohort-admin-header">
        <div>
          <div className="cohort-admin-company-heading">
            <span>{company?.logoUrl ? <img src={company.logoUrl} alt={`${company.name} logo`} /> : <Building2 size={24} />}</span>
            <div><h1>{company?.name || "Batch management"}</h1><strong>Batch management</strong></div>
          </div>
          <p>Organise participants, assign preparation content, and keep every learning group ready.</p>
        </div>
        <div className="cohort-admin-header-actions">
          <button
            type="button"
            onClick={() => void refresh()}
            className="cohort-admin-button cohort-admin-button--secondary"
            disabled={loading}
          >
            <RefreshCw size={16} className={loading ? "cohort-admin-spin" : undefined} />
            Refresh
          </button>
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="cohort-admin-button cohort-admin-button--primary"
          >
            <Plus size={17} /> New batch
          </button>
        </div>
      </header>

      <div className="cohort-admin-stats" aria-label="Batch overview">
        <div className="cohort-admin-stat">
          <span className="cohort-admin-stat-icon"><Users size={18} /></span>
          <div><strong>{cohorts.length}</strong><span>Active batches</span></div>
        </div>
        <div className="cohort-admin-stat">
          <span className="cohort-admin-stat-icon"><UserPlus size={18} /></span>
          <div><strong>{totals.members}</strong><span>Batch seats</span></div>
        </div>
        <div className="cohort-admin-stat">
          <span className="cohort-admin-stat-icon"><BookOpen size={18} /></span>
          <div><strong>{totals.content}</strong><span>Content assignments</span></div>
        </div>
      </div>

      {error && (
        <div className="cohort-admin-alert cohort-admin-alert--error" role="alert">
          <AlertCircle size={18} />
          <div><strong>Something went wrong</strong><span>{error}</span></div>
          <button type="button" onClick={() => void refresh()}>Try again</button>
        </div>
      )}

      <div className="cohort-admin-layout">
        <aside className="cohort-admin-directory">
          <div className="cohort-admin-directory-head">
            <div><h2>Batches</h2><span>{cohorts.length} active</span></div>
            <label className="cohort-admin-search">
              <Search size={16} />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search batches"
                aria-label="Search batches"
              />
              {query && <button type="button" onClick={() => setQuery("")} aria-label="Clear search"><X size={14} /></button>}
            </label>
          </div>

          {loading && cohorts.length === 0 ? (
            <CohortListSkeleton />
          ) : cohorts.length === 0 ? (
            <div className="cohort-admin-empty">
              <span><Users size={23} /></span>
              <h3>Create your first batch</h3>
              <p>Set up a learning group, then add participants and content.</p>
              <button type="button" onClick={() => setCreating(true)}>Create batch <ArrowRight size={15} /></button>
            </div>
          ) : filteredCohorts.length === 0 ? (
            <div className="cohort-admin-empty cohort-admin-empty--compact">
              <h3>No matching batches</h3>
              <p>Try a different name or description.</p>
              <button type="button" onClick={() => setQuery("")}>Clear search</button>
            </div>
          ) : (
            <div className="cohort-admin-list">
              {filteredCohorts.map((cohort) => {
                const selected = selectedCohortId === cohort.id;
                return (
                  <button
                    type="button"
                    key={cohort.id}
                    className={`cohort-admin-row${selected ? " cohort-admin-row--selected" : ""}`}
                    onClick={() => setSelectedCohortId(cohort.id)}
                    aria-current={selected ? "true" : undefined}
                  >
                    <span className="cohort-admin-cohort-mark">{cohort.logoUrl ? <img src={cohort.logoUrl} alt="" /> : initials(cohort.batchName)}</span>
                    <span className="cohort-admin-row-copy">
                      <span className="cohort-admin-row-name-line">
                        <strong>{cohort.batchName}</strong>
                        {cohort.locked && (
                          <span className="cohort-admin-lock-chip" title="Locked — participants can't access their plan, actions, or wallet">
                            <Lock size={10} /> Locked
                          </span>
                        )}
                      </span>
                      {cohort.moduleName && <span className="cohort-admin-row-module">{cohort.moduleName}</span>}
                      <span>{cohort.description || formatStartDate(nextUpcomingCohortDate(cohort.dates))}</span>
                      <span className="cohort-admin-row-meta">
                        <span><Users size={12} /> {cohort.memberCount}</span>
                        <span><BookOpen size={12} /> {cohort.contentCount}</span>
                      </span>
                    </span>
                    <ChevronRight size={17} className="cohort-admin-row-chevron" />
                  </button>
                );
              })}
            </div>
          )}
        </aside>

        <main className="cohort-admin-workspace">
          {selectedCohort ? (
            <CohortDetailPanel
              key={`${companyId}:${selectedCohort.id}`}
              companyId={companyId}
              cohort={selectedCohort}
              role={role}
              onChange={refresh}
            />
          ) : (
            <div className="cohort-admin-placeholder">
              <span><Users size={25} /></span>
              <h2>Select a batch</h2>
              <p>Choose a batch to manage its participants and learning content.</p>
            </div>
          )}
        </main>
      </div>

      {creating && (
        <div className="cohort-admin-modal-backdrop" role="presentation" onMouseDown={closeCreateDialog}>
          <div className="cohort-admin-modal" role="dialog" aria-modal="true" aria-labelledby="new-cohort-title" onMouseDown={(event) => event.stopPropagation()}>
            <div className="cohort-admin-modal-head">
              <div>
                <p className="cohort-admin-eyebrow">New learning group</p>
                <h2 id="new-cohort-title">Create a batch</h2>
                {role === "superadmin" && company && (
                  <p className="cohort-admin-modal-company">
                    <Building2 size={12} /> Creating for <strong>{company.name}</strong>
                  </p>
                )}
                <p className="cohort-admin-modal-company">
                  <Lock size={12} /> Starts locked — a superadmin unlocks it to open plan, actions, and wallet access.
                </p>
              </div>
              <button type="button" onClick={closeCreateDialog} disabled={creatingBusy} aria-label="Close"><X size={18} /></button>
            </div>
            <form id="new-cohort-form" className="cohort-admin-modal-scroll" onSubmit={handleCreate}>
              <p className="cohort-admin-form-section">Identity</p>
              <label className="cohort-admin-field">
                <span>Batch name <em>Required</em></span>
                <input autoFocus value={batchName} onChange={(event) => setBatchName(event.target.value)} placeholder="e.g. January 2026 Leadership Batch" required />
              </label>
              <label className="cohort-admin-field">
                <span>Module name <em>Optional</em></span>
                <input value={moduleName} onChange={(event) => setModuleName(event.target.value)} placeholder="e.g. Communication skills" />
              </label>
              {batchName.trim() && (
                <p className="cohort-admin-name-preview">
                  Shown as <strong>{batchName.trim()}{moduleName.trim() ? ` — ${moduleName.trim()}` : ""}</strong>
                </p>
              )}
              {duplicateCohort && (
                <div className="cohort-admin-inline-warning">
                  <AlertCircle size={14} /> A batch with this exact name and module already exists.
                </div>
              )}
              <label className="cohort-admin-field">
                <span>Description <em>Optional</em></span>
                <textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder="What is this batch working towards?" rows={3} />
              </label>

              {role === "superadmin" && (
                <>
                  <p className="cohort-admin-form-section">Action generation context</p>
                  <div className="cohort-admin-notice">
                    <Info size={15} />
                    <p><strong>Used for every participant in this batch</strong><span>Training content defines the skill. Business context keeps each action realistic for the company and its work.</span></p>
                  </div>
                  <label className="cohort-admin-field">
                    <span>Training content <em>Optional</em></span>
                    <textarea value={trainingContent} onChange={(event) => setTrainingContent(event.target.value)} placeholder="Session topics, agenda, skills, and learning outcomes" rows={4} />
                  </label>
                  <label className="cohort-admin-field">
                    <span>Business context <em>Optional</em></span>
                    <textarea value={businessContext} onChange={(event) => setBusinessContext(event.target.value)} placeholder="Company, industry, operating environment, and realistic work situations" rows={4} />
                  </label>
                </>
              )}

              <p className="cohort-admin-form-section">Schedule</p>
              <div className="cohort-admin-field">
                <span>Dates <em>Optional</em></span>
              </div>
              <div className="cohort-admin-dates-chips">
                {initialDates.length === 0 && <span className="cohort-admin-dates-empty">No dates set</span>}
                {initialDates.map((date) => (
                  <span className="cohort-admin-date-chip" key={date}>
                    {formatStartDate(date)}
                    <button type="button" onClick={() => removePendingDate(date)} aria-label={`Remove date ${formatStartDate(date)}`}>
                      <X size={11} />
                    </button>
                  </span>
                ))}
              </div>
              <div className="cohort-admin-date-add">
                <input type="date" value={pendingDateValue} onChange={(event) => setPendingDateValue(event.target.value)} aria-label="Add a date" />
                <button type="button" onClick={addPendingDate} disabled={!pendingDateValue} className="cohort-admin-button cohort-admin-button--secondary">
                  <Plus size={14} /> Add date
                </button>
              </div>

              <div className="cohort-admin-modal-note"><Info size={16} /><span>You can add more dates, participants, and learning content immediately after creation.</span></div>
            </form>
            <div className="cohort-admin-modal-actions">
              <button type="button" onClick={closeCreateDialog} disabled={creatingBusy} className="cohort-admin-button cohort-admin-button--secondary">Cancel</button>
              <button type="submit" form="new-cohort-form" disabled={creatingBusy || !batchName.trim()} className="cohort-admin-button cohort-admin-button--primary">
                {creatingBusy ? <Loader2 size={16} className="cohort-admin-spin" /> : <Plus size={16} />}
                {creatingBusy ? "Creating…" : "Create batch"}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function CohortDetailPanel({
  companyId,
  cohort,
  role,
  onChange,
}: {
  companyId: string;
  cohort: CohortSummary;
  role: string;
  onChange: () => Promise<void> | void;
}) {
  const [tab, setTab] = useState<"members" | "content" | "trainer" | "buddies" | "settings" | "agenda" | "generation">("members");
  const [editingNames, setEditingNames] = useState(false);
  const [editBatchName, setEditBatchName] = useState(cohort.batchName);
  const [editModuleName, setEditModuleName] = useState(cohort.moduleName ?? "");
  const [companyUsers, setCompanyUsers] = useState<CompanyUser[]>([]);
  const [members, setMembers] = useState<CohortMember[]>([]);
  const [memberIds, setMemberIds] = useState<Set<string>>(new Set());
  // Teams (participant_tags) actually used within THIS batch — derived from
  // its own members' assigned tags, not every team used anywhere in the
  // company, so a team only used in a different batch never shows up here.
  // A freshly created team is appended optimistically (see handleCreateTag)
  // so it can be assigned in this batch before anyone carries it yet.
  const [cohortTags, setCohortTags] = useState<ParticipantTag[]>([]);
  const [newTagName, setNewTagName] = useState("");
  const [creatingTag, setCreatingTag] = useState(false);
  // This batch's own display-name overrides for shared teams (see
  // cohort_team_names, migration 078) — keyed by tag_id, falling back to the
  // tag's global name for any team with no override.
  const [teamNameOverrides, setTeamNameOverrides] = useState<Record<string, string>>({});
  const [editingTeamId, setEditingTeamId] = useState<string | null>(null);
  const [editingTeamName, setEditingTeamName] = useState("");
  const [cohortDates, setCohortDates] = useState<CohortDate[]>([]);
  const [newDateValue, setNewDateValue] = useState("");
  const [libraryItems, setLibraryItems] = useState<PrepareContentItem[]>([]);
  const [assignedContentIds, setAssignedContentIds] = useState<Set<string>>(new Set());
  const [pendingAddIds, setPendingAddIds] = useState<Set<string>>(new Set());
  const [pendingContentIds, setPendingContentIds] = useState<Set<string>>(new Set());
  const [memberQuery, setMemberQuery] = useState("");
  const [currentMemberQuery, setCurrentMemberQuery] = useState("");
  const [contentQuery, setContentQuery] = useState("");
  const [trainingContent, setTrainingContent] = useState(cohort.trainingContent ?? "");
  const [businessContext, setBusinessContext] = useState(cohort.businessContext ?? "");
  const [programPhasesJson, setProgramPhasesJson] = useState(() => JSON.stringify(cohort.programPhases ?? [], null, 2));
  const [currentPhaseId, setCurrentPhaseId] = useState(cohort.currentPhaseId ?? "");
  const [trainerRoster, setTrainerRoster] = useState<Trainer[]>([]);
  const [selectedTrainerId, setSelectedTrainerId] = useState<string>(cohort.trainerId ?? "");
  const [senderName, setSenderName] = useState<string>(cohort.senderName ?? "");
  const [maxWeeks, setMaxWeeks] = useState<string>(cohort.maxWeeks != null ? String(cohort.maxWeeks) : "");
  const [emailSubjects, setEmailSubjects] = useState<BatchEmailSubjects>(cohort.emailSubjects ?? {});
  const [actionCategories, setActionCategories] = useState<string[]>(cohort.actionCategories ?? []);
  const [notices, setNotices] = useState<CohortNotice[]>([]);
  const [noticeDraft, setNoticeDraft] = useState("");
  const [facilitators, setFacilitators] = useState<Facilitator[]>([]);
  const [facilitatorName, setFacilitatorName] = useState("");
  const [facilitatorDesignation, setFacilitatorDesignation] = useState("");
  const [facilitatorPdfUrl, setFacilitatorPdfUrl] = useState("");
  const [facilitatorPdfName, setFacilitatorPdfName] = useState("");
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const canManageTags = role === "admin" || role === "superadmin";

  // Manual commitment-buddy mapping — loaded lazily the first time the tab
  // is opened (not part of the eager workspace bundle, since most sessions
  // never visit it).
  const [buddyRoster, setBuddyRoster] = useState<BuddyMappingMember[]>([]);
  const [buddyLoaded, setBuddyLoaded] = useState(false);
  const [buddyLoading, setBuddyLoading] = useState(false);
  const [buddyError, setBuddyError] = useState<string | null>(null);
  const [buddySelection, setBuddySelection] = useState<string[]>([]);

  const fetchBuddyRoster = useCallback(async () => {
    setBuddyLoading(true);
    setBuddyError(null);
    try {
      const result = await listCommitmentBuddyRoster(cohort.id);
      if (result.error) { setBuddyError(result.error); return; }
      setBuddyRoster(result.members ?? []);
    } catch (caughtError) {
      setBuddyError(caughtError instanceof Error ? caughtError.message : "Failed to load buddy mapping");
    } finally {
      setBuddyLoaded(true);
      setBuddyLoading(false);
    }
  }, [cohort.id]);

  useEffect(() => {
    if (tab !== "buddies" || buddyLoaded || buddyLoading) return;
    void fetchBuddyRoster();
  }, [tab, buddyLoaded, buddyLoading, fetchBuddyRoster]);

  function toggleBuddySelection(userId: string) {
    setBuddySelection((current) =>
      current.includes(userId) ? current.filter((id) => id !== userId) : [...current, userId]
    );
  }

  async function handleSaveBuddyPairing() {
    if (buddySelection.length < 2 || busyAction) return;
    await runMutation(
      "save-buddy-pairing",
      () => saveCommitmentBuddyCircle(cohort.id, buddySelection),
      { after: () => setBuddySelection([]), refetch: [fetchBuddyRoster] }
    );
  }

  async function handleRemoveBuddyAssignment(userId: string) {
    await runMutation(
      `remove-buddy:${userId}`,
      () => removeCommitmentBuddyAssignment(cohort.id, userId),
      { refetch: [fetchBuddyRoster] }
    );
  }

  // Targeted, single-purpose refetchers. Each mutation below only calls the
  // one or two of these it actually invalidates, instead of reloading every
  // section of the panel (which used to make every small edit feel like a
  // full page reload).
  const fetchMembers = useCallback(async () => {
    const detailResult = await getCohortDetail(cohort.id);
    if (detailResult.error) { setError(detailResult.error); return; }
    setMembers(detailResult.members ?? []);
    setMemberIds(new Set((detailResult.members ?? []).map((member) => member.id)));
    setSelectedTrainerId(detailResult.cohort?.trainerId ?? "");
    setSenderName(detailResult.cohort?.senderName ?? "");
    setMaxWeeks(detailResult.cohort?.maxWeeks != null ? String(detailResult.cohort.maxWeeks) : "");
    setEmailSubjects(detailResult.cohort?.emailSubjects ?? {});
    setActionCategories(detailResult.cohort?.actionCategories ?? []);
    // Merge (not replace) so a just-created, not-yet-assigned team stays in
    // the list even though it can't come back from the roster itself.
    setCohortTags((current) => mergeTagsFromMembers(detailResult.members ?? [], current));
  }, [cohort.id]);

  const fetchCompanyUsers = useCallback(async () => {
    const usersResult = await getCompanyUsers(companyId);
    if (usersResult.error) { setError(usersResult.error); return; }
    setCompanyUsers(usersResult.users ?? []);
  }, [companyId]);

  const fetchContent = useCallback(async () => {
    const contentResult = await listCohortContent(cohort.id);
    if (contentResult.error) { setError(contentResult.error); return; }
    setAssignedContentIds(new Set((contentResult.items ?? []).map((item) => item.id)));
  }, [cohort.id]);

  const fetchNotices = useCallback(async () => {
    const noticesResult = await getCohortNotices(cohort.id);
    if (noticesResult.error) { setError(noticesResult.error); return; }
    setNotices(noticesResult.notices ?? []);
  }, [cohort.id]);

  const fetchFacilitators = useCallback(async () => {
    const facilitatorsResult = await listFacilitators(cohort.id);
    if (facilitatorsResult.error) { setError(facilitatorsResult.error); return; }
    setFacilitators(facilitatorsResult.facilitators ?? []);
  }, [cohort.id]);

  const fetchTeamNames = useCallback(async () => {
    const overridesResult = await getCohortTeamNameOverrides(cohort.id);
    if (overridesResult.error) { setError(overridesResult.error); return; }
    setTeamNameOverrides(overridesResult.overrides ?? {});
  }, [cohort.id]);

  const fetchDates = useCallback(async () => {
    const datesResult = await listCohortDates(cohort.id);
    if (datesResult.error) { setError(datesResult.error); return; }
    setCohortDates(datesResult.dates ?? []);
  }, [cohort.id]);

  // Full load — only used when this panel first mounts for a cohort.
  const refresh = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const payload = await fetchAdminJson<{
        error?: string;
        members?: CohortMember[];
        trainerId?: string;
        senderName?: string;
        maxWeeks?: number | null;
        emailSubjects?: BatchEmailSubjects;
        actionCategories?: string[];
        companyUsers?: CompanyUser[];
        assignedContentIds?: string[];
        libraryItems?: PrepareContentItem[];
        trainers?: Trainer[];
        notices?: CohortNotice[];
        facilitators?: Facilitator[];
        teamNameOverrides?: Record<string, string>;
        dates?: CohortDate[];
      }>(
        `/api/admin/cohorts/${encodeURIComponent(cohort.id)}?bundle=workspace&companyId=${encodeURIComponent(companyId)}`,
        signal
      );
      if (payload.error) setError(payload.error);
      setMembers(payload.members ?? []);
      setMemberIds(new Set((payload.members ?? []).map((member) => member.id)));
      setCompanyUsers(payload.companyUsers ?? []);
      setCohortTags(mergeTagsFromMembers(payload.members ?? [], []));
      setTeamNameOverrides(payload.teamNameOverrides ?? {});
      setCohortDates(payload.dates ?? []);
      setAssignedContentIds(new Set(payload.assignedContentIds ?? []));
      setLibraryItems(payload.libraryItems ?? []);
      setTrainerRoster(payload.trainers ?? []);
      setSelectedTrainerId(payload.trainerId ?? "");
      setSenderName(payload.senderName ?? "");
      setMaxWeeks(payload.maxWeeks != null ? String(payload.maxWeeks) : "");
      setEmailSubjects(payload.emailSubjects ?? {});
      setActionCategories(payload.actionCategories ?? []);
      setNotices(payload.notices ?? []);
      setFacilitators(payload.facilitators ?? []);
    } catch (caughtError) {
      if (isAbortError(caughtError)) return;
      setError(caughtError instanceof Error ? caughtError.message : "Failed to load batch details");
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [cohort.id, companyId]);

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [refresh]);

  const currentMembers = members;
  const visibleCurrentMembers = useMemo(() => {
    const needle = currentMemberQuery.trim().toLowerCase();
    if (!needle) return currentMembers;
    return currentMembers.filter((member) =>
      `${member.fullName || "Unnamed user"} ${member.email ?? ""}`.toLowerCase().includes(needle)
    );
  }, [currentMembers, currentMemberQuery]);
  const availableUsers = useMemo(
    () => companyUsers.filter((user) => !memberIds.has(user.id)),
    [companyUsers, memberIds]
  );
  const visibleAvailableUsers = useMemo(() => {
    const needle = memberQuery.trim().toLowerCase();
    if (!needle) return availableUsers;
    return availableUsers.filter((user) =>
      `${user.full_name || "Unnamed user"} ${user.email ?? ""}`.toLowerCase().includes(needle)
    );
  }, [availableUsers, memberQuery]);
  const assignedItems = useMemo(
    () => libraryItems.filter((item) => assignedContentIds.has(item.id)),
    [libraryItems, assignedContentIds]
  );
  const availableItems = useMemo(
    () => libraryItems.filter((item) => !assignedContentIds.has(item.id)),
    [libraryItems, assignedContentIds]
  );
  const visibleAvailableItems = useMemo(() => {
    const needle = contentQuery.trim().toLowerCase();
    if (!needle) return availableItems;
    return availableItems.filter((item) => `${item.title} ${item.type}`.toLowerCase().includes(needle));
  }, [availableItems, contentQuery]);

  // Parsed live from the draft textarea so the "current phase" dropdown
  // reflects unsaved edits — falls back to the last-saved phases if the
  // draft doesn't parse, so the dropdown never goes empty mid-edit.
  const draftAgendaPhases = useMemo((): { id: string; label: string }[] | null => {
    try {
      const parsed = JSON.parse(programPhasesJson || "[]");
      if (!Array.isArray(parsed)) return null;
      if (!parsed.every((phase) => phase && typeof phase.id === "string" && typeof phase.label === "string")) return null;
      return parsed.map((phase) => ({ id: phase.id, label: phase.label }));
    } catch {
      return null;
    }
  }, [programPhasesJson]);
  const agendaPhaseOptions = draftAgendaPhases ?? (cohort.programPhases ?? []).map((phase) => ({ id: phase.id, label: phase.label }));

  function toggleSelection(id: string, setter: React.Dispatch<React.SetStateAction<Set<string>>>) {
    setter((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAllVisible(ids: string[], selected: Set<string>, setter: React.Dispatch<React.SetStateAction<Set<string>>>) {
    const allSelected = ids.length > 0 && ids.every((id) => selected.has(id));
    setter((previous) => {
      const next = new Set(previous);
      ids.forEach((id) => allSelected ? next.delete(id) : next.add(id));
      return next;
    });
  }

  /**
   * Run a mutation and refresh only what it actually invalidates.
   * `refetch` lists the local sections to reload (e.g. [fetchNotices]);
   * `syncList` also asks the parent to reload the sidebar/summary list —
   * only needed when the mutation changes something shown there (name,
   * logo, trainer, member/content counts, dates).
   */
  async function runMutation(
    action: string,
    mutation: () => Promise<{ error?: string }>,
    options?: {
      after?: () => void;
      refetch?: Array<() => Promise<void>>;
      syncList?: boolean;
    }
  ) {
    if (busyAction) return;
    setBusyAction(action);
    setError(null);
    try {
      const result = await mutation();
      if (result.error) {
        setError(result.error);
        return;
      }
      options?.after?.();
      if (options?.refetch?.length) {
        await Promise.all(options.refetch.map((fetcher) => fetcher()));
      }
      if (options?.syncList) {
        await onChange();
      }
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "The update could not be completed");
    } finally {
      setBusyAction(null);
    }
  }

  const allVisibleMembersSelected = visibleAvailableUsers.length > 0 && visibleAvailableUsers.every((user) => pendingAddIds.has(user.id));
  const allVisibleContentSelected = visibleAvailableItems.length > 0 && visibleAvailableItems.every((item) => pendingContentIds.has(item.id));

  async function handleCohortLogo(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    await runMutation(
      "cohort-logo",
      async () => {
        const logoUrl = await uploadCohortLogo(cohort.id, file);
        return updateCohort(cohort.id, { logoUrl });
      },
      { syncList: true }
    );
  }

  async function handleAssignTrainer() {
    await runMutation(
      "assign-trainer",
      () => updateCohort(cohort.id, { trainerId: selectedTrainerId || null }),
      { syncList: true }
    );
  }

  async function handleSaveSenderName() {
    await runMutation(
      "save-sender-name",
      () => updateCohort(cohort.id, { senderName }),
      { syncList: true }
    );
  }

  // Fields start filled with the default subject so it can be edited in
  // place. Text matching the default (or left blank) is saved as "no
  // override", so the email keeps using its built-in default subject.
  const subjectFieldValue = (subjects: BatchEmailSubjects | undefined, key: BatchEmailSubjectKey) =>
    subjects?.[key] ?? BATCH_EMAIL_SUBJECT_OPTIONS[key].defaultSubject;
  const subjectOverride = (subjects: BatchEmailSubjects | undefined, key: BatchEmailSubjectKey) => {
    const value = subjectFieldValue(subjects, key).trim();
    return value === BATCH_EMAIL_SUBJECT_OPTIONS[key].defaultSubject ? "" : value;
  };
  const emailSubjectsDirty = BATCH_EMAIL_SUBJECT_KEYS.some(
    (key) => subjectOverride(emailSubjects, key) !== subjectOverride(cohort.emailSubjects, key)
  );

  async function handleSaveEmailSubjects() {
    const overrides = Object.fromEntries(
      BATCH_EMAIL_SUBJECT_KEYS.map((key) => [key, subjectOverride(emailSubjects, key)])
    );
    await runMutation(
      "save-email-subjects",
      () => updateCohort(cohort.id, { emailSubjects: overrides }),
      { syncList: true }
    );
  }

  const cleanedActionCategories = actionCategories.map((category) => category.trim()).filter(Boolean);
  const actionCategoriesDirty =
    cleanedActionCategories.join("\n") !== (cohort.actionCategories ?? []).join("\n");

  async function handleSaveActionCategories() {
    await runMutation(
      "save-action-categories",
      () => updateCohort(cohort.id, { actionCategories: cleanedActionCategories }),
      { syncList: true, after: () => setActionCategories(cleanedActionCategories) }
    );
  }

  async function handleSaveMaxWeeks() {
    const trimmed = maxWeeks.trim();
    await runMutation(
      "save-max-weeks",
      () => updateCohort(cohort.id, { maxWeeks: trimmed ? Number(trimmed) : null }),
      { syncList: true }
    );
  }

  // Not routed through runMutation because it needs the created tag back
  // (to append it to this batch's own team list) — runMutation's `after`
  // callback only ever gets a void signal, not the mutation's result.
  async function handleCreateTag() {
    if (!newTagName.trim() || creatingTag || busyAction) return;
    setCreatingTag(true);
    setError(null);
    try {
      const result = await createParticipantTag(newTagName);
      if (result.error) { setError(result.error); return; }
      if (result.tag) {
        setCohortTags((current) => [...current, result.tag!].sort((a, b) => a.name.localeCompare(b.name)));
      }
      setNewTagName("");
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Failed to create team");
    } finally {
      setCreatingTag(false);
    }
  }

  async function handleExportMembers() {
    await exportCohortMembersExcel({
      members: currentMembers,
      teamNameOverrides,
      batchName: cohort.batchName,
      moduleName: cohort.moduleName,
    });
  }

  function startEditTeamName(tag: ParticipantTag) {
    setEditingTeamId(tag.id);
    setEditingTeamName(teamNameOverrides[tag.id] ?? tag.name);
  }

  function cancelEditTeamName() {
    setEditingTeamId(null);
    setEditingTeamName("");
  }

  async function handleSaveTeamName(tagId: string) {
    await runMutation(
      `save-team-name:${tagId}`,
      () => setCohortTeamName(cohort.id, tagId, editingTeamName),
      { after: () => { setEditingTeamId(null); setEditingTeamName(""); }, refetch: [fetchTeamNames] }
    );
  }

  async function handleToggleLock() {
    if (role !== "superadmin") return;
    const nextLocked = !cohort.locked;
    if (
      nextLocked &&
      !window.confirm(
        "Lock this batch? Participants will immediately lose access to their plan, action creation, and the Commitment Wallet until you unlock it again."
      )
    ) {
      return;
    }
    await runMutation("toggle-lock", () => setCohortLock(cohort.id, nextLocked), { syncList: true });
  }

  async function handlePostNotice() {
    if (!noticeDraft.trim() || busyAction) return;
    await runMutation(
      "post-notice",
      async () => {
        const result = await postCohortNotice(cohort.id, noticeDraft);
        return { error: result.error };
      },
      { after: () => setNoticeDraft(""), refetch: [fetchNotices] }
    );
  }

  async function handleAddFacilitator() {
    if (!facilitatorName.trim() || !facilitatorDesignation.trim() || busyAction) return;
    await runMutation(
      "add-facilitator",
      async () => {
        const result = await createFacilitator(cohort.id, {
          name: facilitatorName,
          designation: facilitatorDesignation,
          pdfUrl: facilitatorPdfUrl || null,
          pdfName: facilitatorPdfName || null,
        });
        return { error: result.error };
      },
      {
        after: () => {
          setFacilitatorName("");
          setFacilitatorDesignation("");
          setFacilitatorPdfUrl("");
          setFacilitatorPdfName("");
        },
        refetch: [fetchFacilitators],
      }
    );
  }

  async function handleSaveAgenda() {
    if (busyAction) return;
    await runMutation(
      "save-agenda",
      () => updateCohort(cohort.id, { programPhasesJson, currentPhaseId: currentPhaseId || null }),
      { syncList: true }
    );
  }

  function startEditingNames() {
    setEditBatchName(cohort.batchName);
    setEditModuleName(cohort.moduleName ?? "");
    setEditingNames(true);
  }

  async function handleSaveNames() {
    if (!editBatchName.trim() || busyAction) return;
    await runMutation(
      "save-names",
      () => updateCohort(cohort.id, { batchName: editBatchName, moduleName: editModuleName }),
      { after: () => setEditingNames(false), syncList: true }
    );
  }

  async function handleAddDate(event: React.FormEvent) {
    event.preventDefault();
    if (!newDateValue || busyAction) return;
    await runMutation(
      "add-date",
      () => addCohortDate(cohort.id, newDateValue),
      { after: () => setNewDateValue(""), refetch: [fetchDates], syncList: true }
    );
  }

  async function handleDeleteCohort() {
    const displayName = cohort.moduleName ? `${cohort.batchName} — ${cohort.moduleName}` : cohort.batchName;
    if (
      !window.confirm(
        `Permanently delete “${displayName}”? Members, content assignments, and related batch data will be removed. This cannot be undone.`
      )
    ) {
      return;
    }
    if (busyAction) return;
    setBusyAction("delete-cohort");
    setError(null);
    try {
      const result = await deleteCohort(cohort.id);
      if (result.error) {
        setError(result.error);
        return;
      }
      await onChange();
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "The update could not be completed");
    } finally {
      setBusyAction(null);
    }
  }

  return (
    <div className="cohort-admin-detail">
      <div className="cohort-admin-detail-head">
        <div className="cohort-admin-detail-title">
          <span className="cohort-admin-cohort-mark cohort-admin-cohort-mark--large">{cohort.logoUrl ? <img src={cohort.logoUrl} alt={`${cohort.batchName} logo`} /> : initials(cohort.batchName)}</span>
          <div>
            <p className="cohort-admin-eyebrow">
              Active batch
              <span className={`cohort-admin-lock-status${cohort.locked ? " is-locked" : ""}`}>
                {cohort.locked ? <Lock size={11} /> : <LockOpen size={11} />}
                {cohort.locked ? "Locked" : "Unlocked"}
              </span>
            </p>
            {editingNames ? (
              <div className="cohort-admin-name-edit">
                <label className="cohort-admin-field">
                  <span>Batch name <em>Required</em></span>
                  <input
                    autoFocus
                    value={editBatchName}
                    onChange={(event) => setEditBatchName(event.target.value)}
                    disabled={Boolean(busyAction)}
                  />
                </label>
                <label className="cohort-admin-field">
                  <span>Module name <em>Optional</em></span>
                  <input
                    value={editModuleName}
                    onChange={(event) => setEditModuleName(event.target.value)}
                    disabled={Boolean(busyAction)}
                  />
                </label>
                <div className="cohort-admin-name-edit-actions">
                  <button
                    type="button"
                    onClick={() => setEditingNames(false)}
                    disabled={Boolean(busyAction)}
                    className="cohort-admin-button cohort-admin-button--secondary"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleSaveNames()}
                    disabled={Boolean(busyAction) || !editBatchName.trim()}
                    className="cohort-admin-button cohort-admin-button--primary"
                  >
                    {busyAction === "save-names" ? <Loader2 size={15} className="cohort-admin-spin" /> : <Check size={15} />}
                    {busyAction === "save-names" ? "Saving…" : "Save"}
                  </button>
                </div>
              </div>
            ) : (
              <>
                <div className="cohort-admin-title-row">
                  <h2>{cohort.batchName}</h2>
                  <button
                    type="button"
                    onClick={startEditingNames}
                    disabled={Boolean(busyAction)}
                    className="cohort-admin-inline-edit-btn"
                    aria-label="Edit batch and module name"
                    title="Edit batch and module name"
                  >
                    <Pencil size={13} />
                  </button>
                </div>
                {cohort.moduleName && <p className="cohort-admin-module-name">{cohort.moduleName}</p>}
              </>
            )}
            <p>{cohort.description || "No description added."}</p>
          </div>
        </div>
        <div className="cohort-admin-detail-brand-actions">
          <label className="cohort-admin-logo-upload">
            {busyAction === "cohort-logo" ? <Loader2 size={14} className="cohort-admin-spin" /> : <ImagePlus size={14} />}
            {cohort.logoUrl ? "Replace batch logo" : "Upload batch logo"}
            <input type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" disabled={!!busyAction} onChange={(event) => void handleCohortLogo(event)} />
          </label>
          {role === "superadmin" && (
            <button
              type="button"
              onClick={() => void handleToggleLock()}
              disabled={Boolean(busyAction)}
              className={`cohort-admin-button ${cohort.locked ? "cohort-admin-button--primary" : "cohort-admin-button--secondary"}`}
              aria-label={cohort.locked ? `Unlock ${cohort.batchName}` : `Lock ${cohort.batchName}`}
              title={
                cohort.locked
                  ? "Unlock — participants regain access to their plan, actions, and wallet"
                  : "Lock — participants lose access to their plan, actions, and wallet"
              }
            >
              {busyAction === "toggle-lock" ? (
                <Loader2 size={15} className="cohort-admin-spin" />
              ) : cohort.locked ? (
                <LockOpen size={15} />
              ) : (
                <Lock size={15} />
              )}
              {busyAction === "toggle-lock" ? "Updating…" : cohort.locked ? "Unlock batch" : "Lock batch"}
            </button>
          )}
          <button
            type="button"
            onClick={() => void handleDeleteCohort()}
            disabled={Boolean(busyAction)}
            className="cohort-admin-button cohort-admin-button--danger"
            aria-label={`Delete ${cohort.batchName}`}
            title="Delete batch"
          >
            {busyAction === "delete-cohort" ? <Loader2 size={15} className="cohort-admin-spin" /> : <Trash2 size={15} />}
            {busyAction === "delete-cohort" ? "Deleting…" : "Delete batch"}
          </button>
        </div>
      </div>

      <div className="cohort-admin-dates-bar">
        <span className="cohort-admin-dates-label"><CalendarDays size={14} /> Dates</span>
        <div className="cohort-admin-dates-chips">
          {cohortDates.length === 0 && <span className="cohort-admin-dates-empty">No dates set</span>}
          {cohortDates.map((cohortDate) => (
            <span className="cohort-admin-date-chip" key={cohortDate.id}>
              {formatStartDate(cohortDate.date)}
              <button
                type="button"
                onClick={() => void runMutation(`remove-date:${cohortDate.id}`, () => removeCohortDate(cohort.id, cohortDate.id), { refetch: [fetchDates], syncList: true })}
                disabled={Boolean(busyAction)}
                aria-label={`Remove date ${formatStartDate(cohortDate.date)}`}
                title="Remove date"
              >
                {busyAction === `remove-date:${cohortDate.id}` ? <Loader2 size={11} className="cohort-admin-spin" /> : <X size={11} />}
              </button>
            </span>
          ))}
        </div>
        <form className="cohort-admin-date-add" onSubmit={(event) => void handleAddDate(event)}>
          <input
            type="date"
            value={newDateValue}
            onChange={(event) => setNewDateValue(event.target.value)}
            disabled={Boolean(busyAction)}
            aria-label="Add a date"
          />
          <button type="submit" disabled={Boolean(busyAction) || !newDateValue} className="cohort-admin-button cohort-admin-button--secondary">
            {busyAction === "add-date" ? <Loader2 size={14} className="cohort-admin-spin" /> : <Plus size={14} />}
            Add date
          </button>
        </form>
      </div>

      <div className="cohort-admin-tabs" role="tablist" aria-label="Batch details">
        <button type="button" role="tab" aria-selected={tab === "members"} onClick={() => setTab("members")} className={tab === "members" ? "is-active" : ""}>
          <Users size={16} /> Members <span>{currentMembers.length}</span>
        </button>
        <button type="button" role="tab" aria-selected={tab === "content"} onClick={() => setTab("content")} className={tab === "content" ? "is-active" : ""}>
          <BookOpen size={16} /> Learning content <span>{assignedItems.length}</span>
        </button>
        <button type="button" role="tab" aria-selected={tab === "trainer"} onClick={() => setTab("trainer")} className={tab === "trainer" ? "is-active" : ""}>
          <UserRound size={16} /> Trainer <span>{notices.length}</span>
        </button>
        <button type="button" role="tab" aria-selected={tab === "buddies"} onClick={() => setTab("buddies")} className={tab === "buddies" ? "is-active" : ""}>
          <Handshake size={16} /> Buddy mapping <span>{buddyRoster.filter((m) => m.buddyId).length}</span>
        </button>
        <button type="button" role="tab" aria-selected={tab === "settings"} onClick={() => setTab("settings")} className={tab === "settings" ? "is-active" : ""}>
          <Settings size={16} /> Settings
        </button>
        {role === "superadmin" && (
          <button type="button" role="tab" aria-selected={tab === "agenda"} onClick={() => setTab("agenda")} className={tab === "agenda" ? "is-active" : ""}>
            <CalendarDays size={16} /> Agenda <span>{(cohort.programPhases ?? []).length}</span>
          </button>
        )}
        {role === "superadmin" && (
          <button type="button" role="tab" aria-selected={tab === "generation"} onClick={() => setTab("generation")} className={tab === "generation" ? "is-active" : ""}>
            <NotebookPen size={16} /> Action context
          </button>
        )}
      </div>

      {error && (
        <div className="cohort-admin-alert cohort-admin-alert--error cohort-admin-alert--inner" role="alert">
          <AlertCircle size={17} /><div><strong>Unable to update this batch</strong><span>{error}</span></div>
          <button type="button" onClick={() => void refresh()}>Retry</button>
        </div>
      )}

      {loading ? (
        <div className="cohort-admin-detail-loading" aria-busy="true">
          <Loader2 size={20} className="cohort-admin-spin" /><span>Loading batch details…</span>
        </div>
      ) : tab === "members" ? (
        <div className="cohort-admin-picker-grid">
          <section className="cohort-admin-panel">
            <div className="cohort-admin-panel-head">
              <div><h3>Current members</h3><p>People currently learning in this batch.</p></div>
              <span>{currentMembers.length}</span>
              <button
                type="button"
                onClick={() => void handleExportMembers()}
                disabled={currentMembers.length === 0}
                className="cohort-admin-button cohort-admin-button--secondary"
                title="Export current members as an Excel sheet"
              >
                <FileSpreadsheet size={14} />
                Export Excel
              </button>
            </div>
            {canManageTags && (
              <form
                className="cohort-admin-tag-creator"
                onSubmit={(event) => {
                  event.preventDefault();
                  void handleCreateTag();
                }}
              >
                <input
                  value={newTagName}
                  onChange={(event) => setNewTagName(event.target.value)}
                  placeholder="New tag, e.g. Team A"
                  aria-label="New tag name"
                  disabled={creatingTag || Boolean(busyAction)}
                />
                <button type="submit" disabled={creatingTag || Boolean(busyAction) || !newTagName.trim()} className="cohort-admin-button cohort-admin-button--secondary">
                  {creatingTag ? <Loader2 size={14} className="cohort-admin-spin" /> : <Plus size={14} />}
                  Add tag
                </button>
              </form>
            )}
            {currentMembers.length === 0 ? (
              <div className="cohort-admin-mini-empty"><Users size={20} /><strong>No members yet</strong><span>Select people from the company directory.</span></div>
            ) : (
              <>
                <label className="cohort-admin-search cohort-admin-search--panel"><Search size={15} /><input value={currentMemberQuery} onChange={(event) => setCurrentMemberQuery(event.target.value)} placeholder="Search current members" aria-label="Search current members" /></label>
                {visibleCurrentMembers.length === 0 ? (
                  <div className="cohort-admin-no-results">No members match your search.</div>
                ) : (
                  <div className="cohort-admin-people-list">
                    {visibleCurrentMembers.map((member) => (
                      <div key={member.id} className="cohort-admin-person">
                        <span className="cohort-admin-avatar">{initials(member.fullName)}</span>
                        <div><strong>{member.fullName || "Unnamed user"}</strong><span>{member.email || "Batch participant"}</span></div>
                        {canManageTags ? (
                          <select
                            className="cohort-admin-tag-select"
                            value={member.tag?.id ?? ""}
                            disabled={Boolean(busyAction)}
                            aria-label={`Tag for ${member.fullName || "participant"}`}
                            onChange={(event) =>
                              void runMutation(`assign-tag:${member.id}`, () => assignMemberTag(cohort.id, member.id, event.target.value || null), { refetch: [fetchMembers] })
                            }
                          >
                            <option value="">No tag</option>
                            {cohortTags.map((tag) => <option key={tag.id} value={tag.id}>{teamNameOverrides[tag.id] ?? tag.name}</option>)}
                          </select>
                        ) : (
                          member.tag && <span className="cohort-admin-tag-badge">{teamNameOverrides[member.tag.id] ?? member.tag.name}</span>
                        )}
                        <button
                          type="button"
                          onClick={() => void runMutation(`remove-member:${member.id}`, () => removeMembersFromCohort(cohort.id, [member.id]), { refetch: [fetchMembers, fetchCompanyUsers], syncList: true })}
                          disabled={Boolean(busyAction)}
                          aria-label={`Remove ${member.fullName || "member"}`}
                          title="Remove from batch"
                        >
                          {busyAction === `remove-member:${member.id}` ? <Loader2 size={15} className="cohort-admin-spin" /> : <X size={15} />}
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </section>

          <section className="cohort-admin-panel">
            <div className="cohort-admin-panel-head"><div><h3>Add participants</h3><p>{availableUsers.length} available in this company.</p></div></div>
            <div className="cohort-admin-notice"><Info size={17} /><p><strong>Moving between batches</strong><span>Adding an existing participant makes this their current batch. Any unfinished earlier plan is archived and remains available in Archived actions.</span></p></div>
            {companyUsers.length === 0 ? (
              <div className="cohort-admin-mini-empty"><Users size={20} /><strong>No company users</strong><span>Ask a superadmin to add participants to your company first.</span></div>
            ) : availableUsers.length === 0 ? (
              <div className="cohort-admin-mini-empty"><Check size={20} /><strong>Everyone is assigned</strong><span>All company participants are in this batch.</span></div>
            ) : (
              <>
                <label className="cohort-admin-search cohort-admin-search--panel"><Search size={15} /><input value={memberQuery} onChange={(event) => setMemberQuery(event.target.value)} placeholder="Search participants" aria-label="Search participants" /></label>
                <button type="button" className="cohort-admin-select-all" onClick={() => toggleAllVisible(visibleAvailableUsers.map((user) => user.id), pendingAddIds, setPendingAddIds)} disabled={Boolean(busyAction) || visibleAvailableUsers.length === 0}>
                  <span className={`cohort-admin-checkbox${allVisibleMembersSelected ? " is-checked" : ""}`}>{allVisibleMembersSelected && <Check size={12} />}</span>{allVisibleMembersSelected ? "Clear visible" : "Select all visible"}
                </button>
                <div className="cohort-admin-selection-list">
                  {visibleAvailableUsers.map((user) => (
                    <label key={user.id} className="cohort-admin-select-row">
                      <input type="checkbox" checked={pendingAddIds.has(user.id)} onChange={() => toggleSelection(user.id, setPendingAddIds)} disabled={Boolean(busyAction)} />
                      <span className="cohort-admin-checkbox">{pendingAddIds.has(user.id) && <Check size={12} />}</span>
                      <span className="cohort-admin-avatar">{initials(user.full_name)}</span>
                      <span className="cohort-admin-select-row-copy">
                        <strong>{user.full_name || "Unnamed user"}</strong>
                        {user.email && <small>{user.email}</small>}
                      </span>
                    </label>
                  ))}
                  {visibleAvailableUsers.length === 0 && <div className="cohort-admin-no-results">No participants match your search.</div>}
                </div>
                <div className="cohort-admin-panel-action">
                  <span>{pendingAddIds.size ? `${pendingAddIds.size} selected` : "Select participants to add"}</span>
                  <button type="button" onClick={() => void runMutation("add-members", () => addMembersToCohort(cohort.id, Array.from(pendingAddIds)), { after: () => setPendingAddIds(new Set()), refetch: [fetchMembers, fetchCompanyUsers], syncList: true })} disabled={Boolean(busyAction) || pendingAddIds.size === 0} className="cohort-admin-button cohort-admin-button--primary">
                    {busyAction === "add-members" ? <Loader2 size={15} className="cohort-admin-spin" /> : <UserPlus size={15} />} Add to batch
                  </button>
                </div>
              </>
            )}
          </section>
        </div>
      ) : tab === "content" ? (
        <div className="cohort-admin-picker-grid">
          <section className="cohort-admin-panel">
            <div className="cohort-admin-panel-head"><div><h3>Assigned content</h3><p>Preparation visible to this batch.</p></div><span>{assignedItems.length}</span></div>
            {assignedItems.length === 0 ? (
              <div className="cohort-admin-mini-empty"><BookOpen size={20} /><strong>No content assigned</strong><span>Select items from the active content library.</span></div>
            ) : (
              <div className="cohort-admin-content-list">
                {assignedItems.map((item) => (
                  <div key={item.id} className="cohort-admin-content-row">
                    <span className="cohort-admin-type-badge">{item.type}</span>
                    <div><strong>{item.title}</strong><span>{item.description || "No description"}</span></div>
                    <button type="button" onClick={() => void runMutation(`remove-content:${item.id}`, () => removeContentFromCohort(cohort.id, item.id), { refetch: [fetchContent], syncList: true })} disabled={Boolean(busyAction)} aria-label={`Remove ${item.title}`} title="Remove from batch">
                      {busyAction === `remove-content:${item.id}` ? <Loader2 size={15} className="cohort-admin-spin" /> : <X size={15} />}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="cohort-admin-panel">
            <div className="cohort-admin-panel-head"><div><h3>Add learning content</h3><p>{availableItems.length} active items available.</p></div></div>
            {libraryItems.length === 0 ? (
              <div className="cohort-admin-mini-empty"><BookOpen size={20} /><strong>The library is empty</strong><span>Add active content in Content management first.</span></div>
            ) : availableItems.length === 0 ? (
              <div className="cohort-admin-mini-empty"><Check size={20} /><strong>Everything is assigned</strong><span>This batch has all active library items.</span></div>
            ) : (
              <>
                <label className="cohort-admin-search cohort-admin-search--panel"><Search size={15} /><input value={contentQuery} onChange={(event) => setContentQuery(event.target.value)} placeholder="Search content" aria-label="Search content" /></label>
                <button type="button" className="cohort-admin-select-all" onClick={() => toggleAllVisible(visibleAvailableItems.map((item) => item.id), pendingContentIds, setPendingContentIds)} disabled={Boolean(busyAction) || visibleAvailableItems.length === 0}>
                  <span className={`cohort-admin-checkbox${allVisibleContentSelected ? " is-checked" : ""}`}>{allVisibleContentSelected && <Check size={12} />}</span>{allVisibleContentSelected ? "Clear visible" : "Select all visible"}
                </button>
                <div className="cohort-admin-selection-list">
                  {visibleAvailableItems.map((item) => (
                    <label key={item.id} className="cohort-admin-select-row cohort-admin-select-row--content">
                      <input type="checkbox" checked={pendingContentIds.has(item.id)} onChange={() => toggleSelection(item.id, setPendingContentIds)} disabled={Boolean(busyAction)} />
                      <span className="cohort-admin-checkbox">{pendingContentIds.has(item.id) && <Check size={12} />}</span>
                      <span className="cohort-admin-type-badge">{item.type}</span>
                      <span><strong>{item.title}</strong><small>{item.description || "No description"}</small></span>
                    </label>
                  ))}
                  {visibleAvailableItems.length === 0 && <div className="cohort-admin-no-results">No content matches your search.</div>}
                </div>
                <div className="cohort-admin-panel-action">
                  <span>{pendingContentIds.size ? `${pendingContentIds.size} selected` : "Select content to assign"}</span>
                  <button type="button" onClick={() => void runMutation("add-content", () => assignContentToCohort(cohort.id, Array.from(pendingContentIds)), { after: () => setPendingContentIds(new Set()), refetch: [fetchContent], syncList: true })} disabled={Boolean(busyAction) || pendingContentIds.size === 0} className="cohort-admin-button cohort-admin-button--primary">
                    {busyAction === "add-content" ? <Loader2 size={15} className="cohort-admin-spin" /> : <Plus size={15} />} Assign content
                  </button>
                </div>
              </>
            )}
          </section>
        </div>
      ) : tab === "trainer" ? (
        <div className="cohort-admin-picker-grid">
          <section className="cohort-admin-panel">
            <div className="cohort-admin-panel-head"><div><h3>Assigned trainer</h3><p>Shown to participants on their Base Camp page.</p></div></div>
            <div className="cohort-admin-trainer-current">
              <span className="cohort-admin-avatar cohort-admin-avatar--trainer">
                {cohort.trainer?.imageUrl ? <img src={cohort.trainer.imageUrl} alt="" /> : <UserRound size={18} />}
              </span>
              <div>
                <strong>{cohort.trainer?.name || "No trainer assigned"}</strong>
                <span>{cohort.trainer ? "Running this batch" : "Assign one from the roster below"}</span>
              </div>
            </div>
            {role === "superadmin" ? (
              trainerRoster.length === 0 ? (
                <div className="cohort-admin-mini-empty"><UserRound size={20} /><strong>No trainers yet</strong><span>Add a trainer's name and photo in Trainers first.</span></div>
              ) : (
                <div className="cohort-admin-panel-action">
                  <select
                    className="cohort-admin-trainer-select"
                    value={selectedTrainerId}
                    onChange={(event) => setSelectedTrainerId(event.target.value)}
                    disabled={Boolean(busyAction)}
                    aria-label="Assign trainer"
                  >
                    <option value="">No trainer</option>
                    {trainerRoster.map((trainer) => <option key={trainer.id} value={trainer.id}>{trainer.name}</option>)}
                  </select>
                  <button
                    type="button"
                    onClick={() => void handleAssignTrainer()}
                    disabled={Boolean(busyAction) || selectedTrainerId === (cohort.trainerId ?? "")}
                    className="cohort-admin-button cohort-admin-button--primary"
                  >
                    {busyAction === "assign-trainer" ? <Loader2 size={15} className="cohort-admin-spin" /> : <Check size={15} />}
                    {busyAction === "assign-trainer" ? "Saving…" : "Save trainer"}
                  </button>
                </div>
              )
            ) : (
              <div className="cohort-admin-notice"><Info size={17} /><p><strong>Only a superadmin can change this</strong><span>Ask a superadmin to assign or update this batch's trainer.</span></p></div>
            )}
          </section>

          <section className="cohort-admin-panel">
            <div className="cohort-admin-panel-head">
              <div><h3>Notice board</h3><p>Dated notices shown to the whole batch on Base Camp. Normally posted by the trainer once they're logged in.</p></div>
              <span>{notices.length}</span>
            </div>
            <div className="cohort-admin-tag-creator">
              <input
                value={noticeDraft}
                onChange={(event) => setNoticeDraft(event.target.value)}
                placeholder="Post a notice on the trainer's behalf"
                aria-label="New notice"
                maxLength={2000}
                disabled={Boolean(busyAction)}
              />
              <button
                type="button"
                onClick={() => void handlePostNotice()}
                disabled={Boolean(busyAction) || !noticeDraft.trim()}
                className="cohort-admin-button cohort-admin-button--secondary"
              >
                {busyAction === "post-notice" ? <Loader2 size={14} className="cohort-admin-spin" /> : <Megaphone size={14} />}
                Post
              </button>
            </div>
            {notices.length === 0 ? (
              <div className="cohort-admin-mini-empty"><MessageSquareText size={20} /><strong>No notices yet</strong><span>Notices posted here appear on every participant's Base Camp page, with the date.</span></div>
            ) : (
              <div className="cohort-admin-people-list">
                {notices.map((notice) => (
                  <div key={notice.id} className="cohort-admin-expectation-row">
                    <span className="cohort-admin-avatar">{initials(notice.authorName)}</span>
                    <div>
                      <strong>{notice.authorName}</strong>
                      <p>{notice.message}</p>
                      <small>{formatStartDate(notice.createdAt.slice(0, 10))}</small>
                    </div>
                    <button
                      type="button"
                      onClick={() => void runMutation(`delete-notice:${notice.id}`, () => deleteCohortNotice(notice.id), { refetch: [fetchNotices] })}
                      disabled={Boolean(busyAction)}
                      aria-label="Remove notice"
                      title="Remove notice"
                    >
                      {busyAction === `delete-notice:${notice.id}` ? <Loader2 size={15} className="cohort-admin-spin" /> : <X size={15} />}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="cohort-admin-panel">
            <div className="cohort-admin-panel-head">
              <div><h3>Facilitators</h3><p>Name, designation and an optional PDF, shown to participants for this batch only.</p></div>
              <span>{facilitators.length}</span>
            </div>
            {role === "superadmin" && (
              <div className="cohort-admin-context-form">
                <label className="cohort-admin-field">
                  <span>Name</span>
                  <input value={facilitatorName} onChange={(event) => setFacilitatorName(event.target.value)} placeholder="Facilitator name" disabled={Boolean(busyAction)} />
                </label>
                <label className="cohort-admin-field">
                  <span>Designation</span>
                  <input value={facilitatorDesignation} onChange={(event) => setFacilitatorDesignation(event.target.value)} placeholder="e.g. Lead Facilitator, RCPL" disabled={Boolean(busyAction)} />
                </label>
                <FacilitatorPdfUploadField
                  cohortId={cohort.id}
                  onUploaded={(pdfUrl, pdfName) => {
                    setFacilitatorPdfUrl(pdfUrl);
                    setFacilitatorPdfName(pdfName);
                  }}
                  disabled={Boolean(busyAction)}
                  label={facilitatorPdfName || "Upload PDF (optional)"}
                />
                <button
                  type="button"
                  onClick={() => void handleAddFacilitator()}
                  disabled={Boolean(busyAction) || !facilitatorName.trim() || !facilitatorDesignation.trim()}
                  className="cohort-admin-button cohort-admin-button--primary"
                >
                  {busyAction === "add-facilitator" ? <Loader2 size={15} className="cohort-admin-spin" /> : <Plus size={15} />}
                  Add facilitator
                </button>
              </div>
            )}
            {facilitators.length === 0 ? (
              <div className="cohort-admin-mini-empty"><UserRound size={20} /><strong>No facilitators added</strong><span>Add facilitators running this specific batch.</span></div>
            ) : (
              <div className="cohort-admin-people-list">
                {facilitators.map((facilitator) => (
                  <div key={facilitator.id} className="cohort-admin-person">
                    <span className="cohort-admin-avatar">{initials(facilitator.name)}</span>
                    <div><strong>{facilitator.name}</strong><span>{facilitator.designation}</span></div>
                    {facilitator.pdfUrl && (
                      <a href={facilitator.pdfUrl} target="_blank" rel="noreferrer" className="cohort-admin-button cohort-admin-button--secondary">
                        <FileText size={14} /> View PDF
                      </a>
                    )}
                    <button
                      type="button"
                      onClick={() => void runMutation(`remove-facilitator:${facilitator.id}`, () => deleteFacilitator(cohort.id, facilitator.id), { refetch: [fetchFacilitators] })}
                      disabled={Boolean(busyAction)}
                      aria-label={`Remove ${facilitator.name}`}
                      title="Remove facilitator"
                    >
                      {busyAction === `remove-facilitator:${facilitator.id}` ? <Loader2 size={15} className="cohort-admin-spin" /> : <X size={15} />}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      ) : tab === "settings" ? (
        <div className="cohort-admin-picker-grid">
          <section className="cohort-admin-panel">
            <div className="cohort-admin-panel-head"><div><h3>Email sender name</h3><p>Shown as the "From" name on this batch's emails (reminders, recaps, notices). Leave blank to fall back to the assigned trainer, then "Nudgeable".</p></div></div>
            <div className="cohort-admin-panel-action">
              <label className="cohort-admin-field" style={{ flex: 1 }}>
                <span>Sender name <em>Optional</em></span>
                <input
                  value={senderName}
                  onChange={(event) => setSenderName(event.target.value)}
                  disabled={Boolean(busyAction)}
                  placeholder="Nudgeable"
                />
              </label>
              <button
                type="button"
                onClick={() => void handleSaveSenderName()}
                disabled={Boolean(busyAction) || senderName === (cohort.senderName ?? "")}
                className="cohort-admin-button cohort-admin-button--primary"
              >
                {busyAction === "save-sender-name" ? <Loader2 size={15} className="cohort-admin-spin" /> : <Check size={15} />}
                {busyAction === "save-sender-name" ? "Saving…" : "Save"}
              </button>
            </div>
          </section>

          {role === "superadmin" && (
            <section className="cohort-admin-panel cohort-admin-panel--wide">
              <div className="cohort-admin-panel-head">
                <div>
                  <h3>Email subjects</h3>
                  <p>
                    Subject lines for this batch's reminder emails, starting from the default. Edit a field to customise it, or use "Reset to default" to go back.
                    Placeholders: {BATCH_EMAIL_SUBJECT_VARIABLES.map((variable, index) => (
                      <span key={variable.key}>{index > 0 && ", "}<code title={variable.label}>{`{{${variable.key}}}`}</code></span>
                    ))}
                  </p>
                </div>
              </div>
              {BATCH_EMAIL_SUBJECT_KEYS.map((key) => {
                const option = BATCH_EMAIL_SUBJECT_OPTIONS[key];
                const value = subjectFieldValue(emailSubjects, key);
                const isDefault = !subjectOverride(emailSubjects, key);
                return (
                  <div key={key} className="cohort-admin-panel-action">
                    <label className="cohort-admin-field" style={{ flex: 1 }}>
                      <span>{option.label} <em>{option.description}</em></span>
                      <input
                        value={value}
                        onChange={(event) => setEmailSubjects((current) => ({ ...current, [key]: event.target.value }))}
                        disabled={Boolean(busyAction)}
                        maxLength={BATCH_EMAIL_SUBJECT_MAX}
                      />
                    </label>
                    <button
                      type="button"
                      onClick={() => setEmailSubjects((current) => ({ ...current, [key]: option.defaultSubject }))}
                      disabled={Boolean(busyAction) || isDefault}
                      className="cohort-admin-button cohort-admin-button--secondary"
                      title="Restore the default subject"
                    >
                      <X size={15} /> Reset to default
                    </button>
                  </div>
                );
              })}
              <div className="cohort-admin-panel-action">
                <button
                  type="button"
                  onClick={() => void handleSaveEmailSubjects()}
                  disabled={Boolean(busyAction) || !emailSubjectsDirty}
                  className="cohort-admin-button cohort-admin-button--primary"
                >
                  {busyAction === "save-email-subjects" ? <Loader2 size={15} className="cohort-admin-spin" /> : <Check size={15} />}
                  {busyAction === "save-email-subjects" ? "Saving…" : "Save subjects"}
                </button>
              </div>
            </section>
          )}

          {role === "superadmin" && (
            <section className="cohort-admin-panel cohort-admin-panel--wide">
              <div className="cohort-admin-panel-head">
                <div>
                  <h3>Action categories</h3>
                  <p>
                    Up to {MAX_ACTION_CATEGORIES} categories for this batch's actions. When a participant's plan is generated, the AI tags each action with the category that fits it best — they don't need to be spread evenly.
                    Participants can change an action's category when they edit it. Leave empty to skip categories. Applies to actions generated after saving.
                  </p>
                </div>
              </div>
              {actionCategories.map((category, index) => (
                <div key={index} className="cohort-admin-panel-action">
                  <label className="cohort-admin-field" style={{ flex: 1 }}>
                    <span>Category {index + 1}</span>
                    <input
                      value={category}
                      onChange={(event) => setActionCategories((current) => current.map((value, i) => (i === index ? event.target.value : value)))}
                      disabled={Boolean(busyAction)}
                      maxLength={ACTION_CATEGORY_MAX_LENGTH}
                      placeholder="e.g. Giving feedback"
                    />
                  </label>
                  <button
                    type="button"
                    onClick={() => setActionCategories((current) => current.filter((_, i) => i !== index))}
                    disabled={Boolean(busyAction)}
                    className="cohort-admin-button cohort-admin-button--secondary"
                    aria-label={`Remove category ${index + 1}`}
                    title="Remove category"
                  >
                    <X size={15} /> Remove
                  </button>
                </div>
              ))}
              <div className="cohort-admin-panel-action">
                <button
                  type="button"
                  onClick={() => setActionCategories((current) => [...current, ""])}
                  disabled={Boolean(busyAction) || actionCategories.length >= MAX_ACTION_CATEGORIES}
                  className="cohort-admin-button cohort-admin-button--secondary"
                >
                  <Plus size={15} /> Add category
                </button>
                <button
                  type="button"
                  onClick={() => void handleSaveActionCategories()}
                  disabled={Boolean(busyAction) || !actionCategoriesDirty}
                  className="cohort-admin-button cohort-admin-button--primary"
                >
                  {busyAction === "save-action-categories" ? <Loader2 size={15} className="cohort-admin-spin" /> : <Check size={15} />}
                  {busyAction === "save-action-categories" ? "Saving…" : "Save categories"}
                </button>
              </div>
            </section>
          )}

          <section className="cohort-admin-panel">
            <div className="cohort-admin-panel-head"><div><h3>Maximum plan duration</h3><p>Caps how many weeks a participant can choose when building their action plan for this batch. Leave blank to allow up to the platform default of 24 weeks.</p></div></div>
            <div className="cohort-admin-panel-action">
              <label className="cohort-admin-field" style={{ flex: 1 }}>
                <span>Maximum weeks <em>Optional, 2-24</em></span>
                <input
                  type="number"
                  min={2}
                  max={24}
                  value={maxWeeks}
                  onChange={(event) => setMaxWeeks(event.target.value)}
                  disabled={Boolean(busyAction)}
                  placeholder="24"
                />
              </label>
              <button
                type="button"
                onClick={() => void handleSaveMaxWeeks()}
                disabled={Boolean(busyAction) || maxWeeks === (cohort.maxWeeks != null ? String(cohort.maxWeeks) : "")}
                className="cohort-admin-button cohort-admin-button--primary"
              >
                {busyAction === "save-max-weeks" ? <Loader2 size={15} className="cohort-admin-spin" /> : <Check size={15} />}
                {busyAction === "save-max-weeks" ? "Saving…" : "Save"}
              </button>
            </div>
          </section>

          <section className="cohort-admin-panel cohort-admin-panel--wide">
            <div className="cohort-admin-panel-head">
              <div><h3>Team names</h3><p>Rename how a shared team's label appears just for this batch, without changing it anywhere else that team is used. {role === "superadmin" ? "" : "Only a superadmin can rename a team."}</p></div>
              <span>{cohortTags.length}</span>
            </div>
            {cohortTags.length === 0 ? (
              <div className="cohort-admin-mini-empty"><Users size={20} /><strong>No teams in this batch yet</strong><span>Assign a team to a member on the Members tab, then come back here to rename it.</span></div>
            ) : (
              <div className="cohort-admin-team-list" aria-label="Teams in this batch">
                {cohortTags.map((tag) => {
                  const effectiveName = teamNameOverrides[tag.id] ?? tag.name;
                  const isEditing = editingTeamId === tag.id;
                  return (
                    <div key={tag.id} className="cohort-admin-team-row">
                      {isEditing ? (
                        <>
                          <input
                            value={editingTeamName}
                            onChange={(event) => setEditingTeamName(event.target.value)}
                            aria-label={`Rename ${tag.name} for this batch`}
                            disabled={Boolean(busyAction)}
                            autoFocus
                          />
                          <button
                            type="button"
                            onClick={() => void handleSaveTeamName(tag.id)}
                            disabled={Boolean(busyAction) || !editingTeamName.trim()}
                            aria-label="Save team name"
                            className="cohort-admin-icon-button"
                          >
                            {busyAction === `save-team-name:${tag.id}` ? <Loader2 size={13} className="cohort-admin-spin" /> : <Check size={13} />}
                          </button>
                          <button type="button" onClick={cancelEditTeamName} disabled={Boolean(busyAction)} aria-label="Cancel rename" className="cohort-admin-icon-button">
                            <X size={13} />
                          </button>
                        </>
                      ) : (
                        <>
                          <span className="cohort-admin-team-name">
                            {effectiveName}
                            {teamNameOverrides[tag.id] && <em title={`Global team name: ${tag.name}`}> · renamed for this batch</em>}
                          </span>
                          {role === "superadmin" && (
                            <button
                              type="button"
                              onClick={() => startEditTeamName(tag)}
                              disabled={Boolean(busyAction)}
                              aria-label={`Rename ${effectiveName} for this batch`}
                              title="Rename for this batch"
                              className="cohort-admin-icon-button"
                            >
                              <Pencil size={13} />
                            </button>
                          )}
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </div>
      ) : tab === "agenda" ? (
        <div className="cohort-admin-generation-context">
          <section className="cohort-admin-panel">
            <div className="cohort-admin-panel-head">
              <div><h3>Program agenda</h3><p>Phases, days, and session blocks shown on this batch&apos;s Home/Journey page.</p></div>
            </div>
            <div className="cohort-admin-context-form">
              <div className="cohort-admin-notice">
                <Info size={17} />
                <p>
                  <strong>Shown only to this batch</strong>
                  <span>Paste a JSON array of phases — each needs at least an "id" and a "label". Leave it as <code>[]</code> to hide the agenda section entirely.</span>
                </p>
              </div>
              <label className="cohort-admin-field">
                <span>Current phase</span>
                <select
                  value={currentPhaseId}
                  onChange={(event) => setCurrentPhaseId(event.target.value)}
                  disabled={Boolean(busyAction)}
                  aria-label="Current phase"
                >
                  <option value="">No default (first phase shown)</option>
                  {agendaPhaseOptions.map((phase) => <option key={phase.id} value={phase.id}>{phase.label}</option>)}
                </select>
                <em>Selected automatically for participants on their Home page until changed here.</em>
              </label>
              <label className="cohort-admin-field">
                <span>Agenda JSON <em>Optional</em></span>
                <textarea
                  value={programPhasesJson}
                  onChange={(event) => setProgramPhasesJson(event.target.value)}
                  placeholder="[]"
                  rows={16}
                  spellCheck={false}
                  className="cohort-admin-json-field"
                  disabled={Boolean(busyAction)}
                />
              </label>
              <div className="cohort-admin-context-actions">
                <span>{draftAgendaPhases === null ? "This doesn't look like valid phase JSON yet." : `${draftAgendaPhases.length} phase${draftAgendaPhases.length === 1 ? "" : "s"} in this draft`}</span>
                <button
                  type="button"
                  onClick={() => void handleSaveAgenda()}
                  disabled={Boolean(busyAction)}
                  className="cohort-admin-button cohort-admin-button--primary"
                >
                  {busyAction === "save-agenda" ? <Loader2 size={15} className="cohort-admin-spin" /> : <Check size={15} />}
                  {busyAction === "save-agenda" ? "Saving…" : "Save agenda"}
                </button>
              </div>
            </div>
          </section>
        </div>
      ) : tab === "generation" ? (
        <div className="cohort-admin-generation-context">
          <section className="cohort-admin-panel">
            <div className="cohort-admin-panel-head">
              <div><h3>Action generation context</h3><p>These batch-level inputs are combined with each participant&apos;s private notes.</p></div>
            </div>
            <div className="cohort-admin-context-form">
              <div className="cohort-admin-notice"><Info size={17} /><p><strong>Used for every participant in this batch</strong><span>Training content defines the skill. Business context keeps each action realistic for the company and its work.</span></p></div>
              <label className="cohort-admin-field">
                <span>Training content <em>Optional</em></span>
                <textarea value={trainingContent} onChange={(event) => setTrainingContent(event.target.value)} placeholder="Add session topics, agenda, skills, and learning outcomes" rows={8} disabled={Boolean(busyAction)} />
              </label>
              <label className="cohort-admin-field">
                <span>Business context <em>Optional</em></span>
                <textarea value={businessContext} onChange={(event) => setBusinessContext(event.target.value)} placeholder="Add the company, industry, nature of the business, and realistic work situations" rows={8} disabled={Boolean(busyAction)} />
              </label>
              <div className="cohort-admin-context-actions">
                <span>{trainingContent.trim() || businessContext.trim() ? "Saved context improves action quality" : "Optional — actions can still generate from participant notes"}</span>
                <button
                  type="button"
                  onClick={() => void runMutation("save-generation-context", () => updateCohort(cohort.id, { trainingContent, businessContext }))}
                  disabled={Boolean(busyAction)}
                  className="cohort-admin-button cohort-admin-button--primary"
                >
                  {busyAction === "save-generation-context" ? <Loader2 size={15} className="cohort-admin-spin" /> : <Check size={15} />}
                  {busyAction === "save-generation-context" ? "Saving…" : "Save context"}
                </button>
              </div>
            </div>
          </section>
        </div>
      ) : (
        <div className="cohort-admin-buddy-mapping">
          <section className="cohort-admin-panel">
            <div className="cohort-admin-panel-head">
              <div>
                <h3>Commitment buddy mapping</h3>
                <p>Pairs are made automatically when the admin saves the participant list (pairs of two, plus one three-person cycle when the count is odd). You can change any pairing here.</p>
              </div>
              <span>{buddyRoster.filter((member) => member.buddyId).length}/{buddyRoster.length} paired</span>
            </div>

            <div className="cohort-admin-notice">
              <Info size={17} />
              <p>
                <strong>Pairs and cycles</strong>
                <span>Select people below in order. Two people makes a normal pair — each sees the other. Three or more makes a cycle: each person sees only the next one, wrapping back to the first (e.g. A → B → C → A), instead of everyone seeing everyone.</span>
              </p>
            </div>

            {buddyError && (
              <div className="cohort-admin-alert cohort-admin-alert--error cohort-admin-alert--inner" role="alert">
                <AlertCircle size={17} /><div><strong>Unable to load buddy mapping</strong><span>{buddyError}</span></div>
                <button type="button" onClick={() => void fetchBuddyRoster()}>Retry</button>
              </div>
            )}

            {buddyLoading && buddyRoster.length === 0 ? (
              <div className="cohort-admin-detail-loading" aria-busy="true">
                <Loader2 size={18} className="cohort-admin-spin" /><span>Loading buddy mapping…</span>
              </div>
            ) : buddyRoster.length === 0 ? (
              <div className="cohort-admin-mini-empty"><Handshake size={20} /><strong>No members yet</strong><span>Add participants to this batch before pairing buddies.</span></div>
            ) : (
              <>
                <div className="cohort-admin-people-list">
                  {buddyRoster.map((member) => {
                    const orderIndex = buddySelection.indexOf(member.id);
                    const selected = orderIndex !== -1;
                    return (
                      <div key={member.id} className={`cohort-admin-buddy-row${selected ? " is-selected" : ""}`}>
                        <button
                          type="button"
                          className="cohort-admin-buddy-row-select"
                          aria-pressed={selected}
                          onClick={() => toggleBuddySelection(member.id)}
                          disabled={Boolean(busyAction)}
                        >
                          <span className={`cohort-admin-checkbox cohort-admin-checkbox--order${selected ? " is-checked" : ""}`}>
                            {selected ? orderIndex + 1 : ""}
                          </span>
                          <span className="cohort-admin-avatar">{initials(member.fullName)}</span>
                          <span className="cohort-admin-select-row-copy">
                            <strong>{member.fullName || "Unnamed user"}</strong>
                            {member.email && <small>{member.email}</small>}
                          </span>
                        </button>
                        <div className="cohort-admin-buddy-pills">
                          {member.buddyId ? (
                            <span className="cohort-admin-buddy-pill"><ArrowRight size={11} /> {member.buddyName || "Batch member"}</span>
                          ) : (
                            <span className="cohort-admin-buddy-pill cohort-admin-buddy-pill--empty">Unpaired</span>
                          )}
                          {member.seenBy.length > 0 && (
                            <span
                              className="cohort-admin-buddy-pill cohort-admin-buddy-pill--incoming"
                              title={`Seen by ${member.seenBy.map((seer) => seer.name || "Batch member").join(", ")}`}
                            >
                              <ArrowLeft size={11} /> {member.seenBy.map((seer) => seer.name || "Batch member").join(", ")}
                            </span>
                          )}
                        </div>
                        {member.buddyId && (
                          <button
                            type="button"
                            className="cohort-admin-buddy-remove"
                            onClick={() => void handleRemoveBuddyAssignment(member.id)}
                            disabled={Boolean(busyAction)}
                            aria-label={`Unpair ${member.fullName || "member"}`}
                            title="Unpair"
                          >
                            {busyAction === `remove-buddy:${member.id}` ? <Loader2 size={13} className="cohort-admin-spin" /> : <X size={13} />}
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>

                <div className="cohort-admin-panel-action cohort-admin-buddy-tray">
                  <span>
                    {buddySelection.length === 0
                      ? "Select people above, in order, to build a pairing"
                      : buddySelection.length === 1
                      ? "Select at least one more person"
                      : buddyCirclePreview(
                          buddySelection.map((id) => {
                            const name = buddyRoster.find((member) => member.id === id)?.fullName;
                            return name?.split(/\s+/)[0] || "Member";
                          })
                        )}
                  </span>
                  <div className="cohort-admin-buddy-tray-actions">
                    {buddySelection.length > 0 && (
                      <button
                        type="button"
                        onClick={() => setBuddySelection([])}
                        disabled={Boolean(busyAction)}
                        className="cohort-admin-button cohort-admin-button--secondary"
                      >
                        Clear
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => void handleSaveBuddyPairing()}
                      disabled={Boolean(busyAction) || buddySelection.length < 2}
                      className="cohort-admin-button cohort-admin-button--primary"
                    >
                      {busyAction === "save-buddy-pairing" ? <Loader2 size={15} className="cohort-admin-spin" /> : <Handshake size={15} />}
                      {busyAction === "save-buddy-pairing" ? "Saving…" : buddySelection.length >= 3 ? "Save cycle" : "Save pairing"}
                    </button>
                  </div>
                </div>
              </>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
