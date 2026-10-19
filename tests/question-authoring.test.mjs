import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  QUESTION_TYPES,
  SUPPORTED_QUESTION_TYPES,
  getQuestionTypeMeta,
  createQuestionDraft,
  createStimulusDraft,
  useStimulusSnapshot,
  buildQuestionPayloadFromDraft,
  buildQuestionPreviewModel,
  syncDraftFromForm,
  shuffleOrderingIds,
  hasPopulatedTypeData,
  addMcqMultiOption,
  toggleMcqMultiCorrectOption,
  addShortAnswerAccepted,
  addMatchingPrompt,
  moveOrderingItem,
  validateQuestionDraft,
  hydrateQuestionRow,
  normalizeQuestion,
  formatStudentAnswerSummary,
  formatCorrectAnswerSummary,
  isAnswerProvided,
} from '../client/src/question-authoring.js';

const root = path.resolve(import.meta.dirname || path.dirname(fileURLToPath(import.meta.url)), '..');

function renderLitValue(val) {
  if (val === null || val === undefined || val === false) return '';
  if (Array.isArray(val)) return val.map(renderLitValue).join('');
  if (typeof val === 'object' && val?.__litHtml !== undefined) return val.__litHtml;
  return String(val);
}

async function loadMcqAppClass() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcq-ui-test-'));
  const authoringUrl = pathToFileURL(path.join(root, 'client', 'src', 'question-authoring.js')).href;
  const resultsUrl = pathToFileURL(path.join(root, 'client', 'src', 'results.js')).href;

  const litStubPath = path.join(tmpDir, 'lit-stub.mjs');
  fs.writeFileSync(litStubPath, `
    function renderVal(v) {
      if (v === null || v === undefined || v === false) return '';
      if (Array.isArray(v)) return v.map(renderVal).join('');
      if (typeof v === 'object' && v && '__litHtml' in v) return v.__litHtml;
      return String(v);
    }
    export class LitElement {
      requestUpdate() {
        this.updateComplete = Promise.resolve(true);
      }
      connectedCallback() {}
      disconnectedCallback() {}
      querySelector() { return null; }
      querySelectorAll() { return []; }
    }
    export function html(strings, ...values) {
      let out = '';
      for (let i = 0; i < strings.length; i += 1) {
        const chunk = strings[i];
        if (i < values.length) {
          const val = values[i];
          if (/\\?[a-zA-Z0-9_-]+=$/.test(chunk)) {
            const attrMatch = chunk.match(/\\?([a-zA-Z0-9_-]+)=$/);
            const prefix = chunk.slice(0, chunk.length - attrMatch[0].length);
            out += prefix + (val ? attrMatch[1] : '');
          } else if (/\\.[a-zA-Z0-9_-]+=$/.test(chunk)) {
            const propMatch = chunk.match(/\\.([a-zA-Z0-9_-]+)=$/);
            const prefix = chunk.slice(0, chunk.length - propMatch[0].length);
            const attrName = propMatch[1];
            if (attrName === 'checked') {
              out += prefix + (val ? 'checked' : '');
            } else {
              out += prefix + 'data-prop-' + attrName + '="' + String(val ?? '').replace(/"/g, '&quot;') + '"';
            }
          } else if (/@[a-zA-Z0-9_-]+=$/.test(chunk)) {
            const evtMatch = chunk.match(/@([a-zA-Z0-9_-]+)=$/);
            const prefix = chunk.slice(0, chunk.length - evtMatch[0].length);
            out += prefix + 'data-on-' + evtMatch[1] + '="bound"';
          } else {
            out += chunk + renderVal(val);
          }
        } else {
          out += chunk;
        }
      }
      return { __litHtml: out, toString() { return out; } };
    }
    export function keyed(_key, tpl) {
      return tpl;
    }
    export function unsafeHTML(val) {
      return { __litHtml: String(val ?? ''), toString() { return String(val ?? ''); } };
    }
  `, 'utf8');

  const motionStubPath = path.join(tmpDir, 'motion-stub.mjs');
  fs.writeFileSync(motionStubPath, `
    export function installMotion() { return () => {}; }
    export function appear() {}
    export async function disappear() {}
    export async function slideQuestion(_el, _dir, fn) { if (fn) await fn(); }
    export function setMotionActive() {}
    export function shouldEnableMotion() { return true; }
  `, 'utf8');

  const pdfStubPath = path.join(tmpDir, 'pdf-stub.mjs');
  fs.writeFileSync(pdfStubPath, `
    export function generateResultPdf() { return 'test.pdf'; }
  `, 'utf8');

  const litStubUrl = pathToFileURL(litStubPath).href;
  const motionStubUrl = pathToFileURL(motionStubPath).href;
  const pdfStubUrl = pathToFileURL(pdfStubPath).href;

  let appSource = fs.readFileSync(path.join(root, 'client', 'src', 'app.js'), 'utf8');
  appSource = appSource
    .replace(`import { LitElement, html } from 'lit';`, `import { LitElement, html } from '${litStubUrl}';`)
    .replace(`import { keyed } from 'lit/directives/keyed.js';`, `import { keyed } from '${litStubUrl}';`)
    .replace(`import { unsafeHTML } from 'lit/directives/unsafe-html.js';`, `import { unsafeHTML } from '${litStubUrl}';`)
    .replace(`import './style.css';`, ``)
    .replace(/import\s*\{[^}]*\}\s*from\s*'\.\/motion\.js';/, `import { installMotion, appear, disappear, slideQuestion, setMotionActive, shouldEnableMotion } from '${motionStubUrl}';`)
    .replace(`import { filterAndSortResults } from './results.js';`, `import { filterAndSortResults } from '${resultsUrl}';`)
    .replace(`import { generateResultPdf } from './pdf.js';`, `import { generateResultPdf } from '${pdfStubUrl}';`)
    .replace(`from './question-authoring.js';`, `from '${authoringUrl}';`);

  const appTestPath = path.join(tmpDir, 'app-test.mjs');
  fs.writeFileSync(appTestPath, appSource, 'utf8');
  const mod = await import(pathToFileURL(appTestPath).href);
  return {
    McqApp: mod.McqApp,
    cleanup() {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
}

test('manual question editor shows only relevant inputs for each supported question type', async () => {
  const { McqApp, cleanup } = await loadMcqAppClass();
  try {
    const app = new McqApp();
    app.page = 'admin';
    app.adminTab = 'questions';
    app.openQuestionForm();

    const expectedSectionByType = {
      [QUESTION_TYPES.MCQ_SINGLE]: {
        present: ['data-type-section="mcq_single"', 'name="option_a"', 'name="option_b"', 'name="option_c"', 'name="option_d"', 'name="correct_option"'],
        absent: ['data-type-section="mcq_multi"', 'data-type-section="true_false"', 'data-type-section="fill_blank"', 'data-type-section="short_answer"', 'data-type-section="numeric"', 'data-type-section="matching"', 'data-type-section="ordering"', 'name="numeric_value"', 'name="accepted_answer_0"', 'name="matching_prompt_0"', 'name="ordering_item_0"'],
      },
      [QUESTION_TYPES.MCQ_MULTI]: {
        present: ['data-type-section="mcq_multi"', 'name="multi_option_0"', 'name="multi_correct_A"', 'name="min_selections"', 'name="max_selections"'],
        absent: ['data-type-section="mcq_single"', 'name="correct_option"', 'data-type-section="true_false"', 'data-type-section="fill_blank"', 'data-type-section="short_answer"', 'data-type-section="numeric"', 'data-type-section="matching"', 'data-type-section="ordering"'],
      },
      [QUESTION_TYPES.TRUE_FALSE]: {
        present: ['data-type-section="true_false"', 'name="correct_answer"', 'name="true_text"', 'name="false_text"'],
        absent: ['data-type-section="mcq_single"', 'name="option_a"', 'name="option_c"', 'data-type-section="mcq_multi"', 'data-type-section="fill_blank"', 'data-type-section="short_answer"', 'data-type-section="numeric"', 'data-type-section="matching"', 'data-type-section="ordering"'],
      },
      [QUESTION_TYPES.FILL_BLANK]: {
        present: ['data-type-section="fill_blank"', 'name="blank_label_0"', 'name="blank_0_variant_0"'],
        absent: ['data-type-section="mcq_single"', 'name="option_a"', 'data-type-section="mcq_multi"', 'data-type-section="true_false"', 'data-type-section="short_answer"', 'data-type-section="numeric"', 'data-type-section="matching"', 'data-type-section="ordering"'],
      },
      [QUESTION_TYPES.YES_NO]: {
        present: ['data-type-section="yes_no"', 'name="yes_no_correct_answer"', 'value=yes', 'value=no'],
        absent: ['data-type-section="mcq_single"', 'name="option_a"', 'data-type-section="mcq_multi"', 'data-type-section="true_false"', 'data-type-section="short_answer"', 'data-type-section="numeric"', 'data-type-section="matching"', 'data-type-section="ordering"'],
      },
      [QUESTION_TYPES.SHORT_ANSWER]: {
        present: ['data-type-section="short_answer"', 'name="accepted_answer_0"', 'name="case_sensitive"', 'name="max_length"', 'name="placeholder"'],
        absent: ['data-type-section="mcq_single"', 'name="option_a"', 'data-type-section="mcq_multi"', 'data-type-section="true_false"', 'data-type-section="fill_blank"', 'data-type-section="numeric"', 'name="numeric_tolerance"', 'data-type-section="matching"', 'data-type-section="ordering"'],
      },
      [QUESTION_TYPES.NUMERIC]: {
        present: ['data-type-section="numeric"', 'name="numeric_value"', 'name="numeric_tolerance"', 'name="numeric_unit"', 'name="allow_decimals"'],
        absent: ['data-type-section="mcq_single"', 'name="option_a"', 'data-type-section="mcq_multi"', 'data-type-section="true_false"', 'data-type-section="fill_blank"', 'data-type-section="short_answer"', 'name="accepted_answer_0"', 'data-type-section="matching"', 'data-type-section="ordering"'],
      },
      [QUESTION_TYPES.MATCHING]: {
        present: ['data-type-section="matching"', 'name="matching_prompt_0"', 'name="matching_choice_0"', 'name="matching_pair_P1"'],
        absent: ['data-type-section="mcq_single"', 'name="option_a"', 'data-type-section="mcq_multi"', 'data-type-section="true_false"', 'data-type-section="fill_blank"', 'data-type-section="short_answer"', 'data-type-section="numeric"', 'data-type-section="ordering"'],
      },
      [QUESTION_TYPES.ORDERING]: {
        present: ['data-type-section="ordering"', 'name="ordering_item_0"', 'name="ordering_item_1"', 'Move item 1 down'],
        absent: ['data-type-section="mcq_single"', 'name="option_a"', 'data-type-section="mcq_multi"', 'data-type-section="true_false"', 'data-type-section="fill_blank"', 'data-type-section="short_answer"', 'data-type-section="numeric"', 'data-type-section="matching"'],
      },
    };

    for (const qType of SUPPORTED_QUESTION_TYPES) {
      app.changeQuestionType(qType, { discardIncompatible: true });
      const rendered = renderLitValue(app.renderQuestionForm());
      const rules = expectedSectionByType[qType];
      assert.ok(rendered.includes(`data-question-type="${qType}"`), `Form should reflect active question type ${qType}`);
      for (const expectedToken of rules.present) {
        assert.ok(rendered.includes(expectedToken), `Expected "${expectedToken}" to be present for ${qType}`);
      }
      for (const forbiddenToken of rules.absent) {
        assert.ok(!rendered.includes(forbiddenToken), `Expected "${forbiddenToken}" to be hidden for ${qType}`);
      }
      assert.ok(!rendered.includes('name="media_url"'), 'Media URL input should be hidden when attachment is "none"');
    }

    app.questionDraft.media.enabled = true;
    app.questionDraft.media.type = 'image';
    let mediaRendered = renderLitValue(app.renderQuestionForm());
    assert.ok(mediaRendered.includes('name="media_url"'));
    assert.ok(mediaRendered.includes('name="media_alt"'));

    app.questionDraft.media.type = 'audio';
    mediaRendered = renderLitValue(app.renderQuestionForm());
    assert.ok(mediaRendered.includes('name="media_url"'));
    assert.ok(!mediaRendered.includes('name="media_alt"'), 'Alt text input should only appear for image media');
  } finally {
    cleanup();
  }
});

test('type switching preserves common and compatible draft content and asks or warns before discarding incompatible fields', async () => {
  const { McqApp, cleanup } = await loadMcqAppClass();
  try {
    const app = new McqApp();
    app.page = 'admin';
    app.adminTab = 'questions';
    app.openQuestionForm();

    const draft = app.questionDraft;
    draft.question_text = 'Which of these statements or values is accurate?';
    draft.category = 'Physics';
    draft.difficulty = 'Hard';
    draft.explanation = 'Detailed physics explanation.';
    draft.media = { enabled: true, type: 'image', url: 'https://example.com/diagram.png', alt: 'Diagram', caption: 'Fig 1' };
    draft.typeData.mcq_single = {
      option_a: 'Alpha',
      option_b: 'Beta',
      option_c: 'Gamma',
      option_d: 'Delta',
      correct_option: 'C',
    };

    const toMulti = app.changeQuestionType(QUESTION_TYPES.MCQ_MULTI);
    assert.equal(toMulti.switched, true);
    assert.deepEqual(toMulti.incompatibleFields, []);
    assert.equal(draft.question_type, QUESTION_TYPES.MCQ_MULTI);
    assert.equal(draft.question_text, 'Which of these statements or values is accurate?');
    assert.equal(draft.category, 'Physics');
    assert.deepEqual(draft.typeData.mcq_multi.options.map((o) => o.text), ['Alpha', 'Beta', 'Gamma', 'Delta']);
    assert.deepEqual(draft.typeData.mcq_multi.correct_options, ['C']);

    addMcqMultiOption(draft);
    draft.typeData.mcq_multi.options[4].text = 'Epsilon';
    toggleMcqMultiCorrectOption(draft, 'A', true);

    const askResult = app.changeQuestionType(QUESTION_TYPES.SHORT_ANSWER, { askBeforeDiscard: true });
    assert.equal(askResult.switched, false);
    assert.equal(askResult.requiresConfirmation, true);
    assert.ok(askResult.incompatibleFields.length > 0);
    assert.ok(draft.pendingTypeSwitch);
    let formHtml = renderLitValue(app.renderQuestionForm());
    assert.ok(formHtml.includes('role="alertdialog"'), 'Should render confirmation alertdialog before discarding');

    app.cancelTypeSwitch();
    assert.equal(draft.question_type, QUESTION_TYPES.MCQ_MULTI);
    assert.equal(draft.typeData.mcq_multi.options[4].text, 'Epsilon');

    const preserveSwitch = app.changeQuestionType(QUESTION_TYPES.SHORT_ANSWER);
    assert.equal(preserveSwitch.switched, true);
    assert.equal(draft.question_type, QUESTION_TYPES.SHORT_ANSWER);
    assert.ok(draft.lastSwitchNotice, 'Should record lastSwitchNotice when switching away from populated incompatible type');
    formHtml = renderLitValue(app.renderQuestionForm());
    assert.ok(formHtml.includes('Draft preserved on switch'), 'Should display draft preservation banner with revert and discard actions');

    assert.equal(draft.question_text, 'Which of these statements or values is accurate?');
    assert.equal(draft.category, 'Physics');
    assert.equal(draft.explanation, 'Detailed physics explanation.');
    assert.equal(draft.media.url, 'https://example.com/diagram.png');

    app.revertQuestionType();
    assert.equal(draft.question_type, QUESTION_TYPES.MCQ_MULTI);
    assert.equal(draft.typeData.mcq_multi.options.length, 5);
    assert.equal(draft.typeData.mcq_multi.options[4].text, 'Epsilon');
    assert.deepEqual(draft.typeData.mcq_multi.correct_options, ['A', 'C']);

    app.changeQuestionType(QUESTION_TYPES.SHORT_ANSWER);
    app.discardIncompatibleFields(QUESTION_TYPES.MCQ_MULTI);
    assert.equal(draft.lastSwitchNotice, null);
    assert.equal(hasPopulatedTypeData(draft, QUESTION_TYPES.MCQ_MULTI), false);
  } finally {
    cleanup();
  }
});

test('create, preview/view, and edit work across all supported question types, legacy MCQs, and imported questions', async () => {
  const { McqApp, cleanup } = await loadMcqAppClass();
  try {
    const app = new McqApp();
    app.page = 'admin';
    app.adminTab = 'questions';

    const sampleInputs = [
      {
        id: 101,
        question_text: 'Legacy single MCQ question?',
        option_a: 'Opt A',
        option_b: 'Opt B',
        option_c: 'Opt C',
        option_d: 'Opt D',
        correct_option: 'B',
        category: 'General',
        difficulty: 'Easy',
        explanation: 'B is right.',
      },
      {
        id: 102,
        question_text: 'Select all noble gases.',
        question_type: 'mcq_multi',
        category: 'Chemistry',
        difficulty: 'Medium',
        question_config: {
          options: [
            { id: 'A', text: 'Helium' },
            { id: 'B', text: 'Oxygen' },
            { id: 'C', text: 'Neon' },
          ],
          min_selections: 1,
          max_selections: 2,
        },
        answer_key: { correct_options: ['A', 'C'] },
        media: { type: 'image', url: 'https://example.com/periodic.png', alt: 'Periodic table' },
      },
      {
        id: 103,
        question_text: 'Sound travels faster in water than in air.',
        question_type: 'true_false',
        category: 'Physics',
        difficulty: 'Easy',
        answer_key: { correct_answer: true },
        media: { type: 'audio', url: '/assets/sonar.mp3', caption: 'Sonar ping' },
      },
      {
        id: 108,
        question_text: 'Is water made of hydrogen and oxygen?',
        question_type: 'yes_no',
        category: 'Chemistry',
        difficulty: 'Easy',
        answer_key: { correct_answer: 'yes' },
      },
      {
        id: 104,
        question_text: 'What is the SI unit of force?',
        question_type: 'short_answer',
        category: 'Physics',
        difficulty: 'Easy',
        question_config: { case_sensitive: false, max_length: 40, placeholder: 'Unit name' },
        answer_key: { accepted_answers: ['Newton', 'N'], case_sensitive: false },
      },
      {
        id: 105,
        question_text: 'Standard acceleration due to gravity on Earth?',
        question_type: 'numeric',
        category: 'Physics',
        difficulty: 'Medium',
        question_config: { allow_decimals: true, unit: 'm/s²' },
        answer_key: { value: 9.81, tolerance: 0.02 },
      },
      {
        id: 106,
        question_text: 'Match the programming language to its creator.',
        question_type: 'matching',
        category: 'Computer Science',
        difficulty: 'Hard',
        question_config: {
          prompts: [
            { id: 'P1', text: 'Linux' },
            { id: 'P2', text: 'JavaScript' },
          ],
          choices: [
            { id: 'C1', text: 'Brendan Eich' },
            { id: 'C2', text: 'Linus Torvalds' },
            { id: 'C3', text: 'Guido van Rossum' },
          ],
        },
        answer_key: { pairs: { P1: 'C2', P2: 'C1' } },
      },
      {
        id: 107,
        question_text: 'Order the OSI layers from lowest to highest.',
        question_type: 'ordering',
        category: 'Networking',
        difficulty: 'Medium',
        question_config: {
          items: [
            { id: 'I1', text: 'Physical' },
            { id: 'I2', text: 'Data Link' },
            { id: 'I3', text: 'Network' },
          ],
        },
        answer_key: { correct_order: ['I1', 'I2', 'I3'] },
      },
      {
        id: 108,
        question_text: 'The chemical symbol for water is [blank].',
        question_type: 'fill_blank',
        category: 'Chemistry',
        difficulty: 'Easy',
        question_config: {
          blanks: [{ id: 'B1', label: 'Blank 1' }],
        },
        answer_key: { blanks: { B1: ['H2O', 'h2o'] } },
      },
    ];

    const hydratedBank = sampleInputs.map((item) => {
      const { question, errors } = normalizeQuestion(item);
      assert.deepEqual(errors, [], `Sample ${item.id} should normalize without error`);
      return hydrateQuestionRow({ id: item.id, locked: item.id === 101 ? 1 : 0, ...question });
    });

    app.questions = hydratedBank;

    const adminHtml = renderLitValue(app.renderAdmin());
    assert.ok(adminHtml.includes('Single MCQ'));
    assert.ok(adminHtml.includes('Multi-select'));
    assert.ok(adminHtml.includes('True / False'));
    assert.ok(adminHtml.includes('Yes / No'));
    assert.ok(adminHtml.includes('Fill in blanks'));
    assert.ok(adminHtml.includes('Short answer'));
    assert.ok(adminHtml.includes('Numeric'));
    assert.ok(adminHtml.includes('Matching'));
    assert.ok(adminHtml.includes('Ordering'));
    assert.ok(adminHtml.includes('Preview question'));

    for (const qType of SUPPORTED_QUESTION_TYPES) {
      app.typeFilter = qType;
      assert.equal(app.filteredQuestions.length, 1);
      assert.equal(app.filteredQuestions[0].question_type, qType);
    }
    app.typeFilter = '';

    for (const q of hydratedBank) {
      app.openQuestionPreview(q);
      const previewModalHtml = renderLitValue(app.renderQuestionPreviewModal());
      assert.ok(previewModalHtml.includes(q.question_text) || previewModalHtml.includes('________'), `Preview modal must show prompt for ${q.question_type}`);
      assert.ok(previewModalHtml.includes(getQuestionTypeMeta(q.question_type).label), `Preview modal must show type label for ${q.question_type}`);
      if (q.question_type === QUESTION_TYPES.YES_NO) {
        assert.ok(previewModalHtml.includes('Yes') && previewModalHtml.includes('No'));
        assert.ok(previewModalHtml.includes('Correct answer'));
      }

      app.editFromPreview(q);
      assert.equal(app.questionFormOpen, true);
      assert.equal(app.questionDraft.question_type, q.question_type);
      assert.equal(app.questionDraft.question_text, q.question_text);
      assert.equal(app.questionDraft.category, q.category);

      app.toggleEditorPreview();
      assert.equal(app.editorPreviewOpen, true);
      const editorHtml = renderLitValue(app.renderQuestionForm());
      assert.ok(editorHtml.includes('LIVE AUTHORING PREVIEW'));
      assert.ok(editorHtml.includes(q.question_text));

      const validation = validateQuestionDraft(app.questionDraft);
      assert.equal(validation.valid, true, `Hydrated draft for ${q.question_type} must validate cleanly: ${validation.errors.join('; ')}`);
    }

    const orderingQ = hydratedBank.find((q) => q.question_type === QUESTION_TYPES.ORDERING);
    app.openQuestionForm(orderingQ);
    moveOrderingItem(app.questionDraft, 0, 1);
    assert.deepEqual(app.questionDraft.typeData.ordering.correct_order, ['I2', 'I1', 'I3']);
    const reorderedValidation = validateQuestionDraft(app.questionDraft);
    assert.equal(reorderedValidation.valid, true);
    assert.deepEqual(JSON.parse(reorderedValidation.question.answer_key).correct_order, ['I2', 'I1', 'I3']);

    const matchingQ = hydratedBank.find((q) => q.question_type === QUESTION_TYPES.MATCHING);
    app.openQuestionForm(matchingQ);
    addMatchingPrompt(app.questionDraft);
    app.questionDraft.typeData.matching.prompts[2].text = 'Python';
    app.questionDraft.typeData.matching.pairs.P3 = 'C3';
    const matchingValidation = validateQuestionDraft(app.questionDraft);
    assert.equal(matchingValidation.valid, true);
    assert.equal(JSON.parse(matchingValidation.question.answer_key).pairs.P3, 'C3');
  } finally {
    cleanup();
  }
});

test('client validation rejects invalid inputs and enforces scope constraints before saving', async () => {
  const { McqApp, cleanup } = await loadMcqAppClass();
  try {
    const app = new McqApp();
    app.page = 'admin';
    app.adminTab = 'questions';
    app.openQuestionForm();

    const savedEmpty = await app.saveQuestion({ preventDefault() {} });
    assert.equal(savedEmpty, null);
    assert.ok(app.questionSaveError);
    assert.ok(app.questionSaveDetails.some((e) => e.includes('Question is required')));
    assert.ok(app.questionSaveDetails.some((e) => e.includes('Subject is required')));

    app.changeQuestionType(QUESTION_TYPES.NUMERIC, { discardIncompatible: true });
    app.questionDraft.question_text = 'How many protons in Carbon?';
    app.questionDraft.category = 'Chemistry';
    app.questionDraft.typeData.numeric.value = '6.5';
    app.questionDraft.typeData.numeric.allow_decimals = false;
    const savedBadNumeric = await app.saveQuestion({ preventDefault() {} });
    assert.equal(savedBadNumeric, null);
    assert.ok(app.questionSaveDetails.some((e) => e.includes('integer when allow_decimals is false')));

    app.questionDraft.typeData.numeric.value = '6';
    app.questionDraft.media = { enabled: true, type: 'video', url: 'https://example.com/video.mp4', alt: '', caption: '' };
    const savedVideoMedia = await app.saveQuestion({ preventDefault() {} });
    assert.equal(savedVideoMedia, null);
    assert.ok(app.questionSaveDetails.some((e) => e.includes('Video questions and video media are not supported')));
  } finally {
    cleanup();
  }
});

test('end-to-end UI + SQLite workflow: create, view/preview, import, and edit all supported question types while preserving locked exam history', async () => {
  const { execFileSync } = await import('node:child_process');
  const { migrateSqliteDatabase } = await import('../server/question-types.js');
  const { McqApp, cleanup } = await loadMcqAppClass();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcq-e2e-authoring-'));
  const dbPath = path.join(tmpDir, 'test.db');

  let db;
  try {
    const { default: Database } = await import('better-sqlite3');
    const nativeDb = new Database(dbPath);
    nativeDb.pragma('foreign_keys = ON');
    db = {
      pragma(sql) { return nativeDb.pragma(sql); },
      exec(sql) { nativeDb.exec(sql); },
      prepare(sql) {
        const stmt = nativeDb.prepare(sql);
        return {
          get(...params) { return stmt.get(...params); },
          all(...params) { return stmt.all(...params); },
          run(...params) { return stmt.run(...params); },
        };
      },
      transaction(fn) { return nativeDb.transaction(fn); },
      close() { nativeDb.close(); },
    };
  } catch {
    let fkEnabled = true;
    const runPy = (op, sql = '', params = []) => {
      const pyScript = `
import sys, json, sqlite3
payload = json.loads(sys.stdin.read())
con = sqlite3.connect(payload["db"])
con.row_factory = sqlite3.Row
con.execute("PRAGMA foreign_keys = " + ("ON" if payload["fk"] else "OFF"))
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
        input: JSON.stringify({ db: dbPath, fk: fkEnabled, op, sql, params }),
        encoding: 'utf8',
      });
      return JSON.parse(out.trim());
    };

    db = {
      pragma(sql) {
        const clean = String(sql).trim();
        const fkMatch = clean.match(/^foreign_keys\s*=\s*(ON|OFF|1|0)$/i);
        if (fkMatch) {
          fkEnabled = ['ON', '1'].includes(fkMatch[1].toUpperCase());
          return [];
        }
        return runPy('pragma', clean).rows;
      },
      exec(sql) { runPy('exec', sql); },
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
      transaction(fn) { return (...args) => fn(...args); },
      close() {},
    };
  }

  db.exec(`
    CREATE TABLE questions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      archived INTEGER NOT NULL DEFAULT 0,
      question_text TEXT NOT NULL,
      option_a TEXT NOT NULL DEFAULT '',
      option_b TEXT NOT NULL DEFAULT '',
      option_c TEXT NOT NULL DEFAULT '',
      option_d TEXT NOT NULL DEFAULT '',
      correct_option TEXT NOT NULL DEFAULT 'A',
      category TEXT NOT NULL DEFAULT '',
      difficulty TEXT NOT NULL DEFAULT '',
      explanation TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE exams (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      duration_minutes INTEGER NOT NULL DEFAULT 30,
      status TEXT NOT NULL DEFAULT 'published',
      show_score INTEGER NOT NULL DEFAULT 1,
      show_answers INTEGER NOT NULL DEFAULT 1,
      allow_pdf_download INTEGER NOT NULL DEFAULT 1,
      subject TEXT NOT NULL DEFAULT '',
      negative_mark REAL NOT NULL DEFAULT 0.25,
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
      started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      submitted_at TEXT,
      score REAL,
      status TEXT NOT NULL DEFAULT 'in_progress'
    );
    CREATE TABLE answers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      attempt_id INTEGER NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
      question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE RESTRICT,
      selected_option TEXT,
      is_correct INTEGER,
      marks_awarded REAL NOT NULL DEFAULT 0,
      UNIQUE (attempt_id, question_id)
    );
  `);
  migrateSqliteDatabase(db);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const method = (options.method || 'GET').toUpperCase();
    const body = options.body ? JSON.parse(options.body) : null;

    if (url === '/api/admin/questions' && method === 'GET') {
      const rows = db.prepare(`SELECT q.*, EXISTS(SELECT 1 FROM exam_questions eq WHERE eq.question_id = q.id) AS locked
        FROM questions q WHERE q.archived=0 ORDER BY q.id DESC`).all().map((r) => hydrateQuestionRow(r));
      return new Response(JSON.stringify(rows), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url === '/api/admin/exams' && method === 'GET') {
      return new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url === '/api/admin/questions' && method === 'POST') {
      const { question, errors } = normalizeQuestion(body || {});
      if (errors.length) {
        return new Response(JSON.stringify({ error: 'Please correct the question details.', details: errors }), {
          status: 400, headers: { 'Content-Type': 'application/json' },
        });
      }
      const res = db.prepare(`INSERT INTO questions
        (question_text, question_type, option_a, option_b, option_c, option_d, correct_option, question_config, answer_key, media, category, difficulty, explanation)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        question.question_text, question.question_type, question.option_a, question.option_b, question.option_c, question.option_d,
        question.correct_option, question.question_config, question.answer_key, question.media, question.category, question.difficulty, question.explanation,
      );
      const created = db.prepare(`SELECT q.*, EXISTS(SELECT 1 FROM exam_questions eq WHERE eq.question_id = q.id) AS locked
        FROM questions q WHERE q.id = ?`).get(res.lastInsertRowid);
      return new Response(JSON.stringify(hydrateQuestionRow(created)), { status: 201, headers: { 'Content-Type': 'application/json' } });
    }
    const idMatch = String(url).match(/^\/api\/admin\/questions\/(\d+)$/);
    if (idMatch && method === 'PUT') {
      const id = Number(idMatch[1]);
      const existing = db.prepare('SELECT * FROM questions WHERE archived=0 AND id=?').get(id);
      if (!existing) return new Response(JSON.stringify({ error: 'Question not found.' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
      const { question, errors } = normalizeQuestion(body || {});
      if (errors.length) {
        return new Response(JSON.stringify({ error: 'Please correct the question details.', details: errors }), {
          status: 400, headers: { 'Content-Type': 'application/json' },
        });
      }
      const locked = db.prepare('SELECT 1 FROM exam_questions WHERE question_id=? LIMIT 1').get(id);
      if (locked) {
        const res = db.prepare(`INSERT INTO questions
          (question_text, question_type, option_a, option_b, option_c, option_d, correct_option, question_config, answer_key, media, category, difficulty, explanation)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          question.question_text, question.question_type, question.option_a, question.option_b, question.option_c, question.option_d,
          question.correct_option, question.question_config, question.answer_key, question.media, question.category, question.difficulty, question.explanation,
        );
        db.prepare('UPDATE questions SET archived=1 WHERE id=?').run(id);
        const replacement = db.prepare(`SELECT q.*, EXISTS(SELECT 1 FROM exam_questions eq WHERE eq.question_id = q.id) AS locked
          FROM questions q WHERE q.id = ?`).get(res.lastInsertRowid);
        return new Response(JSON.stringify(hydrateQuestionRow(replacement)), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      db.prepare(`UPDATE questions SET question_text=?, question_type=?, option_a=?, option_b=?, option_c=?, option_d=?,
        correct_option=?, question_config=?, answer_key=?, media=?, category=?, difficulty=?, explanation=? WHERE id=?`).run(
        question.question_text, question.question_type, question.option_a, question.option_b, question.option_c, question.option_d,
        question.correct_option, question.question_config, question.answer_key, question.media, question.category, question.difficulty, question.explanation, id,
      );
      const updated = db.prepare(`SELECT q.*, EXISTS(SELECT 1 FROM exam_questions eq WHERE eq.question_id = q.id) AS locked
        FROM questions q WHERE q.id = ?`).get(id);
      return new Response(JSON.stringify(hydrateQuestionRow(updated)), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  try {
    const app = new McqApp();
    app.page = 'admin';
    app.adminTab = 'questions';

    app.openQuestionForm();
    app.questionDraft.question_text = 'Capital of Japan?';
    app.questionDraft.category = 'Geography';
    app.questionDraft.typeData.mcq_single = { option_a: 'Seoul', option_b: 'Tokyo', option_c: 'Kyoto', option_d: 'Osaka', correct_option: 'B' };
    const createdMcq = await app.saveQuestion({ preventDefault() {} });
    assert.ok(createdMcq?.id);

    app.openQuestionForm();
    app.changeQuestionType(QUESTION_TYPES.MCQ_MULTI);
    app.questionDraft.question_text = 'Which are continents?';
    app.questionDraft.category = 'Geography';
    app.questionDraft.typeData.mcq_multi.options = [
      { id: 'A', text: 'Asia' },
      { id: 'B', text: 'Pacific' },
      { id: 'C', text: 'Africa' },
    ];
    app.questionDraft.typeData.mcq_multi.correct_options = ['A', 'C'];
    const createdMulti = await app.saveQuestion({ preventDefault() {} });
    assert.ok(createdMulti?.id);

    app.openQuestionForm();
    app.changeQuestionType(QUESTION_TYPES.TRUE_FALSE);
    app.questionDraft.question_text = 'Light travels faster than sound.';
    app.questionDraft.category = 'Science';
    app.questionDraft.typeData.true_false.correct_answer = true;
    const createdTf = await app.saveQuestion({ preventDefault() {} });
    assert.ok(createdTf?.id);

    app.openQuestionForm();
    app.changeQuestionType(QUESTION_TYPES.SHORT_ANSWER);
    app.questionDraft.question_text = 'Chemical formula for water?';
    app.questionDraft.category = 'Chemistry';
    app.questionDraft.typeData.short_answer.accepted_answers = ['H2O'];
    const createdShort = await app.saveQuestion({ preventDefault() {} });
    assert.ok(createdShort?.id);

    app.openQuestionForm();
    app.changeQuestionType(QUESTION_TYPES.NUMERIC);
    app.questionDraft.question_text = 'Boiling point of water at 1 atm in Celsius?';
    app.questionDraft.category = 'Chemistry';
    app.questionDraft.typeData.numeric.value = '100';
    app.questionDraft.typeData.numeric.tolerance = '0.5';
    app.questionDraft.typeData.numeric.unit = '°C';
    const createdNum = await app.saveQuestion({ preventDefault() {} });
    assert.ok(createdNum?.id);

    app.openQuestionForm();
    app.changeQuestionType(QUESTION_TYPES.MATCHING);
    app.questionDraft.question_text = 'Match element to symbol.';
    app.questionDraft.category = 'Chemistry';
    app.questionDraft.typeData.matching.prompts = [{ id: 'P1', text: 'Sodium' }, { id: 'P2', text: 'Potassium' }];
    app.questionDraft.typeData.matching.choices = [{ id: 'C1', text: 'K' }, { id: 'C2', text: 'Na' }];
    app.questionDraft.typeData.matching.pairs = { P1: 'C2', P2: 'C1' };
    const createdMatch = await app.saveQuestion({ preventDefault() {} });
    assert.ok(createdMatch?.id);

    app.openQuestionForm();
    app.changeQuestionType(QUESTION_TYPES.ORDERING);
    app.questionDraft.question_text = 'Order numbers ascending.';
    app.questionDraft.category = 'Math';
    app.questionDraft.typeData.ordering.items = [{ id: 'I1', text: '10' }, { id: 'I2', text: '20' }, { id: 'I3', text: '30' }];
    app.questionDraft.typeData.ordering.correct_order = ['I1', 'I2', 'I3'];
    const createdOrder = await app.saveQuestion({ preventDefault() {} });
    assert.ok(createdOrder?.id);

    assert.equal(app.questions.length, 7);

    app.openQuestionForm(createdShort);
    addShortAnswerAccepted(app.questionDraft);
    app.questionDraft.typeData.short_answer.accepted_answers[1] = 'Water';
    const updatedShort = await app.saveQuestion({ preventDefault() {} });
    assert.equal(updatedShort.id, createdShort.id, 'Unlocked question should update in place');
    assert.deepEqual(updatedShort.answer_key.accepted_answers, ['H2O', 'Water']);

    db.prepare(`INSERT INTO exams (id, title, duration_minutes, status, show_score, show_answers, subject, negative_mark)
      VALUES (1, 'Mixed Science Exam', 30, 'published', 1, 1, 'Science', 0.25)`).run();
    db.prepare(`INSERT INTO exam_questions (exam_id, question_id, marks, sort_order) VALUES (1, ?, 1, 0), (1, ?, 1, 1)`).run(createdMcq.id, createdNum.id);

    await app.loadAdminData();
    const lockedNumInBank = app.questions.find((q) => q.id === createdNum.id);
    assert.ok(lockedNumInBank.locked, 'Question attached to exam should be marked locked');

    app.openQuestionForm(lockedNumInBank);
    const lockedFormHtml = renderLitValue(app.renderQuestionForm());
    assert.ok(lockedFormHtml.includes('new version on save'), 'Locked question editor should inform teacher that saving creates a new version');

    app.questionDraft.question_text = 'Boiling point of water in Kelvin?';
    app.questionDraft.typeData.numeric.value = '373.15';
    app.questionDraft.typeData.numeric.unit = 'K';
    const versionedNum = await app.saveQuestion({ preventDefault() {} });
    assert.notEqual(versionedNum.id, createdNum.id, 'Editing a locked question must create a new question row');
    assert.equal(versionedNum.answer_key.value, 373.15);

    const examOriginalQ = hydrateQuestionRow(db.prepare('SELECT * FROM questions WHERE id=?').get(createdNum.id));
    assert.equal(examOriginalQ.archived, 1);
    assert.equal(examOriginalQ.answer_key.value, 100);

    const importedTfNorm = normalizeQuestion({
      Question: 'Imported True/False via Excel Correct Answer column?',
      'Question Type': 'true_false',
      'Correct Answer': 'False',
      Category: 'Imported',
    });
    assert.deepEqual(importedTfNorm.errors, []);
    assert.deepEqual(JSON.parse(importedTfNorm.question.answer_key), { correct_answer: false });

    const importedDraft = createQuestionDraft({ id: 999, ...importedTfNorm.question });
    assert.equal(importedDraft.question_type, QUESTION_TYPES.TRUE_FALSE);
    assert.equal(importedDraft.typeData.true_false.correct_answer, false);

    const importedYesNoNorm = normalizeQuestion({
      Question: 'Does the Pacific Ocean touch Bangladesh?',
      'Question Type': 'yes_no',
      'Correct Answer': 'No',
      Category: 'Imported',
    });
    assert.deepEqual(importedYesNoNorm.errors, []);
    assert.deepEqual(JSON.parse(importedYesNoNorm.question.answer_key), { correct_answer: 'no' });
    const importedYesNoDraft = createQuestionDraft({ id: 1000, ...importedYesNoNorm.question });
    assert.equal(importedYesNoDraft.question_type, QUESTION_TYPES.YES_NO);
    assert.equal(importedYesNoDraft.typeData.yes_no.correct_answer, 'no');
    const yesNoValidation = validateQuestionDraft(importedYesNoDraft);
    assert.equal(yesNoValidation.valid, true);
    assert.deepEqual(JSON.parse(yesNoValidation.question.answer_key), { correct_answer: 'no' });

    const yesNoAnswer = {
      ...yesNoValidation.question,
      answer_data: { selected_answer: 'yes' },
    };
    assert.equal(isAnswerProvided(yesNoAnswer, null, yesNoAnswer.answer_data), true);
    assert.equal(formatStudentAnswerSummary(yesNoAnswer), 'Yes');
    assert.equal(formatCorrectAnswerSummary(yesNoAnswer), 'No');
  } finally {
    globalThis.fetch = originalFetch;
    db?.close?.();
    cleanup();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('student and teacher result reviews label positive partial credit clearly', async () => {
  const { McqApp, cleanup } = await loadMcqAppClass();
  try {
    const app = new McqApp();
    const answer = {
      question_id: 1,
      question_type: QUESTION_TYPES.MCQ_MULTI,
      question_text: 'Select the correct prime numbers.',
      answer_data: { selected_options: ['A', 'B', 'D'] },
      answer_key: { correct_options: ['A', 'B', 'C'] },
      marks: 6,
      marks_awarded: 1,
      is_correct: 0,
    };
    app.attempt = {
      exam_title: 'Mixed exam',
      student_name: 'Student',
      questions: [{}],
      result: { score: 1, answers: [answer] },
    };
    const studentReview = renderLitValue(app.renderStudentResult());
    assert.ok(studentReview.includes('Partial credit'));
    assert.ok(studentReview.includes('Your answer:'));
    assert.ok(studentReview.includes('Correct answer:'));
    assert.ok(studentReview.includes('1 / 6 mark'));

    app.answerSheet = {
      ...app.attempt,
      status: 'submitted',
      score: 1,
      started_at: '2026-10-17T00:00:00Z',
      submitted_at: '2026-10-17T00:10:00Z',
      answers: [answer],
    };
    app.resultExam = { negative_mark: 0.25 };
    const teacherReview = renderLitValue(app.renderAnswerSheet());
    assert.ok(teacherReview.includes('Partial credit'));
    assert.ok(teacherReview.includes('is-partial'));
    assert.ok(teacherReview.includes('Student response:'));
    assert.ok(teacherReview.includes('Correct answer:'));
    assert.ok(teacherReview.includes('Exam penalty:'));
  } finally {
    cleanup();
  }
});

test('shared stimulus snapshots preserve identity, media accessibility, marks and independent draft copies', () => {
  const source = {
    id: 'stimulus-q21', title: 'Listen and answer', text: 'Use the same clip for the next questions.',
    media: { type: 'audio', url: '/api/media/example.mp3', caption: 'Weather report', alt: 'Original metadata' },
  };
  const first = createQuestionDraft();
  const second = createQuestionDraft();
  useStimulusSnapshot(first, source);
  useStimulusSnapshot(second, source);
  first.marks = '2.5';
  second.question_type = QUESTION_TYPES.YES_NO;
  const firstPayload = buildQuestionPayloadFromDraft(first);
  const secondPayload = buildQuestionPayloadFromDraft(second);
  assert.deepEqual(firstPayload.stimulus, source);
  assert.deepEqual(secondPayload.stimulus, source);
  assert.equal(firstPayload.marks, 2.5);
  assert.equal(firstPayload.stimulus.media.url, secondPayload.stimulus.media.url, 'Reuse must preserve the same media reference');
  first.stimulus.id = '';
  first.stimulus.title = 'Customized copy';
  assert.equal(second.stimulus.title, source.title);
  assert.equal(source.title, 'Listen and answer');
  assert.equal(buildQuestionPayloadFromDraft(first).stimulus.id, undefined);
  assert.equal(buildQuestionPayloadFromDraft(second).stimulus.id, source.id);
  const hydrated = createQuestionDraft({
    question_type: QUESTION_TYPES.YES_NO, question_text: 'Is it raining?',
    category: 'Listening', question_config: { default_marks: 3, stimulus: source },
    answer_key: { correct_answer: 'yes' },
  });
  assert.equal(hydrated.marks, '3');
  assert.equal(hydrated.stimulus.id, source.id);
  assert.equal(hydrated.stimulus.media_caption, source.media.caption);
  assert.equal(buildQuestionPreviewModel(hydrated).stimulus.media.url, source.media.url);
  hydrated.stimulus = createStimulusDraft();
  assert.equal(buildQuestionPayloadFromDraft(hydrated).stimulus, null);
});

test('pending media drafts do not retain a fake URL and attaching a real URL clears pending state on form synchronization', () => {
  const draft = createQuestionDraft({ question_type: 'yes_no', question_text: 'Read image', media: { type: 'image', placeholder: true, url: '[placeholder]', alt: 'Expected diagram', caption: 'Figure 1' } });
  assert.equal(draft.media.url, '');
  assert.equal(draft.media.placeholder, true);
  assert.equal(buildQuestionPreviewModel(draft).media.placeholder, true);
  assert.equal(buildQuestionPayloadFromDraft(draft).media.alt, 'Expected diagram');
  assert.equal(buildQuestionPayloadFromDraft(draft).media.caption, 'Figure 1');
  const NativeFormData = globalThis.FormData;
  globalThis.FormData = class extends Map { constructor() { super([['media_mode', 'image'], ['media_url', '/api/media/diagram.png'], ['marks', '4']]); } };
  try {
    syncDraftFromForm(draft, {});
    assert.equal(draft.media.placeholder, false);
    assert.equal(draft.marks, '4');
    assert.equal(buildQuestionPayloadFromDraft(draft).media.url, '/api/media/diagram.png');
    assert.equal(buildQuestionPayloadFromDraft(draft).media.placeholder, undefined);
  } finally { globalThis.FormData = NativeFormData; }
});

test('media preview handles pending, accessible playback, loading, error and shared rendering in both review screens', async () => {
  const { McqApp, cleanup } = await loadMcqAppClass();
  try {
    const app = new McqApp();
    const pending = renderLitValue(app.renderQuestionMedia({ type: 'image', placeholder: true, url: '[placeholder]' }));
    assert.ok(pending.includes('Pending image attachment'));
    assert.ok(!pending.includes('<img'));
    const audio = { type: 'audio', url: '/api/media/clip.mp3', caption: 'Spoken instructions' };
    let rendered = renderLitValue(app.renderQuestionMedia(audio, { key: 'test', label: 'Listening task' }));
    assert.ok(rendered.includes('<audio controls preload="metadata"'));
    assert.ok(rendered.includes('Spoken instructions'));
    assert.ok(rendered.includes('Loading audio…'));
    assert.ok(rendered.includes('data-on-error="bound"'));
    app.setMediaStatus(`test:audio:${audio.url}`, 'error');
    rendered = renderLitValue(app.renderQuestionMedia(audio, { key: 'test' }));
    assert.ok(rendered.includes('Audio could not be loaded'));
    assert.ok(rendered.includes('Retry audio'));
    app.setMediaStatus(`test:audio:${audio.url}`, 'ready');
    rendered = renderLitValue(app.renderQuestionMedia(audio, { key: 'test' }));
    assert.ok(!rendered.includes('Loading audio…'));
    assert.ok(!rendered.includes('Retry audio'));
    const invalid = renderLitValue(app.renderQuestionMedia({ type: 'image', url: 'javascript:alert(1)' }));
    assert.ok(invalid.includes('Media preview unavailable'));
    assert.ok(!invalid.includes('<img'));
    const answer = {
      question_id: 1, question_type: 'yes_no', question_text: 'Did it rain?',
      question_config: { stimulus: { id: 'stimulus-q1', title: 'Listening passage', text: 'Listen carefully.', media: audio } },
      media: { type: 'image', url: '/api/media/map.png', alt: 'Weather map' },
      answer_key: { correct_answer: 'yes' }, answer_data: { selected_answer: 'yes' }, marks: 2, marks_awarded: 2, is_correct: 1,
    };
    app.attempt = { id: 1, exam_title: 'Listening', student_name: 'Student', questions: [{ marks: 2 }], result: { score: 2, answers: [answer] } };
    app.answerSheet = { ...app.attempt, status: 'submitted', score: 2, answers: [answer] };
    for (const review of [app.renderStudentResult(), app.renderAnswerSheet()]) {
      const html = renderLitValue(review);
      assert.ok(html.includes('Listening passage'));
      assert.ok(html.includes('Weather map'));
      assert.ok(html.includes('/api/media/clip.mp3'));
    }
    app.attempt.result = { score: 2 };
    assert.ok(!renderLitValue(app.renderStudentResult()).includes('Listening passage'), 'Hidden answer review must not expose media or reference content');
  } finally { cleanup(); }
});

test('media upload clears placeholders, uses a single uploaded reference and quick removal supports versioned questions', async () => {
  const { McqApp, cleanup } = await loadMcqAppClass();
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    return new Response(JSON.stringify(url.endsWith('/upload')
      ? { url: '/api/media/uploaded.wav', type: 'audio' }
      : { id: 101 }), { headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const app = new McqApp();
    app.notify = (message, kind, details) => { app.toast = { message, kind, details }; };
    app.loadAdminData = async () => {};
    app.openQuickAttachMedia({ id: 10, question_text: 'Listen', media: { type: 'audio', placeholder: true }, locked: true });
    assert.equal(app.quickMediaDraft.type, 'audio');
    assert.ok(renderLitValue(app.renderQuickAttachModal()).includes('Pending audio attachment'));
    const input = { files: [new File(['RIFF'], 'sound.wav', { type: 'audio/wav' })], value: 'sound.wav' };
    await app.uploadQuestionMedia({ target: input }, app.quickMediaDraft);
    assert.equal(input.value, '');
    assert.equal(app.quickMediaDraft.placeholder, false);
    assert.equal(app.quickMediaDraft.url, '/api/media/uploaded.wav');
    assert.ok(renderLitValue(app.renderQuickAttachModal()).includes('Save media attachment'));
    assert.equal(requests.length, 1);
    await app.saveQuickAttachMedia({ preventDefault() {} });
    assert.deepEqual(JSON.parse(requests[1].options.body), { media: { type: 'audio', url: '/api/media/uploaded.wav' } });
    assert.ok(app.toast.message.includes('Question #101'));
    assert.ok(app.toast.message.includes('Existing exams keep the original version'));
    app.openQuickAttachMedia({ id: 11, media: { type: 'image', url: '/api/media/old.png' } });
    await app.saveQuickAttachMedia(null, { remove: true });
    assert.deepEqual(JSON.parse(requests[2].options.body), { media: null });
    assert.equal(app.attachingMediaQuestion, null);
    const stimulus = createStimulusDraft();
    await app.uploadQuestionMedia({ target: input }, stimulus, { stimulus: true });
    assert.equal(stimulus.media_url, '/api/media/uploaded.wav');
    assert.equal(stimulus.enabled, true);
    assert.equal(stimulus.media_placeholder, false);
  } finally { globalThis.fetch = originalFetch; cleanup(); }
});

test('question bank media filters include shared media and reusable selector retains snapshot IDs', async () => {
  const { McqApp, cleanup } = await loadMcqAppClass();
  try {
    const app = new McqApp();
    app.questions = [
      { id: 1, question_text: 'Pending', question_config: { stimulus: { media: { type: 'audio', placeholder: true } } } },
      { id: 2, question_text: 'Attached', stimulus: { media: { type: 'image', url: '/api/media/map.png' } } },
      { id: 3, question_text: 'Plain' },
    ];
    app.mediaFilter = 'pending';
    assert.deepEqual(app.filteredQuestions.map((q) => q.id), [1]);
    app.mediaFilter = 'with_media';
    assert.deepEqual(app.filteredQuestions.map((q) => q.id), [2]);
    app.openQuestionForm();
    app.stimuli = [{ id: 'stimulus-q2', title: 'Shared map', media: { type: 'image', url: '/api/media/map.png', alt: 'Map' }, question_count: 2 }];
    app.selectStimulus('stimulus-q2');
    assert.equal(app.questionDraft.stimulus.id, 'stimulus-q2');
    app.updateStimulusField('title', 'Should not mutate shared snapshot');
    assert.equal(app.questionDraft.stimulus.title, 'Shared map');
    const form = renderLitValue(app.renderQuestionForm());
    assert.ok(form.includes('name="stimulus_reference"'));
    assert.ok(form.includes('Customize a copy'));
    assert.ok(form.includes('name="marks"'));
    assert.ok(form.includes('2 questions'));
    assert.ok(!form.includes('Upload stimulus file'), 'Shared snapshot is not editable until explicitly copied');
  } finally { cleanup(); }
});

test('ordering initialization shuffles, stays stable across navigation and reload, and keeps accessible move controls', async () => {
  const ids = ['I1', 'I2', 'I3', 'I4'];
  assert.deepEqual(shuffleOrderingIds(ids, () => 0), ['I2', 'I3', 'I4', 'I1']);
  assert.deepEqual(shuffleOrderingIds(ids, () => 0.999), ['I2', 'I1', 'I3', 'I4'], 'Identity shuffle must be changed');
  assert.deepEqual(ids, ['I1', 'I2', 'I3', 'I4'], 'Original list must be untouched');
  const { McqApp, cleanup } = await loadMcqAppClass();
  const storage = globalThis.sessionStorage;
  const values = new Map();
  globalThis.sessionStorage = { getItem: (key) => values.get(key) || null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) };
  try {
    const question = { id: 41, question_type: 'ordering', question_config: { items: ids.map((id) => ({ id, text: `Step ${id}` })) } };
    const first = new McqApp();
    first.attempt = { id: 71 };
    const initial = [...first.initialOrderingIds(question)];
    assert.notDeepEqual(initial, ids);
    assert.deepEqual(new Set(initial), new Set(ids));
    assert.deepEqual(first.initialOrderingIds(question), initial);
    const second = new McqApp();
    second.attempt = { id: 71 };
    assert.deepEqual(second.initialOrderingIds(question), initial, 'Reload restores unchanged initial order');
    let rendered = renderLitValue(second.renderStudentQuestionInput(question));
    assert.ok(rendered.includes('Move Step I1 up'));
    assert.ok(rendered.includes('Move Step I1 down'));
    second.answerDataByQuestion[41] = { order: ['I4', 'I3', 'I2', 'I1'] };
    rendered = renderLitValue(second.renderStudentQuestionInput(question));
    assert.ok(rendered.indexOf('Step I4') < rendered.indexOf('Step I3'), 'Saved student order takes precedence over shuffled starting order');
    second.attempt = { id: 72 };
    second.initialOrderingIds(question);
    assert.equal(JSON.parse(values.get('mcq-ordering-initial')).attemptId, 72);
  } finally { if (storage === undefined) delete globalThis.sessionStorage; else globalThis.sessionStorage = storage; cleanup(); }
});

test('rich authored labels are safe and readable in plain summaries, while student text stays literal', async () => {
  const row = {
    question_type: 'mcq_multi', question_config: { options: [
      { id: 'A', text: '<b>Alpha</b> &amp; Beta' },
      { id: 'B', text: '<em>Gamma</em><script>bad()</script>' },
    ] }, answer_key: { correct_options: ['A', 'B'] }, answer_data: { selected_options: ['A'] },
  };
  assert.equal(formatStudentAnswerSummary(row), 'A. Alpha & Beta');
  assert.equal(formatCorrectAnswerSummary(row), 'A. Alpha & Beta, B. Gamma');
  const textAnswer = { question_type: 'short_answer', question_config: {}, answer_data: { text: '<b>student literal</b>' } };
  assert.equal(formatStudentAnswerSummary(textAnswer), '<b>student literal</b>');
  const { McqApp, cleanup } = await loadMcqAppClass();
  try {
    const app = new McqApp();
    const matching = {
      question_type: 'matching', question_text: '<b>Match</b>', question_config: {
        prompts: [{ id: 'P1', text: '<em>Author prompt</em>' }, { id: 'P2', text: 'Second' }],
        choices: [{ id: 'C1', text: '<b>Author choice</b>' }, { id: 'C2', text: 'Other' }],
      }, answer_key: { pairs: { P1: 'C1', P2: 'C2' } }, explanation: '<strong>Explanation</strong>',
    };
    const preview = renderLitValue(app.renderQuestionPreviewCard(buildQuestionPreviewModel(matching)));
    assert.ok(preview.includes('<em>Author prompt</em>'));
    assert.ok(preview.includes('<b>Author choice</b>'));
    assert.ok(preview.includes('<strong>Explanation</strong>'));
    const mcq = {
      question_id: 1, question_type: 'mcq_single', question_text: 'Pick', option_a: '<b>Option A</b>', option_b: 'B', option_c: 'C', option_d: 'D',
      correct_option: 'A', selected_option: 'A', explanation: '<em>Because</em>', marks: 1, marks_awarded: 1, is_correct: 1,
    };
    app.answerSheet = { student_name: 'Student', status: 'submitted', answers: [mcq] };
    const sheet = renderLitValue(app.renderAnswerSheet());
    assert.ok(sheet.includes('<b>Option A</b>'));
    assert.ok(sheet.includes('<em>Because</em>'));
  } finally { cleanup(); }
});

function orderingPointerHarness(McqApp, pointerType = 'touch') {
  const listeners = new Map();
  const windowListeners = new Map();
  const document = {
    hidden: false,
    addEventListener: (name, listener) => listeners.set(name, listener),
    removeEventListener: (name, listener) => { if (listeners.get(name) === listener) listeners.delete(name); },
    defaultView: {
      addEventListener: (name, listener) => windowListeners.set(name, listener),
      removeEventListener: (name, listener) => { if (windowListeners.get(name) === listener) windowListeners.delete(name); },
    },
  };
  const rows = [0, 1, 2].map((index) => ({ getBoundingClientRect: () => ({ top: index * 60, bottom: (index + 1) * 60 }) }));
  const list = { getBoundingClientRect: () => ({ left: 10, right: 310, top: 0, bottom: 180 }), querySelectorAll: () => rows };
  let captured = null;
  const handle = {
    ownerDocument: document, disabled: false, isConnected: true,
    closest: (selector) => selector === '.student-ordering-list' ? list : null,
    setPointerCapture: (id) => { captured = id; }, hasPointerCapture: (id) => captured === id,
    releasePointerCapture: (id) => { if (captured === id) captured = null; },
  };
  const question = { id: 81, question_type: 'ordering', question_config: { items: ['I1', 'I2', 'I3'].map((id) => ({ id, text: id })) } };
  const order = ['I1', 'I2', 'I3'];
  const app = new McqApp();
  app.page = 'exam';
  app.attempt = { id: 91, status: 'in_progress', questions: [question] };
  app.answerDataByQuestion[question.id] = { order: [...order] };
  const saved = [];
  app.saveStructuredAnswer = (target, value) => { saved.push({ questionId: target.id, ...value }); app.answerDataByQuestion[target.id] = value; };
  const event = (overrides = {}) => ({ pointerType, pointerId: 7, isPrimary: true, button: 0, clientX: 30, clientY: 30, currentTarget: handle, preventDefault() { this.prevented = true; }, ...overrides });
  return { app, question, order, handle, document, listeners, windowListeners, saved, event, captured: () => captured };
}

test('touch and pen handle dragging commits exactly once on valid release without mutating answers during movement', async () => {
  const { McqApp, cleanup } = await loadMcqAppClass();
  try {
    for (const pointerType of ['touch', 'pen']) {
      const h = orderingPointerHarness(McqApp, pointerType);
      assert.equal(h.app.startOrderingPointerDrag(h.event(), h.question, h.order, 0), true);
      assert.equal(h.captured(), 7);
      assert.deepEqual([...h.listeners.keys()].sort(), ['keydown', 'pointercancel', 'pointermove', 'pointerup', 'visibilitychange']);
      h.listeners.get('pointermove')(h.event({ clientY: 150 }));
      assert.equal(h.app.orderingPointerDrag.toIndex, 2);
      assert.equal(h.saved.length, 0, 'Moving only highlights the destination');
      assert.deepEqual(h.app.answerDataByQuestion[81].order, h.order);
      const rendering = renderLitValue(h.app.renderStudentQuestionInput(h.question));
      assert.ok(rendering.includes('data-ordering-drag-handle'));
      assert.ok(rendering.includes('ordering-drag-source'));
      assert.ok(rendering.includes('ordering-drop-target'));
      assert.ok(rendering.includes('Move I1 up'));
      h.listeners.get('pointerup')(h.event({ clientY: 150 }));
      assert.deepEqual(h.saved, [{ questionId: 81, order: ['I2', 'I3', 'I1'] }]);
      assert.equal(h.app.orderingPointerDrag, null);
      assert.equal(h.listeners.size, 0);
      assert.equal(h.windowListeners.size, 0);
      assert.equal(h.captured(), null);
      assert.equal(h.app.finishOrderingPointerDrag(h.event({ clientY: 150 })), false);
      assert.equal(h.saved.length, 1, 'Duplicate pointerup must not resubmit');
    }
  } finally { cleanup(); }
});

test('touch drag cancels on pointercancel, lost capture, Escape, blur, hidden document, navigation or invalid release', async () => {
  const { McqApp, cleanup } = await loadMcqAppClass();
  try {
    const cancellations = [
      (h) => h.listeners.get('pointercancel')(h.event()),
      (h) => h.app.cancelOrderingPointerDrag(h.event()), // lostpointercapture uses this handler
      (h) => h.listeners.get('keydown')({ key: 'Escape', preventDefault() {} }),
      (h) => h.windowListeners.get('blur')({ type: 'blur' }),
      (h) => { h.document.hidden = true; h.listeners.get('visibilitychange')(); },
      (h) => { h.app.currentQuestion = 1; h.listeners.get('pointerup')(h.event({ clientY: 150 })); },
      (h) => { h.app.page = 'home'; h.listeners.get('pointermove')(h.event({ clientY: 150 })); },
      (h) => { h.app.busy = true; h.listeners.get('pointerup')(h.event({ clientY: 150 })); },
      (h) => { h.app.attempt.status = 'submitted'; h.listeners.get('pointerup')(h.event({ clientY: 150 })); },
      (h) => h.listeners.get('pointerup')(h.event({ clientX: 400, clientY: 150 })),
    ];
    for (const cancel of cancellations) {
      const h = orderingPointerHarness(McqApp);
      h.app.startOrderingPointerDrag(h.event(), h.question, h.order, 0);
      h.listeners.get('pointermove')(h.event({ clientY: 150 }));
      cancel(h);
      assert.equal(h.saved.length, 0);
      assert.deepEqual(h.app.answerDataByQuestion[81].order, h.order);
      assert.equal(h.app.orderingPointerDrag, null);
      assert.equal(h.listeners.size, 0);
      assert.equal(h.windowListeners.size, 0);
    }
    const tap = orderingPointerHarness(McqApp);
    tap.app.startOrderingPointerDrag(tap.event(), tap.question, tap.order, 0);
    tap.listeners.get('pointerup')(tap.event({ clientY: 33 }));
    assert.equal(tap.saved.length, 0, 'A small tap below the movement threshold is not a drag');
  } finally { cleanup(); }
});

test('ordering pointer guards preserve normal scrolling, native mouse drag and disabled answer state', async () => {
  const { McqApp, cleanup } = await loadMcqAppClass();
  try {
    for (const overrides of [{ pointerType: 'mouse' }, { isPrimary: false }, { button: 2 }]) {
      const h = orderingPointerHarness(McqApp);
      const event = h.event(overrides);
      assert.equal(h.app.startOrderingPointerDrag(event, h.question, h.order, 0), false);
      assert.equal(event.prevented, undefined, 'Ignored pointers must not suppress scrolling or native mouse behavior');
      assert.equal(h.listeners.size, 0);
    }
    const h = orderingPointerHarness(McqApp);
    h.app.startOrderingPointerDrag(h.event(), h.question, h.order, 0);
    const otherPointer = h.event({ pointerId: 8, clientY: 150 });
    assert.equal(h.app.updateOrderingPointerDrag(otherPointer), false);
    assert.equal(otherPointer.prevented, undefined);
    assert.equal(h.app.finishOrderingPointerDrag(otherPointer), false);
    assert.equal(h.app.cancelOrderingPointerDrag(otherPointer), false);
    assert.equal(h.app.orderingPointerDrag.pointerId, 7);
    h.app.cancelOrderingPointerDrag();
    for (const field of ['busy', 'pendingAnswerSaves', 'submitConfirmOpen', 'questionMoving']) {
      h.app[field] = true;
      assert.equal(h.app.startOrderingPointerDrag(h.event(), h.question, h.order, 0), false);
      assert.equal(h.app.moveOrderingAnswer(h.question, h.order, 0, 1), false);
      const rendering = renderLitValue(h.app.renderStudentQuestionInput(h.question));
      assert.ok(rendering.includes('draggable=false'));
      h.app[field] = false;
    }
    assert.equal(h.app.moveOrderingAnswer(h.question, h.order, 0, 1), true, 'Accessible arrows use the same guarded save operation');
    assert.deepEqual(h.saved.at(-1).order, ['I2', 'I1', 'I3']);
    assert.ok(renderLitValue(h.app.renderStudentQuestionInput(h.question)).includes('draggable=true'), 'Native desktop dragging remains available');
    const css = fs.readFileSync(path.join(root, 'client/src/style.css'), 'utf8');
    assert.match(css, /\.student-ordering-row \.drag-handle\s*\{[^}]*touch-action:\s*none/s);
    assert.ok(!/\.student-ordering-(?:row|list)\s*\{[^}]*touch-action:\s*none/s.test(css), 'Rows and surrounding list must remain scrollable');
  } finally { cleanup(); }
});
