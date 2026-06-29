import { Router } from 'express';
import {
  createOpenAITranscription,
  normalizeTranscriptionLanguage,
  resolveTranscriptionMimeType,
  sanitizeTranscriptionFileName,
  validateTranscriptionUpload,
} from '../services/transcription.js';

export const transcriptionRouter = Router();

function getHeaderValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function getRequestBuffer(body: unknown): Buffer | null {
  return Buffer.isBuffer(body) ? body : null;
}

transcriptionRouter.post('/', async (req, res) => {
  const audioBuffer = getRequestBuffer(req.body);
  const fileName = sanitizeTranscriptionFileName(getHeaderValue(req.headers['x-file-name']));
  const mimeType = resolveTranscriptionMimeType(getHeaderValue(req.headers['content-type']), fileName);
  const validationError = validateTranscriptionUpload({
    byteLength: audioBuffer?.byteLength || 0,
    mimeType,
    fileName,
  });

  if (!audioBuffer || validationError) {
    res.status(400).json({ error: validationError || 'Upload an audio track before generating a transcript.' });
    return;
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    res.status(503).json({ error: 'Transcription is not configured on this server.' });
    return;
  }

  try {
    const result = await createOpenAITranscription({
      apiKey,
      buffer: audioBuffer,
      mimeType,
      fileName,
      language: normalizeTranscriptionLanguage(getHeaderValue(req.headers['x-transcription-language'])),
      model: process.env.OPENAI_TRANSCRIPTION_MODEL,
    });
    res.json(result);
  } catch (err) {
    console.error(err instanceof Error ? err.message : 'OpenAI transcription failed');
    res.status(502).json({ error: 'Transcript generation failed. Please try again.' });
  }
});
