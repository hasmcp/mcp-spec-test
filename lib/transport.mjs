// Transport abstraction.
//
// The suite's assertions are about the protocol, not about how bytes reach the
// server, so every test speaks to this module rather than to fetch() or a child
// process. Two implementations cover the transports the spec defines:
//
//   http  — Streamable HTTP. Reports real status codes and response headers,
//           and reads SSE frames for the streaming cases.
//   stdio — newline-delimited JSON-RPC over a spawned child's stdin/stdout.
//           There is no status code or header layer, so `status` is synthesised
//           as 200 and `headers` is empty; tests that assert HTTP-specific
//           requirements guard with requireHttp() instead of reading fiction.

import { spawn } from 'node:child_process'

import {
  MCP_COMMAND,
  TRANSPORT,
  VERBOSE,
  authHeaders,
  extraHeaders,
  targetURL,
} from './env.mjs'

const EMPTY_HEADERS = new Headers()

// ---------------------------------------------------------------------------
// Streamable HTTP

async function httpSend(body, { headers = {}, url } = {}) {
  const res = await fetch(url ?? targetURL(), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...authHeaders(),
      ...extraHeaders(),
      ...headers,
    },
    body: JSON.stringify(body),
  })

  const text = await res.text()
  let parsed
  try {
    parsed = text ? JSON.parse(text) : undefined
  } catch {
    // An SSE-framed single response is still a valid answer to a POST; unwrap
    // the first data: line so a streaming server is not reported as garbage.
    parsed = parseFirstSseData(text) ?? { _raw: text }
  }
  return { status: res.status, headers: res.headers, body: parsed }
}

function parseFirstSseData(text) {
  for (const line of String(text).split('\n')) {
    if (!line.startsWith('data:')) continue
    try {
      return JSON.parse(line.slice(5).trim())
    } catch {
      return undefined
    }
  }
  return undefined
}

// httpNotify sends a notification: no id, so there is nothing to correlate and
// nothing to wait for beyond the server accepting it. A 202 is the conformant
// answer; the status is returned for callers that care, and ignored by those
// that do not.
async function httpNotify(body, { headers = {} } = {}) {
  try {
    const res = await fetch(targetURL(), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...authHeaders(),
        ...extraHeaders(),
        ...headers,
      },
      body: JSON.stringify(body),
    })
    // Drain so the socket is released rather than left half-read.
    await res.text()
    return { status: res.status }
  } catch (err) {
    return { status: 0, error: err?.message || String(err) }
  }
}

// httpListen POSTs a request that is expected to answer with a stream, and
// yields decoded JSON frames until `stop` is satisfied or the budget expires.
async function httpListen(body, { headers = {}, budgetMs, stop, onFrame } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), budgetMs)

  let res
  try {
    res = await fetch(targetURL(), {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        ...authHeaders(),
        ...extraHeaders(),
        ...headers,
      },
      body: JSON.stringify(body),
    })
  } catch (err) {
    clearTimeout(timer)
    return { streaming: false, reason: err?.message || String(err), frames: [] }
  }

  const contentType = res.headers.get('content-type') || ''
  if (!res.ok || !contentType.includes('text/event-stream')) {
    clearTimeout(timer)
    return { streaming: false, reason: `status=${res.status} content-type=${contentType}`, frames: [] }
  }

  const frames = []
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true })
      let idx
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 2)
        for (const line of block.split('\n')) {
          if (!line.startsWith('data:')) continue
          try {
            const frame = JSON.parse(line.slice(5).trim())
            frames.push(frame)
            onFrame?.(frame, frames)
          } catch {
            // heartbeat comments and non-JSON keepalives are not frames
          }
        }
      }
      if (stop && stop(frames)) break
    }
  } catch {
    // aborted by the budget; whatever arrived is what the test asserts on
  }
  clearTimeout(timer)
  controller.abort()
  return { streaming: true, frames }
}

// ---------------------------------------------------------------------------
// stdio

// tokenize splits a command line on whitespace, honouring single and double
// quotes so a server command with a quoted path or JSON argument survives.
export function tokenize(line) {
  const out = []
  let cur = ''
  let quote = null
  let started = false
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = null
      else cur += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      started = true
      continue
    }
    if (/\s/.test(ch)) {
      if (started || cur) out.push(cur)
      cur = ''
      started = false
      continue
    }
    cur += ch
  }
  if (started || cur) out.push(cur)
  return out
}

let child = null
const waiters = new Map() // id -> resolve
const listeners = new Set() // fn(frame)

function stdioChild() {
  if (child && child.exitCode === null && !child.killed) return child

  const argv = tokenize(MCP_COMMAND)
  if (argv.length === 0) throw new Error('MCP_COMMAND is empty')

  // The server's own logging is not part of the report. Servers commonly greet
  // on stderr ("Starting STDIO server..."), and inheriting that prints banners
  // above the conformance output for every test file. It is kept and surfaced
  // only when asked for, since it is exactly what someone debugging a failure
  // wants to see.
  child = spawn(argv[0], argv.slice(1), {
    stdio: ['pipe', 'pipe', VERBOSE ? 'inherit' : 'pipe'],
    env: process.env,
  })
  // Drained, not just piped: an unread stderr pipe fills and blocks the server.
  // It is also unreferenced with the rest, or the handle alone keeps the runner
  // alive after the last assertion.
  if (!VERBOSE) child.stderr?.resume()
  child.on('error', (err) => {
    for (const resolve of waiters.values()) resolve({ transportError: err.message })
    waiters.clear()
  })
  child.on('exit', () => {
    for (const resolve of waiters.values()) resolve({ transportError: 'server exited' })
    waiters.clear()
  })

  let buffer = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    let idx
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx).trim()
      buffer = buffer.slice(idx + 1)
      if (!line) continue
      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        continue // a server logging to stdout is not a protocol frame
      }
      for (const fn of listeners) fn(msg)
      if (msg.id !== undefined && waiters.has(msg.id)) {
        const resolve = waiters.get(msg.id)
        waiters.delete(msg.id)
        resolve({ message: msg })
      }
    }
  })

  release()
  return child
}

// The child's stdin/stdout are live handles, so leaving them referenced keeps the
// event loop alive and the test runner never exits — while unreferencing them
// unconditionally would let the process exit before a reply arrives. So they are
// referenced exactly while something is waiting on them, and released the moment
// nothing is.
function retain() {
  if (!child) return
  child.ref?.()
  child.stdin?.ref?.()
  child.stdout?.ref?.()
  child.stderr?.ref?.()
}

function release() {
  if (!child) return
  if (waiters.size > 0 || listeners.size > 0) return
  child.unref?.()
  child.stdin?.unref?.()
  child.stdout?.unref?.()
  child.stderr?.unref?.()
}

function stdioWrite(body) {
  stdioChild().stdin.write(`${JSON.stringify(body)}\n`)
}

async function stdioSend(body, { budgetMs = 10000 } = {}) {
  let settle
  const answered = new Promise((resolve) => {
    settle = resolve
  })
  waiters.set(body.id, settle)
  try {
    stdioWrite(body)
    retain()
  } catch (err) {
    waiters.delete(body.id)
    release()
    return { status: 0, headers: EMPTY_HEADERS, body: { _raw: `spawn failed: ${err.message}` } }
  }

  const timer = setTimeout(() => {
    if (waiters.delete(body.id)) settle({ transportError: `no response within ${budgetMs}ms` })
  }, budgetMs)
  timer.unref?.()
  const outcome = await answered
  clearTimeout(timer)
  release()

  if (outcome.transportError) {
    return { status: 0, headers: EMPTY_HEADERS, body: { _raw: outcome.transportError } }
  }
  // stdio has no status layer: a JSON-RPC error is still a delivered message,
  // and 200 is the closest honest description of "the server answered".
  return { status: 200, headers: EMPTY_HEADERS, body: outcome.message }
}

async function stdioNotify(body) {
  try {
    stdioWrite(body)
    return { status: 200 }
  } catch (err) {
    return { status: 0, error: err.message }
  }
}

async function stdioListen(body, { budgetMs, stop, onFrame } = {}) {
  const frames = []
  let done
  const finished = new Promise((resolve) => {
    done = resolve
  })
  const collect = (msg) => {
    frames.push(msg)
    onFrame?.(msg, frames)
    if (stop && stop(frames)) done()
  }
  listeners.add(collect)
  const timer = setTimeout(done, budgetMs)
  try {
    stdioWrite(body)
    retain()
  } catch (err) {
    listeners.delete(collect)
    clearTimeout(timer)
    release()
    return { streaming: false, reason: `spawn failed: ${err.message}`, frames: [] }
  }
  await finished
  clearTimeout(timer)
  listeners.delete(collect)
  release()
  // stdio is always a stream; an empty result means the server sent nothing,
  // which is a conformance answer rather than an unsupported transport.
  return { streaming: true, frames }
}

export function shutdown() {
  if (child && child.exitCode === null) child.kill()
  child = null
}

process.on('exit', shutdown)

// ---------------------------------------------------------------------------

export const transport = {
  get kind() {
    return TRANSPORT
  },
  send(body, opts) {
    return TRANSPORT === 'stdio' ? stdioSend(body, opts) : httpSend(body, opts)
  },
  notify(body, opts) {
    return TRANSPORT === 'stdio' ? stdioNotify(body, opts) : httpNotify(body, opts)
  },
  listen(body, opts) {
    return TRANSPORT === 'stdio' ? stdioListen(body, opts) : httpListen(body, opts)
  },
}
