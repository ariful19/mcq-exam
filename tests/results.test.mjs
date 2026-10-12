import test from 'node:test';
import assert from 'node:assert/strict';
import { filterAndSortResults } from '../client/src/results.js';

const attempts = [
  { student_name: 'Alex Hunter', roll_number: '10', score: 2 },
  { student_name: 'Sara Khan', roll_number: '2', score: 10 },
  { student_name: 'Noor Ali', roll_number: 'TEST-12', score: null },
  { student_name: 'Sam Khan', roll_number: 'TEST-3', score: -0.5 },
];
const rolls = values => values.map(value => value.roll_number);

test('results search matches partial names or rolls, ignoring case and surrounding whitespace', () => {
  assert.deepEqual(rolls(filterAndSortResults(attempts, ' KHAN ')), ['2', 'TEST-3']);
  assert.deepEqual(rolls(filterAndSortResults(attempts, 'test-1')), ['TEST-12']);
  assert.deepEqual(filterAndSortResults(attempts, 'nobody'), []);
  assert.deepEqual(filterAndSortResults([], ''), []);
});

test('roll sorting uses numeric order for numeric and mixed roll numbers in both directions', () => {
  assert.deepEqual(rolls(filterAndSortResults(attempts, '', 'roll-asc')), ['2', '10', 'TEST-3', 'TEST-12']);
  assert.deepEqual(rolls(filterAndSortResults(attempts, '', 'roll-desc')), ['TEST-12', 'TEST-3', '10', '2']);
});

test('score sorting handles negative scores, zero, numeric strings and ungraded attempts', () => {
  const values = [...attempts, { student_name: 'Zero', roll_number: '4', score: '0' }];
  assert.deepEqual(rolls(filterAndSortResults(values, '', 'score-asc')), ['TEST-3', '4', '10', '2', 'TEST-12']);
  assert.deepEqual(rolls(filterAndSortResults(values, '', 'score-desc')), ['2', '10', '4', 'TEST-3', 'TEST-12']);
});

test('search and sorting combine without changing original result or CSV order', () => {
  const original = [...attempts];
  assert.deepEqual(rolls(filterAndSortResults(attempts, 'khan', 'score-desc')), ['2', 'TEST-3']);
  filterAndSortResults(attempts, '', 'roll-asc');
  assert.deepEqual(attempts, original);
  assert.deepEqual(filterAndSortResults(attempts), original);
});
