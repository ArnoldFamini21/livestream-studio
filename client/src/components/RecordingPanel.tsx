import { useState, useCallback } from 'react';
import type { RecordingResult } from '../hooks/useLocalRecording';
import { useGoogleDriveUpload } from '../hooks/useGoogleDriveUpload';

interface RecordingPanelProps {
  isRecording: boolean;
  formattedTime: string;
  onStartRecording: () => void;
  onStopRecording: () => Promise<RecordingResult>;
  roomName: string;
  onClose: () => void;
}

interface RecordedFile {
  label: string;
  blob: Blob;
  fileName: string;
}

function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  // Delay revocation to allow download to initiate
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

export function RecordingPanel({
  isRecording,
  formattedTime,
  onStartRecording,
  onStopRecording,
  roomName,
  onClose,
}: RecordingPanelProps) {
  const [recordedFiles, setRecordedFiles] = useState<RecordedFile[]>([]);
  const [isStopping, setIsStopping] = useState(false);

  const {
    authorize,
    uploadFile,
    createFolder,
    uploadProgress,
    isUploading,
    isAuthorized,
  } = useGoogleDriveUpload();

  const handleStop = useCallback(async () => {
    setIsStopping(true);
    try {
      const result = await onStopRecording();
      const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
      const prefix = roomName.replace(/\s+/g, '_');
      const files: RecordedFile[] = [];

      if (result.audio.size > 0) {
        files.push({
          label: 'Audio',
          blob: result.audio,
          fileName: `${prefix}_audio_${timestamp}.webm`,
        });
      }
      if (result.video.size > 0) {
        files.push({
          label: 'Video',
          blob: result.video,
          fileName: `${prefix}_video_${timestamp}.webm`,
        });
      }
      if (result.screen && result.screen.size > 0) {
        files.push({
          label: 'Screen',
          blob: result.screen,
          fileName: `${prefix}_screen_${timestamp}.webm`,
        });
      }

      setRecordedFiles(files);
    } catch (err) {
      console.error('Error stopping recording:', err);
    } finally {
      setIsStopping(false);
    }
  }, [onStopRecording, roomName]);

  const handleDownloadAll = useCallback(async () => {
    for (let i = 0; i < recordedFiles.length; i++) {
      downloadBlob(recordedFiles[i].blob, recordedFiles[i].fileName);
      if (i < recordedFiles.length - 1) {
        await new Promise(r => setTimeout(r, 500));
      }
    }
  }, [recordedFiles]);

  const handleDownloadSingle = useCallback((file: RecordedFile) => {
    downloadBlob(file.blob, file.fileName);
  }, []);

  const handleUploadToDrive = useCallback(async () => {
    let authorized = isAuthorized;
    if (!authorized) {
      authorized = await authorize();
      if (!authorized) {
        console.error('Google Drive authorization failed');
        return;
      }
    }

    // Create a folder for this recording session
    const date = new Date().toISOString().slice(0, 10);
    const folderName = `${roomName} - ${date}`;
    const folderId = await createFolder(folderName);

    if (!folderId) {
      console.error('Failed to create Google Drive folder');
      return;
    }

    // Upload all files into the folder
    const uploadPromises = recordedFiles.map((file) =>
      uploadFile(file.blob, file.fileName, folderId)
    );

    await Promise.all(uploadPromises);
    console.log('All files uploaded to Google Drive');
  }, [isAuthorized, authorize, createFolder, uploadFile, recordedFiles, roomName]);

  const handleNewRecording = useCallback(() => {
    setRecordedFiles([]);
  }, []);

  return (
    <div style={styles.panel}>
      {/* Header */}
      <div style={styles.header}>
        <div>
          <h3 style={styles.title}>Local Recording</h3>
          <p style={styles.subtitle}>Multi-track recording</p>
        </div>
        <button className="panel-close-btn" style={styles.closeBtn} onClick={onClose}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      <div style={styles.body}>
        {/* Recording Status */}
        {isRecording && (
          <div style={styles.statusCard}>
            <div style={styles.statusHeader}>
              <span style={styles.recordingDot} />
              <span style={styles.statusLabel}>Recording</span>
            </div>
            <div style={styles.timer}>{formattedTime}</div>
            <div style={styles.trackIndicators}>
              <span style={styles.trackBadge}>Audio</span>
              <span style={styles.trackBadge}>Video</span>
              <span style={styles.trackBadge}>Screen</span>
            </div>
            <button
              className="hover-scale"
              style={styles.stopBtn}
              onClick={handleStop}
              disabled={isStopping}
            >
              {isStopping ? 'Stopping...' : 'Stop Recording'}
            </button>
          </div>
        )}

        {/* Idle State - No recordings, not recording */}
        {!isRecording && recordedFiles.length === 0 && (
          <div style={styles.idleCard}>
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <circle cx="12" cy="12" r="4" fill="var(--text-muted)" />
            </svg>
            <p style={styles.idleText}>Record separate audio, video, and screen tracks locally for maximum quality.</p>
            <button
              className="hover-scale"
              style={styles.startBtn}
              onClick={onStartRecording}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <circle cx="12" cy="12" r="4" fill="currentColor" />
              </svg>
              Start Recording
            </button>
          </div>
        )}

        {/* Recorded Files */}
        {!isRecording && recordedFiles.length > 0 && (
          <>
            <div style={styles.filesHeader}>
              <span style={styles.filesTitle}>Recorded Files</span>
              <span style={styles.filesCount}>{recordedFiles.length} track{recordedFiles.length !== 1 ? 's' : ''}</span>
            </div>

            {recordedFiles.map((file) => {
              const progress = uploadProgress[file.fileName];
              const isFileUploading = progress !== undefined && progress >= 0 && progress < 100;
              const isFileUploaded = progress === 100;
              const isFileError = progress === -1;

              return (
                <div key={file.fileName} className="participant-item" style={styles.fileCard}>
                  <div style={styles.fileHeader}>
                    <div style={styles.fileInfo}>
                      <span style={styles.fileLabel}>{file.label}</span>
                      <span style={styles.fileSize}>{formatFileSize(file.blob.size)}</span>
                    </div>
                    <button
                      className="participant-action-btn"
                      style={styles.downloadBtn}
                      onClick={() => handleDownloadSingle(file)}
                      title={`Download ${file.label}`}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
                        <polyline points="7 10 12 15 17 10" />
                        <line x1="12" y1="15" x2="12" y2="3" />
                      </svg>
                    </button>
                  </div>
                  <div style={styles.fileName}>{file.fileName}</div>

                  {/* Upload progress bar */}
                  {isFileUploading && (
                    <div style={styles.progressContainer}>
                      <div style={styles.progressTrack}>
                        <div
                          style={{
                            ...styles.progressBar,
                            width: `${progress}%`,
                          }}
                        />
                      </div>
                      <span style={styles.progressText}>{progress}%</span>
                    </div>
                  )}
                  {isFileUploaded && (
                    <div style={styles.uploadedBadge}>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                      Uploaded
                    </div>
                  )}
                  {isFileError && (
                    <div style={styles.errorBadge}>Upload failed</div>
                  )}
                </div>
              );
            })}

            {/* Action buttons */}
            <div style={styles.actions}>
              <button
                className="hover-lift"
                style={styles.downloadAllBtn}
                onClick={handleDownloadAll}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
                  <polyline points="7 10 12 15 17 10" />
                  <line x1="12" y1="15" x2="12" y2="3" />
                </svg>
                Download All
              </button>

              <button
                className="hover-lift"
                style={{
                  ...styles.driveBtn,
                  opacity: isUploading ? 0.6 : 1,
                }}
                onClick={handleUploadToDrive}
                disabled={isUploading}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M18 15v3a2 2 0 01-2 2H5a2 2 0 01-2-2v-3" />
                  <polyline points="17 8 12 3 7 8" />
                  <line x1="12" y1="3" x2="12" y2="15" />
                </svg>
                {isUploading ? 'Uploading...' : 'Upload to Google Drive'}
              </button>
            </div>

            {/* New recording button */}
            <button
              style={styles.newRecordingBtn}
              onClick={handleNewRecording}
            >
              New Recording
            </button>
          </>
        )}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  panel: {
    width: 320,
    display: 'flex',
    flexDirection: 'column',
    background: 'var(--bg-secondary)',
    borderLeft: '1px solid var(--border)',
    height: '100%',
  },
  header: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    padding: '14px 16px 10px',
    borderBottom: '1px solid var(--border)',
  },
  title: {
    fontSize: 14,
    fontWeight: 600,
    margin: 0,
  },
  subtitle: {
    fontSize: 11,
    color: 'var(--text-muted)',
    margin: 0,
    marginTop: 2,
  },
  closeBtn: {
    background: 'none',
    border: 'none',
    color: 'var(--text-muted)',
    cursor: 'pointer',
    padding: 4,
    borderRadius: 6,
    display: 'flex',
  },
  body: {
    flex: 1,
    overflowY: 'auto',
    padding: 12,
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },

  // Recording Status
  statusCard: {
    background: 'var(--bg-tertiary)',
    borderRadius: 10,
    padding: 16,
    border: '1px solid rgba(239, 68, 68, 0.3)',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 12,
  },
  statusHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  recordingDot: {
    width: 10,
    height: 10,
    borderRadius: '50%',
    background: '#ef4444',
    animation: 'livePulse 1.5s infinite',
  },
  statusLabel: {
    fontSize: 13,
    fontWeight: 600,
    color: '#ef4444',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
  },
  timer: {
    fontSize: 32,
    fontWeight: 700,
    fontFamily: 'monospace',
    color: 'var(--text-primary)',
    letterSpacing: '0.02em',
  },
  trackIndicators: {
    display: 'flex',
    gap: 6,
  },
  trackBadge: {
    fontSize: 10,
    fontWeight: 600,
    padding: '2px 8px',
    borderRadius: 4,
    background: 'rgba(99, 102, 241, 0.15)',
    color: '#818cf8',
  },
  stopBtn: {
    width: '100%',
    padding: '10px 16px',
    fontSize: 13,
    fontWeight: 600,
    borderRadius: 8,
    border: 'none',
    background: '#ef4444',
    color: 'white',
    cursor: 'pointer',
    marginTop: 4,
  },

  // Idle State
  idleCard: {
    background: 'var(--bg-tertiary)',
    borderRadius: 10,
    padding: 24,
    border: '1px solid var(--border)',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 12,
    textAlign: 'center' as const,
  },
  idleText: {
    fontSize: 12,
    color: 'var(--text-muted)',
    lineHeight: 1.5,
    margin: 0,
  },
  startBtn: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    width: '100%',
    padding: '10px 16px',
    fontSize: 13,
    fontWeight: 600,
    borderRadius: 8,
    border: 'none',
    background: '#ef4444',
    color: 'white',
    cursor: 'pointer',
  },

  // Recorded Files
  filesHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  filesTitle: {
    fontSize: 13,
    fontWeight: 600,
    color: 'var(--text-primary)',
  },
  filesCount: {
    fontSize: 11,
    color: 'var(--text-muted)',
  },
  fileCard: {
    background: 'var(--bg-tertiary)',
    borderRadius: 10,
    padding: '10px 12px',
    border: '1px solid var(--border)',
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  },
  fileHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  fileInfo: {
    display: 'flex',
    alignItems: 'baseline',
    gap: 8,
  },
  fileLabel: {
    fontSize: 13,
    fontWeight: 600,
    color: 'var(--text-primary)',
  },
  fileSize: {
    fontSize: 11,
    color: 'var(--text-muted)',
  },
  fileName: {
    fontSize: 10,
    color: 'var(--text-muted)',
    fontFamily: 'monospace',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  },
  downloadBtn: {
    width: 28,
    height: 28,
    borderRadius: 6,
    background: 'var(--bg-surface)',
    border: '1px solid var(--border)',
    color: 'var(--text-secondary)',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 0,
  },

  // Progress
  progressContainer: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    marginTop: 4,
  },
  progressTrack: {
    flex: 1,
    height: 4,
    borderRadius: 2,
    background: 'var(--bg-surface)',
    overflow: 'hidden',
  },
  progressBar: {
    height: '100%',
    borderRadius: 2,
    background: '#6366f1',
    transition: 'width 0.3s ease',
  },
  progressText: {
    fontSize: 10,
    fontWeight: 600,
    color: '#6366f1',
    minWidth: 30,
    textAlign: 'right' as const,
  },
  uploadedBadge: {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    fontSize: 10,
    fontWeight: 600,
    color: '#22c55e',
    marginTop: 2,
  },
  errorBadge: {
    fontSize: 10,
    fontWeight: 600,
    color: '#ef4444',
    marginTop: 2,
  },

  // Actions
  actions: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    marginTop: 4,
  },
  downloadAllBtn: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    width: '100%',
    padding: '10px 16px',
    fontSize: 13,
    fontWeight: 600,
    borderRadius: 8,
    border: '1px solid var(--border)',
    background: 'var(--bg-tertiary)',
    color: 'var(--text-primary)',
    cursor: 'pointer',
  },
  driveBtn: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    width: '100%',
    padding: '10px 16px',
    fontSize: 13,
    fontWeight: 600,
    borderRadius: 8,
    border: 'none',
    background: '#4285f4',
    color: 'white',
    cursor: 'pointer',
    transition: 'opacity 0.2s ease',
  },
  newRecordingBtn: {
    width: '100%',
    padding: '8px 16px',
    fontSize: 12,
    fontWeight: 500,
    borderRadius: 8,
    border: 'none',
    background: 'transparent',
    color: 'var(--text-muted)',
    cursor: 'pointer',
    marginTop: 4,
    textDecoration: 'underline',
  },
};
