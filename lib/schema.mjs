// Schema-derived assertions.
//
// The point of this module is that the suite asserts what the *spec* requires,
// not what any implementation happens to produce. It reads the vendored
// schema/<revision>/schema.json — a byte-for-byte copy of the published schema —
// and exposes its `required` lists, so updating the schema tightens the tests
// instead of letting them drift.
//
// The schema ships with the suite so it runs in a bare checkout with no other
// repository present. Set MCP_SPEC_PATH to test against a different schema
// (a draft revision, or one pulled straight from the spec repository).

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { LATEST_SPEC_VERSION } from './env.mjs'

const here = dirname(fileURLToPath(import.meta.url))
export const SPEC_PATH = process.env.MCP_SPEC_PATH
  || join(here, '..', 'spec', LATEST_SPEC_VERSION, 'schema.json')

const spec = JSON.parse(readFileSync(SPEC_PATH, 'utf8'))
export const defs = spec.$defs

export function def(name) {
  const d = defs[name]
  if (!d) throw new Error(`${name} is not defined in ${SPEC_PATH} — is the vendored schema current?`)
  return d
}

// requiredFields returns the schema's own `required` list for a definition.
export function requiredFields(name) {
  return def(name).required ?? []
}

// methodConst returns the `const` pinned on a request definition's method
// property, so tests use the spec's method name rather than a typed literal.
export function methodConst(name) {
  const m = def(name).properties?.method?.const
  if (!m) throw new Error(`${name} has no pinned method const in the schema`)
  return m
}

// assertRequiredPresent checks every field the schema marks required is present
// on an actual payload. Returns the list of missing fields.
export function missingRequired(name, payload) {
  const obj = payload ?? {}
  return requiredFields(name).filter((f) => obj[f] === undefined)
}

// FEATURES describes what the revision under test actually has, read from the
// schema rather than branched on the revision date.
//
// The suite already refuses to hand-copy field names — it reads the schema's own
// `required` lists — and test *selection* deserves the same treatment. A case for
// `subscriptions/listen` should run because the revision defines that request,
// not because someone wrote `if (version === '2026-07-28')`. Date branching rots
// the moment the supported window shifts; this does not.
export const FEATURES = {
  // 2026-07-28 replaced the handshake with a discover call and per-request
  // version declaration. Older revisions negotiate once, at initialize.
  discover: !!defs.DiscoverRequest,
  handshake: !!defs.InitializeRequest,
  perRequestVersion: !!defs.RequestMetaObject?.properties?.['io.modelcontextprotocol/protocolVersion'],
  // The CacheableResult envelope: resultType on every result, ttlMs/cacheScope on
  // the cacheable ones.
  resultEnvelope: (defs.ListToolsResult?.required ?? []).includes('resultType'),
  cacheHints: (defs.ListToolsResult?.required ?? []).includes('ttlMs'),
  // subscriptions/listen replaced resources/subscribe and the GET stream.
  listenSubscriptions: !!defs.SubscriptionsListenRequest,
  resourceSubscribe: !!defs.SubscribeRequest,
}

// requireFeature skips a case when the revision under test does not define the
// thing it asserts. Not a weaker assertion — an inapplicable one.
export function requireFeature(t, name) {
  if (!FEATURES[name]) {
    t.skip(`${LATEST_SPEC_VERSION} does not define ${name}; nothing to assert`)
    return false
  }
  return true
}

export const META_KEYS = {
  protocolVersion: 'io.modelcontextprotocol/protocolVersion',
  clientInfo: 'io.modelcontextprotocol/clientInfo',
  clientCapabilities: 'io.modelcontextprotocol/clientCapabilities',
  serverInfo: 'io.modelcontextprotocol/serverInfo',
  subscriptionId: 'io.modelcontextprotocol/subscriptionId',
  logLevel: 'io.modelcontextprotocol/logLevel',
}

// The spec partitions the JSON-RPC server-error range; these are the codes
// 2026-07-28 defines (renumbered from the draft's -32001/-32003/-32004).
export const ERROR_CODES = {
  headerMismatch: -32020,
  missingRequiredClientCapability: -32021,
  unsupportedProtocolVersion: -32022,
}
