// What output formats exist, and what a report file is called.
//
// Deliberately free of imports. The CLI validates --output before it has finished
// turning flags into environment variables, and lib/env.mjs computes its exports
// once at import time from process.env — so anything the CLI imports this early
// must not reach env.mjs, directly or transitively, or env.mjs freezes values that
// the flags have not been applied to yet. That mistake silently disables revision
// detection, which is why the format list lives here rather than beside the
// renderers that need env.mjs.

export const PREFIX = 'mcpspectest'

// stdio first: it is the default, and this order is what --help prints.
export const EXTENSIONS = {
  stdio: null,
  md: 'md',
  html: 'html',
  json: 'json',
}

export const FORMAT_NAMES = Object.keys(EXTENSIONS)

export function isFormat(name) {
  return Object.hasOwn(EXTENSIONS, name)
}

/** The format for a run: whatever was asked for, stdio when nothing was. */
export function resolveFormat(env = process.env) {
  const requested = env.MCP_OUTPUT
  return requested && isFormat(requested) ? requested : 'stdio'
}

/**
 * The YYMMDDHHMMSS stamp in a report's filename.
 *
 * Taken from the model's own generatedAt rather than a fresh clock read, so the
 * name and the timestamp inside the file can never disagree. UTC, for the same
 * reason generatedAt is: a name meaning a different instant depending on who ran
 * it is not much of a name.
 */
export function stamp(generatedAt) {
  return generatedAt.replace(/\D/g, '').slice(2, 14)
}

/** The filename a report of this format and vintage is written under. */
export function filename(generatedAt, extension) {
  return `${PREFIX}-${stamp(generatedAt)}.${extension}`
}
