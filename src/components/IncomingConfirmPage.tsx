import { useState, useEffect } from 'react';
import { CheckCircle, AlertTriangle, Clock, Sparkles, ChevronDown, ChevronUp } from 'lucide-react';
import { Profile, Handover, HandoverEvent } from '../lib/types';
import { supabase } from '../lib/supabase';
import { getPendingAcknowledgment, getOpenEventsForHandover } from '../lib/shift-utils';

interface IncomingConfirmPageProps {
  user: Profile;
  onConfirmed: () => void;
}

export default function IncomingConfirmPage({ user, onConfirmed }: IncomingConfirmPageProps) {
  const [pending, setPending] = useState<{
    handover: Handover;
  } | null>(null);
  const [events, setEvents] = useState<HandoverEvent[]>([]);
  const [comment, setComment] = useState('');
  const [loading, setLoading] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const [transcriptOpen, setTranscriptOpen] = useState(false);

  // SPV-22 — Buscar el traspaso pendiente MÁS ANTIGUO entre todas las áreas
  const findNextPending = async (): Promise<{
    handover: Handover;
    events: HandoverEvent[];
  } | null> => {
    const areas = ['Línea 1', 'Línea 2', 'Sala Eléctrica', 'Utilities'];
    const candidates: { handover: Handover; events: HandoverEvent[] }[] = [];
    for (const area of areas) {
      const result = await getPendingAcknowledgment(area, user.id);
      if (result) {
        const openEvents = await getOpenEventsForHandover(result.handover.id);
        candidates.push({ handover: result.handover, events: openEvents });
      }
    }
    if (candidates.length === 0) return null;
    candidates.sort(
      (a, b) =>
        new Date(a.handover.created_at).getTime() -
        new Date(b.handover.created_at).getTime()
    );
    return candidates[0];
  };

  useEffect(() => {
    let mounted = true;
    const checkAllAreas = async () => {
      const next = await findNextPending();
      if (!mounted) return;
      if (next) {
        setPending({ handover: next.handover });
        setEvents(next.events);
      }
      setLoading(false);
    };

    checkAllAreas();
    return () => {
      mounted = false;
    };
  }, [user.id]);

  // When loading finishes and no pending handover exists,
  // immediately dismiss the confirm screen so the operator
  // sees the home page instead of a blank white screen.
  useEffect(() => {
    if (!loading && !pending) {
      onConfirmed();
    }
  }, [loading, pending, onConfirmed]);

  const handleConfirm = async () => {
    if (!pending) return;
    setConfirming(true);

    const { error: ackError } = await supabase.from('acknowledgments').insert({
      handover_id: pending.handover.id,
      receiving_user_id: user.id,
      timestamp: new Date().toISOString(),
      comment: comment || null,
    });

    if (!ackError) {
      // Set incoming_operator_id on the handover (per PRD: "se llena al confirmar")
      await supabase
        .from('handovers')
        .update({ incoming_operator_id: user.id })
        .eq('id', pending.handover.id);

      // SPV-22 — Presentar el siguiente traspaso sin confirmar, si existe
      const next = await findNextPending();
      if (next) {
        setPending({ handover: next.handover });
        setEvents(next.events);
        setComment('');
        setTranscriptOpen(false);
      } else {
        onConfirmed();
      }
    }
    setConfirming(false);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="w-8 h-8 border-2 border-accent border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!pending) return null;

  const journeyLabels: Record<string, string> = {
    mañana: 'Mañana',
    tarde: 'Tarde',
    noche: 'Noche',
  };

  return (
    <div className="animate-fade-in space-y-6">
      {/* Bloque banner */}
      <div className="flex items-start gap-3 p-4 rounded-xl bg-danger-dim border border-danger/30">
        <AlertTriangle size={28} className="text-danger shrink-0 mt-0.5" />
        <div>
          <h2 className="text-lg font-bold text-text-primary">
            Traspaso pendiente de confirmación
          </h2>
          <p className="text-text-secondary text-sm mt-1">
            Debes confirmar la recepción del traspaso anterior antes de iniciar tu turno.
          </p>
        </div>
      </div>

      {/* Resumen del handover anterior */}
      <div className="card space-y-4">
        <h3 className="text-base font-semibold text-text-primary">
          Traspaso de turno anterior
        </h3>

        <div className="grid grid-cols-2 gap-3 text-sm">
          <div className="flex items-center gap-2 text-text-secondary">
            <Clock size={16} />
            <span>
              {new Date(pending.handover.shift_time).toLocaleDateString('es-ES', {
                day: 'numeric',
                month: 'short',
                year: 'numeric',
              })}
            </span>
          </div>
          <div className="flex items-center gap-2 text-text-secondary">
            <Clock size={16} />
            <span>{journeyLabels[pending.handover.journey]}</span>
          </div>
          <div className="flex items-center gap-2 text-text-secondary">
            <span className="font-medium">Área:</span>
            <span>{pending.handover.area}</span>
          </div>
          <div className="flex items-center gap-2 text-text-secondary">
            <span className="font-medium">Estado:</span>
            <span className="text-success">Completado</span>
          </div>
        </div>

         {/* Resumen IA — contenido principal */}
        <div className="rounded-lg border border-accent/20 bg-accent/5 p-3">
          <div className="flex items-center gap-2 mb-2">
            <Sparkles size={16} className="text-accent" />
            <p className="text-xs font-bold text-accent uppercase tracking-wider">
              Resumen del turno
            </p>
          </div>
          {pending.handover.summary ? (
            <p className="text-sm text-text-primary leading-relaxed">
              {pending.handover.summary}
            </p>
          ) : (
            <p className="text-xs text-text-muted italic">
              Resumen no disponible para este traspaso
            </p>
          )}
        </div>

        {/* Transcripción completa — colapsada si hay resumen */}
        {pending.handover.corrected_transcript && (
          <div className="border-t border-border pt-3">
            <button
              onClick={() => setTranscriptOpen((v) => !v)}
              className="text-xs font-medium text-accent flex items-center gap-1.5 cursor-pointer hover:text-accent/80 transition-colors"
              aria-expanded={transcriptOpen}
            >
              {transcriptOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
              {transcriptOpen ? 'Ocultar transcripción completa' : 'Ver transcripción completa'}
            </button>
            {(transcriptOpen || !pending.handover.summary) && (
              <div className="mt-3 bg-bg-secondary rounded-lg p-3 max-h-64 overflow-y-auto">
                <p className="text-sm text-text-secondary leading-relaxed whitespace-pre-wrap">
                  {pending.handover.corrected_transcript}
                </p>
              </div>
            )}
          </div>
        )}

        {/* Eventos abiertos */}
        {events.length > 0 && (
          <div>
            <p className="text-xs text-text-muted font-medium mb-2">
              EVENTOS PENDIENTES ({events.length})
            </p>
            <div className="space-y-2">
              {events.map((event) => (
                <div
                  key={event.id}
                  className="flex items-center gap-2 bg-bg-elevated rounded-lg px-3 py-2 text-sm"
                >
                  <span
                    className={`w-2 h-2 rounded-full ${
                      event.criticality === 'alta'
                        ? 'bg-danger'
                        : event.criticality === 'media'
                          ? 'bg-warning'
                          : 'bg-success'
                    }`}
                  />
                  <span className="text-text-primary font-medium capitalize">
                    {event.event_type}
                  </span>
                  <span className="text-text-muted">·</span>
                  <span className="text-text-secondary truncate">
                    {event.action_taken || 'Sin descripción'}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Comentario opcional */}
      <div>
        <label className="block text-sm font-medium text-text-secondary mb-1.5">
          Comentario (opcional)
        </label>
        <textarea
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          className="input-field resize-none"
          rows={3}
          placeholder="Agrega un comentario sobre el traspaso..."
        />
      </div>

      {/* Botón de confirmación */}
      <button
        onClick={handleConfirm}
        disabled={confirming}
        className="btn-primary w-full text-lg flex items-center justify-center gap-3 py-5"
      >
        {confirming ? (
          <span className="w-6 h-6 border-2 border-black border-t-transparent rounded-full animate-spin" />
        ) : (
          <>
            <CheckCircle size={24} />
            Confirmar recepción
          </>
        )}
      </button>
    </div>
  );
}
