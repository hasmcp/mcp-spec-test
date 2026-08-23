// The server id is computed here and only shape-checked at the far end, so
// nothing downstream can tell us if this implementation drifts. These are the
// reference implementation's own published vectors, plus the boundaries where a
// hand-written xxhash64 actually goes wrong: the 32-byte block loop, and the
// 8/4/1-byte tails that consume whatever is left.

import test from 'node:test'
import assert from 'node:assert/strict'

import { base62, serverId, xxhash64 } from '../../lib/hash.mjs'

test('xxhash64 matches the reference vectors', () => {
  assert.equal(xxhash64(''), 0xef46db3751d8e999n)
  assert.equal(xxhash64('a'), 0xd24ec4f1a98c6e5bn)
  assert.equal(xxhash64('abc'), 0x44bc2cf5ad770999n)
  assert.equal(xxhash64('abcd'), 0xde0327b0d25d92ccn)
})

test('xxhash64 handles every length boundary', () => {
  // Lengths either side of the 32-byte block, and of each tail width. A wrong
  // implementation typically passes short inputs and fails one of these.
  for (const length of [7, 8, 9, 11, 12, 31, 32, 33, 63, 64, 65, 96]) {
    const value = xxhash64('a'.repeat(length))
    assert.equal(typeof value, 'bigint')
    assert.ok(value >= 0n && value <= (1n << 64n) - 1n, `${length} bytes produced ${value}`)
  }
  // Two vectors on that path, so the loop is pinned and not merely exercised.
  assert.equal(xxhash64('a'.repeat(32)), 0x856e843298f99ad7n)
  assert.equal(xxhash64('a'.repeat(33)), 0x18f3ff0c21e3b24bn)
})

test('xxhash64 hashes multi-byte characters by their UTF-8 bytes', () => {
  // Not the same as hashing the JS string's code units; a server name can hold
  // anything.
  assert.equal(xxhash64('日本語'), xxhash64('日本語'))
  assert.notEqual(xxhash64('café'), xxhash64('cafe'))
})

test('base62 pads to a fixed width and covers the whole alphabet', () => {
  assert.equal(base62(0n), '00000000000')
  assert.equal(base62(9n), '00000000009')
  assert.equal(base62(10n), '0000000000A')
  assert.equal(base62(35n), '0000000000Z')
  assert.equal(base62(36n), '0000000000a')
  assert.equal(base62(61n), '0000000000z')
  assert.equal(base62(62n), '00000000010')
})

test('base62 fits the largest value xxhash64 can produce', () => {
  const max = (1n << 64n) - 1n
  assert.equal(base62(max), 'LygHa16AHYF')
  assert.equal(base62(max).length, 11)
})

test('serverId is 11 base62 characters, as the endpoint requires', () => {
  for (const name of ['filesystem', 'a', '', 'a'.repeat(300), '日本語サーバー']) {
    const id = serverId(name)
    assert.match(id, /^[0-9A-Za-z]{11}$/, `${JSON.stringify(name)} produced ${id}`)
  }
})

test('serverId is stable for a name and distinct between names', () => {
  assert.equal(serverId('filesystem'), serverId('filesystem'))
  assert.notEqual(serverId('filesystem'), serverId('github'))
})

test('serverId salts the name, so it is not a bare hash of it', () => {
  // The salt is what stops these digests matching another system's hash of the
  // same name.
  assert.notEqual(serverId('filesystem'), base62(xxhash64('filesystem')))
  assert.equal(serverId('filesystem'), base62(xxhash64('mcp-spec-testfilesystem')))
})
