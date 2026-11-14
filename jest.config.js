/** @type {import('jest').Config} */
const base = {
  preset: "ts-jest",
  testEnvironment: "node",
};

module.exports = {
  projects: [
    {
      ...base,
      displayName: "unit",
      testMatch: ["<rootDir>/tests/unit/**/*.test.ts"],
    },
    {
      ...base,
      displayName: "integration",
      testMatch: ["<rootDir>/tests/integration/**/*.test.ts"],
    },
  ],
};
