/**
 * Glob matching for `review.exclude`. Supports `**` (any number of path segments), `*` (anything
 * but "/"), `?` (one char but "/") and `{a,b}` alternatives. Patterns without a "/" match the
 * basename anywhere, like .gitignore.
 */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  let i = 0;
  let inBraces = false;
  while (i < glob.length) {
    const c = glob[i] as string;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // "**/" → zero or more directories; trailing "**" → anything.
        if (glob[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 3;
        } else {
          re += ".*";
          i += 2;
        }
        continue;
      }
      re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "{") {
      re += "(?:";
      inBraces = true;
    } else if (c === "}" && inBraces) {
      re += ")";
      inBraces = false;
    } else if (c === "," && inBraces) re += "|";
    else re += c.replace(/[.+^$()|[\]\\]/g, "\\$&");
    i++;
  }
  return new RegExp(`^${re}$`);
}

export class PathFilter {
  readonly #res: RegExp[];

  constructor(patterns: readonly string[]) {
    this.#res = patterns.map((p) => globToRegExp(p.includes("/") ? p : `**/${p}`));
  }

  excludes(path: string): boolean {
    return this.#res.some((re) => re.test(path));
  }
}
