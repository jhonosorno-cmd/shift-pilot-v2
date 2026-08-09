import { useState, useEffect, Fragment, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Mic, History, AlertTriangle, ArrowRight, RefreshCw, Loader2, ChevronDown, ChevronUp, Sparkles } from 'lucide-react';
import { Profile, Handover, HandoverEvent } from '../lib/types';
import { supabase, EF_URL } from '../lib/supabase';
import { getLatestCompleteHandover, getOpenEventsForHandover, getShiftsOpen } from '../lib/shift-utils';

const AREAS = ['Línea 1', 'Línea 2', 'Sala Eléctrica', 'Utilities'];
const JOURNEYS = [
  { value: 'mañana', label: 'Mañana' },
  { value: 'tarde', label: 'Tarde' },
  { value: 'noche', label: 'Noche' },
] as const;

interface HomePageProps {
  user: Profile;
}

interface InheritedEventWithShifts extends HandoverEvent {
  shifts_open: number;
}

export default function HomePage({ user }: HomePageProps) {
  const navigate = useNavigate();
  const [area, setArea] = useState('Línea 1');
  const [journey, setJourney] = useState<'mañana' | 'tarde' | 'noche'>('mañana');
  const [history, setHistory] = useState<Handover[]>([]);
  const [inheritedEvents, setInheritedEvents] = useState<InheritedEventWithShifts[]>([]);
  const [loading, setLoading] = useState(true);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [expandedHandover, setExpandedHandover] = useState<string | null>(null);
  const [expandedEvents, setExpandedEvents] = useState<HandoverEvent[]>([]);
  const [expandedTranscript, setExpandedTranscript] = useState<string | null>(null);
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const [expandingLoading, setExpandingLoading] = useState(false);
  const summaryPollsRef = useRef(0);

  useEffect(() => {
    loadData();
  }, [user.id, area]);

  // Re-fetch on window focus / visibility change (Task 14)
  useEffect(() => {
    let mounted = true;
    const refresh = () => {
      if (document.visibilityState === 'visible' && mounted) loadData(true);
    };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      mounted = false;
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [user.id, area]);

  // El resumen IA lo escribe la Edge Function 20-40 s después de finalizar el
  // traspaso. Sondeamos en silencio hasta que llegue (máx. 12 intentos ≈ 60 s).
  useEffect(() => {
    const needsSummary = history.some(
      (h) =>
        h.status === 'complete' &&
        !h.summary &&
        Date.now() - new Date(h.created_at).getTime() < 10 * 60 * 1000
    );
    if (!needsSummary || summaryPollsRef.current >= 12) return;

    const timer = setTimeout(() => {
      summaryPollsRef.current += 1;
      loadData(true);
    }, 5000);

    return () => clearTimeout(timer);
  }, [history]);

  const loadHandoverDetail = async (handoverId: string) => {
    if (expandedHandover === handoverId) {
      setExpandedHandover(null);
      setExpandedEvents([]);
      setExpandedTranscript(null);
      setTranscriptOpen(false);
      return;
    }
    setExpandedHandover(handoverId);
    setExpandingLoading(true);
    // Transcripción colapsada por defecto: el resumen IA es el contenido principal
    setTranscriptOpen(false);

    // Load transcript
    const { data: handoverData } = await supabase
      .from('handovers')
      .select('corrected_transcript, raw_transcript')
      .eq('id', handoverId)
      .single();

    setExpandedTranscript(
      (handoverData?.corrected_transcript || handoverData?.raw_transcript || null)
    );

    // Load events — also fetch from event_shift_trail for inherited events (Task 11)
    const { data: currentEvents } = await supabase
      .from('events')
      .select('*')
      .eq('current_handover_id', handoverId);

    // Also get events that were part of this handover via shift trail
    const { data: trailRows } = await supabase
      .from('event_shift_trail')
      .select('event_id')
      .eq('handover_id', handoverId);

    let mergedEvents: HandoverEvent[] = (currentEvents || []) as HandoverEvent[];

    if (trailRows && trailRows.length > 0) {
      const existingIds = new Set(mergedEvents.map(e => e.id));
      const trailEventIds = trailRows
        .map(r => r.event_id)
        .filter(id => !existingIds.has(id));
      if (trailEventIds.length > 0) {
        const { data: trailEvents } = await supabase
          .from('events')
          .select('*')
          .in('id', trailEventIds);
        if (trailEvents) {
          mergedEvents = [...mergedEvents, ...(trailEvents as HandoverEvent[])];
        }
      }
    }

    // Sort by created_at descending
    mergedEvents.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

    setExpandedEvents(mergedEvents);
    setExpandingLoading(false);
  };

  const getEventStats = (events: HandoverEvent[]) => {
    const total = events.length;
    const alta = events.filter(e => e.criticality === 'alta').length;
    const media = events.filter(e => e.criticality === 'media').length;
    const baja = events.filter(e => e.criticality === 'baja').length;
    const abierto = events.filter(e => e.status === 'abierto').length;
    const resuelto = events.filter(e => e.status === 'resuelto').length;
    const needsFollowup = events.filter(e => e.needs_followup).length;
    return { total, alta, media, baja, abierto, resuelto, needsFollowup };
  };

  const retryTranscription = async (handoverId: string, recordingUrl: string | null) => {
    if (!recordingUrl) {
      setRetryError('No hay grabación disponible para reintentar.');
      return;
    }
    setRetrying(handoverId);
    setRetryError(null);

    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;

      const submitRes = await fetch(`${EF_URL}/transcribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ action: 'submit', handover_id: handoverId, recording_path: recordingUrl }),
      });
      const submitData = await submitRes.json();
      if (!submitRes.ok) throw new Error(submitData.error || 'Error al enviar transcripción');

      // Poll until done
      for (let attempt = 0; attempt < 200; attempt++) {
        await new Promise((r) => setTimeout(r, 3000));
        const pollRes = await fetch(`${EF_URL}/transcribe`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
          body: JSON.stringify({ action: 'poll', handover_id: handoverId }),
        });
        if (!pollRes.ok) {
          const errData = await pollRes.json().catch(() => ({}));
          throw new Error(errData.error || 'Error al verificar transcripción');
        }
        const pollData = await pollRes.json() as { status: string; transcript?: string; detail?: string };
        if (pollData.status === 'done') {
          navigate('/review', { state: { handoverId } });
          return;
        }
        if (pollData.status === 'error') throw new Error(pollData.detail || 'La transcripción falló');
      }
      throw new Error('La transcripción está tomando más de lo esperado.');
    } catch (err: unknown) {
      setRetryError(err instanceof Error ? err.message : 'Error al reintentar');
    } finally {
      setRetrying(null);
    }
  };

  const loadData = async (silent = false) => {
    if (!silent) setLoading(true);

    // Cargar historial de handovers propios
    const { data: myHandovers } = await supabase
      .from('handovers')
      .select('*')
      .eq('operator_id', user.id)
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .limit(10);

    if (myHandovers) setHistory(myHandovers as Handover[]);

    // Cargar eventos heredados del último handover completo en el área
    const latest = await getLatestCompleteHandover(area);
    if (latest && latest.operator_id !== user.id) {
      const openEvents = await getOpenEventsForHandover(latest.id);
      const withShifts: InheritedEventWithShifts[] = [];
      for (const event of openEvents) {
        const shifts = await getShiftsOpen(event.id);
        withShifts.push({ ...event, shifts_open: shifts });
      }
      setInheritedEvents(withShifts);
    } else {
      setInheritedEvents([]);
    }

    if (!silent) setLoading(false);
  };

  const startRecording = () => {
    navigate('/record', { state: { area, journey } });
  };

  const getCriticalityColor = (c: string) => {
    switch (c) {
      case 'alta': return 'bg-danger';
      case 'media': return 'bg-warning';
      default: return 'bg-success';
    }
  };

  const statusLabels: Record<string, { text: string; color: string }> = {
    processing: { text: 'Procesando', color: 'text-warning' },
    review: { text: 'En revisión', color: 'text-accent' },
    complete: { text: 'Completado', color: 'text-success' },
    error: { text: 'Error', color: 'text-danger' },
  };

  const journeyLabels: Record<string, string> = {
    mañana: 'Mañana',
    tarde: 'Tarde',
    noche: 'Noche',
  };

  const eventTypeLabels: Record<string, string> = {
    falla: 'Falla', alarma: 'Alarma', mantenimiento: 'Mantenimiento',
    parada: 'Parada', riesgo: 'Riesgo', pendiente: 'Pendiente',
  };

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-text-primary">
          Hola, {user.nombre}
        </h1>
        <p className="text-text-muted text-sm mt-1">
          {user.rol === 'supervisor' ? 'Panel de supervisor' : 'Panel de operador'}
        </p>
      </div>

      {/* Area & Journey selectors */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs text-text-muted font-medium mb-1.5">ÁREA</label>
          <select
            value={area}
            onChange={(e) => setArea(e.target.value)}
            className="select-field"
          >
            {AREAS.map((a) => (
              <option key={a} value={a}>{a}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs text-text-muted font-medium mb-1.5">JORNADA</label>
          <select
            value={journey}
            onChange={(e) => setJourney(e.target.value as 'mañana' | 'tarde' | 'noche')}
            className="select-field"
          >
            {JOURNEYS.map((j) => (
              <option key={j.value} value={j.value}>{j.label}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Botón grabar */}
      <button
        onClick={startRecording}
        className="w-full py-8 px-6 rounded-2xl bg-gradient-to-b from-accent/20 to-accent/5 border-2 border-accent/40 hover:border-accent/70 transition-all duration-200 group cursor-pointer"
      >
        <div className="flex flex-col items-center gap-3">
          <div className="w-20 h-20 rounded-full bg-accent flex items-center justify-center group-hover:scale-105 transition-transform">
            <Mic size={36} className="text-black" />
          </div>
          <span className="text-xl font-bold text-text-primary">
            Grabar traspaso de turno
          </span>
          <span className="text-sm text-text-muted">
            {area} · {journeyLabels[journey]}
          </span>
        </div>
      </button>

      {/* Eventos heredados con alerta */}
      {inheritedEvents.length > 0 && (
        <div className="card border-warning/30 bg-warning/5">
          <div className="flex items-center gap-2 mb-3">
            <AlertTriangle size={18} className="text-warning" />
            <h3 className="text-sm font-bold text-text-primary uppercase tracking-wider">
              Eventos pendientes heredados
            </h3>
          </div>
          <div className="space-y-2">
            {inheritedEvents.map((event) => (
              <div
                key={event.id}
                className={`flex items-center justify-between bg-bg-elevated rounded-lg p-3 ${
                  event.shifts_open >= 3 ? 'border border-danger/40 bg-danger/5' : ''
                }`}
              >
                <div className="flex items-center gap-3 min-w-0">
                  <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${getCriticalityColor(event.criticality)}`} />
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-text-primary capitalize truncate">
                      {event.event_type}
                    </p>
                    <p className="text-xs text-text-muted truncate">
                      {event.action_taken || 'Sin descripción'}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className={`text-xs font-bold px-2 py-1 rounded-full ${
                    event.shifts_open >= 3
                      ? 'bg-danger/20 text-danger'
                      : 'bg-warning/20 text-warning'
                  }`}>
                    {event.shifts_open} turno{event.shifts_open !== 1 ? 's' : ''}
                  </span>
                  {event.shifts_open >= 3 && (
                    <AlertTriangle size={16} className="text-danger" />
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Historial */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <History size={16} className="text-text-muted" />
          <h3 className="text-sm font-bold text-text-muted uppercase tracking-wider">
            Historial de traspasos
          </h3>
        </div>

        {loading ? (
          <div className="flex justify-center py-8">
            <div className="w-6 h-6 border-2 border-accent border-t-transparent rounded-full animate-spin" />
          </div>
        ) : history.length === 0 ? (
          <div className="card text-center py-8">
            <p className="text-text-muted text-sm">
              Aún no has realizado ningún traspaso.
            </p>
            <p className="text-text-muted text-xs mt-1">
              Presiona el botón "Grabar traspaso de turno" para comenzar.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {history.map((h) => {
              const statusInfo = statusLabels[h.status];
              const isInformational = h.status === 'complete' || h.status === 'error';
              return (
                <Fragment key={h.id}>
                  <div
                    className="card flex items-center justify-between cursor-pointer hover:bg-bg-elevated"
                    onClick={() => {
                      if (isInformational) {
                        loadHandoverDetail(h.id);
                      } else if (h.status === 'review') {
                        navigate('/review', { state: { handoverId: h.id } });
                      } else if (h.status === 'processing') {
                        navigate('/review', { state: { handoverId: h.id } });
                      }
                    }}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm text-text-primary font-medium">
                          {h.area}
                        </span>
                        <span className="text-xs text-text-muted">·</span>
                        <span className="text-xs text-text-muted">
                          {journeyLabels[h.journey]}
                        </span>
                      </div>
                      <p className="text-xs text-text-muted mt-0.5">
                        {new Date(h.created_at).toLocaleDateString('es-ES', {
                          day: 'numeric',
                          month: 'short',
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className={`text-xs font-medium ${statusInfo?.color}`}>
                        {statusInfo?.text}
                      </span>
                      {isInformational ? (
                        expandedHandover === h.id ? <ChevronUp size={16} className="text-accent" /> : <ChevronDown size={16} className="text-text-muted" />
                      ) : h.status === 'error' ? (
                        <RefreshCw size={16} className="text-danger" />
                      ) : (
                        <ArrowRight size={16} className="text-text-muted" />
                      )}
                    </div>
                  </div>
                  {/* Inline expanded detail for informational statuses */}
                  {isInformational && expandedHandover === h.id && (
                    <div className="card border-border/50 animate-fade-in">
                      {expandingLoading ? (
                        <div className="flex items-center justify-center py-4">
                          <div className="w-5 h-5 border-2 border-accent border-t-transparent rounded-full animate-spin" />
                        </div>
                      ) : (
                        <div className="space-y-3">
                          {/* AI Summary — contenido principal (SPV-21) */}
                          <div className="card border-accent/20 bg-accent/5">
                            <div className="flex items-center gap-2 mb-2">
                              <Sparkles size={16} className="text-accent" />
                              <p className="text-xs font-bold text-accent uppercase tracking-wider">
                                Resumen del turno
                              </p>
                            </div>
                            {h.summary ? (
                              <p className="text-sm text-text-primary leading-relaxed">{h.summary}</p>
                            ) : (
                              <p className="text-xs text-text-muted italic">Resumen no disponible para este traspaso</p>
                            )}
                          </div>

                          {/* Stats summary */}
                          <div className="flex items-center gap-3 flex-wrap">
                            <span className="text-xs font-bold text-text-muted">Resumen</span>
                            <span className="text-xs text-text-muted">{getEventStats(expandedEvents).total} eventos</span>
                            <span className="text-xs px-2 py-0.5 rounded-full bg-danger/20 text-danger">{getEventStats(expandedEvents).alta} alta</span>
                            <span className="text-xs px-2 py-0.5 rounded-full bg-warning/20 text-warning">{getEventStats(expandedEvents).media} media</span>
                            <span className="text-xs px-2 py-0.5 rounded-full bg-success/20 text-success">{getEventStats(expandedEvents).baja} baja</span>
                          </div>

                          {/* Transcripción completa tras toggle colapsable — oculta por defecto (SPV-21) */}
                          {expandedTranscript && (
                            <div className="border-t border-border pt-3">
                              <button
                                onClick={() => setTranscriptOpen((v) => !v)}
                                className="text-xs font-medium text-accent flex items-center gap-1.5 cursor-pointer hover:text-accent/80 transition-colors"
                                aria-expanded={transcriptOpen}
                              >
                                {transcriptOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                                {transcriptOpen ? 'Ocultar transcripción completa' : 'Ver transcripción completa'}
                              </button>
                              {transcriptOpen && (
                                <div className="mt-3 bg-bg-secondary rounded-lg p-3 max-h-64 overflow-y-auto">
                                  <p className="text-xs text-text-secondary leading-relaxed whitespace-pre-wrap">
                                    {expandedTranscript}
                                  </p>
                                </div>
                              )}
                            </div>
                          )}

                          {/* Events list compact */}
                          {expandedEvents.length > 0 && (
                            <div className="space-y-1">
                              <p className="text-xs text-text-muted font-medium">EVENTOS</p>
                              {expandedEvents.slice(0, 5).map(ev => (
                                <div key={ev.id} className="flex items-center gap-2 text-xs">
                                  <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${ev.criticality === 'alta' ? 'bg-danger' : ev.criticality === 'media' ? 'bg-warning' : 'bg-success'}`} />
                                  <span className="text-text-primary capitalize">{eventTypeLabels[ev.event_type] || ev.event_type}</span>
                                  <span className="text-text-muted">·</span>
                                  <span className="text-text-secondary truncate">{ev.action_taken || '—'}</span>
                                  {ev.current_handover_id !== h.id && (
                                    <span className="text-xs px-1.5 py-0.5 rounded-full bg-accent/20 text-accent ml-1 shrink-0">heredado</span>
                                  )}
                                </div>
                              ))}
                              {expandedEvents.length > 5 && (
                                <p className="text-xs text-text-muted">...y {expandedEvents.length - 5} más</p>
                              )}
                            </div>
                          )}

                          {expandedEvents.length === 0 && !expandedTranscript && (
                            <p className="text-xs text-text-muted">Sin eventos ni transcripción disponible.</p>
                          )}

                          {/* Retry button for error handovers — inside expanded panel (Task 9) */}
                          {h.status === 'error' && (
                            <div className="pt-2 border-t border-border">
                              <button
                                onClick={() => retryTranscription(h.id, h.recording_url || null)}
                                disabled={retrying === h.id}
                                className="btn-secondary text-sm flex items-center gap-2 py-2 px-4"
                              >
                                {retrying === h.id ? (
                                  <Loader2 size={16} className="animate-spin" />
                                ) : (
                                  <RefreshCw size={16} />
                                )}
                                {retrying === h.id ? 'Reintentando...' : 'Reintentar transcripción'}
                              </button>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </Fragment>
              );
            })}
          </div>
        )}
      </div>

      {/* Retry error toast */}
      {retryError && (
        <div className="fixed bottom-4 right-4 z-50 flex items-center gap-2 bg-danger-dim border border-danger/40 shadow-lg rounded-xl px-4 py-3 text-sm text-text-primary animate-fade-in">
          <AlertTriangle size={16} className="text-danger shrink-0" />
          <span>{retryError}</span>
          <button onClick={() => setRetryError(null)} className="text-text-muted ml-2 hover:text-text-primary">&times;</button>
        </div>
      )}
    </div>
  );
}