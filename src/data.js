// Módulo de Datos y Estado v4 - Estudio Fitness (Supabase Source of Truth & Set-by-Set Logger)

const STORAGE_KEY = 'estudio_fitness_db_v4';

// Padrón Inicial de DNI Autorizados por el Gimnasio
const DEFAULT_AUTHORIZED_DNIS = [
  { dni: "12345678", nombre: "Juan Pérez" },
  { dni: "87654321", nombre: "María González" },
  { dni: "11223344", nombre: "Lucas Benítez" },
  { dni: "44332211", nombre: "Sofía Martínez" }
];

const DEFAULT_DATA = {
  profesores: [
    { id: "5dfb74e3-bfe5-4085-9b9a-89b1fa4d732d", dni: "99001122", password: "123", nombre: "Prof. Carlos Rossi", rol: "profesor" },
    { id: "2f7a1c0b-76d8-466c-ae0d-1478ffcb1bca", dni: "88001122", password: "123", nombre: "Prof. Franco Gómez", rol: "profesor" }
  ],
  dnisAutorizados: DEFAULT_AUTHORIZED_DNIS,
  alumnos: [
    { id: "al-1", dni: "12345678", password: "123", nombre: "Juan Pérez", telefono: "1198765432", estadoAutorizacion: "autorizado", fechaRegistro: "2026-01-10", rutinaActivaId: "rut-1" },
    { id: "al-2", dni: "87654321", password: "123", nombre: "María González", telefono: "1145678901", estadoAutorizacion: "autorizado", fechaRegistro: "2026-02-01", rutinaActivaId: "rut-2" },
    { id: "al-3", dni: "11223344", password: "123", nombre: "Lucas Benítez", telefono: "1133445566", estadoAutorizacion: "autorizado", fechaRegistro: "2026-02-15", rutinaActivaId: "rut-3" },
    { id: "al-4", dni: "44332211", password: "123", nombre: "Sofía Martínez", telefono: "1166778899", estadoAutorizacion: "autorizado", fechaRegistro: "2026-01-05", rutinaActivaId: null }
  ],
  rutinas: [
    {
      id: "rut-1",
      alumnoId: "al-1",
      profesorCreadorNombre: "Prof. Carlos Rossi",
      titulo: "Fuerza e Hipertrofia - Mesociclo 1",
      duracionDias: 30,
      fechaInicio: new Date(Date.now() - 15 * 86400000).toISOString().split('T')[0],
      fechaVencimiento: new Date(Date.now() + 15 * 86400000).toISOString().split('T')[0],
      estado: "activa",
      dias: [
        {
          id: "dia-1",
          diaNumero: 1,
          nombre: "Día 1: Pecho, Hombro y Tríceps",
          ejercicios: [
            {
              id: "ej-101",
              nombre: "Press Plano con Barra",
              seriesTarget: 4,
              repeticionesTarget: "10-12",
              pesoSugerido: "60 kg",
              notaProfesor: "Controlar descenso a 2 segundos.",
              profesorNotaAutor: "Prof. Carlos Rossi"
            },
            {
              id: "ej-102",
              nombre: "Press Inclinado con Mancuernas",
              seriesTarget: 3,
              repeticionesTarget: "12",
              pesoSugerido: "20 kg c/u",
              notaProfesor: "Mantener omóplatos retraídos.",
              profesorNotaAutor: "Prof. Franco Gómez"
            }
          ]
        }
      ]
    },
    {
      id: "rut-3",
      alumnoId: "al-3",
      profesorCreadorNombre: "Prof. Franco Gómez",
      titulo: "Acondicionamiento Inicial",
      duracionDias: 30,
      fechaInicio: new Date(Date.now() - 29 * 86400000).toISOString().split('T')[0],
      fechaVencimiento: new Date(Date.now() + 1 * 86400000).toISOString().split('T')[0],
      estado: "activa",
      dias: [
        {
          id: "dia-301",
          diaNumero: 1,
          nombre: "Día 1: Full Body",
          ejercicios: [
            {
              id: "ej-301",
              nombre: "Goblet Squat con Mancuerna",
              seriesTarget: 3,
              repeticionesTarget: "12",
              pesoSugerido: "14 kg",
              notaProfesor: "Mancuerna bien pegada al pecho.",
              profesorNotaAutor: "Prof. Franco Gómez"
            }
          ]
        }
      ]
    }
  ],

  // REGISTROS REALES DE ENTRENAMIENTO POR SERIE (RESULTADO REAL ALUMNO)
  workoutLogs: [
    {
      id: "log-1",
      alumnoId: "al-1",
      rutinaId: "rut-1",
      diaId: "dia-1",
      diaNombre: "Día 1: Pecho, Hombro y Tríceps",
      fecha: new Date(Date.now() - 86400000).toISOString(),
      estado: "completado",
      sets: [
        { ejercicioNombre: "Press Plano con Barra", setNumero: 1, repsRealizadas: 12, pesoUtilizado: "60 kg" },
        { ejercicioNombre: "Press Plano con Barra", setNumero: 2, repsRealizadas: 11, pesoUtilizado: "60 kg" },
        { ejercicioNombre: "Press Plano con Barra", setNumero: 3, repsRealizadas: 10, pesoUtilizado: "60 kg" },
        { ejercicioNombre: "Press Plano con Barra", setNumero: 4, repsRealizadas: 9, pesoUtilizado: "60 kg", comentarioAlumno: "Me costó la última serie 😅" }
      ]
    }
  ],

  notificaciones: [
    { id: "notif-1", destinatarioRol: "profesor", alumnoId: "al-1", mensaje: "💬 Juan Pérez completó Día 1 y dejó un comentario.", fecha: new Date(Date.now() - 3600000).toISOString(), leido: false }
  ]
};

class GymStore {
  constructor() {
    this.data = this.loadData();
    this._syncSeq = 0; // Token de secuencia para descartar respuestas de sync fuera de orden
    this.listenSupabaseRealtime();
    this.checkExpirationsAndNotify();
  }

  loadData() {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) return JSON.parse(stored);
    } catch (e) {
      console.warn("Error LocalStorage:", e);
    }
    this.saveData(DEFAULT_DATA);
    return DEFAULT_DATA;
  }

  saveData(newData) {
    this.data = newData || this.data;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.data));
    } catch (e) {
      console.error("Error guardando LocalStorage:", e);
    }
    window.dispatchEvent(new CustomEvent('gym_store_updated'));
  }

  async syncWithSupabase(alumnoId) {
    if (!window.supabaseEngine) return;
    // Token de secuencia: si mientras esta llamada está en vuelo se dispara
    // otra sync más nueva, la respuesta de ESTA llamada se descarta al volver,
    // para que nunca "gane" una respuesta vieja sobre una más reciente.
    const requestToken = ++this._syncSeq;
    try {
      // Si hay alumnoId, la RPC obtener_rutinas_alumno obtendrá sus rutinas.
      // Si no hay alumnoId (profesor), solo se sincronizan profiles y dnis.
      const freshData = await window.supabaseEngine.fetchFullStateFromSupabase(alumnoId || null);

      if (requestToken !== this._syncSeq) {
        console.log("⏭️ Descartando respuesta de sync obsoleta (fuera de orden).");
        return;
      }

      if (freshData) {
        let huboCambios = false;

        if (freshData.dnisAutorizados && freshData.dnisAutorizados.length > 0) {
          this.data.dnisAutorizados = freshData.dnisAutorizados;
          huboCambios = true;
        }

        if (freshData.alumnos && freshData.alumnos.length > 0) {
          freshData.alumnos.forEach(sbAlumno => {
            const loc = this.data.alumnos.find(a => a.dni === sbAlumno.dni || a.id === sbAlumno.id);
            if (loc) {
              loc.estadoAutorizacion = sbAlumno.estadoAutorizacion || loc.estadoAutorizacion;
              loc.nombre = sbAlumno.nombre || loc.nombre;
              loc.telefono = sbAlumno.telefono || loc.telefono;
              if (sbAlumno.rutinaActivaId) loc.rutinaActivaId = sbAlumno.rutinaActivaId;
            } else {
              this.data.alumnos.push(sbAlumno);
            }
          });
          huboCambios = true;
        }

        // Rutinas: solo cuando se obtuvieron via RPC (alumnoId presente)
        if (freshData.rutinas && freshData.rutinas.length > 0) {
          freshData.rutinas.forEach(sbRutina => {
            const idx = this.data.rutinas.findIndex(r => r.id === sbRutina.id);
            if (idx >= 0) {
              this.data.rutinas[idx] = sbRutina;
            } else {
              this.data.rutinas.push(sbRutina);
            }

            // Actualizar rutinaActivaId en el perfil local del alumno si es activa
            if (alumnoId && sbRutina.estado === 'activa') {
              const alumno = this.data.alumnos.find(a => a.id === alumnoId || a.id === sbRutina.alumnoId);
              if (alumno && !alumno.rutinaActivaId) {
                alumno.rutinaActivaId = sbRutina.id;
              }
            }
          });
          huboCambios = true;
        }

        if (freshData.workoutLogs && freshData.workoutLogs.length > 0) {
          freshData.workoutLogs.forEach(sbLog => {
            const idx = this.data.workoutLogs.findIndex(w => w.id === sbLog.id);
            if (idx >= 0) {
              this.data.workoutLogs[idx] = sbLog;
            } else {
              this.data.workoutLogs.unshift(sbLog);
            }
          });
          huboCambios = true;
        }

        if (freshData.notificaciones && freshData.notificaciones.length > 0) {
          this.data.notificaciones = freshData.notificaciones;
          huboCambios = true;
        }

        if (huboCambios) {
          console.log("🟢 Sincronizado exitosamente con Supabase DB (Fuente de Verdad).");
          this.saveData();
        }
      }
    } catch (err) {
      console.warn("⚠️ Error en syncWithSupabase:", err);
    }
  }

  listenSupabaseRealtime() {
    window.addEventListener('supabase_realtime_change', async (e) => {
      console.log("⚡ Actualización Supabase recibida en tiempo real:", e.detail);
      // Pasar el alumnoId del usuario logueado si está disponible en sesión
      const alumnoId = (window._sessionAlumnoId) || null;
      await this.syncWithSupabase(alumnoId);
    });

    window.addEventListener('storage', (e) => {
      if (e.key === STORAGE_KEY && e.newValue) {
        // No confiamos ciegamente en el contenido de localStorage escrito por otra
        // pestaña: puede pertenecer a otra sesión (alumno/profesor) o estar
        // desactualizado. En vez de sobrescribir this.data directamente,
        // forzamos una resincronización real contra Supabase (fuente de verdad)
        // respetando el rol de ESTA pestaña.
        const alumnoId = window._sessionAlumnoId || null;
        this.syncWithSupabase(alumnoId);
      }
    });

    // Sincronización inicial diferida (sin alumnoId — perfil y dnis)
    setTimeout(() => this.syncWithSupabase(null), 400);
  }

  // --- AUTENTICACIÓN Y AUTORIZACIÓN POR DNI ---
  login(dni, password) {
    const cleanDni = String(dni).trim();
    const cleanPass = String(password).trim();

    // Intentar sincronización previa
    this.syncWithSupabase();

    // 1. Buscar en Profesores
    const profesor = this.data.profesores.find(p => p.dni === cleanDni && p.password === cleanPass);
    if (profesor) return { rol: 'profesor', data: profesor };

    // 2. Buscar en Alumnos
    const alumno = this.data.alumnos.find(a => a.dni === cleanDni && a.password === cleanPass);
    if (alumno) {
      return { rol: 'alumno', data: alumno };
    }

    return null;
  }

  registrarseAlumno({ dni, password, nombre, telefono }) {
    const cleanDni = String(dni).trim();
    if (this.data.alumnos.some(a => a.dni === cleanDni)) {
      throw new Error("Ya existe una cuenta creada con ese DNI.");
    }

    // Verificar si el DNI fue autorizado previamente por el Gimnasio
    const estaAutorizado = this.data.dnisAutorizados.some(d => d.dni === cleanDni);
    const generatedId = (window.crypto && window.crypto.randomUUID) ? window.crypto.randomUUID() : ("al-" + Date.now());

    const nuevoAlumno = {
      id: generatedId,
      dni: cleanDni,
      password: String(password).trim(),
      nombre: nombre.trim(),
      telefono: telefono ? telefono.trim() : "",
      estadoAutorizacion: estaAutorizado ? 'autorizado' : 'pendiente',
      fechaRegistro: new Date().toISOString().split('T')[0],
      rutinaActivaId: null
    };

    this.data.alumnos.push(nuevoAlumno);

    // Persistir nuevo perfil en Supabase DB
    if (window.supabaseEngine) {
      window.supabaseEngine.registrarPerfilEnSupabase(nuevoAlumno);
    }

    this.saveData();
    return nuevoAlumno;
  }

  autorizarOAgregarAlumnoPorProfesor({ dni, nombre, telefono }) {
    const cleanDni = String(dni).trim();
    
    // 1. Persistir en Supabase DB (fuente de verdad)
    if (window.supabaseEngine) {
      window.supabaseEngine.autorizarDniEnSupabase(cleanDni, nombre);
    }

    // 2. Registrar DNI en la lista local
    if (!this.data.dnisAutorizados.some(d => d.dni === cleanDni)) {
      this.data.dnisAutorizados.push({ dni: cleanDni, nombre: nombre.trim() });
    }

    let alumno = this.data.alumnos.find(a => a.dni === cleanDni);
    if (alumno) {
      alumno.estadoAutorizacion = 'autorizado';
      alumno.nombre = nombre.trim();
    } else {
      const newId = (window.crypto && window.crypto.randomUUID) ? window.crypto.randomUUID() : ("al-" + Date.now());
      alumno = {
        id: newId,
        dni: cleanDni,
        password: "123",
        nombre: nombre.trim(),
        telefono: telefono ? telefono.trim() : "",
        estadoAutorizacion: 'autorizado',
        fechaRegistro: new Date().toISOString().split('T')[0],
        rutinaActivaId: null
      };
      this.data.alumnos.push(alumno);
    }

    this.saveData();
    return alumno;
  }

  // --- CONSULTAS ---
  getAlumnoPorId(id) {
    return this.data.alumnos.find(a => a.id === id) || null;
  }

  getRutinasAlumno(alumnoId) {
    return this.data.rutinas
      .filter(r => r.alumnoId === alumnoId)
      .sort((a, b) => (b.estado === 'activa' ? 1 : 0) - (a.estado === 'activa' ? 1 : 0));
  }

  getRutinaPorId(rutinaId) {
    return this.data.rutinas.find(r => r.id === rutinaId) || null;
  }

  getRutinaActiva(alumnoId) {
    const alumno = this.getAlumnoPorId(alumnoId);
    if (!alumno || alumno.estadoAutorizacion !== 'autorizado') return null;
    if (alumno.rutinaActivaId) {
      const rut = this.data.rutinas.find(r => r.id === alumno.rutinaActivaId && r.estado === 'activa');
      if (rut) return rut;
    }
    // Fallback: Retornar la rutina activa más reciente asignada al alumno
    return this.data.rutinas
      .filter(r => (r.alumnoId === alumno.id || r.alumnoId === alumno.dni) && (r.estado === 'activa' || !r.estado))
      .sort((a, b) => new Date(b.fechaInicio || 0) - new Date(a.fechaInicio || 0))[0] || null;
  }

  getHistorialRutinas(alumnoId) {
    return this.data.rutinas.filter(r => r.alumnoId === alumnoId && r.id !== this.getAlumnoPorId(alumnoId)?.rutinaActivaId);
  }

  getHistorialEntrenamientosReales(alumnoId) {
    return this.data.workoutLogs.filter(w => w.alumnoId === alumnoId && w.estado === 'completado');
  }

  getAlumnosFiltrados({ busqueda = '', filtro = 'todos' }) {
    const query = busqueda.toLowerCase().trim();
    return this.data.alumnos.filter(alumno => {
      const matchQuery = !query || alumno.nombre.toLowerCase().includes(query) || alumno.dni.includes(query);
      if (!matchQuery) return false;
      const rutina = this.getRutinaActiva(alumno.id);
      if (filtro === 'activa') return !!rutina;
      if (filtro === 'por_vencer') {
        if (!rutina) return false;
        const d = this.calcularDiasRestantes(rutina.fechaVencimiento);
        return d >= 0 && d <= 1;
      }
      if (filtro === 'expirada') {
        if (!rutina) return true;
        const d = this.calcularDiasRestantes(rutina.fechaVencimiento);
        return d < 0;
      }
      return true;
    });
  }

  // --- CREAR NUEVA RUTINA (PERMITIENDO MÚLTIPLES RUTINAS POR ALUMNO) ---
  crearOActualizarRutina({ alumnoId, profesorNombre, titulo, duracionDias, dias }) {
    const alumno = this.getAlumnoPorId(alumnoId);
    if (!alumno) return;

    const hoy = new Date();
    const fechaVenc = new Date(hoy.getTime() + Number(duracionDias) * 86400000);

    const routineUuid = (window.crypto && window.crypto.randomUUID) ? window.crypto.randomUUID() : ("rut-" + Date.now());

    const nuevaRutina = {
      id: routineUuid,
      alumnoId,
      // UUID real del profesor (del perfil en Supabase), para routines.profesor_id
      profesorId: window._sessionProfesorId || null,
      profesorCreadorNombre: profesorNombre || "Profesor de Estudio Fitness",
      titulo: titulo || "Rutina Personalizada",
      duracionDias: Number(duracionDias),
      fechaInicio: hoy.toISOString().split('T')[0],
      fechaVencimiento: fechaVenc.toISOString().split('T')[0],
      estado: "activa",
      dias
    };

    this.data.rutinas.push(nuevaRutina);
    alumno.rutinaActivaId = nuevaRutina.id;

    // Persistir en Supabase DB
    if (window.supabaseEngine) {
      window.supabaseEngine.persistirNuevaRutinaEnSupabase(nuevaRutina);
    }

    // Enviar notificación Push al alumno
    this.crearNotificacion({
      destinatarioRol: "alumno",
      alumnoId,
      mensaje: `🔥 Tu profesor ${profesorNombre || ''} te asignó la rutina "${nuevaRutina.titulo}".`,
      rutaDestino: "rutina",
      rutinaId: nuevaRutina.id
    });

    this.saveData();
    return nuevaRutina;
  }

  // --- EDITAR RUTINA EXISTENTE CONSERVANDO HISTORIAL Y MULTI-RUTINAS ---
  editarRutinaExistente({ rutinaId, profesorNombre, titulo, duracionDias, dias }) {
    const rutina = this.getRutinaPorId(rutinaId);
    if (!rutina) throw new Error("La rutina a editar no fue encontrada.");

    rutina.titulo = titulo || rutina.titulo;
    rutina.duracionDias = Number(duracionDias) || rutina.duracionDias;

    // Recalcular vencimiento desde la fecha de inicio
    const fInicio = rutina.fechaInicio ? new Date(rutina.fechaInicio) : new Date();
    const fechaVenc = new Date(fInicio.getTime() + Number(rutina.duracionDias) * 86400000);
    rutina.fechaVencimiento = fechaVenc.toISOString().split('T')[0];
    rutina.dias = dias;

    if (profesorNombre) rutina.profesorCreadorNombre = profesorNombre;

    // Asegurar que profesorId esté presente para que guardar_rutina_profesor
    // actualice routines.profesor_id con el UUID real del profesor
    if (window._sessionProfesorId && !rutina.profesorId) {
      rutina.profesorId = window._sessionProfesorId;
    }

    // Persistir en Supabase DB
    if (window.supabaseEngine) {
      window.supabaseEngine.persistirEdicionRutinaEnSupabase(rutina);
    }

    // Enviar notificación Push al alumno
    this.crearNotificacion({
      destinatarioRol: "alumno",
      alumnoId: rutina.alumnoId,
      mensaje: `Tu profesor ${profesorNombre || ''} actualizó tu rutina "${rutina.titulo}" 💪`,
      rutaDestino: "rutina",
      rutinaId: rutina.id
    });

    this.saveData();
    return rutina;
  }

  // --- GUARDADO DE SESIÓN DE ENTRENAMIENTO REAL POR SERIES Y COMENTARIO GENERAL ---
  guardarEntrenamientoReal({ alumnoId, rutinaId, diaId, diaNombre, diaNumero, setsLog, comentarioGeneral = "" }) {
    // UUID nativo desde el inicio: mismo ID en localStorage y en Supabase
    const logId = (window.crypto && window.crypto.randomUUID)
      ? window.crypto.randomUUID()
      : ("log-" + Date.now());

    const fechaISO = new Date().toISOString();

    const nuevoLog = {
      id: logId,
      alumnoId,
      rutinaId,
      diaId,
      diaNombre,
      diaNumero: diaNumero || 1,
      fecha: fechaISO,
      estado: "completado",
      comentarioGeneral: comentarioGeneral || "",
      sets: setsLog
    };

    this.data.workoutLogs.unshift(nuevoLog);

    if (window.supabaseEngine) {
      window.supabaseEngine.guardarWorkoutLogEnSupabase(nuevoLog);
    }

    const alumno = this.getAlumnoPorId(alumnoId);
    if (alumno) {
      this.crearNotificacion({
        destinatarioRol: "profesor",
        alumnoId: alumno.id,
        mensaje: `✅ ${alumno.nombre} completó su entrenamiento: ${diaNombre}.`,
        rutaDestino: "historial"
      });
    }

    this.saveData();
    return nuevoLog;
  }

  crearNotificacion({ destinatarioRol, alumnoId, mensaje, rutaDestino = "rutina", rutinaId = null }) {
    const notif = {
      id: "notif-" + Date.now() + Math.random().toString(36).substr(2, 4),
      destinatarioRol,
      alumnoId,
      mensaje,
      rutaDestino,
      rutinaId,
      fecha: new Date().toISOString(),
      leido: false
    };

    this.data.notificaciones.unshift(notif);

    // Enviar Web Push real si es un alumno y Supabase Engine está activo
    if (destinatarioRol === "alumno" && alumnoId && window.supabaseEngine) {
      window.supabaseEngine.enviarPushNotificationAAlumno(alumnoId, {
        title: '🏋️ Estudio Fitness',
        body: mensaje,
        url: './index.html',
        routineId: rutinaId
      });
    }

    this.dispararNotificacionPushNativa(mensaje);
    this.saveData();
  }

  getNotificacionesPorRol(rol, alumnoId = null) {
    return this.data.notificaciones.filter(n => {
      if (n.destinatarioRol !== rol) return false;
      if (rol === 'alumno' && n.alumnoId !== alumnoId) return false;
      return true;
    });
  }

  marcarNotificacionesLeidas(rol, alumnoId = null) {
    this.data.notificaciones.forEach(n => {
      if (n.destinatarioRol === rol) {
        if (rol === 'alumno' && n.alumnoId !== alumnoId) return;
        n.leido = true;
      }
    });
    this.saveData();
  }

  checkExpirationsAndNotify() {
    let huboCambios = false;
    const hoy = new Date();
    this.data.rutinas.forEach(rutina => {
      if (rutina.estado === 'activa') {
        const d = this.calcularDiasRestantes(rutina.fechaVencimiento);
        if (d <= 1 && d >= 0) {
          const alumno = this.getAlumnoPorId(rutina.alumnoId);
          if (alumno) {
            const yaNotificado = this.data.notificaciones.some(
              n => n.destinatarioRol === 'profesor' && 
                   n.alumnoId === alumno.id && 
                   n.mensaje.includes('vence mañana') &&
                   this.esMismoDia(new Date(n.fecha), hoy)
            );
            if (!yaNotificado) {
              this.crearNotificacion({
                destinatarioRol: "profesor",
                alumnoId: alumno.id,
                mensaje: `⏰ La rutina de ${alumno.nombre} (DNI ${alumno.dni}) vence mañana.`
              });
              this.crearNotificacion({
                destinatarioRol: "alumno",
                alumnoId: alumno.id,
                mensaje: `⏰ Tu rutina "${rutina.titulo}" vence mañana. ¡Contacta a tu profe!`
              });
              huboCambios = true;
            }
          }
        } else if (d < 0) {
          rutina.estado = 'expirada';
          huboCambios = true;
        }
      }
    });
    if (huboCambios) this.saveData();
  }

  calcularDiasRestantes(fechaVencStr) {
    const hoy = new Date(); hoy.setHours(0,0,0,0);
    const venc = new Date(fechaVencStr); venc.setHours(0,0,0,0);
    return Math.ceil((venc.getTime() - hoy.getTime()) / (1000 * 60 * 60 * 24));
  }

  esMismoDia(d1, d2) {
    return d1.getFullYear() === d2.getFullYear() && d1.getMonth() === d2.getMonth() && d1.getDate() === d2.getDate();
  }

  dispararNotificacionPushNativa(mensaje) {
    if ('Notification' in window && Notification.permission === 'granted') {
      try {
        if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
          navigator.serviceWorker.ready.then(reg => {
            reg.showNotification('Estudio Fitness 🏋️‍♂️', {
              body: mensaje,
              icon: './icons/icon-192x192.png',
              badge: './icons/icon-192x192.png',
              tag: 'estudio-fitness-' + Date.now()
            });
          });
        }
      } catch (e) {
        console.warn("Push error:", e);
      }
    }
  }
}

window.gymStore = new GymStore();
