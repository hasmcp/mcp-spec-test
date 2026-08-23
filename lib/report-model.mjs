// The report as data, before anything decides how it should look.
//
// The terminal report used to be built in one pass — collect an event, print a
// line — which is why there was no way to emit the same run as Markdown or JSON.
// This module is that pass split in half: what the run found, with no opinion
// about formatting. Every renderer takes one of these.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { SUPPORTED_REVISIONS } from './env.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

const SECTIONS = {
  'discover.test.mjs': 'server/discover',
  'negotiation.test.mjs': 'Version negotiation',
  'result-envelope.test.mjs': 'Result envelope',
  'capabilities.test.mjs': 'Capability methods',
  'subscriptions.test.mjs': 'subscriptions/listen',
  'sdk-compat.test.mjs': 'Official SDK interop',
}

export function section(file) {
  const base = String(file || '').split('/').pop()
  return SECTIONS[base] || base || 'other'
}

// failureReason digs the human sentence out of node:test's nested error. The
// assertion message is what the suite deliberately wrote to explain the
// deviation, so it is what a reader needs — not the ERR_TEST_FAILURE wrapper.
export function failureReason(data) {
  const err = data?.details?.error
  const cause = err?.cause
  if (cause && typeof cause === 'object') {
    if (cause.message) return String(cause.message)
    if (cause.code === 'ERR_ASSERTION') {
      return `expected ${JSON.stringify(cause.expected)}, got ${JSON.stringify(cause.actual)}`
    }
  }
  if (typeof cause === 'string') return cause
  return err?.message || 'failed without a reason'
}

// Query parameters that carry a credential often enough to be worth assuming
// they do. Matched loosely, since the spelling varies by server.
const SECRETISH = /(token|key|secret|password|passwd|pwd|auth|credential|session|sig|signature)/i

/**
 * Strip credentials out of the target before it is written down.
 *
 * The tool supports a token in the URL, so the target can carry one. On a
 * terminal that is the user's own screen; in a file it is a CI artifact, a commit,
 * or an emailed HTML report. So the value is removed rather than the name — the
 * name is worth seeing, since knowing a token was in the URL explains a lot.
 *
 * A command target is left alone. It is an arbitrary string and a secret inside
 * it could look like anything, so pattern-matching would give false confidence
 * rather than safety; the README says so instead.
 */
export function redactTarget(target) {
  if (typeof target !== 'string' || !/^https?:\/\//i.test(target)) return target

  let url
  try {
    url = new URL(target)
  } catch {
    return target
  }

  // user:password@host — the password is a credential and the username often is.
  if (url.password) url.password = 'REDACTED'
  if (url.username) url.username = 'REDACTED'

  for (const name of [...url.searchParams.keys()]) {
    if (SECRETISH.test(name)) url.searchParams.set(name, 'REDACTED')
  }
  return url.toString()
}

// The verdict in three parts: a code a machine can switch on, the label a reader
// sees, and the sentence after it. All three come from here so no two formats can
// disagree about whether a run was conformant.
function verdictFor({ failed, passed, notVerified, notApplicable }, specVersion) {
  if (failed) {
    return {
      code: 'not-conformant',
      label: 'not conformant',
      detail: `${failed} requirement${failed === 1 ? '' : 's'} violated.`,
    }
  }
  if (passed === 0) {
    return {
      code: 'nothing-verified',
      label: 'nothing verified',
      detail: 'every case skipped. Check the target and credentials above.',
    }
  }
  if (notVerified) {
    return {
      code: 'conformant-in-part',
      label: 'conformant on what could be checked',
      detail: `${notVerified} case${notVerified === 1 ? '' : 's'} could not be verified; `
        + 'read the reasons before claiming full conformance.',
    }
  }
  if (notApplicable) {
    // Nothing failed and nothing was left unverified: every requirement this
    // target actually has was checked. Naming the revision is what makes the
    // claim precise without listing what the revision does not define.
    return {
      code: 'conformant-to-revision',
      label: `conformant to ${specVersion}`,
      detail: 'every requirement that applies to this revision and transport was checked and passed.',
    }
  }
  return {
    code: 'fully-conformant',
    label: 'fully conformant',
    detail: 'every case in the suite was checked and passed.',
  }
}

/** Build the model every renderer reads. `env` and `now` are injectable for tests. */
export function buildModel({
  failed = [],
  passed = [],
  skipped = [],
  inapplicable = [],
  recommended = [],
  summary = null,
  env = process.env,
  now = new Date(),
}) {
  const counts = {
    passed: passed.length,
    failed: failed.length,
    notVerified: skipped.length,
    recommendedNotMet: recommended.length,
    notApplicable: inapplicable.length,
    // Only the cases that applied. The rest are not results withheld — they are
    // requirements this revision and transport do not have.
    applied: passed.length + failed.length + skipped.length,
  }

  const specVersion = env.MCP_SPEC_VERSION || SUPPORTED_REVISIONS[0]

  return {
    tool: { name: pkg.name, version: pkg.version },
    target: redactTarget(env.MCP_URL || env.MCP_COMMAND || '(no target configured)'),
    transport: env.MCP_COMMAND ? 'stdio' : 'streamable-http',
    specVersion,
    supportedRevisions: [...SUPPORTED_REVISIONS],
    generatedAt: now.toISOString(),
    durationMs: Math.round(summary?.duration_ms || 0),
    counts,
    verdict: verdictFor(counts, specVersion),
    cases: {
      failed: failed.map((item) => ({
        section: section(item.file),
        name: item.name,
        reason: failureReason(item),
      })),
      notVerified: skipped.map((item) => ({
        section: section(item.file),
        name: item.name,
        reason: item.reason,
      })),
      recommendedNotMet: recommended.map((item) => ({
        section: section(item.file),
        label: item.label,
        detail: item.detail ?? null,
      })),
      passed: passed.map((item) => ({ section: section(item.file), name: item.name })),
      notApplicable: inapplicable.map((item) => ({
        section: section(item.file),
        name: item.name,
        reason: item.reason,
      })),
    },
  }
}

/** Group a case list by section, preserving first-seen order. */
export function bySection(cases) {
  const groups = new Map()
  for (const item of cases) {
    if (!groups.has(item.section)) groups.set(item.section, [])
    groups.get(item.section).push(item)
  }
  return groups
}
