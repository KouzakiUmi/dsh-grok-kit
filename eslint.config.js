//
// Part of dsh-grok-kit, Apache-2.0.
//

import tseslint from 'typescript-eslint'

/**
 * Client tests are typechecked by tsconfig.client.json, not tsconfig.json.
 * Keep this list aligned with that include/exclude split.
 */
const CLIENT_TESTS = [
  'tests/imagine-view.spec.ts',
  'tests/video-view.spec.ts',
  'tests/video-refresh.spec.ts',
  'tests/media-card.spec.ts',
  'tests/settings-pages.spec.ts',
  'tests/quota-view.spec.ts',
  'tests/quota-lifecycle.spec.ts',
  'tests/media-settings.spec.ts',
]

const rules = {
  '@typescript-eslint/no-floating-promises': 'error',
  '@typescript-eslint/no-unused-vars': ['error', {
    args: 'all',
    argsIgnorePattern: '^_',
    varsIgnorePattern: '^_',
    caughtErrors: 'all',
    caughtErrorsIgnorePattern: '^_',
  }],
  '@typescript-eslint/switch-exhaustiveness-check': 'error',
  // Defensive checks against host objects and parsed JSON are widespread.
  // Warn so new always-true conditions stay visible without a sweeping edit.
  '@typescript-eslint/no-unnecessary-condition': 'warn',
}

/** @param {string} project @param {string[]} files @param {string[] | undefined} ignores */
function typed(project, files, ignores) {
  return {
    files,
    ...ignores === undefined ? {} : { ignores },
    extends: [tseslint.configs.base],
    languageOptions: {
      parserOptions: {
        project,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules,
  }
}

export default tseslint.config(
  {
    ignores: ['lib/**', 'node_modules/**', 'coverage/**', 'scripts/**', 'archive/**', 'dist/**'],
  },
  typed('./tsconfig.json', ['src/**/*.ts', 'tests/**/*.ts'], ['src/client/**', ...CLIENT_TESTS]),
  typed('./tsconfig.client.json', ['src/client/**/*.ts', 'src/client/**/*.tsx', ...CLIENT_TESTS]),
)
