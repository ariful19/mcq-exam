import 'dotenv/config';
import express from 'express';
import session from 'express-session';
import multer from 'multer';
import XLSX from 'xlsx';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, databasePath } from './db.js';

const app = express();
const port = Number(process.env.PORT || 3000);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const clientBuild = path.join(root, 'dist', 'client');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 1 } });
const adminUsername = process.env.ADMIN_USERNAME || 'admin';
const derivePassword = promisify(crypto.pbkdf2);
const passwordIterations = 210000;

app.disable('x-powered-by');
app.use(express.json({ limit: '4mb' }));
app.use(session({
  name: 'mcq.sid',
  secret: process.env.SESSION_SECRET || 'local-demo-secret-change-before-deploying',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.COOKIE_SECURE === 'true', maxAge: 8 * 60 * 60 * 1000 },
}));

const questionInsert = db.prepare(`INSERT INTO questions
  (question_text, option_a, option_b, option_c, option_d, correct_option, category, difficulty, explanation)
  VALUES (@question_text, @option_a, @option_b, @option_c, @option_d, @correct_option, @category, @difficulty, @explanation)`);
const questionById = db.prepare('SELECT * FROM questions WHERE id = ?');
const lockedQuestion = db.prepare('SELECT 1 FROM exam_questions WHERE question_id = ? LIMIT 1');
const attemptByToken = db.prepare(`SELECT a.*, e.title AS exam_title, e.duration_minutes, e.show_score, e.show_answers
  FROM attempts a JOIN exams e ON e.id = a.exam_id WHERE a.access_token = ?`);

function apiError(res, status, error, details) {
  return res.status(status).json({ error, ...(details ? { details } : {}) });
}

function signedEqual(value, expected) {
  const left = Buffer.from(String(value ?? ''));
  const right = Buffer.from(String(expected ?? ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

async function passwordMatches(password, record) {
  if (!record) return false;
  const salt = Buffer.from(record.password_salt, 'base64url');
  const expected = Buffer.from(record.password_hash, 'base64url');
  const candidate = await derivePassword(String(password ?? ''), salt, passwordIterations, 32, 'sha256');
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

async function encodePassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await derivePassword(password, salt, passwordIterations, 32, 'sha256');
  return { salt: salt.toString('base64url'), hash: hash.toString('base64url') };
}

function requireAdmin(req, res, next) {
  const auth = db.prepare('SELECT session_version FROM admin_auth WHERE id = 1').get();
  if (!req.session?.admin || req.session.authVersion !== auth?.session_version) {
    return apiError(res, 401, 'Please sign in as an administrator.');
  }
  next();
}

function normalizedQuestion(input) {
  const q = {
    question_text: String(input.question_text ?? input.Question ?? '').trim(),
    option_a: String(input.option_a ?? input['Option A'] ?? '').trim(),
    option_b: String(input.option_b ?? input['Option B'] ?? '').trim(),
    option_c: String(input.option_c ?? input['Option C'] ?? '').trim(),
    option_d: String(input.option_d ?? input['Option D'] ?? '').trim(),
    correct_option: String(input.correct_option ?? input['Correct Answer'] ?? '').trim().toUpperCase(),
    category: String(input.category ?? input.subject ?? input.Category ?? '').trim(),
    difficulty: String(input.difficulty ?? input.Difficulty ?? '').trim(),
    explanation: String(input.explanation ?? input.Explanation ?? '').trim(),
  };
  const errors = [];
  if (!q.question_text) errors.push('Question is required.');
  for (const letter of ['a', 'b', 'c', 'd']) if (!q[`option_${letter}`]) errors.push(`Option ${letter.toUpperCase()} is required.`);
  if (!['A', 'B', 'C', 'D'].includes(q.correct_option)) errors.push('Correct answer must be A, B, C or D.');
  if (!q.category) errors.push('Subject is required.');
  return { question: q, errors };
}

function examQuestions(examId) {
  return db.prepare(`SELECT q.id, q.question_text, q.option_a, q.option_b, q.option_c, q.option_d,
      q.correct_option, q.explanation, eq.marks, eq.sort_order
    FROM exam_questions eq JOIN questions q ON q.id = eq.question_id
    WHERE eq.exam_id = ? ORDER BY eq.sort_order, eq.id`).all(examId);
}

function attemptDeadline(attempt) {
  return new Date(new Date(`${attempt.started_at.replace(' ', 'T')}Z`).getTime() + attempt.duration_minutes * 60_000);
}

function finalizeAttempt(attemptId, status) {
  const run = db.transaction(() => {
    const attempt = db.prepare('SELECT * FROM attempts WHERE id = ?').get(attemptId);
    if (!attempt || attempt.status !== 'in_progress') return;
    const questions = examQuestions(attempt.exam_id);
    const negativeMark = db.prepare('SELECT negative_mark FROM exams WHERE id = ?').get(attempt.exam_id)?.negative_mark ?? 0;
    const answerRows = db.prepare('SELECT * FROM answers WHERE attempt_id = ?').all(attemptId);
    const byQuestion = new Map(answerRows.map((answer) => [answer.question_id, answer]));
    const update = db.prepare(`UPDATE answers SET is_correct = ?, marks_awarded = ? WHERE id = ?`);
    let score = 0;
    for (const question of questions) {
      const answer = byQuestion.get(question.id);
      const correct = Boolean(answer?.selected_option && answer.selected_option === question.correct_option);
      const marks = correct ? question.marks : answer?.selected_option ? -negativeMark : 0;
      score += marks;
      if (answer) update.run(correct ? 1 : 0, marks, answer.id);
    }
    db.prepare(`UPDATE attempts SET status = ?, submitted_at = CURRENT_TIMESTAMP, score = ?
      WHERE id = ? AND status = 'in_progress'`).run(status, score, attemptId);
  });
  run();
}

function enforceDeadline(attempt) {
  if (attempt?.status === 'in_progress' && Date.now() >= attemptDeadline(attempt).getTime()) {
    finalizeAttempt(attempt.id, 'auto_submitted');
    return attemptByToken.get(attempt.access_token);
  }
  return attempt;
}

function safeResult(attempt, detailed) {
  if (!attempt || attempt.status === 'in_progress') return null;
  const result = { status: attempt.status, submittedAt: attempt.submitted_at };
  if (attempt.show_score) result.score = attempt.score;
  if (detailed && attempt.show_answers && attempt.show_score) {
    result.answers = db.prepare(`SELECT q.id AS question_id, q.question_text, q.option_a, q.option_b, q.option_c, q.option_d,
        q.correct_option, q.explanation, eq.marks, a.selected_option, a.is_correct, a.marks_awarded
      FROM exam_questions eq JOIN questions q ON q.id = eq.question_id
      LEFT JOIN answers a ON a.question_id = q.id AND a.attempt_id = ?
      WHERE eq.exam_id = ? ORDER BY eq.sort_order, eq.id`).all(attempt.id, attempt.exam_id);
  }
  return result;
}

function studentAttempt(token) {
  const attempt = attemptByToken.get(token);
  return enforceDeadline(attempt);
}

app.get('/api/admin/session', (req, res) => {
  const sessionVersion = db.prepare('SELECT session_version FROM admin_auth WHERE id = 1').get()?.session_version;
  const authenticated = Boolean(req.session?.admin && req.session.authVersion === sessionVersion);
  if (req.session?.admin && !authenticated) req.session.destroy(() => {});
  res.json({ authenticated });
});
app.post('/api/admin/login', async (req, res) => {
  const username = req.body?.username;
  const password = req.body?.password;
  const credential = db.prepare('SELECT password_salt, password_hash, session_version FROM admin_auth WHERE id = 1').get();
  if (!signedEqual(username, adminUsername) || !(await passwordMatches(password, credential))) {
    return apiError(res, 401, 'The username or password is incorrect.');
  }
  req.session.regenerate((error) => {
    if (error) return apiError(res, 500, 'Unable to start an admin session.');
    req.session.admin = true;
    req.session.authVersion = credential.session_version;
    res.json({ authenticated: true });
  });
});
app.post('/api/admin/logout', requireAdmin, (req, res) => {
  req.session.destroy((error) => {
    if (error) return apiError(res, 500, 'Unable to end the admin session.');
    res.clearCookie('mcq.sid', { httpOnly: true, sameSite: 'lax' });
    res.json({ ok: true });
  });
});

app.post('/api/admin/password', requireAdmin, async (req, res) => {
  const currentPassword = String(req.body?.current_password ?? '');
  const newPassword = String(req.body?.new_password ?? '');
  if (newPassword.length < 12 || newPassword.length > 128) {
    return apiError(res, 400, 'New password must be 12 to 128 characters.');
  }
  const credential = db.prepare('SELECT password_salt, password_hash FROM admin_auth WHERE id = 1').get();
  if (!(await passwordMatches(currentPassword, credential))) return apiError(res, 401, 'The current password is incorrect.');
  const encoded = await encodePassword(newPassword);
  db.prepare(`UPDATE admin_auth SET password_salt=?, password_hash=?, session_version=session_version+1 WHERE id=1`)
    .run(encoded.salt, encoded.hash);
  req.session.destroy((error) => {
    if (error) return apiError(res, 500, 'The password changed, but this session could not be cleared. Sign in again.');
    res.clearCookie('mcq.sid', { httpOnly: true, sameSite: 'lax' });
    res.json({ ok: true, authenticated: false });
  });
});

app.get('/api/exams', (_req, res) => {
  const exams = db.prepare(`SELECT e.id, e.title, e.description, e.duration_minutes, e.created_at,
      COUNT(eq.id) AS question_count
    FROM exams e LEFT JOIN exam_questions eq ON eq.exam_id = e.id
    WHERE e.status = 'published' GROUP BY e.id ORDER BY e.created_at DESC, e.id DESC`).all();
  res.json(exams);
});

app.get('/api/exams/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) return apiError(res, 404, 'This examination is not available.');
  const exam = db.prepare(`SELECT e.id, e.title, e.description, e.duration_minutes, e.subject, e.negative_mark,
      e.created_at, COUNT(eq.id) AS question_count
    FROM exams e LEFT JOIN exam_questions eq ON eq.exam_id=e.id
    WHERE e.id=? AND e.status='published' GROUP BY e.id`).get(id);
  if (!exam) return apiError(res, 404, 'This examination is not available.');
  res.json(exam);
});

app.get('/api/admin/questions', requireAdmin, (_req, res) => {
  const questions = db.prepare(`SELECT q.*, EXISTS(SELECT 1 FROM exam_questions eq WHERE eq.question_id = q.id) AS locked
    FROM questions q ORDER BY q.id DESC`).all();
  res.json(questions);
});

app.post('/api/admin/questions', requireAdmin, (req, res) => {
  const { question, errors } = normalizedQuestion(req.body || {});
  if (errors.length) return apiError(res, 400, 'Please correct the question details.', errors);
  const result = questionInsert.run(question);
  res.status(201).json(questionById.get(result.lastInsertRowid));
});

function parseQuestionPaste(text, subject) {
  const errors = [];
  const normalizedText = String(text ?? '').trim();
  if (!normalizedText) return { questions: [], errors: ['Paste at least one formatted question.'] };
  const blocks = normalizedText.split(/\r?\n\s*\r?\n/).map((block) => block.trim()).filter(Boolean);
  if (blocks.length > 300) errors.push('A maximum of 300 questions can be imported at a time.');
  const questions = [];
  blocks.forEach((block, index) => {
    const lines = block.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
    const questionNumber = index + 1;
    const details = [];
    const start = lines[0]?.match(/^(\d+)[.)]\s+(.+)$/);
    if (!start) details.push('Use "N. Question" for the question line.');
    else if (Number(start[1]) !== questionNumber) details.push(`Question numbers must be sequential (expected ${questionNumber}).`);

    const optionLines = lines.slice(1, 5);
    const options = {};
    for (const [offset, expected] of ['A', 'B', 'C', 'D'].entries()) {
      const match = optionLines[offset]?.match(/^([A-D])[.)]\s*(.+)$/i);
      if (!match || match[1].toUpperCase() !== expected) details.push(`Option ${expected} is required in order.`);
      else options[`option_${expected.toLowerCase()}`] = match[2].trim();
    }

    let answer;
    let explanation = '';
    const answerLine = lines[5]?.match(/^Answer:\s*([A-D])\s*$/i);
    if (!answerLine) details.push('Add "Answer: A", "Answer: B", "Answer: C" or "Answer: D".');
    else answer = answerLine[1].toUpperCase();
    if (lines[6]) {
      const explanationLine = lines[6].match(/^Explanation:\s*(.*)$/i);
      if (!explanationLine) details.push('Only an optional "Explanation: ..." line may follow the answer.');
      else explanation = explanationLine[1].trim();
    }
    if (lines.length > 7) details.push('Each question block may contain only a question, four options, an answer and an optional explanation.');

    const { question, errors: questionErrors } = normalizedQuestion({
      question_text: start?.[2] ?? '',
      ...options,
      correct_option: answer ?? '',
      category: subject,
      explanation,
    });
    details.push(...questionErrors);
    if (details.length) details.forEach((error) => errors.push(`Question ${questionNumber}: ${error}`));
    else questions.push(question);
  });
  return { questions, errors };
}

app.post('/api/admin/questions/bulk', requireAdmin, (req, res) => {
  const subject = String(req.body?.subject ?? '').trim();
  if (!subject) return apiError(res, 400, 'Subject is required.');
  const { questions, errors } = parseQuestionPaste(req.body?.text, subject);
  if (errors.length) return apiError(res, 400, 'Please use the correct question format. No questions were imported.', errors);
  db.transaction(() => questions.forEach((question) => questionInsert.run(question)))();
  res.json({ imported: questions.length });
});

app.put('/api/admin/questions/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (!questionById.get(id)) return apiError(res, 404, 'Question not found.');
  if (lockedQuestion.get(id)) return apiError(res, 409, 'This question belongs to an exam and can no longer be edited.');
  const { question, errors } = normalizedQuestion(req.body || {});
  if (errors.length) return apiError(res, 400, 'Please correct the question details.', errors);
  db.prepare(`UPDATE questions SET question_text=@question_text, option_a=@option_a, option_b=@option_b,
    option_c=@option_c, option_d=@option_d, correct_option=@correct_option, category=@category, difficulty=@difficulty,
    explanation=@explanation
    WHERE id=@id`).run({ ...question, id });
  res.json(questionById.get(id));
});

app.delete('/api/admin/questions/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (!questionById.get(id)) return apiError(res, 404, 'Question not found.');
  if (lockedQuestion.get(id)) return apiError(res, 409, 'This question belongs to an exam and can no longer be deleted.');
  db.prepare('DELETE FROM questions WHERE id = ?').run(id);
  res.json({ ok: true });
});

const templateHeaders = ['Question', 'Option A', 'Option B', 'Option C', 'Option D', 'Correct Answer', 'Category', 'Difficulty', 'Explanation'];
app.get('/api/admin/questions/template', requireAdmin, (_req, res) => {
  const book = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([templateHeaders]);
  sheet['!cols'] = templateHeaders.map((header) => ({ wch: Math.max(header.length + 2, 18) }));
  XLSX.utils.book_append_sheet(book, sheet, 'Questions');
  const bytes = XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="mcq-question-template.xlsx"');
  res.send(bytes);
});

app.post('/api/admin/questions/import', requireAdmin, upload.single('file'), (req, res) => {
  if (!req.file) return apiError(res, 400, 'Choose an Excel workbook to import.');
  let rows;
  try {
    const book = XLSX.read(req.file.buffer, { type: 'buffer' });
    const first = book.Sheets[book.SheetNames[0]];
    rows = XLSX.utils.sheet_to_json(first, { header: 1, defval: '', raw: false });
  } catch {
    return apiError(res, 400, 'This file could not be read as an Excel workbook.');
  }
  if (!rows?.length) return apiError(res, 400, 'The workbook is empty.');
  const headers = rows[0].map((value) => String(value).trim().toLowerCase());
  const requiredHeaders = templateHeaders.slice(0, 6);
  const headerIndexes = new Map(headers.map((header, index) => [header, index]));
  const missing = requiredHeaders.filter((header) => !headerIndexes.has(header.toLowerCase()));
  if (missing.length) return apiError(res, 400, `Missing required columns: ${missing.join(', ')}.`);

  const imported = [];
  const errors = [];
  const fallbackSubject = String(req.body?.subject ?? '').trim();
  for (let index = 1; index < rows.length; index += 1) {
    const cells = rows[index];
    if (cells.every((cell) => String(cell ?? '').trim() === '')) continue;
    const input = Object.fromEntries(templateHeaders.map((header) => {
      const column = headerIndexes.get(header.toLowerCase());
      return [header, column === undefined ? '' : cells[column] ?? ''];
    }));
    if (!String(input.Category ?? '').trim()) input.Category = fallbackSubject;
    const { question, errors: rowErrors } = normalizedQuestion(input);
    rowErrors.forEach((error) => errors.push(`Row ${index + 1}: ${error}`));
    imported.push(question);
  }
  if (!imported.length && !errors.length) errors.push('No populated question rows were found.');
  if (errors.length) return apiError(res, 400, 'The workbook has validation errors. No questions were imported.', errors);
  db.transaction(() => imported.forEach((question) => questionInsert.run(question)))();
  res.json({ imported: imported.length });
});

app.get('/api/admin/exams', requireAdmin, (_req, res) => {
  const exams = db.prepare(`SELECT e.*, COUNT(DISTINCT eq.id) AS question_count,
      COUNT(DISTINCT a.id) AS participant_count,
      COUNT(DISTINCT CASE WHEN a.status != 'in_progress' THEN a.id END) AS submitted_count
    FROM exams e LEFT JOIN exam_questions eq ON eq.exam_id=e.id
    LEFT JOIN attempts a ON a.exam_id=e.id GROUP BY e.id ORDER BY e.created_at DESC, e.id DESC`).all();
  res.json(exams);
});

app.post('/api/admin/exams', requireAdmin, (req, res) => {
  const title = String(req.body?.title || '').trim();
  const description = String(req.body?.description || '').trim();
  const subject = String(req.body?.subject ?? '').trim();
  const negativeMark = Number(req.body?.negative_mark);
  const duration = Number(req.body?.duration_minutes);
  const status = ['draft', 'published', 'closed'].includes(req.body?.status) ? req.body.status : 'draft';
  const showScore = req.body?.show_score ? 1 : 0;
  const showAnswers = req.body?.show_answers ? 1 : 0;
  const ids = Array.isArray(req.body?.question_ids) ? [...new Set(req.body.question_ids.map(Number).filter(Number.isSafeInteger))] : [];
  if (!title) return apiError(res, 400, 'Exam title is required.');
  if (!subject) return apiError(res, 400, 'Subject is required.');
  if (![1, 0.25, 0.5].includes(negativeMark)) return apiError(res, 400, 'Choose a negative mark of 1, 0.25 or 0.50.');
  if (!Number.isInteger(duration) || duration < 1 || duration > 1440) return apiError(res, 400, 'Duration must be between 1 and 1440 minutes.');
  if (showAnswers && !showScore) return apiError(res, 400, 'Show score must be enabled to show answer review.');
  if (!ids.length) return apiError(res, 400, 'Select at least one question for this exam.');
  const available = db.prepare(`SELECT id, category FROM questions WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids);
  if (available.length !== ids.length) return apiError(res, 400, 'One or more selected questions are no longer available. Refresh the question bank and try again.');
  if (available.some((question) => question.category !== subject)) {
    return apiError(res, 400, 'All selected questions must belong to the chosen subject.');
  }
  const examId = db.transaction(() => {
    const created = db.prepare(`INSERT INTO exams (title, description, duration_minutes, status, show_score, show_answers, subject, negative_mark)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(title, description, duration, status, showScore, showAnswers, subject, negativeMark);
    const addQuestion = db.prepare('INSERT INTO exam_questions (exam_id, question_id, marks, sort_order) VALUES (?, ?, 1, ?)');
    ids.forEach((questionId, index) => addQuestion.run(created.lastInsertRowid, questionId, index));
    return created.lastInsertRowid;
  })();
  res.status(201).json(db.prepare(`SELECT e.*, COUNT(eq.id) AS question_count FROM exams e
    LEFT JOIN exam_questions eq ON eq.exam_id=e.id WHERE e.id=? GROUP BY e.id`).get(examId));
});

app.patch('/api/admin/exams/:id/status', requireAdmin, (req, res) => {
  const status = req.body?.status;
  if (!['draft', 'published', 'closed'].includes(status)) return apiError(res, 400, 'Choose draft, published or closed.');
  const result = db.prepare('UPDATE exams SET status = ? WHERE id = ?').run(status, Number(req.params.id));
  if (!result.changes) return apiError(res, 404, 'Exam not found.');
  res.json({ ok: true, status });
});

app.patch('/api/admin/exams/:id/settings', requireAdmin, (req, res) => {
  const exam = db.prepare('SELECT show_score, show_answers FROM exams WHERE id=?').get(Number(req.params.id));
  if (!exam) return apiError(res, 404, 'Exam not found.');
  const showScore = req.body?.show_score === undefined ? exam.show_score : Number(Boolean(req.body.show_score));
  const showAnswers = req.body?.show_answers === undefined ? exam.show_answers : Number(Boolean(req.body.show_answers));
  if (showAnswers && !showScore) return apiError(res, 400, 'Show score must be enabled to show answer review.');
  db.prepare('UPDATE exams SET show_score=?, show_answers=? WHERE id=?').run(showScore, showAnswers, Number(req.params.id));
  res.json({ ok: true, show_score: showScore, show_answers: showAnswers });
});

app.get('/api/admin/exams/:id/questions', requireAdmin, (req, res) => {
  const questions = examQuestions(Number(req.params.id));
  if (!questions.length) return apiError(res, 404, 'Exam not found or it has no questions.');
  res.json(questions);
});

app.get('/api/admin/exams/:id/attempts', requireAdmin, (req, res) => {
  const exam = db.prepare('SELECT id FROM exams WHERE id=?').get(Number(req.params.id));
  if (!exam) return apiError(res, 404, 'Exam not found.');
  res.json(db.prepare(`SELECT id, student_name, roll_number, email, address, started_at, submitted_at, score, status
    FROM attempts WHERE exam_id=? ORDER BY started_at DESC, id DESC`).all(exam.id));
});

app.get('/api/admin/attempts/:id', requireAdmin, (req, res) => {
  const attempt = db.prepare(`SELECT a.*, e.title AS exam_title FROM attempts a
    JOIN exams e ON e.id=a.exam_id WHERE a.id=?`).get(Number(req.params.id));
  if (!attempt) return apiError(res, 404, 'Attempt not found.');
  const answers = db.prepare(`SELECT q.id AS question_id, q.question_text, q.option_a, q.option_b, q.option_c, q.option_d,
      q.correct_option, q.explanation, eq.marks, a.selected_option, a.is_correct, a.marks_awarded
    FROM exam_questions eq JOIN questions q ON q.id=eq.question_id
    LEFT JOIN answers a ON a.question_id=q.id AND a.attempt_id=?
    WHERE eq.exam_id=? ORDER BY eq.sort_order, eq.id`).all(attempt.id, attempt.exam_id);
  res.json({ ...attempt, answers });
});

app.post('/api/exams/:id/attempts', (req, res) => {
  const exam = db.prepare(`SELECT e.* FROM exams e WHERE e.id=? AND e.status='published'`).get(Number(req.params.id));
  if (!exam) return apiError(res, 404, 'This examination is not available.');
  if (!db.prepare('SELECT 1 FROM exam_questions WHERE exam_id=? LIMIT 1').get(exam.id)) return apiError(res, 409, 'This examination has no questions yet.');
  const studentName = String(req.body?.student_name || '').trim();
  const rollNumber = String(req.body?.roll_number || '').trim();
  const email = String(req.body?.email || '').trim();
  const address = String(req.body?.address || '').trim();
  if (!studentName || studentName.length > 120) return apiError(res, 400, 'Enter your name (up to 120 characters).');
  if (!rollNumber || rollNumber.length > 60) return apiError(res, 400, 'Enter your roll number (up to 60 characters).');
  if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return apiError(res, 400, 'Enter a valid email address.');
  if (!address || address.length > 500) return apiError(res, 400, 'Enter your address (up to 500 characters).');
  const token = crypto.randomBytes(32).toString('base64url');
  const result = db.prepare(`INSERT INTO attempts (exam_id, access_token, student_name, roll_number, email, address, started_at)
    VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`).run(exam.id, token, studentName, rollNumber, email, address);
  res.status(201).json({ token, attempt_id: result.lastInsertRowid });
});

app.get('/api/attempts/:token', (req, res) => {
  const token = String(req.params.token || '');
  let attempt = studentAttempt(token);
  if (!attempt) return apiError(res, 404, 'Attempt not found. Return to the exam list to start again.');
  const deadline = attemptDeadline(attempt);
  const questions = examQuestions(attempt.exam_id).map((question) => ({
    id: question.id,
    question_text: question.question_text,
    option_a: question.option_a,
    option_b: question.option_b,
    option_c: question.option_c,
    option_d: question.option_d,
    marks: question.marks,
    sort_order: question.sort_order,
  }));
  const answers = db.prepare('SELECT question_id, selected_option FROM answers WHERE attempt_id=?').all(attempt.id);
  res.json({
    id: attempt.id, exam_id: attempt.exam_id, exam_title: attempt.exam_title,
    student_name: attempt.student_name, roll_number: attempt.roll_number, email: attempt.email, address: attempt.address,
    status: attempt.status, started_at: attempt.started_at, deadline: deadline.toISOString(),
    remaining_seconds: Math.max(0, Math.ceil((deadline.getTime() - Date.now()) / 1000)),
    questions, answers,
    result: safeResult(attempt, true),
  });
});

app.put('/api/attempts/:token/answers', (req, res) => {
  let attempt = studentAttempt(String(req.params.token || ''));
  if (!attempt) return apiError(res, 404, 'Attempt not found.');
  if (attempt.status !== 'in_progress') return apiError(res, 409, 'This attempt has already been submitted.', { result: safeResult(attempt, true) });
  const questionId = Number(req.body?.question_id);
  const selectedOption = req.body?.selected_option === null || req.body?.selected_option === '' ? null : String(req.body?.selected_option || '').toUpperCase();
  if (!['A', 'B', 'C', 'D', null].includes(selectedOption)) return apiError(res, 400, 'Choose option A, B, C or D.');
  if (!db.prepare('SELECT 1 FROM exam_questions WHERE exam_id=? AND question_id=?').get(attempt.exam_id, questionId)) return apiError(res, 400, 'That question is not part of this examination.');
  db.prepare(`INSERT INTO answers (attempt_id, question_id, selected_option) VALUES (?, ?, ?)
    ON CONFLICT(attempt_id, question_id) DO UPDATE SET selected_option=excluded.selected_option, is_correct=NULL, marks_awarded=0`)
    .run(attempt.id, questionId, selectedOption);
  res.json({ ok: true });
});

app.post('/api/attempts/:token/submit', (req, res) => {
  let attempt = studentAttempt(String(req.params.token || ''));
  if (!attempt) return apiError(res, 404, 'Attempt not found.');
  if (attempt.status === 'in_progress') finalizeAttempt(attempt.id, 'submitted');
  attempt = attemptByToken.get(attempt.access_token);
  res.json({ message: 'Your exam has been submitted successfully.', result: safeResult(attempt, true) });
});

setInterval(() => {
  const active = db.prepare(`SELECT a.id, a.started_at, e.duration_minutes FROM attempts a
    JOIN exams e ON e.id=a.exam_id WHERE a.status='in_progress'`).all();
  const now = Date.now();
  for (const attempt of active) {
    const started = new Date(`${attempt.started_at.replace(' ', 'T')}Z`).getTime();
    if (now >= started + attempt.duration_minutes * 60_000) finalizeAttempt(attempt.id, 'auto_submitted');
  }
}, 5000).unref();

app.get('/api/health', (_req, res) => res.json({ ok: true, database: path.relative(root, databasePath) }));
app.use('/api', (_req, res) => apiError(res, 404, 'API route not found.'));

if (fs.existsSync(path.join(clientBuild, 'index.html'))) {
  app.use(express.static(clientBuild));
  app.get('/{*splat}', (_req, res) => res.sendFile(path.join(clientBuild, 'index.html')));
} else {
  app.get('/{*splat}', (_req, res) => res.status(503).send('Client build is missing. Run npm run build, then npm start.'));
}

app.listen(port, '127.0.0.1', () => {
  console.log(`MCQ server ready at http://127.0.0.1:${port}`);
  console.log(`SQLite database: ${databasePath}`);
});
