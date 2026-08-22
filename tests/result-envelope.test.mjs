// The 2026-07-28 result envelope.
//
// Every result carries `resultType`, and results the spec marks CacheableResult
// additionally carry `ttlMs` and `cacheScope`. `_meta` carries serverInfo, which
// replaces what initialize used to return once per session.
//
// The mirror-image requirement matters just as much: none of those fields may
// reach a client that negotiated an older revision.

import test from 'node:test'
import assert from 'node:assert/strict'

import { requireTarget } from '../lib/env.mjs'
import { probe, requireLatest, requireOlderVersion } from '../lib/probe.mjs'
import { call, result } from '../lib/rpc.mjs'
import { META_KEYS, methodConst, missingRequired, requireFeature, requiredFields } from '../lib/schema.mjs'

// The cacheable list methods, each paired with the capability that gates it and
// the schema definition that describes its result — so `required` comes from the
// spec and an unadvertised capability is skipped rather than failed.
const CACHEABLE = [
  { method: methodConst('ListToolsRequest'), capability: 'tools', def: 'ListToolsResult' },
  { method: methodConst('ListPromptsRequest'), capability: 'prompts', def: 'ListPromptsResult' },
  { method: methodConst('ListResourcesRequest'), capability: 'resources', def: 'ListResourcesResult' },
  { method: methodConst('ListResourceTemplatesRequest'), capability: 'resources', def: 'ListResourceTemplatesResult' },
]

// available returns the subset of CACHEABLE the target advertises. Asserting
// only against advertised methods is what lets the same suite run against a
// tools-only server and a full one without configuration.
async function available() {
  const { capabilities } = await probe()
  return CACHEABLE.filter((c) => capabilities?.[c.capability])
}

test('every result carries the required resultType', async (t) => {
  if (!requireTarget(t)) return
  if (!requireFeature(t, 'resultEnvelope')) return
  if (!(await requireLatest(t))) return

  const methods = await available()
  if (methods.length === 0) return t.skip('target advertises no cacheable list capability')

  let checked = 0
  for (const { method } of methods) {
    const res = await call(method, {})
    if (res.body?.error) continue // covered by the capability-conformance suite
    const out = result(res, method)
    assert.equal(out?.resultType, 'complete', `${method}: expected resultType "complete", got ${out?.resultType}`)
    checked++
  }
  assert.ok(checked > 0, 'no advertised cacheable method answered — resultType could not be checked')
})

test('cacheable list results carry the schema-required cache hints', async (t) => {
  if (!requireTarget(t)) return
  if (!requireFeature(t, 'cacheHints')) return
  if (!(await requireLatest(t))) return

  const methods = await available()
  if (methods.length === 0) return t.skip('target advertises no cacheable list capability')

  let checked = 0
  for (const { method, def } of methods) {
    const res = await call(method, {})
    if (res.body?.error) continue
    const out = result(res, method)

    const missing = missingRequired(def, out)
    assert.deepEqual(missing, [], `${method}: ${def} missing schema-required fields: ${missing.join(', ')}`)

    assert.equal(typeof out.ttlMs, 'number', `${method}: ttlMs must be a number`)
    assert.ok(out.ttlMs >= 0, `${method}: ttlMs must be non-negative`)
    assert.ok(
      ['public', 'private'].includes(out.cacheScope),
      `${method}: cacheScope must be public|private, got ${out.cacheScope}`,
    )
    checked++
  }
  assert.ok(checked > 0, 'no advertised cacheable method answered — cache hints could not be checked')
})

test('results identify the server in _meta', async (t) => {
  if (!requireTarget(t)) return
  // serverInfo moved into result _meta when the handshake went away; a revision
  // that still has initialize reports it there instead.
  if (!requireFeature(t, 'perRequestVersion')) return
  if (!(await requireLatest(t))) return

  const methods = await available()
  if (methods.length === 0) return t.skip('target advertises no cacheable list capability')

  const { method } = methods[0]
  const out = result(await call(method, {}), method)
  const info = out?._meta?.[META_KEYS.serverInfo]
  assert.ok(info, `expected ${META_KEYS.serverInfo} in result _meta, got ${JSON.stringify(out?._meta)}`)
  assert.ok(info.name, 'serverInfo.name is required by the Implementation schema')
  assert.ok(info.version !== undefined, 'serverInfo.version is required by the Implementation schema')
})

// The compatibility guarantee from the client's side: a client on an older
// revision must not receive fields that revision has never heard of. This is the
// assertion that catches a server that implements the new envelope by simply
// adding the fields everywhere.
test('a client on an older version receives no newer-revision fields', async (t) => {
  if (!requireTarget(t)) return
  if (!requireFeature(t, 'resultEnvelope')) return
  const p = await requireOlderVersion(t)
  if (!p) return

  const methods = await available()
  if (methods.length === 0) return t.skip('target advertises no list capability to check for leaks')

  // server/discover is deliberately not used here: it carries resultType/ttlMs/
  // cacheScope for every version by design, so it cannot reveal a leak.
  const { method } = methods[0]
  const res = await call(method, { version: p.olderVersion })
  if (res.body?.error) {
    return t.skip(`${method} is not answered on ${p.olderVersion}: ${JSON.stringify(res.body.error)}`)
  }
  const out = result(res, method)
  assert.ok(out, 'expected a result')

  for (const field of ['resultType', 'ttlMs', 'cacheScope', '_meta']) {
    assert.equal(
      out[field],
      undefined,
      `a ${p.olderVersion} client must not receive "${field}": ${JSON.stringify(out)}`,
    )
  }
})

test('schema sanity: the envelope fields match the features selected', async (t) => {
  // Guards against the vendored schema being swapped underneath the suite. Keyed
  // off the feature set, so it stays meaningful on a revision that has no
  // envelope rather than asserting a field that was never there.
  if (!requireFeature(t, 'cacheHints')) return
  for (const field of ['resultType', 'ttlMs', 'cacheScope']) {
    assert.ok(
      requiredFields('ListToolsResult').includes(field),
      `ListToolsResult should require ${field} in the revision under test`,
    )
  }
})
