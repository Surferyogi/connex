-- ============================================================================
-- Connex — database schema (run once in the Supabase SQL editor)
-- Separate accounts, per-user private data enforced by Row Level Security.
-- ============================================================================

-- 1) CARDS TABLE -------------------------------------------------------------
create table if not exists public.cards (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users (id) on delete cascade default auth.uid(),

  -- Extracted contact fields. NULL means "not detected on the card".
  -- The app never invents values; absent fields stay NULL.
  full_name       text,
  name_phonetic   text,            -- furigana / romanization if printed
  job_title       text,
  department      text,
  company         text,
  emails          text[]  default '{}',
  phones          jsonb   default '[]'::jsonb,  -- [{ "label": "mobile", "number": "+81..." }]
  website         text,
  address         text,
  notes           text,

  -- Free-form labels the user assigns (e.g. "client", "tokyo", "supplier").
  tags            text[]  not null default '{}',

  -- Audit / honesty: the full raw structured result returned by the model,
  -- so you can always see exactly what was detected vs. edited by hand.
  raw_extraction  jsonb,
  model_used      text,

  -- Path (not URL) of the stored card photo inside the 'card-images' bucket.
  image_path      text,
  image_path_back text,            -- optional photo of the back of the card

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

alter table public.cards enable row level security;

-- A user can only ever see or touch their own rows.
drop policy if exists "cards_select_own" on public.cards;
create policy "cards_select_own" on public.cards
  for select using (auth.uid() = user_id);

drop policy if exists "cards_insert_own" on public.cards;
create policy "cards_insert_own" on public.cards
  for insert with check (auth.uid() = user_id);

drop policy if exists "cards_update_own" on public.cards;
create policy "cards_update_own" on public.cards
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "cards_delete_own" on public.cards;
create policy "cards_delete_own" on public.cards
  for delete using (auth.uid() = user_id);

create index if not exists cards_user_created_idx
  on public.cards (user_id, created_at desc);

create index if not exists cards_tags_idx
  on public.cards using gin (tags);

-- keep updated_at honest
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists trg_cards_touch on public.cards;
create trigger trg_cards_touch
  before update on public.cards
  for each row execute function public.touch_updated_at();


-- 2) STORAGE BUCKET FOR CARD PHOTOS -----------------------------------------
-- Private bucket. Files are read via short-lived signed URLs from the app.
insert into storage.buckets (id, name, public)
values ('card-images', 'card-images', false)
on conflict (id) do nothing;

-- Each user may only access objects under a top-level folder equal to their uid:
--   card-images/<auth.uid()>/<uuid>.jpg
drop policy if exists "card_images_select_own" on storage.objects;
create policy "card_images_select_own" on storage.objects
  for select using (
    bucket_id = 'card-images'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "card_images_insert_own" on storage.objects;
create policy "card_images_insert_own" on storage.objects
  for insert with check (
    bucket_id = 'card-images'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "card_images_update_own" on storage.objects;
create policy "card_images_update_own" on storage.objects
  for update using (
    bucket_id = 'card-images'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "card_images_delete_own" on storage.objects;
create policy "card_images_delete_own" on storage.objects
  for delete using (
    bucket_id = 'card-images'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
