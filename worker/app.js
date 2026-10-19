import { Hono } from 'hono';
import * as XLSX from 'xlsx/xlsx.mjs';
import seedData from '../site-seed.json';
import { CLIENT_ASSETS } from 'virtual:client-assets';
import { shortenWithIsgd } from '../server/isgd.js';
import { MediaError, inspectMediaBytes, isMediaFilename, mediaHeaders, parseMediaRange, objectMediaStore, readMediaForm, mediaPublishProblem, questionMediaItems, backupMediaManifest } from '../server/media-storage.js';
import { listReusableStimuli } from '../server/stimuli.js';
import {
  normalizeQuestion,
  hydrateQuestionRow,
  hydrateAnswerRow,
  validateStudentAnswer,
  evaluateQuestionAnswer,
  validateQuestionMedia,
  parseQuestionPaste,
  buildLegacyMcqConfig,
  buildLegacyMcqAnswerKey,
} from '../server/question-types.js';
import { createQuestionWorkbook, parseQuestionWorkbook } from '../server/question-import.js';

const app = new Hono();
const sessionSeconds = 8 * 60 * 60;
const allowedNegativeMarks = [0, 1, 0.25, 0.5];
const passwordIterations = 210000;

function apiError(c, status, error, details) {
  return c.json({ error, ...(details ? { details } : {}) }, status);
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

async function passwordHash(password, salt) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const digest = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: fromB64url(salt), iterations: passwordIterations, hash: 'SHA-256' }, key, 256);
  return b64url(new Uint8Array(digest));
}

function constantTimeEqual(leftValue, rightValue) {
  const left = fromB64url(leftValue);
  const right = fromB64url(rightValue);
  let mismatch = left.length ^ right.length;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) mismatch |= (left[index] || 0) ^ (right[index] || 0);
  return mismatch === 0;
}

async function ensureAdminAuth(db, env) {
  let auth = await db.prepare('SELECT id,password_salt,password_hash,session_version FROM admin_auth WHERE id=1').first();
  if (auth || !env.ADMIN_PASSWORD) return auth;
  const salt = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const hash = await passwordHash(String(env.ADMIN_PASSWORD), salt);
  await db.prepare(`INSERT INTO admin_auth (id,password_salt,password_hash,session_version) VALUES (1,?,?,1)
    ON CONFLICT(id) DO NOTHING`).bind(salt, hash).run();
  return db.prepare('SELECT id,password_salt,password_hash,session_version FROM admin_auth WHERE id=1').first();
}

async function makeAdminToken(username, secret, sessionVersion) {
  const payload = b64url(new TextEncoder().encode(JSON.stringify({ username, exp: Math.floor(Date.now() / 1000) + sessionSeconds, version: sessionVersion })));
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
    if (claims.username !== c.env.ADMIN_USERNAME || claims.exp <= Math.floor(Date.now() / 1000)) return null;
    const auth = await ensureAdminAuth(c.env.DB, c.env);
    return auth && claims.version === Number(auth.session_version) ? claims.username : null;
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
    const qType = q.question_type || 'mcq_single';
    const qConfig = typeof q.question_config === 'string'
      ? q.question_config
      : JSON.stringify(q.question_config || buildLegacyMcqConfig(q));
    const answerKey = typeof q.answer_key === 'string'
      ? q.answer_key
      : JSON.stringify(q.answer_key || buildLegacyMcqAnswerKey(q));
    const media = q.media ? (typeof q.media === 'string' ? q.media : JSON.stringify(q.media)) : null;
    statements.push(db.prepare(`INSERT INTO questions (id,question_text,question_type,option_a,option_b,option_c,option_d,correct_option,question_config,answer_key,media,category,difficulty,explanation,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`).bind(
      q.id,
      q.question_text,
      qType,
      q.option_a,
      q.option_b,
      q.option_c,
      q.option_d,
      q.correct_option,
      qConfig,
      answerKey,
      media,
      q.category,
      q.difficulty,
      q.explanation || '',
      q.created_at,
    ));
  }
  for (const e of seedData.exams) {
    statements.push(db.prepare(`INSERT INTO exams (id,title,description,duration_minutes,subject,negative_mark,status,show_score,show_answers,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`).bind(e.id,e.title,e.description,e.duration_minutes,e.subject || '',e.negative_mark || 0,e.status,e.show_score,e.show_answers,e.created_at));
  }
  for (const eq of seedData.exam_questions) {
    statements.push(db.prepare(`INSERT INTO exam_questions (exam_id,question_id,marks,sort_order)
      VALUES (?,?,?,?) ON CONFLICT(exam_id,question_id) DO NOTHING`).bind(eq.exam_id,eq.question_id,eq.marks,eq.sort_order));
  }
  await db.batch(statements);
}

async function getExamQuestions(db, examId) {
  const { results = [] } = await db.prepare(`SELECT q.id,q.question_text,q.question_type,q.option_a,q.option_b,q.option_c,q.option_d,
      q.correct_option,q.question_config,q.answer_key,q.media,q.explanation,q.category,
      eq.marks,eq.sort_order FROM exam_questions eq JOIN questions q ON q.id=eq.question_id
    WHERE eq.exam_id=? ORDER BY eq.sort_order,eq.id`).bind(examId).all();
  return results;
}

function deadlineFor(attempt) {
  return new Date(new Date(attempt.started_at).getTime() + Number(attempt.duration_minutes) * 60_000);
}

async function finalizeAttempt(db, attemptId, status) {
  // D1 batches are transactional, but JavaScript reads before a batch are not.
  // Compare the raw response snapshot before committing; a concurrent save makes
  // this entire grading batch a no-op and is included by the next retry.
  for (let retry = 0; retry < 8; retry += 1) {
    const attempt = await db.prepare('SELECT a.*,e.negative_mark FROM attempts a JOIN exams e ON e.id=a.exam_id WHERE a.id=?').bind(attemptId).first();
    if (!attempt || attempt.status !== 'in_progress') return true;
    const [questions, answerResult] = await Promise.all([
      getExamQuestions(db, attempt.exam_id),
      db.prepare('SELECT * FROM answers WHERE attempt_id=?').bind(attemptId).all(),
    ]);
    const answers = answerResult.results || [];
    const existing = new Map(answers.map((answer) => [answer.question_id, answer]));
    const grades = questions.map((question) => ({
      answer: existing.get(question.id),
      ...evaluateQuestionAnswer(question, existing.get(question.id), Number(attempt.negative_mark || 0)),
    }));
    const snapshot = JSON.stringify(answers.map(({ id, question_id, selected_option, answer_data }) => ({ id, question_id, selected_option, answer_data })));
    const statements = [db.prepare(`UPDATE attempts SET status=?,submitted_at=?,score=?
      WHERE id=? AND status='in_progress'
      AND (SELECT COUNT(*) FROM answers WHERE attempt_id=?)=json_array_length(?)
      AND NOT EXISTS (
        SELECT 1 FROM answers a LEFT JOIN json_each(?) saved ON a.id=json_extract(saved.value,'$.id')
        WHERE a.attempt_id=? AND (saved.value IS NULL
          OR a.question_id IS NOT json_extract(saved.value,'$.question_id')
          OR a.selected_option IS NOT json_extract(saved.value,'$.selected_option')
          OR a.answer_data IS NOT json_extract(saved.value,'$.answer_data'))
      )`).bind(status, new Date().toISOString(), grades.reduce((sum, grade) => sum + grade.marksAwarded, 0), attemptId, attemptId, snapshot, snapshot, attemptId)];
    // changes() propagates the successful compare-and-set through this atomic
    // batch. A losing submission cannot overwrite marks from the winning one.
    for (const { answer, isCorrect, marksAwarded } of grades) {
      if (answer) statements.push(db.prepare('UPDATE answers SET is_correct=?,marks_awarded=? WHERE id=? AND changes()=1')
        .bind(isCorrect ? 1 : 0, marksAwarded, answer.id));
    }
    const result = await db.batch(statements);
    if (result[0]?.meta?.changes === 1) return true;
  }
  throw new Error('Answers are changing concurrently. Please retry submitting the examination.');
}

async function enforceDeadline(db, attempt) {
  if (attempt?.status === 'in_progress' && Date.now() >= deadlineFor(attempt).getTime()) {
    await finalizeAttempt(db, attempt.id, 'auto_submitted');
    return db.prepare(`SELECT a.*,e.title AS exam_title,e.duration_minutes,e.negative_mark,e.show_score,e.show_answers,e.allow_pdf_download
      FROM attempts a JOIN exams e ON e.id=a.exam_id WHERE a.access_token=?`).bind(attempt.access_token).first();
  }
  return attempt;
}

async function getStudentAttempt(db, token) {
  const attempt = await db.prepare(`SELECT a.*,e.title AS exam_title,e.duration_minutes,e.negative_mark,e.show_score,e.show_answers,e.allow_pdf_download
    FROM attempts a JOIN exams e ON e.id=a.exam_id WHERE a.access_token=?`).bind(token).first();
  return enforceDeadline(db, attempt);
}

async function safeResult(db, attempt, detailed) {
  if (!attempt || attempt.status === 'in_progress') return null;
  const result = {
    status: attempt.status,
    submittedAt: attempt.submitted_at,
    allow_pdf_download: Boolean(attempt.allow_pdf_download),
  };
  if (attempt.show_score || attempt.allow_pdf_download) result.score = attempt.score;
  if (detailed && ((attempt.show_answers && attempt.show_score) || attempt.allow_pdf_download)) {
    result.answers = await db.prepare(`SELECT q.id AS question_id,q.question_text,q.question_type,q.option_a,q.option_b,q.option_c,q.option_d,
        q.correct_option,q.question_config,q.answer_key,q.media,q.explanation,
        eq.marks,a.selected_option,a.answer_data,a.is_correct,a.marks_awarded FROM exam_questions eq JOIN questions q ON q.id=eq.question_id
      LEFT JOIN answers a ON a.question_id=q.id AND a.attempt_id=? WHERE eq.exam_id=? ORDER BY eq.sort_order,eq.id`)
      .bind(attempt.id, attempt.exam_id).all().then((response) => (response.results || []).map((row) => hydrateAnswerRow(row)));
  }
  return result;
}

function lockHeader(token) {
  return `mcq.sid=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${sessionSeconds}`;
}

app.get('/api/health', (c) => c.json({ ok: true, database: 'D1' }));
app.get('/api/admin/session', async (c) => c.json({ authenticated: Boolean(await adminUser(c)) }));
app.post('/api/admin/login', async (c) => {
  if (!c.env.ADMIN_USERNAME || !c.env.SESSION_SECRET) return apiError(c, 503, 'Admin login is not configured.');
  let body;
  try { body = await c.req.json(); } catch { return apiError(c, 400, 'Enter your username and password.'); }
  const auth = await ensureAdminAuth(c.env.DB, c.env);
  if (!auth) return apiError(c, 503, 'Admin login is not configured.');
  const submittedPassword = String(body?.password ?? '');
  const submittedHash = await passwordHash(submittedPassword, auth.password_salt);
  if (String(body?.username ?? '') !== c.env.ADMIN_USERNAME || !constantTimeEqual(submittedHash, auth.password_hash)) {
    return apiError(c, 401, 'The username or password is incorrect.');
  }
  const token = await makeAdminToken(c.env.ADMIN_USERNAME, c.env.SESSION_SECRET, Number(auth.session_version));
  return c.json({ authenticated: true }, 200, { 'Set-Cookie': lockHeader(token) });
});
app.post('/api/admin/password', requireAdmin, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const currentPassword = String(body.current_password ?? '');
  const newPassword = String(body.new_password ?? '');
  if (newPassword.length < 12 || newPassword.length > 128) return apiError(c, 400, 'New password must be 12 to 128 characters.');
  const auth = await ensureAdminAuth(c.env.DB, c.env);
  if (!auth || !constantTimeEqual(await passwordHash(currentPassword, auth.password_salt), auth.password_hash)) {
    return apiError(c, 401, 'The current password is incorrect.');
  }
  const salt = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const hash = await passwordHash(newPassword, salt);
  await c.env.DB.prepare(`UPDATE admin_auth SET password_salt=?,password_hash=?,session_version=session_version+1 WHERE id=1`)
    .bind(salt, hash).run();
  return c.json({ ok: true }, 200, { 'Set-Cookie': 'mcq.sid=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0' });
});
app.post('/api/admin/logout', requireAdmin, (c) => c.json({ ok: true }, 200, {
  'Set-Cookie': 'mcq.sid=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0',
}));

app.get('/api/exams', async (c) => {
  await ensureSeeded(c.env.DB);
  const { results = [] } = await c.env.DB.prepare(`SELECT e.id,e.title,e.description,e.duration_minutes,e.created_at,COUNT(eq.id) AS question_count, COALESCE(SUM(eq.marks),0) AS total_marks
    FROM exams e LEFT JOIN exam_questions eq ON eq.exam_id=e.id WHERE e.status='published'
    GROUP BY e.id ORDER BY e.created_at DESC,e.id DESC`).all();
  return c.json(results);
});

app.get('/api/exams/:id', async (c) => {
  await ensureSeeded(c.env.DB);
  const exam = await c.env.DB.prepare(`SELECT e.id,e.title,e.description,e.subject,e.duration_minutes,e.negative_mark,e.created_at,
      COUNT(eq.id) AS question_count, COALESCE(SUM(eq.marks),0) AS total_marks FROM exams e LEFT JOIN exam_questions eq ON eq.exam_id=e.id
    WHERE e.id=? AND e.status='published' GROUP BY e.id`).bind(Number(c.req.param('id'))).first();
  if (!exam) return apiError(c, 404, 'This examination is not available.');
  return c.json(exam);
});

app.get('/api/admin/backup', requireAdmin, async (c) => {
  const tables = ['questions', 'exams', 'exam_questions', 'attempts', 'answers', 'admin_auth', 'site_meta'];
  const results = await c.env.DB.batch(tables.map((table) => c.env.DB.prepare(`SELECT * FROM ${table}`)));
  c.header('Cache-Control', 'no-store');
  c.header('Content-Disposition', `attachment; filename="mcq-backup-${new Date().toISOString().slice(0, 10)}.json"`);
  return c.json({ format: 'mcq-database-backup', version: 1, created_at: new Date().toISOString(), tables: Object.fromEntries(tables.map((table, i) => [table, results[i].results])), media: backupMediaManifest(results[0].results, 'MEDIA_BUCKET') });
});

app.get('/api/admin/questions', requireAdmin, async (c) => {
  await ensureSeeded(c.env.DB);
  const { results = [] } = await c.env.DB.prepare(`SELECT q.*,
    EXISTS(SELECT 1 FROM exam_questions eq WHERE eq.question_id=q.id) AS locked FROM questions q WHERE q.archived=0 ORDER BY q.id DESC`).all();
  return c.json(results.map((row) => hydrateQuestionRow(row)));
});

app.get('/api/admin/stimuli', requireAdmin, async (c) => {
  const { results = [] } = await c.env.DB.prepare('SELECT * FROM questions WHERE archived=0 ORDER BY id DESC').all();
  return c.json(listReusableStimuli(results));
});

app.post('/api/admin/questions', requireAdmin, async (c) => {
  const { question, errors } = normalizeQuestion(await c.req.json().catch(() => ({})));
  if (errors.length) return apiError(c, 400, 'Please correct the question details.', errors);
  const result = await c.env.DB.prepare(`INSERT INTO questions (question_text,question_type,option_a,option_b,option_c,option_d,correct_option,question_config,answer_key,media,category,difficulty,explanation)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
    question.question_text,
    question.question_type,
    question.option_a,
    question.option_b,
    question.option_c,
    question.option_d,
    question.correct_option,
    question.question_config,
    question.answer_key,
    question.media,
    question.category,
    question.difficulty,
    question.explanation,
  ).run();
  const created = await c.env.DB.prepare(`SELECT q.*, EXISTS(SELECT 1 FROM exam_questions eq WHERE eq.question_id=q.id) AS locked
    FROM questions q WHERE q.id=?`).bind(result.meta.last_row_id).first();
  return c.json(hydrateQuestionRow(created), 201);
});

app.on(['GET', 'HEAD'], '/api/media/:filename', async (c) => {
  const filename = c.req.param('filename');
  if (!isMediaFilename(filename)) return apiError(c, 404, 'Media not found.');
  try {
    const store = objectMediaStore(c.env.MEDIA_BUCKET);
    const metadata = await store.head(filename);
    if (!metadata) return apiError(c, 404, 'Media not found.');
    const mime = metadata.httpMetadata?.contentType;
    if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/flac'].includes(mime)) return apiError(c, 404, 'Media not found.');
    const headers = new Headers(mediaHeaders(mime, filename));
    let range;
    try { range = parseMediaRange(c.req.header('Range'), metadata.size); }
    catch (error) { headers.set('Content-Range', `bytes */${metadata.size}`); return new Response(null, { status: 416, headers }); }
    if (metadata.httpEtag) headers.set('ETag', metadata.httpEtag);
    headers.set('Content-Length', String(range ? range.length : metadata.size));
    if (range) headers.set('Content-Range', `bytes ${range.offset}-${range.offset + range.length - 1}/${metadata.size}`);
    if (c.req.method === 'HEAD') return new Response(null, { status: range ? 206 : 200, headers });
    const object = await store.get(filename, range);
    if (!object?.body) return apiError(c, 404, 'Media not found.');
    return new Response(object.body, { status: range ? 206 : 200, headers });
  } catch (error) {
    if (error instanceof MediaError) return apiError(c, error.status, error.message);
    console.error('Media read failed:', error.message);
    return apiError(c, 503, 'Media is temporarily unavailable.');
  }
});

app.post('/api/admin/media/upload', requireAdmin, async (c) => {
  try {
    const store = objectMediaStore(c.env.MEDIA_BUCKET);
    const file = await readMediaForm(c.req.raw);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const info = inspectMediaBytes(bytes, file.type);
    return c.json(await store.put(bytes, info));
  } catch (error) {
    if (error instanceof MediaError) return apiError(c, error.status, error.message);
    console.error('Media upload failed:', error.message);
    return apiError(c, 503, 'Media could not be stored. Please try again.');
  }
});

app.post('/api/admin/questions/:id/media', requireAdmin, async (c) => {
  const id = Number(c.req.param('id'));
  const found = await c.env.DB.prepare('SELECT * FROM questions WHERE archived=0 AND id=?').bind(id).first();
  if (!found) return apiError(c, 404, 'Question not found.');
  const body = await c.req.json().catch(() => ({}));
  const rawMedia = Object.hasOwn(body || {}, 'media') ? body.media : body;
  const { media, errors } = validateQuestionMedia(rawMedia);
  if (errors.length) return apiError(c, 400, 'Invalid media payload.', errors);
  const serialized = media ? JSON.stringify(media) : null;
  let resultId = id;
  if (await c.env.DB.prepare('SELECT 1 FROM exam_questions WHERE question_id=? LIMIT 1').bind(id).first()) {
    const results = await c.env.DB.batch([
      c.env.DB.prepare(`INSERT INTO questions (question_text,question_type,option_a,option_b,option_c,option_d,correct_option,question_config,answer_key,media,category,difficulty,explanation)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(found.question_text, found.question_type, found.option_a, found.option_b,
        found.option_c, found.option_d, found.correct_option, found.question_config, found.answer_key, serialized,
        found.category, found.difficulty, found.explanation),
      c.env.DB.prepare('UPDATE questions SET archived=1 WHERE id=?').bind(id),
    ]);
    resultId = results[0].meta.last_row_id;
  } else {
    await c.env.DB.prepare('UPDATE questions SET media=? WHERE id=?').bind(serialized, id).run();
  }
  const updated = await c.env.DB.prepare(`SELECT q.*, EXISTS(SELECT 1 FROM exam_questions eq WHERE eq.question_id=q.id) AS locked FROM questions q WHERE q.id=?`).bind(resultId).first();
  return c.json(hydrateQuestionRow(updated));
});

async function publishMediaProblem(questions, env) {
  for (const question of questions) {
    const problem = mediaPublishProblem(question);
    if (problem) return problem;
    for (const { value } of questionMediaItems(question)) {
      if (value.url.startsWith('/api/media/')) {
        if (!env.MEDIA_BUCKET) return `Question #${question.id} needs hosted media storage (MEDIA_BUCKET) before publishing.`;
        let stored;
        try { stored = await objectMediaStore(env.MEDIA_BUCKET).head(value.url.slice('/api/media/'.length)); }
        catch { return `Question #${question.id} has media that is temporarily unavailable. Try publishing again later.`; }
        if (!stored) return `Question #${question.id} has a missing uploaded media file.`;
        if (!stored.httpMetadata?.contentType?.startsWith(`${value.type}/`)) return `Question #${question.id} has an attachment type that does not match its uploaded file.`;
      }
      if (value.url.startsWith('/uploads/')) return `Question #${question.id} references a local media file. Upload it to hosted storage before publishing.`;
    }
  }
  return null;
}

app.post('/api/admin/questions/bulk', requireAdmin, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const subject = String(body.subject ?? '').trim();
  if (!subject) return apiError(c, 400, 'Subject is required.');
  const { questions, errors } = parseQuestionPaste(body.text, subject);
  if (errors.length) return apiError(c, 400, 'Please use the required question format. No questions were imported.', errors);
  await c.env.DB.batch(questions.map((question) => c.env.DB.prepare(`INSERT INTO questions
    (question_text,question_type,option_a,option_b,option_c,option_d,correct_option,question_config,answer_key,media,category,difficulty,explanation) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(
      question.question_text,
      question.question_type,
      question.option_a,
      question.option_b,
      question.option_c,
      question.option_d,
      question.correct_option,
      question.question_config,
      question.answer_key,
      question.media,
      question.category,
      question.difficulty,
      question.explanation,
    )));
  return c.json({ imported: questions.length });
});

app.put('/api/admin/questions/:id', requireAdmin, async (c) => {
  const id = Number(c.req.param('id'));
  const found = await c.env.DB.prepare('SELECT id FROM questions WHERE archived=0 AND id=?').bind(id).first();
  if (!found) return apiError(c, 404, 'Question not found.');
  const { question, errors } = normalizeQuestion(await c.req.json().catch(() => ({})));
  if (errors.length) return apiError(c, 400, 'Please correct the question details.', errors);
  if (await c.env.DB.prepare('SELECT 1 FROM exam_questions WHERE question_id=? LIMIT 1').bind(id).first()) {
    const results = await c.env.DB.batch([
      c.env.DB.prepare(`INSERT INTO questions (question_text,question_type,option_a,option_b,option_c,option_d,correct_option,question_config,answer_key,media,category,difficulty,explanation)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
        question.question_text,
        question.question_type,
        question.option_a,
        question.option_b,
        question.option_c,
        question.option_d,
        question.correct_option,
        question.question_config,
        question.answer_key,
        question.media,
        question.category,
        question.difficulty,
        question.explanation,
      ),
      c.env.DB.prepare('UPDATE questions SET archived=1 WHERE id=?').bind(id),
    ]);
    const replacement = await c.env.DB.prepare(`SELECT q.*, EXISTS(SELECT 1 FROM exam_questions eq WHERE eq.question_id=q.id) AS locked
      FROM questions q WHERE q.id=?`).bind(results[0].meta.last_row_id).first();
    return c.json(hydrateQuestionRow(replacement));
  }
  await c.env.DB.prepare(`UPDATE questions SET question_text=?,question_type=?,option_a=?,option_b=?,option_c=?,option_d=?,correct_option=?,question_config=?,answer_key=?,media=?,category=?,difficulty=?,explanation=? WHERE id=?`)
    .bind(
      question.question_text,
      question.question_type,
      question.option_a,
      question.option_b,
      question.option_c,
      question.option_d,
      question.correct_option,
      question.question_config,
      question.answer_key,
      question.media,
      question.category,
      question.difficulty,
      question.explanation,
      id,
    ).run();
  const updated = await c.env.DB.prepare(`SELECT q.*, EXISTS(SELECT 1 FROM exam_questions eq WHERE eq.question_id=q.id) AS locked
    FROM questions q WHERE q.id=?`).bind(id).first();
  return c.json(hydrateQuestionRow(updated));
});

app.delete('/api/admin/questions/:id', requireAdmin, async (c) => {
  const id = Number(c.req.param('id'));
  if (!await c.env.DB.prepare('SELECT id FROM questions WHERE archived=0 AND id=?').bind(id).first()) return apiError(c, 404, 'Question not found.');
  await c.env.DB.prepare('UPDATE questions SET archived=1 WHERE id=?').bind(id).run();
  return c.json({ ok: true });
});

app.get('/api/admin/questions/template', requireAdmin, (c) => {
  const book = createQuestionWorkbook(XLSX);
  const bytes = XLSX.write(book, { type: 'array', bookType: 'xlsx' });
  return new Response(bytes, { headers: {
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': 'attachment; filename="mcq-question-template-v2.xlsx"',
  } });
});

app.get('/api/admin/questions/:id', requireAdmin, async (c) => {
  await ensureSeeded(c.env.DB);
  const id = Number(c.req.param('id'));
  if (!Number.isSafeInteger(id) || id < 1) return apiError(c, 404, 'Question not found.');
  const found = await c.env.DB.prepare(`SELECT q.*, EXISTS(SELECT 1 FROM exam_questions eq WHERE eq.question_id=q.id) AS locked
    FROM questions q WHERE q.archived=0 AND q.id=?`).bind(id).first();
  if (!found) return apiError(c, 404, 'Question not found.');
  return c.json(hydrateQuestionRow(found));
});

app.post('/api/admin/questions/import', requireAdmin, async (c) => {
  let file;
  let uploadSubject = '';
  try {
    const form = await c.req.raw.formData();
    file = form.get('file');
    uploadSubject = String(form.get('subject') ?? '').trim();
  } catch { return apiError(c, 400, 'Choose an Excel workbook to import.'); }
  if (!file || typeof file.arrayBuffer !== 'function') return apiError(c, 400, 'Choose an Excel workbook to import.');
  if (file.size > 8 * 1024 * 1024) return apiError(c, 413, 'The workbook must be smaller than 8 MB.');
  let workbook;
  try {
    workbook = XLSX.read(await file.arrayBuffer(), { type: 'array' });
  } catch { return apiError(c, 400, 'This file could not be read as an Excel workbook.'); }
  const { questions: imported, errors } = parseQuestionWorkbook(workbook, XLSX, uploadSubject);
  if (errors.length) return apiError(c, 400, 'The workbook has validation errors. No questions were imported.', errors);
  await c.env.DB.batch(imported.map((q) => c.env.DB.prepare(`INSERT INTO questions
    (question_text,question_type,option_a,option_b,option_c,option_d,correct_option,question_config,answer_key,media,category,difficulty,explanation) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(
      q.question_text,
      q.question_type,
      q.option_a,
      q.option_b,
      q.option_c,
      q.option_d,
      q.correct_option,
      q.question_config,
      q.answer_key,
      q.media,
      q.category,
      q.difficulty,
      q.explanation,
    )));
  return c.json({ imported: imported.length });
});

app.get('/api/admin/exams', requireAdmin, async (c) => {
  await ensureSeeded(c.env.DB);
  const { results = [] } = await c.env.DB.prepare(`SELECT e.*,COUNT(DISTINCT eq.id) AS question_count,
      (SELECT COALESCE(SUM(marks),0) FROM exam_questions WHERE exam_id=e.id) AS total_marks,
      COUNT(DISTINCT a.id) AS participant_count,COUNT(DISTINCT CASE WHEN a.status!='in_progress' THEN a.id END) AS submitted_count
    FROM exams e LEFT JOIN exam_questions eq ON eq.exam_id=e.id LEFT JOIN attempts a ON a.exam_id=e.id
    GROUP BY e.id ORDER BY e.created_at DESC,e.id DESC`).all();
  return c.json(results);
});

app.post('/api/admin/exams', requireAdmin, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (body.mandatory_sections || body.require_sections) {
    return apiError(c, 400, 'Mandatory exam sections are not supported.');
  }
  const title = String(body.title || '').trim();
  const description = String(body.description || '').trim();
  const duration = Number(body.duration_minutes);
  const subjectInput = String(body.subject ?? '').trim();
  const negativeMark = Number(body.negative_mark);
  const status = ['draft','published','closed'].includes(body.status) ? body.status : 'draft';
  const showScore = body.show_score ? 1 : 0;
  const showAnswers = body.show_answers ? 1 : 0;
  const allowPdfDownload = body.allow_pdf_download ? 1 : 0;
  const ids = Array.isArray(body.question_ids) ? [...new Set(body.question_ids.map(Number).filter(Number.isSafeInteger))] : [];
  if (!title) return apiError(c, 400, 'Exam title is required.');
  if (!allowedNegativeMarks.includes(negativeMark)) return apiError(c, 400, 'Choose a negative mark of 0, 1, 0.25, or 0.50.');
  if (!Number.isInteger(duration) || duration < 1 || duration > 1440) return apiError(c, 400, 'Duration must be between 1 and 1440 minutes.');
  if (showAnswers && !showScore) return apiError(c, 400, 'Show score must be enabled to show answer review.');
  if (!ids.length) return apiError(c, 400, 'Select at least one question for this exam.');
  const available = await c.env.DB.prepare(`SELECT id, category, question_config FROM questions WHERE archived=0 AND id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all();
  if ((available.results || []).length !== ids.length) return apiError(c, 400, 'One or more selected questions are no longer available. Refresh the question bank and try again.');
  const distinctCategories = [...new Set((available.results || []).map((q) => q.category).filter(Boolean))];
  const subject = subjectInput || distinctCategories.join(', ') || 'General';
  if (!subject) return apiError(c, 400, 'Subject is required.');

  if (status === 'published') {
    const selectedQuestions = await c.env.DB.prepare(`SELECT id, media, question_config FROM questions WHERE id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all();
    const problem = await publishMediaProblem(selectedQuestions.results || [], c.env);
    if (problem) return apiError(c, 400, `Cannot publish examination: ${problem}`);
  }

  const created = await c.env.DB.prepare(`INSERT INTO exams (title,description,duration_minutes,subject,negative_mark,status,show_score,show_answers,allow_pdf_download) VALUES (?,?,?,?,?,?,?,?,?)`)
    .bind(title,description,duration,subject,negativeMark,status,showScore,showAnswers,allowPdfDownload).run();
  const examId = created.meta.last_row_id;
  const marksById = new Map((available.results || []).map((q) => [q.id, Number(hydrateQuestionRow(q).question_config.default_marks) || 1]));
  await c.env.DB.batch(ids.map((questionId, index) => c.env.DB.prepare('INSERT INTO exam_questions (exam_id,question_id,marks,sort_order) VALUES (?,?,?,?)').bind(examId,questionId,marksById.get(questionId),index)));
  return c.json(await c.env.DB.prepare(`SELECT e.*,COUNT(eq.id) AS question_count, COALESCE(SUM(eq.marks),0) AS total_marks FROM exams e
    LEFT JOIN exam_questions eq ON eq.exam_id=e.id WHERE e.id=? GROUP BY e.id`).bind(examId).first(), 201);
});

app.delete('/api/admin/exams/:id', requireAdmin, async (c) => {
  const id = Number(c.req.param('id'));
  if (!await c.env.DB.prepare('SELECT id FROM exams WHERE id=?').bind(id).first()) return apiError(c, 404, 'Exam not found.');
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM answers WHERE attempt_id IN (SELECT id FROM attempts WHERE exam_id=?)').bind(id),
    c.env.DB.prepare('DELETE FROM attempts WHERE exam_id=?').bind(id),
    c.env.DB.prepare('DELETE FROM exam_questions WHERE exam_id=?').bind(id),
    c.env.DB.prepare('DELETE FROM exams WHERE id=?').bind(id),
  ]);
  return c.json({ ok: true });
});

app.delete('/api/admin/attempts/:id', requireAdmin, async (c) => {
  const id = Number(c.req.param('id'));
  if (!await c.env.DB.prepare('SELECT id FROM attempts WHERE id=?').bind(id).first()) return apiError(c, 404, 'Answer sheet not found.');
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM answers WHERE attempt_id=?').bind(id),
    c.env.DB.prepare('DELETE FROM attempts WHERE id=?').bind(id),
  ]);
  return c.json({ ok: true });
});

app.patch('/api/admin/exams/:id/status', requireAdmin, async (c) => {
  const status = (await c.req.json().catch(() => ({}))).status;
  if (!['draft','published','closed'].includes(status)) return apiError(c, 400, 'Choose draft, published or closed.');
  const examId = Number(c.req.param('id'));
  if (status === 'published') {
    const examQuestionsList = await c.env.DB.prepare(`SELECT q.id, q.media, q.question_config FROM exam_questions eq JOIN questions q ON q.id=eq.question_id WHERE eq.exam_id=?`).bind(examId).all();
    const problem = await publishMediaProblem(examQuestionsList.results || [], c.env);
    if (problem) return apiError(c, 400, `Cannot publish examination: ${problem}`);
  }
  const result = await c.env.DB.prepare('UPDATE exams SET status=? WHERE id=?').bind(status, examId).run();
  if (!result.meta.changes) return apiError(c, 404, 'Exam not found.');
  return c.json({ ok: true, status });
});

app.patch('/api/admin/exams/:id/settings', requireAdmin, async (c) => {
  const id = Number(c.req.param('id'));
  const exam = await c.env.DB.prepare('SELECT show_score,show_answers,allow_pdf_download FROM exams WHERE id=?').bind(id).first();
  if (!exam) return apiError(c, 404, 'Exam not found.');
  const body = await c.req.json().catch(() => ({}));
  const showScore = body.show_score === undefined ? Number(exam.show_score) : Number(Boolean(body.show_score));
  const showAnswers = body.show_answers === undefined ? Number(exam.show_answers) : Number(Boolean(body.show_answers));
  const allowPdfDownload = body.allow_pdf_download === undefined ? Number(exam.allow_pdf_download) : Number(Boolean(body.allow_pdf_download));
  if (showAnswers && !showScore) return apiError(c, 400, 'Show score must be enabled to show answer review.');
  await c.env.DB.prepare('UPDATE exams SET show_score=?,show_answers=?,allow_pdf_download=? WHERE id=?').bind(showScore,showAnswers,allowPdfDownload,id).run();
  return c.json({ ok: true, show_score: showScore, show_answers: showAnswers, allow_pdf_download: allowPdfDownload });
});

app.post('/api/admin/exams/:id/shorten', requireAdmin, async (c) => {
  const id = Number(c.req.param('id'));
  const exam = await c.env.DB.prepare('SELECT * FROM exams WHERE id=?').bind(id).first();
  if (!exam) return apiError(c, 404, 'Exam not found.');
  if (exam.status !== 'published') return apiError(c, 400, 'Only published exams can be shared with a short link.');

  const body = await c.req.json().catch(() => ({}));
  const force = Boolean(body.force);
  const customAlias = String(body.shorturl || '').trim();

  if (exam.short_url && !force && !customAlias) {
    return c.json({ ok: true, short_url: exam.short_url, cached: true });
  }

  const enabledRow = await c.env.DB.prepare("SELECT value FROM settings WHERE key='enable_short_urls'").first();
  const isEnabled = enabledRow?.value === '1' || enabledRow?.value === 'true';
  if (!isEnabled && !force) {
    return apiError(c, 400, 'is.gd URL shortening is currently disabled in portal settings. Enable it once you have a public domain name.');
  }

  const settingsRow = await c.env.DB.prepare("SELECT value FROM settings WHERE key='public_url'").first();
  const configuredBase = String(settingsRow?.value || '').trim();
  let longUrl = String(body.url || '').trim();
  if (!longUrl) {
    if (configuredBase) {
      longUrl = new URL(`/exam/${exam.id}`, configuredBase).href;
    } else {
      const origin = new URL(c.req.url).origin;
      longUrl = `${origin}/exam/${exam.id}`;
    }
  }

  try {
    const result = await shortenWithIsgd(longUrl, {
      shorturl: customAlias || undefined,
      logstats: body.logstats,
    });
    await c.env.DB.prepare('UPDATE exams SET short_url=? WHERE id=?').bind(result.shorturl, id).run();
    return c.json({ ok: true, short_url: result.shorturl, exam_id: id });
  } catch (err) {
    const hint = err.code === 1 ? 'is.gd requires a publicly accessible URL (localhost cannot be shortened).' :
      err.code === 2 ? 'The custom short URL was rejected or is already taken.' :
      err.code === 3 ? 'Rate limit exceeded on is.gd. Please wait 1 minute before trying again.' :
      'Shortening service error.';
    return apiError(c, 400, err.message, [hint]);
  }
});

app.patch('/api/admin/exams/:id/short_url', requireAdmin, async (c) => {
  const id = Number(c.req.param('id'));
  const exam = await c.env.DB.prepare('SELECT id FROM exams WHERE id=?').bind(id).first();
  if (!exam) return apiError(c, 404, 'Exam not found.');
  const body = await c.req.json().catch(() => ({}));
  const shortUrl = String(body.short_url || '').trim();
  await c.env.DB.prepare('UPDATE exams SET short_url=? WHERE id=?').bind(shortUrl, id).run();
  return c.json({ ok: true, short_url: shortUrl });
});

app.get('/api/admin/exams/:id/questions', requireAdmin, async (c) => {
  await ensureSeeded(c.env.DB);
  const questions = (await getExamQuestions(c.env.DB, Number(c.req.param('id')))).map((row) => hydrateQuestionRow(row));
  if (!questions.length) return apiError(c, 404, 'Exam not found or it has no questions.');
  return c.json(questions);
});

app.get('/api/admin/exams/:id/attempts', requireAdmin, async (c) => {
  const exam = await c.env.DB.prepare('SELECT id FROM exams WHERE id=?').bind(Number(c.req.param('id'))).first();
  if (!exam) return apiError(c, 404, 'Exam not found.');
  const { results = [] } = await c.env.DB.prepare(`SELECT id,student_name,roll_number,email,address,started_at,submitted_at,score,status
    FROM attempts WHERE exam_id=? ORDER BY started_at DESC,id DESC`).bind(exam.id).all();
  return c.json(results);
});

app.get('/api/admin/attempts/:id', requireAdmin, async (c) => {
  const attempt = await c.env.DB.prepare(`SELECT a.*,e.title AS exam_title FROM attempts a JOIN exams e ON e.id=a.exam_id WHERE a.id=?`)
    .bind(Number(c.req.param('id'))).first();
  if (!attempt) return apiError(c, 404, 'Attempt not found.');
  const { results: rawAnswers = [] } = await c.env.DB.prepare(`SELECT q.id AS question_id,q.question_text,q.question_type,q.option_a,q.option_b,q.option_c,q.option_d,
      q.correct_option,q.question_config,q.answer_key,q.media,q.explanation,eq.marks,a.selected_option,a.answer_data,a.is_correct,a.marks_awarded
    FROM exam_questions eq JOIN questions q ON q.id=eq.question_id
    LEFT JOIN answers a ON a.question_id=q.id AND a.attempt_id=? WHERE eq.exam_id=? ORDER BY eq.sort_order,eq.id`)
    .bind(attempt.id,attempt.exam_id).all();
  return c.json({ ...attempt, answers: rawAnswers.map((row) => hydrateAnswerRow(row)) });
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
  const address = String(body.address || '').trim();
  if (!studentName || studentName.length > 120) return apiError(c, 400, 'Enter your name (up to 120 characters).');
  if (!rollNumber || rollNumber.length > 60) return apiError(c, 400, 'Enter your roll number (up to 60 characters).');
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return apiError(c, 400, 'Enter a valid email address.');
  if (!address || address.length > 500) return apiError(c, 400, 'Enter your address (up to 500 characters).');
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = b64url(bytes);
  const result = await c.env.DB.prepare(`INSERT INTO attempts (exam_id,access_token,student_name,roll_number,email,address,started_at)
    VALUES (?,?,?,?,?,?,?)`).bind(exam.id,token,studentName,rollNumber,email,address,new Date().toISOString()).run();
  return c.json({ token, attempt_id: result.meta.last_row_id }, 201);
});

app.get('/api/attempts/:token', async (c) => {
  await ensureSeeded(c.env.DB);
  const attempt = await getStudentAttempt(c.env.DB, c.req.param('token'));
  if (!attempt) return apiError(c, 404, 'Attempt not found. Return to the exam list to start again.');
  const deadline = deadlineFor(attempt);
  const rawQuestions = await getExamQuestions(c.env.DB, attempt.exam_id);
  const questions = rawQuestions.map((question) => hydrateQuestionRow(question, { includeAnswerKey: false }));
  const { results: rawAnswers = [] } = await c.env.DB.prepare('SELECT question_id,selected_option,answer_data FROM answers WHERE attempt_id=?').bind(attempt.id).all();
  const answers = rawAnswers.map((row) => hydrateAnswerRow(row, { forActiveAttempt: true, questionRow: rawQuestions.find((question) => question.id === row.question_id) }));
  return c.json({
    id: attempt.id,exam_id: attempt.exam_id,exam_title: attempt.exam_title,student_name: attempt.student_name,
    roll_number: attempt.roll_number,email: attempt.email,address: attempt.address,status: attempt.status,started_at: attempt.started_at,
    deadline: deadline.toISOString(),remaining_seconds: Math.max(0,Math.floor((deadline.getTime()-Date.now())/1000)),
    allow_pdf_download: Boolean(attempt.allow_pdf_download),
    questions,answers,result: await safeResult(c.env.DB,attempt,true),
  });
});

app.put('/api/attempts/:token/answers', async (c) => {
  let attempt = await getStudentAttempt(c.env.DB, c.req.param('token'));
  if (!attempt) return apiError(c, 404, 'Attempt not found.');
  if (attempt.status !== 'in_progress') return apiError(c, 409, 'This attempt has already been submitted.', { result: await safeResult(c.env.DB,attempt,true) });
  const body = await c.req.json().catch(() => ({}));
  attempt = await enforceDeadline(c.env.DB, attempt);
  if (attempt.status !== 'in_progress') return apiError(c, 409, 'This attempt has already been submitted.');
  const questionId = Number(body.question_id);
  const examQuestion = await c.env.DB.prepare(`SELECT q.* FROM exam_questions eq JOIN questions q ON q.id=eq.question_id WHERE eq.exam_id=? AND eq.question_id=?`)
    .bind(attempt.exam_id, questionId).first();
  if (!examQuestion) {
    if (body.selected_option !== undefined && body.answer_data === undefined) {
      const selectedOption = body.selected_option === null || body.selected_option === '' ? null : String(body.selected_option || '').toUpperCase();
      if (!['A','B','C','D',null].includes(selectedOption)) return apiError(c, 400, 'Choose option A, B, C or D.');
    }
    return apiError(c, 400, 'That question is not part of this examination.');
  }
  const validated = validateStudentAnswer(examQuestion, body, { publicOrderingIds: true });
  if (validated.error) return apiError(c, 400, validated.error);
  const saved = await c.env.DB.prepare(`INSERT INTO answers (attempt_id,question_id,selected_option,answer_data)
    SELECT a.id,?,?,? FROM attempts a WHERE a.id=? AND a.status='in_progress'
      AND julianday(a.started_at) + (SELECT duration_minutes FROM exams WHERE id=a.exam_id)/1440.0 > julianday('now')
    ON CONFLICT(attempt_id,question_id) DO UPDATE SET selected_option=excluded.selected_option,answer_data=excluded.answer_data,is_correct=NULL,marks_awarded=0`)
    .bind(questionId,validated.selected_option,validated.answerDataJson,attempt.id).run();
  if (!saved.meta.changes) {
    await getStudentAttempt(c.env.DB, c.req.param('token'));
    return apiError(c, 409, 'This attempt has already been submitted or its time has expired.');
  }
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
