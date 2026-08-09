import { useState, FormEvent } from 'react';
import { Mic } from 'lucide-react';

interface LoginPageProps {
  onLogin: (email: string, password: string) => Promise<boolean>;
  error?: string | null;
}

export default function LoginPage({ onLogin, error }: LoginPageProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);
    await onLogin(email, password);
    setLoading(false);
  };

  return (
    <div className="min-h-screen bg-bg-primary flex items-center justify-center p-4">
      <div className="w-full max-w-sm animate-fade-in">
        <div className="text-center mb-10">
          <div className="inline-flex items-center justify-center w-20 h-20 rounded-2xl bg-accent-dim mb-5">
            <Mic size={40} className="text-accent" />
          </div>
          <h1 className="text-3xl font-extrabold text-text-primary tracking-tight">
            ShiftPilot
          </h1>
          <p className="text-text-muted mt-2 text-sm">
            Sistema de traspaso de turno por voz
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="email" className="block text-sm font-medium text-text-secondary mb-1.5">
              Correo electrónico
            </label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="input-field"
              placeholder="operador@planta.com"
              required
              autoComplete="email"
              autoFocus
            />
          </div>

          <div>
            <label htmlFor="password" className="block text-sm font-medium text-text-secondary mb-1.5">
              Contraseña
            </label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="input-field"
              placeholder="••••••••"
              required
              autoComplete="current-password"
            />
          </div>

          {error && (
            <p className="text-danger text-sm text-center bg-danger-dim rounded-lg px-4 py-2">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={loading}
            className="btn-primary w-full text-lg flex items-center justify-center gap-2 mt-2"
          >
            {loading ? (
              <span className="w-5 h-5 border-2 border-black border-t-transparent rounded-full animate-spin" />
            ) : (
              'Iniciar sesión'
            )}
          </button>
        </form>

        <div className="mt-8 p-4 rounded-xl bg-bg-card border border-border">
          <p className="text-xs text-text-muted font-medium mb-2">CUENTAS DEMO</p>
          <div className="space-y-1 text-xs text-text-secondary">
            <p>Operador: <span className="font-mono text-text-primary">operador1@demo.com</span> / <span className="font-mono text-text-primary">demo123</span></p>
            <p>Supervisor: <span className="font-mono text-text-primary">supervisor@demo.com</span> / <span className="font-mono text-text-primary">demo123</span></p>
          </div>
        </div>
      </div>
    </div>
  );
}