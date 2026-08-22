// A conformance report, not a test log.
//
// The default node:test output answers "did the suite pass". The question a
// person actually has is "what does this server do, and where does it deviate",
// and the two differ most in the skips: a skipped case is not a pass, and a run
// full of them can look green while proving almost nothing. So this reporter
// prints three sections — failed, passed, and not verified, each with the reason
// the suite gave — and a verdict that counts them honestly.

import { SUPPORTED_REVISIONS } from './env.mjs'
import { parseShould } from './level.mjs'

const SECTIONS = {
  'discover.test.mjs': 'server/discover',
  'negotiation.test.mjs': 'Version negotiation',
  'result-envelope.test.mjs': 'Result envelope',
  'capabilities.test.mjs': 'Capability methods',
  'subscriptions.test.mjs': 'subscriptions/listen',
  'sdk-compat.test.mjs': 'Official SDK interop',
}

const C = process.stdout.isTTY && !process.env.NO_COLOR
  ? {
    red: (s) => `\x1b[31m${s}\x1b[0m`,
    green: (s) => `\x1b[32m${s}\x1b[0m`,
    yellow: (s) => `\x1b[33m${s}\x1b[0m`,
    dim: (s) => `\x1b[2m${s}\x1b[0m`,
    bold: (s) => `\x1b[1m${s}\x1b[0m`,
  }
  : { red: (s) => s, green: (s) => s, yellow: (s) => s, dim: (s) => s, bold: (s) => s }

function section(file) {
  const base = String(file || '').split('/').pop()
  return SECTIONS[base] || base || 'other'
}

// failureReason digs the human sentence out of node:test's nested error. The
// assertion message is what the suite deliberately wrote to explain the
// deviation, so it is what a reader needs — not the ERR_TEST_FAILURE wrapper.
function failureReason(data) {
  const err = data?.details?.error
  const cause = err?.cause
  if (cause && typeof cause === 'object') {
    if (cause.message) return String(cause.message)
    if (cause.code === 'ERR_ASSERTION') {
      return `expected ${JSON.stringify(cause.expected)}, got ${JSON.stringify(cause.actual)}`
    }
  }
  if (typeof cause === 'string') return cause
  return err?.message || 'failed without a reason'
}

function wrap(text, indent) {
  const width = Math.max(40, (process.stdout.columns || 100) - indent.length)
  const out = []
  let line = ''
  for (const word of String(text).replace(/\s+/g, ' ').trim().split(' ')) {
    if (line && line.length + word.length + 1 > width) {
      out.push(line)
      line = word
    } else {
      line = line ? `${line} ${word}` : word
    }
  }
  if (line) out.push(line)
  return out.map((l) => indent + l).join('\n')
}

export default async function* report(source) {
  const failed = []
  const passed = []
  const skipped = []
  const recommended = []
  let summary = null

  for await (const event of source) {
    const data = event.data
    switch (event.type) {
      case 'test:pass':
        if (data.skip) skipped.push({ ...data, reason: typeof data.skip === 'string' ? data.skip : 'no reason given' })
        else if (data.todo) skipped.push({ ...data, reason: `TODO: ${data.todo}` })
        else passed.push(data)
        break
      case 'test:fail':
        // A file-level failure is a rollup of the cases below it, already listed.
        if (data.details?.error?.failureType !== 'subtestsFailed') failed.push(data)
        break
      case 'test:diagnostic': {
        // A SHOULD that was not met: recorded, not asserted, so it never touches
        // the verdict or the exit code.
        const rec = parseShould(data)
        if (rec) recommended.push({ ...rec, file: data.file })
        break
      }
      case 'test:stderr':
        // Server logs on stderr are useful when something fails; keep them, but
        // out of the report body.
        yield C.dim(data.message)
        break
      case 'test:summary':
        if (!data.file) summary = data
        break
      default:
        break
    }
  }

  const byFile = (list) => {
    const groups = new Map()
    for (const item of list) {
      const key = section(item.file)
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(item)
    }
    return groups
  }

  const target = process.env.MCP_URL || process.env.MCP_COMMAND || '(no target configured)'
  const revision = process.env.MCP_SPEC_VERSION || SUPPORTED_REVISIONS[0]

  yield `\n${C.bold(`MCP ${revision} conformance report`)}\n`
  yield `${C.dim('target')}    ${target}\n`
  yield `${C.dim('transport')} ${process.env.MCP_COMMAND ? 'stdio' : 'streamable-http'}\n`
  // Stated up front so a reader knows the boundary of the verdict below: an
  // older revision is out of scope here, not silently judged.
  yield `${C.dim('supported')} ${SUPPORTED_REVISIONS.join(', ')}\n`

  if (failed.length) {
    yield `\n${C.bold(C.red(`FAILED (${failed.length})`))} ${C.dim('— the server deviates from the spec here')}\n`
    for (const [group, items] of byFile(failed)) {
      yield `\n  ${C.bold(group)}\n`
      for (const item of items) {
        yield `    ${C.red('✗')} ${item.name}\n`
        yield `${wrap(failureReason(item), '        ')}\n`
      }
    }
  }

  if (skipped.length) {
    yield `\n${C.bold(C.yellow(`NOT VERIFIED (${skipped.length})`))} ${C.dim('— skipped; a skip is not a pass')}\n`
    for (const [group, items] of byFile(skipped)) {
      yield `\n  ${C.bold(group)}\n`
      // One missing precondition skips many cases with the identical reason —
      // a target without server/discover skips most of the suite. Printing that
      // sentence twenty times buries the one fact the reader needs, so identical
      // reasons collapse into a single entry.
      const byReason = new Map()
      for (const item of items) {
        if (!byReason.has(item.reason)) byReason.set(item.reason, [])
        byReason.get(item.reason).push(item.name)
      }
      for (const [reason, names] of byReason) {
        for (const name of names) yield `    ${C.yellow('–')} ${name}\n`
        yield `${wrap(reason, '        ')}\n`
      }
    }
  }

  if (recommended.length) {
    yield `\n${C.bold(C.yellow(`RECOMMENDED, NOT MET (${recommended.length})`))} `
      + `${C.dim('— the spec says SHOULD here, so this is not a conformance failure')}\n`
    for (const [group, items] of byFile(recommended)) {
      yield `\n  ${C.bold(group)}\n`
      for (const item of items) {
        yield `    ${C.yellow('!')} ${item.label}\n`
        if (item.detail) yield `${wrap(item.detail, '        ')}\n`
      }
    }
  }

  if (passed.length) {
    yield `\n${C.bold(C.green(`PASSED (${passed.length})`))}\n`
    for (const [group, items] of byFile(passed)) {
      yield `\n  ${C.bold(group)}\n`
      for (const item of items) yield `    ${C.green('✓')} ${item.name}\n`
    }
  }

  const counts = summary?.counts
  yield `\n${C.bold('Summary')}\n`
  yield `  ${C.green(`${passed.length} passed`)}  ${C.red(`${failed.length} failed`)}  `
    + `${C.yellow(`${skipped.length} not verified`)}`
    + (recommended.length ? `  ${C.yellow(`${recommended.length} recommended not met`)}` : '')
    + '\n'
  if (counts) yield `  ${C.dim(`${counts.tests} cases in ${Math.round((summary.duration_ms || 0))}ms`)}\n`

  if (failed.length) {
    yield `\n${C.red('Verdict: not conformant')} — ${failed.length} requirement${failed.length === 1 ? '' : 's'} violated.\n`
  } else if (passed.length === 0) {
    yield `\n${C.yellow('Verdict: nothing verified')} — every case skipped. Check the target and credentials above.\n`
  } else if (skipped.length) {
    yield `\n${C.green('Verdict: conformant on what could be checked')} — ${skipped.length} case${skipped.length === 1 ? '' : 's'} could not be verified; read the reasons before claiming full conformance.\n`
  } else {
    yield `\n${C.green('Verdict: fully conformant')} — every case in the suite was checked and passed.\n`
  }
  yield '\n'
}
