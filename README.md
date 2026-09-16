# VORTEX :: Decentralized Edge AI & Cryptographic Compute Protocol

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)
[![Python 3.8+](https://img.shields.io/badge/python-3.8+-blue.svg)](https://www.python.org/downloads/)
[![Architecture: 3--Phase](https://img.shields.io/badge/Architecture-3--Phase--Unified-orange.svg)]()

VORTEX is a lightweight, decentralized micro-compute engine designed to run dynamic Edge AI matrix computations on consumer hardware while generating tamper-evident cryptographic execution proofs and automated micro-payment settlements.

---

## 🏛 System Architecture

The VORTEX protocol operates on a unified 3-Phase Execution Pipeline:
	[ Input Payload ]
│
▼
┌───────────────────────────────────────────────────────────┐
│ PHASE 1: Edge Compute Engine                              │
│ ── NumPy SIMD / Real Dynamic Attention Matrix Operations  │
│ ── Measures Real Hardware Execution Latency               │
└───────────────────────────┬───────────────────────────────┘
│
▼
┌───────────────────────────────────────────────────────────┐
│ PHASE 2: Verification Layer                               │
│ ── Deterministic ASCII Matrix Fingerprinting              │
│ ── State Validation & ZK-Execution Proof Generation       │
└───────────────────────────┬───────────────────────────────┘
│
▼
┌───────────────────────────────────────────────────────────┐
│ PHASE 3: Agent Settlement Protocol                        │
│ ── Per-Token Micro-Payment Reward Distribution            │
│ ── Immutable SHA-256 Ledger Block Binding                 │
└───────────────────────────┬───────────────────────────────┘
---

## 🚀 Key Features

* **Real Dynamic Hardware Compute:** Calculates actual microsecond execution latency using NumPy self-attention dot product operations instead of static timers.
* **Cryptographic Proof of Compute:** Every executed payload generates a deterministic matrix fingerprint and Zero-Knowledge (ZK) state proof.
* **Immutable Ledger Chain:** Transactions are linked sequentially via SHA-256 hashes, ensuring complete ledger integrity.
* **Micro-Payment Token Engine:** Integrated agent settlement layer calculating real-time VTX token payouts per executed token.

---

## 🛠 Quickstart Guide

### Prerequisites
* Python 3.8+
* `numpy` (Optional, fallback pure-Python loop engine available)
* `flask`

### Installation & Execution
1. **Clone the repository:**
   ```bash
   git clone https://github.com/YOUR_USERNAME/vortex-edge-ai.git
