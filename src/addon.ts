import { config } from '../package.json'

import hooks from './hooks'
import { runtimeSelfTest, type RuntimeSelfTestResult } from './utils/runtimeSelfTest'
import { createZToolkit } from './utils/ztoolkit'

import type { ColumnOptions, DialogHelper } from 'zotero-plugin-toolkit'

class Addon {
  public data: {
    alive: boolean
    config: typeof config
    // Env type, see build.js
    env: 'development' | 'production'
    initialized?: boolean
    /** Bootstrap bridge outcome, exposed for diagnostics and the CI runtime smoke. */
    runtimeBridge?: RuntimeBridgeReport
    ztoolkit: ZToolkit
    locale?: {
      current: any
    }
    prefs?: {
      window: Window
      columns?: ColumnOptions[]
      rows?: Record<string, string>[]
    }
    dialog?: DialogHelper
  }
  // Lifecycle hooks
  public hooks: typeof hooks
  // APIs
  public api: {
    runtimeSelfTest: () => Promise<RuntimeSelfTestResult>
  }

  constructor() {
    this.data = {
      alive: true,
      config,
      env: __env__,
      initialized: false,
      ztoolkit: createZToolkit(),
    }
    this.hooks = hooks
    this.api = { runtimeSelfTest }
  }
}

export default Addon
