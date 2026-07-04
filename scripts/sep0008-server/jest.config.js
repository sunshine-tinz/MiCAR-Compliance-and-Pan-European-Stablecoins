/**
 * Jest config for the SEP-0008 hook server.
 *
 * Uses the ts-jest preset so the test files (which use TypeScript
 * `import` syntax and types from the SDK) are compiled in-place.
 */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  testMatch: ["<rootDir>/test/**/*.test.ts"],
  // Suppress noisy "Cannot find module" warnings from the SDK's
  // optional .d.ts subpath types that aren't shipped.
  moduleFileExtensions: ["ts", "js", "json"],
  // Don't fail on console.error from the SDK's deprecation warnings.
  silent: false,
};
