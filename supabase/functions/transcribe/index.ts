import "jsr:@supabase/functions-js/edge-runtime.d.ts"

const SPEECHMATICS_API_KEY = Deno.env.get("SPEECHMATICS_API_KEY") ?? ""
const SPEECHMATICS_BATCH_URL = "https://asr.api.speechmatics.com/v2/jobs"
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? ""
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? ""

interface TranscribeRequest {
  action: "submit" | "poll" | "answer_submit" | "answer_poll"
  handover_id?: string
  audio_path?: string
  recording_path?: string
  job_id?: string
}

function corsHeaders(): HeadersInit {
  return { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization", "Content-Type": "application/json" }
}

async function verifyToken(token: string): Promise<boolean> {
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { Authorization: `Bearer ${token}`, apikey: SERVICE_ROLE_KEY } })
    return res.ok
  } catch { return false }
}

async function fetchSupabase<T>(path: string, options?: { method?: string; body?: Record<string, unknown> }): Promise<T> {
  const res = await fetch(`${SUPABASE_URL}${path}`, {
    method: options?.method ?? "GET",
    headers: { Authorization: `Bearer ${SERVICE_ROLE_KEY}`, apikey: SERVICE_ROLE_KEY, "Content-Type": "application/json", Prefer: "return=representation" },
    body: options?.body ? JSON.stringify(options.body) : undefined,
  })
  if (!res.ok) { const text = await res.text(); console.error("Supabase failed:", res.status, text); throw new Error(`Supabase error: ${res.status}`) }
  return res.json()
}

class RecordingUrlMissingError extends Error {
  detail: string
  constructor(detail: string) { super("recording_url_missing"); this.detail = detail }
}
class RecordingNotFoundError extends Error {
  detail: string
  constructor(detail: string) { super("storage_download_failed"); this.detail = detail }
}
class RecordingPermissionError extends Error {
  detail: string
  constructor(detail: string) { super("recording_permission_denied"); this.detail = detail }
}
class InvalidApiKeyError extends Error {}
class UnsupportedAudioError extends Error {
  detail: string
  constructor(detail: string) { super("Unsupported audio"); this.detail = detail }
}

/** Download audio from Supabase Storage using service role key + apikey header. */
async function downloadAudio(audioPath: string): Promise<{ arrayBuffer: ArrayBuffer; filename: string }> {
  const storageUrl = `${SUPABASE_URL}/storage/v1/object/recordings/${audioPath}`
  const audioRes = await fetch(storageUrl, {
    headers: { Authorization: `Bearer ${SERVICE_ROLE_KEY}`, apikey: SERVICE_ROLE_KEY },
  })

  if (audioRes.status === 404) {
    throw new RecordingNotFoundError(`No existe el objeto en storage: ${storageUrl}`)
  }
  if (audioRes.status === 403 || audioRes.status === 401) {
    throw new RecordingPermissionError(`Sin permisos para descargar: ${storageUrl} (status ${audioRes.status})`)
  }
  if (!audioRes.ok) {
    const errText = await audioRes.text().catch(() => "unknown")
    console.error("Audio download failed:", audioRes.status, errText, "for", storageUrl)
    throw new RecordingNotFoundError(`Storage download failed (${audioRes.status}): ${storageUrl}`)
  }

  const arrayBuffer = await audioRes.arrayBuffer()
  const filename = audioPath.split("/").pop() ?? "recording.wav"
  return { arrayBuffer, filename }
}

async function submitTranscription(
  handoverId: string,
  explicitPath?: string
): Promise<{ job_id: string }> {
  // Priority: explicitPath (from request body) > handovers.recording_url (DB fallback)
  let audioPath = explicitPath
  if (!audioPath) {
    const handovers = await fetchSupabase<{ id: string; recording_url: string | null }[]>(
      `/rest/v1/handovers?id=eq.${handoverId}&select=id,recording_url`
    )
    const handover = Array.isArray(handovers) ? handovers[0] : undefined
    audioPath = handover?.recording_url ?? undefined
  }
  if (!audioPath) {
    throw new RecordingUrlMissingError(
      `No hay ruta de audio disponible para handover ${handoverId}: ni recording_path en el body ni recording_url en la base de datos`
    )
  }

  const { arrayBuffer: audioBuffer, filename } = await downloadAudio(audioPath)
  // Ensure the filename ends in .wav so Speechmatics identifies the format correctly
  const wavFilename = filename.replace(/\.[^.]+$/, "") + ".wav"
  const audioBlob = new Blob([audioBuffer], { type: "audio/wav" })

  const formData = new FormData()
  formData.append("config", JSON.stringify({
    type: "transcription",
    transcription_config: { language: "es" },
  }))
  formData.append("data_file", audioBlob, wavFilename)

  const submitRes = await fetch(SPEECHMATICS_BATCH_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${SPEECHMATICS_API_KEY}` },
    body: formData,
  })

  if (submitRes.status === 401 || submitRes.status === 403) throw new InvalidApiKeyError()
  if (!submitRes.ok) {
    const errText = await submitRes.text().catch(() => "unknown")
    console.error("Speechmatics submission error:", submitRes.status, errText)
    throw new UnsupportedAudioError(`Speechmatics rejected job (status ${submitRes.status}): ${errText}`)
  }

  const data = await submitRes.json()
  const jobId: string = data.id
  if (!jobId) throw new Error("Speechmatics did not return a job ID")

  await fetchSupabase(`/rest/v1/handovers?id=eq.${handoverId}`, {
    method: "PATCH",
    body: { speechmatics_job_id: jobId, status: "processing" },
  })

  return { job_id: jobId }
}

interface TranscriptResult {
  type?: string
  alternatives?: { content?: string; confidence?: number }[]
}

interface PollResponse {
  httpStatus: number
  body: Record<string, unknown>
}

/** Reconstruye texto plano desde los resultados JSON de Speechmatics. */
function buildTranscriptFromResults(results: TranscriptResult[]): { transcript: string; confidence: number } {
  let rawTranscript = ""
  let wordCount = 0
  const wordConfidences: number[] = []
  for (const result of results) {
    const content = result.alternatives?.[0]?.content ?? ""
    if (!content) continue
    if (result.type === "punctuation") {
      rawTranscript += content
    } else {
      if (wordCount > 0) rawTranscript += " "
      rawTranscript += content
      wordCount++
      const confidence = result.alternatives?.[0]?.confidence
      if (typeof confidence === "number") wordConfidences.push(confidence)
    }
  }

  const avgConfidence =
    wordConfidences.length > 0
      ? wordConfidences.reduce((sum, c) => sum + c, 0) / wordConfidences.length
      : 0
  return { transcript: rawTranscript, confidence: avgConfidence }
}

async function pollTranscription(handoverId: string): Promise<PollResponse> {
  const handovers = await fetchSupabase<{ id: string; speechmatics_job_id: string | null }[]>(
    `/rest/v1/handovers?id=eq.${handoverId}&select=id,speechmatics_job_id`
  )
  const handover = Array.isArray(handovers) ? handovers[0] : undefined
  if (!handover?.speechmatics_job_id) {
    return { httpStatus: 409, body: { error: "no_job_submitted" } }
  }

  const jobRes = await fetch(`${SPEECHMATICS_BATCH_URL}/${handover.speechmatics_job_id}`, {
    headers: { Authorization: `Bearer ${SPEECHMATICS_API_KEY}` },
  })
  if (!jobRes.ok) {
    console.error("Speechmatics job status check failed:", jobRes.status, await jobRes.text())
    return { httpStatus: 502, body: { error: "Error al consultar estado de la transcripción" } }
  }

  const jobData = await jobRes.json()
  const jobStatus: string = jobData.job?.status ?? jobData.status ?? "unknown"

  if (jobStatus === "done" || jobStatus === "completed") {
    const transcriptRes = await fetch(
      `${SPEECHMATICS_BATCH_URL}/${handover.speechmatics_job_id}/transcript?format=json-v2`,
      { headers: { Authorization: `Bearer ${SPEECHMATICS_API_KEY}` } }
    )
    if (!transcriptRes.ok) {
      console.error("Speechmatics transcript fetch failed:", transcriptRes.status, await transcriptRes.text())
      return { httpStatus: 502, body: { error: "Error al obtener la transcripción" } }
    }

    const transcriptData = await transcriptRes.json()
    const { transcript: rawTranscript, confidence: avgConfidence } = buildTranscriptFromResults(
      (transcriptData.results ?? []) as TranscriptResult[]
    )

    await fetchSupabase(`/rest/v1/handovers?id=eq.${handoverId}`, {
      method: "PATCH",
      body: { raw_transcript: rawTranscript, transcript_confidence: avgConfidence, status: "review" },
    })

    return {
      httpStatus: 200,
      body: { status: "done", transcript: rawTranscript, confidence: avgConfidence },
    }
  }

  if (jobStatus === "rejected" || jobStatus === "deleted" || jobStatus === "expired") {
    console.error("Speechmatics job failed:", jobData)
    await fetchSupabase(`/rest/v1/handovers?id=eq.${handoverId}`, {
      method: "PATCH",
      body: { status: "error" },
    })
    const detail =
      (jobData.job?.detail as string | undefined) ??
      (jobData.job_data?.failure as string | undefined) ??
      JSON.stringify(jobData)
    return { httpStatus: 200, body: { status: "error", detail } }
  }

  return { httpStatus: 200, body: { status: "running" } }
}

/* ------------------------------------------------------------------ */
/*  Answer transcription — short voice replies to follow-up questions   */
/*  Same Speechmatics batch flow, but keyed by audio_path / job_id      */
/*  instead of the handover record (no DB writes).                      */
/* ------------------------------------------------------------------ */
async function submitAnswerTranscription(audioPath: string): Promise<{ job_id: string }> {
  const { arrayBuffer: audioBuffer, filename } = await downloadAudio(audioPath)
  // Ensure the filename ends in .wav so Speechmatics identifies the format correctly
  const wavFilename = filename.replace(/\.[^.]+$/, "") + ".wav"
  const audioBlob = new Blob([audioBuffer], { type: "audio/wav" })

  const formData = new FormData()
  formData.append("config", JSON.stringify({
    type: "transcription",
    transcription_config: { language: "es" },
  }))
  formData.append("data_file", audioBlob, wavFilename)

  const submitRes = await fetch(SPEECHMATICS_BATCH_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${SPEECHMATICS_API_KEY}` },
    body: formData,
  })

  if (submitRes.status === 401 || submitRes.status === 403) throw new InvalidApiKeyError()
  if (!submitRes.ok) {
    const errText = await submitRes.text().catch(() => "unknown")
    console.error("Speechmatics answer submission error:", submitRes.status, errText)
    throw new UnsupportedAudioError(`Speechmatics rejected job (status ${submitRes.status}): ${errText}`)
  }

  const data = await submitRes.json()
  const jobId: string = data.id
  if (!jobId) throw new Error("Speechmatics did not return a job ID")
  return { job_id: jobId }
}

async function pollAnswerTranscription(jobId: string): Promise<PollResponse> {
  const jobRes = await fetch(`${SPEECHMATICS_BATCH_URL}/${jobId}`, {
    headers: { Authorization: `Bearer ${SPEECHMATICS_API_KEY}` },
  })
  if (!jobRes.ok) {
    console.error("Speechmatics answer job status check failed:", jobRes.status, await jobRes.text())
    return { httpStatus: 502, body: { error: "Error al consultar estado de la transcripción" } }
  }

  const jobData = await jobRes.json()
  const jobStatus: string = jobData.job?.status ?? jobData.status ?? "unknown"

  if (jobStatus === "done" || jobStatus === "completed") {
    const transcriptRes = await fetch(
      `${SPEECHMATICS_BATCH_URL}/${jobId}/transcript?format=json-v2`,
      { headers: { Authorization: `Bearer ${SPEECHMATICS_API_KEY}` } }
    )
    if (!transcriptRes.ok) {
      console.error("Speechmatics answer transcript fetch failed:", transcriptRes.status, await transcriptRes.text())
      return { httpStatus: 502, body: { error: "Error al obtener la transcripción" } }
    }

    const transcriptData = await transcriptRes.json()
    const { transcript: rawTranscript, confidence: avgConfidence } = buildTranscriptFromResults(
      (transcriptData.results ?? []) as TranscriptResult[]
    )

    return {
      httpStatus: 200,
      body: { status: "done", transcript: rawTranscript, confidence: avgConfidence },
    }
  }

  if (jobStatus === "rejected" || jobStatus === "deleted" || jobStatus === "expired") {
    console.error("Speechmatics answer job failed:", jobData)
    const detail =
      (jobData.job?.detail as string | undefined) ??
      (jobData.job_data?.failure as string | undefined) ??
      JSON.stringify(jobData)
    return { httpStatus: 200, body: { status: "error", detail } }
  }

  return { httpStatus: 200, body: { status: "running" } }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() })
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: corsHeaders() })

  const authHeader = req.headers.get("Authorization") || ""
  const token = authHeader.replace(/^Bearer\s+/i, "")
  if (!token || !(await verifyToken(token))) {
    return new Response(JSON.stringify({ error: "Token de autenticación inválido" }), { status: 401, headers: corsHeaders() })
  }

  try {
    const body: TranscribeRequest = await req.json()

    // ---- ANSWER TRANSCRIPTION (short voice replies) ----
    if (body.action === "answer_submit") {
      if (!body.audio_path) {
        return new Response(JSON.stringify({ error: "Falta el campo requerido: audio_path" }), { status: 400, headers: corsHeaders() })
      }
      const result = await submitAnswerTranscription(body.audio_path)
      return new Response(JSON.stringify(result), { status: 200, headers: corsHeaders() })
    }

    if (body.action === "answer_poll") {
      if (!body.job_id) {
        return new Response(JSON.stringify({ error: "Falta el campo requerido: job_id" }), { status: 400, headers: corsHeaders() })
      }
      const result = await pollAnswerTranscription(body.job_id)
      return new Response(JSON.stringify(result.body), { status: result.httpStatus, headers: corsHeaders() })
    }

    // ---- MAIN TRANSCRIPTION ----
    if (!body.handover_id) {
      return new Response(JSON.stringify({ error: "Falta el campo requerido: handover_id" }), { status: 400, headers: corsHeaders() })
    }

    if (body.action === "poll") {
      const result = await pollTranscription(body.handover_id)
      return new Response(JSON.stringify(result.body), { status: result.httpStatus, headers: corsHeaders() })
    }

    if (body.action !== "submit") {
      return new Response(JSON.stringify({ error: `Acción desconocida: ${body.action}` }), { status: 400, headers: corsHeaders() })
    }

    // Use recording_path from body (preferred) or audio_path (legacy alias)
    const explicitPath = body.recording_path ?? body.audio_path
    const result = await submitTranscription(body.handover_id, explicitPath)
    return new Response(JSON.stringify(result), { status: 200, headers: corsHeaders() })
  } catch (err) {
    if (err instanceof RecordingUrlMissingError) {
      return new Response(JSON.stringify({ error: "recording_url_missing", detail: err.detail }), { status: 404, headers: corsHeaders() })
    }
    if (err instanceof RecordingNotFoundError) {
      return new Response(JSON.stringify({ error: "storage_download_failed", detail: err.detail }), { status: 502, headers: corsHeaders() })
    }
    if (err instanceof RecordingPermissionError) {
      return new Response(JSON.stringify({ error: "recording_permission_denied", detail: err.detail }), { status: 502, headers: corsHeaders() })
    }
    if (err instanceof InvalidApiKeyError) {
      return new Response(JSON.stringify({ error: "invalid_api_key" }), { status: 502, headers: corsHeaders() })
    }
    if (err instanceof UnsupportedAudioError) {
      return new Response(JSON.stringify({ error: "unsupported_audio", detail: err.detail }), { status: 422, headers: corsHeaders() })
    }
    console.error("Transcribe error:", err)
    return new Response(JSON.stringify({ error: "Error al procesar la transcripción. Intenta de nuevo." }), { status: 500, headers: corsHeaders() })
  }
})