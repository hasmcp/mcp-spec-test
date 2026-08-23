// The report as Markdown, for a pull request comment or a wiki page.
//
// Written so it reads well as plain text too, since a Markdown file is as often
// catted as rendered: no HTML, no nested tables, and reasons on their own lines
// rather than crammed into table cells where they would need wrapping.

import { bySection } from './report-model.mjs'

// Escapes the characters that would turn a case name or a server's error message
// into unintended formatting. Reasons come from the target, so they are not
// trusted to be Markdown-safe.
function escape(text) {
  return String(text).replace(/([\\`*_[\]<>|])/g, '\\$1')
}

function heading(model) {
  const { counts } = model
  return [
    `# MCP ${model.specVersion} conformance report`,
    '',
    `**Verdict: ${escape(model.verdict.label)}** — ${escape(model.verdict.detail)}`,
    '',
    '| | |',
    '| --- | --- |',
    `| Target | \`${escape(model.target)}\` |`,
    `| Transport | ${model.transport} |`,
    `| Revision tested | ${model.specVersion} |`,
    `| Revisions supported | ${model.supportedRevisions.join(', ')} |`,
    `| Passed | ${counts.passed} |`,
    `| Failed | ${counts.failed} |`,
    `| Not verified | ${counts.notVerified} |`,
    ...(counts.recommendedNotMet ? [`| Recommended, not met | ${counts.recommendedNotMet} |`] : []),
    `| Cases applied | ${counts.applied} |`,
    `| Duration | ${model.durationMs}ms |`,
    `| Generated | ${model.generatedAt} |`,
    `| Tool | ${model.tool.name} ${model.tool.version} |`,
    '',
  ]
}

function caseSection(title, note, cases, render) {
  if (!cases.length) return []
  const lines = [`## ${title} (${cases.length})`, '', `_${note}_`, '']
  for (const [group, items] of bySection(cases)) {
    lines.push(`### ${escape(group)}`, '')
    for (const item of items) lines.push(...render(item))
    lines.push('')
  }
  return lines
}

export function renderMarkdown(model) {
  const { cases } = model
  const lines = [
    ...heading(model),
    ...caseSection('Failed', 'the server deviates from the spec here', cases.failed, (item) => [
      `- **${escape(item.name)}**`,
      `  ${escape(item.reason)}`,
    ]),
    ...caseSection('Not verified', 'skipped; a skip is not a pass', cases.notVerified, (item) => [
      `- **${escape(item.name)}**`,
      `  ${escape(item.reason)}`,
    ]),
    ...caseSection(
      'Recommended, not met',
      'the spec says SHOULD here, so this is not a conformance failure',
      cases.recommendedNotMet,
      (item) => [`- **${escape(item.label)}**`, ...(item.detail ? [`  ${escape(item.detail)}`] : [])],
    ),
    ...caseSection('Passed', 'checked and conformant', cases.passed, (item) => [
      `- ${escape(item.name)}`,
    ]),
  ]
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`
}
