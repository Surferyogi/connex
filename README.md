# Connex — business card scanner (PWA)

Scan a business card with your phone camera, let Claude read the details, store
the card photo and fields in your own Supabase database (synced across all your
Apple devices), and add the contact to iOS Contacts after you confirm.

Stack: React + Vite (frontend, GitHub Pages) · Supabase (Postgres + Storage +
Auth + Edge Function) · Claude `claude-sonnet-4-6` for extraction.

---

## Build status — read this first

- Every source file was syntax/JSX-validated with esbuild and passes cleanly.
- The full production build (`vite build`) was **not** run in the environment it
  was authored in (the sandbox network couldn't finish installing React/Vite).
  **Run `npm install && npm run build` on your machine as the real check.**
- No fabricated values anywhere: any card field Claude can't read is stored as
  `null`, and the raw model output is kept in `raw_extraction` for audit.

---

## What you need

- Node 18+ and npm
- A Supabase account (a new, dedicated project for this app)
- An Anthropic API key (stored only as a Supabase secret — never in the frontend)
- A GitHub repo with Pages enabled (for hosting), plus an iPhone/iPad to install it

---

## 1. Create the Supabase project + database

1. Create a **new** Supabase project (Singapore region keeps it near your other
   apps; pick whatever you prefer).
2. Open **SQL Editor**, paste the contents of `supabase/schema.sql`, and run it.
   This creates the `cards` table, the private `card-images` storage bucket, and
   the Row Level Security policies that keep your data and Sophia's fully
   separate (each row/object is bound to `auth.uid()`).
3. In **Authentication → Providers**, make sure **Email** is enabled. Create an
   account each (e.g. your `koksum@` address and Sophia's gmail) — either by
   signing up inside the app, or via the Auth dashboard. If you'd rather skip the
   email-confirmation step, turn off "Confirm email" in Auth settings.

## 2. Deploy the OCR Edge Function (keeps the API key server-side)

Install the Supabase CLI, then from the project root:

```bash
supabase login
supabase link --project-ref YOUR_PROJECT_REF

# Secrets live on the server only — never commit these:
supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
# optional override (defaults to claude-sonnet-4-6):
# supabase secrets set CLAUDE_MODEL=claude-sonnet-4-6

# Deploy WITH JWT verification (the default — do NOT pass --no-verify-jwt),
# so only signed-in users can spend your API budget:
supabase functions deploy scan-card
```

## 3. Configure + run the frontend

```bash
cp .env.example .env
# edit .env with your project's URL and ANON (public) key from
# Supabase → Project Settings → API
npm install
npm run dev          # local preview (see note on base path below)
```

The anon key is meant to be public; RLS is what protects your data. The secret
service-role key and the Anthropic key must never appear in the frontend.

## 4. Deploy to GitHub Pages

1. In `vite.config.js`, set `base` to `"/<your-repo-name>/"` (it's `"/connex/"`
   by default).
2. Build and publish:

```bash
npm run build        # outputs to dist/
npm run deploy       # publishes dist/ to the gh-pages branch via gh-pages
```

3. In the repo's **Settings → Pages**, serve from the `gh-pages` branch.

> For local `npm run dev`/`npm run preview` you can temporarily set `base` to
> `"/"`. Remember to set it back to `"/<repo>/"` before building for Pages.

## 5. Install on your iPhone/iPad

Open the `https://<you>.github.io/<repo>/` URL in **Safari** → Share → **Add to
Home Screen**. Sign in with the account you created. Data syncs across every
device signed into the same account.

---

## Using it

- **Scan a card** opens the camera (it uses the native camera picker, which is
  the reliable path on iOS). If the camera ever misbehaves in the installed app,
  open the same URL in Safari instead — a known WebKit quirk affects camera
  access in installed PWAs.
- **Review** shows exactly what was read. Blank = not detected; nothing is
  guessed. Edit anything, then **Save card** (you'll see the seal stamp).
- **Add to Contacts** builds a UTF-8 vCard (so Japanese/Korean/Chinese names
  stay intact) and opens the share sheet → choose **Contacts**, then **Save**.
  If it downloads instead, open the `.vcf`, tap the share/actions icon, and
  choose Contacts — iOS hides the save action behind that icon.

## Costs

Extraction calls Claude per scan. As of the build date, `claude-sonnet-4-6` is
priced at $3 / $15 per million input/output tokens (source: Anthropic docs —
verify current pricing at https://www.anthropic.com/pricing before relying on
per-scan estimates). A downscaled card image plus the JSON response is a small
number of tokens per scan.

## Security checklist

- Anon key in `.env`/frontend: fine (public, gated by RLS).
- `ANTHROPIC_API_KEY`: Supabase secret only. If it's ever exposed, rotate it
  immediately and re-run `supabase secrets set`.
- Edge Function deployed with JWT verification on, so anonymous callers can't
  burn your API quota.

## Maintenance

- Version stamp lives in `src/App.jsx` as `APP_VERSION`. Update it on every edit
  to App.jsx using the `vYYYY:MM:DD-HH:MM` (Asia/Tokyo) convention. Current:
  `v2026:06:19-11:14`.
- After redeploying, clear the old service-worker cache if a device shows a
  stale build (or bump the `CACHE` name in `public/sw.js`).

## File map

```
connex/
  index.html                       app shell, PWA + iOS meta, fonts
  vite.config.js                   base path for GitHub Pages
  package.json                     scripts: dev / build / preview / deploy
  .env.example                     frontend Supabase config template
  public/
    manifest.webmanifest           PWA manifest
    sw.js                          minimal offline app-shell cache
    icon-192/512, maskable, apple-touch-icon
  src/
    main.jsx                       entry + service worker registration
    App.jsx                        all screens + logic (version stamp here)
    styles.css                     ink/paper/seal design system
    supabaseClient.js              Supabase client from env
    api.js                         image processing, scan, CRUD, storage
    vcard.js                       UTF-8 vCard + Contacts hand-off
  supabase/
    schema.sql                     tables, RLS, storage bucket + policies
    functions/scan-card/index.ts   OCR via Claude (key server-side)
```
