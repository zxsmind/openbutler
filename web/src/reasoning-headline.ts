const sentenceSegmenter = new Intl.Segmenter(undefined, { granularity: 'sentence' });
const wordSegmenter = new Intl.Segmenter(undefined, { granularity: 'word' });
const MIN_HEADLINE_CHARS = 64;
const MIN_HEADLINE_WORDS = 9;

function words(text: string): string[] {
  return [...wordSegmenter.segment(text)]
    .filter((part) => part.isWordLike && /\p{L}/u.test(part.segment))
    .map((part) => part.segment.toLowerCase());
}

function isPlainSentence(sentence: string): boolean {
  // Ordinary prose punctuation is allowed; symbols, markup, paths and code are
  // not headline candidates. Check raw text so stripping markup cannot hide it.
  if (!/^[\p{L}\p{M}\p{N}\s.,!?;:'"‘’“”\-–—]+$/u.test(sentence)) return false;
  if (/\p{L}\.\p{L}/u.test(sentence)) return false;
  if (!/[.!][\p{Pf}"']*$/u.test(sentence) || /(?:\.{2,}|…)\s*$/u.test(sentence)) return false;
  return sentence.length >= MIN_HEADLINE_CHARS && words(sentence).length >= MIN_HEADLINE_WORDS;
}

/** Extract complete prose without joining code, headings or unfinished streaming text. */
export function reasoningSentences(text: string): string[] {
  const prose = text
    .replace(/```[^]*?(?:```|$)|~~~[^]*?(?:~~~|$)/g, '\n\n')
    .replace(/^\s*#{1,6}\s+.*$/gm, '')
    .replace(/^\s*(?:[-+]\s+|\d+[.)]\s+)/gm, '');
  return prose
    .split(/\n\s*\n/)
    .flatMap((paragraph) =>
      [...sentenceSegmenter.segment(paragraph.replace(/\s+/g, ' ').trim())].map((part) => part.segment.trim()).filter(isPlainSentence),
    );
}

type Vector = Map<string, number>;

/**
 * Summary-style models split their thought into sections headed by a sole bold
 * line ("**Planning the request**"). The headline follows the current section:
 * the last completed bold line wins, and a half-streamed one is ignored.
 * Only a lone line counts - bold anywhere else stays prose.
 */
export function reasoningTitle(text: string): string | null {
  let title: string | null = null;
  for (const line of text.split('\n')) {
    const match = /^\*\*([^*\n]{3,60})\*\*[.:]?$/.exec(line.trim());
    if (match) title = match[1]!.trim();
  }
  return title;
}

function cosine(left: Vector, right: Vector): number {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (const [term, weight] of left) {
    dot += weight * (right.get(term) ?? 0);
    leftNorm += weight * weight;
  }
  for (const weight of right.values()) rightNorm += weight * weight;
  return leftNorm && rightNorm ? dot / Math.sqrt(leftNorm * rightNorm) : 0;
}

/**
 * Rank recent sentences by TF-IDF lexical cohesion, with a recency decay.
 * No topic/verb dictionaries, language-specific stop words or semantic claims.
 * The bounded window keeps pairwise scoring cheap during token streaming.
 */
export function thoughtHeadline(text: string): string {
  const sentences = reasoningSentences(text).slice(-24);
  if (!sentences.length) return '';
  const documents = sentences.map(words);
  const frequencies = new Map<string, number>();
  for (const document of documents) for (const term of new Set(document)) frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
  const vectors = documents.map((document) => {
    const counts: Vector = new Map();
    for (const term of document) counts.set(term, (counts.get(term) ?? 0) + 1);
    for (const [term, count] of counts) counts.set(term, (1 + Math.log(count)) * Math.log(1 + documents.length / frequencies.get(term)!));
    return counts;
  });
  let selected = sentences.length - 1;
  let best = -Infinity;
  for (const [index, vector] of vectors.entries()) {
    let support = 0;
    let total = 0;
    for (const [otherIndex, other] of vectors.entries()) {
      if (index === otherIndex) continue;
      support += cosine(vector, other);
      total += 1;
    }
    const cohesion = total ? support / total : 0;
    // Length is an eligibility gate, never a penalty that favors short fragments.
    const score = cohesion / Math.sqrt(vectors.length - index);
    if (score >= best) {
      selected = index;
      best = score;
    }
  }
  // Keep the original complete sentence. The view owns any visual ellipsis.
  return sentences[selected];
}
