# VORTEX Agent Trust & Control Infrastructure — Full MVP Engine

VORTEX is a control plane for autonomous AI agents:

**Agent → Identity → Authorization → Policy → Limits → Controlled Execution → Verification → Audit**

## Included

- Express API gateway
- Public web UI at `/`
- Gateway API credential + per-agent credential
- Agent permissions
- Atomic agent+nonce replay protection
- Daily spending/action limits with daily period reset
- SQLite WAL persistence
- Controlled execution adapter with explicit event records
- Hash-chained audit ledger
- Independent ledger integrity verification
- Real Groth16 proving endpoint when generated artifacts are present
- Real SnarkJS Groth16 verification
- Optional Solana environment placeholders for a future explicit settlement adapter
- Docker build that compiles Circom and generates development Groth16 artifacts
- Render Blueprint
- Smoke tests

## Local

```bash
cp .env.example .env
npm install
npm run zk:setup
npm test
npm start
```

Set strong values in `.env` before using protected routes.

## ZK

The circuit proves:

`c = a * b`

`a` and `b` are witness inputs; `c` is the public output. The setup script generates WASM, a proving key and a verification key for development. The `/api/v1/zk/prove` endpoint creates a real Groth16 proof with SnarkJS and self-verifies it before returning it.

**Important:** the included Powers of Tau contribution is development setup only. A production cryptographic deployment should use an appropriate ceremony/trust setup and independent review.

## API

### Public
- `GET /`
- `GET /api/v1/health`
- `GET /api/v1/public/summary`

### Gateway credential required
- `POST /api/v1/zk/prove`
- `POST /api/v1/execute`
- `GET /api/v1/ledger`
- `GET /api/v1/ledger/verify`
- `GET /api/v1/metrics`

Protected execution requires:
- `x-vortex-api-key`
- `x-vortex-agent-key`
- `agentId`
- `action`
- `nonce`

Example action permissions for the seeded agent:
- `database.write`
- `agent.action`
- `payments.transfer`

The controlled runtime records an internal execution event. It does **not** claim to have moved real money or changed an external system. External adapters must be implemented and independently tested before enabling real-world side effects.

## Render

The repository can be deployed with the Dockerfile/Blueprint. Configure `VORTEX_API_KEY` and `AGENT_01_KEY` as secrets. Do not commit `.env` or private keys.

## Production status

This is a substantially complete **MVP engine**, not a security-audited production system. Before real customers or real funds: independent security review, load/concurrency testing, secret rotation, database backup/recovery, observability, scoped credentials, external-adapter isolation, and a production ZK ceremony/setup are required.
