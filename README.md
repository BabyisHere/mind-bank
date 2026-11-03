# Mind Bank

Manasseh's private notebook: to-dos, voice/text/photo journal, search, streak.

Plain HTML/CSS/JS, no build step. Every device keeps its own copy in IndexedDB (fast, works offline);
Supabase syncs it across phone and laptop and stores audio and photos permanently.

## Files

| File | What it is |
|---|---|
| `index.html`, `style.css` | the page |
| `app.js` | storage, sync, recording, photos, export |
| `logic.js` | pure helpers (tags, streak, search); checked by `npm test` |
| `config.js` | your Supabase URL and anon key |
| `supabase.sql` | database table, storage bucket and privacy rules |
| `sw.js`, `manifest.webmanifest`, `icon.svg` | offline cache and "Add to Home Screen" |

## Setup (about 10 minutes, free tiers)

1. **Supabase project.** Sign up at supabase.com, create a project.
2. **Database.** SQL Editor > New query > paste all of `supabase.sql` > Run.
3. **Your login.** Authentication > Users > Add user > Create new user: your email and a strong password,
   tick "Auto Confirm User".
4. **Lock the door.** Authentication > Sign In / Providers > turn off "Allow new users to sign up".
   Now nobody else can create an account, and row-level security stops anyone reading your rows or files.
5. **Keys.** Project Settings > API: copy the Project URL and the `anon` `public` key into `config.js`.
   (Never put the `service_role` key anywhere in this app.)
6. **Host it on HTTPS** (the microphone and offline mode need HTTPS). Easiest: app.netlify.com/drop and
   drag the `mind-bank` folder in. GitHub Pages or Cloudflare Pages work too. The code is public there;
   your notes are not, they sit behind your login.
7. **Install on your phone.** Open the URL, sign in, then Share > Add to Home Screen (iPhone)
   or menu > Install app (Android).

Without step 5 the app still works, but only on the device you use it on ("local only" in the header).

## Run locally

```
python -m http.server 8765
```

Then open http://localhost:8765. `npm test` checks the helpers.

## Good to know

- **Transcription** uses the browser's built-in speech recognition. On Chrome that audio goes to Google,
  on Safari to Apple. The recording itself only goes to your Supabase bucket. Firefox has no transcription.
- **Offline**: everything you add is saved on the device first and syncs when you're back online.
  Media made on another device downloads the first time you view it online.
- **Updates**: after you redeploy, the new version shows on the second open (the first open is served from cache).
- **Export all** downloads a zip: `mind-bank.json` (everything), `journal.txt` (readable), `media/` (audio and photos).
- **Two devices editing the same task at the same moment**: the later edit wins.
