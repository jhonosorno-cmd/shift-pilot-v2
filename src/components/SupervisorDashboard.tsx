import { useState, useEffect, Fragment } from 'react';
import { Shield, Filter, AlertTriangle, ChevronDown, ChevronUp, Eye, Image, CheckCircle, XCircle, Clock, Pencil, Trash2, Save, X } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { Handover, HandoverEvent, EventShiftTrail, Profile, Asset, Acknowledgment } from '../lib/types';

interface EventWithShifts extends HandoverEvent {
  shifts_open: number;
  asset_tag?: string;
  asset_nombre?: string;
  trail: EventShiftTrail[];
}

export default function SupervisorDashboard() {
  const [handovers, setHandovers] = useState<(Handover & { operator_name?: string; event_count?: number })[]>([]);
  const [alertEvents, setAlertEvents] = useState<EventWithShifts[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedHandover, setSelectedHandover] = useState<string | null>(null);
  const [selectedEvents, setSelectedEvents] = useState<EventWithShifts[]>([]);
  const [expandedEvent, setExpandedEvent] = useState<string | null>(null);
  const [areaFilter, setAreaFilter] = useState('');
  const [journeyFilter, setJourneyFilter] = useState('');
  const [operatorFilter, setOperatorFilter] = useState('');
  const [operators, setOperators] = useState<Profile[]>([]);
  const [acknowledgments, setAcknowledgments] = useState<Acknowledgment[]>([]);
  const [profileNameMap, setProfileNameMap] = useState<Record<string, string>>({});
  const [photoPreview, setPhotoPreview] = useState<{ url: string; analysis: string } | null>(null);
const [expandedAlertEvent, setExpandedAlertEvent] = useState<string | null>(null);
  // Build handover lookup map for alert trail display
  const handoverMap = new Map(handovers.map(h => [h.id, h]));

  // Edit / Delete state
  const [editingHandover, setEditingHandover] = useState(false);
  const [editArea, setEditArea] = useState('');
  const [editJourney, setEditJourney] = useState('');
  const [editTranscript, setEditTranscript] = useState('');
  const [editEvents, setEditEvents] = useState<{ id: string; event_type: string; criticality: string; action_taken: string; status: string }[]>([]);
  const [saving, setSaving] = useState(false);
  const [deleteConfirmModal, setDeleteConfirmModal] = useState<{ message: string; onConfirm: () => void } | null>(null);

  useEffect(() => { loadData(); }, []);

  const loadData = async () => {
    setLoading(true);
    const { data: profiles } = await supabase.from('profiles').select('*');
    const profileMap = new Map((profiles || []).map((p: Profile) => [p.id, p.nombre]));
    const nameMap: Record<string, string> = {};
    for (const p of profiles || []) { nameMap[p.id] = p.nombre; }
    setProfileNameMap(nameMap);
    setOperators((profiles || []).filter((p: Profile) => p.rol === 'operador'));
    const { data: assets } = await supabase.from('assets').select('*');
    const assetMap = new Map((assets || []).map((a: Asset) => [a.id, a]));

    const { data: allHandovers } = await supabase.from('handovers').select('*').is('deleted_at', null).order('created_at', { ascending: false });
    if (allHandovers) {
      const enriched = await Promise.all(allHandovers.map(async (h: Handover) => {
        const { count } = await supabase.from('event_shift_trail').select('*', { count: 'exact', head: true }).eq('handover_id', h.id);
        return { ...h, operator_name: profileMap.get(h.operator_id) || 'Desconocido', event_count: count || 0 };
      }));
      setHandovers(enriched);
    }

    const { data: openEvents } = await supabase.from('events').select('*').eq('status', 'abierto').order('created_at', { ascending: false });
    if (openEvents) {
      const withShifts: EventWithShifts[] = [];
      for (const event of openEvents as HandoverEvent[]) {
        const { data: trail } = await supabase.from('event_shift_trail').select('*').eq('event_id', event.id).order('shift_number');
        const asset = event.asset_id ? assetMap.get(event.asset_id) : undefined;
        withShifts.push({ ...event, shifts_open: trail?.length || 0, asset_tag: asset?.tag, asset_nombre: asset?.nombre, trail: (trail || []) as EventShiftTrail[] });
      }
      withShifts.sort((a, b) => b.shifts_open - a.shifts_open);
      setAlertEvents(withShifts.slice(0, 10));
    }
    setLoading(false);
  };

  const loadHandoverEvents = async (handoverId: string) => {
    if (selectedHandover === handoverId) { setSelectedHandover(null); setSelectedEvents([]); setAcknowledgments([]); return; }
    setSelectedHandover(handoverId);
    // Load events — also fetch from event_shift_trail for inherited events (Task 11)
    const { data: currentEvents } = await supabase.from('events').select('*').eq('current_handover_id', handoverId);
    let mergedEvents: HandoverEvent[] = (currentEvents || []) as HandoverEvent[];
    const { data: trailRows } = await supabase.from('event_shift_trail').select('event_id').eq('handover_id', handoverId);
    if (trailRows && trailRows.length > 0) {
      const existingIds = new Set(mergedEvents.map(e => e.id));
      const trailEventIds = trailRows.map(r => r.event_id).filter(id => !existingIds.has(id));
      if (trailEventIds.length > 0) {
        const { data: trailEvents } = await supabase.from('events').select('*').in('id', trailEventIds);
        if (trailEvents) mergedEvents = [...mergedEvents, ...(trailEvents as HandoverEvent[])];
      }
    }
    if (mergedEvents.length > 0) {
      const withShifts: EventWithShifts[] = [];
      for (const event of mergedEvents as HandoverEvent[]) {
        const { data: trail } = await supabase.from('event_shift_trail').select('*').eq('event_id', event.id).order('shift_number');
        let assetTag: string | undefined;
        let assetNombre: string | undefined;
        if (event.asset_id) {
          const { data: aData } = await supabase.from('assets').select('tag,nombre').eq('id', event.asset_id).single();
          assetTag = aData?.tag;
          assetNombre = aData?.nombre;
        }
        withShifts.push({ ...event, shifts_open: trail?.length || 0, asset_tag: assetTag, asset_nombre: assetNombre, trail: (trail || []) as EventShiftTrail[] });
      }
      setSelectedEvents(withShifts);
    }
    // Load acknowledgments for this handover
    const { data: acks } = await supabase.from('acknowledgments').select('*').eq('handover_id', handoverId);
    setAcknowledgments((acks || []) as Acknowledgment[]);
  };

  const filteredHandovers = handovers.filter(h => {
    if (areaFilter && h.area !== areaFilter) return false;
    if (journeyFilter && h.journey !== journeyFilter) return false;
    if (operatorFilter && h.operator_id !== operatorFilter) return false;
    return true;
  });

  const journeyLabels: Record<string, string> = { mañana: 'Mañana', tarde: 'Tarde', noche: 'Noche' };
  const areas = [...new Set(handovers.map(h => h.area))];
  const eventTypeLabels: Record<string, string> = { falla: 'Falla', alarma: 'Alarma', mantenimiento: 'Mantenimiento', parada: 'Parada', riesgo: 'Riesgo', pendiente: 'Pendiente' };

  // Compute stats summary for selected events
  const getEventStats = (events: EventWithShifts[]) => {
    const total = events.length;
    const alta = events.filter(e => e.criticality === 'alta').length;
    const media = events.filter(e => e.criticality === 'media').length;
    const baja = events.filter(e => e.criticality === 'baja').length;
    const abierto = events.filter(e => e.status === 'abierto').length;
    const resuelto = events.filter(e => e.status === 'resuelto').length;
    const needsFollowup = events.filter(e => e.needs_followup).length;
    return { total, alta, media, baja, abierto, resuelto, needsFollowup };
  };

  const startEditing = () => {
    const handover = handovers.find(h => h.id === selectedHandover);
    if (!handover) return;
    setEditArea(handover.area);
    setEditJourney(handover.journey);
    setEditTranscript(handover.corrected_transcript || handover.raw_transcript || '');
    setEditEvents(selectedEvents.map(e => ({
      id: e.id,
      event_type: e.event_type,
      criticality: e.criticality,
      action_taken: e.action_taken || '',
      status: e.status,
    })));
    setEditingHandover(true);
  };

  const cancelEditing = () => {
    setEditingHandover(false);
  };

  const saveChanges = async () => {
    if (!selectedHandover) return;
    setSaving(true);
    try {
      // Save handover fields
      const { error: hError } = await supabase
        .from('handovers')
        .update({ area: editArea, journey: editJourney as Handover['journey'], corrected_transcript: editTranscript })
        .eq('id', selectedHandover);
      if (hError) throw new Error('Error al guardar traspaso: ' + hError.message);

      // Save each event
      for (const ev of editEvents) {
        const { error: evError } = await supabase
          .from('events')
          .update({ event_type: ev.event_type, criticality: ev.criticality, action_taken: ev.action_taken || null, status: ev.status })
          .eq('id', ev.id);
        if (evError) throw new Error('Error al guardar evento: ' + evError.message);
      }

      // Refresh data
      await loadData();
      await loadHandoverEvents(selectedHandover);
      setEditingHandover(false);
    } catch (err) {
      console.error('Save error:', err);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!selectedHandover) return;
    // Check if any event with origin_handover_id = this handover has been inherited forward
    const { data: blockedEvents } = await supabase
      .from('events')
      .select('id, current_handover_id, event_type')
      .eq('origin_handover_id', selectedHandover)
      .neq('current_handover_id', selectedHandover);

    if (blockedEvents && blockedEvents.length > 0) {
      // Find which handover holds them now
      const targetIds = [...new Set(blockedEvents.map(e => e.current_handover_id))];
      const targetNames = targetIds.map(id => handoverMap.get(id)?.operator_name || id).join(', ');
      setDeleteConfirmModal({
        message: `No se puede eliminar: ${blockedEvents.length} evento(s) han sido heredados a otro(s) traspaso(s) (${targetNames}). Resuelve esos eventos primero.`,
        onConfirm: () => setDeleteConfirmModal(null),
      });
      return;
    }

    // No blocking events — soft delete
    const handoverData = handovers.find(h => h.id === selectedHandover);
    setDeleteConfirmModal({
      message: `¿Eliminar el reporte de ${handoverData?.operator_name || 'operador'} (${handoverData?.area})? Los datos se conservarán pero no serán visibles.`,
      onConfirm: async () => {
        const { error } = await supabase
          .from('handovers')
          .update({ deleted_at: new Date().toISOString() })
          .eq('id', selectedHandover);
        if (!error) {
          setDeleteConfirmModal(null);
          setSelectedHandover(null);
          setSelectedEvents([]);
          setAcknowledgments([]);
          await loadData();
        }
      },
    });
  };

  if (loading) return (
    <div className="flex items-center justify-center min-h-[60vh]">
      <div className="w-8 h-8 border-2 border-accent border-t-transparent rounded-full animate-spin" />
    </div>
  );

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex items-center gap-3">
        <Shield size={24} className="text-accent" />
        <div>
          <h1 className="text-xl font-bold text-text-primary">Dashboard de Supervisor</h1>
          <p className="text-text-muted text-xs mt-0.5">Vista general de todos los traspasos y alertas</p>
        </div>
      </div>

      {/* Alert panel */}
      {alertEvents.length > 0 && (
        <div className="card border-danger/30 bg-danger/5">
          <div className="flex items-center gap-2 mb-3">
            <AlertTriangle size={18} className="text-danger" />
            <h3 className="text-sm font-bold text-danger uppercase tracking-wider">Alertas: Eventos con más turnos abiertos</h3>
          </div>
          <div className="space-y-2">
            {alertEvents.slice(0, 5).map(event => (
              <Fragment key={event.id}>
                <div
                  className="flex items-center justify-between bg-bg-elevated rounded-lg p-3 cursor-pointer hover:bg-bg-card"
                  onClick={() => setExpandedAlertEvent(expandedAlertEvent === event.id ? null : event.id)}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span className={`w-2 h-2 rounded-full shrink-0 ${event.criticality === 'alta' ? 'bg-danger' : event.criticality === 'media' ? 'bg-warning' : 'bg-success'}`} />
                    <div className="min-w-0">
                      <p className="text-sm text-text-primary truncate">
                        <span className="font-medium capitalize">{eventTypeLabels[event.event_type]}</span>
                        {event.asset_tag && <span className="text-text-muted ml-1">— {event.asset_tag}</span>}
                      </p>
                      <p className="text-xs text-text-muted truncate">{event.action_taken || 'Sin acción registrada'}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="text-xs font-bold text-danger bg-danger/20 px-2 py-1 rounded-full">
                      {event.shifts_open} turno{event.shifts_open !== 1 ? 's' : ''}
                    </span>
                    {expandedAlertEvent === event.id ? <ChevronUp size={14} className="text-accent" /> : <ChevronDown size={14} className="text-text-muted" />}
                  </div>
                </div>
                {expandedAlertEvent === event.id && event.trail.length > 0 && (
                  <div className="bg-bg-elevated/50 rounded-lg px-3 py-2 space-y-1.5 animate-fade-in">
                    <p className="text-xs text-text-muted font-medium mb-1">HISTORIAL DE TURNOS</p>
                    {event.trail.map(t => {
                      const handoverData = handoverMap.get(t.handover_id);
                      return (
                        <div key={t.id} className="flex items-center gap-2 text-xs text-text-secondary">
                          <Clock size={12} className="text-text-muted shrink-0" />
                          <span className="font-mono text-text-muted">#{t.shift_number}</span>
                          <span>{new Date(t.created_at).toLocaleDateString('es-ES', { day: 'numeric', month: 'short', hour: '2-digit' })}</span>
                          {handoverData && (
                            <>
                              <span className="text-text-muted">·</span>
                              <span>{handoverData.area}</span>
                              <span className="text-text-muted">·</span>
                              <span>{journeyLabels[handoverData.journey]}</span>
                            </>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </Fragment>
            ))}
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="flex gap-3">
        <Filter size={16} className="text-text-muted mt-3" />
        <select value={areaFilter} onChange={e => setAreaFilter(e.target.value)} className="select-field text-sm py-2 flex-1">
          <option value="">Todas las áreas</option>
          {areas.map(a => <option key={a} value={a}>{a}</option>)}
        </select>
        <select value={journeyFilter} onChange={e => setJourneyFilter(e.target.value)} className="select-field text-sm py-2 flex-1">
          <option value="">Todas las jornadas</option>
          <option value="mañana">Mañana</option>
          <option value="tarde">Tarde</option>
          <option value="noche">Noche</option>
        </select>
        <select value={operatorFilter} onChange={e => setOperatorFilter(e.target.value)} className="select-field text-sm py-2 flex-1">
          <option value="">Todos los operadores</option>
          {operators.map(op => <option key={op.id} value={op.id}>{op.nombre}</option>)}
        </select>
      </div>

      {/* Handovers table */}
      <div className="overflow-x-auto rounded-xl border border-border">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-bg-secondary text-text-muted text-xs uppercase tracking-wider">
              <th className="text-left px-4 py-3 font-medium">Operador</th>
              <th className="text-left px-4 py-3 font-medium">Área</th>
              <th className="text-left px-4 py-3 font-medium">Jornada</th>
              <th className="text-left px-4 py-3 font-medium">Fecha</th>
              <th className="text-center px-4 py-3 font-medium">Eventos</th>
              <th className="text-left px-4 py-3 font-medium">Estado</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody>
            {filteredHandovers.length === 0 ? (
              <tr>
                <td colSpan={7} className="text-center py-8 text-text-muted">No se encontraron traspasos</td>
              </tr>
            ) : filteredHandovers.map(h => (
              <Fragment key={h.id}>
                <tr className="border-t border-border cursor-pointer hover:bg-bg-card" onClick={() => loadHandoverEvents(h.id)}>
                  <td className="px-4 py-3 text-text-primary font-medium">{h.operator_name}</td>
                  <td className="px-4 py-3 text-text-secondary">{h.area}</td>
                  <td className="px-4 py-3 text-text-secondary">{journeyLabels[h.journey]}</td>
                  <td className="px-4 py-3 text-text-secondary text-xs">
                    {new Date(h.created_at).toLocaleDateString('es-ES', { day: '2-digit', month: 'short' })}
                  </td>
                  <td className="px-4 py-3 text-center text-text-secondary">{h.event_count}</td>
                  <td className="px-4 py-3">
                    <span className={`text-xs font-medium px-2 py-1 rounded-full ${
                      h.status === 'complete' ? 'bg-success/20 text-success' :
                      h.status === 'error' ? 'bg-danger/20 text-danger' :
                      h.status === 'review' ? 'bg-warning/20 text-warning' : 'bg-accent/20 text-accent'
                    }`}>
                      {h.status === 'complete' ? 'Completado' : h.status === 'review' ? 'Revisión' : h.status === 'error' ? 'Error' : 'Procesando'}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    {selectedHandover === h.id ? <ChevronUp size={16} className="text-accent" /> : <ChevronDown size={16} className="text-text-muted" />}
                  </td>
                </tr>
                {/* Expanded detail inline under the row */}
                {selectedHandover === h.id && (
                  <tr className="animate-fade-in">
                    <td colSpan={7} className="px-4 py-3 bg-bg-secondary/50">
                      <div className="print-report space-y-3">
                        {/* Print-only report header (Task 10) */}
                        <div className="print-only">
                          <h1 style={{fontSize:'18px',fontWeight:'bold',marginBottom:'4px'}}>Reporte de Traspaso de Turno</h1>
                          <table style={{fontSize:'12px',borderCollapse:'collapse',width:'100%',marginBottom:'12px'}}>
                            <tbody>
                              <tr><td style={{padding:'2px 8px 2px 0',fontWeight:600}}>Operador:</td><td>{h.operator_name}</td></tr>
                              <tr><td style={{padding:'2px 8px 2px 0',fontWeight:600}}>Área:</td><td>{h.area}</td></tr>
                              <tr><td style={{padding:'2px 8px 2px 0',fontWeight:600}}>Jornada:</td><td>{journeyLabels[h.journey]}</td></tr>
                              <tr><td style={{padding:'2px 8px 2px 0',fontWeight:600}}>Fecha:</td><td>{new Date(h.created_at).toLocaleDateString('es-ES',{day:'numeric',month:'long',year:'numeric',hour:'2-digit',minute:'2-digit'})}</td></tr>
                              <tr><td style={{padding:'2px 8px 2px 0',fontWeight:600}}>Estado:</td><td>{h.status === 'complete' ? 'Completado' : h.status === 'review' ? 'Revisión' : h.status === 'error' ? 'Error' : 'Procesando'}</td></tr>
                            </tbody>
                          </table>
                          <hr style={{border:'none',borderTop:'1px solid #ccc',marginBottom:'12px'}} />
                        </div>
                        {/* AI Summary — Task 3 */}
                        {h.summary ? (
                          <div className="card border-accent/20 bg-accent/5">
                            <p className="text-sm text-text-primary leading-relaxed">{h.summary}</p>
                          </div>
                        ) : h.status !== 'processing' && h.status !== 'error' ? (
                          <div className="card border-border/50">
                            <p className="text-xs text-text-muted italic">Resumen no disponible para este traspaso</p>
                          </div>
                        ) : null}

                        {/* Stats summary — Task 3 */}
                        <div className="card border-accent/30">
                          <div className="flex items-center gap-3 flex-wrap">
                            <span className="text-sm font-bold text-text-primary">Resumen</span>
                            <span className="text-xs text-text-muted">{getEventStats(selectedEvents).total} eventos</span>
                            <span className="text-xs px-2 py-0.5 rounded-full bg-danger/20 text-danger">{getEventStats(selectedEvents).alta} alta</span>
                            <span className="text-xs px-2 py-0.5 rounded-full bg-warning/20 text-warning">{getEventStats(selectedEvents).media} media</span>
                            <span className="text-xs px-2 py-0.5 rounded-full bg-success/20 text-success">{getEventStats(selectedEvents).baja} baja</span>
                            <span className="text-xs text-text-muted">·</span>
                            <span className="text-xs text-warning">{getEventStats(selectedEvents).abierto} abierto{getEventStats(selectedEvents).abierto !== 1 ? 's' : ''}</span>
                            <span className="text-xs text-success">{getEventStats(selectedEvents).resuelto} resuelto{getEventStats(selectedEvents).resuelto !== 1 ? 's' : ''}</span>
                            {getEventStats(selectedEvents).needsFollowup > 0 && (
                              <>
                                <span className="text-xs text-text-muted">·</span>
                                <span className="text-xs text-danger">{getEventStats(selectedEvents).needsFollowup} con seguimiento</span>
                              </>
                            )}
                          </div>
                          <div className="flex items-center gap-2 mt-3 flex-wrap">
                            <button
                              onClick={() => window.print()}
                              className="btn-secondary text-xs py-2 px-3 flex items-center gap-1.5"
                            >
                              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>
                              Exportar PDF
                            </button>
                            {!editingHandover ? (
                              <>
                                <button onClick={startEditing} className="btn-secondary text-xs py-2 px-3 flex items-center gap-1.5">
                                  <Pencil size={14} />
                                  Editar
                                </button>
                                <button onClick={handleDelete} className="btn-danger text-xs py-2 px-3 flex items-center gap-1.5">
                                  <Trash2 size={14} />
                                  Eliminar reporte
                                </button>
                              </>
                            ) : (
                              <>
                                <button onClick={saveChanges} disabled={saving} className="btn-primary text-xs py-2 px-3 flex items-center gap-1.5">
                                  <Save size={14} />
                                  {saving ? 'Guardando...' : 'Guardar cambios'}
                                </button>
                                <button onClick={cancelEditing} className="btn-secondary text-xs py-2 px-3 flex items-center gap-1.5">
                                  <X size={14} />
                                  Cancelar
                                </button>
                              </>
                            )}
                          </div>
                        </div>

                        {/* Editable handover fields when editing */}
                        {editingHandover && (
                          <div className="card border-warning/30 bg-warning/5 space-y-3">
                            <h3 className="text-sm font-bold text-warning uppercase tracking-wider flex items-center gap-2">
                              <Pencil size={14} />
                              Editando traspaso
                            </h3>
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                              <div>
                                <label className="text-xs text-text-muted font-medium block mb-1">Área</label>
                                <input
                                  value={editArea}
                                  onChange={e => setEditArea(e.target.value)}
                                  className="input-field text-sm w-full"
                                />
                              </div>
                              <div>
                                <label className="text-xs text-text-muted font-medium block mb-1">Jornada</label>
                                <select value={editJourney} onChange={e => setEditJourney(e.target.value)} className="select-field text-sm w-full">
                                  <option value="mañana">Mañana</option>
                                  <option value="tarde">Tarde</option>
                                  <option value="noche">Noche</option>
                                </select>
                              </div>
                            </div>
                            <div>
                              <label className="text-xs text-text-muted font-medium block mb-1">Transcripción corregida</label>
                              <textarea
                                value={editTranscript}
                                onChange={e => setEditTranscript(e.target.value)}
                                className="input-field text-sm w-full min-h-[80px]"
                                rows={3}
                              />
                            </div>
                          </div>
                        )}

                        {/* Acknowledgments section */}
                        <div className="card border-accent/20">
                          <h3 className="text-sm font-bold text-text-muted uppercase tracking-wider mb-3">Recepción de turno</h3>
                          {acknowledgments.length === 0 ? (
                            <div className="flex items-center gap-2 text-sm text-warning">
                              <XCircle size={16} />
                              <span>Sin confirmar</span>
                            </div>
                          ) : (
                            <div className="space-y-2">
                              {acknowledgments.map(ack => (
                                <div key={ack.id} className="flex items-center gap-2 text-sm">
                                  <CheckCircle size={16} className="text-success shrink-0" />
                                  <span className="text-text-primary font-medium">{profileNameMap[ack.receiving_user_id] || 'Operador'}</span>
                                  <span className="text-text-muted">—</span>
                                  <span className="text-text-muted text-xs">
                                    {new Date(ack.timestamp).toLocaleDateString('es-ES', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                                  </span>
                                  {ack.comment && (
                                    <p className="text-xs text-text-secondary mt-1 w-full">{ack.comment}</p>
                                  )}
                                </div>
                              ))}
                            </div>
                          )}
                        </div>

                        <h3 className="text-sm font-bold text-text-muted uppercase tracking-wider">Eventos del traspaso ({selectedEvents.length})</h3>
                        {editingHandover ? (
                          /* Editable event cards when editing */
                          selectedEvents.map((event, idx) => {
                            const editEv = editEvents.find(e => e.id === event.id);
                            if (!editEv) return null;
                            return (
                              <div key={event.id} className="card border-warning/30 bg-warning/5">
                                <div className="flex items-center gap-2 mb-2">
                                  <Pencil size={12} className="text-warning" />
                                  <span className="text-xs font-bold text-warning">Evento #{idx + 1}</span>
                                  {event.asset_tag && <span className="text-xs text-text-muted">{event.asset_tag}</span>}
                                </div>
                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                  <div>
                                    <label className="text-xs text-text-muted font-medium block mb-1">Tipo</label>
                                    <select
                                      value={editEv.event_type}
                                      onChange={e => {
                                        const updated = editEvents.map(ev => ev.id === event.id ? { ...ev, event_type: e.target.value } : ev);
                                        setEditEvents(updated);
                                      }}
                                      className="select-field text-sm w-full"
                                    >
                                      <option value="falla">Falla</option>
                                      <option value="alarma">Alarma</option>
                                      <option value="mantenimiento">Mantenimiento</option>
                                      <option value="parada">Parada</option>
                                      <option value="riesgo">Riesgo</option>
                                      <option value="pendiente">Pendiente</option>
                                    </select>
                                  </div>
                                  <div>
                                    <label className="text-xs text-text-muted font-medium block mb-1">Criticidad</label>
                                    <select
                                      value={editEv.criticality}
                                      onChange={e => {
                                        const updated = editEvents.map(ev => ev.id === event.id ? { ...ev, criticality: e.target.value } : ev);
                                        setEditEvents(updated);
                                      }}
                                      className="select-field text-sm w-full"
                                    >
                                      <option value="baja">Baja</option>
                                      <option value="media">Media</option>
                                      <option value="alta">Alta</option>
                                    </select>
                                  </div>
                                  <div>
                                    <label className="text-xs text-text-muted font-medium block mb-1">Estado</label>
                                    <select
                                      value={editEv.status}
                                      onChange={e => {
                                        const updated = editEvents.map(ev => ev.id === event.id ? { ...ev, status: e.target.value } : ev);
                                        setEditEvents(updated);
                                      }}
                                      className="select-field text-sm w-full"
                                    >
                                      <option value="abierto">Abierto</option>
                                      <option value="resuelto">Resuelto</option>
                                    </select>
                                  </div>
                                  <div className="sm:col-span-2">
                                    <label className="text-xs text-text-muted font-medium block mb-1">Acción tomada</label>
                                    <textarea
                                      value={editEv.action_taken}
                                      onChange={e => {
                                        const updated = editEvents.map(ev => ev.id === event.id ? { ...ev, action_taken: e.target.value } : ev);
                                        setEditEvents(updated);
                                      }}
                                      className="input-field text-sm w-full min-h-[60px]"
                                      rows={2}
                                    />
                                  </div>
                                </div>
                              </div>
                            );
                          })
                        ) : (
                        selectedEvents.map(event => (
                          <div key={event.id} className="card">
                            <div className="flex items-center justify-between cursor-pointer" onClick={() => setExpandedEvent(expandedEvent === event.id ? null : event.id)}>
                              <div className="flex items-center gap-2">
                                <span className={`w-2.5 h-2.5 rounded-full ${event.criticality === 'alta' ? 'bg-danger' : event.criticality === 'media' ? 'bg-warning' : 'bg-success'}`} />
                                <span className="text-sm font-medium text-text-primary capitalize">{eventTypeLabels[event.event_type]}</span>
                                {event.asset_tag && <span className="text-xs text-text-muted">{event.asset_tag}</span>}
                                {event.current_handover_id !== selectedHandover && (
                                  <span className="text-xs px-2 py-0.5 rounded-full bg-accent/20 text-accent">heredado al turno siguiente</span>
                                )}
                              </div>
                              <div className="flex items-center gap-2">
                                <span className={`text-xs px-2 py-0.5 rounded-full ${event.status === 'abierto' ? 'bg-warning/20 text-warning' : 'bg-success/20 text-success'}`}>
                                  {event.status === 'abierto' ? 'Abierto' : 'Resuelto'}
                                </span>
                                {event.shifts_open > 1 && (
                                  <span className="text-xs px-2 py-0.5 rounded-full bg-danger/20 text-danger">{event.shifts_open} turnos</span>
                                )}
                                <ChevronDown size={14} className={`text-text-muted transition-transform ${expandedEvent === event.id ? 'rotate-180' : ''}`} />
                              </div>
                            </div>

                            {expandedEvent === event.id && (
                              <div className="mt-3 pt-3 border-t border-border space-y-3 animate-fade-in">
                                {event.action_taken && <p className="text-sm text-text-secondary">{event.action_taken}</p>}

                                {event.photo_urls.length > 0 && (
                                  <div>
                                    <div className="flex items-center gap-1 mb-1">
                                      <Image size={14} className="text-text-muted" />
                                      <span className="text-xs text-text-muted font-medium">FOTOS</span>
                                    </div>
                                    <div className="flex flex-wrap gap-2">
                                      {event.photo_urls.map((url, i) => (
                                        <div key={i} className="relative group">
                                          <img src={url} alt="" className="w-16 h-16 rounded-lg object-cover border border-border" />
                                          {event.photo_analysis && (
                                            <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity rounded-lg flex items-center justify-center" onClick={() => setPhotoPreview({ url, analysis: event.photo_analysis! })}>
                                              <Eye size={16} className="text-white" />
                                            </div>
                                          )}
                                        </div>
                                      ))}
                                    </div>
                                    {event.photo_analysis && <p className="text-xs text-text-muted mt-1 italic">{event.photo_analysis}</p>}
                                  </div>
                                )}

                                {event.trail.length > 0 && (
                                  <div>
                                    <p className="text-xs text-text-muted font-medium mb-1">HISTORIAL DE TURNOS</p>
                                    <div className="space-y-1">
                                      {event.trail.map(t => (
                                        <div key={t.id} className="flex items-center gap-2 text-xs text-text-secondary">
                                          <span className="font-mono text-text-muted">#{t.shift_number}</span>
                                          <span>{new Date(t.created_at).toLocaleDateString('es-ES', { day: 'numeric', month: 'short', hour: '2-digit' })}</span>
                                        </div>
                                      ))}
                                    </div>
                                  </div>
                                )}

                                {event.agent_questions && (
                                  <div>
                                    <p className="text-xs text-text-muted font-medium mb-1">PREGUNTAS DEL AGENTE</p>
                                    <pre className="text-xs text-text-secondary bg-bg-secondary rounded-lg p-2 overflow-x-auto">{JSON.stringify(event.agent_questions, null, 2)}</pre>
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        )))}
                          {/* Print-only events table (Task 10) */}
                          <table className="print-only-table print-table">
                            <thead>
                              <tr>
                                <th>Tipo</th>
                                <th>Criticidad</th>
                                <th>Activo</th>
                                <th>Acción tomada</th>
                                <th>Estado</th>
                              </tr>
                            </thead>
                            <tbody>
                              {selectedEvents.map(ev => (
                                <tr key={ev.id}>
                                  <td className="capitalize">{eventTypeLabels[ev.event_type] || ev.event_type}</td>
                                  <td>{ev.criticality}</td>
                                  <td>{ev.asset_tag || '—'}</td>
                                  <td>{ev.action_taken || '—'}</td>
                                  <td>{ev.status === 'abierto' ? 'Abierto' : 'Resuelto'}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>

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

      {/* Delete confirmation modal */}
      {deleteConfirmModal && (
        <div className="fixed inset-0 z-[90] bg-black/60 flex items-center justify-center p-4" onClick={() => setDeleteConfirmModal(null)}>
          <div className="max-w-md w-full bg-bg-card rounded-2xl overflow-hidden p-6" onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-3 mb-4">
              <AlertTriangle size={24} className="text-danger shrink-0" />
              <h3 className="text-lg font-bold text-text-primary">Confirmar</h3>
            </div>
            <p className="text-sm text-text-secondary mb-6">{deleteConfirmModal.message}</p>
            <div className="flex gap-3 justify-end">
              <button onClick={() => setDeleteConfirmModal(null)} className="btn-secondary text-sm py-2 px-4">
                Cancelar
              </button>
              <button onClick={deleteConfirmModal.onConfirm} className="btn-danger text-sm py-2 px-4">
                Confirmar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}