export interface Profile {
  id: string;
  nombre: string;
  rol: 'operador' | 'supervisor';
  created_at: string;
}

export interface Asset {
  id: string;
  tag: string;
  nombre: string;
  area: string;
  base_criticality: 'baja' | 'media' | 'alta';
  manufacturer?: string;
  created_at: string;
}

export interface Handover {
  id: string;
  operator_id: string;
  incoming_operator_id?: string;
  shift_time: string;
  journey: 'mañana' | 'tarde' | 'noche';
  area: string;
  recording_url?: string;
  raw_transcript?: string;
  corrected_transcript?: string;
  transcript_confidence?: number;
  summary?: string | null;
  status: 'processing' | 'review' | 'complete' | 'error';
  deleted_at?: string | null;
  created_at: string;
}

export interface HandoverEvent {
  id: string;
  origin_handover_id: string;
  current_handover_id: string;
  asset_id?: string;
  event_type: 'falla' | 'alarma' | 'mantenimiento' | 'parada' | 'riesgo' | 'pendiente';
  criticality: 'baja' | 'media' | 'alta';
  event_time?: string;
  action_taken?: string;
  status: 'abierto' | 'resuelto';
  needs_followup: boolean;
  photo_urls: string[];
  photo_analysis?: string;
  agent_questions?: AgentQuestions;
  created_at: string;
}

export interface AgentQuestions {
  disambiguation?: { question: string; options: string[]; resolved?: string }[];
  follow_up?: { question: string; answer?: string }[];
}

export interface EventShiftTrail {
  id: string;
  event_id: string;
  handover_id: string;
  shift_number: number;
  created_at: string;
}

export interface Acknowledgment {
  id: string;
  handover_id: string;
  receiving_user_id: string;
  timestamp: string;
  comment?: string;
}

export interface ExtractEventsResponse {
  events: HandoverEvent[];
  disambiguation_questions: DisambiguationQuestion[];
  follow_up_questions: FollowUpQuestion[];
}

export interface DisambiguationOption {
  asset_id?: string;
  tag: string;
  nombre?: string;
}

export interface DisambiguationQuestion {
  question: string;
  // Resueltas contra el catálogo: { asset_id, tag, nombre } en lugar de IDs crudos
  options: DisambiguationOption[];
  resolved_asset_id?: string;
}

export interface FollowUpQuestion {
  question: string;
  answer?: string;
}