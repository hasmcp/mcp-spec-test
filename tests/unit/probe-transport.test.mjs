// probe() must send a genuinely modern discover request on Streamable HTTP,
// not a version-less one — and must not silently downgrade to a legacy
// handshake result when the revision under test has no handshake to fall
// back to.
//
// Two bugs pinned here, both found verifying the fixes above against a real
// HTTP server.
//
// docs/specification/2026-07-28/basic/versioning.mdx, "Backward Compatibility
// with Initialization-Based Versions":
//
//   - stdio: probe with server/discover and fall back on any error that is
//     not a recognized modern error.
//   - Streamable HTTP: attempt a modern request and inspect the body of a
//     400 Bad Request before falling back.
//
// A server is entitled, per transports/streamable-http.mdx's own backward-
// compatibility clause, to treat an under-declared request (no
// MCP-Protocol-Version header, no _meta) as an old, pre-2025-06-18 client —
// which is exactly what the suite's previous version-less probe looked like
// on HTTP. Sent as a genuine 2026-07-28 request instead (real _meta, real
// headers), the same server answers correctly.
//
// The second bug: "fall back" in that guidance is written for a
// general-purpose client willing to keep talking under whatever era the
// server turns out to speak. This suite is not that client — it tests one
// specific revision per run. `probeByHandshake()` only means anything for a
// revision that actually has a handshake (`FEATURES.handshake`), and the
// revision that reaches this fallback — by construction, since
// `FEATURES.discover` is what got it here — never does. Calling it anyway
// hit `session.needed() === false` and returned a no-op "success", which
// then reported a target that had answered nothing at all as fully
// conformant to the newest revision. Every downstream case that trusted that
// answer went on to make real requests it should have skipped, which is
// also why the bug did not fail loudly: against a dead stdio target a real
// run went from ~0.2s to ~16s, because nothing was skipped any more.
//
// Each case here spawns a fresh subprocess that does nothing but call
// probe() and print its answer as JSON — lib/env.mjs reads MCP_URL once, at
// import time, so a single process cannot safely probe two different targets
// in succession, and this also keeps each case decoupled from every other
// test file's own fixture requirements.

import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const probeModuleURL = `file://${join(root, 'lib', 'probe.mjs')}`

// runProbe spawns node with MCP_URL/MCP_SPEC_VERSION set, imports probe.mjs
// fresh, and returns its answer plus how long the whole process took.
function runProbe(url) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now()
    execFile(
      process.execPath,
      ['--input-type=module', '-e', `import('${probeModuleURL}').then(async (m) => { console.log(JSON.stringify(await m.probe())) })`],
      { env: { ...process.env, MCP_URL: url, MCP_SPEC_VERSION: '2026-07-28' } },
      (error, stdout, stderr) => {
        if (error) return reject(new Error(`probe subprocess failed: ${error.message}\n${stderr}`))
        try {
          resolve({ result: JSON.parse(stdout.trim()), ms: Date.now() - startedAt })
        } catch (err) {
          reject(new Error(`probe subprocess did not print JSON: ${stdout}\n${stderr}`))
        }
      },
    )
  })
}

// dualEraLegacyDefaultServer models a server that implements 2026-07-28
// (server/discover answers when addressed as a modern client) but, per the
// spec's own backward-compatibility allowance, treats a request lacking the
// MCP-Protocol-Version header as an old client and answers with a legacy-era
// "method not found" instead of the modern DiscoverResult.
async function dualEraLegacyDefaultServer() {
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    const msg = body ? JSON.parse(body) : {}

    const send = (payload) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id ?? null, ...payload }))
    }

    if (msg.method !== 'server/discover' || !req.headers['mcp-protocol-version']) {
      // Either a method this server has never heard of, or discover asked
      // for without declaring a version: both get the legacy-era answer.
      return send({ error: { code: -32601, message: `Method not found: ${msg.method}` } })
    }

    return send({
      result: {
        resultType: 'DiscoverResult',
        supportedVersions: ['2026-07-28'],
        ttlMs: 60000,
        cacheScope: 'public',
        capabilities: { tools: {} },
        serverInfo: { name: 'dual-era-fixture', version: '1.0.0' },
      },
    })
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${server.address().port}/mcp`,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

// unsupportedVersionServer models a genuinely modern server that just does
// not support the exact version this run asked for, and says so with the
// schema-required error rather than silently negotiating one.
async function unsupportedVersionServer(supported) {
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    const msg = body ? JSON.parse(body) : {}
    res.writeHead(400, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      jsonrpc: '2.0',
      id: msg.id ?? null,
      error: { code: -32022, message: 'Unsupported protocol version', data: { requested: '2026-07-28', supported } },
    }))
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${server.address().port}/mcp`,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

// deadServer answers nothing modern or legacy-recognizable at all — the
// closest thing to the bug's own reproduction, a target that never responds
// usefully to anything.
async function deadServer() {
  const server = createServer((req, res) => {
    res.writeHead(500)
    res.end('nope')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${server.address().port}/mcp`,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

test('probe() sends a modern discover request on HTTP, so a dual-era server answers instead of defaulting to legacy', async () => {
  const server = await dualEraLegacyDefaultServer()
  try {
    const { result } = await runProbe(server.url)
    assert.equal(result.ok, true, `expected the dual-era server to be detected as modern, got: ${result.reason}`)
    assert.deepEqual(result.supportedVersions, ['2026-07-28'])
    assert.equal(result.viaHandshake, false)
    assert.equal(result.discover?.serverInfo?.name, 'dual-era-fixture')
  } finally {
    await server.close()
  }
})

test('probe() reads supportedVersions from an UnsupportedProtocolVersionError rather than giving up', async () => {
  const server = await unsupportedVersionServer(['2025-11-25', '2025-06-18'])
  try {
    const { result } = await runProbe(server.url)
    assert.equal(result.ok, true, `a recognized modern error should not be reported unreachable, got: ${result.reason}`)
    assert.deepEqual(result.supportedVersions, ['2025-11-25', '2025-06-18'])
    assert.equal(result.servesLatest, false)
  } finally {
    await server.close()
  }
})

test('probe() reports unreachable rather than a false handshake success when nothing answers', async () => {
  const server = await deadServer()
  try {
    const { result, ms } = await runProbe(server.url)
    // The bug: this used to fall back to probeByHandshake(), a no-op for the
    // very revision that reaches this branch (it has no handshake), and
    // returned {ok: true, servesLatest: true, viaHandshake: true} for a
    // target that had answered nothing at all.
    assert.equal(result.ok, false, 'a target that answers nothing modern or legacy must not be reported conformant')
    assert.equal(result.viaHandshake, false)
    assert.equal(result.servesLatest, false)
    assert.ok(ms < 5000, `expected an unreachable target to be reported quickly, took ${ms}ms`)
  } finally {
    await server.close()
  }
})
