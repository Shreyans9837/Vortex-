# VORTEX security checklist

Implemented in this MVP:
- [x] Gateway authentication header
- [x] Per-agent credential
- [x] Timing-safe credential comparison
- [x] Input size limit
- [x] Rate limiting
- [x] Strict amount validation
- [x] Agent permission check
- [x] Agent+nonce primary-key replay protection
- [x] Atomic spending/nonce/ledger transaction
- [x] Hash-chain integrity verification
- [x] No fake ZK success when artifacts are missing
- [x] Invalid Groth16 proof rejected
- [x] External side effects isolated behind controlled adapter boundary

Still required before production claims:
- [ ] Independent security audit
- [ ] Credential rotation/revocation workflow
- [ ] Per-action scopes and least privilege
- [ ] Durable backups and disaster recovery
- [ ] Concurrency/load test suite
- [ ] Observability and alerting
- [ ] Production ZK ceremony/setup review
- [ ] External side-effect adapter threat model
- [ ] Formal policy model and policy test corpus
- [ ] Customer/tenant isolation model
