module.exports = function transformImportMetaEnv({ types }) {
  return {
    name: 'transform-vite-env-for-jest',
    visitor: {
      MemberExpression(path) {
        const object = path.node.object;
        if (
          types.isMetaProperty(object) &&
          types.isIdentifier(object.meta, { name: 'import' }) &&
          types.isIdentifier(object.property, { name: 'meta' }) &&
          types.isIdentifier(path.node.property, { name: 'env' })
        ) {
          path.replaceWith(
            types.memberExpression(
              types.identifier('globalThis'),
              types.identifier('__VITE_ENV__'),
            ),
          );
        }
      },
    },
  };
};
