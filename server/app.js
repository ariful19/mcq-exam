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
import { shortenWithIsgd } from './isgd.js';
import {
  normalizeQuestion,
  hydrateQuestionRow,
  hydrateAnswerRow,
  validateStudentAnswer,
  evaluateQuestionAnswer,
  validateQuestionMedia,
  parseQuestionPaste,
} from './question-types.js';

const app = express();
const port = Number(process.env.PORT || 3000);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const clientBuild = path.join(root, 'dist', 'client');
const defaultUploadsDir = process.env.DB_PATH
  ? path.join(path.dirname(path.resolve(process.env.DB_PATH)), 'uploads')
  : path.join(root, 'data', 'uploads');
const uploadsDir = path.resolve(process.env.UPLOADS_DIR || defaultUploadsDir);
try {
  fs.mkdirSync(uploadsDir, { recursive: true });
} catch (err) {
  console.warn(`Could not create uploads directory at ${uploadsDir}:`, err.message);
}
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 12 * 1024 * 1024, files: 1 } });
const adminUsername = process.env.ADMIN_USERNAME || 'admin';
const derivePassword = promisify(crypto.pbkdf2);
const passwordIterations = 210000;

app.disable('x-powered-by');
app.use(express.json({ limit: '8mb' }));
app.use('/uploads', express.static(uploadsDir));
app.use(session({
  name: 'mcq.sid',
  secret: process.env.SESSION_SECRET || 'local-demo-secret-change-before-deploying',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.COOKIE_SECURE === 'true', maxAge: 8 * 60 * 60 * 1000 },
}));

const questionInsert = db.prepare(`INSERT INTO questions
  (question_text, question_type, option_a, option_b, option_c, option_d, correct_option, question_config, answer_key, media, category, difficulty, explanation)
  VALUES (@question_text, @question_type, @option_a, @option_b, @option_c, @option_d, @correct_option, @question_config, @answer_key, @media, @category, @difficulty, @explanation)`);
const questionById = db.prepare(`SELECT q.*, EXISTS(SELECT 1 FROM exam_questions eq WHERE eq.question_id = q.id) AS locked
  FROM questions q WHERE q.archived=0 AND q.id = ?`);
const lockedQuestion = db.prepare('SELECT 1 FROM exam_questions WHERE question_id = ? LIMIT 1');
const attemptByToken = db.prepare(`SELECT a.*, e.title AS exam_title, e.duration_minutes, e.show_score, e.show_answers, e.allow_pdf_download
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
  return normalizeQuestion(input);
}

function examQuestions(examId) {
  return db.prepare(`SELECT q.id, q.question_text, q.question_type, q.option_a, q.option_b, q.option_c, q.option_d,
      q.correct_option, q.question_config, q.answer_key, q.media, q.explanation, q.category, eq.marks, eq.sort_order
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
      const { isCorrect, marksAwarded } = evaluateQuestionAnswer(question, answer, negativeMark);
      score += marksAwarded;
      if (answer) update.run(isCorrect ? 1 : 0, marksAwarded, answer.id);
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
  const result = {
    status: attempt.status,
    submittedAt: attempt.submitted_at,
    allow_pdf_download: Boolean(attempt.allow_pdf_download),
  };
  if (attempt.show_score || attempt.allow_pdf_download) result.score = attempt.score;
  if (detailed && ((attempt.show_answers && attempt.show_score) || attempt.allow_pdf_download)) {
    result.answers = db.prepare(`SELECT q.id AS question_id, q.question_text, q.question_type, q.option_a, q.option_b, q.option_c, q.option_d,
        q.correct_option, q.question_config, q.answer_key, q.media, q.explanation, eq.marks, a.selected_option, a.answer_data, a.is_correct, a.marks_awarded
      FROM exam_questions eq JOIN questions q ON q.id = eq.question_id
      LEFT JOIN answers a ON a.question_id = q.id AND a.attempt_id = ?
      WHERE eq.exam_id = ? ORDER BY eq.sort_order, eq.id`).all(attempt.id, attempt.exam_id).map((row) => hydrateAnswerRow(row));
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

app.get('/api/settings', (_req, res) => {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const settings = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  res.json(settings);
});

app.put('/api/admin/settings', requireAdmin, (req, res) => {
  const allowedKeys = [
    'site_title',
    'site_subtitle',
    'hero_eyebrow',
    'hero_title',
    'hero_description',
    'hero_tagline',
    'footer_copyright',
    'footer_tagline',
    'public_url',
    'enable_short_urls',
    'enable_animations',
    'auto_device_animations',
  ];
  const updates = req.body || {};
  const upsert = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  db.transaction(() => {
    for (const key of allowedKeys) {
      if (typeof updates[key] === 'string') {
        upsert.run(key, updates[key].trim().slice(0, 1000));
      }
    }
  })();
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const settings = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  res.json(settings);
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

app.get('/api/admin/backup', requireAdmin, (_req, res) => {
  const tables = ['questions', 'exams', 'exam_questions', 'attempts', 'answers', 'admin_auth', 'settings'];
  const data = db.transaction(() => Object.fromEntries(tables.map((table) => [table, db.prepare(`SELECT * FROM ${table}`).all()])))();
  res.set('Cache-Control', 'no-store');
  res.attachment(`mcq-backup-${new Date().toISOString().slice(0, 10)}.json`);
  res.json({ format: 'mcq-database-backup', version: 1, created_at: new Date().toISOString(), tables: data });
});

app.get('/api/admin/questions', requireAdmin, (_req, res) => {
  const questions = db.prepare(`SELECT q.*, EXISTS(SELECT 1 FROM exam_questions eq WHERE eq.question_id = q.id) AS locked
    FROM questions q WHERE q.archived=0 ORDER BY q.id DESC`).all().map((row) => hydrateQuestionRow(row));
  res.json(questions);
});

app.post('/api/admin/questions', requireAdmin, (req, res) => {
  const { question, errors } = normalizedQuestion(req.body || {});
  if (errors.length) return apiError(res, 400, 'Please correct the question details.', errors);
  const result = questionInsert.run(question);
  res.status(201).json(hydrateQuestionRow(questionById.get(result.lastInsertRowid)));
});

app.post('/api/admin/media/upload', requireAdmin, upload.single('file'), (req, res) => {
  if (!req.file) return apiError(res, 400, 'Choose a file to upload.');
  const mime = String(req.file.mimetype || '').toLowerCase();
  const isImage = mime.startsWith('image/');
  const isAudio = mime.startsWith('audio/');
  if (!isImage && !isAudio) {
    return apiError(res, 400, 'Only image and audio file uploads are supported.');
  }
  if (mime.includes('video')) {
    return apiError(res, 400, 'Video uploads are not supported.');
  }
  const maxImageSize = 5 * 1024 * 1024;
  const maxAudioSize = 10 * 1024 * 1024;
  if (isImage && req.file.size > maxImageSize) {
    return apiError(res, 400, 'Image file size must be 5MB or less.');
  }
  if (isAudio && req.file.size > maxAudioSize) {
    return apiError(res, 400, 'Audio file size must be 10MB or less.');
  }
  const ext = path.extname(req.file.originalname) || (isImage ? '.png' : '.mp3');
  const filename = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`;
  const targetPath = path.join(uploadsDir, filename);
  fs.writeFileSync(targetPath, req.file.buffer);
  const fileUrl = `/uploads/${filename}`;
  res.json({
    url: fileUrl,
    type: isImage ? 'image' : 'audio',
    filename,
    size: req.file.size,
    mime,
  });
});

app.post('/api/admin/questions/:id/media', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const found = questionById.get(id);
  if (!found) return apiError(res, 404, 'Question not found.');
  const { media, errors } = validateQuestionMedia(req.body?.media || req.body);
  if (errors.length) return apiError(res, 400, 'Invalid media payload.', errors);
  db.prepare('UPDATE questions SET media=? WHERE id=?').run(media ? JSON.stringify(media) : null, id);
  res.json(hydrateQuestionRow(questionById.get(id)));
});

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
  const { question, errors } = normalizedQuestion(req.body || {});
  if (errors.length) return apiError(res, 400, 'Please correct the question details.', errors);
  if (lockedQuestion.get(id)) {
    const replacement = db.transaction(() => {
      const result = questionInsert.run(question);
      db.prepare('UPDATE questions SET archived=1 WHERE id=?').run(id);
      return hydrateQuestionRow(questionById.get(result.lastInsertRowid));
    })();
    return res.json(replacement);
  }
  db.prepare(`UPDATE questions SET question_text=@question_text, question_type=@question_type, option_a=@option_a, option_b=@option_b,
    option_c=@option_c, option_d=@option_d, correct_option=@correct_option, question_config=@question_config, answer_key=@answer_key,
    media=@media, category=@category, difficulty=@difficulty, explanation=@explanation
    WHERE id=@id`).run({ ...question, id });
  res.json(hydrateQuestionRow(questionById.get(id)));
});

app.delete('/api/admin/questions/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (!questionById.get(id)) return apiError(res, 404, 'Question not found.');
  db.prepare('UPDATE questions SET archived=1 WHERE id=?').run(id);
  res.json({ ok: true });
});

const templateHeaders = [
  'Question',
  'Question Type',
  'Option A',
  'Option B',
  'Option C',
  'Option D',
  'Correct Answer',
  'Category',
  'Difficulty',
  'Explanation',
  'Question Config',
  'Answer Key',
  'Media',
];
const optionalImportHeaders = ['Question Config', 'Answer Key', 'Media'];

const templateSampleRows = [
  [
    'What is the capital of Bangladesh?',
    'mcq_single',
    'Dhaka',
    'Chittagong',
    'Sylhet',
    'Rajshahi',
    'A',
    'General Knowledge',
    'Easy',
    'Dhaka has been the capital since 1971.',
    '',
    '',
    '',
  ],
  [
    'Which of the following numbers are prime?',
    'mcq_multi',
    '2',
    '3',
    '4',
    '6',
    'A, B',
    'Mathematics',
    'Medium',
    '2 and 3 are prime numbers.',
    '{"options":[{"id":"A","text":"2"},{"id":"B","text":"3"},{"id":"C","text":"4"},{"id":"D","text":"6"}]}',
    '{"correct_options":["A","B"]}',
    '',
  ],
  [
    'The Earth revolves around the Sun.',
    'true_false',
    'True',
    'False',
    '',
    '',
    'True',
    'General Science',
    'Easy',
    'The Earth orbits the Sun in approximately 365.25 days.',
    '',
    '',
    '',
  ],
  [
    'The chemical symbol for water is [blank].',
    'fill_blank',
    '',
    '',
    '',
    '',
    'H2O',
    'Chemistry',
    'Easy',
    'Water consists of 2 hydrogen and 1 oxygen atom.',
    '{"blanks":[{"id":"B1","label":"Blank 1"}]}',
    '{"blanks":{"B1":["H2O","h2o"]}}',
    '',
  ],
  [
    'What is the powerhouse of the cell?',
    'short_answer',
    '',
    '',
    '',
    '',
    'Mitochondria',
    'Biology',
    'Medium',
    'Mitochondria generate ATP energy for cellular processes.',
    '',
    '',
    '',
  ],
  [
    'What is standard gravity on Earth in m/s^2 (approx)?',
    'numeric',
    '',
    '',
    '',
    '',
    '9.8',
    'Physics',
    'Medium',
    'Standard gravity is 9.80665 m/s^2.',
    '{"tolerance":0.1,"unit":"m/s^2"}',
    '{"value":9.8,"tolerance":0.1}',
    '',
  ],
  [
    'Match chemical formulas to common compound names.',
    'matching',
    '',
    '',
    '',
    '',
    '',
    'Chemistry',
    'Hard',
    'H2O is water, NaCl is salt.',
    '{"prompts":[{"id":"P1","text":"H2O"},{"id":"P2","text":"NaCl"}],"choices":[{"id":"C1","text":"Salt"},{"id":"C2","text":"Water"}]}',
    '{"pairs":{"P1":"C2","P2":"C1"}}',
    '',
  ],
  [
    'Arrange butterfly lifecycle stages sequentially.',
    'ordering',
    '',
    '',
    '',
    '',
    '',
    'Biology',
    'Easy',
    'Order: Egg -> Caterpillar -> Pupa -> Butterfly.',
    '{"items":[{"id":"I1","text":"Egg"},{"id":"I2","text":"Caterpillar"},{"id":"I3","text":"Pupa"},{"id":"I4","text":"Butterfly"}]}',
    '{"correct_order":["I1","I2","I3","I4"]}',
    '',
  ],
];

app.get('/api/admin/questions/template', requireAdmin, (_req, res) => {
  const book = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([templateHeaders, ...templateSampleRows]);
  sheet['!cols'] = templateHeaders.map((header) => ({ wch: Math.max(header.length + 2, 20) }));
  XLSX.utils.book_append_sheet(book, sheet, 'Questions');
  const bytes = XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="mcq-question-template.xlsx"');
  res.send(bytes);
});

app.get('/api/admin/questions/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) return apiError(res, 404, 'Question not found.');
  const found = questionById.get(id);
  if (!found) return apiError(res, 404, 'Question not found.');
  res.json(hydrateQuestionRow(found));
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
  const headerIndexes = new Map(headers.map((header, index) => [header, index]));
  const hasExtensibleHeaders = headerIndexes.has('question') && (
    headerIndexes.has('question type') || headerIndexes.has('question config') || headerIndexes.has('answer key')
  );
  let missing = [];
  if (hasExtensibleHeaders) {
    if (!headerIndexes.has('question')) missing.push('Question');
  } else {
    const legacyRequiredHeaders = ['Question', 'Option A', 'Option B', 'Option C', 'Option D'];
    missing = legacyRequiredHeaders.filter((header) => !headerIndexes.has(header.toLowerCase()));
    if (!headerIndexes.has('correct answer') && !headerIndexes.has('correct option')) {
      missing.push('Correct Answer');
    }
  }
  if (missing.length) return apiError(res, 400, `Missing required columns: ${missing.join(', ')}.`);

  const imported = [];
  const errors = [];
  const fallbackSubject = String(req.body?.subject ?? '').trim();
  const allRecognizedHeaders = [...templateHeaders, ...optionalImportHeaders];
  for (let index = 1; index < rows.length; index += 1) {
    const cells = rows[index];
    if (cells.every((cell) => String(cell ?? '').trim() === '')) continue;
    const input = Object.fromEntries(allRecognizedHeaders.map((header) => {
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
  if (req.body?.mandatory_sections || req.body?.require_sections) {
    return apiError(res, 400, 'Mandatory exam sections are not supported.');
  }
  const title = String(req.body?.title || '').trim();
  const description = String(req.body?.description || '').trim();
  const subjectInput = String(req.body?.subject ?? '').trim();
  const negativeMark = Number(req.body?.negative_mark);
  const duration = Number(req.body?.duration_minutes);
  const status = ['draft', 'published', 'closed'].includes(req.body?.status) ? req.body.status : 'draft';
  const showScore = req.body?.show_score ? 1 : 0;
  const showAnswers = req.body?.show_answers ? 1 : 0;
  const allowPdfDownload = req.body?.allow_pdf_download ? 1 : 0;
  const ids = Array.isArray(req.body?.question_ids) ? [...new Set(req.body.question_ids.map(Number).filter(Number.isSafeInteger))] : [];
  if (!title) return apiError(res, 400, 'Exam title is required.');
  if (![0, 1, 0.25, 0.5].includes(negativeMark)) return apiError(res, 400, 'Choose a negative mark of 0, 1, 0.25 or 0.50.');
  if (!Number.isInteger(duration) || duration < 1 || duration > 1440) return apiError(res, 400, 'Duration must be between 1 and 1440 minutes.');
  if (showAnswers && !showScore) return apiError(res, 400, 'Show score must be enabled to show answer review.');
  if (!ids.length) return apiError(res, 400, 'Select at least one question for this exam.');
  const available = db.prepare(`SELECT id, category FROM questions WHERE archived=0 AND id IN (${ids.map(() => '?').join(',')})`).all(...ids);
  if (available.length !== ids.length) return apiError(res, 400, 'One or more selected questions are no longer available. Refresh the question bank and try again.');
  const distinctCategories = [...new Set(available.map((question) => question.category).filter(Boolean))];
  const subject = subjectInput || distinctCategories.join(', ') || 'General';
  if (!subject) return apiError(res, 400, 'Subject is required.');

  if (status === 'published') {
    const selectedQuestions = db.prepare(`SELECT id, media FROM questions WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids);
    for (const q of selectedQuestions) {
      if (q.media) {
        try {
          const parsed = JSON.parse(q.media);
          if (parsed && parsed.placeholder) {
            return apiError(res, 400, `Cannot publish examination: Question #${q.id} has an unresolved media placeholder. Please attach media before publishing.`);
          }
        } catch {}
      }
    }
  }

  const examId = db.transaction(() => {
    const created = db.prepare(`INSERT INTO exams (title, description, duration_minutes, status, show_score, show_answers, allow_pdf_download, subject, negative_mark)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(title, description, duration, status, showScore, showAnswers, allowPdfDownload, subject, negativeMark);
    const addQuestion = db.prepare('INSERT INTO exam_questions (exam_id, question_id, marks, sort_order) VALUES (?, ?, 1, ?)');
    ids.forEach((questionId, index) => addQuestion.run(created.lastInsertRowid, questionId, index));
    return created.lastInsertRowid;
  })();
  res.status(201).json(db.prepare(`SELECT e.*, COUNT(eq.id) AS question_count FROM exams e
    LEFT JOIN exam_questions eq ON eq.exam_id=e.id WHERE e.id=? GROUP BY e.id`).get(examId));
});

app.delete('/api/admin/exams/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (!db.prepare('SELECT id FROM exams WHERE id=?').get(id)) return apiError(res, 404, 'Exam not found.');
  db.transaction(() => {
    db.prepare('DELETE FROM attempts WHERE exam_id=?').run(id);
    db.prepare('DELETE FROM exams WHERE id=?').run(id);
  })();
  res.json({ ok: true });
});

app.delete('/api/admin/attempts/:id', requireAdmin, (req, res) => {
  const result = db.prepare('DELETE FROM attempts WHERE id=?').run(Number(req.params.id));
  if (!result.changes) return apiError(res, 404, 'Answer sheet not found.');
  res.json({ ok: true });
});

app.patch('/api/admin/exams/:id/status', requireAdmin, (req, res) => {
  const status = req.body?.status;
  if (!['draft', 'published', 'closed'].includes(status)) return apiError(res, 400, 'Choose draft, published or closed.');
  const examId = Number(req.params.id);
  if (status === 'published') {
    const examQuestionsList = db.prepare(`SELECT q.id, q.media FROM exam_questions eq JOIN questions q ON q.id=eq.question_id WHERE eq.exam_id=?`).all(examId);
    for (const q of examQuestionsList) {
      if (q.media) {
        try {
          const parsed = JSON.parse(q.media);
          if (parsed && parsed.placeholder) {
            return apiError(res, 400, `Cannot publish examination: Question #${q.id} has an unresolved media placeholder. Please attach media before publishing.`);
          }
        } catch {}
      }
    }
  }
  const result = db.prepare('UPDATE exams SET status = ? WHERE id = ?').run(status, examId);
  if (!result.changes) return apiError(res, 404, 'Exam not found.');
  res.json({ ok: true, status });
});

app.patch('/api/admin/exams/:id/settings', requireAdmin, (req, res) => {
  const exam = db.prepare('SELECT show_score, show_answers, allow_pdf_download FROM exams WHERE id=?').get(Number(req.params.id));
  if (!exam) return apiError(res, 404, 'Exam not found.');
  const showScore = req.body?.show_score === undefined ? exam.show_score : Number(Boolean(req.body.show_score));
  const showAnswers = req.body?.show_answers === undefined ? exam.show_answers : Number(Boolean(req.body.show_answers));
  const allowPdfDownload = req.body?.allow_pdf_download === undefined ? exam.allow_pdf_download : Number(Boolean(req.body.allow_pdf_download));
  if (showAnswers && !showScore) return apiError(res, 400, 'Show score must be enabled to show answer review.');
  db.prepare('UPDATE exams SET show_score=?, show_answers=?, allow_pdf_download=? WHERE id=?').run(showScore, showAnswers, allowPdfDownload, Number(req.params.id));
  res.json({ ok: true, show_score: showScore, show_answers: showAnswers, allow_pdf_download: allowPdfDownload });
});

app.post('/api/admin/exams/:id/shorten', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const exam = db.prepare('SELECT * FROM exams WHERE id=?').get(id);
  if (!exam) return apiError(res, 404, 'Exam not found.');
  if (exam.status !== 'published') return apiError(res, 400, 'Only published exams can be shared with a short link.');

  const force = Boolean(req.body?.force);
  const customAlias = String(req.body?.shorturl || '').trim();

  if (exam.short_url && !force && !customAlias) {
    return res.json({ ok: true, short_url: exam.short_url, cached: true });
  }

  const enabledRow = db.prepare("SELECT value FROM settings WHERE key='enable_short_urls'").get();
  const isEnabled = enabledRow?.value === '1' || enabledRow?.value === 'true' || process.env.ENABLE_ISGD_SHORTENER === 'true';
  if (!isEnabled && !force) {
    return apiError(res, 400, 'is.gd URL shortening is currently disabled in portal settings. Enable it once you have a public domain name.');
  }

  const settingsRow = db.prepare("SELECT value FROM settings WHERE key='public_url'").get();
  const configuredBase = String(settingsRow?.value || '').trim();
  let longUrl = String(req.body?.url || '').trim();
  if (!longUrl) {
    if (configuredBase) {
      longUrl = new URL(`/exam/${exam.id}`, configuredBase).href;
    } else {
      const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'http';
      const host = req.headers['x-forwarded-host'] || req.get('host') || 'localhost:3000';
      longUrl = `${protocol}://${host}/exam/${exam.id}`;
    }
  }

  try {
    const result = await shortenWithIsgd(longUrl, {
      shorturl: customAlias || undefined,
      logstats: req.body?.logstats,
    });
    db.prepare('UPDATE exams SET short_url = ? WHERE id = ?').run(result.shorturl, id);
    res.json({ ok: true, short_url: result.shorturl, exam_id: id });
  } catch (err) {
    const hint = err.code === 1 ? 'is.gd requires a publicly accessible URL (localhost cannot be shortened).' :
      err.code === 2 ? 'The custom short URL was rejected or is already taken.' :
      err.code === 3 ? 'Rate limit exceeded on is.gd. Please wait 1 minute before trying again.' :
      'Shortening service error.';
    return apiError(res, 400, err.message, [hint]);
  }
});

app.patch('/api/admin/exams/:id/short_url', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const exam = db.prepare('SELECT id FROM exams WHERE id=?').get(id);
  if (!exam) return apiError(res, 404, 'Exam not found.');
  const shortUrl = String(req.body?.short_url || '').trim();
  db.prepare('UPDATE exams SET short_url = ? WHERE id = ?').run(shortUrl, id);
  res.json({ ok: true, short_url: shortUrl });
});

app.post('/api/admin/shorten', requireAdmin, async (req, res) => {
  const url = String(req.body?.url || '').trim();
  if (!url) return apiError(res, 400, 'Please specify a URL to shorten.');
  try {
    const result = await shortenWithIsgd(url, {
      shorturl: req.body?.shorturl,
      logstats: req.body?.logstats,
    });
    res.json({ ok: true, short_url: result.shorturl });
  } catch (err) {
    return apiError(res, 400, err.message);
  }
});

app.get('/api/admin/exams/:id/questions', requireAdmin, (req, res) => {
  const questions = examQuestions(Number(req.params.id)).map((row) => hydrateQuestionRow(row));
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
  const answers = db.prepare(`SELECT q.id AS question_id, q.question_text, q.question_type, q.option_a, q.option_b, q.option_c, q.option_d,
      q.correct_option, q.question_config, q.answer_key, q.media, q.explanation, eq.marks, a.selected_option, a.answer_data, a.is_correct, a.marks_awarded
    FROM exam_questions eq JOIN questions q ON q.id=eq.question_id
    LEFT JOIN answers a ON a.question_id=q.id AND a.attempt_id=?
    WHERE eq.exam_id=? ORDER BY eq.sort_order, eq.id`).all(attempt.id, attempt.exam_id).map((row) => hydrateAnswerRow(row));
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
  const questions = examQuestions(attempt.exam_id).map((question) => hydrateQuestionRow(question, { includeAnswerKey: false }));
  const answers = db.prepare('SELECT question_id, selected_option, answer_data FROM answers WHERE attempt_id=?')
    .all(attempt.id)
    .map((row) => hydrateAnswerRow(row, { forActiveAttempt: true }));
  res.json({
    id: attempt.id, exam_id: attempt.exam_id, exam_title: attempt.exam_title,
    student_name: attempt.student_name, roll_number: attempt.roll_number, email: attempt.email, address: attempt.address,
    status: attempt.status, started_at: attempt.started_at, deadline: deadline.toISOString(),
    remaining_seconds: Math.max(0, Math.ceil((deadline.getTime() - Date.now()) / 1000)),
    allow_pdf_download: Boolean(attempt.allow_pdf_download),
    questions, answers,
    result: safeResult(attempt, true),
  });
});

app.put('/api/attempts/:token/answers', (req, res) => {
  let attempt = studentAttempt(String(req.params.token || ''));
  if (!attempt) return apiError(res, 404, 'Attempt not found.');
  if (attempt.status !== 'in_progress') return apiError(res, 409, 'This attempt has already been submitted.', { result: safeResult(attempt, true) });
  const questionId = Number(req.body?.question_id);
  const examQuestion = db.prepare(`SELECT q.* FROM exam_questions eq JOIN questions q ON q.id = eq.question_id WHERE eq.exam_id = ? AND eq.question_id = ?`)
    .get(attempt.exam_id, questionId);
  if (!examQuestion) {
    if (req.body?.selected_option !== undefined && req.body?.answer_data === undefined) {
      const selectedOption = req.body?.selected_option === null || req.body?.selected_option === '' ? null : String(req.body?.selected_option || '').toUpperCase();
      if (!['A', 'B', 'C', 'D', null].includes(selectedOption)) return apiError(res, 400, 'Choose option A, B, C or D.');
    }
    return apiError(res, 400, 'That question is not part of this examination.');
  }
  const validated = validateStudentAnswer(examQuestion, req.body || {});
  if (validated.error) return apiError(res, 400, validated.error);
  db.prepare(`INSERT INTO answers (attempt_id, question_id, selected_option, answer_data) VALUES (?, ?, ?, ?)
    ON CONFLICT(attempt_id, question_id) DO UPDATE SET selected_option=excluded.selected_option, answer_data=excluded.answer_data, is_correct=NULL, marks_awarded=0`)
    .run(attempt.id, questionId, validated.selected_option, validated.answerDataJson);
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
