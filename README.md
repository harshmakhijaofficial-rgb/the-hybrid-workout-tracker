# THE HYBRID — Gym Command Centre

A responsive workout dashboard for the Bear × Mentzer × Arnold programme, with a Tuesday–Monday training cycle and weekend recovery. Log sets and cardio, see exercise progress, and keep a daily recovery journal.

**[Open the live dashboard](https://harshmakhijaofficial-rgb.github.io/the-hybrid-workout-tracker/)**

## Use the hosted dashboard

Open the link above in a modern browser. No installation or account is required.

- **Overview:** this week's completed sets, lifting days, cardio minutes and volume.
- **Training log:** save weight, reps, reps in reserve, completed sets and exercise notes; add extra sets; record cardio.
- **Progress:** exercise charts, best weights and recent completed sets.
- **Daily journal:** body weight, sleep, energy, duration, recovery notes and freeform entries, including weekends.
- **Backup & data:** export and restore JSON backups.

**Hosted workout entries are saved only in this browser on this device.** They are not uploaded to GitHub or shared with other visitors. They do not automatically sync across devices. Clearing website data or using a private browsing session can remove them. Export a JSON backup regularly; restore it on another device to move your records. A restore merges records, updating matching IDs, and validates the whole backup before changing anything.

The hosted dashboard uses browser storage. Google Sheets synchronisation is available in the Python edition below, after you configure your own workbook and OAuth credentials. Both editions use the same JSON backup format.

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

Opening `public/index.html` directly is not sufficient. Use the Python server, or build and preview the browser edition.

## Build and preview the browser edition

Node.js 20+ is required. There are no npm dependencies to install.

```sh
npm run build
npm run preview
```

Open **http://127.0.0.1:8788/the-hybrid-workout-tracker/**. The build copies the frontend and programme into `docs/` and selects browser storage. Relative asset URLs support a GitHub Pages project path.

GitHub Pages publishes `main` → `/docs`. After editing `public/` or `plan.json`, run `npm run build` and commit the updated source and `docs/` together. GitHub Actions checks the browser storage tests, Python tests and generated assets on pushes and pull requests.

## Optional Google Sheets sync (Python edition)

1. Set `spreadsheet_id` in `config.json` to your own Google Sheets workbook ID. The public repository intentionally includes no personal workbook or credentials.
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

| Day | First cycle | Focus | Cardio target |
| --- | --- | --- | --- |
| Tuesday | 20 October 2026 | Chest + Back A | 15 minutes |
| Wednesday | 21 October 2026 | Legs A + Core | 10 minutes easy |
| Thursday | 22 October 2026 | Shoulders + Arms | 25 minutes |
| Friday | 23 October 2026 | Chest + Back B | 20 minutes |
| Monday | 26 October 2026 | Legs B + Core | 10 minutes easy |
| Saturday & Sunday | 24–25 October 2026 | Rest and recovery | — |

The four-week programme starts on Tuesday, 20 October 2026, using the date in `plan.json`. Each training week runs Tuesday–Monday: Week 1 ends on Monday, 26 October, and Week 2 begins on Tuesday, 27 October. The same weekday split repeats each week. Saturday and Sunday show recovery with the next workout on Monday. Dates after the programme show Week 4. Change the start date for a new cycle. Use full planned sets only when recovery permits. Track reps in reserve; reduce sets when needed.

Exercise IDs are stable when the schedule changes, so existing saved sets, progress history and JSON backups continue to work.

For planks, enter seconds in Reps and 0 kg. For split squats, enter reps per leg. Bodyweight movements can use 0 kg. Volume is the raw sum of kg × reps.

## Verification

```sh
npm test
python test_app.py
npm run build
```

Browser storage tests cover persistence, validation, backups and failed writes. Python tests cover SQLite, atomic imports, Google push/pull, conflicts, deletions, validation and HTTP serving without a Google account.

## Source layout

- `public/` — shared frontend; Python runtime uses server storage.
- `public/storage.js` — browser storage API and backup validation.
- `docs/` — generated browser dashboard, published by GitHub Pages.
- `server.py` — Python HTTP server, SQLite and Google sync.
- `connect_google.py` — optional local Google OAuth setup.
- `plan.json` — workout programme.
- `scripts/` — dependency-free build and preview commands.
- `tests/`, `test_app.py` — browser storage and Python checks.
