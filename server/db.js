import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const databasePath = path.resolve(process.env.DB_PATH || 'data/mcq.db');
fs.mkdirSync(path.dirname(databasePath), { recursive: true });

export const db = new Database(databasePath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
  CREATE TABLE IF NOT EXISTS questions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    question_text TEXT NOT NULL,
    option_a TEXT NOT NULL,
    option_b TEXT NOT NULL,
    option_c TEXT NOT NULL,
    option_d TEXT NOT NULL,
    correct_option TEXT NOT NULL CHECK (correct_option IN ('A','B','C','D')),
    category TEXT NOT NULL DEFAULT '',
    difficulty TEXT NOT NULL DEFAULT '',
    explanation TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS exams (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    duration_minutes INTEGER NOT NULL CHECK (duration_minutes > 0),
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','closed')),
    show_score INTEGER NOT NULL DEFAULT 0 CHECK (show_score IN (0,1)),
    show_answers INTEGER NOT NULL DEFAULT 0 CHECK (show_answers IN (0,1)),
    subject TEXT NOT NULL DEFAULT '',
    negative_mark REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (show_answers = 0 OR show_score = 1)
  );
  CREATE TABLE IF NOT EXISTS exam_questions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    exam_id INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
    question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE RESTRICT,
    marks REAL NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL DEFAULT 0,
    UNIQUE (exam_id, question_id)
  );
  CREATE TABLE IF NOT EXISTS attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    exam_id INTEGER NOT NULL REFERENCES exams(id) ON DELETE RESTRICT,
    access_token TEXT NOT NULL UNIQUE,
    student_name TEXT NOT NULL,
    roll_number TEXT NOT NULL,
    email TEXT NOT NULL DEFAULT '',
    address TEXT NOT NULL DEFAULT '',
    started_at TEXT NOT NULL,
    submitted_at TEXT,
    score REAL,
    status TEXT NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress','submitted','auto_submitted'))
  );
  CREATE TABLE IF NOT EXISTS answers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    attempt_id INTEGER NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
    question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE RESTRICT,
    selected_option TEXT CHECK (selected_option IN ('A','B','C','D')),
    is_correct INTEGER CHECK (is_correct IN (0,1) OR is_correct IS NULL),
    marks_awarded REAL NOT NULL DEFAULT 0,
    UNIQUE (attempt_id, question_id)
  );
  CREATE TABLE IF NOT EXISTS admin_auth (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    password_salt TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    session_version INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_questions_category_difficulty ON questions(category, difficulty);
  CREATE INDEX IF NOT EXISTS idx_attempts_exam ON attempts(exam_id, started_at DESC);
  CREATE INDEX IF NOT EXISTS idx_attempts_token ON attempts(access_token);
`);

// Keep existing local databases usable when the application adds fields.
// These additive migrations preserve all question, exam, and attempt records.
function addColumnIfMissing(table, column, definition) {
  const columns = db.pragma(`table_info(${table})`);
  if (!columns.some((item) => item.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
}

db.transaction(() => {
  addColumnIfMissing('questions', 'archived', 'archived INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing('questions', 'explanation', "explanation TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing('exams', 'subject', "subject TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing('exams', 'negative_mark', 'negative_mark REAL NOT NULL DEFAULT 0');
  addColumnIfMissing('attempts', 'address', "address TEXT NOT NULL DEFAULT ''");
})();

// Seed the persistent administrator credential once. Later environment changes
// do not silently overwrite a password changed from the application.
if (!db.prepare('SELECT 1 FROM admin_auth WHERE id = 1').get()) {
  const password = process.env.ADMIN_PASSWORD || 'admin123!';
  const salt = crypto.randomBytes(16);
  const hash = crypto.pbkdf2Sync(password, salt, 210000, 32, 'sha256');
  db.prepare(`INSERT INTO admin_auth (id, password_salt, password_hash, session_version)
    VALUES (1, ?, ?, 1)`).run(salt.toString('base64url'), hash.toString('base64url'));
}

const starterQuestions = [
  ['What is the capital city of Bangladesh?', 'Chattogram', 'Dhaka', 'Khulna', 'Rajshahi', 'B', 'Bangladesh', 'Easy'],
  ['Which is the national flower of Bangladesh?', 'Water lily', 'Rose', 'Marigold', 'Jasmine', 'A', 'Bangladesh', 'Easy'],
  ['What is the currency of Bangladesh?', 'Rupee', 'Taka', 'Riyal', 'Yen', 'B', 'Bangladesh', 'Easy'],
  ['Which planet is known as the Red Planet?', 'Venus', 'Jupiter', 'Mars', 'Mercury', 'C', 'Science', 'Easy'],
  ['How many days are there in a leap year?', '364', '365', '366', '367', 'C', 'General Knowledge', 'Easy'],
  ['Which ocean lies to the south of Bangladesh?', 'Atlantic Ocean', 'Indian Ocean', 'Pacific Ocean', 'Arctic Ocean', 'B', 'Geography', 'Easy'],
  ['What is the largest planet in our solar system?', 'Earth', 'Saturn', 'Jupiter', 'Neptune', 'C', 'Science', 'Easy'],
  ['Which language is primarily spoken in Brazil?', 'Spanish', 'Portuguese', 'French', 'Italian', 'B', 'World', 'Easy'],
  ['What is the national animal of Bangladesh?', 'Royal Bengal tiger', 'Asian elephant', 'Leopard', 'Lion', 'A', 'Bangladesh', 'Easy'],
  ['Which continent is the Sahara Desert located in?', 'Asia', 'South America', 'Africa', 'Australia', 'C', 'Geography', 'Easy'],
];

if (db.prepare('SELECT COUNT(*) AS count FROM questions').get().count === 0) {
  const insert = db.prepare(`INSERT INTO questions
    (question_text, option_a, option_b, option_c, option_d, correct_option, category, difficulty)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  db.transaction(() => starterQuestions.forEach((question) => insert.run(...question)))();
}

if (db.prepare('SELECT COUNT(*) AS count FROM exams').get().count === 0) {
  const questionIds = db.prepare('SELECT id FROM questions ORDER BY id LIMIT 10').all();
  const createDemo = db.transaction(() => {
    const exam = db.prepare(`INSERT INTO exams (title, description, duration_minutes, status, show_score, show_answers)
      VALUES (?, ?, ?, 'published', 1, 1)`).run(
      'Getting Started: General Knowledge',
      'A short sample exam to help you explore the examination portal.',
      15,
    );
    const attach = db.prepare('INSERT INTO exam_questions (exam_id, question_id, marks, sort_order) VALUES (?, ?, 1, ?)');
    questionIds.forEach((row, index) => attach.run(exam.lastInsertRowid, row.id, index));
  });
  createDemo();
}

const defaultSettings = {
  site_title: 'Northstar',
  site_subtitle: 'EXAMINATION PORTAL',
  hero_eyebrow: 'LEARN · PREPARE · ACHIEVE',
  hero_title: 'Your next step starts here.',
  hero_description: 'Focused assessments, a clear path forward. Choose an examination below when you’re ready.',
  hero_tagline: 'A calm space to do your best work',
  footer_copyright: 'Northstar Examination Portal',
  footer_tagline: 'Thoughtful assessment, made simple ✦',
};

const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
db.transaction(() => {
  for (const [key, value] of Object.entries(defaultSettings)) {
    insertSetting.run(key, value);
  }
})();

export { databasePath };
