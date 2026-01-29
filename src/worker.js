const { pool, query } = require('./db');
const { createClient } = require('redis');
const dotenv = require('dotenv');
const fs = require('fs').promises;
const path = require('path');
const nodemailer = require('nodemailer');
const { csvFromArray } = require('./workerLib');
const logger = require('./logger');

dotenv.config();

const REDIS_URL = process.env.REDIS_URL || 'redis://redis:6379';
const MAIL_HOST = process.env.MAIL_HOST || 'mailhog';
const MAIL_PORT = parseInt(process.env.MAIL_PORT, 10) || 1025;
const MAIL_FROM = process.env.MAIL_FROM || 'noreply@example.com';

const redis = createClient({ url: REDIS_URL });
redis.on('error', (err) => logger.error('Redis error', { err: err.message }));

let shuttingDown = false;

process.on('SIGINT', () => { logger.info('SIGINT received'); shuttingDown = true; });
process.on('SIGTERM', () => { logger.info('SIGTERM received'); shuttingDown = true; });

async function processJob(jobId) {
  try {
    const { rows } = await pool.query('SELECT * FROM jobs WHERE id = $1', [jobId]);
    if (rows.length === 0) {
      logger.warn(`Job ${jobId} not found`);
      return;
    }
    const job = rows[0];
    if (job.status !== 'pending') {
      logger.info(`Job ${jobId} status is ${job.status}, skipping`);
      return;
    }

    // increment attempts and set to processing
    const updated = await pool.query(
      'UPDATE jobs SET attempts = attempts + 1, status = $1, updated_at = NOW() WHERE id = $2 RETURNING attempts',
      ['processing', jobId]
    );
    const attempts = updated.rows[0].attempts;
    logger.info('Processing job', { jobId, attempts, jobType: job.type });

    if (job.type === 'CSV_EXPORT') {
      const data = job.payload && job.payload.data;
      if (!Array.isArray(data)) throw new Error('payload.data must be an array');
      const csv = csvFromArray(data);
      const outPath = path.join('/usr/src/app/output', `${jobId}.csv`);
      await fs.writeFile(outPath, csv, 'utf8');
      await pool.query('UPDATE jobs SET status = $1, result = $2, updated_at = NOW() WHERE id = $3',
        ['completed', { filePath: outPath }, jobId]);
      logger.info('Job completed (CSV)', { jobId, outPath });
    } else if (job.type === 'EMAIL_SEND') {
      const payload = job.payload || {};
      const { to, subject, body } = payload;
      if (!to || !subject || !body) throw new Error('payload must include to, subject, and body');

      const transporter = nodemailer.createTransport({ host: MAIL_HOST, port: MAIL_PORT, secure: false });
      const info = await transporter.sendMail({ from: MAIL_FROM, to, subject, text: body });
      await pool.query('UPDATE jobs SET status = $1, result = $2, updated_at = NOW() WHERE id = $3',
        ['completed', { messageId: info.messageId }, jobId]);
      logger.info('Job completed (EMAIL)', { jobId, messageId: info.messageId });
    } else {
      throw new Error(`Unknown job type: ${job.type}`);
    }
  } catch (err) {
    logger.error(`Error processing job ${jobId}: ${err.message}`, { jobId });
    // Get latest attempts to decide
    const { rows } = await pool.query('SELECT attempts, priority FROM jobs WHERE id = $1', [jobId]);
    if (rows.length === 0) return;
    const { attempts, priority } = rows[0];
    if (attempts >= 3) {
      await pool.query('UPDATE jobs SET status = $1, error = $2, updated_at = NOW() WHERE id = $3', ['failed', err.message, jobId]);
      logger.info('Job marked as failed', { jobId, attempts });
    } else {
      // set back to pending and re-enqueue
      await pool.query('UPDATE jobs SET status = $1, updated_at = NOW() WHERE id = $2', ['pending', jobId]);
      const queueKey = `queue:${priority === 'high' ? 'high_priority' : 'default'}`;
      await redis.lPush(queueKey, jobId);
      logger.info('Job re-enqueued for retry', { jobId, attempts });
    }
  }
}

async function run() {
  await redis.connect();
  console.log('Worker connected to Redis, waiting for jobs...');

  while (!shuttingDown) {
    try {
      // BLPOP will prefer the first key if items exist there, enforcing priority
      const res = await redis.blPop(['queue:high_priority', 'queue:default'], 0);
      if (!res) continue;
      const jobId = res.element || res[1] || res;
      // Process job
      await processJob(jobId);
    } catch (err) {
      console.error('Worker loop error', err);
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  console.log('Worker shutting down gracefully');
  await redis.disconnect();
  process.exit(0);
}

run().catch(err => {
  console.error('Worker failed to start', err);
  process.exit(1);
});
