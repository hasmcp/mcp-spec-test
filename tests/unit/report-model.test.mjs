// The model decides what the report says; the renderers only decide how it looks.
// So the verdict logic and the redaction live here, and these are the tests that
// stop two formats disagreeing about whether a run was conformant.

import test from 'node:test'
import assert from 'node:assert/strict'

import { bySection, buildModel, failureReason, redactTarget, section } from '../../lib/report-model.mjs'

const ENV = { MCP_URL: 'https://example.com/mcp', MCP_SPEC_VERSION: '2026-07-28' }
const NOW = new Date('2026-08-23T07:15:03.123Z')

const build = (parts) => buildModel({ env: ENV, now: NOW, ...parts })
const one = (name, file = 'tests/discover.test.mjs') => ({ name, file })

test('section maps a test file to its report heading', () => {
  assert.equal(section('tests/discover.test.mjs'), 'server/discover')
  assert.equal(section('/abs/path/sdk-compat.test.mjs'), 'Official SDK interop')
  // An unmapped file still has to land somewhere legible.
  assert.equal(section('tests/brand-new.test.mjs'), 'brand-new.test.mjs')
  assert.equal(section(undefined), 'other')
})

test('failureReason prefers the sentence the suite wrote', () => {
  assert.equal(
    failureReason({ details: { error: { cause: { message: 'resultType is required' } } } }),
    'resultType is required',
  )
})

test('failureReason falls back through the shapes node:test produces', () => {
  assert.equal(
    failureReason({ details: { error: { cause: { code: 'ERR_ASSERTION', expected: 1, actual: 2 } } } }),
    'expected 1, got 2',
  )
  assert.equal(failureReason({ details: { error: { cause: 'plain string cause' } } }), 'plain string cause')
  assert.equal(failureReason({ details: { error: { message: 'outer only' } } }), 'outer only')
  assert.equal(failureReason({}), 'failed without a reason')
})

test('counts separate what applied from what does not apply', () => {
  const model = build({
    passed: [one('p1'), one('p2')],
    failed: [one('f1')],
    skipped: [one('s1')],
    inapplicable: [one('n1'), one('n2')],
    recommended: [{ label: 'r1', file: 'tests/discover.test.mjs' }],
  })

  assert.deepEqual(model.counts, {
    passed: 2, failed: 1, notVerified: 1, recommendedNotMet: 1, notApplicable: 2, applied: 4,
  })
})

test('a failure makes the run not conformant, whatever else passed', () => {
  const model = build({ passed: [one('p')], failed: [one('f')] })
  assert.equal(model.verdict.code, 'not-conformant')
  assert.equal(model.verdict.detail, '1 requirement violated.')
})

test('the verdict pluralises its own count', () => {
  assert.equal(build({ failed: [one('a'), one('b')] }).verdict.detail, '2 requirements violated.')
})

test('nothing passing is called out rather than reported as success', () => {
  // The failure this exists to prevent: a wholly skipped run reading as green.
  const model = build({ skipped: [one('s')] })
  assert.equal(model.verdict.code, 'nothing-verified')
})

test('skips leave the verdict partial', () => {
  const model = build({ passed: [one('p')], skipped: [one('s')] })
  assert.equal(model.verdict.code, 'conformant-in-part')
  assert.match(model.verdict.detail, /1 case could not be verified/)
})

test('inapplicable cases give a verdict scoped to the revision', () => {
  const model = build({ passed: [one('p')], inapplicable: [one('n')] })
  assert.equal(model.verdict.code, 'conformant-to-revision')
  assert.equal(model.verdict.label, 'conformant to 2026-07-28')
})

test('a clean sweep is fully conformant', () => {
  assert.equal(build({ passed: [one('p')] }).verdict.code, 'fully-conformant')
})

test('the model records the run, not just its cases', () => {
  const model = build({ passed: [one('p')], summary: { duration_ms: 2889.4 } })
  assert.equal(model.transport, 'streamable-http')
  assert.equal(model.specVersion, '2026-07-28')
  assert.equal(model.generatedAt, '2026-08-23T07:15:03.123Z')
  assert.equal(model.durationMs, 2889)
  assert.ok(model.tool.name && model.tool.version)
  assert.ok(model.supportedRevisions.length >= 2)
})

test('a command target reports the stdio transport', () => {
  const model = buildModel({ env: { MCP_COMMAND: 'npx server' }, now: NOW })
  assert.equal(model.transport, 'stdio')
  assert.equal(model.target, 'npx server')
})

test('no target is stated rather than left blank', () => {
  assert.equal(buildModel({ env: {}, now: NOW }).target, '(no target configured)')
})

test('cases keep their section, name and reason', () => {
  const model = build({
    failed: [{ name: 'f', file: 'tests/negotiation.test.mjs', details: { error: { cause: { message: 'why' } } } }],
    skipped: [{ name: 's', file: 'tests/discover.test.mjs', reason: 'no discover' }],
    recommended: [{ label: 'r', detail: 'd', file: 'tests/capabilities.test.mjs' }],
    passed: [one('p')],
    inapplicable: [{ name: 'n', file: 'tests/subscriptions.test.mjs', reason: 'not in this revision' }],
  })

  assert.deepEqual(model.cases.failed, [{ section: 'Version negotiation', name: 'f', reason: 'why' }])
  assert.deepEqual(model.cases.notVerified, [{ section: 'server/discover', name: 's', reason: 'no discover' }])
  assert.deepEqual(model.cases.recommendedNotMet, [{ section: 'Capability methods', label: 'r', detail: 'd' }])
  assert.deepEqual(model.cases.passed, [{ section: 'server/discover', name: 'p' }])
  assert.deepEqual(model.cases.notApplicable, [
    { section: 'subscriptions/listen', name: 'n', reason: 'not in this revision' },
  ])
})

test('a recommendation with no detail records null rather than undefined', () => {
  // undefined disappears through JSON.stringify; null survives, and a consumer
  // can tell "no detail" from "field missing".
  const model = build({ recommended: [{ label: 'r', file: 'tests/discover.test.mjs' }] })
  assert.equal(model.cases.recommendedNotMet[0].detail, null)
})

test('bySection groups without reordering', () => {
  const groups = bySection([
    { section: 'A', name: '1' }, { section: 'B', name: '2' }, { section: 'A', name: '3' },
  ])
  assert.deepEqual([...groups.keys()], ['A', 'B'])
  assert.deepEqual(groups.get('A').map((c) => c.name), ['1', '3'])
})

// A token in the target is the one thing in this report that must not be written
// to a file, so these are the important tests in this file.
test('redactTarget removes credential-shaped query values', () => {
  assert.equal(
    redactTarget('https://example.com/mcp?token=s3cret'),
    'https://example.com/mcp?token=REDACTED',
  )
  for (const name of ['api_key', 'apiKey', 'secret', 'password', 'authorization', 'sig', 'session_id']) {
    const out = redactTarget(`https://example.com/mcp?${name}=s3cret`)
    assert.ok(!out.includes('s3cret'), `${name} leaked: ${out}`)
  }
})

test('redactTarget keeps the parameter name, which is worth seeing', () => {
  assert.match(redactTarget('https://example.com/mcp?token=s3cret'), /token=/)
})

test('redactTarget leaves ordinary parameters alone', () => {
  assert.equal(
    redactTarget('https://example.com/mcp?tenant=acme&page=2'),
    'https://example.com/mcp?tenant=acme&page=2',
  )
})

test('redactTarget removes credentials in the userinfo', () => {
  const out = redactTarget('https://alice:hunter2@example.com/mcp')
  assert.ok(!out.includes('hunter2'), out)
  assert.ok(!out.includes('alice'), out)
})

test('redactTarget passes through what it cannot parse', () => {
  // A command is an arbitrary string; guessing at secrets inside it would be
  // false confidence, so it is documented instead.
  assert.equal(redactTarget('npx -y server --api-key=abc'), 'npx -y server --api-key=abc')
  assert.equal(redactTarget('(no target configured)'), '(no target configured)')
  assert.equal(redactTarget('http://['), 'http://[')
  assert.equal(redactTarget(undefined), undefined)
})

test('the model redacts before anything can write the target down', () => {
  const model = buildModel({ env: { MCP_URL: 'https://example.com/mcp?token=s3cret' }, now: NOW })
  assert.ok(!model.target.includes('s3cret'))
})
