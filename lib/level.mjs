// MUST and SHOULD are different claims, and a conformance tool that conflates
// them is wrong in a way that matters.
//
// The spec uses both. "Invalid cursors SHOULD result in an error with code
// -32602" is a recommendation; reporting a server that ignores it as *not
// conformant*, with the same weight as a violated MUST, overstates the finding
// and devalues the real ones. But dropping the check loses a genuine interop
// hazard, and the runner has only pass, fail and skip.
//
// So a SHOULD is recorded rather than asserted: the case still passes, and the
// observation is emitted as a diagnostic the reporter collects into its own
// RECOMMENDED section, outside the pass/fail verdict and outside the exit code.

const MARKER = 'SHOULD'

// should records a recommendation that was not met. Returns whether it held, so
// a caller can stop early.
export function should(t, held, label, detail) {
  if (held) return true
  t.diagnostic(`${MARKER} ${label} — ${detail}`)
  return false
}

// parse recognises the diagnostics emitted above. Run-level summary diagnostics
// carry no file, which is what separates them from a case's own output.
export function parseShould(data) {
  if (!data?.file) return null
  const message = String(data.message ?? '')
  if (!message.startsWith(`${MARKER} `)) return null
  const body = message.slice(MARKER.length + 1)
  const split = body.indexOf(' — ')
  return split === -1
    ? { label: body, detail: '' }
    : { label: body.slice(0, split), detail: body.slice(split + 3) }
}
