import { Link } from 'react-router-dom';

export function NotFound() {
  return (
    <div className="not-found-page">
      <h1>404</h1>
      <p>The page you are looking for does not exist or has been moved.</p>
      <Link to="/">
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
          <polyline points="9 22 9 12 15 12 15 22" />
        </svg>
        Go Home
      </Link>
    </div>
  );
}
