import stylisticPlugin from '@stylistic/eslint-plugin'
import zotero from '@zotero-plugin/eslint-config'
import importPlugin from 'eslint-plugin-import'

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

export default zotero({
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
        import: importPlugin,
      },
      settings: {
        'import/resolver': {
          typescript: {
            project: './tsconfig.json',
            alwaysTryTypes: true,
          },
          node: {
            extensions: ['.ts', '.tsx'],
            moduleDirectory: ['node_modules', 'src/'],
          },
        },
        'import/parsers': {
          '@typescript-eslint/parser': ['.ts', '.tsx'],
        },
      },
      rules: {
        'import/no-unresolved': 'error',
        'import/namespace': 'off',
        'import/order': [
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
