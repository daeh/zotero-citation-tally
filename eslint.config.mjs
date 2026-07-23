import stylisticPlugin from '@stylistic/eslint-plugin'
import zotero from '@zotero-plugin/eslint-config'
import { defineConfig } from 'eslint/config'
import { createTypeScriptImportResolver } from 'eslint-import-resolver-typescript'
import { importX } from 'eslint-plugin-import-x'

const context = (() => {
  if (typeof process.env.NODE_ENV === 'undefined') return 'default'
  if (process.env.NODE_ENV === 'development') return 'development'
  if (process.env.NODE_ENV === 'production') return 'production'
  if (process.env.NODE_ENV === 'repo') return 'repository'
  return 'default'
})()

// Project-wide src/ relaxations — preserve parity with the pre-preset lint
// config. Tighten these incrementally in follow-up commits rather than as
// part of infra migration.
const srcRelaxations = {
  '@typescript-eslint/no-unused-vars': 'off',
  '@typescript-eslint/no-explicit-any': 'off',
  '@typescript-eslint/ban-ts-comment': [
    'warn',
    {
      'ts-expect-error': 'allow-with-description',
      'ts-ignore': 'allow-with-description',
      'ts-nocheck': 'allow-with-description',
      'ts-check': 'allow-with-description',
    },
  ],
  'no-useless-assignment': 'off',
  'no-useless-escape': 'warn',
}

const projectFilesToIgnore = context === 'repository' ? [] : ['zotero-plugin.config.ts', '*.config.mjs']

const baseConfig = zotero({
  overrides: [
    {
      name: 'zotero-citation-tally/stylistic',
      files: ['**/*.{ts,mts,cts,tsx,mtsx,js,mjs,cjs,jsx,mjsx}'],
      plugins: {
        '@stylistic': stylisticPlugin,
      },
      rules: {
        '@stylistic/max-len': [
          'warn',
          {
            code: 120,
            ignoreComments: true,
            ignoreTrailingComments: true,
            ignoreStrings: true,
            ignoreUrls: true,
          },
        ],
      },
    },
    {
      name: 'zotero-citation-tally/import-order',
      files: ['src/**/*.{ts,tsx}'],
      plugins: {
        'import-x': importX,
      },
      settings: {
        'import-x/resolver-next': [
          createTypeScriptImportResolver({
            project: './tsconfig.json',
            alwaysTryTypes: true,
          }),
        ],
      },
      rules: {
        'import-x/no-unresolved': 'error',
        'import-x/namespace': 'off',
        'import-x/order': [
          'error',
          {
            'groups': ['builtin', 'external', 'internal', 'parent', 'sibling', 'index', 'type', 'object', 'unknown'],
            'newlines-between': 'always',
            'alphabetize': { order: 'asc', caseInsensitive: true },
          },
        ],
        'sort-imports': [
          'error',
          {
            allowSeparatedGroups: true,
            ignoreCase: true,
            ignoreDeclarationSort: true,
            ignoreMemberSort: false,
            memberSyntaxSortOrder: ['none', 'all', 'multiple', 'single'],
          },
        ],
      },
    },
    {
      name: 'zotero-citation-tally/src-restricted-globals',
      files: ['src/**/*.{ts,tsx}'],
      rules: {
        'no-restricted-globals': [
          'error',
          { name: 'window', message: 'Use `Zotero.getMainWindow()` instead.' },
          { name: 'document', message: 'Use `Zotero.getMainWindow().document` instead.' },
          { name: 'ZoteroPane', message: 'Use `Zotero.getActiveZoteroPane()` instead.' },
          'Zotero_Tabs',
        ],
        '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
        ...srcRelaxations,
      },
    },
    {
      name: 'zotero-citation-tally/project-ignores',
      ignores: ['**/*-lintignore*', '**/*_lintignore*', 'scripts/', 'src/modules/examples.ts', ...projectFilesToIgnore],
    },
  ],
})

// Use the plugin registered by the preset to avoid loading a second @typescript-eslint instance.
const tsPlugin = baseConfig.find((c) => c.plugins?.['@typescript-eslint'])?.plugins?.['@typescript-eslint']
if (!tsPlugin) throw new Error('@zotero-plugin/eslint-config did not register @typescript-eslint')
const typeChecked = tsPlugin.configs['flat/recommended-type-checked-only']
if (!Array.isArray(typeChecked)) throw new Error('unexpected shape for recommended-type-checked-only')

// Keep no-unsafe findings visible without making existing any usage fail linting.
const noUnsafeWarn = Object.fromEntries(
  Object.keys(Object.assign({}, ...typeChecked.filter((c) => c.rules).map((c) => c.rules)))
    .filter((r) => r.startsWith('@typescript-eslint/no-unsafe-'))
    .map((r) => [r, 'warn']),
)

export default defineConfig(baseConfig, {
  name: 'zotero-citation-tally/type-checked',
  files: ['src/**/*.{ts,mts,cts,tsx}'],
  ignores: ['src/modules/examples.ts'],
  extends: [typeChecked],
  languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
  rules: { ...noUnsafeWarn },
})
