import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { HomePage } from './components/HomePage.tsx';
const StudioRoom = React.lazy(() => import('./components/StudioRoom.tsx').then(module => ({ default: module.StudioRoom })));
const JoinRoom = React.lazy(() => import('./components/JoinRoom.tsx').then(module => ({ default: module.JoinRoom })));
import { NotFound } from './components/NotFound.tsx';
import { PrivacyPolicy } from './components/PrivacyPolicy.tsx';
import { TermsOfService } from './components/TermsOfService.tsx';
import { ErrorBoundary } from './components/ErrorBoundary.tsx';
import { ToastProvider } from './components/Toast.tsx';
import './styles/global.css';

const PopoutChat = React.lazy(() => import('./components/PopoutChat.tsx').then((module) => ({ default: module.PopoutChat })));

function RouteFallback() {
  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', background: 'var(--bg-primary)', color: 'var(--text-secondary)', fontSize: 13, fontWeight: 700 }}>
      Loading...
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <ToastProvider>
        <BrowserRouter future={{ v7_relativeSplatPath: true, v7_startTransition: true }}>
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/studio/:roomId" element={<React.Suspense fallback={<RouteFallback />}><StudioRoom /></React.Suspense>} />
            <Route path="/studio/:roomId/popout-chat" element={<React.Suspense fallback={<RouteFallback />}><PopoutChat /></React.Suspense>} />
            <Route path="/join/:roomId" element={<React.Suspense fallback={<RouteFallback />}><JoinRoom /></React.Suspense>} />
            <Route path="/privacy" element={<PrivacyPolicy />} />
            <Route path="/terms" element={<TermsOfService />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </BrowserRouter>
      </ToastProvider>
    </ErrorBoundary>
  </React.StrictMode>
);
