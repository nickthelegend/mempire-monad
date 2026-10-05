/**
 * Solana libraries assume a Node environment in places. Providing Buffer and a
 * minimal `process` up front keeps wallet adapters and web3.js from crashing on
 * a missing global — this must be imported before anything that touches them.
 */
import { Buffer } from 'buffer';

// Cast rather than augment Window: the DOM lib already types `process`, and
// widening it here fights those declarations for no benefit.
const g = globalThis as unknown as Record<string, unknown>;

if (!g.Buffer) g.Buffer = Buffer;
if (!g.global) g.global = globalThis;
if (!g.process) g.process = { env: {} };
