// Rendering a model and putting the result where it belongs.

import { writeFileSync } from 'node:fs'
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

  // The test child runs with its cwd set to the package root, so resolving
  // against the process would write the report inside node_modules. The CLI
  // passes the shell's directory through instead.
  const directory = env.MCP_OUTPUT_DIR || process.cwd()
  // Timestamped, so a second run does not overwrite the first. Reports
  // accumulate rather than replace; .gitignore covers them.
  const path = resolve(directory, filename(model.generatedAt, extension))
  write(path, rendered, 'utf8')

  return { format, path, stdout: `report written to ${path}\n` }
}
