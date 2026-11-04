/**
 * "Done" taps on WhatsApp reminders → the action is completed in the app,
 * with no login or redirect, and the chat continues with the actions still
 * open (Option A in docs/WHATSAPP_REMINDERS_PLAN.md):
 *
 *   reminder: 1️⃣ … 2️⃣ … 3️⃣ …   [Action 1 done] [Action 2 done] [Action 3 done]
 *   tap "Action 2 done" → "✅ Saved: 2️⃣ …  2 actions left: 1️⃣ 3️⃣"
 *                          + [Action 1 done] [Action 3 done]
 *   tap "Action 3 done" → "✅ Saved: 3️⃣ …  1 action left: 1️⃣" + [Action 1 done]
 *   tap "Action 1 done" → "✅ Saved: 1️⃣ …  🎉 all done"
 *
 * Every Done payload carries the whole reminder's action list plus which
 * number was tapped ("done:<n>:<id1>,<id2>,…", ids without dashes), so the
 * follow-ups keep the reminder's original numbering without storing anything.
 * Follow-ups are free-form interactive messages: the tap opened the 24-hour
 * window, so they need no template.
 *
 * Settlement runs in complete_action_for_user
 * (supabase/migrations/085_complete_action_for_user.sql; 087 redefines it to
 * mark user_actions.completed_via = 'whatsapp'), which calls the
 * same RPCs as completeAction() in app/actions/user-actions.ts. The profile
 * points and feed event below mirror the rest of completeAction — keep the
 * two in sync.
 */
import type { createAdminClient } from "@/lib/supabase/admin";
import { getPointsForEvent } from "@/lib/points";

type AdminClient = ReturnType<typeof createAdminClient>;

const DONE_PAYLOAD_PREFIX = "done:";
const COMPACT_ID = /^[0-9a-f]{32}$/;
/** Matches MAX_ACTIONS_PER_TEMPLATE: a reminder carries at most three actions. */
const MAX_REMINDER_ACTIONS = 3;

function compactId(id: string) {
  return id.replace(/-/g, "").toLowerCase();
}

function expandId(compact: string) {
  return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`;
}

/** Payload for the Done button of action number `number` (1-based) in a reminder. */
export function doneButtonPayload(reminderActionIds: string[], number: number): string {
  const ids = reminderActionIds.slice(0, MAX_REMINDER_ACTIONS).map(compactId).join(",");
  return `${DONE_PAYLOAD_PREFIX}${number}:${ids}`;
}

export type DoneTap = {
  /** The tapped action's number in the original reminder (1-based). */
  number: number;
  actionId: string;
  /** Every action in that reminder, in its numbered order. */
  reminderActionIds: string[];
};

/** Decodes a Done button/list payload, or null for anything else. */
export function parseDonePayload(payload: string | null | undefined): DoneTap | null {
  if (!payload?.startsWith(DONE_PAYLOAD_PREFIX)) return null;
  const [numberPart, idsPart, ...rest] = payload.slice(DONE_PAYLOAD_PREFIX.length).split(":");
  if (rest.length || !idsPart) return null;
  const compactIds = idsPart.split(",");
  if (!compactIds.length || compactIds.length > MAX_REMINDER_ACTIONS || !compactIds.every((id) => COMPACT_ID.test(id))) {
    return null;
  }
  const number = Number(numberPart);
  if (!Number.isInteger(number) || number < 1 || number > compactIds.length) return null;
  const reminderActionIds = compactIds.map(expandId);
  return { number, actionId: reminderActionIds[number - 1], reminderActionIds };
}

const RECAP_ALL_PREFIX = "all:";
const RECAP_SOME_PREFIX = "some:";

/** Payload of the Friday recap's "All done" button. */
export function recapAllPayload(actionIds: string[]): string {
  return `${RECAP_ALL_PREFIX}${actionIds.slice(0, MAX_REMINDER_ACTIONS).map(compactId).join(",")}`;
}

/** Payload of the Friday recap's "Some done" button. */
export function recapSomePayload(actionIds: string[]): string {
  return `${RECAP_SOME_PREFIX}${actionIds.slice(0, MAX_REMINDER_ACTIONS).map(compactId).join(",")}`;
}

export type RecapTap = { kind: "all" | "some"; actionIds: string[] };

/** Decodes a recap "All done" / "Some done" payload, or null for anything else. */
export function parseRecapPayload(payload: string | null | undefined): RecapTap | null {
  const kind = payload?.startsWith(RECAP_ALL_PREFIX) ? "all" : payload?.startsWith(RECAP_SOME_PREFIX) ? "some" : null;
  if (!kind || !payload) return null;
  const compactIds = payload.slice((kind === "all" ? RECAP_ALL_PREFIX : RECAP_SOME_PREFIX).length).split(",");
  if (compactIds.length > MAX_REMINDER_ACTIONS || !compactIds.every((id) => COMPACT_ID.test(id))) return null;
  return { kind, actionIds: compactIds.map(expandId) };
}

export type WhatsAppCompletion =
  | { outcome: "completed"; title: string; pointsAdded: number; completedLate: boolean; surpriseBoxUnlocked: boolean }
  | { outcome: "already_done"; title: string }
  | { outcome: "not_assigned" | "unsupported"; title: string | null };

type CompletionRow = {
  result: "completed" | "already_done" | "not_assigned" | "unsupported";
  settle_path: "legacy" | "wallet" | "validated" | null;
  points_added: number;
  completed_late: boolean;
  surprise_unlock_id: string | null;
  previous_status: string | null;
  action_title: string | null;
  action_cohort_id: string | null;
};

async function addProfilePoints(admin: AdminClient, userId: string, delta: number) {
  if (!delta) return;
  const { data: profile } = await admin.from("profiles").select("total_points").eq("id", userId).single();
  if (!profile) return;
  await admin
    .from("profiles")
    .update({ total_points: Math.max(0, (profile.total_points || 0) + delta), last_active_at: new Date().toISOString() })
    .eq("id", userId);
}

/**
 * Completes one action for the participant who tapped Done. Throws only if
 * the settlement itself fails (so the webhook can let Meta retry); the
 * follow-up points/feed writes are best effort, like completeAction's.
 */
export async function completeActionFromWhatsApp(
  admin: AdminClient,
  userId: string,
  actionId: string
): Promise<WhatsAppCompletion> {
  const { data, error } = await admin.rpc("complete_action_for_user", { p_user_id: userId, p_action_id: actionId });
  if (error) throw new Error(`complete action: ${error.message}`);
  const row = (Array.isArray(data) ? data[0] : data) as CompletionRow | null;
  if (!row) throw new Error("complete action: no result");

  const title = row.action_title ?? "your action";
  if (row.result === "already_done") return { outcome: "already_done", title };
  if (row.result !== "completed") return { outcome: row.result, title: row.action_title };

  try {
    // Same follow-up as completeAction: older plans only post the feed event;
    // wallet plans also add profile points (the action was already accepted,
    // since it was on the participant's plan).
    if (row.settle_path !== "legacy") {
      const alreadyAccepted = ["scheduled", "success", "failed"].includes(row.previous_status ?? "");
      if (!alreadyAccepted) await addProfilePoints(admin, userId, getPointsForEvent("accept", false));
      await addProfilePoints(admin, userId, getPointsForEvent("success"));
    }
    if (row.action_title) {
      await admin.from("feed_events").insert({
        user_id: userId,
        cohort_id: row.action_cohort_id,
        action_title: row.action_title,
        type: "SUCCESS",
      });
    }
  } catch (followUpError) {
    console.error("[whatsapp-completion] follow-up writes failed", followUpError);
  }

  return {
    outcome: "completed",
    title,
    pointsAdded: row.points_added,
    completedLate: row.completed_late,
    surpriseBoxUnlocked: !!row.surprise_unlock_id,
  };
}

export type ReminderActionState = { number: number; id: string; title: string; done: boolean };

/** The reminder's actions, in their original numbering, with which are done now. */
export async function loadReminderActionStates(
  admin: AdminClient,
  userId: string,
  reminderActionIds: string[]
): Promise<ReminderActionState[]> {
  const [{ data: actions, error: actionError }, { data: userActions, error: userActionError }] = await Promise.all([
    admin.from("actions").select("id, title").in("id", reminderActionIds),
    admin.from("user_actions").select("action_id, status").eq("user_id", userId).in("action_id", reminderActionIds),
  ]);
  if (actionError || userActionError) {
    throw new Error(`load reminder actions: ${actionError?.message ?? userActionError?.message}`);
  }
  const titles = new Map((actions ?? []).map((action) => [action.id as string, action.title as string]));
  const statuses = new Map((userActions ?? []).map((row) => [row.action_id as string, row.status as string]));
  return reminderActionIds.map((id, index) => ({
    number: index + 1,
    id,
    title: titles.get(id) ?? "Action",
    done: statuses.get(id) === "success",
  }));
}

/** A free-form WhatsApp message: plain text, or an interactive object for sendWhatsAppInteractive. */
export type FollowUpMessage = { kind: "text"; body: string } | { kind: "interactive"; interactive: Record<string, unknown> };

const MAX_BODY = 1024;
const NUMBER_EMOJI = ["0️⃣", "1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣"];

/** 1 → "1️⃣", matching the reminder template's numbering. */
function numberEmoji(number: number) {
  return NUMBER_EMOJI[number] ?? `${number})`;
}

function truncate(value: string, max: number) {
  return value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value;
}

/**
 * The message sent after a Done tap: what was saved, the reminder's actions
 * still open (original numbers) and an "Action N done" reply button for each. A reminder
 * has at most three actions, which is also WhatsApp's reply-button limit.
 */
export function buildCompletionFollowUp(params: {
  completion: WhatsAppCompletion;
  tappedNumber: number;
  actions: ReminderActionState[];
}): FollowUpMessage {
  const { completion, tappedNumber, actions } = params;
  if (completion.outcome === "not_assigned" || completion.outcome === "unsupported") {
    return {
      kind: "text",
      body: "We couldn't update that action from WhatsApp. Please open Nudgeable and mark it done there.",
    };
  }

  const tappedTitle = actions.find((action) => action.number === tappedNumber)?.title ?? completion.title;
  const lines =
    completion.outcome === "completed"
      ? [`✅ Saved! Action ${tappedNumber} is marked done:`, `${numberEmoji(tappedNumber)} ${tappedTitle}`]
      : [`👍 Action ${tappedNumber} was already marked done:`, `${numberEmoji(tappedNumber)} ${tappedTitle}`];
  // No points or Surprise Box lines: the reply only confirms the action (the
  // box still unlocks and shows in the app as usual).
  if (completion.outcome === "completed" && completion.completedLate) {
    lines.push("Recorded as completed after its assigned day.");
  }

  const open = actions.filter((action) => !action.done);
  if (!open.length) {
    lines.push("", "🎉 Well done, you've completed all your actions! Keep the momentum going.");
    return { kind: "text", body: lines.join("\n") };
  }

  // Same layout as the reminder: number emoji, a blank line between actions.
  // ("1 action left:" rather than "Still open (1):", which read like an empty
  // "action (1)".)
  lines.push("", `${open.length} action${open.length === 1 ? "" : "s"} left:`);
  for (const action of open) lines.push("", `${numberEmoji(action.number)} ${action.title}`);
  // Same instruction as the reminder template.
  lines.push(
    "",
    open.length === 1
      ? "✅ When you complete it, click the button below to update its status as done."
      : "✅ When you complete an action, click its button below to update its status as done."
  );
  return doneButtonsMessage(lines, actions);
}

/** `lines` as the body, with an "Action N done" reply button per open action. */
function doneButtonsMessage(lines: string[], actions: ReminderActionState[]): FollowUpMessage {
  const allIds = actions.map((action) => action.id);
  return {
    kind: "interactive",
    interactive: {
      type: "button",
      body: { text: truncate(lines.join("\n"), MAX_BODY) },
      action: {
        buttons: actions
          .filter((action) => !action.done)
          .map((action) => ({
            type: "reply",
            reply: { id: doneButtonPayload(allIds, action.number), title: `Action ${action.number} done` },
          })),
      },
    },
  };
}

/**
 * The reply to the Friday recap's "All done" tap. Every action was tried, so
 * this only reports: saved, already saved, or couldn't be done from WhatsApp.
 */
export function buildRecapAllDoneFollowUp(completions: WhatsAppCompletion[]): FollowUpMessage {
  const saved = completions.filter((completion) => completion.outcome === "completed");
  const blocked = completions.filter(
    (completion) => completion.outcome === "not_assigned" || completion.outcome === "unsupported"
  ).length;
  const total = completions.length;
  const noun = `action${total === 1 ? "" : "s"}`;

  if (blocked) {
    const lines = saved.length ? [`✅ Saved! ${saved.length} of your ${total} ${noun} marked done.`, ""] : [];
    lines.push(
      `We couldn't update ${blocked === 1 ? "1 action" : `${blocked} actions`} from WhatsApp. Please open Nudgeable and mark ${blocked === 1 ? "it" : "them"} done there.`
    );
    return { kind: "text", body: lines.join("\n") };
  }

  const lines = saved.length
    ? [total === 1 ? "✅ Saved! Your action is marked done." : `✅ Saved! All ${total} actions are marked done.`]
    : [total === 1 ? "👍 Your action was already marked done." : `👍 All ${total} actions were already marked done.`];
  if (saved.some((completion) => completion.completedLate)) {
    lines.push("Anything past its assigned day is recorded as completed late.");
  }
  lines.push("", "🎉 Well done, you've completed all your actions! Have a good weekend.");
  return { kind: "text", body: lines.join("\n") };
}

/**
 * The reply to the Friday recap's "Some done" tap: the actions still open with
 * a Done button each. Those taps then run the normal Done flow above.
 */
export function buildRecapSomeDoneFollowUp(actions: ReminderActionState[]): FollowUpMessage {
  const open = actions.filter((action) => !action.done);
  if (!open.length) return { kind: "text", body: "👍 All your actions are already marked done. Have a good weekend." };
  const lines = [open.length === 1 ? "Have you completed this one?" : "Which ones have you completed?"];
  for (const action of open) lines.push("", `${numberEmoji(action.number)} ${action.title}`);
  return doneButtonsMessage(lines, actions);
}
