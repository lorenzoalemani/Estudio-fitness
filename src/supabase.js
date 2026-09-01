// ESTUDIO FITNESS - SUPABASE REALTIME & BACKEND CLIENT ENGINE

// Configuración por defecto o mediante variables globales/entorno
const SUPABASE_CONFIG = {
  url: window.ENV_SUPABASE_URL || 'https://fsvuuysjfnjjjbfjgxjj.supabase.co',
  anonKey: window.ENV_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZzdnV1eXNqZm5qampiZmpneGpqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODYzNzE4NjIsImV4cCI6MjEwMTk0Nzg2Mn0.0kqWhbrsdEvJyKmPM4jH4AGO441n4eXpYjBtAxICvAE'
  // La VAPID public key ya NO vive acá hardcodeada (ni real ni dummy):
  // se pide en runtime al backend vía SupabaseEngine.getVapidPublicKey(),
  // que lee /api/vapid-public-key (Vercel) o /.netlify/functions/vapid-public-key.
};

class SupabaseEngine {
  constructor() {
    this.client = null;
    this.isRealtimeConnected = false;
    this.initClient();
  }

  initClient() {
    if (window.supabase && window.supabase.createClient) {
      try {
        this.client = window.supabase.createClient(SUPABASE_CONFIG.url, SUPABASE_CONFIG.anonKey);
        console.log("⚡ Cliente Supabase inicializado correctamente.");
        this.setupRealtimeSubscriptions();
      } catch (e) {
        console.warn("⚠️ No se pudo conectar a Supabase, operando en modo local seguro:", e);
      }
    } else {
      console.warn("⚠️ SDK de Supabase no cargado desde CDN aún.");
    }
  }

  setupRealtimeSubscriptions() {
    if (!this.client) return;

    try {
      const channel = this.client.channel('estudio-fitness-realtime')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'routines' }, payload => this.handleRealtimeEvent('routines', payload))
        .on('postgres_changes', { event: '*', schema: 'public', table: 'routine_days' }, payload => this.handleRealtimeEvent('routine_days', payload))
        .on('postgres_changes', { event: '*', schema: 'public', table: 'exercise_goals' }, payload => this.handleRealtimeEvent('exercise_goals', payload))
        .on('postgres_changes', { event: '*', schema: 'public', table: 'workout_logs' }, payload => this.handleRealtimeEvent('workout_logs', payload))
        .on('postgres_changes', { event: '*', schema: 'public', table: 'notifications' }, payload => this.handleRealtimeEvent('notifications', payload))
        .on('postgres_changes', { event: '*', schema: 'public', table: 'profiles' }, payload => this.handleRealtimeEvent('profiles', payload))
        .on('postgres_changes', { event: '*', schema: 'public', table: 'authorized_dnis' }, payload => this.handleRealtimeEvent('authorized_dnis', payload))
        .subscribe((status) => {
          if (status === 'SUBSCRIBED') {
            this.isRealtimeConnected = true;
            console.log("🟢 Conectado a Supabase Realtime WebSocket (Rutinas, Días, Ejercicios, Perfiles y DNI Autorizados)");
          }
        });
    } catch (err) {
      console.warn("Error iniciando canal Realtime:", err);
    }
  }

  handleRealtimeEvent(table, payload) {
    console.log(`⚡ Cambios en tiempo real en la tabla [${table}]:`, payload);
    window.dispatchEvent(new CustomEvent('supabase_realtime_change', {
      detail: { table, eventType: payload.eventType, record: payload.new || payload.old }
    }));
  }

  // --- CONSULTAS SELECT Y SINCRONIZACIÓN DESDE SUPABASE DB ---
  // alumnoId opcional: si se pasa, usa la RPC segura para obtener rutinas del alumno.
  // Si es profesor (alumnoId = null), las rutinas se omiten (el profesor usa localStorage).
  async fetchFullStateFromSupabase(alumnoId) {
    if (!this.client) return null;
    try {
      // 1. Consultas abiertas por RLS: profiles y authorized_dnis tienen
      //    políticas anon que permiten al menos el INSERT de alumnos nuevos.
      //    El SELECT de profiles devuelve vacío para anon — se usa para
      //    detectar si el alumno fue autorizado en otro dispositivo.
      let [resAuthDnis, resProfiles, resLogs, resLogSets, resNotifs] = await Promise.all([
        this.client.from('authorized_dnis').select('*'),
        // puntos_total/racha_semanas/racha_ultima_semana: fuente de verdad del
        // ranking (ver sql/patch_gestion_rutinas_y_puntos.sql). Se leen acá para
        // que cada dispositivo muestre el mismo número, en vez del contador
        // aislado que vivía antes solo en alumno.puntosTotal de localStorage.
        this.client.from('profiles').select('id,dni,nombre,nombre_apodo_profesor,telefono,rol,estado_autorizacion,created_at,puntos_total,racha_semanas,racha_ultima_semana,auth_user_id'),
        // Nested: trae series junto al log (más fiable que un SELECT suelto a sets)
        this.client.from('workout_logs').select('*, workout_log_sets(*)'),
        this.client.from('workout_log_sets').select('*'),
        this.client.from('notifications').select('*')
      ]);

      // Si el embed falla (nombre de FK distinto), reintentar logs planos
      if (resLogs.error) {
        console.warn('⚠️ workout_logs nested select falló, reintento plano:', resLogs.error.message);
        resLogs = await this.client.from('workout_logs').select('*');
      }

      // IMPORTANTE: distinguimos "consulta falló" (error !== null → no podemos
      // confiar en el resultado, no debe usarse para reconciliar/podar estado
      // local) de "consulta exitosa pero sin filas" ([] legítimo → SÍ debe
      // usarse para reconciliar, incluso vaciando la colección local si
      // corresponde). Antes, `(res.data || [])` conflaba ambos casos: un error
      // silencioso se comportaba igual que un vacío legítimo.
      const dnisAutorizados = resAuthDnis.error
        ? null
        : (resAuthDnis.data || []).map(d => ({ dni: d.dni, nombre: d.nombre }));

      const alumnos = resProfiles.error
        ? null
        : (resProfiles.data || []).filter(p => p.rol === 'alumno').map(a => {
            // nombreProfesor: apodo que el profesor asigna para identificar al
            // alumno en SU interfaz. Fuente de verdad: authorized_dnis.nombre
            // (NUNCA profiles.nombre). Si el DNI todavía no tiene fila en
            // authorized_dnis (alumno no autorizado aún), queda null y la UI
            // usa alumno.nombre (nombre real) como fallback.
            const dniAuth = (dnisAutorizados || []).find(d => d.dni === a.dni);
            return {
              id: a.id,
              dni: a.dni,
              // password: NUNCA se lee desde Supabase (columna no existe en profiles).
              // Los passwords legacy viven exclusivamente en localStorage y son
              // preservados por syncWithSupabase() durante la reconciliación.
              // No incluir esta propiedad aquí evita que sbAlumno.password sea null
              // (en lugar de undefined), lo que cortocircuitaría la lógica de
              // preservación en syncWithSupabase().
              nombre: a.nombre,
              nombreProfesor: a.nombre_apodo_profesor || null,
              telefono: a.telefono || "",
              estadoAutorizacion: a.estado_autorizacion,
              fechaRegistro: a.created_at ? a.created_at.split('T')[0] : new Date().toISOString().split('T')[0],
              rutinaActivaId: null,
              // auth_user_id: UUID de Supabase Auth. Puede ser null si la cuenta
              // todavía no fue vinculada (Etapa 1 de migración). Se preserva
              // undefined si la columna no existe aún en producción.
              authUserId: a.auth_user_id !== undefined ? (a.auth_user_id || null) : undefined,
              // Valor autoritativo desde Supabase. Puede venir undefined si la
              // columna todavía no existe en producción (antes de correr el patch
              // SQL) — en ese caso data.js conserva el valor local existente.
              puntosTotal: (a.puntos_total !== null && a.puntos_total !== undefined) ? Number(a.puntos_total) : undefined,
              rachaSemanal: (a.racha_semanas !== null && a.racha_semanas !== undefined)
                ? { semanas: Number(a.racha_semanas), ultimaSemana: a.racha_ultima_semana || null }
                : undefined
            };
          });

      const profesores = resProfiles.error
        ? null
        : (resProfiles.data || []).filter(p => p.rol === 'profesor').map(p => ({
            id: p.id,
            dni: p.dni,
            // password: NUNCA se lee desde Supabase (columna no existe en profiles).
            // La contraseña hardcodeada del profesor ("octagym2000") vive en
            // DEFAULT_DATA y se conserva en localStorage hasta que sea migrado
            // a Supabase Auth. syncWithSupabase() la preserva durante la
            // reconciliación siempre que authUserId no esté confirmado.
            nombre: p.nombre,
            rol: "profesor",
            // auth_user_id: UUID de Supabase Auth. Puede ser null si todavía
            // no fue vinculado (Etapa 1 de migración).
            authUserId: p.auth_user_id !== undefined ? (p.auth_user_id || null) : undefined
          }));

      // 2. Rutinas: solo via RPC segura cuando hay alumnoId conocido.
      //    Si es profesor o no hay alumnoId, no se consulta nada → `null`
      //    (distinto de "consultamos y no hay rutinas", que sería `[]`).
      //    Si la RPC falla, también queda en `null` para no pisar/podar el
      //    estado local con un resultado que no pudimos verificar.
      let rutinas = null;
      if (alumnoId) {
        const alumnoUuid = this.ensureValidUUID(alumnoId);
        const { data: rpcData, error: rpcErr } = await this.client.rpc('obtener_rutinas_alumno', {
          p_alumno_id: alumnoUuid
        });
        if (rpcErr) {
          console.warn("⚠️ RPC obtener_rutinas_alumno falló:", rpcErr.message);
        } else {
          rutinas = Array.isArray(rpcData) ? rpcData : [];
          console.log(`📦 RPC obtener_rutinas_alumno: ${rutinas.length} rutina(s) para alumno ${alumnoUuid}`);
        }
      }

      // 3. Historial de entrenamientos + series
      const mapSetRow = (s) => ({
        ejercicioId: s.exercise_goal_id || s.ejercicio_id || null,
        ejercicioNombre: s.exercise_nombre || s.ejercicio_nombre || s.nombre || s.exercise_name || '',
        setNumero: s.set_numero != null ? s.set_numero : (s.setNumero || 0),
        repsRealizadas: s.reps_realizadas != null ? s.reps_realizadas : (s.reps || ''),
        pesoUtilizado: s.peso_utilizado != null ? s.peso_utilizado : (s.peso || ''),
        comentarioAlumno: s.comentario_alumno || s.comentario || ''
      });

      if (resLogSets.error) {
        console.warn('⚠️ SELECT workout_log_sets falló:', resLogSets.error.message || resLogSets.error);
      } else {
        console.log('📦 workout_log_sets recibidos:', (resLogSets.data || []).length);
      }
      if (resLogs.error) {
        console.warn('⚠️ SELECT workout_logs falló:', resLogs.error.message || resLogs.error);
      } else {
        console.log('📦 workout_logs recibidos:', (resLogs.data || []).length);
      }

      const setsByLog = {};
      const addSet = (lid, row) => {
        if (!lid) return;
        const key = String(lid);
        if (!setsByLog[key]) setsByLog[key] = [];
        setsByLog[key].push(row);
      };
      (resLogSets.data || []).forEach(s => addSet(s.workout_log_id, mapSetRow(s)));

      // Si el SELECT global de sets vino vacío pero hay logs, pedir series por IDs
      // (más compatible con RLS y evita perder historial con detalle).
      let logRows = resLogs.error ? null : (resLogs.data || []);
      if (logRows && logRows.length && Object.keys(setsByLog).length === 0) {
        const ids = logRows.map(l => l.id).filter(Boolean);
        for (let i = 0; i < ids.length; i += 50) {
          const chunk = ids.slice(i, i + 50);
          try {
            const { data: extraSets, error: extraErr } = await this.client
              .from('workout_log_sets')
              .select('*')
              .in('workout_log_id', chunk);
            if (extraErr) {
              console.warn('⚠️ SELECT sets por ids falló:', extraErr.message);
            } else {
              (extraSets || []).forEach(s => addSet(s.workout_log_id, mapSetRow(s)));
            }
          } catch (e) {
            console.warn('⚠️ Excepción sets por ids:', e && e.message);
          }
        }
        console.log('📦 sets tras re-fetch por ids, logs con series:', Object.keys(setsByLog).length);
      }

      const workoutLogs = logRows === null
        ? null
        : logRows.map(l => {
            const nested = Array.isArray(l.workout_log_sets) ? l.workout_log_sets.map(mapSetRow) : [];
            const flat = setsByLog[String(l.id)] || setsByLog[l.id] || [];
            const sets = nested.length > 0 ? nested : flat;
            return {
              id: l.id,
              alumnoId: l.alumno_id,
              rutinaId: l.routine_id,
              diaId: l.dia_id || 'dia-1',
              diaNombre: l.dia_nombre,
              diaNumero: l.dia_numero || 1,
              fecha: l.fecha_entrenamiento,
              estado: l.estado,
              comentarioGeneral: l.comentario_general || '',
              puntos: l.puntos != null ? l.puntos : undefined,
              sets
            };
          });

      const notificaciones = resNotifs.error
        ? null
        : (resNotifs.data || []).map(n => ({
            id: n.id,
            destinatarioRol: n.destinatario_rol,
            alumnoId: n.alumno_id,
            mensaje: n.mensaje,
            rutaDestino: n.ruta_destino,
            fecha: n.created_at,
            leido: n.leido
          }));

      // A partir de acá cada campo es: un array (posiblemente vacío = snapshot
      // válido) o `null` (no se consultó o la consulta falló → no tocar/podar
      // el estado local para ese campo). data.js debe chequear `!== null`,
      // NO `.length > 0`, para no confundir "vacío real" con "sin datos".
      return {
        dnisAutorizados,
        alumnos,
        profesores,
        rutinas,
        workoutLogs,
        notificaciones
      };
    } catch (e) {
      console.warn("⚠️ Error obteniendo datos de Supabase:", e);
      return null;
    }
  }

  // --- HELPER UUID DETERMINÍSTICO PARA SUPABASE DB ---
  ensureValidUUID(idStr) {
    if (!idStr) return (window.crypto && window.crypto.randomUUID) ? window.crypto.randomUUID() : '00000000-0000-4000-a000-' + String(Date.now()).padStart(12, '0');
    const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idStr);
    if (isUUID) return idStr;

    // Convertir de forma determinística strings como "rut-1723456789000" o "al-1723456789000"
    const digits = String(idStr).replace(/[^0-9]/g, '');
    let paddedHex = '000000000000';
    try {
      if (digits.length > 0) {
        paddedHex = BigInt(digits).toString(16).padStart(12, '0').slice(-12);
      }
    } catch (e) {
      paddedHex = String(Date.now()).padStart(12, '0').slice(-12);
    }
    return `00000000-0000-4000-a000-${paddedHex}`;
  }

  // --- OPERACIONES DE ESCRITURA RELACIONAL EN SUPABASE DB ---
  async registrarPerfilEnSupabase(alumno) {
    if (!this.client) return;
    try {
      const cleanDni = String(alumno.dni).trim();
      const profileId = this.ensureValidUUID(alumno.id);
      alumno.id = profileId;

      const { error } = await this.client.from('profiles').insert({
        id: profileId,
        dni: cleanDni,
        nombre: alumno.nombre.trim(),
        telefono: alumno.telefono ? alumno.telefono.trim() : "",
        rol: 'alumno',
        estado_autorizacion: 'pendiente'
      });

      if (error) {
        console.error("❌ Error insertando perfil en Supabase DB (profiles):", error);
      } else {
        console.log("✅ Perfil de alumno registrado exitosamente en Supabase DB (profiles).");
      }
    } catch (err) {
      console.error("❌ Excepción al registrar perfil en Supabase DB:", err);
    }
  }

  async autorizarDniEnSupabase(dni, nombre) {
    if (!this.client) return;
    try {
      const cleanDni = String(dni).trim();

      // 1. Insertar o actualizar en authorized_dnis
      const { data: authData, error: authErr } = await this.client
        .from('authorized_dnis')
        .upsert({ dni: cleanDni, nombre: nombre.trim() }, { onConflict: 'dni' })
        .select();

      if (authErr) {
        console.error("❌ Error autorizando DNI en Supabase DB (authorized_dnis):", authErr);
      } else {
        console.log(`✅ DNI ${cleanDni} insertado/autorizado en Supabase DB (authorized_dnis):`, authData);
      }

      // 2. Actualizar profiles si ya existe perfil con ese DNI
      const { data: profData, error: profErr } = await this.client
        .from('profiles')
        .update({ estado_autorizacion: 'autorizado' })
        .eq('dni', cleanDni)
        .select();

      if (profErr) {
        console.error("❌ Error actualizando perfil a autorizado en Supabase DB (profiles):", profErr);
      } else if (profData && profData.length > 0) {
        console.log(`✅ Perfil de alumno con DNI ${cleanDni} actualizado a 'autorizado' en Supabase DB:`, profData);
      }
    } catch (err) {
      console.error("❌ Excepción en autorizarDniEnSupabase:", err);
    }
  }

  async persistirNuevaRutinaEnSupabase(rutina) {
    if (!this.client) return { ok: false, error: 'cliente_no_inicializado' };
    if (!window._sessionProfesorId) {
      console.error('🚫 Bloqueado: intento de escribir una rutina sin sesión de profesor activa.');
      return { ok: false, error: 'no_autorizado_no_es_profesor' };
    }
    console.log("🔎 DEBUG SUPABASE ANTES ensureValidUUID:", {
    rutinaAlumnoId: rutina.alumnoId,
    rutinaId: rutina.id
});
    try {
      const routineUuid = this.ensureValidUUID(rutina.id);
const alumnoUuid = this.ensureValidUUID(rutina.alumnoId);

console.log("🔎 DEBUG SUPABASE DESPUÉS ensureValidUUID:", {
    originalAlumnoId: rutina.alumnoId,
    alumnoUuidGenerado: alumnoUuid,
    originalRutinaId: rutina.id,
    routineUuidGenerado: routineUuid
});

rutina.id = routineUuid;
rutina.alumnoId = alumnoUuid;

      

      // Asegurar UUIDs válidos en todos los niveles
      rutina.dias = (rutina.dias || []).map(d => ({
        ...d,
        id: this.ensureValidUUID(d.id),
        ejercicios: (d.ejercicios || []).map(e => ({
          ...e,
          id: this.ensureValidUUID(e.id)
        }))
      }));

      // Única vía: RPC guardar_rutina_profesor (SECURITY DEFINER)
      // Las tablas routines / routine_days / exercise_goals están protegidas por RLS.
      console.log("🔎 DEBUG ANTES RPC:", {
    alumnoId: rutina.alumnoId,
    rutinaId: rutina.id,
    titulo: rutina.titulo
});

const { data: rpcData, error: rpcErr } = await this.client.rpc(
    'guardar_rutina_profesor',
    { p_rutina: rutina }
);

      if (rpcErr) {
        console.error('❌ RPC guardar_rutina_profesor falló (nueva rutina):', rpcErr.message, rpcErr);
        return { ok: false, error: rpcErr.message };
      }

      if (rpcData && rpcData.ok === false) {
        console.error('❌ RPC guardar_rutina_profesor retornó error de negocio:', rpcData.error);
        return { ok: false, error: rpcData.error };
      }

      console.log('✅ Nueva rutina persistida atómicamente via RPC en Supabase DB.', rpcData);
      return { ok: true, data: rpcData };
    } catch (err) {
      console.error('❌ Excepción en persistirNuevaRutinaEnSupabase:', err);
      return { ok: false, error: err.message };
    }
  }

  async persistirEdicionRutinaEnSupabase(rutina) {
    if (!this.client) return { ok: false, error: 'cliente_no_inicializado' };
    if (!window._sessionProfesorId) {
      console.error('🚫 Bloqueado: intento de escribir una rutina sin sesión de profesor activa.');
      return { ok: false, error: 'no_autorizado_no_es_profesor' };
    }
    try {
      const routineUuid = this.ensureValidUUID(rutina.id);
      rutina.id = routineUuid;

      // Asegurar UUIDs válidos en todos los niveles
      rutina.dias = (rutina.dias || []).map(d => ({
        ...d,
        id: this.ensureValidUUID(d.id),
        ejercicios: (d.ejercicios || []).map(e => ({
          ...e,
          id: this.ensureValidUUID(e.id)
        }))
      }));

      // Única vía: RPC guardar_rutina_profesor (SECURITY DEFINER)
      // La RPC detecta si la rutina existe y hace UPDATE o INSERT según corresponda.
      const { data: rpcData, error: rpcErr } = await this.client.rpc(
        'guardar_rutina_profesor',
        { p_rutina: rutina }
      );

      if (rpcErr) {
        console.error('❌ RPC guardar_rutina_profesor falló (edición rutina):', rpcErr.message, rpcErr);
        return { ok: false, error: rpcErr.message };
      }

      if (rpcData && rpcData.ok === false) {
        console.error('❌ RPC guardar_rutina_profesor retornó error de negocio:', rpcData.error);
        return { ok: false, error: rpcData.error };
      }

      console.log('✅ Edición de rutina persistida atómicamente via RPC en Supabase DB.', rpcData);
      return { ok: true, data: rpcData };
    } catch (err) {
      console.error('❌ Excepción en persistirEdicionRutinaEnSupabase:', err);
      return { ok: false, error: err.message };
    }
  }

  // --- ACTIVAR/DESACTIVAR RUTINA: RPC segura (bypassea RLS de routines) ---
  async cambiarEstadoRutinaEnSupabase(rutinaId, profesorId, nuevoEstado) {
    if (!this.client) return { ok: false, error: 'cliente_no_inicializado' };
    if (!window._sessionProfesorId) {
      console.error('🚫 Bloqueado: intento de cambiar estado de rutina sin sesión de profesor activa.');
      return { ok: false, error: 'no_autorizado_no_es_profesor' };
    }
    try {
      const rutinaUuid   = this.ensureValidUUID(rutinaId);
      const profesorUuid = this.ensureValidUUID(profesorId);
      const { data: rpcData, error: rpcErr } = await this.client.rpc('cambiar_estado_rutina_profesor', {
        p_rutina_id: rutinaUuid,
        p_profesor_id: profesorUuid,
        p_nuevo_estado: nuevoEstado
      });
      if (rpcErr) {
        console.error('❌ RPC cambiar_estado_rutina_profesor falló:', rpcErr.message, rpcErr);
        return { ok: false, error: rpcErr.message };
      }
      if (rpcData && rpcData.ok === false) {
        console.error('❌ RPC cambiar_estado_rutina_profesor retornó error de negocio:', rpcData.error);
        return { ok: false, error: rpcData.error };
      }
      console.log('✅ Estado de rutina cambiado atómicamente via RPC en Supabase DB.', rpcData);
      return { ok: true, data: rpcData };
    } catch (err) {
      console.error('❌ Excepción en cambiarEstadoRutinaEnSupabase:', err);
      return { ok: false, error: err.message };
    }
  }

  // --- BORRAR RUTINA: RPC segura (bypassea RLS de routines) ---
  async eliminarRutinaEnSupabase(rutinaId, profesorId) {
    if (!this.client) return { ok: false, error: 'cliente_no_inicializado' };
    if (!window._sessionProfesorId) {
      console.error('🚫 Bloqueado: intento de borrar rutina sin sesión de profesor activa.');
      return { ok: false, error: 'no_autorizado_no_es_profesor' };
    }
    try {
      const rutinaUuid   = this.ensureValidUUID(rutinaId);
      const profesorUuid = this.ensureValidUUID(profesorId);
      const { data: rpcData, error: rpcErr } = await this.client.rpc('borrar_rutina_profesor', {
        p_rutina_id: rutinaUuid,
        p_profesor_id: profesorUuid
      });
      if (rpcErr) {
        console.error('❌ RPC borrar_rutina_profesor falló:', rpcErr.message, rpcErr);
        return { ok: false, error: rpcErr.message };
      }
      if (rpcData && rpcData.ok === false) {
        console.error('❌ RPC borrar_rutina_profesor retornó error de negocio:', rpcData.error);
        return { ok: false, error: rpcData.error };
      }
      console.log('✅ Rutina borrada atómicamente via RPC en Supabase DB.', rpcData);
      return { ok: true, data: rpcData };
    } catch (err) {
      console.error('❌ Excepción en eliminarRutinaEnSupabase:', err);
      return { ok: false, error: err.message };
    }
  }

  // --- RUTINA PROPIA DEL ALUMNO: RPC segura, SIN depender de _sessionProfesorId ---
  // Vía separada de persistirNuevaRutinaEnSupabase/persistirEdicionRutinaEnSupabase
  // (que son exclusivas del profesor). La RPC guardar_rutina_propia_alumno
  // (SECURITY DEFINER) valida la identidad del alumno server-side vía
  // auth.uid() y hace INSERT o UPDATE según corresponda (mismo patrón upsert
  // que guardar_rutina_profesor). profesor_id siempre queda NULL para estas
  // rutinas.
  async persistirRutinaPropiaEnSupabase(rutina) {
    if (!this.client) return { ok: false, error: 'cliente_no_inicializado' };
    try {
      const routineUuid = this.ensureValidUUID(rutina.id);
      const alumnoUuid = this.ensureValidUUID(rutina.alumnoId);

      rutina.id = routineUuid;
      rutina.alumnoId = alumnoUuid;
      // Nunca debe viajar un profesorId en la rutina propia del alumno.
      rutina.profesorId = null;

      // Asegurar UUIDs válidos en todos los niveles
      rutina.dias = (rutina.dias || []).map(d => ({
        ...d,
        id: this.ensureValidUUID(d.id),
        ejercicios: (d.ejercicios || []).map(e => ({
          ...e,
          id: this.ensureValidUUID(e.id)
        }))
      }));

      const { data: rpcData, error: rpcErr } = await this.client.rpc(
        'guardar_rutina_propia_alumno',
        { p_rutina: rutina }
      );

      if (rpcErr) {
        console.error('❌ RPC guardar_rutina_propia_alumno falló:', rpcErr.message, rpcErr);
        return { ok: false, error: rpcErr.message };
      }

      if (rpcData && rpcData.ok === false) {
        console.error('❌ RPC guardar_rutina_propia_alumno retornó error de negocio:', rpcData.error);
        return { ok: false, error: rpcData.error };
      }

      console.log('✅ Rutina propia persistida atómicamente via RPC en Supabase DB.', rpcData);
      return { ok: true, data: rpcData };
    } catch (err) {
      console.error('❌ Excepción en persistirRutinaPropiaEnSupabase:', err);
      return { ok: false, error: err.message };
    }
  }

  // --- BORRAR RUTINA PROPIA DEL ALUMNO: RPC segura, SIN depender de _sessionProfesorId ---
  async eliminarRutinaPropiaEnSupabase(rutinaId, alumnoId) {
    if (!this.client) return { ok: false, error: 'cliente_no_inicializado' };
    try {
      const rutinaUuid = this.ensureValidUUID(rutinaId);
      const alumnoUuid = this.ensureValidUUID(alumnoId);
      const { data: rpcData, error: rpcErr } = await this.client.rpc('eliminar_rutina_propia_alumno', {
        p_rutina_id: rutinaUuid,
        p_alumno_id: alumnoUuid
      });
      if (rpcErr) {
        console.error('❌ RPC eliminar_rutina_propia_alumno falló:', rpcErr.message, rpcErr);
        return { ok: false, error: rpcErr.message };
      }
      if (rpcData && rpcData.ok === false) {
        console.error('❌ RPC eliminar_rutina_propia_alumno retornó error de negocio:', rpcData.error);
        return { ok: false, error: rpcData.error };
      }
      console.log('✅ Rutina propia borrada atómicamente via RPC en Supabase DB.', rpcData);
      return { ok: true, data: rpcData };
    } catch (err) {
      console.error('❌ Excepción en eliminarRutinaPropiaEnSupabase:', err);
      return { ok: false, error: err.message };
    }
  }

  async guardarWorkoutLogEnSupabase(log) {
    if (!this.client) return { ok: false, error: 'sin_cliente' };
    try {
      const logUuid    = this.ensureValidUUID(log.id);
      const alumnoUuid = this.ensureValidUUID(log.alumnoId);
      let routineUuid = null;
      try { routineUuid = this.ensureValidUUID(log.rutinaId); } catch (_) { routineUuid = log.rutinaId || null; }
      log.id = logUuid;

      // 1) Log del entrenamiento
      const { error: lErr } = await this.client.from('workout_logs').insert({
        id:                  logUuid,
        alumno_id:           alumnoUuid,
        routine_id:          routineUuid,
        dia_numero:          log.diaNumero || 1,
        dia_nombre:          log.diaNombre,
        comentario_general:  log.comentarioGeneral || null,
        estado:              log.estado || 'completado',
        fecha_entrenamiento: log.fecha
      });
      if (lErr) {
        const msg = String(lErr.message || lErr);
        console.warn('⚠️ INSERT workout_logs:', msg);
        // Si no es duplicado, igual seguimos a series (el log puede existir)
      }

      const sets = Array.isArray(log.sets) ? log.sets : [];
      console.log('📝 Persistiendo series:', sets.length, 'log', logUuid);

      if (!sets.length) {
        return { ok: true, setsOk: 0, warning: 'sin_series_en_payload' };
      }

      // Payload compatible con la RPC de edición (SECURITY DEFINER, saltea RLS)
      const setsPayload = sets.map((s, i) => {
        const repsRaw = s.repsRealizadas != null ? s.repsRealizadas : s.reps;
        let reps = parseInt(String(repsRaw == null ? '0' : repsRaw).replace(/[^\d-]/g, ''), 10);
        if (!Number.isFinite(reps) || reps < 0) reps = 0;
        let peso = s.pesoUtilizado != null ? s.pesoUtilizado : s.peso;
        if (peso == null || String(peso).trim() === '') peso = '0';
        peso = String(peso);
        const nombre = (s.ejercicioNombre || s.ejercicio || s.nombre || 'Ejercicio').toString().trim() || 'Ejercicio';
        let setNum = parseInt(s.setNumero, 10);
        if (!Number.isFinite(setNum) || setNum < 1) setNum = i + 1;
        return {
          exercise_goal_id:  null,
          exercise_nombre:   nombre,
          set_numero:        setNum,
          reps_realizadas:   reps,
          peso_utilizado:    peso,
          comentario_alumno: s.comentarioAlumno || null
        };
      });

      let setsOk = 0;
      let lastErr = null;

      // 2) Preferir RPC (misma que editar dentro de 2hs) — evita RLS en workout_log_sets
      try {
        const { data: rpcData, error: rpcErr } = await this.client.rpc('editar_workout_log_sets_alumno', {
          p_workout_log_id: logUuid,
          p_alumno_id: alumnoUuid,
          p_sets: setsPayload,
          p_comentario_general: log.comentarioGeneral ?? null
        });
        if (!rpcErr && !(rpcData && rpcData.ok === false)) {
          setsOk = setsPayload.length;
          console.log('✅ Series guardadas via RPC editar_workout_log_sets_alumno', rpcData);
        } else {
          lastErr = rpcErr || (rpcData && rpcData.error) || 'rpc_fallo';
          console.warn('⚠️ RPC series falló, pruebo INSERT directo:', lastErr);
        }
      } catch (e) {
        lastErr = e && e.message;
        console.warn('⚠️ RPC series excepción, INSERT directo:', lastErr);
      }

      // 3) Fallback: INSERT directo
      if (setsOk === 0) {
        const rows = setsPayload.map(s => ({
          workout_log_id:  logUuid,
          exercise_nombre: s.exercise_nombre,
          set_numero:      s.set_numero,
          reps_realizadas: s.reps_realizadas,
          peso_utilizado:  s.peso_utilizado,
          comentario_alumno: s.comentario_alumno
        }));
        const { error: batchErr } = await this.client.from('workout_log_sets').insert(rows);
        if (!batchErr) {
          setsOk = rows.length;
          console.log('✅ Series guardadas via INSERT directo', setsOk);
        } else {
          lastErr = batchErr;
          console.warn('⚠️ INSERT lote series:', batchErr.message || batchErr);
          for (const row of rows) {
            const { error: sErr } = await this.client.from('workout_log_sets').insert(row);
            if (!sErr) setsOk++;
            else {
              lastErr = sErr;
              console.error('❌ INSERT set:', sErr.message || sErr, row);
            }
          }
        }
      }

      // Verificación
      let countInDb = null;
      try {
        const { count } = await this.client
          .from('workout_log_sets')
          .select('id', { count: 'exact', head: true })
          .eq('workout_log_id', logUuid);
        countInDb = count;
      } catch (_) {}

      console.log('✅ Entrenamiento persistido.', { logUuid, setsOk, total: sets.length, countInDb });

      if (setsOk === 0) {
        return { ok: false, error: (lastErr && (lastErr.message || lastErr)) || 'series_no_guardadas', setsOk: 0 };
      }
      return { ok: true, setsOk, countInDb };
    } catch (err) {
      console.error('❌ Excepción guardando entrenamiento real en Supabase DB:', err);
      return { ok: false, error: err.message };
    }
  }

  // --- BORRAR ENTRENAMIENTO DEL HISTORIAL (solo el propio alumno) ---
  async eliminarWorkoutLogEnSupabase(logId, alumnoId, puntosARestar = 0) {
    if (!this.client) return { ok: false, error: 'Sin conexión a Supabase' };
    try {
      const logUuid = this.ensureValidUUID(logId);
      const alumnoUuid = this.ensureValidUUID(alumnoId);
      const pts = Math.max(0, Math.round(Number(puntosARestar) || 0));

      // 1) Preferir RPC atómica (borra log+sets y resta puntos_total)
      try {
        const { data: rpcData, error: rpcErr } = await this.client.rpc('eliminar_entrenamiento_alumno', {
          p_workout_log_id: logUuid,
          p_alumno_id: alumnoUuid,
          p_puntos_a_restar: pts
        });
        if (!rpcErr && rpcData && rpcData.ok !== false) {
          console.log('✅ Entrenamiento borrado via RPC eliminar_entrenamiento_alumno', rpcData);
          return { ok: true, puntosRestados: pts, puntosTotal: rpcData.puntosTotal };
        }
        if (rpcErr) {
          console.warn('⚠️ RPC eliminar_entrenamiento_alumno no disponible, fallback manual:', rpcErr.message);
        }
      } catch (e) {
        console.warn('⚠️ RPC eliminar_entrenamiento_alumno falló, fallback manual:', e && e.message);
      }

      // 2) Fallback: borrar sets + log
      const { error: sErr } = await this.client
        .from('workout_log_sets')
        .delete()
        .eq('workout_log_id', logUuid);
      if (sErr) {
        console.error('❌ Error borrando workout_log_sets:', sErr);
        return { ok: false, error: sErr.message };
      }

      const { error: lErr } = await this.client
        .from('workout_logs')
        .delete()
        .eq('id', logUuid)
        .eq('alumno_id', alumnoUuid);
      if (lErr) {
        console.error('❌ Error borrando workout_logs:', lErr);
        return { ok: false, error: lErr.message };
      }

      // 3) Restar puntos en profiles (fuente del ranking)
      if (pts > 0) {
        const { data: prof, error: pReadErr } = await this.client
          .from('profiles')
          .select('puntos_total')
          .eq('id', alumnoUuid)
          .maybeSingle();
        if (pReadErr) {
          console.warn('⚠️ No se pudo leer puntos_total para restar:', pReadErr.message);
        } else {
          const actual = Number(prof && prof.puntos_total) || 0;
          const nuevo = Math.max(0, actual - pts);
          const { error: pUpErr } = await this.client
            .from('profiles')
            .update({ puntos_total: nuevo })
            .eq('id', alumnoUuid);
          if (pUpErr) {
            console.error('❌ No se pudieron restar puntos en profiles:', pUpErr.message);
            // El log ya se borró; avisamos pero no revertimos el delete
            return { ok: true, puntosRestados: 0, warning: 'log_borrado_pero_puntos_no_restados' };
          }
          console.log('✅ puntos_total actualizado:', actual, '→', nuevo);
          return { ok: true, puntosRestados: pts, puntosTotal: nuevo };
        }
      }

      console.log('✅ Entrenamiento borrado en Supabase:', logUuid);
      return { ok: true, puntosRestados: pts };
    } catch (err) {
      console.error('❌ Excepción eliminarWorkoutLogEnSupabase:', err);
      return { ok: false, error: err.message };
    }
  }

    // --- EDITAR SERIES DE UN ENTRENAMIENTO YA GUARDADO (ventana de 2hs) ---
  // RPC segura: valida server-side que el log sea del alumno y que no
  // pasaron más de 2hs desde fecha_entrenamiento antes de reemplazar sets.
  async editarWorkoutLogSetsEnSupabase(logId, alumnoId, setsLog, comentarioGeneral) {
    if (!this.client) return { ok: false, error: 'cliente_no_inicializado' };
    try {
      const logUuid    = this.ensureValidUUID(logId);
      const alumnoUuid = this.ensureValidUUID(alumnoId);

      const setsPayload = (setsLog || []).map(s => ({
        exercise_goal_id:  s.ejercicioId || null,
        exercise_nombre:   s.ejercicioNombre,
        set_numero:        s.setNumero,
        reps_realizadas:   s.repsRealizadas,
        peso_utilizado:    s.pesoUtilizado,
        comentario_alumno: s.comentarioAlumno || null
      }));

      const { data: rpcData, error: rpcErr } = await this.client.rpc('editar_workout_log_sets_alumno', {
        p_workout_log_id: logUuid,
        p_alumno_id: alumnoUuid,
        p_sets: setsPayload,
        p_comentario_general: comentarioGeneral ?? null
      });

      if (rpcErr) {
        console.error('❌ RPC editar_workout_log_sets_alumno falló:', rpcErr.message, rpcErr);
        return { ok: false, error: rpcErr.message };
      }
      if (rpcData && rpcData.ok === false) {
        console.error('❌ RPC editar_workout_log_sets_alumno retornó error de negocio:', rpcData.error);
        return { ok: false, error: rpcData.error };
      }
      console.log('✅ Entrenamiento editado atómicamente via RPC en Supabase DB (ventana 2hs).', rpcData);
      return { ok: true, data: rpcData };
    } catch (err) {
      console.error('❌ Excepción en editarWorkoutLogSetsEnSupabase:', err);
      return { ok: false, error: err.message };
    }
  }

  // --- PUNTOS/RANKING: RPC atómica que calcula y otorga puntos server-side ---
  // Se llama una vez por cada entrenamiento recién guardado (después de que
  // guardarWorkoutLogEnSupabase ya insertó log + sets). El servidor decide
  // si este entrenamiento es el primero del día calendario (Argentina) del
  // alumno — si no lo es, no otorga puntos (yaHuboEntrenamientoHoy: true),
  // pero el entrenamiento ya quedó guardado en el historial de todas formas.
  async registrarPuntosEntrenamientoEnSupabase(logId, alumnoId) {
    if (!this.client) {
      console.error('❌ registrarPuntosEntrenamientoEnSupabase: Cliente Supabase no inicializado');
      return { ok: false, error: 'cliente_no_inicializado' };
    }
    const logUuid    = this.ensureValidUUID(logId);
    const alumnoUuid = this.ensureValidUUID(alumnoId);

    const llamarRpc = async () => {
      console.log(`🔄 registrarPuntosEntrenamientoEnSupabase: RPC logId=${logUuid}, alumnoId=${alumnoUuid}`);
      const { data, error } = await this.client.rpc('registrar_puntos_entrenamiento_alumno', {
        p_workout_log_id: logUuid,
        p_alumno_id: alumnoUuid
      });
      return { data, error };
    };

    const normalizar = (raw) => {
      let d = raw;
      if (Array.isArray(d)) d = d[0];
      if (d && typeof d === 'object' && d.data && typeof d.data === 'object' && d.ok === undefined) {
        d = d.data;
      }
      return d;
    };

    try {
      let { data: rpcData, error: rpcErr } = await llamarRpc();

      // Reintento único (a veces el log recién insertado aún no es visible para la RPC)
      if (rpcErr || (rpcData && (rpcData.ok === false || (Array.isArray(rpcData) && rpcData[0] && rpcData[0].ok === false)))) {
        console.warn('⚠️ RPC puntos falló, reintento en 500ms:', rpcErr || rpcData);
        await new Promise(r => setTimeout(r, 500));
        const second = await llamarRpc();
        rpcData = second.data;
        rpcErr = second.error;
      }

      if (rpcErr) {
        console.error('❌ registrarPuntosEntrenamientoEnSupabase: RPC error:', rpcErr.message, rpcErr);
        return { ok: false, error: rpcErr.message };
      }

      const d = normalizar(rpcData);
      if (!d) {
        // Algunas funciones void / sin return: si no hay error técnico, contar como OK
        console.warn('⚠️ RPC puntos sin payload; se asume OK (sin error técnico).');
        return { ok: true, puntosGanados: null, bonusRacha: null, puntosTotal: null, yaHuboEntrenamientoHoy: false };
      }
      if (d.ok === false) {
        console.error('❌ registrarPuntosEntrenamientoEnSupabase: negocio:', d.error);
        return { ok: false, error: d.error || 'rpc_negocio' };
      }

      console.log('✅ Puntos registrados en BD:', d);
      return {
        ok: true,
        puntosGanados: d.puntosGanados != null ? d.puntosGanados : d.puntos_ganados,
        bonusRacha: d.bonusRacha != null ? d.bonusRacha : d.bonus_racha,
        puntosTotal: d.puntosTotal != null ? d.puntosTotal : d.puntos_total,
        yaHuboEntrenamientoHoy: !!(d.yaHuboEntrenamientoHoy != null ? d.yaHuboEntrenamientoHoy : d.ya_hubo_entrenamiento_hoy)
      };
    } catch (err) {
      console.error('❌ registrarPuntosEntrenamientoEnSupabase: excepción:', err);
      return { ok: false, error: err.message };
    }
  }

  // --- HISTORIAL: alumno obtiene sus propios registros vía RPC segura ---
  /**
   * Adjunta series a logs existentes SIN reemplazar el log entero.
   * Si el server no trae series para un log, deja las locales intactas.
   */
  async enriquecerSeriesDeLogs(logs) {
    if (!this.client || !Array.isArray(logs) || !logs.length) return logs;
    try {
      const ids = logs.map(l => l && l.id).filter(Boolean);
      const mapSetRow = (s) => ({
        ejercicioId: s.exercise_goal_id || s.ejercicio_id || null,
        ejercicioNombre: s.exercise_nombre || s.ejercicio_nombre || s.nombre || s.exercise_name || '',
        setNumero: s.set_numero != null ? s.set_numero : (s.setNumero || 0),
        repsRealizadas: s.reps_realizadas != null ? s.reps_realizadas : (s.reps || 0),
        pesoUtilizado: s.peso_utilizado != null ? s.peso_utilizado : (s.peso || '0'),
        comentarioAlumno: s.comentario_alumno || s.comentario || ''
      });
      const setsByLog = {};
      for (let i = 0; i < ids.length; i += 50) {
        const chunk = ids.slice(i, i + 50);
        const { data, error } = await this.client
          .from('workout_log_sets')
          .select('*')
          .in('workout_log_id', chunk);
        if (error) {
          console.warn('⚠️ enriquecerSeriesDeLogs:', error.message);
          continue;
        }
        (data || []).forEach(s => {
          const key = String(s.workout_log_id);
          if (!setsByLog[key]) setsByLog[key] = [];
          setsByLog[key].push(mapSetRow(s));
        });
      }
      let enriched = 0;
      logs.forEach(log => {
        if (!log || log.id == null) return;
        const remote = setsByLog[String(log.id)] || [];
        const local = Array.isArray(log.sets) ? log.sets : [];
        if (remote.length > local.length) {
          log.sets = remote;
          enriched++;
        } else if (remote.length > 0 && local.length === 0) {
          log.sets = remote;
          enriched++;
        }
        // si remote vacío → no tocar local
      });
      console.log(`✅ Series enriquecidas en ${enriched} log(s). Keys con series: ${Object.keys(setsByLog).length}`);
      return logs;
    } catch (e) {
      console.warn('⚠️ enriquecerSeriesDeLogs excepción:', e && e.message);
      return logs;
    }
  }

    async obtenerHistorialDesdeSupabase(alumnoId) {
    if (!this.client) return [];
    try {
      const alumnoUuid = this.ensureValidUUID(alumnoId);
      // Misma fuente que el sync general
      const { data: rows, error } = await this.client
        .from('workout_logs')
        .select('*')
        .eq('alumno_id', alumnoUuid)
        .order('fecha_entrenamiento', { ascending: false });
      if (error) {
        console.warn('⚠️ obtenerHistorial SELECT:', error.message);
        // fallback RPC
        try {
          const { data, error: rpcErr } = await this.client.rpc('obtener_historial_alumno', { p_alumno_id: alumnoUuid });
          if (!rpcErr && data) return Array.isArray(data) ? data : [];
        } catch (_) {}
        return [];
      }
      const logs = (rows || []).map(l => ({
        id: l.id,
        alumnoId: l.alumno_id,
        rutinaId: l.routine_id || l.rutina_id,
        diaId: l.dia_id || 'dia-1',
        diaNombre: l.dia_nombre,
        diaNumero: l.dia_numero || 1,
        fecha: l.fecha_entrenamiento,
        estado: l.estado,
        comentarioGeneral: l.comentario_general || '',
        puntos: l.puntos != null ? l.puntos : undefined,
        sets: []
      }));
      await this.enriquecerSeriesDeLogs(logs);
      console.log(`✅ Historial: ${logs.length} logs, con series: ${logs.filter(l => (l.sets || []).length).length}`);
      return logs;
    } catch (err) {
      console.error('❌ obtenerHistorialDesdeSupabase:', err);
      return [];
    }
  }

  // --- RUTINAS (PUNTO C): profesor obtiene las rutinas de UN alumno conocido ---
  // Reutiliza la MISMA RPC 'obtener_rutinas_alumno' que ya usa el alumno para
  // sus propias rutinas (SECURITY DEFINER, ya probada). No es una RPC nueva:
  // es la misma llamada que ya existe en fetchFullStateFromSupabase(), solo
  // extraída como método independiente para poder invocarla una vez por cada
  // alumno que el profesor ya conoce localmente. No toca ensureValidUUID
  // (solo la usa, sin modificarla) ni fetchFullStateFromSupabase.
  async obtenerRutinasAlumnoDesdeSupabase(alumnoId) {
    if (!this.client) return { ok: false, error: 'cliente_no_inicializado', rutinas: [] };
    try {
      const alumnoUuid = this.ensureValidUUID(alumnoId);
      const { data: rpcData, error: rpcErr } = await this.client.rpc('obtener_rutinas_alumno', {
        p_alumno_id: alumnoUuid
      });
      if (rpcErr) {
        console.warn(`⚠️ RPC obtener_rutinas_alumno falló para alumno ${alumnoUuid}:`, rpcErr.message);
        return { ok: false, error: rpcErr.message, rutinas: [] };
      }
      const rutinas = Array.isArray(rpcData) ? rpcData : [];
      return { ok: true, rutinas };
    } catch (err) {
      console.warn(`⚠️ Excepción en obtenerRutinasAlumnoDesdeSupabase (alumno ${alumnoId}):`, err);
      return { ok: false, error: err.message, rutinas: [] };
    }
  }

  // --- HISTORIAL: profesor obtiene registros de un alumno vía RPC segura ---
  async obtenerHistorialParaProfesor(alumnoId, profesorId) {
    if (!this.client) return [];
    try {
      const alumnoUuid   = this.ensureValidUUID(alumnoId);
      const profesorUuid = this.ensureValidUUID(profesorId);
      const { data, error } = await this.client.rpc(
        'obtener_historial_para_profesor',
        { p_alumno_id: alumnoUuid, p_profesor_id: profesorUuid }
      );
      if (error) {
        console.error('❌ RPC obtener_historial_para_profesor falló:', error.message);
        return [];
      }
      const logs = Array.isArray(data) ? data : (data || []);
      console.log(`✅ Historial del alumno obtenido para profesor: ${logs.length} registros.`);
      return logs;
    } catch (err) {
      console.error('❌ Excepción en obtenerHistorialParaProfesor:', err);
      return [];
    }
  }

  // Consulta al backend (Vercel/Netlify) la VAPID public key real, configurada
  // como variable de entorno del lado del servidor (VAPID_PUBLIC_KEY). No es
  // información secreta -- es la clave PÚBLICA del par VAPID -- pero se sirve
  // desde un endpoint en vez de hardcodearla en el bundle para que un mismo
  // origen de verdad (las env vars de Vercel) alimente tanto a /api/send-push.js
  // como al frontend, sin duplicarla ni usar una key dummy que Apple/Google
  // rechazan silenciosamente al suscribir.
  async getVapidPublicKey() {
    const endpoints = [
      '/.netlify/functions/vapid-public-key',
      '/api/vapid-public-key'
    ];
    for (const ep of endpoints) {
      try {
        const res = await fetch(ep);
        if (res.ok) {
          const data = await res.json();
          if (data && data.publicKey) return data.publicKey;
        }
      } catch (e) {
        // probamos el siguiente endpoint disponible (Netlify vs Vercel)
      }
    }
    console.error("❌ No se pudo obtener VAPID_PUBLIC_KEY desde ningún endpoint backend.");
    return null;
  }

  async registerPushSubscription(userId, subscription) {
    if (!this.client) throw new Error("Cliente Supabase no inicializado.");

    const userUuid = this.ensureValidUUID(userId);

    // RPC segura (única vía — push_subscriptions está protegida para anon).
    // A propósito NO se atrapa el error acá: el llamador (app.js) necesita
    // saber si la suscripción realmente quedó guardada en la DB o no, para
    // no mostrar un "✅ activado" falso cuando en realidad falló.
    const { error: rpcErr } = await this.client.rpc('guardar_push_subscription', {
      p_user_id: userUuid,
      p_subscription: subscription
    });

    if (rpcErr) {
      console.error("❌ RPC guardar_push_subscription falló:", rpcErr.message);
      throw new Error(rpcErr.message);
    }
    console.log("✅ Suscripción Web Push guardada mediante RPC segura en Supabase DB.");
  }

  async enviarPushNotificationAAlumno(alumnoId, payload) {
    if (!this.client) return;
    try {
      // push_subscriptions está protegida para anon: usamos la RPC para leer
      // las suscripciones del alumno de forma segura en el backend de Supabase.
      // El backend /api/send-push usa la service_role key para consultar directamente.
      const userUuid = this.ensureValidUUID(alumnoId);

      const endpoints = [
        '/.netlify/functions/send-push',
        '/api/send-push'
      ];
      if (window.ENV_PUSH_ENDPOINT) {
        endpoints.unshift(window.ENV_PUSH_ENDPOINT);
      }

      let sent = false;
      for (const ep of endpoints) {
        try {
          const res = await fetch(ep, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              alumnoId: userUuid,
              payload: payload
            })
          });
          if (res.ok) {
            const resData = await res.json();
            console.log(`✅ Web Push despachado mediante [${ep}]:`, resData);
            sent = true;
            break;
          } else {
            const errText = await res.text();
            console.warn(`⚠️ Endpoint [${ep}] respondió con error ${res.status}:`, errText);
          }
        } catch (pushErr) {
          console.warn(`⚠️ Endpoint [${ep}] no disponible:`, pushErr.message);
        }
      }
      if (!sent) {
        console.warn("⚠️ Ningún endpoint backend de Web Push estuvo accesible para alumno:", alumnoId);
      }
    } catch (err) {
      console.error("❌ Error al enviar notificación push al alumno:", err);
    }
  }

  // =========================================================================
  // --- SUPABASE AUTH — ETAPA 1: autenticación real con fallback legacy ---
  // Los métodos de abajo NO borran contraseñas ni modifican profiles.id.
  // auth_user_id es el único vínculo nuevo con Supabase Auth.
  // =========================================================================

  // Genera el email interno derivado de DNI+rol.
  // Formato requerido: "dni_alumno_DNI@estudiofitness.app"
  // Este email nunca se muestra al usuario; es solo la clave de Auth.
  getInternalEmail(dni, rol) {
    return `dni_${rol}_${String(dni).trim()}@estudiofitness.app`;
  }

  // Email interno en el formato VIEJO (usado hasta antes del commit 9c96ff6).
  // Los usuarios de Supabase Auth creados con el código anterior existen con
  // ESTE email. Se usa SOLO como reintento en authSignIn(): nunca para signUp,
  // así no se crean usuarios duplicados con el formato viejo.
  getLegacyInternalEmail(dni, rol) {
    return `${String(dni).trim()}-${rol}@estudiofitnessinternal.com`;
  }

  // Determina si un error de signInWithPassword es de credenciales inválidas.
  // Supabase usa el mismo código ambiguo tanto para "email inexistente" como
  // para "contraseña incorrecta"; solo ante ese error tiene sentido probar el
  // email en formato legado (otros errores —red, rate limit— no deben reintentar).
  _esErrorCredencialesInvalidas(error) {
    if (!error) return false;
    if (error.code === 'invalid_credentials') return true;
    if (error.status === 400 && /invalid login credentials/i.test(error.message || '')) return true;
    return false;
  }

  // Crea una cuenta de Supabase Auth para dni+rol con la password dada.
  // Retorna { ok, user, session } o { ok: false, error }.
  // No altera ningún dato de perfil ni contraseña legacy.
  async authSignUp(dni, rol, password) {
    console.log('AUTH DEBUG engine:', window.supabaseEngine);
    console.log('AUTH DEBUG client:', window.supabaseEngine?.client);
    console.log('AUTH DEBUG signup iniciado:', dni, rol);

    if (!this.client) return { ok: false, error: 'cliente_no_inicializado' };

    // Validación de longitud de contraseña
    if (typeof password !== 'string' || password.trim().length < 2) {
      return { ok: false, error: 'La contraseña debe tener al menos 2 caracteres.' };
    }
    if (password.length > 128) {
      return { ok: false, error: 'La contraseña es demasiado larga (máximo 128 caracteres).' };
    }

    try {
      const email = this.getInternalEmail(dni, rol);
      const { data, error } = await this.client.auth.signUp({ email, password });

      console.log('AUTH DEBUG signup resultado:', data, error);

      if (error) {
        console.warn('⚠️ authSignUp error detallado:', error);
        return { ok: false, error: error };
      }
      console.log('✅ authSignUp OK para', email, '→ user.id:', data.user?.id);
      return { ok: true, user: data.user, session: data.session };
    } catch (err) {
      console.warn('⚠️ Excepción en authSignUp:', err);
      return { ok: false, error: err };
    }
  }

  // Inicia sesión en Supabase Auth para dni+rol con la password dada.
  // Retorna { ok, user, session } o { ok: false, error }.
  // No valida contra passwords legacy ni altera ningún campo local.
  async authSignIn(dni, rol, password) {
    if (!this.client) return { ok: false, error: 'cliente_no_inicializado' };

    // Validación de longitud de contraseña
    if (typeof password !== 'string' || password.trim().length < 2) {
      return { ok: false, error: 'La contraseña debe tener al menos 2 caracteres.' };
    }

    // INSTRUMENTACIÓN TEMPORAL: AUTH SIGNIN START
    const email = this.getInternalEmail(dni, rol);
    console.log('=== SUPABASE AUTH SIGNIN START ===', {
      dni,
      rol,
      emailGenerado: email
    });
    // FIN INSTRUMENTACIÓN
    try {
      // 1) Intento principal con el formato vigente (cuentas nuevas).
      let { data, error } = await this.client.auth.signInWithPassword({ email, password });

      // 2) Reintento con el formato LEGADO solo si falló por credenciales.
      //    Las cuentas creadas antes del cambio de getInternalEmail (9c96ff6)
      //    viven en Supabase Auth con el email viejo; sin este reintento
      //    reciben invalid_credentials aunque la contraseña sea correcta.
      //    Es únicamente otro signInWithPassword: NO crea usuarios nuevos,
      //    NO toca perfiles ni contraseñas.
      if (error && this._esErrorCredencialesInvalidas(error)) {
        const emailLegado = this.getLegacyInternalEmail(dni, rol);
        if (emailLegado !== email) {
          console.log(`ℹ️ authSignIn: sin resultado con el email actual → reintentando con formato legado (${emailLegado}).`);
          const reintento = await this.client.auth.signInWithPassword({ email: emailLegado, password });
          data = reintento.data;
          error = reintento.error;
        }
      }

      if (error) {
        // INSTRUMENTACIÓN TEMPORAL: AUTH SIGNIN ERROR
        console.log('=== SUPABASE AUTH SIGNIN RESULT ===', {
          ok: false,
          errorCode: error.code ?? null,
          errorMessage: error.message ?? null,
          errorStatus: error.status ?? null
        });
        // FIN INSTRUMENTACIÓN
        console.warn('⚠️ authSignIn error:', error.message);
        return { ok: false, error: error.message };
      }
      console.log('✅ authSignIn OK para', email, '→ user.id:', data.user?.id);
      // INSTRUMENTACIÓN TEMPORAL: AUTH SIGNIN SUCCESS
      console.log('=== SUPABASE AUTH SIGNIN RESULT ===', {
        ok: true,
        userId: data.user?.id ?? null
      });
      // FIN INSTRUMENTACIÓN
      return { ok: true, user: data.user, session: data.session };
    } catch (err) {
      // INSTRUMENTACIÓN TEMPORAL: AUTH SIGNIN EXCEPTION
      console.log('=== SUPABASE AUTH SIGNIN RESULT ===', {
        ok: false,
        errorCode: 'exception',
        errorMessage: err.message ?? String(err),
        errorStatus: null
      });
      // FIN INSTRUMENTACIÓN
      console.warn('⚠️ Excepción en authSignIn:', err);
      return { ok: false, error: err.message };
    }
  }

  // Cierra la sesión activa de Supabase Auth.
  // No borra localStorage ni contraseñas legacy.
  async authSignOut() {
    if (!this.client) return;
    // INSTRUMENTACIÓN TEMPORAL: AUTH SIGNOUT START
    console.log('=== AUTH SIGNOUT START ===', {});
    // FIN INSTRUMENTACIÓN
    try {
      await this.client.auth.signOut();
      console.log('🔒 Sesión Supabase Auth cerrada.');
      // INSTRUMENTACIÓN TEMPORAL: AUTH SIGNOUT RESULT
      console.log('=== AUTH SIGNOUT RESULT ===', { ok: true, error: null });
      // FIN INSTRUMENTACIÓN
    } catch (e) {
      console.warn('⚠️ Error al cerrar sesión Supabase Auth:', e);
      // INSTRUMENTACIÓN TEMPORAL: AUTH SIGNOUT RESULT
      console.log('=== AUTH SIGNOUT RESULT ===', { ok: false, error: e.message ?? String(e) });
      // FIN INSTRUMENTACIÓN
    }
  }

  // Devuelve la sesión activa de Supabase Auth, o null si no hay ninguna.
  // Usado al iniciar la app para restaurar sesión persistente.
  async authGetSession() {
    if (!this.client) return null;
    try {
      const { data: { session } } = await this.client.auth.getSession();
      return session || null;
    } catch (e) {
      console.warn('⚠️ Error obteniendo sesión Supabase Auth:', e);
      return null;
    }
  }

  // =========================================================================
  // --- LOGIN POR DNI — flujo mínimo (generateLink + verifyOtp) ---
  // Pide al backend (api/login-dni o netlify/functions/login-dni) un
  // hashed_token de magic link para el DNI dado, lo canjea con verifyOtp()
  // por una sesión REAL emitida por Supabase Auth (no fabricada, no usa
  // setSession() manual), y devuelve el perfil ya resuelto vía RLS.
  // NO reemplaza a authSignIn/authSignUp: quedan intactos y sin usarse
  // desde acá, pendientes de limpieza controlada en un paso posterior.
  // =========================================================================
  async loginConDni(dni) {
    if (!this.client) return { ok: false, error: 'cliente_no_inicializado' };

    const cleanDni = String(dni).trim();
    const endpoints = ['/.netlify/functions/login-dni', '/api/login-dni'];

    let hashedToken = null;
    let lastError = null;

    for (const ep of endpoints) {
      try {
        const res = await fetch(ep, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dni: cleanDni })
        });

        if (res.ok) {
          const data = await res.json();
          hashedToken = data.hashed_token;
          break;
        }

        const errData = await res.json().catch(() => ({}));
        lastError = errData.error || `Error ${res.status} en ${ep}`;
        if (errData.error === 'dni_no_encontrado') break; // no tiene sentido reintentar en el otro endpoint
      } catch (err) {
        lastError = err.message;
      }
    }

    if (!hashedToken) {
      console.warn('⚠️ loginConDni: no se obtuvo hashed_token:', lastError);
      return { ok: false, error: lastError || 'no_se_pudo_generar_sesion' };
    }

    // Canjear el token por una sesión REAL (access + refresh emitidos por
    // Supabase Auth / GoTrue). El SDK persiste la sesión solo y maneja el
    // refresh automático de acá en adelante — esto es lo que garantiza que
    // la sesión sobreviva a cerrar/reabrir la PWA.
    const { data: sessionData, error: verifyError } = await this.client.auth.verifyOtp({
      token_hash: hashedToken,
      type: 'magiclink'
    });

    if (verifyError) {
      console.warn('⚠️ loginConDni: verifyOtp falló:', verifyError.message);
      return { ok: false, error: verifyError.message };
    }

    const authUserId = sessionData.user?.id;
    if (!authUserId) {
      return { ok: false, error: 'sesion_sin_usuario' };
    }

    // profiles.rol es la única fuente de verdad del rol — nunca se infiere
    // del email de auth.users. Se lee vía RLS ("Auth: Perfil propio..."),
    // ya con la sesión activa.
    const { data: perfilData, error: perfilError } = await this.client
      .from('profiles')
      .select('id,dni,nombre,telefono,rol,estado_autorizacion,puntos_total,racha_semanas,racha_ultima_semana,auth_user_id')
      .eq('auth_user_id', authUserId)
      .single();

    if (perfilError || !perfilData) {
      console.warn('⚠️ loginConDni: no se pudo leer profiles tras autenticar:', perfilError?.message);
      return { ok: false, error: 'perfil_no_encontrado_tras_login' };
    }

    console.log(`✅ loginConDni OK → rol: ${perfilData.rol}, authUserId: ${authUserId}`);
    return { ok: true, rol: perfilData.rol, authUserId, data: perfilData };
  }

  // RPC: verifica que el DNI exista como alumno autorizado y que el teléfono
  // coincida. Usada antes de completar el registro de un alumno precreado.
  // Retorna { ok, data } o { ok: false, error }.
  async verificarDatosActivacionAlumno(dni, telefono) {
    if (!this.client) return { ok: false, error: 'cliente_no_inicializado' };
    try {
      const { data, error } = await this.client.rpc('verificar_datos_activacion_alumno', {
        p_dni: String(dni).trim(),
        p_telefono: String(telefono || '').trim()
      });
      if (error) {
        console.warn('⚠️ RPC verificar_datos_activacion_alumno error:', error.message);
        return { ok: false, error: error.message };
      }
      return { ok: true, data };
    } catch (err) {
      console.warn('⚠️ Excepción en verificarDatosActivacionAlumno:', err);
      return { ok: false, error: err.message };
    }
  }

  // RPC: vincula el usuario de Supabase Auth actualmente autenticado al perfil de alumno
  // identificado por DNI. Usa auth.uid() internamente, por lo que no necesita p_auth_user_id.
  // Solo setea profiles.auth_user_id — no altera profiles.id ni ninguna contraseña.
  async vincularPerfilAlumno(dni, telefono) {
    if (!this.client) return { ok: false, error: 'cliente_no_inicializado' };
    try {
      const { data, error } = await this.client.rpc('vincular_perfil_alumno_a_auth_user', {
        p_dni: String(dni).trim(),
        p_telefono_verificacion: String(telefono || '').trim()
      });
      if (error) {
        console.warn('⚠️ RPC vincular_perfil_alumno_a_auth_user error:', error.message);
        return { ok: false, error: error.message };
      }
      console.log('✅ RPC vincular_perfil_alumno_a_auth_user OK → auth_user_id seteado en profiles.');
      return { ok: true, data };
    } catch (err) {
      console.warn('⚠️ Excepción en vincularPerfilAlumno:', err);
      return { ok: false, error: err.message };
    }
  }

  // RPC: vincula el usuario de Supabase Auth actualmente autenticado al perfil de profesor
  // identificado por DNI. Usa auth.uid() internamente, por lo que no necesita p_auth_user_id.
  // Solo setea profiles.auth_user_id — no altera profiles.id ni ninguna contraseña.
  // --- RANKING PÚBLICO ---
  // Llama a la RPC get_ranking_publico() (SECURITY DEFINER), que ignora RLS
  // y devuelve ÚNICAMENTE las 5 columnas públicas de los alumnos activos.
  // La RPC solo puede ejecutarla el rol `authenticated` (anon tiene REVOKE).
  // El resultado se guarda en this.data.rankingCache (solo en memoria —
  // saveData() lo excluye de localStorage, ver comentario en data.js).
  async fetchRankingPublico() {
    if (!this.client) return { ok: false, error: 'no_client' };
    try {
      const { data: rankingData, error: rpcErr } = await this.client.rpc('get_ranking_publico');
      if (rpcErr) {
        console.warn('⚠️ RPC get_ranking_publico falló:', rpcErr.message);
        return { ok: false, error: rpcErr.message };
      }
      return { ok: true, data: rankingData || [] };
    } catch (e) {
      console.warn('⚠️ Excepción en fetchRankingPublico:', e);
      return { ok: false, error: e.message };
    }
  }

  // --- EDITAR NOMBRE PERSONALIZADO DEL PROFESOR (apodo en authorized_dnis) ---
  // Llama a la RPC editar_nombre_profesor (SECURITY DEFINER), que valida que
  // quien llama es profesor via profiles.auth_user_id = auth.uid() y
  // actualiza ÚNICAMENTE authorized_dnis.nombre. NUNCA toca profiles.nombre
  // (nombre real de la cuenta del alumno).
  async editarNombreProfesor(dni, nuevoNombre) {
    if (!this.client) return { ok: false, error: 'cliente_no_inicializado' };
    try {
      const { data: rpcData, error: rpcErr } = await this.client.rpc('editar_nombre_profesor', {
        p_dni: String(dni).trim(),
        p_nuevo_nombre: String(nuevoNombre).trim()
      });
      if (rpcErr) {
        console.error('❌ RPC editar_nombre_profesor falló:', rpcErr.message, rpcErr);
        return { ok: false, error: rpcErr.message };
      }
      if (rpcData && rpcData.ok === false) {
        console.error('❌ RPC editar_nombre_profesor retornó error de negocio:', rpcData.error);
        return { ok: false, error: rpcData.error };
      }
      console.log('✅ Nombre personalizado del profesor actualizado via RPC en Supabase DB.', rpcData);
      return { ok: true, data: rpcData };
    } catch (err) {
      console.error('❌ Excepción en editarNombreProfesor:', err);
      return { ok: false, error: err.message };
    }
  }

  async vincularPerfilProfesor(dni) {
    if (!this.client) return { ok: false, error: 'cliente_no_inicializado' };
    try {
      const { data, error } = await this.client.rpc('vincular_perfil_profesor_a_auth_user', {
        p_dni: String(dni).trim()
      });
      if (error) {
        console.warn('⚠️ RPC vincular_perfil_profesor_a_auth_user error:', error.message);
        return { ok: false, error: error.message };
      }
      console.log('✅ RPC vincular_perfil_profesor_a_auth_user OK → auth_user_id seteado en profiles.');
      return { ok: true, data };
    } catch (err) {
      console.warn('⚠️ Excepción en vincularPerfilProfesor:', err);
      return { ok: false, error: err.message };
    }
  }
}

window.supabaseEngine = new SupabaseEngine();