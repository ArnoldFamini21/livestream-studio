import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type {
  RecordingExportArtifactFormat,
  RecordingExportArtifactStatus,
  RecordingExportJobResponse,
  RecordingExportJobStatusValue,
  RecordingExportSessionRequest,
} from '@studio/shared';
import {
  createRecordingExportCommands,
  sanitizeExportBasename,
  type RecordingExportCommand,
  type RecordingExportTrack,
} from './recordingExport.js';
import type { RecordingUploadExportSource, RecordingUploadExportTrack } from './recordingUpload.js';

export type RecordingExportRunner = (command: RecordingExportCommand) => Promise<void>;

interface RecordingExportArtifact extends RecordingExportArtifactStatus {
  outputPath: string;
  command: RecordingExportCommand;
}

interface RecordingExportJob {
  exportId: string;
  uploadId: string;
  roomId: string;
  sessionId?: string;
  outputDirectory: string;
  status: RecordingExportJobStatusValue;
  createdAt: string;
  updatedAt: string;
  artifacts: RecordingExportArtifact[];
  error?: string;
}

export class RecordingExportJobError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'RecordingExportJobError';
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error && err.message ? err.message : 'Recording export failed';
}

function toPublicJob(job: RecordingExportJob): RecordingExportJobResponse {
  return {
    exportId: job.exportId,
    uploadId: job.uploadId,
    roomId: job.roomId,
    sessionId: job.sessionId,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    artifacts: job.artifacts.map((artifact) => ({
      id: artifact.id,
      label: artifact.label,
      format: artifact.format,
      status: artifact.status,
      bytes: artifact.bytes,
      error: artifact.error,
    })),
    error: job.error,
  };
}

function getArtifactFormat(outputPath: string): RecordingExportArtifactFormat {
  const extension = path.extname(outputPath).toLowerCase();
  if (extension === '.wav') return 'wav';
  if (extension === '.mp3') return 'mp3';
  return 'mp4';
}

function hasTrackAudio(track: RecordingUploadExportTrack): boolean {
  if (track.mimeType.startsWith('audio/')) return true;
  return track.kind === 'program' || track.kind === 'iso';
}

function hasTrackVideo(track: RecordingUploadExportTrack): boolean {
  if (track.mimeType.startsWith('audio/')) return false;
  return track.kind === 'program' || track.kind === 'iso' || track.kind === 'video' || track.kind === 'screen';
}

function toExportTrack(track: RecordingUploadExportTrack): RecordingExportTrack {
  return {
    id: track.id,
    label: track.label,
    kind: track.kind,
    path: track.filePath,
    mimeType: track.mimeType,
    hasAudio: hasTrackAudio(track),
    hasVideo: hasTrackVideo(track),
  };
}

function validateExportSource(source: RecordingUploadExportSource) {
  if (source.tracks.length === 0) {
    throw new RecordingExportJobError(400, 'RECORDING_EXPORT_NO_TRACKS', 'At least one uploaded recording track is required');
  }
  for (const track of source.tracks) {
    if (!track.complete) {
      throw new RecordingExportJobError(409, 'RECORDING_EXPORT_UPLOAD_INCOMPLETE', `${track.label} is not fully uploaded`);
    }
    if (track.bytesReceived <= 0) {
      throw new RecordingExportJobError(409, 'RECORDING_EXPORT_TRACK_EMPTY', `${track.label} has no uploaded media`);
    }
  }
}

function buildArtifacts(commands: RecordingExportCommand[], includeAudioStems: boolean): RecordingExportArtifact[] {
  const selected = includeAudioStems
    ? commands
    : commands.filter((command) => getArtifactFormat(command.outputPath) === 'mp4');
  return selected.map((command, index) => {
    const format = getArtifactFormat(command.outputPath);
    return {
      id: format === 'mp4' ? 'final-mp4' : `stem-${index}-${format}`,
      label: command.label,
      format,
      status: 'queued',
      outputPath: command.outputPath,
      command,
    };
  });
}

export function createFfmpegExportRunner(ffmpegPath: string): RecordingExportRunner {
  return (command) => new Promise<void>((resolve, reject) => {
    const child = spawn(ffmpegPath, command.args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString('utf8')}`.slice(-4000);
    });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      if (stderr.trim()) console.warn(`recording export ${command.label}: ${stderr.trim()}`);
      reject(new Error(signal ? `FFmpeg exited from ${signal}` : `FFmpeg exited with code ${code ?? 'unknown'}`));
    });
  });
}

export class RecordingExportJobStore {
  private readonly jobs = new Map<string, RecordingExportJob>();

  constructor(private readonly runner: RecordingExportRunner) {}

  async createJob(
    source: RecordingUploadExportSource,
    request: RecordingExportSessionRequest = {},
    nowMs = Date.now()
  ): Promise<RecordingExportJobResponse> {
    validateExportSource(source);
    const exportId = randomUUID();
    const basename = sanitizeExportBasename(request.basename || source.sessionId || source.uploadId);
    const outputDirectory = path.join(source.rootDir, 'exports', exportId);
    await mkdir(outputDirectory, { recursive: true });

    const commands = createRecordingExportCommands({
      tracks: source.tracks.map(toExportTrack),
      outputDirectory,
      basename,
      video: request.video,
      audio: request.audio,
    });
    const artifacts = buildArtifacts([commands.mp4, ...commands.stems], request.includeAudioStems !== false);
    const createdAt = new Date(nowMs).toISOString();
    const job: RecordingExportJob = {
      exportId,
      uploadId: source.uploadId,
      roomId: source.roomId,
      sessionId: source.sessionId,
      outputDirectory,
      status: 'queued',
      createdAt,
      updatedAt: createdAt,
      artifacts,
    };
    this.jobs.set(exportId, job);
    return toPublicJob(job);
  }

  getJob(exportId: string, uploadId?: string): RecordingExportJobResponse {
    const job = this.jobs.get(exportId);
    if (!job || (uploadId && job.uploadId !== uploadId)) {
      throw new RecordingExportJobError(404, 'RECORDING_EXPORT_NOT_FOUND', 'Recording export job not found');
    }
    return toPublicJob(job);
  }

  getArtifact(exportId: string, artifactId: string, uploadId?: string): { path: string; format: RecordingExportArtifactFormat; label: string } {
    const job = this.jobs.get(exportId);
    if (!job || (uploadId && job.uploadId !== uploadId)) {
      throw new RecordingExportJobError(404, 'RECORDING_EXPORT_NOT_FOUND', 'Recording export job not found');
    }
    const artifact = job.artifacts.find((item) => item.id === artifactId);
    if (!artifact) {
      throw new RecordingExportJobError(404, 'RECORDING_EXPORT_ARTIFACT_NOT_FOUND', 'Recording export artifact not found');
    }
    if (artifact.status !== 'ready') {
      throw new RecordingExportJobError(409, 'RECORDING_EXPORT_NOT_READY', 'Recording export artifact is not ready');
    }
    return { path: artifact.outputPath, format: artifact.format, label: artifact.label };
  }

  async startJob(exportId: string): Promise<void> {
    const job = this.jobs.get(exportId);
    if (!job || job.status !== 'queued') return;
    job.status = 'running';
    job.updatedAt = new Date().toISOString();

    for (const artifact of job.artifacts) {
      artifact.status = 'running';
      artifact.error = undefined;
      job.updatedAt = new Date().toISOString();
      try {
        await this.runner(artifact.command);
        const outputStat = await stat(artifact.outputPath).catch(() => null);
        if (outputStat) artifact.bytes = outputStat.size;
        artifact.status = 'ready';
        job.updatedAt = new Date().toISOString();
      } catch (err) {
        artifact.status = 'error';
        artifact.error = errorMessage(err);
        job.status = 'error';
        job.error = artifact.error;
        job.updatedAt = new Date().toISOString();
        for (const pending of job.artifacts) {
          if (pending.status === 'queued') {
            pending.status = 'error';
            pending.error = 'Skipped because an earlier export artifact failed';
          }
        }
        return;
      }
    }

    job.status = 'ready';
    job.updatedAt = new Date().toISOString();
  }
}
