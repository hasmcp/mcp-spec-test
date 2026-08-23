// The report as a single HTML file, for attaching to a ticket or publishing as a
// CI artifact.
//
// Self-contained by necessity: no stylesheet, script or font is fetched, because
// an artifact viewer is often offline or behind a strict CSP, and a report that
// renders differently depending on the network is not a record of anything. It
// also has to survive being printed, so the layout is one column and the colours
// have contrast rather than saturation.

import { bySection } from './report-model.mjs'

// Everything interpolated below is either ours or the target's. The target's
// strings — case reasons, server error messages, the URL — are attacker-shaped in
// the general case, so all of it goes through here.
function escape(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

const STYLE = `
  :root {
    color-scheme: light dark;
    --bg: #ffffff; --fg: #1a1a1a; --muted: #5c5c5c; --rule: #e2e2e2;
    --panel: #f7f7f7; --fail: #b3261e; --warn: #8a5a00; --pass: #1a6b34;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #16181c; --fg: #e8e8e8; --muted: #a0a4ab; --rule: #2c3038;
      --panel: #1d2026; --fail: #ff9c94; --warn: #f0c060; --pass: #7fd39b;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0 auto; padding: 2.5rem 1.25rem 4rem; max-width: 52rem;
    background: var(--bg); color: var(--fg);
    font: 16px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  h1 { font-size: 1.5rem; margin: 0 0 .25rem; letter-spacing: -0.01em; }
  h2 { font-size: 1.1rem; margin: 2.5rem 0 .25rem; }
  h3 { font-size: .95rem; margin: 1.5rem 0 .5rem; color: var(--muted); font-weight: 600; }
  .verdict { font-weight: 600; margin: 0 0 1.5rem; }
  .verdict.fail { color: var(--fail); }
  .verdict.warn { color: var(--warn); }
  .verdict.pass { color: var(--pass); }
  .verdict span { font-weight: 400; color: var(--fg); }
  .note { color: var(--muted); font-size: .9rem; margin: 0 0 1rem; }
  table { border-collapse: collapse; width: 100%; margin: 0 0 1rem; font-size: .9rem; }
  th, td { text-align: left; padding: .4rem .6rem; border-bottom: 1px solid var(--rule); }
  th { color: var(--muted); font-weight: 500; width: 12rem; }
  .tallies { display: flex; flex-wrap: wrap; gap: .5rem 1.5rem; margin: 0 0 1.5rem;
             padding: .75rem 1rem; background: var(--panel); border-radius: 6px; font-size: .9rem; }
  .tallies b { font-variant-numeric: tabular-nums; }
  ul { list-style: none; margin: 0; padding: 0; }
  li { padding: .5rem 0 .5rem 1.5rem; border-bottom: 1px solid var(--rule); position: relative; }
  li::before { position: absolute; left: 0; font-weight: 700; }
  li.fail::before { content: "\\2717"; color: var(--fail); }
  li.warn::before { content: "\\2013"; color: var(--warn); }
  li.pass::before { content: "\\2713"; color: var(--pass); }
  .reason { display: block; color: var(--muted); font-size: .875rem; margin-top: .15rem;
            font-family: ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap: anywhere; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap: anywhere; }
  footer { margin-top: 3rem; padding-top: 1rem; border-top: 1px solid var(--rule);
           color: var(--muted); font-size: .8rem; }
  @media print {
    body { max-width: none; padding: 0; }
    li { break-inside: avoid; }
  }
`

// Exhaustive over the verdict codes the model produces. Kept exhaustive by a
// test rather than by a fallback, so adding a code fails loudly instead of
// rendering a class nobody styled.
export const VERDICT_CLASS = {
  'not-conformant': 'fail',
  'nothing-verified': 'warn',
  'conformant-in-part': 'pass',
  'conformant-to-revision': 'pass',
  'fully-conformant': 'pass',
}

function caseSection(title, note, cases, kind, { reasons = true } = {}) {
  if (!cases.length) return ''
  let out = `<h2>${escape(title)} (${cases.length})</h2>\n<p class="note">${escape(note)}</p>\n`
  for (const [group, items] of bySection(cases)) {
    out += `<h3>${escape(group)}</h3>\n<ul>\n`
    for (const item of items) {
      out += `<li class="${kind}">${escape(item.name ?? item.label)}`
      const reason = item.reason ?? item.detail
      if (reasons && reason) out += `<span class="reason">${escape(reason)}</span>`
      out += '</li>\n'
    }
    out += '</ul>\n'
  }
  return out
}

export function renderHtml(model) {
  const { counts, cases } = model
  const title = `MCP ${model.specVersion} conformance report`

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<h1>${escape(title)}</h1>
<p class="verdict ${VERDICT_CLASS[model.verdict.code]}">Verdict: ${escape(model.verdict.label)} <span>— ${escape(model.verdict.detail)}</span></p>

<div class="tallies">
<span><b>${counts.passed}</b> passed</span>
<span><b>${counts.failed}</b> failed</span>
<span><b>${counts.notVerified}</b> not verified</span>
${counts.recommendedNotMet ? `<span><b>${counts.recommendedNotMet}</b> recommended not met</span>\n` : ''}<span><b>${counts.applied}</b> applied, in ${counts.applied ? model.durationMs : 0}ms</span>
</div>

<table>
<tr><th>Target</th><td><code>${escape(model.target)}</code></td></tr>
<tr><th>Transport</th><td>${escape(model.transport)}</td></tr>
<tr><th>Revision tested</th><td>${escape(model.specVersion)}</td></tr>
<tr><th>Revisions supported</th><td>${escape(model.supportedRevisions.join(', '))}</td></tr>
</table>

${caseSection('Failed', 'the server deviates from the spec here', cases.failed, 'fail')}${caseSection('Not verified', 'skipped; a skip is not a pass', cases.notVerified, 'warn')}${caseSection('Recommended, not met', 'the spec says SHOULD here, so this is not a conformance failure', cases.recommendedNotMet, 'warn')}${caseSection('Passed', 'checked and conformant', cases.passed, 'pass', { reasons: false })}
<footer>
Generated ${escape(model.generatedAt)} by ${escape(model.tool.name)} ${escape(model.tool.version)}.
</footer>
</body>
</html>
`
}
