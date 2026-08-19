import { config } from '../../package.json'

import type { FluentMessageId } from '../../typings/i10n'

export { initLocale, getString, getLocaleID }

/**
 * Initialize locale data
 */
function initLocale() {
  // Every FTL the plugin ships. `FluentMessageId` is generated as a union over all
  // of them, so registering only some would let `getString` typecheck against an
  // id it can't actually resolve. test/locale.test.ts enforces that ids are unique
  // across the files.
  const l10n = new (typeof Localization === 'undefined' ? ztoolkit.getGlobal('Localization') : Localization)(
    [`${config.addonRef}-addon.ftl`, `${config.addonRef}-preferences.ftl`],
    true,
  )
  addon.data.locale = {
    current: l10n,
  }
}

/**
 * Get locale string, see https://firefox-source-docs.mozilla.org/l10n/fluent/tutorial.html#fluent-translation-list-ftl
 * @param localString ftl key
 * @param options.branch branch name
 * @param options.args args
 * @example
 * ```ftl
 * # addon.ftl
 * addon-static-example = This is default branch!
 *     .branch-example = This is a branch under addon-static-example!
 * addon-dynamic-example =
    { $count ->
        [one] I have { $count } apple
       *[other] I have { $count } apples
    }
 * ```
 * ```js
 * getString("addon-static-example"); // This is default branch!
 * getString("addon-static-example", { branch: "branch-example" }); // This is a branch under addon-static-example!
 * getString("addon-dynamic-example", { args: { count: 1 } }); // I have 1 apple
 * getString("addon-dynamic-example", { args: { count: 2 } }); // I have 2 apples
 * ```
 */
function getString(localString: FluentMessageId): string
function getString(localString: FluentMessageId, branch: string): string
function getString(
  localeString: FluentMessageId,
  options: { branch?: string | undefined; args?: Record<string, unknown> },
): string
function getString(...inputs: any[]) {
  if (inputs.length === 1) {
    return _getString(inputs[0])
  } else if (inputs.length === 2) {
    if (typeof inputs[1] === 'string') {
      return _getString(inputs[0], { branch: inputs[1] })
    } else {
      return _getString(inputs[0], inputs[1])
    }
  } else {
    throw new Error('Invalid arguments')
  }
}

function _getString(
  localeString: string,
  options: { branch?: string | undefined; args?: Record<string, unknown> } = {},
): string {
  const localStringWithPrefix = `${config.addonRef}-${localeString}`
  const { branch, args } = options
  const pattern = addon.data.locale?.current.formatMessagesSync([{ id: localStringWithPrefix, args }])[0]
  if (!pattern) {
    return localStringWithPrefix
  }
  if (branch && pattern.attributes) {
    for (const attr of pattern.attributes) {
      if (attr.name === branch) {
        return attr.value
      }
    }
    return pattern.attributes[branch] || localStringWithPrefix
  } else {
    return pattern.value || localStringWithPrefix
  }
}

/**
 * Namespace an id for use where the build cannot rewrite it. The scaffold
 * prefixes `data-l10n-id` in markup only, so ids constructed in TypeScript must
 * be prefixed here. Typed on `FluentMessageId` so a typo fails the build.
 */
function getLocaleID(id: FluentMessageId) {
  return `${config.addonRef}-${id}`
}
