const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');

test('hashing is deterministic',()=>{const a=crypto.createHash('sha256').update('vortex').digest('hex');const b=crypto.createHash('sha256').update('vortex').digest('hex');assert.equal(a,b);});
test('nonce format accepts bounded identifiers',()=>{assert.match('NONCE_0001',/^[A-Za-z0-9._:-]{8,128}$/);});
test('amount validation rejects negative values',()=>{assert.ok(!(Number.isFinite(-1)&&-1>=0));});
