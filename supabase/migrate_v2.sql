-- ============================================================================
-- Connex — migration v2: back-of-card image + tags
-- Run once in the Supabase SQL Editor on your EXISTING project.
-- Safe and additive: existing rows are untouched (back = NULL, tags = empty).
-- ============================================================================

alter table public.cards
  add column if not exists image_path_back text;

alter table public.cards
  add column if not exists tags text[] not null default '{}';

-- Fast lookups when filtering by tag.
create index if not exists cards_tags_idx
  on public.cards using gin (tags);
