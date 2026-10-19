import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runAtBackgroundPriority } from './processPriority.js';
import type {
  RecordingExportArtifactFormat,
  RecordingExportArtifactStorage,
  RecordingExportArtifactStatus,
  RecordingExportJobResponse,
  RecordingExportJobStatusValue,
  RecordingExportSessionRequest,
} from '@studio/shared';
import {
  createRecordingExportCommands,
  createRecordingAudioStemArgs,
  validateRecordingExportTracks,
  getRecordingExportClipIssue,
  getRecordingExportEditIssue,
  normalizeRecordingExportClipRange,
  sanitizeExportBasename,
  type RecordingExportClipRange,
  type RecordingExportEdit,
  type RecordingExportCommand,
  type RecordingExportTrack,
} from './recordingExport.js';
import type { RecordingUploadExportSource, RecordingUploadExportTrack } from './recordingUpload.js';

export type RecordingExportRunner = (command: RecordingExportCommand) => Promise<void>;

export interface RecordingExportArtifactUploadInput {
  exportId: string;
  uploadId: string;
  roomId: string;
  sessionId?: string;
  artifactId: string;
  label: string;
  format: RecordingExportArtifactFormat;
  filePath: string;
  contentType: string;
}

export type RecordingExportArtifactUploader = (
  input: RecordingExportArtifactUploadInput
) => Promise<RecordingExportArtifactStorage>;

interface RecordingExportArtifact extends RecordingExportArtifactStatus {
  outputPath: string;
  command?: RecordingExportCommand;
  generated?: 'manifest';
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
  clip?: RecordingExportClipRange | null;
  edit?: { keptRanges: number; keptSeconds: number } | null;
  normalizeAudio?: boolean;
  tracks: RecordingExportManifestTrack[];
  artifacts: RecordingExportArtifact[];
  error?: string;
}

interface RecordingExportManifestTrack {
  id: string;
  label: string;
  kind: RecordingUploadExportTrack['kind'];
  mimeType: string;
  expectedBytes?: number;
  durationMs?: number;
  bytesReceived: number;
  complete: boolean;
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
      storage: artifact.storage,
      error: artifact.error,
    })),
    error: job.error,
  };
}

function getArtifactFormat(outputPath: string): RecordingExportArtifactFormat {
  const extension = path.extname(outputPath).toLowerCase();
  if (extension === '.wav') return 'wav';
  if (extension === '.mp3') return 'mp3';
  if (extension === '.json') return 'json';
  return 'mp4';
}

function getArtifactContentType(format: RecordingExportArtifactFormat): string {
  if (format === 'wav') return 'audio/wav';
  if (format === 'mp3') return 'audio/mpeg';
  if (format === 'json') return 'application/json';
  return 'video/mp4';
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
  const artifacts: RecordingExportArtifact[] = selected.map((command, index): RecordingExportArtifact => {
    const format = getArtifactFormat(command.outputPath);
    return {
      id: command.artifactId || (format === 'mp4' ? 'final-mp4' : `stem-${index}-${format}`),
      label: command.label,
      format,
      status: 'queued',
      outputPath: command.outputPath,
      command,
    };
  });
  const outputDirectory = selected[0]?.outputPath ? path.dirname(selected[0].outputPath) : '';
  const basename = selected[0]?.outputPath ? path.basename(selected[0].outputPath, path.extname(selected[0].outputPath)) : 'recording-export';
  if (outputDirectory) {
    artifacts.push({
      id: 'export-manifest',
      label: 'Export manifest',
      format: 'json',
      status: 'queued',
      outputPath: path.join(outputDirectory, `${basename}_manifest.json`),
      generated: 'manifest',
    });
  }
  return artifacts;
}

function toManifestTrack(track: RecordingUploadExportTrack): RecordingExportManifestTrack {
  return {
    id: track.id,
    label: track.label,
    kind: track.kind,
    mimeType: track.mimeType,
    expectedBytes: track.expectedBytes,
    durationMs: track.durationMs,
    bytesReceived: track.bytesReceived,
    complete: track.complete,
  };
}

function buildExportManifest(job: RecordingExportJob): string {
  return `${JSON.stringify({
    app: 'livestream-studio',
    exportType: 'recording-export-manifest',
    version: 1,
    generatedAt: new Date().toISOString(),
    export: {
      exportId: job.exportId,
      uploadId: job.uploadId,
      roomId: job.roomId,
      sessionId: job.sessionId,
      status: 'ready',
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      clip: job.clip ?? null,
      edit: job.edit ?? null,
      normalizeAudio: job.normalizeAudio === true,
    },
    tracks: job.tracks,
    artifacts: job.artifacts
      .filter((artifact) => artifact.id !== 'export-manifest')
      .map((artifact) => ({
        id: artifact.id,
        label: artifact.label,
        format: artifact.format,
        status: artifact.status,
        bytes: artifact.bytes,
        storage: artifact.storage,
        error: artifact.error,
      })),
  }, null, 2)}\n`;
}

export function createFfmpegExportRunner(ffmpegPath: string): RecordingExportRunner {
  return (command) => new Promise<void>((resolve, reject) => {
    const child = spawn(ffmpegPath, command.args, { stdio: ['ignore', 'ignore', 'pipe'] });
    // Exports yield the CPU to live encoding (see processPriority.ts).
    runAtBackgroundPriority(child.pid);
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

const JOB_STATE_FILE_NAME = 'job-state.json';
const EXPORT_ID_PATTERN = /^[A-Za-z0-9_-]{1,120}$/;

function defaultExportUploadRoot(): string {
  return process.env.RECORDING_UPLOAD_DIR || path.join(os.tmpdir(), 'livestream-studio-recordings');
}

export class RecordingExportJobStore {
  private readonly jobs = new Map<string, RecordingExportJob>();
  private readonly knownUploadRoots = new Set<string>();

  constructor(
    private readonly runner: RecordingExportRunner,
    private readonly artifactUploader?: RecordingExportArtifactUploader,
    uploadRoot = defaultExportUploadRoot()
  ) {
    if (uploadRoot) this.knownUploadRoots.add(uploadRoot);
  }

  private async persistJob(job: RecordingExportJob): Promise<void> {
    await writeFile(path.join(job.outputDirectory, JOB_STATE_FILE_NAME), `${JSON.stringify(job, null, 2)}\n`, 'utf8');
  }

  private persistJobSync(job: RecordingExportJob): void {
    try {
      writeFileSync(path.join(job.outputDirectory, JOB_STATE_FILE_NAME), `${JSON.stringify(job, null, 2)}\n`, 'utf8');
    } catch {
      // Directory may have been removed concurrently.
    }
  }

  private loadJobFromStateFile(stateFile: string, expectedExportId: string): RecordingExportJob | null {
    if (!existsSync(stateFile)) return null;
    try {
      const parsed = JSON.parse(readFileSync(stateFile, 'utf8')) as Partial<RecordingExportJob>;
      if (
        !parsed ||
        parsed.exportId !== expectedExportId ||
        typeof parsed.uploadId !== 'string' ||
        typeof parsed.roomId !== 'string' ||
        typeof parsed.outputDirectory !== 'string' ||
        typeof parsed.status !== 'string' ||
        typeof parsed.createdAt !== 'string' ||
        typeof parsed.updatedAt !== 'string' ||
        !Array.isArray(parsed.tracks) ||
        !Array.isArray(parsed.artifacts)
      ) {
        return null;
      }

      const job: RecordingExportJob = {
        exportId: parsed.exportId,
        uploadId: parsed.uploadId,
        roomId: parsed.roomId,
        sessionId: typeof parsed.sessionId === 'string' ? parsed.sessionId : undefined,
        outputDirectory: parsed.outputDirectory,
        status: parsed.status,
        createdAt: parsed.createdAt,
        updatedAt: parsed.updatedAt,
        clip: parsed.clip ?? null,
        edit: parsed.edit ?? null,
        normalizeAudio: parsed.normalizeAudio === true,
        tracks: parsed.tracks,
        artifacts: parsed.artifacts,
        error: typeof parsed.error === 'string' ? parsed.error : undefined,
      };

      // A job that was actively running when the previous process exited lost its child FFmpeg process.
      if (job.status === 'running') {
        const reason = 'Recording export interrupted by server restart';
        job.status = 'error';
        job.error = reason;
        job.updatedAt = new Date().toISOString();
        for (const artifact of job.artifacts) {
          if (artifact.status === 'running' || artifact.status === 'queued') {
            artifact.status = 'error';
            artifact.error = reason;
          }
        }
        this.persistJobSync(job);
      }

      this.jobs.set(job.exportId, job);
      return job;
    } catch {
      return null;
    }
  }

  private loadJobFromDisk(exportId: string, uploadId?: string): RecordingExportJob | null {
    if (!EXPORT_ID_PATTERN.test(exportId)) return null;
    if (uploadId && !EXPORT_ID_PATTERN.test(uploadId)) return null;

    for (const root of this.knownUploadRoots) {
      if (!existsSync(root)) continue;
      if (uploadId) {
        const stateFile = path.join(root, uploadId, 'exports', exportId, JOB_STATE_FILE_NAME);
        const loaded = this.loadJobFromStateFile(stateFile, exportId);
        if (loaded) return loaded;
        continue;
      }
      try {
        const uploadDirs = readdirSync(root, { withFileTypes: true });
        for (const entry of uploadDirs) {
          if (!entry.isDirectory() || entry.name.startsWith('._')) continue;
          const stateFile = path.join(root, entry.name, 'exports', exportId, JOB_STATE_FILE_NAME);
          const loaded = this.loadJobFromStateFile(stateFile, exportId);
          if (loaded) return loaded;
        }
      } catch {
        // Ignore unreadable roots.
      }
    }
    return null;
  }

  private resolveJob(exportId: string, uploadId?: string): RecordingExportJob {
    const job = this.jobs.get(exportId) ?? this.loadJobFromDisk(exportId, uploadId);
    if (!job || (uploadId && job.uploadId !== uploadId)) {
      throw new RecordingExportJobError(404, 'RECORDING_EXPORT_NOT_FOUND', 'Recording export job not found');
    }
    return job;
  }

  async createJob(
    source: RecordingUploadExportSource,
    request: RecordingExportSessionRequest = {},
    nowMs = Date.now()
  ): Promise<RecordingExportJobResponse> {
    validateExportSource(source);
    const clipIssue = getRecordingExportClipIssue(request.clip ?? null);
    if (clipIssue) {
      throw new RecordingExportJobError(400, 'RECORDING_EXPORT_INVALID_CLIP', clipIssue);
    }
    const clip = normalizeRecordingExportClipRange(request.clip as RecordingExportClipRange | null | undefined);
    const editIssue = getRecordingExportEditIssue(request.edit ?? null)
      || (request.edit && clip ? 'An export can use a clip range or an edit, not both' : null);
    if (editIssue) {
      throw new RecordingExportJobError(400, 'RECORDING_EXPORT_INVALID_EDIT', editIssue);
    }
    const edit = (request.edit as RecordingExportEdit | undefined) || null;
    const exportId = randomUUID();
    const basename = sanitizeExportBasename(request.basename || source.sessionId || source.uploadId);
    const outputDirectory = path.join(source.rootDir, 'exports', exportId);
    this.knownUploadRoots.add(path.dirname(source.rootDir));
    await mkdir(outputDirectory, { recursive: true });

    const normalizeAudio = request.normalizeAudio === true;
    const tracks = source.tracks.map(toExportTrack);
    const audioOnly = tracks.every((track) => track.kind === 'audio');
    let artifactCommands: RecordingExportCommand[];
    try {
      if (audioOnly) {
        const issue = validateRecordingExportTracks(tracks);
        if (issue) throw new Error(issue);
        artifactCommands = tracks.flatMap((track) => (['wav', 'mp3'] as const).map((format) =>
          createRecordingAudioStemArgs(track, outputDirectory, basename, format, request.audio, clip, normalizeAudio, edit, request.video?.frameRate)
        ));
      } else {
        const commands = createRecordingExportCommands({
          tracks,
          outputDirectory,
          basename,
          video: request.video,
          audio: request.audio,
          clip,
          edit,
          normalizeAudio,
        });
        artifactCommands = [commands.mp4, ...commands.isolatedVideos, ...commands.stems];
      }
    } catch (err) {
      throw new RecordingExportJobError(400, edit ? 'RECORDING_EXPORT_INVALID_EDIT' : 'RECORDING_EXPORT_INVALID_TRACKS', errorMessage(err));
    }
    // Audio is the primary deliverable for audio-only sessions, even if the
    // caller disabled optional stems for normal video exports.
    const artifacts = buildArtifacts(artifactCommands, audioOnly || request.includeAudioStems !== false);
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
      clip,
      edit: edit
        ? {
          keptRanges: edit.keepRanges.length,
          keptSeconds: Math.round(edit.keepRanges.reduce((total, range) => total + range.endSeconds - range.startSeconds, 0) * 1000) / 1000,
        }
        : null,
      normalizeAudio,
      tracks: source.tracks.map(toManifestTrack),
      artifacts,
    };
    this.jobs.set(exportId, job);
    await this.persistJob(job);
    return toPublicJob(job);
  }

  getJob(exportId: string, uploadId?: string): RecordingExportJobResponse {
    return toPublicJob(this.resolveJob(exportId, uploadId));
  }

  getArtifact(exportId: string, artifactId: string, uploadId?: string): { path: string; format: RecordingExportArtifactFormat; label: string } {
    const job = this.resolveJob(exportId, uploadId);
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
    const job = this.jobs.get(exportId) ?? this.loadJobFromDisk(exportId);
    if (!job || job.status !== 'queued') return;
    job.status = 'running';
    job.updatedAt = new Date().toISOString();
    await this.persistJob(job);

    for (const artifact of job.artifacts) {
      artifact.status = 'running';
      artifact.error = undefined;
      artifact.storage = undefined;
      job.updatedAt = new Date().toISOString();
      await this.persistJob(job);
      try {
        if (artifact.generated === 'manifest') {
          await writeFile(artifact.outputPath, buildExportManifest(job), 'utf8');
        } else if (artifact.command) {
          if (artifact.command.filterScript) {
            await writeFile(artifact.command.filterScript.path, artifact.command.filterScript.content, 'utf8');
          }
          await this.runner(artifact.command);
        } else {
          throw new Error('Recording export artifact has no command');
        }
        const outputStat = await stat(artifact.outputPath).catch(() => null);
        if (outputStat) artifact.bytes = outputStat.size;
        if (this.artifactUploader) {
          artifact.storage = await this.artifactUploader({
            exportId: job.exportId,
            uploadId: job.uploadId,
            roomId: job.roomId,
            sessionId: job.sessionId,
            artifactId: artifact.id,
            label: artifact.label,
            format: artifact.format,
            filePath: artifact.outputPath,
            contentType: getArtifactContentType(artifact.format),
          });
        }
        artifact.status = 'ready';
        job.updatedAt = new Date().toISOString();
        await this.persistJob(job);
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
        await this.persistJob(job);
        return;
      }
    }

    job.status = 'ready';
    job.updatedAt = new Date().toISOString();
    await this.persistJob(job);
  }
}
