import "jsr:@supabase/functions-js/edge-runtime.d.ts"

const FEATHERLESS_API_KEY = Deno.env.get("FEATHERLESS_API_KEY") ?? ""
const FEATHERLESS_URL = "https://api.featherless.ai/v1/chat/completions"
const MODEL = "deepseek-ai/DeepSeek-V4-Pro"
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? ""
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""

interface ExtractRequest {
  handover_id: string
  corrected_transcript: string
  photo_urls?: string[]
  agent_disambiguation?: { question: string; options: (string | { asset_id?: string | null; tag?: string; nombre?: string | null })[]; resolved?: string }[]
  agent_follow_up?: { question: string; answer?: string }[]
  finalize?: boolean
}
interface PhotoAnalysisRequest {
  action: "analyze_photo"
  handover_id: string
  event_id: string
  photo_url: string
  event_context: string
  corrected_transcript: string
}
interface AssetRef { id: string; tag: string; nombre: string; area: string; base_criticality: string; aliases?: string[] | null; asset_type?: string | null; parent_tag?: string | null }

class InvalidApiKeyError extends Error {}
class RateLimitedError extends Error {}
class ModelCallError extends Error {
  detail: string
  constructor(detail: string) { super("Model call failed"); this.detail = detail }
}
class InvalidModelOutputError extends Error {
  raw: string
  finishReason: string
  constructor(raw: string, finishReason: string) {
    super("Invalid model output"); this.raw = raw; this.finishReason = finishReason
  }
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
  if (!res.ok) { const text = await res.text(); console.error(`Supabase failed [${options?.method??"GET"} ${path}]:`, res.status, text); throw new Error(`Supabase error: ${res.status}`) }
  return res.json()
}

async function inheritOpenEvents(handoverId: string, area: string): Promise<{ count: number }> {
  // Safety net: inherit from ALL same-area handovers that aren't 'review' and aren't the current one
  // — this covers complete, processing, and error handovers with open events
  const previous = await fetchSupabase<Record<string, unknown>[]>(
    `/rest/v1/handovers?area=eq.${encodeURIComponent(area)}&status=neq.review&id=neq.${handoverId}&deleted_at=is.null&order=created_at.desc&limit=5&select=id`
  )
  if (!Array.isArray(previous) || previous.length === 0) return { count: 0 }
  let inherited = 0
  const alreadyProcessed = new Set<string>()
  for (const prev of previous) {
    const prevId = prev.id as string
    const events = await fetchSupabase<Record<string, unknown>[]>(
      `/rest/v1/events?current_handover_id=eq.${prevId}&status=eq.abierto&needs_followup=eq.true&select=id`
    )
    if (!Array.isArray(events)) continue
    for (const ev of events) {
      const eventId = ev.id as string
      if (alreadyProcessed.has(eventId)) continue
      alreadyProcessed.add(eventId)
      const trail = await fetchSupabase<Record<string, unknown>[]>(`/rest/v1/event_shift_trail?event_id=eq.${eventId}&select=shift_number&order=shift_number.desc&limit=1`)
      const nextShift = Array.isArray(trail) && trail.length > 0 ? (trail[0].shift_number as number) + 1 : 1
      await fetchSupabase(`/rest/v1/events?id=eq.${eventId}`, { method: "PATCH", body: { current_handover_id: handoverId } })
      await fetchSupabase("/rest/v1/event_shift_trail", { method: "POST", body: { event_id: eventId, handover_id: handoverId, shift_number: nextShift } })
      inherited++
    }
  }
  return { count: inherited }
}

function extractJsonObject(raw: string): string | null {
  let text = raw
  text = text.replace(/<think>[\s\S]*?<\/think>/gi, "")
  text = text.replace(/<think>[\s\S]*$/i, "")
  text = text.replace(/```(?:json)?/gi, "")
  const start = text.indexOf("{")
  if (start === -1) return null
  let depth = 0, inString = false, escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (escaped) { escaped = false; continue }
    if (ch === "\\") { escaped = true; continue }
    if (ch === '"') { inString = !inString; continue }
    if (inString) continue
    if (ch === "{") depth++
    else if (ch === "}") { depth--; if (depth === 0) return text.slice(start, i + 1) }
  }
  return null
}

async function callFeatherless(
  systemPrompt: string,
  userMsg: string,
  maxTokens = 4096,
  temperature = 0.1,
  useJsonMode = false
): Promise<{ content: string; finishReason: string }> {
  const payload: Record<string, unknown> = {
    model: MODEL,
    messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userMsg }],
    temperature,
    max_tokens: maxTokens,
  }
  if (useJsonMode) payload.response_format = { type: "json_object" }

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 60000)
  let response: Response
  try {
    response = await fetch(FEATHERLESS_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${FEATHERLESS_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
  } catch (err) {
    throw new ModelCallError(`timeout/network: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    clearTimeout(timeoutId)
  }

  if (response.status === 401 || response.status === 403) throw new InvalidApiKeyError()
  if (response.status === 429) throw new RateLimitedError()
  if (!response.ok) {
    const errText = await response.text()
    console.error("Featherless API error:", response.status, errText)
    if (response.status === 400 && useJsonMode) {
      console.warn("Retrying without response_format (provider rejected JSON mode)")
      return await callFeatherless(systemPrompt, userMsg, maxTokens, temperature, false)
    }
    throw new ModelCallError(`${response.status} ${errText.slice(0, 500)}`)
  }

  const data = await response.json()
  const choice = data.choices?.[0]
  const finishReason: string = choice?.finish_reason ?? "unknown"
  const content: string = choice?.message?.content ?? ""
  console.log("Featherless finish_reason:", finishReason, "content length:", content.length)
  if (!content) throw new InvalidModelOutputError("(empty content)", finishReason)
  return { content, finishReason }
}

async function analyzePhotoWithEventContext(photoUrl: string, eventContext: string, transcript: string): Promise<string | null> {
  try {
    const response = await fetch(FEATHERLESS_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${FEATHERLESS_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "user", content: [{ type: "text", text: `Describe en 2-3 oraciones lo que ves en esta foto industrial. Contexto: ${eventContext}` }, { type: "image_url", image_url: { url: photoUrl } }] }],
        temperature: 0.1, max_tokens: 256,
      }),
    })
    if (!response.ok) return null
    const data = await response.json()
    return data.choices?.[0]?.message?.content ?? null
  } catch { return null }
}

async function generateSummary(
  events: Record<string, unknown>[],
  correctedTranscript: string,
  assets: AssetRef[]
): Promise<string | null> {
  try {
    // Resolver asset_id contra el catálogo de activos para mostrar tag/nombre reales
    const assetById = new Map<string, AssetRef>()
    for (const a of assets) assetById.set(a.id, a)

    const eventsSummary = events.map((e, i) => {
      const asset = typeof e.asset_id === "string" ? assetById.get(e.asset_id) : undefined
      const assetLabel = asset ? `${asset.tag} (${asset.nombre})` : (typeof e.asset_id === "string" ? e.asset_id : "?")
      return `- Evento ${i + 1}: tipo="${e.event_type ?? "?"}", activo="${assetLabel}", criticidad="${e.criticality ?? "?"}", accion="${e.action_taken ?? "—"}", estado="${e.status ?? "?"}", seguimiento=${e.needs_followup ?? false}`
    }).join("\n")

    const systemPrompt = `Eres un asistente que resume traspasos de turno industrial en español.
Genera un resumen narrativo de 2 a 4 oraciones que describa de forma general el turno.
Debe incluir cuantos eventos ocurrieron, los mas relevantes (fallas criticas, pendientes, etc.) y el estado general.
Responde SOLO con el texto del resumen, sin JSON, sin markdown, sin introduccion.`

    const userMsg = `Transcripción corregida del turno:\n${correctedTranscript}\n\nEventos extraídos:\n${eventsSummary}\n\nGenera el resumen:`

    // 2048 tokens: el modelo es de razonamiento y puede gastar parte del
    // presupuesto en <think> antes de emitir el resumen (512 era insuficiente)
    const { content, finishReason } = await callFeatherless(systemPrompt, userMsg, 2048, 0.1, false)
    // Quitar bloques <think> residuales del modelo de razonamiento
    const cleaned = content
      .replace(/<think>[\s\S]*?<\/think>/gi, "")
      .replace(/<think>[\s\S]*$/i, "")
      .replace(/^["'\s]+|["'\s]+$/g, "")
      .trim()
    console.log(`Summary generated: length=${cleaned.length}, finish_reason=${finishReason}`)
    if (!cleaned) return null
    return cleaned
  } catch (err) {
    console.error("Summary generation failed (non-blocking):", err)
    return null
  }
}

interface DisambiguationOption { asset_id?: string | null; tag: string; nombre?: string | null }

function resolveDisambiguationOptions(
  questions: { question: string; options: string[] }[],
  assets: AssetRef[]
): { question: string; options: DisambiguationOption[] }[] {
  const byId = new Map<string, AssetRef>()
  const byTag = new Map<string, AssetRef>()
  for (const a of assets) {
    byId.set(a.id, a)
    byTag.set(a.tag.toLowerCase(), a)
  }
  return (questions ?? []).map((q) => ({
    question: q.question,
    options: (q.options ?? []).map((opt) => {
      const raw = String(opt ?? "").trim()
      const match = byId.get(raw) ?? byTag.get(raw.toLowerCase())
      if (match) return { asset_id: match.id, tag: match.tag, nombre: match.nombre }
      return { asset_id: undefined, tag: raw, nombre: undefined }
    }),
  }))
}

async function extractEventsFromTranscript(
  transcript: string,
  assets: AssetRef[],
  prevDisambiguation?: { question: string; options: string[]; resolved?: string }[],
  prevFollowUp?: { question: string; answer?: string }[]
): Promise<{
  events: Record<string, unknown>[]; disambiguation_questions: { question: string; options: string[] }[]; follow_up_questions: { question: string }[]
}> {
const assetContext = assets.map((a) => {
  const type = a.asset_type ? ` | tipo: ${a.asset_type}` : ""
  const parent = a.parent_tag ? ` | pertenece a: ${a.parent_tag}` : ""
  const alias = Array.isArray(a.aliases) && a.aliases.length > 0 ? ` | se le dice: ${a.aliases.join(", ")}` : ""
  return `- ${a.tag} (${a.nombre}) - area: ${a.area} [base: ${a.base_criticality}]${type}${parent}${alias}`
}).join("\n")

  const answeredLines: string[] = []
  const answeredDisambig = (prevDisambiguation ?? []).filter((q) => q.resolved)
  const answeredFollowUp = (prevFollowUp ?? []).filter((q) => q.answer)
  if (answeredDisambig.length > 0) {
    answeredLines.push("Desambiguaciones resueltas:")
    for (const q of answeredDisambig) answeredLines.push(`- "${q.question}" => ${q.resolved}`)
  }
  if (answeredFollowUp.length > 0) {
    answeredLines.push("Seguimientos respondidos:")
    for (const q of answeredFollowUp) answeredLines.push(`- "${q.question}" => "${q.answer}"`)
  }
  const answeredContext = answeredLines.length > 0
    ? `\n\nPreguntas YA RESPONDIDAS:\n${answeredLines.join("\n")}`
    : ""

  const systemPrompt = `Eres un asistente de extraccion de eventos para traspasos de turno industrial.\n\nInstrucciones:\n1. Analiza el traspaso y extrae los eventos mencionados\n2. Identifica: activo, tipo de evento, accion tomada, requiere seguimiento\n3. Si hay ambiguedad sobre un activo, genera pregunta de desambiguacion\n4. Si falta informacion critica, genera pregunta de seguimiento${answeredContext}\n\nActivos disponibles:\n${assetContext || "(ninguno)"}\n\nTipos: falla, alarma, mantenimiento, parada, riesgo, pendiente\nCriticidad: baja, media, alta\nStatus: abierto, resuelto\n\nResponde solo con JSON:\n{\n  "events": [{"asset_tag": "..", "event_type": "..", "criticality": "..", "action_taken": "..", "status": "..", "needs_followup": true}],\n  "disambiguation_questions": [{"question": "..", "options": [".."]}],\n  "follow_up_questions": [{"question": ".."}]\n}`

  const attempt = async (extraInstruction: string) => {
    const userMessage = extraInstruction ? `${transcript}\n\n${extraInstruction}` : transcript
    const { content, finishReason } = await callFeatherless(systemPrompt, userMessage, 4096, 0.1)
    const jsonText = extractJsonObject(content)
    if (!jsonText) throw new InvalidModelOutputError(content.slice(0, 2000), finishReason)
    try {
      return JSON.parse(jsonText)
    } catch {
      throw new InvalidModelOutputError(content.slice(0, 2000), finishReason)
    }
  }

  let parsed
  try {
    parsed = await attempt("")
  } catch (firstErr) {
    if (!(firstErr instanceof InvalidModelOutputError)) throw firstErr
    console.error("First attempt returned invalid output, retrying:", firstErr)
    parsed = await attempt(
      "IMPORTANTE: responde SOLO con el JSON. Empieza con { y termina con }. Sin pensamiento, sin markdown."
    )
  }
  return {
    events: Array.isArray(parsed.events) ? parsed.events : [],
    disambiguation_questions: Array.isArray(parsed.disambiguation_questions) ? parsed.disambiguation_questions : [],
    follow_up_questions: Array.isArray(parsed.follow_up_questions) ? parsed.follow_up_questions : [],
  }
}

async function saveEvents(
  handoverId: string,
  rawEvents: Record<string, unknown>[],
  agentQuestions?: any
): Promise<Record<string, unknown>[]> {
  const existingEvents = await fetchSupabase<Record<string, unknown>[]>(
    `/rest/v1/events?origin_handover_id=eq.${handoverId}&status=eq.abierto&select=id,event_type,asset_id,photo_urls,photo_analysis`
  )
  const existingByKey = new Map<string, Record<string, unknown>>()
  if (Array.isArray(existingEvents)) {
    for (const ev of existingEvents) {
      existingByKey.set(`${ev.event_type ?? "pendiente"}:${ev.asset_id ?? ""}`, ev)
    }
  }

  const saved: Record<string, unknown>[] = []
  const matchedKeys = new Set<string>()

  for (const raw of rawEvents) {
    let assetId: string | null = null
    if (raw.asset_tag && typeof raw.asset_tag === "string") {
      const assetResult = await fetchSupabase<{ id: string }[]>(`/rest/v1/assets?tag=eq.${encodeURIComponent(raw.asset_tag)}&select=id`)
      if (Array.isArray(assetResult) && assetResult.length > 0) assetId = assetResult[0].id
    }

    const eventType = (raw.event_type as string) ?? "pendiente"
    const key = `${eventType}:${assetId ?? ""}`
    matchedKeys.add(key)
    const existing = existingByKey.get(key)

    const payload: Record<string, unknown> = {
      origin_handover_id: handoverId,
      current_handover_id: handoverId,
      asset_id: assetId,
      event_type: eventType,
      criticality: raw.criticality ?? "media",
      action_taken: raw.action_taken ?? null,
      status: raw.status ?? "abierto",
      needs_followup: raw.needs_followup ?? false,
      photo_urls: Array.isArray(existing?.photo_urls) ? existing.photo_urls : [],
      photo_analysis: existing?.photo_analysis ?? null,
      agent_questions: agentQuestions ?? null,
    }

    if (existing) {
      const updated = await fetchSupabase<Record<string, unknown>[]>(`/rest/v1/events?id=eq.${existing.id}`, { method: "PATCH", body: payload })
      if (Array.isArray(updated) && updated.length > 0) saved.push(updated[0])
      else saved.push({ ...existing, ...payload })
    } else {
      const created = await fetchSupabase<Record<string, unknown>[]>("/rest/v1/events", {
        method: "POST",
        body: payload,
      })
      if (Array.isArray(created) && created.length > 0) {
        const newEvent = created[0]
        await fetchSupabase("/rest/v1/event_shift_trail", {
          method: "POST",
          body: { event_id: newEvent.id, handover_id: handoverId, shift_number: 1 },
        })
        saved.push(newEvent)
      }
    }
  }

  for (const [key, ev] of existingByKey) {
    if (matchedKeys.has(key)) continue
    // Never delete events with attached photos — protect against photo loss
    const photoUrls = ev.photo_urls as string[] | undefined
    if (photoUrls && photoUrls.length > 0) {
      // Leave the event in place (update current_handover_id so it stays visible)
      await fetchSupabase(`/rest/v1/events?id=eq.${ev.id}`, {
        method: "PATCH",
        body: { current_handover_id: handoverId },
      })
      continue
    }
    await fetchSupabase(`/rest/v1/event_shift_trail?event_id=eq.${ev.id}`, { method: "DELETE" })
    await fetchSupabase(`/rest/v1/events?id=eq.${ev.id}`, { method: "DELETE" })
  }

  return saved
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() })
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: corsHeaders() })

  const authHeader = req.headers.get("Authorization") || ""
  const token = authHeader.replace(/^Bearer\s+/i, "")
  if (!token || !(await verifyToken(token))) {
    return new Response(JSON.stringify({ error: "Token de autenticacion invalido" }), { status: 401, headers: corsHeaders() })
  }

  try {
    const body = await req.json()

    if (body.action === "analyze_photo") {
      const { handover_id, event_id, photo_url, event_context, corrected_transcript } = body as PhotoAnalysisRequest
      if (!handover_id || !event_id || !photo_url) return new Response(JSON.stringify({ error: "Faltan campos" }), { status: 400, headers: corsHeaders() })
      const analysis = await analyzePhotoWithEventContext(photo_url, event_context || "", corrected_transcript || "")
      if (analysis) {
        const current = await fetchSupabase<Record<string, unknown>[]>(`/rest/v1/events?id=eq.${event_id}&select=photo_urls`)
        const currentUrls = (Array.isArray(current) && current[0]?.photo_urls) ? (current[0].photo_urls as string[]) : []
        await fetchSupabase(`/rest/v1/events?id=eq.${event_id}`, { method: "PATCH", body: { photo_urls: [...new Set([...currentUrls, photo_url])], photo_analysis: analysis } })
      }
      return new Response(JSON.stringify({ event_id, photo_analysis: analysis }), { status: 200, headers: corsHeaders() })
    }

    const { handover_id, corrected_transcript, agent_disambiguation, agent_follow_up, finalize } = body as ExtractRequest
    if (!handover_id || !corrected_transcript) return new Response(JSON.stringify({ error: "Faltan campos: handover_id, corrected_transcript" }), { status: 400, headers: corsHeaders() })
    // finalize=true → el operador cerró el traspaso: generar resumen aunque queden preguntas
    const isFinalize = finalize === true

    const handover = await fetchSupabase<{ area: string }[]>(`/rest/v1/handovers?id=eq.${handover_id}&select=area`)
    const area = handover?.[0]?.area ?? ""

    const isFollowUp = (agent_disambiguation?.length ?? 0) > 0 || (agent_follow_up?.length ?? 0) > 0
    let inheritedCount = 0
    if (!isFollowUp) {
      const inherited = await inheritOpenEvents(handover_id, area)
      inheritedCount = inherited.count
      if (inherited.count > 0) console.log(`Inherited ${inherited.count} events`)
    }

    let assets: AssetRef[] = await fetchSupabase<AssetRef[]>(
      `/rest/v1/assets?area=eq.${encodeURIComponent(area)}&select=id,tag,nombre,area,base_criticality,aliases,asset_type,parent_tag`
    )
    if (!Array.isArray(assets)) assets = []
    let assetsAreaMatched = assets.length > 0
    if (assets.length === 0) {
      console.warn(`No assets matched area="${area}"`)
      const all = await fetchSupabase<AssetRef[]>(
        `/rest/v1/assets?select=id,tag,nombre,area,base_criticality,aliases,asset_type,parent_tag`
      )
      assets = Array.isArray(all) ? all : []
    }
    console.log(`Assets: ${assets.length} (area match: ${assetsAreaMatched})`)

    const result = await extractEventsFromTranscript(corrected_transcript, Array.isArray(assets) ? assets : [], agent_disambiguation, agent_follow_up)

    const disambiguationQuestions = resolveDisambiguationOptions(
      result.disambiguation_questions ?? [],
      Array.isArray(assets) ? assets : []
    )

    const agentQuestions = {
      disambiguation: agent_disambiguation ?? [],
      follow_up: agent_follow_up ?? [],
    }

    const savedEvents = await saveEvents(handover_id, result.events, agentQuestions)

    const responsePayload: Record<string, unknown> = {
      events: savedEvents,
      disambiguation_questions: disambiguationQuestions,
      follow_up_questions: result.follow_up_questions ?? [],
      requires_input: false,
      inherited_count: inheritedCount,
      assets_in_context: assets.length,
      assets_area_matched: assetsAreaMatched,
    }

    if (!isFinalize && (disambiguationQuestions.length > 0 || (result.follow_up_questions?.length ?? 0) > 0)) {
      responsePayload.requires_input = true
      return new Response(JSON.stringify(responsePayload), { status: 200, headers: corsHeaders() })
    }

    // Generate AI summary (non-blocking — never block the extraction on this)
    const generatedSummary = await generateSummary(savedEvents, corrected_transcript, assets)
    const patchBody: Record<string, unknown> = {}
    if (generatedSummary) patchBody.summary = generatedSummary
    // En finalización el cliente ya marcó status='complete'; no lo sobrescribimos
    if (!isFinalize) patchBody.status = "review"

    if (Object.keys(patchBody).length > 0) {
      await fetchSupabase(`/rest/v1/handovers?id=eq.${handover_id}`, { method: "PATCH", body: patchBody })
    } else {
      console.warn("No summary generated and nothing to patch — skipping PATCH")
    }

    responsePayload.requires_input = false
    return new Response(JSON.stringify(responsePayload), { status: 200, headers: corsHeaders() })
  } catch (err) {
    console.error("Error:", err)
    if (err instanceof InvalidApiKeyError) {
      return new Response(JSON.stringify({ error: "invalid_api_key" }), { status: 502, headers: corsHeaders() })
    }
    if (err instanceof RateLimitedError) {
      return new Response(JSON.stringify({ error: "rate_limited" }), { status: 503, headers: corsHeaders() })
    }
    if (err instanceof InvalidModelOutputError) {
      return new Response(JSON.stringify({
        error: err.finishReason === "length" ? "output_truncated" : "invalid_model_output",
        finish_reason: err.finishReason,
        raw: err.raw,
      }), { status: 502, headers: corsHeaders() })
    }
    if (err instanceof ModelCallError) {
      return new Response(JSON.stringify({ error: "model_error", detail: err.detail }), { status: 502, headers: corsHeaders() })
    }
    return new Response(JSON.stringify({
      error: "extraction_failed",
      detail: err instanceof Error ? err.message : String(err),
    }), { status: 500, headers: corsHeaders() })
  }
})