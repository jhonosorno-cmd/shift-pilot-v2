import { supabase } from './supabase';
import { Handover, HandoverEvent, Acknowledgment } from './types';

/**
 * Buscar el handover más reciente con status='complete' en la misma área.
 */
export async function getLatestCompleteHandover(area: string): Promise<Handover | null> {
  const { data, error } = await supabase
    .from('handovers')
    .select('*')
    .eq('area', area)
    .eq('status', 'complete')
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  if (error || !data) return null;
  return data as Handover;
}

/**
 * Buscar eventos abiertos con needs_followup=true de un handover específico.
 */
export async function getOpenEventsForHandover(handoverId: string): Promise<HandoverEvent[]> {
  const { data, error } = await supabase
    .from('events')
    .select('*')
    .eq('current_handover_id', handoverId)
    .eq('status', 'abierto')
    .eq('needs_followup', true);

  if (error) return [];
  return data as HandoverEvent[];
}

/**
 * Heredar eventos abiertos a un nuevo handover:
 * - Reasigna current_handover_id de cada evento
 * - Inserta fila en event_shift_trail
 */
export async function inheritOpenEvents(
  previousHandoverId: string,
  newHandoverId: string
): Promise<{ count: number; errors: string[] }> {
  const errors: string[] = [];
  const events = await getOpenEventsForHandover(previousHandoverId);

  for (const event of events) {
    // Obtener el próximo shift_number
    const { data: trailData } = await supabase
      .from('event_shift_trail')
      .select('shift_number')
      .eq('event_id', event.id)
      .order('shift_number', { ascending: false })
      .limit(1);

    const nextShift = trailData && trailData.length > 0 ? trailData[0].shift_number + 1 : 1;

    // Reasignar current_handover_id
    const { error: updateError } = await supabase
      .from('events')
      .update({ current_handover_id: newHandoverId })
      .eq('id', event.id);

    if (updateError) {
      errors.push(`Error updating event ${event.id}: ${updateError.message}`);
      continue;
    }

    // Insertar trail
    const { error: trailError } = await supabase.from('event_shift_trail').insert({
      event_id: event.id,
      handover_id: newHandoverId,
      shift_number: nextShift,
    });

    if (trailError) {
      errors.push(`Error inserting trail for event ${event.id}: ${trailError.message}`);
    }
  }

  return { count: events.length, errors };
}

/**
 * Resolver un evento (cerrarlo globalmente)
 */
export async function resolveEvent(eventId: string): Promise<boolean> {
  const { error } = await supabase
    .from('events')
    .update({ status: 'resuelto', needs_followup: false })
    .eq('id', eventId);

  return !error;
}

/**
 * Verificar si el operador actual ya confirmó recepción de un handover
 */
export async function hasAcknowledged(
  handoverId: string,
  userId: string
): Promise<boolean> {
  const { data } = await supabase
    .from('acknowledgments')
    .select('id')
    .eq('handover_id', handoverId)
    .eq('receiving_user_id', userId)
    .limit(1);

  return !!(data && data.length > 0);
}

/**
 * Obtener el handover pendiente de confirmación para un área y operador
 */
export async function getPendingAcknowledgment(
  area: string,
  userId: string
): Promise<{ handover: Handover; acknowledgments: Acknowledgment[] } | null> {
  // Todos los handovers completos del área, del más antiguo al más nuevo:
  // se puede confirmar CUALQUIER traspaso aún no reconocido, no solo el último.
  const { data: handovers, error } = await supabase
    .from('handovers')
    .select('*')
    .eq('area', area)
    .eq('status', 'complete')
    .is('deleted_at', null)
    .order('created_at', { ascending: true });

  if (error || !handovers) return null;

  for (const handover of handovers as Handover[]) {
    // El operador no confirma sus propios traspasos
    if (handover.operator_id === userId) continue;

    // Saltar traspasos que este operador ya confirmó
    const alreadyAcked = await hasAcknowledged(handover.id, userId);
    if (alreadyAcked) continue;

    // Obtener acknowledgments existentes
    const { data: acks } = await supabase
      .from('acknowledgments')
      .select('*')
      .eq('handover_id', handover.id);

    return {
      handover,
      acknowledgments: (acks || []) as Acknowledgment[],
    };
  }

  return null;
}

/**
 * Obtener la cantidad de turnos que un evento lleva abierto
 */
export async function getShiftsOpen(eventId: string): Promise<number> {
  const { count } = await supabase
    .from('event_shift_trail')
    .select('*', { count: 'exact', head: true })
    .eq('event_id', eventId);

  return count || 0;
}