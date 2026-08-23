// ANSI colouring for the terminal report.
//
// Shared because two places need it: the report itself, and the target's own
// stderr, which streams through while the run is still going.
//
// The decision and the palette are separate functions so both sides of "is colour
// on" are reachable from a test. Deciding it inline would leave the escape-code
// path unexercised anywhere but a real terminal, which is exactly where nobody is
// watching for a regression.

/** Colour is for terminals: off when redirected, and off when NO_COLOR is set. */
export function colourEnabled(env = process.env, stream = process.stdout) {
  return Boolean(stream.isTTY) && !env.NO_COLOR
}

export function palette(enabled) {
  const wrap = (code) => (text) => (enabled ? `\x1b[${code}m${text}\x1b[0m` : String(text))
  return { red: wrap(31), green: wrap(32), yellow: wrap(33), dim: wrap(2), bold: wrap(1) }
}

const active = palette(colourEnabled())

export const red = active.red
export const green = active.green
export const yellow = active.yellow
export const dim = active.dim
export const bold = active.bold
