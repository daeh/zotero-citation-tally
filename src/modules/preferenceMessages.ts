/**
 * Message selection for the preferences pane.
 *
 * This module touches no Zotero API, so the Node tests can reach it.
 * `preferenceScript.ts` cannot, since it imports Zotero-bound preference,
 * notification, and client modules. Everything that decides *which* message to
 * show lives here and is tested; the pane module just binds the result to the DOM.
 *
 * Nothing here renders text. A result carries a Fluent message id plus whatever
 * variables that message takes, so user input reaches the pane as a Fluent
 * argument, which Fluent writes as text and never as markup.
 */

import type { ValidationStatus } from './citationTypes.ts'

/**
 * A message, plus the variables it takes if it takes any.
 *
 * These ids are *not* constrained to the build-generated `FluentMessageId` here,
 * because this module stays free of generated typings so the Node test project
 * can compile it. The constraint is applied where the ids are used:
 * `preferenceScript.ts` passes each one to `getLocaleID`, which is typed on
 * `FluentMessageId`, so an id missing from every `.ftl` still fails the build.
 * `test/locale.test.ts` also pins them to `preferences.ftl` specifically.
 */
export type PrefsMessage =
  | { readonly id: 'pref-database-valid' | 'pref-database-duplicate' | 'pref-database-count' }
  | { readonly id: 'pref-database-invalid'; readonly args: { readonly databases: string } }
  | { readonly id: 'pref-apikey-cleaned'; readonly args: { readonly characters: string } }
  | {
      readonly id:
        | 'pref-apikey-valid'
        | 'pref-apikey-invalid'
        | 'pref-apikey-indeterminate'
        | 'pref-apikey-error'
        | 'pref-apikey-empty'
        | 'pref-apikey-checking'
        | 'pref-apikey-unavailable'
    }

/**
 * Every id the pane can set, as runtime data. The `Record` turns a missing entry
 * into a type error, and lets the locale test assert that each id exists in
 * `preferences.ftl`. No type can check that, since the generated union spans
 * every FTL.
 */
const PREFS_MESSAGE_ID_SET: Record<PrefsMessage['id'], true> = {
  'pref-database-valid': true,
  'pref-database-duplicate': true,
  'pref-database-count': true,
  'pref-database-invalid': true,
  'pref-apikey-valid': true,
  'pref-apikey-invalid': true,
  'pref-apikey-indeterminate': true,
  'pref-apikey-error': true,
  'pref-apikey-empty': true,
  'pref-apikey-checking': true,
  'pref-apikey-unavailable': true,
  'pref-apikey-cleaned': true,
}

export const PREFS_MESSAGE_IDS = Object.keys(PREFS_MESSAGE_ID_SET) as PrefsMessage['id'][]

export type DatabaseValidation =
  | { readonly valid: true; readonly databases: string[]; readonly message: PrefsMessage }
  | { readonly valid: false; readonly message: PrefsMessage }

export const VALID_DATABASES = ['crossref', 'semanticscholar', 'inspire'] as const
const MAX_DATABASES = 3

/**
 * Validate a comma-separated database order.
 *
 * Unrecognised tokens are reported verbatim, so the user sees what they typed.
 * Escaping is the renderer's job: the token travels as a Fluent argument, and
 * Fluent writes it as text.
 *
 * @example
 * validateDatabaseOrder('crossref, nope')
 * // { valid: false, message: { id: 'pref-database-invalid', args: { databases: 'nope' } } }
 */
export function validateDatabaseOrder(rawInput: string): DatabaseValidation {
  const tokens = rawInput
    .split(',')
    .map((token) => token.trim())
    .filter((token) => token !== '')

  const normalized = tokens.map((token) => token.toLowerCase())
  if (new Set(normalized).size !== normalized.length) {
    return { valid: false, message: { id: 'pref-database-duplicate' } }
  }

  // Compare case-insensitively, but report what the user actually wrote.
  const unrecognized = tokens.filter((token) => !(VALID_DATABASES as readonly string[]).includes(token.toLowerCase()))
  if (unrecognized.length > 0) {
    return { valid: false, message: { id: 'pref-database-invalid', args: { databases: unrecognized.join(', ') } } }
  }

  if (normalized.length === 0 || normalized.length > MAX_DATABASES) {
    return { valid: false, message: { id: 'pref-database-count' } }
  }

  return { valid: true, databases: normalized, message: { id: 'pref-database-valid' } }
}

/** Statuses the API-key row can show beyond the validation outcomes. */
export type ApiKeyUiStatus = ValidationStatus | 'checking' | 'neutral' | 'unavailable'

/** Presentation class for the status row; mapped to a colour by the pane. */
export type StatusTone = 'ok' | 'error' | 'warn' | 'none'

/** `null` when the row should stay blank — `neutral` and `aborted` say nothing. */
export function apiKeyStatusMessage(status: ApiKeyUiStatus): PrefsMessage | null {
  switch (status) {
    case 'valid':
      return { id: 'pref-apikey-valid' }
    case 'invalid':
      return { id: 'pref-apikey-invalid' }
    case 'unavailable':
      return { id: 'pref-apikey-unavailable' }
    case 'client_error':
      return { id: 'pref-apikey-error' }
    case 'indeterminate':
      return { id: 'pref-apikey-indeterminate' }
    case 'empty':
      return { id: 'pref-apikey-empty' }
    case 'checking':
      return { id: 'pref-apikey-checking' }
    default:
      return null
  }
}

export function apiKeyStatusTone(status: ApiKeyUiStatus): StatusTone {
  switch (status) {
    case 'valid':
      return 'ok'
    case 'invalid':
    case 'unavailable':
      return 'error'
    case 'client_error':
    case 'indeterminate':
      return 'warn'
    default:
      return 'none'
  }
}

/** `null` when normalization changed nothing worth reporting. */
export function cleanedCharactersMessage(removed: readonly string[]): PrefsMessage | null {
  return removed.length === 0 ? null : { id: 'pref-apikey-cleaned', args: { characters: removed.join(', ') } }
}
