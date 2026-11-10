-- Per-batch action categories. A superadmin lists up to five categories in the
-- batch's Settings tab; when generating a participant's plan the AI tags each
-- action with whichever one fits best (no even split required). Participants
-- can change an action's category from the edit popup. An empty list turns
-- the feature off for that batch, and actions keep a NULL category.
-- See lib/action-categories.ts.

ALTER TABLE public.cohorts
  ADD COLUMN IF NOT EXISTS action_categories TEXT[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN public.cohorts.action_categories IS
  'Superadmin-set categories (max 5) the AI picks from when generating this batch''s personal actions. Empty means actions are not categorised.';

ALTER TABLE public.actions
  ADD COLUMN IF NOT EXISTS category TEXT;

COMMENT ON COLUMN public.actions.category IS
  'One of the batch''s cohorts.action_categories, chosen by the AI at generation time and editable by the participant. NULL when the batch has no categories.';
