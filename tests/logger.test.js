const logger = require('../src/logger');

describe('logger', () => {
  let origLog, origErr;

  beforeEach(() => {
    origLog = console.log;
    origErr = console.error;
  });

  afterEach(() => {
    console.log = origLog;
    console.error = origErr;
  });

  test('info logs JSON with timestamp and level', () => {
    let out;
    console.log = (s) => { out = s; };
    logger.info('test message', { jobId: '123' });
    const parsed = JSON.parse(out);
    expect(parsed.level).toBe('info');
    expect(parsed.message).toBe('test message');
    expect(parsed.jobId).toBe('123');
    expect(parsed.timestamp).toBeDefined();
  });

  test('error calls console.error', () => {
    let out;
    console.error = (s) => { out = s; };
    logger.error('boom', { jobId: 'x' });
    const parsed = JSON.parse(out);
    expect(parsed.level).toBe('error');
    expect(parsed.message).toBe('boom');
    expect(parsed.jobId).toBe('x');
  });
});