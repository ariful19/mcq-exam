import { Hono } from 'hono';
import * as XLSX from 'xlsx/xlsx.mjs';
import seedData from '../site-seed.json';
import { CLIENT_ASSETS } from 'virtual:client-assets';

const app = new Hono();
const optionKeys = { A: 'option_a', B: 'option_b', C: 'option_c', D: 'option_d' };
const templateHeaders = ['Question', 'Option A', 'Option B', 'Option C', 'Option D', 'Correct Answer', 'Category', 'Difficulty'];
const sessionSeconds = 8 * 60 * 60;

function apiError(c, status, error, details) {
  return c.json({ error, ...(details ? { details } : {}) }, status);
}

function normalizeQuestion(input = {}) {
  const question = {
    question_text: String(input.question_text ?? input.Question ?? '').trim(),
    option_a: String(input.option_a ?? input['Option A'] ?? '').trim(),
    option_b: String(input.option_b ?? input['Option B'] ?? '').trim(),
    option_c: String(input.option_c ?? input['Option C'] ?? '').trim(),
    option_d: String(input.option_d ?? input['Option D'] ?? '').trim(),
    correct_option: String(input.correct_option ?? input['Correct Answer'] ?? '').trim().toUpperCase(),
    category: String(input.category ?? input.Category ?? '').trim(),
    difficulty: String(input.difficulty ?? input.Difficulty ?? '').trim(),
  };
  const errors = [];
  if (!question.question_text) errors.push('Question is required.');
  for (const letter of ['a', 'b', 'c', 'd']) if (!question[`option_${letter}`]) errors.push(`Option ${letter.toUpperCase()} is required.`);
  if (!['A', 'B', 'C', 'D'].includes(question.correct_option)) errors.push('Correct answer must be A, B, C or D.');
  return { question, errors };
}

function b64url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function fromB64url(value) {
  const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4);
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

async function sessionKey(secret) {
  return crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

async function makeAdminToken(username, secret) {
  const payload = b64url(new TextEncoder().encode(JSON.stringify({ username, exp: Math.floor(Date.now() / 1000) + sessionSeconds })));
  const signature = await crypto.subtle.sign('HMAC', await sessionKey(secret), new TextEncoder().encode(payload));
  return `${payload}.${b64url(new Uint8Array(signature))}`;
}

async function adminUser(c) {
  const cookie = c.req.header('Cookie') || '';
  const token = cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith('mcq.sid='))?.slice('mcq.sid='.length);
  if (!token || !c.env.SESSION_SECRET) return null;
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra) return null;
  try {
    const verified = await crypto.subtle.verify('HMAC', await sessionKey(c.env.SESSION_SECRET), fromB64url(signature), new TextEncoder().encode(payload));
    if (!verified) return null;
    const claims = JSON.parse(new TextDecoder().decode(fromB64url(payload)));
    return claims.username === c.env.ADMIN_USERNAME && claims.exp > Math.floor(Date.now() / 1000) ? claims.username : null;
  } catch { return null; }
}

async function requireAdmin(c, next) {
  const user = await adminUser(c);
  if (!user) return apiError(c, 401, 'Please sign in as an administrator.');
  c.set('adminUser', user);
  return next();
}

async function ensureSeeded(db) {
  const marker = await db.prepare("SELECT value FROM site_meta WHERE key='initial_seed'").first();
  if (marker) return;
  const statements = [db.prepare("INSERT INTO site_meta (key,value) VALUES ('initial_seed','1') ON CONFLICT(key) DO NOTHING")];
  for (const q of seedData.questions) {
    statements.push(db.prepare(`INSERT INTO questions (id,question_text,option_a,option_b,option_c,option_d,correct_option,category,difficulty,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`).bind(q.id,q.question_text,q.option_a,q.option_b,q.option_c,q.option_d,q.correct_option,q.category,q.difficulty,q.created_at));
  }
  for (const e of seedData.exams) {
    statements.push(db.prepare(`INSERT INTO exams (id,title,description,duration_minutes,status,show_score,show_answers,created_at)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`).bind(e.id,e.title,e.description,e.duration_minutes,e.status,e.show_score,e.show_answers,e.created_at));
  }
  for (const eq of seedData.exam_questions) {
    statements.push(db.prepare(`INSERT INTO exam_questions (exam_id,question_id,marks,sort_order)
      VALUES (?,?,?,?) ON CONFLICT(exam_id,question_id) DO NOTHING`).bind(eq.exam_id,eq.question_id,eq.marks,eq.sort_order));
  }
  await db.batch(statements);
}

async function getExamQuestions(db, examId) {
  const { results = [] } = await db.prepare(`SELECT q.id,q.question_text,q.option_a,q.option_b,q.option_c,q.option_d,q.correct_option,
      eq.marks,eq.sort_order FROM exam_questions eq JOIN questions q ON q.id=eq.question_id
    WHERE eq.exam_id=? ORDER BY eq.sort_order,eq.id`).bind(examId).all();
  return results;
}

function deadlineFor(attempt) {
  return new Date(new Date(attempt.started_at).getTime() + Number(attempt.duration_minutes) * 60_000);
}

async function finalizeAttempt(db, attemptId, status) {
  const attempt = await db.prepare('SELECT * FROM attempts WHERE id=?').bind(attemptId).first();
  if (!attempt || attempt.status !== 'in_progress') return;
  const [questions, answerResult] = await Promise.all([
    getExamQuestions(db, attempt.exam_id),
    db.prepare('SELECT * FROM answers WHERE attempt_id=?').bind(attemptId).all(),
  ]);
  const existing = new Map((answerResult.results || []).map((answer) => [answer.question_id, answer]));
  let score = 0;
  const statements = [];
  for (const question of questions) {
    const answer = existing.get(question.id);
    const correct = Boolean(answer?.selected_option && answer.selected_option === question.correct_option);
    const marks = correct ? question.marks : 0;
    if (correct) score += marks;
    if (answer) statements.push(db.prepare('UPDATE answers SET is_correct=?,marks_awarded=? WHERE id=?').bind(correct ? 1 : 0, marks, answer.id));
  }
  statements.push(db.prepare(`UPDATE attempts SET status=?,submitted_at=?,score=? WHERE id=? AND status='in_progress'`)
    .bind(status, new Date().toISOString(), score, attemptId));
  await db.batch(statements);
}

async function enforceDeadline(db, attempt) {
  if (attempt?.status === 'in_progress' && Date.now() >= deadlineFor(attempt).getTime()) {
    await finalizeAttempt(db, attempt.id, 'auto_submitted');
    return db.prepare(`SELECT a.*,e.title AS exam_title,e.duration_minutes,e.show_score,e.show_answers
      FROM attempts a JOIN exams e ON e.id=a.exam_id WHERE a.access_token=?`).bind(attempt.access_token).first();
  }
  return attempt;
}

async function getStudentAttempt(db, token) {
  const attempt = await db.prepare(`SELECT a.*,e.title AS exam_title,e.duration_minutes,e.show_score,e.show_answers
    FROM attempts a JOIN exams e ON e.id=a.exam_id WHERE a.access_token=?`).bind(token).first();
  return enforceDeadline(db, attempt);
}

async function safeResult(db, attempt, detailed) {
  if (!attempt || attempt.status === 'in_progress') return null;
  const result = { status: attempt.status, submittedAt: attempt.submitted_at };
  if (attempt.show_score) result.score = attempt.score;
  if (detailed && attempt.show_answers && attempt.show_score) {
    result.answers = await db.prepare(`SELECT q.id AS question_id,q.question_text,q.option_a,q.option_b,q.option_c,q.option_d,q.correct_option,
        eq.marks,a.selected_option,a.is_correct,a.marks_awarded FROM exam_questions eq JOIN questions q ON q.id=eq.question_id
      LEFT JOIN answers a ON a.question_id=q.id AND a.attempt_id=? WHERE eq.exam_id=? ORDER BY eq.sort_order,eq.id`)
      .bind(attempt.id, attempt.exam_id).all().then((response) => response.results || []);
  }
  return result;
}

function lockHeader(token) {
  return `mcq.sid=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${sessionSeconds}`;
}

app.get('/api/health', (c) => c.json({ ok: true, database: 'D1' }));
app.get('/api/admin/session', async (c) => c.json({ authenticated: Boolean(await adminUser(c)) }));
app.post('/api/admin/login', async (c) => {
  if (!c.env.ADMIN_USERNAME || !c.env.ADMIN_PASSWORD || !c.env.SESSION_SECRET) return apiError(c, 503, 'Admin login is not configured.');
  let body;
  try { body = await c.req.json(); } catch { return apiError(c, 400, 'Enter your username and password.'); }
  const submitted = `${String(body?.username ?? '')}\0${String(body?.password ?? '')}`;
  const expected = `${c.env.ADMIN_USERNAME}\0${c.env.ADMIN_PASSWORD}`;
  let mismatch = submitted.length ^ expected.length;
  for (let index = 0; index < Math.max(submitted.length, expected.length); index += 1) mismatch |= (submitted.charCodeAt(index) || 0) ^ (expected.charCodeAt(index) || 0);
  if (mismatch) return apiError(c, 401, 'The username or password is incorrect.');
  const token = await makeAdminToken(c.env.ADMIN_USERNAME, c.env.SESSION_SECRET);
  return c.json({ authenticated: true }, 200, { 'Set-Cookie': lockHeader(token) });
});
app.post('/api/admin/logout', requireAdmin, (c) => c.json({ ok: true }, 200, {
  'Set-Cookie': 'mcq.sid=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0',
}));

app.get('/api/exams', async (c) => {
  await ensureSeeded(c.env.DB);
  const { results = [] } = await c.env.DB.prepare(`SELECT e.id,e.title,e.description,e.duration_minutes,e.created_at,COUNT(eq.id) AS question_count
    FROM exams e LEFT JOIN exam_questions eq ON eq.exam_id=e.id WHERE e.status='published'
    GROUP BY e.id ORDER BY e.created_at DESC,e.id DESC`).all();
  return c.json(results);
});

app.get('/api/admin/questions', requireAdmin, async (c) => {
  await ensureSeeded(c.env.DB);
  const { results = [] } = await c.env.DB.prepare(`SELECT q.*,
    EXISTS(SELECT 1 FROM exam_questions eq WHERE eq.question_id=q.id) AS locked FROM questions q ORDER BY q.id DESC`).all();
  return c.json(results);
});

app.post('/api/admin/questions', requireAdmin, async (c) => {
  const { question, errors } = normalizeQuestion(await c.req.json().catch(() => ({})));
  if (errors.length) return apiError(c, 400, 'Please correct the question details.', errors);
  const result = await c.env.DB.prepare(`INSERT INTO questions (question_text,option_a,option_b,option_c,option_d,correct_option,category,difficulty)
    VALUES (?,?,?,?,?,?,?,?)`).bind(question.question_text,question.option_a,question.option_b,question.option_c,question.option_d,question.correct_option,question.category,question.difficulty).run();
  return c.json(await c.env.DB.prepare('SELECT * FROM questions WHERE id=?').bind(result.meta.last_row_id).first(), 201);
});

app.put('/api/admin/questions/:id', requireAdmin, async (c) => {
  const id = Number(c.req.param('id'));
  const found = await c.env.DB.prepare('SELECT id FROM questions WHERE id=?').bind(id).first();
  if (!found) return apiError(c, 404, 'Question not found.');
  if (await c.env.DB.prepare('SELECT 1 FROM exam_questions WHERE question_id=? LIMIT 1').bind(id).first()) return apiError(c, 409, 'This question belongs to an exam and can no longer be edited.');
  const { question, errors } = normalizeQuestion(await c.req.json().catch(() => ({})));
  if (errors.length) return apiError(c, 400, 'Please correct the question details.', errors);
  await c.env.DB.prepare(`UPDATE questions SET question_text=?,option_a=?,option_b=?,option_c=?,option_d=?,correct_option=?,category=?,difficulty=? WHERE id=?`)
    .bind(question.question_text,question.option_a,question.option_b,question.option_c,question.option_d,question.correct_option,question.category,question.difficulty,id).run();
  return c.json(await c.env.DB.prepare('SELECT * FROM questions WHERE id=?').bind(id).first());
});

app.delete('/api/admin/questions/:id', requireAdmin, async (c) => {
  const id = Number(c.req.param('id'));
  if (!await c.env.DB.prepare('SELECT id FROM questions WHERE id=?').bind(id).first()) return apiError(c, 404, 'Question not found.');
  if (await c.env.DB.prepare('SELECT 1 FROM exam_questions WHERE question_id=? LIMIT 1').bind(id).first()) return apiError(c, 409, 'This question belongs to an exam and can no longer be deleted.');
  await c.env.DB.prepare('DELETE FROM questions WHERE id=?').bind(id).run();
  return c.json({ ok: true });
});

app.get('/api/admin/questions/template', requireAdmin, (c) => {
  const book = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([templateHeaders]);
  sheet['!cols'] = templateHeaders.map((header) => ({ wch: Math.max(header.length + 2, 18) }));
  XLSX.utils.book_append_sheet(book, sheet, 'Questions');
  const bytes = XLSX.write(book, { type: 'array', bookType: 'xlsx' });
  return new Response(bytes, { headers: {
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': 'attachment; filename="mcq-question-template.xlsx"',
  } });
});

app.post('/api/admin/questions/import', requireAdmin, async (c) => {
  let file;
  try { file = (await c.req.raw.formData()).get('file'); } catch { return apiError(c, 400, 'Choose an Excel workbook to import.'); }
  if (!file || typeof file.arrayBuffer !== 'function') return apiError(c, 400, 'Choose an Excel workbook to import.');
  if (file.size > 8 * 1024 * 1024) return apiError(c, 413, 'The workbook must be smaller than 8 MB.');
  let rows;
  try {
    const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array' });
    rows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { header: 1, defval: '', raw: false });
  } catch { return apiError(c, 400, 'This file could not be read as an Excel workbook.'); }
  if (!rows?.length) return apiError(c, 400, 'The workbook is empty.');
  const headerIndexes = new Map(rows[0].map((value, index) => [String(value).trim().toLowerCase(), index]));
  const missing = templateHeaders.slice(0, 6).filter((header) => !headerIndexes.has(header.toLowerCase()));
  if (missing.length) return apiError(c, 400, `Missing required columns: ${missing.join(', ')}.`);
  const imported = [];
  const errors = [];
  for (let index = 1; index < rows.length; index += 1) {
    const cells = rows[index];
    if (cells.every((value) => String(value ?? '').trim() === '')) continue;
    const input = Object.fromEntries(templateHeaders.map((header) => [header, cells[headerIndexes.get(header.toLowerCase())] ?? '']));
    const { question, errors: rowErrors } = normalizeQuestion(input);
    rowErrors.forEach((error) => errors.push(`Row ${index + 1}: ${error}`));
    imported.push(question);
  }
  if (imported.length > 900) errors.push('The workbook may contain at most 900 question rows.');
  if (!imported.length && !errors.length) errors.push('No populated question rows were found.');
  if (errors.length) return apiError(c, 400, 'The workbook has validation errors. No questions were imported.', errors);
  await c.env.DB.batch(imported.map((q) => c.env.DB.prepare(`INSERT INTO questions
    (question_text,option_a,option_b,option_c,option_d,correct_option,category,difficulty) VALUES (?,?,?,?,?,?,?,?)`)
    .bind(q.question_text,q.option_a,q.option_b,q.option_c,q.option_d,q.correct_option,q.category,q.difficulty)));
  return c.json({ imported: imported.length });
});

app.get('/api/admin/exams', requireAdmin, async (c) => {
  await ensureSeeded(c.env.DB);
  const { results = [] } = await c.env.DB.prepare(`SELECT e.*,COUNT(DISTINCT eq.id) AS question_count,
      COUNT(DISTINCT a.id) AS participant_count,COUNT(DISTINCT CASE WHEN a.status!='in_progress' THEN a.id END) AS submitted_count
    FROM exams e LEFT JOIN exam_questions eq ON eq.exam_id=e.id LEFT JOIN attempts a ON a.exam_id=e.id
    GROUP BY e.id ORDER BY e.created_at DESC,e.id DESC`).all();
  return c.json(results);
});

app.post('/api/admin/exams', requireAdmin, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const title = String(body.title || '').trim();
  const description = String(body.description || '').trim();
  const duration = Number(body.duration_minutes);
  const status = ['draft','published','closed'].includes(body.status) ? body.status : 'draft';
  const showScore = body.show_score ? 1 : 0;
  const showAnswers = body.show_answers ? 1 : 0;
  const ids = Array.isArray(body.question_ids) ? [...new Set(body.question_ids.map(Number).filter(Number.isSafeInteger))] : [];
  if (!title) return apiError(c, 400, 'Exam title is required.');
  if (!Number.isInteger(duration) || duration < 1 || duration > 1440) return apiError(c, 400, 'Duration must be between 1 and 1440 minutes.');
  if (showAnswers && !showScore) return apiError(c, 400, 'Show score must be enabled to show answer review.');
  if (!ids.length) return apiError(c, 400, 'Select at least one question for this exam.');
  const available = await c.env.DB.prepare(`SELECT id FROM questions WHERE id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all();
  if ((available.results || []).length !== ids.length) return apiError(c, 400, 'One or more selected questions are no longer available. Refresh the question bank and try again.');
  const created = await c.env.DB.prepare(`INSERT INTO exams (title,description,duration_minutes,status,show_score,show_answers) VALUES (?,?,?,?,?,?)`)
    .bind(title,description,duration,status,showScore,showAnswers).run();
  const examId = created.meta.last_row_id;
  await c.env.DB.batch(ids.map((questionId, index) => c.env.DB.prepare('INSERT INTO exam_questions (exam_id,question_id,marks,sort_order) VALUES (?,?,?,?)').bind(examId,questionId,1,index)));
  return c.json(await c.env.DB.prepare(`SELECT e.*,COUNT(eq.id) AS question_count FROM exams e
    LEFT JOIN exam_questions eq ON eq.exam_id=e.id WHERE e.id=? GROUP BY e.id`).bind(examId).first(), 201);
});

app.patch('/api/admin/exams/:id/status', requireAdmin, async (c) => {
  const status = (await c.req.json().catch(() => ({}))).status;
  if (!['draft','published','closed'].includes(status)) return apiError(c, 400, 'Choose draft, published or closed.');
  const result = await c.env.DB.prepare('UPDATE exams SET status=? WHERE id=?').bind(status, Number(c.req.param('id'))).run();
  if (!result.meta.changes) return apiError(c, 404, 'Exam not found.');
  return c.json({ ok: true, status });
});

app.patch('/api/admin/exams/:id/settings', requireAdmin, async (c) => {
  const id = Number(c.req.param('id'));
  const exam = await c.env.DB.prepare('SELECT show_score,show_answers FROM exams WHERE id=?').bind(id).first();
  if (!exam) return apiError(c, 404, 'Exam not found.');
  const body = await c.req.json().catch(() => ({}));
  const showScore = body.show_score === undefined ? Number(exam.show_score) : Number(Boolean(body.show_score));
  const showAnswers = body.show_answers === undefined ? Number(exam.show_answers) : Number(Boolean(body.show_answers));
  if (showAnswers && !showScore) return apiError(c, 400, 'Show score must be enabled to show answer review.');
  await c.env.DB.prepare('UPDATE exams SET show_score=?,show_answers=? WHERE id=?').bind(showScore,showAnswers,id).run();
  return c.json({ ok: true, show_score: showScore, show_answers: showAnswers });
});

app.get('/api/admin/exams/:id/questions', requireAdmin, async (c) => {
  await ensureSeeded(c.env.DB);
  const questions = await getExamQuestions(c.env.DB, Number(c.req.param('id')));
  if (!questions.length) return apiError(c, 404, 'Exam not found or it has no questions.');
  return c.json(questions);
});

app.get('/api/admin/exams/:id/attempts', requireAdmin, async (c) => {
  const exam = await c.env.DB.prepare('SELECT id FROM exams WHERE id=?').bind(Number(c.req.param('id'))).first();
  if (!exam) return apiError(c, 404, 'Exam not found.');
  const { results = [] } = await c.env.DB.prepare(`SELECT id,student_name,roll_number,email,started_at,submitted_at,score,status
    FROM attempts WHERE exam_id=? ORDER BY started_at DESC,id DESC`).bind(exam.id).all();
  return c.json(results);
});

app.get('/api/admin/attempts/:id', requireAdmin, async (c) => {
  const attempt = await c.env.DB.prepare(`SELECT a.*,e.title AS exam_title FROM attempts a JOIN exams e ON e.id=a.exam_id WHERE a.id=?`)
    .bind(Number(c.req.param('id'))).first();
  if (!attempt) return apiError(c, 404, 'Attempt not found.');
  const { results: answers = [] } = await c.env.DB.prepare(`SELECT q.id AS question_id,q.question_text,q.option_a,q.option_b,q.option_c,q.option_d,q.correct_option,
      eq.marks,a.selected_option,a.is_correct,a.marks_awarded FROM exam_questions eq JOIN questions q ON q.id=eq.question_id
    LEFT JOIN answers a ON a.question_id=q.id AND a.attempt_id=? WHERE eq.exam_id=? ORDER BY eq.sort_order,eq.id`)
    .bind(attempt.id,attempt.exam_id).all();
  return c.json({ ...attempt, answers });
});

app.post('/api/exams/:id/attempts', async (c) => {
  await ensureSeeded(c.env.DB);
  const exam = await c.env.DB.prepare("SELECT * FROM exams WHERE id=? AND status='published'").bind(Number(c.req.param('id'))).first();
  if (!exam) return apiError(c, 404, 'This examination is not available.');
  if (!await c.env.DB.prepare('SELECT 1 FROM exam_questions WHERE exam_id=? LIMIT 1').bind(exam.id).first()) return apiError(c, 409, 'This examination has no questions yet.');
  const body = await c.req.json().catch(() => ({}));
  const studentName = String(body.student_name || '').trim();
  const rollNumber = String(body.roll_number || '').trim();
  const email = String(body.email || '').trim();
  if (!studentName || studentName.length > 120) return apiError(c, 400, 'Enter your name (up to 120 characters).');
  if (!rollNumber || rollNumber.length > 60) return apiError(c, 400, 'Enter your roll number (up to 60 characters).');
  if (email && (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) return apiError(c, 400, 'Enter a valid email address or leave it blank.');
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = b64url(bytes);
  const result = await c.env.DB.prepare(`INSERT INTO attempts (exam_id,access_token,student_name,roll_number,email,started_at)
    VALUES (?,?,?,?,?,?)`).bind(exam.id,token,studentName,rollNumber,email,new Date().toISOString()).run();
  return c.json({ token, attempt_id: result.meta.last_row_id }, 201);
});

app.get('/api/attempts/:token', async (c) => {
  await ensureSeeded(c.env.DB);
  const attempt = await getStudentAttempt(c.env.DB, c.req.param('token'));
  if (!attempt) return apiError(c, 404, 'Attempt not found. Return to the exam list to start again.');
  const deadline = deadlineFor(attempt);
  const questions = (await getExamQuestions(c.env.DB, attempt.exam_id)).map((question) => ({
    id: question.id,question_text: question.question_text,option_a: question.option_a,option_b: question.option_b,
    option_c: question.option_c,option_d: question.option_d,marks: question.marks,sort_order: question.sort_order,
  }));
  const { results: answers = [] } = await c.env.DB.prepare('SELECT question_id,selected_option FROM answers WHERE attempt_id=?').bind(attempt.id).all();
  return c.json({
    id: attempt.id,exam_id: attempt.exam_id,exam_title: attempt.exam_title,student_name: attempt.student_name,
    roll_number: attempt.roll_number,email: attempt.email,status: attempt.status,started_at: attempt.started_at,
    deadline: deadline.toISOString(),remaining_seconds: Math.max(0,Math.floor((deadline.getTime()-Date.now())/1000)),
    questions,answers,result: await safeResult(c.env.DB,attempt,true),
  });
});

app.put('/api/attempts/:token/answers', async (c) => {
  const attempt = await getStudentAttempt(c.env.DB, c.req.param('token'));
  if (!attempt) return apiError(c, 404, 'Attempt not found.');
  if (attempt.status !== 'in_progress') return apiError(c, 409, 'This attempt has already been submitted.', { result: await safeResult(c.env.DB,attempt,true) });
  const body = await c.req.json().catch(() => ({}));
  const questionId = Number(body.question_id);
  const selectedOption = body.selected_option === null || body.selected_option === '' ? null : String(body.selected_option || '').toUpperCase();
  if (!['A','B','C','D',null].includes(selectedOption)) return apiError(c, 400, 'Choose option A, B, C or D.');
  if (!await c.env.DB.prepare('SELECT 1 FROM exam_questions WHERE exam_id=? AND question_id=?').bind(attempt.exam_id,questionId).first()) return apiError(c, 400, 'That question is not part of this examination.');
  await c.env.DB.prepare(`INSERT INTO answers (attempt_id,question_id,selected_option) VALUES (?,?,?)
    ON CONFLICT(attempt_id,question_id) DO UPDATE SET selected_option=excluded.selected_option,is_correct=NULL,marks_awarded=0`)
    .bind(attempt.id,questionId,selectedOption).run();
  return c.json({ ok: true });
});

app.post('/api/attempts/:token/submit', async (c) => {
  let attempt = await getStudentAttempt(c.env.DB, c.req.param('token'));
  if (!attempt) return apiError(c, 404, 'Attempt not found.');
  if (attempt.status === 'in_progress') await finalizeAttempt(c.env.DB,attempt.id,'submitted');
  attempt = await getStudentAttempt(c.env.DB,c.req.param('token'));
  return c.json({ message: 'Your exam has been submitted successfully.', result: await safeResult(c.env.DB,attempt,true) });
});

app.use('/api/*', (c) => apiError(c, 404, 'API route not found.'));
app.get('*', (c) => {
  const path = c.req.path === '/' ? '/index.html' : c.req.path;
  const asset = CLIENT_ASSETS[path] || (path.includes('.') ? null : CLIENT_ASSETS['/index.html']);
  if (!asset) return c.text('Not found', 404);
  return new Response(asset.body, { headers: { 'Content-Type': asset.contentType, 'Cache-Control': path === '/index.html' ? 'no-cache' : 'public, max-age=31536000, immutable' } });
});

export default {
  fetch(request, env, ctx) {
    return app.fetch(request, env, ctx);
  },
};
