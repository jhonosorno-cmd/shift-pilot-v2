import { useState, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { FileText, ArrowRight, Sparkles, AlertCircle } from 'lucide-react';
import { supabase, EF_URL } from '../lib/supabase';
import { errorMessageFor } from '../lib/error-messages';

export default function ReviewTranscriptPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { handoverId, transcript: initialTranscript } =
    (location.state as { handoverId?: string; transcript?: string }) || {};

  const [transcript, setTranscript] = useState(initialTranscript || '');
  const [loading, setLoading] = useState(!initialTranscript && !!handoverId);
  const [extracting, setExtracting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load transcript from DB when navigated without state (e.g. from history)
  useEffect(() => {
    if (initialTranscript) return; // already have it
    if (!handoverId) return;

    const loadTranscript = async () => {
      setLoading(true);
      const { data, error } = await supabase
        .from('handovers')
        .select('raw_transcript, corrected_transcript')
        .eq('id', handoverId)
        .single();

      if (error) {
        setError('No se pudo cargar la transcripción. Inténtalo de nuevo.');
        setLoading(false);
        return;
      }

      if (data) {
        setTranscript(data.corrected_transcript || data.raw_transcript || '');
      }
      setLoading(false);
    };

    loadTranscript();
  }, [handoverId, initialTranscript]);

  const handleExtractEvents = async () => {
    if (!handoverId || !transcript.trim()) return;

    setExtracting(true);
    setError(null);

    try {
      // Save corrected transcript — verify row was actually updated (RLS can silently return 0 rows)
      const { data: updatedHandover, error: updateError } = await supabase
        .from('handovers')
        .update({ corrected_transcript: transcript })
        .eq('id', handoverId)
        .select('id')
        .single();

      if (updateError || !updatedHandover) {
        console.error('Failed to save corrected_transcript:', updateError, 'handover:', handoverId);
        throw new Error('No se pudo guardar (permisos). Contacta al supervisor.');
      }

      // Call extract-events Edge Function
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;

      const res = await fetch(`${EF_URL}/extract-events`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          handover_id: handoverId,
          corrected_transcript: transcript,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(errorMessageFor(data.error));
      }

      navigate('/events', {
        state: {
          handoverId,
          events: data.events || [],
          disambiguationQuestions: data.disambiguation_questions || [],
          followUpQuestions: data.follow_up_questions || [],
          correctedTranscript: transcript,
          inheritedCount: data.inherited_count || 0,
        },
      });
    } catch (err: unknown) {
      setError(
        err instanceof Error ? err.message : 'Error al extraer eventos'
      );
    } finally {
      setExtracting(false);
    }
  };

  if (!handoverId) {
    return (
      <div className="text-center py-12">
        <p className="text-text-muted">No se encontró un traspaso activo.</p>
        <button onClick={() => navigate('/home')} className="btn-secondary mt-4">
          Volver al inicio
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex items-center gap-3">
        <FileText size={24} className="text-accent" />
        <div>
          <h1 className="text-xl font-bold text-text-primary">
            Revisar transcripción
          </h1>
          <p className="text-text-muted text-xs mt-0.5">
            Corrige la transcripción antes de extraer los eventos
          </p>
        </div>
      </div>

      {/* Loading state */}
      {loading && (
        <div className="flex justify-center py-8">
          <div className="w-6 h-6 border-2 border-accent border-t-transparent rounded-full animate-spin" />
        </div>
      )}

      {/* Transcript editor */}
      <div className={`card p-1 ${loading ? 'opacity-50' : ''}`}>
        <textarea
          value={transcript}
          onChange={(e) => setTranscript(e.target.value)}
          className="w-full bg-transparent border-none outline-none resize-none text-text-primary text-base leading-relaxed p-4 min-h-[250px] placeholder:text-text-muted/50"
          placeholder="La transcripción aparecerá aquí..."
          rows={12}
        />
      </div>

      {error && (
        <div className="flex items-start gap-3 p-4 rounded-xl bg-danger-dim border border-danger/30">
          <AlertCircle size={20} className="text-danger shrink-0 mt-0.5" />
          <p className="text-text-primary text-sm">{error}</p>
        </div>
      )}

      {/* Actions */}
      <div className="flex flex-col gap-3">
        <button
          onClick={handleExtractEvents}
          disabled={extracting || !transcript.trim()}
          className="btn-primary w-full text-lg flex items-center justify-center gap-3 py-5"
        >
          {extracting ? (
            <>
              <div className="w-6 h-6 border-2 border-black border-t-transparent rounded-full animate-spin" />
              Extrayendo eventos...
            </>
          ) : (
            <>
              <Sparkles size={22} />
              Listo — Extraer eventos
            </>
          )}
        </button>

        <button
          onClick={() => navigate('/home')}
          className="btn-secondary w-full flex items-center justify-center gap-2"
        >
          <ArrowRight size={18} />
          Volver al inicio
        </button>
      </div>
    </div>
  );
}