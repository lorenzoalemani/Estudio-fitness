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
  async fetchFullStateFromSupabase() {
    if (!this.client) return null;
    try {
      const [resAuthDnis, resProfiles, resRoutines, resDays, resGoals, resLogs, resLogSets, resNotifs] = await Promise.all([
        this.client.from('authorized_dnis').select('*'),
        this.client.from('profiles').select('*'),
        this.client.from('routines').select('*'),
        this.client.from('routine_days').select('*'),
        this.client.from('exercise_goals').select('*'),
        this.client.from('workout_logs').select('*'),
        this.client.from('workout_log_sets').select('*'),
        this.client.from('notifications').select('*')
      ]);

      if (resAuthDnis.error || resProfiles.error || resRoutines.error) {
        console.warn("ℹ️ Consulta a Supabase en proceso o restringida por RLS:", resProfiles.error || resRoutines.error);
      }

      const dnisAutorizados = (resAuthDnis.data || []).map(d => ({ dni: d.dni, nombre: d.nombre }));
      const alumnos = (resProfiles.data || []).filter(p => p.rol === 'alumno').map(a => ({
        id: a.id,
        dni: a.dni,
        password: a.password || "123",
        nombre: a.nombre,
        telefono: a.telefono || "",
        estadoAutorizacion: a.estado_autorizacion,
        fechaRegistro: a.created_at ? a.created_at.split('T')[0] : new Date().toISOString().split('T')[0],
        rutinaActivaId: a.rutina_activa_id || null
      }));

      const profesores = (resProfiles.data || []).filter(p => p.rol === 'profesor').map(p => ({
        id: p.id,
        dni: p.dni,
        password: p.password || "123",
        nombre: p.nombre,
        rol: "profesor"
      }));

      // Reconstruir rutinas con sus días y ejercicios
      const daysByRoutine = {};
      (resDays.data || []).forEach(d => {
        if (!daysByRoutine[d.routine_id]) daysByRoutine[d.routine_id] = [];
        daysByRoutine[d.routine_id].push({
          id: d.id,
          diaNumero: d.dia_numero,
          nombre: d.nombre,
          ejercicios: []
        });
      });

      const goalsByDay = {};
      (resGoals.data || []).forEach(g => {
        if (!goalsByDay[g.day_id]) goalsByDay[g.day_id] = [];
        goalsByDay[g.day_id].push({
          id: g.id,
          orden: g.orden || 1,
          nombre: g.nombre,
          seriesTarget: g.series_target,
          repeticionesTarget: g.repeticiones_target,
          pesoSugerido: g.peso_sugerido,
          notaProfesor: g.nota_profesor || "",
          profesorNotaAutor: g.profesor_nota_autor || ""
        });
      });

      // Asociar ejercicios a sus días
      Object.values(daysByRoutine).forEach(dayList => {
        dayList.forEach(d => {
          d.ejercicios = (goalsByDay[d.id] || []).sort((a, b) => a.orden - b.orden);
        });
        dayList.sort((a, b) => a.diaNumero - b.diaNumero);
      });

      const rutinas = (resRoutines.data || []).map(r => ({
        id: r.id,
        alumnoId: r.alumno_id,
        profesorCreadorNombre: r.profesor_creador_nombre || "Profesor",
        titulo: r.titulo,
        duracionDias: r.duracion_dias,
        fechaInicio: r.fecha_inicio,
        fechaVencimiento: r.fecha_vencimiento,
        estado: r.estado,
        dias: daysByRoutine[r.id] || []
      }));

      // Reconstruir historial de entrenamientos
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

 // --- OPERACIONES DE ESCRITURA RELACIONAL EN SUPABASE DB ---
async registrarPerfilEnSupabase(alumno) {
  if (!this.client) return;
  try {
    const cleanDni = String(alumno.dni).trim();
    const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(alumno.id);
    const profileId = isUUID ? alumno.id : (window.crypto && window.crypto.randomUUID ? window.crypto.randomUUID() : '00000000-0000-4000-a000-' + String(Date.now()).padStart(12, '0'));

    const { data, error } = await this.client
      .from('profiles')
      .upsert({
        id: profileId,
        dni: cleanDni,
        nombre: alumno.nombre.trim(),
        telefono: alumno.telefono ? alumno.telefono.trim() : "",
        rol: 'alumno',
        estado_autorizacion: alumno.estadoAutorizacion || 'pendiente'
      }, { onConflict: 'dni' })
      .select();

    if (error) {
      console.error("❌ Error insertando perfil en Supabase DB (profiles):", error);
    } else {
      console.log("✅ Perfil de alumno registrado/actualizado exitosamente en Supabase DB (profiles):", data);
      if (profileId !== alumno.id && data && data[0]) {
        alumno.id = data[0].id;
      }
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
    if (!this.client) return;
    try {
      // 1. Insertar Rutina
      const { data: rData, error: rErr } = await this.client.from('routines').insert({
        id: rutina.id,
        alumno_id: rutina.alumnoId,
        profesor_creador_nombre: rutina.profesorCreadorNombre,
        titulo: rutina.titulo,
        duracion_dias: rutina.duracionDias,
        fecha_inicio: rutina.fechaInicio,
        fecha_vencimiento: rutina.fechaVencimiento,
        estado: rutina.estado || 'activa'
      }).select().single();

      if (rErr) throw rErr;

      // 2. Insertar Días y Ejercicios
      for (const d of rutina.dias) {
        const { data: dData, error: dErr } = await this.client.from('routine_days').insert({
          id: d.id,
          routine_id: rutina.id,
          dia_numero: d.diaNumero,
          nombre: d.nombre
        }).select().single();

        if (dErr) continue;

        for (let idx = 0; idx < d.ejercicios.length; idx++) {
          const e = d.ejercicios[idx];
          await this.client.from('exercise_goals').insert({
            id: e.id,
            day_id: dData.id,
            orden: idx + 1,
            nombre: e.nombre,
            series_target: e.seriesTarget,
            repeticiones_target: e.repeticionesTarget,
            peso_sugerido: e.pesoSugerido,
            nota_profesor: e.notaProfesor,
            profesor_nota_autor: e.profesorNotaAutor
          });
        }
      }
      console.log("✅ Nueva rutina persistida relacionalmente en Supabase DB.");
    } catch (err) {
      console.warn("⚠️ Error guardando rutina en Supabase DB (operando en modo local):", err);
    }
  }

  async persistirEdicionRutinaEnSupabase(rutina) {
    if (!this.client) return;
    try {
      // 1. Actualizar Rutina
      await this.client.from('routines').update({
        titulo: rutina.titulo,
        duracion_dias: rutina.duracionDias,
        fecha_vencimiento: rutina.fechaVencimiento,
        profesor_creador_nombre: rutina.profesorCreadorNombre
      }).eq('id', rutina.id);

      // 2. Reemplazar días y ejercicios de la rutina
      await this.client.from('routine_days').delete().eq('routine_id', rutina.id);

      for (const d of rutina.dias) {
        const { data: dData, error: dErr } = await this.client.from('routine_days').insert({
          id: d.id,
          routine_id: rutina.id,
          dia_numero: d.diaNumero,
          nombre: d.nombre
        }).select().single();

        if (dErr) continue;

        for (let idx = 0; idx < d.ejercicios.length; idx++) {
          const e = d.ejercicios[idx];
          await this.client.from('exercise_goals').insert({
            id: e.id,
            day_id: dData.id,
            orden: idx + 1,
            nombre: e.nombre,
            series_target: e.seriesTarget,
            repeticiones_target: e.repeticionesTarget,
            peso_sugerido: e.pesoSugerido,
            nota_profesor: e.notaProfesor,
            profesor_nota_autor: e.profesorNotaAutor
          });
        }
      }
      console.log("✅ Edición de rutina persistida relacionalmente en Supabase DB.");
    } catch (err) {
      console.warn("⚠️ Error actualizando rutina en Supabase DB:", err);
    }
  }

  async guardarWorkoutLogEnSupabase(log) {
    if (!this.client) return;
    try {
      const { data: lData, error: lErr } = await this.client.from('workout_logs').insert({
        id: log.id,
        alumno_id: log.alumnoId,
        routine_id: log.rutinaId,
        dia_nombre: log.diaNombre,
        comentario_general: log.comentarioGeneral,
        estado: log.estado || 'completado'
      }).select().single();

      if (lErr) throw lErr;

      for (const s of log.sets) {
        await this.client.from('workout_log_sets').insert({
          workout_log_id: lData.id,
          exercise_nombre: s.ejercicioNombre,
          set_numero: s.setNumero,
          reps_realizadas: s.repsRealizadas,
          peso_utilizado: s.pesoUtilizado,
          comentario_alumno: s.comentarioAlumno
        });
      }
      console.log("✅ Entrenamiento real persistido relacionalmente en Supabase DB.");
    } catch (err) {
      console.warn("⚠️ Error guardando entrenamiento real en Supabase DB:", err);
    }
  }

  async registerPushSubscription(userId, subscription) {
    if (!this.client) return;
    try {
      await this.client.from('push_subscriptions').upsert({
        user_id: userId,
        subscription_json: subscription
      }, { onConflict: 'user_id, subscription_json' });
      console.log("✅ Suscripción Web Push sincronizada en Supabase.");
    } catch (e) {
      console.error("Error guardando suscripción Push:", e);
    }
  }

  async enviarPushNotificationAAlumno(alumnoId, payload) {
    if (!this.client) return;
    try {
      const { data: subs, error } = await this.client
        .from('push_subscriptions')
        .select('subscription_json')
        .eq('user_id', alumnoId);

      if (error || !subs || subs.length === 0) {
        console.log("ℹ️ No hay suscripciones Web Push activas registradas para el alumno:", alumnoId);
        return;
      }

      console.log(`📡 Despachando Web Push a ${subs.length} dispositivo(s) para alumno ${alumnoId}...`);

      const endpoints = [
        '/.netlify/functions/send-push',
        '/api/send-push'
      ];
      if (window.ENV_PUSH_ENDPOINT) {
        endpoints.unshift(window.ENV_PUSH_ENDPOINT);
      }

      for (const item of subs) {
        let sent = false;
        for (const ep of endpoints) {
          try {
            const res = await fetch(ep, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                subscription: item.subscription_json,
                payload: payload
              })
            });
            if (res.ok) {
              const resData = await res.json();
              console.log(`✅ Web Push despachado con éxito mediante [${ep}]:`, resData);
              sent = true;
              break;
            }
          } catch (pushErr) {
            console.warn(`⚠️ Endpoint [${ep}] no disponible:`, pushErr.message);
          }
        }
        if (!sent) {
          console.warn("⚠️ Ningún endpoint backend de Web Push estuvo accesible.");
        }
      }
    } catch (err) {
      console.error("Error al obtener suscripciones push del alumno:", err);
    }
  }
}

window.supabaseEngine = new SupabaseEngine();
