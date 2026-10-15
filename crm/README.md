# Company CRM

A lightweight CRM for a sales / outreach team. No database to install: data is saved in `data/db.json`.

## Quick start

1. Install Node.js 18 or newer from https://nodejs.org
2. Open a terminal in this folder and run:

```
npm install
npm start
```

3. Open http://localhost:3000

To protect the app with a password (recommended if you host it online):

```
APP_PASSWORD=yourpassword npm start        # Mac/Linux
set APP_PASSWORD=yourpassword && npm start # Windows (cmd)
```
Then log in with username `admin` and that password.

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
- **Mass Mailing** - choose audience, write subject and message, send. `{{name}}` and `{{company}}` are personalised per client. "All clients" never includes the Red Zone.
- **Settings & Import** - SMTP email settings and CSV import.

### Sales tools (new)
- **Tasks** - to-dos with due date, priority and an optional client. Filter by open / due today / overdue / done; tick to complete. Tasks also show inside each client's page.
- **Deals Pipeline** - a board with Lead, Qualified, Proposal sent, Negotiation, Won and Lost. Drag cards between columns (or click a card to edit). Each deal has a value, client and expected close date; stage changes are logged on the client's timeline. Deleting a client keeps their deals (unlinked) so revenue history is not lost.
- **Reports** - pick 7 / 30 / 90 days or 12 months: response rate, conversion, open pipeline, weighted forecast, won revenue (and last 6 months), win rate, calling outcomes, team activity, lead sources, task counts. The forecast weights (Lead 10%, Qualified 25%, Proposal 50%, Negotiation 75%) are `DEAL_WEIGHT` in `lib/tools.js`.
- **Email Templates** - save subject + message with `{{name}}` / `{{company}}`. Load them in Mass Mailing, or use one for a single client from the Draft message box. "Save as template" on the Mass Mailing page saves what you just wrote.
- **CSV export** - clients, deals, tasks and activity log (buttons on All Clients, Tasks, Deals and Reports). Files open in Excel/Google Sheets; cells that could be read as spreadsheet formulas are neutralised.

### AI features powered by Claude (new)
Set up: Settings & Import > **General & AI** > paste your Anthropic API key (from console.anthropic.com) > Test AI connection. Or set it on the server instead (recommended when hosting online):

```
ANTHROPIC_API_KEY=sk-ant-... npm start
```
Optional: `CLAUDE_MODEL=...` (or the Model box in Settings) to choose another Claude model. Default is `claude-sonnet-5-5`.

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
Settings & Import > choose a CSV with headers `name,company,phone,email` > Import. Duplicate emails/phones are skipped.

## Project structure
```
server.js          API + storage + mass mail (Express, Nodemailer)
lib/tools.js       tasks, deals, templates, reports, CSV export
lib/ai.js          Claude features (drafts, summaries, reply analysis, campaigns, assistant)
public/index.html  page shell with sidebar
public/style.css   styling
public/app.js      dashboard, client tables and modal, mass mail, settings, reminders
public/tools.js    tasks, deals board, reports, templates pages
public/ai.js       AI buttons, campaign writer, assistant chat, AI settings
data/db.json       created automatically on first run (back this file up!)
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

## Hosting online
Run on any VPS or service that supports Node.js (Render, Railway, a DigitalOcean droplet). Set `APP_PASSWORD`, use HTTPS, and keep the `data/` folder on persistent storage.

## Ideas for next steps
Multiple users with logins, a click-to-call integration (Exotel / Knowlarity), WhatsApp Business API, email open tracking, and a PostgreSQL database for large teams.
