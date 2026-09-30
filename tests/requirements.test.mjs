import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import XLSX from 'xlsx';

const root = path.resolve(import.meta.dirname, '..');

async function unusedPort() {
  const socket = net.createServer();
  await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const { port } = socket.address();
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

async function startServer(databasePath) {
  const port = await unusedPort();
  const process = spawn(globalThis.process.execPath, ['server/app.js'], {
    cwd: root,
    env: {
      ...globalThis.process.env,
      PORT: String(port),
      DB_PATH: databasePath,
      ADMIN_USERNAME: 'admin',
      ADMIN_PASSWORD: 'initialPass123!',
      SESSION_SECRET: 'requirements-test-secret-with-sufficient-length',
      COOKIE_SECURE: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  process.stdout.on('data', (chunk) => { output += chunk; });
  process.stderr.on('data', (chunk) => { output += chunk; });
  const base = `http://127.0.0.1:${port}`;
  const limit = Date.now() + 10_000;
  while (Date.now() < limit) {
    if (process.exitCode !== null) throw new Error(`Server exited early:\n${output}`);
    try {
      const response = await fetch(`${base}/api/health`);
      if (response.ok) return { process, base };
    } catch { /* Waiting for startup. */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  process.kill();
  throw new Error(`Server did not become ready:\n${output}`);
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  child.kill();
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]);
}

function client(base, cookie = '') {
  return async (route, { method = 'GET', body } = {}) => {
    const headers = cookie ? { Cookie: cookie } : {};
    if (body !== undefined && !(body instanceof FormData)) headers['Content-Type'] = 'application/json';
    const response = await fetch(`${base}${route}`, {
      method,
      headers,
      body: body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
    });
    const contentType = response.headers.get('content-type') || '';
    const data = contentType.includes('application/json') ? await response.json() : await response.text();
    return { status: response.status, data, cookie: response.headers.get('set-cookie')?.split(';')[0] || '' };
  };
}

function question(text, answer = 'A', category = 'Integration QA', explanation = '') {
  return {
    question_text: text,
    option_a: 'First option',
    option_b: 'Second option',
    option_c: 'Third option',
    option_d: 'Fourth option',
    correct_option: answer,
    category,
    difficulty: 'Easy',
    explanation,
  };
}

function bulkBlock(number) {
  return `${number}. Integration paste question ${number}?\nA. First option\nB. Second option\nC. Third option\nD. Fourth option\nAnswer: B\nExplanation: Paste explanation ${number}.`;
}

test('MCQ requirements work through the local API and persist in SQLite', { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mcq-requirements-'));
  const databasePath = path.join(directory, 'exam.db');
  let running;
  try {
    running = await startServer(databasePath);
    let anonymous = client(running.base);
    let response = await anonymous('/api/admin/login', { method: 'POST', body: { username: 'admin', password: 'initialPass123!' } });
    assert.equal(response.status, 200, JSON.stringify(response.data));
    const oldCookie = response.cookie;
    let admin = client(running.base, oldCookie);

    response = await admin('/api/admin/password', { method: 'POST', body: { current_password: 'initialPass123!', new_password: 'updatedPass123!' } });
    assert.equal(response.status, 200, JSON.stringify(response.data));
    assert.equal((await admin('/api/admin/questions')).status, 401, 'Password change must invalidate old sessions.');
    assert.equal((await anonymous('/api/admin/login', { method: 'POST', body: { username: 'admin', password: 'initialPass123!' } })).status, 401);
    response = await anonymous('/api/admin/login', { method: 'POST', body: { username: 'admin', password: 'updatedPass123!' } });
    assert.equal(response.status, 200, JSON.stringify(response.data));
    admin = client(running.base, response.cookie);

    response = await admin('/api/admin/questions', { method: 'POST', body: question('Manual entry?', 'A', 'Integration QA', 'Manual explanation.') });
    assert.equal(response.status, 201, JSON.stringify(response.data));
    const manualId = response.data.id;

    response = await admin('/api/admin/questions/bulk', { method: 'POST', body: { subject: 'Integration QA', text: bulkBlock(1) } });
    assert.equal(response.status, 200, JSON.stringify(response.data));
    assert.equal(response.data.imported, 1);
    let questions = (await admin('/api/admin/questions')).data;
    const pasteId = questions.find((item) => item.question_text === 'Integration paste question 1?')?.id;
    assert.ok(pasteId);

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
      ['Question', 'Option A', 'Option B', 'Option C', 'Option D', 'Correct Answer', 'Category', 'Difficulty', 'Explanation'],
      ['Excel entry?', 'First option', 'Second option', 'Third option', 'Fourth option', 'C', '', 'Easy', 'Excel explanation.'],
    ]), 'Questions');
    const form = new FormData();
    form.append('subject', 'Integration QA');
    form.append('file', new Blob([XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' })]), 'questions.xlsx');
    response = await admin('/api/admin/questions/import', { method: 'POST', body: form });
    assert.equal(response.status, 200, JSON.stringify(response.data));
    assert.equal(response.data.imported, 1);
    questions = (await admin('/api/admin/questions')).data;
    const excel = questions.find((item) => item.question_text === 'Excel entry?');
    assert.equal(excel?.category, 'Integration QA');
    assert.equal(excel?.explanation, 'Excel explanation.');

    const countBeforeInvalid = questions.length;
    response = await admin('/api/admin/questions/bulk', { method: 'POST', body: { subject: 'Integration QA', text: `${bulkBlock(1)}\n\n2. Bad question\nA. One\nAnswer: A` } });
    assert.equal(response.status, 400);
    assert.equal((await admin('/api/admin/questions')).data.length, countBeforeInvalid, 'Invalid paste must be atomic.');

    response = await admin('/api/admin/questions/bulk', { method: 'POST', body: { subject: 'Integration QA', text: Array.from({ length: 301 }, (_, index) => bulkBlock(index + 1)).join('\n\n') } });
    assert.equal(response.status, 400);
    assert.equal((await admin('/api/admin/questions')).data.length, countBeforeInvalid);
    response = await admin('/api/admin/questions/bulk', { method: 'POST', body: { subject: 'Integration QA', text: Array.from({ length: 300 }, (_, index) => bulkBlock(index + 1)).join('\n\n') } });
    assert.equal(response.status, 200, JSON.stringify(response.data));
    assert.equal(response.data.imported, 300);

    response = await admin('/api/admin/questions', { method: 'POST', body: question('Other subject?', 'A', 'Other Subject') });
    assert.equal(response.status, 201, JSON.stringify(response.data));
    const otherId = response.data.id;
    const examBody = {
      title: 'Requirements integration exam',
      description: 'One correct, one wrong, one unanswered',
      duration_minutes: 20,
      status: 'published',
      subject: 'Integration QA',
      negative_mark: 0.25,
      show_score: false,
      show_answers: false,
      question_ids: [manualId, pasteId, excel.id],
    };
    response = await admin('/api/admin/exams', { method: 'POST', body: { ...examBody, question_ids: [manualId, otherId] } });
    assert.equal(response.status, 400, 'Exam must reject questions from another subject.');
    response = await admin('/api/admin/exams', { method: 'POST', body: examBody });
    assert.equal(response.status, 201, JSON.stringify(response.data));
    const examId = response.data.id;
    assert.equal((await anonymous(`/api/exams/${examId}`)).status, 200);
    const directPage = await anonymous(`/exam/${examId}`);
    assert.equal(directPage.status, 200);
    assert.match(directPage.data, /<html/i);

    const identity = { student_name: 'Integration Student', roll_number: '42', email: 'student@example.com', address: 'Dhaka' };
    assert.equal((await anonymous(`/api/exams/${examId}/attempts`, { method: 'POST', body: { ...identity, email: '' } })).status, 400);
    assert.equal((await anonymous(`/api/exams/${examId}/attempts`, { method: 'POST', body: { ...identity, address: '' } })).status, 400);
    response = await anonymous(`/api/exams/${examId}/attempts`, { method: 'POST', body: identity });
    assert.equal(response.status, 201, JSON.stringify(response.data));
    const token = response.data.token;
    const active = await anonymous(`/api/attempts/${token}`);
    assert.equal(active.status, 200);
    assert.equal(active.data.address, 'Dhaka');
    assert.ok(active.data.questions.every((item) => !('correct_option' in item) && !('explanation' in item)), 'Active exam must not disclose answer keys.');
    assert.equal((await anonymous(`/api/attempts/${token}/answers`, { method: 'PUT', body: { question_id: manualId, selected_option: 'A' } })).status, 200);
    assert.equal((await anonymous(`/api/attempts/${token}/answers`, { method: 'PUT', body: { question_id: pasteId, selected_option: 'A' } })).status, 200);
    response = await anonymous(`/api/attempts/${token}/submit`, { method: 'POST' });
    assert.equal(response.status, 200);
    assert.ok(!('score' in response.data.result) && !('answers' in response.data.result), 'Hidden student results must stay hidden in the API.');
    const attempts = await admin(`/api/admin/exams/${examId}/attempts`);
    assert.equal(attempts.status, 200);
    const attempt = attempts.data.find((item) => item.email === identity.email);
    assert.equal(attempt?.score, 0.75);
    const sheet = await admin(`/api/admin/attempts/${attempt.id}`);
    assert.equal(sheet.status, 200);
    assert.equal(sheet.data.address, 'Dhaka');
    assert.equal(sheet.data.answers.find((item) => item.question_id === pasteId)?.marks_awarded, -0.25);
    assert.equal(sheet.data.answers.find((item) => item.question_id === excel.id)?.marks_awarded ?? 0, 0);

    assert.equal((await admin(`/api/admin/exams/${examId}/settings`, { method: 'PATCH', body: { show_score: true, show_answers: true } })).status, 200);
    response = await anonymous(`/api/attempts/${token}`);
    assert.equal(response.data.result.score, 0.75);
    assert.equal(response.data.result.answers.find((item) => item.question_id === manualId)?.explanation, 'Manual explanation.');

    for (const penalty of [0.5, 1]) {
      response = await admin('/api/admin/exams', { method: 'POST', body: { ...examBody, title: `Penalty ${penalty}`, negative_mark: penalty, question_ids: [manualId] } });
      assert.equal(response.status, 201, JSON.stringify(response.data));
      const penaltyExam = response.data.id;
      response = await anonymous(`/api/exams/${penaltyExam}/attempts`, { method: 'POST', body: { ...identity, roll_number: String(penalty) } });
      const penaltyToken = response.data.token;
      assert.equal((await anonymous(`/api/attempts/${penaltyToken}/answers`, { method: 'PUT', body: { question_id: manualId, selected_option: 'B' } })).status, 200);
      await anonymous(`/api/attempts/${penaltyToken}/submit`, { method: 'POST' });
      const penaltyAttempts = (await admin(`/api/admin/exams/${penaltyExam}/attempts`)).data;
      assert.equal(penaltyAttempts[0].score, -penalty);
    }

    const legacyExam = (await anonymous('/api/exams')).data.find((item) => item.title === 'Getting Started: General Knowledge');
    assert.ok(legacyExam, 'The seeded legacy exam should remain available.');
    response = await anonymous(`/api/exams/${legacyExam.id}/attempts`, { method: 'POST', body: { ...identity, roll_number: 'legacy' } });
    assert.equal(response.status, 201);
    const legacyToken = response.data.token;
    const legacyQuestions = (await anonymous(`/api/attempts/${legacyToken}`)).data.questions;
    assert.equal((await anonymous(`/api/attempts/${legacyToken}/answers`, { method: 'PUT', body: { question_id: legacyQuestions[0].id, selected_option: 'A' } })).status, 200);
    response = await anonymous(`/api/attempts/${legacyToken}/submit`, { method: 'POST' });
    assert.equal(response.data.result.score, 0, 'Existing zero-penalty exams must keep their original grading.');

    for (const route of ['/api/admin/backup', `/api/admin/exams/${examId}`, `/api/admin/attempts/${attempt.id}`]) {
      assert.equal((await anonymous(route, { method: route.endsWith('backup') ? 'GET' : 'DELETE' })).status, 401);
    }
    const backup = await admin('/api/admin/backup');
    assert.equal(backup.status, 200);
    assert.equal(backup.data.format, 'mcq-database-backup');
    assert.ok(backup.data.tables.answers.length > 0);
    assert.ok(backup.data.tables.attempts.some((row) => row.id === attempt.id));
    const original = sheet.data.answers.find((row) => row.question_id === manualId);
    response = await admin(`/api/admin/questions/${manualId}`, { method: 'PUT', body: question('Changed bank question?', 'D', 'Integration QA') });
    assert.equal(response.status, 200);
    assert.notEqual(response.data.id, manualId);
    const replacementId = response.data.id;
    const preserved = (await admin(`/api/admin/attempts/${attempt.id}`)).data;
    assert.equal(preserved.score, sheet.data.score);
    assert.deepEqual(preserved.answers.find((row) => row.question_id === manualId), original);
    assert.ok(!(await admin('/api/admin/questions')).data.some((row) => row.id === manualId));
    assert.equal((await admin(`/api/admin/questions/${pasteId}`, { method: 'DELETE' })).status, 200);
    assert.equal((await admin(`/api/admin/attempts/${attempt.id}`)).data.answers.length, sheet.data.answers.length);
    assert.equal((await admin('/api/admin/exams', { method: 'POST', body: { ...examBody, question_ids: [pasteId] } })).status, 400);
    assert.equal((await admin(`/api/admin/questions/${replacementId}`, { method: 'DELETE' })).status, 200);
    assert.equal((await admin(`/api/admin/attempts/${attempt.id}`, { method: 'DELETE' })).status, 200);
    assert.equal((await admin(`/api/admin/attempts/${attempt.id}`)).status, 404);
    assert.equal((await anonymous(`/api/attempts/${token}`)).status, 404);
    response = await anonymous(`/api/exams/${examId}/attempts`, { method: 'POST', body: identity });
    const deletedToken = response.data.token;
    assert.equal((await admin(`/api/admin/exams/${examId}`, { method: 'DELETE' })).status, 200);
    assert.equal((await anonymous(`/api/exams/${examId}`)).status, 404);
    assert.equal((await anonymous(`/api/attempts/${deletedToken}`)).status, 404);
    const afterDelete = (await admin('/api/admin/backup')).data.tables;
    assert.ok(!afterDelete.attempts.some((row) => row.exam_id === examId));
    assert.ok(!afterDelete.answers.some((row) => row.attempt_id === attempt.id));
    assert.ok(!afterDelete.exam_questions.some((row) => row.exam_id === examId));

    await stopServer(running.process);
    running = await startServer(databasePath);
    anonymous = client(running.base);
    assert.equal((await anonymous('/api/admin/login', { method: 'POST', body: { username: 'admin', password: 'initialPass123!' } })).status, 401);
    assert.equal((await anonymous('/api/admin/login', { method: 'POST', body: { username: 'admin', password: 'updatedPass123!' } })).status, 200);
  } finally {
    await stopServer(running?.process);
    if (path.dirname(databasePath) === directory && directory.startsWith(os.tmpdir())) await rm(directory, { recursive: true, force: true });
  }
});


test('Hosted backend preserves question history and exports and deletes data', async () => {
  const { default: Database } = await import('better-sqlite3');
  const { readFileSync } = await import('node:fs');
  const { default: worker } = await import('../dist/server/index.js');
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  for (const file of ['0000_green_maggott.sql', '0001_supreme_inertia.sql', '0002_long_clea.sql']) {
    sqlite.exec(readFileSync(path.join(root, 'drizzle', file), 'utf8'));
  }
  const DB = {
    prepare(sql) {
      let params = [];
      const statement = {
        bind(...values) { params = values; return statement; },
        first() { return sqlite.prepare(sql).get(...params) ?? null; },
        all() { return { results: sqlite.prepare(sql).all(...params) }; },
        run() { const result = sqlite.prepare(sql).run(...params); return { meta: { last_row_id: Number(result.lastInsertRowid), changes: result.changes } }; },
        execute() { return sqlite.prepare(sql).reader ? statement.all() : statement.run(); },
      };
      return statement;
    },
    async batch(statements) { return sqlite.transaction(() => statements.map((statement) => statement.execute()))(); },
  };
  const env = { DB, ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'workerPass123!', SESSION_SECRET: 'worker-test-secret' };
  let cookie = '';
  async function call(route, method = 'GET', body) {
    return worker.fetch(new Request(`https://test.local${route}`, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }), env);
  }
  try {
    assert.equal((await call('/api/admin/backup')).status, 401);
    const login = await call('/api/admin/login', 'POST', { username: 'admin', password: env.ADMIN_PASSWORD });
    assert.equal(login.status, 200);
    cookie = login.headers.get('set-cookie').split(';')[0];
    const questions = await (await call('/api/admin/questions')).json();
    const exam = sqlite.prepare('SELECT * FROM exams LIMIT 1').get();
    const old = sqlite.prepare('SELECT q.* FROM questions q JOIN exam_questions eq ON eq.question_id=q.id WHERE eq.exam_id=? LIMIT 1').get(exam.id);
    const edit = await call(`/api/admin/questions/${old.id}`, 'PUT', { ...old, question_text: 'Updated version', correct_option: 'D' });
    assert.equal(edit.status, 200);
    const replacement = await edit.json();
    assert.notEqual(replacement.id, old.id);
    assert.equal(sqlite.prepare('SELECT question_text FROM questions WHERE id=?').get(old.id).question_text, old.question_text);
    assert.equal((await call(`/api/admin/questions/${replacement.id}`, 'DELETE')).status, 200);
    sqlite.prepare("INSERT INTO attempts (exam_id,access_token,student_name,roll_number,email,address,started_at,status) VALUES (?,'test-token','Student','1','a@b.com','Dhaka',CURRENT_TIMESTAMP,'submitted')").run(exam.id);
    const attemptId = Number(sqlite.prepare('SELECT id FROM attempts').get().id);
    sqlite.prepare('INSERT INTO answers (attempt_id,question_id,selected_option) VALUES (?,?,?)').run(attemptId,old.id,'A');
    const backup = await call('/api/admin/backup');
    assert.match(backup.headers.get('content-disposition'), /attachment/);
    assert.equal(backup.headers.get('cache-control'), 'no-store');
    const data = await backup.json();
    assert.equal(data.tables.answers.length, 1);
    assert.ok(data.tables.questions.length >= questions.length);
    assert.equal((await call(`/api/admin/attempts/${attemptId}`, 'DELETE')).status, 200);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM answers').get().count, 0);
    sqlite.prepare("INSERT INTO attempts (exam_id,access_token,student_name,roll_number,started_at) VALUES (?,'second','Student','1',CURRENT_TIMESTAMP)").run(exam.id);
    const remaining = sqlite.prepare('SELECT id FROM attempts').get().id;
    sqlite.prepare('INSERT INTO answers (attempt_id,question_id) VALUES (?,?)').run(remaining, old.id);
    assert.equal((await call(`/api/admin/exams/${exam.id}`, 'DELETE')).status, 200);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM attempts').get().count, 0);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM answers').get().count, 0);
    assert.equal((await call(`/api/admin/exams/${exam.id}`, 'DELETE')).status, 404);
  } finally { sqlite.close(); }
});
