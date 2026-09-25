module.exports = {
  presets: [
    ['@babel/preset-env', { targets: { node: 'current' } }],
    ['@babel/preset-react', { runtime: 'automatic' }],
    ['@babel/preset-typescript', { allExtensions: true, isTSX: true }],
  ],
  plugins: [require.resolve('./transform-import-meta-env.cjs')],
};
