// Capability discovery.
//
// A suite that can be pointed at *any* server cannot be told out-of-band what
// that server supports — and it does not have to be, because 2026-07-28 added
// `server/discover` for exactly this: one unauthenticated, handshake-free call
// that reports which protocol versions the server can serve and which
// capabilities it offers.
//
// So the suite asks. Everything downstream keys off the answer:
//
//   - a server that does not advertise the revision under test skips the
//     revision-specific cases, with the advertised list quoted in the reason
//   - a server that advertises no capability for prompts/resources skips those
//     cases instead of failing on a method it never claimed
//   - the "older client sees no new fields" case picks a real older version out
//     of the advertised list rather than trusting a configured constant
//
// A skip is not a pass. Every skip names what was missing so a run cannot be
// mistaken for conformance the server never demonstrated.

import { LATEST_SPEC_VERSION, SUPPORTED_REVISIONS, TRANSPORT, inWindow } from './env.mjs'
import { call, throttled } from './rpc.mjs'
import { FEATURES } from './schema.mjs'
import * as session from './session.mjs'

let cached = null

// discover performs the version-less server/discover once per process and caches
// it. Version-less on purpose: discover MUST be answerable without a negotiated
// version, and the response tells us what the server defaults to.
export async function probe() {
  if (cached) return cached

  // A revision without server/discover has to be asked the older way. The point
  // stands either way: capabilities come from the server, not from configuration
  // — only the question changes.
  if (!FEATURES.discover) {
    cached = await probeByHandshake()
    return cached
  }

  let res
  try {
    res = await call('server/discover', { version: null, meta: false, headerVersion: null })
  } catch (err) {
    cached = unreachable(err?.message || String(err))
    return cached
  }

  const out = res.body?.result
  if (!out) {
    const why = throttled(res)
      ? 'target rate-limited the suite, so what it supports could not be established'
      : res.body?.error
        ? `server/discover returned an error: ${JSON.stringify(res.body.error)}`
        : `server/discover returned no result (status ${res.status})`
    cached = unreachable(why)
    return cached
  }

  const supportedVersions = Array.isArray(out.supportedVersions) ? out.supportedVersions.slice() : []

  cached = {
    ok: true,
    reason: null,
    discover: out,
    capabilities: out.capabilities ?? {},
    supportedVersions,
    // The version the server negotiated for a client that declared none. On
    // Streamable HTTP the server must echo it; stdio has no header, so allow an
    // override and otherwise fall back to the newest advertised version.
    defaultVersion:
      process.env.MCP_SERVER_DEFAULT_VERSION
      || (TRANSPORT === 'http' ? res.headers.get('mcp-protocol-version') : null)
      || newest(supportedVersions),
    servesLatest: supportedVersions.includes(LATEST_SPEC_VERSION),
    // The newest advertised revision that is *not* the one under test, and is
    // inside the suite's window. Used by the backward-compatibility cases, which
    // need an older version the server actually serves *and* the suite has a
    // schema for — a server whose only older revision is 2024-11-05 gets those
    // cases skipped as out of scope rather than checked against assumptions.
    olderVersion: newest(supportedVersions.filter((v) => v !== LATEST_SPEC_VERSION && inWindow(v))),
    // Advertised revisions the suite does not reason about, kept so a skip can
    // say what was there rather than just that nothing usable was.
    outOfWindow: supportedVersions.filter((v) => !inWindow(v)),
    viaHandshake: false,
  }
  return cached
}

// probeByHandshake builds the same shape from an initialize result, which is
// where a handshake-based revision reports its capabilities and the version it
// settled on.
async function probeByHandshake() {
  const s = await session.open()
  if (!s.ok) return unreachable(s.reason)

  // initialize reports one negotiated version rather than a list, so that is the
  // only revision known to be servable. Claiming more would be a guess.
  const negotiated = s.protocolVersion || LATEST_SPEC_VERSION
  return {
    ok: true,
    reason: null,
    discover: null,
    capabilities: s.capabilities ?? {},
    supportedVersions: [negotiated],
    defaultVersion: process.env.MCP_SERVER_DEFAULT_VERSION || negotiated,
    servesLatest: negotiated === LATEST_SPEC_VERSION,
    // A handshake reveals exactly one version, so there is no second revision to
    // check compatibility against. That is a real absence, not a failure.
    olderVersion: null,
    outOfWindow: inWindow(negotiated) ? [] : [negotiated],
    viaHandshake: true,
  }
}

function unreachable(reason) {
  return {
    ok: false,
    reason,
    discover: null,
    capabilities: {},
    supportedVersions: [],
    defaultVersion: process.env.MCP_SERVER_DEFAULT_VERSION || null,
    servesLatest: false,
    olderVersion: null,
    outOfWindow: [],
    viaHandshake: false,
  }
}

// Revision ids are ISO dates, so lexical order is chronological order.
function newest(versions) {
  return versions.length ? versions.slice().sort().at(-1) : null
}

// requireLatest guards every case that asserts a 2026-07-28-only requirement.
// A server that does not advertise the revision is not failing those
// requirements — it never claimed them — so the case skips, naming what the
// server did advertise.
export async function requireLatest(t) {
  const p = await probe()
  if (!p.ok) {
    t.skip(`cannot determine what the target supports — ${p.reason}`)
    return null
  }
  if (!p.servesLatest) {
    t.skip(`target does not advertise ${LATEST_SPEC_VERSION}; it offers ${JSON.stringify(p.supportedVersions)}`)
    return null
  }
  return p
}

// requireOlderVersion guards the backward-compatibility cases, which need a
// second, older revision the server also serves.
export async function requireOlderVersion(t) {
  const p = await requireLatest(t)
  if (!p) return null
  if (!p.olderVersion) {
    const why = p.viaHandshake
      ? `${LATEST_SPEC_VERSION} negotiates one version at the handshake, so there is no second `
        + 'revision to check compatibility against'
      : p.outOfWindow.length
      ? `target's only older revisions are ${JSON.stringify(p.outOfWindow)}, outside the supported window `
        + `(${SUPPORTED_REVISIONS.join(', ')})`
      : `target serves only ${JSON.stringify(p.supportedVersions)} — no older revision to check compatibility against`
    t.skip(why)
    return null
  }
  return p
}

// requireCapability guards cases for an optional feature. `tools`, `prompts`,
// `resources`, `logging`, `completions` are the ServerCapabilities keys.
export async function requireCapability(t, name) {
  const p = await requireLatest(t)
  if (!p) return null
  if (!p.capabilities?.[name]) {
    t.skip(`target does not advertise the "${name}" capability: ${JSON.stringify(Object.keys(p.capabilities))}`)
    return null
  }
  return p
}

// requireSubCapability guards a sub-flag such as resources.subscribe or
// tools.listChanged.
export async function requireSubCapability(t, name, sub) {
  const p = await requireCapability(t, name)
  if (!p) return null
  if (!p.capabilities[name]?.[sub]) {
    t.skip(`target does not advertise ${name}.${sub}`)
    return null
  }
  return p
}
