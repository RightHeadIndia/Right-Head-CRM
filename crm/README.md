# Company CRM

A CRM for a sales / outreach team. Data is stored in a local SQLite database at `data/crm.sqlite` by default; no separate database server is needed.

## Quick start

1. Install Node.js 24.15 or newer from https://nodejs.org (the app uses Node's built-in SQLite support)
2. Open a terminal in this folder and run:

```
npm install
npm run setup
```

`npm run setup` creates a local `.env` with a generated shared password and encryption key. It will not overwrite an existing `.env`. Save both values in your company password manager; keep a separate copy of the encryption key for backups.

3. Start the app and open http://localhost:3000:

```
npm start
```

Run the automated migration, encryption, conflict, login, API, campaign, CSV, and backup checks with `npm test`.

The `.env` file contains the shared password and encryption key. Restrict access to it at the operating system level. Behind an HTTPS reverse proxy, add `CRM_TRUST_PROXY=1` to `.env` so the session cookie is marked secure.

Sessions expire after 12 hours and are cleared when the server restarts. Keep the service behind your company firewall; use an HTTPS reverse proxy if anyone can connect over an untrusted network.

### Database and migration
On first startup, the app creates `data/crm.sqlite`. If `data/db.json` exists, its CRM records and settings are imported once into SQLite. The original JSON file is left intact, and a `db.json.pre-sqlite.bak` copy is made before import. Both legacy JSON files are plaintext: restrict their file permissions and remove them only after confirming the SQLite migration and a separate backup. This checkout already tracks `crm/data/db.json`; before storing company data, remove it from Git tracking with `git rm --cached crm/data/db.json` from the repository root. `.gitignore` cannot untrack a file that is already tracked. If migration fails, startup stops and the JSON source remains available for recovery. SQLite records and settings are encrypted with AES-256-GCM using `CRM_ENCRYPTION_KEY`; that key is never stored in the database. Updates are committed in SQLite transactions; if two requests edit the same record concurrently, the later one receives a conflict instead of silently overwriting the first. `CRM_DB_FILE` can point to a database on a mounted persistent disk.

### Backups and restore
Use **Settings & Import > Database backup > Download encrypted backup** regularly and store the file in a restricted location. The downloaded database is encrypted, but restoring it requires the same `CRM_ENCRYPTION_KEY`. To restore, stop the CRM service, replace the configured SQLite file with the backup, remove stale `-wal` and `-shm` sidecar files for that database, then restart with the same key. Keep a second copy of the encryption key separate from the database backups.

## What you get

### Dashboard (home page)
| Panel | Colour | What it shows |
|---|---|---|
| Top tiles | - | Total clients, follow-ups due (and overdue), replies, onboarded, red zone |
| Calling Status | grey | Bars for Not called / Connected / No answer / Busy / Call back |
| Follow-up Reminders | amber | Clients whose follow-up is today or overdue (overdue in red text) |
| Client Replies | **BLUE** | Clients who replied / reverted back, with their latest message |
| Onboarded Clients | **GREEN** | Clients who have been onboarded |
| Red Zone | **RED** | Clients who said no |
| Mass Mailing | - | Latest campaigns and a button to start a new one |

### Sidebar (detailed pages)
- **All Clients** - search, filter by stage, edit anything.
- **Calling Status** - change call status from a dropdown right in the table; click the phone number to call, or WhatsApp button to chat.
- **Follow-up Reminders** - everything with a reminder date, oldest first.
- **Replies (Blue Zone)**, **Onboarded Clients**, **Red Zone** - one page per zone with colour-coded rows.
- **Mass Mailing** - choose audience, write subject and message, send. `{{name}}` and `{{company}}` are personalised per client. Said No clients are excluded from every audience; each recipient's current stage is checked again before sending. Campaign progress and send errors are saved as the send runs. A campaign marked interrupted after a restart is not automatically retried, to avoid duplicate emails.
- **Settings & Import** - SMTP email settings and CSV import.

### Sales tools (new)
- **Tasks** - to-dos with due date, priority and an optional client. Filter by open / due today / overdue / done; tick to complete. Tasks also show inside each client's page.
- **Deals Pipeline** - a board with Lead, Qualified, Proposal sent, Negotiation, Won and Lost. Drag cards between columns (or click a card to edit). Each deal has a value, client and expected close date; stage changes are logged on the client's timeline. Deleting a client keeps their deals (unlinked) so revenue history is not lost.
- **Reports** - pick 7 / 30 / 90 days or 12 months: response rate, conversion, open pipeline, weighted forecast, won revenue (and last 6 months), win rate, calling outcomes, team activity, lead sources, task counts. The forecast weights (Lead 10%, Qualified 25%, Proposal 50%, Negotiation 75%) are `DEAL_WEIGHT` in `lib/tools.js`.
- **Email Templates** - save subject + message with `{{name}}` / `{{company}}`. Load them in Mass Mailing, or use one for a single client from the Draft message box. "Save as template" on the Mass Mailing page saves what you just wrote.
- **CSV export** - clients, deals, tasks and activity log (buttons on All Clients, Tasks, Deals and Reports). Files open in Excel/Google Sheets; cells that could be read as spreadsheet formulas are neutralised.

### AI features powered by Claude
Set up: Settings & Import > **General & AI** > paste your Anthropic API key (from console.anthropic.com) > Test AI connection. Or set it on the server instead (recommended when hosting online):

```
APP_PASSWORD='use-a-long-unique-password' CRM_ENCRYPTION_KEY='paste-the-saved-key' ANTHROPIC_API_KEY=sk-ant-... npm start
```
Optional: `CLAUDE_MODEL=...` (or the Model box in Settings) to choose another Claude model. Default is `claude-sonnet-5`.

| Where | What it does |
|---|---|
| Client page > **Summarize client** | Short status summary, key points, open items, risk level and the best next step, from the client's notes, activity, tasks and deals |
| Client page > **Draft message** | Email / WhatsApp / SMS draft for a purpose (intro, follow-up, reply, proposal nudge, welcome...) and tone. You edit it, then copy it, open WhatsApp, or send the email. Nothing is sent automatically |
| Client page > **Analyze reply** | Paste or use the client's reply: sentiment, intent, what to do next, a suggested reply, and a one-click **Apply** that records the reply, moves the stage and sets a follow-up date (asks first for Onboarded / Said No) |
| Mass Mailing and Email Templates > **Write with AI** | 1-3 versions of a campaign email with `{{name}}` / `{{company}}`; pick one and edit |
| **AI Assistant** page | Ask questions ("who should I follow up today?", "what is at risk in my pipeline?"). It looks things up in your CRM; it can create a task or set a follow-up reminder when you ask, and it cannot send messages, edit or delete clients |

Things to know:
- AI usage is billed by Anthropic to your API account. The server limits AI calls to 40 per minute as a safety net.
- When you use an AI button, that client's details (name, company, contact info, notes, recent activity, messages) are sent to Anthropic. The assistant can read any client you ask about. Make sure this fits your privacy policy and what you tell clients.
- AI drafts can be wrong or generic. Check names, facts and any `[bracketed]` blanks before sending. The campaign writer adds a "reply if you'd rather not receive these" line, but this CRM has no automatic unsubscribe, so honour those replies by moving the client to the Red Zone.
- Messages from clients are treated as data by the AI, not as instructions, and the assistant's write actions are limited to tasks and reminders.

### How the colour zones work
1. A client starts as **New**. When you set a call status the client becomes **Contacted**.
2. Click a client, type their message and press **Client replied**: the client turns **BLUE** (Replies).
3. Change the stage to **Onboarded** (**GREEN**) or **Said No** (**RED**). Reminders are cleared automatically for these two.

### Reminders
Set a "Next follow-up" date and time on any client. It appears on the dashboard when due, and the browser shows a notification and alert (allow notifications when asked). The check runs every minute while the CRM tab is open.

## Setting up mass mailing
Go to **Settings & Import** and enter your SMTP details.

Gmail example: host `smtp.gmail.com`, port `587`, username = your Gmail address, password = an **App Password** (Google Account > Security > 2-Step Verification > App passwords).
Business email: use the host, port and login your email provider gives you.

Until SMTP is configured, campaigns run in **simulation mode** (logged, nothing sent), so you can test safely.

Use mass mail only for people who have agreed to hear from you, and follow the anti-spam rules in your country (for example India's DPDP Act, and CAN-SPAM/GDPR for foreign contacts). Gmail and similar providers limit daily sends (about 500/day for personal Gmail), so send large lists through a business mail service.

## Importing clients
In Google Sheets, choose **File > Download > Comma-separated values (.csv)** for the client tab. In the CRM, open **Settings & Import**, choose that CSV and click **Import**. Use headers such as `name,company,phone,email,source,notes,stage,callStatus,followUp,lastReply`; common alternatives like `Full Name`, `Company Name`, `Mobile Number`, `Email Address`, `Status`, and `Next Follow Up` are also recognized. Valid stage values are `new`, `contacted`, `replied`, `onboarded`, and `rejected`; valid call statuses are `not_called`, `connected`, `no_answer`, `busy`, and `callback`. Duplicate emails/phones are skipped. Large files are uploaded in batches. This importer creates clients; tasks, deals, and activity history need their own import mapping before they can be imported.

## Project structure
```
server.js          API + SQLite storage + mass mail (Express, Nodemailer)
lib/database.js    SQLite schema, transactional persistence and one-time JSON migration
lib/tools.js       tasks, deals, templates, reports, CSV export
lib/ai.js          Claude features (drafts, summaries, reply analysis, campaigns, assistant)
public/index.html  page shell with sidebar
public/style.css   styling
public/app.js      dashboard, client tables and modal, mass mail, settings, reminders
public/tools.js    tasks, deals board, reports, templates pages
public/ai.js       AI buttons, campaign writer, assistant chat, AI settings
data/crm.sqlite    created automatically on first run (back this file up!)
```

## API (for developers)
- `GET/POST /api/clients`, `PUT/DELETE /api/clients/:id`
- `POST /api/clients/:id/activity` `{type:"note"|"reply", note}`
- `POST /api/clients/import` (array of clients)
- `GET /api/dashboard`
- `POST /api/mail/send` `{audience, subject, body}`
- `GET/PUT /api/settings`
- `GET/POST /api/tasks`, `PUT/DELETE /api/tasks/:id`; `GET/POST /api/deals`, `PUT/DELETE /api/deals/:id`; `GET/POST /api/templates`, `PUT/DELETE /api/templates/:id`
- `GET /api/reports?days=30`, `GET /api/export/{clients|deals|tasks|activities}.csv`
- `POST /api/mail/send-one` `{clientId, subject, body}`
- `GET /api/ai/status`, `POST /api/ai/{test|draft|summary|analyze-reply|campaign|assistant}`

## Running on a company server
Install Node.js 24.15+, copy this folder to the server, install dependencies with `npm install`, and run `npm run setup` once to create the secrets file. Keep the app behind the company firewall or an HTTPS reverse proxy, run it under a dedicated OS account, and store `CRM_DB_FILE` on a persistent disk with restricted file permissions. Back up the SQLite database regularly and verify that backups can be restored. Do not put the database or credentials into source control.

The shared-password login is intended for a small trusted team behind a company network boundary. It does not provide per-employee identity, roles, or an audit trail of who made a change. Add those before using the CRM where individual accountability or access separation is required. Protect the database file and environment variables with OS permissions. CRM records, settings, SMTP credentials, and an AI key entered in Settings are encrypted at rest in SQLite using `CRM_ENCRYPTION_KEY`. An `ANTHROPIC_API_KEY` supplied through the environment is kept outside SQLite; protect the environment file and server account.

## Ideas for next steps
Per-employee accounts and roles, a click-to-call integration (Exotel / Knowlarity), WhatsApp Business API, email open tracking, and PostgreSQL for larger or multi-server deployments.
