import { hydrateQuestionRow, validateQuestionStimulus } from './question-types.js';

// Saved questions own their material snapshot. Reusing a catalog entry copies that
// snapshot and its media URL, never creates a mutable join or uploads a new asset.
export function listReusableStimuli(rows) {
  const bySnapshot = new Map();
  const usedIds = new Set();
  for (const row of rows) {
    const { stimulus, errors } = validateQuestionStimulus(hydrateQuestionRow(row)?.question_config?.stimulus);
    if (!stimulus || errors.length) continue;
    const { id, ...content } = stimulus;
    const key = JSON.stringify(content);
    const existing = bySnapshot.get(key);
    if (existing) { existing.question_count += 1; continue; }
    const reference = id && !usedIds.has(id) ? id : `stimulus-q${row.id}`;
    usedIds.add(reference);
    bySnapshot.set(key, { id: reference, ...content, question_count: 1 });
  }
  return [...bySnapshot.values()];
}
