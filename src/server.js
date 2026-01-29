const express = require('express');
const { pool } = require('./db');
const { createClient } = require('redis');
const bodyParser = require('express').json;
const dotenv = require('dotenv');

dotenv.config();

const API_PORT = process.env.API_PORT || 3000;
const REDIS_URL = process.env.REDIS_URL || 'redis://redis:6379';

const app = express();
app.use(bodyParser());
const path = require('path');

// Admin auth middleware (basic)
function adminAuth(req, res, next) {
  const ADMIN_USER = process.env.ADMIN_USER;
  const ADMIN_PASS = process.env.ADMIN_PASS;
  // If not configured, skip auth
  if (!ADMIN_USER || !ADMIN_PASS) return next();

  const auth = req.headers['authorization'];
  if (!auth) {
    res.set('WWW-Authenticate', 'Basic realm="Admin"');
    return res.status(401).send('Authentication required');
  }
  const m = auth.match(/^Basic (.+)$/);
  if (!m) return res.status(401).send('Invalid auth');
  const creds = Buffer.from(m[1], 'base64').toString('utf8').split(':');
  const [user, pass] = creds;
  if (user === ADMIN_USER && pass === ADMIN_PASS) return next();
  res.set('WWW-Authenticate', 'Basic realm="Admin"');
  return res.status(401).send('Invalid credentials');
}

// Protect admin routes and UI
app.use('/admin', adminAuth);

// Serve static admin UI (fallback)
app.use('/admin/ui/', express.static(path.join(__dirname, '..', 'public')));
app.get('/admin/ui', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'admin.html')));

// Redis client used only for enqueueing jobs
const redis = createClient({ url: REDIS_URL });
redis.on('error', (err) => console.error('Redis Client Error', err));

async function start() {
  await redis.connect();

  app.post('/jobs', async (req, res) => {
    try {
      const { type, priority = 'default', payload } = req.body;
      if (!type) return res.status(400).json({ error: 'type is required' });
      if (!payload) return res.status(400).json({ error: 'payload is required' });
      if (!['default', 'high'].includes(priority)) return res.status(400).json({ error: 'priority must be "default" or "high"' });

      const insert = await pool.query(
        'INSERT INTO jobs (type, priority, payload) VALUES ($1, $2, $3) RETURNING id',
        [type, priority, payload]
      );

      const jobId = insert.rows[0].id;

      // Enqueue by pushing job id into the corresponding list
      const queueKey = `queue:${priority === 'high' ? 'high_priority' : 'default'}`;
      await redis.lPush(queueKey, jobId);

      res.status(201).json({ jobId });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'internal error' });
    }
  });

  app.get('/jobs/:id', async (req, res) => {
    try {
      const id = req.params.id;
      const q = await pool.query('SELECT * FROM jobs WHERE id = $1', [id]);
      if (q.rows.length === 0) return res.status(404).json({ error: 'not found' });
      const job = q.rows[0];
      res.json({
        id: job.id,
        type: job.type,
        status: job.status,
        priority: job.priority,
        attempts: job.attempts,
        result: job.result,
        error: job.error,
        createdAt: job.created_at,
        updatedAt: job.updated_at
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'internal error' });
    }
  });

  // Admin: list jobs with optional filters
  app.get('/admin/jobs', async (req, res) => {
    try {
      const { status, type, priority, limit = 50, offset = 0 } = req.query;
      const clauses = [];
      const params = [];
      if (status) { params.push(status); clauses.push(`status = $${params.length}`); }
      if (type) { params.push(type); clauses.push(`type = $${params.length}`); }
      if (priority) { params.push(priority); clauses.push(`priority = $${params.length}`); }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      const q = await pool.query(`SELECT * FROM jobs ${where} ORDER BY created_at DESC LIMIT $${params.length+1} OFFSET $${params.length+2}`, [...params, limit, offset]);
      res.json({ jobs: q.rows });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'internal error' });
    }
  });

  // Admin: retry a failed job
  app.post('/admin/jobs/:id/retry', async (req, res) => {
    try {
      const id = req.params.id;
      const q = await pool.query('SELECT id, status, attempts, priority FROM jobs WHERE id = $1', [id]);
      if (q.rows.length === 0) return res.status(404).json({ error: 'not found' });
      const job = q.rows[0];
      if (job.status !== 'failed') return res.status(400).json({ error: 'job is not failed' });

      await pool.query('UPDATE jobs SET status = $1, attempts = 0, error = NULL, updated_at = NOW() WHERE id = $2', ['pending', id]);
      const queueKey = `queue:${job.priority === 'high' ? 'high_priority' : 'default'}`;
      await redis.lPush(queueKey, id);
      res.json({ ok: true });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'internal error' });
    }
  });

  // Admin: list failed jobs (for monitoring)
  app.get('/admin/failed', async (req, res) => {
    try {
      const { limit = 50, offset = 0 } = req.query;
      const q = await pool.query('SELECT * FROM jobs WHERE status = $1 ORDER BY updated_at DESC LIMIT $2 OFFSET $3', ['failed', limit, offset]);
      res.json({ jobs: q.rows });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'internal error' });
    }
  });

  // Admin: move job to Dead Letter Queue (DLQ)
  app.post('/admin/jobs/:id/dlq', async (req, res) => {
    try {
      const id = req.params.id;
      const q = await pool.query('SELECT id, status, priority FROM jobs WHERE id = $1', [id]);
      if (q.rows.length === 0) return res.status(404).json({ error: 'not found' });
      const job = q.rows[0];

      // Mark as failed and add an error note
      await pool.query('UPDATE jobs SET status = $1, error = $2, updated_at = NOW() WHERE id = $3', ['failed', 'moved-to-dlq', id]);
      // Enqueue into a dedicated DLQ list for manual inspection later
      await redis.lPush('queue:dlq', id);
      res.json({ ok: true });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'internal error' });
    }
  });

  app.get('/health', (req, res) => res.send('ok'));

  app.listen(API_PORT, () => console.log(`API listening on port ${API_PORT}`));
}

start().catch((err) => {
  console.error('Failed to start app', err);
  process.exit(1);
});
