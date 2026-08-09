import { useNavigate, useLocation } from 'react-router-dom';
import { LogOut, ArrowLeft, Home, Shield } from 'lucide-react';
import { Profile } from '../lib/types';

interface LayoutProps {
  user: Profile;
  onSignOut: () => void;
  children: React.ReactNode;
  showBack?: boolean;
  onBack?: () => void;
}

export default function Layout({
  user,
  onSignOut,
  children,
  showBack,
  onBack,
}: LayoutProps) {
  const navigate = useNavigate();
  const location = useLocation();

  const isHome = location.pathname === '/home';
  const isSupervisor = user.rol === 'supervisor';

  return (
    <div className="min-h-screen bg-bg-primary flex flex-col">
      {/* Header */}
      <header className="bg-bg-secondary border-b border-border px-4 py-3 flex items-center justify-between sticky top-0 z-50">
        <div className="flex items-center gap-3">
          {showBack && (
            <button
              onClick={onBack || (() => navigate(-1))}
              className="btn-ghost p-2"
              aria-label="Volver"
            >
              <ArrowLeft size={24} />
            </button>
          )}
          {isHome ? (
            <h1 className="text-xl font-bold text-accent tracking-tight">
              ShiftPilot
            </h1>
          ) : (
            <button
              onClick={() => navigate('/home')}
              className="btn-ghost p-1"
              aria-label="Inicio"
            >
              <Home size={22} />
            </button>
          )}
        </div>

        <div className="flex items-center gap-3">
          <span className="text-text-secondary text-sm hidden sm:block">
            {user.nombre}
          </span>
          {isSupervisor && (
            <button
              onClick={() => navigate('/supervisor')}
              className={`btn-ghost p-2 ${location.pathname === '/supervisor' ? 'text-accent' : ''}`}
              aria-label="Dashboard supervisor"
            >
              <Shield size={22} />
            </button>
          )}
          <button
            onClick={onSignOut}
            className="btn-ghost p-2 text-text-muted hover:text-danger"
            aria-label="Cerrar sesión"
          >
            <LogOut size={20} />
          </button>
        </div>
      </header>

      {/* Main content */}
      <main className="flex-1 overflow-y-auto">
        <div className="max-w-2xl mx-auto w-full px-4 py-6">{children}</div>
      </main>
    </div>
  );
}