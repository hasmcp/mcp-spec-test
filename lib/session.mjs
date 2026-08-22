// The handshake, for revisions that have one.
//
// 2026-07-28 declares the protocol version on every request and needs no session.
// Every revision before it negotiates once, at `initialize`, and then expects
// `notifications/initialized` before ordinary traffic — and on Streamable HTTP it
// hands back an `Mcp-Session-Id` that subsequent requests must carry.
//
// So which of those two worlds the suite is in is not a matter of configuration:
// it follows from whether the revision under test defines InitializeRequest. This
// module does nothing at all in the per-request-version world, and performs
// exactly one handshake in the other, cached for the process.

import { LATEST_SPEC_VERSION } from './env.mjs'
import { FEATURES } from './schema.mjs'
import { transport } from './transport.mjs'

let session = null

// needed answers whether the revision under test requires a handshake before
// ordinary requests are legal.
export function needed() {
  return FEATURES.handshake && !FEATURES.perRequestVersion
}

// open performs the handshake and returns
// { ok, sessionId, protocolVersion, capabilities, serverInfo, reason }.
// Cached: a second call returns the same session rather than renegotiating.
export async function open() {
  if (!needed()) return { ok: true, skipped: true, sessionId: null }
  if (session) return session

  const res = await transport.send({
    jsonrpc: '2.0',
    id: 'mcp-spec-test-initialize',
    method: 'initialize',
    params: {
      protocolVersion: LATEST_SPEC_VERSION,
      capabilities: {},
      clientInfo: { name: 'mcp-spec-test', version: '1.0.0' },
    },
  }, { headers: { 'mcp-protocol-version': LATEST_SPEC_VERSION } })

  if (res.body?.error) {
    session = { ok: false, reason: `initialize failed: ${JSON.stringify(res.body.error)}`, sessionId: null }
    return session
  }
  const out = res.body?.result
  if (!out) {
    session = { ok: false, reason: `initialize returned no result (status ${res.status})`, sessionId: null }
    return session
  }

  // The server may negotiate down. Carrying on as though it agreed to the
  // requested revision would assert that revision's requirements against a
  // server that said no, so the mismatch is reported instead.
  if (out.protocolVersion && out.protocolVersion !== LATEST_SPEC_VERSION) {
    session = {
      ok: false,
      reason: `server negotiated ${out.protocolVersion}, not the ${LATEST_SPEC_VERSION} under test`,
      sessionId: null,
      protocolVersion: out.protocolVersion,
    }
    return session
  }

  const sessionId = res.headers?.get?.('mcp-session-id') ?? null

  // The spec requires the notification before ordinary requests; it carries no
  // reply, so there is nothing to check beyond sending it.
  await transport.notify?.({ jsonrpc: '2.0', method: 'notifications/initialized' }, {
    headers: sessionHeaders(sessionId),
  })

  session = {
    ok: true,
    sessionId,
    protocolVersion: out.protocolVersion,
    capabilities: out.capabilities ?? {},
    serverInfo: out.serverInfo,
  }
  return session
}

function sessionHeaders(id) {
  return id ? { 'mcp-session-id': id } : {}
}

// headers returns what an ordinary request must carry to stay inside the session.
export function headers() {
  return sessionHeaders(session?.sessionId ?? null)
}

// require guards a case that cannot run without a live session, skipping with the
// handshake's own failure reason rather than a generic message.
export async function require(t) {
  const s = await open()
  if (s.skipped) return true // no handshake needed in this revision
  if (!s.ok) {
    t.skip(`no session — ${s.reason}`)
    return false
  }
  return true
}

export function reset() {
  session = null
}
