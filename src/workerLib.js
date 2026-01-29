const { stringify } = require('querystring');

function csvFromArray(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return '';
  const cols = Object.keys(arr[0]);
  const header = cols.join(',');
  const rows = arr.map(r => cols.map(c => {
    const v = r[c] === undefined || r[c] === null ? '' : String(r[c]).replace(/"/g, '""');
    return `"${v}"`;
  }).join(','));
  return [header, ...rows].join('\n');
}

module.exports = { csvFromArray };
