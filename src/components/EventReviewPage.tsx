import { useState, useRef, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import {
  CheckCircle,
  Camera,
  Send,
  Sparkles,
  MessageSquare,
  HelpCircle,
  Loader2,
  Image,
  Eye,
  AlertCircle,
  ArrowRight,
} from 'lucide-react';
import { supabase, EF_URL } from '../lib/supabase';
import {
  HandoverEvent,
  DisambiguationQuestion,
  DisambiguationOption,
  FollowUpQuestion,
} from '../lib/types';
import { resolveEvent } from '../lib/shift-utils';
import { errorMessageFor } from '../lib/error-messages';

interface LocationState {
  handoverId: string;
  events: HandoverEvent[];
  disambiguationQuestions: DisambiguationQuestion[];
  followUpQuestions: FollowUpQuestion[];
  correctedTranscript: string;
  inheritedCount?: number;
}

// Normaliza el texto de una pregunta para comparaciones insensibles a mayúsculas/espacios
const normalizeQuestion = (text: string) => text.trim().toLowerCase();

// Normaliza opciones de desambiguación: acepta strings (respuestas viejas del LLM)
// o el formato nuevo { asset_id, tag, nombre } que resuelve la EF.
const normalizeDisambiguationOptions = (opts: unknown[]): DisambiguationOption[] =>
  (opts || []).map((opt) => {
    if (typeof opt === 'string') {
      return { tag: opt, asset_id: opt };
    }
    const o = (opt || {}) as Record<string, unknown>;
    return {
      asset_id: typeof o.asset_id === 'string' ? o.asset_id : undefined,
      tag: typeof o.tag === 'string' ? o.tag : String(o.asset_id ?? ''),
      nombre: typeof o.nombre === 'string' ? o.nombre : undefined,
    };
  });

const normalizeDisambiguationQuestions = (qs: unknown[]): DisambiguationQuestion[] =>
  (qs || []).map((q) => {
    const raw = (q || {}) as Record<string, unknown>;
    return {
      question: typeof raw.question === 'string' ? raw.question : '',
      options: normalizeDisambiguationOptions((raw.options || []) as unknown[]),
      resolved_asset_id:
        typeof raw.resolved_asset_id === 'string' ? raw.resolved_asset_id : undefined,
    };
  });

export default function EventReviewPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const state = location.state as LocationState | null;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [attachingToEventId, setAttachingToEventId] = useState<string | null>(null);

  const [events, setEvents] = useState<HandoverEvent[]>(state?.events || []);
  const [dQuestions, setDQuestions] = useState<DisambiguationQuestion[]>(
    state?.disambiguationQuestions || []
  );
  const [fQuestions, setFQuestions] = useState<FollowUpQuestion[]>(
    state?.followUpQuestions || []
  );
  const [loading, setLoading] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [photoUploading, setPhotoUploading] = useState<string | null>(null);
  const [completed, setCompleted] = useState(false);

  // CHANGE 1 — New state
  const [error, setError] = useState<string | null>(null);
  const [noMoreInfo, setNoMoreInfo] = useState(false);
  const [pendingSubmit, setPendingSubmit] = useState(false);
  const [additionalNotes, setAdditionalNotes] = useState<string[]>([]);
  const [noteDraft, setNoteDraft] = useState('');
  const [followUpDrafts, setFollowUpDrafts] = useState<Record<number, string>>({});

  // Task 12 — Track photo-analysis failures per event
  const [photoAnalysisErrors, setPhotoAnalysisErrors] = useState<Record<string, true>>({});

  // Task 13 — Respect prefers-reduced-motion
  const [reducedMotion, setReducedMotion] = useState(false);

  // Modal states
  const [photoPreview, setPhotoPreview] = useState<{ url: string; analysis: string } | null>(null);
  const [confirmModal, setConfirmModal] = useState<{ message: string; onConfirm: () => void } | null>(null);

  // Set de preguntas ya respondidas en esta sesión — evita que el LLM repita
  const answeredQuestionsRef = useRef<Set<string>>(new Set());

  // Sembrar el set con preguntas ya respondidas desde el estado inicial
  useEffect(() => {
    const seen = answeredQuestionsRef.current;
    for (const q of dQuestions) {
      if (q.resolved_asset_id && q.question) seen.add(normalizeQuestion(q.question));
    }
    for (const q of fQuestions) {
      if (q.answer && q.question) seen.add(normalizeQuestion(q.question));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Task 13 — Check prefers-reduced-motion on mount
  useEffect(() => {
    setReducedMotion(window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }, []);

  const handoverId = state?.handoverId || '';
  const correctedTranscript = state?.correctedTranscript || '';
  const inheritedCount = state?.inheritedCount || 0;

  // CHANGE 2 — Stop auto-firing re-extraction (resolveDisambiguation)
  const resolveDisambiguation = async (qIdx: number, selectedOption: string) => {
    const updatedQuestions = [...dQuestions];
    updatedQuestions[qIdx] = {
      ...updatedQuestions[qIdx],
      resolved_asset_id: selectedOption,
    };
    setDQuestions(updatedQuestions);

    // Registrar la pregunta como respondida para no repetirla en rondas siguientes
    const question = updatedQuestions[qIdx]?.question;
    if (question) answeredQuestionsRef.current.add(normalizeQuestion(question));

    // Solo marcar pendiente — el operador decide cuándo re-enviar
    if (!updatedQuestions.every((q) => q.resolved_asset_id)) return;
    setPendingSubmit(true);
  };

  // CHANGE 2 — Stop auto-firing re-extraction (answerFollowUp)
  const answerFollowUp = async (qIdx: number, answer: string) => {
    const updatedQuestions = [...fQuestions];
    updatedQuestions[qIdx] = { ...updatedQuestions[qIdx], answer };
    setFQuestions(updatedQuestions);

    // Registrar la pregunta como respondida para no repetirla en rondas siguientes
    const question = updatedQuestions[qIdx]?.question;
    if (question) answeredQuestionsRef.current.add(normalizeQuestion(question));

    // Solo marcar pendiente — el operador decide cuándo re-enviar
    setPendingSubmit(true);
  };

  // CHANGE 4 + 5 — reExtractWithNotes (real implementation)
  const reExtractWithNotes = async (
    disambigQs: DisambiguationQuestion[],
    followUpQs: FollowUpQuestion[],
    notes: string[]
  ) => {
    setLoading(true);
    setError(null);

    // Construir transcript enriquecido con respuestas
    let enrichedTranscript = correctedTranscript;
    for (const q of disambigQs) {
      if (q.resolved_asset_id) {
        enrichedTranscript += `\n[Desambiguación: "${q.question}" → Asset ID: ${q.resolved_asset_id}]`;
      }
    }

    // CHANGE 4 — Carry operator notes as synthetic answered questions
    const notesAsAnswers = notes.map((text, i) => ({
      question: `Información adicional del operador #${i + 1}`,
      answer: text,
    }));
    const allFollowUps = [...followUpQs, ...notesAsAnswers];

    for (const q of allFollowUps) {
      if (q.answer) {
        enrichedTranscript += `\n[Seguimiento: "${q.question}" → "${q.answer}"]`;
      }
    }

    try {
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
          corrected_transcript: enrichedTranscript,
          agent_disambiguation: disambigQs.map((q) => ({
            question: q.question,
            options: q.options,
            resolved: q.resolved_asset_id,
          })),
          agent_follow_up: allFollowUps.map((q) => ({
            question: q.question,
            answer: q.answer,
          })),
        }),
      });

      const data = await res.json();

      // CHANGE 5 — Fix silent error handling
      if (!res.ok) {
        console.error('extract-events failed:', res.status, data);
        setError(errorMessageFor(data.error));
        return;
      }

      setError(null);
      setPendingSubmit(false);
      if (Array.isArray(data.events) && data.events.length > 0) {
        setEvents(data.events);
      }

      // Merge defensivo: descartar preguntas ya respondidas en rondas anteriores
      const seen = answeredQuestionsRef.current;
      const newDQuestions = normalizeDisambiguationQuestions(
        data.disambiguation_questions || []
      ).filter(
        (q: DisambiguationQuestion) =>
          !q.question || !seen.has(normalizeQuestion(q.question))
      );
      const newFQuestions = (data.follow_up_questions || []).filter(
        (q: FollowUpQuestion) =>
          !q.question || !seen.has(normalizeQuestion(q.question))
      );
      setDQuestions(newDQuestions);
      setFQuestions(newFQuestions);
    } catch (err) {
      console.error('extract-events network error:', err);
      setError('No se pudo conectar con el servidor. Revisa tu conexión e intenta de nuevo.');
    } finally {
      setLoading(false);
    }
  };

  // CHANGE 7 — reExtract as thin wrapper
  const reExtract = (disambigQs: DisambiguationQuestion[], followUpQs: FollowUpQuestion[]) =>
    reExtractWithNotes(disambigQs, followUpQs, additionalNotes);

  // CHANGE 7 — handleNoMoreInfo
  const handleNoMoreInfo = async () => {
    const unanswered =
      dQuestions.filter((q) => !q.resolved_asset_id).length +
      fQuestions.filter((q) => !q.answer).length;

    if (unanswered > 0) {
      // Use custom confirmation modal instead of native window.confirm
      return new Promise<void>((resolve) => {
        setConfirmModal({
          message: `Quedan ${unanswered} pregunta(s) sin responder. ¿Cerrar el traspaso de todas formas?`,
          onConfirm: async () => {
            setConfirmModal(null);
            if (pendingSubmit) {
              await reExtract(dQuestions, fQuestions);
            }
            setNoMoreInfo(true);
            resolve();
          },
        });
      });
    }

    if (pendingSubmit) {
      await reExtract(dQuestions, fQuestions);
    }
    setNoMoreInfo(true);
  };

  // Adjuntar foto a un evento
  const attachPhoto = async (eventId: string, file: File) => {
    setPhotoUploading(eventId);

    const timestamp = Date.now();
    const ext = file.name.split('.').pop() || 'jpg';
    const contentType = file.type || `image/${ext}`;
    const filePath = `photos/${eventId}/${timestamp}.${ext}`;

    const { error: uploadError } = await supabase.storage
      .from('photos')
      .upload(filePath, file, { contentType });

    if (uploadError) {
      setPhotoUploading(null);
      return;
    }

    const publicUrl = `${supabase.storage.from('photos').getPublicUrl(filePath).data.publicUrl}`;

    // Add photo URL to the event immediately
    const currentUrls = events.find((e) => e.id === eventId)?.photo_urls || [];
    const { error: updateError } = await supabase
      .from('events')
      .update({ photo_urls: [...currentUrls, publicUrl] })
      .eq('id', eventId);

    if (!updateError) {
      setEvents((prev) =>
        prev.map((e) =>
          e.id === eventId
            ? { ...e, photo_urls: [...currentUrls, publicUrl] }
            : e
        )
      );

      // Analyze photo with vision — call EF in photo-analysis mode (NO duplicate events)
      const event = events.find((e) => e.id === eventId);
      const eventContext = [
        event?.event_type ? `Tipo: ${event.event_type}` : '',
        event?.criticality ? `Criticidad: ${event.criticality}` : '',
        event?.action_taken ? `Acción: ${event.action_taken}` : '',
      ].filter(Boolean).join(', ');
      const analysisTranscript = correctedTranscript ||
        events.map((e) => e.action_taken).filter(Boolean).join('. ');

      try {
        const { data: { session } } = await supabase.auth.getSession();
        const token = session?.access_token;

        const res = await fetch(`${EF_URL}/extract-events`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
          },
          body: JSON.stringify({
            action: 'analyze_photo',
            handover_id: handoverId,
            event_id: eventId,
            photo_url: publicUrl,
            event_context: eventContext,
            corrected_transcript: analysisTranscript,
          }),
        });

        if (res.ok) {
          const data = await res.json();
          if (data.photo_analysis) {
            setEvents((prev) =>
              prev.map((e) =>
                e.id === eventId
                  ? { ...e, photo_analysis: data.photo_analysis }
                  : e
              )
            );
            // Also persist photo_analysis to DB
            await supabase
              .from('events')
              .update({ photo_analysis: data.photo_analysis })
              .eq('id', eventId);
          }
        }
      } catch {
        // Task 12 — Show inline error instead of silent fail
        setPhotoAnalysisErrors(prev => ({ ...prev, [eventId]: true }));
      }
    }

    setPhotoUploading(null);
  };

  // Confirmar reporte final — el operador vuelve a su panel (sesión compartida en tablet)
  const confirmReport = async () => {
    setConfirming(true);

    // Marcar handover como complete — verify row was actually updated (RLS can silently return 0 rows)
    const { data: updatedHandover, error: updateError } = await supabase
      .from('handovers')
      .update({ status: 'complete' })
      .eq('id', handoverId)
      .select('id')
      .single();

    if (updateError || !updatedHandover) {
      console.error('Failed to complete handover:', updateError, 'handover:', handoverId);
      setConfirming(false);
      return;
    }

    // SPV-19 — Generar SIEMPRE el resumen al finalizar, aunque queden preguntas sin responder.
    // El resumen corre en background: la pantalla de éxito no debe esperar al LLM.
    void (async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession();
        const token = session?.access_token;
        const enrichedTranscript =
          correctedTranscript +
          dQuestions
            .filter((q) => q.resolved_asset_id)
            .map((q) => `\n[Desambiguación: "${q.question}" → Asset ID: ${q.resolved_asset_id}]`)
            .join('') +
          [...fQuestions, ...additionalNotes.map((text, i) => ({
            question: `Información adicional del operador #${i + 1}`,
            answer: text,
          }))]
            .filter((q) => q.answer)
            .map((q) => `\n[Seguimiento: "${q.question}" → "${q.answer}"]`)
            .join('');

        await fetch(`${EF_URL}/extract-events`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
          },
          body: JSON.stringify({
            finalize: true,
            handover_id: handoverId,
            corrected_transcript: enrichedTranscript,
            agent_disambiguation: dQuestions.map((q) => ({
              question: q.question,
              options: q.options,
              resolved: q.resolved_asset_id,
            })),
            agent_follow_up: [...fQuestions, ...additionalNotes.map((text, i) => ({
              question: `Información adicional del operador #${i + 1}`,
              answer: text,
            }))].map((q) => ({ question: q.question, answer: q.answer })),
          }),
        });
      } catch (err) {
        // No bloqueante: el traspaso ya está completo; el resumen es best-effort
        console.error('Finalize summary call failed (non-blocking):', err);
      }
    })();

    setCompleted(true);
  };

  if (completed) {
    const confettiPieces = !reducedMotion ? Array.from({ length: 24 }, (_, i) => {
      const colors = ['bg-accent', 'bg-success', 'bg-warning', 'bg-danger'];
      const color = colors[i % colors.length];
      const left = `${Math.random() * 100}%`;
      const delay = `${Math.random() * 0.8}s`;
      const size = 6 + Math.random() * 8;
      const rotation = Math.random() * 360;
      return { key: i, color, left, delay, size, rotation };
    }) : [];

    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] text-center relative overflow-hidden">
        {/* Confetti pieces (Task 13) */}
        {confettiPieces.map(p => (
          <div
            key={p.key}
            className={`absolute top-0 ${p.color} rounded-sm opacity-0`}
            style={{
              left: p.left,
              width: `${p.size}px`,
              height: `${p.size * 0.6}px`,
              transform: `rotate(${p.rotation}deg)`,
              animation: `confetti-fall 1.5s ease-out ${p.delay} forwards`,
            }}
          />
        ))}
        <div className="animate-fade-in">
          <div className="w-24 h-24 rounded-full bg-success/20 flex items-center justify-center mb-6">
            <CheckCircle size={56} className="text-success" />
          </div>
          <h2 className="text-2xl font-bold text-text-primary mb-2">
            ¡Traspaso completado!
          </h2>
          <p className="text-text-muted mb-8 max-w-sm">
            El reporte ha sido guardado y los eventos quedan registrados para el próximo turno.
          </p>
          <button
            onClick={() => navigate('/home')}
            className="btn-primary text-lg px-10 py-4"
          >
            Volver al inicio
          </button>
        </div>
      </div>
    );
  }

  if (!handoverId) {
    return (
      <div className="text-center py-12">
        <p className="text-text-muted">No hay datos de eventos para revisar.</p>
        <button onClick={() => navigate('/home')} className="btn-secondary mt-4">
          Volver al inicio
        </button>
      </div>
    );
  }

  const criticalityColors: Record<string, string> = {
    alta: 'bg-danger text-white',
    media: 'bg-warning text-black',
    baja: 'bg-success text-black',
  };

  const eventTypeLabels: Record<string, string> = {
    falla: 'Falla',
    alarma: 'Alarma',
    mantenimiento: 'Mantenimiento',
    parada: 'Parada',
    riesgo: 'Riesgo',
    pendiente: 'Pendiente',
  };

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex items-center gap-3">
        <Sparkles size={24} className="text-accent" />
        <div>
          <h1 className="text-xl font-bold text-text-primary">
            Revisión de eventos
          </h1>
          <p className="text-text-muted text-xs mt-0.5">
            Revisa, corrige y confirma los eventos extraídos
          </p>
        </div>
      </div>

      {/* Inherited events toast */}
      {inheritedCount > 0 && (
        <div className="flex items-center gap-2 p-4 rounded-xl bg-warning/10 border border-warning/30 animate-fade-in">
          <ArrowRight size={18} className="text-warning shrink-0" />
          <p className="text-sm text-text-primary">
            {inheritedCount} evento{inheritedCount !== 1 ? 's' : ''} pendiente{inheritedCount !== 1 ? 's' : ''} heredado{inheritedCount !== 1 ? 's' : ''} del turno anterior
          </p>
        </div>
      )}

      {loading && (
        <div className="card flex items-center justify-center gap-3 py-6">
          <Loader2 size={20} className="text-accent animate-spin" />
          <span className="text-text-secondary">Procesando respuestas...</span>
        </div>
      )}

      {/* CHANGE 8 — Error banner (after loading, before disambiguation) */}
      {error && !loading && (
        <div className="flex items-start gap-3 p-4 rounded-xl bg-danger-dim border border-danger/30">
          <AlertCircle size={20} className="text-danger shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="text-text-primary text-sm">{error}</p>
            <button onClick={() => reExtract(dQuestions, fQuestions)} className="btn-secondary text-sm mt-3">
              Reintentar
            </button>
          </div>
        </div>
      )}

      {/* Preguntas de desambiguación */}
      {dQuestions.length > 0 && !loading && (
        <div className="card border-accent/30">
          <div className="flex items-center gap-2 mb-3">
            <HelpCircle size={18} className="text-accent" />
            <h3 className="text-sm font-bold text-accent uppercase tracking-wider">
              Desambiguación necesaria
            </h3>
          </div>
          {dQuestions.map((q, idx) => (
            <div key={idx} className="mb-3 last:mb-0">
              {!q.resolved_asset_id && (
                <>
                  <p className="text-text-primary text-sm mb-2">{q.question}</p>
                  <div className="flex flex-wrap gap-2">
                    {q.options.map((opt) => (
                      <button
                        key={opt.asset_id ?? opt.tag}
                        onClick={() => resolveDisambiguation(idx, opt.asset_id ?? opt.tag)}
                        className="btn-secondary text-sm py-3 px-4"
                      >
                        {opt.nombre ?? opt.tag}
                      </button>
                    ))}
                  </div>
                </>
              )}
              {q.resolved_asset_id && (
                <div className="flex items-center gap-2 text-sm text-success">
                  <CheckCircle size={16} />
                  <span>Resuelto: {(q.options.find(o => o.asset_id === q.resolved_asset_id || o.tag === q.resolved_asset_id)?.nombre || '')} {(q.options.find(o => o.asset_id === q.resolved_asset_id || o.tag === q.resolved_asset_id)?.nombre ? '— ' : '')}{q.options.find(o => o.asset_id === q.resolved_asset_id || o.tag === q.resolved_asset_id)?.tag || q.resolved_asset_id}</span>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* CHANGE 3 — Show ALL pending follow-up questions at once */}
      {fQuestions.length > 0 && !loading && (
        <div className="card border-warning/30">
          <div className="flex items-center gap-2 mb-3">
            <MessageSquare size={18} className="text-warning" />
            <h3 className="text-sm font-bold text-warning uppercase tracking-wider">
              Preguntas de seguimiento ({fQuestions.filter((q) => q.answer).length}/{fQuestions.length})
            </h3>
          </div>
          <div className="space-y-4">
            {fQuestions.map((q, idx) => (
              <div key={idx}>
                <p className="text-text-primary text-sm mb-2">{q.question}</p>
                {q.answer ? (
                  <div className="flex items-center gap-2 text-sm text-success">
                    <CheckCircle size={16} />
                    <span>{q.answer}</span>
                  </div>
                ) : (
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={followUpDrafts[idx] ?? ''}
                      onChange={(e) =>
                        setFollowUpDrafts((prev) => ({ ...prev, [idx]: e.target.value }))
                      }
                      className="input-field flex-1"
                      placeholder="Escribe tu respuesta..."
                    />
                    <button
                      onClick={() => {
                        const text = (followUpDrafts[idx] ?? '').trim();
                        if (!text) return;
                        answerFollowUp(idx, text);
                        setFollowUpDrafts((prev) => ({ ...prev, [idx]: '' }));
                      }}
                      className="btn-primary"
                      disabled={!(followUpDrafts[idx] ?? '').trim()}
                    >
                      <Send size={18} />
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Eventos extraídos */}
      <div>
        <h3 className="text-sm font-bold text-text-muted uppercase tracking-wider mb-3">
          Eventos extraídos ({events.length})
        </h3>

        {events.length === 0 && !loading && (
          <div className="card text-center py-8">
            <p className="text-text-muted">No se extrajeron eventos del traspaso.</p>
          </div>
        )}

        <div className="space-y-3">
          {events.map((event) => (
            <div key={event.id} className="card">
              <div className="flex items-start justify-between mb-3">
                <div className="flex items-center gap-2">
                  <span
                    className={`text-xs font-bold px-2 py-0.5 rounded-full ${
                      criticalityColors[event.criticality ?? 'media']
                    }`}
                  >
                    {(event.criticality ?? 'media').toUpperCase()}
                  </span>
                  <span className="text-sm font-bold text-text-primary capitalize">
                    {eventTypeLabels[event.event_type] || event.event_type || 'Evento'}
                  </span>
                </div>
                <div className="flex items-center gap-1">
                  {event.status === 'abierto' && (
                    <button
                      onClick={async () => {
                        const ok = await resolveEvent(event.id);
                        if (ok) {
                          setEvents((prev) =>
                            prev.map((e) =>
                              e.id === event.id
                                ? { ...e, status: 'resuelto', needs_followup: false }
                                : e
                            )
                          );
                        }
                      }}
                      className="btn-ghost text-xs text-success flex items-center gap-1"
                    >
                      <CheckCircle size={14} />
                      Resolver
                    </button>
                  )}
                </div>
              </div>

              {event.action_taken && (
                <p className="text-sm text-text-secondary mb-2">{event.action_taken}</p>
              )}

              {(event.photo_urls?.length ?? 0) > 0 && (
                <div className="mb-3">
                  <div className="flex items-center gap-2 mb-1">
                    <Image size={14} className="text-text-muted" />
                    <span className="text-xs text-text-muted font-medium">FOTOS</span>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {event.photo_urls?.map((url, i) => (
                      <div key={i} className="relative group">
                        <img
                          src={url}
                          alt={`Foto ${i + 1}`}
                          className="w-20 h-20 rounded-lg object-cover border border-border"
                        />
                        {event.photo_analysis && (
                          <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity rounded-lg flex items-center justify-center cursor-pointer"
                            onClick={() => setPhotoPreview({ url, analysis: event.photo_analysis! })}
                          >
                            <Eye size={20} className="text-white" />
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                  {event.photo_analysis && (
                    <p className="text-xs text-text-muted mt-2 italic">
                      {event.photo_analysis}
                    </p>
                  )}
                  {photoAnalysisErrors[event.id] && !event.photo_analysis && (
                    <p className="text-xs text-warning mt-1">No se pudo analizar la foto</p>
                  )}
                </div>
              )}

              <div className="flex gap-2">
                <button
                  onClick={() => {
                    setAttachingToEventId(event.id);
                    fileInputRef.current?.click();
                  }}
                  disabled={photoUploading === event.id}
                  className="btn-ghost text-xs flex items-center gap-1 text-text-muted"
                >
                  {photoUploading === event.id ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : (
                    <Camera size={14} />
                  )}
                  {photoUploading === event.id ? 'Subiendo...' : 'Adjuntar foto'}
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Global hidden file input for photo attachment */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          const targetId = attachingToEventId;
          if (file && targetId) {
            attachPhoto(targetId, file);
          }
          setAttachingToEventId(null);
          e.target.value = '';
        }}
      />

      {/* CHANGE 6 — Operator-controlled completion card */}
      {!noMoreInfo && !loading && (
        <div className="card border-accent/30">
          <div className="flex items-center gap-2 mb-3">
            <MessageSquare size={18} className="text-accent" />
            <h3 className="text-sm font-bold text-accent uppercase tracking-wider">
              ¿Algo más que reportar?
            </h3>
          </div>

          {dQuestions.length === 0 && fQuestions.length === 0 && (
            <p className="text-text-muted text-sm mb-3">
              No quedan preguntas pendientes. Puedes añadir información adicional o cerrar el traspaso.
            </p>
          )}

          {additionalNotes.length > 0 && (
            <ul className="mb-3 space-y-1">
              {additionalNotes.map((note, i) => (
                <li key={i} className="flex items-start gap-2 text-sm text-success">
                  <CheckCircle size={16} className="shrink-0 mt-0.5" />
                  <span>{note}</span>
                </li>
              ))}
            </ul>
          )}

          <textarea
            value={noteDraft}
            onChange={(e) => setNoteDraft(e.target.value)}
            className="input-field w-full min-h-[80px] resize-none mb-3"
            placeholder="Añade cualquier novedad que no se haya capturado..."
          />

          <div className="flex flex-col sm:flex-row gap-3">
            <button
              onClick={async () => {
                const text = noteDraft.trim();
                if (!text) return;
                const nextNotes = [...additionalNotes, text];
                setAdditionalNotes(nextNotes);
                setNoteDraft('');
                await reExtractWithNotes(dQuestions, fQuestions, nextNotes);
              }}
              disabled={!noteDraft.trim()}
              className="btn-secondary flex-1 flex items-center justify-center gap-2 py-4"
            >
              <Send size={18} />
              Añadir información
            </button>

            <button
              onClick={handleNoMoreInfo}
              className="btn-primary flex-1 flex items-center justify-center gap-2 py-4"
            >
              <CheckCircle size={18} />
              No hay más novedades
            </button>
          </div>

          {pendingSubmit && (
            <p className="text-text-muted text-xs mt-3">
              Tienes respuestas sin enviar. Se enviarán al pulsar cualquiera de los dos botones.
            </p>
          )}
        </div>
      )}

      {/* CHANGE 8 — Gate confirm button on operator's explicit decision */}
      {noMoreInfo && !loading && (
        <>
          <button
            onClick={() => setNoMoreInfo(false)}
            className="btn-ghost w-full text-sm text-text-muted"
          >
            Volver a añadir información
          </button>

          <button
            onClick={confirmReport}
            disabled={confirming}
            className="btn-primary w-full text-lg flex items-center justify-center gap-3 py-5"
          >
            {confirming ? (
              <Loader2 size={24} className="animate-spin" />
            ) : (
              <>
                <CheckCircle size={24} />
                Confirmar reporte
              </>
            )}
          </button>
        </>
      )}

      {/* Photo preview modal */}
      {photoPreview && (
        <div className="fixed inset-0 z-[100] bg-black/80 flex items-center justify-center p-4" onClick={() => setPhotoPreview(null)}>
          <div className="max-w-lg w-full bg-bg-card rounded-2xl overflow-hidden" onClick={(e) => e.stopPropagation()}>
            <img src={photoPreview.url} alt="Foto" className="w-full max-h-[50vh] object-contain bg-black" />
            <div className="p-4">
              <p className="text-sm text-text-primary">{photoPreview.analysis}</p>
            </div>
            <div className="px-4 pb-4">
              <button onClick={() => setPhotoPreview(null)} className="btn-secondary w-full text-sm">
                Cerrar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Confirmation modal */}
      {confirmModal && (
        <div className="fixed inset-0 z-[100] bg-black/60 flex items-center justify-center p-4">
          <div className="bg-bg-card border border-border rounded-2xl p-6 max-w-sm w-full text-center animate-fade-in">
            <div className="w-14 h-14 rounded-full bg-warning/20 flex items-center justify-center mx-auto mb-4">
              <AlertCircle size={28} className="text-warning" />
            </div>
            <p className="text-text-primary text-sm mb-6">{confirmModal.message}</p>
            <div className="flex gap-3">
              <button
                onClick={() => setConfirmModal(null)}
                className="btn-secondary flex-1 text-sm py-3"
              >
                Cancelar
              </button>
              <button
                onClick={confirmModal.onConfirm}
                className="btn-primary flex-1 text-sm py-3"
              >
                Confirmar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}