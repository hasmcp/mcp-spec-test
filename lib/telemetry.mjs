// Anonymous usage telemetry: which revision and transport a run tested, and which
// cases landed in which bucket.
//
// Three rules govern everything here, and they are the reason the code is shaped
// the way it is:
//
//   1. It never changes the verdict. The report is already written by the time
//      this runs, and nothing here can alter a result or an exit code.
//   2. It never speaks to the user. Every failure — offline, DNS, a 500, a
//      timeout — is swallowed. A conformance run must not print a word about our
//      metrics pipeline.
//   3. It never touches the server under test. No extra requests are made to the
//      target for telemetry's sake; it reports only what the run already learned.
//
// Opt out with --disable-telemetry=1, or MCP_DISABLE_TELEMETRY=1.

import { caseId } from './case-ids.mjs'
import { serverId } from './hash.mjs'

const ENDPOINT = 'https://telemetry.hasmcp.com/api/v1/usages/mcp-spec-test'

// Fire and forget, but a hung connection would still hold the process open, so
// the request is bounded. Two seconds: this is the tail a user actually feels —
// a half-open connection that accepts and never answers holds the process for
// the full budget, and waiting longer buys nothing a retry would not.
const TIMEOUT_MS = 2000

const SERVER_TYPES = { stdio: 1, 'streamable-http': 2 }

export function isDisabled(env = process.env) {
  return env.MCP_DISABLE_TELEMETRY === '1'
}

/**
 * Turn a run's results into the endpoint's payload, or null when there is
 * nothing worth reporting.
 *
 * Names are mapped to ids and unknown names are dropped rather than guessed at.
 * A run where nothing mapped is not sent at all — that would be a row saying only
 * "somebody ran something", which is noise.
 */
export function buildPayload({ failed, passed, notVerified, specVersion, transport, serverName }) {
  const ids = (names) => [...new Set(names.map(caseId).filter((id) => id !== undefined))]

  const failedTests = ids(failed)
  const passedTests = ids(passed)
  const notVerifiedTests = ids(notVerified)
  if (!failedTests.length && !passedTests.length && !notVerifiedTests.length) return null

  const serverType = SERVER_TYPES[transport]
  if (!serverType || !specVersion) return null

  const payload = { serverType, specVersion, failedTests, passedTests, notVerifiedTests }
  // Hashed here, so the name itself never leaves this process. Absent when the
  // run never learned a name — the field is optional.
  if (serverName) payload.serverId = serverId(serverName)
  return payload
}

/**
 * Send a payload. Resolves either way and never throws, so a caller can await it
 * without a try/catch and without a branch for the failure case.
 */
export async function send(payload, { endpoint = ENDPOINT, timeoutMs = TIMEOUT_MS, fetchImpl = fetch } = {}) {
  if (!payload) return false
  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    })
    return response.ok
  } catch {
    // Deliberately empty. See rule 2 above: the user is running a conformance
    // suite and has no interest in whether our telemetry landed.
    return false
  }
}

/** Build and send in one step, honouring the opt-out. */
export async function report(run, options = {}) {
  if (isDisabled(options.env ?? process.env)) return false
  return send(buildPayload(run), options)
}
