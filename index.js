const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const rateLimit = require('express-rate-limit');
const snarkjs = require('snarkjs');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const PORT = Number(process.env.PORT || 10000);
const DB_FILE = process.env.DB_FILE || './data/vortex.db';
const API_KEY = process.env.VORTEX_API_KEY || '';
const ZK_ENABLED = String(process.env.ZK_ENABLED ?? 'true').toLowerCase() === 'true';
const ZK_WASM = process.env.ZK_WASM || './zk/build/vortex_js/vortex.wasm';
const ZK_ZKEY = process.env.ZK_ZKEY || './zk/build/vortex_final.zkey';
const ZK_VKEY = process.env.ZK_VKEY || './zk/build/verification_key.json';
const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';
const GENESIS_HASH = 'GENESIS_HASH_00000000000000000000000000000000';

fs.mkdirSync(path.dirname(path.resolve(DB_FILE)), { recursive: true });
const db = new sqlite3.Database(DB_FILE);

function run(sql, params = []) { return new Promise((resolve, reject) => db.run(sql, params, function(err){ err ? reject(err) : resolve(this); })); }
function get(sql, params = []) { return new Promise((resolve, reject) => db.get(sql, params, (err,row)=>err?reject(err):resolve(row))); }
function all(sql, params = []) { return new Promise((resolve, reject) => db.all(sql, params, (err,rows)=>err?reject(err):resolve(rows))); }
function sha256(value) { return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex'); }
function hmac(value) { return crypto.createHmac('sha256', API_KEY || 'vortex-bootstrap').update(String(value)).digest('hex'); }
function safeEqual(a,b){ const aa=Buffer.from(String(a||'')); const bb=Buffer.from(String(b||'')); return aa.length===bb.length && crypto.timingSafeEqual(aa,bb); }
function fail(res,status,error,message,details){ return res.status(status).json({ ok:false,error,message,...(details?{details}: {}) }); }
function now(){ return new Date().toISOString(); }
function id(prefix){ return `${prefix}_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`; }
function normalizeAction(action){ return String(action||'').trim().toLowerCase(); }
function validNonce(n){ return typeof n==='string' && /^[A-Za-z0-9._:-]{8,128}$/.test(n); }
function amountNumber(x){ if(x===undefined || x===null || x==='') return 0; const n=Number(x); return Number.isFinite(n)&&n>=0&&n<=1e9?n:null; }

async function init(){
  await run('PRAGMA journal_mode=WAL');
  await run('PRAGMA foreign_keys=ON');
  await run(`CREATE TABLE IF NOT EXISTS agents(
    agent_id TEXT PRIMARY KEY, api_key_hash TEXT NOT NULL, status TEXT NOT NULL,
    permissions TEXT NOT NULL, daily_limit REAL NOT NULL, spent_today REAL NOT NULL DEFAULT 0,
    spend_period TEXT NOT NULL, created_at TEXT NOT NULL
  )`);
  await run(`CREATE TABLE IF NOT EXISTS processed_nonces(
    agent_id TEXT NOT NULL, nonce TEXT NOT NULL, request_id TEXT,
    created_at TEXT NOT NULL, PRIMARY KEY(agent_id,nonce)
  )`);
  await run(`CREATE TABLE IF NOT EXISTS executions(
    execution_id TEXT PRIMARY KEY, request_id TEXT UNIQUE, agent_id TEXT NOT NULL,
    action TEXT NOT NULL, amount REAL NOT NULL, status TEXT NOT NULL,
    result_json TEXT NOT NULL, created_at TEXT NOT NULL
  )`);
  await run(`CREATE TABLE IF NOT EXISTS audit_ledger(
    id INTEGER PRIMARY KEY AUTOINCREMENT, execution_id TEXT UNIQUE NOT NULL,
    agent_id TEXT NOT NULL, action TEXT NOT NULL, status TEXT NOT NULL,
    request_json TEXT NOT NULL, result_json TEXT NOT NULL, zk_status TEXT NOT NULL,
    settlement_status TEXT NOT NULL, prev_hash TEXT NOT NULL, current_hash TEXT NOT NULL,
    timestamp TEXT NOT NULL
  )`);
  await run(`CREATE TABLE IF NOT EXISTS action_events(
    event_id TEXT PRIMARY KEY, execution_id TEXT NOT NULL, action TEXT NOT NULL,
    payload_json TEXT NOT NULL, created_at TEXT NOT NULL
  )`);
  await run(`CREATE TABLE IF NOT EXISTS settlements(
    settlement_id TEXT PRIMARY KEY, execution_id TEXT NOT NULL, provider TEXT NOT NULL,
    status TEXT NOT NULL, tx_signature TEXT, error TEXT, created_at TEXT NOT NULL
  )`);
  await run(`CREATE INDEX IF NOT EXISTS idx_ledger_created ON audit_ledger(id DESC)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_exec_agent ON executions(agent_id,created_at DESC)`);

  const agentKey = process.env.AGENT_01_KEY || '';
  if(agentKey){
    const period = new Date().toISOString().slice(0,10);
    await run(`INSERT INTO agents(agent_id,api_key_hash,status,permissions,daily_limit,spent_today,spend_period,created_at)
      VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(agent_id) DO UPDATE SET api_key_hash=excluded.api_key_hash,status='ACTIVE',permissions=excluded.permissions,daily_limit=excluded.daily_limit`,
      ['AGENT_01', hmac(agentKey), 'ACTIVE', 'database.write,agent.action,payments.transfer', 5000, 0, period, now()]);
  }
}

const limiter = rateLimit({ windowMs:Number(process.env.RATE_LIMIT_WINDOW_MS||60000), limit:Number(process.env.RATE_LIMIT_MAX||60), standardHeaders:true, legacyHeaders:false });
app.use('/api/', limiter);

function requireGateway(req,res,next){
  if(!API_KEY) return fail(res,503,'AUTH_NOT_CONFIGURED','VORTEX_API_KEY is not configured');
  if(!safeEqual(req.get('x-vortex-api-key')||'', API_KEY)) return fail(res,401,'UNAUTHORIZED','Invalid gateway credential');
  next();
}
async function getAgent(req,res,agentId){
  const agent=await get(`SELECT * FROM agents WHERE agent_id=? AND status='ACTIVE'`,[agentId]);
  if(!agent) return fail(res,401,'AGENT_UNAUTHORIZED','Unknown or inactive agent');
  const presented=req.get('x-vortex-agent-key')||'';
  if(!presented) return fail(res,401,'AGENT_CREDENTIAL_REQUIRED','x-vortex-agent-key is required');
  if(!safeEqual(agent.api_key_hash,hmac(presented))) return fail(res,403,'AGENT_CREDENTIAL_INVALID','Invalid agent credential');
  return agent;
}

async function verifyZK(data){
  if(!ZK_ENABLED) return {status:'DISABLED',verified:false};
  if(!data || !data.proof || !Array.isArray(data.publicSignals)) return {status:'NOT_GENERATED',verified:false};
  if(!fs.existsSync(path.resolve(ZK_VKEY))) return {status:'NOT_GENERATED',verified:false,reason:'verification key missing'};
  try{
    const vkey=JSON.parse(fs.readFileSync(path.resolve(ZK_VKEY),'utf8'));
    const verified=await snarkjs.groth16.verify(vkey,data.publicSignals,data.proof);
    return verified?{status:'VERIFIED_VALID',verified:true}:{status:'PROOF_INVALID',verified:false};
  }catch(e){ return {status:'PROOF_ERROR',verified:false,reason:e.message}; }
}

async function proveZK(a,b){
  if(!ZK_ENABLED) throw new Error('ZK_DISABLED');
  const wasm=path.resolve(ZK_WASM), zkey=path.resolve(ZK_ZKEY);
  if(!fs.existsSync(wasm)||!fs.existsSync(zkey)) throw new Error('ZK_ARTIFACTS_MISSING');
  const {proof,publicSignals}=await snarkjs.groth16.fullProve({a:String(a),b:String(b)},wasm,zkey);
  const verification=await verifyZK({proof,publicSignals});
  if(!verification.verified) throw new Error('SELF_VERIFICATION_FAILED');
  return {proof,publicSignals,verification};
}

async function executeAdapter(action,payload,executionId){
  // Controlled internal side-effect: records an execution event. External effects remain adapters.
  const eventId=id('EVENT');
  await run(`INSERT INTO action_events(event_id,execution_id,action,payload_json,created_at) VALUES(?,?,?,?,?)`,[eventId,executionId,action,JSON.stringify(payload||{}),now()]);
  return {executed:true,eventId,provider:'VORTEX_CONTROLLED_RUNTIME'};
}

async function atomicExecution({agent,agentId,nonce,requestId,action,amount,executionId,requestJson,resultJson,zkStatus,settlementStatus}){
  const timestamp=now();
  await run('BEGIN IMMEDIATE TRANSACTION');
  try{
    try{ await run(`INSERT INTO processed_nonces(agent_id,nonce,request_id,created_at) VALUES(?,?,?,?)`,[agentId,nonce,requestId,timestamp]); }
    catch(e){ if(String(e.message).includes('UNIQUE constraint failed')){const x=new Error('REPLAY_ATTACK');x.code='REPLAY_ATTACK';throw x;} throw e; }
    const current=await get(`SELECT spent_today,spend_period,daily_limit FROM agents WHERE agent_id=? AND status='ACTIVE'`,[agentId]);
    if(!current){const x=new Error('AGENT_NOT_ACTIVE');x.code='AGENT_NOT_ACTIVE';throw x;}
    let spent=Number(current.spent_today); const period=timestamp.slice(0,10);
    if(current.spend_period!==period) spent=0;
    if(spent+amount>Number(current.daily_limit)){const x=new Error('LIMIT_EXCEEDED');x.code='LIMIT_EXCEEDED';throw x;}
    const last=await get(`SELECT current_hash FROM audit_ledger ORDER BY id DESC LIMIT 1`);
    const prevHash=last?last.current_hash:GENESIS_HASH;
    const currentHash=sha256(JSON.stringify({executionId,agentId,action,amount,requestJson,resultJson,zkStatus,settlementStatus,prevHash,timestamp}));
    await run(`UPDATE agents SET spent_today=?,spend_period=? WHERE agent_id=?`,[spent+amount,period,agentId]);
    await run(`INSERT INTO executions(execution_id,request_id,agent_id,action,amount,status,result_json,created_at) VALUES(?,?,?,?,?,?,?,?)`,[executionId,requestId,agentId,action,amount,'SUCCESS',resultJson,timestamp]);
    await run(`INSERT INTO audit_ledger(execution_id,agent_id,action,status,request_json,result_json,zk_status,settlement_status,prev_hash,current_hash,timestamp) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,[executionId,agentId,action,'SUCCESS',requestJson,resultJson,zkStatus,settlementStatus,prevHash,currentHash,timestamp]);
    await run('COMMIT');
    return {timestamp,prevHash,currentHash};
  }catch(e){ try{await run('ROLLBACK')}catch(_){} throw e; }
}

app.get('/',(_req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
app.get('/api/v1/health',async(_req,res)=>{
  const ledger=await get(`SELECT COUNT(*) AS count FROM audit_ledger`);
  const zkArtifacts=fs.existsSync(path.resolve(ZK_VKEY))&&fs.existsSync(path.resolve(ZK_ZKEY))&&fs.existsSync(path.resolve(ZK_WASM));
  res.json({ok:true,service:'vortex-agent-gateway',version:'2.0.0',status:'LIVE',zkEnabled:ZK_ENABLED,zkArtifacts,ledgerRecords:ledger.count,timestamp:now()});
});
app.get('/api/v1/public/summary',async(_req,res)=>{
  const executions=await get(`SELECT COUNT(*) AS n FROM executions`); const agents=await get(`SELECT COUNT(*) AS n FROM agents WHERE status='ACTIVE'`); const events=await get(`SELECT COUNT(*) AS n FROM action_events`);
  res.json({ok:true,agents:agents.n,executions:executions.n,events:events.n,product:'VORTEX Agent Trust & Control Infrastructure'});
});

app.post('/api/v1/zk/prove',requireGateway,async(req,res)=>{
  const a=Number(req.body?.a),b=Number(req.body?.b);
  if(!Number.isInteger(a)||!Number.isInteger(b)||a<0||b<0||a>1000000||b>1000000) return fail(res,400,'BAD_INPUT','a and b must be bounded non-negative integers');
  try{ const result=await proveZK(a,b); return res.json({ok:true,a,b,publicSignals:result.publicSignals,proof:result.proof,verification:result.verification}); }
  catch(e){ return fail(res,503,'ZK_UNAVAILABLE',e.message); }
});

app.post('/api/v1/execute',requireGateway,async(req,res)=>{
  const body=req.body||{}; const {agentId,requestId,nonce}=body; const action=normalizeAction(body.action); const amount=amountNumber(body.amount);
  if(typeof agentId!=='string'||typeof action!=='string'||!action||!validNonce(nonce)) return fail(res,400,'BAD_REQUEST','agentId, action and a valid nonce are required');
  if(requestId!==undefined && (typeof requestId!=='string'||requestId.length>128)) return fail(res,400,'BAD_REQUEST','requestId must be a string <=128 chars');
  if(amount===null) return fail(res,400,'BAD_AMOUNT','amount must be a finite non-negative number <= 1e9');
  const agent=await getAgent(req,res,agentId); if(!agent || agent.headersSent) return;
  const permissions=agent.permissions.split(',').map(x=>x.trim()).filter(Boolean);
  if(!permissions.includes(action)) return fail(res,403,'POLICY_VIOLATION',`Action '${action}' blocked by policy`);
  const zk=await verifyZK(body.zkProofData);
  if(zk.status==='PROOF_INVALID'||zk.status==='PROOF_ERROR') return fail(res,400,'INVALID_ZK_PROOF','Groth16 verification failed');
  const executionId=id('EXEC');
  const requestJson=JSON.stringify({agentId,requestId:requestId||null,nonce,action,amount,payload:body.payload||{}});
  let adapter;
  try{ adapter=await executeAdapter(action,body.payload||{},executionId); }
  catch(e){ return fail(res,500,'ACTION_FAILED','Controlled action failed safely'); }
  const result={accepted:true,action,amount,adapter};
  try{
    const audit=await atomicExecution({agent,agentId,nonce,requestId:requestId||null,action,amount,executionId,requestJson,resultJson:JSON.stringify(result),zkStatus:zk.status,settlementStatus:'DISABLED'});
    return res.json({ok:true,status:'SUCCESS',executionId,agentId,actionExecuted:action,zkStatus:zk.status,settlementStatus:'DISABLED',cryptographicAudit:audit,result});
  }catch(e){
    if(e.code==='REPLAY_ATTACK') return fail(res,409,'REPLAY_ATTACK','Duplicate nonce detected for this agent');
    if(e.code==='LIMIT_EXCEEDED') return fail(res,422,'LIMIT_EXCEEDED','Execution quota exceeded');
    console.error(e); return fail(res,500,'EXECUTION_FAILED','Execution rolled back safely');
  }
});

app.get('/api/v1/ledger',requireGateway,async(_req,res)=>{ const rows=await all(`SELECT * FROM audit_ledger ORDER BY id DESC LIMIT 100`); res.json({ok:true,records:rows}); });
app.get('/api/v1/ledger/verify',requireGateway,async(_req,res)=>{
  try{
    const rows=await all(`SELECT * FROM audit_ledger ORDER BY id ASC`); let previous=GENESIS_HASH;
    for(const row of rows){
      if(row.prev_hash!==previous) return res.json({ok:false,ledgerIntegrity:'CORRUPTED_OR_TAMPERED',tamperedRowId:row.id,reason:'PREVIOUS_HASH_MISMATCH'});
      const expected=sha256(JSON.stringify({executionId:row.execution_id,agentId:row.agent_id,action:row.action,amount:JSON.parse(row.request_json).amount,requestJson:row.request_json,resultJson:row.result_json,zkStatus:row.zk_status,settlementStatus:row.settlement_status,prevHash:row.prev_hash,timestamp:row.timestamp}));
      if(expected!==row.current_hash) return res.json({ok:false,ledgerIntegrity:'CORRUPTED_OR_TAMPERED',tamperedRowId:row.id,reason:'CURRENT_HASH_MISMATCH'});
      previous=row.current_hash;
    }
    res.json({ok:true,ledgerIntegrity:'VERIFIED_VALID',totalRecords:rows.length,head:previous});
  }catch(e){ fail(res,500,'LEDGER_VERIFY_FAILED','Ledger verification failed'); }
});
app.get('/api/v1/metrics',requireGateway,async(_req,res)=>{
  const [a,e,x]=await Promise.all([get(`SELECT COUNT(*) n FROM agents WHERE status='ACTIVE'`),get(`SELECT COUNT(*) n FROM executions`),get(`SELECT COUNT(*) n FROM action_events`)]);
  res.json({ok:true,activeAgents:a.n,executions:e.n,events:x.n});
});

async function main(){ await init(); app.listen(PORT,'0.0.0.0',()=>console.log(`VORTEX Gateway live on http://0.0.0.0:${PORT}`)); }
main().catch(e=>{console.error('Startup failed',e);process.exit(1)});
