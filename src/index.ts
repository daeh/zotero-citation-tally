import { BasicTool } from 'zotero-plugin-toolkit'

import { config } from '../package.json'

import Addon from './addon'

const basicTool = new BasicTool()

// @ts-expect-error addon instance is injected at runtime
if (!basicTool.getGlobal('Zotero')[config.addonInstance]) {
  _globalThis.addon = new Addon()
  defineGlobal('ztoolkit', () => {
    return _globalThis.addon.data.ztoolkit
  })
  // @ts-expect-error addon instance is injected at runtime
  Zotero[config.addonInstance] = addon
}

function defineGlobal(name: Parameters<BasicTool['getGlobal']>[0]): void
function defineGlobal(name: string, getter: () => any): void
function defineGlobal(name: string, getter?: () => any) {
  Object.defineProperty(_globalThis, name, {
    get() {
      return getter ? getter() : basicTool.getGlobal(name)
    },
  })
}
