// Target configuration.
//
// mcp-spec-test is a black-box conformance suite: it knows nothing about the
// implementation under test beyond how to reach it. Two transports are
// supported, matching the two the spec defines:
//
//   MCP_URL      — a Streamable HTTP endpoint
//   MCP_COMMAND  — a command line to spawn and speak stdio to
//
// Exactly one should be set. Everything else here is optional and exists only
// because real deployments put credentials in different places.

import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// The revisions this suite takes an interest in, newest first.
//
// Read from the vendored schemas rather than hardcoded, so the newest revision on
// disk is always the one under test. Adding support for a new spec is dropping
// its published schema at spec/<date>/schema.json — no code change, and no risk
// of the list and the shipped schemas disagreeing about what is supported.
//
// Trimmed to the two most recent. Older revisions are still out there and a
// server may well advertise them, but "supported" here means the suite has a
// schema for it and will reason about it, and a conformance tool that claims to
// cover revisions it cannot assert against is worse than one with a stated
// window. Anything outside it is reported as out of scope, not quietly accepted.
export const REVISION_WINDOW = 2

const specDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'spec')

function vendoredRevisions() {
  const dated = readdirSync(specDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(e.name))
    .map((e) => e.name)
    // Revision ids are ISO dates, so lexical order is chronological order.
    .sort()
    .reverse()
  if (dated.length === 0) {
    throw new Error(`no vendored schemas found in ${specDir} — expected spec/<yyyy-mm-dd>/schema.json`)
  }
  return dated
}

export const VENDORED_REVISIONS = vendoredRevisions()
export const SUPPORTED_REVISIONS = VENDORED_REVISIONS.slice(0, REVISION_WINDOW)

// The revision whose conformance is asserted: the newest one shipped, unless
// overridden — and only within the window, since a schema the suite does not
// ship cannot be asserted against.
export const LATEST_SPEC_VERSION = process.env.MCP_SPEC_VERSION || SUPPORTED_REVISIONS[0]

if (!SUPPORTED_REVISIONS.includes(LATEST_SPEC_VERSION) && !process.env.MCP_SPEC_PATH) {
  const vendored = VENDORED_REVISIONS.includes(LATEST_SPEC_VERSION)
    ? `it is vendored but older than the ${REVISION_WINDOW}-revision window`
    : 'it is not vendored'
  throw new Error(
    `MCP_SPEC_VERSION=${LATEST_SPEC_VERSION} is not supported: ${vendored}. `
    + `Supported: ${SUPPORTED_REVISIONS.join(', ')}. Drop its schema.json under spec/<date>/ `
    + 'to make it the revision under test, or point MCP_SPEC_PATH at a schema explicitly.',
  )
}

// inWindow answers whether a revision is one the suite will reason about.
export function inWindow(version) {
  return SUPPORTED_REVISIONS.includes(version)
}

export const MCP_URL = process.env.MCP_URL
export const MCP_COMMAND = process.env.MCP_COMMAND
export const MCP_TOKEN = process.env.MCP_TOKEN

export const TRANSPORT = MCP_COMMAND ? 'stdio' : MCP_URL ? 'http' : null

export function requireTarget(t) {
  if (!TRANSPORT) {
    t.skip('no target: set MCP_URL (Streamable HTTP) or MCP_COMMAND (stdio) — see README')
    return false
  }
  return true
}

// requireHttp guards cases that assert something only Streamable HTTP defines
// (response headers, status codes). They are not weaker requirements on stdio,
// they simply do not exist there, so skipping is the honest outcome.
export function requireHttp(t) {
  if (!requireTarget(t)) return false
  if (TRANSPORT !== 'http') {
    t.skip('Streamable-HTTP-only requirement; target is stdio')
    return false
  }
  return true
}

// ---------------------------------------------------------------------------
// Credentials
//
// The spec expects OAuth 2.1 bearer tokens in the standard `Authorization`
// header, which is the default here. Servers that deviate are common enough
// that the suite can be told where the credential goes instead of being unable
// to test them:
//
//   MCP_AUTH_MODE=header  (default) — MCP_AUTH_HEADER: <scheme> <token>
//   MCP_AUTH_MODE=query            — ?<MCP_AUTH_QUERY_PARAM>=<token>
//   MCP_AUTH_MODE=none             — send no credential
//
// A token in a URL lands in access logs, proxy logs and browser history, so
// query mode is a deliberate trade a target has already made, never a default.
export const MCP_AUTH_HEADER = (process.env.MCP_AUTH_HEADER || 'authorization').toLowerCase()
export const MCP_AUTH_QUERY_PARAM = process.env.MCP_AUTH_QUERY_PARAM || 'token'
export const MCP_AUTH_MODE = ['query', 'none', 'header'].includes(process.env.MCP_AUTH_MODE)
  ? process.env.MCP_AUTH_MODE
  : 'header'

// The token prefix. Defaults to the standard `Bearer `; set MCP_AUTH_SCHEME=''
// for a server that wants the bare token.
export const MCP_AUTH_SCHEME = process.env.MCP_AUTH_SCHEME ?? 'Bearer'

export function authHeaders() {
  if (!MCP_TOKEN || MCP_AUTH_MODE !== 'header') return {}
  const value = MCP_AUTH_SCHEME ? `${MCP_AUTH_SCHEME} ${MCP_TOKEN}` : MCP_TOKEN
  return { [MCP_AUTH_HEADER]: value }
}

// targetURL returns the endpoint with the credential attached as a query
// parameter when that mode is selected, so callers need no other change.
export function targetURL(base = MCP_URL) {
  if (!base || !MCP_TOKEN || MCP_AUTH_MODE !== 'query') return base
  const url = new URL(base)
  url.searchParams.set(MCP_AUTH_QUERY_PARAM, MCP_TOKEN)
  return url.toString()
}

// Extra headers a target needs (tenant ids, API keys alongside the token):
//   MCP_EXTRA_HEADERS='x-tenant: acme, x-api-key: abc'
export function extraHeaders() {
  const raw = process.env.MCP_EXTRA_HEADERS
  if (!raw) return {}
  const out = {}
  for (const pair of raw.split(',')) {
    const idx = pair.indexOf(':')
    if (idx === -1) continue
    out[pair.slice(0, idx).trim().toLowerCase()] = pair.slice(idx + 1).trim()
  }
  return out
}

// Surface the target's own stderr. Off by default so a server that greets on
// startup does not print banners over the report; on when debugging a failure.
export const VERBOSE = process.env.MCP_VERBOSE === '1' || process.env.MCP_VERBOSE === 'true'

// Arguments for tools and prompts that require them.
//
// The suite will not invent values for a tool whose side effects it cannot know —
// a tool named `delete_everything` with a required `confirm` is not something to
// guess at — so by default those cases skip and say so. An operator testing their
// own server knows what is safe, and this is how they say it:
//
//   --tool-args '{"search":{"query":"test"},"echo":{"message":"hi"}}'
//   --prompt-args '{"review":{"file":"README.md"}}'
//
// Keyed by tool/prompt name, so one flag covers a whole server.
function parseArgMap(raw, label) {
  if (!raw) return {}
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(`${label} is not valid JSON: ${err.message}`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object keyed by name, got ${JSON.stringify(parsed)}`)
  }
  return parsed
}

export const TOOL_ARGS = parseArgMap(process.env.MCP_TOOL_ARGS, 'MCP_TOOL_ARGS')
export const PROMPT_ARGS = parseArgMap(process.env.MCP_PROMPT_ARGS, 'MCP_PROMPT_ARGS')

// How many listed resources to read. Reading one proves the method answers;
// reading several is what catches a server that only handles its first entry.
// Bounded because a server may list thousands.
export const RESOURCE_SAMPLE = Number(process.env.MCP_RESOURCE_SAMPLE || 5)

// Cap on pages walked when following nextCursor, so a server with a broken
// cursor that never advances cannot spin the suite forever.
export const PAGE_LIMIT = Number(process.env.MCP_PAGE_LIMIT || 10)

// Pace outgoing requests, for targets that rate-limit.
//
// Given as requests per minute because that is how deployments express their
// limits — HasMCP's default is 60 per 60s — so the number here can be copied
// from the server's configuration rather than converted in your head. A full
// pass makes more requests than that, which is why an unthrottled run against a
// default deployment gets 429s partway through.
export const RATE_LIMIT_PER_MIN = Number(process.env.MCP_RATE_LIMIT || 0)
export const MIN_REQUEST_INTERVAL_MS = RATE_LIMIT_PER_MIN > 0
  ? Math.ceil(60000 / RATE_LIMIT_PER_MIN)
  : 0

// How long the suite will wait out a rate limit before giving up on a request.
//
// A 429 is not a conformance answer, so the useful response is to wait and try
// again rather than either failing the case or hammering. Zero disables the
// wait, in which case a throttled request is reported as unverified immediately.
export const RETRY_BUDGET_MS = process.env.MCP_RETRY_BUDGET_MS === undefined
  ? 60000
  : Number(process.env.MCP_RETRY_BUDGET_MS)

// How long a streaming case waits before giving up on frames.
export const STREAM_BUDGET_MS = Number(process.env.MCP_STREAM_BUDGET_MS || 4000)
