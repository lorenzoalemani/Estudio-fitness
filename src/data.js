// Módulo de Datos y Estado v4 - Estudio Fitness (Supabase Source of Truth & Set-by-Set Logger)

const STORAGE_KEY = 'estudio_fitness_db_v4';

// UUID fijo de OCTAVIO MONTERSINO — el MISMO id que se inserta en Supabase
// (profiles.id) mediante el script SQL de limpieza, para que el profesor
// quede identificado igual en local y en la DB y no se dupliquen registros
// al sincronizar entre dispositivos.
const OCTAVIO_ID = "da631950-9e21-447e-801a-dd21d3fae8d4";

// Padrón Inicial de DNI Autorizados por el Gimnasio.
// Vacío a propósito: ya no hay alumnos de prueba pre-autorizados. El
// profesor autoriza alumnos reales desde el panel (autorizarOAgregarAlumnoPorProfesor).
const DEFAULT_AUTHORIZED_DNIS = [];

// Estado inicial de una instalación nueva (localStorage vacío): un único
// profesor real, sin alumnos, rutinas, historiales ni notificaciones de
// demostración.
const DEFAULT_DATA = {
  profesores: [
    { id: OCTAVIO_ID, dni: "41976817", password: "octagym2000", nombre: "OCTAVIO MONTERSINO", rol: "profesor" }
  ],
  dnisAutorizados: DEFAULT_AUTHORIZED_DNIS,
  alumnos: [],
  rutinas: [],

  // REGISTROS REALES DE ENTRENAMIENTO POR SERIE (RESULTADO REAL ALUMNO)
  workoutLogs: [],

  notificaciones: []
};

class GymStore {
  constructor() {
    this.data = this.loadData();
    this._syncSeq = 0; // Token de secuencia para descartar respuestas de sync fuera de orden
    this._authSyncSeq = 0; // Token de secuencia EXCLUSIVO de syncs con alumnoId (autenticadas).
    // Una sync sin alumnoId (más liviana, no trae rutinas) nunca debe poder
    // invalidar la respuesta de una sync CON alumnoId (la que sí trae rutinas),
    // aunque haya arrancado después y termine antes. Por eso se comparan por
    // separado: cada tipo de llamada solo puede ser "pisada" por otra de su mismo tipo.
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
    // Si esta llamada trae alumnoId (autenticada), también reserva un token en
    // el contador paralelo _authSyncSeq. Solo otra llamada CON alumnoId más
    // nueva puede invalidarla — una sync sin alumnoId que arranque después
    // (por ejemplo, la inicial del constructor) ya no puede pisarla.
    const isAuthSync = !!alumnoId;
    const authRequestToken = isAuthSync ? ++this._authSyncSeq : null;
    try {
      // Si hay alumnoId, la RPC obtener_rutinas_alumno obtendrá sus rutinas.
      // Si no hay alumnoId (profesor), solo se sincronizan profiles y dnis.
      const freshData = await window.supabaseEngine.fetchFullStateFromSupabase(alumnoId || null);

      const isStale = isAuthSync
        ? (authRequestToken !== this._authSyncSeq)
        : (requestToken !== this._syncSeq);

      if (isStale) {
        console.log("⏭️ Descartando respuesta de sync obsoleta (fuera de orden).");
        return;
      }

      if (freshData) {
        let huboCambios = false;

        // NOTA GENERAL: a partir de acá, cada campo de freshData es un array
        // (posiblemente VACÍO — snapshot real de Supabase) o `null` (no se
        // consultó, o la consulta falló). Se chequea `!== null`, nunca
        // `.length > 0`, para no confundir "no hay nada" con "no se pudo
        // consultar" — ver comentario en fetchFullStateFromSupabase().

        if (freshData.dnisAutorizados !== null) {
          this.data.dnisAutorizados = freshData.dnisAutorizados;
          huboCambios = true;
        }

        // ALUMNOS: Supabase es la fuente de verdad. Reconciliación completa:
        // se reconstruye this.data.alumnos a partir del snapshot de Supabase
        // (agrega los nuevos, actualiza los existentes) y, como resultado,
        // cualquier alumno local que ya NO está en el snapshot queda
        // automáticamente afuera (podado) — ya no sobrevive un alumno
        // eliminado en Supabase solo porque seguía en localStorage.
        if (freshData.alumnos !== null) {
          this.data.alumnos = freshData.alumnos.map(sbAlumno => {
            const loc = this.data.alumnos.find(a => a.dni === sbAlumno.dni || a.id === sbAlumno.id);
            if (!loc) return sbAlumno;
            return {
              ...loc,
              ...sbAlumno,
              // password: la consulta a `profiles` (ver fetchFullStateFromSupabase)
              // NO selecciona esta columna, así que sbAlumno.password siempre
              // es null (el fallback). Si copiáramos sbAlumno tal cual
              // pisaríamos la contraseña real guardada localmente con null en
              // cada sync. Se conserva SIEMPRE el password local si existe.
              password: loc.password !== undefined ? loc.password : sbAlumno.password,
              // rutinaActivaId: Supabase siempre lo manda en null (no se lee
              // de esa tabla); se conserva el valor local conocido si existe,
              // igual que hacía la lógica anterior.
              rutinaActivaId: sbAlumno.rutinaActivaId || loc.rutinaActivaId,
              // Puntos/Ranking: profiles.puntos_total (Supabase) es la fuente
              // de verdad. Si la columna todavía no existe en producción
              // (antes de correr el patch SQL), sbAlumno.puntosTotal viene
              // undefined y se conserva el valor local sin tocarlo.
              puntosTotal: sbAlumno.puntosTotal !== undefined ? sbAlumno.puntosTotal : loc.puntosTotal,
              rachaSemanal: sbAlumno.rachaSemanal !== undefined ? sbAlumno.rachaSemanal : loc.rachaSemanal
            };
          });
          huboCambios = true;
        }

        // PROFESORES: antes NO se sincronizaba nunca (freshData.profesores se
        // calculaba en supabase.js pero jamás se leía acá), por lo que un
        // profesor eliminado en Supabase seguía viviendo para siempre en
        // localStorage y podía loguearse con esas credenciales. Mismo
        // criterio de reconciliación completa que alumnos.
        if (freshData.profesores !== null) {
          this.data.profesores = freshData.profesores.map(sbProfesor => {
            const loc = this.data.profesores.find(p => p.dni === sbProfesor.dni || p.id === sbProfesor.id);
            if (!loc) return sbProfesor;
            return {
              ...loc,
              ...sbProfesor,
              // password: mismo motivo que en alumnos — la columna no viaja
              // desde Supabase (ver fetchFullStateFromSupabase), sbProfesor.password
              // es siempre null. Se conserva el valor local real.
              password: loc.password !== undefined ? loc.password : sbProfesor.password
            };
          });
          huboCambios = true;
        }

        // RUTINAS: solo se consultaron (via RPC) las del alumnoId de ESTA
        // llamada, así que la reconciliación debe limitarse estrictamente a
        // las rutinas de ese alumno — nunca tocar rutinas de otros alumnos
        // que no formaron parte de esta consulta.
        // Excepción importante: las rutinas "propias" (esPropia: true,
        // auto-gestionadas por el alumno) son 100% locales por diseño y
        // NUNCA se escriben ni se leen de Supabase — no deben podarse solo
        // porque no aparecen en el snapshot de la RPC.
        if (alumnoId && freshData.rutinas !== null) {
          const idsFrescos = new Set(freshData.rutinas.map(r => r.id));
          this.data.rutinas = this.data.rutinas.filter(r => {
            if (r.alumnoId !== alumnoId) return true; // no es de este alumno: no tocar
            if (r.esPropia) return true; // rutina propia local: nunca se poda
            return idsFrescos.has(r.id); // rutina asignada por profesor: podar si ya no existe en Supabase
          });

          freshData.rutinas.forEach(sbRutina => {
            const idx = this.data.rutinas.findIndex(r => r.id === sbRutina.id);
            if (idx >= 0) {
              this.data.rutinas[idx] = sbRutina;
            } else {
              this.data.rutinas.push(sbRutina);
            }

            // Actualizar rutinaActivaId en el perfil local del alumno si es activa
            if (sbRutina.estado === 'activa') {
              const alumno = this.data.alumnos.find(a => a.id === alumnoId || a.id === sbRutina.alumnoId);
              if (alumno && !alumno.rutinaActivaId) {
                alumno.rutinaActivaId = sbRutina.id;
              }
            }
          });
          huboCambios = true;
        }

        if (freshData.workoutLogs !== null) {
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

        if (freshData.notificaciones !== null) {
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

  // --- RUTINAS DEL PROFESOR (PUNTO C) ---
  // El profesor no tiene un alumnoId propio, así que syncWithSupabase(null)
  // nunca trae rutinas (ver comentario en esa función). Para que el profesor
  // vea rutinas creadas/editadas desde OTRO dispositivo, consultamos la RPC
  // obtener_rutinas_alumno UNA VEZ POR CADA ALUMNO que el profesor ya conoce
  // localmente (this.data.alumnos), y mergeamos los resultados.
  //
  // Condición de seguridad: si la consulta de un alumno puntual falla (error
  // de red, RPC, o promesa rechazada), esa falla se ignora por completo y NO
  // borra ni pisa las rutinas locales existentes — ni las de ese alumno ni
  // las de ningún otro. Solo se reconcilian las rutinas de los alumnos cuya
  // consulta sí llegó ok (resultado.ok === true), incluyendo poda si esa
  // respuesta vino vacía. No modifica _syncSeq/_authSyncSeq (no comparte su
  // lógica de descarte).
  async syncRutinasProfesor() {
    if (!window.supabaseEngine) return;

    const alumnosConocidos = (this.data.alumnos || []).filter(a => a && a.id);
    if (alumnosConocidos.length === 0) return;

    const resultados = await Promise.allSettled(
      alumnosConocidos.map(alumno => window.supabaseEngine.obtenerRutinasAlumnoDesdeSupabase(alumno.id))
    );

    let huboCambios = false;

    resultados.forEach((r, i) => {
      // Promesa rechazada o resultado ok:false -> se ignora, no se toca this.data.
      if (r.status !== 'fulfilled') return;
      const resultado = r.value;
      if (!resultado || resultado.ok !== true) return;

      const alumnoId = alumnosConocidos[i].id;
      const rutinasFrescas = resultado.rutinas || [];
      const idsFrescos = new Set(rutinasFrescas.map(rt => rt.id));

      // Poda: de las rutinas locales de ESTE alumno (nunca de otros, y nunca
      // las "propias" auto-gestionadas, que son locales por diseño), eliminar
      // las que ya no están en el snapshot fresco de Supabase.
      this.data.rutinas = this.data.rutinas.filter(rt => {
        if (rt.alumnoId !== alumnoId) return true;
        if (rt.esPropia) return true;
        return idsFrescos.has(rt.id);
      });

      rutinasFrescas.forEach(sbRutina => {
        const idx = this.data.rutinas.findIndex(rt => rt.id === sbRutina.id);
        if (idx >= 0) {
          this.data.rutinas[idx] = sbRutina;
        } else {
          this.data.rutinas.push(sbRutina);
        }
      });
      huboCambios = true;
    });

    if (huboCambios) {
      console.log("🟢 Rutinas del profesor sincronizadas desde Supabase (Fuente de Verdad).");
      this.saveData();
    }
  }

  listenSupabaseRealtime() {
    window.addEventListener('supabase_realtime_change', async (e) => {
      console.log("⚡ Actualización Supabase recibida en tiempo real:", e.detail);
      // Pasar el alumnoId del usuario logueado si está disponible en sesión
      const alumnoId = (window._sessionAlumnoId) || null;
      await this.syncWithSupabase(alumnoId);
      // Realtime es solo AVISO: si hay sesión de profesor activa, volvemos a
      // consultar Supabase (no this.data) para traer las rutinas actualizadas.
      if (window._sessionProfesorId) {
        await this.syncRutinasProfesor();
      }
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
        if (window._sessionProfesorId) {
          this.syncRutinasProfesor();
        }
      }
    });

    // --- PWA ANCLADA AL INICIO: refetch automático al volver a primer plano ---
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        const alumnoId = window._sessionAlumnoId || null;
        console.log("🔄 PWA volvió a primer plano (visibilitychange) → refetch automático con Supabase.");
        this.syncWithSupabase(alumnoId);
        if (window._sessionProfesorId) {
          this.syncRutinasProfesor();
        }
      }
    });

    document.addEventListener('resume', () => {
      const alumnoId = window._sessionAlumnoId || null;
      console.log("🔄 Evento 'resume' (PWA nativa) → refetch automático con Supabase.");
      this.syncWithSupabase(alumnoId);
      if (window._sessionProfesorId) {
        this.syncRutinasProfesor();
      }
    }, false);

    window.addEventListener('pageshow', (e) => {
      if (e.persisted) {
        const alumnoId = window._sessionAlumnoId || null;
        console.log("🔄 Evento 'pageshow' (bfcache) → refetch automático con Supabase.");
        this.syncWithSupabase(alumnoId);
        if (window._sessionProfesorId) {
          this.syncRutinasProfesor();
        }
      }
    });

    // Sincronización inicial diferida (sin alumnoId — perfil y dnis)
    setTimeout(() => this.syncWithSupabase(null), 400);
  }

  // --- REFETCH FORZADO AL TOCAR "RUTINAS" EN BOTTOM NAV O AL ABRIR UNA NOTIFICACIÓN ---
  async forceRefreshRutinas(alumnoId = null) {
    const idAUsar = alumnoId || window._sessionAlumnoId || null;
    console.log("🔄 Forzando reobtención fresca de Rutinas desde Supabase (tab Rutinas / notificación).");
    return this.syncWithSupabase(idAUsar);
  }

  // --- AUTENTICACIÓN Y AUTORIZACIÓN POR DNI ---
  // Async a propósito: la secuencia deseada es (1) sincronizar con Supabase,
  // (2) actualizar el estado local, (3) recién ahí validar credenciales.
  // Antes se disparaba syncWithSupabase() sin esperarlo (fire-and-forget) y
  // se validaba en el mismo tick contra this.data.profesores/alumnos, que
  // podían venir de una versión vieja de localStorage — una cuenta borrada
  // en Supabase pero todavía cacheada localmente podía loguearse igual.
  //
  // Limitación técnica a tener en cuenta: no conocemos el rol/id del usuario
  // ANTES de identificarlo por dni+password, así que este await es a
  // syncWithSupabase() SIN alumnoId (la sync "liviana": profiles + dnis, sin
  // rutinas vía RPC — igual que ya se usaba en otros puntos de entrada). Es
  // suficiente para este propósito porque profesores/alumnos (los datos que
  // el login necesita) sí se traen en esa sync liviana; las rutinas del
  // alumno se siguen trayendo después del login, como ya hacía app.js.
  //
  // syncWithSupabase() nunca rechaza (atrapa sus propios errores) y no hace
  // nada si no hay window.supabaseEngine (offline/no inicializado), así que
  // este await no puede trabar el login ni romper el funcionamiento offline:
  // si Supabase no responde, simplemente se valida contra el último estado
  // local conocido, igual que antes.
  async login(dni, password) {
    const cleanDni = String(dni).trim();
    const cleanPass = String(password).trim();

    // 1. Sincronizar con Supabase y esperar a que termine.
    await this.syncWithSupabase();

    // 2. Validar credenciales contra el estado YA actualizado.
    // 2a. Buscar en Profesores
    const profesor = this.data.profesores.find(p => p.dni === cleanDni && p.password === cleanPass);
    if (profesor) return { rol: 'profesor', data: profesor };

    // 2b. Buscar en Alumnos
    const alumno = this.data.alumnos.find(a => a.dni === cleanDni && a.password !== null && a.password === cleanPass);
    if (alumno) {
      return { rol: 'alumno', data: alumno };
    }

    return null;
  }

  registrarseAlumno({ dni, password, nombre, telefono }) {
    const cleanDni = String(dni).trim();
    const cleanPass = String(password).trim();

    const existente = this.data.alumnos.find(a => a.dni === cleanDni);

    if (existente) {
      // Caso B: alumno precreado/autorizado por el profesor (password === null
      // significa que el registro está incompleto — el alumno aún no eligió su
      // contraseña). Se completa la cuenta con los datos que el alumno acaba de
      // proporcionar en el formulario de registro.
      if (existente.password === null) {
        existente.password = cleanPass;
        existente.nombre = nombre.trim();
        existente.telefono = telefono ? telefono.trim() : (existente.telefono || "");

        // Persistir perfil en Supabase DB (INSERT — el perfil puede no existir
        // aún en la tabla profiles si solo se creó localmente por el profesor).
        if (window.supabaseEngine) {
          window.supabaseEngine.registrarPerfilEnSupabase(existente);
        }

        this.saveData();
        return existente;
      }

      // El alumno ya tiene contraseña real → ya completó su registro anteriormente.
      throw new Error("Ya existe una cuenta creada con ese DNI.");
    }

    // Caso A: DNI nuevo — crear alumno normalmente.
    // Verificar si el DNI fue autorizado previamente por el Gimnasio
    const estaAutorizado = this.data.dnisAutorizados.some(d => d.dni === cleanDni);
    const generatedId = (window.crypto && window.crypto.randomUUID) ? window.crypto.randomUUID() : ("al-" + Date.now());

    const nuevoAlumno = {
      id: generatedId,
      dni: cleanDni,
      password: cleanPass,
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
        password: null,
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
      .filter(r => r.alumnoId === alumnoId && !r.esPropia)
      .sort((a, b) => (b.estado === 'activa' ? 1 : 0) - (a.estado === 'activa' ? 1 : 0));
  }

  // --- FEATURE "MIS RUTINAS": rutinas auto-gestionadas por el propio alumno ---
  getRutinasPropiasAlumno(alumnoId) {
    return this.data.rutinas.filter(r => r.esPropia && r.alumnoCreadorId === alumnoId);
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
    // Fallback: Retornar la rutina activa más reciente asignada al alumno (excluye rutinas propias)
    return this.data.rutinas
      .filter(r => (r.alumnoId === alumno.id || r.alumnoId === alumno.dni) && !r.esPropia && (r.estado === 'activa' || !r.estado))
      .sort((a, b) => new Date(b.fechaInicio || 0) - new Date(a.fechaInicio || 0))[0] || null;
  }

  // Historial = todas las rutinas del alumno que NO están activas ahora
  // mismo (desactivada, completada o expirada). Antes filtraba por
  // "distinta de rutinaActivaId", lo cual dejaba afuera del historial a
  // cualquier rutina vieja cuyo id todavía coincidiera con rutinaActivaId
  // por datos desactualizados, y de paso metía en el historial rutinas
  // activas que el alumno nunca marcó como tal. Filtrar por estado real
  // es correcto en los dos sentidos.
  getHistorialRutinas(alumnoId) {
    return this.data.rutinas.filter(r => r.alumnoId === alumnoId && r.estado !== 'activa');
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
  async editarRutinaExistente({ rutinaId, profesorNombre, titulo, duracionDias, dias }) {
    const rutina = this.getRutinaPorId(rutinaId);
    if (!rutina) throw new Error("La rutina a editar no fue encontrada.");

    // Guardamos los valores originales antes de mutar, para poder revertir
    // en memoria si Supabase rechaza el guardado (rutina es la referencia
    // real del store, así que cualquier asignación de acá en más ya "pisa"
    // el estado en memoria antes de confirmar nada con el servidor).
    const original = {
      titulo: rutina.titulo,
      duracionDias: rutina.duracionDias,
      fechaVencimiento: rutina.fechaVencimiento,
      dias: rutina.dias,
      profesorCreadorNombre: rutina.profesorCreadorNombre,
      profesorId: rutina.profesorId
    };

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

    // Persistir en Supabase DB y ESPERAR confirmación real antes de
    // notificar al alumno o persistir localmente. Si Supabase rechaza el
    // guardado, revertimos la mutación en memoria (no dejamos "confirmado"
    // algo que el servidor no aceptó).
    if (window.supabaseEngine) {
      const resultado = await window.supabaseEngine.persistirEdicionRutinaEnSupabase(rutina);

      if (!resultado || resultado.ok !== true) {
        rutina.titulo = original.titulo;
        rutina.duracionDias = original.duracionDias;
        rutina.fechaVencimiento = original.fechaVencimiento;
        rutina.dias = original.dias;
        rutina.profesorCreadorNombre = original.profesorCreadorNombre;
        rutina.profesorId = original.profesorId;

        return { ok: false, error: (resultado && resultado.error) || 'error_desconocido' };
      }
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
    return { ok: true, data: rutina };
  }

  // --- ACTIVAR/DESACTIVAR RUTINA ASIGNADA POR EL PROFESOR ---
  // No confundir con eliminarRutinaPropia/editarRutinaPropia (rutinas
  // 100% locales del alumno): esto es para rutinas asignadas por un
  // profesor, con la misma lógica de "esperar confirmación real del
  // servidor y revertir en memoria si falla" que editarRutinaExistente.
  async cambiarEstadoRutina(rutinaId, profesorId, nuevoEstado) {
    const rutina = this.getRutinaPorId(rutinaId);
    if (!rutina) throw new Error("La rutina no fue encontrada.");
    if (nuevoEstado !== 'activa' && nuevoEstado !== 'desactivada') {
      throw new Error("Estado inválido.");
    }

    const estadoOriginal = rutina.estado;
    rutina.estado = nuevoEstado;

    if (window.supabaseEngine) {
      const resultado = await window.supabaseEngine.cambiarEstadoRutinaEnSupabase(rutinaId, profesorId, nuevoEstado);
      if (!resultado || resultado.ok !== true) {
        rutina.estado = estadoOriginal;
        return { ok: false, error: (resultado && resultado.error) || 'error_desconocido' };
      }
    }

    // Si se desactiva la rutina que el alumno tenía marcada como activa,
    // se le quita esa marca (getRutinaActiva ya no la devolvería igual,
    // pero mantenemos rutinaActivaId consistente con el estado real).
    if (nuevoEstado === 'desactivada') {
      const alumno = this.getAlumnoPorId(rutina.alumnoId);
      if (alumno && alumno.rutinaActivaId === rutinaId) alumno.rutinaActivaId = null;
    }

    this.saveData();
    return { ok: true, data: rutina };
  }

  // --- BORRAR RUTINA ASIGNADA POR EL PROFESOR ---
  async eliminarRutina(rutinaId, profesorId) {
    const rutina = this.getRutinaPorId(rutinaId);
    if (!rutina) throw new Error("La rutina no fue encontrada.");

    if (window.supabaseEngine) {
      const resultado = await window.supabaseEngine.eliminarRutinaEnSupabase(rutinaId, profesorId);
      if (!resultado || resultado.ok !== true) {
        return { ok: false, error: (resultado && resultado.error) || 'error_desconocido' };
      }
    }

    const idx = this.data.rutinas.findIndex(r => r.id === rutinaId);
    if (idx !== -1) this.data.rutinas.splice(idx, 1);

    const alumno = this.getAlumnoPorId(rutina.alumnoId);
    if (alumno && alumno.rutinaActivaId === rutinaId) alumno.rutinaActivaId = null;

    this.saveData();
    return { ok: true };
  }

  // --- CREAR/EDITAR/ELIMINAR RUTINA PROPIA (AUTO-GESTIÓN DEL ALUMNO) ---
  // Diseño intencional: las rutinas propias son 100% locales (LocalStorage) y
  // NUNCA se escriben en Supabase, para respetar el Fix 3 (bloqueo de
  // escritura de rutinas cuando no hay sesión de profesor activa). El alumno
  // no tiene `window._sessionProfesorId`, así que cualquier intento de
  // persistencia hacia la tabla `routines` sería rechazado de todas formas.
  crearRutinaPropia({ alumnoId, titulo, duracionDias, dias }) {
    const alumno = this.getAlumnoPorId(alumnoId);
    if (!alumno) throw new Error("Alumno no encontrado.");

    const hoy = new Date();
    const fechaVenc = new Date(hoy.getTime() + Number(duracionDias) * 86400000);
    const routineUuid = (window.crypto && window.crypto.randomUUID) ? window.crypto.randomUUID() : ("rutp-" + Date.now());

    const nuevaRutina = {
      id: routineUuid,
      alumnoId,
      esPropia: true,
      alumnoCreadorId: alumnoId,
      profesorCreadorNombre: "Auto-gestionada por el alumno",
      titulo: titulo || "Mi Rutina Personal",
      duracionDias: Number(duracionDias) || 30,
      fechaInicio: hoy.toISOString().split('T')[0],
      fechaVencimiento: fechaVenc.toISOString().split('T')[0],
      estado: "activa",
      dias
    };

    this.data.rutinas.push(nuevaRutina);
    this.saveData();
    return nuevaRutina;
  }

  editarRutinaPropia({ rutinaId, alumnoId, titulo, duracionDias, dias }) {
    const rutina = this.getRutinaPorId(rutinaId);
    if (!rutina || !rutina.esPropia || rutina.alumnoCreadorId !== alumnoId) {
      throw new Error("No tenés permiso para editar esta rutina.");
    }
    rutina.titulo = titulo || rutina.titulo;
    rutina.duracionDias = Number(duracionDias) || rutina.duracionDias;
    const fInicio = rutina.fechaInicio ? new Date(rutina.fechaInicio) : new Date();
    rutina.fechaVencimiento = new Date(fInicio.getTime() + Number(rutina.duracionDias) * 86400000).toISOString().split('T')[0];
    rutina.dias = dias;
    this.saveData();
    return rutina;
  }

  eliminarRutinaPropia(rutinaId, alumnoId) {
    const idx = this.data.rutinas.findIndex(r => r.id === rutinaId);
    if (idx === -1) throw new Error("Rutina no encontrada.");
    const rutina = this.data.rutinas[idx];
    if (!rutina.esPropia || rutina.alumnoCreadorId !== alumnoId) {
      throw new Error("No tenés permiso para eliminar esta rutina.");
    }
    this.data.rutinas.splice(idx, 1);
    const alumno = this.getAlumnoPorId(alumnoId);
    if (alumno && alumno.rutinaActivaId === rutinaId) alumno.rutinaActivaId = null;
    this.saveData();
  }

  // --- SISTEMA DE PUNTUACIÓN Y RACHA SEMANAL ---
  // Clave de semana ISO (YYYY-Www), estable independientemente del día exacto.
  getWeekKey(date) {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
    return `${d.getUTCFullYear()}-W${weekNo}`;
  }

  // +100 Base + Σ(peso × reps) por cada serie registrada / 100
  // (equivale a Peso × Reps × Series / 100 cuando peso/reps son constantes entre series)
  calcularPuntosSesion(setsLog) {
    let volumen = 0;
    (setsLog || []).forEach(s => {
      const pesoNum = parseFloat(String(s.pesoUtilizado).replace(',', '.')) || 0;
      const repsNum = Number(s.repsRealizadas) || 0;
      volumen += pesoNum * repsNum;
    });
    return Math.round((100 + volumen / 100) * 100) / 100;
  }

  // Actualiza la racha semanal del alumno y suma los puntos totales.
  // +50 puntos extra si esta sesión continúa una racha de 2+ semanas consecutivas.
  actualizarRachaYSumarPuntos(alumno, fechaISO, puntosBase) {
    const semanaActual = this.getWeekKey(new Date(fechaISO));
    if (!alumno.rachaSemanal) alumno.rachaSemanal = { semanas: 0, ultimaSemana: null };

    let bonusRacha = 0;
    if (alumno.rachaSemanal.ultimaSemana !== semanaActual) {
      const semanaAnteriorEsperada = this.getWeekKey(new Date(new Date(fechaISO).getTime() - 7 * 86400000));
      alumno.rachaSemanal.semanas = (alumno.rachaSemanal.ultimaSemana === semanaAnteriorEsperada)
        ? alumno.rachaSemanal.semanas + 1
        : 1;
      alumno.rachaSemanal.ultimaSemana = semanaActual;
      if (alumno.rachaSemanal.semanas >= 2) bonusRacha = 50;
    }

    alumno.puntosTotal = Math.round(((alumno.puntosTotal || 0) + puntosBase + bonusRacha) * 100) / 100;
    return bonusRacha;
  }

  // --- RANKING EN TIEMPO REAL (Top alumnos por puntos acumulados) ---
  getRanking() {
    return [...this.data.alumnos]
      .filter(a => (a.puntosTotal || 0) > 0 || a.estadoAutorizacion === 'autorizado')
      .sort((a, b) => (b.puntosTotal || 0) - (a.puntosTotal || 0))
      .map((a, idx) => ({ ...a, posicion: idx + 1 }));
  }

  // Ventana de 2hs para poder editar un entrenamiento ya guardado.
  puedeEditarseEntrenamiento(log) {
    if (!log || !log.fecha) return false;
    const transcurridoMs = Date.now() - new Date(log.fecha).getTime();
    return transcurridoMs >= 0 && transcurridoMs <= 2 * 60 * 60 * 1000;
  }

  // Devuelve true si ya existe, ENTRE LOS DATOS QUE TENEMOS LOCALMENTE, un
  // entrenamiento completado del alumno en el mismo día calendario (hora
  // local del dispositivo) que fechaISO. Es la versión offline/optimista
  // de la regla "el primer entrenamiento del día otorga los puntos": el
  // servidor (RPC registrar_puntos_entrenamiento_alumno) es quien decide
  // de forma autoritativa y atómica en zona horaria Argentina — esto solo
  // se usa para no mostrarle al alumno una estimación de puntos que el
  // servidor casi seguro va a corregir a 0 apenas haya conexión.
  _yaHayEntrenamientoHoyLocal(alumnoId, fechaISO) {
    const diaCal = new Date(fechaISO);
    const y = diaCal.getFullYear(), m = diaCal.getMonth(), d = diaCal.getDate();
    return this.data.workoutLogs.some(w => {
      if (w.alumnoId !== alumnoId || w.estado !== 'completado') return false;
      const f = new Date(w.fecha);
      return f.getFullYear() === y && f.getMonth() === m && f.getDate() === d;
    });
  }

  // --- GUARDADO DE SESIÓN DE ENTRENAMIENTO REAL POR SERIES Y COMENTARIO GENERAL ---
  // Async: guarda localmente de forma optimista (para que la UI responda al
  // instante incluso sin red) y, si hay conexión, corrige puntos/racha con
  // el valor AUTORITATIVO que devuelve la RPC registrar_puntos_entrenamiento_alumno
  // (servidor decide, en zona horaria Argentina, si este es el primer
  // entrenamiento del día — la única fuente de verdad real ante múltiples
  // dispositivos compitiendo casi al mismo tiempo).
  async guardarEntrenamientoReal({ alumnoId, rutinaId, diaId, diaNombre, diaNumero, setsLog, comentarioGeneral = "" }) {
    // UUID nativo desde el inicio: mismo ID en localStorage y en Supabase
    const logId = (window.crypto && window.crypto.randomUUID)
      ? window.crypto.randomUUID()
      : ("log-" + Date.now());

    const fechaISO = new Date().toISOString();
    const alumno = this.getAlumnoPorId(alumnoId);

    // --- ESTIMACIÓN LOCAL (optimista, puede quedar sobreescrita por el servidor) ---
    const puntosBase = this.calcularPuntosSesion(setsLog);
    const esPrimerEntrenamientoDelDiaLocal = alumno ? !this._yaHayEntrenamientoHoyLocal(alumnoId, fechaISO) : false;
    let bonusRacha = 0;
    let puntosSesion = 0;
    if (alumno && esPrimerEntrenamientoDelDiaLocal) {
      bonusRacha = this.actualizarRachaYSumarPuntos(alumno, fechaISO, puntosBase);
      puntosSesion = puntosBase + bonusRacha;
    }

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
      sets: setsLog,
      puntos: puntosSesion,
      bonusRacha,
      puntosConfirmadosPorServidor: false
    };

    this.data.workoutLogs.unshift(nuevoLog);

    if (alumno) {
      this.crearNotificacion({
        destinatarioRol: "profesor",
        alumnoId: alumno.id,
        mensaje: `✅ ${alumno.nombre} completó su entrenamiento: ${diaNombre}.`,
        rutaDestino: "historial"
      });
    }

    this.saveData();

    // --- CONFIRMACIÓN AUTORITATIVA DEL SERVIDOR ---
    let resultadoPuntos = null;
    if (window.supabaseEngine) {
      await window.supabaseEngine.guardarWorkoutLogEnSupabase(nuevoLog);
      resultadoPuntos = await window.supabaseEngine.registrarPuntosEntrenamientoEnSupabase(logId, alumnoId);

      if (resultadoPuntos && resultadoPuntos.ok && alumno) {
        // El servidor manda: se pisa la estimación local (incluyendo el caso
        // "ya había otro entrenamiento hoy" → puntosGanados/bonusRacha en 0).
        nuevoLog.puntos = Number(resultadoPuntos.puntosGanados) || 0;
        nuevoLog.bonusRacha = Number(resultadoPuntos.bonusRacha) || 0;
        nuevoLog.puntosConfirmadosPorServidor = true;
        alumno.puntosTotal = Number(resultadoPuntos.puntosTotal) || 0;
        this.saveData();
      }
    }

    const yaHuboEntrenamientoHoy = (resultadoPuntos && resultadoPuntos.ok)
      ? !!resultadoPuntos.yaHuboEntrenamientoHoy
      : !esPrimerEntrenamientoDelDiaLocal;

    return { ...nuevoLog, yaHuboEntrenamientoHoy };
  }

  // --- EDITAR ENTRENAMIENTO YA GUARDADO (solo dentro de la ventana de 2hs) ---
  // No recalcula ni toca puntos: quedan fijados en el momento del primer
  // guardado, tal como se decidió para el sistema de puntos/ranking.
  async editarEntrenamientoReciente({ logId, alumnoId, setsLog, comentarioGeneral }) {
    const log = this.data.workoutLogs.find(w => w.id === logId);
    if (!log) throw new Error("Entrenamiento no encontrado.");
    if (log.alumnoId !== alumnoId) throw new Error("No tenés permiso para editar este entrenamiento.");
    if (!this.puedeEditarseEntrenamiento(log)) {
      throw new Error("Ya pasaron más de 2 horas desde que se guardó este entrenamiento, no se puede editar.");
    }

    if (window.supabaseEngine) {
      const resultado = await window.supabaseEngine.editarWorkoutLogSetsEnSupabase(logId, alumnoId, setsLog, comentarioGeneral);
      if (!resultado || resultado.ok !== true) {
        return { ok: false, error: (resultado && resultado.error) || 'error_desconocido' };
      }
    }

    log.sets = setsLog;
    if (comentarioGeneral !== undefined && comentarioGeneral !== null) {
      log.comentarioGeneral = comentarioGeneral;
    }
    this.saveData();
    return { ok: true, data: log };
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