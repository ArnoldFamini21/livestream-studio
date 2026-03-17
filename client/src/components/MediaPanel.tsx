import { useState, useRef, useEffect } from 'react';

type MediaTab = 'videos' | 'images' | 'files';

interface MediaPanelProps {
  onPlayVideo: (url: string) => void;
  onShowImage: (url: string) => void;
  onStopMedia: () => void;
  activeMedia: { type: 'video' | 'image' | 'pdf'; url: string } | null;
  onClose: () => void;
}

interface UploadedFile {
  id: string;
  name: string;
  url: string;
  type: 'video' | 'image' | 'pdf';
}

export function MediaPanel({
  onPlayVideo,
  onShowImage,
  onStopMedia,
  activeMedia,
  onClose,
}: MediaPanelProps) {
  const [activeTab, setActiveTab] = useState<MediaTab>('videos');
  const [videoUrl, setVideoUrl] = useState('');
  const [imageUrl, setImageUrl] = useState('');
  const [uploadedVideos, setUploadedVideos] = useState<UploadedFile[]>([]);
  const [uploadedImages, setUploadedImages] = useState<UploadedFile[]>([]);
  const [uploadedFiles, setUploadedFiles] = useState<UploadedFile[]>([]);
  const [currentSlideIndex, setCurrentSlideIndex] = useState(0);
  const [pdfPage, setPdfPage] = useState(1);

  const videoInputRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Revoke all blob URLs on unmount
  useEffect(() => {
    return () => {
      uploadedVideos.forEach((f) => { if (f.url.startsWith('blob:')) URL.revokeObjectURL(f.url); });
      uploadedImages.forEach((f) => { if (f.url.startsWith('blob:')) URL.revokeObjectURL(f.url); });
      uploadedFiles.forEach((f) => { if (f.url.startsWith('blob:')) URL.revokeObjectURL(f.url); });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleVideoUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const url = URL.createObjectURL(file);
      const id = crypto.randomUUID();
      setUploadedVideos((prev) => [...prev, { id, name: file.name, url, type: 'video' }]);
    }
    e.target.value = '';
  };

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const url = URL.createObjectURL(file);
      const id = crypto.randomUUID();
      setUploadedImages((prev) => [...prev, { id, name: file.name, url, type: 'image' }]);
    }
    e.target.value = '';
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const url = URL.createObjectURL(file);
      const id = crypto.randomUUID();
      const isPdf = file.type === 'application/pdf' || file.name.endsWith('.pdf');
      setUploadedFiles((prev) => [
        ...prev,
        { id, name: file.name, url, type: isPdf ? 'pdf' : 'image' },
      ]);
    }
    e.target.value = '';
  };

  const handleVideoUrlSubmit = () => {
    const trimmed = videoUrl.trim();
    if (!trimmed) return;
    onPlayVideo(trimmed);
    setVideoUrl('');
  };

  const handleImageUrlSubmit = () => {
    const trimmed = imageUrl.trim();
    if (!trimmed) return;
    onShowImage(trimmed);
    setImageUrl('');
  };

  const handleRemoveUploaded = (
    list: UploadedFile[],
    setList: React.Dispatch<React.SetStateAction<UploadedFile[]>>,
    index: number,
  ) => {
    const file = list[index];
    if (file.url.startsWith('blob:')) {
      URL.revokeObjectURL(file.url);
    }
    setList((prev) => prev.filter((_, i) => i !== index));
  };

  const handlePrevSlide = () => {
    setCurrentSlideIndex((prev) => Math.max(0, prev - 1));
  };

  const handleNextSlide = () => {
    setCurrentSlideIndex((prev) => Math.min(uploadedImages.length - 1, prev + 1));
  };

  const tabs: { id: MediaTab; label: string; icon: React.ReactNode }[] = [
    {
      id: 'videos',
      label: 'Videos',
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polygon points="5 3 19 12 5 21 5 3" />
        </svg>
      ),
    },
    {
      id: 'images',
      label: 'Images',
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
          <circle cx="8.5" cy="8.5" r="1.5" />
          <polyline points="21 15 16 10 5 21" />
        </svg>
      ),
    },
    {
      id: 'files',
      label: 'Files',
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
        </svg>
      ),
    },
  ];

  return (
    <div style={styles.panel}>
      {/* Header */}
      <div style={styles.header}>
        <h3 style={styles.title}>Media</h3>
        <button style={styles.closeBtn} onClick={onClose} title="Close media panel">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      {/* Tab bar */}
      <div style={styles.tabBar}>
        {tabs.map((tab) => (
          <button
            key={tab.id}
            style={{
              ...styles.tab,
              ...(activeTab === tab.id ? styles.tabActive : {}),
            }}
            onClick={() => setActiveTab(tab.id)}
            title={tab.label}
          >
            {tab.icon}
            <span style={styles.tabLabel}>{tab.label}</span>
          </button>
        ))}
      </div>

      {/* Active media indicator */}
      {activeMedia && (
        <div style={styles.activeIndicator}>
          <div style={styles.activeInfo}>
            <div style={styles.activeDot} />
            <span style={styles.activeText}>
              {activeMedia.type === 'video' ? 'Video playing' : activeMedia.type === 'pdf' ? 'PDF showing' : 'Image showing'}
            </span>
          </div>
          <button style={styles.stopBtn} onClick={onStopMedia}>
            Stop
          </button>
        </div>
      )}

      {/* Tab content */}
      <div style={styles.content}>
        {/* Videos tab */}
        {activeTab === 'videos' && (
          <div style={styles.section}>
            <h4 style={styles.sectionTitle}>Play a Video</h4>

            {/* URL input */}
            <div style={styles.inputRow}>
              <input
                style={styles.urlInput}
                placeholder="Paste video URL..."
                value={videoUrl}
                onChange={(e) => setVideoUrl(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleVideoUrlSubmit()}
              />
              <button
                style={{
                  ...styles.actionBtn,
                  opacity: videoUrl.trim() ? 1 : 0.4,
                }}
                onClick={handleVideoUrlSubmit}
                disabled={!videoUrl.trim()}
              >
                Play
              </button>
            </div>

            {/* Upload button */}
            <input
              ref={videoInputRef}
              type="file"
              accept="video/*"
              multiple
              style={{ display: 'none' }}
              onChange={handleVideoUpload}
            />
            <button
              style={styles.uploadBtn}
              onClick={() => videoInputRef.current?.click()}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="17 8 12 3 7 8" />
                <line x1="12" y1="3" x2="12" y2="15" />
              </svg>
              Upload Video
            </button>

            {/* Uploaded videos list */}
            {uploadedVideos.length > 0 && (
              <div style={styles.fileList}>
                {uploadedVideos.map((file, index) => (
                  <div key={file.id} style={styles.fileItem}>
                    <div style={styles.fileInfo}>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <polygon points="5 3 19 12 5 21 5 3" />
                      </svg>
                      <span style={styles.fileName}>{file.name}</span>
                    </div>
                    <div style={styles.fileActions}>
                      <button
                        style={styles.fileActionBtn}
                        onClick={() => onPlayVideo(file.url)}
                        title="Play video"
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <polygon points="5 3 19 12 5 21 5 3" />
                        </svg>
                      </button>
                      <button
                        style={styles.fileActionBtn}
                        onClick={() => handleRemoveUploaded(uploadedVideos, setUploadedVideos, index)}
                        title="Remove"
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                          <line x1="18" y1="6" x2="6" y2="18" />
                          <line x1="6" y1="6" x2="18" y2="18" />
                        </svg>
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Video preview when active */}
            {activeMedia?.type === 'video' && (
              <div style={styles.previewSection}>
                <h4 style={styles.sectionTitle}>Now Playing</h4>
                <div style={styles.videoPreview}>
                  <video
                    src={activeMedia.url}
                    style={styles.videoElement}
                    controls
                    autoPlay
                  />
                </div>
              </div>
            )}
          </div>
        )}

        {/* Images tab */}
        {activeTab === 'images' && (
          <div style={styles.section}>
            <h4 style={styles.sectionTitle}>Show an Image</h4>

            {/* URL input */}
            <div style={styles.inputRow}>
              <input
                style={styles.urlInput}
                placeholder="Paste image URL..."
                value={imageUrl}
                onChange={(e) => setImageUrl(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleImageUrlSubmit()}
              />
              <button
                style={{
                  ...styles.actionBtn,
                  opacity: imageUrl.trim() ? 1 : 0.4,
                }}
                onClick={handleImageUrlSubmit}
                disabled={!imageUrl.trim()}
              >
                Show
              </button>
            </div>

            {/* Upload button */}
            <input
              ref={imageInputRef}
              type="file"
              accept="image/*"
              multiple
              style={{ display: 'none' }}
              onChange={handleImageUpload}
            />
            <button
              style={styles.uploadBtn}
              onClick={() => imageInputRef.current?.click()}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="17 8 12 3 7 8" />
                <line x1="12" y1="3" x2="12" y2="15" />
              </svg>
              Upload Images
            </button>

            {/* Uploaded images list + slide controls */}
            {uploadedImages.length > 0 && (
              <>
                {/* Slide navigation */}
                <div style={styles.slideControls}>
                  <button
                    style={{
                      ...styles.slideBtn,
                      opacity: currentSlideIndex > 0 ? 1 : 0.3,
                    }}
                    onClick={handlePrevSlide}
                    disabled={currentSlideIndex <= 0}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="15 18 9 12 15 6" />
                    </svg>
                  </button>
                  <span style={styles.slideCounter}>
                    {currentSlideIndex + 1} / {uploadedImages.length}
                  </span>
                  <button
                    style={{
                      ...styles.slideBtn,
                      opacity: currentSlideIndex < uploadedImages.length - 1 ? 1 : 0.3,
                    }}
                    onClick={handleNextSlide}
                    disabled={currentSlideIndex >= uploadedImages.length - 1}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="9 18 15 12 9 6" />
                    </svg>
                  </button>
                </div>

                {/* Current slide preview */}
                <div style={styles.imagePreview}>
                  <img
                    src={uploadedImages[currentSlideIndex]?.url}
                    alt={uploadedImages[currentSlideIndex]?.name}
                    style={styles.imageElement}
                  />
                </div>

                {/* Show on stream button */}
                <button
                  style={styles.showOnStreamBtn}
                  onClick={() => {
                    const img = uploadedImages[currentSlideIndex];
                    if (img) onShowImage(img.url);
                  }}
                >
                  Show on Stream
                </button>

                {/* Image list */}
                <div style={styles.fileList}>
                  {uploadedImages.map((file, index) => (
                    <div
                      key={file.id}
                      style={{
                        ...styles.fileItem,
                        ...(index === currentSlideIndex ? styles.fileItemActive : {}),
                      }}
                      onClick={() => setCurrentSlideIndex(index)}
                    >
                      <div style={styles.fileInfo}>
                        <img
                          src={file.url}
                          alt={file.name}
                          style={styles.thumbnailImg}
                        />
                        <span style={styles.fileName}>{file.name}</span>
                      </div>
                      <button
                        style={styles.fileActionBtn}
                        onClick={(e) => {
                          e.stopPropagation();
                          handleRemoveUploaded(uploadedImages, setUploadedImages, index);
                          if (currentSlideIndex >= uploadedImages.length - 1 && currentSlideIndex > 0) {
                            setCurrentSlideIndex(currentSlideIndex - 1);
                          }
                        }}
                        title="Remove"
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                          <line x1="18" y1="6" x2="6" y2="18" />
                          <line x1="6" y1="6" x2="18" y2="18" />
                        </svg>
                      </button>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        {/* Files tab (PDF support) */}
        {activeTab === 'files' && (
          <div style={styles.section}>
            <h4 style={styles.sectionTitle}>Share a File</h4>
            <p style={styles.hint}>Upload PDFs or other documents to display on stream.</p>

            {/* Upload button */}
            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf,image/*"
              multiple
              style={{ display: 'none' }}
              onChange={handleFileUpload}
            />
            <button
              style={styles.uploadBtn}
              onClick={() => fileInputRef.current?.click()}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="17 8 12 3 7 8" />
                <line x1="12" y1="3" x2="12" y2="15" />
              </svg>
              Upload File
            </button>

            {/* Uploaded files list */}
            {uploadedFiles.length > 0 && (
              <div style={styles.fileList}>
                {uploadedFiles.map((file, index) => (
                  <div key={file.id} style={styles.fileItem}>
                    <div style={styles.fileInfo}>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                        <polyline points="14 2 14 8 20 8" />
                      </svg>
                      <span style={styles.fileName}>{file.name}</span>
                    </div>
                    <div style={styles.fileActions}>
                      <button
                        style={styles.fileActionBtn}
                        onClick={() => {
                          if (file.type === 'pdf') {
                            onShowImage(file.url);
                            setPdfPage(1);
                          } else {
                            onShowImage(file.url);
                          }
                        }}
                        title="Show on stream"
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                          <circle cx="12" cy="12" r="3" />
                        </svg>
                      </button>
                      <button
                        style={styles.fileActionBtn}
                        onClick={() => handleRemoveUploaded(uploadedFiles, setUploadedFiles, index)}
                        title="Remove"
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                          <line x1="18" y1="6" x2="6" y2="18" />
                          <line x1="6" y1="6" x2="18" y2="18" />
                        </svg>
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* PDF preview with page navigation */}
            {activeMedia?.type === 'pdf' && (
              <div style={styles.previewSection}>
                <h4 style={styles.sectionTitle}>PDF Viewer</h4>
                <div style={styles.pdfPreview}>
                  <object
                    data={`${activeMedia.url}#page=${pdfPage}`}
                    type="application/pdf"
                    style={styles.pdfObject}
                  >
                    <iframe
                      src={`${activeMedia.url}#page=${pdfPage}`}
                      style={styles.pdfObject}
                      title="PDF preview"
                    />
                  </object>
                </div>
                <div style={styles.pdfNav}>
                  <button
                    style={{
                      ...styles.slideBtn,
                      opacity: pdfPage > 1 ? 1 : 0.3,
                    }}
                    onClick={() => setPdfPage((p) => Math.max(1, p - 1))}
                    disabled={pdfPage <= 1}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="15 18 9 12 15 6" />
                    </svg>
                  </button>
                  <span style={styles.slideCounter}>Page {pdfPage}</span>
                  <button
                    style={styles.slideBtn}
                    onClick={() => setPdfPage((p) => p + 1)}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="9 18 15 12 9 6" />
                    </svg>
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  panel: {
    width: 240,
    display: 'flex',
    flexDirection: 'column',
    background: 'var(--bg-secondary)',
    borderLeft: '1px solid var(--border)',
    height: '100%',
    overflow: 'hidden',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '12px 16px',
    borderBottom: '1px solid var(--border)',
  },
  title: {
    fontSize: 14,
    fontWeight: 600,
    margin: 0,
    color: 'var(--text-primary)',
  },
  closeBtn: {
    background: 'none',
    border: 'none',
    color: 'var(--text-muted)',
    cursor: 'pointer',
    padding: 4,
    borderRadius: 6,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  tabBar: {
    display: 'flex',
    borderBottom: '1px solid var(--border)',
    padding: '0 4px',
  },
  tab: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 3,
    padding: '10px 4px 8px',
    background: 'none',
    border: 'none',
    borderBottom: '2px solid transparent',
    color: 'var(--text-muted)',
    cursor: 'pointer',
    transition: 'all var(--transition-fast)',
    borderRadius: 0,
  },
  tabActive: {
    color: 'var(--accent-hover)',
    borderBottomColor: 'var(--accent)',
  },
  tabLabel: {
    fontSize: 10,
    fontWeight: 500,
  },
  activeIndicator: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '8px 12px',
    background: 'var(--accent-subtle)',
    borderBottom: '1px solid var(--border)',
  },
  activeInfo: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
  },
  activeDot: {
    width: 6,
    height: 6,
    borderRadius: '50%',
    background: '#ef4444',
    animation: 'pulse 1.5s ease-in-out infinite',
  },
  activeText: {
    fontSize: 11,
    fontWeight: 500,
    color: 'var(--text-primary)',
  },
  stopBtn: {
    padding: '3px 8px',
    fontSize: 10,
    fontWeight: 600,
    background: '#ef4444',
    color: 'white',
    border: 'none',
    borderRadius: 'var(--radius)',
    cursor: 'pointer',
    transition: 'opacity var(--transition-fast)',
  },
  content: {
    flex: 1,
    overflowY: 'auto',
  },
  section: {
    padding: 16,
  },
  sectionTitle: {
    fontSize: 11,
    fontWeight: 600,
    color: 'var(--text-muted)',
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
    marginBottom: 12,
    marginTop: 0,
  },
  hint: {
    fontSize: 12,
    color: 'var(--text-muted)',
    lineHeight: 1.5,
    marginTop: 0,
    marginBottom: 12,
  },
  inputRow: {
    display: 'flex',
    gap: 6,
    marginBottom: 10,
  },
  urlInput: {
    flex: 1,
    padding: '6px 8px',
    fontSize: 12,
    borderRadius: 'var(--radius)',
    border: '1px solid var(--border)',
    background: 'var(--bg-tertiary)',
    color: 'var(--text-primary)',
    outline: 'none',
    minWidth: 0,
  },
  actionBtn: {
    padding: '6px 10px',
    fontSize: 11,
    fontWeight: 600,
    background: 'var(--accent)',
    color: 'white',
    border: 'none',
    borderRadius: 'var(--radius)',
    cursor: 'pointer',
    transition: 'opacity var(--transition-fast)',
    whiteSpace: 'nowrap',
  },
  uploadBtn: {
    width: '100%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    padding: '8px 12px',
    fontSize: 12,
    fontWeight: 500,
    background: 'none',
    color: 'var(--text-secondary)',
    border: '1px dashed var(--border-strong)',
    borderRadius: 'var(--radius-lg)',
    cursor: 'pointer',
    transition: 'all var(--transition-fast)',
    marginBottom: 12,
  },
  fileList: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    marginBottom: 12,
  },
  fileItem: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '6px 8px',
    borderRadius: 'var(--radius)',
    background: 'var(--bg-tertiary)',
    cursor: 'pointer',
    transition: 'background var(--transition-fast)',
  },
  fileItemActive: {
    background: 'var(--accent-subtle)',
    outline: '1px solid var(--accent)',
  },
  fileInfo: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    minWidth: 0,
    flex: 1,
    color: 'var(--text-secondary)',
  },
  fileName: {
    fontSize: 11,
    color: 'var(--text-secondary)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  fileActions: {
    display: 'flex',
    alignItems: 'center',
    gap: 2,
    flexShrink: 0,
  },
  fileActionBtn: {
    background: 'none',
    border: 'none',
    color: 'var(--text-muted)',
    cursor: 'pointer',
    padding: 3,
    borderRadius: 4,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    transition: 'color var(--transition-fast)',
  },
  thumbnailImg: {
    width: 20,
    height: 20,
    borderRadius: 3,
    objectFit: 'cover',
    flexShrink: 0,
  },
  slideControls: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    marginBottom: 10,
  },
  slideBtn: {
    width: 28,
    height: 28,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'var(--bg-tertiary)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius)',
    color: 'var(--text-secondary)',
    cursor: 'pointer',
    padding: 0,
    transition: 'all var(--transition-fast)',
  },
  slideCounter: {
    fontSize: 11,
    fontWeight: 600,
    color: 'var(--text-secondary)',
  },
  imagePreview: {
    width: '100%',
    aspectRatio: '16 / 9',
    borderRadius: 'var(--radius-lg)',
    overflow: 'hidden',
    background: 'var(--bg-surface)',
    border: '1px solid var(--border)',
    marginBottom: 8,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  imageElement: {
    width: '100%',
    height: '100%',
    objectFit: 'contain',
  },
  showOnStreamBtn: {
    width: '100%',
    padding: '8px 12px',
    fontSize: 12,
    fontWeight: 600,
    background: 'var(--accent)',
    color: 'white',
    border: 'none',
    borderRadius: 'var(--radius)',
    cursor: 'pointer',
    transition: 'background var(--transition-fast)',
    marginBottom: 12,
  },
  previewSection: {
    marginTop: 16,
  },
  videoPreview: {
    width: '100%',
    aspectRatio: '16 / 9',
    borderRadius: 'var(--radius-lg)',
    overflow: 'hidden',
    background: '#000',
    border: '1px solid var(--border)',
  },
  videoElement: {
    width: '100%',
    height: '100%',
    objectFit: 'contain',
  },
  pdfPreview: {
    width: '100%',
    height: 180,
    borderRadius: 'var(--radius-lg)',
    overflow: 'hidden',
    background: 'var(--bg-surface)',
    border: '1px solid var(--border)',
    marginBottom: 8,
  },
  pdfObject: {
    width: '100%',
    height: '100%',
    border: 'none',
  },
  pdfNav: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
};
