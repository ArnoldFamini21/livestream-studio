import { Link } from 'react-router-dom';

export function TermsOfService() {
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

        <h1 style={styles.title}>Terms of Service</h1>
        <p style={styles.lastUpdated}>Last updated: March 2026</p>

        <div style={styles.content}>
          <p style={styles.intro}>
            Please read these Terms of Service ("Terms") carefully before using LiveStream Studio at
            studio.arnoldfamini.com ("the Service"), operated by Arnold Famini.
          </p>

          <section style={styles.section}>
            <h2 style={styles.sectionTitle}>1. Acceptance of Terms</h2>
            <p style={styles.text}>
              By accessing or using LiveStream Studio, you agree to be bound by these Terms. If you do not agree to
              these Terms, you may not access or use the Service. We reserve the right to update these Terms at any
              time, and your continued use of the Service following any changes constitutes acceptance of the updated Terms.
            </p>
          </section>

          <section style={styles.section}>
            <h2 style={styles.sectionTitle}>2. Description of Service</h2>
            <p style={styles.text}>
              LiveStream Studio is a web-based livestreaming and recording studio that allows users to create and join
              live broadcast sessions, record content, and collaborate with other participants in real-time. The Service
              provides tools for audio/video communication, screen sharing, recording, and optional upload of recordings
              to Google Drive.
            </p>
          </section>

          <section style={styles.section}>
            <h2 style={styles.sectionTitle}>3. User Accounts and Responsibilities</h2>
            <p style={styles.text}>
              You are responsible for any activity that occurs during your use of the Service. When creating or joining
              a studio session, you agree to:
            </p>
            <ul style={styles.list}>
              <li style={styles.listItem}>Provide a display name that does not impersonate others or violate any third-party rights</li>
              <li style={styles.listItem}>Maintain the confidentiality of any invite links you create or receive</li>
              <li style={styles.listItem}>Use the Service in compliance with all applicable laws and regulations</li>
              <li style={styles.listItem}>Not share access credentials or invite links with unauthorized parties if your session is private</li>
            </ul>
          </section>

          <section style={styles.section}>
            <h2 style={styles.sectionTitle}>4. Acceptable Use Policy</h2>
            <p style={styles.text}>You agree not to use LiveStream Studio to:</p>
            <ul style={styles.list}>
              <li style={styles.listItem}>Transmit any content that is unlawful, harmful, threatening, abusive, harassing, defamatory, vulgar, obscene, or otherwise objectionable</li>
              <li style={styles.listItem}>Violate any local, state, national, or international law or regulation</li>
              <li style={styles.listItem}>Infringe upon any third party's intellectual property rights, privacy rights, or other proprietary rights</li>
              <li style={styles.listItem}>Transmit any viruses, malware, or other malicious code</li>
              <li style={styles.listItem}>Interfere with or disrupt the Service or servers or networks connected to the Service</li>
              <li style={styles.listItem}>Attempt to gain unauthorized access to any portion of the Service or any other systems or networks</li>
              <li style={styles.listItem}>Use the Service to record or stream content without the consent of all participants</li>
            </ul>
          </section>

          <section style={styles.section}>
            <h2 style={styles.sectionTitle}>5. Intellectual Property</h2>
            <p style={styles.text}>
              <strong>Your content:</strong> You retain full ownership of all content you create, record, or transmit
              using LiveStream Studio. We do not claim any ownership rights over your recordings, streams, or any
              other content you produce using the Service.
            </p>
            <p style={styles.text}>
              <strong>Our service:</strong> The LiveStream Studio service, including its design, features, and underlying
              technology, is the property of Arnold Famini. You may not copy, modify, distribute, or reverse-engineer
              any part of the Service without prior written consent.
            </p>
          </section>

          <section style={styles.section}>
            <h2 style={styles.sectionTitle}>6. Disclaimer of Warranties</h2>
            <p style={styles.text}>
              THE SERVICE IS PROVIDED ON AN "AS IS" AND "AS AVAILABLE" BASIS WITHOUT WARRANTIES OF ANY KIND, EITHER
              EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO IMPLIED WARRANTIES OF MERCHANTABILITY, FITNESS FOR A
              PARTICULAR PURPOSE, AND NON-INFRINGEMENT.
            </p>
            <p style={styles.text}>
              We do not warrant that the Service will be uninterrupted, timely, secure, or error-free. We do not
              warrant that the results obtained from using the Service will be accurate or reliable. The quality of
              livestreams and recordings may vary depending on your internet connection, hardware, and other factors
              outside our control.
            </p>
          </section>

          <section style={styles.section}>
            <h2 style={styles.sectionTitle}>7. Limitation of Liability</h2>
            <p style={styles.text}>
              TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, IN NO EVENT SHALL ARNOLD FAMINI OR LIVESTREAM STUDIO
              BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES, INCLUDING BUT NOT
              LIMITED TO LOSS OF PROFITS, DATA, USE, OR GOODWILL, ARISING OUT OF OR IN CONNECTION WITH YOUR USE OF
              THE SERVICE, WHETHER BASED ON WARRANTY, CONTRACT, TORT (INCLUDING NEGLIGENCE), OR ANY OTHER LEGAL THEORY,
              EVEN IF WE HAVE BEEN ADVISED OF THE POSSIBILITY OF SUCH DAMAGES.
            </p>
            <p style={styles.text}>
              Our total liability to you for any claims arising from or related to the Service shall not exceed the
              amount you paid to us, if any, for access to the Service during the twelve (12) months preceding the claim.
            </p>
          </section>

          <section style={styles.section}>
            <h2 style={styles.sectionTitle}>8. Termination</h2>
            <p style={styles.text}>
              We reserve the right to suspend or terminate your access to the Service at any time, with or without
              cause and with or without notice. Upon termination, your right to use the Service will immediately cease.
              Any recordings or data stored locally in your browser will remain accessible to you, but you will no
              longer be able to create or join studio sessions.
            </p>
          </section>

          <section style={styles.section}>
            <h2 style={styles.sectionTitle}>9. Governing Law</h2>
            <p style={styles.text}>
              These Terms shall be governed by and construed in accordance with the laws of the United States, without
              regard to its conflict of law provisions. Any disputes arising under or in connection with these Terms
              shall be resolved through good-faith negotiation, and if necessary, through binding arbitration or in
              the courts of competent jurisdiction.
            </p>
          </section>

          <section style={styles.section}>
            <h2 style={styles.sectionTitle}>10. Contact Information</h2>
            <p style={styles.text}>
              If you have any questions about these Terms of Service, please contact us at:
            </p>
            <p style={styles.text}>
              <a href="mailto:arnoldfamini21@gmail.com" style={styles.link}>arnoldfamini21@gmail.com</a>
            </p>
          </section>
        </div>

        <div style={styles.footer}>
          <Link to="/" style={styles.footerLink}>Back to Home</Link>
          <span style={styles.footerSep}>|</span>
          <Link to="/privacy" style={styles.footerLink}>Privacy Policy</Link>
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
