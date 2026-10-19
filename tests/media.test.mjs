import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import Database from 'better-sqlite3';
import worker from '../dist/server/index.js';
import { inspectMediaBytes, MAX_IMAGE_BYTES, MAX_AUDIO_BYTES, MAX_UPLOAD_BODY_BYTES, mediaPublishProblem, readMediaForm, parseMediaRange } from '../server/media-storage.js';
import { localMediaStore } from '../server/local-media-storage.js';

import { mediaFixtures } from './media-fixtures.mjs';

const root = path.resolve(import.meta.dirname, '..');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1kAAAAASUVORK5CYII=', 'base64');
function wav() {
  const b = Buffer.alloc(48); b.write('RIFF'); b.writeUInt32LE(40, 4); b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(8000, 24);
  b.writeUInt32LE(16000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(4, 40); return b;
}
const WAV = wav();
const baseQuestion = (text, media = null) => ({ question_text: text, option_a: 'One', option_b: 'Two', option_c: 'Three', option_d: 'Four', correct_option: 'A', category: 'Media QA', media });
const examBody = (id, status = 'published') => ({ title: 'Media exam', duration_minutes: 30, negative_mark: 0, status, show_score: true, show_answers: true, question_ids: [id] });

function makeD1(db, hooks = {}) {
  const wrap = (statement, values = [], sql = '') => ({ statement, values,
    bind(...bound) { return wrap(statement, bound, sql); },
    async first() { const value = statement.get(...values) ?? null; await hooks.afterFirst?.(sql, value); return value; },
    async all() { return { results: statement.all(...values) }; },
    async run() { await hooks.beforeRun?.(sql, values); const r = statement.run(...values); return { meta: { changes: r.changes, last_row_id: Number(r.lastInsertRowid) } }; },
  });
  return { prepare(sql) { return wrap(db.prepare(sql), [], sql); }, async batch(statements) { return db.transaction(() => statements.map(({ statement, values }) => {
    if (statement.reader) return { results: statement.all(...values) };
    const r = statement.run(...values); return { meta: { changes: r.changes, last_row_id: Number(r.lastInsertRowid) } };
  }))(); } };
}
function makeBucket() {
  const objects = new Map();
  return { objects,
    async put(key, input, options) {
      assert.deepEqual(options.onlyIf, { etagDoesNotMatch: '*' });
      if (objects.has(key)) return null;
      const bytes = new Uint8Array(input);
      const object = { bytes, size: bytes.length, httpMetadata: options.httpMetadata, customMetadata: options.customMetadata, httpEtag: '"test-etag"' };
      objects.set(key, object); return object;
    },
    async head(key) { return objects.get(key) || null; },
    async get(key, options = {}) {
      const object = objects.get(key); if (!object) return null;
      const range = options.range; const bytes = range ? object.bytes.subarray(range.offset, range.offset + range.length) : object.bytes;
      return { ...object, body: bytes };
    },
  };
}
async function fixture(kind, hooks = {}) {
  if (kind === 'Worker') {
    const db = new Database(':memory:'); db.pragma('foreign_keys = ON');
    for (const name of fs.readdirSync(path.join(root, 'drizzle')).filter((n) => /^\d{4}_.*\.sql$/.test(n)).sort()) {
      for (const sql of fs.readFileSync(path.join(root, 'drizzle', name), 'utf8').split('--> statement-breakpoint').map((s) => s.trim()).filter(Boolean)) db.exec(sql);
    }
    db.prepare("INSERT INTO site_meta (key,value) VALUES ('initial_seed','1')").run();
    const bucket = makeBucket();
    const env = { DB: makeD1(db, hooks), MEDIA_BUCKET: bucket, ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'mediaPass123!', SESSION_SECRET: 'media-tests-secret-not-production' };
    return { db, bucket, env, send: (route, options) => worker.fetch(new Request(`https://example.test${route}`, options), env, {}), close: async () => db.close() };
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mcq-media-'));
  const socket = net.createServer(); await new Promise((r) => socket.listen(0, '127.0.0.1', r));
  const port = socket.address().port; await new Promise((r) => socket.close(r));
  const dbPath = path.join(directory, 'exam.db'); const uploads = path.join(directory, 'uploads');
  const child = spawn(process.execPath, ['server/app.js'], { cwd: root,
    env: { ...process.env, PORT: String(port), DB_PATH: dbPath, UPLOADS_DIR: uploads, ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'mediaPass123!', SESSION_SECRET: 'media-tests-secret-not-production', COOKIE_SECURE: 'false' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = ''; child.stdout.on('data', (c) => { output += c; }); child.stderr.on('data', (c) => { output += c; });
  const send = (route, options) => fetch(`http://127.0.0.1:${port}${route}`, options);
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { if ((await send('/api/health')).ok) { ready = true; break; } } catch {}
    if (child.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  if (!ready) { child.kill(); throw new Error(output); }
  const db = new Database(dbPath);
  return { db, uploads, send, close: async () => { db.close(); if (child.exitCode === null) { const exit = new Promise((r) => child.once('exit', r)); child.kill(); await exit; } fs.rmSync(directory, { recursive: true, force: true }); } };
}
async function client(f) {
  const response = await f.send('/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'mediaPass123!' }) });
  assert.equal(response.status, 200, await response.clone().text());
  const cookie = response.headers.get('set-cookie').split(';')[0];
  const call = (route, method = 'GET', body, headers = {}) => f.send(route, { method,
    headers: { Cookie: cookie, ...(body !== undefined && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify(body),
  });
  const json = async (route, method, body, status = 200) => { const r = await call(route, method, body); const data = await r.json(); assert.equal(r.status, status, JSON.stringify(data)); return data; };
  const upload = (bytes, mime, filename = 'file') => { const form = new FormData(); form.set('file', new Blob([bytes], { type: mime }), filename); return call('/api/admin/media/upload', 'POST', form); };
  return { call, json, upload };
}

test('media signatures reject spoofed, active, video and oversized payloads', () => {
  for (const [name, bytes] of Object.entries(mediaFixtures)) {
    if (name.startsWith('video')) { assert.throws(() => inspectMediaBytes(bytes, 'audio/ogg'), /not supported/); continue; }
    const expected = name.endsWith('.jpeg') ? 'jpg' : name.split('.').at(-1);
    assert.equal(inspectMediaBytes(bytes).extension, expected);
  }
  assert.equal(inspectMediaBytes(PNG, 'image/png').extension, 'png');
  assert.equal(inspectMediaBytes(WAV, 'audio/x-wav').extension, 'wav');
  assert.throws(() => inspectMediaBytes(PNG, 'audio/mpeg'), /does not match/);
  for (const bytes of [Buffer.alloc(0), Buffer.from('<svg onload="alert(1)"/>'), Buffer.from('<html>test</html>'), Buffer.from('%PDF-1.4'), Buffer.from('ID3junk'), Buffer.from('0000ftypmp42')]) assert.throws(() => inspectMediaBytes(bytes, 'image/png'));
  const huge = Buffer.alloc(MAX_IMAGE_BYTES + 1); PNG.copy(huge); PNG.subarray(-12).copy(huge, huge.length - 12);
  assert.throws(() => inspectMediaBytes(huge, 'image/png'), /5MB/);
  assert.throws(() => inspectMediaBytes(Buffer.alloc(MAX_AUDIO_BYTES + 1), 'audio/wav'), /10MB/);
  assert.deepEqual(parseMediaRange('bytes=-4', 10), { offset: 6, length: 4 });
  assert.throws(() => parseMediaRange('bytes=0-1,3-4', 10), /not satisfiable/);
  assert.throws(() => parseMediaRange('bytes=99-', 10), /not satisfiable/);
  assert.throws(() => parseMediaRange('bytes=-9999999999999999999999999', 10), /not satisfiable/);
});

test('local storage rejects traversal and symlinks and creates immutable non-executable files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcq-media-store-'));
  try {
    const store = localMediaStore(dir); const a = store.put(PNG, inspectMediaBytes(PNG)); const b = store.put(PNG, inspectMediaBytes(PNG));
    assert.notEqual(a.filename, b.filename); assert.equal(fs.statSync(path.join(dir, a.filename)).mode & 0o777, 0o600);
    assert.equal(store.get('../outside'), null);
    const linked = `${'a'.repeat(32)}.png`; fs.symlinkSync(path.join(dir, a.filename), path.join(dir, linked)); assert.equal(store.get(linked), null);
    assert.deepEqual(store.get(a.filename).bytes, PNG);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('multipart stream has a hard limit even without Content-Length', async () => {
  let cancelled = false;
  const request = new Request('https://example.test', { method: 'POST', duplex: 'half', headers: { 'Content-Type': 'multipart/form-data; boundary=x' },
    body: new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(MAX_UPLOAD_BODY_BYTES + 1)); }, cancel() { cancelled = true; } }),
  });
  await assert.rejects(readMediaForm(request), /too large/); assert.equal(cancelled, true);
});

test('publish guard rejects all placeholder aliases, malformed metadata and pending stimulus media', () => {
  for (const media of ['broken', '[]', '{}', JSON.stringify({ type: 'image', url: 'pending' }), JSON.stringify({ type: 'audio', url: '/x', pending: true }), JSON.stringify({ type: 'image', url: '//evil.test/file' })]) assert.ok(mediaPublishProblem({ id: 1, media, question_config: '{}' }));
  assert.ok(mediaPublishProblem({ id: 1, question_config: JSON.stringify({ stimulus: { media: { type: 'image', placeholder: true } } }) }));
  assert.equal(mediaPublishProblem({ id: 1, media: null, question_config: '{}' }), null);
  assert.equal(mediaPublishProblem({ id: 1, media: { type: 'image', url: `data:image/png;base64,${PNG.toString('base64')}` } }), null);
});

for (const kind of ['Express', 'Worker']) {
  test(`${kind}: upload/download security, playback ranges and storage adapter`, { timeout: 60000 }, async () => {
    const f = await fixture(kind);
    try {
      const c = await client(f);
      const unauthorized = await f.send('/api/admin/media/upload', { method: 'POST' }); assert.equal(unauthorized.status, 401);
      for (const [bytes, mime] of [[mediaFixtures['video.ogg'], 'audio/ogg'], [Buffer.from('<svg onload="alert(1)"/>'), 'image/svg+xml'], [Buffer.from('<html>unsafe</html>'), 'image/png'], [PNG, 'audio/mpeg'], [Buffer.alloc(0), 'audio/wav']]) assert.equal((await c.upload(bytes, mime)).status, 400);
      const uploadedResponse = await c.upload(PNG, 'image/png', '../../evil.html'); assert.equal(uploadedResponse.status, 200);
      const image = await uploadedResponse.json(); assert.match(image.url, /^\/api\/media\/[a-f0-9]{32}\.png$/); assert.equal(image.mime, 'image/png'); assert.equal(image.type, 'image');
      assert.ok(!image.url.startsWith('data:')); assert.ok(!image.filename.includes('evil'));
      const fetched = await f.send(image.url); assert.equal(fetched.status, 200); assert.equal(fetched.headers.get('content-type'), 'image/png'); assert.equal(fetched.headers.get('x-content-type-options'), 'nosniff'); assert.ok(fetched.headers.get('content-security-policy').includes('sandbox')); assert.deepEqual(Buffer.from(await fetched.arrayBuffer()), PNG);
      const audio = await (await c.upload(WAV, 'audio/wav', 'voice.wav')).json(); assert.equal(audio.type, 'audio');
      const ranged = await f.send(audio.url, { headers: { Range: 'bytes=4-11' } }); assert.equal(ranged.status, 206); assert.equal(ranged.headers.get('content-range'), `bytes 4-11/${WAV.length}`); assert.deepEqual(Buffer.from(await ranged.arrayBuffer()), WAV.subarray(4, 12));
      const head = await f.send(audio.url, { method: 'HEAD' }); assert.equal(head.status, 200); assert.equal(head.headers.get('content-length'), String(WAV.length)); assert.equal((await head.arrayBuffer()).byteLength, 0);
      assert.equal((await f.send(audio.url, { headers: { Range: 'bytes=999999-' } })).status, 416);
      assert.equal((await f.send('/api/media/not-a-file.png')).status, 404);
      assert.equal((await f.send('/api/media/')).status, 404);
      const huge = Buffer.alloc(MAX_IMAGE_BYTES + 1); PNG.copy(huge); PNG.subarray(-12).copy(huge, huge.length - 12);
      assert.equal((await c.upload(huge, 'image/png')).status, 413);
      assert.equal((await c.upload(Buffer.alloc(MAX_AUDIO_BYTES + 1), 'audio/wav')).status, 413);
      if (kind === 'Worker') {
        assert.equal(f.bucket.objects.size, 2);
        assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM questions WHERE media LIKE '%base64%'").get().n, 0);
        delete f.env.MEDIA_BUCKET; assert.equal((await c.upload(PNG, 'image/png')).status, 503);
        assert.equal((await f.send(image.url)).status, 503);
      } else {
        const old = '1792195200000-abcdef123456.png'; fs.writeFileSync(path.join(f.uploads, old), PNG);
        assert.equal((await f.send(`/uploads/${old}`)).status, 200);
        const evil = '1792195200000-abcdef123456.svg'; fs.writeFileSync(path.join(f.uploads, evil), '<svg/>');
        assert.equal((await f.send(`/uploads/${evil}`)).status, 404);
        assert.equal((await f.send('/uploads/')).status, 404);
      }
    } finally { await f.close(); }
  });

  test(`${kind}: media replace/remove preserves saved exams and answers and backup lists historic assets`, { timeout: 60000 }, async () => {
    const f = await fixture(kind);
    try {
      const c = await client(f);
      const image = await (await c.upload(PNG, 'image/png')).json();
      const audio = await (await c.upload(WAV, 'audio/wav')).json();
      const original = await c.json('/api/admin/questions', 'POST', baseQuestion('Original visual prompt', { type: 'image', url: image.url, alt: 'A single pixel' }), 201);
      const exam = await c.json('/api/admin/exams', 'POST', examBody(original.id), 201);
      const attempt = await c.json(`/api/exams/${exam.id}/attempts`, 'POST', { student_name: 'Media Student', roll_number: '42', email: 'student@example.test', address: 'Test address' }, 201);
      await c.json(`/api/attempts/${attempt.token}/answers`, 'PUT', { question_id: original.id, selected_option: 'A' });
      const replacement = await c.json(`/api/admin/questions/${original.id}/media`, 'POST', { media: { type: 'audio', url: audio.url, caption: 'New prompt' } });
      assert.notEqual(replacement.id, original.id); assert.equal(replacement.media.url, audio.url);
      assert.equal(f.db.prepare('SELECT question_id FROM exam_questions WHERE exam_id=?').get(exam.id).question_id, original.id);
      assert.equal(f.db.prepare('SELECT archived FROM questions WHERE id=?').get(original.id).archived, 1);
      const active = await c.json(`/api/attempts/${attempt.token}`); assert.equal(active.questions[0].media.url, image.url); assert.equal('answer_key' in active.questions[0], false); assert.equal('correct_option' in active.questions[0], false);
      const secondExam = await c.json('/api/admin/exams', 'POST', examBody(replacement.id, 'draft'), 201);
      const cleared = await c.json(`/api/admin/questions/${replacement.id}/media`, 'POST', { media: null }); assert.notEqual(cleared.id, replacement.id); assert.equal(cleared.media, null);
      assert.equal(f.db.prepare('SELECT question_id FROM exam_questions WHERE exam_id=?').get(secondExam.id).question_id, replacement.id);
      assert.equal(JSON.parse(f.db.prepare('SELECT media FROM questions WHERE id=?').get(replacement.id).media).url, audio.url);
      const results = await c.json(`/api/attempts/${attempt.token}/submit`, 'POST'); assert.equal(results.result.score, 1); assert.equal(results.result.answers[0].media.url, image.url);
      assert.equal((await f.send(image.url)).status, 200); assert.equal((await f.send(audio.url)).status, 200);
      const backup = await c.json('/api/admin/backup'); assert.equal(backup.media.files_included, false); assert.ok(backup.media.referenced_urls.includes(image.url)); assert.ok(backup.media.referenced_urls.includes(audio.url));
      assert.equal(backup.tables.questions.find((q) => q.id === original.id).archived, 1);
      await c.json(`/api/admin/questions/${cleared.id}/media`, 'POST', { media: null });
    } finally { await f.close(); }
  });

  test(`${kind}: publish blocks unresolved/missing/malformed attachments and retains legacy inline assets`, { timeout: 60000 }, async () => {
    const f = await fixture(kind);
    try {
      const c = await client(f);
      const pending = await c.json('/api/admin/questions', 'POST', baseQuestion('Pending prompt', { type: 'image', placeholder: true }), 201);
      assert.equal((await c.call('/api/admin/exams', 'POST', examBody(pending.id))).status, 400);
      const draft = await c.json('/api/admin/exams', 'POST', examBody(pending.id, 'draft'), 201);
      assert.equal((await c.call(`/api/admin/exams/${draft.id}/status`, 'PATCH', { status: 'published' })).status, 400);
      const upload = await (await c.upload(PNG, 'image/png')).json();
      const resolved = await c.json(`/api/admin/questions/${pending.id}/media`, 'POST', { media: { type: 'image', url: upload.url } });
      assert.notEqual(resolved.id, pending.id);
      assert.equal((await c.call(`/api/admin/exams/${draft.id}/status`, 'PATCH', { status: 'published' })).status, 400, 'A saved draft remains an immutable snapshot; choose the replacement in a new exam.');
      await c.json('/api/admin/exams', 'POST', examBody(resolved.id), 201);
      const free = await c.json('/api/admin/questions', 'POST', baseQuestion('No attachment'), 201); await c.json('/api/admin/exams', 'POST', examBody(free.id), 201);
      const missing = await c.json('/api/admin/questions', 'POST', baseQuestion('Missing file', { type: 'image', url: `/api/media/${'a'.repeat(32)}.png` }), 201);
      assert.equal((await c.call('/api/admin/exams', 'POST', examBody(missing.id))).status, 400);
      const wrongType = await c.json('/api/admin/questions', 'POST', baseQuestion('Incorrect attachment type', { type: 'audio', url: upload.url }), 201);
      assert.equal((await c.call('/api/admin/exams', 'POST', examBody(wrongType.id))).status, 400);
      const broken = await c.json('/api/admin/questions', 'POST', baseQuestion('Malformed media'), 201); f.db.prepare('UPDATE questions SET media=? WHERE id=?').run('{broken', broken.id);
      assert.equal((await c.call('/api/admin/exams', 'POST', examBody(broken.id))).status, 400);
      const stimulus = await c.json('/api/admin/questions', 'POST', { ...baseQuestion('Pending shared stimulus'), stimulus: { title: 'Shared figure', media: { type: 'image', placeholder: true } } }, 201);
      assert.equal((await c.call('/api/admin/exams', 'POST', examBody(stimulus.id))).status, 400);
      const legacy = await c.json('/api/admin/questions', 'POST', baseQuestion('Legacy inline image'), 201);
      const inline = `data:image/png;base64,${PNG.toString('base64')}`;
      f.db.prepare('UPDATE questions SET media=? WHERE id=?').run(JSON.stringify({ type: 'image', url: inline }), legacy.id);
      const legacyExam = await c.json('/api/admin/exams', 'POST', examBody(legacy.id), 201);
      const attempt = await c.json(`/api/exams/${legacyExam.id}/attempts`, 'POST', { student_name: 'Legacy Student', roll_number: '43', email: 'student@example.test', address: 'Test address' }, 201);
      assert.equal((await c.json(`/api/attempts/${attempt.token}`)).questions[0].media.url, inline);
      const backup = await c.json('/api/admin/backup'); assert.equal(backup.media.legacy_inline_count, 1);
    } finally { await f.close(); }
  });
}


for (const kind of ['Express', 'Worker']) {
  test(`${kind}: slow streamed answer bodies cannot save after the deadline`, { timeout: 30000 }, async () => {
    let firstReadInTime = false;
    let watchAttempt = false;
    const f = await fixture(kind, { afterFirst(sql, row) {
      if (watchAttempt && /SELECT a\.\*,e\.title/.test(sql) && row?.status === 'in_progress') {
        firstReadInTime ||= new Date(row.started_at).getTime() + 60000 > Date.now();
      }
    } });
    try {
      const c = await client(f);
      const question = await c.json('/api/admin/questions', 'POST', baseQuestion('Deadline question'), 201);
      const exam = await c.json('/api/admin/exams', 'POST', { ...examBody(question.id), duration_minutes: 1 }, 201);
      const attempt = await c.json(`/api/exams/${exam.id}/attempts`, 'POST', { student_name: 'Timer Student', roll_number: '99', email: 'timer@example.test', address: 'Test address' }, 201);
      await c.json(`/api/attempts/${attempt.token}/answers`, 'PUT', { question_id: question.id, selected_option: 'B' });
      const nearDeadline = new Date(Date.now() - 59200).toISOString();
      f.db.prepare('UPDATE attempts SET started_at=? WHERE id=?').run(kind === 'Express' ? nearDeadline.replace('T', ' ').replace('Z', '') : nearDeadline, attempt.attempt_id);
      watchAttempt = true;
      const response = await f.send(`/api/attempts/${attempt.token}/answers`, {
        method: 'PUT', duplex: 'half', headers: { 'Content-Type': 'application/json' },
        body: new ReadableStream({ start(controller) {
          setTimeout(() => { controller.enqueue(new TextEncoder().encode(JSON.stringify({ question_id: question.id, selected_option: 'A' }))); controller.close(); }, 1200);
        } }),
      });
      assert.equal(response.status, 409, await response.text());
      if (kind === 'Worker') assert.equal(firstReadInTime, true, 'Worker must have read the attempt before the delayed body crossed its deadline.');
      const stored = f.db.prepare('SELECT selected_option FROM answers WHERE attempt_id=?').get(attempt.attempt_id);
      assert.equal(stored.selected_option, 'B');
      const result = await c.json(`/api/attempts/${attempt.token}`);
      assert.equal(result.status, 'auto_submitted'); assert.equal(result.result.score, 0);
      assert.equal(result.result.answers[0].selected_option, 'B');
    } finally { await f.close(); }
  });
}

test('Worker: SQL deadline guard rejects an answer when time expires after validation', { timeout: 30000 }, async () => {
  let expireOnSave = false;
  let f;
  f = await fixture('Worker', { beforeRun(sql) {
    if (expireOnSave && /INSERT INTO answers/.test(sql)) {
      expireOnSave = false;
      f.db.prepare("UPDATE attempts SET started_at=? WHERE status='in_progress'").run(new Date(Date.now() - 61000).toISOString());
    }
  } });
  try {
    const c = await client(f);
    const question = await c.json('/api/admin/questions', 'POST', baseQuestion('Atomic deadline question'), 201);
    const exam = await c.json('/api/admin/exams', 'POST', { ...examBody(question.id), duration_minutes: 1 }, 201);
    const attempt = await c.json(`/api/exams/${exam.id}/attempts`, 'POST', { student_name: 'Atomic Student', roll_number: '100', email: 'timer@example.test', address: 'Test address' }, 201);
    await c.json(`/api/attempts/${attempt.token}/answers`, 'PUT', { question_id: question.id, selected_option: 'B' });
    expireOnSave = true;
    const late = await c.call(`/api/attempts/${attempt.token}/answers`, 'PUT', { question_id: question.id, selected_option: 'A' });
    assert.equal(late.status, 409, await late.text());
    assert.equal(expireOnSave, false, 'The test must reach the final SQL write after body validation.');
    const attemptRow = f.db.prepare('SELECT status,score FROM attempts WHERE id=?').get(attempt.attempt_id);
    assert.deepEqual(attemptRow, { status: 'auto_submitted', score: 0 });
    assert.equal(f.db.prepare('SELECT selected_option FROM answers WHERE attempt_id=?').get(attempt.attempt_id).selected_option, 'B');
  } finally { await f.close(); }
});
