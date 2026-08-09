import { Clock } from 'lucide-react';
import { useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './hooks/useAuth';
import { useInactivityTimer } from './hooks/useInactivityTimer';
import Layout from './components/Layout';
import ProtectedRoute from './components/ProtectedRoute';
import LoginPage from './components/LoginPage';
import ErrorBoundary from './components/ErrorBoundary';
import HomePage from './components/HomePage';
import RecordPage from './components/RecordPage';
import ReviewTranscriptPage from './components/ReviewTranscriptPage';
import EventReviewPage from './components/EventReviewPage';
import IncomingConfirmPage from './components/IncomingConfirmPage';
import SupervisorDashboard from './components/SupervisorDashboard';

function AppContent() {
  const { user, loading, error, signIn, signOut } = useAuth();
  const [showIncomingConfirm, setShowIncomingConfirm] = useState(true);

  const handleTimeout = () => {
    signOut();
  };

  const { showWarning, dismissWarning } = useInactivityTimer(handleTimeout);

  // Handle sign out
  const handleSignOut = async () => {
    await signOut();
  };

  // Incoming confirmation handler
  const handleIncomingConfirmed = () => {
    setShowIncomingConfirm(false);
  };

  // Reset incoming check on login
  const handleLogin = async (email: string, password: string) => {
    const ok = await signIn(email, password);
    if (ok) setShowIncomingConfirm(true);
    return ok;
  };

  return (
    <BrowserRouter>
      <Routes>
        <Route
          path="/login"
          element={
            user ? <Navigate to="/home" replace /> : (
              <LoginPage onLogin={handleLogin} error={error} />
            )
          }
        />

        <Route
          path="/home"
          element={
            <ProtectedRoute user={user} loading={loading}>
              <Layout user={user!} onSignOut={handleSignOut}>
                {user?.rol === 'supervisor' ? (
                  <SupervisorDashboard />
                ) : (
                  <>
                    {showIncomingConfirm && (
                      <IncomingConfirmPage
                        user={user!}
                        onConfirmed={handleIncomingConfirmed}
                      />
                    )}
                    {!showIncomingConfirm && <HomePage user={user!} />}
                  </>
                )}
              </Layout>
            </ProtectedRoute>
          }
        />

        <Route
          path="/record"
          element={
            <ProtectedRoute user={user} loading={loading}>
              <Layout user={user!} onSignOut={handleSignOut} showBack>
                <RecordPage />
              </Layout>
            </ProtectedRoute>
          }
        />

        <Route
          path="/review"
          element={
            <ProtectedRoute user={user} loading={loading}>
              <Layout user={user!} onSignOut={handleSignOut} showBack>
                <ReviewTranscriptPage />
              </Layout>
            </ProtectedRoute>
          }
        />

        <Route
          path="/events"
          element={
            <ProtectedRoute user={user} loading={loading}>
              <Layout user={user!} onSignOut={handleSignOut} showBack>
                <EventReviewPage />
              </Layout>
            </ProtectedRoute>
          }
        />

        <Route
          path="/supervisor"
          element={
            <ProtectedRoute user={user} loading={loading} requireSupervisor>
              <Layout user={user!} onSignOut={handleSignOut}>
                <SupervisorDashboard />
              </Layout>
            </ProtectedRoute>
          }
        />

        <Route path="*" element={<Navigate to="/home" replace />} />
      </Routes>

      {/* Inactivity warning modal */}
      {showWarning && user && (
        <div className="fixed inset-0 z-[100] bg-black/60 flex items-center justify-center p-4">
          <div className="bg-bg-card border border-border rounded-2xl p-8 max-w-sm w-full text-center animate-fade-in">
            <div className="w-16 h-16 rounded-full bg-warning/20 flex items-center justify-center mx-auto mb-4">
              <Clock size={32} className="text-warning" />
            </div>
            <h2 className="text-lg font-bold text-text-primary mb-2">
              ¿Sigues ahí?
            </h2>
            <p className="text-text-secondary text-sm mb-6">
              Por inactividad, la sesión se cerrará en 30 segundos.
            </p>
            <button
              onClick={dismissWarning}
              className="btn-primary w-full text-lg"
            >
              Continuar sesión
            </button>
          </div>
        </div>
      )}
    </BrowserRouter>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <AppContent />
    </ErrorBoundary>
  );
}