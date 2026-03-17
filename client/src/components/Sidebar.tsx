import { useState, useRef, useEffect } from 'react';
import type { LayoutMode } from '@studio/shared';
import { LayoutSwitcher } from './LayoutSwitcher.tsx';
import { LowerThirdManager, type LowerThirdData } from './LowerThird.tsx';
import { BannerManager, type BannerData } from './BannerOverlay.tsx';
import { TimerManager, type TimerData } from './TimerOverlay.tsx';

type SidebarTab = 'layout' | 'overlays' | 'brand';

interface SidebarProps {
  currentLayout: LayoutMode;
  onLayoutChange: (layout: LayoutMode) => void;
  participantCount: number;
  lowerThirds: LowerThirdData[];
  onAddLowerThird: (lt: Omit<LowerThirdData, 'id' | 'visible'>) => void;
  onToggleLowerThird: (id: string) => void;
  onRemoveLowerThird: (id: string) => void;
  banners: BannerData[];
  onAddBanner: (banner: Omit<BannerData, 'id' | 'visible'>) => void;
  onToggleBanner: (id: string) => void;
  onRemoveBanner: (id: string) => void;
  timers: TimerData[];
  onAddTimer: (timer: Omit<TimerData, 'id' | 'visible'>) => void;
  onToggleTimer: (id: string) => void;
  onRemoveTimer: (id: string) => void;
  onUpdateTimer: (id: string, updates: Partial<TimerData>) => void;
}

export function Sidebar({
  currentLayout,
  onLayoutChange,
  participantCount,
  lowerThirds,
  onAddLowerThird,
  onToggleLowerThird,
  onRemoveLowerThird,
  banners,
  onAddBanner,
  onToggleBanner,
  onRemoveBanner,
  timers,
  onAddTimer,
  onToggleTimer,
  onRemoveTimer,
  onUpdateTimer,
}: SidebarProps) {
  const [activeTab, setActiveTab] = useState<SidebarTab>('layout');
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [bgImageUrl, setBgImageUrl] = useState<string | null>(null);
  const [brandColor, setBrandColor] = useState('#7c3aed');
  const logoInputRef = useRef<HTMLInputElement>(null);
  const bgInputRef = useRef<HTMLInputElement>(null);

  // Revoke logo/bg URLs on unmount
  useEffect(() => {
    return () => {
      if (logoUrl) URL.revokeObjectURL(logoUrl);
      if (bgImageUrl) URL.revokeObjectURL(bgImageUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleLogoUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      if (logoUrl) URL.revokeObjectURL(logoUrl);
      setLogoUrl(URL.createObjectURL(file));
    }
    e.target.value = '';
  };

  const handleBgUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      if (bgImageUrl) URL.revokeObjectURL(bgImageUrl);
      setBgImageUrl(URL.createObjectURL(file));
    }
    e.target.value = '';
  };

  const brandPresets = [
    { name: 'Purple', color: '#7c3aed' },
    { name: 'Blue', color: '#3b82f6' },
    { name: 'Green', color: '#22c55e' },
    { name: 'Red', color: '#ef4444' },
    { name: 'Orange', color: '#f97316' },
    { name: 'Pink', color: '#ec4899' },
    { name: 'Cyan', color: '#06b6d4' },
    { name: 'Amber', color: '#f59e0b' },
  ];

  const tabs: { id: SidebarTab; label: string; icon: React.ReactNode }[] = [
    {
      id: 'layout',
      label: 'Layout',
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="3" width="7" height="7" />
          <rect x="14" y="3" width="7" height="7" />
          <rect x="14" y="14" width="7" height="7" />
          <rect x="3" y="14" width="7" height="7" />
        </svg>
      ),
    },
    {
      id: 'overlays',
      label: 'Overlays',
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
          <line x1="3" y1="15" x2="21" y2="15" />
        </svg>
      ),
    },
    {
      id: 'brand',
      label: 'Brand',
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10" />
          <polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76" />
        </svg>
      ),
    },
  ];

  return (
    <div style={styles.sidebar}>
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

      {/* Tab content */}
      <div style={styles.content}>
        {activeTab === 'layout' && (
          <div style={styles.section}>
            <h4 style={styles.sectionTitle}>Arrange Feeds</h4>
            <div style={styles.layoutWrap}>
              <LayoutSwitcher
                currentLayout={currentLayout}
                onLayoutChange={onLayoutChange}
                participantCount={participantCount}
              />
            </div>
            <p style={styles.hint}>
              Choose how participant videos are arranged on screen. Spotlight and PiP require 2+ participants.
            </p>
          </div>
        )}

        {activeTab === 'overlays' && (
          <div>
            <LowerThirdManager
              lowerThirds={lowerThirds}
              onAdd={onAddLowerThird}
              onToggle={onToggleLowerThird}
              onRemove={onRemoveLowerThird}
            />
            <div style={styles.overlayDivider} />
            <BannerManager
              banners={banners}
              onAdd={onAddBanner}
              onToggle={onToggleBanner}
              onRemove={onRemoveBanner}
            />
            <div style={styles.overlayDivider} />
            <TimerManager
              timers={timers}
              onAdd={onAddTimer}
              onToggle={onToggleTimer}
              onRemove={onRemoveTimer}
              onUpdate={onUpdateTimer}
            />
          </div>
        )}

        {activeTab === 'brand' && (
          <div style={styles.section}>
            <h4 style={styles.sectionTitle}>Brand Kit</h4>

            {/* Logo Upload */}
            <div style={styles.brandGroup}>
              <span style={styles.brandLabel}>Logo</span>
              <input
                ref={logoInputRef}
                type="file"
                accept="image/*"
                style={{ display: 'none' }}
                onChange={handleLogoUpload}
              />
              {logoUrl ? (
                <div style={styles.logoPreview}>
                  <img src={logoUrl} alt="Logo" style={styles.logoImg} />
                  <button
                    style={styles.removeImgBtn}
                    onClick={() => { URL.revokeObjectURL(logoUrl); setLogoUrl(null); }}
                  >
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                      <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                </div>
              ) : (
                <button
                  style={styles.uploadBtn}
                  onClick={() => logoInputRef.current?.click()}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="17 8 12 3 7 8" />
                    <line x1="12" y1="3" x2="12" y2="15" />
                  </svg>
                  Upload Logo
                </button>
              )}
            </div>

            {/* Background Image */}
            <div style={styles.brandGroup}>
              <span style={styles.brandLabel}>Background</span>
              <input
                ref={bgInputRef}
                type="file"
                accept="image/*,video/*"
                style={{ display: 'none' }}
                onChange={handleBgUpload}
              />
              {bgImageUrl ? (
                <div style={styles.bgPreview}>
                  <img src={bgImageUrl} alt="Background" style={styles.bgImg} />
                  <button
                    style={styles.removeImgBtn}
                    onClick={() => { URL.revokeObjectURL(bgImageUrl); setBgImageUrl(null); }}
                  >
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                      <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                </div>
              ) : (
                <button
                  style={styles.uploadBtn}
                  onClick={() => bgInputRef.current?.click()}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <rect x="3" y="3" width="18" height="18" rx="2" />
                    <circle cx="8.5" cy="8.5" r="1.5" />
                    <polyline points="21 15 16 10 5 21" />
                  </svg>
                  Upload Background
                </button>
              )}
            </div>

            {/* Brand Color */}
            <div style={styles.brandGroup}>
              <span style={styles.brandLabel}>Brand Color</span>
              <div style={styles.colorGrid}>
                {brandPresets.map((preset) => (
                  <button
                    key={preset.color}
                    style={{
                      ...styles.colorSwatch,
                      background: preset.color,
                      outline: brandColor === preset.color ? `2px solid ${preset.color}` : 'none',
                      outlineOffset: 2,
                    }}
                    onClick={() => setBrandColor(preset.color)}
                    title={preset.name}
                  />
                ))}
              </div>
              <div style={styles.colorInfo}>
                <div style={{ ...styles.colorDot, background: brandColor }} />
                <span style={styles.colorHex}>{brandColor}</span>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  sidebar: {
    width: 240,
    display: 'flex',
    flexDirection: 'column',
    background: 'var(--bg-secondary)',
    borderLeft: '1px solid var(--border)',
    height: '100%',
    overflow: 'hidden',
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
  content: {
    flex: 1,
    overflowY: 'auto',
  },
  section: {
    padding: '16px',
  },
  sectionTitle: {
    fontSize: 11,
    fontWeight: 600,
    color: 'var(--text-muted)',
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
    marginBottom: 12,
  },
  layoutWrap: {
    marginBottom: 12,
  },
  hint: {
    fontSize: 12,
    color: 'var(--text-muted)',
    lineHeight: 1.5,
  },
  overlayDivider: {
    height: 1,
    background: 'var(--border)',
    margin: '4px 16px 8px',
  },
  // Brand Kit
  brandGroup: {
    marginBottom: 16,
  },
  brandLabel: {
    fontSize: 11,
    fontWeight: 600,
    color: 'var(--text-secondary)',
    display: 'block',
    marginBottom: 8,
  },
  uploadBtn: {
    width: '100%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    padding: '10px',
    fontSize: 12,
    fontWeight: 500,
    background: 'none',
    color: 'var(--text-muted)',
    border: '1px dashed var(--border-strong)',
    borderRadius: 10,
    cursor: 'pointer',
    transition: 'all var(--transition-fast)',
  },
  logoPreview: {
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: 60,
    borderRadius: 8,
    background: 'var(--bg-tertiary)',
    border: '1px solid var(--border)',
    overflow: 'hidden',
  },
  logoImg: {
    maxHeight: 48,
    maxWidth: '100%',
    objectFit: 'contain',
  },
  bgPreview: {
    position: 'relative',
    aspectRatio: '16 / 9',
    borderRadius: 8,
    background: 'var(--bg-tertiary)',
    border: '1px solid var(--border)',
    overflow: 'hidden',
  },
  bgImg: {
    width: '100%',
    height: '100%',
    objectFit: 'cover',
  },
  removeImgBtn: {
    position: 'absolute',
    top: 4,
    right: 4,
    width: 20,
    height: 20,
    borderRadius: 4,
    background: 'rgba(0,0,0,0.6)',
    border: 'none',
    color: 'white',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 0,
  },
  colorGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(8, 1fr)',
    gap: 4,
    marginBottom: 8,
  },
  colorSwatch: {
    width: '100%',
    aspectRatio: '1',
    borderRadius: 6,
    border: 'none',
    cursor: 'pointer',
    transition: 'transform 0.1s',
  },
  colorInfo: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
  },
  colorDot: {
    width: 12,
    height: 12,
    borderRadius: 4,
  },
  colorHex: {
    fontSize: 11,
    fontFamily: 'monospace',
    color: 'var(--text-muted)',
  },
};
