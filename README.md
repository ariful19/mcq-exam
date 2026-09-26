# Northstar MCQ Examination Portal

A small examination app built with Express, Lit, Vite, SQLite, and Excel workbook import.

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

## Admin login

The local demo credentials are:

- Username: `admin`
- Password: `admin123!`

Set `ADMIN_USERNAME`, `ADMIN_PASSWORD`, and `SESSION_SECRET` in the environment to override the demo defaults. Copy `.env.example` to `.env` to configure them locally. `PORT` defaults to `3000`; `DB_PATH` can override the database file path. Set `COOKIE_SECURE=true` when the app is served over HTTPS.

## Question import

Sign in, open the Question bank, and download the Excel template. Keep the first worksheet headers as `Question`, `Option A`, `Option B`, `Option C`, `Option D`, and `Correct Answer`; `Category` and `Difficulty` are optional. Correct answers must be A, B, C, or D. The full workbook is validated before a single transaction imports it, and validation errors include their worksheet row numbers.

Questions used by any saved examination are locked against edits and deletion. They can still be selected for another exam. Random selections are previewed and stored with the examination so every student receives the same set and order.

## Architecture

- `server/app.js` contains the API, session login, Excel workflow, deadline enforcement, and scoring.
- `server/db.js` creates the five SQLite tables and seeds the empty database.
- `client/src/app.js` and `client/src/style.css` implement the Lit UI and responsive layouts.
- Vite proxies development API requests; Express serves the built `dist/` directory in production.

Admin APIs use a server-side session cookie. Student attempts use a random opaque token held in the browser session; answer choices are saved immediately. The server calculates each deadline from the attempt start time and exam duration, auto-submits expired attempts, and only includes scores and answer review allowed by the exam settings.
