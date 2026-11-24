import config from '@iobroker/eslint-config';

export default [
    { ignores: ['node_modules/**', 'coverage/**'] },
    ...config,
    // This CommonJS adapter uses inline protocol comments; full API JSDoc is optional.
    { rules: { 'jsdoc/require-jsdoc': 'off' } },
];
