import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const databasePath = path.resolve(process.env.DB_PATH || path.join(root, 'data/mcq.db'));
const outputPath = path.join(root, 'site-seed.json');
const db = new Database(databasePath, { readonly: true });

const questions = db.prepare(`SELECT id, question_text, option_a, option_b, option_c, option_d,
  correct_option, category, difficulty, created_at FROM questions ORDER BY id`).all();
const exams = db.prepare(`SELECT id, title, description, duration_minutes, status, show_score,
  show_answers, created_at FROM exams WHERE status='published' ORDER BY id`).all()
  .map((exam) => ({
    ...exam,
    title: exam.title.includes('Verification Sitting') ? 'Bangladesh and World Knowledge' : exam.title,
  }));
const examQuestions = exams.flatMap((exam) => db.prepare(`SELECT exam_id, question_id, marks, sort_order
  FROM exam_questions WHERE exam_id=? ORDER BY sort_order`).all(exam.id));

db.close();
fs.writeFileSync(outputPath, `${JSON.stringify({ questions, exams, exam_questions: examQuestions }, null, 2)}\n`);
process.stdout.write(`Exported ${questions.length} questions and ${exams.length} published exams without attempt data.\n`);
