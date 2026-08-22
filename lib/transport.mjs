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
  MIN_REQUEST_INTERVAL_MS,
  RETRY_BUDGET_MS,
  TRANSPORT,
  VERBOSE,
  authHeaders,
  extraHeaders,
  targetURL,
} from './env.mjs'

const EMPTY_HEADERS = new Headers()

// ---------------------------------------------------------------------------
// Pacing
//
// Every outgoing request passes through here, so a target that rate-limits can
// be tested without the run collapsing into 429s partway through. The gate is a
// promise chain rather than a token bucket: requests are spaced by a minimum
// interval, which is what a fixed per-minute allowance actually needs.
//
// This is per process, and node:test runs each test file in its own process, so
// the CLI also serialises the files when a limit is set. Without that, six
// concurrent files would each pace themselves and together exceed the limit six
// times over.

let gate = Promise.resolve()
let lastSentAt = 0

function pace() {
  if (!MIN_REQUEST_INTERVAL_MS && !breakerOpenUntil) return Promise.resolve()
  gate = gate.then(async () => {
    // Wait out an open breaker first: while the target is rate-limiting, nothing
    // should go out at all, or the queue keeps the limit tripped.
    let openFor = breakerOpenUntil - Date.now()
    while (openFor > 0) {
      await sleep(openFor)
      openFor = breakerOpenUntil - Date.now()
    }
    const wait = lastSentAt + MIN_REQUEST_INTERVAL_MS - Date.now()
    if (wait > 0) await sleep(wait)
    lastSentAt = Date.now()
  })
  return gate
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)))

// ---------------------------------------------------------------------------
// Rate-limit breaker
//
// A 429 says nothing about conformance, so failing the case is wrong and so is
// retrying immediately. Instead the breaker opens: every request waits, the one
// that tripped it is retried, and the run continues once the target lets it. If
// the budget runs out the 429 is returned and the case reports itself as
// unverified rather than failed, because that is what it is.
//
// The delay comes from Retry-After where the target sends one — it knows its own
// window better than any guess — and otherwise backs off from a second.

let breakerOpenUntil = 0

function isThrottledResponse(status, body) {
  if (status === 429) return true
  const err = body?.error
  if (!err) return false
  return err.code === 429 || /rate.?limit/i.test(String(err.message ?? ''))
}

// retryAfterMs reads the header the target sent, in either permitted form: a
// delay in seconds, or an HTTP date.
function retryAfterMs(headers) {
  const raw = headers?.get?.('retry-after')
  if (!raw) return null
  const seconds = Number(raw)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const at = Date.parse(raw)
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now())
}

function openBreaker(ms) {
  breakerOpenUntil = Math.max(breakerOpenUntil, Date.now() + ms)
}

// withBreaker runs one request, waiting out rate limits until the budget is
// spent. `attempt` must return { status, headers, body }.
async function withBreaker(attempt) {
  const deadline = Date.now() + RETRY_BUDGET_MS
  let backoff = 1000

  for (;;) {
    await pace()
    const res = await attempt()
    if (!isThrottledResponse(res.status, res.body)) return res
    if (RETRY_BUDGET_MS <= 0) return res

    const remaining = deadline - Date.now()
    if (remaining <= 0) return res

    const suggested = retryAfterMs(res.headers)
    const delay = Math.min(suggested ?? backoff, remaining)
    openBreaker(delay)
    if (VERBOSE) process.stderr.write(`rate-limited; waiting ${Math.round(delay)}ms\n`)
    await sleep(delay)
    backoff = Math.min(backoff * 2, 15000)
  }
}

// ---------------------------------------------------------------------------
// Streamable HTTP

function httpSend(body, opts = {}) {
  return withBreaker(() => httpSendOnce(body, opts))
}

async function httpSendOnce(body, { headers = {}, url } = {}) {
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
  await pace()
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
  await pace()
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
  await pace()
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
  await pace()
  try {
    stdioWrite(body)
    return { status: 200 }
  } catch (err) {
    return { status: 0, error: err.message }
  }
}

async function stdioListen(body, { budgetMs, stop, onFrame } = {}) {
  await pace()
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
