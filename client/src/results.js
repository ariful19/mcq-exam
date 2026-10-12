const rollOrder = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export function filterAndSortResults(attempts, search = '', sort = 'recent') {
  const query = search.trim().toLocaleLowerCase();
  const results = attempts.filter(attempt => !query
    || String(attempt.student_name ?? '').toLocaleLowerCase().includes(query)
    || String(attempt.roll_number ?? '').toLocaleLowerCase().includes(query));
  if (sort === 'recent') return results;
  const descending = sort.endsWith('-desc');
  return results.sort((left, right) => {
    if (sort.startsWith('score-')) {
      // Unsubmitted attempts belong at the end in either direction.
      if (left.score == null || right.score == null) {
        return left.score == null ? (right.score == null ? 0 : 1) : -1;
      }
      const difference = Number(left.score) - Number(right.score);
      if (difference) return descending ? -difference : difference;
      return rollOrder.compare(String(left.roll_number ?? ''), String(right.roll_number ?? ''));
    }
    const difference = rollOrder.compare(String(left.roll_number ?? ''), String(right.roll_number ?? ''));
    return descending ? -difference : difference;
  });
}
