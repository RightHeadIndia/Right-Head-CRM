# Company CRM

A CRM for a sales / outreach team: calling status, follow-up reminders, client replies, onboarding, red zone, mass mailing, tasks, a deals pipeline, reports, email templates, CSV/Excel import and export, and AI features powered by Claude. Data is stored in an encrypted local SQLite database (`data/crm.sqlite`); no separate database server is needed.

## Quick start

1. Install **Node.js 22.16 or newer** (24 recommended) from https://nodejs.org
2. Open a terminal in this folder and run:

```
npm install
npm run setup
npm start
```

`npm run setup` creates `.env` with a generated login password and encryption key and prints them. **Save both in your company password manager.** It never overwrites an existing `.env`. Backups can only be opened with the same encryption key; if it is lost the data cannot be recovered.

3. Open http://localhost:3000 and sign in with the password.

`npm test` runs the automated checks (encryption, wrong key, conflicts, migration, login, import, export, mass mail, backup).

### Moving from an older version
Put your old `data/db.json` in the new `data/` folder before the first start. It is imported once into SQLite; the original is left in place and a `db.json.pre-sqlite.bak` copy is made. Both are plaintext: restrict access and delete them only after you have checked the migration and made a backup.

## Using it

**Dashboard** and sidebar pages: All Clients, Calling Status, Follow-up Reminders, Replies (blue), Onboarded (green), Red Zone (red), Tasks, Deals Pipeline, Reports, Mass Mailing, Email Templates, AI Assistant, Settings & Import.

**Colour zones.** A client starts as New. Setting a call status makes them Contacted. "Client replied" turns them blue. Onboarded is green and Said No is red; both clear the reminder. Red Zone clients are never mailed.

**Reminders.** Set "Next follow-up" on a client. It shows on the dashboard when due and the browser notifies you (checked every minute while the tab is open).

**Tasks.** To-dos with due date, priority and an optional client; filter by open / due today / overdue / done.

**Deals Pipeline.** Lead, Qualified, Proposal sent, Negotiation, Won, Lost. Drag cards between columns. Stage changes are logged on the client. Deleting a client keeps their deals (unlinked) so revenue history stays.

**Reports.** 7 / 30 / 90 days or 12 months: response rate, conversion, pipeline, weighted forecast (weights in `DEAL_WEIGHT`, `lib/tools.js`), won revenue, win rate, calling outcomes, activity, sources, tasks.

**Email Templates.** Save subject + message with `{{name}}` / `{{company}}`; load them in Mass Mailing or for one client.

**Export.** CSV for clients, deals, tasks and the activity log (spreadsheet formulas are neutralised).

### Importing clients (CSV or Excel)
Settings & Import > choose a `.csv`, `.xlsx` or `.xls` file > Import. Row 1 must be headings. Columns are matched **by heading**, ignoring capitals, spaces and dots: Name / Full Name / Client Name, Company / Company Name, Phone / Phone No. / Mobile, Email / Email ID, Source, Link, Status, Location / City, Remark, Notes, Meeting Status, Reminder 1..12, Follow Up, and more. Only the first Excel sheet is read.

- Columns it does not recognise are saved inside **Notes**, so nothing is lost.
- A row with no person name uses the company name; a row needs at least a name, company, email or phone.
- A bad value (two emails in one cell, "NA", a text phone number, an invalid date) is moved to Notes instead of rejecting the client.
- Duplicates are skipped by email, or by phone (the last 10 digits, so `+91 98765 43210` and `9876543210` match).
- When it finishes you get a summary: rows read, imported, skipped and why.

### Mass mailing and SMTP
Settings & Import > Email (SMTP). Gmail: host `smtp.gmail.com`, port `587`, username = your Gmail address, password = an **App Password**. The host must be a server name (not an email address) and "From" looks like `Company <you@company.com>`. Until SMTP is configured, campaigns run in **simulation mode** (logged, nothing sent). Send only to people who agreed to hear from you and follow anti-spam law (India's DPDP Act, CAN-SPAM, GDPR). Gmail limits personal accounts to about 500 emails a day.

## AI features (Claude)
Settings & Import > General & AI > paste your Anthropic API key > Test AI connection. Or set `ANTHROPIC_API_KEY` on the server (recommended when hosting online). Optional `CLAUDE_MODEL`. Default model: `claude-sonnet-5-5`.

| Where | What it does |
|---|---|
| Client > Summarize client | Summary, key points, open items, risk, next step |
| Client > Draft message | Email / WhatsApp / SMS draft; you edit, then copy, open WhatsApp or send |
| Client > Analyze reply | Sentiment, intent, next step, suggested reply, one-click Apply (stage + follow-up) |
| Mass Mailing / Templates > Write with AI | 1-3 campaign versions |
| AI Assistant page | Ask about clients, deals, tasks and results; it can create tasks and set reminders when asked, but cannot send, edit or delete |

AI usage is billed by Anthropic. When you use an AI button, that client's details (name, company, contact info, notes, recent activity and messages) are sent to Anthropic; the assistant can read any client you ask about. Drafts can be wrong: check names, facts and any `[bracketed]` blanks before sending. The CRM has no automatic unsubscribe, so move anyone who asks to stop to the Red Zone. Client messages are treated as data, not instructions, and the server limits AI calls to 40 per minute.

## Security and backups
- Sign-in uses one shared password (`APP_PASSWORD`, at least 12 characters). Sessions last 12 hours, use an HttpOnly SameSite cookie, and 5 wrong attempts lock the login for 15 minutes. It is meant for a small trusted team; there are no per-person accounts or audit trail yet.
- Every record and setting is encrypted at rest with AES-256-GCM using `CRM_ENCRYPTION_KEY`, which is never stored in the database. An `ANTHROPIC_API_KEY` in the environment stays outside the database.
- **Settings & Import > Download encrypted backup** regularly and keep the file and the key in separate restricted places. To restore: stop the CRM, replace `data/crm.sqlite` with the backup, delete the `-wal` and `-shm` files next to it, start with the same key.
- Behind an HTTPS reverse proxy set `CRM_TRUST_PROXY=1`. Put the database on persistent disk with `CRM_DB_FILE`. Never commit `.env`; `.gitignore` already excludes it.
- If two people edit the same client at once, the later save gets a "changed by someone else" message instead of overwriting.

## How it is optimized
- Records are decrypted once at startup and served from memory; reads never touch the disk or the cipher.
- A save writes **only the records that changed**, in one transaction, so it stays fast with large lists (100,000 clients included).
- SQLite runs in WAL mode; mass mail updates each recipient atomically as it goes.
- Large lists draw 200 rows at a time ("Show more"); search waits for a pause in typing; the background refresh pauses when the tab is hidden.
- The Excel reader is served from this app (no internet needed) and imports upload in batches.

## Project structure
```
server.js              API, login, mass mail, backup (Express, Nodemailer)
lib/database.js        encrypted SQLite storage, change-only writes, conflict check, db.json migration
lib/tools.js           tasks, deals, templates, reports, CSV export
lib/ai.js              Claude features
public/index.html      app shell        public/login.*   sign-in page
public/app.js          dashboard, clients, mass mail, settings, import
public/tools.js        tasks, deals board, reports, templates pages
public/ai.js           AI buttons, campaign writer, assistant chat
scripts/setup.js       creates .env       test/   automated tests
data/crm.sqlite        created on first run (back it up)
```

## API (for developers; all routes need a signed-in session)
`POST /api/auth/login|logout`, `GET /api/auth/session`; `GET/POST /api/clients`, `PUT/DELETE /api/clients/:id`, `GET /api/clients/:id/activities`, `POST /api/clients/:id/activity`, `POST /api/clients/import` (array); `GET /api/dashboard`; `GET/PUT /api/settings`; tasks, deals, templates: `GET/POST /api/{tasks|deals|templates}`, `PUT/DELETE /api/{...}/:id`; `GET /api/reports?days=30`; `GET /api/export/{clients|deals|tasks|activities}.csv`; `POST /api/mail/send`, `/api/mail/send-one`; `GET /api/mail/audience/:key`, `GET /api/campaigns`; `GET /api/backup`; `GET /api/ai/status`, `POST /api/ai/{test|draft|summary|analyze-reply|campaign|assistant}`.

## Ideas for next steps
Per-employee accounts and roles, click-to-call (Exotel / Knowlarity), WhatsApp Business API, email open tracking, PostgreSQL for multi-server use.
