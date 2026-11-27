/** Token estimation. Pluggable so a real tokenizer can replace the heuristic later. */
export interface TokenEstimator {
  estimate(text: string): number;
}

/** chars/N heuristic. 4 is typical for English; code often runs closer to 3, hence the margin. */
export function charsPerToken(n = 4): TokenEstimator {
  return { estimate: (text) => Math.ceil(text.length / n) };
}

/** Fraction of the context window kept free to absorb estimation error. */
export const SAFETY_MARGIN = 0.15;
