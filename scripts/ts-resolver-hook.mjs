/**
 * Node ESM resolver hook — rewrites relative ".js" imports to ".ts" so we
 * can import the audit extension's source directly from a script running
 * under --experimental-strip-types. Without this, Node's strip-types mode
 * doesn't follow the NodeNext convention used by the audit module
 * (`import "./foo.js"` resolves to `foo.ts`).
 *
 * Scope: ONLY relative imports. Bare specifiers and absolute paths fall
 * through to the default resolver untouched.
 *
 * Cost-of-existence: 30 lines, no new dependencies, no build step. The
 * audit extension stays loadable by the openclaw runtime as-is.
 */
export async function resolve(specifier, context, nextResolve) {
  const isRelative = specifier.startsWith("./") || specifier.startsWith("../");
  if (isRelative && specifier.endsWith(".js")) {
    try {
      return await nextResolve(specifier.slice(0, -3) + ".ts", context);
    } catch {
      // Fall through — the original .js resolution might still succeed
      // (e.g. for actual compiled .js files in node_modules).
    }
  }
  return nextResolve(specifier, context);
}
