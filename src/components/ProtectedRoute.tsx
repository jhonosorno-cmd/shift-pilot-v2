import { Navigate } from 'react-router-dom';

interface ProtectedRouteProps {
  user: { id: string; rol: string; nombre: string } | null;
  loading: boolean;
  requireSupervisor?: boolean;
  children: React.ReactNode;
}

export default function ProtectedRoute({
  user,
  loading,
  requireSupervisor,
  children,
}: ProtectedRouteProps) {
  if (loading) {
    return (
      <div className="min-h-screen bg-bg-primary flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <div className="w-10 h-10 border-2 border-accent border-t-transparent rounded-full animate-spin" />
          <p className="text-text-secondary text-sm">Cargando...</p>
        </div>
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  if (requireSupervisor && user.rol !== 'supervisor') {
    return <Navigate to="/home" replace />;
  }

  return <>{children}</>;
}