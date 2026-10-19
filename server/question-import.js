import { normalizeQuestion } from './question-types.js';

export const QUESTION_WORKBOOK_VERSION = 2;
export const QUESTION_WORKBOOK_HEADERS = Object.freeze([
  'Question', 'Question Type', 'Option A', 'Option B', 'Option C', 'Option D',
  'Correct Answer', 'Category', 'Difficulty', 'Explanation', 'Question Config',
  'Answer Key', 'Media', 'Marks',
]);
const FORMAT = 'Northstar question workbook';
const MAX_QUESTIONS = 900;

const samples = [
  { Question: 'What is the <u>capital</u> of Bangladesh?', 'Question Type': 'mcq_single', 'Option A': '<b>Dhaka</b>', 'Option B': 'Chattogram', 'Option C': 'Sylhet', 'Option D': 'Rajshahi', 'Correct Answer': 'A', Category: 'Geography', Marks: 1 },
  { Question: 'Select the prime numbers.', 'Question Type': 'mcq_multi', 'Option A': '2', 'Option B': '3', 'Option C': '4', 'Option D': '6', 'Correct Answer': 'A, B', Category: 'Mathematics', Marks: 2 },
  { Question: 'The Earth revolves around the Sun.', 'Question Type': 'true_false', 'Correct Answer': 'True', Category: 'Science', Marks: 1 },
  { Question: 'Is water composed of hydrogen and oxygen?', 'Question Type': 'yes_no', 'Correct Answer': 'Yes', Category: 'Science', Marks: 1 },
  { Question: 'Water is [blank1]; table salt is [blank2].', 'Question Type': 'fill_blank', Category: 'Chemistry', 'Question Config': JSON.stringify({ blanks: [{ id: 'B1', label: 'Water' }, { id: 'B2', label: 'Table salt' }], case_sensitive: true }), 'Answer Key': JSON.stringify({ blanks: { B1: ['H2O', 'H₂O'], B2: ['NaCl'] } }), Marks: 2 },
  { Question: 'What is the powerhouse of the cell?', 'Question Type': 'short_answer', 'Correct Answer': 'Mitochondria|Mitochondrion', Category: 'Biology', Marks: 1 },
  { Question: 'What is standard gravity on Earth?', 'Question Type': 'numeric', 'Correct Answer': '9.8', Category: 'Physics', 'Question Config': JSON.stringify({ tolerance: 0.1, unit: 'm/s²' }), 'Answer Key': JSON.stringify({ value: 9.8, tolerance: 0.1 }), Marks: 2 },
  { Question: 'Match formulas to common compound names.', 'Question Type': 'matching', Category: 'Chemistry', 'Question Config': JSON.stringify({ prompts: [{ id: 'P1', text: 'H2O' }, { id: 'P2', text: 'NaCl' }], choices: [{ id: 'C1', text: 'Salt' }, { id: 'C2', text: 'Water' }] }), 'Answer Key': JSON.stringify({ pairs: { P1: 'C2', P2: 'C1' } }), Marks: 2 },
  { Question: 'Arrange the butterfly lifecycle stages.', 'Question Type': 'ordering', Category: 'Biology', 'Question Config': JSON.stringify({ items: [{ id: 'I1', text: 'Egg' }, { id: 'I2', text: 'Caterpillar' }, { id: 'I3', text: 'Pupa' }, { id: 'I4', text: 'Butterfly' }] }), 'Answer Key': JSON.stringify({ correct_order: ['I1', 'I2', 'I3', 'I4'] }), Marks: 2 },
];

export function createQuestionWorkbook(XLSX) {
  const book = XLSX.utils.book_new();
  book.Props = { Title: 'Northstar question import template', Subject: `Question workbook version ${QUESTION_WORKBOOK_VERSION}` };
  const sheet = XLSX.utils.aoa_to_sheet([
    QUESTION_WORKBOOK_HEADERS,
    ...samples.map((sample) => QUESTION_WORKBOOK_HEADERS.map((header) => sample[header] ?? '')),
  ]);
  sheet['!cols'] = QUESTION_WORKBOOK_HEADERS.map((header) => ({ wch: Math.max(header.length + 2, 20) }));
  XLSX.utils.book_append_sheet(book, sheet, 'Questions');
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([
    [FORMAT, 'Version', QUESTION_WORKBOOK_VERSION],
    ['Instructions', 'Replace the example rows. You may add more question worksheets; every populated question worksheet is validated before any question is saved.'],
    ['Legacy compatibility', 'The original Question, Option A–D, Correct Answer, Category template remains valid. Missing Question Type means single-choice MCQ.'],
    ['Question Type', 'mcq_single, mcq_multi, true_false, yes_no, fill_blank, short_answer, numeric, matching, ordering'],
    ['Category', 'Subject for this row. Blank Category uses the subject selected at upload. Subject is also accepted as a column name.'],
    ['Marks', 'A positive number up to 1000 (defaults to 1); copied into an examination when selected. A blank cell preserves default_marks from Question Config when supplied.'],
    ['Formatting', 'Use <b>, <i>, <u>, <s> or <del>, and <br> in prompt and choice text. Other HTML is sanitized. Plain text is supported.'],
    ['Question Config / Answer Key', 'JSON objects, as in the examples. Blank answer variants are exact matches with Unicode normalization and trimming; configure case_sensitive explicitly. Ordering keys use stable item IDs.'],
    ['Media', 'Optional JSON: {"type":"image","placeholder":true} or {"type":"audio","placeholder":true}. Attach media before publishing. No video or student uploads.'],
    ['Limits', `At most ${MAX_QUESTIONS} question rows across the entire workbook. An error in any row or worksheet prevents the whole import.`],
  ]), 'Instructions');
  return book;
}

/** Read all question sheets, collecting diagnostics before callers write anything. */
export function parseQuestionWorkbook(book, XLSX, fallbackSubject = '') {
  const questions = [];
  const errors = [];
  let populatedRows = 0;
  for (const sheetName of book.SheetNames || []) {
    const sheet = book.Sheets[sheetName];
    const rowOffset = sheet?.['!ref'] ? XLSX.utils.decode_range(sheet['!ref']).s.r : 0;
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false });
    if (!rows.some((row) => row.some((cell) => String(cell ?? '').trim()))) continue;
    const location = (row) => `Worksheet "${sheetName}", Row ${row + rowOffset}`;
    if (sheetName === 'Instructions' && rows[0]?.[0] === FORMAT) {
      if (rows[0]?.[1] !== 'Version' || Number(rows[0]?.[2]) !== QUESTION_WORKBOOK_VERSION) {
        errors.push(`${location(1)}: Unsupported workbook version. Download the current version ${QUESTION_WORKBOOK_VERSION} template.`);
      }
      continue;
    }
    const aliases = { subject: 'category', 'correct option': 'correct answer' };
    const headers = (rows[0] || []).map((header) => {
      const normalized = String(header ?? '').trim().toLowerCase();
      return aliases[normalized] || normalized;
    });
    const indexes = new Map();
    headers.forEach((header, index) => {
      if (!header) return;
      if (indexes.has(header)) errors.push(`${location(1)}: Duplicate column "${header}". Keep one unambiguous column.`);
      indexes.set(header, index);
    });
    const extensible = ['question type', 'question config', 'answer key'].some((header) => indexes.has(header));
    const required = extensible ? ['Question'] : ['Question', 'Option A', 'Option B', 'Option C', 'Option D', 'Correct Answer'];
    const missing = required.filter((header) => !indexes.has(header.toLowerCase()));
    if (missing.length) {
      errors.push(`${location(1)}: Missing required columns: ${missing.join(', ')}.`);
      continue;
    }
    for (let index = 1; index < rows.length; index += 1) {
      const cells = rows[index];
      if (!cells.some((cell) => String(cell ?? '').trim())) continue;
      populatedRows += 1;
      if (populatedRows > MAX_QUESTIONS) continue;
      const input = Object.fromEntries(QUESTION_WORKBOOK_HEADERS.map((header) => {
        const column = indexes.get(header.toLowerCase());
        return [header, column === undefined ? '' : cells[column] ?? ''];
      }));
      if (!String(input.Marks ?? '').trim()) delete input.Marks;
      if (!String(input.Category ?? '').trim()) input.Category = String(fallbackSubject).trim();
      const { question, errors: rowErrors } = normalizeQuestion(input);
      errors.push(...rowErrors.map((error) => `${location(index + 1)}: ${error}`));
      if (!rowErrors.length) questions.push(question);
    }
  }
  if (populatedRows > MAX_QUESTIONS) errors.push(`The workbook may contain at most ${MAX_QUESTIONS} question rows across all worksheets.`);
  if (!questions.length && !errors.length) errors.push('No populated question rows were found.');
  return { questions: errors.length ? [] : questions, errors };
}
