/** A Markdown code fence longer than any backtick run inside the content. */
export function fence(content: string, lang = ""): string {
  const longest = Math.max(2, ...[...content.matchAll(/`+/g)].map((m) => m[0].length));
  const ticks = "`".repeat(longest + 1);
  return `${ticks}${lang}\n${content}\n${ticks}`;
}
