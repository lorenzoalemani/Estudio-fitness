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
    // rankingCache vive SOLO en memoria: se puebla desde la RPC get_ranking_publico()
    // en cada sync y se elimina explícitamente antes de serializar a localStorage
    // (ver saveData()). Arrancar siempre desde [] para no servir datos rancios.
    this.data.rankingCache = [];
    this._syncSeq = 0; // Token de secuencia para descartar respuestas de sync fuera de orden
    this._authSyncSeq = 0; // Token de secuencia EXCLUSIVO de syncs con alumnoId (autenticadas).
    // Una sync sin alumnoId (más liviana, no trae rutinas) nunca debe poder
    // invalidar la respuesta de una sync CON alumnoId (la que sí trae rutinas),
    // aunque haya arrancado después y termine antes. Por eso se comparan por
    // separado: cada tipo de llamada solo puede ser "pisada" por otra de su mismo tipo.
    this._syncCounter = 0; // INSTRUMENTACIÓN TEMPORAL: contador de syncs
    this.listenSupabaseRealtime();
    this.checkExpirationsAndNotify();
  }

  loadData() {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        // rankingCache nunca debe venir de localStorage: contiene datos de
        // otros usuarios (nombres/puntos) que no deben persistir localmente.
        // Si llegara (por algún bug previo), se elimina de inmediato para que
        // el constructor lo reinicialice como [] y lo pueble desde la RPC.
        if (parsed.rankingCache !== undefined) delete parsed.rankingCache;
        
        // Normalizar localStorage antiguo: validar tipos y agregar propiedades faltantes
        // Preserve existing properties (including _formatoSeguro, sesionActual, etc.)
        const normalized = {
          ...parsed,
          // Validar que cada propiedad crítica sea un array válido
          // Si existe pero es de tipo inválido, usar el default correspondiente
          profesores: Array.isArray(parsed.profesores) ? parsed.profesores : DEFAULT_DATA.profesores,
          alumnos: Array.isArray(parsed.alumnos) ? parsed.alumnos : [],
          dnisAutorizados: Array.isArray(parsed.dnisAutorizados) ? parsed.dnisAutorizados : [],
          rutinas: Array.isArray(parsed.rutinas) ? parsed.rutinas : [],
          workoutLogs: Array.isArray(parsed.workoutLogs) ? parsed.workoutLogs : [],
          notificaciones: Array.isArray(parsed.notificaciones) ? parsed.notificaciones : []
        };
        
        // Log de migración solo si realmente hay cambios (propiedades faltantes o inválidas)
        const needsMigration = 
          !Array.isArray(parsed.profesores) ||
          !Array.isArray(parsed.alumnos) ||
          !Array.isArray(parsed.dnisAutorizados) ||
          !Array.isArray(parsed.rutinas) ||
          !Array.isArray(parsed.workoutLogs) ||
          !Array.isArray(parsed.notificaciones);
        
        if (needsMigration) {
          console.log("📋 localStorage normalizado: se completaron propiedades faltantes o inválidas");
        }
        
        return normalized;
      }
    } catch (e) {
      console.warn("Error LocalStorage:", e);
    }
    this.saveData(DEFAULT_DATA);
    return DEFAULT_DATA;
  }

  saveData(newData) {
    this.data = newData || this.data;
    try {
      // rankingCache contiene datos de otros usuarios (nombres/puntos del
      // ranking público) y no debe persistirse en localStorage. Se hace una
      // copia shallow excluyendo esa clave antes de serializar, para que
      // this.data.rankingCache siga vivo en memoria pero nunca llegue al disco.
      const { rankingCache: _omitido, ...toStore } = this.data;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(toStore));
    } catch (e) {
      console.error("Error guardando LocalStorage:", e);
    }
    window.dispatchEvent(new CustomEvent('gym_store_updated'));
  }

  async syncWithSupabase(alumnoId) {
    if (!window.supabaseEngine) return;
    // INSTRUMENTACIÓN TEMPORAL: SYNC START
    const syncId = ++this._syncCounter;
    const authSession = window.supabaseEngine?.client?.auth?.getSession ? 'checking...' : 'no client';
    console.log(`=== SYNC #${syncId} START ===`, {
      alumnoId: alumnoId ?? null,
      authSessionExists: 'check via getSession' // se verifica en FETCH RESULT
    });
    // FIN INSTRUMENTACIÓN

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

      // INSTRUMENTACIÓN TEMPORAL: SYNC FETCH RESULT
      let sessionExists = false;
      try {
        const { data: { session } } = await window.supabaseEngine.client.auth.getSession();
        sessionExists = !!session;
      } catch (e) { sessionExists = false; }
      console.log(`=== SYNC #${syncId} FETCH RESULT ===`, {
        alumnos: freshData?.alumnos?.length ?? 'null',
        profesores: freshData?.profesores?.length ?? 'null',
        ambosVacios: (freshData?.alumnos?.length === 0 && freshData?.profesores?.length === 0) ?? 'n/a',
        authSessionExists: sessionExists
      });
      // FIN INSTRUMENTACIÓN

      const isStale = isAuthSync
        ? (authRequestToken !== this._authSyncSeq)
        : (requestToken !== this._syncSeq);

      if (isStale) {
        console.log("⏭️ Descartando respuesta de sync obsoleta (fuera de orden).");
        return;
      }

      if (freshData) {
        let huboCambios = false;

        // --- GUARDIA: no confundir "vacío legítimo" con "RLS bloqueó todo" ---
        // El SELECT de `profiles` puede devolver `[]` sin error tanto cuando
        // "no hay ningún perfil" como cuando RLS bloqueó todo por falta de
        // sesión Auth activa (por ejemplo, justo después de un logout). Sin
        // esta guardia, ese `[]` reemplazaba this.data.alumnos/profesores por
        // arrays vacíos y el login dejaba de encontrar cualquier perfil.
        //
        // IMPORTANTE: NO se usa authGetSession() para esto. authGetSession()
        // devuelve null también en el flujo normal de login (login() llama a
        // syncWithSupabase() ANTES de authSignIn()), así que usarlo como
        // condición bloqueaba incluso el primer login legítimo de una app
        // recién abierta, sin haber sesión Auth todavía.
        //
        // Heurística en su lugar: en este sistema siempre existe al menos un
        // profesor (OCTAVIO_ID, ver DEFAULT_DATA), así que un snapshot real de
        // Supabase JAMÁS trae alumnos Y profesores vacíos al mismo tiempo. Si
        // eso ocurre, es la señal de que RLS filtró todo por falta de sesión
        // (o por algún corte de red parcial) y no debe usarse para podar el
        // estado local. Si viene CUALQUIER dato (alumnos o profesores no
        // vacíos), se reconcilia normalmente, haya o no sesión Auth activa.
        const ambosVaciosSimultaneamente =
          freshData.alumnos !== null && freshData.profesores !== null &&
          freshData.alumnos.length === 0 && freshData.profesores.length === 0;
        if (ambosVaciosSimultaneamente) {
          console.log('⏭️ [sync] profiles trajo alumnos Y profesores vacíos a la vez (posible RLS sin sesión) → NO se reconcilian this.data.alumnos/this.data.profesores, se preserva el estado local.');
        }

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
        if (freshData.alumnos !== null && ambosVaciosSimultaneamente) {
          // no reconciliar — ver guardia arriba
        } else if (freshData.alumnos !== null) {
          this.data.alumnos = freshData.alumnos.map(sbAlumno => {
            const loc = this.data.alumnos.find(a => a.dni === sbAlumno.dni || a.id === sbAlumno.id);
            if (!loc) return sbAlumno;

            // authUserId resuelto: Supabase es la fuente de verdad si lo tiene;
            // si no lo tiene, se conserva el valor local.
            const resolvedAuthUserId = sbAlumno.authUserId !== undefined
              ? sbAlumno.authUserId
              : loc.authUserId;

            const merged = {
              ...loc,
              ...sbAlumno,
              authUserId: resolvedAuthUserId,
              rutinaActivaId: sbAlumno.rutinaActivaId || loc.rutinaActivaId,
              puntosTotal: sbAlumno.puntosTotal !== undefined ? sbAlumno.puntosTotal : loc.puntosTotal,
              rachaSemanal: sbAlumno.rachaSemanal !== undefined ? sbAlumno.rachaSemanal : loc.rachaSemanal
            };

            // PRESERVACIÓN DE PASSWORD LEGACY (siempre, con o sin authUserId):
            // borrarlo cuando existe auth_user_id (introducido en 6f49015) dejó
            // sin red de seguridad a las cuentas cuyo usuario Auth fue creado
            // con el formato de email viejo (pre-9c96ff6): authSignIn fallaba
            // con invalid_credentials y el fallback legacy ya no tenía password.
            // El password local no interfiere con el login normal (mientras
            // authSignIn tenga éxito, el fallback ni se evalúa) y solo se
            // elimina en _intentarMigracionLegacy() tras confirmar Auth+RPC.
            merged.password = loc.password !== undefined ? loc.password : undefined;
            if (merged.password === undefined) {
              delete merged.password;
            }

            return merged;
          });
          huboCambios = true;
        }

        // PROFESORES: antes NO se sincronizaba nunca (freshData.profesores se
        // calculaba en supabase.js pero jamás se leía acá), por lo que un
        // profesor eliminado en Supabase seguía viviendo para siempre en
        // localStorage y podía loguearse con esas credenciales. Mismo
        // criterio de reconciliación completa que alumnos.
        if (freshData.profesores !== null && ambosVaciosSimultaneamente) {
          // no reconciliar — ver guardia arriba
        } else if (freshData.profesores !== null) {
          this.data.profesores = freshData.profesores.map(sbProfesor => {
            const loc = this.data.profesores.find(p => p.dni === sbProfesor.dni || p.id === sbProfesor.id);
            if (!loc) return sbProfesor;

            const resolvedAuthUserId = sbProfesor.authUserId !== undefined
              ? sbProfesor.authUserId
              : loc.authUserId;

            const merged = {
              ...loc,
              ...sbProfesor,
              authUserId: resolvedAuthUserId
            };

            // PRESERVACIÓN DE PASSWORD LEGACY (siempre, con o sin authUserId):
            // mismo criterio que alumnos. Incluye conservar "octagym2000" en
            // localStorage aunque el profesor ya esté vinculado: borrarlo aquí
            // (6f49015) eliminaba la única vía de entrada si el usuario Auth
            // vinculado no responde al email generado actual.
            merged.password = loc.password !== undefined ? loc.password : undefined;
            if (merged.password === undefined) {
              delete merged.password;
            }

            return merged;
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

        // Ranking: se actualiza en cada sync exitosa (con o sin cambios de
        // negocio), porque cualquier sync puede ocurrir tras un nuevo entrenamiento
        // de cualquier otro alumno. La RPC get_ranking_publico() (SECURITY DEFINER)
        // ignora RLS y devuelve solo las 5 columnas públicas. Si falla (offline,
        // usuario no authenticated, etc.) se conserva el rankingCache anterior
        // sin alterar nada — el ranking simplemente queda con los datos del
        // último sync exitoso.
        if (window.supabaseEngine) {
          const rankingFresco = await window.supabaseEngine.fetchRankingPublico();
          if (rankingFresco && rankingFresco.ok) {
            this.data.rankingCache = rankingFresco.data || [];
            console.log(`🏆 Ranking actualizado: ${this.data.rankingCache.length} alumno(s).`);
          }
        }
      }
    } catch (err) {
      console.warn("⚠️ Error en syncWithSupabase:", err);
    }
    // INSTRUMENTACIÓN TEMPORAL: SYNC END
    console.log(`=== SYNC #${syncId} END ===`, {
      alumnosFinal: this.data.alumnos?.length ?? 0,
      profesoresFinal: this.data.profesores?.length ?? 0
    });
    // FIN INSTRUMENTACIÓN
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

  // --- REFETCH FORZADO DEL RANKING (tras registrar puntos de un entrenamiento) ---
  // Más liviano que forceRefreshRutinas()/syncWithSupabase(): solo llama a la
  // RPC pública get_ranking_publico() y repuebla rankingCache, sin tocar
  // alumnos, rutinas ni el resto del estado. Se usa inmediatamente después de
  // que el servidor confirma puntos en guardarEntrenamientoReal(), para que
  // el ranking los refleje sin esperar al próximo visibilitychange/sync
  // completo. Si falla (offline, etc.) conserva el rankingCache anterior.
  async forceRefreshRanking() {
    if (!window.supabaseEngine) {
      console.warn("⚠️ forceRefreshRanking: No hay supabaseEngine disponible");
      return;
    }
    try {
      console.log("🔄 forceRefreshRanking: Consultando ranking fresco desde Supabase...");
      const rankingFresco = await window.supabaseEngine.fetchRankingPublico();
      
      if (rankingFresco && rankingFresco.ok) {
        this.data.rankingCache = rankingFresco.data || [];
        console.log(`✅ forceRefreshRanking: Ranking actualizado correctamente con ${this.data.rankingCache.length} alumno(s).`);
      } else {
        console.warn("❌ forceRefreshRanking: fetchRankingPublico retornó error:", rankingFresco?.error);
      }
    } catch (err) {
      console.error("❌ forceRefreshRanking: Excepción al actualizar ranking:", err);
    }
  }

  // --- AUTENTICACIÓN Y AUTORIZACIÓN POR DNI ---
  // Async a propósito: la secuencia deseada es (1) sincronizar con Supabase,
  // (2) actualizar el estado local, (3) recién ahí validar credenciales.
  //
  // --- SUPABASE AUTH (Etapa 1) ---
  // Después de identificar el rol por DNI, se intenta authSignIn contra
  // Supabase Auth. Si tiene éxito, se registra el authUserId en el perfil
  // local y se llama a la RPC de vinculación para persistirlo en la DB.
  // Si Supabase Auth falla (cuenta todavía no creada), se cae al flujo
  // legacy de validación por contraseña, que sigue intacto.
  // La contraseña legacy NUNCA se borra en esta etapa.
  //
  // syncWithSupabase() nunca rechaza (atrapa sus propios errores) y no hace
  // nada si no hay window.supabaseEngine (offline/no inicializado), así que
  // este await no puede trabar el login ni romper el funcionamiento offline.
  async login(dni, password) {
    const cleanDni = String(dni).trim();
    const cleanPass = String(password).trim();

    // --- INSTRUMENTACIÓN TEMPORAL: LOGIN START ---
    const alumnoPreSync = this.data.alumnos?.find(a => a.dni === cleanDni);
    const profesorPreSync = this.data.profesores?.find(p => p.dni === cleanDni);
    console.log('=== LOGIN START ===', {
      dni: cleanDni,
      alumnosCount: this.data.alumnos?.length ?? 0,
      profesoresCount: this.data.profesores?.length ?? 0,
      alumnoPerfil: alumnoPreSync ? {
        existe: true,
        authUserId: alumnoPreSync.authUserId ?? null,
        hasPassword: 'password' in alumnoPreSync && alumnoPreSync.password !== undefined
      } : { existe: false },
      profesorPerfil: profesorPreSync ? {
        existe: true,
        authUserId: profesorPreSync.authUserId ?? null,
        hasPassword: 'password' in profesorPreSync && profesorPreSync.password !== undefined
      } : { existe: false }
    });
    // --- FIN INSTRUMENTACIÓN ---

    // 1. Sincronizar con Supabase y esperar a que termine.
    await this.syncWithSupabase();

    // --- INSTRUMENTACIÓN TEMPORAL: SYNC RESULT ---
    const alumnoPostSync = this.data.alumnos?.find(a => a.dni === cleanDni);
    const profesorPostSync = this.data.profesores?.find(p => p.dni === cleanDni);
    console.log('=== SYNC RESULT ===', {
      freshDataAlumnos: 'ver syncWithSupabase logs',
      freshDataProfesores: 'ver syncWithSupabase logs',
      ambosVacios: 'ver syncWithSupabase logs',
      alumnoEncontrado: alumnoPostSync ? {
        existe: true,
        authUserId: alumnoPostSync.authUserId ?? null,
        hasPassword: 'password' in alumnoPostSync && alumnoPostSync.password !== undefined
      } : { existe: false },
      profesorEncontrado: profesorPostSync ? {
        existe: true,
        authUserId: profesorPostSync.authUserId ?? null,
        hasPassword: 'password' in profesorPostSync && profesorPostSync.password !== undefined
      } : { existe: false }
    });
    // --- FIN INSTRUMENTACIÓN ---

    // 2. Detectar rol por DNI (necesario para generar el email interno de Auth).
    const profesor = this.data.profesores.find(p => p.dni === cleanDni);
    const alumno   = this.data.alumnos.find(a => a.dni === cleanDni);

    // 3. Intentar Supabase Auth si hay motor disponible y el rol es conocido.
    //    El resultado de Supabase Auth NO reemplaza la validación de contraseña
    //    legacy en esta etapa: solo agrega el authUserId al perfil.
    const engine = window.supabaseEngine;
    if (engine && (profesor || alumno)) {
      const rol = profesor ? 'profesor' : 'alumno';
      const perfil = profesor || alumno;

      // --- INSTRUMENTACIÓN TEMPORAL: AUTH SIGNIN START ---
      console.log('=== AUTH SIGNIN START ===', {
        rol,
        perfilEncontrado: perfil ? {
          existe: true,
          authUserId: perfil.authUserId ?? null,
          hasPassword: 'password' in perfil && perfil.password !== undefined
        } : { existe: false }
      });
      // --- FIN INSTRUMENTACIÓN ---

      const authRes = await engine.authSignIn(cleanDni, rol, cleanPass);

      // --- INSTRUMENTACIÓN TEMPORAL: AUTH SIGNIN RESULT ---
      console.log('=== AUTH SIGNIN RESULT ===', {
        ok: authRes.ok,
        errorCode: authRes.error?.code ?? authRes.error ?? null,
        errorMessage: authRes.error?.message ?? authRes.error ?? null,
        errorStatus: authRes.error?.status ?? null
      });
      // --- FIN INSTRUMENTACIÓN ---

      if (authRes.ok && authRes.user) {
        // Supabase Auth validó la contraseña correctamente.
        const authUserId = authRes.user.id;
        console.log(`🔑 Supabase Auth OK (${rol} ${cleanDni}) → authUserId: ${authUserId}`);

        // Persistir authUserId en el perfil local si no lo tenía ya.
        if (!perfil.authUserId) {
          perfil.authUserId = authUserId;
          this.saveData();

          // Vincular en la DB (fire-and-forget: si falla, el perfil local ya
          // tiene el authUserId y la próxima sync lo re-intentará via RPC).
          // authUserId localmente se usa para sesión, pero las RPCs usan auth.uid() interno.
          if (rol === 'profesor') {
            engine.vincularPerfilProfesor(cleanDni)
              .then(r => { if (!r.ok) console.warn('⚠️ vincularPerfilProfesor falló (no crítico):', r.error); });
          } else {
            engine.vincularPerfilAlumno(cleanDni, perfil.telefono || '')
              .then(r => { if (!r.ok) console.warn('⚠️ vincularPerfilAlumno falló (no crítico):', r.error); });
          }
        }

        // Retornar sesión usando el perfil local ya actualizado (que tiene
        // la contraseña legacy intacta).
        if (profesor) {
          console.log('=== LOGIN END ===', { success: true, rol: 'profesor', error: null });
          return { rol: 'profesor', data: perfil };
        }
        if (alumno) {
          console.log('=== LOGIN END ===', { success: true, rol: 'alumno', error: null });
          return { rol: 'alumno', data: perfil };
        }
      }
      // authSignIn devolvió ok:false → la cuenta Supabase Auth todavía no
      // existe o la contraseña no coincide. Caemos al flujo legacy.
      console.log(`ℹ️ authSignIn no tuvo éxito para ${rol} ${cleanDni} → usando flujo legacy.`);
    }

    // --- INSTRUMENTACIÓN TEMPORAL: LEGACY FALLBACK ---
    const profesorLegacyCheck = this.data.profesores.find(p => p.dni === cleanDni);
    const alumnoLegacyCheck = this.data.alumnos.find(a => a.dni === cleanDni);
    console.log('=== LEGACY FALLBACK ===', {
      profesorEncontrado: profesorLegacyCheck ? {
        existe: true,
        hasPassword: 'password' in profesorLegacyCheck && profesorLegacyCheck.password !== undefined
      } : { existe: false },
      alumnoEncontrado: alumnoLegacyCheck ? {
        existe: true,
        hasPassword: 'password' in alumnoLegacyCheck && alumnoLegacyCheck.password !== undefined
      } : { existe: false },
      legacyResult: 'pending'
    });
    // --- FIN INSTRUMENTACIÓN ---

    // 4. Flujo legacy intacto — validación por DNI + contraseña en local.
    // Si el usuario valida por legacy (cuenta Auth todavía no creada), se
    // intenta la migración automática a Supabase Auth en este mismo instante.
    // La contraseña solo existe en memoria durante esta función: nunca se
    // imprime, nunca se escribe en un log, nunca se persiste de nuevo.

    // 4a. Buscar en Profesores
    const profesorLegacy = this.data.profesores.find(p => p.dni === cleanDni && p.password === cleanPass);
    if (profesorLegacy) {
      // Migración automática: intentar crear cuenta Auth con la contraseña que
      // el usuario acaba de tipear (está en memoria, nunca se guarda de nuevo).
      if (engine) {
        this._intentarMigracionLegacy(profesorLegacy, 'profesor', cleanDni, cleanPass, engine);
      }
      console.log('=== LOGIN END ===', { success: true, rol: 'profesor', error: null });
      return { rol: 'profesor', data: profesorLegacy };
    }

    // 4b. Buscar en Alumnos
    const alumnoLegacy = this.data.alumnos.find(a => a.dni === cleanDni && a.password !== null && a.password === cleanPass);
    if (alumnoLegacy) {
      if (engine) {
        this._intentarMigracionLegacy(alumnoLegacy, 'alumno', cleanDni, cleanPass, engine);
      }
      console.log('=== LOGIN END ===', { success: true, rol: 'alumno', error: null });
      return { rol: 'alumno', data: alumnoLegacy };
    }

    // --- INSTRUMENTACIÓN TEMPORAL: LOGIN END ---
    console.log('=== LOGIN END ===', {
      success: false,
      rol: null,
      error: 'No se encontró perfil válido (ni Auth ni legacy)'
    });
    // --- FIN INSTRUMENTACIÓN ---

    return null;
  }

  // --- LOGIN POR DNI — flujo mínimo (sesión real de Supabase Auth) ---
  // Delega la autenticación en engine.loginConDni() (generateLink +
  // verifyOtp) y luego reutiliza syncWithSupabase() sin modificarla para
  // repoblar this.data.alumnos/profesores con los objetos locales de
  // siempre. Devuelve la MISMA forma { rol, data } que login(), para que
  // el resto de app.js (asignación de sesión, sync de rutinas, etc.)
  // funcione sin cambios.
  // No toca login(), _intentarMigracionLegacy() ni el flujo legacy.
  async loginConDni(dni) {
    const cleanDni = String(dni).trim();
    const engine = window.supabaseEngine;
    if (!engine) {
      console.warn('⚠️ loginConDni: supabaseEngine no disponible.');
      return null;
    }

    const authRes = await engine.loginConDni(cleanDni);
    if (!authRes.ok) {
      console.warn('⚠️ loginConDni (DataManager): falló en engine:', authRes.error);
      return null;
    }

    // Repoblar this.data.alumnos/profesores ya con la sesión activa.
    await this.syncWithSupabase();

    if (authRes.rol === 'profesor') {
      const profesor = this.data.profesores.find(p => p.dni === cleanDni);
      if (!profesor) {
        console.warn('⚠️ loginConDni: autenticado pero no se encontró el profesor localmente tras sync.');
        return null;
      }
      return { rol: 'profesor', data: profesor };
    }

    const alumno = this.data.alumnos.find(a => a.dni === cleanDni);
    if (!alumno) {
      console.warn('⚠️ loginConDni: autenticado pero no se encontró el alumno localmente tras sync.');
      return null;
    }
    return { rol: 'alumno', data: alumno };
  }

  // Migración automática de usuario legacy a Supabase Auth.
  // Se llama en background (fire-and-forget desde login()) cuando un usuario
  // entra por fallback legacy. La contraseña solo vive en esta función.
  // Si TODA la cadena tiene éxito, elimina el password del objeto local.
  // Si CUALQUIER paso falla, el password se preserva y el usuario puede
  // seguir usando el fallback en el próximo login.
  // NUNCA imprime la contraseña en ningún log.
  async _intentarMigracionLegacy(perfil, rol, dni, password, engine) {
    try {
      console.log(`🔄 Iniciando migración legacy → Supabase Auth para ${rol} ${dni}`);

      // 1. Crear cuenta en Supabase Auth
      const authRes = await engine.authSignUp(dni, rol, password);
      if (!authRes.ok || !authRes.user) {
        console.log(`ℹ️ Migración legacy: authSignUp no OK para ${rol} ${dni}:`, authRes.error);
        return; // Preservar password legacy — no se migra en este intento
      }

      // 2. Vincular perfil en la DB via RPC
      let linkRes;
      if (rol === 'profesor') {
        linkRes = await engine.vincularPerfilProfesor(dni);
      } else {
        linkRes = await engine.vincularPerfilAlumno(dni, perfil.telefono || '');
      }

      if (!linkRes.ok) {
        console.warn(`⚠️ Migración legacy: vincular${rol === 'profesor' ? 'Profesor' : 'Alumno'} falló para ${dni}:`, linkRes.error);
        return; // No eliminar password — la migración no se completó
      }

      // 3. Éxito total: confirmar authUserId y eliminar password del localStorage
      const authUserId = authRes.user.id;
      perfil.authUserId = authUserId;
      // Eliminar el password del objeto local: la contraseña ya vive en Supabase Auth
      delete perfil.password;
      this.saveData();

      console.log(`✅ Migración legacy completa para ${rol} ${dni} → authUserId: ${authUserId}. Password eliminado del localStorage.`);
    } catch (e) {
      console.warn(`⚠️ Excepción en migración legacy para ${rol} ${dni} (no crítico — password preservado):`, e);
    }
  }

  // ETAPA 2 — registrarseAlumno: Supabase Auth es la fuente de autenticación.
  // La contraseña solo vive en memoria durante esta función. Nunca se imprime.
  // Si Auth+RPC tienen éxito: se guarda authUserId, sin password en localStorage.
  // Si Auth falla (offline, error): se guarda password temporalmente como fallback
  // legacy para que el usuario pueda entrar. La migración se completará en el
  // próximo login exitoso via _intentarMigracionLegacy().
  async registrarseAlumno({ dni, password, nombre, telefono }) {
    const cleanDni = String(dni).trim();
    const cleanPass = String(password).trim();

    // Validación de longitud de contraseña
    if (cleanPass.length < 2) {
      throw new Error('La contraseña debe tener al menos 2 caracteres.');
    }
    if (cleanPass.length > 128) {
      throw new Error('La contraseña es demasiado larga (máximo 128 caracteres).');
    }

    const existente = this.data.alumnos.find(a => a.dni === cleanDni);

    if (existente) {
      // Caso B: alumno precreado por el profesor.
      // Nuevo criterio: no tiene authUserId Y no tiene password (registro incompleto).
      // Un alumno con authUserId ya está migrado; con password ya completó el registro.
      if (!existente.authUserId && existente.password === null) {
        existente.nombre = nombre.trim();
        existente.telefono = telefono ? telefono.trim() : (existente.telefono || "");
        // NO guardar password en el objeto todavía — solo en memoria (cleanPass).

        // Persistir perfil en Supabase DB sin password (columna no existe).
        if (window.supabaseEngine) {
          window.supabaseEngine.registrarPerfilEnSupabase(existente);
        }

        console.log('REGISTER DEBUG supabaseEngine:', !!window.supabaseEngine);
        console.log('REGISTER DEBUG client:', !!window.supabaseEngine?.client);

        let authExitoso = false;
        if (window.supabaseEngine) {
          try {
            // 1. Verificar datos (DNI + Teléfono) antes de Auth
            const verifyRes = await window.supabaseEngine.verificarDatosActivacionAlumno(cleanDni, telefono);
            if (verifyRes.ok) {
              // 2. Crear Auth user (contraseña solo en memoria, nunca se guarda)
              const authRes = await window.supabaseEngine.authSignUp(cleanDni, 'alumno', cleanPass);
              if (authRes.ok && authRes.user) {
                // 3. Vincular perfil (AWAIT)
                const linkRes = await window.supabaseEngine.vincularPerfilAlumno(cleanDni, existente.telefono || '');
                if (linkRes.ok) {
                  // 4. Éxito total: guardar authUserId SIN password
                  existente.authUserId = authRes.user.id;
                  authExitoso = true;
                  console.log('✅ Registro Auth OK (caso B precreado) → authUserId:', authRes.user.id, '| password NO guardado en localStorage.');
                } else {
                  console.warn('⚠️ Registro: authSignUp OK pero vincularPerfilAlumno (caso B) falló:', linkRes.error);
                }
              } else {
                console.log('ℹ️ Registro: authSignUp no OK (caso B):', authRes.error);
              }
            } else {
              console.log('ℹ️ Registro: verificarDatosActivacionAlumno falló (caso B):', verifyRes.error);
            }
          } catch (e) {
            console.warn('⚠️ Registro: excepción en Auth (caso B, no crítico):', e);
          }
        }

        if (!authExitoso) {
          // Fallback: guardar password temporalmente para que el usuario pueda entrar.
          // Se migrará automáticamente en el próximo login exitoso.
          existente.password = cleanPass;
          console.log('ℹ️ Registro: Auth no disponible — password guardado temporalmente como fallback legacy.');
        }

        this.saveData();
        return existente;
      }

      // El alumno ya tiene authUserId o ya tiene password → ya completó su registro.
      if (existente.authUserId) {
        throw new Error("Esta cuenta ya fue activada. Usá el inicio de sesión.");
      }
      throw new Error("Ya existe una cuenta creada con ese DNI.");
    }

    // Caso A: DNI nuevo.
    const estaAutorizado = this.data.dnisAutorizados.some(d => d.dni === cleanDni);
    const generatedId = (window.crypto && window.crypto.randomUUID) ? window.crypto.randomUUID() : ("al-" + Date.now());

    // NO incluir password en el objeto — solo en memoria durante authSignUp.
    const nuevoAlumno = {
      id: generatedId,
      dni: cleanDni,
      nombre: nombre.trim(),
      telefono: telefono ? telefono.trim() : "",
      estadoAutorizacion: estaAutorizado ? 'autorizado' : 'pendiente',
      fechaRegistro: new Date().toISOString().split('T')[0],
      rutinaActivaId: null
    };

    this.data.alumnos.push(nuevoAlumno);

    // Persistir nuevo perfil en Supabase DB (sin password)
    if (window.supabaseEngine) {
      window.supabaseEngine.registrarPerfilEnSupabase(nuevoAlumno);
    }

    console.log('REGISTER DEBUG supabaseEngine:', !!window.supabaseEngine);
    console.log('REGISTER DEBUG client:', !!window.supabaseEngine?.client);

    let authExitosoA = false;
    if (window.supabaseEngine) {
      try {
        const authRes = await window.supabaseEngine.authSignUp(cleanDni, 'alumno', cleanPass);
        if (authRes.ok && authRes.user) {
          const linkRes = await window.supabaseEngine.vincularPerfilAlumno(cleanDni, nuevoAlumno.telefono || '');
          if (linkRes.ok) {
            nuevoAlumno.authUserId = authRes.user.id;
            authExitosoA = true;
            console.log('✅ Registro Auth OK (caso A nuevo) → authUserId:', authRes.user.id, '| password NO guardado en localStorage.');
          } else {
            console.warn('⚠️ Registro: authSignUp OK pero vincularPerfilAlumno (caso A) falló:', linkRes.error);
          }
        } else {
          console.log('ℹ️ Registro: authSignUp no OK (caso A):', authRes.error);
        }
      } catch (e) {
        console.warn('⚠️ Registro: excepción en Auth (caso A, no crítico):', e);
      }
    }

    if (!authExitosoA) {
      // Fallback: guardar password temporalmente para que el usuario pueda entrar.
      // Se migrará automáticamente en el próximo login exitoso.
      nuevoAlumno.password = cleanPass;
      console.log('ℹ️ Registro: Auth no disponible — password guardado temporalmente como fallback legacy.');
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
      // NUNCA pisar el nombre real (profiles.nombre / alumno.nombre): el
      // texto que tipeó el profesor acá es su apodo/etiqueta personal.
      alumno.nombreProfesor = nombre.trim();
    } else {
      const newId = (window.crypto && window.crypto.randomUUID) ? window.crypto.randomUUID() : ("al-" + Date.now());
      alumno = {
        id: newId,
        dni: cleanDni,
        password: null,
        // Todavía no existe fila en profiles (el alumno no se registró): se
        // usa el texto del profesor como placeholder de nombre real hasta que
        // el alumno se registre y el próximo sync traiga profiles.nombre.
        nombre: nombre.trim(),
        nombreProfesor: nombre.trim(),
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

  // --- EDITAR NOMBRE PERSONALIZADO DEL PROFESOR (apodo, vía RPC segura) ---
  // Actualiza ÚNICAMENTE authorized_dnis.nombre (el apodo con el que el
  // profesor identifica al alumno en SU interfaz). NUNCA toca profiles.nombre
  // (nombre real de la cuenta, que el alumno sigue viendo intacto).
  async editarNombreProfesor({ dni, nuevoNombre }) {
    const cleanDni = String(dni).trim();
    const cleanNombre = String(nuevoNombre).trim();
    if (!cleanNombre) {
      throw new Error("El apodo no puede estar vacío.");
    }
    if (!window.supabaseEngine) {
      throw new Error("Sin conexión a Supabase: no se pudo guardar el apodo.");
    }

    const resultado = await window.supabaseEngine.editarNombreProfesor(cleanDni, cleanNombre);
    if (!resultado || resultado.ok !== true) {
      throw new Error((resultado && resultado.error) || "No se pudo actualizar el apodo.");
    }

    // Reflejar el cambio localmente recién DESPUÉS de que Supabase confirmó éxito.
    const alumno = this.data.alumnos.find(a => a.dni === cleanDni);
    if (alumno) {
      alumno.nombreProfesor = cleanNombre;
    }
    const dniAuth = this.data.dnisAutorizados.find(d => d.dni === cleanDni);
    if (dniAuth) {
      dniAuth.nombre = cleanNombre;
    } else {
      this.data.dnisAutorizados.push({ dni: cleanDni, nombre: cleanNombre });
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
    console.log("🔎 DEBUG crearOActualizarRutina - recibió:", {
    alumnoId
});
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

    console.log("🔎 DEBUG ANTES PERSISTIR:", {
        nuevaRutinaAlumnoId: nuevaRutina.alumnoId,
        nuevaRutina: nuevaRutina
    });

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
  // Las rutinas propias SÍ se persisten en Supabase (tabla routines, con
  // profesor_id = NULL), pero por una vía separada de la del profesor:
  // las RPCs guardar_rutina_propia_alumno / eliminar_rutina_propia_alumno
  // (SECURITY DEFINER) validan la identidad del alumno vía auth.uid() en
  // vez de depender de window._sessionProfesorId (que el alumno no tiene).
  // Mismo patrón de "esperar confirmación real del servidor y revertir en
  // memoria si falla" que usa editarRutinaExistente para rutinas de profesor.
  async crearRutinaPropia({ alumnoId, titulo, duracionDias, dias }) {
    const alumno = this.getAlumnoPorId(alumnoId);
    if (!alumno) throw new Error("Alumno no encontrado.");

    const hoy = new Date();
    const fechaVenc = new Date(hoy.getTime() + Number(duracionDias) * 86400000);
    const routineUuid = (window.crypto && window.crypto.randomUUID) ? window.crypto.randomUUID() : ("rutp-" + Date.now());

    const nuevaRutina = {
      id: routineUuid,
      alumnoId,
      // Rutina propia del alumno: nunca tiene profesor asociado en Supabase.
      profesorId: null,
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

    if (window.supabaseEngine) {
      const resultado = await window.supabaseEngine.persistirRutinaPropiaEnSupabase(nuevaRutina);

      if (!resultado || resultado.ok !== true) {
        throw new Error(
          (resultado && resultado.error) || "No se pudo guardar la rutina en Supabase."
        );
      }

      console.log("✅ Rutina propia guardada en Supabase:", resultado);
    }

    this.data.rutinas.push(nuevaRutina);
    this.saveData();
    return nuevaRutina;
  }

  async editarRutinaPropia({ rutinaId, alumnoId, titulo, duracionDias, dias }) {
    const rutina = this.getRutinaPorId(rutinaId);
    if (!rutina || !rutina.esPropia || rutina.alumnoCreadorId !== alumnoId) {
      throw new Error("No tenés permiso para editar esta rutina.");
    }

    // Guardamos los valores originales antes de mutar, para poder revertir
    // en memoria si Supabase rechaza el guardado (mismo patrón que
    // editarRutinaExistente para rutinas de profesor).
    const original = {
      titulo: rutina.titulo,
      duracionDias: rutina.duracionDias,
      fechaVencimiento: rutina.fechaVencimiento,
      dias: rutina.dias
    };

    rutina.titulo = titulo || rutina.titulo;
    rutina.duracionDias = Number(duracionDias) || rutina.duracionDias;
    const fInicio = rutina.fechaInicio ? new Date(rutina.fechaInicio) : new Date();
    rutina.fechaVencimiento = new Date(fInicio.getTime() + Number(rutina.duracionDias) * 86400000).toISOString().split('T')[0];
    rutina.dias = dias;

    if (window.supabaseEngine) {
      const resultado = await window.supabaseEngine.persistirRutinaPropiaEnSupabase(rutina);

      if (!resultado || resultado.ok !== true) {
        // Revertir: la persistencia falló, no dejamos "confirmado" en memoria
        // algo que el servidor no aceptó.
        rutina.titulo = original.titulo;
        rutina.duracionDias = original.duracionDias;
        rutina.fechaVencimiento = original.fechaVencimiento;
        rutina.dias = original.dias;
        return { ok: false, error: (resultado && resultado.error) || 'error_desconocido' };
      }
    }

    this.saveData();
    return { ok: true, data: rutina };
  }

  async eliminarRutinaPropia(rutinaId, alumnoId) {
    const idx = this.data.rutinas.findIndex(r => r.id === rutinaId);
    if (idx === -1) throw new Error("Rutina no encontrada.");
    const rutina = this.data.rutinas[idx];
    if (!rutina.esPropia || rutina.alumnoCreadorId !== alumnoId) {
      throw new Error("No tenés permiso para eliminar esta rutina.");
    }

    // Confirmar eliminación en Supabase PRIMERO; recién si el servidor
    // confirma, se elimina localmente. Si falla, la rutina queda intacta.
    if (window.supabaseEngine) {
      const resultado = await window.supabaseEngine.eliminarRutinaPropiaEnSupabase(rutinaId, alumnoId);
      if (!resultado || resultado.ok !== true) {
        return { ok: false, error: (resultado && resultado.error) || 'error_desconocido' };
      }
    }

    this.data.rutinas.splice(idx, 1);
    const alumno = this.getAlumnoPorId(alumnoId);
    if (alumno && alumno.rutinaActivaId === rutinaId) alumno.rutinaActivaId = null;
    this.saveData();
    return { ok: true };
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

  // --- RANKING PÚBLICO (fuente: RPC get_ranking_publico vía Supabase) ---
  // rankingCache se puebla en cada syncWithSupabase() y vive SOLO en memoria
  // — nunca se serializa a localStorage (ver saveData() y loadData()).
  // Los datos vienen de la RPC (SECURITY DEFINER, ignora RLS) y contienen
  // únicamente las 5 columnas públicas: id, nombre, puntos_total,
  // racha_semanas, racha_ultima_semana. Sin DNI, teléfono ni datos privados.
  // La conversión snake_case → camelCase es necesaria porque renderRankingView()
  // en app.js espera puntosTotal / rachaSemanal.semanas / rachaSemanal.ultimaSemana.
  getRanking() {
    if (!this.data.rankingCache || this.data.rankingCache.length === 0) {
      return [];
    }
    return this.data.rankingCache.map((r, idx) => ({
      id: r.id,
      nombre: r.nombre,
      puntosTotal: Number(r.puntos_total) || 0,
      rachaSemanal: (r.racha_semanas || r.racha_ultima_semana)
        ? { semanas: Number(r.racha_semanas) || 0, ultimaSemana: r.racha_ultima_semana || null }
        : undefined,
      posicion: idx + 1
    }));
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
        // Refresca el ranking en memoria para que el puntaje recién ganado
        // se vea de inmediato, sin esperar al próximo visibilitychange/sync.
        await this.forceRefreshRanking();
        
        // Fuerza el re-renderizado de la UI con el ranking actualizado
        if (typeof window.renderApp === 'function') {
          console.log("🎨 guardarEntrenamientoReal: Re-renderizando UI con ranking actualizado...");
          window.renderApp();
        }
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