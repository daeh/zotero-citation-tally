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

/**
 * The slice of Gecko's `MozXULElement` this plugin uses.
 *
 * `zotero-types` does not declare it, and it is a Mozilla platform global
 * rather than a Zotero API. Declaring the one method narrowly is better than
 * the `@ts-ignore` this replaces, which suppressed every error on the line.
 */
declare interface MozXULElementStatics {
  insertFTLIfNeeded: (href: string) => void
}

declare namespace _ZoteroTypes {
  interface MainWindow {
    MozXULElement: MozXULElementStatics
  }
}

declare type ZToolkit = ReturnType<typeof import('../src/utils/ztoolkit').createZToolkit>

declare const ztoolkit: ZToolkit

declare const rootURI: string

declare const addon: import('../src/addon').default

declare const __env__: 'production' | 'development'
