const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const crypto = require('crypto');
const snarkjs = require('snarkjs');
const fs = require('fs');
const rateLimit = require('express-rate-limit');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));

const PORT = Number(process.env.PORT || 3000);
const DB_FILE = process.env.DB_FILE || './vortex.db';
const CONFIGURED_API_KEY = process.env.VORTEX_API_KEY || '';
const ZK_ENABLED = String(process.env.ZK_ENABLED || 'true').toLowerCase() === 'true';
const ZK_VKEY = process.env.ZK_VKEY || './verification_key.json';

const GENESIS_HASH = 'GENESIS_HASH_00000000000000000000000000000000';

const db = new sqlite3.Database(DB_FILE, (err) => {
  if (err) {
    console.error('❌ DB Initialization Error:', err.message);
    process.exit(1);
  }
  db.run('PRAGMA journal_mode = WAL;', (pragmaErr) => {
    if (pragmaErr) console.error('❌ WAL setup error:', pragmaErr.message);
    else console.log('⚡ Connected to VORTEX SQLite Engine [WAL Mode].');
  });
});

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function timingSafeEqualText(a, b) {
  const aa = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  if (aa.length !== bb.length) return false;
  return crypto.timingSafeEqual(aa, bb);
}

function fail(res, status, code, message) {
  return res.status(status).json({ error: code, message });
}

async function init() {
  await run(`CREATE TABLE IF NOT EXISTS agents (
    agent_id TEXT PRIMARY KEY,
    api_key_hash TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'ACTIVE',
    daily_limit REAL NOT NULL DEFAULT 1000.0,
    spent_today REAL NOT NULL DEFAULT 0.0,
    permissions TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`);

  await run(`CREATE TABLE IF NOT EXISTS processed_nonces (
    agent_id TEXT NOT NULL,
    nonce TEXT NOT NULL,
    request_id TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (agent_id, nonce)
  )`);

  await run(`CREATE TABLE IF NOT EXISTS audit_ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    execution_id TEXT UNIQUE NOT NULL,
    agent_id TEXT NOT NULL,
    action TEXT NOT NULL,
    status TEXT NOT NULL,
    request_json TEXT NOT NULL,
    result_json TEXT NOT NULL,
    prev_hash TEXT NOT NULL,
    current_hash TEXT NOT NULL,
    zk_proof_status TEXT NOT NULL,
    timestamp TEXT NOT NULL
  )`);

  const dummyHash = sha256('secret123');
  await run(
    `INSERT OR IGNORE INTO agents
      (agent_id, api_key_hash, permissions, daily_limit, created_at)
     VALUES ('AGENT_01', ?, 'database.write,payments.transfer', 5000.0, ?)`,
    [dummyHash, new Date().toISOString()]
  );
}

async function verifyZk(zkProofData) {
  if (!zkProofData || !zkProofData.proof || !zkProofData.publicSignals) {
    return { status: 'NOT_GENERATED', verified: false };
  }

  if (!ZK_ENABLED) {
    return { status: 'DISABLED', verified: false };
  }

  if (!fs.existsSync(ZK_VKEY)) {
    return {
      status: 'NOT_GENERATED',
      verified: false,
      reason: 'Verification key is missing'
    };
  }

  try {
    const vKey = JSON.parse(fs.readFileSync(ZK_VKEY, 'utf8'));
    const verified = await snarkjs.groth16.verify(
      vKey,
      zkProofData.publicSignals,
      zkProofData.proof
    );

    if (!verified) {
      return { status: 'PROOF_INVALID', verified: false };
    }

    return { status: 'VERIFIED_VALID', verified: true };
  } catch (error) {
    console.error('ZK verification error:', error.message);
    return { status: 'PROOF_ERROR', verified: false };
  }
}

async function atomicCommit({
  agentId,
  nonce,
  requestId,
  action,
  amount,
  executionId,
  requestJson,
  resultJson,
  zkStatus
}) {
  const timestamp = new Date().toISOString();

  await run('BEGIN IMMEDIATE TRANSACTION');

  try {
    // The database primary key enforces this atomically under concurrency.
    try {
      await run(
        `INSERT INTO processed_nonces (agent_id, nonce, request_id, timestamp)
         VALUES (?, ?, ?, ?)`,
        [agentId, nonce, requestId, timestamp]
      );
    } catch (error) {
      if (String(error.message).includes('UNIQUE constraint failed')) {
        const replay = new Error('REPLAY_ATTACK');
        replay.code = 'REPLAY_ATTACK';
        throw replay;
      }
      throw error;
    }

    const agent = await get(
      `SELECT spent_today, daily_limit FROM agents
       WHERE agent_id = ? AND status = 'ACTIVE'`,
      [agentId]
    );

    if (!agent) {
      const error = new Error('Agent is no longer active');
      error.code = 'AGENT_NOT_ACTIVE';
      throw error;
    }

    if (agent.spent_today + amount > agent.daily_limit) {
      const error = new Error('Execution quota exceeded');
      error.code = 'LIMIT_EXCEEDED';
      throw error;
    }

    const last = await get(
      `SELECT current_hash FROM audit_ledger ORDER BY id DESC LIMIT 1`
    );
    const prevHash = last ? last.current_hash : GENESIS_HASH;

    const currentHash = sha256(JSON.stringify({
      executionId,
      agentId,
      action,
      amount,
      requestJson,
      resultJson,
      zkStatus,
      prevHash,
      timestamp
    }));

    await run(
      `UPDATE agents
       SET spent_today = spent_today + ?
       WHERE agent_id = ?`,
      [amount, agentId]
    );

    await run(
      `INSERT INTO audit_ledger
       (execution_id, agent_id, action, status, request_json, result_json,
        prev_hash, current_hash, zk_proof_status, timestamp)
       VALUES (?, ?, ?, 'ALLOWED', ?, ?, ?, ?, ?, ?)`,
      [
        executionId,
        agentId,
        action,
        requestJson,
        resultJson,
        prevHash,
        currentHash,
        zkStatus,
        timestamp
      ]
    );

    await run('COMMIT');

    return { prevHash, currentHash, timestamp };
  } catch (error) {
    try { await run('ROLLBACK'); } catch (_) {}
    throw error;
  }
}

const limiter = rateLimit({
  windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS || 60000),
  limit: Number(process.env.RATE_LIMIT_MAX || 60),
  standardHeaders: true,
  legacyHeaders: false
});
app.use('/api/', limiter);

function requireApiKey(req, res, next) {
  if (!CONFIGURED_API_KEY) {
    return fail(res, 503, 'AUTH_NOT_CONFIGURED', 'VORTEX_API_KEY is not configured');
  }

  const supplied = req.get('x-vortex-api-key') || '';
  if (!timingSafeEqualText(supplied, CONFIGURED_API_KEY)) {
    return fail(res, 401, 'UNAUTHORIZED', 'Invalid API key');
  }

  next();
}

app.get('/api/v1/health', async (_req, res) => {
  res.json({
    ok: true,
    service: 'vortex-gateway',
    zkEnabled: ZK_ENABLED,
    timestamp: new Date().toISOString()
  });
});

app.post('/api/v1/execute', requireApiKey, async (req, res) => {
  const {
    agentId,
    requestId,
    nonce,
    action,
    amount,
    zkProofData
  } = req.body || {};

  if (
    typeof agentId !== 'string' ||
    typeof nonce !== 'string' ||
    typeof action !== 'string'
  ) {
    return fail(res, 400, 'BAD_REQUEST', 'agentId, nonce and action are required strings');
  }

  if (requestId !== undefined && typeof requestId !== 'string') {
    return fail(res, 400, 'BAD_REQUEST', 'requestId must be a string');
  }

  const requestedAmount =
    amount === undefined ? 0 : Number(amount);

  if (!Number.isFinite(requestedAmount) || requestedAmount < 0) {
    return fail(res, 400, 'BAD_AMOUNT', 'amount must be a non-negative finite number');
  }

  const agent = await get(
    `SELECT * FROM agents WHERE agent_id = ? AND status = 'ACTIVE'`,
    [agentId]
  );

  if (!agent) {
    return fail(res, 401, 'UNAUTHORIZED', 'Agent profile invalid or suspended');
  }

  // API-key auth is the gateway credential. Agent records are still explicitly checked.
  const agentKeyHash = sha256(req.get('x-vortex-agent-key') || '');
  if (req.get('x-vortex-agent-key') && !timingSafeEqualText(agent.api_key_hash, agentKeyHash)) {
    return fail(res, 403, 'FORBIDDEN', 'Invalid agent credential');
  }

  const permissions = agent.permissions.split(',').map((x) => x.trim()).filter(Boolean);
  if (!permissions.includes(action)) {
    return fail(res, 403, 'POLICY_VIOLATION', `Action '${action}' blocked by policy`);
  }

  if (agent.spent_today + requestedAmount > agent.daily_limit) {
    return fail(res, 422, 'LIMIT_EXCEEDED', 'Execution quota exceeded');
  }

  const zk = await verifyZk(zkProofData);

  if (zk.status === 'PROOF_INVALID' || zk.status === 'PROOF_ERROR') {
    return fail(res, 400, 'INVALID_ZK_PROOF', 'Groth16 verification failed');
  }

  const executionId =
    `EXEC_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;

  const requestJson = JSON.stringify({
    agentId,
    requestId: requestId || null,
    nonce,
    action,
    amount: requestedAmount
  });

  // This MVP records the controlled execution. It does not claim to have
  // performed an external database/payment side effect.
  const result = {
    accepted: true,
    action,
    amount: requestedAmount
  };

  try {
    const audit = await atomicCommit({
      agentId,
      nonce,
      requestId: requestId || null,
      action,
      amount: requestedAmount,
      executionId,
      requestJson,
      resultJson: JSON.stringify(result),
      zkStatus: zk.status
    });

    return res.status(200).json({
      status: 'SUCCESS',
      executionId,
      agentId,
      actionExecuted: action,
      zkStatus: zk.status,
      cryptographicAudit: audit
    });
  } catch (error) {
    if (error.code === 'REPLAY_ATTACK') {
      return fail(res, 409, 'REPLAY_ATTACK', 'Duplicate nonce detected for this agent');
    }
    if (error.code === 'LIMIT_EXCEEDED') {
      return fail(res, 422, 'LIMIT_EXCEEDED', 'Execution quota exceeded');
    }

    console.error('Atomic execution failed:', error);
    return fail(res, 500, 'EXECUTION_FAILED', 'Execution failed safely');
  }
});

app.get('/api/v1/ledger/verify', requireApiKey, async (_req, res) => {
  try {
    const rows = await all(`SELECT * FROM audit_ledger ORDER BY id ASC`);

    let previousHash = GENESIS_HASH;

    for (const row of rows) {
      if (row.prev_hash !== previousHash) {
        return res.json({
          ledgerIntegrity: 'CORRUPTED_OR_TAMPERED',
          totalRecords: rows.length,
          tamperedRowIndex: row.id,
          reason: 'PREVIOUS_HASH_MISMATCH'
        });
      }

      const expected = sha256(JSON.stringify({
        executionId: row.execution_id,
        agentId: row.agent_id,
        action: row.action,
        amount: JSON.parse(row.request_json).amount,
        requestJson: row.request_json,
        resultJson: row.result_json,
        zkStatus: row.zk_proof_status,
        prevHash: row.prev_hash,
        timestamp: row.timestamp
      }));

      if (row.current_hash !== expected) {
        return res.json({
          ledgerIntegrity: 'CORRUPTED_OR_TAMPERED',
          totalRecords: rows.length,
          tamperedRowIndex: row.id,
          reason: 'CURRENT_HASH_MISMATCH'
        });
      }

      previousHash = row.current_hash;
    }

    return res.json({
      ledgerIntegrity: 'VERIFIED_VALID',
      totalRecords: rows.length,
      tamperedRowIndex: null,
      head: previousHash
    });
  } catch (error) {
    return fail(res, 500, 'LEDGER_VERIFY_FAILED', error.message);
  }
});

app.get('/api/v1/ledger', requireApiKey, async (_req, res) => {
  const rows = await all(`SELECT * FROM audit_ledger ORDER BY id DESC LIMIT 100`);
  res.json({ records: rows });
});

async function main() {
  await init();
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 VORTEX Gateway live on http://0.0.0.0:${PORT}`);
  });
}

main().catch((error) => {
  console.error('❌ Startup failed:', error);
  process.exit(1);
});
