import { Router } from 'express';
import {
  createOpenAIHighlightSuggestions,
  validateHighlightSuggestionRequest,
  type HighlightCaptionSegment,
} from '../services/highlightSuggestions.js';

export const highlightRouter = Router();

highlightRouter.post('/', async (req, res) => {
  const validationError = validateHighlightSuggestionRequest(req.body);
  if (validationError) {
    res.status(400).json({ error: validationError });
    return;
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    res.status(503).json({ error: 'AI highlight suggestions are not configured on this server.' });
    return;
  }

  const { segments, durationSeconds } = req.body as {
    segments: HighlightCaptionSegment[];
    durationSeconds?: number | null;
  };

  try {
    const result = await createOpenAIHighlightSuggestions({
      apiKey,
      segments,
      durationSeconds,
      model: process.env.OPENAI_HIGHLIGHT_MODEL,
    });
    res.json(result);
  } catch (err) {
    console.error(err instanceof Error ? err.message : 'OpenAI highlight suggestions failed');
    res.status(502).json({ error: 'Highlight suggestions failed. Please try again.' });
  }
});
