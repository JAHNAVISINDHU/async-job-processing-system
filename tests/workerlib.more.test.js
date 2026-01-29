const { csvFromArray } = require('../src/workerLib');

test('csvFromArray returns empty string for non-array inputs', () => {
  expect(csvFromArray(null)).toBe('');
  expect(csvFromArray(undefined)).toBe('');
  expect(csvFromArray({})).toBe('');
});

test('csvFromArray handles heterogeneous keys (missing values become empty)', () => {
  const data = [{ id: 1, a: 'x' }, { id: 2, b: 'y' }];
  const csv = csvFromArray(data);
  const lines = csv.split('\n');
  // header should be keys of first object
  expect(lines[0]).toBe('id,a');
  // second row should have empty for 'a' (since second object has a different key)
  expect(lines[2]).toContain('\"2\",\"\"');
});

test('csvFromArray handles nested objects by stringifying', () => {
  const data = [{ id: 1, meta: { x: 1 } }];
  const csv = csvFromArray(data);
  expect(csv).toContain('"[object Object]"');
});
