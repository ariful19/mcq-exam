import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  QUESTION_TYPES,
  SUPPORTED_QUESTION_TYPES,
  normalizeQuestion,
  validateQuestionMedia,
  hydrateQuestionRow,
  hydrateAnswerRow,
  validateStudentAnswer,
  evaluateQuestionAnswer,
  parseQuestionPaste,
  sanitizeRichText,
  formatQuestionBlanks,
  cleanQuestionBlanks,
  renderQuestionText,
  BULK_PASTE_SAMPLE,
  migrateSqliteDatabase,
} from '../server/question-types.js';

const root = path.resolve(import.meta.dirname || path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Creates a synchronous SQLite database handle backed by `better-sqlite3` when available,
 * or by the system Python `sqlite3` module in environments without native Node addons installed.
 */
async function openTestDatabase(dbFilePath) {
  try {
    const { default: Database } = await import('better-sqlite3');
    const db = new Database(dbFilePath);
    db.pragma('foreign_keys = ON');
    return {
      pragma(sql) {
        return db.pragma(sql);
      },
      exec(sql) {
        db.exec(sql);
      },
      prepare(sql) {
        const stmt = db.prepare(sql);
        return {
          get(...params) { return stmt.get(...params); },
          all(...params) { return stmt.all(...params); },
          run(...params) { return stmt.run(...params); },
        };
      },
      transaction(fn) {
        return db.transaction(fn);
      },
      close() {
        db.close();
      },
    };
  } catch {
    let fkEnabled = true;
    const runPy = (op, sql = '', params = []) => {
      const pyScript = `
import sys, json, sqlite3
payload = json.loads(sys.stdin.read())
con = sqlite3.connect(payload["db"])
con.row_factory = sqlite3.Row
if payload["fk"]:
    con.execute("PRAGMA foreign_keys = ON")
else:
    con.execute("PRAGMA foreign_keys = OFF")
op = payload["op"]
sql = payload["sql"]
params = payload["params"]
if op == "exec":
    con.executescript(sql)
    con.commit()
    print(json.dumps({"ok": True}))
elif op == "pragma":
    cur = con.execute("PRAGMA " + sql)
    rows = [dict(r) for r in cur.fetchall()]
    con.commit()
    print(json.dumps({"rows": rows}))
elif op == "get":
    cur = con.execute(sql, params)
    row = cur.fetchone()
    con.commit()
    print(json.dumps({"row": dict(row) if row is not None else None}))
elif op == "all":
    cur = con.execute(sql, params)
    rows = [dict(r) for r in cur.fetchall()]
    con.commit()
    print(json.dumps({"rows": rows}))
elif op == "run":
    cur = con.execute(sql, params)
    con.commit()
    print(json.dumps({"lastInsertRowid": cur.lastrowid, "changes": cur.rowcount}))
con.close()
`;
      const out = execFileSync('python3', ['-c', pyScript], {
        input: JSON.stringify({ db: dbFilePath, fk: fkEnabled, op, sql, params }),
        encoding: 'utf8',
      });
      return JSON.parse(out.trim());
    };

    return {
      pragma(sql) {
        const clean = String(sql).trim();
        const fkMatch = clean.match(/^foreign_keys\s*=\s*(ON|OFF|1|0)$/i);
        if (fkMatch) {
          fkEnabled = ['ON', '1'].includes(fkMatch[1].toUpperCase());
          return [];
        }
        return runPy('pragma', clean).rows;
      },
      exec(sql) {
        runPy('exec', sql);
      },
      prepare(sql) {
        return {
          get(...params) {
            const bound = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
            return runPy('get', sql, bound).row ?? undefined;
          },
          all(...params) {
            const bound = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
            return runPy('all', sql, bound).rows;
          },
          run(...params) {
            const bound = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
            return runPy('run', sql, bound);
          },
        };
      },
      transaction(fn) {
        return (...args) => fn(...args);
      },
      close() {},
    };
  }
}

test('stable question-type identifiers and legacy MCQ normalization work losslessly', () => {
  assert.deepEqual(SUPPORTED_QUESTION_TYPES, [
    'mcq_single',
    'mcq_multi',
    'true_false',
    'fill_blank',
    'short_answer',
    'numeric',
    'matching',
    'ordering',
  ]);

  const legacyInput = {
    question_text: 'What is the capital of Bangladesh?',
    option_a: 'Chattogram',
    option_b: 'Dhaka',
    option_c: 'Khulna',
    option_d: 'Rajshahi',
    correct_option: 'b',
    category: 'Bangladesh',
    difficulty: 'Easy',
    explanation: 'Dhaka is the capital city.',
  };
  const { question, errors } = normalizeQuestion(legacyInput);
  assert.deepEqual(errors, []);
  assert.equal(question.question_type, QUESTION_TYPES.MCQ_SINGLE);
  assert.equal(question.option_a, 'Chattogram');
  assert.equal(question.option_b, 'Dhaka');
  assert.equal(question.option_c, 'Khulna');
  assert.equal(question.option_d, 'Rajshahi');
  assert.equal(question.correct_option, 'B');
  assert.equal(question.category, 'Bangladesh');
  assert.equal(question.media, null);
  assert.deepEqual(JSON.parse(question.question_config), {
    options: [
      { id: 'A', text: 'Chattogram' },
      { id: 'B', text: 'Dhaka' },
      { id: 'C', text: 'Khulna' },
      { id: 'D', text: 'Rajshahi' },
    ],
  });
  assert.deepEqual(JSON.parse(question.answer_key), { correct_option: 'B' });
});

test('all extensible question types validate configuration, answer keys, and optional media separately from subject', () => {
  // 1. mcq_multi with optional image media
  const multi = normalizeQuestion({
    question_text: 'Which of the following are prime numbers?',
    question_type: 'mcq_multi',
    category: 'Mathematics',
    difficulty: 'Medium',
    media: { type: 'image', url: 'https://example.com/primes.png', alt: 'Number grid' },
    question_config: {
      options: [
        { id: 'A', text: '2' },
        { id: 'B', text: '4' },
        { id: 'C', text: '5' },
        { id: 'D', text: '9' },
      ],
      min_selections: 1,
      max_selections: 3,
    },
    answer_key: { correct_options: ['A', 'C'] },
  });
  assert.deepEqual(multi.errors, []);
  assert.equal(multi.question.question_type, 'mcq_multi');
  assert.equal(multi.question.category, 'Mathematics');
  assert.equal(multi.question.correct_option, '');
  assert.deepEqual(JSON.parse(multi.question.media), {
    type: 'image',
    url: 'https://example.com/primes.png',
    alt: 'Number grid',
  });

  // 2. true_false with optional audio media
  const tf = normalizeQuestion({
    question_text: 'The Earth revolves around the Sun.',
    question_type: 'true_false',
    category: 'Science',
    media: { type: 'audio', url: '/assets/prompt.mp3', caption: 'Listen to the statement' },
    answer_key: { correct_answer: true },
  });
  assert.deepEqual(tf.errors, []);
  assert.equal(tf.question.question_type, 'true_false');
  assert.deepEqual(JSON.parse(tf.question.answer_key), { correct_answer: true });

  // 3. short_answer (deterministic, no AI/NLP)
  const shortAns = normalizeQuestion({
    question_text: 'What is the chemical symbol for gold?',
    question_type: 'short_answer',
    category: 'Chemistry',
    question_config: { case_sensitive: true, max_length: 10 },
    answer_key: { accepted_answers: ['Au'] },
  });
  assert.deepEqual(shortAns.errors, []);
  assert.equal(shortAns.question.question_type, 'short_answer');
  assert.deepEqual(JSON.parse(shortAns.question.answer_key), {
    accepted_answers: ['Au'],
    case_sensitive: true,
  });

  // 4. numeric (with tolerance)
  const numQ = normalizeQuestion({
    question_text: 'Approximate pi to two decimal places.',
    question_type: 'numeric',
    category: 'Mathematics',
    question_config: { unit: 'rad', allow_decimals: true },
    answer_key: { value: 3.14, tolerance: 0.005 },
  });
  assert.deepEqual(numQ.errors, []);
  assert.equal(numQ.question.question_type, 'numeric');
  assert.deepEqual(JSON.parse(numQ.question.answer_key), { value: 3.14, tolerance: 0.005 });

  // 5. matching
  const matchingQ = normalizeQuestion({
    question_text: 'Match each country with its capital city.',
    question_type: 'matching',
    category: 'Geography',
    question_config: {
      prompts: [
        { id: 'P1', text: 'Bangladesh' },
        { id: 'P2', text: 'Japan' },
      ],
      choices: [
        { id: 'C1', text: 'Tokyo' },
        { id: 'C2', text: 'Dhaka' },
        { id: 'C3', text: 'Seoul' },
      ],
    },
    answer_key: { pairs: { P1: 'C2', P2: 'C1' } },
  });
  assert.deepEqual(matchingQ.errors, []);
  assert.equal(matchingQ.question.question_type, 'matching');

  // 6. ordering
  const orderingQ = normalizeQuestion({
    question_text: 'Arrange these planets from closest to farthest from the Sun.',
    question_type: 'ordering',
    category: 'Astronomy',
    question_config: {
      items: [
        { id: 'M', text: 'Mercury' },
        { id: 'V', text: 'Venus' },
        { id: 'E', text: 'Earth' },
      ],
    },
    answer_key: { correct_order: ['M', 'V', 'E'] },
  });
  assert.deepEqual(orderingQ.errors, []);
  assert.equal(orderingQ.question.question_type, 'ordering');
});

test('API validation rejects unsupported types, scope violations, and malformed configurations', () => {
  // Reject unknown question types
  assert.ok(normalizeQuestion({
    question_text: 'Q?',
    question_type: 'free_essay_unknown',
    category: 'General',
  }).errors.some((e) => e.includes('Unsupported question type')));

  // Reject video question type and video media
  assert.ok(normalizeQuestion({
    question_text: 'Watch the video clip',
    question_type: 'video_question',
    category: 'Media',
  }).errors.some((e) => e.includes('Video questions and video media are not supported')));

  assert.ok(validateQuestionMedia({
    type: 'video',
    url: 'https://example.com/clip.mp4',
  }).errors.some((e) => e.includes('Video questions and video media are not supported')));

  // Reject student audio/video uploads
  assert.ok(normalizeQuestion({
    question_text: 'Record your pronunciation',
    question_type: 'audio_upload',
    category: 'Speaking',
  }).errors.some((e) => e.includes('Student audio and video uploads are not supported')));

  assert.ok(normalizeQuestion({
    question_text: 'Short answer with audio upload',
    question_type: 'short_answer',
    category: 'Speaking',
    question_config: { allow_audio_upload: true },
    answer_key: { accepted_answers: ['hello'] },
  }).errors.some((e) => e.includes('Student audio and video uploads are not supported')));

  // Reject AI/NLP grading
  assert.ok(normalizeQuestion({
    question_text: 'Explain photosynthesis',
    question_type: 'short_answer',
    category: 'Biology',
    question_config: { grading_mode: 'ai' },
    answer_key: { accepted_answers: ['light'] },
  }).errors.some((e) => e.includes('AI/NLP grading is not supported')));

  // Reject mixing subject/category or media inside question_config
  assert.ok(normalizeQuestion({
    question_text: 'Mixed fields?',
    question_type: 'true_false',
    category: 'Science',
    question_config: { category: 'WrongPlace', media: { type: 'image', url: 'https://example.com/a.png' } },
    answer_key: { correct_answer: true },
  }).errors.length >= 2);

  // Reject malformed type-specific configs & answer keys
  assert.ok(normalizeQuestion({
    question_text: 'Conflicting MCQ key',
    question_type: 'mcq_single',
    option_a: '1',
    option_b: '2',
    option_c: '3',
    option_d: '4',
    correct_option: 'A',
    answer_key: { correct_option: 'B' },
    category: 'Math',
  }).errors.some((e) => e.includes('must match')));

  assert.ok(normalizeQuestion({
    question_text: 'Bad multi choice',
    question_type: 'mcq_multi',
    category: 'Math',
    question_config: { options: [{ id: 'A', text: 'One' }, { id: 'B', text: 'Two' }] },
    answer_key: { correct_options: ['Z'] },
  }).errors.some((e) => e.includes('unknown option id')));

  assert.ok(normalizeQuestion({
    question_text: 'Bad numeric tolerance',
    question_type: 'numeric',
    category: 'Math',
    answer_key: { value: 10, tolerance: -1 },
  }).errors.some((e) => e.includes('non-negative')));

  assert.ok(normalizeQuestion({
    question_text: 'Incomplete ordering key',
    question_type: 'ordering',
    category: 'History',
    question_config: { items: [{ id: 'A', text: 'First' }, { id: 'B', text: 'Second' }] },
    answer_key: { correct_order: ['A'] },
  }).errors.some((e) => e.includes('every item id')));
});

test('mixed question-type exam grading, student answer validation, and active attempt key stripping work accurately', () => {
  const qMcq = { id: 1, marks: 1, ...normalizeQuestion({
    question_text: 'MCQ?', option_a: 'A1', option_b: 'B1', option_c: 'C1', option_d: 'D1', correct_option: 'B', category: 'Gen',
  }).question };
  const qMulti = { id: 2, marks: 2, ...normalizeQuestion({
    question_text: 'Multi?', question_type: 'mcq_multi', category: 'Gen',
    question_config: { options: [{ id: 'A', text: '1' }, { id: 'B', text: '2' }, { id: 'C', text: '3' }] },
    answer_key: { correct_options: ['A', 'C'] },
  }).question };
  const qTf = { id: 3, marks: 1, ...normalizeQuestion({
    question_text: 'TF?', question_type: 'true_false', category: 'Gen',
    answer_key: { correct_answer: false },
  }).question };
  const qShort = { id: 4, marks: 1.5, ...normalizeQuestion({
    question_text: 'Short?', question_type: 'short_answer', category: 'Gen',
    answer_key: { accepted_answers: ['Dhaka', 'Dacca'], case_sensitive: false },
  }).question };
  const qNum = { id: 5, marks: 2, ...normalizeQuestion({
    question_text: 'Num?', question_type: 'numeric', category: 'Gen',
    answer_key: { value: 9.8, tolerance: 0.05 },
  }).question };
  const qMatch = { id: 6, marks: 1, ...normalizeQuestion({
    question_text: 'Match?', question_type: 'matching', category: 'Gen',
    question_config: {
      prompts: [{ id: 'P1', text: 'H2O' }, { id: 'P2', text: 'NaCl' }],
      choices: [{ id: 'C1', text: 'Salt' }, { id: 'C2', text: 'Water' }],
    },
    answer_key: { pairs: { P1: 'C2', P2: 'C1' } },
  }).question };
  const qOrder = { id: 7, marks: 1, ...normalizeQuestion({
    question_text: 'Order?', question_type: 'ordering', category: 'Gen',
    question_config: { items: [{ id: 'I1', text: '1st' }, { id: 'I2', text: '2nd' }] },
    answer_key: { correct_order: ['I1', 'I2'] },
  }).question };

  // Active exam hydration strips answer_key, correct_option, and explanation
  for (const q of [qMcq, qMulti, qTf, qShort, qNum, qMatch, qOrder]) {
    const publicView = hydrateQuestionRow(q, { includeAnswerKey: false });
    assert.ok(!('correct_option' in publicView));
    assert.ok(!('answer_key' in publicView));
    assert.ok(!('explanation' in publicView));
    assert.equal(publicView.question_type, q.question_type);
    assert.equal(typeof publicView.question_config, 'object');
  }

  // Student answer validation rejects audio/video uploads and malformed payloads
  assert.ok(validateStudentAnswer(qShort, { answer_data: { audio_upload: 'data:audio/mp3;base64,AAA' } }).error);
  assert.equal(validateStudentAnswer(qMcq, { selected_option: 'E' }).error, 'Choose option A, B, C or D.');

  // Evaluate correct, wrong (with 0.25 negative mark), and unanswered across mixed exam
  const penalty = 0.25;
  const ans1 = validateStudentAnswer(qMcq, { selected_option: 'B' });
  assert.deepEqual(evaluateQuestionAnswer(qMcq, { selected_option: ans1.selected_option, answer_data: ans1.answerDataJson }, penalty), {
    answered: true, isCorrect: true, marksAwarded: 1,
  });

  const ans2 = validateStudentAnswer(qMulti, { answer_data: { selected_options: ['C', 'A'] } });
  assert.deepEqual(evaluateQuestionAnswer(qMulti, { selected_option: ans2.selected_option, answer_data: ans2.answerDataJson }, penalty), {
    answered: true, isCorrect: true, marksAwarded: 2,
  });

  const ans3Wrong = validateStudentAnswer(qTf, { answer_data: { selected_answer: true } });
  assert.deepEqual(evaluateQuestionAnswer(qTf, { selected_option: ans3Wrong.selected_option, answer_data: ans3Wrong.answerDataJson }, penalty), {
    answered: true, isCorrect: false, marksAwarded: -0.25,
  });

  const ans4 = validateStudentAnswer(qShort, { answer_data: { text: '  dhaka ' } });
  assert.deepEqual(evaluateQuestionAnswer(qShort, { selected_option: ans4.selected_option, answer_data: ans4.answerDataJson }, penalty), {
    answered: true, isCorrect: true, marksAwarded: 1.5,
  });

  const ans5 = validateStudentAnswer(qNum, { answer_data: { value: 9.83 } });
  assert.deepEqual(evaluateQuestionAnswer(qNum, { selected_option: ans5.selected_option, answer_data: ans5.answerDataJson }, penalty), {
    answered: true, isCorrect: true, marksAwarded: 2,
  });

  const ans6 = validateStudentAnswer(qMatch, { answer_data: { pairs: { P1: 'C2', P2: 'C1' } } });
  assert.deepEqual(evaluateQuestionAnswer(qMatch, { selected_option: ans6.selected_option, answer_data: ans6.answerDataJson }, penalty), {
    answered: true, isCorrect: true, marksAwarded: 1,
  });

  // Unanswered ordering question receives 0 penalty
  const ans7Empty = validateStudentAnswer(qOrder, { answer_data: null });
  assert.deepEqual(evaluateQuestionAnswer(qOrder, { selected_option: ans7Empty.selected_option, answer_data: ans7Empty.answerDataJson }, penalty), {
    answered: false, isCorrect: false, marksAwarded: 0,
  });
});

test('SQLite and D1 migrations upgrade populated legacy databases losslessly and preserve results and archived history', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcq-migration-test-'));
  try {
    // 1. Test Express/SQLite migrateSqliteDatabase on a pre-populated legacy SQLite database
    const sqlitePath = path.join(tmpDir, 'legacy-sqlite.db');
    const db = await openTestDatabase(sqlitePath);

    // Create original legacy schema (pre-expansion)
    db.exec(`
      CREATE TABLE questions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        archived INTEGER NOT NULL DEFAULT 0,
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
      CREATE TABLE exams (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        duration_minutes INTEGER NOT NULL CHECK (duration_minutes > 0),
        status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','closed')),
        show_score INTEGER NOT NULL DEFAULT 0 CHECK (show_score IN (0,1)),
        show_answers INTEGER NOT NULL DEFAULT 0 CHECK (show_answers IN (0,1)),
        allow_pdf_download INTEGER NOT NULL DEFAULT 0 CHECK (allow_pdf_download IN (0,1)),
        subject TEXT NOT NULL DEFAULT '',
        negative_mark REAL NOT NULL DEFAULT 0,
        short_url TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE exam_questions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        exam_id INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
        question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE RESTRICT,
        marks REAL NOT NULL DEFAULT 1,
        sort_order INTEGER NOT NULL DEFAULT 0,
        UNIQUE (exam_id, question_id)
      );
      CREATE TABLE attempts (
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
        status TEXT NOT NULL DEFAULT 'in_progress'
      );
      CREATE TABLE answers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        attempt_id INTEGER NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
        question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE RESTRICT,
        selected_option TEXT CHECK (selected_option IN ('A','B','C','D')),
        is_correct INTEGER CHECK (is_correct IN (0,1) OR is_correct IS NULL),
        marks_awarded REAL NOT NULL DEFAULT 0,
        UNIQUE (attempt_id, question_id)
      );
    `);

    // Populate with active and archived legacy MCQ questions, an exam, an attempt, and graded answers
    db.exec(`
      INSERT INTO questions (id, archived, question_text, option_a, option_b, option_c, option_d, correct_option, category, difficulty, explanation)
      VALUES
        (1, 1, 'Archived v1 question?', 'Old A', 'Old B', 'Old C', 'Old D', 'A', 'History', 'Easy', 'Archived explanation'),
        (2, 0, 'Active v2 question?', 'New A', 'New B', 'New C', 'New D', 'C', 'History', 'Medium', 'Active explanation');
      INSERT INTO exams (id, title, duration_minutes, status, show_score, show_answers, subject, negative_mark)
      VALUES (1, 'Legacy History Exam', 30, 'published', 1, 1, 'History', 0.25);
      INSERT INTO exam_questions (exam_id, question_id, marks, sort_order)
      VALUES (1, 1, 1, 0), (1, 2, 1, 1);
      INSERT INTO attempts (id, exam_id, access_token, student_name, roll_number, email, address, started_at, submitted_at, score, status)
      VALUES (1, 1, 'legacy-tok-1', 'Rahim Uddin', '101', 'rahim@example.com', 'Khulna', '2026-10-01T10:00:00Z', '2026-10-01T10:15:00Z', 0.75, 'submitted');
      INSERT INTO answers (id, attempt_id, question_id, selected_option, is_correct, marks_awarded)
      VALUES
        (1, 1, 1, 'A', 1, 1),
        (2, 1, 2, 'B', 0, -0.25);
    `);

    migrateSqliteDatabase(db);

    assert.deepEqual(db.pragma('foreign_key_check'), []);
    const migratedQuestions = db.prepare('SELECT * FROM questions ORDER BY id').all();
    assert.equal(migratedQuestions.length, 2);
    assert.equal(migratedQuestions[0].archived, 1);
    assert.equal(migratedQuestions[0].question_type, 'mcq_single');
    assert.deepEqual(JSON.parse(migratedQuestions[0].question_config), {
      options: [
        { id: 'A', text: 'Old A' },
        { id: 'B', text: 'Old B' },
        { id: 'C', text: 'Old C' },
        { id: 'D', text: 'Old D' },
      ],
    });
    assert.deepEqual(JSON.parse(migratedQuestions[0].answer_key), { correct_option: 'A' });

    const migratedAttempt = db.prepare('SELECT * FROM attempts WHERE id = 1').get();
    assert.equal(migratedAttempt.score, 0.75);
    assert.equal(migratedAttempt.status, 'submitted');

    const migratedAnswers = db.prepare('SELECT * FROM answers ORDER BY id').all();
    assert.equal(migratedAnswers.length, 2);
    assert.equal(migratedAnswers[0].selected_option, 'A');
    assert.equal(migratedAnswers[0].marks_awarded, 1);
    assert.deepEqual(JSON.parse(migratedAnswers[0].answer_data), { selected_option: 'A' });
    assert.equal(migratedAnswers[1].selected_option, 'B');
    assert.equal(migratedAnswers[1].marks_awarded, -0.25);
    assert.deepEqual(JSON.parse(migratedAnswers[1].answer_data), { selected_option: 'B' });

    // Verify new extensible non-MCQ question can be inserted and attached to the same exam
    const { question: newTf } = normalizeQuestion({
      question_text: 'Bangladesh gained independence in 1971.',
      question_type: 'true_false',
      category: 'History',
      answer_key: { correct_answer: true },
    });
    db.prepare(`INSERT INTO questions (question_text, question_type, option_a, option_b, option_c, option_d, correct_option, question_config, answer_key, media, category, difficulty, explanation)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      newTf.question_text, newTf.question_type, newTf.option_a, newTf.option_b, newTf.option_c, newTf.option_d,
      newTf.correct_option, newTf.question_config, newTf.answer_key, newTf.media, newTf.category, newTf.difficulty, newTf.explanation,
    );
    const insertedTf = db.prepare('SELECT * FROM questions WHERE id = 3').get();
    assert.equal(insertedTf.question_type, 'true_false');
    assert.equal(insertedTf.correct_option, '');
    db.close();

    // 2. Test D1 / Drizzle SQL migrations (0000..0004 -> populate -> 0005)
    const d1Path = path.join(tmpDir, 'd1-migration.db');
    const d1 = await openTestDatabase(d1Path);
    for (const file of ['0000_green_maggott.sql', '0001_supreme_inertia.sql', '0002_long_clea.sql', '0003_add_short_url.sql', '0004_add_allow_pdf_download.sql']) {
      d1.exec(fs.readFileSync(path.join(root, 'drizzle', file), 'utf8'));
    }
    d1.exec(`
      INSERT INTO questions (id, archived, question_text, option_a, option_b, option_c, option_d, correct_option, category, difficulty, explanation)
      VALUES (10, 0, 'D1 Legacy MCQ?', 'Opt A', 'Opt B', 'Opt C', 'Opt D', 'D', 'Science', 'Easy', 'Exp');
      INSERT INTO exams (id, title, duration_minutes, status, show_score, show_answers)
      VALUES (5, 'D1 Exam', 20, 'published', 1, 1);
      INSERT INTO exam_questions (exam_id, question_id, marks, sort_order)
      VALUES (5, 10, 1, 0);
      INSERT INTO attempts (id, exam_id, access_token, student_name, roll_number, started_at, score, status)
      VALUES (7, 5, 'd1-token', 'Karim', '22', '2026-10-02T00:00:00Z', 1, 'submitted');
      INSERT INTO answers (attempt_id, question_id, selected_option, is_correct, marks_awarded)
      VALUES (7, 10, 'D', 1, 1);
    `);

    // Apply 0005_extensible_question_types.sql
    d1.exec(fs.readFileSync(path.join(root, 'drizzle', '0005_extensible_question_types.sql'), 'utf8'));

    assert.deepEqual(d1.pragma('foreign_key_check'), []);
    const d1Question = d1.prepare('SELECT * FROM questions WHERE id = 10').get();
    assert.equal(d1Question.question_type, 'mcq_single');
    assert.deepEqual(JSON.parse(d1Question.answer_key), { correct_option: 'D' });

    const d1Answer = d1.prepare('SELECT * FROM answers WHERE attempt_id = 7 AND question_id = 10').get();
    assert.equal(d1Answer.selected_option, 'D');
    assert.equal(d1Answer.marks_awarded, 1);
    assert.deepEqual(JSON.parse(d1Answer.answer_data), { selected_option: 'D' });

    // Verify legacy SQL insert into D1 after 0005 triggers auto-population of question_config and answer_key
    d1.exec(`
      INSERT INTO questions (id, question_text, option_a, option_b, option_c, option_d, correct_option, category)
      VALUES (11, 'Triggered MCQ?', '1', '2', '3', '4', 'A', 'Math');
    `);
    const triggeredQ = d1.prepare('SELECT * FROM questions WHERE id = 11').get();
    assert.equal(triggeredQ.question_type, 'mcq_single');
    assert.deepEqual(JSON.parse(triggeredQ.answer_key), { correct_option: 'A' });
    assert.equal(JSON.parse(triggeredQ.question_config).options.length, 4);
    d1.close();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('fair deterministic partial credit algorithm for multi-select MCQs', () => {
  // 1 mark question with 2 correct answers (A, B) out of 4 options
  const qRow = {
    question_type: QUESTION_TYPES.MCQ_MULTI,
    marks: 1,
    question_config: JSON.stringify({
      options: [
        { id: 'A', text: 'Opt A' },
        { id: 'B', text: 'Opt B' },
        { id: 'C', text: 'Opt C' },
        { id: 'D', text: 'Opt D' },
      ],
    }),
    answer_key: JSON.stringify({ correct_options: ['A', 'B'] }),
  };

  // Full credit: selects A, B
  const full = evaluateQuestionAnswer(qRow, { answer_data: JSON.stringify({ selected_options: ['A', 'B'] }) }, 0.25);
  assert.equal(full.isCorrect, true);
  assert.equal(full.marksAwarded, 1);

  // Partial credit: selects A (1 right, 0 wrong -> (1 - 0) * 0.5 = 0.5)
  const half = evaluateQuestionAnswer(qRow, { answer_data: JSON.stringify({ selected_options: ['A'] }) }, 0.25);
  assert.equal(half.isCorrect, false);
  assert.equal(half.marksAwarded, 0.5);

  // 1 right, 1 wrong -> (1 - 1) * 0.5 = 0
  const zeroNet = evaluateQuestionAnswer(qRow, { answer_data: JSON.stringify({ selected_options: ['A', 'C'] }) }, 0.25);
  assert.equal(zeroNet.isCorrect, false);
  assert.equal(zeroNet.marksAwarded, 0);

  // Clamped at 0 (zero double penalties): 0 right, 2 wrong -> clamped to 0, not negative
  const clampedZero = evaluateQuestionAnswer(qRow, { answer_data: JSON.stringify({ selected_options: ['C', 'D'] }) }, 0.25);
  assert.equal(clampedZero.isCorrect, false);
  assert.equal(clampedZero.marksAwarded, 0);

  // 2 right, 1 wrong -> (2 - 1) * 0.5 = 0.5
  const withDistractor = evaluateQuestionAnswer(qRow, { answer_data: JSON.stringify({ selected_options: ['A', 'B', 'C'] }) }, 0.25);
  assert.equal(withDistractor.isCorrect, false);
  assert.equal(withDistractor.marksAwarded, 0.5);

  // Unanswered -> 0 marks
  const unans = evaluateQuestionAnswer(qRow, null, 0.25);
  assert.equal(unans.answered, false);
  assert.equal(unans.marksAwarded, 0);
});

test('fill-in-the-blank question evaluation with NFC normalization, trimming, and all-or-nothing scoring', () => {
  const qRow = {
    question_type: QUESTION_TYPES.FILL_BLANK,
    marks: 2,
    question_config: JSON.stringify({
      blanks: [
        { id: 'B1', label: 'Blank 1' },
        { id: 'B2', label: 'Blank 2' },
      ],
      case_sensitive: false,
    }),
    answer_key: JSON.stringify({
      blanks: {
        B1: ['H2O', 'water'],
        B2: ['CO2', 'carbon dioxide'],
      },
      case_sensitive: false,
    }),
  };

  // Both correct with trimming and case variation
  const correct = evaluateQuestionAnswer(qRow, {
    answer_data: JSON.stringify({
      blanks: { B1: '  h2o  ', B2: 'CARBON DIOXIDE ' },
    }),
  }, 0.5);
  assert.equal(correct.isCorrect, true);
  assert.equal(correct.marksAwarded, 2);

  // One right, one wrong -> all-or-nothing (penalty applied if configured)
  const partial = evaluateQuestionAnswer(qRow, {
    answer_data: JSON.stringify({
      blanks: { B1: 'H2O', B2: 'wrong' },
    }),
  }, 0.5);
  assert.equal(partial.isCorrect, false);
  assert.equal(partial.marksAwarded, -0.5);

  // Unicode NFC normalization test
  const nfcRow = {
    question_type: QUESTION_TYPES.FILL_BLANK,
    marks: 1,
    question_config: JSON.stringify({ blanks: [{ id: 'B1' }], case_sensitive: true }),
    answer_key: JSON.stringify({ blanks: { B1: ['café'] }, case_sensitive: true }),
  };
  // 'cafe\u0301' is decomposed NFD, should match composed 'café' NFC
  const nfcMatch = evaluateQuestionAnswer(nfcRow, {
    answer_data: JSON.stringify({ blanks: { B1: 'cafe\u0301' } }),
  }, 0);
  assert.equal(nfcMatch.isCorrect, true);
});

test('rich-text sanitization preserves allowed formatting and strips malicious tags', () => {
  const clean = sanitizeRichText('This is <b>bold</b>, <i>italic</i>, <u>underlined</u>, <del>strike</del>, and <code>code</code>.');
  assert.equal(clean, 'This is <b>bold</b>, <i>italic</i>, <u>underlined</u>, <del>strike</del>, and <code>code</code>.');

  const stripped = sanitizeRichText('<script>alert("xss")</script><iframe src="malicious.html"></iframe><p>Safe</p><video src="test.mp4"></video>');
  assert.ok(!stripped.includes('<script>'));
  assert.ok(!stripped.includes('alert'));
  assert.ok(!stripped.includes('iframe'));
  assert.ok(!stripped.includes('video'));
});

test('multi-type bulk text paste validates sequentially, supports media placeholders, and enforces atomic failure', () => {
  const validPaste = `1. What is single MCQ?\nA. Alpha\nB. Beta\nC. Gamma\nD. Delta\nAnswer: A\nExplanation: Alpha is correct.\n\n2. Which are prime?\nType: mcq_multi\nA. 2\nB. 3\nC. 4\nAnswer: A, B\n\n3. The Earth is flat.\nType: true_false\nAnswer: False\n\n4. Symbol for water is [blank].\nType: fill_blank\nAnswer: H2O\nMedia: [image: placeholder]\n\n5. Arrange steps.\nType: ordering\n1. First\n2. Second\nAnswer: 1, 2`;

  const { questions, errors } = parseQuestionPaste(validPaste, 'General');
  assert.deepEqual(errors, []);
  assert.equal(questions.length, 5);
  assert.equal(questions[0].question_type, 'mcq_single');
  assert.equal(questions[1].question_type, 'mcq_multi');
  assert.equal(questions[2].question_type, 'true_false');
  assert.equal(questions[3].question_type, 'fill_blank');
  const parsedMedia = JSON.parse(questions[3].media);
  assert.equal(parsedMedia.type, 'image');
  assert.equal(parsedMedia.placeholder, true);
  assert.equal(questions[4].question_type, 'ordering');

  // Non-sequential numbering fails
  const nonSeq = `1. First question?\nA. 1\nB. 2\nC. 3\nD. 4\nAnswer: A\n\n3. Jumped question?\nA. 1\nB. 2\nC. 3\nD. 4\nAnswer: B`;
  const nonSeqRes = parseQuestionPaste(nonSeq, 'General');
  assert.ok(nonSeqRes.errors.length > 0);
  assert.ok(nonSeqRes.errors.some((e) => e.includes('sequential')));
});

test('fill-in-the-blank placeholders render like long underlined space ________', () => {
  const rendered = renderQuestionText('The chemical symbol for water is [blank].');
  assert.equal(rendered, 'The chemical symbol for water is <span class="blank-underline">________</span>.');

  const multiBlanks = renderQuestionText('Photosynthesis produces [blank1] and [blank2].');
  assert.equal(multiBlanks, 'Photosynthesis produces <span class="blank-underline">________</span> and <span class="blank-underline">________</span>.');

  const formatted = renderQuestionText('The symbol for water is <b>[blank]</b>.');
  assert.equal(formatted, 'The symbol for water is <b><span class="blank-underline">________</span></b>.');

  const clean = cleanQuestionBlanks('The chemical symbol for water is [blank].');
  assert.equal(clean, 'The chemical symbol for water is ________.');
});

test('BULK_PASTE_SAMPLE includes one example for every supported question type and parses cleanly', () => {
  const { questions, errors } = parseQuestionPaste(BULK_PASTE_SAMPLE, 'General Knowledge');
  assert.deepEqual(errors, []);
  assert.equal(questions.length, SUPPORTED_QUESTION_TYPES.length);

  const presentTypes = new Set(questions.map((q) => q.question_type));
  for (const expectedType of SUPPORTED_QUESTION_TYPES) {
    assert.ok(
      presentTypes.has(expectedType),
      `Expected BULK_PASTE_SAMPLE to include an example for question type "${expectedType}"`
    );
  }

  // Verify each question type's parsed specifics
  assert.equal(questions[0].question_type, QUESTION_TYPES.MCQ_SINGLE);
  assert.equal(questions[0].correct_option, 'B');

  assert.equal(questions[1].question_type, QUESTION_TYPES.MCQ_MULTI);
  const q1Config = JSON.parse(questions[1].question_config);
  const q1Key = JSON.parse(questions[1].answer_key);
  assert.equal(q1Config.options.length, 4);
  assert.deepEqual(q1Key.correct_options, ['A', 'B']);

  assert.equal(questions[2].question_type, QUESTION_TYPES.TRUE_FALSE);
  const q2Key = JSON.parse(questions[2].answer_key);
  assert.equal(q2Key.correct_answer, true);

  assert.equal(questions[3].question_type, QUESTION_TYPES.FILL_BLANK);
  const q3Key = JSON.parse(questions[3].answer_key);
  assert.deepEqual(q3Key.blanks.B1, ['H2O']);

  assert.equal(questions[4].question_type, QUESTION_TYPES.SHORT_ANSWER);
  const q4Key = JSON.parse(questions[4].answer_key);
  assert.deepEqual(q4Key.accepted_answers, ['Mitochondria']);

  assert.equal(questions[5].question_type, QUESTION_TYPES.NUMERIC);
  const q5Key = JSON.parse(questions[5].answer_key);
  assert.equal(q5Key.value, 9.8);
  assert.equal(q5Key.tolerance, 0.1);

  assert.equal(questions[6].question_type, QUESTION_TYPES.ORDERING);
  const q6Key = JSON.parse(questions[6].answer_key);
  assert.deepEqual(q6Key.correct_order, ['I1', 'I2', 'I3', 'I4']);

  assert.equal(questions[7].question_type, QUESTION_TYPES.MATCHING);
  const q7Key = JSON.parse(questions[7].answer_key);
  assert.deepEqual(q7Key.pairs, { P1: 'C1', P2: 'C2', P3: 'C3' });
});


