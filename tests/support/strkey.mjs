/**
 * Deterministic, checksum-valid Stellar "G…" strkeys for test fixtures.
 *
 * `decode.ts`'s `addr()` only checks the strkey *shape* (a regex), but the
 * real SDK's `Address` class — used here to build genuine XDR ScVal
 * addresses — validates the CRC16 checksum too. So fixtures need real,
 * correctly-checksummed addresses, not arbitrary look-alike strings.
 *
 * Implemented locally (CRC16/XMODEM + RFC4648 base32, no padding) rather than
 * pulling in a keypair library: this only ever needs to produce a stable,
 * reproducible address per test label, never a spendable key.
 */
import { createHash } from "node:crypto";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function crc16xmodem(bytes) {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1;
      crc &= 0xffff;
    }
  }
  return crc;
}

function base32Encode(bytes) {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

/** version byte 6<<3 = 0x30, 'G' — ed25519 public key (account address). */
const ED25519_PUBLIC_KEY_VERSION = 6 << 3;

function strkeyFor(versionByte, payload32) {
  const withVersion = Buffer.concat([Buffer.from([versionByte]), payload32]);
  const crc = crc16xmodem(withVersion);
  // Little-endian, per RFC4648 strkey convention.
  const withChecksum = Buffer.concat([withVersion, Buffer.from([crc & 0xff, (crc >> 8) & 0xff])]);
  return base32Encode(withChecksum);
}

/** A stable, checksum-valid G-address derived from any label — same label, same address. */
export function addressFor(label) {
  const payload = createHash("sha256").update(`mimir-test-address:${label}`).digest();
  return strkeyFor(ED25519_PUBLIC_KEY_VERSION, payload);
}
