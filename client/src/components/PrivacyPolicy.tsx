import { Link } from 'react-router-dom';

export function PrivacyPolicy() {
  return (
    <div style={styles.page}>
      <div style={styles.container}>
        <Link to="/" style={styles.backLink}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M19 12H5" />
            <polyline points="12 19 5 12 12 5" />
          </svg>
          Back to Home
        </Link>

        <h1 style={styles.title}>Privacy Policy</h1>
        <p style={styles.lastUpdated}>Last updated: March 2026</p>

        <div style={styles.content}>
          <p style={styles.intro}>
            This Privacy Policy describes how LiveStream Studio ("we", "us", or "our"), operated by Arnold Famini,
            collects, uses, and protects your information when you use our service at studio.arnoldfamini.com.
          </p>

          <section style={styles.section}>
            <h2 style={styles.sectionTitle}>1. Information We Collect</h2>
            <p style={styles.text}>When you use LiveStream Studio, we may collect the following types of information:</p>
            <ul style={styles.list}>
              <li style={styles.listItem}>
                <strong>Camera and microphone data:</strong> We access your device's camera and microphone to provide
                the livestreaming and recording functionality. This media data is transmitted in real-time to other
                participants via peer-to-peer connections and is not stored on our servers.
              </li>
              <li style={styles.listItem}>
                <strong>Screen share data:</strong> If you choose to share your screen, that visual data is transmitted
                to other participants in your studio session.
              </li>
              <li style={styles.listItem}>
                <strong>Display name:</strong> We collect the name you provide when creating or joining a studio session.
                This is stored temporarily in your browser's session storage.
              </li>
              <li style={styles.listItem}>
                <strong>Google Drive access:</strong> If you choose to upload recordings to Google Drive, we request
                access to your Google Drive account solely for the purpose of uploading your recording files.
              </li>
            </ul>
          </section>

          <section style={styles.section}>
            <h2 style={styles.sectionTitle}>2. How We Use Your Information</h2>
            <p style={styles.text}>We use the information we collect for the following purposes:</p>
            <ul style={styles.list}>
              <li style={styles.listItem}>To provide and maintain the livestreaming and recording service</li>
              <li style={styles.listItem}>To facilitate real-time audio and video communication between studio participants</li>
              <li style={styles.listItem}>To enable recording of studio sessions</li>
              <li style={styles.listItem}>To upload recordings to your Google Drive when you request it</li>
              <li style={styles.listItem}>To display your name to other participants in a studio session</li>
            </ul>
          </section>

          <section style={styles.section}>
            <h2 style={styles.sectionTitle}>3. Data Storage</h2>
            <p style={styles.text}>
              <strong>Local recordings:</strong> When you record a studio session, the recording is processed and stored
              locally in your browser. Recordings are not automatically uploaded to or stored on our servers.
            </p>
            <p style={styles.text}>
              <strong>Google Drive uploads:</strong> If you choose to upload a recording to Google Drive, the file is
              sent directly to your own Google Drive account. We do not retain copies of uploaded recordings.
            </p>
            <p style={styles.text}>
              <strong>Session data:</strong> Your display name and session information are stored in your browser's
              session storage and are cleared when you close the browser tab.
            </p>
          </section>

          <section style={styles.section}>
            <h2 style={styles.sectionTitle}>4. Third-Party Services</h2>
            <p style={styles.text}>LiveStream Studio uses the following third-party services:</p>
            <ul style={styles.list}>
              <li style={styles.listItem}>
                <strong>Google Drive API:</strong> Used to upload recordings to your Google Drive account when you
                explicitly choose to do so. Subject to{' '}
                <a href="https://policies.google.com/privacy" target="_blank" rel="noopener noreferrer" style={styles.link}>
                  Google's Privacy Policy
                </a>.
              </li>
              <li style={styles.listItem}>
                <strong>WebRTC:</strong> Used for peer-to-peer audio and video connections between participants.
                Media data is transmitted directly between participants and is not routed through our servers when
                a direct connection can be established.
              </li>
            </ul>
          </section>

          <section style={styles.section}>
            <h2 style={styles.sectionTitle}>5. Cookies and Local Storage</h2>
            <p style={styles.text}>
              LiveStream Studio uses browser session storage to maintain your session state (such as your display name
              and role) during an active studio session. We do not use tracking cookies or third-party analytics cookies.
              Session storage data is automatically cleared when you close the browser tab.
            </p>
          </section>

          <section style={styles.section}>
            <h2 style={styles.sectionTitle}>6. Data Retention</h2>
            <p style={styles.text}>
              We retain minimal data. Session information is stored only in your browser's session storage and is cleared
              when you close the tab. Studio room data on our servers is temporary and is removed when the session ends.
              We do not maintain long-term databases of user information or recordings.
            </p>
          </section>

          <section style={styles.section}>
            <h2 style={styles.sectionTitle}>7. Your Rights</h2>
            <p style={styles.text}>You have the right to:</p>
            <ul style={styles.list}>
              <li style={styles.listItem}>
                <strong>Access:</strong> Request information about what data we hold about you.
              </li>
              <li style={styles.listItem}>
                <strong>Deletion:</strong> Request deletion of any data associated with you. Since we store minimal
                data and most is session-based, clearing your browser data effectively removes all locally stored
                information.
              </li>
              <li style={styles.listItem}>
                <strong>Revoke access:</strong> You can revoke Google Drive access at any time through your{' '}
                <a href="https://myaccount.google.com/permissions" target="_blank" rel="noopener noreferrer" style={styles.link}>
                  Google Account permissions
                </a>.
              </li>
            </ul>
          </section>

          <section style={styles.section}>
            <h2 style={styles.sectionTitle}>8. Contact Information</h2>
            <p style={styles.text}>
              If you have any questions or concerns about this Privacy Policy or our data practices, please contact us at:
            </p>
            <p style={styles.text}>
              <a href="mailto:arnoldfamini21@gmail.com" style={styles.link}>arnoldfamini21@gmail.com</a>
            </p>
          </section>

          <section style={styles.section}>
            <h2 style={styles.sectionTitle}>9. Changes to This Policy</h2>
            <p style={styles.text}>
              We may update this Privacy Policy from time to time. Any changes will be posted on this page with an
              updated "Last updated" date. We encourage you to review this Privacy Policy periodically for any changes.
              Your continued use of the service after changes are posted constitutes your acceptance of the updated policy.
            </p>
          </section>
        </div>

        <div style={styles.footer}>
          <Link to="/" style={styles.footerLink}>Back to Home</Link>
          <span style={styles.footerSep}>|</span>
          <Link to="/terms" style={styles.footerLink}>Terms of Service</Link>
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    minHeight: '100vh',
    background: 'var(--bg-primary)',
    color: 'var(--text-primary)',
    padding: '40px 24px',
  },
  container: {
    maxWidth: 720,
    margin: '0 auto',
  },
  backLink: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
    fontSize: 14,
    color: 'var(--accent)',
    textDecoration: 'none',
    marginBottom: 32,
    fontWeight: 500,
  },
  title: {
    fontSize: 32,
    fontWeight: 700,
    letterSpacing: '-0.02em',
    color: 'var(--text-primary)',
    marginBottom: 8,
  },
  lastUpdated: {
    fontSize: 14,
    color: 'var(--text-muted)',
    marginBottom: 32,
  },
  content: {
    lineHeight: 1.7,
  },
  intro: {
    fontSize: 15,
    color: 'var(--text-secondary)',
    marginBottom: 32,
    lineHeight: 1.7,
  },
  section: {
    marginBottom: 32,
  },
  sectionTitle: {
    fontSize: 20,
    fontWeight: 600,
    color: 'var(--text-primary)',
    marginBottom: 12,
    letterSpacing: '-0.01em',
  },
  text: {
    fontSize: 15,
    color: 'var(--text-secondary)',
    marginBottom: 12,
    lineHeight: 1.7,
  },
  list: {
    paddingLeft: 24,
    margin: '8px 0',
  },
  listItem: {
    fontSize: 15,
    color: 'var(--text-secondary)',
    marginBottom: 10,
    lineHeight: 1.7,
  },
  link: {
    color: 'var(--accent)',
    textDecoration: 'none',
    fontWeight: 500,
  },
  footer: {
    marginTop: 48,
    paddingTop: 24,
    borderTop: '1px solid var(--border)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  footerLink: {
    fontSize: 14,
    color: 'var(--accent)',
    textDecoration: 'none',
    fontWeight: 500,
  },
  footerSep: {
    color: 'var(--text-muted)',
    fontSize: 14,
  },
};
