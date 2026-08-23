// The terminal report: the default, and the only one a human reads while waiting.
//
// Output here is deliberately unchanged from before the renderers were split out
// — same sections, same wording, same colours — because it is what every existing
// user and CI log already looks like.

import { bold, dim, green, red, yellow } from './colour.mjs'
import { bySection } from './report-model.mjs'

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

export function renderText(model) {
  const { counts, cases } = model
  let out = ''

  out += `\n${bold(`MCP ${model.specVersion} conformance report`)}\n`
  out += `${dim('target')}    ${model.target}\n`
  out += `${dim('transport')} ${model.transport}\n`
  // Stated up front so a reader knows the boundary of the verdict below: an
  // older revision is out of scope here, not silently judged.
  out += `${dim('supported')} ${model.supportedRevisions.join(', ')}\n`

  if (counts.failed) {
    out += `\n${bold(red(`FAILED (${counts.failed})`))} ${dim('— the server deviates from the spec here')}\n`
    for (const [group, items] of bySection(cases.failed)) {
      out += `\n  ${bold(group)}\n`
      for (const item of items) {
        out += `    ${red('✗')} ${item.name}\n`
        out += `${wrap(item.reason, '        ')}\n`
      }
    }
  }

  if (counts.notVerified) {
    out += `\n${bold(yellow(`NOT VERIFIED (${counts.notVerified})`))} ${dim('— skipped; a skip is not a pass')}\n`
    for (const [group, items] of bySection(cases.notVerified)) {
      out += `\n  ${bold(group)}\n`
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
        for (const name of names) out += `    ${yellow('–')} ${name}\n`
        out += `${wrap(reason, '        ')}\n`
      }
    }
  }

  if (counts.recommendedNotMet) {
    out += `\n${bold(yellow(`RECOMMENDED, NOT MET (${counts.recommendedNotMet})`))} `
      + `${dim('— the spec says SHOULD here, so this is not a conformance failure')}\n`
    for (const [group, items] of bySection(cases.recommendedNotMet)) {
      out += `\n  ${bold(group)}\n`
      for (const item of items) {
        out += `    ${yellow('!')} ${item.label}\n`
        if (item.detail) out += `${wrap(item.detail, '        ')}\n`
      }
    }
  }

  if (counts.passed) {
    out += `\n${bold(green(`PASSED (${counts.passed})`))}\n`
    for (const [group, items] of bySection(cases.passed)) {
      out += `\n  ${bold(group)}\n`
      for (const item of items) out += `    ${green('✓')} ${item.name}\n`
    }
  }

  out += `\n${bold('Summary')}\n`
  out += `  ${green(`${counts.passed} passed`)}  ${red(`${counts.failed} failed`)}  `
    + `${yellow(`${counts.notVerified} not verified`)}`
    + (counts.recommendedNotMet ? `  ${yellow(`${counts.recommendedNotMet} recommended not met`)}` : '')
    + '\n'
  out += `  ${dim(`${counts.applied} case${counts.applied === 1 ? '' : 's'} applied, in ${model.durationMs}ms`)}\n`

  // Wording comes from the model, so every format agrees on it; the colour and
  // the "Verdict:" prefix are this renderer's.
  const colour = model.verdict.code === 'not-conformant'
    ? red
    : model.verdict.code === 'nothing-verified' ? yellow : green
  out += `\n${colour(`Verdict: ${model.verdict.label}`)} — ${model.verdict.detail}\n`
  out += '\n'
  return out
}
