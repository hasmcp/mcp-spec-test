// A hand-written client for the revision under test.
//
// The official @modelcontextprotocol/sdk cannot yet drive 2026-07-28 (see
// tests/sdk-compat.test.mjs, which asserts that gap rather than assuming it), so
// conformance to the current spec is exercised over raw JSON-RPC. Everything
// here is transport-agnostic: it builds messages and hands them to
// lib/transport.mjs.

import { LATEST_SPEC_VERSION, STREAM_BUDGET_MS } from './env.mjs'
import { version as pkgVersion } from './pkg.mjs'
import { FEATURES, META_KEYS } from './schema.mjs'
import * as session from './session.mjs'
import { transport } from './transport.mjs'

let nextId = 1

// requestMeta builds the per-request _meta the current revision requires.
// protocolVersion and clientCapabilities are both required by
// RequestMetaObject; clientInfo is a SHOULD, so it is included by default.
export function requestMeta({ version = LATEST_SPEC_VERSION, capabilities = {}, clientInfo = true, logLevel } = {}) {
  const meta = {
    [META_KEYS.protocolVersion]: version,
    [META_KEYS.clientCapabilities]: capabilities,
  }
  if (clientInfo) {
    meta[META_KEYS.clientInfo] = { name: 'mcp-spec-test', version: pkgVersion }
  }
  if (logLevel) meta[META_KEYS.logLevel] = logLevel
  return meta
}

export function buildRequest(method, { params, version = LATEST_SPEC_VERSION, meta = true, clientInfo = true, id } = {}) {
  const body = { jsonrpc: '2.0', id: id ?? nextId++, method }
  const p = { ...(params ?? {}) }
  // Only revisions that declare the version per request carry it in _meta.
  // Sending it to an older revision would be inventing a field its schema does
  // not have, which is exactly the kind of thing this suite exists to catch.
  if (meta && version && FEATURES.perRequestVersion) {
    p._meta = { ...requestMeta({ version, clientInfo }), ...(params?._meta ?? {}) }
  } else if (params?._meta) {
    p._meta = params._meta
  }
  if (Object.keys(p).length > 0) body.params = p
  return body
}

// HANDSHAKE_METHODS are the requests that *establish* a session rather than
// travel inside one. They must not be preceded by a handshake and must not carry
// a session id — see `withinSession` below.
const HANDSHAKE_METHODS = new Set(['initialize'])

// call sends one JSON-RPC request and returns { status, headers, body }.
//
// `version` sets both the _meta protocolVersion and — on Streamable HTTP — the
// MCP-Protocol-Version header, which the spec requires to agree. Pass
// `headerVersion` to deliberately disagree (the HeaderMismatch case), or null to
// omit one side entirely. On stdio there is no header, so headerVersion is inert.
//
// `withinSession` decides whether this request belongs inside an existing
// session. It defaults to true for everything except `initialize`, and that
// exception is not cosmetic. `initialize` *is* the handshake: opening a session
// before sending it, and then sending it with that session's id, asks the server
// to initialize a session that is already initialized. A conformant server
// refuses exactly that — the official SDK asserts the refusal in its own tests —
// so the suite would be reading its own bug as a server defect. It did:
// "target does not answer initialize: duplicate \"initialize\" received".
//
// Worth stating what that cost, because the false skip was the lesser half. The
// negotiation case that offers an impossible version and accepts an error as
// proof of refusal was *passing on the duplicate error* — certifying a
// requirement it had never actually tested.
export async function call(method, {
  params,
  version = LATEST_SPEC_VERSION,
  headerVersion,
  meta = true,
  clientInfo = true,
  id,
  url,
  extraHeaders = {},
  withinSession,
} = {}) {
  const inSession = withinSession ?? !HANDSHAKE_METHODS.has(method)

  // A handshake-based revision needs its session opened before ordinary traffic,
  // and every request inside it carries the session id. open() is a no-op and
  // costs nothing on revisions that declare the version per request.
  if (inSession) await session.open()

  const headers = { ...(inSession ? session.headers() : {}), ...extraHeaders }
  const hv = headerVersion === undefined ? version : headerVersion
  if (hv) headers['mcp-protocol-version'] = hv

  const body = buildRequest(method, { params, version, meta, clientInfo, id })
  return transport.send(body, { headers, url })
}

// listen sends a request expected to answer with a stream and collects frames.
// Returns { streaming, reason, frames } — `streaming: false` means the target
// answered without a stream, which the streaming tests report as a skip rather
// than a failure, because a non-streaming answer says nothing about conformance
// to the streaming requirements.
export async function listen(method, {
  params,
  version = LATEST_SPEC_VERSION,
  id,
  budgetMs = STREAM_BUDGET_MS,
  stop,
  onFrame,
} = {}) {
  await session.open()
  const body = buildRequest(method, { params, version, id })
  return transport.listen(body, {
    headers: { 'mcp-protocol-version': version, ...session.headers() },
    budgetMs,
    stop,
    onFrame,
  })
}

// notify sends a notification: no id, no reply. Used for the handshake's
// initialized notification and for cancelling an in-flight request.
export async function notify(method, { params, version = LATEST_SPEC_VERSION } = {}) {
  await session.open()
  const body = { jsonrpc: '2.0', method }
  if (params) body.params = params
  return transport.notify(body, {
    headers: { ...(version ? { 'mcp-protocol-version': version } : {}), ...session.headers() },
  })
}

// result unwraps a successful response, failing loudly on a JSON-RPC error so a
// test's assertion message names the error rather than "undefined".
export function result(res, context = '') {
  if (res.body?.error) {
    throw new Error(`${context} unexpected JSON-RPC error: ${JSON.stringify(res.body.error)}`)
  }
  return res.body?.result
}

export function rpcError(res) {
  return res.body?.error
}

// throttled recognises a rate-limited response.
//
// A throttled run says nothing about conformance, so reporting it as a spec
// deviation is worse than useless — it invents findings. Deployments express it
// differently (an HTTP 429, or a 200 carrying a 429-ish error body), so both
// shapes are recognised.
export function throttled(res) {
  if (res?.status === 429) return true
  const err = res?.body?.error
  if (!err) return false
  return err.code === 429 || /rate.?limit/i.test(String(err.message ?? ''))
}

// unauthorized recognises a response that was refused for lack of credentials.
//
// Like a rate limit, this is not an answer about conformance: a server that will
// not talk to you has told you nothing about whether it implements the spec.
// Failing the case would manufacture findings out of a missing token.
export function unauthorized(res) {
  if (res?.status === 401 || res?.status === 403) return true
  const code = res?.body?.error?.code
  return code === 401 || code === 403
}

// requireReachable turns "could not ask" into a skip that names why, for cases
// that are not already gated on the probe. Rate limits and refused credentials
// are different causes with the same consequence: nothing was learned.
export function requireReachable(t, res, context = '') {
  const where = context ? ` on ${context}` : ''
  if (throttled(res)) {
    t.skip(`target rate-limited the suite${where} — raise the limit or re-run later; a throttled run proves nothing`)
    return false
  }
  if (unauthorized(res)) {
    t.skip(`target refused the credentials${where} (HTTP ${res.status}) — supply a token or OAuth client credentials; an unauthenticated run proves nothing`)
    return false
  }
  return true
}

// requireNotThrottled is kept as the narrower name for callers that only care
// about pacing.
export const requireNotThrottled = requireReachable
