import { Router } from 'express';
import {
  createOpenAICaptionTranslation,
  validateCaptionTranslationRequest,
  type CaptionTranslationSegment,
} from '../services/captionTranslation.js';

export const captionTranslationRouter = Router();

captionTranslationRouter.post('/', async (req, res) => {
  const validationError = validateCaptionTranslationRequest(req.body);
  if (validationError) {
    res.status(400).json({ error: validationError });
    return;
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    res.status(503).json({ error: 'AI caption translation is not configured on this server.' });
    return;
  }

  const { segments, targetLanguage } = req.body as {
    segments: CaptionTranslationSegment[];
    targetLanguage: string;
  };

  try {
    const result = await createOpenAICaptionTranslation({
      apiKey,
      segments,
      targetLanguage,
      model: process.env.OPENAI_CAPTION_TRANSLATION_MODEL,
    });
    res.json(result);
  } catch (err) {
    console.error(err instanceof Error ? err.message : 'OpenAI caption translation failed');
    res.status(502).json({ error: 'Caption translation failed. Please try again.' });
  }
});
