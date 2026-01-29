#!/usr/bin/env node
const { execSync } = require('child_process');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForApi(url, timeoutSeconds = 120) {
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    try {
      const res = await axios.get(url);
      if (res.status === 200) return true;
    } catch (e) {
      // ignore
    }
    process.stdout.write('.');
    await sleep(2000);
  }
  return false;
}

async function pollJobStatus(jobId, timeoutSeconds = 120) {
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    const res = await axios.get(`http://localhost:3000/jobs/${jobId}`);
    const s = res.data.status;
    process.stdout.write(`${s} `);
    if (s === 'completed' || s === 'failed') return res.data;
    await sleep(2000);
  }
  throw new Error('job timed out');
}

(async function main() {
  try {
    console.log('Starting smoke test: bringing up compose stack...');
    execSync('docker-compose up --build -d', { stdio: 'inherit' });

    process.stdout.write('Waiting for API ');
    const healthy = await waitForApi('http://localhost:3000/health', 120);
    if (!healthy) throw new Error('API did not become healthy in time');
    console.log('\nAPI is healthy');

    // EMAIL job
    console.log('Posting EMAIL_SEND job...');
    const emailResp = await axios.post('http://localhost:3000/jobs', {
      type: 'EMAIL_SEND',
      priority: 'high',
      payload: { to: 'smoke@example.com', subject: 'Smoke test', body: 'Hello from smoke test' }
    });
    const emailJobId = emailResp.data.jobId;
    console.log('Email job id:', emailJobId);
    console.log('Polling email job status:');
    const emailJob = await pollJobStatus(emailJobId, 120);
    console.log('\nEmail job final status:', emailJob.status);
    if (emailJob.status !== 'completed') throw new Error('Email job did not complete successfully');

    // Check MailHog for message
    console.log('Checking MailHog for message...');
    let found = false;
    for (let i = 0; i < 30; i++) {
      const m = await axios.get('http://localhost:8025/api/v2/messages?limit=5');
      const msgs = (m.data && m.data.items) || [];
      if (msgs.some(msg => (msg.Content && msg.Content.Headers && msg.Content.Headers.To && msg.Content.Headers.To.join('\n') || '').includes('smoke@example.com'))) {
        found = true; break;
      }
      process.stdout.write('.');
      await sleep(2000);
    }
    if (!found) throw new Error('MailHog did not receive the email');
    console.log('\nMailHog received the message');

    // CSV job
    console.log('Posting CSV_EXPORT job...');
    const csvResp = await axios.post('http://localhost:3000/jobs', {
      type: 'CSV_EXPORT',
      priority: 'default',
      payload: { data: [{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }] }
    });
    const csvJobId = csvResp.data.jobId;
    console.log('CSV job id:', csvJobId);
    console.log('Polling CSV job status:');
    const csvJob = await pollJobStatus(csvJobId, 120);
    console.log('\nCSV job final status:', csvJob.status);
    if (csvJob.status !== 'completed') throw new Error('CSV job did not complete successfully');

    // Check output file
    const outPath = path.join(__dirname, '..', 'output', `${csvJobId}.csv`);
    if (!fs.existsSync(outPath)) throw new Error(`CSV file not found at ${outPath}`);
    const stat = fs.statSync(outPath);
    if (stat.size === 0) throw new Error('CSV file is empty');
    console.log('CSV file exists and is non-empty:', outPath);

    console.log('\nSmoke test finished SUCCESSFULLY ✅');
    process.exit(0);
  } catch (err) {
    console.error('\nSmoke test FAILED ❌', err.message || err);
    console.error(err.stack || '');
    process.exit(2);
  }
})();
