import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildClipSuggestions,
  type ClipSuggestionCaptionSegment,
} from '../src/utils/clipSuggestions.ts';

const RECORDING_START = Date.parse('2026-07-07T10:00:00.000Z');

function captionAt(offsetSeconds: number, text: string, overrides: Partial<ClipSuggestionCaptionSegment> = {}): ClipSuggestionCaptionSegment {
  return {
    speakerName: 'Host',
    text,
    timestamp: new Date(RECORDING_START + offsetSeconds * 1000).toISOString(),
    ...overrides,
  };
}

describe('buildClipSuggestions', () => {
  it('returns no suggestions without markers or captions', () => {
    assert.deepEqual(buildClipSuggestions({}), []);
    assert.deepEqual(buildClipSuggestions({ captionSegments: [], markers: [] }), []);
  });

  it('anchors 30-second suggestions around recording markers', () => {
    const suggestions = buildClipSuggestions({
      markers: [{ label: 'Product demo', seconds: 60 }],
      durationSeconds: 300,
    });

    assert.equal(suggestions.length, 1);
    assert.equal(suggestions[0].reason, 'marker');
    assert.equal(suggestions[0].label, 'Marker: Product demo');
    assert.equal(suggestions[0].startSeconds, 55);
    assert.equal(suggestions[0].endSeconds, 85);
  });

  it('clamps marker suggestions to the start and end of the track', () => {
    const suggestions = buildClipSuggestions({
      markers: [
        { label: 'Cold open', seconds: 1 },
        { label: 'Outro', seconds: 118 },
      ],
      durationSeconds: 120,
    });

    assert.equal(suggestions.length, 2);
    assert.equal(suggestions[0].startSeconds, 0);
    assert.equal(suggestions[0].endSeconds, 26);
    assert.equal(suggestions[1].startSeconds, 113);
    assert.equal(suggestions[1].endSeconds, 120);
  });

  it('drops suggestions that start beyond the track or become too short', () => {
    const suggestions = buildClipSuggestions({
      markers: [
        { label: 'Beyond the end', seconds: 500 },
        { label: 'Sliver', seconds: 120 },
      ],
      durationSeconds: 118,
    });

    assert.deepEqual(suggestions, []);
  });

  it('suggests question moments from caption segments', () => {
    const suggestions = buildClipSuggestions({
      captionSegments: [
        captionAt(0, 'Welcome to the show everyone.'),
        captionAt(45, 'So how does the pricing actually work for teams?'),
        captionAt(50, 'Great question, let me walk through it.'),
      ],
      durationSeconds: 300,
    });

    const question = suggestions.find((item) => item.reason === 'question');
    assert.ok(question, 'expected a question suggestion');
    assert.match(question.label, /^Question: "So how does the pricing/);
    assert.equal(question.startSeconds, 42);
    assert.equal(question.endSeconds, 72);
  });

  it('suggests highlight-phrase moments and quotes the caption text', () => {
    const suggestions = buildClipSuggestions({
      captionSegments: [
        captionAt(0, 'Welcome back to the stream.'),
        captionAt(90, 'This next part is the key takeaway from the whole session.'),
      ],
      durationSeconds: 240,
    });

    const highlight = suggestions.find((item) => item.reason === 'highlight-phrase');
    assert.ok(highlight, 'expected a highlight suggestion');
    assert.match(highlight.label, /^Highlight: "This next part is the key takeaway/);
    assert.equal(highlight.startSeconds, 87);
  });

  it('ignores interim captions and captions with invalid timestamps', () => {
    const suggestions = buildClipSuggestions({
      captionSegments: [
        captionAt(10, 'is this an amazing question?', { interim: true }),
        { speakerName: 'Host', text: 'What an amazing announcement today?', timestamp: 'not-a-date' },
      ],
      durationSeconds: 120,
    });

    assert.deepEqual(suggestions, []);
  });

  it('finds the densest speech burst when captions carry no keywords', () => {
    const suggestions = buildClipSuggestions({
      captionSegments: [
        captionAt(0, 'Hello.'),
        captionAt(60, 'We shipped the new layout engine this week and it changes everything about scenes.'),
        captionAt(65, 'Every overlay now snaps to the grid and the compositor keeps sixty frames a second.'),
        captionAt(70, 'It also means recordings pick up the exact program mix without extra work.'),
        captionAt(140, 'Bye.'),
      ],
      durationSeconds: 200,
    });

    assert.equal(suggestions.length, 1);
    assert.equal(suggestions[0].reason, 'speech-burst');
    assert.equal(suggestions[0].label, 'Most active moment');
    assert.equal(suggestions[0].startSeconds, 58);
    assert.equal(suggestions[0].endSeconds, 88);
  });

  it('deduplicates overlapping suggestions preferring higher scores', () => {
    const suggestions = buildClipSuggestions({
      markers: [{ label: 'Q&A start', seconds: 50 }],
      captionSegments: [
        captionAt(0, 'Intro chatter to set the caption origin.'),
        captionAt(50, 'How do you handle multiple destinations at once?'),
      ],
      durationSeconds: 300,
    });

    const overlappingQuestion = suggestions.filter((item) => item.startSeconds < 75 && item.endSeconds > 45);
    assert.equal(overlappingQuestion.length, 1);
    assert.equal(overlappingQuestion[0].reason, 'marker');
  });

  it('caps the list at six suggestions sorted by start time', () => {
    const suggestions = buildClipSuggestions({
      markers: Array.from({ length: 10 }, (_, index) => ({
        label: `Marker ${index + 1}`,
        seconds: index * 60,
      })),
      durationSeconds: 900,
    });

    assert.equal(suggestions.length, 6);
    for (let index = 1; index < suggestions.length; index += 1) {
      assert.ok(suggestions[index].startSeconds > suggestions[index - 1].startSeconds);
    }
  });

  it('truncates long marker labels and quotes', () => {
    const longLabel = 'A very long marker label that keeps going well past the limit for chips';
    const suggestions = buildClipSuggestions({
      markers: [{ label: longLabel, seconds: 30 }],
      durationSeconds: 120,
    });

    assert.equal(suggestions.length, 1);
    assert.ok(suggestions[0].label.length <= 'Marker: '.length + 44);
    assert.match(suggestions[0].label, /\.\.\.$/);
  });
});
