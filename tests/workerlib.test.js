const { csvFromArray } = require('../src/workerLib');

test('csvFromArray returns empty string for empty array', () => {
  expect(csvFromArray([])).toBe('');
});

test('csvFromArray generates correct CSV with header and rows', () => {
  const data = [{ id: 1, name: 'Alice', email: 'alice@example.com' }, { id: 2, name: 'Bob', email: 'bob@example.com' }];
  const csv = csvFromArray(data);
  expect(csv.split('\n')[0]).toBe('id,name,email');
  expect(csv).toContain('"1","Alice","alice@example.com"');
  expect(csv).toContain('"2","Bob","bob@example.com"');
});

test('csvFromArray handles fields with quotes', () => {
  const data = [{ id: 1, note: 'He said "Hello"', email: 'a@b.com' }];
  const csv = csvFromArray(data);
  expect(csv).toContain('"He said ""Hello"""');
});
