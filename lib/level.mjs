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

// A skip has two very different meanings, and reporting them together makes both
// harder to read.
//
//   not applicable — the revision under test does not define the thing, or the
//                    transport has no such requirement. There is nothing to
//                    check and there never will be for this target. Noise.
//   not verified   — the requirement applies to this target, but the run could
//                    not establish it: a capability was not advertised, a call
//                    needed arguments, the stream never opened. This is the list
//                    a reader has to work through before claiming conformance.
//
// The runner only has "skip", so the distinction is carried in the reason and
// split by the reporter.
const NA_MARKER = 'n/a:'

// skipNotApplicable marks a case that cannot apply to this target at all.
export function skipNotApplicable(t, reason) {
  t.skip(`${NA_MARKER} ${reason}`)
  return false
}

// notApplicable returns the reason when a skip was inapplicable rather than
// unverified, and null otherwise.
export function notApplicable(reason) {
  const text = String(reason ?? '')
  return text.startsWith(NA_MARKER) ? text.slice(NA_MARKER.length).trim() : null
}

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
