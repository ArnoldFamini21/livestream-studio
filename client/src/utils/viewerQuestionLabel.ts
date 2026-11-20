import type { QAQuestion } from '@studio/shared';
import { splitGraphemes } from './graphemes.ts';

const VIEWER_SUFFIX = ' (viewer)';
type QuestionAuthor = Pick<QAQuestion, 'authorName' | 'fromViewer'>;

/**
 * The name shown with a question. A question from the public watch page always
 * says so, whatever name the viewer typed: a viewer who calls themselves
 * "Host" must not look like the host in the studio or on the broadcast.
 */
export function questionAuthorLabel(question: QuestionAuthor): string {
  return question.fromViewer ? `${question.authorName}${VIEWER_SUFFIX}` : question.authorName;
}

export function fitQuestionAuthorLabel(
  question: QuestionAuthor,
  maxWidth: number,
  measureWidth: (text: string) => number,
): string {
  const full = `- ${questionAuthorLabel(question)}`;
  if (measureWidth(full) <= maxWidth) return full;

  const suffix = question.fromViewer ? VIEWER_SUFFIX : '';
  const shortened = (name: string) => `- ${name}…${suffix}`;
  if (measureWidth(shortened('')) > maxWidth) {
    return question.fromViewer && measureWidth('Viewer') <= maxWidth ? 'Viewer' : '';
  }

  const name = splitGraphemes(question.authorName);
  let low = 0;
  let high = name.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (measureWidth(shortened(name.slice(0, middle).join(''))) <= maxWidth) low = middle;
    else high = middle - 1;
  }
  return shortened(name.slice(0, low).join(''));
}
