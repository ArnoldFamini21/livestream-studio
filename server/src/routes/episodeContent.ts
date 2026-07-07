import { Router } from 'express';
import {
  createOpenAIEpisodeContent,
  validateEpisodeContentRequest,
} from '../services/episodeContent.js';

export const episodeContentRouter = Router();

episodeContentRouter.post('/', async (req, res) => {
  const validationError = validateEpisodeContentRequest(req.body);
  if (validationError) {
    res.status(400).json({ error: validationError });
    return;
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    res.status(503).json({ error: 'AI episode content is not configured on this server.' });
    return;
  }

  const { transcript, durationSeconds } = req.body as {
    transcript: string;
    durationSeconds?: number | null;
  };

  try {
    const result = await createOpenAIEpisodeContent({
      apiKey,
      transcript,
      durationSeconds,
      model: process.env.OPENAI_EPISODE_CONTENT_MODEL,
    });
    res.json(result);
  } catch (err) {
    console.error(err instanceof Error ? err.message : 'OpenAI episode content failed');
    res.status(502).json({ error: 'Episode content generation failed. Please try again.' });
  }
});
