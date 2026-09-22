// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'public/**', 'src/vite-env.d.ts'],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    // L'analyse typée ne couvre que `src` : les fichiers de configuration
    // (vite, eslint) ne font pas partie du programme TypeScript, et les
    // inclure obligerait à maintenir un second tsconfig pour rien.
    files: ['src/**/*.ts'],
    languageOptions: {
      parserOptions: {
        project: './tsconfig.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Un paramètre inutilisé nommé `_dt` est une signature imposée par un
      // appelant, pas un oubli : on ne veut pas être averti pour cela.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],

      // Les typages publics de Cesium ne déclarent pas tout ce que la
      // bibliothèque expose réellement à l'exécution (`scene.context`,
      // `Appearance.getDefaultRenderState`, les attributs de géométrie libres).
      // Chaque transtypage du projet est commenté sur place avec sa raison ;
      // interdire `any` ici n'apporterait qu'un contournement de plus.
      '@typescript-eslint/no-explicit-any': 'warn',

      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': ['warn', { allow: ['warn', 'error', 'info'] }],
      'prefer-const': 'error',
    },
  },

  // `prettier` vient en dernier : il désactive les règles de style qui
  // entreraient en conflit avec le formateur.
  prettier,
);
