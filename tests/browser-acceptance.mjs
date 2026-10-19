/**
 * Optional real-browser acceptance, run after `npm run build`:
 *   node tests/browser-acceptance.mjs
 * Requires Playwright plus Chromium (PLAYWRIGHT_CHROMIUM_EXECUTABLE may override).
 * Uses only localhost, an isolated temporary SQLite DB, synthetic participants/media,
 * and headless desktop/mobile Chromium. No deployment or external account mutations.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright');
const root = path.resolve(import.meta.dirname, '..');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mcq-browser-'));
const artifacts = process.env.BROWSER_ARTIFACTS || path.join(directory, 'artifacts');
fs.mkdirSync(artifacts, { recursive: true });
const stages = [];
let browser, child;
let output = '';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=', 'base64');
const wav = Buffer.alloc(44 + 16000);
wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(16000, 40);
const imageFile = path.join(directory, 'diagram.png'); fs.writeFileSync(imageFile, png);
const audioFile = path.join(directory, 'reference.wav'); fs.writeFileSync(audioFile, wav);
const finishStage = (name) => { stages.push(name); console.log(`PASS ${name}`); };
async function shot(page, name) { await page.screenshot({ path: path.join(artifacts, `${name}.png`), fullPage: true }); }
async function responseJson(response, status = 200) { assert.equal(response.status(), status, await response.text()); return response.json(); }
async function waitSaved(page) { await page.waitForFunction(() => { const app = document.querySelector('mcq-app'); return app && !app.pendingAnswerSaves && !app.answerSaveError; }); }
async function questionNav(page, index) { await page.locator('.question-nav-item').nth(index).click(); await page.waitForFunction((index) => { const app = document.querySelector('mcq-app'); return app.currentQuestion === index && !app.questionMoving; }, index); }
async function begin(page, base, exam, name) {
  await page.goto(`${base}/exam/${exam.id}`);
  await page.locator('[name=student_name]').fill(name);
  await page.locator('[name=email]').fill('browser-qa@example.test');
  await page.locator('[name=address]').fill('Synthetic browser acceptance address');
  await page.locator('[name=roll_number]').fill(name);
  await page.getByRole('button', { name: /Begin examination/ }).click();
  await page.locator('.exam-player').waitFor();
}
async function newQuestion(page, type, text) {
  await page.getByRole('button', { name: 'Add question', exact: false }).click();
  await page.locator('[name=question_type]').selectOption(type);
  const confirm = page.locator('[data-action=confirm-discard]');
  if (await confirm.count()) await confirm.click();
  await page.locator('[name=category]').fill('Browser acceptance');
  await page.locator('[name=question_text]').fill(text);
}
async function saveQuestion(page) {
  const response = page.waitForResponse((r) => r.url().endsWith('/api/admin/questions') && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Add to question bank', exact: true }).click();
  const result = await responseJson(await response, 201);
  await page.locator('.question-editor').waitFor({ state: 'detached' });
  return result;
}
async function upload(page, section, file) {
  const response = page.waitForResponse((r) => r.url().endsWith('/api/admin/media/upload'));
  await page.locator(`[data-section=${section}] input[type=file]`).setInputFiles(file);
  const uploaded = await responseJson(await response);
  await page.waitForFunction(() => !document.querySelector('mcq-app').busy);
  return uploaded;
}
try {
  const socket = net.createServer(); await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve)); const port = socket.address().port; await new Promise((resolve) => socket.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['server/app.js'], { cwd: root, env: { ...process.env, PORT: String(port), DB_PATH: path.join(directory, 'qa.db'), ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'browserPass123!', SESSION_SECRET: 'browser-acceptance-isolated-session-secret', COOKIE_SECURE: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (chunk) => { output += chunk; }); child.stderr.on('data', (chunk) => { output += chunk; });
  let ready = false;
  for (let i = 0; i < 100; i++) { if (child.exitCode !== null) throw new Error(output); try { if ((await fetch(`${base}/api/health`)).ok) { ready = true; break; } } catch {} await new Promise((resolve) => setTimeout(resolve, 100)); }
  assert.ok(ready, `Server never started: ${output}`);
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/usr/bin/chromium', headless: true, chromiumSandbox: true });
  console.log(`Browser: headless cloud Chromium ${browser.version()}; isolated localhost ${base}`);
  const desktop = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  const admin = await desktop.newPage();
  const pageErrors = [];
  desktop.on('page', (page) => page.on('pageerror', (error) => pageErrors.push(error.message)));
  admin.on('pageerror', (error) => pageErrors.push(error.message));
  await admin.goto(base);
  await admin.getByRole('button', { name: /Admin sign in/ }).click();
  await admin.locator('[name=username]').fill('admin'); await admin.locator('[name=password]').fill('browserPass123!');
  await admin.getByRole('button', { name: /Sign in securely/ }).click();
  await admin.getByRole('heading', { name: 'Good day, administrator' }).waitFor();
  finishStage('Real admin sign-in');

  await newQuestion(admin, 'fill_blank', '<b>Complete</b>: <u>city</u> [blank1] and <i>river</i> [blank2].');
  await admin.locator('[name=marks]').fill('2.5');
  await admin.locator('[name=blank_label_0]').fill('City'); await admin.locator('[name=blank_0_variant_0]').fill('Dhaka');
  await admin.getByRole('button', { name: 'Add blank', exact: false }).click();
  await admin.locator('[name=blank_label_1]').fill('River'); await admin.locator('[name=blank_1_variant_0]').fill('Buriganga');
  await admin.locator('[name=stimulus_title]').fill('Reusable image passage');
  await admin.locator('[name=stimulus_text]').fill('The <b>city</b> is Dhaka, beside the <u>Buriganga</u>.');
  const imageUpload = await upload(admin, 'stimulus', imageFile);
  await admin.locator('[name=stimulus_media_alt]').fill('Synthetic reference diagram');
  await admin.locator('[name=stimulus_media_caption]').fill('Image stimulus caption');
  await admin.locator('[name=explanation]').fill('<b>Dhaka</b> is on the <u>Buriganga</u>.');
  await admin.locator('.question-editor').getByRole('button', { name: /Preview question/ }).click();
  assert.equal(await admin.locator('.question-preview-card .preview-question-title b').textContent(), 'Complete');
  assert.equal(await admin.locator('.question-preview-card .preview-question-title u').textContent(), 'city');
  await admin.locator('[data-section=stimulus] img').evaluate((img) => img.scrollIntoView());
  await admin.waitForFunction(() => { const image = document.querySelector('[data-section=stimulus] img'); return image?.complete && image.naturalWidth > 0; });
  await shot(admin, 'desktop-author-fillblank-image-stimulus');
  const fillQuestion = await saveQuestion(admin);
  assert.equal(fillQuestion.question_config.default_marks, 2.5); assert.ok(fillQuestion.question_config.stimulus);
  const stimuli = await responseJson(await desktop.request.get(`${base}/api/admin/stimuli`));
  const sharedId = stimuli.find((item) => item.title === 'Reusable image passage').id;
  finishStage('Fill-blank UI authoring, rich text preview, local image upload, shared stimulus and custom marks');

  await newQuestion(admin, 'yes_no', 'Is <u>Dhaka</u> the city in the shared passage?');
  await admin.locator('[name=stimulus_reference]').selectOption(String(sharedId));
  await admin.waitForFunction(() => document.querySelector('[name=stimulus_title]')?.value === 'Reusable image passage');
  assert.equal(await admin.locator('[name=stimulus_text]').getAttribute('readonly'), '');
  await admin.locator('[name=yes_no_correct_answer][value=yes]').check();
  const reuseQuestion = await saveQuestion(admin);
  assert.equal(reuseQuestion.question_config.stimulus.id, sharedId);
  finishStage('Shared stimulus selected and reused from actual authoring dropdown');

  await newQuestion(admin, 'true_false', 'The reference audio is available.');
  await admin.locator('[name=correct_answer][value=true]').check();
  await admin.locator('[name=stimulus_title]').fill('Reusable audio stimulus');
  await upload(admin, 'stimulus', audioFile);
  await admin.locator('[name=stimulus_media_caption]').fill('Synthetic one-second WAV');
  await admin.locator('[name=media_mode]').selectOption('audio');
  await upload(admin, 'media', audioFile);
  await admin.waitForFunction(() => [...document.querySelectorAll('.question-editor audio')].length === 2 && [...document.querySelectorAll('.question-editor audio')].every((audio) => audio.readyState >= 1));
  assert.equal(await admin.locator('.question-editor audio').count(), 2);
  await shot(admin, 'desktop-author-audio-stimulus');
  const audioQuestion = await saveQuestion(admin);
  assert.equal(audioQuestion.question_config.stimulus.media.type, 'audio'); assert.equal(audioQuestion.media.type, 'audio');
  finishStage('Audio-only shared stimulus and question audio attachment upload/metadata');

  const api = desktop.request;
  const specimen = [
    { question_type: 'ordering', question_text: 'Arrange in <b>chronological</b> order.', question_config: { items: [{ id: 'I1', text: 'First' }, { id: 'I2', text: 'Second' }, { id: 'I3', text: 'Third' }] }, answer_key: { correct_order: ['I1', 'I2', 'I3'] } },
    { question_type: 'mcq_multi', question_text: 'Select <u>two</u> prime numbers.', question_config: { options: [{ id: 'A', text: '<b>2</b>' }, { id: 'B', text: '4' }, { id: 'C', text: '<i>3</i>' }, { id: 'D', text: '6' }] }, answer_key: { correct_options: ['A', 'C'] } },
    { question_type: 'short_answer', question_text: 'Name this city.', answer_key: { accepted_answers: ['Dhaka'] } },
    { question_type: 'numeric', question_text: 'Enter the numeric answer.', question_config: { tolerance: 0.1 }, answer_key: { value: 9.8, tolerance: 0.1 } },
    { question_type: 'matching', question_text: 'Match the <b>pairs</b>.', question_config: { prompts: [{ id: 'P1', text: 'One' }, { id: 'P2', text: 'Two' }], choices: [{ id: 'C1', text: 'First' }, { id: 'C2', text: 'Second' }] }, answer_key: { pairs: { P1: 'C1', P2: 'C2' } } },
    { question_type: 'mcq_single', question_text: 'Pick <u>Alpha</u>.', option_a: '<b>Alpha</b>', option_b: 'Beta', option_c: 'Gamma', option_d: 'Delta', correct_option: 'A' },
  ];
  const questions = [fillQuestion, reuseQuestion, audioQuestion];
  for (const q of specimen) questions.push(await responseJson(await api.post(`${base}/api/admin/questions`, { data: { ...q, marks: 1, category: 'Browser acceptance', explanation: '<b>Browser</b> answer explanation.' } }), 201));
  const exam = await responseJson(await api.post(`${base}/api/admin/exams`, { data: { title: 'Browser all-type acceptance', duration_minutes: 30, status: 'published', negative_mark: 0.5, show_score: true, show_answers: true, allow_pdf_download: true, question_ids: questions.map((q) => q.id) } }), 201);
  const student = await desktop.newPage(); await begin(student, base, exam, 'Desktop QA');
  assert.equal(await student.locator('.question-content h1 b').textContent(), 'Complete');
  assert.equal(await student.locator('.question-content h1 u').textContent(), 'city');
  assert.equal(await student.locator('.stimulus-panel .stimulus-text b').textContent(), 'city');
  await student.locator('.stimulus-panel img').evaluate((image) => image.scrollIntoView());
  await student.waitForFunction(() => document.querySelector('.stimulus-panel img')?.naturalWidth > 0);
  await student.getByRole('textbox', { name: 'City', exact: true }).pressSequentially('Dhaka', { delay: 15 });
  await student.getByRole('textbox', { name: 'River', exact: true }).pressSequentially('Buriganga', { delay: 15 });
  await waitSaved(student); await shot(student, 'desktop-fillblank-rich-text');
  await student.reload(); await student.locator('.exam-player').waitFor();
  assert.equal(await student.getByRole('textbox', { name: 'City', exact: true }).inputValue(), 'Dhaka');
  assert.equal(await student.getByRole('textbox', { name: 'River', exact: true }).inputValue(), 'Buriganga');
  await questionNav(student, 1); await student.locator('.answer-option').filter({ hasText: 'Yes' }).click(); await waitSaved(student);
  assert.equal(await student.locator('.stimulus-title').textContent(), 'Reusable image passage');
  await questionNav(student, 2); await student.locator('.answer-option').filter({ hasText: 'True' }).click();
  await student.waitForFunction(() => [...document.querySelectorAll('.question-content audio')].length === 2 && [...document.querySelectorAll('.question-content audio')].every((audio) => audio.readyState >= 1));
  await student.locator('.question-content audio').first().evaluate((audio) => audio.play());
  await student.waitForFunction(() => document.querySelector('.question-content audio').currentTime > 0); await student.locator('.question-content audio').first().evaluate((audio) => audio.pause());
  finishStage('Desktop rich prompt/option/stimulus rendering, rapid multi-blank typing, reload persistence and real audio playback');

  await questionNav(student, 3);
  const orderText = () => student.locator('.student-ordering-row .option-text').allTextContents();
  const activeToken = await student.evaluate(() => sessionStorage.getItem('mcq-attempt-token'));
  const active = await responseJson(await api.get(`${base}/api/attempts/${activeToken}`));
  const publicOrdering = active.questions.find((question) => question.id === questions[3].id);
  assert.ok(!('answer_key' in publicOrdering));
  assert.ok(!('public_item_ids' in publicOrdering.question_config));
  assert.deepEqual(publicOrdering.question_config.items.map((item) => item.id).sort(), Object.values(questions[3].answer_key.public_item_ids).sort());
  const initial = await orderText();
  assert.deepEqual([...initial].sort(), ['First', 'Second', 'Third'].sort());
  assert.notDeepEqual(initial, publicOrdering.question_config.items.map((item) => item.text), 'The client shuffles the opaque public transport order');
  await student.reload(); await student.locator('.exam-player').waitFor(); await questionNav(student, 3); assert.deepEqual(await orderText(), initial, 'Unanswered shuffle remains stable across reload');
  await student.getByRole('button', { name: `Move ${initial[0]} down`, exact: true }).focus(); await student.keyboard.press('Enter'); await waitSaved(student);
  const keyboardOrder = await orderText(); assert.deepEqual(keyboardOrder, [initial[1], initial[0], initial[2]]);
  await student.reload(); await student.locator('.exam-player').waitFor(); await questionNav(student, 3); assert.deepEqual(await orderText(), keyboardOrder);
  await student.locator('.student-ordering-row').first().dragTo(student.locator('.student-ordering-row').last()); await waitSaved(student);
  assert.deepEqual(await orderText(), [keyboardOrder[1], keyboardOrder[2], keyboardOrder[0]], 'Desktop HTML5 drag/drop reorders and saves');
  for (const [target, text] of ['First', 'Second', 'Third'].entries()) {
    let order = await orderText(); while (order.indexOf(text) > target) { await student.getByRole('button', { name: `Move ${text} up`, exact: true }).click(); await waitSaved(student); order = await orderText(); }
  }
  await shot(student, 'desktop-ordering-keyboard-and-drag');
  finishStage('Ordering starts shuffled, stays stable on reload, keyboard and real desktop drag/drop save');
  await questionNav(student, 4); await student.locator('.answer-option').filter({ hasText: '2' }).click(); await student.locator('.answer-option').filter({ hasText: '3' }).click(); await waitSaved(student);
  assert.equal(await student.locator('.answer-option b').textContent(), '2');
  await questionNav(student, 5); await student.getByRole('textbox', { name: 'Your short answer' }).fill('Dhaka'); await student.getByRole('textbox', { name: 'Your short answer' }).press('Tab');
  await questionNav(student, 6); await student.getByRole('spinbutton', { name: 'Your numeric answer' }).fill('9.8'); await student.getByRole('spinbutton', { name: 'Your numeric answer' }).press('Tab');
  await questionNav(student, 7); await student.getByLabel('Match for One', { exact: true }).selectOption('C1'); await student.getByLabel('Match for Two', { exact: true }).selectOption('C2');
  await questionNav(student, 8); await student.locator('.answer-option').filter({ hasText: 'Alpha' }).click(); await waitSaved(student);
  await student.getByRole('button', { name: 'Submit examination', exact: true }).click();
  await student.locator('.confirm-modal').getByRole('button', { name: /Submit/ }).click();
  await student.locator('.result-page').waitFor();
  const token = await student.evaluate(() => sessionStorage.getItem('mcq-attempt-token'));
  const result = await responseJson(await api.get(`${base}/api/attempts/${token}`));
  assert.equal(result.result.score, 10.5); assert.equal(result.result.answers.length, 9);
  assert.equal(await student.locator('.review-item.is-correct').count(), 9);
  assert.equal(await student.locator('.review-item .stimulus-panel').count(), 3);
  assert.equal(await student.locator('.review-item audio').count(), 2);
  assert.equal(await student.locator('.review-item .answer-explanation u').first().textContent(), 'Buriganga');
  await shot(student, 'desktop-student-answer-review');
  finishStage('All nine question types completed in real UI, correctly graded, full student answer review with rich media');

  await admin.reload(); await admin.getByRole('button', { name: /Admin dashboard|Admin sign in/ }).click();
  await admin.locator('.admin-tabs').getByRole('button', { name: /Examinations/ }).click();
  await admin.locator('.admin-exam-card').filter({ hasText: exam.title }).getByRole('button', { name: /View results/ }).click();
  await admin.getByRole('button', { name: /Desktop QA.*Roll Desktop QA/ }).click();
  await admin.locator('.answer-sheet').waitFor();
  assert.equal(await admin.locator('.sheet-question.is-correct').count(), 9);
  assert.equal(await admin.locator('.sheet-question .stimulus-panel').count(), 3);
  assert.equal(await admin.locator('.sheet-question audio').count(), 2);
  await shot(admin, 'desktop-teacher-answer-review');
  finishStage('Teacher answer sheet includes all nine answers, shared stimuli, images and audio');

  const mobile = await browser.newContext({ ...devices['Pixel 7'], reducedMotion: 'reduce' });
  const phone = await mobile.newPage(); phone.on('pageerror', (error) => pageErrors.push(error.message));
  await begin(phone, base, exam, 'Mobile QA');
  await phone.getByRole('textbox', { name: 'City', exact: true }).fill('Dhaka'); await phone.getByRole('textbox', { name: 'River', exact: true }).fill('Buriganga'); await waitSaved(phone);
  await questionNav(phone, 3);
  const mobileOrder = await phone.locator('.student-ordering-row .option-text').allTextContents();
  assert.deepEqual([...mobileOrder].sort(), ['First', 'Second', 'Third'].sort());
  assert.notDeepEqual(mobileOrder, publicOrdering.question_config.items.map((item) => item.text));
  await phone.getByRole('button', { name: `Move ${mobileOrder[0]} down`, exact: true }).tap(); await waitSaved(phone);
  const afterTap = await phone.locator('.student-ordering-row .option-text').allTextContents(); assert.deepEqual(afterTap, [mobileOrder[1], mobileOrder[0], mobileOrder[2]]);
  await phone.reload(); await phone.locator('.exam-player').waitFor(); await questionNav(phone, 3); assert.deepEqual(await phone.locator('.student-ordering-row .option-text').allTextContents(), afterTap);
  const dimensions = await phone.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth })); assert.ok(dimensions.scroll <= dimensions.width + 1, `Mobile horizontal overflow: ${JSON.stringify(dimensions)}`);
  await shot(phone, 'mobile-touch-ordering');
  await questionNav(phone, 0); assert.equal(await phone.getByRole('textbox', { name: 'City', exact: true }).inputValue(), 'Dhaka'); await shot(phone, 'mobile-fillblank-and-stimulus');
  await questionNav(phone, 2); await phone.waitForFunction(() => [...document.querySelectorAll('.question-content audio')].every((audio) => audio.readyState >= 1)); await shot(phone, 'mobile-audio-stimulus');
  finishStage('Mobile touch context: fill blanks, arrow-tap reorder fallback, reload persistence, media and no horizontal overflow');
  assert.deepEqual(pageErrors, [], 'No unhandled browser JS exceptions');
  finishStage('Zero unhandled browser JavaScript exceptions');
  fs.writeFileSync(path.join(artifacts, 'results.json'), JSON.stringify({ browser: browser.version(), passed: stages, artifacts, limits: ['Headless Chromium on cloud workspace; mobile viewport and touch emulation, not physical hardware.', 'Local Express backend; no live deployed Worker/browser/network check.', 'External media reliability and all device/browser combinations are not exercised.'] }, null, 2));
  console.log(`Screenshots and JSON: ${artifacts}`);
} catch (error) {
  console.error(error);
  if (browser) for (const [i, context] of browser.contexts().entries()) for (const [j, page] of context.pages().entries()) { try { await shot(page, `failure-${i}-${j}`); fs.writeFileSync(path.join(artifacts, `failure-${i}-${j}.html`), await page.content()); } catch {} }
  console.error(`Artifacts: ${artifacts}\nServer: ${output}`); process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  if (child && child.exitCode === null) { child.kill(); await new Promise((resolve) => child.once('exit', resolve)); }
  // Artifacts intentionally retained; DB/media are isolated in the reported temp folder.
}
