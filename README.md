# Connex — business card scanner (PWA)

Scan a business card with your phone camera, let Claude read the details, store
the card photo and fields in your own Supabase database (synced across your
Apple devices), and hand the contact off to iOS Contacts after you confirm.

**Live:** https://surferyogi.github.io/connex/
**Repo:** https://github.com/surferyogi/connex
**Supabase project ref:** `pvqwpzbjremcyobnsldd`
**Current version:** `v2026:06:20-01:36`  ·  Last updated: 2026-06-20

Stack: React + Vite (frontend, GitHub Pages) · Supabase (Postgres + Storage +
Auth + Edge Function) · Claude `claude-sonnet-4-6` for extraction.

---

## How it works (the chain)

1. **Capture** — the "Scan a card" button uses the native camera file input
   (`capture="environment"`), not a live `getUserMedia` stream, because the live
   camera is unreliable inside an installed iOS PWA.
2. **Extract** — the image is downscaled in the browser, then sent to the
   `scan-card` Supabase Edge Function, which calls Claude. The Anthropic API key
   lives only as a Supabase secret — it never reaches the frontend.
3. **Review** — extracted fields appear for you to check/edit. Anything Claude
   couldn't read is left blank (never guessed); the raw model output is stored in
   `raw_extraction` for audit.
4. **Save** — fields go to the `cards` table; the photo goes to the private
   `card-images` bucket. Both are isolated per user by Row Level Security.
5. **Add to Contacts** — builds a UTF-8 vCard and opens it so iOS shows the
   contact, after your confirmation. See the iOS note below.

Separate accounts for the two of you; each account sees only its own cards,
synced across every device signed into that account.

---

## Updating the app (READ THIS — it caused real confusion once)

**main vs gh-pages:**
- `main` branch = source code (a backup). Editing it changes nothing live.
- `gh-pages` branch = the built site your devices actually load.
- **Only `npm run deploy` rebuilds and publishes.** A web commit on GitHub does
  NOT update the live app on its own.

**Edit in ONE place.** Editing the same files both on the Mac and on the GitHub
website creates a split where `git pull` refuses to merge ("local changes would
be overwritten"). Pick one workflow and stick to it:

Preferred — always edit on the Mac:
```bash
cd ~/Downloads/connex
# ...make edits...
git add -A && git commit -m "what changed"
git push          # backs up source to main
npm run deploy    # rebuilds + publishes to gh-pages (this is the one that matters)
```

If you ever DID edit on the GitHub website, sync the Mac before building:
```bash
git pull          # bring web edits down first
npm run deploy
```
If `git pull` reports a conflict because both sides changed, and the Mac copy is
the version you want to keep:
```bash
git add -A && git commit -m "local latest"
git pull --no-rebase -X ours --no-edit
git push
```

**After deploying:** on the phone, close and reopen the app. Confirm the footer
shows the new version. If a device shows a stale build, open the URL once in
Safari to refresh, or bump the `CACHE` name in `public/sw.js`.

**Version stamp convention:** every time `src/App.jsx` changes, update
`APP_VERSION` at the top using `vYYYY:MM:DD-HH:MM` in Asia/Tokyo time.

---

## The iOS "Add to Contacts" reality (verified, not a bug)

A web app on iOS **cannot** write to Contacts silently or skip the final
confirmation tap — confirmed on Apple's developer forum. The most a PWA can do
is open the vCard so iOS shows the contact, then you tap to add it.

Current behaviour (v2026:06:20-01:36): on iPhone/iPad the button navigates the
window to the vCard so iOS opens its **contact preview**. From there:
**tap the share/actions icon → Add to Contacts → review/edit → Add.**

That last tap cannot be removed. If a future iOS version shows a share sheet or a
blank page instead of the preview, the rock-solid fallback is: **Save to Files →
open the .vcf from Files → Add to Contacts.** On desktop, the button downloads
the `.vcf`; double-click it and Contacts opens with an Add prompt.

Names are emitted as UTF-8 vCard 3.0 so Japanese/Korean/Chinese and accented
names survive. The card photo is intentionally not embedded as the contact's
avatar (a card scan isn't a portrait); it stays in the app.

---

## First-time setup (already done — here for rebuilds / a second project)

### Supabase
1. New project → run `supabase/schema.sql` in the SQL Editor (creates `cards`,
   the `card-images` bucket, and RLS policies).
2. Authentication → enable Email; create the two accounts.
3. Deploy the function (Supabase CLI needs **Node 20+**):
   ```bash
   npx supabase login
   npx supabase link --project-ref pvqwpzbjremcyobnsldd   # bare ref, not the URL
   npx supabase secrets set ANTHROPIC_API_KEY=sk-ant-...  # server-side only
   npx supabase functions deploy scan-card                # JWT verification ON (default)
   ```

### Frontend
1. `cp .env.example .env`, then set `VITE_SUPABASE_URL` and
   `VITE_SUPABASE_ANON_KEY` (Project Settings → API). The anon key is public and
   safe in the frontend; it's gated by RLS. `.env` is read at **build time**, so
   rebuild after any change.
2. `npm install` then `npm run dev` to preview locally.

### GitHub Pages
1. `base` in `vite.config.js` must equal `/connex/` (matches the repo name) or
   you get a blank screen.
2. `npm run deploy` → Settings → Pages → Source: Deploy from a branch →
   Branch: `gh-pages` / root → Save.

### iPhone/iPad
Open the live URL in Safari → Share → Add to Home Screen.

---

## Costs

Each scan calls Claude on your Anthropic account. `claude-sonnet-4-6` was
$3 / $15 per million input/output tokens at build time — **verify current rates
at https://www.anthropic.com/pricing** before relying on estimates. A downscaled
card image plus a small JSON response is a low token count per scan. Set a spend
limit in the Anthropic Console if you want a guardrail.

## Security

- Anon key in the frontend: fine (public, RLS-protected).
- `ANTHROPIC_API_KEY`: Supabase secret only — never in the repo or frontend.
  Rotate immediately if ever exposed.
- `scan-card` is deployed with JWT verification on, so only signed-in users can
  spend your API budget.

---

## Changelog

- **v2026:06:20-01:36** — iOS Contacts: navigate in place so iOS opens the
  contact preview (replaces the share-sheet attempt, which buried the contact
  action behind document apps).
- **v2026:06:20-00:40** — First attempt at opening the vCard directly on iOS
  (used `target="_blank"`; produced a share sheet — superseded).
- **v2026:06:19-11:14** — Initial build and first successful deploy.

---

## File map

```
connex/
  index.html                       app shell, PWA + iOS meta, fonts
  vite.config.js                   base path for GitHub Pages (/connex/)
  package.json                     scripts: dev / build / preview / deploy
  .env.example                     frontend Supabase config template
  .gitignore                       node_modules, dist, .env
  public/
    manifest.webmanifest           PWA manifest
    sw.js                          minimal offline app-shell cache (bump CACHE to bust)
    icon-192/512, maskable, apple-touch-icon
  src/
    main.jsx                       entry + service worker registration
    App.jsx                        all screens + logic (APP_VERSION lives here)
    styles.css                     ink/paper/seal design system
    supabaseClient.js              Supabase client from env
    api.js                         image processing, scan, CRUD, storage
    vcard.js                       UTF-8 vCard + iOS Contacts hand-off
  supabase/
    schema.sql                     tables, RLS, storage bucket + policies
    functions/scan-card/index.ts   OCR via Claude (key server-side)
```
