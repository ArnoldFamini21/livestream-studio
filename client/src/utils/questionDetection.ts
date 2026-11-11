/**
 * Is this chat comment a question? Pure and cheap: English and basic
 * Tagalog / Taglish. A trailing "?" settles it; otherwise a leading question
 * word or the particle "ba" near the start does, unless the text reads as a
 * statement or an exclamation ("What a blessing!", "Will be there").
 */

const ENGLISH_WH = new Set(['who', 'whom', 'whose', 'what', 'when', 'where', 'why', 'how', 'which']);
const ENGLISH_AUX = new Set(['can', 'could', 'do', 'does', 'did', 'is', 'are', 'will', 'would', 'should']);
const TAGALOG_WORDS = new Set([
  'ano', 'sino', 'saan', 'kailan', 'bakit', 'paano', 'pwede', 'puwede', 'alin', 'ilan', 'kanino', 'magkano',
]);
/** Contractions that still start a question ("what's the verse?"). */
const WH_CONTRACTIONS = new Set(["who's", "what's", "when's", "where's", "why's", "how's", "whats", "hows"]);
/** After an auxiliary these make it a statement or an order: "Will be there", "Do not forget". */
const AUX_STATEMENT_NEXT = new Set(['be', 'not', 'it', 'this', 'that', 'good', 'of', 'power', 'smith', 'nothing']);
/** "How great is our God", "What a blessing": praise and exclamations, not questions. */
const PRAISE_AFTER_HOW = new Set([
  'great', 'beautiful', 'wonderful', 'amazing', 'awesome', 'blessed', 'good', 'lovely', 'powerful', 'precious', 'sweet', 'nice', 'cool',
]);
const NUMBER_OF_ALNUM_REQUIRED = 2;

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/\s+/)
    .map((word) => word.replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, '').replace(/[\u2019]/g, "'"))
    .filter(Boolean);
}

function endsWithQuestionMark(text: string): boolean {
  const trimmed = text.replace(/[\s"'\u201d\u2019)\]}*_~\p{Extended_Pictographic}\u200d\ufe0f]+$/gu, '');
  if (!trimmed.endsWith('?')) return false;
  const alnum = (trimmed.match(/[\p{L}\p{N}]/gu) || []).length;
  if (alnum < NUMBER_OF_ALNUM_REQUIRED) return false;
  const lastToken = trimmed.split(/\s+/).pop() || '';
  // A link that ends in "?" is not a question.
  if (/^https?:\/\//i.test(lastToken) && trimmed.split(/\s+/).length === 1) return false;
  return true;
}

export function isQuestion(text: string): boolean {
  if (typeof text !== 'string') return false;
  const value = text.trim();
  if (!value) return false;
  if (endsWithQuestionMark(value)) return true;
  // Without a question mark, a sentence that ends like a statement or an exclamation is not a question.
  if (/[.!]["'\u201d\u2019)\]]*\s*$/u.test(value) || /!/.test(value)) return false;

  const list = words(value);
  if (list.length === 0) return false;
  const [first, second] = list;

  if (TAGALOG_WORDS.has(first)) return true;
  if (WH_CONTRACTIONS.has(first)) return list.length >= 2;
  if (ENGLISH_WH.has(first)) {
    if (list.length < 2) return false;
    if (first === 'what' && (second === 'a' || second === 'an')) return false;
    if (first === 'how' && PRAISE_AFTER_HOW.has(second)) return false;
    // "When I was young..." / "What I think": a clause, not a question.
    if (second === 'i' || second === "i'm" || second === 'we') return false;
    return true;
  }
  if (ENGLISH_AUX.has(first)) {
    if (list.length < 2) return false;
    if (AUX_STATEMENT_NEXT.has(second)) return false;
    if (second.endsWith("n't")) return false;
    return true;
  }
  // Taglish particle "ba" within the first four words ("Live ba ito", "Pwede ba").
  return list.slice(0, 4).includes('ba');
}
