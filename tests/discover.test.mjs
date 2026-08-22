// server/discover — the entry point for everything else.
//
// 2026-07-28 makes discover mandatory: a server MUST answer it so a client can
// choose a protocol version up front, with no handshake and no session. These
// cases fail rather than skip on a server that does not answer, because that is
// a real conformance failure — and because the rest of the suite reads its
// answer to decide what to test, an unanswered discover is worth reporting
// loudly.

import test from 'node:test'
import assert from 'node:assert/strict'

import { requireTarget, LATEST_SPEC_VERSION, SUPPORTED_REVISIONS, inWindow } from '../lib/env.mjs'
import { probe } from '../lib/probe.mjs'
import { call, result } from '../lib/rpc.mjs'
import { FEATURES, methodConst, missingRequired, requiredFields } from '../lib/schema.mjs'

// A revision without server/discover cannot be asked for one. methodConst would
// throw on the missing definition, so the name is resolved lazily and every case
// here guards on the feature first.
const DISCOVER = FEATURES.discover ? methodConst('DiscoverRequest') : 'server/discover'

// requireDiscover skips when the revision under test has no discover at all —
// an inapplicable case, not a weaker one. Its replacement, the handshake, is
// covered in negotiation.test.mjs.
function requireDiscover(t) {
  if (!FEATURES.discover) {
    t.skip(`${process.env.MCP_SPEC_VERSION || 'this revision'} has no server/discover; it negotiates at the handshake`)
    return false
  }
  return true
}

test('server/discover is answered without a session or handshake', async (t) => {
  if (!requireTarget(t)) return
  if (!requireDiscover(t)) return

  const res = await call(DISCOVER, { version: null, meta: false, headerVersion: null })
  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`)

  const out = result(res, DISCOVER)
  assert.ok(out, `${DISCOVER} returned no result`)

  // Assert against the schema's own required list rather than a hand-copied one.
  const missing = missingRequired('DiscoverResult', out)
  assert.deepEqual(missing, [], `DiscoverResult is missing schema-required fields: ${missing.join(', ')}`)
})

test('server/discover advertises the versions the server can serve', async (t) => {
  if (!requireTarget(t)) return
  if (!requireDiscover(t)) return

  const out = result(await call(DISCOVER, { version: null, meta: false, headerVersion: null }), DISCOVER)
  assert.ok(Array.isArray(out.supportedVersions), 'supportedVersions must be an array')
  assert.ok(out.supportedVersions.length > 0, 'supportedVersions must not be empty')

  // Revision ids are dates; anything else cannot be compared or negotiated.
  for (const v of out.supportedVersions) {
    assert.match(v, /^\d{4}-\d{2}-\d{2}$/, `"${v}" is not a protocol revision date`)
  }

  // The version negotiated for a client that asks for nothing must itself be
  // servable, or version-less clients would be promised something unsupported.
  const { defaultVersion } = await probe()
  if (defaultVersion) {
    assert.ok(
      out.supportedVersions.includes(defaultVersion),
      `the negotiated default ${defaultVersion} is missing from ${JSON.stringify(out.supportedVersions)}`,
    )
  }
})

test('server/discover is a CacheableResult with usable cache hints', async (t) => {
  if (!requireTarget(t)) return
  if (!requireDiscover(t)) return

  const out = result(await call(DISCOVER, { version: null, meta: false, headerVersion: null }), DISCOVER)

  // ttlMs and cacheScope are required on DiscoverResult per the schema.
  assert.ok(requiredFields('DiscoverResult').includes('ttlMs'), 'schema sanity: ttlMs should be required')
  assert.equal(typeof out.ttlMs, 'number', 'ttlMs must be a number')
  assert.ok(out.ttlMs >= 0, 'ttlMs must be non-negative')
  assert.ok(['public', 'private'].includes(out.cacheScope), `cacheScope must be public|private, got ${out.cacheScope}`)
})

test('server/discover reports server identity and capabilities', async (t) => {
  if (!requireTarget(t)) return
  if (!requireDiscover(t)) return

  const out = result(await call(DISCOVER, { version: null, meta: false, headerVersion: null }), DISCOVER)
  assert.equal(typeof out.capabilities, 'object', 'capabilities must be an object')

  // serverInfo is not schema-required on DiscoverResult, but a server that
  // cannot name itself is useless for diagnostics, so we expect it.
  const info = out.serverInfo ?? out._meta?.['io.modelcontextprotocol/serverInfo']
  assert.ok(info?.name, `expected a named serverInfo, got ${JSON.stringify(out.serverInfo ?? out._meta)}`)
})

// Cache hints are only meaningful if the answer is actually stable, and a client
// that caches discover for ttlMs would be broken by a server that varies it.
test('server/discover is stable across calls within its own TTL', async (t) => {
  if (!requireTarget(t)) return
  if (!requireDiscover(t)) return

  const a = result(await call(DISCOVER, { version: null, meta: false, headerVersion: null }), DISCOVER)
  const b = result(await call(DISCOVER, { version: null, meta: false, headerVersion: null }), DISCOVER)
  assert.deepEqual(
    b.supportedVersions,
    a.supportedVersions,
    'supportedVersions changed between two immediate calls, so the ttlMs hint cannot be honoured',
  )
})

// The suite reasons about the two most recent revisions and no further. A target
// that advertises nothing in that window is not something this tool can make a
// conformance statement about, and saying so is more useful than asserting the
// current spec's requirements against a server built for an older one.
test('server/discover advertises a revision this suite supports', async (t) => {
  if (!requireTarget(t)) return
  if (!requireDiscover(t)) return

  const out = result(await call(DISCOVER, { version: null, meta: false, headerVersion: null }), DISCOVER)
  const overlap = (out.supportedVersions ?? []).filter(inWindow)
  assert.ok(
    overlap.length > 0,
    `target advertises ${JSON.stringify(out.supportedVersions)}, none of which this suite supports `
      + `(${SUPPORTED_REVISIONS.join(', ')})`,
  )
})

test('the suite is reading a schema that matches the features it selected', async () => {
  // Guards against the vendored schema being swapped underneath the suite, which
  // would silently weaken every assertion in it. Asserted against the feature set
  // rather than a revision date, so it stays true as the window moves.
  if (FEATURES.discover) {
    assert.ok(
      requiredFields('DiscoverResult').includes('supportedVersions'),
      `${LATEST_SPEC_VERSION} defines server/discover, so DiscoverResult must require supportedVersions`,
    )
  }
  if (FEATURES.resultEnvelope) {
    assert.ok(
      requiredFields('ListToolsResult').includes('resultType'),
      `${LATEST_SPEC_VERSION} has the result envelope, so ListToolsResult must require resultType`,
    )
  }
  assert.ok(
    FEATURES.discover || FEATURES.handshake,
    `${LATEST_SPEC_VERSION} defines neither server/discover nor initialize — it cannot be negotiated at all`,
  )
})
