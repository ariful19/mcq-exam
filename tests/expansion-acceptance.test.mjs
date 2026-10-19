import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { webcrypto } from 'node:crypto';
import Database from 'better-sqlite3';
import XLSX from 'xlsx';
import worker from '../dist/server/index.js';
import { SUPPORTED_QUESTION_TYPES, normalizeQuestion, validateStudentAnswer, evaluateQuestionAnswer, parseQuestionPaste, BULK_PASTE_SAMPLE } from '../server/question-types.js';
import { createQuestionWorkbook, parseQuestionWorkbook, QUESTION_WORKBOOK_VERSION } from '../server/question-import.js';

if (!globalThis.crypto) globalThis.crypto = webcrypto;
const root = path.resolve(import.meta.dirname, '..');
const common = { category: 'Acceptance A', marks: 3, explanation: 'Private teacher explanation.' };
const sharedStimulus = { id: 'acceptance-passage', title: 'Shared passage', text: 'An <u>original</u> teacher passage.', media: { type: 'image', url: 'https://example.test/passage.png', alt: 'Reference diagram' } };
const specimens = [
  { question_type: 'mcq_single', question_text: 'Choose <u>one</u>.', option_a: 'Alpha', option_b: 'Beta', option_c: 'Gamma', option_d: 'Delta', correct_option: 'A', correct: { selected_option: 'A' }, wrong: { selected_option: 'B' }, wrongMarks: -0.5 },
  { question_type: 'mcq_multi', question_text: 'Choose the first two.', question_config: { options: ['A', 'B', 'C', 'D'].map((id) => ({ id, text: id })) }, answer_key: { correct_options: ['A', 'B'] }, correct: { selected_options: ['B', 'A'] }, wrong: { selected_options: ['A', 'B', 'C', 'D'] }, wrongMarks: 0 },
  { question_type: 'true_false', question_text: 'This is true.', answer_key: { correct_answer: true }, correct: { selected_answer: true }, wrong: { selected_answer: false }, wrongMarks: -0.5 },
  { question_type: 'yes_no', question_text: 'Is this yes?', answer_key: { correct_answer: 'yes' }, correct: { selected_answer: 'yes' }, wrong: { selected_answer: 'no' }, wrongMarks: 0 },
  { question_type: 'fill_blank', question_text: '<b>Word:</b> [blank1]; <u>symbol:</u> [blank2].', question_config: { blanks: [{ id: 'B1', label: 'Word' }, { id: 'B2', label: 'Symbol' }], case_sensitive: true }, answer_key: { blanks: { B1: ['café'], B2: ['NaCl'] } }, correct: { blanks: { B1: ' cafe\u0301 ', B2: 'NaCl' } }, wrong: { blanks: { B1: 'café', B2: 'nacl' } }, wrongMarks: -0.5 },
  { question_type: 'short_answer', question_text: 'Name the city.', question_config: { case_sensitive: true }, answer_key: { accepted_answers: ['Dhaka'], case_sensitive: true }, correct: { text: ' Dhaka ' }, wrong: { text: 'dhaka' }, wrongMarks: -0.5 },
  { question_type: 'numeric', question_text: 'Enter the value.', question_config: { tolerance: 0.1 }, answer_key: { value: 9.8, tolerance: 0.1 }, correct: { value: 9.9 }, wrong: { value: 10 }, wrongMarks: -0.5 },
  { question_type: 'matching', question_text: 'Match these.', question_config: { prompts: [{ id: 'P1', text: 'One' }, { id: 'P2', text: 'Two' }], choices: [{ id: 'C1', text: 'First' }, { id: 'C2', text: 'Second' }] }, answer_key: { pairs: { P1: 'C1', P2: 'C2' } }, correct: { pairs: { P1: 'C1', P2: 'C2' } }, wrong: { pairs: { P1: 'C2', P2: 'C1' } }, wrongMarks: -0.5 },
  { question_type: 'ordering', question_text: 'Order these.', question_config: { items: [{ id: 'I1', text: 'First' }, { id: 'I2', text: 'Second' }, { id: 'I3', text: 'Third' }] }, answer_key: { correct_order: ['I1', 'I2', 'I3'] }, correct: { order: ['I1', 'I2', 'I3'] }, wrong: { order: ['I2', 'I1', 'I3'] }, wrongMarks: -0.5 },
];

function payload(specimen, index = 0) {
  const { correct, wrong, wrongMarks, ...question } = specimen;
  return { ...common, ...question, category: index % 2 ? 'Acceptance B' : 'Acceptance A' };
}

// This is a transactional in-process D1 adapter, not a live Cloudflare deployment.
function makeD1(db, hooks = {}) {
  const wrap = (sql, values = []) => ({
    sql, values,
    bind(...bound) { return wrap(sql, bound); },
    async first() { return db.prepare(sql).get(...values) ?? null; },
    async all() {
      const results = db.prepare(sql).all(...values);
      if (hooks.afterAll) await hooks.afterAll(sql, values, results);
      return { results };
    },
    async run() {
      const result = db.prepare(sql).run(...values);
      return { meta: { changes: result.changes, last_row_id: Number(result.lastInsertRowid) || 0 } };
    },
  });
  return {
    prepare: (sql) => wrap(sql),
    async batch(statements) {
      if (hooks.beforeBatch) await hooks.beforeBatch(statements);
      return db.transaction(() => statements.map(({ sql, values }) => {
        const statement = db.prepare(sql);
        if (statement.reader) return { results: statement.all(...values) };
        const result = statement.run(...values);
        return { meta: { changes: result.changes, last_row_id: Number(result.lastInsertRowid) || 0 } };
      }))();
    },
  };
}

async function backend(mode, hooks = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `mcq-expansion-${mode}-`));
  let processHandle;
  let db;
  let request;
  if (mode === 'Worker') {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    for (const name of fs.readdirSync(path.join(root, 'drizzle')).filter((name) => /^\d+_.*\.sql$/.test(name)).sort()) {
      for (const statement of fs.readFileSync(path.join(root, 'drizzle', name), 'utf8').split('--> statement-breakpoint').filter((sql) => sql.trim())) db.exec(statement);
    }
    db.prepare("INSERT INTO site_meta (key,value) VALUES ('initial_seed','1')").run();
    const env = { DB: makeD1(db, hooks), ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'acceptancePass123!', SESSION_SECRET: 'acceptance-test-secret-long-enough' };
    request = (route, options) => worker.fetch(new Request(`https://acceptance.test${route}`, options), env, {});
  } else {
    const socket = net.createServer();
    await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
    const port = socket.address().port;
    await new Promise((resolve) => socket.close(resolve));
    const databasePath = path.join(directory, 'exam.db');
    processHandle = spawn(process.execPath, ['server/app.js'], { cwd: root, env: { ...process.env, PORT: String(port), DB_PATH: databasePath, ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'acceptancePass123!', SESSION_SECRET: 'acceptance-test-secret-long-enough', COOKIE_SECURE: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    processHandle.stdout.on('data', (chunk) => { output += chunk; });
    processHandle.stderr.on('data', (chunk) => { output += chunk; });
    request = (route, options) => fetch(`http://127.0.0.1:${port}${route}`, options);
    let ready = false;
    for (let retry = 0; retry < 100; retry++) {
      if (processHandle.exitCode !== null) throw new Error(output);
      try { if ((await request('/api/health')).ok) { ready = true; break; } } catch { /* Starting. */ }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(ready, output);
    db = new Database(databasePath);
    db.pragma('foreign_keys = ON');
  }
  let cookie = '';
  const call = (route, { method = 'GET', body, admin = true } = {}) => {
    const headers = admin && cookie ? { Cookie: cookie } : {};
    if (body !== undefined && !(body instanceof FormData)) headers['Content-Type'] = 'application/json';
    return request(route, { method, headers, body: body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify(body) });
  };
  const login = await call('/api/admin/login', { method: 'POST', body: { username: 'admin', password: 'acceptancePass123!' } });
  assert.equal(login.status, 200, await login.clone().text());
  cookie = login.headers.get('set-cookie').split(';')[0];
  return {
    db, call,
    async close() {
      if (processHandle && processHandle.exitCode === null) {
        processHandle.kill();
        await new Promise((resolve) => processHandle.once('exit', resolve));
      }
      db.close();
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

async function createExam(harness) {
  const questions = [];
  for (const [index, specimen] of specimens.entries()) {
    const input = payload(specimen, index);
    if (index === 0) input.stimulus = sharedStimulus;
    if (index === 1) {
      const response = await harness.call('/api/admin/stimuli');
      assert.equal(response.status, 200);
      const entry = (await response.json()).find((stimulus) => stimulus.id === sharedStimulus.id);
      assert.ok(entry, 'A previously saved passage is reusable without uploading media again.');
      input.stimulus = entry;
    }
    const response = await harness.call('/api/admin/questions', { method: 'POST', body: input });
    assert.equal(response.status, 201, await response.clone().text());
    questions.push(await response.json());
  }
  const response = await harness.call('/api/admin/exams', { method: 'POST', body: { title: 'All-types mixed-subject acceptance exam', duration_minutes: 30, negative_mark: 0.5, status: 'published', show_score: true, show_answers: true, question_ids: questions.map((question) => question.id) } });
  assert.equal(response.status, 201, await response.clone().text());
  const exam = await response.json();
  assert.ok(exam.subject.includes('Acceptance A') && exam.subject.includes('Acceptance B'));
  return { questions, exam };
}
async function startAttempt(harness, exam) {
  const response = await harness.call(`/api/exams/${exam.id}/attempts`, { method: 'POST', admin: false, body: { student_name: 'Acceptance Student', roll_number: 'QA-1', email: 'qa@example.test', address: 'Test address' } });
  assert.equal(response.status, 201, await response.clone().text());
  return response.json();
}
async function save(harness, token, question, answer) {
  if (question.question_type === 'ordering' && answer?.order && question.answer_key?.public_item_ids) {
    answer = { ...answer, order: answer.order.map((id) => question.answer_key.public_item_ids[id] ?? id) };
  }
  return harness.call(`/api/attempts/${token}/answers`, { method: 'PUT', admin: false, body: { question_id: question.id, answer_data: answer } });
}

for (const mode of ['Express', 'Worker']) {
  test(`${mode}: all nine types have scoring, raw answer, visibility, history, backup and timeout parity`, { timeout: 60_000 }, async () => {
    const harness = await backend(mode);
    try {
      const { questions, exam } = await createExam(harness);
      assert.deepEqual(harness.db.prepare('SELECT marks FROM exam_questions WHERE exam_id=? ORDER BY sort_order').all(exam.id).map((row) => row.marks), specimens.map(() => 3));
      for (const scenario of ['correct', 'wrong', 'unanswered']) {
        const attempt = await startAttempt(harness, exam);
        const active = await (await harness.call(`/api/attempts/${attempt.token}`, { admin: false })).json();
        assert.equal(active.result, null);
        assert.equal(active.questions.length, 9);
        for (const question of active.questions.slice(0, 2)) assert.deepEqual(question.question_config.stimulus, sharedStimulus);
        for (const question of active.questions) {
          for (const key of ['answer_key', 'correct_option', 'explanation', 'is_correct', 'marks_awarded']) assert.ok(!(key in question), `${mode} leaked ${key}`);
          assert.ok(!('public_item_ids' in question.question_config), 'The private ordering identifier map is never student-visible.');
          if (question.question_type === 'ordering') assert.ok(question.question_config.items.every((item) => !['I1', 'I2', 'I3'].includes(item.id)), 'Canonical ordering identifiers are not exposed.');
        }
        const forgedOrder = await harness.call(`/api/attempts/${attempt.token}/answers`, { method: 'PUT', admin: false, body: { question_id: questions[8].id, answer_data: specimens[8].correct } });
        assert.equal(forgedOrder.status, 400, 'Canonical ordering IDs cannot bypass opaque student identifiers.');
        if (scenario !== 'unanswered') {
          for (let index = 0; index < questions.length; index++) {
            const response = await save(harness, attempt.token, questions[index], specimens[index][scenario]);
            assert.equal(response.status, 200, await response.clone().text());
          }
          const resumed = await (await harness.call(`/api/attempts/${attempt.token}`, { admin: false })).json();
          assert.equal(resumed.answers.length, 9);
          for (const answer of resumed.answers) assert.ok(!('is_correct' in answer) && !('marks_awarded' in answer));
          const publicOrder = resumed.answers.find((answer) => answer.question_id === questions[8].id).answer_data.order;
          assert.deepEqual(publicOrder, specimens[8][scenario].order.map((id) => questions[8].answer_key.public_item_ids[id]));
          assert.deepEqual(JSON.parse(harness.db.prepare('SELECT answer_data FROM answers WHERE attempt_id=? AND question_id=?').get(attempt.attempt_id, questions[8].id).answer_data).order, specimens[8][scenario].order, 'Stored raw ordering IDs remain canonical and unambiguous.');
        }
        const results = await Promise.all(Array.from({ length: 3 }, async () => {
          const response = await harness.call(`/api/attempts/${attempt.token}/submit`, { method: 'POST', admin: false });
          assert.equal(response.status, 200, await response.clone().text());
          return (await response.json()).result;
        }));
        results.forEach((result) => assert.deepEqual(result, results[0]));
        const result = results[0];
        assert.equal(result.score, scenario === 'correct' ? 27 : scenario === 'wrong' ? -3.5 : 0);
        assert.deepEqual(result.answers.map((answer, index) => answer.marks_awarded), specimens.map((specimen) => scenario === 'correct' ? 3 : scenario === 'wrong' ? specimen.wrongMarks : null));
        assert.deepEqual(result.answers.map((answer) => answer.question_type), specimens.map((specimen) => specimen.question_type));
        assert.equal((await save(harness, attempt.token, questions[0], specimens[0].wrong)).status, 409);
        const storedScore = harness.db.prepare('SELECT score FROM attempts WHERE id=?').get(attempt.attempt_id).score;
        assert.equal(storedScore, result.score);
      }
      const partial = await startAttempt(harness, exam);
      assert.equal((await save(harness, partial.token, questions[1], { selected_options: ['A'] })).status, 200);
      const partialResult = await (await harness.call(`/api/attempts/${partial.token}/submit`, { method: 'POST', admin: false })).json();
      assert.equal(partialResult.result.score, 1.5, 'No second negative penalty on partial multi-select credit.');
      const expired = await startAttempt(harness, exam);
      assert.equal((await save(harness, expired.token, questions[8], specimens[8].correct)).status, 200);
      harness.db.prepare("UPDATE attempts SET started_at='2001-01-01 00:00:00' WHERE id=?").run(expired.attempt_id);
      const expiredResponse = await harness.call(`/api/attempts/${expired.token}`, { admin: false });
      assert.equal(expiredResponse.status, 200, await expiredResponse.clone().text());
      const expiredBody = await expiredResponse.json();
      assert.equal(expiredBody.status, 'auto_submitted');
      assert.equal(expiredBody.result.score, 3);
      assert.equal((await save(harness, expired.token, questions[8], specimens[8].wrong)).status, 409);
      harness.db.prepare('UPDATE exams SET show_score=0,show_answers=0,allow_pdf_download=0 WHERE id=?').run(exam.id);
      const hidden = await (await harness.call(`/api/attempts/${expired.token}`, { admin: false })).json();
      assert.ok(!('score' in hidden.result) && !('answers' in hidden.result));
      harness.db.prepare('UPDATE exams SET show_score=1,show_answers=1 WHERE id=?').run(exam.id);
      for (let index = 0; index < questions.length; index++) {
        const response = await harness.call(`/api/admin/questions/${questions[index].id}`, { method: 'PUT', body: { ...payload(specimens[index], index), question_text: `Updated ${specimens[index].question_type}`, ...(index === 0 ? { stimulus: { ...sharedStimulus, text: 'New bank wording.' } } : {}) } });
        assert.equal(response.status, 200, await response.clone().text());
        assert.notEqual((await response.json()).id, questions[index].id, 'Used questions are versioned, not overwritten.');
      }
      const historical = await (await harness.call(`/api/attempts/${expired.token}`, { admin: false })).json();
      assert.equal(historical.result.score, 3);
      assert.deepEqual(historical.result.answers.map((answer) => answer.question_text), specimens.map((specimen) => specimen.question_text));
      for (const question of historical.result.answers.slice(0, 2)) assert.deepEqual(question.question_config.stimulus, sharedStimulus, 'Saved exam material and shared media URL survive bank editing.');
      const backupResponse = await harness.call('/api/admin/backup');
      assert.equal(backupResponse.status, 200);
      const backup = await backupResponse.json();
      for (const table of ['questions', 'exams', 'exam_questions', 'attempts', 'answers', 'admin_auth']) assert.ok(Array.isArray(backup.tables[table]));
      for (const question of questions) {
        const archived = backup.tables.questions.find((row) => row.id === question.id);
        assert.equal(archived.archived, 1);
        assert.ok(archived.question_config && archived.answer_key);
      }
      assert.ok(backup.tables.answers.some((answer) => JSON.parse(answer.answer_data || '{}').order?.length === 3));
      assert.deepEqual(harness.db.pragma('foreign_key_check'), []);
    } finally { await harness.close(); }
  });
}

test('Worker: a concurrent answer save invalidates a grading snapshot, and a losing submit cannot regrade the winner', { timeout: 30_000 }, async () => {
  let pause;
  let entered;
  let release;
  const hooks = {
    async afterAll(sql) {
      if (pause && /^SELECT \* FROM answers WHERE attempt_id/.test(sql)) {
        pause = false;
        entered();
        await new Promise((resolve) => { release = resolve; });
      }
    },
  };
  const harness = await backend('Worker', hooks);
  try {
    const { questions, exam } = await createExam(harness);
    for (const { winnerAlsoSubmits, initiallyAnswered } of [
      { winnerAlsoSubmits: false, initiallyAnswered: true },
      { winnerAlsoSubmits: true, initiallyAnswered: true },
      { winnerAlsoSubmits: false, initiallyAnswered: false },
    ]) {
      const attempt = await startAttempt(harness, exam);
      if (initiallyAnswered) assert.equal((await save(harness, attempt.token, questions[0], specimens[0].correct)).status, 200);
      const paused = new Promise((resolve) => { entered = resolve; });
      pause = true;
      const firstSubmit = harness.call(`/api/attempts/${attempt.token}/submit`, { method: 'POST', admin: false });
      await paused;
      assert.equal((await save(harness, attempt.token, questions[0], specimens[0].wrong)).status, 200);
      let winner;
      if (winnerAlsoSubmits) {
        const response = await harness.call(`/api/attempts/${attempt.token}/submit`, { method: 'POST', admin: false });
        assert.equal(response.status, 200, await response.clone().text());
        winner = (await response.json()).result;
      }
      release();
      const response = await firstSubmit;
      assert.equal(response.status, 200, await response.clone().text());
      const result = (await response.json()).result;
      assert.equal(result.score, -0.5);
      assert.equal(result.answers[0].selected_option, 'B');
      assert.equal(result.answers[0].is_correct, 0);
      assert.equal(result.answers[0].marks_awarded, -0.5);
      if (winner) assert.deepEqual(result, winner);
    }
  } finally {
    release?.();
    await harness.close();
  }
});

function workbookForm(workbook) {
  const form = new FormData();
  form.append('subject', 'Import fallback');
  form.append('file', new Blob([XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' })]), 'questions.xlsx');
  return form;
}
function smallWorkbook(secondQuestionType = 'yes_no') {
  const workbook = XLSX.utils.book_new();
  for (const [name, questionType, text] of [['First questions', 'yes_no', 'First valid question?'], ['Second questions', secondQuestionType, 'Second question?']]) {
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['Question', 'Question Type', 'Correct Answer', 'Marks'], [text, questionType, 'yes', 2.5]]), name);
  }
  return workbook;
}

test('versioned workbook round trips all nine types, preserves marks and formatting, and diagnoses every worksheet before import', () => {
  assert.equal(QUESTION_WORKBOOK_VERSION, 2);
  const workbook = createQuestionWorkbook(XLSX);
  const reparsed = XLSX.read(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }), { type: 'buffer' });
  const parsed = parseQuestionWorkbook(reparsed, XLSX);
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(parsed.questions.map((question) => question.question_type).sort(), [...SUPPORTED_QUESTION_TYPES].sort());
  assert.ok(parsed.questions[0].question_text.includes('<u>'));
  assert.equal(JSON.parse(parsed.questions.find((question) => question.question_type === 'ordering').question_config).default_marks, 2);
  const invalid = parseQuestionWorkbook(smallWorkbook('unsupported'), XLSX, 'Fallback');
  assert.equal(invalid.questions.length, 0);
  assert.ok(invalid.errors.some((error) => /Second questions.*Row 2.*Unsupported question type/.test(error)));
  const duplicate = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(duplicate, XLSX.utils.aoa_to_sheet([['Question', 'Question Type', 'Correct Answer', 'Category', 'Subject'], ['Ambiguous?', 'yes_no', 'yes', 'A', 'B']]), 'Ambiguous');
  assert.match(parseQuestionWorkbook(duplicate, XLSX).errors.join('\n'), /Duplicate column/);
  const legacy = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(legacy, XLSX.utils.aoa_to_sheet([
    ['Question', 'Option A', 'Option B', 'Option C', 'Option D', 'Correct Option', 'Subject', 'Question Config'],
    ['Legacy aliases?', 'A', 'B', 'C', 'D', 'B', 'Legacy subject', '{"default_marks":2.5}'],
  ]), 'Legacy');
  const legacyResult = parseQuestionWorkbook(legacy, XLSX);
  assert.deepEqual(legacyResult.errors, []);
  assert.equal(legacyResult.questions[0].correct_option, 'B');
  assert.equal(legacyResult.questions[0].category, 'Legacy subject');
  assert.equal(JSON.parse(legacyResult.questions[0].question_config).default_marks, 2.5);
  const offsetBook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(offsetBook, XLSX.utils.aoa_to_sheet([[], [], ['Question', 'Question Type', 'Correct Answer'], ['Offset invalid row', 'unsupported', 'yes']]), 'Offset rows');
  assert.match(parseQuestionWorkbook(offsetBook, XLSX, 'Fallback').errors.join('\n'), /Row 4:/);
});

for (const mode of ['Express', 'Worker']) {
  test(`${mode}: template download, multi-sheet import and validation/storage failures are atomic`, { timeout: 60_000 }, async () => {
    const harness = await backend(mode);
    try {
      const template = await harness.call('/api/admin/questions/template');
      assert.equal(template.status, 200);
      const workbook = XLSX.read(await template.arrayBuffer(), { type: 'array' });
      const parsed = parseQuestionWorkbook(workbook, XLSX);
      assert.deepEqual(parsed.errors, []);
      assert.equal(parsed.questions.length, 9);
      const response = await harness.call('/api/admin/questions/import', { method: 'POST', body: workbookForm(workbook) });
      assert.equal(response.status, 200, await response.clone().text());
      assert.equal((await response.json()).imported, 9);
      const count = () => harness.db.prepare('SELECT count(*) AS count FROM questions').get().count;
      const before = count();
      const invalid = await harness.call('/api/admin/questions/import', { method: 'POST', body: workbookForm(smallWorkbook('unsupported')) });
      assert.equal(invalid.status, 400, await invalid.clone().text());
      assert.match(JSON.stringify(await invalid.json()), /Second questions.*Row 2/);
      assert.equal(count(), before);
      const success = await harness.call('/api/admin/questions/import', { method: 'POST', body: workbookForm(smallWorkbook()) });
      assert.equal(success.status, 200, await success.clone().text());
      assert.equal((await success.json()).imported, 2);
      assert.equal(count(), before + 2);
      harness.db.exec("CREATE TRIGGER reject_test_insert BEFORE INSERT ON questions WHEN NEW.question_text='Second question?' BEGIN SELECT RAISE(ABORT, 'Deliberate acceptance test storage failure'); END;");
      const failedWrite = await harness.call('/api/admin/questions/import', { method: 'POST', body: workbookForm(smallWorkbook()) });
      assert.equal(failedWrite.status, 500);
      assert.equal(count(), before + 2, 'The transaction rolls back earlier question inserts after a storage failure.');
      harness.db.exec('DROP TRIGGER reject_test_insert');
      const badPaste = await harness.call('/api/admin/questions/bulk', { method: 'POST', body: { subject: 'Acceptance', text: '1. Is this valid?\nType: yes_no\nAnswer: yes\n\n2. Broken.\nType: imaginary\nAnswer: no' } });
      assert.equal(badPaste.status, 400);
      assert.equal(count(), before + 2);
      const paste = await harness.call('/api/admin/questions/bulk', { method: 'POST', body: { subject: 'Acceptance', text: BULK_PASTE_SAMPLE } });
      assert.equal(paste.status, 200, await paste.clone().text());
      assert.equal((await paste.json()).imported, 9);
    } finally { await harness.close(); }
  });
}

test('fill-blank D1 migration preserves populated question versions, links, submitted raw answers, grades and ID high-water marks', () => {
  const db = new Database(':memory:');
  try {
    db.pragma('foreign_keys = ON');
    const names = fs.readdirSync(path.join(root, 'drizzle')).filter((name) => /^000[0-7]_.*\.sql$/.test(name)).sort();
    assert.equal(names.length, 8);
    const migrate = (name) => {
      const statements = fs.readFileSync(path.join(root, 'drizzle', name), 'utf8').split('--> statement-breakpoint').filter((sql) => sql.trim());
      db.transaction(() => statements.forEach((sql) => db.exec(sql)))();
    };
    names.slice(0, 7).forEach(migrate);
    db.prepare("INSERT INTO exams (id,title,duration_minutes,status,show_score,show_answers) VALUES (1,'Existing exam',30,'published',1,1)").run();
    db.prepare("INSERT INTO attempts (id,exam_id,access_token,student_name,roll_number,started_at,status,score) VALUES (1,1,'migration-student','Existing student','1','2026-01-01 00:00:00','submitted',24)").run();
    const insert = db.prepare(`INSERT INTO questions (id,archived,question_text,question_type,option_a,option_b,option_c,option_d,correct_option,question_config,answer_key,media,category,difficulty,explanation)
      VALUES (@id,1,@question_text,@question_type,@option_a,@option_b,@option_c,@option_d,@correct_option,@question_config,@answer_key,@media,@category,@difficulty,@explanation)`);
    for (const [index, specimen] of specimens.filter((specimen) => specimen.question_type !== 'fill_blank').entries()) {
      const { question, errors } = normalizeQuestion(payload(specimen, index));
      assert.deepEqual(errors, []);
      insert.run({ id: index + 1, ...question });
      db.prepare('INSERT INTO exam_questions (id,exam_id,question_id,marks,sort_order) VALUES (?,1,?,3,?)').run(index + 1, index + 1, index);
      const validated = validateStudentAnswer(question, { answer_data: specimen.correct });
      assert.equal(validated.error, null);
      db.prepare('INSERT INTO answers (id,attempt_id,question_id,selected_option,answer_data,is_correct,marks_awarded) VALUES (?,1,?,?,?,1,3)').run(index + 1, index + 1, validated.selected_option, validated.answerDataJson);
    }
    const before = Object.fromEntries(['questions', 'exam_questions', 'attempts', 'answers'].map((table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()]));
    // Deleted IDs must not be reused after a table rebuild.
    const extra = normalizeQuestion(payload(specimens[0])).question;
    insert.run({ id: 10000, ...extra });
    db.prepare('DELETE FROM questions WHERE id=10000').run();
    migrate(names[7]);
    for (const [table, rows] of Object.entries(before)) assert.deepEqual(db.prepare(`SELECT * FROM ${table} ORDER BY id`).all(), rows, `${table} changed during migration`);
    const blank = normalizeQuestion(payload(specimens.find((specimen) => specimen.question_type === 'fill_blank'))).question;
    const result = db.prepare(`INSERT INTO questions (question_text,question_type,question_config,answer_key,category) VALUES (?,?,?,?,?)`).run(blank.question_text, blank.question_type, blank.question_config, blank.answer_key, blank.category);
    assert.equal(Number(result.lastInsertRowid), 10001);
    assert.deepEqual(db.pragma('foreign_key_check'), []);
  } finally { db.close(); }
});

test('blank validation rejects malformed and oversized responses, respects per-blank case, and grades all-or-nothing', () => {
  const base = payload(specimens.find((specimen) => specimen.question_type === 'fill_blank'));
  for (const blanks of [[null], [{ id: 'B1' }, { id: 'B1' }], [{ id: 'B1', max_length: -1 }]]) {
    assert.ok(normalizeQuestion({ ...base, question_config: { blanks } }).errors.length);
  }
  const normalized = normalizeQuestion({ ...base, question_config: { blanks: [{ id: 'B1', max_length: 5, case_sensitive: false }, { id: 'B2', max_length: 5, case_sensitive: true }] } });
  assert.deepEqual(normalized.errors, []);
  const question = { ...normalized.question, marks: 3 };
  assert.ok(validateStudentAnswer(question, { answer_data: { blanks: { B1: 'Too long' } } }).error);
  assert.ok(validateStudentAnswer(question, { answer_data: { text: 'Too long' } }).error, 'Single-blank text fallback cannot bypass length checks.');
  assert.ok(validateStudentAnswer(question, { answer_data: { blanks: { UNKNOWN: 'x' } } }).error);
  const grade = (blanks) => evaluateQuestionAnswer(question, { answer_data: { blanks } }, 0.5);
  assert.equal(grade({ B1: ' CAFÉ ', B2: 'NaCl' }).marksAwarded, 3);
  assert.equal(grade({ B1: 'cafe\u0301', B2: 'nacl' }).marksAwarded, -0.5);
  assert.equal(grade({ B1: 'café' }).marksAwarded, -0.5);
  assert.equal(grade({}).marksAwarded, 0);
});

test('paste v2 rejects ambiguity and unknown lines with locations while retaining legacy syntax and the 300-block limit', () => {
  const legacy = '1. Plain MCQ?\nA. First\nB. Second\nC. Third\nD. Fourth\nAnswer: A';
  assert.deepEqual(parseQuestionPaste(legacy, 'Legacy').errors, []);
  assert.deepEqual(parseQuestionPaste(`MCQ-PASTE: 2\n${legacy}`, 'Legacy').errors, []);
  assert.match(parseQuestionPaste(`MCQ-PASTE: 999\n${legacy}`, 'Legacy').errors.join('\n'), /version/i);
  for (const suffix of ['\nAnswer: B', '\nA. Replacement', '\nUnrecognized teacher instruction']) {
    const result = parseQuestionPaste(`MCQ-PASTE: 2\n${legacy}${suffix}`, 'Legacy');
    assert.ok(result.errors.length);
    assert.match(result.errors.join('\n'), /Question 1.*Line/i);
  }
  const blocks = Array.from({ length: 300 }, (_, index) => `${index + 1}. Yes?\nType: yes_no\nAnswer: yes`);
  assert.equal(parseQuestionPaste(blocks.join('\n\n'), 'Legacy').questions.length, 300);
  blocks.push('301. No?\nType: yes_no\nAnswer: no');
  assert.match(parseQuestionPaste(blocks.join('\n\n'), 'Legacy').errors.join('\n'), /300/);
});

test('private ordering-ID migration leaves original keys, chunks, submitted responses and marks unchanged and is idempotent', () => {
  const db = new Database(':memory:');
  try {
    db.pragma('foreign_keys = ON');
    const names = fs.readdirSync(path.join(root, 'drizzle')).filter((name) => /^000[0-8]_.*\.sql$/.test(name)).sort();
    assert.equal(names.length, 9);
    const migrate = (name) => db.transaction(() => {
      for (const statement of fs.readFileSync(path.join(root, 'drizzle', name), 'utf8').split('--> statement-breakpoint').filter((sql) => sql.trim())) db.exec(statement);
    })();
    names.slice(0, 8).forEach(migrate);
    const config = JSON.stringify(specimens[8].question_config);
    const key = JSON.stringify(specimens[8].answer_key);
    db.prepare("INSERT INTO questions (id,archived,question_text,question_type,question_config,answer_key,category) VALUES (1,1,'Existing ordering','ordering',?,?,'Legacy')").run(config, key);
    db.prepare("INSERT INTO exams (id,title,duration_minutes,status) VALUES (1,'Legacy',30,'published')").run();
    db.prepare('INSERT INTO exam_questions (id,exam_id,question_id,marks,sort_order) VALUES (1,1,1,3,0)').run();
    db.prepare("INSERT INTO attempts (id,exam_id,access_token,student_name,roll_number,started_at,status,score) VALUES (1,1,'legacy-ordering','Student','1','2026-01-01 00:00:00','submitted',3)").run();
    db.prepare('INSERT INTO answers (id,attempt_id,question_id,answer_data,is_correct,marks_awarded) VALUES (1,1,1,?,1,3)').run(JSON.stringify(specimens[8].correct));
    const before = Object.fromEntries(['exam_questions', 'attempts', 'answers'].map((table) => [table, db.prepare(`SELECT * FROM ${table}`).all()]));
    migrate(names[8]);
    const question = db.prepare('SELECT * FROM questions WHERE id=1').get();
    const upgradedKey = JSON.parse(question.answer_key);
    assert.equal(question.question_config, config);
    assert.deepEqual(upgradedKey.correct_order, specimens[8].answer_key.correct_order);
    assert.deepEqual(Object.keys(upgradedKey.public_item_ids).sort(), ['I1', 'I2', 'I3']);
    assert.equal(new Set(Object.values(upgradedKey.public_item_ids)).size, 3);
    assert.ok(Object.values(upgradedKey.public_item_ids).every((id) => /^O[A-F0-9]{32}$/.test(id)));
    for (const [table, rows] of Object.entries(before)) assert.deepEqual(db.prepare(`SELECT * FROM ${table}`).all(), rows);
    migrate(names[8]);
    assert.equal(db.prepare('SELECT answer_key FROM questions WHERE id=1').get().answer_key, question.answer_key);
    assert.deepEqual(db.pragma('foreign_key_check'), []);
  } finally { db.close(); }
});
