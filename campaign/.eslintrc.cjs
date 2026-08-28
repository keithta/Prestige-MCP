/**
 * The no-restricted-syntax rule below is the guardrail that keeps Microsoft
 * Graph behind one module. The exempted paths are the legitimate exceptions:
 *
 *   packages/graph   the client itself
 *   packages/testing the stand-in Graph server
 *   core/config.ts   where the default endpoint is defined
 *   scripts/         the credential verification tool
 *   tests/           the setup file asserts on the URL precisely to keep test
 *                    runs off the real API
 */
module.exports = {
  "root": true,
  "parser": "@typescript-eslint/parser",
  "plugins": [
    "@typescript-eslint"
  ],
  "extends": [
    "eslint:recommended",
    "plugin:@typescript-eslint/recommended"
  ],
  "env": {
    "node": true,
    "es2023": true
  },
  "ignorePatterns": [
    "dist/",
    "node_modules/",
    ".next/",
    "coverage/",
    "*.config.ts",
    "next-env.d.ts"
  ],
  "rules": {
    "@typescript-eslint/no-explicit-any": "warn",
    "@typescript-eslint/no-unused-vars": [
      "error",
      {
        "argsIgnorePattern": "^_",
        "varsIgnorePattern": "^_"
      }
    ],
    "no-restricted-syntax": [
      "error",
      {
        "selector": "Literal[value=/graph\\.microsoft\\.com/]",
        "message": "Microsoft Graph must only be called through @campaign/graph. Do not hardcode Graph URLs elsewhere."
      }
    ]
  },
  "overrides": [
    {
      "files": [
        "packages/graph/src/**/*.ts",
        "packages/testing/src/**/*.ts",
        "packages/core/src/config.ts",
        "scripts/**/*.ts",
        "tests/**/*.ts"
      ],
      "rules": {
        "no-restricted-syntax": "off"
      }
    }
  ]
};
