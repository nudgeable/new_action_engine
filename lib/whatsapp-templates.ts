/**
 * WhatsApp message templates used by the app (Phase 3 of
 * docs/WHATSAPP_REMINDERS_PLAN.md). The templates live on the "Nudgeable AI"
 * WhatsApp account and are reviewed by Meta; what's here must match them
 * exactly — same names, language, placeholder order and button order.
 *
 * Template parameters can't contain line breaks, so each action gets its own
 * line in the template itself. A participant has at most three current actions,
 * so there is one template per count: plan_reminder_1 … plan_reminder_3
 * (UTILITY, en) — three buttons, all shown inline. plan_reminder_3:
 *
 *   (no header — the message starts directly with the greeting)
 *   Body:    Hi {{1}} 👋, this is your scheduled reminder. These actions from
 *            your {{2}} plan are due {{3}}:     ({{2}} company, {{3}} this week|today)
 *
 *            1) {{4}}
 *
 *            2) {{5}}
 *
 *            3) {{6}}
 *
 *            When you complete an action, click its button below to update
 *            its status as done.
 *   Footer:  Reply STOP to turn off WhatsApp reminders
 *   Buttons: QUICK_REPLY "Action 1 done", "Action 2 done", "Action 3 done" —
 *            each payload is set per message (doneButtonPayload: the tapped
 *            number + every action in the reminder), so a tap completes that
 *            action via the webhook and the follow-up lists the rest
 *            (lib/whatsapp-action-completion.ts). No link to the app: the
 *            participant stays in WhatsApp.
 *
 * plan_reminder_1 is singular and unnumbered ("This action from your {{2}}
 * plan is due {{3}}:", "When you complete it, click the button below to
 * update its status as done.", one "Action done" button).
 *
 * KEEP THE UTILITY ANCHORS. Meta only treats a template as UTILITY when it is
 * clearly about the user's own account/transaction and has no promotional or
 * persuasive intent; vague content is MARKETING. Two drafts were reclassified:
 *   - action_reminder_company: motivational/brand lines ("Nudgie here!",
 *     "Small steps, real change 💪");
 *   - action_checklist_1…3: "Hi {{1}} 👋 your {{2}} actions are ready:" with
 *     number emoji and ✅ — it dropped "this is your scheduled reminder",
 *     "from your plan" and "are due …", which tie the message to the
 *     participant's own scheduled plan.
 * So: keep those three phrases, keep emoji to the greeting, no hype.
 * (Unused earlier sets: action_reminder_1…5 without buttons; action_done_1…3,
 * UTILITY but with a company header that can't be removed by editing.)
 *
 * Should a reminder ever have more than three actions, it uses
 * plan_reminder_3 with "(+N more)" on the last line, and only the first
 * three get Done buttons.
 *
 * The Friday recap has its own set, plan_recap_1 … plan_recap_3 (UTILITY, en),
 * with the same anchors. plan_recap_3:
 *
 *   Body:    Hi {{1}} 👋, this is your scheduled weekly reminder. These actions
 *            from your {{2}} plan are due this week and are still open:
 *
 *            1) {{3}}
 *
 *            2) {{4}}
 *
 *            3) {{5}}
 *
 *            If you have completed them, click a button below to update their
 *            status as done.
 *   Footer:  Reply STOP to turn off WhatsApp reminders
 *   Buttons: QUICK_REPLY "All done", "Some done"
 *
 * plan_recap_1 is singular and unnumbered, with one "Action done" button that
 * works like a reminder's. Two buttons rather than one per action plus "All
 * done": four buttons would collapse behind "See all options".
 */
import { doneButtonPayload, recapAllPayload, recapSomePayload } from "@/lib/whatsapp-action-completion";

export const ACTION_REMINDER_LANGUAGE = "en";
/** Equals MAX_WEEKLY_ACTIONS in lib/personal-action-generation.ts. */
export const MAX_ACTIONS_PER_TEMPLATE = 3;

function templateSlots(actionCount: number): number {
  return Math.min(Math.max(actionCount, 1), MAX_ACTIONS_PER_TEMPLATE);
}

export function actionReminderTemplateName(actionCount: number): string {
  return `plan_reminder_${templateSlots(actionCount)}`;
}

export function weeklyRecapTemplateName(actionCount: number): string {
  return `plan_recap_${templateSlots(actionCount)}`;
}

/** Template parameters can't contain newlines/tabs or 4+ consecutive spaces. */
export function sanitizeTemplateParam(value: string, maxLength: number): string {
  const clean = value.replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ").trim();
  return clean.length > maxLength ? `${clean.slice(0, maxLength - 1).trimEnd()}…` : clean;
}

const MAX_TITLE_LENGTH = 120;

/**
 * One parameter per action line. Beyond three, the third line carries
 * "(+N more)" so nobody thinks the list is complete.
 */
export function actionLines(titles: string[]): string[] {
  const lines = titles
    .slice(0, MAX_ACTIONS_PER_TEMPLATE)
    .map((title) => sanitizeTemplateParam(title, MAX_TITLE_LENGTH));
  const remaining = titles.length - lines.length;
  if (remaining > 0) {
    const last = lines.length - 1;
    lines[last] = `${sanitizeTemplateParam(lines[last], MAX_TITLE_LENGTH - 12)} (+${remaining} more)`;
  }
  return lines;
}

export type TemplateComponent =
  | { type: "body"; parameters: { type: "text"; text: string }[] }
  | { type: "button"; sub_type: "quick_reply"; index: string; parameters: { type: "payload"; payload: string }[] };

export type TemplateMessage = {
  template: { name: string; language: string };
  components: TemplateComponent[];
};

/**
 * The template and send-time components for one action reminder. Callers
 * pass only the plan's current actions for that batch (same set the reminder
 * email lists); at least one is required.
 */
export function buildActionReminder(params: {
  firstName: string | null;
  /** "from your {{company}} plan"; falls back to "Nudgeable". */
  companyName: string | null;
  track: "daily" | "weekly";
  actions: { id: string; title: string }[];
}): TemplateMessage {
  if (!params.actions.length) throw new Error("An action reminder needs at least one action");
  const lines = actionLines(params.actions.map((action) => action.title));
  const buttonActionIds = params.actions.slice(0, lines.length).map((action) => action.id);
  const doneButtons = buttonActionIds.map(
    (_actionId, index): TemplateComponent => ({
      type: "button",
      sub_type: "quick_reply",
      index: String(index),
      parameters: [{ type: "payload", payload: doneButtonPayload(buttonActionIds, index + 1) }],
    })
  );
  return {
    template: { name: actionReminderTemplateName(lines.length), language: ACTION_REMINDER_LANGUAGE },
    components: [
      {
        type: "body",
        parameters: [
          { type: "text", text: sanitizeTemplateParam(params.firstName || "there", 40) },
          { type: "text", text: sanitizeTemplateParam(params.companyName || "Nudgeable", 40) },
          { type: "text", text: params.track === "daily" ? "today" : "this week" },
          ...lines.map((text) => ({ type: "text" as const, text })),
        ],
      },
      ...doneButtons,
    ],
  };
}

function quickReply(index: number, payload: string): TemplateComponent {
  return { type: "button", sub_type: "quick_reply", index: String(index), parameters: [{ type: "payload", payload }] };
}

/**
 * The template and send-time components for one Friday recap. Callers pass
 * the plan's current actions; at least one is required.
 */
export function buildWeeklyRecap(params: {
  firstName: string | null;
  companyName: string | null;
  actions: { id: string; title: string }[];
}): TemplateMessage {
  if (!params.actions.length) throw new Error("A weekly recap needs at least one action");
  const lines = actionLines(params.actions.map((action) => action.title));
  const actionIds = params.actions.slice(0, lines.length).map((action) => action.id);
  return {
    template: { name: weeklyRecapTemplateName(lines.length), language: ACTION_REMINDER_LANGUAGE },
    components: [
      {
        type: "body",
        parameters: [
          { type: "text", text: sanitizeTemplateParam(params.firstName || "there", 40) },
          { type: "text", text: sanitizeTemplateParam(params.companyName || "Nudgeable", 40) },
          ...lines.map((text) => ({ type: "text" as const, text })),
        ],
      },
      ...(actionIds.length === 1
        ? [quickReply(0, doneButtonPayload(actionIds, 1))]
        : [quickReply(0, recapAllPayload(actionIds)), quickReply(1, recapSomePayload(actionIds))]),
    ],
  };
}
