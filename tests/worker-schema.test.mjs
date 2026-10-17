import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import worker from '../dist/server/index.js';

const root = path.resolve(import.meta.dirname || path.dirname(fileURLToPath(import.meta.url)), '..');

function makeD1(db) {
  const wrap = (statement, values = []) => ({
    statement,
    values,
    bind(...boundValues) { return wrap(statement, boundValues); },
    async first() { return statement.get(...values) ?? null; },
    async all() { return { results: statement.all(...values) }; },
    async run() {
      const result = statement.run(...values);
      return { meta: { changes: result.changes, last_row_id: Number(result.lastInsertRowid) || 0 } };
    },
  });
  return {
    prepare(sql) { return wrap(db.prepare(sql)); },
    async batch(statements) {
      return db.transaction(() => statements.map(({ statement, values }) => {
        const result = statement.run(...values);
        return { meta: { changes: result.changes, last_row_id: Number(result.lastInsertRowid) || 0 } };
      }))();
    },
  };
}

test('latest SQLite migration accepts yes_no and preserves existing questions and exam links', () => {
  const db = new Database(':memory:');
  try {
    db.pragma('foreign_keys = ON');
    const migrationNames = fs.readdirSync(path.join(root, 'drizzle')).filter((name) => /^000[0-6]_.*\.sql$/.test(name)).sort();
    for (const name of migrationNames.slice(0, 6)) {
      const sql = fs.readFileSync(path.join(root, 'drizzle', name), 'utf8')
        .split('--> statement-breakpoint').map((statement) => statement.trim()).filter(Boolean);
      for (const statement of sql) db.exec(statement);
    }

    db.prepare(`INSERT INTO questions (id,question_text,question_type,option_a,option_b,option_c,option_d,correct_option,question_config,answer_key)
      VALUES (101,'Legacy question','mcq_single','A text','B text','C text','D text','A','{}','{}')`).run();
    db.prepare("INSERT INTO exams (id,title,duration_minutes) VALUES (201,'Existing exam',30)").run();
    db.prepare('INSERT INTO exam_questions (id,exam_id,question_id,marks,sort_order) VALUES (301,201,101,2,0)').run();
    db.prepare(`INSERT INTO attempts (id,exam_id,access_token,student_name,roll_number,started_at,status,score)
      VALUES (401,201,'existing-token','Student','42','2026-01-01T00:00:00.000Z','submitted',2)`).run();
    db.prepare(`INSERT INTO answers (id,attempt_id,question_id,selected_option,answer_data,is_correct,marks_awarded)
      VALUES (501,401,101,'A',json_object('selected_option','A'),1,2)`).run();

    const migration = fs.readFileSync(path.join(root, 'drizzle', migrationNames[6]), 'utf8')
      .split('--> statement-breakpoint').map((statement) => statement.trim()).filter(Boolean);
    db.transaction(() => {
      for (const statement of migration) db.exec(statement);
    })();

    const yesNoInsert = db.prepare(`INSERT INTO questions (question_text,question_type,question_config,answer_key)
      VALUES ('Yes or no?','yes_no',?,?)`);
    yesNoInsert.run(JSON.stringify({ options: [{ id: 'yes', text: 'Yes' }, { id: 'no', text: 'No' }] }), JSON.stringify({ correct_answer: 'yes' }));

    const rows = db.prepare('SELECT question_type,question_config,answer_key FROM questions ORDER BY id').all();
    assert.equal(rows[0].question_type, 'mcq_single');
    assert.deepEqual(JSON.parse(rows[0].question_config).options.map(({ id, text }) => [id, text]), [['A', 'A text'], ['B', 'B text'], ['C', 'C text'], ['D', 'D text']]);
    assert.equal(JSON.parse(rows[0].answer_key).correct_option, 'A');
    assert.equal(rows[1].question_type, 'yes_no');
    assert.deepEqual(JSON.parse(rows[1].question_config).options.map(({ id, text }) => [id, text]), [['yes', 'Yes'], ['no', 'No']]);
    assert.equal(JSON.parse(rows[1].answer_key).correct_answer, 'yes');
    assert.deepEqual(db.prepare('SELECT id,exam_id,question_id,marks,sort_order FROM exam_questions').get(), { id: 301, exam_id: 201, question_id: 101, marks: 2, sort_order: 0 });
    assert.deepEqual(db.prepare('SELECT id,student_name,roll_number,status,score FROM attempts').get(), { id: 401, student_name: 'Student', roll_number: '42', status: 'submitted', score: 2 });
    assert.deepEqual(db.prepare('SELECT id,attempt_id,question_id,selected_option,answer_data,is_correct,marks_awarded FROM answers').get(), { id: 501, attempt_id: 401, question_id: 101, selected_option: 'A', answer_data: '{"selected_option":"A"}', is_correct: 1, marks_awarded: 2 });
    const legacyQuestionId = Number(db.prepare(`INSERT INTO questions (question_text,option_a,option_b,option_c,option_d,correct_option,category)
      VALUES ('Legacy insert after migration','A','B','C','D','A','General')`).run().lastInsertRowid);
    const triggerQuestion = db.prepare('SELECT question_type,question_config,answer_key FROM questions WHERE id=?').get(legacyQuestionId);
    assert.equal(triggerQuestion.question_type, 'mcq_single');
    assert.equal(JSON.parse(triggerQuestion.question_config).options.length, 4);
    assert.deepEqual(JSON.parse(triggerQuestion.answer_key), { correct_option: 'A' });
    db.prepare(`INSERT INTO answers (attempt_id,question_id,selected_option,is_correct,marks_awarded)
      VALUES (401,?, 'B',0,0)`).run(legacyQuestionId);
    assert.deepEqual(JSON.parse(db.prepare('SELECT answer_data FROM answers WHERE attempt_id=401 AND question_id=?').get(legacyQuestionId).answer_data), { selected_option: 'B' });
    assert.deepEqual(db.pragma('foreign_key_check'), []);
    assert.throws(() => db.prepare(`INSERT INTO questions (question_text,question_type) VALUES ('Unsupported','not_a_type')`).run());
  } finally {
    db.close();
  }
});

test('Worker attempt routes hide keys while active and persist and grade multi-select and yes_no answers', async () => {
  const db = new Database(':memory:');
  try {
    db.pragma('foreign_keys = ON');
    for (const name of fs.readdirSync(path.join(root, 'drizzle')).filter((name) => /^000[0-6]_.*\.sql$/.test(name)).sort()) {
      const sql = fs.readFileSync(path.join(root, 'drizzle', name), 'utf8')
        .split('--> statement-breakpoint').map((statement) => statement.trim()).filter(Boolean);
      for (const statement of sql) db.exec(statement);
    }
    db.prepare("INSERT INTO site_meta (key,value) VALUES ('initial_seed','1')").run();
    db.prepare(`INSERT INTO exams (id,title,duration_minutes,subject,negative_mark,status,show_score,show_answers)
      VALUES (1,'Worker exam',30,'Science',1,'published',1,1)`).run();
    const multiConfig = JSON.stringify({ options: [
      { id: 'A', text: 'Alpha' }, { id: 'B', text: 'Beta' }, { id: 'C', text: 'Gamma' },
      { id: 'D', text: 'Delta' }, { id: 'E', text: 'Epsilon' },
    ] });
    const multiKey = JSON.stringify({ correct_options: ['A', 'B', 'C'] });
    const insertMulti = db.prepare(`INSERT INTO questions (id,question_text,question_type,question_config,answer_key)
      VALUES (?,?,'mcq_multi',?,?)`);
    insertMulti.run(1, 'Select one correct option', multiConfig, multiKey);
    insertMulti.run(2, 'Select all options', multiConfig, multiKey);
    insertMulti.run(3, 'Select both correct options', multiConfig, multiKey);
    insertMulti.run(4, 'Leave unanswered', multiConfig, multiKey);
    insertMulti.run(5, 'Select correct and incorrect options', multiConfig, multiKey);
    db.prepare(`INSERT INTO questions (id,question_text,question_type,question_config,answer_key)
      VALUES (6,'Is it true?','yes_no',?,?)`).run(
      JSON.stringify({ options: [{ id: 'yes', text: 'Yes' }, { id: 'no', text: 'No' }] }),
      JSON.stringify({ correct_answer: 'yes' }),
    );
    db.prepare(`INSERT INTO questions (id,question_text,question_type,question_config,answer_key)
      VALUES (7,'Is it false?','yes_no',?,?)`).run(
      JSON.stringify({ options: [{ id: 'yes', text: 'Yes' }, { id: 'no', text: 'No' }] }),
      JSON.stringify({ correct_answer: 'yes' }),
    );
    db.prepare(`INSERT INTO exam_questions (exam_id,question_id,marks,sort_order)
      VALUES (1,1,6,0),(1,2,6,1),(1,3,6,2),(1,4,6,3),(1,5,6,4),(1,6,3,5),(1,7,3,6)`).run();
    db.prepare(`INSERT INTO attempts (id,exam_id,access_token,student_name,roll_number,email,address,started_at,status)
      VALUES (1,1,'worker-token','Student','42','s@example.test','Test address',?,'in_progress')`).run(new Date().toISOString());
    const env = { DB: makeD1(db) };

    const active = await worker.fetch(new Request('https://example.test/api/attempts/worker-token'), env, {});
    assert.equal(active.status, 200);
    const activeBody = await active.json();
    assert.equal(activeBody.result, null);
    assert.equal('answer_key' in activeBody.questions[0], false);
    assert.equal(activeBody.questions.length, 7);
    assert.ok(activeBody.questions.every((question) => !('answer_key' in question)));

    const saveAnswer = async (questionId, answerData) => worker.fetch(new Request('https://example.test/api/attempts/worker-token/answers', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question_id: questionId, answer_data: answerData }),
    }), env, {});
    const partial = await saveAnswer(1, { selected_options: ['A'] });
    const allSelected = await saveAnswer(2, { selected_options: ['A', 'B', 'C', 'D', 'E'] });
    const fullMatch = await saveAnswer(3, { selected_options: ['A', 'B', 'C'] });
    const mixed = await saveAnswer(5, { selected_options: ['A', 'B', 'D'] });
    const wrongYesNo = await saveAnswer(6, { selected_answer: 'no' });
    const correctYesNo = await saveAnswer(7, { selected_answer: 'yes' });
    for (const response of [partial, allSelected, fullMatch, mixed, wrongYesNo, correctYesNo]) {
      assert.equal(response.status, 200, await response.text());
    }
    assert.deepEqual(JSON.parse(db.prepare('SELECT answer_data FROM answers WHERE question_id=1').get().answer_data), { selected_options: ['A'] });
    assert.deepEqual(JSON.parse(db.prepare('SELECT answer_data FROM answers WHERE question_id=2').get().answer_data), { selected_options: ['A', 'B', 'C', 'D', 'E'] });
    assert.deepEqual(JSON.parse(db.prepare('SELECT answer_data FROM answers WHERE question_id=3').get().answer_data), { selected_options: ['A', 'B', 'C'] });
    assert.deepEqual(JSON.parse(db.prepare('SELECT answer_data FROM answers WHERE question_id=5').get().answer_data), { selected_options: ['A', 'B', 'D'] });
    assert.deepEqual(JSON.parse(db.prepare('SELECT answer_data FROM answers WHERE question_id=6').get().answer_data), { selected_answer: 'no' });
    assert.deepEqual(JSON.parse(db.prepare('SELECT answer_data FROM answers WHERE question_id=7').get().answer_data), { selected_answer: 'yes' });
    assert.equal(db.prepare('SELECT 1 FROM answers WHERE question_id=4').get(), undefined);

    const submit = await worker.fetch(new Request('https://example.test/api/attempts/worker-token/submit', { method: 'POST' }), env, {});
    assert.equal(submit.status, 200);
    const result = (await submit.json()).result;
    assert.equal(result.score, 12);
    const grades = result.answers.map(({ is_correct, marks_awarded }) => [is_correct, marks_awarded]);
    assert.deepEqual(grades.map(([isCorrect]) => isCorrect), [0, 0, 1, null, 0, 0, 1]);
    const expectedMarks = [2, 0, 6, null, 1, 0, 3];
    grades.forEach(([, marksAwarded], index) => {
      if (expectedMarks[index] === null) assert.equal(marksAwarded, null);
      else assert.ok(Math.abs(marksAwarded - expectedMarks[index]) < 1e-9, `Question ${index + 1} awarded ${marksAwarded}, expected ${expectedMarks[index]}.`);
    });
  } finally {
    db.close();
  }
});
