import { defineConfig } from 'zotero-plugin-scaffold'
import pkg from './package.json' with { type: 'json' }

export default defineConfig({
  source: ['src', 'addon'],
  dist: '.scaffold/build',
  name: pkg.config.addonName,
  id: pkg.config.addonID,
  namespace: pkg.config.addonRef,
  updateURL: `https://github.com/{{owner}}/{{repo}}/releases/download/release/${
    pkg.version.includes('-') ? 'update-beta.json' : 'update.json'
  }`,
  xpiDownloadLink: 'https://github.com/{{owner}}/{{repo}}/releases/download/v{{version}}/{{xpiName}}.xpi',

  build: {
    assets: ['addon/**/*.*'],
    define: {
      ...pkg.config,
      author: pkg.author,
      description: pkg.description,
      homepage: pkg.homepage,
      buildVersion: pkg.version,
      buildTime: '{{buildTime}}',
      // Substituted into raw assets (bootstrap.js) — the bundle gets __env__ from esbuild below.
      buildEnv: process.env.NODE_ENV === 'development' ? 'development' : 'production',
    },
    prefs: {
      prefix: pkg.config.prefsPrefix,
    },
    esbuildOptions: [
      {
        entryPoints: ['src/index.ts'],
        define: {
          __env__: `"${process.env.NODE_ENV}"`,
        },
        bundle: true,
        target: 'firefox140',
        outfile: `.scaffold/build/addon/content/scripts/${pkg.config.addonRef}.js`,
      },
    ],
  },

  test: {
    // Only this directory is bundled into the Zotero test window; the Node
    // unit tests under test/ must not be swept into the browser environment.
    entries: 'test/zotero',
    mocha: {
      timeout: 30000,
    },
    waitForPlugin: `() => Zotero.${pkg.config.addonInstance}.data.initialized`,
  },

  // For detailed logging, uncomment:
  // logLevel: "trace",
})
