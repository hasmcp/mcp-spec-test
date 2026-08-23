// xxhash64 and base62, the two halves of the server id the telemetry endpoint
// expects.
//
// Implemented here rather than taken from a package because this tool ships with
// exactly one dependency — the official SDK, which it exists to test against —
// and a hash function is not worth widening that. It is verified against the
// reference implementation's published vectors in tests/unit/hash.test.mjs.
//
// The endpoint only checks the shape of what arrives, so it cannot tell us if
// this drifts. The vectors are the guard.

const MASK = (1n << 64n) - 1n

const P1 = 11400714785074694791n
const P2 = 14029467366897019727n
const P3 = 1609587929392839161n
const P4 = 9650029242287828579n
const P5 = 2870177450012600261n

const mul = (a, b) => (a * b) & MASK
const add = (a, b) => (a + b) & MASK
const rotl = (value, bits) => ((value << BigInt(bits)) | (value >> BigInt(64 - bits))) & MASK

const round = (acc, input) => mul(rotl(add(acc, mul(input, P2)), 31), P1)

function mergeRound(acc, value) {
  return add(mul(acc ^ round(0n, value), P1), P4)
}

/** xxhash64 of a UTF-8 string, seed 0, as an unsigned 64-bit bigint. */
export function xxhash64(text) {
  const bytes = new TextEncoder().encode(text)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const length = bytes.length
  let index = 0
  let acc

  if (length >= 32) {
    let a = add(add(0n, P1), P2)
    let b = add(0n, P2)
    let c = 0n
    let d = (0n - P1) & MASK

    const limit = length - 32
    while (index <= limit) {
      a = round(a, view.getBigUint64(index, true))
      b = round(b, view.getBigUint64(index + 8, true))
      c = round(c, view.getBigUint64(index + 16, true))
      d = round(d, view.getBigUint64(index + 24, true))
      index += 32
    }

    acc = add(add(add(rotl(a, 1), rotl(b, 7)), rotl(c, 12)), rotl(d, 18))
    acc = mergeRound(acc, a)
    acc = mergeRound(acc, b)
    acc = mergeRound(acc, c)
    acc = mergeRound(acc, d)
  } else {
    acc = add(0n, P5)
  }

  acc = add(acc, BigInt(length))

  while (length - index >= 8) {
    acc = add(mul(rotl(acc ^ round(0n, view.getBigUint64(index, true)), 27), P1), P4)
    index += 8
  }
  if (length - index >= 4) {
    acc = add(mul(rotl(acc ^ mul(BigInt(view.getUint32(index, true)), P1), 23), P2), P3)
    index += 4
  }
  while (index < length) {
    acc = mul(rotl(acc ^ mul(BigInt(bytes[index]), P5), 11), P1)
    index += 1
  }

  acc = mul(acc ^ (acc >> 33n), P2)
  acc = mul(acc ^ (acc >> 29n), P3)
  return (acc ^ (acc >> 32n)) & MASK
}

// Digits, then uppercase, then lowercase. The order is load-bearing: the
// endpoint decodes what it receives to range-check it, so a different ordering
// would produce ids that decode to the wrong number.
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

// A 64-bit value needs 11 base62 characters, and the endpoint requires exactly
// that width — left-padded, so a value with leading zeros is not mistaken for a
// different server.
export const SERVER_ID_WIDTH = 11

export function base62(value, width = SERVER_ID_WIDTH) {
  let remaining = value
  let out = ''
  while (remaining > 0n) {
    out = ALPHABET[Number(remaining % 62n)] + out
    remaining /= 62n
  }
  return out.padStart(width, '0')
}

// The salt is the constant below, prepended with no separator. It keeps these
// digests from matching another system's hash of the same name; it is not a
// secret and is not meant to be.
const SALT = 'mcp-spec-test'

/** The id the endpoint expects for a server announcing `name`. */
export function serverId(name) {
  return base62(xxhash64(SALT + name))
}
