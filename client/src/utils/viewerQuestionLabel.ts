import type { QAQuestion } from '@studio/shared';

/**
 * The name shown with a question. A question from the public watch page always
 * says so, whatever name the viewer typed: a viewer who calls themselves
 * "Host" must not look like the host in the studio or on the broadcast.
 */
export function questionAuthorLabel(question: Pick<QAQuestion, 'authorName' | 'fromViewer'>): string {
  return question.fromViewer ? `${question.authorName} (viewer)` : question.authorName;
}
