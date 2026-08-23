// Choosing a format, naming the file, and writing it in the right directory.
//
// The directory is the part worth testing: the test child runs with its cwd set
// to the package root, so a report resolved against the process would be written
// inside node_modules, where nobody would look for it.

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { EXTENSIONS, FORMAT_NAMES, filename, isFormat, resolveFormat, stamp } from '../../lib/formats.mjs'
import { emit } from '../../lib/output.mjs'
import { buildModel } from '../../lib/report-model.mjs'

const NOW = new Date('2026-08-23T07:15:03.123Z')

const model = buildModel({
  env: { MCP_URL: 'https://example.com/mcp' },
  now: NOW,
  passed: [{ name: 'p', file: 'tests/discover.test.mjs' }],
})

test('the four documented formats exist, and stdio is the default', () => {
  assert.deepEqual(FORMAT_NAMES, ['stdio', 'md', 'html', 'json'])
  assert.equal(EXTENSIONS.stdio, null)
  assert.equal(resolveFormat({}), 'stdio')
})

test('isFormat accepts only the four', () => {
  for (const name of FORMAT_NAMES) assert.ok(isFormat(name), name)
  for (const name of ['markdown', 'MD', 'yaml', 'txt', '', 'toString']) {
    assert.equal(isFormat(name), false, name)
  }
})

test('an unrecognised format falls back to stdio rather than writing nothing', () => {
  // The CLI rejects a bad --output before this point; if one ever gets through,
  // printing the report beats silently producing no output at all.
  assert.equal(resolveFormat({ MCP_OUTPUT: 'yaml' }), 'stdio')
  assert.equal(resolveFormat({ MCP_OUTPUT: '' }), 'stdio')
})

test('the filename stamp is YYMMDDHHMMSS in UTC', () => {
  assert.equal(stamp('2026-08-23T07:15:03.123Z'), '260823071503')
  assert.equal(stamp('2026-08-23T07:15:03.123Z').length, 12)
  assert.equal(stamp('2099-12-31T23:59:59.000Z'), '991231235959')
})

test('the filename comes from the report, so name and content cannot disagree', () => {
  assert.equal(filename(model.generatedAt, 'md'), 'mcpspectest-260823071503.md')
  assert.equal(filename(model.generatedAt, 'html'), 'mcpspectest-260823071503.html')
  assert.equal(filename(model.generatedAt, 'json'), 'mcpspectest-260823071503.json')
})

test('stdio returns the report and writes nothing', () => {
  let wrote = false
  const result = emit(model, { env: {}, write: () => { wrote = true } })

  assert.equal(result.format, 'stdio')
  assert.equal(result.path, null)
  assert.equal(wrote, false)
  assert.match(result.stdout, /conformance report/)
})

test('a file format writes the file and prints only where it went', () => {
  const seen = []
  const result = emit(model, {
    env: { MCP_OUTPUT: 'md', MCP_OUTPUT_DIR: '/somewhere' },
    write: (path, contents) => seen.push({ path, contents }),
  })

  assert.equal(result.format, 'md')
  assert.equal(result.path, '/somewhere/mcpspectest-260823071503.md')
  assert.equal(seen.length, 1)
  assert.equal(seen[0].path, result.path)
  assert.match(seen[0].contents, /^# MCP/)
  // The report itself must not also go to stdout, or --output md is just noise.
  assert.equal(result.stdout, `report written to ${result.path}\n`)
  assert.ok(!result.stdout.includes('# MCP'))
})

test('the report goes where the shell was, not where the process is', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mcp-spec-test-'))

  const result = emit(model, { env: { MCP_OUTPUT: 'json', MCP_OUTPUT_DIR: directory } })

  assert.deepEqual(readdirSync(directory), ['mcpspectest-260823071503.json'])
  assert.equal(JSON.parse(readFileSync(result.path, 'utf8')).specVersion, model.specVersion)
})

test('each format writes its own extension', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mcp-spec-test-'))
  for (const format of ['md', 'html', 'json']) {
    emit(model, { env: { MCP_OUTPUT: format, MCP_OUTPUT_DIR: directory } })
  }

  assert.deepEqual(readdirSync(directory).sort(), [
    'mcpspectest-260823071503.html',
    'mcpspectest-260823071503.json',
    'mcpspectest-260823071503.md',
  ])
})

test('two runs do not overwrite each other', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mcp-spec-test-'))
  const later = buildModel({ env: {}, now: new Date('2026-08-23T07:16:04.000Z') })

  emit(model, { env: { MCP_OUTPUT: 'md', MCP_OUTPUT_DIR: directory } })
  emit(later, { env: { MCP_OUTPUT: 'md', MCP_OUTPUT_DIR: directory } })

  assert.equal(readdirSync(directory).length, 2)
})

test('with no directory given it falls back to the process, rather than throwing', () => {
  let path = null
  emit(model, { env: { MCP_OUTPUT: 'md' }, write: (p) => { path = p } })
  assert.equal(path, join(process.cwd(), 'mcpspectest-260823071503.md'))
})
