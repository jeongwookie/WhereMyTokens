import type { PathCategory } from '../shared/breakdownTypes';

export { PATH_CATEGORIES, type PathCategory } from '../shared/breakdownTypes';

/** Pure, fixed default ruleset (YAGNI: not user-configurable - spec section 8). Fallback = product_code. */
export function classifyPath(rawPath: string): PathCategory {
  const p = rawPath.replace(/\\/g, '/').toLowerCase();
  const base = p.slice(p.lastIndexOf('/') + 1);

  // Vendor wins over everything so vendored tests/assets count as vendor.
  if (/(^|\/)(node_modules|vendor|third[_-]?party|\.yarn|bower_components)\//.test(p)) return 'vendor';

  if (/(\.|^)(test|spec)\.[a-z0-9]+$/.test(base) || /(^|\/)(tests?|__tests__)\//.test(p)) return 'test_code';

  if (/(^|\/)(migrations?)\//.test(p) || /\.(sql|prisma)$/.test(base) || base.endsWith('.proto') || /schema\.(graphql|prisma|sql)$/.test(base)) return 'schema_migration';

  if (
    /\.(md|mdx|markdown|rst|adoc|txt)$/.test(base) ||
    base === 'license' || base === 'licence' || base === 'copying' || base === 'notice' || base === 'authors' ||
    /(^|\/)(docs?|spec|specs)\//.test(p)
  ) return 'docs_spec';

  if (
    /\.(json|ya?ml|toml|ini|cfg|conf|lock|dockerfile|gradle)$/.test(base) ||
    base === 'dockerfile' || base === 'makefile' || base === '.gitignore' ||
    /(^|\/)\.github\//.test(p) ||
    /\.(config|rc)\.[a-z0-9]+$/.test(base)
  ) return 'config_build';

  if (/\.(png|jpe?g|gif|svg|ico|webp|woff2?|ttf|otf|eot|mp4|mp3|wav|pdf)$/.test(base) || /(^|\/)(assets?|public|static|images?|fonts?)\//.test(p)) return 'asset';

  return 'product_code';
}
