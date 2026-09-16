import os
import sys
import time
import json
import sqlite3
import hashlib

try:
    import numpy as np
    NUMPY_AVAILABLE = True
except ImportError:
    NUMPY_AVAILABLE = False

from flask import Flask, request, render_template_string

# ==========================================
# CONFIGURATION & IMMUTABLE LEDGER
# ==========================================
HTTP_PORT = 8080
DB_FILE = "vortex_full_ecosystem.db"

def init_db():
    conn = sqlite3.connect(DB_FILE, timeout=10)
    c = conn.cursor()
    c.execute('''CREATE TABLE IF NOT EXISTS ecosystem_ledger 
                 (block_id INTEGER PRIMARY KEY AUTOINCREMENT, 
                  task_id TEXT, 
                  prompt TEXT,
                  tokens INTEGER,
                  latency REAL,
                  fingerprint TEXT,
                  zk_proof TEXT,
                  agent_payout REAL,
                  prev_hash TEXT, 
                  current_hash TEXT, 
                  verification_status TEXT)''')
    c.execute("SELECT COUNT(*) FROM ecosystem_ledger")
    if c.fetchone()[0] == 0:
        gen_hash = hashlib.sha256(b"VORTEX_GENESIS_ROOT").hexdigest()
        c.execute("""INSERT INTO ecosystem_ledger 
                     (task_id, prompt, tokens, latency, fingerprint, zk_proof, agent_payout, prev_hash, current_hash, verification_status) 
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                  ("TASK_GENESIS", "System Genesis Node", 0, 0.0000, "GENESIS_ROOT", "ZK_PROOF_PASSED", 0.00, "0"*64, gen_hash, "GENESIS_NODE"))
    conn.commit()
    conn.close()

init_db()

def get_last_block():
    conn = sqlite3.connect(DB_FILE, timeout=10)
    c = conn.cursor()
    c.execute("SELECT current_hash, block_id FROM ecosystem_ledger ORDER BY block_id DESC LIMIT 1")
    res = c.fetchone()
    conn.close()
    return res if res else ("0"*64, 0)

# ==========================================
# UNIFIED 3-PHASE EXECUTION PIPELINE
# ==========================================

# PHASE 1: Real Edge AI Hardware Execution
def phase1_edge_compute(prompt_text):
    start = time.perf_counter()
    tokens = [ord(c) for c in prompt_text.strip()]
    token_count = len(tokens)
    
    if NUMPY_AVAILABLE and token_count > 0:
        np.random.seed(sum(tokens) % (2**32 - 1))
        dim = 64
        embedding = np.random.randn(token_count, dim)
        scores = np.matmul(embedding, embedding.T) / np.sqrt(dim)
        exp_scores = np.exp(scores - np.max(scores, axis=-1, keepdims=True))
        weights = exp_scores / np.sum(exp_scores, axis=-1, keepdims=True)
        fingerprint = hex(int(abs(np.sum(weights)) * 1000000000))[2:14].upper()
    else:
        acc = 1
        for t in tokens: acc = (acc * t + 7) % 1000000007
        fingerprint = hex(acc)[2:14].upper()

    latency = round(time.perf_counter() - start, 6)
    return token_count, latency, f"0x{fingerprint}"

# PHASE 2: Verification Engine (State Validation & ZK Simulation)
def phase2_verification_gate(task_id, fingerprint, latency):
    state_payload = f"{task_id}:{fingerprint}:{latency}"
    zk_sig = hashlib.sha256(state_payload.encode()).hexdigest()[:16].upper()
    is_valid = latency < 5.0 and len(fingerprint) > 3
    status = "VERIFIED_VALID" if is_valid else "FRAUD_DETECTED"
    return f"ZK-PROOF-0x{zk_sig}", status

# PHASE 3: Agent Protocol & Micro-Payment Settlement
def phase3_agent_settlement(token_count, verification_status):
    if verification_status != "VERIFIED_VALID":
        return 0.0000
    base_rate_per_token = 0.00015
    payout = round(token_count * base_rate_per_token, 6)
    return payout

# ==========================================
# FLASK DASHBOARD UI
# ==========================================
app = Flask(__name__)

UI_TEMPLATE = """
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>VORTEX :: 3-Phase Unified Protocol</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { background: #04070a; color: #00ff66; font-family: 'Courier New', monospace; padding: 15px; }
        .header { border-bottom: 2px solid #00ff66; padding-bottom: 10px; margin-bottom: 15px; display: flex; justify-content: space-between; align-items: center; }
        .card { background: #0a0f18; border: 1px solid #162436; padding: 15px; border-radius: 6px; margin-bottom: 15px; }
        input[type="text"] { width: 100%; padding: 10px; background: #04070a; border: 1px solid #00ff66; color: #fff; font-family: monospace; font-size: 13px; margin-bottom: 10px; }
        button { width: 100%; background: #00ff66; color: #000; border: none; padding: 10px; font-weight: bold; cursor: pointer; }
        table { width: 100%; border-collapse: collapse; table-layout: fixed; }
        th, td { border: 1px solid #162436; padding: 8px; font-size: 10px; word-wrap: break-word; }
        th { background: #0f1a28; color: #00ff66; }
        .hash { color: #6e99c4; font-family: monospace; }
        .status { color: #00ff66; font-weight: bold; }
        .payout { color: #ffcc00; font-weight: bold; }
    </style>
</head>
<body>
    <div class="header">
        <div><b>VORTEX // UNIFIED 3-PHASE ECOSYSTEM PROTOCOL</b></div>
        <div style="background:#00ff66; color:#000; padding:2px 8px; font-weight:bold; font-size:11px;">ECOSYSTEM LIVE</div>
    </div>

    <div class="card">
        <form action="/execute" method="POST">
            <input type="text" name="prompt" placeholder="Submit task to run Phase 1 (Compute) -> Phase 2 (Verify) -> Phase 3 (Settlement)..." required autocomplete="off">
            <button type="submit">EXECUTE FULL ECOSYSTEM PIPELINE</button>
        </form>
    </div>

    <div class="card">
        <h3>Ecosystem Cryptographic Execution Ledger</h3>
        <table>
            <thead>
                <tr>
                    <th style="width: 5%;">ID</th>
                    <th style="width: 25%;">Payload & Hardware Stats</th>
                    <th style="width: 15%;">Phase 1: Compute</th>
                    <th style="width: 20%;">Phase 2: ZK Verification</th>
                    <th style="width: 15%;">Phase 3: Agent Pay</th>
                    <th style="width: 20%;">Ledger Chain Hash</th>
                </tr>
            </thead>
            <tbody>
                {% for b in blocks %}
                <tr>
                    <td><b>#{{ b[0] }}</b></td>
                    <td><b>Prompt:</b> {{ b[2] }}<br><span style="color:#8899ac;">[Tokens: {{ b[3] }}]</span></td>
                    <td>Latency: <b>{{ "%.6f"|format(b[4]) }}s</b><br>FP: {{ b[5] }}</td>
                    <td>Proof: <span class="hash">{{ b[6] }}</span><br>Status: <span class="status">{{ b[9] }}</span></td>
                    <td class="payout">{{ "%.6f"|format(b[7]) }} VTX</td>
                    <td class="hash">Prev: {{ b[8][:8] }}...<br>Curr: {{ b[9][:8] }}...</td>
                </tr>
                {% endfor %}
            </tbody>
        </table>
    </div>
</body>
</html>
"""

@app.route('/')
def index():
    conn = sqlite3.connect(DB_FILE, timeout=10)
    c = conn.cursor()
    c.execute("SELECT * FROM ecosystem_ledger ORDER BY block_id DESC LIMIT 10")
    blocks = c.fetchall()
    conn.close()
    return render_template_string(UI_TEMPLATE, blocks=blocks)

@app.route('/execute', methods=['POST'])
def execute():
    prompt = request.form.get("prompt", "")
    if prompt.strip():
        last_hash, last_id = get_last_block()
        task_id = f"TASK_{int(time.time())}_{last_id + 1}"
        
        # Step 1: Execute Phase 1
        tokens, latency, fingerprint = phase1_edge_compute(prompt)
        
        # Step 2: Execute Phase 2
        zk_proof, status = phase2_verification_gate(task_id, fingerprint, latency)
        
        # Step 3: Execute Phase 3
        payout = phase3_agent_settlement(tokens, status)
        
        # Cryptographic Ledger Binding
        payload = f"{task_id}{prompt}{fingerprint}{zk_proof}{payout}{last_hash}"
        current_hash = hashlib.sha256(payload.encode()).hexdigest()
        
        conn = sqlite3.connect(DB_FILE, timeout=10)
        c = conn.cursor()
        c.execute("""INSERT INTO ecosystem_ledger 
                     (task_id, prompt, tokens, latency, fingerprint, zk_proof, agent_payout, prev_hash, current_hash, verification_status) 
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                  (task_id, prompt, tokens, latency, fingerprint, zk_proof, payout, last_hash, current_hash, status))
        conn.commit()
        conn.close()
        
    return index()

if __name__ == '__main__':
    print(f"\n[VORTEX ECOSYSTEM] Running on http://127.0.0.1:{HTTP_PORT}\n")
    app.run(host='0.0.0.0', port=HTTP_PORT, debug=False)
