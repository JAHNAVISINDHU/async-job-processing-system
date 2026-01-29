// Simple structured logger
function fmt(level, message, meta = {}) {
  const entry = Object.assign({ level, message, timestamp: new Date().toISOString() }, meta);
  const out = JSON.stringify(entry);
  if (level === 'error') {
    console.error(out);
  } else {
    console.log(out);
  }
}

module.exports = {
  info: (message, meta) => fmt('info', message, meta),
  warn: (message, meta) => fmt('warn', message, meta),
  error: (message, meta) => fmt('error', message, meta),
};
