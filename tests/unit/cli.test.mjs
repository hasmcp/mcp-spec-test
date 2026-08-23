// Argument handling, driven through the real binary.
//
// These are the paths a user hits before anything else works: asking for help,
// asking for the version, mistyping a flag, and forgetting a target. Each has an
// exit code somebody's shell script depends on, and none of them were covered.

import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const bin = join(root, 'bin', 'mcp-spec-test.mjs')
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

// Resolves rather than rejects on a non-zero exit: the exit code is the thing
// under test.
function run(args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [bin, ...args], (error, stdout, stderr) => {
      resolve({ code: error?.code ?? 0, stdout, stderr })
    })
  })
}

test('help is available as a command and as a flag', async () => {
  for (const args of [['help'], ['--help'], ['-h']]) {
    const { code, stdout } = await run(args)
    assert.equal(code, 0, `${args[0]} exited ${code}`)
    assert.match(stdout, /conformance test any MCP server/, `${args[0]} printed no usage`)
    // The two ways in should describe the same tool.
    assert.match(stdout, /-u, --url/)
  }
})

test('the version is available as a command and as a flag', async () => {
  for (const args of [['version'], ['--version'], ['-v']]) {
    const { code, stdout } = await run(args)
    assert.equal(code, 0, `${args[0]} exited ${code}`)
    assert.equal(stdout.trim(), version)
  }
})

test('help documents the telemetry opt-out', async () => {
  // An opt-out nobody can find is not an opt-out.
  const { stdout } = await run(['help'])
  assert.match(stdout, /--disable-telemetry/)
})

test('a mistyped flag is an error, not a silent no-op', async () => {
  const { code, stderr } = await run(['helpp'])
  assert.equal(code, 2)
  assert.match(stderr, /unknown option: helpp/)
})

test('a mistyped flag that merely resembles a real one is still rejected', async () => {
  const { code, stderr } = await run(['-c', 'true', '--disable-telemetryy'])
  assert.equal(code, 2)
  assert.match(stderr, /unknown option/)
})

test('no target is an error that says what to pass', async () => {
  const { code, stderr } = await run([])
  assert.equal(code, 2)
  assert.match(stderr, /no target/)
})

test('a url and a command together is refused, since they select different transports', async () => {
  const { code, stderr } = await run(['-u', 'https://example.com/mcp', '-c', 'true'])
  assert.equal(code, 2)
  assert.match(stderr, /either a url or a command/)
})

test('a flag given no value is refused rather than swallowing the next flag', async () => {
  const { code, stderr } = await run(['-u'])
  assert.equal(code, 2)
  assert.match(stderr, /needs a value/)
})

test('help lists the output formats', async () => {
  const { stdout } = await run(['help'])
  assert.match(stdout, /--output <format>/)
  for (const format of ['md', 'html', 'json']) assert.ok(stdout.includes(format), format)
})

test('an unknown output format is refused, and says what the choices are', async () => {
  const { code, stderr } = await run(['-c', 'true', '--output', 'yaml'])
  assert.equal(code, 2)
  assert.match(stderr, /--output yaml is not a format: choose stdio, md, html, json/)
})

test('every documented format is accepted', async () => {
  // Only argument validation is under test here: an unreachable target makes the
  // run itself fail, but it must not fail at the flag.
  for (const format of ['stdio', 'md', 'html', 'json']) {
    const { stderr } = await run(['-c', 'true', '--output', format])
    assert.ok(!stderr.includes('is not a format'), `${format} was rejected`)
  }
})

test('--output takes both spellings', async () => {
  for (const args of [['--output', 'yaml'], ['--output=yaml']]) {
    const { code, stderr } = await run(['-c', 'true', ...args])
    assert.equal(code, 2, args.join(' '))
    assert.match(stderr, /is not a format/)
  }
})

test('--tap and --output together is refused rather than quietly ignored', async () => {
  // --tap replaces the reporter, so --output could not be honoured; writing no
  // file and explaining nothing is the outcome worth preventing.
  const { code, stderr } = await run(['-c', 'true', '--tap', '--output', 'md'])
  assert.equal(code, 2)
  assert.match(stderr, /--tap and --output cannot be combined/)
})

test('--tap with an explicit stdio is allowed, since nothing is being asked for', async () => {
  const { stderr } = await run(['-c', 'true', '--tap', '--output', 'stdio'])
  assert.ok(!stderr.includes('cannot be combined'))
})
