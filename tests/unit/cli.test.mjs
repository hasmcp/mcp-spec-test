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
