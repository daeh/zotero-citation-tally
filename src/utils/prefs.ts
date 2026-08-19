import { config } from '../../package.json'

type PluginPrefsMap = _ZoteroTypes.Prefs['PluginPrefsMap']

const PREFS_PREFIX = config.prefsPrefix

/**
 * Get preference value.
 * Wrapper of `Zotero.Prefs.get`.
 * @param key
 */
export function getPref<K extends keyof PluginPrefsMap>(key: K) {
  return Zotero.Prefs.get(`${PREFS_PREFIX}.${key}`, true) as PluginPrefsMap[K]
}

/**
 * Set preference value.
 * Wrapper of `Zotero.Prefs.set`.
 * @param key
 * @param value
 */
export function setPref<K extends keyof PluginPrefsMap>(key: K, value: PluginPrefsMap[K]) {
  return Zotero.Prefs.set(`${PREFS_PREFIX}.${key}`, value, true)
}
