# WhatsApp Action Reminders — Plan

Goal: send the participant action reminder (today an email from
`sendDailyActionReminders` in `lib/action-reminders.ts`, on the participant's
chosen weekday — or every weekday on the daily track) over WhatsApp as well,
using the WhatsApp Cloud API on the **Nudgeable consulting** business.

Reference: https://developers.facebook.com/documentation/business-messaging/whatsapp/overview

## Key platform constraints

- Business-initiated messages outside the 24-hour customer-service window must
  be **approved templates**. A reminder is always outside that window, so it is
  a template (category: utility).
- Template variables cannot contain newlines, so the WhatsApp reminder is a
  short summary plus a link, not the full email.
- Explicit **opt-in** is required before sending, naming the business and what
  will be sent.
- Delivery status (sent / delivered / read / failed) and user replies only
  arrive via **webhook**.
- Default limits: 80 msg/s per number; ~1 message per 6 s to the same user
  (error 131056); retry failed sends after 4^n seconds. Unverified businesses
  get lower daily send limits.

## Phases

### Phase 0 — Meta setup
- Meta app with the WhatsApp use case, linked to the Nudgeable consulting business portfolio.
- Add + register the business phone number; create a system user token
  (`business_management`, `whatsapp_business_messaging`, `whatsapp_business_management`).
- Start Business Verification in parallel.

### Phase 1 — Webhook ✅ (verified end to end on the preview deployment)
- `app/api/webhooks/whatsapp/route.ts`: GET verification handshake, POST with
  `X-Hub-Signature-256` check; parsing in `lib/whatsapp-webhook.ts`.
- `supabase/migrations/082_whatsapp_webhook.sql`: `whatsapp_message_logs`
  (status per wamid, forward-only), `whatsapp_inbound_messages`,
  `whatsapp_webhook_events`.
- Env: `WHATSAPP_WEBHOOK_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET`.
- Done when: a `hello_world` test send shows sent → delivered → read in
  `whatsapp_message_logs`, and a reply appears in `whatsapp_inbound_messages`.

### Phase 2 — Phone numbers + opt-in ✅ (this branch)
- `supabase/migrations/083_whatsapp_contacts.sql`: `whatsapp_contacts` (one
  number per participant, unique; `opted_out_at` set by STOP) and
  `personal_action_subscriptions.whatsapp_reminders_enabled` /
  `whatsapp_opted_in_at` (per-plan choice; existing plans default off).
- Admin: superadmin → Users → Edit user → **WhatsApp number** (default the
  participant sees; list shows the number and a STOP badge).
- Plan setup (`components/Onboarding.tsx`): **Send my reminders on WhatsApp**,
  ticked by default (unticked if they previously replied STOP), with the
  admin's number pre-filled and editable. Saved by `saveGeneratedActions`.
- My Actions → Plan overview (`components/WhatsAppRemindersCard.tsx`): turn
  WhatsApp off/on or change the number at any time, even after finalising.
- Webhook (`lib/whatsapp-inbound.ts`): STOP / UNSUBSCRIBE pauses WhatsApp for
  every plan; START resumes and re-enables their unarchived plans. Only newly
  received messages are acted on, so Meta retries can't double-process.
- Numbers are normalised to digits with country code; a bare 10-digit number
  is assumed Indian (+91).
- **Phase 4 sends a WhatsApp reminder only when** the plan has
  `whatsapp_reminders_enabled`, the person has a number, and
  `opted_out_at IS NULL`.
- Env: `WHATSAPP_PHONE_NUMBER_ID` (shows the options), `WHATSAPP_ACCESS_TOKEN`
  (confirmation replies now, reminders in Phase 4).

### Phase 3 — Templates ✅ submitted (pending Meta review)
Template parameters can't contain line breaks, so each action needs its own
line in the template itself: one UTILITY template per action count, chosen by
`buildActionReminder()` in `lib/whatsapp-templates.ts`.

| Template | Id | Lines |
|---|---|---|
| `action_reminder_1` | 3561293904030778 | 1 (singular, unnumbered) |
| `action_reminder_2` | 3696282903855083 | 2 |
| `action_reminder_3` | 1703608441293691 | 3 |
| `action_reminder_4` | 1969471500396295 | 4 |
| `action_reminder_5` | 28562238106732647 | 5 (6+ actions: "(+N more)" on line 5) |

- Header: "Your {{1}} actions are ready" ({{1}} company; falls back to "Nudgeable").
- Body: "Hi {{1}}, this is your scheduled reminder. These actions from your plan
  are due {{2}}: / 1) {{3}} / 2) {{4}} … / Open Nudgeable to see how to do each
  one and mark them done when you finish." — {{2}} "this week" | "today".
- Footer: "Reply STOP to turn off WhatsApp reminders".
- URL button "View my actions" →
  `https://practice.nudgeable.ai/api/auto-login?next=%2Factions&key={{1}}`
  (persistent login key, same as reminder emails); Meta link tracking off.
- **Wording must stay strictly factual.** `action_reminder_company` added
  "Nudgie here!", "Small steps, real change 💪" and emoji, and Meta approved it
  as MARKETING instead of UTILITY (utility = no promotional or persuasive
  intent; mixed content → marketing). Repeated misclassification can get the
  business's utility templates restricted. Earlier drafts `action_reminder`
  (UTILITY) and `action_reminder_company` (MARKETING) are not used by the code.
- Approval/rejection arrives on the webhook as
  `message_template_status_update` (stored in `whatsapp_webhook_events`).

### Phase 4 — Sending ✅ (this branch)
- `lib/whatsapp-reminders.ts` `sendWhatsAppActionReminders()`, called from the
  daily cron (`app/api/cron/email-scheduler/route.ts`) right after the batch
  release and before the Resend check, so WhatsApp doesn't depend on email.
- Mirrors the reminder email exactly: active, unarchived plans linked to a
  batch; same days (`reminderDaysFor()` in `lib/reminder-days.ts`, shared with the email); same actions
  (`buildReminderActionContext()`: the plan's current actions in that batch).
- Sends only when `whatsapp_reminders_enabled`, a number exists, and
  `opted_out_at IS NULL`; skips plans with no current actions.
- Template `action_reminder_N` by action count via `buildActionReminder()`;
  company from the batch's company; button = persistent login key.
- `supabase/migrations/084_whatsapp_reminder_claims.sql`: one claim per plan
  per IST day (`claim_whatsapp_reminder`), separate from the email claim;
  failed sends retried by a rerun after 15 min, max 3 attempts. The claim
  stores the wamid; delivery/read/failure lands in `whatsapp_message_logs`.
- The cron response includes a `whatsappReminders` summary (sent, failed,
  skipped: not due / no number / opted out / empty / already claimed).
- Plans not linked to a batch get no reminders on either channel (existing
  email behaviour, kept as is).

### Phase 5 — Admin + extras
- ✅ Superadmin → Emails & reminders → **WhatsApp reminders** tab
  (`app/(app)/superadmin/whatsapp-reminders-panel.tsx`,
  `app/actions/whatsapp-reminders-admin.ts`):
  - Upcoming: every active plan with WhatsApp on — number, batch, schedule,
    next 11:30 send, the exact actions and template it will use, or why it
    can't be sent (no number, replied STOP, no current actions, no login key).
  - **Send WhatsApp now** for selected participants: same content as the cron
    (shared `prepareWhatsAppReminders` / `sendPreparedWhatsAppReminder`), can
    be repeated, doesn't use up the automatic reminder (no daily claim).
  - Delivery history: every reminder (automatic or sent now) with the
    webhook's sent / delivered / read / failed status and Meta error.
- Later: bulk CSV import of numbers; optional per-cohort rollout flag.

### Option A — "Done" buttons complete actions from WhatsApp (this branch)
- A participant has at most three current actions (weekly plans are capped at
  3 per week), so the reminder uses one of three UTILITY templates,
  `plan_reminder_1…3` — no header, no app link or login key:
  "Hi {{1}} 👋, this is your scheduled reminder. These actions from your {{2}}
  plan are due {{3}}:" ({{2}} company, {{3}} "this week" | "today"), then each
  action as "1) {{4}}" with a blank line between, then "When you complete an
  action, click its button below to update its status as done.", footer
  "Reply STOP to turn off WhatsApp reminders", and one QUICK_REPLY button per
  action ("Action done" / "Action 1 done"…"Action 3 done"), all inline.
  Submitted for review: `plan_reminder_1` (2571905986564041),
  `plan_reminder_2` (1101638012755695), `plan_reminder_3` (1449500153780527).
- **Utility anchors:** "this is your scheduled reminder", "from your … plan"
  and "are due …" tie the message to the participant's own plan. Two drafts
  without them were approved as MARKETING (`action_reminder_company`,
  `action_checklist_1…3` — the latter with "your {{2}} actions are ready",
  number emoji and ✅). Earlier unused sets: `action_reminder_1…5` (no
  buttons), `action_done_1…3` (UTILITY, but with a company header that can't
  be removed by editing), `action_checkin_1…3` (deleted).
- Each payload is set per message to `done:<n>:<id1>,<id2>,<id3>` — the tapped
  number plus every action in that reminder (ids without dashes) — so
  follow-ups keep the original numbering with nothing stored.
- A tap arrives on the webhook; `lib/whatsapp-inbound.ts` maps the sender's
  number → participant (`whatsapp_contacts`), completes the action
  (`completeActionFromWhatsApp`) and replies, free-form (the tap opened the
  24-hour window, no template): "✅ Saved! Action 2 is marked done" (no points
  or Surprise Box line),
  "2 actions left: 1️⃣ … 3️⃣ …" with [Action 1 done] [Action 3 done]; repeats per tap until
  "🎉 Well done, you've completed all your actions! Keep the momentum going." (`buildCompletionFollowUp`).
- `supabase/migrations/085_complete_action_for_user.sql`:
  `complete_action_for_user(user, action)` acts as the participant for one
  transaction and calls the same RPCs as the app's `completeAction`
  (older scored plans / wallet on time or late / Pending validation →
  validated / Surprise Box unlock). Service role only. Profile points and the
  feed event are added in TypeScript, mirroring `completeAction`.
- Only actions on that participant's plan can be completed; repeat taps reply
  "already marked done" with the same still-open list.
- If a reminder ever had more than three actions, line 3 reads "(+N more)" and
  only the first three get buttons.
- `action_reminder_1…5` (approved, no buttons) are kept but no longer used.

### Friday recap on WhatsApp
- Same people and actions as the reminder: active, unarchived plans in a batch
  with WhatsApp on, a number and no STOP, listing the plan's current actions
  (at most three; Pending validation actions are not listed, as in the email).
  Nothing is sent to a plan with no open actions.
- Sent at 12:30 IST on Fridays by the weekly-recap cron, alongside the recap
  email and before its Resend check. `sendWhatsAppWeeklyRecap()` in
  `lib/whatsapp-reminders.ts`.
- **The recap replaces the Friday WhatsApp reminder** (11:30), so nobody gets
  the same list twice an hour apart. The reminder email is unchanged.
- **Rollout switch:** `WHATSAPP_WEEKLY_RECAP_ENABLED=true` turns on both the
  automatic recap and the Friday reminder skip. Leave it unset until all three
  templates are approved, or Friday's WhatsApp would fail with nothing sent.
  Send now in superadmin works regardless, for testing after approval.
- Templates (UTILITY, en, no header, footer "Reply STOP to turn off WhatsApp
  reminders"): `plan_recap_1` (1160616259725238), `plan_recap_2`
  (1876617937038332), `plan_recap_3` (2353028508434770). Wording is in
  `lib/whatsapp-templates.ts`. Submitted 2026-11-04. Scores and progress stay
  out of them to keep them UTILITY. If Meta approves them as MARKETING, don't
  turn the recap on.
- Buttons: `plan_recap_1` has "Action done" (a normal `done:` payload).
  `plan_recap_2…3` have "All done" (`all:<ids>`) and "Some done" (`some:<ids>`),
  two buttons because four would collapse behind "See all options".
  - All done completes each action in turn, with no confirm step and no undo.
    If one fails, Meta's retry repeats the tap and the finished ones return
    already_done.
  - Some done replies with the open actions and a Done button each, which then
    run the normal Done flow.
- `supabase/migrations/088_whatsapp_recap_claims.sql`: own claims, one per plan
  per Friday. `whatsapp_reminder_claims` can't be reused: it's unique per plan
  per day, so the two would collide.
- Saturday catch-up: the daily cron runs the recap again on Saturday, claiming
  against the same Friday, so failed or missed sends go out once. It also
  reaches anyone with open actions who turned WhatsApp on after Friday's run.
- Superadmin → WhatsApp reminders has a **Friday recap** switch: upcoming, Send
  now (`weekly_recap_manual`) and delivery history share the reminder views.
