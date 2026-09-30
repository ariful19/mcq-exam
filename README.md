# Northstar MCQ Examination Portal

A small examination app built with Express, Lit, Vite, SQLite, and three ways to add questions: a form, numbered text paste, and Excel import.

## Requirements

- Node.js 20 or newer
- npm

## Install and run

From this folder:

```powershell
npm install
npm run dev
```

Open **http://127.0.0.1:5173** during development. Vite serves the Lit app with live updates and proxies `/api` requests to Express at **http://127.0.0.1:3000**. If a build exists, port 3000 also serves that last built version. The SQLite database initializes automatically at `data/mcq.db` with ten sample questions and a published demo examination.

For a production build and run:

```powershell
npm run build
$env:NODE_ENV = 'production'
npm start
```

The built app is served by Express at **http://127.0.0.1:3000**. After building, `npm start` works even when `NODE_ENV` is unset.

Run the isolated API requirements check with `npm test`. It creates a temporary SQLite database and does not alter `data/mcq.db`.

## Admin login

For a new local database, the demo credentials are:

- Username: `admin`
- Password: `admin123!`

Set `ADMIN_USERNAME`, `ADMIN_PASSWORD`, and `SESSION_SECRET` in the environment to override the demo defaults. Copy `.env.example` to `.env` to configure them locally. `PORT` defaults to `3000`; `DB_PATH` can override the database file path. Set `COOKIE_SECURE=true` when the app is served over HTTPS. The password is copied into the database only when admin credentials are first initialized. After that, change it in the Admin workspace; changing `ADMIN_PASSWORD` alone will not replace an existing database password. A password change signs out existing admin sessions.

## Question bank

Every new question needs a subject, stored in the existing `Category` field. An explanation is optional. Add questions individually, paste up to 300 at once, or import an Excel workbook.

For text paste, choose a subject and separate numbered questions with a blank line:

```text
1. What is the capital of Bangladesh?
A. Chattogram
B. Dhaka
C. Khulna
D. Rajshahi
Answer: B
Explanation: Dhaka is the capital city.

2. Which planet is known as the Red Planet?
A. Venus
B. Mars
C. Jupiter
D. Mercury
Answer: B
```

All pasted questions are validated before any are saved. The app reports the number imported or identifies invalid question blocks.

For Excel, download the template from the Question bank. Keep the first worksheet headers `Question`, `Option A`, `Option B`, `Option C`, `Option D`, and `Correct Answer`; `Category`, `Difficulty`, and `Explanation` are optional. Correct answers must be A, B, C, or D. Each row uses its own Category, or the subject chosen at upload when Category is blank. The full workbook is validated before one transaction imports it, with worksheet row numbers in errors.

Questions used by saved examinations can be edited or removed from the bank while existing examinations retain their original version. During exam creation, choose a subject, select its questions manually or randomly, set the duration, and choose a wrong-answer penalty of `1`, `0.25`, or `0.50` marks. Unanswered questions receive no penalty. Random selections are previewed and stored with the examination so every student receives the same set and order. Existing exams retain their original zero-penalty grading.

Each published exam has a direct `/exam/<id>` link with a Copy link control. Students provide a name, roll number, email, and address before starting. The admin can choose whether students see their final score and answer review after submission. Explanations appear with answer review when available; the admin always sees full answer sheets.

## Architecture

- `server/app.js` contains the API, session login, Excel workflow, deadline enforcement, and scoring.
- `server/db.js` creates and updates the local SQLite schema and seeds the empty database.
- `client/src/app.js` and `client/src/style.css` implement the Lit UI and responsive layouts.
- Vite proxies development API requests; Express serves the built `dist/` directory in production.
- `worker/` and `db/` contain the equivalent Worker/D1 source for a future Sites deployment. This repository update does not publish that version.

Admin APIs use a server-side session cookie. Student attempts use a random opaque token held in the browser session; answer choices are saved immediately. The server calculates each deadline from the attempt start time and exam duration, auto-submits expired attempts, and only includes scores and answer review allowed by the exam settings.

## Admin deletion and backups

Admins can delete an examination together with all its attempts and answers, or delete an individual answer sheet from its detail view. Both actions require confirmation and are permanent.

Questions can be edited or removed from the bank even after use. Editing a used question creates a new bank version; existing exams and answer sheets retain the original question, answer key, and score. Removing a question from the bank also preserves its use in existing exams.

The admin password/settings panel includes **Download database backup**. This downloads a versioned JSON export of all application tables, including archived questions, participant data, and admin credential hashes. Store it securely. This is a data export; there is currently no in-app restore flow. Hosted deployments must apply the latest Drizzle migration before using these features.
