# Company CRM

A CRM for a sales / outreach team: lead and communication statuses, calling, follow-up reminders, client replies, onboarding, red zone, mass mailing and automated sequences, tasks, deals, reports, templates, CSV/Excel import and export, and configurable AI. Production persistence uses Neon PostgreSQL through `DATABASE_URL`; the existing SQLite adapter remains for isolated compatibility tests. Existing record payloads and saved integration credentials remain encrypted with AES-256-GCM.

## Quick start

1. Install **Node.js 22.16 or newer** (24 recommended) from https://nodejs.org.
2. Copy `.env.example` to `.env` and set `DATABASE_URL`, `APP_PASSWORD`, and `CRM_ENCRYPTION_KEY`.
3. In Neon Console, open the intended project/database and run `database/schema.sql` in SQL Editor. The schema uses `CREATE TABLE IF NOT EXISTS` and does not delete existing records.
4. Install and start:

```
npm install
npm start
```

Open http://localhost:3000 and sign in with `APP_PASSWORD`.

**Existing encrypted Neon database:** use the exact `CRM_ENCRYPTION_KEY` already associated with that database. Do not run `npm run setup` to generate a replacement key. A different key makes the existing records unreadable. If you need a blank CRM, use a separate Neon database; do not truncate the existing database.

`npm test` runs the automated SQLite compatibility tests in an isolated temporary database. `npm run check` checks JavaScript syntax.

### Database notes
Production requires `DATABASE_URL` and does not fall back to SQLite. Explicit `CRM_DB_FILE` is accepted only for isolated local compatibility tests. The PostgreSQL adapter uses the existing encrypted record format and the same `records` and `meta` tables. Do not run the legacy SQLite-to-Neon migration again if the Neon database already contains your records.

## Neon Console connection

- Set `DATABASE_URL` to the connection string copied from Neon Console → **Connect**. Keep the URL private.
- Set `CRM_ENCRYPTION_KEY` to the original key if reusing an existing encrypted database. For a new empty database, generate a 32-byte base64 key and store it securely.
- Set `APP_PASSWORD` to a strong password of at least 12 characters.
- Render: add those values in the service's **Environment** settings. `NODE_ENV=production` requires `DATABASE_URL`; a missing or broken Neon connection stops startup rather than using a local database.
- Run `database/schema.sql` in Neon SQL Editor, or allow the server to create the same tables on startup. This does not copy or remove client data.
- For a non-destructive connection check, use `node scripts/check-neon.js` after configuring `.env`.

## Using it

**Dashboard** and sidebar pages: All Clients, Calling Status, Follow-up Reminders, Replies (blue), Onboarded (green), Red Zone (red), Tasks, Deals Pipeline, Reports, Mass Mailing, Email Templates, AI Assistant, Settings & Import.

**Colour zones.** A client starts as New. Setting a call status makes them Contacted. "Client replied" turns them blue. Onboarded is green and Said No is red; both clear the reminder. Red Zone clients are never mailed.

**Reminders.** Set "Next follow-up" on a client. It shows on the dashboard when due and the browser notifies you (checked every minute while the tab is open).

**Email follow-ups.** A one-to-one email automatically continues the latest email conversation for the selected client address. Follow-ups are numbered from 1, keep the original subject with `Re:`, and use the saved message/thread headers; choose **Start a new email conversation** to reset the count. Mass mail offers an option to continue each recipient's latest thread, and automated sequence reminders stay in the thread after the initial email. Messages sent before thread tracking was added may not have a saved message ID, so their `Re:` subject may not be enough for every email provider to group them. Sending a follow-up does not mark a client as Replied/Blue; record an actual client response with **Client replied**.

**Email sequences.** Mass Mailing can create an editable five-email sequence: an initial email on Day 1 followed by reminders on Days 3, 5, 7 and 9 (48 hours between emails). A sequence starts paused; select Start to activate it. Existing sequences on the prior schedule are migrated when the server next starts; active reminders retain their interval anchor, and paused sequences use the new schedule when resumed. After the final email, the CRM waits three days for a reply or onboarding; if neither is recorded, it moves the client to Red Zone and stops further follow-ups. A reply moves the client to Blue and stops the sequence; mark onboarded clients Green. The server scheduler continues while the browser is closed and resumes persisted schedules after a restart. Failures retry up to three times. Email replies must be logged with **Client replied**; automatic inbound email detection requires a separately configured mailbox/webhook integration.

**Communication.** Click-to-call opens the device's phone app and logs an attempt; choose a call outcome to track it. Selecting **Call back** creates a high-priority task and reminder. WhatsApp links open the installed app; when Meta WhatsApp Cloud API credentials and a public webhook are configured in Settings, the CRM can send a message and record Meta delivery status. LinkedIn profile visits and drafted messages are recorded, while sending remains in LinkedIn because outbound messaging depends on LinkedIn's approved API permissions. A browser `tel:` link cannot choose the caller ID; use a configured phone or calling provider for that.

**Themes.** Use the header toggle for Dark/Light mode. The choice is saved in CRM settings and in the current browser.

**Tasks.** To-dos with due date, priority and an optional client; filter by open / due today / overdue / done.

**Deals Pipeline.** Lead, Qualified, Proposal sent, Negotiation, Won, Lost. Drag cards between columns. Stage changes are logged on the client. Deleting a client keeps their deals (unlinked) so revenue history stays.

**Reports.** 7 / 30 / 90 days or 12 months: response rate, conversion, pipeline, weighted forecast (weights in `DEAL_WEIGHT`, `lib/tools.js`), won revenue, win rate, calling outcomes, activity, sources, tasks.

**Email Templates.** Save subject + message with `{{name}}` / `{{company}}`; load them in Mass Mailing or for one client. Outgoing emails automatically include the hosted Right Head logo beneath the message. Email clients that block external images may require the recipient to choose “Display images.”

**Export.** CSV for clients, deals, tasks and the activity log (spreadsheet formulas are neutralised).

### Importing clients (CSV or Excel)
Settings & Import > choose a `.csv`, `.xlsx` or `.xls` file > Import. Row 1 must be headings. Columns are matched **by heading**, ignoring capitals, spaces and dots: Name / Full Name / Client Name, Company / Company Name, Phone / Phone No. / Mobile, Email / Email ID, Source, Link, Status, Location / City, Remark, Notes, Meeting Status, Reminder 1..12, Follow Up, and more. Only the first Excel sheet is read.

- Columns it does not recognise are saved inside **Notes**, so nothing is lost.
- A row with no person name uses the company name; a row needs at least a name, company, email or phone.
- A bad value (two emails in one cell, "NA", a text phone number, an invalid date) is moved to Notes instead of rejecting the client.
- Duplicates are skipped by email, or by phone (the last 10 digits, so `+91 98765 43210` and `9876543210` match).
- When it finishes you get a summary: rows read, imported, skipped and why.

### Mass mailing and SMTP
Settings & Import > Email (SMTP). Gmail: host `smtp.gmail.com`, port `587`, username = your Gmail address, password = an **App Password**. The host must be a server name (not an email address) and "From" looks like `Company <you@company.com>`. Each client can have a primary email and additional addresses. In Mass Mailing, choose **Choose individual clients** to search clients across pipeline stages and select the exact email addresses to contact; **Select visible** chooses only each client's primary address. Red Zone and opted-out clients are excluded. You can send a one-time follow-up or create a sequence for the selected addresses. Until SMTP is configured, campaigns run in **simulation mode** (logged, nothing sent). Send only to people who agreed to hear from you and follow anti-spam law (India's DPDP Act, CAN-SPAM, GDPR). Gmail limits personal accounts to about 500 emails a day.

Add a client's additional email addresses in the client editor, one per line. CSV/Excel imports can provide multiple addresses in the Email column (separated by commas, semicolons, or slashes) or use an `Email 2` / `Alternate Emails` column.

## AI features (Groq by default)
Settings & Import > General & AI > select Groq or an OpenAI-compatible provider, set a model and API key, then Test AI Connection. Groq uses `https://api.groq.com/openai/v1` by default; the default model is `openai/gpt-oss-20b`. Or set `GROQ_API_KEY` on the server. The Groq Free plan has rate limits; upgrading the provider account can incur usage charges. No AI API calls occur until a user clicks an AI feature. Configure other providers only when you choose to use them.

| Where | What it does |
|---|---|
| Client > Summarize client | Summary, key points, open items, risk, next step |
| Client > Draft message | Email / WhatsApp / SMS draft; you edit, then copy, open WhatsApp or send |
| Client > Analyze reply | Sentiment, intent, next step, suggested reply, one-click Apply (stage + follow-up) |
| Mass Mailing / Templates > Write with AI | 1-3 campaign versions |
| AI Assistant page | Ask about clients, deals, tasks and results; it can create tasks and set reminders when asked, but cannot send, edit or delete |

When you use an AI button, the required client details (name, company, contact info, notes, recent activity and messages) are sent to the selected provider; the assistant can read any client you ask about. Drafts can be wrong: check names, facts and any `[bracketed]` blanks before sending. Client messages are treated as data, not instructions, and the server limits AI calls to 40 per minute. Groq model availability and limits can change; choose a model enabled for your account.

## Security and backups
- Sign-in uses one shared password (`APP_PASSWORD`, at least 12 characters). Sessions last 12 hours, use an HttpOnly SameSite cookie, and 5 wrong attempts lock the login for 15 minutes. It is meant for a small trusted team; there are no per-person accounts or audit trail yet.
- Every record and setting is encrypted at rest with AES-256-GCM using `CRM_ENCRYPTION_KEY`, which is never stored in the database. `GROQ_API_KEY` and other provider keys set in the environment stay outside the database; keys entered in Settings are encrypted with the CRM settings.
- **Settings & Import > Download backup** regularly and store it securely. PostgreSQL mode exports a JSON backup of the CRM data; treat it as sensitive because the export contains decrypted record values. SQLite compatibility mode downloads an encrypted SQLite backup.
- Behind an HTTPS reverse proxy set `CRM_TRUST_PROXY=1`. Never commit `.env`; `.gitignore` excludes it. Configure environment variables in Render rather than uploading `.env`.
- If two people edit the same client at once, the later save gets a "changed by someone else" message instead of overwriting.

## How it is optimized
- Encrypted records are decrypted once at startup and served from a process cache.
- PostgreSQL writes use parameterized queries, transactions, and version checks; only changed records are written.
- The existing SQLite adapter remains for isolated automated compatibility tests only; production requires Neon.
- Large lists draw 200 rows at a time ("Show more"); search waits for a pause in typing; the background refresh pauses when the tab is hidden.
- The Excel reader is served from this app (no internet needed) and imports upload in batches.

## Project structure
```
server.js              API, login, mass mail, backup (Express, Nodemailer)
lib/database.js        SQLite compatibility adapter for tests
lib/database-postgres.js Neon PostgreSQL adapter with encrypted records and version checks
database/schema.sql    Repeatable Neon schema setup
lib/tools.js           tasks, deals, templates, reports, CSV export
lib/ai.js              Groq/OpenAI-compatible AI features
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
Per-employee accounts and roles, click-to-call (Exotel / Knowlarity), WhatsApp Business API, email open tracking, and shared cache/locking for multi-instance deployments.
