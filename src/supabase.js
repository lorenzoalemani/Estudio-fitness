// ESTUDIO FITNESS - SUPABASE REALTIME & BACKEND CLIENT ENGINE

// Configuración por defecto o mediante variables globales/entorno
const SUPABASE_CONFIG = {
  url: window.ENV_SUPABASE_URL || 'https://fsvuuysjfnjjjbfjgxjj.supabase.co',
  anonKey: window.ENV_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZzdnV1eXNqZm5qampiZmpneGpqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODYzNzE4NjIsImV4cCI6MjEwMTk0Nzg2Mn0.0kqWhbrsdEvJyKmPM4jH4AGO441n4eXpYjBtAxICvAE',
  vapidPublicKey: window.ENV_VAPID_PUBLIC_KEY || 'BEl62iUYgUivxIkv69yViEuiBIa-m9GYv50D2nE85-dummy-public-key'
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
      const [resAuthDnis, resProfiles, resLogs, resLogSets, resNotifs] = await Promise.all([
        this.client.from('authorized_dnis').select('*'),
        this.client.from('profiles').select('id,dni,nombre,telefono,rol,estado_autorizacion,created_at'),
        this.client.from('workout_logs').select('*'),
        this.client.from('workout_log_sets').select('*'),
        this.client.from('notifications').select('*')
      ]);

      const dnisAutorizados = (resAuthDnis.data || []).map(d => ({ dni: d.dni, nombre: d.nombre }));

      const alumnos = (resProfiles.data || []).filter(p => p.rol === 'alumno').map(a => ({
        id: a.id,
        dni: a.dni,
        password: a.password || "123",
        nombre: a.nombre,
        telefono: a.telefono || "",
        estadoAutorizacion: a.estado_autorizacion,
        fechaRegistro: a.created_at ? a.created_at.split('T')[0] : new Date().toISOString().split('T')[0],
        rutinaActivaId: null
      }));

      const profesores = (resProfiles.data || []).filter(p => p.rol === 'profesor').map(p => ({
        id: p.id,
        dni: p.dni,
        password: p.password || "123",
        nombre: p.nombre,
        rol: "profesor"
      }));

      // 2. Rutinas: solo via RPC segura cuando hay alumnoId conocido.
      //    Si es profesor o no hay alumnoId, las rutinas se omiten (usa localStorage).
      let rutinas = [];
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

      // 3. Historial de entrenamientos
      const setsByLog = {};
      (resLogSets.data || []).forEach(s => {
        if (!setsByLog[s.workout_log_id]) setsByLog[s.workout_log_id] = [];
        setsByLog[s.workout_log_id].push({
          ejercicioNombre: s.exercise_nombre,
          setNumero: s.set_numero,
          repsRealizadas: s.reps_realizadas,
          pesoUtilizado: s.peso_utilizado,
          comentarioAlumno: s.comentario_alumno || ""
        });
      });

      const workoutLogs = (resLogs.data || []).map(l => ({
        id: l.id,
        alumnoId: l.alumno_id,
        rutinaId: l.routine_id,
        diaId: l.dia_id || "dia-1",
        diaNombre: l.dia_nombre,
        fecha: l.fecha_entrenamiento,
        estado: l.estado,
        comentarioGeneral: l.comentario_general || "",
        sets: setsByLog[l.id] || []
      }));

      const notificaciones = (resNotifs.data || []).map(n => ({
        id: n.id,
        destinatarioRol: n.destinatario_rol,
        alumnoId: n.alumno_id,
        mensaje: n.mensaje,
        rutaDestino: n.ruta_destino,
        fecha: n.created_at,
        leido: n.leido
      }));

      return {
        dnisAutorizados: dnisAutorizados.length > 0 ? dnisAutorizados : null,
        alumnos: alumnos.length > 0 ? alumnos : null,
        profesores: profesores.length > 0 ? profesores : null,
        rutinas: rutinas.length > 0 ? rutinas : null,
        workoutLogs: workoutLogs.length > 0 ? workoutLogs : null,
        notificaciones: notificaciones.length > 0 ? notificaciones : null
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
    try {
      const routineUuid = this.ensureValidUUID(rutina.id);
      const alumnoUuid  = this.ensureValidUUID(rutina.alumnoId);
      rutina.id       = routineUuid;
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

  async guardarWorkoutLogEnSupabase(log) {
    if (!this.client) return;
    try {
      const logUuid    = this.ensureValidUUID(log.id);  // ya es UUID nativo, ensureValidUUID lo pasa sin cambios
      const alumnoUuid = this.ensureValidUUID(log.alumnoId);
      const routineUuid= this.ensureValidUUID(log.rutinaId);
      log.id = logUuid;

      const { error: lErr } = await this.client.from('workout_logs').insert({
        id:                  logUuid,
        alumno_id:           alumnoUuid,
        routine_id:          routineUuid,
        dia_numero:          log.diaNumero || 1,           // número real del día
        dia_nombre:          log.diaNombre,
        comentario_general:  log.comentarioGeneral || null,
        estado:              log.estado || 'completado',
        fecha_entrenamiento: log.fecha                     // fecha real del alumno
      });

      if (lErr) {
        console.error('❌ Error en INSERT workout_logs:', lErr);
        return;
      }

      for (const s of log.sets) {
        await this.client.from('workout_log_sets').insert({
          workout_log_id:   logUuid,
          exercise_goal_id: s.ejercicioId || null,         // vincula al ejercicio objetivo
          exercise_nombre:  s.ejercicioNombre,
          set_numero:       s.setNumero,
          reps_realizadas:  s.repsRealizadas,
          peso_utilizado:   s.pesoUtilizado,
          comentario_alumno:s.comentarioAlumno || null
        });
      }
      console.log('✅ Entrenamiento real persistido en Supabase DB.', { logUuid, sets: log.sets.length });
    } catch (err) {
      console.error('❌ Excepción guardando entrenamiento real en Supabase DB:', err);
    }
  }

  // --- HISTORIAL: alumno obtiene sus propios registros vía RPC segura ---
  async obtenerHistorialDesdeSupabase(alumnoId) {
    if (!this.client) return [];
    try {
      const alumnoUuid = this.ensureValidUUID(alumnoId);
      const { data, error } = await this.client.rpc(
        'obtener_historial_alumno',
        { p_alumno_id: alumnoUuid }
      );
      if (error) {
        console.error('❌ RPC obtener_historial_alumno falló:', error.message);
        return [];
      }
      const logs = Array.isArray(data) ? data : (data || []);
      console.log(`✅ Historial obtenido desde Supabase: ${logs.length} registros.`);
      return logs;
    } catch (err) {
      console.error('❌ Excepción en obtenerHistorialDesdeSupabase:', err);
      return [];
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

  async registerPushSubscription(userId, subscription) {
    if (!this.client) return;
    try {
      const userUuid = this.ensureValidUUID(userId);

      // RPC segura (única vía — push_subscriptions está protegida para anon)
      const { error: rpcErr } = await this.client.rpc('guardar_push_subscription', {
        p_user_id: userUuid,
        p_subscription: subscription
      });

      if (rpcErr) {
        console.error("❌ RPC guardar_push_subscription falló:", rpcErr.message);
      } else {
        console.log("✅ Suscripción Web Push guardada mediante RPC segura en Supabase DB.");
      }
    } catch (e) {
      console.error("❌ Excepción guardando suscripción Push:", e);
    }
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
}

window.supabaseEngine = new SupabaseEngine();