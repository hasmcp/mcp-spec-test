// Version negotiation.
//
// 2026-07-28 declares the protocol version per request, in _meta, instead of
// once per session at initialize. On Streamable HTTP the MCP-Protocol-Version
// header must carry the same value, and a disagreement is an error rather than
// something the server resolves in favour of one side.

import test from 'node:test'
import assert from 'node:assert/strict'

import { requireTarget, requireHttp, LATEST_SPEC_VERSION } from '../lib/env.mjs'
import { probe, requireLatest, requireOlderVersion } from '../lib/probe.mjs'
import { call, requireReachable, result, rpcError } from '../lib/rpc.mjs'
import { ERROR_CODES, FEATURES, methodConst, missingRequired, requireFeature } from '../lib/schema.mjs'
import * as session from '../lib/session.mjs'

const DISCOVER = FEATURES.discover ? methodConst('DiscoverRequest') : 'server/discover'

// Negotiation is a property of ordinary requests, so these cases run against a
// real capability-backed method where the server has one, and fall back to
// server/discover otherwise. negotiationMethod() picks it from what the target
// actually advertises rather than assuming tools exist.
async function negotiationMethod() {
  const { ok, capabilities } = await probe()
  if (capabilities?.tools) return methodConst('ListToolsRequest')
  if (capabilities?.prompts) return methodConst('ListPromptsRequest')
  if (capabilities?.resources) return methodConst('ListResourcesRequest')
  // Where discover is unavailable there is nothing to read capabilities from, so
  // guess at the one nearly every server has. Using discover here instead would
  // report a version-negotiation verdict about a method the target has already
  // failed to implement.
  return ok ? DISCOVER : methodConst('ListToolsRequest')
}

test('a version declared in _meta is accepted', async (t) => {
  if (!requireFeature(t, 'perRequestVersion')) return
  if (!requireTarget(t)) return
  if (!(await requireLatest(t))) return

  const res = await call(await negotiationMethod(), { version: LATEST_SPEC_VERSION })
  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`)
  assert.ok(result(res, 'negotiated request'), 'expected a result')
})

test('the negotiated version is echoed in the response header', async (t) => {
  if (!requireFeature(t, 'perRequestVersion')) return
  if (!requireHttp(t)) return
  if (!(await requireLatest(t))) return

  const res = await call(await negotiationMethod(), { version: LATEST_SPEC_VERSION })
  assert.equal(
    res.headers.get('mcp-protocol-version'),
    LATEST_SPEC_VERSION,
    'server must echo the negotiated version',
  )
})

test('header and _meta version disagreement is a HeaderMismatch error', async (t) => {
  if (!requireFeature(t, 'perRequestVersion')) return
  if (!requireHttp(t)) return
  const p = await requireOlderVersion(t)
  if (!p) return

  const res = await call(await negotiationMethod(), {
    version: LATEST_SPEC_VERSION,
    headerVersion: p.olderVersion,
  })

  assert.equal(res.status, 400, `a mismatch must be a 400, got ${res.status}`)
  const err = rpcError(res)
  assert.equal(
    err?.code,
    ERROR_CODES.headerMismatch,
    `expected HeaderMismatch (${ERROR_CODES.headerMismatch}), got ${JSON.stringify(err)}`,
  )
})

test('an unsupported version is rejected with the supported list', async (t) => {
  if (!requireFeature(t, 'perRequestVersion')) return
  if (!requireTarget(t)) return
  if (!(await requireLatest(t))) return

  // A date far enough in the past that no revision could ever claim it.
  const res = await call(await negotiationMethod(), { version: '1999-01-01' })

  const err = rpcError(res)
  assert.equal(
    err?.code,
    ERROR_CODES.unsupportedProtocolVersion,
    `expected UnsupportedProtocolVersion (${ERROR_CODES.unsupportedProtocolVersion}), got ${JSON.stringify(res.body)}`,
  )
  // The client needs to know what to retry with, per the negotiation section.
  assert.ok(
    Array.isArray(err?.data?.supported) && err.data.supported.length > 0,
    `error data must list supported versions, got ${JSON.stringify(err?.data)}`,
  )
  // Those versions must be the ones discover advertises, or a client that
  // retries from the error and a client that reads discover disagree.
  const { supportedVersions } = await probe()
  if (supportedVersions.length) {
    assert.deepEqual(
      err.data.supported.slice().sort(),
      supportedVersions.slice().sort(),
      'the versions offered in the error must match the ones server/discover advertises',
    )
  }
})

test('an unsupported version is rejected with a 400 on Streamable HTTP', async (t) => {
  if (!requireFeature(t, 'perRequestVersion')) return
  if (!requireHttp(t)) return
  if (!(await requireLatest(t))) return

  const res = await call(await negotiationMethod(), { version: '1999-01-01' })
  assert.equal(res.status, 400, `expected 400, got ${res.status}: ${JSON.stringify(res.body)}`)
})

// Backward compatibility: a client that declares nothing must still be served,
// on whatever version the server defaults to.
//
// The method has to be one this server will answer *without a session*, or the
// case stops testing version fallback and starts testing session policy. A
// stateful server legitimately refuses tools/list outside a session, and calling
// that a negotiation failure would be wrong.
//
// That is exactly the trap a version-less request sets when the target does
// not itself advertise the revision under test. A dual-era server is
// explicitly permitted (Streamable HTTP's Protocol Version Header section:
// "a server that supports clients implementing protocol versions earlier
// than 2025-06-18 ... MAY treat a request that omits the header as protocol
// version 2025-03-26") to default an under-declared request to a much older,
// handshake-based revision — one this suite is not performing the handshake
// for, since it is testing 2026-07-28's session-less model. Whatever method
// gets picked, a server that then refuses it as "needs a session first" is
// being correctly stateful under its own chosen default, not failing this
// requirement; there is no method choice that sidesteps that, discover
// included, once the target's default might not be the revision under test
// at all. So this only runs against a target that has already told us (via
// `requireLatest`, the same gate every other case in this file uses) that it
// serves the revision under test — where a version-less request served
// under anything else would itself be the deviation worth reporting.
test('a request with no version at all is served on the default', async (t) => {
  if (!requireTarget(t)) return
  const p = await requireLatest(t)
  if (!p) return

  const method = FEATURES.discover ? DISCOVER : await negotiationMethod()
  // Version-less on purpose, but Mcp-Method mirrors the method name regardless
  // of whether a version is declared — see probe.mjs's own discover call for
  // why omitting it reads as malformed to a server that already speaks
  // 2026-07-28's transport.
  const res = await call(method, { version: null, meta: false, headerVersion: null, extraHeaders: { 'mcp-method': method } })
  if (!requireReachable(t, res, method)) return
  assert.equal(
    res.status,
    200,
    `a version-less request must be served, got ${res.status}: ${JSON.stringify(res.body)}`,
  )
  // On stdio there is no status code to fail, so the JSON-RPC error is the only
  // evidence that the request was refused rather than served.
  assert.ok(
    !rpcError(res),
    `a version-less ${method} must be served, not refused: ${JSON.stringify(rpcError(res))}`,
  )

  if (p.defaultVersion && res.headers.get('mcp-protocol-version')) {
    assert.equal(
      res.headers.get('mcp-protocol-version'),
      p.defaultVersion,
      'a version-less request should negotiate the server default, consistently',
    )
  }
})

test('clientInfo is optional (SHOULD, not MUST)', async (t) => {
  if (!requireFeature(t, 'perRequestVersion')) return
  if (!requireTarget(t)) return
  if (!(await requireLatest(t))) return

  // clientInfo is a SHOULD in the released schema, so a request omitting it must
  // still succeed. Only protocolVersion and clientCapabilities are required.
  const res = await call(await negotiationMethod(), { version: LATEST_SPEC_VERSION, clientInfo: false })
  assert.equal(res.status, 200, `omitting clientInfo must not fail: ${JSON.stringify(res.body)}`)
  assert.ok(!rpcError(res), `omitting clientInfo must not error: ${JSON.stringify(rpcError(res))}`)
})

// ---------------------------------------------------------------------------
// The handshake, for revisions that negotiate once instead of per request.
//
// These are the same requirements the cases above check — agree on a version, or
// say why not — expressed the way an older revision expresses them. Selected by
// the schema's feature set, so exactly one of the two families runs.

test('initialize returns the schema-required fields', async (t) => {
  if (!requireTarget(t)) return
  if (!requireFeature(t, 'handshake')) return
  if (!(await session.require(t))) return

  const s = await session.open()
  assert.ok(s.ok, `handshake failed: ${s.reason}`)

  // InitializeResult requires capabilities, protocolVersion and serverInfo. A
  // client has no way to proceed without all three.
  const missing = missingRequired('InitializeResult', {
    capabilities: s.capabilities,
    protocolVersion: s.protocolVersion,
    serverInfo: s.serverInfo,
  })
  assert.deepEqual(missing, [], `InitializeResult is missing schema-required fields: ${missing.join(', ')}`)
  assert.ok(s.serverInfo?.name, 'serverInfo.name is required by the Implementation schema')
})

test('the handshake settles on the revision under test', async (t) => {
  if (!requireTarget(t)) return
  if (!requireFeature(t, 'handshake')) return
  if (!(await session.require(t))) return

  const s = await session.open()
  assert.equal(
    s.protocolVersion,
    LATEST_SPEC_VERSION,
    `asked for ${LATEST_SPEC_VERSION}, negotiated ${s.protocolVersion}`,
  )
})

test('an unsupported version offered at the handshake is refused or downgraded, not echoed', async (t) => {
  if (!requireTarget(t)) return
  if (!requireFeature(t, 'handshake')) return

  const res = await call('initialize', {
    version: null,
    meta: false,
    headerVersion: null,
    params: {
      protocolVersion: '1999-01-01',
      capabilities: {},
      clientInfo: { name: 'mcp-spec-test', version: '0.1.0' },
    },
  })

  // Either answer is conformant: refuse it, or reply with a version the server
  // does support. Echoing back a revision that does not exist is not, because the
  // client would then speak it.
  //
  // Accepting "an error" as proof of refusal makes this case only as trustworthy
  // as the request that provoked it. It once sent this initialize inside an
  // already-open session, so a conformant server refused it as a duplicate and
  // this passed without ever testing the version at all. rpc.call sends the
  // handshake outside any session now, which is what makes the error below
  // attributable to the version offered.
  const err = rpcError(res)
  if (err) return
  const negotiated = res.body?.result?.protocolVersion
  assert.ok(negotiated, `expected either an error or a protocolVersion, got ${JSON.stringify(res.body)}`)
  assert.notEqual(negotiated, '1999-01-01', 'a server must not echo back a protocol version it cannot speak')
})
