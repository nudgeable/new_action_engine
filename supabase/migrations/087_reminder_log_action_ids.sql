-- Which actions each reminder listed, so the admin dashboard can say exactly when
-- a participant saw a given action (the email's opened_at / the WhatsApp read_at).
--
-- Filled at send time by lib/email-send.ts (daily_reminder, weekly_recap) and
-- lib/whatsapp-reminders.ts (action_reminder, action_reminder_manual). NULL for
-- rows sent before this column existed and for messages that list no actions;
-- getParticipantActionTimeline falls back to matching those by send time.

ALTER TABLE public.email_campaign_logs
  ADD COLUMN IF NOT EXISTS action_ids UUID[];

ALTER TABLE public.whatsapp_message_logs
  ADD COLUMN IF NOT EXISTS action_ids UUID[];

CREATE INDEX IF NOT EXISTS idx_email_campaign_logs_action_ids
  ON public.email_campaign_logs USING GIN (action_ids) WHERE action_ids IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_whatsapp_message_logs_action_ids
  ON public.whatsapp_message_logs USING GIN (action_ids) WHERE action_ids IS NOT NULL;

COMMENT ON COLUMN public.email_campaign_logs.action_ids IS
  'Actions listed in this email (daily_reminder / weekly_recap), recorded at send time. NULL for older rows and other templates.';
COMMENT ON COLUMN public.whatsapp_message_logs.action_ids IS
  'Actions listed in this WhatsApp reminder, recorded at send time. NULL for older rows and non-reminder messages.';
