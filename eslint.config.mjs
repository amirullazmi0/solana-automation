import tseslint from 'typescript-eslint';
import globals from 'globals';
import eslint from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';

export default tseslint.config(
  {
    ignores: ['**/*.js', 'node_modules', 'dist'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended, // Menggunakan recommended biasa, bukan TypeChecked agar lebih santai
  eslintPluginPrettierRecommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      // Aturan dari project lama Anda
      '@typescript-eslint/interface-name-prefix': 'off',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-explicit-any': 'error',
      'object-curly-spacing': ['error', 'always'],
      
      // Aturan tambahan agar tidak terlalu strict
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      'prettier/prettier': 'off', // MATIKAN biar nggak rewel soal spasi/indentasi
    },
  },
);