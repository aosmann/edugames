# EduGames class connection server

Class mode needs a small server that passes messages between the teacher's and the students' browsers. The portal used the free public one (0.peerjs.com), but some ad blockers (Arc's
built-in one, for example) and school filters block it. This folder is our own copy of that service,
running free on Cloudflare at an address that is not on blocker lists.

It only passes the class messages along while a class is open (names, answers, scores). Nothing is stored,
except the class lists you upload.

## Deploy (once, about 5 minutes)

1. Make a free Cloudflare account at https://dash.cloudflare.com/sign-up (the school's email is a good idea).
2. In Terminal on the Mac:

   ```
   cd ~/Documents/EduGames/edugames/server
   npm install
   npx wrangler login      # a browser window opens: click Allow
   npx wrangler deploy
   ```

   The first time, Cloudflare asks you to pick a workers.dev name for the account (for example the school's name).
3. The last line shows the address, like `https://edugames-class.your-school.workers.dev`.
   Open it: it should say "EduGames class server: ok". Send that address to Claude, who puts it in the portal
   (`SIGNAL_HOST` in `index.html`).

The portal tries this server first and falls back to 0.peerjs.com by itself, so classes keep working even if
one of them is down. The free plan covers far more than a school needs (100,000 requests a day).

## Class lists

Class lists live only in `src/classes.json` on your Mac and on Cloudflare, never on GitHub (the file is in
`.gitignore`). Format, one entry per class:

```
[
  {"id": "7a", "name": "7A", "students": ["Ana Popescu", "Matei Ionescu"]},
  {"id": "8b", "name": "8B", "students": ["…"]}
]
```

Only signed-in teachers can load the class lists and the reports.

## Teacher accounts

Each teacher has their own username and password. The accounts live in `src/teachers.json`
(only password hashes, never the passwords; the file stays on this computer and is not on GitHub).

1. Once: make the secret that signs the sign-ins (Terminal, in this folder):
   ```
   npx wrangler secret put AUTH_SECRET
   ```
   Paste a long random text (for example from `openssl rand -base64 32`). Put the same text on Render:
   Environment → `AUTH_SECRET`.
2. Add a teacher (or reset a forgotten password) and deploy:
   ```
   node add-teacher.mjs maria "Maria Pop"
   node add-teacher.mjs osman "Osman" admin
   npx wrangler deploy
   ```
   The script prints the new password once. Give it to the teacher.
3. A teacher sees only their own reports. An `admin` sees every teacher's reports
   (and the reports saved before accounts existed).
4. To remove a teacher, delete their entry in `src/teachers.json` and run `npx wrangler deploy`.
   Resetting a password also signs that teacher out on every device.

8 wrong passwords in a row lock that username for 15 minutes. A sign-in lasts 60 days on a device;
"Sign out" in Reports ends it and clears the class lists and synced reports from that device.

After changing `classes.json` or `teachers.json`, run `npx wrangler deploy` again.

## Later

- Update after a code change: `npx wrangler deploy` again in this folder.
- Test locally: `npx wrangler dev`, then open the portal with `?peer=127.0.0.1:8787`.
- To use a school domain instead of workers.dev: Cloudflare dashboard → the `edugames-class` Worker →
  Settings → Domains & Routes → Add custom domain.
