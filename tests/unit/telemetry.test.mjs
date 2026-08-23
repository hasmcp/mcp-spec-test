// Telemetry has one hard requirement beyond being correct: it must be incapable
// of affecting a conformance run. So alongside the payload shape, these pin the
// three ways it could go wrong in someone's terminal — a thrown error, a leaked
// server name, and a request that ignores the opt-out.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { CASE_IDS, caseId } from '../../lib/case-ids.mjs'
import { buildPayload, isDisabled, report, send } from '../../lib/telemetry.mjs'
import { serverId } from '../../lib/hash.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

const RUN = {
  failed: ['header and _meta version disagreement is a HeaderMismatch error'],
  passed: ['a version declared in _meta is accepted', 'server/discover reports server identity and capabilities'],
  notVerified: ['a completely unconfigured SDK client works'],
  specVersion: '2026-07-28',
  transport: 'stdio',
  serverName: 'filesystem',
}

test('every case in the suite has an id, and every id names a real case', () => {
  // The ids are keyed by case name, so a rename would silently orphan one. This
  // is the guard that makes that impossible to do quietly.
  const actual = new Set()
  for (const file of readdirSync(join(root, 'tests')).filter((n) => n.endsWith('.test.mjs'))) {
    const src = readFileSync(join(root, 'tests', file), 'utf8')
    for (const m of src.matchAll(/\ntest\('([^']+)'/g)) actual.add(m[1])
  }

  const missing = [...actual].filter((name) => !CASE_IDS.has(name))
  const stale = [...CASE_IDS.keys()].filter((name) => !actual.has(name))

  assert.deepEqual(missing, [], 'cases with no telemetry id')
  assert.deepEqual(stale, [], 'ids naming a case that no longer exists')
})

test('case ids are unique and never renumbered', () => {
  const ids = [...CASE_IDS.values()]
  assert.equal(new Set(ids).size, ids.length, 'a number is used twice')
  assert.deepEqual(ids, ids.map((_, index) => index + 1), 'ids are not 1..n in order')
})

test('buildPayload maps names to ids', () => {
  assert.deepEqual(buildPayload(RUN), {
    serverType: 1,
    specVersion: '2026-07-28',
    failedTests: [3],
    passedTests: [1, 14],
    notVerifiedTests: [43],
    serverId: serverId('filesystem'),
  })
})

test('buildPayload numbers the transports as the endpoint expects', () => {
  assert.equal(buildPayload({ ...RUN, transport: 'stdio' }).serverType, 1)
  assert.equal(buildPayload({ ...RUN, transport: 'streamable-http' }).serverType, 2)
  assert.equal(buildPayload({ ...RUN, transport: 'something-else' }), null)
})

test('buildPayload never sends the server name in the clear', () => {
  const payload = buildPayload(RUN)
  assert.ok(!JSON.stringify(payload).includes('filesystem'))
  assert.match(payload.serverId, /^[0-9A-Za-z]{11}$/)
})

test('buildPayload omits serverId when no name was learned', () => {
  assert.equal('serverId' in buildPayload({ ...RUN, serverName: undefined }), false)
})

test('buildPayload drops names it has no id for rather than guessing', () => {
  const payload = buildPayload({ ...RUN, failed: ['a case that does not exist'] })
  assert.deepEqual(payload.failedTests, [])
})

test('buildPayload deduplicates', () => {
  const name = 'a version declared in _meta is accepted'
  assert.deepEqual(buildPayload({ ...RUN, passed: [name, name] }).passedTests, [caseId(name)])
})

test('buildPayload returns null when there is nothing to report', () => {
  assert.equal(buildPayload({ ...RUN, failed: [], passed: [], notVerified: [] }), null)
  assert.equal(buildPayload({ ...RUN, specVersion: undefined }), null)
})

test('isDisabled reads the opt-out', () => {
  assert.equal(isDisabled({}), false)
  assert.equal(isDisabled({ MCP_DISABLE_TELEMETRY: '0' }), false)
  assert.equal(isDisabled({ MCP_DISABLE_TELEMETRY: '1' }), true)
})

test('report sends nothing when opted out', async () => {
  let called = false
  const fetchImpl = () => {
    called = true
    throw new Error('should not be reached')
  }

  const sent = await report(RUN, { env: { MCP_DISABLE_TELEMETRY: '1' }, fetchImpl })

  assert.equal(called, false, 'the opt-out was ignored')
  assert.equal(sent, false)
})

test('report posts JSON to the endpoint when not opted out', async () => {
  let seen = null
  const fetchImpl = async (url, init) => {
    seen = { url, init }
    return { ok: true }
  }

  const sent = await report(RUN, { env: {}, fetchImpl })

  assert.equal(sent, true)
  assert.equal(seen.url, 'https://telemetry.hasmcp.com/api/v1/usages/mcp-spec-test')
  assert.equal(seen.init.method, 'POST')
  assert.equal(seen.init.headers['content-type'], 'application/json')
  assert.deepEqual(JSON.parse(seen.init.body), buildPayload(RUN))
  assert.ok(seen.init.signal, 'no timeout signal was attached')
})

// The point of the whole module: a conformance run must not care.
test('send swallows a network failure', async () => {
  const sent = await send(buildPayload(RUN), {
    fetchImpl: () => Promise.reject(new Error('getaddrinfo ENOTFOUND')),
  })
  assert.equal(sent, false)
})

test('send swallows a synchronous throw', async () => {
  const sent = await send(buildPayload(RUN), {
    fetchImpl: () => {
      throw new Error('fetch is not a function')
    },
  })
  assert.equal(sent, false)
})

test('send swallows a rejection from the endpoint', async () => {
  const sent = await send(buildPayload(RUN), { fetchImpl: async () => ({ ok: false, status: 422 }) })
  assert.equal(sent, false)
})

test('send gives up rather than hanging', async () => {
  // A target that never answers must not hold the process open indefinitely,
  // which is exactly what send()'s own AbortSignal.timeout relies on an
  // unref'd timer to do. That same unref means this test's fake network call
  // is the only thing left running by the time it starts — so without
  // something else keeping the event loop open, Node is free to decide the
  // loop is idle and tear the process down before that timer ever fires,
  // rather than actually waiting the 20ms out. A ref'd handle here stands in
  // for "there is other work happening", which is true in every real run.
  const keepAlive = setInterval(() => {}, 1_000_000)
  try {
    const fetchImpl = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted')))
      })

    const sent = await send(buildPayload(RUN), { fetchImpl, timeoutMs: 20 })

    assert.equal(sent, false)
  } finally {
    clearInterval(keepAlive)
  }
})

test('send does nothing with nothing to send', async () => {
  let called = false
  await send(null, {
    fetchImpl: () => {
      called = true
    },
  })
  assert.equal(called, false)
})
