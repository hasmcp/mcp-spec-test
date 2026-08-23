// The three file formats.
//
// Every string in a report except our own labels comes from the target: case
// reasons are the server's error messages, and the target itself is a URL someone
// typed. A report is then committed, attached to a ticket, or opened in a browser.
// So the tests that matter most here are the ones that feed hostile strings in and
// check they come out inert.

import test from 'node:test'
import assert from 'node:assert/strict'

import { colourEnabled, palette } from '../../lib/colour.mjs'
import { buildModel } from '../../lib/report-model.mjs'
import { renderHtml, VERDICT_CLASS } from '../../lib/render-html.mjs'
import { renderJson, SCHEMA } from '../../lib/render-json.mjs'
import { renderMarkdown } from '../../lib/render-markdown.mjs'
import { renderText } from '../../lib/render-text.mjs'

const NOW = new Date('2026-08-23T07:15:03.123Z')

function model(parts = {}) {
  return buildModel({
    env: { MCP_URL: 'https://example.com/mcp', MCP_SPEC_VERSION: '2026-07-28' },
    now: NOW,
    summary: { duration_ms: 1234 },
    failed: [{
      name: 'resultType is required',
      file: 'tests/result-envelope.test.mjs',
      details: { error: { cause: { message: 'got {"a":1}' } } },
    }],
    passed: [{ name: 'tools/list is conformant', file: 'tests/capabilities.test.mjs' }],
    skipped: [{ name: 'subscriptions are checked', file: 'tests/subscriptions.test.mjs', reason: 'not advertised' }],
    recommended: [{ label: 'invalid cursor rejected', detail: 'got a result', file: 'tests/capabilities.test.mjs' }],
    inapplicable: [{ name: 'older revision only', file: 'tests/discover.test.mjs', reason: 'not in this revision' }],
    ...parts,
  })
}

const HOSTILE = '<script>alert(1)</script> `code` **bold** | pipe | [link](x) _under_'

function hostileModel() {
  return buildModel({
    env: { MCP_URL: `https://example.com/mcp?q=${encodeURIComponent(HOSTILE)}` },
    now: NOW,
    failed: [{
      name: HOSTILE,
      file: 'tests/discover.test.mjs',
      details: { error: { cause: { message: HOSTILE } } },
    }],
  })
}

test('json is parseable and carries the whole model', () => {
  const parsed = JSON.parse(renderJson(model()))

  assert.equal(parsed.schema, SCHEMA)
  assert.equal(parsed.specVersion, '2026-07-28')
  assert.equal(parsed.transport, 'streamable-http')
  assert.equal(parsed.durationMs, 1234)
  assert.equal(parsed.verdict.code, 'not-conformant')
  assert.equal(parsed.counts.applied, 3)
  assert.equal(parsed.cases.failed[0].reason, 'got {"a":1}')
})

test('json is the only format that keeps the inapplicable cases', () => {
  // A machine reading history wants them; a person reading a verdict does not,
  // which is why the three human formats leave them out.
  const parsed = JSON.parse(renderJson(model()))
  assert.equal(parsed.cases.notApplicable.length, 1)

  for (const render of [renderText, renderMarkdown, renderHtml]) {
    assert.ok(!render(model()).includes('older revision only'), render.name)
  }
})

test('json ends with a newline, so it appends and diffs cleanly', () => {
  assert.match(renderJson(model()), /\n$/)
})

test('json needs no escaping rules of its own', () => {
  const parsed = JSON.parse(renderJson(hostileModel()))
  assert.equal(parsed.cases.failed[0].name, HOSTILE)
})

test('markdown states the verdict where a reader lands first', () => {
  const md = renderMarkdown(model())
  assert.match(md, /^# MCP 2026-07-28 conformance report/)
  assert.match(md.split('\n').slice(0, 4).join('\n'), /\*\*Verdict: not conformant\*\*/)
})

test('markdown includes every populated section and skips empty ones', () => {
  const md = renderMarkdown(model())
  for (const heading of ['## Failed (1)', '## Not verified (1)', '## Recommended, not met (1)', '## Passed (1)']) {
    assert.ok(md.includes(heading), `missing ${heading}`)
  }
  assert.ok(!renderMarkdown(model({ failed: [], skipped: [], recommended: [] })).includes('## Failed'))
})

test('markdown neutralises formatting characters from the target', () => {
  const md = renderMarkdown(hostileModel())
  // The text must survive, but not as markup: no bare ** or [ ] that would
  // render, and no raw < that a markdown-to-html step would pass through.
  assert.ok(md.includes('\\*\\*bold\\*\\*'), md.slice(0, 400))
  assert.ok(md.includes('\\[link\\]'))
  assert.ok(md.includes('\\<script\\>'))
  assert.ok(!/[^\\]\|/.test(md.split('## Failed')[1] ?? ''), 'an unescaped pipe would break the table')
})

test('markdown collapses runs of blank lines', () => {
  assert.ok(!renderMarkdown(model()).includes('\n\n\n'))
})

test('html is a self-contained document with nothing to fetch', () => {
  const html = renderHtml(model())
  assert.match(html, /^<!doctype html>/)
  assert.ok(html.includes('<style>'))
  // A report that renders differently offline is not a record of anything.
  assert.ok(!/<(script|link|img)\b/i.test(html), 'html pulls in an external resource')
  assert.ok(!/https?:\/\/(?!example\.com)/.test(html.replace(/<a [^>]*>/g, '')), 'html references a remote host')
})

test('html escapes everything the target controls', () => {
  const html = renderHtml(hostileModel())
  assert.ok(!html.includes('<script>alert(1)</script>'), 'script tag survived into the document')
  assert.ok(html.includes('&lt;script&gt;'), 'the text itself was lost instead of escaped')
})

test('html escapes quotes, so an attribute cannot be broken out of', () => {
  const html = renderHtml(buildModel({
    env: { MCP_URL: 'https://example.com/mcp?x="onload="alert(1)' },
    now: NOW,
    passed: [{ name: 'p', file: 'tests/discover.test.mjs' }],
  }))
  assert.ok(!html.includes('"onload='), html.match(/.{0,80}onload.{0,40}/)?.[0])
})

test('html marks each case with its outcome', () => {
  const html = renderHtml(model())
  assert.ok(html.includes('class="fail"'))
  assert.ok(html.includes('class="warn"'))
  assert.ok(html.includes('class="pass"'))
  assert.ok(html.includes('class="verdict fail"'))
})

test('html omits sections with nothing in them', () => {
  const html = renderHtml(model({ failed: [], skipped: [], recommended: [] }))
  assert.ok(!html.includes('>Failed ('))
  assert.ok(html.includes('>Passed ('))
})

test('every format agrees on the verdict', () => {
  const m = model()
  assert.ok(renderText(m).includes('not conformant'))
  assert.ok(renderMarkdown(m).includes('not conformant'))
  assert.ok(renderHtml(m).includes('not conformant'))
  assert.equal(JSON.parse(renderJson(m)).verdict.label, 'not conformant')
})

test('every format redacts a token in the target', () => {
  const m = buildModel({
    env: { MCP_URL: 'https://example.com/mcp?token=s3cret' },
    now: NOW,
    passed: [{ name: 'p', file: 'tests/discover.test.mjs' }],
  })
  for (const render of [renderText, renderMarkdown, renderHtml, renderJson]) {
    assert.ok(!render(m).includes('s3cret'), `${render.name} leaked the token`)
  }
})

test('text output survives a run with no cases at all', () => {
  // The reporter builds a model even when the suite could not start.
  const empty = buildModel({ env: {}, now: NOW })
  assert.match(renderText(empty), /Verdict: nothing verified/)
  assert.match(renderMarkdown(empty), /nothing verified/)
  assert.match(renderHtml(empty), /nothing verified/)
  assert.equal(JSON.parse(renderJson(empty)).counts.applied, 0)
})

test('text pluralises the applied-case count', () => {
  const m = (n) => buildModel({
    env: {}, now: NOW,
    passed: Array.from({ length: n }, (_, i) => ({ name: `p${i}`, file: 'tests/discover.test.mjs' })),
  })
  assert.match(renderText(m(1)), /1 case applied/)
  assert.match(renderText(m(2)), /2 cases applied/)
})

test('every verdict the model can produce has an html class', () => {
  // The renderer has no fallback, on purpose: a new verdict code should fail here
  // rather than render a class nobody styled.
  const codes = [
    'not-conformant', 'nothing-verified', 'conformant-in-part',
    'conformant-to-revision', 'fully-conformant',
  ]
  for (const code of codes) assert.ok(VERDICT_CLASS[code], `no class for ${code}`)
  assert.deepEqual(Object.keys(VERDICT_CLASS).sort(), [...codes].sort())
})

test('a recommendation with no detail renders as just the label', () => {
  const m = buildModel({
    env: {},
    now: NOW,
    passed: [{ name: 'p', file: 'tests/discover.test.mjs' }],
    recommended: [{ label: 'no detail given', file: 'tests/capabilities.test.mjs' }],
  })

  assert.match(renderMarkdown(m), /- \*\*no detail given\*\*/)
  assert.match(renderHtml(m), /no detail given/)
  // Nothing empty should be emitted where the detail would have gone.
  assert.ok(!renderHtml(m).includes('<span class="reason"></span>'))
})

test('text wraps a long reason instead of printing one endless line', () => {
  const reason = 'the server returned a body that does not match the schema '.repeat(8)
  const m = buildModel({
    env: {},
    now: NOW,
    failed: [{
      name: 'long reason',
      file: 'tests/discover.test.mjs',
      details: { error: { cause: { message: reason } } },
    }],
  })

  const lines = renderText(m).split('\n').filter((line) => line.startsWith('        '))
  assert.ok(lines.length > 1, 'the reason was not wrapped')
  for (const line of lines) assert.ok(line.length <= 120, `line too long: ${line.length}`)
})

test('colour is on for a terminal and off everywhere else', () => {
  assert.equal(colourEnabled({}, { isTTY: true }), true)
  assert.equal(colourEnabled({}, { isTTY: false }), false)
  assert.equal(colourEnabled({}, {}), false)
  // NO_COLOR is honoured even on a terminal.
  assert.equal(colourEnabled({ NO_COLOR: '1' }, { isTTY: true }), false)
})

test('the palette emits escape codes only when enabled', () => {
  assert.equal(palette(true).red('x'), '\u001b[31mx\u001b[0m')
  assert.equal(palette(false).red('x'), 'x')
  assert.equal(palette(false).bold(42), '42')
})
