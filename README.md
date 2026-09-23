# VORTEX Gateway — Fixed Gemini Implementation

This is the corrected version of the supplied Gemini implementation.

## Critical fixes

1. **Atomic replay protection:** nonce claim, spending update and audit insertion happen inside one SQLite `BEGIN IMMEDIATE` transaction. The old check-then-insert race is removed.
2. **Nonce is scoped to the agent:** the uniqueness rule is `(agent_id, nonce)`, not nonce globally.
3. **Ledger head is read inside the same write transaction:** concurrent requests cannot fork the hash chain through a stale previous hash.
4. **No fake ZK verification:** missing verification key returns `NOT_GENERATED`; it never becomes a successful proof.
5. **Invalid ZK proof is rejected.**
6. **Authentication uses an HTTP header:** `x-vortex-api-key`, rather than putting the secret in the JSON body.
7. **Timing-safe API-key comparison.**
8. **Strict amount validation:** malformed amounts are rejected instead of silently becoming zero.
9. **Input limits and rate limiting added.**
10. **Execution result is written to the audit record so ledger verification covers the important execution state.**
11. **No real-world payment/side-effect is claimed:** this MVP only records the controlled execution request.

## Run

```bash
npm install
cp .env.example .env
npm start
```

Set a real API key:

```bash
export VORTEX_API_KEY='replace-with-a-long-random-secret'
```

Health:

```bash
curl http://localhost:3000/api/v1/health
```

Execution:

```bash
curl -X POST http://localhost:3000/api/v1/execute   -H 'Content-Type: application/json'   -H 'x-vortex-api-key: replace-with-a-long-random-secret'   -d '{"agentId":"AGENT_01","nonce":"NONCE_001","action":"database.write","amount":100}'
```

Ledger:

```bash
curl http://localhost:3000/api/v1/ledger/verify
```

## ZK

A real Groth16 verification key must exist at `ZK_VKEY`. If it does not, the response is explicitly `NOT_GENERATED`.

This file does not generate a proof. A real circuit/prover must create the proof and public signals separately.

## Important

This is still an MVP, not a security-audited production system.
