import { randomBytes } from "node:crypto";

// ULID: https://github.com/ulid/spec — 48-bit timestamp (ms) + 80-bit randomness,
// Crockford's Base32 (no I, L, O, U to avoid transcription ambiguity).
const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ENCODING_LEN = ENCODING.length;
const TIME_LEN = 10;
const RANDOM_LEN = 16;

function encodeTime(now: number): string {
  let mut = now;
  let out = "";
  for (let i = TIME_LEN - 1; i >= 0; i--) {
    const mod = mut % ENCODING_LEN;
    out = ENCODING[mod] + out;
    mut = (mut - mod) / ENCODING_LEN;
  }
  return out;
}

function encodeRandom(): string {
  const bytes = randomBytes(10); // 80 bits
  let out = "";
  // 10 bytes -> 16 base32 chars, 5 bits at a time across a byte boundary.
  let bitBuffer = 0;
  let bitCount = 0;
  let byteIndex = 0;
  while (out.length < RANDOM_LEN) {
    if (bitCount < 5) {
      bitBuffer = (bitBuffer << 8) | bytes[byteIndex++]!;
      bitCount += 8;
    }
    bitCount -= 5;
    const index = (bitBuffer >> bitCount) & 0x1f;
    out += ENCODING[index];
  }
  return out;
}

/** Generates a ULID: lexicographically sortable by creation time. */
export function generateUlid(now: number = Date.now()): string {
  return encodeTime(now) + encodeRandom();
}
