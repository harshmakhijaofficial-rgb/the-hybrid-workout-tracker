# THE HYBRID — Gym Command Centre

A responsive workout dashboard for the Bear × Mentzer × Arnold programme, with Monday–Friday lifting and weekend recovery. Log sets and cardio, see exercise progress and your body weight trend, and keep a daily recovery journal.

The Google Sheets edition runs as a private Apps Script web app and saves directly to the linked workout workbook. It uses Google sign-in and needs no JSON file transfers.

**[Open the connected Google Sheets dashboard](https://script.google.com/macros/s/AKfycbwoN4h_vKgSakOoKM4dlFNF_rhZi-D_XGD405OIczFn9rua59I3v24F2LNu8qQhwqPX/exec)** — sign in as the workbook owner.

**[Open the website](https://cleaninglondon.online/)** · [GitHub Pages mirror](https://harshmakhijaofficial-rgb.github.io/the-hybrid-workout-tracker/)

## Deploy from GitHub to FTP

Successful pushes to `main` publish the tested `htdocs/` website to **https://cleaninglondon.online/** and the GitHub Pages mirror. The FTP credentials are stored in repository Actions secrets named `FTP_SERVER`, `FTP_USERNAME` and `FTP_PASSWORD`. Keep their values out of source files.

The FTP job checks the existing document root before uploading. It prefers `cleaninglondon.online/htdocs/`, then `htdocs/`, relative to the account's login directory. If the account already opens in `htdocs` or `public_html`, it uses that directory. For another layout, set the repository Actions variable `FTP_SERVER_DIR` to the existing document root, including a trailing slash. The preflight never creates a missing destination directory.

FTPS with certificate verification is the default. For a host that supports only FTP, set the Actions variable `FTP_PROTOCOL` to `ftp`. You can also select the protocol when running **Check and publish tracker → Run workflow** manually on `main`. A failed connection stops deployment.

Only the website files are uploaded. A separate `.hybrid-workout-tracker-ftp-state.json` tracks this app's deployed files; unrelated files on the host are preserved. Deployment runs after the tests pass, and an HTTPS check confirms that the live dashboard and assets match this commit.

This publishes the static dashboard. The private spreadsheet backend remains on Google Apps Script and opens through **Open connected dashboard**.

## Upload to an FTP website

`htdocs/` is the complete website and the single frontend source folder. It is ready to upload; your host does not need Node.js, Python, a database or a build command.

1. Open your host's `htdocs` document root in your FTP client. Some hosts call it `public_html` or `www`.
2. Upload **the contents of this repository's `htdocs/` folder** into that document root. Your host should have `htdocs/index.html`, not `htdocs/htdocs/index.html`.
3. Open your domain over HTTPS. The dashboard also works in a subfolder, such as `https://example.com/workouts/`.

Upload these files together whenever the website changes:

```text
htdocs/
  index.html
  app.js
  style.css
  storage.js
  schedule.js
  runtime-config.js
  plan.json
  .nojekyll
```

Only this folder belongs in the public document root. Keep Python files, `apps-script/`, credentials, local workout data, tests and `.git/` outside it. `.nojekyll` supports GitHub Pages and is harmless on FTP hosts.

The FTP website saves entries in that browser on that website's domain. Existing entries from GitHub Pages do not automatically move to a new domain. For saves directly to your spreadsheet and access across devices, use **Open connected dashboard** and sign in with the workbook owner's Google account. That private edition continues to run on Google Apps Script; uploading to FTP does not move its backend.

After editing the website or connection metadata, run `npm run build` to validate the files and refresh the browser runtime configuration before uploading. To make an FTP ZIP on Windows:

```powershell
npm run build
New-Item -ItemType Directory -Path dist -Force
Compress-Archive -LiteralPath htdocs -DestinationPath dist/THE_HYBRID_FTP.zip -Force
```

Extract the ZIP, then upload the files inside its `htdocs/` folder.

## Use the hosted dashboard

Open the link above in a modern browser. No installation or account is required.

- **Overview:** this week's completed sets, lifting days, cardio minutes and volume.
- **Training log:** save weight, reps, reps in reserve, completed sets and exercise notes; add extra sets; record cardio.
- **Progress:** body weight trend, exercise charts, best weights and recent completed sets.
- **Daily journal:** body weight, sleep, energy, duration, recovery notes and freeform entries, including weekends.
- **Backup & data:** export and restore JSON backups.

**Hosted workout entries are saved only in this browser on this device.** They are not uploaded to GitHub or shared with other visitors. They do not automatically sync across devices. Clearing website data or using a private browsing session can remove them. Export a JSON backup regularly; restore it on another device to move your records. A restore merges records, updating matching IDs, and validates the whole backup before changing anything.

The public GitHub Pages edition uses browser storage. For automatic workbook saves, use the private connected edition below. Google Sheets synchronisation is also available in the Python edition after local OAuth setup.

## Connected Google Sheets dashboard

The connected edition uses the same interface and training schedule. It reads sets, cardio, notes and check-ins from the existing Google Sheets tabs; each successful Save updates that record immediately. **Refresh Sheets** pulls changes made directly in the workbook. A failed save shows an error and keeps the entered values available to retry.

The Apps Script deployment is **Only myself**, executing as the deploying Google account. Sign in with the workbook owner's account. Google requires a one-time Sheets permission approval; the server code fixes access to the configured workbook. Neither OAuth tokens nor credentials appear in the public repository. The public GitHub Pages dashboard remains available with browser-local storage and a link to the connected dashboard.

Apps Script source is in `apps-script/`. `connection.json` records the observed project ID, workbook ID and deployed dashboard URL. To generate the files for the Apps Script editor:

```sh
npm run build:sheets
```

This writes ignored `apps-script/build/Code.gs`, `Index.html` and `appsscript.json`. Copy each complete file into its matching Apps Script editor file. The build embeds the current programme and UI, so rerun it after source changes. Save and update the private web app deployment to publish those changes. The manifest explicitly declares owner-only access and the Google Sheets scope. Keep that access setting private.

Existing workbook headers are validated before writes. Saving updates one record's schema columns; extra columns, formatting and reference tabs remain intact. If a save lands out of date order, that tab is re-sorted by date: whole rows move together, so extra columns stay with their record, same-day rows keep their order and cleared rows sink to the bottom. IDs must remain stable;

**Organise workbook** on the dashboard's Google Sheets page puts the PLAN and START HERE tabs in Monday-to-Sunday order, sorts the log tabs by date, and creates a **Weight Trend** tab with each day's check-in weight, its 7-day average and a line chart. Check-in saves keep that tab current. It changes no records and is safe to run again; run it once after updating the Apps Script files. manual rows need a unique ID and the original headers. There is a 4,999-record limit per data tab. The connected edition uses Sheets as its source of truth and requires an internet connection; manual workbook changes appear after refresh. Simultaneous edits to the same record use the last completed save.

## Run the Python edition

Python 3.9+ is enough for local tracking; no pip packages are required unless you enable Google sync.

```sh
python server.py
```

On Windows you may need `py -3 server.py`; on macOS/Linux, `python3 server.py`. Or use `START_WINDOWS.bat` / `START_MAC_LINUX.sh`.

Open **http://127.0.0.1:8787** while the server is running. Data is saved in `data/workouts.sqlite3`. The server binds only to your own computer. To choose another port:

```sh
python server.py --port 8788
```

Use the Python server for local SQLite storage. It serves the same `htdocs/` assets and selects server storage dynamically; the FTP files keep their browser storage configuration.

## Build and preview the browser edition

Node.js 20+ is required. There are no npm dependencies to install.

```sh
npm run build
npm run preview
```

Open **http://127.0.0.1:8788/**. You can also preview **http://127.0.0.1:8788/the-hybrid-workout-tracker/** to check a subfolder deployment. The build validates `htdocs/` and refreshes its browser runtime configuration. Relative asset URLs support both FTP document roots and GitHub Pages project paths. Use an HTTP preview instead of opening `index.html` as a local file.

GitHub Actions tests the app and publishes `htdocs/` to FTP and GitHub Pages on successful pushes to `main`. After editing `htdocs/` or `apps-script/connection.json`, run `npm run build` and commit the changes. Pull requests run the same checks without publishing. There is no separate `public/` or generated `docs/` copy to maintain.

## Optional Google Sheets sync (Python edition)

1. `config.json` points to the linked workout workbook. To use another workbook, change `spreadsheet_id`. The repository contains no credentials or workout records.
2. Create these tabs with the following exact header rows in row 1:

| Tab | Headers, in order |
| --- | --- |
| Workout Logs | `id, date, day, exercise_id, exercise, set_number, weight_kg, reps, rir, completed, note, updated_at` |
| Cardio | `id, date, day, type, minutes, level, effort, note, updated_at` |
| Daily Notes | `id, date, day, category, note, updated_at` |
| Check-ins | `id, date, day, bodyweight_kg, sleep_hours, energy, duration_min, note, updated_at` |

3. In Google Cloud Console, enable the Google Sheets API, configure OAuth consent and create a **Desktop app** OAuth client. Add your Google account as a test user if required.
4. Download the client JSON to `credentials.json` beside `server.py`. Keep it private.
5. Install and authorise:

```sh
python -m pip install -r requirements.txt
python connect_google.py
```

6. Run the Python tracker, open **Google sync**, and select **Sync now**. Use a Google account with edit permission on the workbook.

The app requests the Google Sheets OAuth scope. Your existing ChatGPT connection does not authorise this separate local application. Tokens stay in `data/token.json`; `.gitignore` excludes credentials, tokens and the local database. Avoid committing a personally configured `config.json`.

Sync pushes local changes and pulls manual Sheet edits. Keep the tab headers and existing IDs unchanged. Missing IDs on new valid Sheet rows are filled during sync. Local edits win when the same record changed in both places; the remote copy is saved in `data/sync_conflicts.json`. Local deletions propagate on the next sync. Each tab supports 4,999 records. Invalid headers, records or capacity fail validation before any Sheet writes. A network failure during writes can still require a retry; back up the workbook and local JSON regularly. Reference tabs such as PLAN remain untouched.

## Programme and logging conventions

| Day | Week 1 | Focus | Cardio target |
| --- | --- | --- | --- |
| Monday | 19 October 2026 (before the start date) | Legs B + Core | 10 minutes easy |
| Tuesday | 20 October 2026 | Chest + Back A | 15 minutes |
| Wednesday | 21 October 2026 | Legs A + Core | 10 minutes easy |
| Thursday | 22 October 2026 | Shoulders + Arms | 25 minutes |
| Friday | 23 October 2026 | Chest + Back B | 20 minutes |
| Saturday & Sunday | 24–25 October 2026 | Rest and recovery | — |

The four-week programme starts on Tuesday, 20 October 2026, using the date in `htdocs/plan.json`. Each training week runs Monday–Sunday, and Week 1 is the week containing the start date: it ends on Sunday, 25 October, and Week 2 begins with Legs B on Monday, 26 October. The Overview marks a Monday before the start date as not yet started. The same weekday split repeats each week. Saturday and Sunday show recovery with the next workout on Monday. Dates after the programme show Week 4. Change the start date for a new cycle. Use full planned sets only when recovery permits. Track reps in reserve; reduce sets when needed.

Exercise IDs are stable when the schedule changes, so existing saved sets, progress history and JSON backups continue to work.

The body weight trend on Progress and Daily journal uses the body weight from each daily check-in. Each dot is one day's weigh-in; the line is the average of the weigh-ins from the 7 calendar days ending on that day, which smooths day-to-day water swings. Weigh in at the same time each day, ideally in the morning, for the cleanest trend.

For planks, enter seconds in Reps and 0 kg. For split squats, enter reps per leg. Bodyweight movements can use 0 kg. Volume is the raw sum of kg × reps.

## Verification

```sh
npm test
python test_app.py
npm run build
```

Browser storage tests cover persistence, validation, backups and failed writes. Python tests cover SQLite, atomic imports, Google push/pull, conflicts, deletions, validation and HTTP serving without a Google account.

## Source layout

- `htdocs/` — complete FTP website and shared frontend, also published by GitHub Pages.
- `htdocs/storage.js` — browser storage API and backup validation.
- `htdocs/plan.json` — workout programme.
- `server.py` — Python HTTP server, SQLite and Google sync.
- `connect_google.py` — optional local Google OAuth setup.
- `scripts/` — dependency-free build and preview commands.
- `apps-script/` — private connected dashboard backend, deployment manifest and connection metadata.
- `tests/`, `test_app.py` — browser storage and Python checks.
- `dist/` — ignored FTP ZIP exports.
