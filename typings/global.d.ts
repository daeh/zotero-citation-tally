declare const _globalThis: {
  [key: string]: any
  Zotero: _ZoteroTypes.Zotero
  ztoolkit: ZToolkit
  addon: typeof addon
  __runtimeBridgeReport?: RuntimeBridgeReport
}

/** Outcome of the bootstrap runtime bridge (see addon/bootstrap.js). */
declare interface RuntimeBridgeReport {
  provider: 'bootstrap-global' | 'import-global-properties' | 'unavailable'
  semanticScholarAvailable: boolean
}

declare type ZToolkit = ReturnType<typeof import('../src/utils/ztoolkit').createZToolkit>

declare const ztoolkit: ZToolkit

declare const rootURI: string

declare const addon: import('../src/addon').default

declare const __env__: 'production' | 'development'
