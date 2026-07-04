/** @type {import('jest').Config} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  testMatch: ["**/__tests__/**/*.test.ts"],
  // Tests live in dedicated `__tests__/` directories. Until you add real
  // unit tests, this config just makes `npm test` succeed quietly.
  passWithNoTests: true,
};
