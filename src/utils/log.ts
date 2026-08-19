import { getPref } from './prefs'

/**
 * Logging channels.
 *
 * `ztoolkit.log` was used for everything, including per-cell-render item
 * introspection and full dumps of library-scan state and API responses. That is
 * expensive in hot paths and puts item titles, identifiers, Extra-field
 * contents, and raw provider payloads into the log unconditionally.
 *
 * Two channels now:
 *
 * - `debugLog` — diagnostics, off unless the `debugLogging` pref is set.
 * - `ztoolkit.log` / `Zotero.logError` — operational messages and genuine
 *   degradation, always emitted. Gating those would make the next startup
 *   failure unreportable, which is the opposite of what this is for.
 */
export function isDebugLoggingEnabled(): boolean {
  return getPref('debugLogging') === true
}

/** Diagnostic logging. Silent unless the user turns `debugLogging` on. */
export function debugLog(...args: unknown[]): void {
  if (!isDebugLoggingEnabled()) return
  ztoolkit.log(...args)
}

/**
 * Diagnostic logging whose *message* is expensive to build.
 *
 * The thunk is not called when logging is off, so `JSON.stringify` of a whole
 * library scan costs nothing in the default configuration.
 */
export function debugLogLazy(build: () => unknown[]): void {
  if (!isDebugLoggingEnabled()) return
  ztoolkit.log(...build())
}
