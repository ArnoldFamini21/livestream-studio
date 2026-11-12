import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isQuestion } from '../src/utils/questionDetection.ts';

describe('isQuestion', () => {
  it('detects a trailing question mark, even with emoji or quotes after it', () => {
    for (const text of ['Is this live?', 'sermon starts at 10?', 'ok?? ', 'Really? 🙏', 'He said "why?"', 'Amen... what time?  ']) {
      assert.equal(isQuestion(text), true, text);
    }
  });

  it('detects English question words and auxiliaries without a question mark', () => {
    for (const text of [
      'who is speaking today', 'What time does it start', 'when is the next service', 'Where can I find the notes',
      'why is the audio low', 'how do I give online', 'Can you hear us', 'could you repeat that', 'do you have a link',
      'Does anyone have the verse', 'did he say Romans 8', 'is the video loading for you', 'Are we live', 'will there be a replay',
      'would you pray for my mother', 'should we stand', "what's the verse", 'which bible version',
    ]) {
      assert.equal(isQuestion(text), true, text);
    }
  });

  it('detects basic Tagalog and Taglish', () => {
    for (const text of [
      'Ano po ang title ng message', 'sino ang speaker', 'Saan ang simbahan', 'kailan ang next service', 'Bakit walang sound',
      'paano mag-give online', 'pwede po bang magrequest', 'puwede ba mag-share', 'alin dito ang tama', 'ilan na ang nanonood',
      'kanino ito galing', 'magkano ang registration',
    ]) {
      assert.equal(isQuestion(text), true, text);
    }
  });

  it('detects the particle "ba" within the first four words only', () => {
    assert.equal(isQuestion('Live ba ito'), true);
    assert.equal(isQuestion('Meron ba kayong replay'), true);
    assert.equal(isQuestion('Salamat po sa inyo ba'), false, 'fifth word');
  });

  it('does not flag statements, praise or exclamations', () => {
    for (const text of [
      'Amen!', 'God bless you all', 'What a blessing!', 'What a beautiful song', 'How great is our God', 'How beautiful',
      'Will be there', 'Do not forget to subscribe', 'Do it for the Lord', "Can't wait for Sunday", 'Isaiah 53 is powerful',
      'When I was young I prayed', 'what I know is Jesus saves', 'Where I come from we sing', 'Ano ba!', 'Who knew!',
      'Thank you pastor', 'Dowload the app', 'Island hopping', 'Whatever happens, God is good.', '?', '??', '🙏', '',
      'Is', 'what', 'https://example.com/watch?', 'Babalik ako bukas', 'Ba-ba black sheep',
    ]) {
      assert.equal(isQuestion(text), false, text);
    }
  });

  it('ignores non-string input', () => {
    assert.equal(isQuestion(undefined as unknown as string), false);
    assert.equal(isQuestion(42 as unknown as string), false);
  });
});
