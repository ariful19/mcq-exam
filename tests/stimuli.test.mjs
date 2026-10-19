import test from 'node:test';
import assert from 'node:assert/strict';
import { listReusableStimuli } from '../server/stimuli.js';
import { normalizeQuestion, sanitizeRichText, validateQuestionMedia, validateQuestionStimulus, validateStudentAnswer } from '../server/question-types.js';

const base = { question_type: 'yes_no', question_text: 'Does this match?', category: 'Reading', answer_key: { correct_answer: 'yes' } };
const passage = { title: 'Reading', text: '<u>A passage</u>\nSecond line.', media: { type: 'audio', url: 'https://example.test/listening.mp3', caption: 'Listen first.' } };

test('shared stimulus catalog reuses immutable snapshots and asset URLs without collapsing changed material', () => {
  const row = (id, stimulus) => ({ id, ...normalizeQuestion({ ...base, stimulus }).question });
  const catalog = listReusableStimuli([row(1, passage), row(2, { ...passage, id: 'shared-one' })]);
  assert.equal(catalog.length, 1);
  assert.equal(catalog[0].question_count, 2);
  assert.equal(catalog[0].id, 'stimulus-q1');
  assert.equal(catalog[0].media.url, passage.media.url);
  const before = JSON.stringify(catalog[0]);
  const changed = listReusableStimuli([row(3, { ...catalog[0], text: 'Revised passage' }), row(4, catalog[0])]);
  assert.equal(changed.length, 2);
  assert.notEqual(changed[0].id, changed[1].id);
  assert.equal(JSON.stringify(catalog[0]), before);
  assert.ok(changed.every((item) => !('answer_key' in item)));
});

test('rich text preserves wording, mathematical comparisons and newlines while rebuilding allowed tags safely', () => {
  assert.equal(sanitizeRichText('5 < 6 and 7 > 2\nUse javascript: as a literal.'), '5 &lt; 6 and 7 &gt; 2<br>Use javascript: as a literal.');
  assert.equal(sanitizeRichText('<b onclick="alert(1)">Bold</b><img src=x onerror=alert(1)><script>alert(1)</script>'), '<b>Bold</b>');
  assert.equal(sanitizeRichText('<b title="a > b">math</b>'), '<b>math</b>');
  assert.equal(sanitizeRichText('<img src=x'), '&lt;img src=x');
  assert.equal(sanitizeRichText('<u>Underlined</u><i>Italic</i><s>Strike</s><br>'), '<u>Underlined</u><i>Italic</i><s>Strike</s><br>');
  const normalized = normalizeQuestion({ ...base, question_type: 'mcq_multi', question_config: { options: [{ id: 'A', text: '<b onclick=x>A</b>' }, { id: 'B', text: '<img src=x>B' }] }, answer_key: { correct_options: ['A'] } });
  assert.deepEqual(normalized.errors, []);
  assert.deepEqual(JSON.parse(normalized.question.question_config).options.map((option) => option.text), ['<b>A</b>', 'B']);
});

test('new media and stimulus references reject unsafe schemes while preserving safe metadata', () => {
  for (const url of ['//evil.test/a.png', '/\\evil.test/a.png', 'javascript:alert(1)', 'data:image/svg+xml;base64,AAAA', 'https:\n//evil.test/a']) {
    assert.ok(validateQuestionMedia({ type: 'image', url }).errors.length, url);
  }
  for (const url of ['/api/media/abc.png', 'https://example.test/a.png']) {
    assert.deepEqual(validateQuestionMedia({ type: 'image', url, alt: 'A diagram' }).errors, []);
  }
  assert.ok(validateQuestionStimulus({ id: '<bad>', text: 'Passage' }).errors.length);
});

test('fill blank authoring rejects malformed blanks and validates Unicode-equivalent response lengths consistently', () => {
  const blank = { ...base, question_type: 'fill_blank', question_text: '[blank]', question_config: { blanks: [{ id: 'B1', max_length: 1 }] }, answer_key: { blanks: { B1: ['é'] } } };
  const normalized = normalizeQuestion(blank);
  assert.deepEqual(normalized.errors, []);
  assert.equal(validateStudentAnswer(normalized.question, { answer_data: { blanks: { B1: 'e\u0301' } } }).error, null);
  assert.ok(validateStudentAnswer(normalized.question, { answer_data: { text: 'too long' } }).error);
  assert.ok(validateStudentAnswer(normalized.question, { answer_data: { blanks: { B1: {} } } }).error);
  for (const blanks of [[null], {}, [], [{ id: 'B1' }, { id: 'B1' }]]) {
    assert.ok(normalizeQuestion({ ...blank, question_config: { blanks } }).errors.length);
  }
});
