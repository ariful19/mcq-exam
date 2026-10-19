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

Questions can use the existing four-option single-select format, Yes/No, multi-select, True/False, fill-in-the-blank, short answer, numeric, matching, or ordering. Each question can set positive marks up to 1000 (default 1); exam creation copies those marks into its immutable snapshot. Yes/No questions are graded full or zero. Students can select multiple options on multi-select questions; their responses save as they move through the exam. Multi-select partial credit is `max(0, correct selections ÷ correct options − incorrect selections ÷ incorrect options) × question marks`, capped at the question’s full marks. If there are no incorrect options, the incorrect-selection share is zero. Missing correct choices reduce earned credit, and selecting every option earns zero when distractors exist. Multi-select questions do not also receive the exam-level negative-mark penalty; other question types retain their existing penalty behavior.

For text paste, choose a fallback subject and separate sequentially numbered questions with a blank line. The versioned `MCQ-PASTE: 2` format supports every type; the original headerless A–D format below remains valid. Unknown lines, duplicate fields, invalid answers and imports over 300 questions are rejected atomically with question/line diagnostics. Download or copy examples from the Question bank; see [the complete import syntax](docs/question-imports.md).

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

For Excel, download the version 2 template from the Question bank. It contains an example for every supported type, a `Marks` column, and a versioned Instructions sheet. All populated question worksheets are validated before one transaction imports any rows, with worksheet and row diagnostics and a 900-question workbook limit. The original legacy A–D workbook remains valid. `Subject` and `Correct Option` are accepted aliases for `Category` and `Correct Answer`. See [question imports](docs/question-imports.md).

Questions used by saved examinations can be edited or removed from the bank while existing examinations retain their original version. During exam creation, combine subjects and question types freely, select questions manually or randomly, set the duration, and choose a wrong-answer penalty of `1`, `0.25`, or `0.50` marks. Unanswered questions receive no penalty. Random selections are previewed and stored with the examination so every student receives the same set and order. Existing exams retain their original zero-penalty grading.

Each published exam has a direct `/exam/<id>` link with a Copy link control. Students provide a name, roll number, email, and address before starting. The admin can choose whether students see their final score and answer review after submission. Explanations appear with answer review when available; the admin always sees full answer sheets.

## Architecture

- `server/app.js` contains the API, session login, Excel workflow, deadline enforcement, and scoring.
- `server/db.js` creates and updates the local SQLite schema and seeds the empty database.
- `client/src/app.js` and `client/src/style.css` implement the Lit UI and responsive layouts.
- Vite proxies development API requests; Express serves the built `dist/` directory in production.
- `worker/` and `db/` contain the equivalent Worker/D1 source for a future Sites deployment. This repository update does not publish that version.

Admin APIs use a server-side session cookie. Student attempts use a random opaque token held in the browser session; answer choices are saved immediately. The server calculates each deadline from the attempt start time and exam duration, auto-submits expired attempts, and only includes scores and answer review allowed by the exam settings.

## Admin deletion and backups

Admins can delete an examination together with all its attempts and answers, or delete any individual result sheet directly from the participant list or its detail view, including submitted and automatically submitted sheets. Both actions require confirmation and are permanent.

Questions can be edited or removed from the bank even after use. Editing a used question creates a new bank version; existing exams and answer sheets retain the original question, answer key, and score. Removing a question from the bank also preserves its use in existing exams.

The admin password/settings panel includes **Download database backup**. This downloads a versioned JSON export of all application tables, including archived questions, participant data, and admin credential hashes. Store it securely. This is a data export; there is currently no in-app restore flow. Hosted deployments must apply all migrations through `0008_private_ordering_identifiers.sql` before using these features. Migration 0007 adds the missing fill-blank constraint support; 0008 adds private random ordering-ID mappings without changing original answers, keys or scores.

Database backups include media metadata and a retention manifest, not file bytes. Back up the local upload directory or hosted object bucket separately. Read [media storage and restore operations](docs/media-storage.md) before enabling hosted uploads. Hosted uploads require an R2-compatible `MEDIA_BUCKET` binding; this repository does not provision or deploy it.


## Shared material and historical safety

Enable a reading/listening stimulus in the question editor, then choose **Reuse existing material** on another question. A saved question owns an immutable copy of the passage and media reference; reusing material does not upload another copy. Customize a copy to change it without affecting other questions. Student exams and answer review render the same snapshots without mandatory sections.

Pending image/audio placeholders are visible and filterable in the bank. Upload, replace or remove attachments before publishing. Updating a question already used by any saved exam creates a replacement bank version. Existing exams, including drafts, keep the original version; create/reselect a new exam question set rather than silently changing saved snapshots.

Ordering uses stable opaque public item IDs in active attempts; the private mapping and canonical sequence are not sent to students. Saved internal identifiers and previously awarded grades remain unchanged. Display order is shuffled per attempt and preserved across page reloads; keyboard/touch Move Up/Down controls remain available.

## Verification

`npm test` builds the client and Worker and runs every `tests/*.test.mjs` test. Tests use disposable SQLite databases, an in-process transactional D1 adapter and an R2 contract fake, never production data. They include all nine question types, atomic import failures, migrations/history, answer visibility, deadline and concurrent-submission races, media validation and authoring UI behavior.

An optional real-browser suite is available at `tests/browser-acceptance.mjs`. It requires Playwright and a runnable Chromium installation. See [acceptance verification](docs/exam-expansion-acceptance.md) for commands, actual results and remaining real-host/browser limits. No deployment is performed by the test suite.
