// Rendering a model and putting the result where it belongs.

import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import { EXTENSIONS, filename, resolveFormat } from './formats.mjs'
import { renderHtml } from './render-html.mjs'
import { renderJson } from './render-json.mjs'
import { renderMarkdown } from './render-markdown.mjs'
import { renderText } from './render-text.mjs'

const RENDERERS = {
  stdio: renderText,
  md: renderMarkdown,
  html: renderHtml,
  json: renderJson,
}

/**
 * Render a model and put it where it belongs.
 *
 * Returns what the caller should print: the whole report for stdio, a single line
 * naming the file otherwise. The path comes back too, so a caller can say where
 * the report went without recomputing it.
 */
export function emit(model, { env = process.env, write = writeFileSync } = {}) {
  const format = resolveFormat(env)
  const extension = EXTENSIONS[format]
  const rendered = RENDERERS[format](model)

  if (!extension) return { format, path: null, stdout: rendered }

  // The CLI always sets this — to an explicit --output-folder resolved against
  // the shell's directory, or otherwise to the OS temp directory — having
  // already created it. This fallback is only for a caller using emit()
  // directly; it matches the CLI's own default rather than process.cwd(),
  // which the test child runs with set to the package root, so resolving
  // against the process would write the report inside node_modules.
  const directory = env.MCP_OUTPUT_DIR || tmpdir()
  // Timestamped, so a second run does not overwrite the first. Reports
  // accumulate rather than replace; .gitignore covers them.
  const path = resolve(directory, filename(model.generatedAt, extension))

  try {
    write(path, rendered, 'utf8')
  } catch (err) {
    // The run is already over and its results are the expensive part — minutes of
    // requests, possibly against a rate-limited target. So a disk that fills up
    // between the CLI's check and this write costs the file, not the findings:
    // the report goes to the terminal instead, with the reason it is there.
    return {
      format,
      path: null,
      stdout: `could not write ${path}: ${err.message}\nprinting the report instead\n`
        + renderText(model),
    }
  }

  return { format, path, stdout: `report written to ${path}\n` }
}
