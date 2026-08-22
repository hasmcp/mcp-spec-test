// A hand-written client for the revision under test.
//
// The official @modelcontextprotocol/sdk cannot yet drive 2026-07-28 (see
// tests/sdk-compat.test.mjs, which asserts that gap rather than assuming it), so
// conformance to the current spec is exercised over raw JSON-RPC. Everything
// here is transport-agnostic: it builds messages and hands them to
// lib/transport.mjs.

import { LATEST_SPEC_VERSION, STREAM_BUDGET_MS } from './env.mjs'
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
    meta[META_KEYS.clientInfo] = { name: 'mcp-spec-test', version: '1.0.0' }
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

// call sends one JSON-RPC request and returns { status, headers, body }.
//
// `version` sets both the _meta protocolVersion and — on Streamable HTTP — the
// MCP-Protocol-Version header, which the spec requires to agree. Pass
// `headerVersion` to deliberately disagree (the HeaderMismatch case), or null to
// omit one side entirely. On stdio there is no header, so headerVersion is inert.
export async function call(method, {
  params,
  version = LATEST_SPEC_VERSION,
  headerVersion,
  meta = true,
  clientInfo = true,
  id,
  url,
  extraHeaders = {},
} = {}) {
  // A handshake-based revision needs its session opened before ordinary traffic,
  // and every request inside it carries the session id. open() is a no-op and
  // costs nothing on revisions that declare the version per request.
  await session.open()

  const headers = { ...session.headers(), ...extraHeaders }
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

// requireNotThrottled turns a throttled response into a skip that names the
// cause, for cases that are not already gated on the probe.
export function requireNotThrottled(t, res, context = '') {
  if (!throttled(res)) return true
  t.skip(`target rate-limited the suite${context ? ` on ${context}` : ''} — raise the limit or re-run later; a throttled run proves nothing`)
  return false
}
