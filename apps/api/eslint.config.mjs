import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig([
  ...tseslint.configs.recommended,
  globalIgnores(['dist/**', 'dist-scripts/**', 'coverage/**', 'jest.config.js']),
]);
