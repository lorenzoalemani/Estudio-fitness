// LÓGICA DE APLICACIÓN v4 - ESTUDIO FITNESS (WORKOUT LOGGER & WEB PUSH REAL)

// --- INSTALACIÓN DE PWA (banner "Instalar aplicación" vía beforeinstallprompt) ---
// Se define FUERA del DOMContentLoaded, en el nivel superior del script,
// para no perder el evento si el navegador lo dispara antes de que termine
// de cargar el resto de la página (puede pasar). No toca el registro del
// Service Worker (eso sigue exactamente igual, más abajo) ni ningún otro
// flujo: solo guarda el evento para poder dispararlo cuando el usuario
// toque el botón.
const INSTALL_DISMISS_KEY = 'estudio_fitness_install_dismissed_at';
const INSTALL_DISMISS_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000; // 7 días

window.deferredInstallPrompt = null;

// display-mode:standalone cubre Android/Chrome/Edge/Desktop una vez instalada;
// navigator.standalone es el equivalente legado de iOS Safari cuando la PWA
// se agregó a la pantalla de inicio manualmente (ahí nunca va a existir
// beforeinstallprompt, pero si ya está instalada tampoco hay que ofrecer nada).
function estudioFitnessPwaYaInstalada() {
  return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches)
      || window.navigator.standalone === true;
}

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault(); // evita el mini-banner nativo automático; lo mostramos nosotros
  window.deferredInstallPrompt = e;
  if (typeof window.renderApp === 'function') window.renderApp();
});

window.addEventListener('appinstalled', () => {
  window.deferredInstallPrompt = null;
  try { localStorage.removeItem(INSTALL_DISMISS_KEY); } catch (e) {}
  if (typeof window.renderApp === 'function') window.renderApp();
});

document.addEventListener('DOMContentLoaded', () => {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js')
      .then(reg => {
        console.log('✅ Service Worker PWA activo');
        // INSTRUMENTACIÓN TEMPORAL: SERVICE WORKER VERSION
        const swVersion = reg.active ? reg.active.scriptURL : 'no active worker';
        console.log('=== SERVICE WORKER VERSION ===', {
          scriptURL: swVersion,
          state: reg.active ? reg.active.state : 'none',
          controller: navigator.serviceWorker.controller ? navigator.serviceWorker.controller.scriptURL : 'no controller'
        });
        // FIN INSTRUMENTACIÓN
      })
      .catch(err => console.warn('Error SW:', err));

    navigator.serviceWorker.addEventListener('message', (event) => {
      if (event.data && event.data.type === 'NAVIGATE_ROUTE') {
        if (event.data.routineId && appState.usuarioActual && appState.usuarioActual.rol === 'alumno') {
          appState.tabCliente = 'rutina';
          appState.rutinaSeleccionadaId = event.data.routineId;
          appState.diaSeleccionadoId = null;
          renderApp();
          // PWA: al interactuar con una notificación de rutina actualizada,
          // forzamos la reobtención fresca desde Supabase (no confiar en caché).
          if (window.gymStore) window.gymStore.forceRefreshRutinas(appState.usuarioActual.data.id);
        }
      }
    });
  }

  const store = window.gymStore;
  const appContainer = document.getElementById('app');

  const appState = {
    usuarioActual: null, // null | { rol: 'profesor'|'alumno', data: object }
    tabCliente: 'rutina', // 'rutina' | 'historial'
    rutinaSeleccionadaId: null, // ID de rutina seleccionada por el alumno
    diaSeleccionadoId: null, // ID de día seleccionado por el alumno
    diaActivoEntrenamiento: null, // null | diaObject
    filtroProfesor: 'todos',
    busquedaProfesor: '',
    modalActivo: null,
    alumnoSeleccionadoId: null,
    rutinaAEliminarId: null, // rutina pendiente de confirmación de borrado (panel profesor)
    logEnEdicionId: null,    // entrenamiento que el alumno está editando (ventana 2hs)
    mostrarDrawerNotifs: false,
    workoutDraftSets: {},       // Estado temporal del entrenamiento en progreso por serie
    borradorEntrenamientoDetectado: null, // borrador recuperado de localStorage, pendiente de confirmar Continuar/Descartar
    historialProfesorLogs: null  // Caché async del historial del alumno visto por el profesor
  };

  // Escuchar cambios de Supabase Realtime / Local Store
  window.addEventListener('gym_store_updated', () => {
    if (appState.usuarioActual && appState.usuarioActual.rol === 'alumno') {
      const alumnoActualizado = store.getAlumnoPorId(appState.usuarioActual.data.id) || store.data.alumnos.find(a => a.dni === appState.usuarioActual.data.dni);
      if (alumnoActualizado) appState.usuarioActual.data = alumnoActualizado;
    }

    const activeEl = document.activeElement;
    const isTyping = activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA');
    if (!isTyping) {
      renderApp();
    }
  });

  function renderApp() {
    if (!appState.usuarioActual) {
      renderLoginScreen();
    } else if (appState.usuarioActual.rol === 'alumno') {
      renderClientDashboard();
    } else if (appState.usuarioActual.rol === 'profesor') {
      renderTrainerDashboard();
    }
  }
  // Expuesta para que los listeners de beforeinstallprompt/appinstalled
  // (definidos arriba, fuera de este DOMContentLoaded) puedan refrescar el
  // banner de instalación en cuanto cambie su disponibilidad.
  window.renderApp = renderApp;

  // --- BANNER "INSTALAR APLICACIÓN" ---
  function debeOfrecerInstalacion() {
    if (!window.deferredInstallPrompt) return false; // sin evento nativo disponible, no mostramos nada (requisito 7)
    if (estudioFitnessPwaYaInstalada()) return false; // ya instalada (requisito 6)
    try {
      const dismissedAt = Number(localStorage.getItem(INSTALL_DISMISS_KEY) || 0);
      if (dismissedAt && (Date.now() - dismissedAt) < INSTALL_DISMISS_COOLDOWN_MS) return false; // el usuario ya lo cerró hace poco (requisito 9)
    } catch (e) { /* localStorage no disponible: no bloqueamos por esto */ }
    return true;
  }

  function renderInstallBanner() {
    if (!debeOfrecerInstalacion()) return '';
    return `
      <div class="install-pwa-banner" id="installPwaBanner">
        <div class="install-pwa-text">
          <div class="install-pwa-title">📱 Instalar Estudio Fitness</div>
          <div class="install-pwa-subtitle">Accedé más rápido, como una app, sin pasar por el navegador.</div>
        </div>
        <div class="install-pwa-actions">
          <button class="btn btn-primary btn-sm" id="btnInstallPwa">Instalar aplicación</button>
          <button class="btn btn-secondary btn-icon" id="btnDismissInstallPwa" title="Cerrar">✕</button>
        </div>
      </div>
    `;
  }

  function bindInstallBannerEvents() {
    const btnInstall = document.getElementById('btnInstallPwa');
    if (btnInstall) {
      btnInstall.addEventListener('click', async () => {
        const promptEvent = window.deferredInstallPrompt;
        if (!promptEvent) { renderApp(); return; } // ya no está disponible (p.ej. se instaló desde otra pestaña)
        btnInstall.disabled = true;
        promptEvent.prompt();
        try {
          await promptEvent.userChoice; // se resuelve tanto si acepta como si rechaza el diálogo nativo
        } catch (e) { /* usuario cerró el diálogo del sistema sin elegir */ }
        // El evento beforeinstallprompt es de un solo uso: una vez mostrado el
        // diálogo nativo, se descarta. Si aceptó, "appinstalled" además limpia
        // el flag de "cerrado por el usuario" y oculta el banner (requisito 5).
        window.deferredInstallPrompt = null;
        renderApp();
      });
    }
    const btnDismiss = document.getElementById('btnDismissInstallPwa');
    if (btnDismiss) {
      btnDismiss.addEventListener('click', () => {
        try { localStorage.setItem(INSTALL_DISMISS_KEY, String(Date.now())); } catch (e) {}
        renderApp();
      });
    }
  }

  // --- HEADER COMPARTIDO CON ACTIVACIÓN EXPLÍCITA DE WEB PUSH ---
  function renderHeader() {
    const isProfesor = appState.usuarioActual?.rol === 'profesor';
    const user = appState.usuarioActual?.data;

    const notifs = store.getNotificacionesPorRol(
      isProfesor ? 'profesor' : 'alumno',
      user ? user.id : null
    );
    const unreadCount = notifs.filter(n => !n.leido).length;
    const pushConcedido = 'Notification' in window && Notification.permission === 'granted';

    return `
      <header class="app-header">
        <div class="brand-wrapper" id="btnHeaderHome">
          <img src="./src/logo.svg" alt="Estudio Fitness Logo" class="brand-logo">
          <div class="brand-title">Estudio<span>Fitness</span></div>
        </div>

        <div class="header-actions">
          ${user ? `
            <span class="badge header-user-badge ${isProfesor ? 'badge-warning' : 'badge-active'}" title="${user.nombre}">
              ${isProfesor ? '⚡' : '👤'} ${user.nombre}
            </span>
          ` : ''}

          ${appState.usuarioActual ? `
            <button
              class="btn btn-secondary btn-icon notif-bell-btn"
              id="btnNotifBell"
              title="${pushConcedido ? 'Notificaciones' : 'Notificaciones (tocá para activar el push)'}"
            >
              🔔
              ${!pushConcedido
                ? `<span class="notif-bell-dot" title="Push desactivado"></span>`
                : (unreadCount > 0 ? `<span style="position:absolute; top:-4px; right:-4px; background:var(--red-primary); color:#fff; border-radius:50%; width:18px; height:18px; font-size:0.7rem; font-weight:800; display:flex; align-items:center; justify-content:center">${unreadCount}</span>` : '')
              }
            </button>
            <button class="btn btn-secondary btn-sm header-logout-btn" id="btnLogout"><span class="header-logout-label">Salir</span> 🚪</button>
          ` : ''}
        </div>
      </header>

      ${appState.mostrarDrawerNotifs ? renderNotifDrawer(notifs) : ''}
      ${renderInstallBanner()}
    `;
  }

  function renderNotifDrawer(notifs) {
    return `
      <div class="notif-drawer">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; border-bottom:1px solid var(--border-color); padding-bottom:6px">
          <strong style="font-size:0.95rem">🔔 Avisos de Entrenamiento</strong>
          <button class="btn btn-secondary btn-sm" id="btnCloseNotifs" style="padding:2px 8px">&times;</button>
        </div>
        ${notifs.length === 0 ? `
          <div style="font-size:0.85rem; color:var(--text-gray); padding:10px; text-align:center">Sin notificaciones pendientes</div>
        ` : notifs.map(n => `
          <div class="notif-item ${!n.leido ? 'unread' : ''}">
            <div>${n.mensaje}</div>
            <div style="font-size:0.72rem; color:var(--text-muted); margin-top:4px">${new Date(n.fecha).toLocaleString()}</div>
          </div>
        `).join('')}
      </div>
    `;
  }

  function renderBottomNav() {
    if (!appState.usuarioActual) return '';
    const isProfesor = appState.usuarioActual.rol === 'profesor';
    const user = appState.usuarioActual.data;
    const notifs = store.getNotificacionesPorRol(isProfesor ? 'profesor' : 'alumno', user ? user.id : null);
    const unreadCount = notifs.filter(n => !n.leido).length;

    const iconRutina = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M8 9h8M8 13h8M8 17h5"/></svg>`;
    const iconHistorial = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>`;
    const iconAvisos = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>`;
    const iconAlumnos = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 3 3.87"/></svg>`;
    const iconMisRutinas = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="8" r="4"/><path d="M2 21v-1a7 7 0 0 1 7-7h1.5"/><path d="M18 14v6M15 17h6"/></svg>`;
    const iconRanking = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 21h8M12 17v4M7 4h10v4a5 5 0 0 1-10 0V4Z"/><path d="M7 6H4a2 2 0 0 0 2 4M17 6h3a2 2 0 0 1-2 4"/></svg>`;

    const items = isProfesor ? [
      { id: 'navAlumnos',    label: 'Alumnos', icon: iconAlumnos, active: appState.modalActivo === null && !appState.mostrarDrawerNotifs },
      { id: 'navAvisosProf', label: 'Avisos',   icon: iconAvisos,  active: appState.mostrarDrawerNotifs, badge: unreadCount }
    ] : [
      { id: 'navRutina',       label: 'Rutinas',   icon: iconRutina,    active: appState.tabCliente === 'rutina' && !appState.mostrarDrawerNotifs },
      { id: 'navMisRutinas',   label: 'Mías',       icon: iconMisRutinas, active: appState.tabCliente === 'mis_rutinas' && !appState.mostrarDrawerNotifs },
      { id: 'navRanking',      label: 'Ranking',    icon: iconRanking,   active: appState.tabCliente === 'ranking' && !appState.mostrarDrawerNotifs },
      { id: 'navHistorial',    label: 'Historial', icon: iconHistorial, active: appState.tabCliente === 'historial' && !appState.mostrarDrawerNotifs },
      { id: 'navAvisosAlumno', label: 'Avisos',     icon: iconAvisos,    active: appState.mostrarDrawerNotifs, badge: unreadCount }
    ];

    return `
      <nav class="bottom-nav">
        ${items.map(it => `
          <button class="bottom-nav-item ${it.active ? 'active' : ''}" id="${it.id}">
            <span class="bottom-nav-icon">
              ${it.icon}
              ${it.badge ? `<span class="bottom-nav-badge">${it.badge}</span>` : ''}
            </span>
            <span class="bottom-nav-label">${it.label}</span>
          </button>
        `).join('')}
      </nav>
    `;
  }

  // --- LOGIN Y REGISTRO POR DNI CON VERIFICACIÓN DE AUTORIZACIÓN ---
  function renderLoginScreen() {
    appContainer.innerHTML = `
      ${renderHeader()}
      <div class="login-container">
        <img src="./src/logo.svg" alt="Logo Estudio Fitness" class="login-logo">
        <h1 class="login-title">Estudio Fitness</h1>
        <p class="login-subtitle">Ingreso único por DNI</p>

        <form id="formLoginUnico">
          <div class="form-group">
            <label class="form-label" for="inputDni">Número de DNI</label>
            <input type="text" id="inputDni" class="form-input" placeholder="Ingresa tu DNI" required autofocus>
          </div>

          <!-- Campo de contraseña eliminado del flujo activo (login por DNI,
               generateLink + verifyOtp). authSignIn/authSignUp y el flujo
               legacy de password siguen en supabase.js/data.js sin usarse,
               pendientes de limpieza controlada. -->

          <button type="submit" class="btn btn-primary" style="width:100%">Iniciar Sesión 🚀</button>
        </form>

        <div style="margin-top:16px; border-top:1px solid var(--border-color); padding-top:14px">
          <button class="btn btn-secondary btn-sm" id="btnToggleRegister" style="width:100%">¿Eres alumno nuevo? Crear Cuenta 👤</button>
        </div>
      </div>
    `;
    bindInstallBannerEvents();

    let loginEnCurso = false;
    document.getElementById('formLoginUnico').addEventListener('submit', async (e) => {
      e.preventDefault();
      if (loginEnCurso) return; // evita doble submit mientras se sincroniza con Supabase
      const dni = document.getElementById('inputDni').value;

      if (!dni || !dni.trim()) {
        alert("Ingresá tu DNI.");
        return;
      }

      const submitBtn = e.target.querySelector('button[type="submit"]');
      loginEnCurso = true;
      if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Verificando...'; }

      let res;
      try {
        // Login por DNI: genera un magic-link en el backend y lo canjea por
        // una sesión REAL de Supabase Auth (generateLink + verifyOtp).
        // store.login(dni, password) queda sin usarse en este flujo activo,
        // pendiente de limpieza controlada.
        res = await store.loginConDni(dni);
      } finally {
        loginEnCurso = false;
        if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Iniciar Sesión 🚀'; }
      }

      if (res) {
        appState.usuarioActual = res;

        if (res.rol === 'alumno' && res.data && res.data.id) {
          // --- SESIÓN ALUMNO ---
          window._sessionAlumnoId = res.data.id;
          window._sessionProfesorId = null;
          // Detectar si hay un borrador de entrenamiento sin terminar que
          // pertenezca a ESTE alumno (getBorradorPropio verifica ownerId).
          appState.borradorEntrenamientoDetectado = getBorradorPropio();
          // Sincronizar rutinas e historial vía RPC después del login
          setTimeout(async () => {
            await gymStore.syncWithSupabase(res.data.id);
            // Sincronizar historial desde Supabase
            if (window.supabaseEngine) {
              const sbLogs = await window.supabaseEngine.obtenerHistorialDesdeSupabase(res.data.id);
              if (sbLogs && sbLogs.length > 0) {
                sbLogs.forEach(sbLog => {
                  const idx = gymStore.data.workoutLogs.findIndex(w => w.id === sbLog.id);
                  if (idx >= 0) {
                    gymStore.data.workoutLogs[idx] = sbLog;
                  } else {
                    gymStore.data.workoutLogs.push(sbLog);
                  }
                });
                gymStore.saveData();
                window.dispatchEvent(new CustomEvent('gym_store_updated'));
              }
            }
          }, 300);
        } else if (res.rol === 'profesor' && res.data && res.data.id) {
          // --- SESIÓN PROFESOR ---
          window._sessionProfesorId = res.data.id;
          window._sessionAlumnoId = null;
          // Sincronizar rutinas de todos los alumnos conocidos tras el login
          // (punto C). No existe persistencia de sesión, así que este login
          // es el único punto de entrada confiable para el profesor.
          setTimeout(async () => {
            await gymStore.syncRutinasProfesor();
          }, 300);
        } else {
          window._sessionAlumnoId = null;
          window._sessionProfesorId = null;
        }

        appState.historialProfesorLogs = null; // limpiar caché al cambiar de sesión
        renderApp();
      } else {
        alert("❌ No se pudo iniciar sesión con ese DNI. Verificá el número.");
      }

    });

    document.getElementById('btnToggleRegister')?.addEventListener('click', () => {
      renderRegisterScreen();
    });
  }

  // Genera una contraseña temporal aleatoria e interna para Supabase Auth
  // signUp(). El usuario nunca la ve ni la introduce: el login real es
  // exclusivamente por DNI vía loginConDni() (magic link / OTP), no por
  // email+password. No reemplaza ni modifica authSignIn/authSignUp.
  function generarPasswordTemporalInterna() {
    if (window.crypto && window.crypto.randomUUID) {
      return window.crypto.randomUUID() + window.crypto.randomUUID();
    }
    return 'tmp-' + Date.now() + '-' + Math.random().toString(36).slice(2);
  }

  function renderRegisterScreen() {
    appContainer.innerHTML = `
      ${renderHeader()}
      <div class="login-container">
        <h2 class="login-title">Crear Cuenta de Alumno</h2>
        <p class="login-subtitle">Ingresa tus datos para registrarte en el gimnasio</p>

        <form id="formRegisterAlumno">
          <div class="form-group">
            <label class="form-label">Tu DNI *</label>
            <input type="text" id="regDni" class="form-input" placeholder="Ej: 55667788" required>
          </div>
          <div class="form-group">
            <label class="form-label">Nombre Completo *</label>
            <input type="text" id="regNombre" class="form-input" placeholder="Ej: Mariano López" required>
          </div>
          <div class="form-group">
            <label class="form-label">Teléfono (Opcional)</label>
            <input type="text" id="regTel" class="form-input" placeholder="Ej: 1199887766">
          </div>

          <button type="submit" class="btn btn-primary" style="width:100%">Crear mi Cuenta 📝</button>
        </form>

        <div style="margin-top:14px">
          <button class="btn btn-secondary btn-sm" id="btnBackToLogin">Volver al Login ⬅️</button>
        </div>
      </div>
    `;
    bindInstallBannerEvents();

    document.getElementById('btnBackToLogin')?.addEventListener('click', () => renderLoginScreen());

    document.getElementById('formRegisterAlumno')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const submitBtn = e.target.querySelector('button[type="submit"]');
      if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Registrando...'; }
      try {
        const dni = document.getElementById('regDni').value;
        // El usuario ya NO ingresa contraseña: se genera internamente, solo
        // para satisfacer el requisito de Supabase Auth signUp(). El login
        // real sigue siendo exclusivamente por DNI vía loginConDni() (OTP),
        // así que esta contraseña nunca se usa para autenticar y no hace
        // falta que el usuario la vea ni la recuerde.
        const pass = generarPasswordTemporalInterna();
        const nombre = document.getElementById('regNombre').value;
        const tel = document.getElementById('regTel').value;

        // registrarseAlumno es async en Etapa 1: intenta authSignUp después
        // del registro local. El await es necesario para que la UI no avance
        // antes de que el intento de Supabase Auth termine (aunque no sea bloqueante
        // para el perfil local, sí debe resolverse antes de renderApp).
        const alumno = await store.registrarseAlumno({ dni, password: pass, nombre, telefono: tel });
        appState.usuarioActual = { rol: 'alumno', data: alumno };
        renderApp();
      } catch (err) {
        alert("❌ Error: " + err.message);
      } finally {
        if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Crear mi Cuenta 📝'; }
      }
    });
  }

  // --- DASHBOARD ALUMNO (NUEVA NAVEGACIÓN MOBILE-FIRST POR TARJETAS) ---
  function renderClientDashboard() {
    const alumno = appState.usuarioActual.data;
    const pendienteAutorizacion = alumno.estadoAutorizacion === 'pendiente';

    const historialEntrenamientos = store.getHistorialEntrenamientosReales(alumno.id);

    appContainer.innerHTML = `
      ${renderHeader()}

      <main class="client-dashboard">
        ${pendienteAutorizacion ? `
          <div class="pending-banner">
            ⚠️ Tu DNI (<strong>${alumno.dni}</strong>) todavía no fue autorizado por tu profesor, así que aún no
            vas a ver rutinas asignadas. Mientras tanto, ¡ya podés crear y entrenar tus propias rutinas en
            <strong>"Mías"</strong>! Pedile a tu profe que te autorice para recibir rutinas personalizadas.
          </div>
        ` : ''}

        ${(appState.tabCliente === 'rutina' || appState.tabCliente === 'mis_rutinas') ? (
          appState.diaActivoEntrenamiento ? renderWorkoutSession() : (
            appState.diaSeleccionadoId ? renderDayDetailView(alumno) : (
              appState.rutinaSeleccionadaId ? renderRoutineDaysView(alumno) : (
                appState.tabCliente === 'mis_rutinas' ? renderMisRutinasView(alumno) : renderRoutinesListView(alumno)
              )
            )
          )
        ) : ''}

        ${appState.tabCliente === 'ranking' ? renderRankingView() : ''}
        ${appState.tabCliente === 'historial' ? renderHistorialAgrupado(historialEntrenamientos, store.data.rutinas, true) : ''}
      </main>

      ${(appState.modalActivo === 'crear_rutina_propia' || appState.modalActivo === 'editar_rutina_propia') ? renderModalFormularioRutina(appState.modalActivo) : ''}
      ${appState.modalActivo === 'editar_entrenamiento' ? renderModalEditarEntrenamiento(alumno) : ''}
      ${appState.borradorEntrenamientoDetectado ? renderModalRecuperarBorrador() : ''}

      ${renderBottomNav()}
    `;

    bindHeaderEvents();
    bindInstallBannerEvents();
    bindBottomNavEvents();
    bindMisRutinasEvents(alumno);
    bindHistorialEvents(alumno);
    bindBorradorEntrenamientoEvents();

    // Eventos de navegación por tarjetas de rutina (excluye las de "Mis Rutinas",
    // que tienen su propio binding en bindMisRutinasEvents para soportar Editar/Borrar)
    document.querySelectorAll('.routine-select-card:not(.routine-propia-card)').forEach(card => {
      card.addEventListener('click', () => {
        appState.rutinaSeleccionadaId = card.dataset.rutinaId;
        appState.diaSeleccionadoId = null;
        renderApp();
      });
    });

    // Evento volver a Mis Rutinas desde lista de días
    document.getElementById('btnBackToRoutines')?.addEventListener('click', () => {
      appState.rutinaSeleccionadaId = null;
      appState.diaSeleccionadoId = null;
      renderApp();
    });

    // Eventos de navegación por tarjetas de día
    document.querySelectorAll('.day-select-card').forEach(card => {
      card.addEventListener('click', () => {
        appState.diaSeleccionadoId = card.dataset.diaId;
        renderApp();
      });
    });

    // Evento volver a Días desde detalle de día
    document.getElementById('btnBackToDays')?.addEventListener('click', () => {
      appState.diaSeleccionadoId = null;
      renderApp();
    });

    // Eventos de iniciar entrenamiento
    document.querySelectorAll('.btn-comenzar-entrenamiento').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const diaId = e.currentTarget.dataset.diaId;
        const rutina = store.getRutinaPorId(appState.rutinaSeleccionadaId);
        const diaObj = rutina ? rutina.dias.find(d => d.id === diaId) : null;
        if (diaObj) {
          appState.diaActivoEntrenamiento = diaObj;
          initWorkoutDraft(diaObj);
          renderApp();
        }
      });
    });

    bindAccordionEvents();
  }

  function renderRoutinesListView(alumno) {
    const rutinas = store.getRutinasAlumno(alumno.id);
    if (!rutinas || rutinas.length === 0) {
      return `
        <div class="routine-banner" style="text-align:center; justify-content:center; flex-direction:column; padding:30px 20px">
          <div style="font-size:2.5rem; margin-bottom:10px">🏋️</div>
          <h2 style="font-size:1.3rem; font-weight:900">Sin Rutinas Asignadas</h2>
          <p style="color:var(--text-gray); font-size:0.9rem; margin-top:6px">Tu profesor te asignará una nueva rutina personalizada en breve.</p>
        </div>
      `;
    }

    return `
      <div style="margin-bottom:16px">
        <h2 style="font-size:1.4rem; font-weight:900; letter-spacing:0.5px">Mis Rutinas</h2>
        <p style="font-size:0.85rem; color:var(--text-gray)">Seleccioná una rutina para ver tus días de entrenamiento</p>
      </div>

      ${rutinas.map(r => {
        const semanas = Math.max(1, Math.ceil((r.duracionDias || 30) / 7));
        const esActiva = r.estado === 'activa';
        const diasRestantes = store.calcularDiasRestantes(r.fechaVencimiento);

        return `
          <div class="routine-select-card" data-rutina-id="${r.id}">
            <div class="routine-card-header">
              <span class="badge ${esActiva ? (diasRestantes <= 1 ? 'badge-warning' : 'badge-active') : 'badge-role'}">
                ● ${esActiva ? (diasRestantes <= 1 ? `ACTIVA (${diasRestantes}d restantes)` : 'ACTIVA') : 'INACTIVA'}
              </span>
              <span class="badge badge-info">${semanas} ${semanas === 1 ? 'semana' : 'semanas'}</span>
            </div>

            <div>
              <h3 class="routine-card-title">${r.titulo}</h3>
              <p class="routine-card-subtitle">Profesor: <strong>${r.profesorCreadorNombre || 'Estudio Fitness'}</strong></p>
            </div>

            <div style="display:flex; justify-content:space-between; align-items:center; border-top:1px solid var(--border-color); padding-top:10px; margin-top:4px">
              <div class="routine-card-days-count">
                🔥 ${r.dias ? r.dias.length : 0} Días de Entrenamiento
              </div>
              <div style="font-weight:800; font-size:0.88rem; color:var(--red-primary); display:flex; align-items:center; gap:4px">
                Tocar para ver días ➔
              </div>
            </div>
          </div>
        `;
      }).join('')}
    `;
  }

  // --- FEATURE "MIS RUTINAS": vista de rutinas auto-gestionadas por el alumno ---
  function renderMisRutinasView(alumno) {
    const misRutinas = store.getRutinasPropiasAlumno(alumno.id);

    return `
      <div style="margin-bottom:16px; display:flex; justify-content:space-between; align-items:center; gap:10px; flex-wrap:wrap">
        <div>
          <h2 style="font-size:1.4rem; font-weight:900; letter-spacing:0.5px">🧑‍🔧 Mis Rutinas</h2>
          <p style="font-size:0.85rem; color:var(--text-gray)">Rutinas personales que armás y gestionás vos mismo</p>
        </div>
        <button class="btn btn-primary btn-sm" id="btnNuevaRutinaPropia">+ Crear Rutina Propia</button>
      </div>

      ${misRutinas.length === 0 ? `
        <div class="routine-banner" style="text-align:center; justify-content:center; flex-direction:column; padding:30px 20px">
          <div style="font-size:2.5rem; margin-bottom:10px">📝</div>
          <h3 style="font-size:1.1rem; font-weight:900">Todavía no creaste rutinas propias</h3>
          <p style="color:var(--text-gray); font-size:0.88rem; margin-top:6px">
            Armá tu propia rutina de entrenamiento y empezá a registrar tus series cuando quieras.
          </p>
        </div>
      ` : misRutinas.map(r => `
        <div class="routine-select-card routine-propia-card" data-rutina-id="${r.id}">
          <div class="routine-card-header">
            <span class="badge badge-info">🔧 Auto-gestionada</span>
            <span class="badge badge-info">${r.dias ? r.dias.length : 0} ${r.dias && r.dias.length === 1 ? 'día' : 'días'}</span>
          </div>

          <div>
            <h3 class="routine-card-title">${r.titulo}</h3>
            <p class="routine-card-subtitle">Creada por vos · Duración: ${r.duracionDias} días</p>
          </div>

          <div style="display:flex; justify-content:space-between; align-items:center; border-top:1px solid var(--border-color); padding-top:10px; margin-top:4px; gap:8px; flex-wrap:wrap">
            <div class="routine-card-days-count">Tocar para ver días ➔</div>
            <div style="display:flex; gap:6px">
              <button class="btn btn-secondary btn-sm btn-editar-rutina-propia" data-rutina-id="${r.id}" style="border-color:var(--yellow-warning); color:var(--yellow-warning); padding:4px 10px; font-size:0.78rem">✏️ Editar</button>
              <button class="btn btn-secondary btn-sm btn-eliminar-rutina-propia" data-rutina-id="${r.id}" style="border-color:var(--red-primary); color:var(--red-primary); padding:4px 10px; font-size:0.78rem">🗑️ Borrar</button>
            </div>
          </div>
        </div>
      `).join('')}
    `;
  }

  function bindMisRutinasEvents(alumno) {
    document.getElementById('btnNuevaRutinaPropia')?.addEventListener('click', () => {
      appState.alumnoSeleccionadoId = alumno.id;
      appState.rutinaEnEdicionId = null;
      appState.modalActivo = 'crear_rutina_propia';
      initFormBuilderForNew();
      renderApp();
    });

    document.querySelectorAll('.routine-propia-card').forEach(card => {
      card.addEventListener('click', (e) => {
        const rId = card.dataset.rutinaId;

        if (e.target.closest('.btn-editar-rutina-propia')) {
          e.stopPropagation();
          appState.alumnoSeleccionadoId = alumno.id;
          appState.rutinaEnEdicionId = rId;
          appState.modalActivo = 'editar_rutina_propia';
          initFormBuilderForRoutine(rId);
          renderApp();
          return;
        }

        if (e.target.closest('.btn-eliminar-rutina-propia')) {
          e.stopPropagation();
          if (confirm("¿Seguro que querés eliminar esta rutina propia? Esta acción no se puede deshacer.")) {
            try {
              store.eliminarRutinaPropia(rId, alumno.id);
            } catch (err) {
              alert("❌ Error: " + err.message);
            }
            renderApp();
          }
          return;
        }

        // Reutiliza el mismo flujo de días/ejercicios/entrenamiento que las rutinas asignadas,
        // pero SIN cambiar de pestaña: se mantiene en "Mis Rutinas" (tabCliente ya es 'mis_rutinas').
        appState.rutinaSeleccionadaId = rId;
        appState.diaSeleccionadoId = null;
        renderApp();
      });
    });
  }

  // --- EDICIÓN DE ENTRENAMIENTO YA GUARDADO (ventana de 2hs, solo el propio alumno) ---
  function bindHistorialEvents(alumno) {
    document.querySelectorAll('.btn-editar-entrenamiento-click').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const logId = btn.dataset.logId;
        const log = store.data.workoutLogs.find(w => w.id === logId);
        if (!log) return;
        appState.logEnEdicionId = logId;
        appState.editDraftSets = JSON.parse(JSON.stringify(log.sets || []));
        appState.editDraftComentario = log.comentarioGeneral || '';
        appState.modalActivo = 'editar_entrenamiento';
        renderApp();
      });
    });
  }

  function renderModalEditarEntrenamiento(alumno) {
    const log = store.data.workoutLogs.find(w => w.id === appState.logEnEdicionId);
    if (!log || !appState.editDraftSets) return '';

    if (!store.puedeEditarseEntrenamiento(log)) {
      return `
        <div class="modal-overlay">
          <div class="modal-content" style="max-width:420px">
            <div class="modal-header">
              <h3>⏰ Ventana de edición vencida</h3>
              <button class="close-btn" id="btnCloseModal">&times;</button>
            </div>
            <p style="color:var(--text-gray); font-size:0.92rem">
              Ya pasaron más de 2 horas desde que guardaste este entrenamiento, así que no se puede editar.
            </p>
          </div>
        </div>
      `;
    }

    // Agrupar por ejercicio, conservando el índice real en editDraftSets para los onchange
    const ejMap = {};
    appState.editDraftSets.forEach((s, idx) => {
      if (!ejMap[s.ejercicioNombre]) ejMap[s.ejercicioNombre] = [];
      ejMap[s.ejercicioNombre].push({ ...s, _idx: idx });
    });

    return `
      <div class="modal-overlay">
        <div class="modal-content">
          <div class="modal-header">
            <h3>✏️ Editar Entrenamiento: ${log.diaNombre}</h3>
            <button class="close-btn" id="btnCloseModal">&times;</button>
          </div>
          <p style="color:var(--yellow-warning); font-size:0.8rem; margin-bottom:12px">
            ⏰ Podés editar hasta 2 horas después de haber guardado el entrenamiento. Los puntos ya otorgados no cambian.
          </p>

          ${Object.entries(ejMap).map(([ejNombre, sets]) => `
            <div class="exercise-block">
              <div class="exercise-title" style="font-size:1rem; font-weight:900; color:#fff">${ejNombre}</div>
              <div class="sets-table-header">
                <div>SERIE</div>
                <div>REPS</div>
                <div>PESO</div>
                <div>COMENTARIO POR SERIE</div>
              </div>
              ${sets.map(s => `
                <div class="set-row">
                  <div class="set-label">Serie ${s.setNumero}</div>
                  <div><input type="number" class="set-input" value="${s.repsRealizadas}" onchange="window.updateEditSet(${s._idx}, 'repsRealizadas', this.value)"></div>
                  <div><input type="text" class="set-input" value="${s.pesoUtilizado}" onchange="window.updateEditSet(${s._idx}, 'pesoUtilizado', this.value)"></div>
                  <div><input type="text" class="set-input set-comment-input" value="${s.comentarioAlumno || ''}" onchange="window.updateEditSet(${s._idx}, 'comentarioAlumno', this.value)"></div>
                </div>
              `).join('')}
            </div>
          `).join('')}

          <div class="exercise-block" style="border-color:var(--border-highlight)">
            <label class="form-label" style="color:var(--red-primary)">💬 COMENTARIO GENERAL</label>
            <textarea class="exercise-textarea" onchange="window.updateEditComentarioGeneral(this.value)">${appState.editDraftComentario || ''}</textarea>
          </div>

          <div style="display:flex; justify-content:flex-end; gap:10px; margin-top:16px">
            <button type="button" class="btn btn-secondary" id="btnCancelModal">Cancelar</button>
            <button type="button" class="btn btn-primary" id="btnGuardarEdicionEntrenamiento">💾 Guardar Cambios</button>
          </div>
        </div>
      </div>
    `;
  }

  window.updateEditSet = (idx, field, val) => {
    if (appState.editDraftSets && appState.editDraftSets[idx]) {
      appState.editDraftSets[idx][field] = field === 'repsRealizadas' ? Number(val) : val;
    }
  };

  window.updateEditComentarioGeneral = (val) => {
    appState.editDraftComentario = val;
  };

  // --- MODAL: recuperar entrenamiento sin terminar (borrador local) ---
  function renderModalRecuperarBorrador() {
    const draft = appState.borradorEntrenamientoDetectado;
    if (!draft) return '';
    return `
      <div class="modal-overlay">
        <div class="modal-content" style="max-width:420px">
          <div class="modal-header">
            <h3>💪 Entrenamiento sin terminar</h3>
          </div>
          <p style="color:var(--text-gray); font-size:0.92rem; line-height:1.5">
            Tenés un entrenamiento sin terminar: <strong style="color:#fff">${draft.diaActivoEntrenamiento?.nombre || ''}</strong>. ¿Querés continuar donde lo dejaste?
          </p>
          <div style="display:flex; justify-content:flex-end; gap:10px; margin-top:20px">
            <button type="button" class="btn btn-secondary" id="btnDescartarBorrador">Descartar</button>
            <button type="button" class="btn btn-primary" id="btnContinuarBorrador">Continuar ▶</button>
          </div>
        </div>
      </div>
    `;
  }

  function bindBorradorEntrenamientoEvents() {
    document.getElementById('btnContinuarBorrador')?.addEventListener('click', () => {
      const draft = appState.borradorEntrenamientoDetectado;
      if (!draft) return;
      appState.rutinaSeleccionadaId = draft.rutinaSeleccionadaId || null;
      appState.tabCliente = draft.tabCliente || 'rutina';
      appState.diaActivoEntrenamiento = draft.diaActivoEntrenamiento;
      appState.workoutDraftSets = draft.workoutDraftSets || {};
      appState.workoutGeneralComment = draft.workoutGeneralComment || '';
      appState.borradorEntrenamientoDetectado = null;
      renderApp();
    });

    document.getElementById('btnDescartarBorrador')?.addEventListener('click', () => {
      clearWorkoutDraft();
      appState.borradorEntrenamientoDetectado = null;
      renderApp();
    });
  }

  // --- FEATURE RANKING: tabla de posiciones en tiempo real con medallas Top 3 ---
  function renderRankingView() {
    const ranking = store.getRanking();
    const miId = appState.usuarioActual.data.id;
    const medalla = (pos) => pos === 1 ? '🥇' : pos === 2 ? '🥈' : pos === 3 ? '🥉' : `#${pos}`;

    return `
      <div style="margin-bottom:16px">
        <h2 style="font-size:1.4rem; font-weight:900; letter-spacing:0.5px">🏆 Ranking</h2>
        <p style="font-size:0.85rem; color:var(--text-gray)">Puntos acumulados por entrenamientos completados y racha semanal</p>
      </div>

      ${ranking.length === 0 ? `
        <div class="routine-banner" style="text-align:center; justify-content:center; flex-direction:column; padding:30px 20px">
          <div style="font-size:2.5rem; margin-bottom:10px">🏆</div>
          <h3 style="font-size:1.1rem; font-weight:900">Aún no hay puntos registrados</h3>
          <p style="color:var(--text-gray); font-size:0.88rem; margin-top:6px">Completá un entrenamiento para empezar a sumar puntos.</p>
        </div>
      ` : `
        <div class="ranking-list">
          ${ranking.map(a => `
            <div class="ranking-row ${a.id === miId ? 'ranking-row-me' : ''} ${a.posicion <= 3 ? 'ranking-row-top' + a.posicion : ''}">
              <div class="ranking-pos">${medalla(a.posicion)}</div>
              <div class="ranking-info">
                <div class="ranking-name">${a.nombre}${a.id === miId ? ' <span style="color:var(--red-primary)">(Vos)</span>' : ''}</div>
                ${a.rachaSemanal && a.rachaSemanal.semanas >= 2 ? `<div class="ranking-streak">🔥 Racha de ${a.rachaSemanal.semanas} semanas</div>` : ''}
              </div>
              <div class="ranking-points">${Math.round(a.puntosTotal || 0)} pts</div>
            </div>
          `).join('')}
        </div>
      `}
    `;
  }

  function renderRoutineDaysView(alumno) {
    const rutina = store.getRutinaPorId(appState.rutinaSeleccionadaId);
    if (!rutina) {
      appState.rutinaSeleccionadaId = null;
      return renderRoutinesListView(alumno);
    }

    const semanas = Math.max(1, Math.ceil((rutina.duracionDias || 30) / 7));
    const esActiva = rutina.estado === 'activa';

    return `
      <button class="nav-breadcrumb-btn" id="btnBackToRoutines">⬅️ Volver a ${rutina.esPropia ? 'Mis Rutinas' : 'Rutinas'}</button>

      <div class="routine-banner" style="margin-bottom:20px">
        <div>
          <span class="badge ${esActiva ? 'badge-active' : 'badge-role'}">
            ● ${esActiva ? 'RUTINA ACTIVA' : 'RUTINA HISTÓRICA'}
          </span>
          <h2 style="font-size:1.35rem; font-weight:900; margin-top:6px">${rutina.titulo}</h2>
          <p style="font-size:0.85rem; color:var(--text-gray); margin-top:4px">
            Profesor: <strong>${rutina.profesorCreadorNombre || 'Estudio Fitness'}</strong> | Duración: ${semanas} ${semanas === 1 ? 'semana' : 'semanas'}
          </p>
        </div>
      </div>

      <div style="margin-bottom:14px">
        <h3 style="font-size:1.1rem; font-weight:900; text-transform:uppercase; letter-spacing:0.5px">Días de Entrenamiento</h3>
        <p style="font-size:0.82rem; color:var(--text-gray)">Tocá un día para ver sus ejercicios</p>
      </div>

      ${rutina.dias.map((dia, idx) => `
        <div class="day-select-card" data-dia-id="${dia.id}">
          <div class="day-card-info">
            <div class="day-card-number">Día ${dia.diaNumero || (idx + 1)}</div>
            <div class="day-card-name">${dia.nombre}</div>
            <div style="font-size:0.8rem; color:var(--text-gray); margin-top:4px">
              💪 ${dia.ejercicios ? dia.ejercicios.length : 0} ejercicios programados
            </div>
          </div>
          <div class="day-card-arrow">➔</div>
        </div>
      `).join('')}
    `;
  }

  function renderDayDetailView(alumno) {
    const rutina = store.getRutinaPorId(appState.rutinaSeleccionadaId);
    if (!rutina) {
      appState.rutinaSeleccionadaId = null;
      appState.diaSeleccionadoId = null;
      return renderRoutinesListView(alumno);
    }

    const dia = rutina.dias.find(d => d.id === appState.diaSeleccionadoId);
    if (!dia) {
      appState.diaSeleccionadoId = null;
      return renderRoutineDaysView(alumno);
    }

    return `
      <button class="nav-breadcrumb-btn" id="btnBackToDays">⬅️ Volver a Días de la Rutina</button>

      <div style="margin-bottom:20px; background:var(--bg-card); border:1px solid var(--border-color); border-radius:var(--radius-md); padding:18px">
        <span class="badge badge-warning" style="margin-bottom:6px">DÍA ${dia.diaNumero || 1} DE ENTRENAMIENTO</span>
        <h2 style="font-size:1.4rem; font-weight:900; color:#fff">${dia.nombre}</h2>
        <div style="font-size:0.85rem; color:var(--text-gray); margin-top:4px">Rutina: ${rutina.titulo}</div>
      </div>

      <h3 style="font-size:1.05rem; font-weight:900; text-transform:uppercase; margin-bottom:14px; color:var(--text-white)">
        📋 Ejercicios e Indicaciones del Profesor
      </h3>

      ${dia.ejercicios.map(ej => `
        <div class="exercise-block">
          <div style="font-size:1.15rem; font-weight:900; color:#fff; margin-bottom:8px">${ej.nombre}</div>

          <div class="target-box">
            <div class="target-title">🎯 Objetivo Indicado por el Profesor:</div>
            <div class="target-stats">
              ${ej.seriesTarget} series × ${ej.repeticionesTarget} reps · ${ej.pesoSugerido}
            </div>
            ${ej.notaProfesor ? `
              <div style="font-size:0.85rem; color:#fca5a5; margin-top:6px; border-top:1px dashed rgba(255,255,255,0.1); padding-top:6px">
                👨‍🏫 <strong>${ej.profesorNotaAutor || 'Profesor'}:</strong> "${ej.notaProfesor}"
              </div>
            ` : ''}
          </div>
          ${ej.videoUrl ? `<a href="${ej.videoUrl}" target="_blank" rel="noopener noreferrer" class="btn-video-demo">🎬 Ver ejercicio</a>` : ''}
        </div>
      `).join('')}

      <button class="btn btn-primary btn-comenzar-entrenamiento" data-dia-id="${dia.id}" style="width:100%; padding:18px; font-size:1.15rem; font-weight:900; margin-top:10px; box-shadow: 0 0 35px rgba(255, 46, 46, 0.45)">
        ▶ EMPEZAR ENTRENAMIENTO
      </button>
    `;
  }

  // MODULO DE ENTRENAMIENTO EN VIVO: REGISTRO DE SERIES (OBJETIVO VS REAL)

  // --- BORRADOR DE ENTRENAMIENTO EN CURSO: persistencia local anti-pérdida ---
  // Clave INDEPENDIENTE de estudio_fitness_db_v4 (el store global) y de
  // cualquier copia de alumnos/profesores — acá SOLO vive el entrenamiento
  // que el alumno está completando en este momento, y únicamente mientras
  // lo está completando. No se toca syncWithSupabase() ni RLS para esto.
  const WORKOUT_DRAFT_KEY = 'estudio_fitness_draft_v4';

  function getCurrentAlumnoId() {
    return (appState.usuarioActual && appState.usuarioActual.rol === 'alumno' && appState.usuarioActual.data)
      ? appState.usuarioActual.data.id
      : null;
  }

  // Guarda el borrador completo (día activo + series + comentario) cada vez
  // que cambia algo. Se etiqueta con ownerId = alumno.id logueado en ESE
  // momento, para poder verificar más tarde que el borrador le pertenece a
  // quien lo está por recuperar.
  function persistWorkoutDraft() {
    const alumnoId = getCurrentAlumnoId();
    if (!alumnoId || !appState.diaActivoEntrenamiento) return;
    try {
      const draft = {
        ownerId: alumnoId,
        rutinaSeleccionadaId: appState.rutinaSeleccionadaId || null,
        tabCliente: appState.tabCliente,
        diaActivoEntrenamiento: appState.diaActivoEntrenamiento,
        workoutDraftSets: appState.workoutDraftSets,
        workoutGeneralComment: appState.workoutGeneralComment || '',
        savedAt: new Date().toISOString()
      };
      localStorage.setItem(WORKOUT_DRAFT_KEY, JSON.stringify(draft));
    } catch (e) {
      console.warn('⚠️ No se pudo guardar el borrador de entrenamiento:', e);
    }
  }

  // Borra el borrador SOLO si pertenece al alumno actualmente logueado (o si
  // no hay forma de determinar dueño, por seguridad igual se borra al hacer
  // logout explícito — ver bindHeaderEvents). Nunca borra a ciegas el
  // borrador de otro usuario que todavía no volvió a entrar.
  function clearWorkoutDraft() {
    try { localStorage.removeItem(WORKOUT_DRAFT_KEY); } catch (e) {}
  }

  // Devuelve el borrador guardado ÚNICAMENTE si su ownerId coincide con el
  // alumno actualmente logueado. Si pertenece a otro alumno (por ejemplo,
  // otro usuario que entrenó antes en este mismo dispositivo y no llegó a
  // terminar), se ignora por completo — nunca se muestra ni se borra el
  // borrador ajeno, así el dueño real todavía puede recuperarlo cuando
  // vuelva a loguearse él.
  function getBorradorPropio() {
    try {
      const raw = localStorage.getItem(WORKOUT_DRAFT_KEY);
      if (!raw) return null;
      const draft = JSON.parse(raw);
      const alumnoId = getCurrentAlumnoId();
      if (!alumnoId || !draft || draft.ownerId !== alumnoId) return null;
      return draft;
    } catch (e) {
      return null;
    }
  }

  function initWorkoutDraft(diaObj) {
    appState.workoutDraftSets = {};
    appState.workoutGeneralComment = '';
    diaObj.ejercicios.forEach(ej => {
      appState.workoutDraftSets[ej.id] = {
        nombre: ej.nombre,
        sets: Array.from({ length: ej.seriesTarget }, (_, i) => ({
          setNumero: i + 1,
          reps: ej.repeticionesTarget.includes('-') ? Number(ej.repeticionesTarget.split('-')[0]) : (Number(ej.repeticionesTarget) || 10),
          peso: ej.pesoSugerido,
          comentarioSet: ''
        }))
      };
    });
    // Guarda inmediatamente el borrador recién iniciado (antes de que el
    // alumno edite nada), para cubrir el caso de que la app se cierre
    // apenas empezado el entrenamiento.
    persistWorkoutDraft();
  }

  function renderWorkoutSession() {
    const dia = appState.diaActivoEntrenamiento;
    if (!dia) return '';

    return `
      <div class="workout-session-container">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px">
          <div>
            <span class="badge badge-warning">▶ EN PROGRESO</span>
            <h2 style="font-size:1.4rem; font-weight:900; margin-top:4px">${dia.nombre}</h2>
          </div>
          <button class="btn btn-secondary btn-sm" id="btnCancelWorkout">Cancelar ✖</button>
        </div>

        ${dia.ejercicios.map(ej => {
          const draftEj = appState.workoutDraftSets[ej.id];
          return `
            <div class="exercise-block">
              <div class="exercise-title" style="font-size:1.15rem; font-weight:900; color:#fff">${ej.nombre}</div>

              <div class="target-box">
                <div class="target-title">🎯 OBJETIVO DEL PROFESOR</div>
                <div class="target-stats">${ej.seriesTarget} series · ${ej.repeticionesTarget} reps · ${ej.pesoSugerido}</div>
                ${ej.notaProfesor ? `<div style="font-size:0.85rem; color:#fca5a5; margin-top:4px">👨‍🏫 ${ej.notaProfesor}</div>` : ''}
              </div>
              ${ej.videoUrl ? `<a href="${ej.videoUrl}" target="_blank" rel="noopener noreferrer" class="btn-video-demo">🎬 Ver ejercicio</a>` : ''}

              <h4 style="font-size:0.8rem; text-transform:uppercase; color:var(--text-gray); margin-bottom:8px">✏️ REGISTRO REAL POR SERIE:</h4>

              <div class="sets-table-header">
                <div>SERIE</div>
                <div>REPS</div>
                <div>PESO</div>
                <div>COMENTARIO POR SERIE</div>
              </div>

              ${draftEj.sets.map((set, setIdx) => `
                <div class="set-row">
                  <div class="set-label">Serie ${set.setNumero}</div>
                  <div>
                    <input type="number" class="set-input" value="${set.reps}" onchange="window.updateDraftSet('${ej.id}', ${setIdx}, 'reps', this.value)">
                  </div>
                  <div>
                    <input type="text" class="set-input" value="${set.peso}" onchange="window.updateDraftSet('${ej.id}', ${setIdx}, 'peso', this.value)">
                  </div>
                  <div>
                    <input type="text" class="set-input set-comment-input" placeholder="Comentario..." value="${set.comentarioSet || ''}" onchange="window.updateDraftSet('${ej.id}', ${setIdx}, 'comentarioSet', this.value)">
                  </div>
                </div>
              `).join('')}
            </div>
          `;
        }).join('')}

        <div class="exercise-block" style="border-color:var(--border-highlight)">
          <label class="form-label" style="color:var(--red-primary)">💬 COMENTARIO GENERAL DEL ENTRENAMIENTO (OPCIONAL)</label>
          <textarea class="exercise-textarea" id="inputGeneralComment" placeholder="Escribe un comentario general sobre cómo te sentiste en la sesión..." onchange="window.updateGeneralComment(this.value)">${appState.workoutGeneralComment || ''}</textarea>
        </div>

        <button class="btn btn-primary" id="btnFinishWorkout" style="width:100%; padding:16px; font-size:1.1rem; margin-top:10px; box-shadow: 0 0 35px rgba(255, 46, 46, 0.45)">
          🏆 FINALIZAR Y GUARDAR ENTRENAMIENTO
        </button>
      </div>
    `;
  }

  window.updateDraftSet = (ejId, setIdx, field, val) => {
    if (appState.workoutDraftSets[ejId]) {
      appState.workoutDraftSets[ejId].sets[setIdx][field] = field === 'reps' ? Number(val) : val;
      persistWorkoutDraft();
    }
  };

  window.updateGeneralComment = (val) => {
    appState.workoutGeneralComment = val;
    persistWorkoutDraft();
  };

  // Extrae el día calendario (YYYY-MM-DD) de un ISO string usando la ZONA HORARIA LOCAL
  // del navegador, NO UTC. log.fecha se guarda como new Date().toISOString() (ej. "2026-08-12T23:30:00.000Z"),
  // y usar toISOString().slice(0,10) para agrupar desplazaría al día siguiente cualquier
  // entrenamiento hecho entre las 21:00 y las 23:59 hora Argentina (UTC-3). No modifica el
  // formato almacenado en Supabase, solo cómo se interpreta acá para contar días.
  function getFechaCalendarioLocal(fechaISO) {
    const d = new Date(fechaISO);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  // --- HISTORIAL AGRUPADO: Rutina → Semana → Día → Ejercicios → Series ---
  // permitirEdicion: SOLO true cuando el alumno ve su PROPIO historial
  // (renderClientDashboard). El historial que el profesor ve de un alumno
  // (renderModalHistorialAlumno) llama esta misma función sin el flag,
  // así que nunca muestra el botón "Editar entrenamiento" — esa edición es
  // exclusiva del alumno dueño del registro, dentro de la ventana de 2hs.
  function renderHistorialAgrupado(logs, rutinas, permitirEdicion = false) {
    if (!logs || logs.length === 0) {
      return `<div style="text-align:center; color:var(--text-gray); padding:40px 20px">
        <div style="font-size:2.5rem; margin-bottom:10px">📜</div>
        <div style="font-size:1rem; font-weight:700">Aún no hay entrenamientos registrados.</div>
        <div style="font-size:0.85rem; margin-top:6px">Completa una sesión para ver tu historial aquí.</div>
      </div>`;
    }

    // Agrupar: rutinaId → semana → día
    const grouped = {};
    logs.forEach(log => {
      const rId = log.rutinaId || 'sin-rutina';
      if (!grouped[rId]) {
        const rutina = rutinas ? rutinas.find(r => r.id === rId) : null;
        grouped[rId] = {
          titulo: log.rutinaT || (rutina ? rutina.titulo : 'Rutina'),
          fechaInicio: rutina ? rutina.fechaInicio : null,
          duracionDias: rutina ? (rutina.duracionDias || 30) : 30,
          semanas: {}
        };
      }
      const g = grouped[rId];

      // Calcular semana relativa a la fecha de inicio de la rutina
      let semana = log.semana || 1;
      if (!log.semana && g.fechaInicio && log.fecha) {
        const diffDays = Math.floor(
          (new Date(log.fecha) - new Date(g.fechaInicio)) / 86400000
        );
        semana = Math.max(1, Math.ceil((diffDays + 1) / 7));
      }

      if (!g.semanas[semana]) g.semanas[semana] = {};
      const diaKey = String(log.diaNumero || log.diaNombre || 1);
      if (!g.semanas[semana][diaKey]) g.semanas[semana][diaKey] = [];
      g.semanas[semana][diaKey].push(log);
    });

    return `<div style="max-width:800px; margin:0 auto">
      ${Object.entries(grouped).map(([rId, g]) => {
        const totalSemanas = Math.max(1, Math.ceil(g.duracionDias / 7));
        const semanasOrdenadas = Object.keys(g.semanas).map(Number).sort((a, b) => a - b);

        return `
        <div style="margin-bottom:28px">
          <div style="display:flex; align-items:center; gap:10px; margin-bottom:14px; padding:12px 16px;
                      background:rgba(255,46,46,0.08); border-radius:10px; border-left:4px solid var(--red-primary)">
            <div style="font-size:1.3rem">💪</div>
            <div>
              <div style="font-size:1.1rem; font-weight:900; color:#fff">${g.titulo}</div>
              <div style="font-size:0.78rem; color:var(--text-gray)">${totalSemanas} semanas · ${g.duracionDias} días
                ${g.fechaInicio ? ' · Inicio: ' + new Date(g.fechaInicio).toLocaleDateString('es-AR') : ''}
              </div>
            </div>
          </div>

          ${Array.from({ length: totalSemanas }, (_, i) => i + 1).map(numSemana => {
            const diasEsaSemana = g.semanas[numSemana];
            const tieneRegistros = diasEsaSemana && Object.keys(diasEsaSemana).length > 0;

            // logsEsaSemana = TODOS los workout_logs de la semana, sin importar bajo qué diaNumero quedaron agrupados
            const logsEsaSemana = tieneRegistros ? Object.values(diasEsaSemana).flat() : [];

            // "día" = fecha calendario única (zona horaria local), NO diaNumero de rutina
            const fechasUnicas = new Set(logsEsaSemana.map(l => getFechaCalendarioLocal(l.fecha)));
            const totalDiasCalendario = fechasUnicas.size;

            // "entrenamiento" = un workout_log, sin agrupar
            const totalEntrenamientos = logsEsaSemana.length;

            const resumenSemana = totalDiasCalendario === totalEntrenamientos
              ? `${totalDiasCalendario} ${totalDiasCalendario === 1 ? 'día' : 'días'}`
              : `${totalDiasCalendario} ${totalDiasCalendario === 1 ? 'día' : 'días'} · ${totalEntrenamientos} entrenamientos`;

            return `
            <div style="margin-bottom:12px">
              <div class="history-accordion-header" data-acc-id="acc-s${numSemana}-${rId.slice(0,8)}"
                   style="display:flex; justify-content:space-between; align-items:center;
                          background:rgba(255,255,255,0.04); border:1px solid var(--border-color);
                          padding:10px 14px; border-radius:8px; cursor:pointer; user-select:none">
                <span style="font-weight:800; font-size:0.95rem">📅 Semana ${numSemana}</span>
                <span style="color:var(--text-gray); font-size:0.8rem">
                  ${tieneRegistros ? resumenSemana : 'Sin registros'} ▼
                </span>
              </div>

              <div class="history-accordion-body" id="acc-s${numSemana}-${rId.slice(0,8)}"
                   style="display:none; padding:10px 0 0">
                ${!tieneRegistros
                  ? `<div style="text-align:center; color:var(--text-gray); font-size:0.82rem; padding:12px">
                       Sin entrenamientos registrados esta semana.
                     </div>`
                  : Object.entries(diasEsaSemana).map(([diaKey, diaLogs]) => {
                      return diaLogs.map(log => `
                      <div class="history-item-card" style="margin-bottom:10px; border-left:3px solid var(--border-highlight)">
                        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px">
                          <div>
                            <strong style="color:var(--green-active); font-size:1rem">✓ ${log.diaNombre}</strong>
                            <div style="font-size:0.75rem; color:var(--text-gray)">
                              ${new Date(log.fecha).toLocaleString('es-AR', { weekday:'short', day:'numeric', month:'short', hour:'2-digit', minute:'2-digit' })}
                            </div>
                          </div>
                          <div style="display:flex; align-items:center; gap:8px">
                            <span class="badge badge-active">Completado</span>
                            ${permitirEdicion && store.puedeEditarseEntrenamiento(log) ? `
                              <button class="btn btn-secondary btn-sm btn-editar-entrenamiento-click" data-log-id="${log.id}" style="border-color:var(--yellow-warning); color:var(--yellow-warning); padding:4px 10px; font-size:0.75rem">✏️ Editar entrenamiento</button>
                            ` : ''}
                          </div>
                        </div>

                        ${log.comentarioGeneral ? `
                          <div style="background:rgba(255,46,46,0.08); border-left:3px solid var(--red-primary);
                                      padding:7px 12px; border-radius:0 6px 6px 0; margin-bottom:8px; font-size:0.82rem">
                            💬 <strong>Comentario general:</strong> "${log.comentarioGeneral}"
                          </div>` : ''}

                        <div style="border-top:1px solid var(--border-color); padding-top:8px">
                          ${(() => {
                            // Agrupar series por ejercicio
                            const ejMap = {};
                            (log.sets || []).forEach(s => {
                              const key = s.ejercicioNombre;
                              if (!ejMap[key]) ejMap[key] = [];
                              ejMap[key].push(s);
                            });
                            return Object.entries(ejMap).map(([ejNombre, sets]) => `
                              <div style="margin-bottom:8px">
                                <div style="font-size:0.88rem; font-weight:800; color:#fff; margin-bottom:4px">
                                  🏋️ ${ejNombre}
                                </div>
                                ${sets.map(s => `
                                  <div style="font-size:0.82rem; background:rgba(0,0,0,0.3);
                                              padding:5px 10px; border-radius:6px; margin-bottom:3px">
                                    Serie ${s.setNumero}: <strong>${s.repsRealizadas} reps</strong>
                                    con <strong>${s.pesoUtilizado}</strong>
                                    ${s.comentarioAlumno ? `<span style="color:var(--yellow-warning)">
                                      · 💬 "${s.comentarioAlumno}"</span>` : ''}
                                  </div>`).join('')}
                              </div>`).join('');
                          })()}
                        </div>
                      </div>
                      `).join('');
                    }).join('')
                }
              </div>
            </div>`;
          }).join('')}
        </div>`;
      }).join('')}
    </div>`;
  }

  // --- DASHBOARD PROFESOR ---
  function renderTrainerDashboard() {
    const alumnosFiltrados = store.getAlumnosFiltrados({
      busqueda: appState.busquedaProfesor,
      filtro: appState.filtroProfesor
    });

    const totalAlumnos = store.data.alumnos.length;
    const conRutina = store.data.alumnos.filter(a => store.getRutinaActiva(a.id)).length;
    const porVencer = store.getAlumnosFiltrados({ filtro: 'por_vencer' }).length;
    const sinRutina = totalAlumnos - conRutina;

    appContainer.innerHTML = `
      ${renderHeader()}

      <main class="trainer-dashboard">
        <div class="stats-grid">
          <div class="stat-card"><div class="val">${totalAlumnos}</div><div class="label">Alumnos</div></div>
          <div class="stat-card"><div class="val" style="color:var(--green-active)">${conRutina}</div><div class="label">Rutinas Activas</div></div>
          <div class="stat-card"><div class="val" style="color:var(--yellow-warning)">${porVencer}</div><div class="label">Por Vencer 24h</div></div>
          <div class="stat-card"><div class="val" style="color:var(--red-primary)">${sinRutina}</div><div class="label">Sin Rutina</div></div>
        </div>

        <div class="toolbar-section">
          <div class="search-box">
            <input type="text" id="inputSearchProf" class="form-input" placeholder="🔎 Buscar por Nombre o DNI..." value="${appState.busquedaProfesor}">
          </div>

          <div class="filter-buttons">
            <button class="btn btn-secondary btn-sm ${appState.filtroProfesor === 'todos' ? 'active' : ''}" id="fTodos">Todos (${totalAlumnos})</button>
            <button class="btn btn-secondary btn-sm ${appState.filtroProfesor === 'activa' ? 'active' : ''}" id="fActiva">Activas (${conRutina})</button>
            <button class="btn btn-secondary btn-sm ${appState.filtroProfesor === 'por_vencer' ? 'active' : ''}" id="fVencer">Por Vencer ⏰ (${porVencer})</button>
            <button class="btn btn-secondary btn-sm ${appState.filtroProfesor === 'expirada' ? 'active' : ''}" id="fSinRutina">Sin Rutina ⚠️ (${sinRutina})</button>
          </div>

          <button class="btn btn-primary" id="btnOpenNuevoAlumno">+ Registrar Nuevo Alumno 👤</button>
        </div>

        <div class="alumnos-grid">
          ${alumnosFiltrados.map(alumno => {
            const rutinasAlumno = store.getRutinasAlumno(alumno.id);
            const rutinaActiva = store.getRutinaActiva(alumno.id);
            const dRest = rutinaActiva ? store.calcularDiasRestantes(rutinaActiva.fechaVencimiento) : -1;

            let badgeHtml = `<span class="badge badge-expired">Sin Rutina</span>`;
            if (rutinaActiva) {
              if (dRest <= 1 && dRest >= 0) badgeHtml = `<span class="badge badge-warning">⏰ Vence en ${dRest}d</span>`;
              else if (dRest > 1) badgeHtml = `<span class="badge badge-active">● Activa (${dRest}d)</span>`;
            }

            return `
              <div class="alumno-card-clickable" data-alumno-id="${alumno.id}">
                <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:10px">
                  <div>
                    <div style="display:flex; align-items:center; gap:6px;">
                      <span style="font-size:1.15rem; font-weight:800">${alumno.nombreProfesor || alumno.nombre}</span>
                      <button class="btn-edit-nombre" data-dni="${alumno.dni}" title="Editar apodo"
                              style="background:none; border:none; cursor:pointer; font-size:1rem; padding:0; color:var(--text-gray)">✎</button>
                    </div>
                    <div style="font-size:0.85rem; color:var(--text-gray)">
                      DNI: ${alumno.dni} | 
                      <span style="color:${alumno.estadoAutorizacion === 'autorizado' ? 'var(--green-active)' : 'var(--yellow-warning)'}">
                        ${alumno.estadoAutorizacion === 'autorizado' ? 'Autorizado' : 'Pendiente'}
                      </span>
                    </div>
                  </div>
                  ${badgeHtml}
                </div>

                <div style="background:rgba(0,0,0,0.3); padding:10px; border-radius:8px; font-size:0.85rem; color:var(--text-gray); margin-bottom:12px">
                  ${rutinasAlumno.length > 0 ? rutinasAlumno.map(r => {
                    const estaDesactivada = r.estado === 'desactivada';
                    return `
                    <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid rgba(255,255,255,0.06); padding:6px 0; gap:8px; flex-wrap:wrap">
                      <div>
                        <div style="color:#fff; font-weight:700">💪 ${r.titulo} ${estaDesactivada ? '<span class="badge badge-role" style="margin-left:4px">Desactivada</span>' : ''}</div>
                        <div style="font-size:0.72rem; color:var(--text-muted)">Vence: ${r.fechaVencimiento} | ${r.dias ? r.dias.length : 0} días</div>
                      </div>
                      <div style="display:flex; gap:6px; flex-wrap:wrap">
                        <button class="btn btn-secondary btn-sm btn-editar-rutina-click" data-alumno-id="${alumno.id}" data-rutina-id="${r.id}" style="border-color:var(--yellow-warning); color:var(--yellow-warning); padding:4px 10px; font-size:0.78rem">✏️ Editar</button>
                        <button class="btn btn-secondary btn-sm btn-toggle-estado-rutina-click" data-alumno-id="${alumno.id}" data-rutina-id="${r.id}" data-estado-actual="${r.estado}" style="border-color:var(--blue-info,#3b82f6); color:var(--blue-info,#3b82f6); padding:4px 10px; font-size:0.78rem">
                          ${estaDesactivada ? '▶️ Activar' : '⏸️ Desactivar'}
                        </button>
                        <button class="btn btn-secondary btn-sm btn-borrar-rutina-click" data-alumno-id="${alumno.id}" data-rutina-id="${r.id}" style="border-color:var(--red-primary); color:var(--red-primary); padding:4px 10px; font-size:0.78rem">🗑️ Borrar</button>
                      </div>
                    </div>
                  `;
                  }).join('') : `
                    <div>⚠️ Sin rutinas creadas aún.</div>
                  `}
                </div>

                <div style="display:flex; flex-wrap:wrap; gap:8px">
                  <button class="btn btn-primary btn-sm btn-crear-rutina-click" data-alumno-id="${alumno.id}">+ Crear Nueva Rutina</button>
                  <button class="btn btn-secondary btn-sm btn-historial-click" data-alumno-id="${alumno.id}">📜 Historial Real</button>
                </div>
              </div>
            `;
          }).join('')}
        </div>
      </main>

      ${appState.modalActivo === 'nuevo_alumno' ? renderModalNuevoAlumno() : ''}
      ${(appState.modalActivo === 'crear_rutina' || appState.modalActivo === 'editar_rutina') ? renderModalFormularioRutina(appState.modalActivo) : ''}
      ${appState.modalActivo === 'historial_alumno' ? renderModalHistorialAlumno() : ''}
      ${appState.modalActivo === 'confirmar_borrado_rutina' ? renderModalConfirmarBorradoRutina() : ''}

      ${renderBottomNav()}
    `;

    bindHeaderEvents();
    bindInstallBannerEvents();
    bindBottomNavEvents();

    const inputSearch = document.getElementById('inputSearchProf');
    inputSearch?.addEventListener('input', (e) => {
      appState.busquedaProfesor = e.target.value;
      renderApp();
      document.getElementById('inputSearchProf').focus();
    });

    document.getElementById('fTodos')?.addEventListener('click', () => { appState.filtroProfesor = 'todos'; renderApp(); });
    document.getElementById('fActiva')?.addEventListener('click', () => { appState.filtroProfesor = 'activa'; renderApp(); });
    document.getElementById('fVencer')?.addEventListener('click', () => { appState.filtroProfesor = 'por_vencer'; renderApp(); });
    document.getElementById('fSinRutina')?.addEventListener('click', () => { appState.filtroProfesor = 'expirada'; renderApp(); });

    document.getElementById('btnOpenNuevoAlumno')?.addEventListener('click', () => {
      appState.modalActivo = 'nuevo_alumno';
      renderApp();
    });

    document.querySelectorAll('.alumno-card-clickable').forEach(card => {
      card.addEventListener('click', async (e) => {
        const alumnoId = card.dataset.alumnoId;

console.log("========== DEBUG SELECCIÓN ==========");
console.log("CARD TEXT:", card.innerText);
console.log("DATASET ID:", card.dataset.alumnoId);

const alumnoDebug = store.getAlumnoPorId(card.dataset.alumnoId);

console.log("ALUMNO RESUELTO:", {
    id: alumnoDebug?.id,
    dni: alumnoDebug?.dni,
    nombre: alumnoDebug?.nombre,
    apodo: alumnoDebug?.nombreApodoProfesor
});

console.log("====================================");
        // Antes de mostrar/editar el detalle o la rutina de este alumno,
        // refrescamos su estado desde Supabase (fuente de verdad) para no
        // confiar en la copia local del profesor, que puede estar desactualizada.
        await store.syncWithSupabase(alumnoId);
        if (e.target.classList.contains('btn-historial-click')) {
          e.stopPropagation();
          // Se invalida el caché en cada apertura del historial (no solo al cambiar de alumno)
          // para que el profesor siempre vea los registros más recientes desde Supabase.
          appState.historialProfesorLogs = null;
          appState.alumnoSeleccionadoId = alumnoId;
          appState.modalActivo = 'historial_alumno';
          renderApp();
        } else if (e.target.classList.contains('btn-editar-rutina-click')) {
          e.stopPropagation();
          appState.alumnoSeleccionadoId = alumnoId;
          appState.rutinaEnEdicionId = e.target.dataset.rutinaId;
          appState.modalActivo = 'editar_rutina';
          initFormBuilderForRoutine(appState.rutinaEnEdicionId);
          renderApp();
        } else if (e.target.classList.contains('btn-crear-rutina-click')) {
          e.stopPropagation();
          appState.alumnoSeleccionadoId = alumnoId;
          appState.rutinaEnEdicionId = null;
          appState.modalActivo = 'crear_rutina';
          initFormBuilderForNew();
          renderApp();
        } else if (e.target.classList.contains('btn-toggle-estado-rutina-click')) {
          e.stopPropagation();
          const rId = e.target.dataset.rutinaId;
          const estadoActual = e.target.dataset.estadoActual;
          const nuevoEstado = estadoActual === 'desactivada' ? 'activa' : 'desactivada';
          const profesorId = window._sessionProfesorId || appState.usuarioActual.data.id;
          e.target.disabled = true;
          const resultado = await store.cambiarEstadoRutina(rId, profesorId, nuevoEstado);
          if (!resultado || resultado.ok !== true) {
            alert("❌ No se pudo cambiar el estado de la rutina: " + ((resultado && resultado.error) || "error desconocido"));
          }
          renderApp();
        } else if (e.target.classList.contains('btn-borrar-rutina-click')) {
          e.stopPropagation();
          appState.rutinaAEliminarId = e.target.dataset.rutinaId;
          appState.modalActivo = 'confirmar_borrado_rutina';
          renderApp();
        } else if (e.target.classList.contains('btn-edit-nombre')) {
          e.stopPropagation();
          const dniAlumno = e.target.dataset.dni;
          const alumnoActual = store.getAlumnoPorId(alumnoId);
          const nombreActual = (alumnoActual && (alumnoActual.nombreProfesor || alumnoActual.nombre)) || '';
          const nuevoNombre = prompt("Apodo para identificar a este alumno en tu panel:", nombreActual);
          if (nuevoNombre === null) return; // cancelado
          if (!nuevoNombre.trim()) {
            alert("El apodo no puede estar vacío.");
            return;
          }
          e.target.disabled = true;
          try {
            await store.editarNombreProfesor({ dni: dniAlumno, nuevoNombre: nuevoNombre.trim() });
          } catch (err) {
            alert("❌ No se pudo actualizar el apodo: " + err.message);
          }
          renderApp();
        } else {
          const rutina = store.getRutinaActiva(alumnoId);
          appState.alumnoSeleccionadoId = alumnoId;
          if (rutina) {
            appState.rutinaEnEdicionId = rutina.id;
            appState.modalActivo = 'editar_rutina';
            initFormBuilderForRoutine(rutina.id);
          } else {
            appState.rutinaEnEdicionId = null;
            appState.modalActivo = 'crear_rutina';
            initFormBuilderForNew();
          }
          renderApp();
        }
      });
    });

    bindAccordionEvents();
  }

  function renderModalNuevoAlumno() {
    return `
      <div class="modal-overlay">
        <div class="modal-content" style="max-width:440px">
          <div class="modal-header">
            <h3>👤 Registrar y Autorizar DNI</h3>
            <button class="close-btn" id="btnCloseModal">&times;</button>
          </div>
          <form id="formNuevoAlumno">
            <div class="form-group">
              <label class="form-label">DNI del Alumno *</label>
              <input type="text" id="newDni" class="form-input" placeholder="Ej: 55667788" required>
            </div>
            <div class="form-group">
              <label class="form-label">Nombre Completo *</label>
              <input type="text" id="newNombre" class="form-input" placeholder="Ej: Rodrigo Ruiz" required>
            </div>
            <div class="form-group">
              <label class="form-label">Teléfono (Opcional)</label>
              <input type="text" id="newTel" class="form-input" placeholder="Ej: 1122334455">
            </div>

            <div style="display:flex; justify-content:flex-end; gap:10px; margin-top:20px">
              <button type="button" class="btn btn-secondary" id="btnCancelModal">Cancelar</button>
              <button type="submit" class="btn btn-primary">Autorizar Alumno 💾</button>
            </div>
          </form>
        </div>
      </div>
    `;
  }

  function renderModalFormularioRutina(modo) {
    const esPropiaModo = modo === 'crear_rutina_propia' || modo === 'editar_rutina_propia';
    const esEdicion = modo === 'editar_rutina' || modo === 'editar_rutina_propia';
    const alumno = store.getAlumnoPorId(appState.alumnoSeleccionadoId);
    const rutinaExistente = esEdicion ? store.getRutinaPorId(appState.rutinaEnEdicionId) : null;

    const tituloModal = esPropiaModo
      ? (esEdicion ? '✏️ Editar Mi Rutina' : '📝 Crear Mi Rutina Propia')
      : `${esEdicion ? '✏️ Editar Rutina' : '📝 Asignar Nueva Rutina'} — ${alumno ? alumno.nombre : ''}`;

    return `
      <div class="modal-overlay">
        <div class="modal-content">
          <div class="modal-header">
            <h3>${tituloModal}</h3>
            <button class="close-btn" id="btnCloseModal">&times;</button>
          </div>

          <form id="formCrearRutina">
            <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap:12px">
              <div class="form-group">
                <label class="form-label">Título de la Rutina *</label>
                <input type="text" id="routineTitle" class="form-input" value="${rutinaExistente ? rutinaExistente.titulo : 'Fuerza e Hipertrofia'}" required>
              </div>
              <div class="form-group">
                <label class="form-label">Duración (Días) *</label>
                <input type="number" id="routineDuration" class="form-input" min="1" max="180" value="${rutinaExistente ? rutinaExistente.duracionDias : 30}" required>
              </div>
            </div>

            <div style="display:flex; justify-content:space-between; align-items:center; margin:16px 0 10px; border-top:1px solid var(--border-color); padding-top:14px">
              <h4 style="color:var(--red-primary); font-weight:900">Días de Entrenamiento y Ejercicios</h4>
              <button type="button" class="btn btn-secondary btn-sm" id="btnAddDay">+ Agregar Día</button>
            </div>

            <div id="daysContainer"></div>

            <div style="display:flex; justify-content:flex-end; gap:10px; margin-top:24px">
              <button type="button" class="btn btn-secondary" id="btnCancelModal">Cancelar</button>
              <button type="submit" class="btn btn-primary">
                ${esEdicion ? '💾 Guardar Cambios' : (esPropiaModo ? '🚀 Crear Mi Rutina' : '🚀 Asignar Nueva Rutina')}
              </button>
            </div>
          </form>
        </div>
      </div>
    `;
  }

  function renderModalHistorialAlumno() {
    const alumno = store.getAlumnoPorId(appState.alumnoSeleccionadoId);
    if (!alumno) return '';

    // Si no hay caché y Supabase está disponible, disparar fetch async
    if (appState.historialProfesorLogs === null && window.supabaseEngine && window._sessionProfesorId) {
      const alumnoId = alumno.id;
      const profesorId = window._sessionProfesorId;
      window.supabaseEngine.obtenerHistorialParaProfesor(alumnoId, profesorId)
        .then(sbLogs => {
          appState.historialProfesorLogs = sbLogs && sbLogs.length > 0
            ? sbLogs
            : store.getHistorialEntrenamientosReales(alumnoId); // fallback local
          window.dispatchEvent(new CustomEvent('gym_store_updated'));
        })
        .catch(() => {
          appState.historialProfesorLogs = store.getHistorialEntrenamientosReales(alumnoId);
          window.dispatchEvent(new CustomEvent('gym_store_updated'));
        });
    }

    const historialLogs = appState.historialProfesorLogs
      ?? store.getHistorialEntrenamientosReales(alumno.id);

    return `
      <div class="modal-overlay">
        <div class="modal-content">
          <div class="modal-header">
            <h3>📜 Historial: ${alumno.nombre}</h3>
            <button class="close-btn" id="btnCloseModal">&times;</button>
          </div>
          ${appState.historialProfesorLogs === null
            ? `<div style="text-align:center; padding:40px; color:var(--text-gray)">
                <div style="font-size:2rem; margin-bottom:8px">⏳</div>
                Cargando historial desde Supabase...
               </div>`
            : renderHistorialAgrupado(historialLogs, store.data.rutinas)
          }
        </div>
      </div>
    `;
  }

  function renderModalConfirmarBorradoRutina() {
    const rutina = store.getRutinaPorId(appState.rutinaAEliminarId);
    if (!rutina) return '';
    return `
      <div class="modal-overlay">
        <div class="modal-content" style="max-width:420px">
          <div class="modal-header">
            <h3>🗑️ Borrar Rutina</h3>
            <button class="close-btn" id="btnCloseModal">&times;</button>
          </div>
          <p style="color:var(--text-gray); font-size:0.92rem; line-height:1.5">
            ¿Seguro que querés borrar <strong style="color:#fff">"${rutina.titulo}"</strong>?
            Esta acción no se puede deshacer. El historial de entrenamientos ya guardado del alumno no se borra.
          </p>
          <div style="display:flex; justify-content:flex-end; gap:10px; margin-top:20px">
            <button type="button" class="btn btn-secondary" id="btnCancelModal">Cancelar</button>
            <button type="button" class="btn btn-primary" id="btnConfirmarBorradoRutina" style="background:var(--red-primary)">Sí, Borrar 🗑️</button>
          </div>
        </div>
      </div>
    `;
  }

  let currentFormDays = [];

  function initFormBuilderForNew() {
    currentFormDays = [
      {
        nombre: "Día 1: Pecho, Hombro y Tríceps",
        ejercicios: [
          { nombre: "Press Plano con Barra", series: 4, repeticiones: "10-12", peso: "60 kg", notaProfesor: "Controlar bajada", videoUrl: "" }
        ]
      }
    ];
  }

  function initFormBuilderForRoutine(rutinaId) {
    const rutina = store.getRutinaPorId(rutinaId);
    if (rutina && rutina.dias) {
      currentFormDays = rutina.dias.map(d => ({
        nombre: d.nombre,
        ejercicios: d.ejercicios.map(e => ({
          nombre: e.nombre,
          series: e.seriesTarget || 3,
          repeticiones: e.repeticionesTarget || "12",
          peso: e.pesoSugerido || "S/D",
          notaProfesor: e.notaProfesor || "",
          videoUrl: e.videoUrl || ""
        }))
      }));
    } else {
      initFormBuilderForNew();
    }
  }

  function setupRoutineFormBuilder() {
    renderFormDays();
    document.getElementById('btnAddDay')?.addEventListener('click', () => {
      currentFormDays.push({
        nombre: `Día ${currentFormDays.length + 1}: General`,
        ejercicios: [{ nombre: "Nuevo Ejercicio", series: 3, repeticiones: "12", peso: "10 kg", notaProfesor: "", videoUrl: "" }]
      });
      renderFormDays();
    });
  }

  function renderFormDays() {
    const container = document.getElementById('daysContainer');
    if (!container) return;

    container.innerHTML = currentFormDays.map((dia, diaIdx) => `
      <div style="background:rgba(0,0,0,0.5); border:1px solid var(--border-color); border-radius:var(--radius-sm); padding:14px; margin-bottom:14px">
        <div style="display:flex; justify-content:space-between; align-items:center; gap:6px; margin-bottom:10px; flex-wrap:wrap">
          <input type="text" class="form-input" value="${dia.nombre}" onchange="window.updateFormDayName(${diaIdx}, this.value)" style="font-weight:800; flex:1; min-width:140px">
          <div style="display:flex; gap:4px">
            <button type="button" class="btn btn-secondary btn-sm" onclick="window.moveFormDayUp(${diaIdx})" title="Subir Día" style="padding:4px 8px">⬆️</button>
            <button type="button" class="btn btn-secondary btn-sm" onclick="window.moveFormDayDown(${diaIdx})" title="Bajar Día" style="padding:4px 8px">⬇️</button>
            <button type="button" class="btn btn-secondary btn-sm" onclick="window.addFormExercise(${diaIdx})">+ Ejercicio</button>
            ${currentFormDays.length > 1 ? `<button type="button" class="btn btn-secondary btn-sm" onclick="window.removeFormDay(${diaIdx})" style="color:var(--red-primary); border-color:var(--red-primary); padding:4px 8px">🗑️</button>` : ''}
          </div>
        </div>

        ${dia.ejercicios.map((ej, ejIdx) => `
          <div style="background:rgba(255,255,255,0.03); border:1px solid var(--border-color); padding:10px; border-radius:8px; margin-bottom:8px">
            <div style="display:flex; justify-content:space-between; align-items:center; gap:6px; margin-bottom:6px">
              <div class="form-group" style="margin-bottom:0; flex:1">
                <label class="form-label" style="font-size:0.75rem">Nombre del Ejercicio</label>
                <input type="text" class="form-input" value="${ej.nombre}" onchange="window.updateFormExercise(${diaIdx}, ${ejIdx}, 'nombre', this.value)">
              </div>
              <div style="display:flex; gap:4px; margin-top:16px">
                <button type="button" class="btn btn-secondary btn-sm" onclick="window.moveFormExerciseUp(${diaIdx}, ${ejIdx})" style="padding:4px 6px" title="Subir Ejercicio">⬆️</button>
                <button type="button" class="btn btn-secondary btn-sm" onclick="window.moveFormExerciseDown(${diaIdx}, ${ejIdx})" style="padding:4px 6px" title="Bajar Ejercicio">⬇️</button>
                ${dia.ejercicios.length > 1 ? `<button type="button" class="btn btn-secondary btn-sm" onclick="window.removeFormExercise(${diaIdx}, ${ejIdx})" style="color:var(--red-primary); border-color:var(--red-primary); padding:4px 6px">🗑️</button>` : ''}
              </div>
            </div>

            <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(85px, 1fr)); gap:8px; margin-bottom:6px">
              <div class="form-group" style="margin-bottom:0">
                <label class="form-label" style="font-size:0.72rem">Series Objetivo</label>
                <input type="number" class="form-input" value="${ej.series}" onchange="window.updateFormExercise(${diaIdx}, ${ejIdx}, 'series', this.value)">
              </div>
              <div class="form-group" style="margin-bottom:0">
                <label class="form-label" style="font-size:0.72rem">Reps Objetivo</label>
                <input type="text" class="form-input" value="${ej.repeticiones}" onchange="window.updateFormExercise(${diaIdx}, ${ejIdx}, 'repeticiones', this.value)">
              </div>
              <div class="form-group" style="margin-bottom:0">
                <label class="form-label" style="font-size:0.72rem">Peso Sugerido</label>
                <input type="text" class="form-input" value="${ej.peso}" onchange="window.updateFormExercise(${diaIdx}, ${ejIdx}, 'peso', this.value)">
              </div>
            </div>

            <div class="form-group" style="margin-bottom:0">
              <label class="form-label" style="font-size:0.72rem">Indicación / Nota del Profesor</label>
              <input type="text" class="form-input" placeholder="Ej: Controlar 2 seg de bajada" value="${ej.notaProfesor || ''}" onchange="window.updateFormExercise(${diaIdx}, ${ejIdx}, 'notaProfesor', this.value)">
            </div>

            <div class="form-group" style="margin-bottom:0; margin-top:6px">
              <label class="form-label" style="font-size:0.72rem">🎬 URL de Video/Demo (Opcional)</label>
              <input type="url" class="form-input" placeholder="https://youtube.com/..." value="${ej.videoUrl || ''}" onchange="window.updateFormExercise(${diaIdx}, ${ejIdx}, 'videoUrl', this.value)">
            </div>
          </div>
        `).join('')}
      </div>
    `).join('');
  }

  window.updateFormDayName = (diaIdx, val) => { currentFormDays[diaIdx].nombre = val; };
  window.addFormExercise = (diaIdx) => {
    currentFormDays[diaIdx].ejercicios.push({ nombre: "Nuevo Ejercicio", series: 3, repeticiones: "12", peso: "10 kg", notaProfesor: "", videoUrl: "" });
    renderFormDays();
  };
  window.removeFormExercise = (diaIdx, ejIdx) => {
    currentFormDays[diaIdx].ejercicios.splice(ejIdx, 1);
    renderFormDays();
  };
  window.removeFormDay = (diaIdx) => {
    currentFormDays.splice(diaIdx, 1);
    renderFormDays();
  };
  window.moveFormDayUp = (diaIdx) => {
    if (diaIdx > 0) {
      const temp = currentFormDays[diaIdx];
      currentFormDays[diaIdx] = currentFormDays[diaIdx - 1];
      currentFormDays[diaIdx - 1] = temp;
      renderFormDays();
    }
  };
  window.moveFormDayDown = (diaIdx) => {
    if (diaIdx < currentFormDays.length - 1) {
      const temp = currentFormDays[diaIdx];
      currentFormDays[diaIdx] = currentFormDays[diaIdx + 1];
      currentFormDays[diaIdx + 1] = temp;
      renderFormDays();
    }
  };
  window.moveFormExerciseUp = (diaIdx, ejIdx) => {
    if (ejIdx > 0) {
      const ejs = currentFormDays[diaIdx].ejercicios;
      const temp = ejs[ejIdx];
      ejs[ejIdx] = ejs[ejIdx - 1];
      ejs[ejIdx - 1] = temp;
      renderFormDays();
    }
  };
  window.moveFormExerciseDown = (diaIdx, ejIdx) => {
    const ejs = currentFormDays[diaIdx].ejercicios;
    if (ejIdx < ejs.length - 1) {
      const temp = ejs[ejIdx];
      ejs[ejIdx] = ejs[ejIdx + 1];
      ejs[ejIdx + 1] = temp;
      renderFormDays();
    }
  };
  window.updateFormExercise = (diaIdx, ejIdx, field, val) => {
    currentFormDays[diaIdx].ejercicios[ejIdx][field] = val;
  };

  async function saveRoutineFromForm() {
    const titulo = document.getElementById('routineTitle').value;
    const duracion = document.getElementById('routineDuration').value;
    const usuarioActualData = appState.usuarioActual.data;
    const esModoAlumnoPropio = appState.modalActivo === 'crear_rutina_propia' || appState.modalActivo === 'editar_rutina_propia';

    const formattedDays = currentFormDays.map((d, dIdx) => ({
      id: crypto.randomUUID(),
      diaNumero: dIdx + 1,
      nombre: d.nombre,
      ejercicios: d.ejercicios.map((e, idx) => ({
        id: crypto.randomUUID(),
        nombre: e.nombre,
        seriesTarget: Number(e.series) || 3,
        repeticionesTarget: e.repeticiones || "12",
        pesoSugerido: e.peso || "S/D",
        notaProfesor: e.notaProfesor || "",
        profesorNotaAutor: esModoAlumnoPropio ? `${usuarioActualData.nombre} (vos)` : usuarioActualData.nombre,
        videoUrl: e.videoUrl || ""
      }))
    }));

    if (esModoAlumnoPropio) {
      try {
        if (appState.modalActivo === 'editar_rutina_propia' && appState.rutinaEnEdicionId) {
          store.editarRutinaPropia({
            rutinaId: appState.rutinaEnEdicionId,
            alumnoId: usuarioActualData.id,
            titulo,
            duracionDias: duracion,
            dias: formattedDays
          });
          alert("✅ Rutina propia actualizada correctamente.");
        } else {
          store.crearRutinaPropia({
            alumnoId: usuarioActualData.id,
            titulo,
            duracionDias: duracion,
            dias: formattedDays
          });
          alert("🚀 ¡Rutina propia creada! Ya podés empezar a entrenarla desde \"Mías\".");
        }
      } catch (err) {
        alert("❌ Error: " + err.message);
      }
    } else if (appState.modalActivo === 'editar_rutina' && appState.rutinaEnEdicionId) {
      const resultado = await store.editarRutinaExistente({
        rutinaId: appState.rutinaEnEdicionId,
        profesorNombre: usuarioActualData.nombre,
        titulo,
        duracionDias: duracion,
        dias: formattedDays
      });
      if (resultado && resultado.ok) {
        alert("✅ Rutina actualizada correctamente. El alumno recibirá una notificación con los cambios.");
      } else {
        alert("❌ No se pudo guardar la rutina: " + ((resultado && resultado.error) || "error desconocido") + ". Los cambios no se aplicaron, probá de nuevo.");
      }
    } else {
      store.crearOActualizarRutina({
        alumnoId: appState.alumnoSeleccionadoId,
        profesorNombre: usuarioActualData.nombre,
        titulo,
        duracionDias: duracion,
        dias: formattedDays
      });
      alert("🚀 Nueva rutina asignada y activada correctamente.");
    }

    appState.modalActivo = null;
    appState.rutinaEnEdicionId = null;
    renderApp();
  }

  // Convierte la VAPID public key (base64url) al Uint8Array que exige
  // pushManager.subscribe(). Esta función se invocaba en bindHeaderEvents
  // pero no existía en ningún archivo del proyecto: cualquier dispositivo
  // que no tuviera ya una suscripción guardada en el navegador (típicamente
  // un dispositivo nuevo, como el celular de mamá) disparaba un
  // ReferenceError silencioso, atrapado por el catch(), que mostraba el
  // alert de "activadas" sin haber guardado ninguna suscripción real.
  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = window.atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) {
      outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
  }

  function toggleNotifDrawer() {
    appState.mostrarDrawerNotifs = !appState.mostrarDrawerNotifs;
    if (appState.usuarioActual) {
      store.marcarNotificacionesLeidas(
        appState.usuarioActual.rol,
        appState.usuarioActual.rol === 'alumno' ? appState.usuarioActual.data.id : null
      );
    }
    renderApp();
  }

  function bindBottomNavEvents() {
    document.getElementById('navRutina')?.addEventListener('click', async () => {
      appState.tabCliente = 'rutina';
      appState.diaActivoEntrenamiento = null;
      appState.rutinaSeleccionadaId = null;
      appState.diaSeleccionadoId = null;
      appState.mostrarDrawerNotifs = false;
      renderApp(); // feedback visual inmediato de cambio de tab

      // PWA / Bottom Nav: al tocar "Rutinas" forzamos la reobtención fresca
      // desde Supabase para que el alumno siempre vea la última versión.
      if (appState.usuarioActual?.rol === 'alumno' && window.gymStore) {
        await window.gymStore.forceRefreshRutinas(appState.usuarioActual.data.id);
      }
    });

    document.getElementById('navMisRutinas')?.addEventListener('click', () => {
      appState.tabCliente = 'mis_rutinas';
      appState.diaActivoEntrenamiento = null;
      appState.rutinaSeleccionadaId = null;
      appState.diaSeleccionadoId = null;
      appState.mostrarDrawerNotifs = false;
      renderApp();
    });

    document.getElementById('navRanking')?.addEventListener('click', async () => {
      appState.tabCliente = 'ranking';
      appState.mostrarDrawerNotifs = false;

      if (appState.usuarioActual?.rol === 'alumno' && window.gymStore) {
        await window.gymStore.syncWithSupabase(appState.usuarioActual.data.id);
      }

      renderApp();
    });

    document.getElementById('navHistorial')?.addEventListener('click', () => {
      appState.tabCliente = 'historial';
      appState.mostrarDrawerNotifs = false;
      renderApp();
    });

    document.getElementById('navAvisosAlumno')?.addEventListener('click', toggleNotifDrawer);
    document.getElementById('navAvisosProf')?.addEventListener('click', toggleNotifDrawer);

    document.getElementById('navAlumnos')?.addEventListener('click', () => {
      appState.modalActivo = null;
      appState.mostrarDrawerNotifs = false;
      renderApp();
    });
  }

  function bindHeaderEvents() {
    document.getElementById('btnLogout')?.addEventListener('click', async () => {
      // Cerrar sesión en Supabase Auth (fire-and-forget: si falla, la sesión
      // local se limpia igual y el usuario queda deslogueado en la app).
      // A propósito NO se llama a reg.pushManager.getSubscription().unsubscribe()
      // acá. La suscripción física del navegador es del dispositivo, no de la
      // sesión de la app: si la desuscribiéramos en cada logout, el próximo
      // usuario que loguee en este mismo dispositivo dispararía SIEMPRE una
      // resuscripción nueva (más lento, y en iOS puede pedir permiso de nuevo).
      // Ahora que guardar_push_subscription reasigna el endpoint por UPSERT
      // (ver SQL), el problema de "queda asociado al usuario viejo" se
      // resuelve en el próximo login+activación sin necesidad de desuscribir
      // acá. Solo se limpia el estado de sesión de la app.
      if (window.supabaseEngine) {
        window.supabaseEngine.authSignOut(); // no se espera (fire-and-forget)
      }
      // Borrador de entrenamiento: se elimina en logout SOLO si pertenece al
      // alumno que se está desloguéando ahora mismo (nunca el de otro usuario).
      const borradorPropioAlCerrarSesion = getBorradorPropio();
      if (borradorPropioAlCerrarSesion) clearWorkoutDraft();
      window._sessionAlumnoId  = null;
      window._sessionProfesorId = null;
      appState.usuarioActual = null;
      appState.historialProfesorLogs = null;
      renderApp();
    });

    document.getElementById('btnHeaderHome')?.addEventListener('click', () => renderApp());

    document.getElementById('btnNotifBell')?.addEventListener('click', () => {
      const pushConcedido = 'Notification' in window && Notification.permission === 'granted';

      // Push ya activado -> la campana funciona como antes: abre el drawer
      if (pushConcedido) {
        toggleNotifDrawer();
        return;
      }

      // Push NO activado todavía -> tocar la campana dispara el mismo flujo
      // que antes tenía el botón de texto "Activar Push" (funcionalidad
      // intacta, solo cambia el disparador visual).
      if ('Notification' in window) {
        Notification.requestPermission().then(permission => {
          if (permission === 'granted') {
            if ('serviceWorker' in navigator && window.supabaseEngine) {
              navigator.serviceWorker.ready.then(async reg => {
                try {
                  let sub = await reg.pushManager.getSubscription();
                  if (!sub) {
                    // La VAPID public key real se pide al backend (no es secreta,
                    // pero no vive hardcodeada en el frontend). Si no está
                    // configurada en el servidor, cortamos acá con un error
                    // explícito en vez de caer a una key dummy inválida.
                    const vapidKey = await window.supabaseEngine.getVapidPublicKey();
                    if (!vapidKey) {
                      throw new Error("No se pudo obtener la clave pública VAPID del servidor (falta configurar VAPID_PUBLIC_KEY en Vercel).");
                    }
                    sub = await reg.pushManager.subscribe({
                      userVisibleOnly: true,
                      applicationServerKey: urlBase64ToUint8Array(vapidKey)
                    });
                  }
                  if (sub && appState.usuarioActual) {
                    // Esta llamada ahora propaga el error real si la RPC falla
                    // (ver registerPushSubscription en supabase.js): antes,
                    // cualquier falla acá quedaba enmascarada por el catch de
                    // abajo, que siempre mostraba un mensaje de "activadas"
                    // aunque la suscripción nunca se hubiera guardado en la DB.
                    // Esto era la causa de "se activan pero no llegan".
                    await window.supabaseEngine.registerPushSubscription(appState.usuarioActual.data.id, sub.toJSON());
                    alert("🔔 Suscripción Web Push activa y vinculada a tu cuenta correctamente.");
                  }
                } catch (e) {
                  console.error("❌ No se pudo activar/guardar la suscripción Web Push:", e);
                  alert("⚠️ No se pudo activar la notificación push: " + ((e && e.message) || "error desconocido") + ". Probá de nuevo o contactá al profesor.");
                }
                renderApp();
              });
            } else {
              alert("🔔 Notificaciones habilitadas.");
              renderApp();
            }
          } else {
            alert("⚠️ Permiso de notificaciones denegado. Puedes habilitarlo desde la configuración de tu navegador.");
          }
        });
      }
    });

    document.getElementById('btnCloseNotifs')?.addEventListener('click', () => {
      appState.mostrarDrawerNotifs = false;
      renderApp();
    });

    document.getElementById('btnCancelWorkout')?.addEventListener('click', () => {
      if (confirm("¿Deseas cancelar la sesión de entrenamiento actual?")) {
        clearWorkoutDraft();
        appState.diaActivoEntrenamiento = null;
        renderApp();
      }
    });

    document.getElementById('btnFinishWorkout')?.addEventListener('click', async (e) => {
      const dia = appState.diaActivoEntrenamiento;
      const alumno = appState.usuarioActual.data;
      const rutinaActiva = store.getRutinaPorId(appState.rutinaSeleccionadaId) || store.getRutinaActiva(alumno.id);

      const setsLogArr = [];
      Object.keys(appState.workoutDraftSets).forEach(ejId => {
        const ejData = appState.workoutDraftSets[ejId];
        ejData.sets.forEach(s => {
          setsLogArr.push({
            ejercicioId:       ejId,              // para vincular exercise_goal_id en Supabase
            ejercicioNombre:   ejData.nombre,
            setNumero:         s.setNumero,
            repsRealizadas:    s.reps,
            pesoUtilizado:     s.peso,
            comentarioAlumno:  s.comentarioSet || ''
          });
        });
      });

      // VALIDACIÓN CRÍTICA: Verificar que existe una rutina activa válida
      // Si no hay rutina en Supabase, el alumno debe contactar al profesor
      if (!rutinaActiva) {
        alert('❌ No tienes una rutina activa asignada.\n\nContacta a tu profesor para que te asigne una rutina de entrenamiento.');
        renderApp();
        return;
      }

      // guardarEntrenamientoReal es async: guarda local de forma optimista y
      // espera la confirmación autoritativa del servidor (RPC de puntos) antes
      // de mostrar el mensaje final, así el alumno nunca ve un número de
      // puntos que el servidor va a corregir un segundo después.
      const btn = e.currentTarget;
      btn.disabled = true;
      btn.textContent = '⏳ Guardando...';

      const logGuardado = await store.guardarEntrenamientoReal({
        alumnoId:         alumno.id,
        rutinaId:         rutinaActiva.id,
        diaId:            dia.id,
        diaNombre:        dia.nombre,
        diaNumero:        dia.diaNumero || 1,    // número real del día en la rutina
        setsLog:          setsLogArr,
        comentarioGeneral: appState.workoutGeneralComment || ''
      });

      // VALIDACIÓN CRÍTICA: Verificar que la RPC confirmó los puntos en el servidor
      const puntosConfirmadosPorServidor = logGuardado?.puntosConfirmadosPorServidor === true;
      
      if (!puntosConfirmadosPorServidor) {
        // La RPC falló silenciosamente → No se pueden dar por válidos los puntos
        alert(`⚠️ Entrenamiento guardado en tu historial, pero no se pudieron guardar los puntos en el servidor.\n\nIntentaremos de nuevo automáticamente. Si el problema persiste, contactá al profesor.`);
      } else {
        // La RPC fue exitosa → Mostrar el mensaje de éxito real
        const puntosGanados = Math.round((logGuardado?.puntos || 0));
        const bonusTexto = logGuardado?.bonusRacha ? ` (incluye +${logGuardado.bonusRacha} 🔥 bonus por racha semanal)` : '';
        const mensajePuntos = logGuardado?.yaHuboEntrenamientoHoy
          ? `Ya sumaste puntos hoy con otro entrenamiento — este quedó guardado en tu historial, pero no otorga puntos adicionales (solo se otorgan puntos una vez por día).`
          : `+${puntosGanados} puntos ganados${bonusTexto}`;
        alert(`🏆 ¡Entrenamiento completado y guardado en tu historial!\n${mensajePuntos}`);
      }
      clearWorkoutDraft();
      appState.diaActivoEntrenamiento = null;
      appState.tabCliente = 'historial';
      renderApp();
    });

    const cerrarModalGenerico = () => {
      appState.modalActivo = null;
      appState.rutinaAEliminarId = null;
      appState.logEnEdicionId = null;
      appState.editDraftSets = null;
      appState.editDraftComentario = '';
      renderApp();
    };
    document.getElementById('btnCloseModal')?.addEventListener('click', cerrarModalGenerico);
    document.getElementById('btnCancelModal')?.addEventListener('click', cerrarModalGenerico);

    document.getElementById('btnGuardarEdicionEntrenamiento')?.addEventListener('click', async () => {
      const alumno = appState.usuarioActual.data;
      try {
        const resultado = await store.editarEntrenamientoReciente({
          logId: appState.logEnEdicionId,
          alumnoId: alumno.id,
          setsLog: appState.editDraftSets,
          comentarioGeneral: appState.editDraftComentario
        });
        if (resultado && resultado.ok) {
          alert("✅ Entrenamiento actualizado correctamente.");
        } else {
          alert("❌ No se pudo guardar la edición: " + ((resultado && resultado.error) || "error desconocido"));
        }
      } catch (err) {
        alert("❌ Error: " + err.message);
      }
      cerrarModalGenerico();
    });

    document.getElementById('btnConfirmarBorradoRutina')?.addEventListener('click', async () => {
      const rId = appState.rutinaAEliminarId;
      const profesorId = window._sessionProfesorId || appState.usuarioActual.data.id;
      const resultado = await store.eliminarRutina(rId, profesorId);
      appState.modalActivo = null;
      appState.rutinaAEliminarId = null;
      if (!resultado || resultado.ok !== true) {
        alert("❌ No se pudo borrar la rutina: " + ((resultado && resultado.error) || "error desconocido"));
      }
      renderApp();
    });

    const formNuevo = document.getElementById('formNuevoAlumno');
    if (formNuevo) {
      formNuevo.addEventListener('submit', (e) => {
        e.preventDefault();
        try {
          const dni = document.getElementById('newDni').value;
          const nombre = document.getElementById('newNombre').value;
          const tel = document.getElementById('newTel').value;
          store.autorizarOAgregarAlumnoPorProfesor({ dni, nombre, telefono: tel });
          alert("✅ Alumno registrado y DNI autorizado correctamente.");
          appState.modalActivo = null;
          renderApp();
        } catch (err) {
          alert("❌ Error: " + err.message);
        }
      });
    }

    const formRutina = document.getElementById('formCrearRutina');
    if (formRutina) {
      setupRoutineFormBuilder();
      formRutina.addEventListener('submit', async (e) => {
        e.preventDefault();
        await saveRoutineFromForm();
      });
    }
  }

  function bindAccordionEvents() {
    document.querySelectorAll('.history-accordion-header').forEach(header => {
      header.addEventListener('click', () => {
        const accId = header.dataset.accId;
        const body = document.getElementById(accId);
        if (body) {
          const estaAbierto = body.style.display === 'block';
          body.style.display = estaAbierto ? 'none' : 'block';
        }
      });
    });
  }

  // --- RECUPERAR SESIÓN DE SUPABASE AUTH AL INICIO (Etapa 1) ---
  // Se ejecuta como IIFE async para poder usar await antes del primer renderApp().
  // Si Supabase Auth tiene una sesión activa (JWT válido en localStorage del
  // navegador), se intenta recuperar el perfil local correspondiente por
  // authUserId = session.user.id. Si se encuentra, se restaura appState y
  // window._session* exactamente como haría un login() exitoso. Si no hay
  // sesión, o el perfil no existe localmente todavía (todavía sin vincular),
  // se arranca en la pantalla de login sin mostrar ningún error.
  // Este bloque no modifica ni borra ninguna contraseña legacy.
  (async () => {
    try {
      if (window.supabaseEngine) {
        // Esperar que el store tenga datos básicos (la sync inicial diferida
        // del constructor de GymStore ya se programó con setTimeout 400ms;
        // aquí no la esperamos explícitamente para no bloquear el arranque,
        // pero usamos lo que ya hay en localStorage + lo que Supabase Auth
        // puede darnos en el token).
        const session = await window.supabaseEngine.authGetSession();
        if (session && session.user) {
          const authUid = session.user.id;
          console.log('🔑 Sesión Supabase Auth encontrada al inicio → authUserId:', authUid);

          // Buscar perfil local por authUserId (ya puede estar en localStorage
          // si el usuario se logueó antes y guardamos el campo).
          const perfilProfesor = store.data.profesores.find(p => p.authUserId === authUid);
          const perfilAlumno   = !perfilProfesor
            ? store.data.alumnos.find(a => a.authUserId === authUid)
            : null;

          if (perfilProfesor) {
            appState.usuarioActual = { rol: 'profesor', data: perfilProfesor };
            window._sessionProfesorId = perfilProfesor.id;
            window._sessionAlumnoId   = null;
            console.log('✅ Sesión restaurada como PROFESOR:', perfilProfesor.nombre);
            // Sincronizar rutinas del profesor en segundo plano
            setTimeout(() => gymStore.syncRutinasProfesor(), 400);
          } else if (perfilAlumno) {
            appState.usuarioActual = { rol: 'alumno', data: perfilAlumno };
            window._sessionAlumnoId   = perfilAlumno.id;
            window._sessionProfesorId = null;
            console.log('✅ Sesión restaurada como ALUMNO:', perfilAlumno.nombre);
            // Detectar borrador de entrenamiento sin terminar de este alumno
            // (nunca el de otro usuario — getBorradorPropio verifica ownerId
            // contra el alumno recién restaurado).
            appState.borradorEntrenamientoDetectado = getBorradorPropio();
            // Sincronizar rutinas e historial del alumno en segundo plano
            setTimeout(async () => {
              await gymStore.syncWithSupabase(perfilAlumno.id);
              if (window.supabaseEngine) {
                const sbLogs = await window.supabaseEngine.obtenerHistorialDesdeSupabase(perfilAlumno.id);
                if (sbLogs && sbLogs.length > 0) {
                  sbLogs.forEach(sbLog => {
                    const idx = gymStore.data.workoutLogs.findIndex(w => w.id === sbLog.id);
                    if (idx >= 0) gymStore.data.workoutLogs[idx] = sbLog;
                    else gymStore.data.workoutLogs.push(sbLog);
                  });
                  gymStore.saveData();
                  window.dispatchEvent(new CustomEvent('gym_store_updated'));
                }
              }
            }, 400);
          } else {
            // Hay sesión Auth pero el perfil aún no está vinculado localmente.
            // Esto puede pasar si el usuario limpia localStorage pero la sesión
            // de Auth sigue válida. En ese caso arrancamos en login para que
            // el usuario ingrese sus credenciales y la vinculación se complete.
            console.log('ℹ️ Sesión Auth encontrada pero perfil no vinculado localmente → ir a login.');
          }
        }
      }
    } catch (e) {
      console.warn('⚠️ Error al recuperar sesión inicial de Supabase Auth (no crítico):', e);
    }

    renderApp();
  })();
});