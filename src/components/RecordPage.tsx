import { useState, useRef, useCallback, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Mic, Square, Upload, AlertCircle, Loader2 } from 'lucide-react';
import { supabase, EF_URL } from '../lib/supabase';
import { convertBlobToWav } from '../lib/audio-utils';

const MAX_DURATION_MS = 10 * 60 * 1000; // 10 min

export default function RecordPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { area, journey } = (location.state as { area?: string; journey?: string }) || {};

  const [mediaRecorder, setMediaRecorder] = useState<MediaRecorder | null>(null);
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [converting, setConverting] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progressMsg, setProgressMsg] = useState<string | null>(null);

  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTimeRef = useRef<number>(0);
  const streamRef = useRef<MediaStream | null>(null);
  const pollingActiveRef = useRef(true);

  const cleanup = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    setRecording(false);
    setElapsed(0);
  }, []);

  useEffect(() => {
    return cleanup;
  }, [cleanup]);

  useEffect(() => {
    return () => { pollingActiveRef.current = false; };
  }, []);
  
  const formatTime = (ms: number) => {
    const mins = Math.floor(ms / 60000);
    const secs = Math.floor((ms % 60000) / 1000);
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  const startRecording = async () => {
    try {
      setError(null);
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      // Prefer webm/opus for Speechmatics
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm';

      const recorder = new MediaRecorder(stream, { mimeType });
      chunksRef.current = [];
      setMediaRecorder(recorder);

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      recorder.onstop = async () => {
        const webmBlob = new Blob(chunksRef.current, { type: mimeType });

        try {
          // 0. Convert webm → 16 kHz mono 16-bit WAV (Speechmatics doesn't support webm)
          setConverting(true);
          setProgressMsg('Procesando audio...');
          const wavBlob = await convertBlobToWav(webmBlob);
          setConverting(false);

          setUploading(true);
          setProgressMsg('Subiendo audio...');

          const { data: { user } } = await supabase.auth.getUser();
          if (!user) throw new Error('Not authenticated');

          // 1. Generate handover id on the client
          const handoverId = crypto.randomUUID();
          const timestamp = Date.now();
          const filePath = `${user.id}/${timestamp}.wav`;

          // 2. Upload WAV to Storage FIRST (before the INSERT, so recording_url
          //    is written in the single INSERT statement and there is no separate
          //    UPDATE that could silently fail due to RLS)
          const { error: uploadError } = await supabase.storage
            .from('recordings')
            .upload(filePath, wavBlob, {
              contentType: 'audio/wav',
              upsert: false,
            });

          if (uploadError) throw uploadError;

          // 3. Insert handover with explicit id AND recording_url in one statement
          const { data: handover, error: hError } = await supabase
            .from('handovers')
            .insert({
              id: handoverId,
              operator_id: user.id,
              shift_time: new Date().toISOString(),
              journey: journey || 'mañana',
              area: area || 'Línea 1',
              status: 'processing',
              recording_url: filePath,
            })
            .select()
            .single();

          if (hError || !handover) throw new Error('No se pudo crear el traspaso');

          // 4. Transcribe — recording_url is already in the row from step 3
          //    Inheritance is handled by the extract-events Edge Function
          setUploading(false);
          setTranscribing(true);
          setProgressMsg('Enviando a transcripción...');

          const { data: { session } } = await supabase.auth.getSession();
          const token = session?.access_token;

          const submitRes = await fetch(`${EF_URL}/transcribe`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${token}`,
            },
            body: JSON.stringify({
              action: 'submit',
              handover_id: handover.id,
              recording_path: filePath,
            }),
          });

          const submitData = await submitRes.json();
          if (!submitRes.ok) {
            throw new Error(submitData.error || 'Error al enviar transcripción');
          }

          // Poll until transcription completes
          setProgressMsg('Transcribiendo audio...');
          let pollResult: { status: string; transcript?: string; confidence?: number; detail?: string; error?: string } | null = null;

          // ~10 min max (200 x 3s) — covers long recordings
          pollingActiveRef.current = true;
          for (let attempt = 0; attempt < 200 && pollingActiveRef.current; attempt++) {
            await new Promise((r) => setTimeout(r, 3000));

            const pollRes = await fetch(`${EF_URL}/transcribe`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`,
              },
              body: JSON.stringify({ action: 'poll', handover_id: handover.id }),
            });

            if (!pollRes.ok) {
              const errData = await pollRes.json().catch(() => ({}));
              throw new Error(errData.error || 'Error al verificar transcripción');
            }

            const pollData = (await pollRes.json()) as { status: string; transcript?: string; confidence?: number; detail?: string; error?: string };
            pollResult = pollData;

            if (pollData.status === 'done') break;
            if (pollData.status === 'error') throw new Error(pollData.detail || pollData.error || 'La transcripción falló');
            // If still processing, continue polling
          }

          if (!pollResult || pollResult.status !== 'done') {
            throw new Error('La transcripción está tomando más de lo esperado. Vuelve a intentarlo.');
          }

          setTranscribing(false);
          navigate('/review', {
            state: {
              handoverId: handover.id,
              transcript: pollResult.transcript,
              confidence: pollResult.confidence,
            },
          });
        } catch (err: unknown) {
          setConverting(false);
          setUploading(false);
          setTranscribing(false);
          setProgressMsg(null);
          setError(
            err instanceof Error ? err.message : 'Ocurrió un error inesperado'
          );
        }
      };

      recorder.start(1000); // Collect data every second
      setRecording(true);
      startTimeRef.current = Date.now();

      timerRef.current = setInterval(() => {
        const elapsed = Date.now() - startTimeRef.current;
        setElapsed(elapsed);
        if (elapsed >= MAX_DURATION_MS) {
          recorder.stop();
          cleanup();
        }
      }, 100);
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'NotAllowedError') {
        setError('Permiso de micrófono denegado. Por favor, permite el acceso al micrófono.');
      } else {
        setError(
          err instanceof Error ? err.message : 'No se pudo iniciar la grabación'
        );
      }
    }
  };

  const stopRecording = () => {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop();
    }
    cleanup();
  };

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="text-center">
        <h1 className="text-2xl font-bold text-text-primary">
          Grabar traspaso
        </h1>
        <p className="text-text-muted text-sm mt-1">
          {area || 'Área no seleccionada'} · {journey || 'Jornada no seleccionada'}
        </p>
      </div>

      {/* Recording indicator */}
      <div className="flex flex-col items-center py-8">
        <div
          className={`w-40 h-40 rounded-full flex items-center justify-center transition-all duration-300 ${
            recording
              ? 'bg-danger/20 border-4 border-danger animate-pulse-record'
              : 'bg-bg-card border-4 border-border'
          }`}
        >
          {recording ? (
            <Square size={48} className="text-danger" />
          ) : (
            <Mic size={48} className="text-text-muted" />
          )}
        </div>

        {/* Timer */}
        <div className="mt-6">
          <span className={`text-5xl font-mono font-bold tabular-nums ${
            recording ? 'text-danger' : 'text-text-muted'
          }`}>
            {formatTime(elapsed)}
          </span>
        </div>
        <p className="text-text-muted text-xs mt-2">
          Máximo 10 minutos
        </p>
      </div>

      {/* Error message */}
      {error && (
        <div className="flex items-start gap-3 p-4 rounded-xl bg-danger-dim border border-danger/30">
          <AlertCircle size={20} className="text-danger shrink-0 mt-0.5" />
          <p className="text-text-primary text-sm">{error}</p>
        </div>
      )}

      {/* Progress */}
      {converting && (
        <div className="card flex items-center gap-3">
          <Loader2 size={20} className="text-accent animate-spin" />
          <p className="text-text-secondary text-sm">{progressMsg}</p>
        </div>
      )}
      {uploading && (
        <div className="card flex items-center gap-3">
          <Upload size={20} className="text-accent animate-pulse" />
          <p className="text-text-secondary text-sm">{progressMsg}</p>
        </div>
      )}
      {transcribing && (
        <div className="card flex items-center gap-3">
          <div className="w-5 h-5 border-2 border-accent border-t-transparent rounded-full animate-spin" />
          <p className="text-text-secondary text-sm">{progressMsg}</p>
        </div>
      )}

      {/* Controls */}
      <div className="flex justify-center gap-4">
        {!recording ? (
          <button
            onClick={startRecording}
            disabled={converting || uploading || transcribing}
            className="btn-primary text-lg flex items-center gap-3 py-5 px-10"
          >
            <Mic size={24} />
            Iniciar grabación
          </button>
        ) : (
          <button
            onClick={stopRecording}
            className="btn-danger text-lg flex items-center gap-3 py-5 px-10"
          >
            <Square size={24} />
            Detener grabación
          </button>
        )}
      </div>

      {!recording && !converting && !uploading && !transcribing && !error && (
        <p className="text-center text-text-muted text-xs">
          Al presionar "Iniciar grabación" se solicitará permiso para usar el micrófono.
        </p>
      )}
    </div>
  );
}