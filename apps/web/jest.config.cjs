module.exports = {
  rootDir: '.',
  testEnvironment: 'jsdom',
  testMatch: ['<rootDir>/src/**/*.spec.{ts,tsx}'],
  transform: {
    '^.+\\.[tj]sx?$': 'babel-jest',
  },
  setupFilesAfterEnv: ['<rootDir>/src/test-setup.ts'],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json'],
  collectCoverageFrom: [
    'src/**/*.{ts,tsx}',
    '!src/**/*.spec.{ts,tsx}',
    '!src/main.tsx',
    '!src/test-setup.ts',
    '!src/test-fixtures.ts',
    '!src/vite-env.d.ts',
  ],
  coverageDirectory: '<rootDir>/../../coverage/web',
  coverageReporters: ['text', 'lcov', 'json-summary'],
  coverageThreshold: {
    global: {
      branches: 80,
      functions: 80,
      lines: 80,
      statements: 80,
    },
  },
  clearMocks: true,
  testEnvironmentOptions: {
    url: 'http://localhost/',
  },
};
