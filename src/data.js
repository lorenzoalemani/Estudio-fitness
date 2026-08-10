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
    { id: "prof-1", dni: "99001122", password: "123", nombre: "Prof. Carlos Rossi", rol: "profesor" },
    { id: "prof-2", dni: "88001122", password: "123", nombre: "Prof. Franco Gómez", rol: "profesor" }
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

  listenSupabaseRealtime() {
    window.addEventListener('supabase_realtime_change', (e) => {
      console.log("⚡ Actualización Supabase recibida:", e.detail);
      this.saveData();
    });

    window.addEventListener('storage', (e) => {
      if (e.key === STORAGE_KEY && e.newValue) {
        try {
          this.data = JSON.parse(e.newValue);
          window.dispatchEvent(new CustomEvent('gym_store_updated'));
        } catch (err) {}
      }
    });
  }

  // --- AUTENTICACIÓN Y AUTORIZACIÓN POR DNI ---
  login(dni, password) {
    const cleanDni = String(dni).trim();
    const cleanPass = String(password).trim();

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

    const nuevoAlumno = {
      id: "al-" + Date.now(),
      dni: cleanDni,
      password: String(password).trim(),
      nombre: nombre.trim(),
      telefono: telefono ? telefono.trim() : "",
      estadoAutorizacion: estaAutorizado ? 'autorizado' : 'pendiente',
      fechaRegistro: new Date().toISOString().split('T')[0],
      rutinaActivaId: null
    };

    this.data.alumnos.push(nuevoAlumno);
    this.saveData();
    return nuevoAlumno;
  }

  autorizarOAgregarAlumnoPorProfesor({ dni, nombre, telefono }) {
    const cleanDni = String(dni).trim();
    
    // Registrar DNI en la lista de autorizados
    if (!this.data.dnisAutorizados.some(d => d.dni === cleanDni)) {
      this.data.dnisAutorizados.push({ dni: cleanDni, nombre: nombre.trim() });
    }

    let alumno = this.data.alumnos.find(a => a.dni === cleanDni);
    if (alumno) {
      alumno.estadoAutorizacion = 'autorizado';
      alumno.nombre = nombre.trim();
    } else {
      alumno = {
        id: "al-" + Date.now(),
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

  getRutinaActiva(alumnoId) {
    const alumno = this.getAlumnoPorId(alumnoId);
    if (!alumno || alumno.estadoAutorizacion !== 'autorizado' || !alumno.rutinaActivaId) return null;
    return this.data.rutinas.find(r => r.id === alumno.rutinaActivaId && r.estado === 'activa') || null;
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

  // --- CREAR NUEVA RUTINA (ARCHIVANDO LA ANTERIOR) ---
  crearOActualizarRutina({ alumnoId, profesorNombre, titulo, duracionDias, dias }) {
    const alumno = this.getAlumnoPorId(alumnoId);
    if (!alumno) return;

    // Si el alumno ya tenía una rutina activa, archivarla en el historial como completada
    if (alumno.rutinaActivaId) {
      const vieja = this.data.rutinas.find(r => r.id === alumno.rutinaActivaId);
      if (vieja) vieja.estado = "completada";
    }

    const hoy = new Date();
    const fechaVenc = new Date(hoy.getTime() + Number(duracionDias) * 86400000);

    const nuevaRutina = {
      id: "rut-" + Date.now(),
      alumnoId,
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

    // Enviar notificación Push al alumno
    this.crearNotificacion({
      destinatarioRol: "alumno",
      alumnoId,
      mensaje: `🔥 Nueva rutina: ${profesorNombre || 'Tu profesor'} te asignó "${nuevaRutina.titulo}".`,
      rutaDestino: "rutina"
    });

    this.saveData();
    return nuevaRutina;
  }

  // --- GUARDADO DE SESIÓN DE ENTRENAMIENTO REAL POR SERIES ---
  guardarEntrenamientoReal({ alumnoId, rutinaId, diaId, diaNombre, setsLog }) {
    const nuevoLog = {
      id: "log-" + Date.now(),
      alumnoId,
      rutinaId,
      diaId,
      diaNombre,
      fecha: new Date().toISOString(),
      estado: "completado",
      sets: setsLog
    };

    this.data.workoutLogs.unshift(nuevoLog);

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

  crearNotificacion({ destinatarioRol, alumnoId, mensaje, rutaDestino = "rutina" }) {
    const notif = {
      id: "notif-" + Date.now() + Math.random().toString(36).substr(2, 4),
      destinatarioRol,
      alumnoId,
      mensaje,
      rutaDestino,
      fecha: new Date().toISOString(),
      leido: false
    };

    this.data.notificaciones.unshift(notif);
    this.dispararNotificacionPushNativa(mensaje);
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
