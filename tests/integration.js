require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const API = 'http://localhost:3000';
const MAILHOG = 'http://localhost:8025/api/v2/messages';

const ADMIN_AUTH = process.env.ADMIN_USER ? { headers: { Authorization: 'Basic ' + Buffer.from(`${process.env.ADMIN_USER}:${process.env.ADMIN_PASS}`).toString('base64') } } : {};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function waitFor(conditionFn, timeout = 60000, interval = 1000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const ok = await conditionFn();
    if (ok) return true;
    await sleep(interval);
  }
  return false;
}

async function ensureHealthy() {
  const ok = await waitFor(async () => {
    try { const r = await axios.get(`${API}/health`, { timeout: 2000 }); return r.status === 200; } catch (e) { return false; }
  }, 30000);
  if (!ok) throw new Error('API health check failed');
}

async function testCsvExport() {
  const payload = {
    type: 'CSV_EXPORT',
    priority: 'default',
    payload: { data: [{ id: 1, name: 'Alice', email: 'alice@example.com' }, { id: 2, name: 'Bob', email: 'bob@example.com' }] }
  };
  const create = await axios.post(`${API}/jobs`, payload);
  const jobId = create.data.jobId;
  console.log('CSV job created:', jobId);

  const completed = await waitFor(async () => {
    const r = await axios.get(`${API}/jobs/${jobId}`);
    return r.data.status === 'completed' || r.data.status === 'failed';
  }, 60000, 1000);
  if (!completed) throw new Error('CSV job did not complete in time');

  const r = await axios.get(`${API}/jobs/${jobId}`);
  if (r.data.status !== 'completed') throw new Error('CSV job failed: ' + r.data.error);

  const filePath = path.join(__dirname, '..', 'output', `${jobId}.csv`);
  if (!fs.existsSync(filePath)) throw new Error('CSV file not found: ' + filePath);
  const content = fs.readFileSync(filePath, 'utf8');
  if (!content.includes('id,name,email')) throw new Error('CSV header missing');
  console.log('CSV export verified:', filePath);
}

async function testEmailSend() {
  const payload = {
    type: 'EMAIL_SEND',
    priority: 'default',
    payload: { to: 'user@test.com', subject: 'Job Notification', body: 'Your job has been processed successfully.' }
  };
  const create = await axios.post(`${API}/jobs`, payload);
  const jobId = create.data.jobId;
  console.log('Email job created:', jobId);

  const completed = await waitFor(async () => {
    const r = await axios.get(`${API}/jobs/${jobId}`);
    return r.data.status === 'completed' || r.data.status === 'failed';
  }, 60000, 1000);
  if (!completed) throw new Error('Email job did not complete in time');

  const r = await axios.get(`${API}/jobs/${jobId}`);
  if (r.data.status !== 'completed') throw new Error('Email job failed: ' + r.data.error);

  // Check MailHog for the message
  const seen = await waitFor(async () => {
    const m = await axios.get(MAILHOG);
    const items = m.data.items || [];
    return items.some(it => {
      const sub = it.Content && it.Content.Headers && it.Content.Headers.Subject && it.Content.Headers.Subject[0];
      const to = it.Content && it.Content.Headers && it.Content.Headers.To && it.Content.Headers.To[0];
      return sub === 'Job Notification' && to === 'user@test.com';
    });
  }, 30000, 1000);

  if (!seen) throw new Error('Email not found in MailHog');
  console.log('Email send verified via MailHog');
}

(async () => {
  try {
    console.log('Starting integration tests...');
    await ensureHealthy();
    await testCsvExport();
    await testEmailSend();
    await testFailedJobAndDLQ();
    console.log('All integration tests passed ✅');

async function testFailedJobAndDLQ() {
  const payload = {
    type: 'CSV_EXPORT',
    priority: 'default',
    payload: {} // invalid payload: missing data array
  };
  const create = await axios.post(`${API}/jobs`, payload);
  const jobId = create.data.jobId;
  console.log('Invalid CSV job created (should fail):', jobId);

  const failed = await waitFor(async () => {
    const r = await axios.get(`${API}/jobs/${jobId}`);
    return r.data.status === 'failed';
  }, 60000, 1000);
  if (!failed) throw new Error('Invalid job did not fail in time');

  const r = await axios.get(`${API}/jobs/${jobId}`);
  if (r.data.attempts < 3) throw new Error('Invalid job did not reach 3 attempts');
  if (!r.data.error) throw new Error('Invalid job error missing');

  // Move to DLQ
  await axios.post(`${API}/admin/jobs/${jobId}/dlq`, null, ADMIN_AUTH);
  const r2 = await axios.get(`${API}/jobs/${jobId}`);
  if (!r2.data.error || r2.data.error !== 'moved-to-dlq') throw new Error('Job not moved to DLQ');

  // Check /admin/failed includes it
  const failedList = await axios.get(`${API}/admin/failed`, ADMIN_AUTH);
  if (!failedList.data.jobs.some(j => j.id === jobId)) throw new Error('Job not found in /admin/failed');
  console.log('Failed job and DLQ flow verified for', jobId);
}

async function testAdminUI() {
  const r = await axios.get(`${API}/admin/ui`, ADMIN_AUTH);
  if (!r || !r.data || !r.data.includes('Job Admin')) throw new Error('Admin UI not reachable or content missing');
  console.log('Admin UI verified');
}

    await testAdminUI();
    console.log('All integration tests passed ✅');
    process.exit(0);
  } catch (err) {
    console.error('Integration tests failed:', err.message);
    process.exit(1);
  }
})();
