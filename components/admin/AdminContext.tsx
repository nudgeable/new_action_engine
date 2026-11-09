"use client";

import React, { createContext, useContext, useMemo, useState, useEffect, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { Building2 } from "lucide-react";
import { BatchModuleSelects, BatchSelector, useBatchOptions } from "@/components/admin/BatchSelector";
import AdminStepLoader from "@/components/admin/AdminStepLoader";

const COMPANY_STORAGE_KEY = "nudgeable:admin:companyId";
const COHORT_STORAGE_KEY = "nudgeable:admin:cohortId";
// Set only when a batch was picked through an explicit user action (the
// BatchPickerGate pop-out, or the top-bar switcher afterwards) — never by
// the hydration restore itself. A stored cohort id without this flag means
// it was left over from before this confirmation step existed, so it's
// ignored on restore instead of silently skipping the pop-out.
const CONFIRMED_STORAGE_KEY = "nudgeable:admin:batchConfirmed";
// Who confirmed the remembered batch. A remembered batch only counts for that
// same user, so anyone else signing in on this tab still gets the pop-out.
const OWNER_STORAGE_KEY = "nudgeable:admin:batchOwner";
// General "working on it" checklist shown while a batch's dashboard loads.
// Purely for engagement: steps tick off on loose, randomised timers and the
// last one keeps running until the data is really ready.
const BATCH_LOADING_STEPS = [
  "Reading batch records",
  "Finding participants",
  "Searching activity",
  "Checking data",
  "Sorting results",
  "Calculating stats",
  "Generating charts",
  "Almost ready",
] as const;

/** Clears the remembered company/batch selection so the next login always
 * lands back on the BatchPickerGate pop-out instead of silently reusing
 * whatever was picked in a previous session on this tab. Call on logout. */
export function clearAdminBatchSelection() {
  if (typeof window === "undefined") return;
  sessionStorage.removeItem(COMPANY_STORAGE_KEY);
  sessionStorage.removeItem(COHORT_STORAGE_KEY);
  sessionStorage.removeItem(CONFIRMED_STORAGE_KEY);
  sessionStorage.removeItem(OWNER_STORAGE_KEY);
}

interface Company {
  id: string;
  name: string;
  slug: string | null;
}

interface AdminContextType {
  companies: Company[];
  role: string;
  userCompanyId: string | null;
  selectedCompanyId: string | null;
  setSelectedCompanyId: (id: string | null) => void;
  /** True when the company is chosen outside this context (the superadmin
   * console's top-bar selector), so the built-in company switcher hides. */
  companyControlled: boolean;
  effectiveCompanyId: string | null;
  selectedCohortId: string | null;
  setSelectedCohortId: (id: string | null) => void;
  /** True once the active view's own data has finished loading. Views with
   * their own background fetches (Dashboard, Engagement, Cohort Analytics)
   * report into this so BatchPickerGate can keep a single loading screen up
   * until everything is actually ready, instead of assuming a batch pick
   * means the data is there. Views that don't opt in leave this at its
   * default `true`, so they're never blocked. */
  viewReady: boolean;
  setViewReady: (ready: boolean) => void;
  /** Where a view wants the context bar placed. A view with its own header row
   * registers an element here and AdminContextBar moves into it; views that
   * don't leave it null and the bar keeps its own row above them. */
  contextBarSlot: HTMLElement | null;
  setContextBarSlot: (slot: HTMLElement | null) => void;
}

const AdminContext = createContext<AdminContextType | null>(null);

export function useAdminContext() {
  const context = useContext(AdminContext);
  if (!context) {
    throw new Error("useAdminContext must be used within AdminContextProvider");
  }
  return context;
}

export function useOptionalAdminContext() {
  return useContext(AdminContext);
}

/** Resolve the batch a page should show: the globally selected one when it
 * still exists, otherwise the first batch in the current company list. */
export function useSelectedAdminBatch<T extends { id: string }>(cohorts: T[]) {
  const { selectedCohortId, setSelectedCohortId } = useAdminContext();
  const activeId = useMemo(() => {
    if (selectedCohortId && cohorts.some((cohort) => cohort.id === selectedCohortId)) {
      return selectedCohortId;
    }
    return cohorts[0]?.id ?? null;
  }, [cohorts, selectedCohortId]);
  const selectedCohort = useMemo(
    () => cohorts.find((cohort) => cohort.id === activeId) ?? null,
    [cohorts, activeId]
  );
  return { selectedCohortId: activeId, setSelectedCohortId, selectedCohort };
}

interface AdminContextProviderProps {
  children: React.ReactNode;
  companies: Company[];
  role: string;
  companyId: string | null;
  /** When provided, the selected company is owned by the caller (the
   * superadmin console's top-bar selector) instead of this context. */
  controlledCompanyId?: string | null;
  /** The signed-in user — a remembered batch is only restored for them. */
  userId?: string | null;
}

export function AdminContextProvider({
  children,
  companies,
  role,
  companyId,
  controlledCompanyId,
  userId,
}: AdminContextProviderProps) {
  const companyControlled = controlledCompanyId !== undefined;
  const [uncontrolledCompanyId, setSelectedCompanyIdState] = useState<string | null>(null);
  const selectedCompanyId = companyControlled ? controlledCompanyId : uncontrolledCompanyId;
  const [selectedCohortId, setSelectedCohortIdState] = useState<string | null>(null);
  const [viewReady, setViewReady] = useState(true);
  const [contextBarSlot, setContextBarSlot] = useState<HTMLElement | null>(null);
  const selectedCompanyIdRef = useRef<string | null>(null);
  const hydratedRef = useRef(false);
  selectedCompanyIdRef.current = selectedCompanyId;

  useEffect(() => {
    if (hydratedRef.current) return;
    hydratedRef.current = true;
    const storedCompany = sessionStorage.getItem(COMPANY_STORAGE_KEY);
    const storedCohort = sessionStorage.getItem(COHORT_STORAGE_KEY);
    const storedOwner = sessionStorage.getItem(OWNER_STORAGE_KEY);
    const wasConfirmed =
      sessionStorage.getItem(CONFIRMED_STORAGE_KEY) === "1" && (!userId || storedOwner === userId);
    if (role === "superadmin" && !companyControlled) {
      const nextCompany =
        storedCompany && companies.some((company) => company.id === storedCompany)
          ? storedCompany
          : companies[0]?.id ?? null;
      selectedCompanyIdRef.current = nextCompany;
      setSelectedCompanyIdState(nextCompany);
      if (nextCompany) sessionStorage.setItem(COMPANY_STORAGE_KEY, nextCompany);
    }
    // Only restore a remembered batch if it was explicitly confirmed — a
    // cohort id left over from before this pop-out existed (or from a
    // partial/older session) must not silently skip the picker.
    if (storedCohort && wasConfirmed) {
      setSelectedCohortIdState(storedCohort);
    } else if (storedCohort) {
      sessionStorage.removeItem(COHORT_STORAGE_KEY);
    }
  }, [role, companies, companyControlled, userId]);

  // A controlled company change invalidates the picked batch, exactly like
  // setSelectedCompanyId does for the built-in switcher.
  const previousControlledRef = useRef(controlledCompanyId);
  useEffect(() => {
    if (!companyControlled || previousControlledRef.current === controlledCompanyId) return;
    previousControlledRef.current = controlledCompanyId;
    setSelectedCohortIdState(null);
    setViewReady(true);
    sessionStorage.removeItem(COHORT_STORAGE_KEY);
    sessionStorage.removeItem(CONFIRMED_STORAGE_KEY);
  }, [companyControlled, controlledCompanyId]);

  const setSelectedCompanyId = useCallback((id: string | null) => {
    if (selectedCompanyIdRef.current === id) return;
    selectedCompanyIdRef.current = id;
    setSelectedCompanyIdState(id);
    setSelectedCohortIdState(null);
    setViewReady(true);
    sessionStorage.removeItem(COHORT_STORAGE_KEY);
    sessionStorage.removeItem(CONFIRMED_STORAGE_KEY);
    if (id) sessionStorage.setItem(COMPANY_STORAGE_KEY, id);
    else sessionStorage.removeItem(COMPANY_STORAGE_KEY);
  }, []);

  const setSelectedCohortId = useCallback((id: string | null) => {
    setSelectedCohortIdState(id);
    // A newly picked batch hasn't loaded anything yet — don't let the
    // previous batch's (now stale) data or "ready" state show through while
    // the new one's fetches are still in flight.
    setViewReady(false);
    // Only ever called from an explicit user action (the picker pop-out or
    // the top-bar switcher), so it's safe to mark this as confirmed.
    sessionStorage.setItem(CONFIRMED_STORAGE_KEY, "1");
    if (userId) sessionStorage.setItem(OWNER_STORAGE_KEY, userId);
    if (id) sessionStorage.setItem(COHORT_STORAGE_KEY, id);
    else sessionStorage.removeItem(COHORT_STORAGE_KEY);
  }, [userId]);

  const effectiveCompanyId = role === "superadmin" ? selectedCompanyId : companyId;

  return (
    <AdminContext.Provider
      value={{
        companies,
        role,
        userCompanyId: companyId,
        selectedCompanyId,
        setSelectedCompanyId,
        companyControlled,
        effectiveCompanyId,
        selectedCohortId,
        setSelectedCohortId,
        viewReady,
        setViewReady,
        contextBarSlot,
        setContextBarSlot,
      }}
    >
      {children}
    </AdminContext.Provider>
  );
}

export function CompanySelector() {
  const { companies, role, selectedCompanyId, setSelectedCompanyId, companyControlled } =
    useAdminContext();

  if (role !== "superadmin" || companies.length === 0 || companyControlled) {
    return null;
  }

  return (
    <div className="flex items-center gap-2 bg-white rounded-xl px-3 py-2 min-w-0" style={{ border: "1px solid var(--color-border)", boxShadow: "var(--shadow-sm)" }}>
      <Building2 size={15} strokeWidth={2} style={{ color: "var(--color-text-muted)" }} />
      <select
        value={selectedCompanyId ?? ""}
        onChange={(e) => setSelectedCompanyId(e.target.value || null)}
        className="text-sm font-semibold bg-transparent outline-none cursor-pointer min-w-0 max-w-xs"
        style={{ color: "var(--color-text-primary)" }}
        aria-label="Company"
      >
        <option value="">Select company…</option>
        {companies.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
    </div>
  );
}

export function AdminContextBar() {
  const { companies, role, effectiveCompanyId, selectedCohortId, setSelectedCohortId, companyControlled, contextBarSlot } =
    useAdminContext();

  const showCompany = role === "superadmin" && companies.length > 0 && !companyControlled;
  if (!showCompany && !effectiveCompanyId) return null;

  const bar = (
    <div className="flex flex-wrap items-center justify-end gap-3">
      <CompanySelector />
      {effectiveCompanyId && (
        <BatchSelector
          companyId={effectiveCompanyId}
          value={selectedCohortId}
          onChange={setSelectedCohortId}
        />
      )}
    </div>
  );

  return contextBarSlot ? createPortal(bar, contextBarSlot) : bar;
}

/**
 * Never assumes a batch: blocks the actual view from being *shown* until the
 * admin has explicitly chosen a company + batch/module from a pop-out — no
 * batch gets auto-picked, and nothing renders on a guess. Once confirmed,
 * the view mounts and fetches in the background behind a loading screen;
 * the gate only reveals it once the view reports (via `viewReady`) that its
 * data has actually finished loading, instead of assuming the pick alone
 * means the data is there.
 */
export function BatchPickerGate({ children }: { children: React.ReactNode }) {
  const {
    companies,
    role,
    selectedCompanyId,
    setSelectedCompanyId,
    effectiveCompanyId,
    selectedCohortId,
    setSelectedCohortId,
    viewReady,
  } = useAdminContext();

  const [draftCompanyId, setDraftCompanyId] = useState<string | null>(effectiveCompanyId);
  const [draftCohortId, setDraftCohortId] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    setDraftCompanyId(effectiveCompanyId);
    // A newly resolved/changed company always needs its own explicit batch
    // pick — don't let a stale "dismissed" hide the gate for it.
    setDismissed(false);
  }, [effectiveCompanyId]);

  const { options, loading } = useBatchOptions(draftCompanyId);

  // Superadmins jump between companies/batches far more often than a
  // company admin does — the pop-out and the background-load screen exist
  // to stop a company admin's dashboard from flashing "all batches" data
  // before settling on their one real batch, which doesn't apply the same
  // way here. Superadmin keeps the plain top-bar switcher instead.
  const needsCompanyPick = role === "superadmin" ? false : companies.length > 0 && !effectiveCompanyId;
  const needsBatchPick =
    role !== "superadmin" && !!effectiveCompanyId && !loading && options.length > 0 && selectedCohortId === null && !dismissed;
  const showPicker = needsCompanyPick || needsBatchPick;

  if (!showPicker) {
    return (
      <>
        {/* Mounted so its fetches run in the background; visually covered by
            the loading screen below until it reports itself ready. */}
        {children}
        {role !== "superadmin" && !viewReady && (
          <AdminStepLoader steps={BATCH_LOADING_STEPS} />
        )}
      </>
    );
  }

  function handleContinue() {
    if (role === "superadmin" && draftCompanyId && draftCompanyId !== selectedCompanyId) {
      setSelectedCompanyId(draftCompanyId);
    }
    setSelectedCohortId(draftCohortId);
    setDismissed(true);
  }

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center p-4"
      style={{ top: 0, left: 0, right: 0, bottom: 0, width: "100vw", height: "100vh", background: "rgba(12,15,20,0.6)", backdropFilter: "blur(2px)" }}
    >
      <div className="bg-white rounded-2xl w-full max-w-md p-6 space-y-5" style={{ boxShadow: "var(--shadow-lg)" }}>
        <div className="space-y-1">
          <h3 className="text-lg font-bold" style={{ color: "var(--color-text-primary)" }}>
            Select a batch to continue
          </h3>
          <p className="text-sm" style={{ color: "var(--color-text-muted)" }}>
            Which batch do you want to work on? You can change it any time from the top right corner.
          </p>
        </div>

        <div className="space-y-3">
          {role === "superadmin" && companies.length > 0 && (
            <label className="block space-y-1">
              <span className="text-xs font-semibold uppercase tracking-wide" style={{ color: "var(--color-text-muted)" }}>
                Company
              </span>
              <div className="flex items-center gap-2 rounded-xl px-3 py-2.5" style={{ border: "1px solid var(--color-border)" }}>
                <Building2 size={15} strokeWidth={2} style={{ color: "var(--color-text-muted)" }} />
                <select
                  value={draftCompanyId ?? ""}
                  onChange={(e) => {
                    setDraftCompanyId(e.target.value || null);
                    setDraftCohortId(null);
                  }}
                  className="w-full text-sm font-semibold bg-transparent outline-none cursor-pointer"
                  style={{ color: "var(--color-text-primary)" }}
                >
                  <option value="">Select company…</option>
                  {companies.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>
            </label>
          )}

          {draftCompanyId && (
            <BatchModuleSelects
              idPrefix="gate"
              options={options}
              loading={loading}
              value={draftCohortId}
              onChange={setDraftCohortId}
              stacked
            />
          )}
        </div>

        <button
          type="button"
          disabled={!draftCompanyId || !draftCohortId || loading}
          onClick={handleContinue}
          className="w-full rounded-xl py-2.5 text-sm font-bold transition-all disabled:opacity-50 disabled:cursor-not-allowed"
          style={{ background: "var(--bright-amber)", color: "var(--color-text-primary)" }}
        >
          Continue
        </button>
      </div>
    </div>,
    document.body
  );
}

export function AdminShell({
  children,
  companies,
  role,
  companyId,
  userId,
}: AdminContextProviderProps) {
  return (
    <AdminContextProvider companies={companies} role={role} companyId={companyId} userId={userId}>
      <div className="max-w-7xl mx-auto w-full space-y-4">
        <AdminContextBar />
        <NoCompanyWarning />
        <BatchPickerGate>{children}</BatchPickerGate>
      </div>
    </AdminContextProvider>
  );
}

export function NoCompanyWarning() {
  const { role, userCompanyId } = useAdminContext();

  if (role !== "admin" || userCompanyId) {
    return null;
  }

  return (
    <div className="card__inset flex items-start gap-3" style={{ borderColor: "var(--color-border-yellow)", background: "rgba(255,206,0,0.07)" }}>
      <div className="w-2 h-2 rounded-full mt-1.5 flex-shrink-0" style={{ background: "var(--bright-amber)" }} />
      <p className="text-sm font-semibold" style={{ color: "var(--color-text-accent)" }}>
        You are not assigned to a company. Contact your superadmin to get access.
      </p>
    </div>
  );
}
