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
    // Recargar una sola vez cuando el nuevo SW toma control (evita quedar con JS/CSS viejo)
    let refreshing = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (refreshing) return;
      refreshing = true;
      window.location.reload();
    });

    navigator.serviceWorker.register('./sw.js')
      .then(reg => {
        console.log('✅ Service Worker PWA activo');
        // Buscar actualización al abrir la app
        reg.update().catch(() => {});
        // Si ya hay un SW en waiting, forzar activación
        if (reg.waiting) {
          reg.waiting.postMessage({ type: 'SKIP_WAITING' });
        }
        reg.addEventListener('updatefound', () => {
          const worker = reg.installing;
          if (!worker) return;
          worker.addEventListener('statechange', () => {
            if (worker.state === 'installed' && navigator.serviceWorker.controller) {
              // Nueva versión lista: activar (skipWaiting ya está en sw.js; claim + controllerchange recarga)
              worker.postMessage({ type: 'SKIP_WAITING' });
            }
          });
        });
      })
      .catch(err => console.warn('Error SW:', err));

    // Al volver a la app (cerrar y abrir / cambiar de pestaña), chequear update
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        navigator.serviceWorker.getRegistration('./sw.js').then(reg => {
          if (reg) reg.update().catch(() => {});
        });
      }
    });

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
    logABorrarId: null,       // entrenamiento pendiente de confirmar borrado
    finalizandoEntrenamiento: false, // candado anti doble-toque al finalizar
    statsSelectedLogId: null,
    statsMonthOffset: 0,
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
              <svg class="header-icon header-icon-bell" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="width:24px;height:24px;min-width:24px;min-height:24px;display:block;color:#fff;"><path d="M10.268 21a2 2 0 0 0 3.464 0"/><path d="M22 8c0-2.3-.8-4.3-2-6"/><path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326"/><path d="M4 2C2.8 3.7 2 5.7 2 8"/></svg>
              ${!pushConcedido
                ? `<span class="notif-bell-dot" title="Push desactivado"></span>`
                : (unreadCount > 0 ? `<span style="position:absolute; top:-4px; right:-4px; background:var(--red-primary); color:#fff; border-radius:50%; width:18px; height:18px; font-size:0.7rem; font-weight:800; display:flex; align-items:center; justify-content:center">${unreadCount}</span>` : '')
              }
            </button>
            <button class="btn btn-secondary btn-sm header-logout-btn" id="btnLogout"><span class="header-logout-label">Salir</span> <svg class="header-icon" xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/></svg></button>
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
    const iconStats = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><path d="M7 16V9"/><path d="M12 16v-5"/><path d="M17 16V7"/></svg>`;

    const items = isProfesor ? [
      { id: 'navAlumnos',    label: 'Alumnos', icon: iconAlumnos, active: appState.modalActivo === null && !appState.mostrarDrawerNotifs },
      { id: 'navAvisosProf', label: 'Avisos',   icon: iconAvisos,  active: appState.mostrarDrawerNotifs, badge: unreadCount }
    ] : [
      { id: 'navRutina',       label: 'Rutinas',   icon: iconRutina,    active: appState.tabCliente === 'rutina' && !appState.mostrarDrawerNotifs },
      { id: 'navMisRutinas',   label: 'Mías',       icon: iconMisRutinas, active: appState.tabCliente === 'mis_rutinas' && !appState.mostrarDrawerNotifs },
      { id: 'navRanking',      label: 'Ranking',    icon: iconRanking,   active: appState.tabCliente === 'ranking' && !appState.mostrarDrawerNotifs },
      { id: 'navHistorial',    label: 'Historial', icon: iconHistorial, active: appState.tabCliente === 'historial' && !appState.mostrarDrawerNotifs },
      { id: 'navStats',        label: 'Stats',      icon: iconStats,     active: appState.tabCliente === 'stats' && !appState.mostrarDrawerNotifs }
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
                  const idx = gymStore.data.workoutLogs.findIndex(w => String(w.id) === String(sbLog.id));
                  const remoteSets = Array.isArray(sbLog.sets) ? sbLog.sets : [];
                  if (idx >= 0) {
                    const local = gymStore.data.workoutLogs[idx];
                    const localSets = Array.isArray(local.sets) ? local.sets : [];
                    const sets = remoteSets.length > 0 ? remoteSets : localSets;
                    gymStore.data.workoutLogs[idx] = { ...local, ...sbLog, sets };
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
        ${appState.tabCliente === 'stats' ? renderStatsView(historialEntrenamientos) : ''}
      </main>

      ${(appState.modalActivo === 'crear_rutina_propia' || appState.modalActivo === 'editar_rutina_propia') ? renderModalFormularioRutina(appState.modalActivo) : ''}
      ${appState.modalActivo === 'editar_entrenamiento' ? renderModalEditarEntrenamiento(alumno) : ''}
      ${appState.modalActivo === 'confirmar_borrar_entrenamiento' ? renderModalConfirmarBorrarEntrenamiento(alumno) : ''}
      ${appState.borradorEntrenamientoDetectado ? renderModalRecuperarBorrador() : ''}

      ${renderBottomNav()}
    `;

    bindHeaderEvents();
    bindInstallBannerEvents();
    bindBottomNavEvents();
    bindMisRutinasEvents(alumno);
    bindHistorialEvents(alumno);
    if (appState.tabCliente === 'stats') bindStatsEvents(historialEntrenamientos);
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
            (async () => {
              try {
                const resultado = await store.eliminarRutinaPropia(rId, alumno.id);
                if (!resultado || resultado.ok !== true) {
                  alert("❌ No se pudo eliminar la rutina: " + ((resultado && resultado.error) || "error desconocido"));
                }
              } catch (err) {
                alert("❌ Error: " + err.message);
              }
              renderApp();
            })();
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

    document.querySelectorAll('.btn-borrar-entrenamiento-click').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const logId = btn.dataset.logId;
        const log = store.data.workoutLogs.find(w => w.id === logId);
        if (!log) return;
        appState.logABorrarId = logId;
        appState.modalActivo = 'confirmar_borrar_entrenamiento';
        renderApp();
      });
    });
  }

  function renderModalConfirmarBorrarEntrenamiento(alumno) {
    const log = store.data.workoutLogs.find(w => w.id === appState.logABorrarId);
    if (!log) return '';
    const fechaTxt = log.fecha
      ? new Date(log.fecha).toLocaleString('es-AR', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
      : '';
    return `
      <div class="modal-overlay">
        <div class="modal-content" style="max-width:420px">
          <div class="modal-header">
            <h3>🗑️ Borrar entrenamiento</h3>
            <button class="close-btn" id="btnCloseModal">&times;</button>
          </div>
          <p style="color:var(--text-gray); font-size:0.92rem; line-height:1.45; margin-bottom:8px">
            ¿Seguro que querés borrar este entrenamiento?
          </p>
          <div style="background:rgba(255,255,255,0.04); border-radius:10px; padding:12px 14px; margin-bottom:16px">
            <div style="font-weight:800; color:#fff">${log.diaNombre || 'Entrenamiento'}</div>
            <div style="font-size:0.8rem; color:var(--text-gray); margin-top:4px">${fechaTxt}</div>
            ${log.puntos ? `<div style="font-size:0.8rem; color:var(--red-primary); margin-top:6px; font-weight:700">−${log.puntos} pts se restarán del ranking</div>` : ''}
          </div>
          <p style="font-size:0.78rem; color:var(--text-muted); margin-bottom:16px">Esta acción no se puede deshacer.</p>
          <div style="display:flex; justify-content:flex-end; gap:10px">
            <button type="button" class="btn btn-secondary" id="btnCancelModal">Cancelar</button>
            <button type="button" class="btn btn-primary" id="btnConfirmarBorrarEntrenamiento" style="background:var(--red-primary)">Sí, borrar</button>
          </div>
        </div>
      </div>
    `;
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

  // --- FEATURE RANKING: podio Top 3 + lista desde el 4º ---
  function renderRankingView() {
    const ranking = store.getRanking();
    const miId = appState.usuarioActual.data.id;
    const medalla = (pos) => pos === 1 ? '🥇' : pos === 2 ? '🥈' : pos === 3 ? '🥉' : `#${pos}`;

    const top3 = ranking.filter(a => a.posicion <= 3);
    const resto = ranking.filter(a => a.posicion > 3);
    const byPos = (pos) => top3.find(a => a.posicion === pos) || null;

    // Colores e alturas inline para que el podio se vea aunque falle el CSS externo
    const blockStyle = {
      1: 'height:112px;background:linear-gradient(180deg,#f5d76e 0%,#d4a017 55%,#b8860b 100%);',
      2: 'height:80px;background:linear-gradient(180deg,#e8e8ec 0%,#b0b0b8 55%,#8a8a94 100%);',
      3: 'height:64px;background:linear-gradient(180deg,#d4a574 0%,#a66b3a 55%,#8b5a2b 100%);'
    };
    const slotBase = 'flex:1 1 0;min-width:0;max-width:140px;display:flex;flex-direction:column;align-items:center;text-align:center;';
    const blockBase = 'width:100%;border-radius:10px 10px 4px 4px;display:flex;align-items:flex-start;justify-content:center;padding-top:12px;box-shadow:inset 0 1px 0 rgba(255,255,255,0.15);';
    const numBase = 'font-size:1.4rem;font-weight:900;line-height:1;color:rgba(0,0,0,0.5);';

    const renderPodiumSlot = (a, place) => {
      const empty = !a;
      const isMe = a && a.id === miId;
      const name = empty ? '' : a.nombre;
      const pts = empty ? '' : `${Math.round(a.puntosTotal || 0)} pts`;
      const streak = (!empty && a.rachaSemanal && a.rachaSemanal.semanas >= 2)
        ? `<div style="font-size:0.68rem;font-weight:700;color:#f59e0b;">🔥 ${a.rachaSemanal.semanas} sem</div>`
        : '';
      const meBadge = isMe ? ' <span style="color:#ff2e2e;font-weight:800;">(Vos)</span>' : '';
      const meRing = isMe ? 'box-shadow:inset 0 1px 0 rgba(255,255,255,0.18),0 0 0 2px #ff2e2e;' : '';
      const opacity = empty ? 'opacity:0.35;' : '';

      return `
        <div class="podium-slot podium-slot-${place}${isMe ? ' podium-slot-me' : ''}${empty ? ' podium-slot-empty' : ''}"
             style="${slotBase}${opacity}" ${empty ? 'aria-hidden="true"' : ''}>
          <div class="podium-meta${place === 1 && !empty ? ' podium-meta-first' : ''}" style="width:100%;padding:0 4px 10px;display:flex;flex-direction:column;align-items:center;gap:2px;min-height:52px;justify-content:flex-end;position:relative;">
            ${empty ? '' : `
              ${place === 1 ? `<span class="podium-sparks" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></span>` : ''}
              <div class="podium-name" title="${name}" style="font-size:0.82rem;font-weight:800;color:#fff;line-height:1.2;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;position:relative;z-index:1;">${name}${meBadge}</div>
              <div class="podium-pts" style="font-size:0.78rem;font-weight:900;color:#ff2e2e;white-space:nowrap;position:relative;z-index:1;">${pts}</div>
              ${streak}
            `}
          </div>
          <div class="podium-block" style="${blockBase}${blockStyle[place]}${meRing}">
            <span class="podium-num" style="${numBase}${place === 1 ? 'font-size:1.55rem;' : ''}">${place}</span>
          </div>
        </div>`;
    };

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
        <style>
          /* Podio: uno por uno 3 → 2 → 1. Nombre del 1º flota sutil (como el trofeo). */
          @keyframes efColRise {
            0%   { opacity: 0; transform: scaleY(0.08); }
            100% { opacity: 1; transform: scaleY(1); }
          }
          @keyframes efNameIn {
            0%   { opacity: 0; transform: translateY(8px); }
            100% { opacity: 1; transform: translateY(0); }
          }
          /* Movimiento del nombre del 1º (equivalente al trofeo del video) */
          @keyframes efNameFloat {
            0%, 100% { transform: translateY(0); }
            50%      { transform: translateY(-7px); }
          }

          .podium-slot {
            opacity: 1;
          }
          /* Columnas empiezan invisibles; aparecen en secuencia clara */
          .podium-block {
            opacity: 0;
            transform-origin: bottom center !important;
            animation: efColRise 0.42s cubic-bezier(0.25, 0.9, 0.3, 1) both !important;
          }
          .podium-meta {
            opacity: 0;
            animation: efNameIn 0.32s ease both !important;
          }

          /* 3º primero */
          .podium-slot-3 .podium-block { animation-delay: 0.05s !important; }
          .podium-slot-3 .podium-meta  { animation-delay: 0.18s !important; }
          /* 2º después (espera a que termine el 3) */
          .podium-slot-2 .podium-block { animation-delay: 0.48s !important; }
          .podium-slot-2 .podium-meta  { animation-delay: 0.60s !important; }
          /* 1º al final */
          .podium-slot-1 .podium-block { animation-delay: 0.90s !important; }
          .podium-slot-1 .podium-meta  {
            animation:
              efNameIn 0.32s ease 1.02s both,
              efNameFloat 1.6s ease-in-out 1.4s 2 !important; /* 2 flotaciones sutiles */
          }

          .podium-block::after { display: none !important; }
          /* Chispas sutiles solo en el 1º (~2s) */
          .podium-sparks {
            position: absolute;
            left: 50%;
            top: 28%;
            width: 0;
            height: 0;
            pointer-events: none;
            z-index: 2;
          }
          .podium-sparks i {
            position: absolute;
            width: 4px;
            height: 4px;
            border-radius: 50%;
            background: #ffe9a0;
            box-shadow: 0 0 6px 1px rgba(255, 215, 80, 0.85);
            opacity: 0;
            animation: efSpark 1.9s ease-out 1.05s both;
          }
          .podium-sparks i:nth-child(1) { --dx: -18px; --dy: -22px; animation-delay: 1.05s; background: #fff6c8; }
          .podium-sparks i:nth-child(2) { --dx: 16px;  --dy: -24px; animation-delay: 1.12s; background: #ffd36b; width: 3px; height: 3px; }
          .podium-sparks i:nth-child(3) { --dx: -26px; --dy: -8px;  animation-delay: 1.18s; background: #ffb347; }
          .podium-sparks i:nth-child(4) { --dx: 24px;  --dy: -10px; animation-delay: 1.22s; background: #fff; width: 3px; height: 3px; }
          .podium-sparks i:nth-child(5) { --dx: -10px; --dy: -30px; animation-delay: 1.28s; background: #ffe08a; }
          .podium-sparks i:nth-child(6) { --dx: 8px;   --dy: -28px; animation-delay: 1.34s; background: #ff9f43; width: 3px; height: 3px; }
          .podium-sparks i:nth-child(7) { --dx: -22px; --dy: 4px;   animation-delay: 1.40s; background: #fff3b0; }
          .podium-sparks i:nth-child(8) { --dx: 20px;  --dy: 2px;   animation-delay: 1.46s; background: #ffd27a; width: 3px; height: 3px; }
          @keyframes efSpark {
            0%   { opacity: 0; transform: translate(0, 0) scale(0.4); }
            18%  { opacity: 1; transform: translate(calc(var(--dx) * 0.35), calc(var(--dy) * 0.35)) scale(1); }
            70%  { opacity: 0.85; }
            100% { opacity: 0; transform: translate(var(--dx), var(--dy)) scale(0.2); }
          }
          @media (prefers-reduced-motion: reduce) {
            .podium-sparks { display: none !important; }
          }

          .podium-slot:hover .podium-block {
            transform: translateY(-3px) !important;
            transition: transform 0.18s ease !important;
          }
          @media (prefers-reduced-motion: reduce) {
            .podium-block,
            .podium-meta {
              opacity: 1 !important;
              animation: none !important;
            }
            .podium-slot:hover .podium-block { transform: none !important; }
          }
        </style>
        <div class="podium" role="list" aria-label="Podio top 3"
             style="display:flex;align-items:flex-end;justify-content:center;gap:8px;width:100%;max-width:100%;padding:8px 0 4px;box-sizing:border-box;">
          ${renderPodiumSlot(byPos(2), 2)}
          ${renderPodiumSlot(byPos(1), 1)}
          ${renderPodiumSlot(byPos(3), 3)}
        </div>

        ${resto.length > 0 ? `
          <div class="ranking-list ranking-list-rest" style="margin-top:18px;display:flex;flex-direction:column;gap:10px;">
            ${resto.map(a => `
              <div class="ranking-row ${a.id === miId ? 'ranking-row-me' : ''}">
                <div class="ranking-pos">${medalla(a.posicion)}</div>
                <div class="ranking-info">
                  <div class="ranking-name">${a.nombre}${a.id === miId ? ' <span style="color:var(--red-primary)">(Vos)</span>' : ''}</div>
                  ${a.rachaSemanal && a.rachaSemanal.semanas >= 2 ? `<div class="ranking-streak">🔥 Racha de ${a.rachaSemanal.semanas} semanas</div>` : ''}
                </div>
                <div class="ranking-points">${Math.round(a.puntosTotal || 0)} pts</div>
              </div>
            `).join('')}
          </div>
        ` : ''}
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
        <div class="exercise-block${ej.esEntradaEnCalor ? ' exercise-block-warmup' : ''}">
          <div style="font-size:1.15rem; font-weight:900; color:#fff; margin-bottom:8px">${ej.esEntradaEnCalor ? '🔥 ' : ''}${ej.nombre}${ej.esEntradaEnCalor ? ' <span class="warmup-badge">Entrada en calor</span>' : ''}</div>

          <div class="target-box">
            <div class="target-title">${ej.esEntradaEnCalor ? '🔥 Activación / Entrada en calor' : '🎯 Objetivo Indicado por el Profesor:'}</div>
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
            <div class="exercise-block${ej.esEntradaEnCalor ? ' exercise-block-warmup' : ''}">
              <div class="exercise-title" style="font-size:1.15rem; font-weight:900; color:#fff">${ej.esEntradaEnCalor ? '🔥 ' : ''}${ej.nombre}${ej.esEntradaEnCalor ? ' <span class="warmup-badge">Entrada en calor</span>' : ''}</div>

              <div class="target-box">
                <div class="target-title">${ej.esEntradaEnCalor ? '🔥 ACTIVACIÓN / ENTRADA EN CALOR' : '🎯 OBJETIVO DEL PROFESOR'}</div>
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

  // --- ESTADÍSTICAS DEL ALUMNO (distribución, comparación, constancia) ---
  function _statsMuscleOf(name) {
    // Normalizar: minúsculas, sin acentos, espacios simples
    const n = String(name || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!n) return 'Otros';

    // --- Orden: más específico primero (evitar que "press" genérico coma todo) ---

    // Tríceps (antes que pecho: press francés, fondos en paralelas a veces pecho, extension)
    if (/triceps|tricep|press frances|frances|skull ?crusher|extension (de )?(triceps|codo)|extension tras( de)? nuca|extension trasnuca|patada de triceps|kickback|push ?down|pushdown|fondos en paralela|fondo en paralela|press cerrado|press agarre cerrado/.test(n)) return 'Triceps';

    // Bíceps
    if (/biceps|bicep|curl (de )?(biceps|barra|mancuerna|polea|martillo|concentrado|predicador|scott)|hammer curl|curl martillo|curl scott|curl predicador|curl con barra|curl con mancuern/.test(n)) return 'Biceps';
    if (/\bcurl\b/.test(n) && !/femoral|pierna|leg curl|isquio/.test(n)) return 'Biceps';

    // Hombros (vuelos laterales, press arnold, militar, pallof a veces core pero pallof es core)
    if (/press arnold|arnold press|press militar|militar|shoulder press|press de hombro|press hombro|press de hombros/.test(n)) return 'Hombros';
    if (/vuelo?s? laterales?|elevacion(es)? laterales?|lateral raise|vuelo?s? frontales?|elevacion(es)? frontales?|front raise/.test(n)) return 'Hombros';
    if (/pajaro|face pull|rear delt|deltoides? posterior|elevacion posterior/.test(n)) return 'Hombros';
    if (/rotacion (de )?hombro|rotacion externa|hombro con banda/.test(n)) return 'Hombros';
    if (/\bhombro|\bhombros\b|deltoid/.test(n)) return 'Hombros';

    // Espalda ANTES que pecho (ej. "jalon al pecho" es espalda, no pecho)
    if (/jalon|dorsalera|dorsal|pulldown|dominada|pull ?up|chin ?up/.test(n)) return 'Espalda';
    if (/\bremo\b|\brows?\b/.test(n)) return 'Espalda';
    if (/pull ?over|pullover|encogimiento|trapecio|espalda/.test(n)) return 'Espalda';

    // Pecho
    if (/press (de )?(banca|banco|plano|inclinado|declinado)|bench press|press plano|press inclinado|press declinado/.test(n)) return 'Pecho';
    if (/apertura|aperturas|\bfly\b|crossover|cruce(s)?( de)?( cable|polea)?|pec ?deck|peck ?deck|contractora/.test(n)) return 'Pecho';
    if (/fondos en banco|fondo en banco|fondos entre bancos|push ?up|flexiones/.test(n)) return 'Pecho';
    if (/\bpecho\b|pectoral/.test(n) && !/jalon|dorsal|remo/.test(n)) return 'Pecho';
    if (/press en smith|press en maquina/.test(n) && /pecho|banca|plano|inclinado/.test(n)) return 'Pecho';

    // Piernas
    if (/gemelo|pantorrilla|elevacion de gemelo|calf|suelo de gemelo/.test(n)) return 'Gemelos';
    if (/femoral|isquio|curl femoral|curl de pierna|leg curl|nordic|camilla de isquio/.test(n)) return 'Femoral';
    if (/gluteo|glute|hip thrust|puente de glute|patada de glute|abduccion|abductor|aductor|adductor|patada glute/.test(n)) return 'Gluteos';
    if (/sentadilla|squat|prensa|leg press|hack|zancada|estocada|lunge|bulgara|extension de cuad|extension de pierna|leg extension|cuadriceps|cuadricera/.test(n)) return 'Cuadriceps';
    if (/peso muerto|deadlift|rumano|\brdl\b|cargada/.test(n)) return 'Femoral';

    // Core / abdomen
    if (/abdomen|abdominal|abs\b|crunch|plancha|core|rueda abdominal|elevacion de piernas|sit ?up|situp|press pallof|pallof|wall ball|burpee|burpi/.test(n)) return 'Core';

    // Press genérico sin contexto: suele ser pecho en gimnasio arg
    if (/\bpress\b/.test(n) && !/pierna|hombro|militar|arnold|frances|triceps|pallof/.test(n)) return 'Pecho';

    return 'Otros';
  }

  function _statsParsePesoKg(peso) {
    if (peso == null || peso === '') return 0;
    if (typeof peso === 'number') return peso;
    const m = String(peso).replace(',', '.').match(/-?\d+(\.\d+)?/);
    return m ? parseFloat(m[0]) : 0;
  }

  function _statsDiaKey(log) {
    const raw = String(log.diaNombre || log.diaId || log.diaNumero || 'dia').toLowerCase();
    return raw.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();
  }

  /** Nombres de ejercicios únicos ordenados (firma del estímulo). */
  function _statsExerciseSignature(log) {
    const names = new Set();
    (log.sets || []).forEach(s => {
      const n = String(s.ejercicioNombre || s.ejercicio || s.nombre || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (n) names.add(n);
    });
    return Array.from(names).sort().join('|');
  }

  /**
   * Anterior comparable:
   * 1) Mismo nombre de día (ej. "Espalda y bicep")
   * 2) Mismos ejercicios exactos (ej. lunes = jueves con la misma lista)
   * 3) Solapamiento >= 70% de ejercicios del actual
   */
  function _statsFindPreviousComparable(selected, list) {
    const selDate = new Date(selected.fecha).getTime();
    const earlier = (list || [])
      .filter(l => l.id !== selected.id && new Date(l.fecha).getTime() < selDate)
      .sort((a, b) => new Date(b.fecha) - new Date(a.fecha));
    if (!earlier.length) return { prev: null, matchType: null };

    const key = _statsDiaKey(selected);
    const byName = earlier.find(l => _statsDiaKey(l) === key);
    if (byName) return { prev: byName, matchType: 'nombre' };

    const sig = _statsExerciseSignature(selected);
    if (sig) {
      const byExact = earlier.find(l => _statsExerciseSignature(l) === sig);
      if (byExact) return { prev: byExact, matchType: 'ejercicios' };
    }

    const selSet = new Set(sig ? sig.split('|').filter(Boolean) : []);
    if (selSet.size >= 2) {
      let best = null;
      let bestRatio = 0;
      earlier.forEach(l => {
        const other = _statsExerciseSignature(l);
        if (!other) return;
        const oSet = new Set(other.split('|'));
        let inter = 0;
        selSet.forEach(n => { if (oSet.has(n)) inter++; });
        const ratio = inter / selSet.size;
        if (ratio >= 0.7 && ratio > bestRatio) {
          bestRatio = ratio;
          best = l;
        }
      });
      if (best) return { prev: best, matchType: 'similares' };
    }
    return { prev: null, matchType: null };
  }

  function _statsFormatFecha(iso) {
    try {
      return new Date(iso).toLocaleDateString('es-AR', { weekday: 'short', day: 'numeric', month: 'short' });
    } catch (_) {
      return '—';
    }
  }

  function renderStatsView(logs) {
    const list = (logs || []).slice().sort((a, b) => new Date(b.fecha) - new Date(a.fecha));
    if (!list.length) {
      return `<div class="stats-page">
        <h2 class="stats-title">Estadísticas</h2>
        <p class="stats-sub">Todavía no hay entrenamientos registrados. Completá una sesión para ver distribución, progreso y constancia.</p>
      </div>`;
    }

    if (appState.statsMonthOffset == null) appState.statsMonthOffset = 0;

    // --- Selector por RUTINA → DÍA (no por sesión suelta) ---
    const rutinasStore = (store.data && store.data.rutinas) ? store.data.rutinas : [];
    const rutinaIdsEnLogs = [];
    list.forEach(l => {
      const rid = l.rutinaId || 'sin-rutina';
      if (!rutinaIdsEnLogs.includes(rid)) rutinaIdsEnLogs.push(rid);
    });
    // Incluir rutinas del store (alumno) aunque todavía no tengan logs
    const alumnoIdStats = (appState.usuarioActual && appState.usuarioActual.data && appState.usuarioActual.data.id)
      ? String(appState.usuarioActual.data.id) : null;
    rutinasStore.forEach(r => {
      if (!r || !r.id) return;
      if (alumnoIdStats && r.alumnoId && String(r.alumnoId) !== alumnoIdStats) return;
      if (!rutinaIdsEnLogs.includes(r.id)) rutinaIdsEnLogs.push(r.id);
    });
    const rutinaOpciones = rutinaIdsEnLogs.map(rid => {
      const r = rutinasStore.find(x => x.id === rid);
      const titulo = r ? r.titulo : (rid === 'sin-rutina' ? 'Sin rutina' : 'Rutina');
      return { id: rid, titulo };
    });

    if (!appState.statsSelectedRutinaId || !rutinaOpciones.find(r => r.id === appState.statsSelectedRutinaId)) {
      appState.statsSelectedRutinaId = rutinaOpciones[0].id;
    }
    const rutinaIdActiva = appState.statsSelectedRutinaId;

    const logsDeRutina = list.filter(l => (l.rutinaId || 'sin-rutina') === rutinaIdActiva);
    const rutinaObj = rutinasStore.find(x => x.id === rutinaIdActiva) || null;

    // Días: de la rutina actual (se actualiza al editar) + los que aparezcan en logs
    const diasMap = new Map();
    if (rutinaObj && Array.isArray(rutinaObj.dias)) {
      rutinaObj.dias.forEach(d => {
        const fake = { diaNombre: d.nombre, diaId: d.id, diaNumero: d.diaNumero };
        const key = _statsDiaKey(fake);
        if (!key) return;
        if (!diasMap.has(key)) diasMap.set(key, { key, label: d.nombre || key, dayObj: d });
        else if (!diasMap.get(key).dayObj) diasMap.get(key).dayObj = d;
      });
    }
    logsDeRutina.forEach(l => {
      const key = _statsDiaKey(l);
      if (!key) return;
      if (!diasMap.has(key)) {
        diasMap.set(key, { key, label: l.diaNombre || key, dayObj: null });
      }
    });
    const diasOpciones = Array.from(diasMap.values());

    if (!appState.statsSelectedDiaKey || !diasOpciones.find(d => d.key === appState.statsSelectedDiaKey)) {
      appState.statsSelectedDiaKey = diasOpciones.length ? diasOpciones[0].key : null;
    }
    const diaKeyActiva = appState.statsSelectedDiaKey;
    const diaMeta = diasOpciones.find(d => d.key === diaKeyActiva) || null;

    // Sesión de referencia (gráfico de comparación) = la más reciente de esa rutina + ese día
    const logsDelDia = logsDeRutina
      .filter(l => _statsDiaKey(l) === diaKeyActiva)
      .sort((a, b) => new Date(b.fecha) - new Date(a.fecha));
    const selected = logsDelDia[0] || logsDeRutina[0] || list[0];
    appState.statsSelectedLogId = selected.id;

    const optionsRutina = rutinaOpciones.map(r =>
      `<option value="${r.id}" ${r.id === rutinaIdActiva ? 'selected' : ''}>${r.titulo}</option>`
    ).join('');
    const optionsDia = diasOpciones.map(d =>
      `<option value="${d.key}" ${d.key === diaKeyActiva ? 'selected' : ''}>${d.label}</option>`
    ).join('');

    // Distribución muscular: según la RUTINA ACTUAL (ejercicios del día),
    // así al editar la rutina se actualiza de inmediato. Si no hay día en la
    // rutina, se usa la última sesión registrada como fallback.
    const muscleCounts = {};
    let totalSets = 0;
    let muscleFuente = 'rutina';
    const ejerciciosRutinaDia = (diaMeta && diaMeta.dayObj && Array.isArray(diaMeta.dayObj.ejercicios))
      ? diaMeta.dayObj.ejercicios
      : null;

    if (ejerciciosRutinaDia && ejerciciosRutinaDia.length) {
      ejerciciosRutinaDia.forEach(ej => {
        // Entrada en calor no cuenta en la distribución principal
        if (ej.esEntradaEnCalor) return;
        const m = _statsMuscleOf(ej.nombre || '');
        const series = Number(ej.seriesTarget != null ? ej.seriesTarget : ej.series) || 1;
        muscleCounts[m] = (muscleCounts[m] || 0) + series;
        totalSets += series;
      });
    }
    if (totalSets === 0) {
      muscleFuente = 'sesion';
      (selected.sets || []).forEach(s => {
        const m = _statsMuscleOf(s.ejercicioNombre || s.ejercicio || s.nombre || '');
        muscleCounts[m] = (muscleCounts[m] || 0) + 1;
        totalSets++;
      });
    }
    const muscleDist = Object.entries(muscleCounts)
      .map(([name, n]) => ({ name, pct: totalSets ? Math.round((n / totalSets) * 100) : 0, n }))
      .sort((a, b) => b.pct - a.pct);

    const muscleHtml = muscleDist.length
      ? muscleDist.map(d => `
          <div class="stats-muscle-row">
            <div class="stats-muscle-name">${d.name}</div>
            <div class="stats-muscle-track"><div class="stats-muscle-fill" style="width:${d.pct}%"></div></div>
            <div class="stats-muscle-pct">${d.pct}%</div>
          </div>`).join('')
      : `<p class="stats-empty">No hay ejercicios en este día de la rutina ni series en el historial.</p>`;

    // Comparación multi-línea: una línea por sesión comparable (gris) + actual (azul)
    // Eje X = ejercicios del entrenamiento actual; Y = volumen (reps × kg)
    const { prev, matchType } = _statsFindPreviousComparable(selected, list);

    const volMap = (log) => {
      const map = {};
      (log.sets || []).forEach(s => {
        const name = String(
          s.ejercicioNombre || s.ejercicio || s.nombre || s.exercise_nombre || s.exercise_name || 'Ejercicio'
        ).trim() || 'Ejercicio';
        const reps = Number(
          s.repsRealizadas != null ? s.repsRealizadas
            : (s.reps != null ? s.reps
              : (s.reps_realizadas != null ? s.reps_realizadas : 0))
        ) || 0;
        const peso = _statsParsePesoKg(
          s.pesoUtilizado != null ? s.pesoUtilizado
            : (s.peso != null ? s.peso : s.peso_utilizado)
        );
        map[name] = (map[name] || 0) + reps * peso;
      });
      return map;
    };

    // Todos los anteriores comparables (mismo nombre o mismos ejercicios), hasta 8
    const selDate = new Date(selected.fecha).getTime();
    const selKey = _statsDiaKey(selected);
    const selSig = _statsExerciseSignature(selected);
    const prevSessions = list
      .filter(l => {
        if (l.id === selected.id) return false;
        if (new Date(l.fecha).getTime() >= selDate) return false;
        // Preferir misma rutina; si no hay, permitir otras
        const sameRutina = (l.rutinaId || 'sin-rutina') === (selected.rutinaId || 'sin-rutina');
        if (_statsDiaKey(l) === selKey && sameRutina) return true;
        if (_statsDiaKey(l) === selKey) return true;
        if (selSig && _statsExerciseSignature(l) === selSig) return true;
        return false;
      })
      .sort((a, b) => new Date(a.fecha) - new Date(b.fecha)) // viejo → nuevo
      .slice(-8);

    const chain = [...prevSessions, selected]; // para el badge
    const curVol = volMap(selected);
    // Eje X: unión de ejercicios de TODAS las sesiones comparables (no solo la actual)
    const labels = [];
    const pushName = (raw) => {
      const name = String(raw || '').trim() || 'Ejercicio';
      if (name && !labels.includes(name)) labels.push(name);
    };
    chain.forEach(log => {
      (log.sets || []).forEach(s => {
        pushName(s.ejercicioNombre || s.ejercicio || s.nombre || s.exercise_nombre || s.exercise_name);
      });
    });
    // Fallback: ejercicios del día en la rutina actual
    if (!labels.length && ejerciciosRutinaDia && ejerciciosRutinaDia.length) {
      ejerciciosRutinaDia.forEach(ej => {
        if (!ej.esEntradaEnCalor) pushName(ej.nombre);
      });
    }
    if (!labels.length) labels.push('Sin series');

    // seriesList: cada sesión es una línea
    // Colores tipo gráfico clásico (azul actual + naranja/verde/etc. anteriores)
    const prevColors = ['#f97316', '#a78bfa', '#34d399', '#f472b6', '#eab308', '#22d3ee', '#fb7185', '#94a3b8'];
    let prevColorIdx = 0;
    const seriesList = chain.map((log) => {
      const isCurrent = log.id === selected.id;
      const vm = volMap(log);
      const values = labels.map(n => Math.round(vm[n] || 0));
      let fechaTxt = '';
      try {
        fechaTxt = new Date(log.fecha).toLocaleDateString('es-AR', { day: '2-digit', month: 'short' });
      } catch (_) {}
      let color = '#3b82f6';
      if (!isCurrent) {
        color = prevColors[prevColorIdx % prevColors.length];
        prevColorIdx++;
      }
      return {
        id: log.id,
        label: isCurrent ? 'Este' : fechaTxt,
        isCurrent,
        color,
        values
      };
    });

    // Compat con el drawer viejo del canvas
    const seriesA = seriesList.find(s => s.isCurrent)?.values || labels.map(() => 0);
    const seriesB = null;

    let compareHint = 'Cada línea es un entrenamiento. Azul = el que elegiste. Más arriba = más volumen (reps × kg).';
    if (chain.length < 2) {
      compareHint = 'Primera vez de este estímulo: línea azul con el volumen de cada ejercicio. Cuando lo repitas, vas a ver las líneas grises de antes.';
    } else if (matchType === 'nombre') {
      compareHint = `Comparando ${chain.length} sesiones · mismo día (${selected.diaNombre || ''}). Azul = actual.`;
    } else if (matchType === 'ejercicios' || matchType === 'similares') {
      compareHint = `Comparando ${chain.length} sesiones · mismos / similares ejercicios. Azul = actual.`;
    }

    const chartPayload = encodeURIComponent(JSON.stringify({ labels, seriesList }));

    // Calendario
    const now = new Date();
    const offset = Number(appState.statsMonthOffset) || 0;
    const viewDate = new Date(now.getFullYear(), now.getMonth() + offset, 1);
    const y = viewDate.getFullYear();
    const m = viewDate.getMonth();
    const lastDay = new Date(y, m + 1, 0).getDate();
    let startPad = new Date(y, m, 1).getDay() - 1;
    if (startPad < 0) startPad = 6;
    const trained = new Set();
    list.forEach(l => {
      const d = new Date(l.fecha);
      if (d.getFullYear() === y && d.getMonth() === m) trained.add(d.getDate());
    });
    let trainedCount = 0;
    for (let d = 1; d <= lastDay; d++) if (trained.has(d)) trainedCount++;
    const rate = (trainedCount / lastDay * 7).toFixed(1);
    const monthLabel = viewDate.toLocaleDateString('es-AR', { month: 'long', year: 'numeric' });
    let calCells = '';
    for (let i = 0; i < startPad; i++) calCells += '<div class="stats-cal-cell empty"></div>';
    for (let d = 1; d <= lastDay; d++) {
      calCells += `<div class="stats-cal-cell${trained.has(d) ? ' trained' : ''}"></div>`;
    }


    return `
      <div class="stats-page">
        <h2 class="stats-title">Estadísticas</h2>
        <p class="stats-sub">Elegí un entrenamiento y mirá distribución, progreso y constancia.</p>

        <section class="stats-card">
          <label class="stats-label" for="statsSelectRutina">Rutina</label>
          <select id="statsSelectRutina" class="stats-select">${optionsRutina}</select>
          <label class="stats-label" for="statsSelectDia" style="margin-top:12px">Día de la rutina</label>
          <select id="statsSelectDia" class="stats-select">${optionsDia}</select>
          <p class="stats-hint" style="margin-top:10px">Última sesión de este día: <strong style="color:#fff">${_statsFormatFecha(selected.fecha)}</strong> · ${selected.diaNombre || ''}</p>
          <p class="stats-hint">${compareHint}</p>
        </section>

        <section class="stats-card">
          <div class="stats-card-head">
            <h3>Distribución muscular</h3>
            <span class="stats-badge">${muscleFuente === 'rutina' ? 'Según rutina' : 'Última sesión'}${muscleDist.length ? ' · ' + muscleDist.length + ' grupos' : ''}</span>
          </div>
          <p class="stats-hint">${muscleFuente === 'rutina'
            ? 'Se calcula con los ejercicios actuales de este día en la rutina (se actualiza al editarla).'
            : 'No se encontró el día en la rutina; se usa la última sesión registrada.'}</p>
          <div class="stats-muscle-bars">${muscleHtml}</div>
        </section>

        <section class="stats-card">
          <div class="stats-card-head">
            <h3>Comparación</h3>
            <span class="stats-badge">${chain.length > 1 ? chain.length + ' sesiones' : 'Solo este'}</span>
          </div>
          <p class="stats-hint">${compareHint}</p>
          <div class="stats-chart-wrap">
            <canvas id="statsLineChart" width="640" height="280" data-chart="${chartPayload}"></canvas>
          </div>
          <div class="stats-legend">
            ${seriesList.map(s => `<span><i style="background:${s.color}"></i> ${s.isCurrent ? 'Este' : s.label}</span>`).join('')}
          </div>
        </section>

        <section class="stats-card">
          <div class="stats-card-head">
            <h3>Constancia</h3>
            <div class="stats-month-nav">
              <button type="button" class="stats-icon-btn" id="statsPrevMonth">‹</button>
              <span>${monthLabel}</span>
              <button type="button" class="stats-icon-btn" id="statsNextMonth">›</button>
            </div>
          </div>
          <p class="stats-hint">${trainedCount}/${lastDay} días · ~${rate}×/semana</p>
          <div class="stats-cal-weekdays"><span>L</span><span>M</span><span>X</span><span>J</span><span>V</span><span>S</span><span>D</span></div>
          <div class="stats-cal-grid">${calCells}</div>
          <div class="stats-cal-legend">
            <span><i class="on"></i> Entrenó</span>
            <span><i class="off"></i> Descanso</span>
          </div>
        </section>
      </div>
    `;
  }

  function _drawStatsLineChart(canvas) {
    if (!canvas) return;
    let payload = null;
    try {
      payload = JSON.parse(decodeURIComponent(canvas.getAttribute('data-chart') || '') || 'null');
    } catch (_) { return; }
    if (!payload || !payload.labels) return;
    const labels = payload.labels;
    let seriesList = Array.isArray(payload.seriesList) ? payload.seriesList : [];
    if (!seriesList.length && payload.seriesA) {
      seriesList = [{ values: payload.seriesA, isCurrent: true, color: '#3b82f6' }];
      if (payload.seriesB) seriesList.unshift({ values: payload.seriesB, isCurrent: false, color: 'rgba(148,163,184,0.55)' });
    }

    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    // En celu a veces clientWidth es 0 en el primer paint
    const parentW = canvas.parentElement ? canvas.parentElement.clientWidth : 0;
    const cssW = Math.max(canvas.clientWidth || parentW || 320, 260);
    const cssH = 220;
    canvas.style.width = '100%';
    canvas.width = Math.floor(cssW * dpr);
    canvas.height = Math.floor(cssH * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const W = cssW, H = cssH;
    const pad = { t: 22, r: 12, b: 44, l: 40 };
    const plotW = W - pad.l - pad.r;
    const plotH = H - pad.t - pad.b;
    ctx.clearRect(0, 0, W, H);

    const allVals = [];
    seriesList.forEach(s => (s.values || []).forEach(v => allVals.push(Number(v) || 0)));
    const maxRaw = allVals.length ? Math.max(...allVals) : 0;
    const maxY = Math.max(10, maxRaw) * 1.2;

    // Grid
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = pad.t + (plotH * i) / 4;
      ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(W - pad.r, y); ctx.stroke();
      const val = Math.round(maxY * (1 - i / 4));
      ctx.fillStyle = '#6b7280';
      ctx.font = '9px system-ui, sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText(String(val), pad.l - 6, y + 3);
    }

    const n = Math.max(1, labels.length);
    function xAt(i) {
      if (n <= 1) return pad.l + plotW / 2;
      return pad.l + (plotW * i) / (n - 1);
    }
    function yAt(v) { return pad.t + plotH - (Math.max(0, Number(v) || 0) / maxY) * plotH; }

    function drawLine(values, color, thick, isCurrent) {
      if (!values || !values.length) return;
      const pts = values.map((v, i) => ({ x: xAt(i), y: yAt(v), v }));
      const baseY = pad.t + plotH;
      ctx.beginPath();
      if (pts.length === 1) {
        // Sube desde abajo hasta el valor (no una raya horizontal aislada)
        const p = pts[0];
        const xL = Math.max(pad.l, p.x - plotW * 0.22);
        const xR = Math.min(W - pad.r, p.x + plotW * 0.22);
        ctx.moveTo(xL, baseY);
        ctx.quadraticCurveTo(xL, p.y, p.x, p.y);
        ctx.quadraticCurveTo(xR, p.y, xR, baseY);
      } else if (pts.length === 2) {
        ctx.moveTo(pts[0].x, baseY);
        ctx.quadraticCurveTo(pts[0].x, pts[0].y, pts[0].x, pts[0].y);
        ctx.quadraticCurveTo((pts[0].x + pts[1].x) / 2, (pts[0].y + pts[1].y) / 2, pts[1].x, pts[1].y);
      } else {
        // Curva suave entre ejercicios
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 0; i < pts.length - 1; i++) {
          const p0 = pts[i];
          const p1 = pts[i + 1];
          const cx = (p0.x + p1.x) / 2;
          ctx.quadraticCurveTo(p0.x, p0.y, cx, (p0.y + p1.y) / 2);
          ctx.quadraticCurveTo(p1.x, p1.y, p1.x, p1.y);
        }
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = thick;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.stroke();
      pts.forEach(p => {
        ctx.beginPath();
        ctx.arc(p.x, p.y, isCurrent ? 5 : 3.5, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        if (isCurrent) {
          ctx.beginPath();
          ctx.arc(p.x, p.y, 2, 0, Math.PI * 2);
          ctx.fillStyle = '#0a0a0c';
          ctx.fill();
          ctx.fillStyle = '#e5e7eb';
          ctx.font = '10px system-ui, sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText(String(Math.round(p.v)), p.x, p.y - 10);
        }
      });
    }

    // Anteriores atrás, actual arriba (como gráfico de varias series)
    seriesList.filter(s => !s.isCurrent).forEach(s => drawLine(s.values, s.color || '#94a3b8', 2.4, false));
    seriesList.filter(s => s.isCurrent).forEach(s => drawLine(s.values, s.color || '#3b82f6', 3.2, true));

    // Labels X (ejercicios)
    ctx.fillStyle = '#8b8b96';
    ctx.font = '9px system-ui, sans-serif';
    ctx.textAlign = 'center';
    labels.forEach((lab, i) => {
      const short = lab.length > 10 ? lab.slice(0, 9) + '…' : lab;
      ctx.fillText(short, xAt(i), H - 14);
    });
  }

  function bindStatsEvents(logs) {
    const list = logs || [];
    document.getElementById('statsSelectRutina')?.addEventListener('change', (e) => {
      appState.statsSelectedRutinaId = e.target.value;
      appState.statsSelectedDiaKey = null; // reset día al cambiar rutina
      renderApp();
    });
    document.getElementById('statsSelectDia')?.addEventListener('change', (e) => {
      appState.statsSelectedDiaKey = e.target.value;
      renderApp();
    });
    document.getElementById('statsPrevMonth')?.addEventListener('click', () => {
      appState.statsMonthOffset = (Number(appState.statsMonthOffset) || 0) - 1;
      renderApp();
    });
    document.getElementById('statsNextMonth')?.addEventListener('click', () => {
      appState.statsMonthOffset = (Number(appState.statsMonthOffset) || 0) + 1;
      renderApp();
    });
    const draw = () => _drawStatsLineChart(document.getElementById('statsLineChart'));
    requestAnimationFrame(() => requestAnimationFrame(draw));
    // Redibujar al rotar / cambiar tamaño (celu)
    if (!window._statsChartResizeBound) {
      window._statsChartResizeBound = true;
      window.addEventListener('resize', () => {
        if (appState.tabCliente === 'stats') draw();
      });
    }
  }

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
                   style="display:${tieneRegistros ? 'block' : 'none'}; padding:10px 0 0">
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
                            ${permitirEdicion ? `
                              <div style="display:flex; gap:6px; flex-wrap:wrap; justify-content:flex-end">
                                ${store.puedeEditarseEntrenamiento(log) ? `
                                  <button class="btn btn-secondary btn-sm btn-editar-entrenamiento-click" data-log-id="${log.id}" style="border-color:var(--yellow-warning); color:var(--yellow-warning); padding:4px 10px; font-size:0.75rem">✏️ Editar</button>
                                ` : ''}
                                <button class="btn btn-secondary btn-sm btn-borrar-entrenamiento-click" data-log-id="${log.id}" style="border-color:var(--red-primary); color:var(--red-primary); padding:4px 10px; font-size:0.75rem">🗑️ Borrar</button>
                              </div>
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
                            const setsArr = log.sets || [];
                            if (!setsArr.length) {
                              return `<div style="font-size:0.82rem; color:var(--text-gray); padding:8px 0">
                                Sin detalle de series guardado para este entrenamiento.
                                (Los nuevos entrenamientos sí guardan series, reps y pesos.)
                              </div>`;
                            }
                            const ejMap = {};
                            setsArr.forEach(s => {
                              const key = s.ejercicioNombre || s.ejercicio || s.nombre || 'Ejercicio';
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
                                    Serie ${s.setNumero != null ? s.setNumero : ''}: <strong>${s.repsRealizadas != null ? s.repsRealizadas : (s.reps || '—')} reps</strong>
                                    con <strong>${s.pesoUtilizado != null ? s.pesoUtilizado : (s.peso || '—')}</strong>
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
      const cursorPos = e.target.selectionStart;
      appState.busquedaProfesor = e.target.value;
      renderApp();
      const newInputSearch = document.getElementById('inputSearchProf');
      if (newInputSearch) {
        newInputSearch.focus();
        newInputSearch.setSelectionRange(cursorPos, cursorPos);
      }
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
    // Recargar una sola vez cuando el nuevo SW toma control (evita quedar con JS/CSS viejo)
    let refreshing = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (refreshing) return;
      refreshing = true;
      window.location.reload();
    });

    navigator.serviceWorker.register('./sw.js')
      .then(reg => {
        console.log('✅ Service Worker PWA activo');
        // Buscar actualización al abrir la app
        reg.update().catch(() => {});
        // Si ya hay un SW en waiting, forzar activación
        if (reg.waiting) {
          reg.waiting.postMessage({ type: 'SKIP_WAITING' });
        }
        reg.addEventListener('updatefound', () => {
          const worker = reg.installing;
          if (!worker) return;
          worker.addEventListener('statechange', () => {
            if (worker.state === 'installed' && navigator.serviceWorker.controller) {
              // Nueva versión lista: activar (skipWaiting ya está en sw.js; claim + controllerchange recarga)
              worker.postMessage({ type: 'SKIP_WAITING' });
            }
          });
        });
      })
      .catch(err => console.warn('Error SW:', err));

    // Al volver a la app (cerrar y abrir / cambiar de pestaña), chequear update
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        navigator.serviceWorker.getRegistration('./sw.js').then(reg => {
          if (reg) reg.update().catch(() => {});
        });
      }
    });

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
    logABorrarId: null,       // entrenamiento pendiente de confirmar borrado
    finalizandoEntrenamiento: false, // candado anti doble-toque al finalizar
    statsSelectedLogId: null,
    statsMonthOffset: 0,
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
              <svg class="header-icon header-icon-bell" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="width:24px;height:24px;min-width:24px;min-height:24px;display:block;color:#fff;"><path d="M10.268 21a2 2 0 0 0 3.464 0"/><path d="M22 8c0-2.3-.8-4.3-2-6"/><path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326"/><path d="M4 2C2.8 3.7 2 5.7 2 8"/></svg>
              ${!pushConcedido
                ? `<span class="notif-bell-dot" title="Push desactivado"></span>`
                : (unreadCount > 0 ? `<span style="position:absolute; top:-4px; right:-4px; background:var(--red-primary); color:#fff; border-radius:50%; width:18px; height:18px; font-size:0.7rem; font-weight:800; display:flex; align-items:center; justify-content:center">${unreadCount}</span>` : '')
              }
            </button>
            <button class="btn btn-secondary btn-sm header-logout-btn" id="btnLogout"><span class="header-logout-label">Salir</span> <svg class="header-icon" xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/></svg></button>
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
    const iconStats = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><path d="M7 16V9"/><path d="M12 16v-5"/><path d="M17 16V7"/></svg>`;

    const items = isProfesor ? [
      { id: 'navAlumnos',    label: 'Alumnos', icon: iconAlumnos, active: appState.modalActivo === null && !appState.mostrarDrawerNotifs },
      { id: 'navAvisosProf', label: 'Avisos',   icon: iconAvisos,  active: appState.mostrarDrawerNotifs, badge: unreadCount }
    ] : [
      { id: 'navRutina',       label: 'Rutinas',   icon: iconRutina,    active: appState.tabCliente === 'rutina' && !appState.mostrarDrawerNotifs },
      { id: 'navMisRutinas',   label: 'Mías',       icon: iconMisRutinas, active: appState.tabCliente === 'mis_rutinas' && !appState.mostrarDrawerNotifs },
      { id: 'navRanking',      label: 'Ranking',    icon: iconRanking,   active: appState.tabCliente === 'ranking' && !appState.mostrarDrawerNotifs },
      { id: 'navHistorial',    label: 'Historial', icon: iconHistorial, active: appState.tabCliente === 'historial' && !appState.mostrarDrawerNotifs },
      { id: 'navStats',        label: 'Stats',      icon: iconStats,     active: appState.tabCliente === 'stats' && !appState.mostrarDrawerNotifs }
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
                  const idx = gymStore.data.workoutLogs.findIndex(w => String(w.id) === String(sbLog.id));
                  const remoteSets = Array.isArray(sbLog.sets) ? sbLog.sets : [];
                  if (idx >= 0) {
                    const local = gymStore.data.workoutLogs[idx];
                    const localSets = Array.isArray(local.sets) ? local.sets : [];
                    const sets = remoteSets.length > 0 ? remoteSets : localSets;
                    gymStore.data.workoutLogs[idx] = { ...local, ...sbLog, sets };
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
        ${appState.tabCliente === 'stats' ? renderStatsView(historialEntrenamientos) : ''}
      </main>

      ${(appState.modalActivo === 'crear_rutina_propia' || appState.modalActivo === 'editar_rutina_propia') ? renderModalFormularioRutina(appState.modalActivo) : ''}
      ${appState.modalActivo === 'editar_entrenamiento' ? renderModalEditarEntrenamiento(alumno) : ''}
      ${appState.modalActivo === 'confirmar_borrar_entrenamiento' ? renderModalConfirmarBorrarEntrenamiento(alumno) : ''}
      ${appState.borradorEntrenamientoDetectado ? renderModalRecuperarBorrador() : ''}

      ${renderBottomNav()}
    `;

    bindHeaderEvents();
    bindInstallBannerEvents();
    bindBottomNavEvents();
    bindMisRutinasEvents(alumno);
    bindHistorialEvents(alumno);
    if (appState.tabCliente === 'stats') bindStatsEvents(historialEntrenamientos);
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
            (async () => {
              try {
                const resultado = await store.eliminarRutinaPropia(rId, alumno.id);
                if (!resultado || resultado.ok !== true) {
                  alert("❌ No se pudo eliminar la rutina: " + ((resultado && resultado.error) || "error desconocido"));
                }
              } catch (err) {
                alert("❌ Error: " + err.message);
              }
              renderApp();
            })();
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

    document.querySelectorAll('.btn-borrar-entrenamiento-click').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const logId = btn.dataset.logId;
        const log = store.data.workoutLogs.find(w => w.id === logId);
        if (!log) return;
        appState.logABorrarId = logId;
        appState.modalActivo = 'confirmar_borrar_entrenamiento';
        renderApp();
      });
    });
  }

  function renderModalConfirmarBorrarEntrenamiento(alumno) {
    const log = store.data.workoutLogs.find(w => w.id === appState.logABorrarId);
    if (!log) return '';
    const fechaTxt = log.fecha
      ? new Date(log.fecha).toLocaleString('es-AR', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
      : '';
    return `
      <div class="modal-overlay">
        <div class="modal-content" style="max-width:420px">
          <div class="modal-header">
            <h3>🗑️ Borrar entrenamiento</h3>
            <button class="close-btn" id="btnCloseModal">&times;</button>
          </div>
          <p style="color:var(--text-gray); font-size:0.92rem; line-height:1.45; margin-bottom:8px">
            ¿Seguro que querés borrar este entrenamiento?
          </p>
          <div style="background:rgba(255,255,255,0.04); border-radius:10px; padding:12px 14px; margin-bottom:16px">
            <div style="font-weight:800; color:#fff">${log.diaNombre || 'Entrenamiento'}</div>
            <div style="font-size:0.8rem; color:var(--text-gray); margin-top:4px">${fechaTxt}</div>
            ${log.puntos ? `<div style="font-size:0.8rem; color:var(--red-primary); margin-top:6px; font-weight:700">−${log.puntos} pts se restarán del ranking</div>` : ''}
          </div>
          <p style="font-size:0.78rem; color:var(--text-muted); margin-bottom:16px">Esta acción no se puede deshacer.</p>
          <div style="display:flex; justify-content:flex-end; gap:10px">
            <button type="button" class="btn btn-secondary" id="btnCancelModal">Cancelar</button>
            <button type="button" class="btn btn-primary" id="btnConfirmarBorrarEntrenamiento" style="background:var(--red-primary)">Sí, borrar</button>
          </div>
        </div>
      </div>
    `;
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

  // --- FEATURE RANKING: podio Top 3 + lista desde el 4º ---
  function renderRankingView() {
    const ranking = store.getRanking();
    const miId = appState.usuarioActual.data.id;
    const medalla = (pos) => pos === 1 ? '🥇' : pos === 2 ? '🥈' : pos === 3 ? '🥉' : `#${pos}`;

    const top3 = ranking.filter(a => a.posicion <= 3);
    const resto = ranking.filter(a => a.posicion > 3);
    const byPos = (pos) => top3.find(a => a.posicion === pos) || null;

    // Colores e alturas inline para que el podio se vea aunque falle el CSS externo
    const blockStyle = {
      1: 'height:112px;background:linear-gradient(180deg,#f5d76e 0%,#d4a017 55%,#b8860b 100%);',
      2: 'height:80px;background:linear-gradient(180deg,#e8e8ec 0%,#b0b0b8 55%,#8a8a94 100%);',
      3: 'height:64px;background:linear-gradient(180deg,#d4a574 0%,#a66b3a 55%,#8b5a2b 100%);'
    };
    const slotBase = 'flex:1 1 0;min-width:0;max-width:140px;display:flex;flex-direction:column;align-items:center;text-align:center;';
    const blockBase = 'width:100%;border-radius:10px 10px 4px 4px;display:flex;align-items:flex-start;justify-content:center;padding-top:12px;box-shadow:inset 0 1px 0 rgba(255,255,255,0.15);';
    const numBase = 'font-size:1.4rem;font-weight:900;line-height:1;color:rgba(0,0,0,0.5);';

    const renderPodiumSlot = (a, place) => {
      const empty = !a;
      const isMe = a && a.id === miId;
      const name = empty ? '' : a.nombre;
      const pts = empty ? '' : `${Math.round(a.puntosTotal || 0)} pts`;
      const streak = (!empty && a.rachaSemanal && a.rachaSemanal.semanas >= 2)
        ? `<div style="font-size:0.68rem;font-weight:700;color:#f59e0b;">🔥 ${a.rachaSemanal.semanas} sem</div>`
        : '';
      const meBadge = isMe ? ' <span style="color:#ff2e2e;font-weight:800;">(Vos)</span>' : '';
      const meRing = isMe ? 'box-shadow:inset 0 1px 0 rgba(255,255,255,0.18),0 0 0 2px #ff2e2e;' : '';
      const opacity = empty ? 'opacity:0.35;' : '';

      return `
        <div class="podium-slot podium-slot-${place}${isMe ? ' podium-slot-me' : ''}${empty ? ' podium-slot-empty' : ''}"
             style="${slotBase}${opacity}" ${empty ? 'aria-hidden="true"' : ''}>
          <div class="podium-meta${place === 1 && !empty ? ' podium-meta-first' : ''}" style="width:100%;padding:0 4px 10px;display:flex;flex-direction:column;align-items:center;gap:2px;min-height:52px;justify-content:flex-end;position:relative;">
            ${empty ? '' : `
              ${place === 1 ? `<span class="podium-sparks" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></span>` : ''}
              <div class="podium-name" title="${name}" style="font-size:0.82rem;font-weight:800;color:#fff;line-height:1.2;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;position:relative;z-index:1;">${name}${meBadge}</div>
              <div class="podium-pts" style="font-size:0.78rem;font-weight:900;color:#ff2e2e;white-space:nowrap;position:relative;z-index:1;">${pts}</div>
              ${streak}
            `}
          </div>
          <div class="podium-block" style="${blockBase}${blockStyle[place]}${meRing}">
            <span class="podium-num" style="${numBase}${place === 1 ? 'font-size:1.55rem;' : ''}">${place}</span>
          </div>
        </div>`;
    };

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
        <style>
          /* Podio: uno por uno 3 → 2 → 1. Nombre del 1º flota sutil (como el trofeo). */
          @keyframes efColRise {
            0%   { opacity: 0; transform: scaleY(0.08); }
            100% { opacity: 1; transform: scaleY(1); }
          }
          @keyframes efNameIn {
            0%   { opacity: 0; transform: translateY(8px); }
            100% { opacity: 1; transform: translateY(0); }
          }
          /* Movimiento del nombre del 1º (equivalente al trofeo del video) */
          @keyframes efNameFloat {
            0%, 100% { transform: translateY(0); }
            50%      { transform: translateY(-7px); }
          }

          .podium-slot {
            opacity: 1;
          }
          /* Columnas empiezan invisibles; aparecen en secuencia clara */
          .podium-block {
            opacity: 0;
            transform-origin: bottom center !important;
            animation: efColRise 0.42s cubic-bezier(0.25, 0.9, 0.3, 1) both !important;
          }
          .podium-meta {
            opacity: 0;
            animation: efNameIn 0.32s ease both !important;
          }

          /* 3º primero */
          .podium-slot-3 .podium-block { animation-delay: 0.05s !important; }
          .podium-slot-3 .podium-meta  { animation-delay: 0.18s !important; }
          /* 2º después (espera a que termine el 3) */
          .podium-slot-2 .podium-block { animation-delay: 0.48s !important; }
          .podium-slot-2 .podium-meta  { animation-delay: 0.60s !important; }
          /* 1º al final */
          .podium-slot-1 .podium-block { animation-delay: 0.90s !important; }
          .podium-slot-1 .podium-meta  {
            animation:
              efNameIn 0.32s ease 1.02s both,
              efNameFloat 1.6s ease-in-out 1.4s 2 !important; /* 2 flotaciones sutiles */
          }

          .podium-block::after { display: none !important; }
          /* Chispas sutiles solo en el 1º (~2s) */
          .podium-sparks {
            position: absolute;
            left: 50%;
            top: 28%;
            width: 0;
            height: 0;
            pointer-events: none;
            z-index: 2;
          }
          .podium-sparks i {
            position: absolute;
            width: 4px;
            height: 4px;
            border-radius: 50%;
            background: #ffe9a0;
            box-shadow: 0 0 6px 1px rgba(255, 215, 80, 0.85);
            opacity: 0;
            animation: efSpark 1.9s ease-out 1.05s both;
          }
          .podium-sparks i:nth-child(1) { --dx: -18px; --dy: -22px; animation-delay: 1.05s; background: #fff6c8; }
          .podium-sparks i:nth-child(2) { --dx: 16px;  --dy: -24px; animation-delay: 1.12s; background: #ffd36b; width: 3px; height: 3px; }
          .podium-sparks i:nth-child(3) { --dx: -26px; --dy: -8px;  animation-delay: 1.18s; background: #ffb347; }
          .podium-sparks i:nth-child(4) { --dx: 24px;  --dy: -10px; animation-delay: 1.22s; background: #fff; width: 3px; height: 3px; }
          .podium-sparks i:nth-child(5) { --dx: -10px; --dy: -30px; animation-delay: 1.28s; background: #ffe08a; }
          .podium-sparks i:nth-child(6) { --dx: 8px;   --dy: -28px; animation-delay: 1.34s; background: #ff9f43; width: 3px; height: 3px; }
          .podium-sparks i:nth-child(7) { --dx: -22px; --dy: 4px;   animation-delay: 1.40s; background: #fff3b0; }
          .podium-sparks i:nth-child(8) { --dx: 20px;  --dy: 2px;   animation-delay: 1.46s; background: #ffd27a; width: 3px; height: 3px; }
          @keyframes efSpark {
            0%   { opacity: 0; transform: translate(0, 0) scale(0.4); }
            18%  { opacity: 1; transform: translate(calc(var(--dx) * 0.35), calc(var(--dy) * 0.35)) scale(1); }
            70%  { opacity: 0.85; }
            100% { opacity: 0; transform: translate(var(--dx), var(--dy)) scale(0.2); }
          }
          @media (prefers-reduced-motion: reduce) {
            .podium-sparks { display: none !important; }
          }

          .podium-slot:hover .podium-block {
            transform: translateY(-3px) !important;
            transition: transform 0.18s ease !important;
          }
          @media (prefers-reduced-motion: reduce) {
            .podium-block,
            .podium-meta {
              opacity: 1 !important;
              animation: none !important;
            }
            .podium-slot:hover .podium-block { transform: none !important; }
          }
        </style>
        <div class="podium" role="list" aria-label="Podio top 3"
             style="display:flex;align-items:flex-end;justify-content:center;gap:8px;width:100%;max-width:100%;padding:8px 0 4px;box-sizing:border-box;">
          ${renderPodiumSlot(byPos(2), 2)}
          ${renderPodiumSlot(byPos(1), 1)}
          ${renderPodiumSlot(byPos(3), 3)}
        </div>

        ${resto.length > 0 ? `
          <div class="ranking-list ranking-list-rest" style="margin-top:18px;display:flex;flex-direction:column;gap:10px;">
            ${resto.map(a => `
              <div class="ranking-row ${a.id === miId ? 'ranking-row-me' : ''}">
                <div class="ranking-pos">${medalla(a.posicion)}</div>
                <div class="ranking-info">
                  <div class="ranking-name">${a.nombre}${a.id === miId ? ' <span style="color:var(--red-primary)">(Vos)</span>' : ''}</div>
                  ${a.rachaSemanal && a.rachaSemanal.semanas >= 2 ? `<div class="ranking-streak">🔥 Racha de ${a.rachaSemanal.semanas} semanas</div>` : ''}
                </div>
                <div class="ranking-points">${Math.round(a.puntosTotal || 0)} pts</div>
              </div>
            `).join('')}
          </div>
        ` : ''}
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
        <div class="exercise-block${ej.esEntradaEnCalor ? ' exercise-block-warmup' : ''}">
          <div style="font-size:1.15rem; font-weight:900; color:#fff; margin-bottom:8px">${ej.esEntradaEnCalor ? '🔥 ' : ''}${ej.nombre}${ej.esEntradaEnCalor ? ' <span class="warmup-badge">Entrada en calor</span>' : ''}</div>

          <div class="target-box">
            <div class="target-title">${ej.esEntradaEnCalor ? '🔥 Activación / Entrada en calor' : '🎯 Objetivo Indicado por el Profesor:'}</div>
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
            <div class="exercise-block${ej.esEntradaEnCalor ? ' exercise-block-warmup' : ''}">
              <div class="exercise-title" style="font-size:1.15rem; font-weight:900; color:#fff">${ej.esEntradaEnCalor ? '🔥 ' : ''}${ej.nombre}${ej.esEntradaEnCalor ? ' <span class="warmup-badge">Entrada en calor</span>' : ''}</div>

              <div class="target-box">
                <div class="target-title">${ej.esEntradaEnCalor ? '🔥 ACTIVACIÓN / ENTRADA EN CALOR' : '🎯 OBJETIVO DEL PROFESOR'}</div>
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

  // --- ESTADÍSTICAS DEL ALUMNO (distribución, comparación, constancia) ---
  function _statsMuscleOf(name) {
    // Normalizar: minúsculas, sin acentos, espacios simples
    const n = String(name || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!n) return 'Otros';

    // --- Orden: más específico primero (evitar que "press" genérico coma todo) ---

    // Tríceps (antes que pecho: press francés, fondos en paralelas a veces pecho, extension)
    if (/triceps|tricep|press frances|frances|skull ?crusher|extension (de )?(triceps|codo)|extension tras( de)? nuca|extension trasnuca|patada de triceps|kickback|push ?down|pushdown|fondos en paralela|fondo en paralela|press cerrado|press agarre cerrado/.test(n)) return 'Triceps';

    // Bíceps
    if (/biceps|bicep|curl (de )?(biceps|barra|mancuerna|polea|martillo|concentrado|predicador|scott)|hammer curl|curl martillo|curl scott|curl predicador|curl con barra|curl con mancuern/.test(n)) return 'Biceps';
    if (/\bcurl\b/.test(n) && !/femoral|pierna|leg curl|isquio/.test(n)) return 'Biceps';

    // Hombros (vuelos laterales, press arnold, militar, pallof a veces core pero pallof es core)
    if (/press arnold|arnold press|press militar|militar|shoulder press|press de hombro|press hombro|press de hombros/.test(n)) return 'Hombros';
    if (/vuelo?s? laterales?|elevacion(es)? laterales?|lateral raise|vuelo?s? frontales?|elevacion(es)? frontales?|front raise/.test(n)) return 'Hombros';
    if (/pajaro|face pull|rear delt|deltoides? posterior|elevacion posterior/.test(n)) return 'Hombros';
    if (/rotacion (de )?hombro|rotacion externa|hombro con banda/.test(n)) return 'Hombros';
    if (/\bhombro|\bhombros\b|deltoid/.test(n)) return 'Hombros';

    // Espalda ANTES que pecho (ej. "jalon al pecho" es espalda, no pecho)
    if (/jalon|dorsalera|dorsal|pulldown|dominada|pull ?up|chin ?up/.test(n)) return 'Espalda';
    if (/\bremo\b|\brows?\b/.test(n)) return 'Espalda';
    if (/pull ?over|pullover|encogimiento|trapecio|espalda/.test(n)) return 'Espalda';

    // Pecho
    if (/press (de )?(banca|banco|plano|inclinado|declinado)|bench press|press plano|press inclinado|press declinado/.test(n)) return 'Pecho';
    if (/apertura|aperturas|\bfly\b|crossover|cruce(s)?( de)?( cable|polea)?|pec ?deck|peck ?deck|contractora/.test(n)) return 'Pecho';
    if (/fondos en banco|fondo en banco|fondos entre bancos|push ?up|flexiones/.test(n)) return 'Pecho';
    if (/\bpecho\b|pectoral/.test(n) && !/jalon|dorsal|remo/.test(n)) return 'Pecho';
    if (/press en smith|press en maquina/.test(n) && /pecho|banca|plano|inclinado/.test(n)) return 'Pecho';

    // Piernas
    if (/gemelo|pantorrilla|elevacion de gemelo|calf|suelo de gemelo/.test(n)) return 'Gemelos';
    if (/femoral|isquio|curl femoral|curl de pierna|leg curl|nordic|camilla de isquio/.test(n)) return 'Femoral';
    if (/gluteo|glute|hip thrust|puente de glute|patada de glute|abduccion|abductor|aductor|adductor|patada glute/.test(n)) return 'Gluteos';
    if (/sentadilla|squat|prensa|leg press|hack|zancada|estocada|lunge|bulgara|extension de cuad|extension de pierna|leg extension|cuadriceps|cuadricera/.test(n)) return 'Cuadriceps';
    if (/peso muerto|deadlift|rumano|\brdl\b|cargada/.test(n)) return 'Femoral';

    // Core / abdomen
    if (/abdomen|abdominal|abs\b|crunch|plancha|core|rueda abdominal|elevacion de piernas|sit ?up|situp|press pallof|pallof|wall ball|burpee|burpi/.test(n)) return 'Core';

    // Press genérico sin contexto: suele ser pecho en gimnasio arg
    if (/\bpress\b/.test(n) && !/pierna|hombro|militar|arnold|frances|triceps|pallof/.test(n)) return 'Pecho';

    return 'Otros';
  }

  function _statsParsePesoKg(peso) {
    if (peso == null || peso === '') return 0;
    if (typeof peso === 'number') return peso;
    const m = String(peso).replace(',', '.').match(/-?\d+(\.\d+)?/);
    return m ? parseFloat(m[0]) : 0;
  }

  function _statsDiaKey(log) {
    const raw = String(log.diaNombre || log.diaId || log.diaNumero || 'dia').toLowerCase();
    return raw.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();
  }

  /** Nombres de ejercicios únicos ordenados (firma del estímulo). */
  function _statsExerciseSignature(log) {
    const names = new Set();
    (log.sets || []).forEach(s => {
      const n = String(s.ejercicioNombre || s.ejercicio || s.nombre || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (n) names.add(n);
    });
    return Array.from(names).sort().join('|');
  }

  /**
   * Anterior comparable:
   * 1) Mismo nombre de día (ej. "Espalda y bicep")
   * 2) Mismos ejercicios exactos (ej. lunes = jueves con la misma lista)
   * 3) Solapamiento >= 70% de ejercicios del actual
   */
  function _statsFindPreviousComparable(selected, list) {
    const selDate = new Date(selected.fecha).getTime();
    const earlier = (list || [])
      .filter(l => l.id !== selected.id && new Date(l.fecha).getTime() < selDate)
      .sort((a, b) => new Date(b.fecha) - new Date(a.fecha));
    if (!earlier.length) return { prev: null, matchType: null };

    const key = _statsDiaKey(selected);
    const byName = earlier.find(l => _statsDiaKey(l) === key);
    if (byName) return { prev: byName, matchType: 'nombre' };

    const sig = _statsExerciseSignature(selected);
    if (sig) {
      const byExact = earlier.find(l => _statsExerciseSignature(l) === sig);
      if (byExact) return { prev: byExact, matchType: 'ejercicios' };
    }

    const selSet = new Set(sig ? sig.split('|').filter(Boolean) : []);
    if (selSet.size >= 2) {
      let best = null;
      let bestRatio = 0;
      earlier.forEach(l => {
        const other = _statsExerciseSignature(l);
        if (!other) return;
        const oSet = new Set(other.split('|'));
        let inter = 0;
        selSet.forEach(n => { if (oSet.has(n)) inter++; });
        const ratio = inter / selSet.size;
        if (ratio >= 0.7 && ratio > bestRatio) {
          bestRatio = ratio;
          best = l;
        }
      });
      if (best) return { prev: best, matchType: 'similares' };
    }
    return { prev: null, matchType: null };
  }

  function _statsFormatFecha(iso) {
    try {
      return new Date(iso).toLocaleDateString('es-AR', { weekday: 'short', day: 'numeric', month: 'short' });
    } catch (_) {
      return '—';
    }
  }

  function renderStatsView(logs) {
    const list = (logs || []).slice().sort((a, b) => new Date(b.fecha) - new Date(a.fecha));
    if (!list.length) {
      return `<div class="stats-page">
        <h2 class="stats-title">Estadísticas</h2>
        <p class="stats-sub">Todavía no hay entrenamientos registrados. Completá una sesión para ver distribución, progreso y constancia.</p>
      </div>`;
    }

    if (appState.statsMonthOffset == null) appState.statsMonthOffset = 0;

    // --- Selector por RUTINA → DÍA (no por sesión suelta) ---
    const rutinasStore = (store.data && store.data.rutinas) ? store.data.rutinas : [];
    const rutinaIdsEnLogs = [];
    list.forEach(l => {
      const rid = l.rutinaId || 'sin-rutina';
      if (!rutinaIdsEnLogs.includes(rid)) rutinaIdsEnLogs.push(rid);
    });
    // Incluir rutinas del store (alumno) aunque todavía no tengan logs
    const alumnoIdStats = (appState.usuarioActual && appState.usuarioActual.data && appState.usuarioActual.data.id)
      ? String(appState.usuarioActual.data.id) : null;
    rutinasStore.forEach(r => {
      if (!r || !r.id) return;
      if (alumnoIdStats && r.alumnoId && String(r.alumnoId) !== alumnoIdStats) return;
      if (!rutinaIdsEnLogs.includes(r.id)) rutinaIdsEnLogs.push(r.id);
    });
    const rutinaOpciones = rutinaIdsEnLogs.map(rid => {
      const r = rutinasStore.find(x => x.id === rid);
      const titulo = r ? r.titulo : (rid === 'sin-rutina' ? 'Sin rutina' : 'Rutina');
      return { id: rid, titulo };
    });

    if (!appState.statsSelectedRutinaId || !rutinaOpciones.find(r => r.id === appState.statsSelectedRutinaId)) {
      appState.statsSelectedRutinaId = rutinaOpciones[0].id;
    }
    const rutinaIdActiva = appState.statsSelectedRutinaId;

    const logsDeRutina = list.filter(l => (l.rutinaId || 'sin-rutina') === rutinaIdActiva);
    const rutinaObj = rutinasStore.find(x => x.id === rutinaIdActiva) || null;

    // Días: de la rutina actual (se actualiza al editar) + los que aparezcan en logs
    const diasMap = new Map();
    if (rutinaObj && Array.isArray(rutinaObj.dias)) {
      rutinaObj.dias.forEach(d => {
        const fake = { diaNombre: d.nombre, diaId: d.id, diaNumero: d.diaNumero };
        const key = _statsDiaKey(fake);
        if (!key) return;
        if (!diasMap.has(key)) diasMap.set(key, { key, label: d.nombre || key, dayObj: d });
        else if (!diasMap.get(key).dayObj) diasMap.get(key).dayObj = d;
      });
    }
    logsDeRutina.forEach(l => {
      const key = _statsDiaKey(l);
      if (!key) return;
      if (!diasMap.has(key)) {
        diasMap.set(key, { key, label: l.diaNombre || key, dayObj: null });
      }
    });
    const diasOpciones = Array.from(diasMap.values());

    if (!appState.statsSelectedDiaKey || !diasOpciones.find(d => d.key === appState.statsSelectedDiaKey)) {
      appState.statsSelectedDiaKey = diasOpciones.length ? diasOpciones[0].key : null;
    }
    const diaKeyActiva = appState.statsSelectedDiaKey;
    const diaMeta = diasOpciones.find(d => d.key === diaKeyActiva) || null;

    // Sesión de referencia (gráfico de comparación) = la más reciente de esa rutina + ese día
    const logsDelDia = logsDeRutina
      .filter(l => _statsDiaKey(l) === diaKeyActiva)
      .sort((a, b) => new Date(b.fecha) - new Date(a.fecha));
    const selected = logsDelDia[0] || logsDeRutina[0] || list[0];
    appState.statsSelectedLogId = selected.id;

    const optionsRutina = rutinaOpciones.map(r =>
      `<option value="${r.id}" ${r.id === rutinaIdActiva ? 'selected' : ''}>${r.titulo}</option>`
    ).join('');
    const optionsDia = diasOpciones.map(d =>
      `<option value="${d.key}" ${d.key === diaKeyActiva ? 'selected' : ''}>${d.label}</option>`
    ).join('');

    // Distribución muscular: según la RUTINA ACTUAL (ejercicios del día),
    // así al editar la rutina se actualiza de inmediato. Si no hay día en la
    // rutina, se usa la última sesión registrada como fallback.
    const muscleCounts = {};
    let totalSets = 0;
    let muscleFuente = 'rutina';
    const ejerciciosRutinaDia = (diaMeta && diaMeta.dayObj && Array.isArray(diaMeta.dayObj.ejercicios))
      ? diaMeta.dayObj.ejercicios
      : null;

    if (ejerciciosRutinaDia && ejerciciosRutinaDia.length) {
      ejerciciosRutinaDia.forEach(ej => {
        // Entrada en calor no cuenta en la distribución principal
        if (ej.esEntradaEnCalor) return;
        const m = _statsMuscleOf(ej.nombre || '');
        const series = Number(ej.seriesTarget != null ? ej.seriesTarget : ej.series) || 1;
        muscleCounts[m] = (muscleCounts[m] || 0) + series;
        totalSets += series;
      });
    }
    if (totalSets === 0) {
      muscleFuente = 'sesion';
      (selected.sets || []).forEach(s => {
        const m = _statsMuscleOf(s.ejercicioNombre || s.ejercicio || s.nombre || '');
        muscleCounts[m] = (muscleCounts[m] || 0) + 1;
        totalSets++;
      });
    }
    const muscleDist = Object.entries(muscleCounts)
      .map(([name, n]) => ({ name, pct: totalSets ? Math.round((n / totalSets) * 100) : 0, n }))
      .sort((a, b) => b.pct - a.pct);

    const muscleHtml = muscleDist.length
      ? muscleDist.map(d => `
          <div class="stats-muscle-row">
            <div class="stats-muscle-name">${d.name}</div>
            <div class="stats-muscle-track"><div class="stats-muscle-fill" style="width:${d.pct}%"></div></div>
            <div class="stats-muscle-pct">${d.pct}%</div>
          </div>`).join('')
      : `<p class="stats-empty">No hay ejercicios en este día de la rutina ni series en el historial.</p>`;

    // Comparación multi-línea: una línea por sesión comparable (gris) + actual (azul)
    // Eje X = ejercicios del entrenamiento actual; Y = volumen (reps × kg)
    const { prev, matchType } = _statsFindPreviousComparable(selected, list);

    const volMap = (log) => {
      const map = {};
      (log.sets || []).forEach(s => {
        const name = String(
          s.ejercicioNombre || s.ejercicio || s.nombre || s.exercise_nombre || s.exercise_name || 'Ejercicio'
        ).trim() || 'Ejercicio';
        const reps = Number(
          s.repsRealizadas != null ? s.repsRealizadas
            : (s.reps != null ? s.reps
              : (s.reps_realizadas != null ? s.reps_realizadas : 0))
        ) || 0;
        const peso = _statsParsePesoKg(
          s.pesoUtilizado != null ? s.pesoUtilizado
            : (s.peso != null ? s.peso : s.peso_utilizado)
        );
        map[name] = (map[name] || 0) + reps * peso;
      });
      return map;
    };

    // Todos los anteriores comparables (mismo nombre o mismos ejercicios), hasta 8
    const selDate = new Date(selected.fecha).getTime();
    const selKey = _statsDiaKey(selected);
    const selSig = _statsExerciseSignature(selected);
    const prevSessions = list
      .filter(l => {
        if (l.id === selected.id) return false;
        if (new Date(l.fecha).getTime() >= selDate) return false;
        // Preferir misma rutina; si no hay, permitir otras
        const sameRutina = (l.rutinaId || 'sin-rutina') === (selected.rutinaId || 'sin-rutina');
        if (_statsDiaKey(l) === selKey && sameRutina) return true;
        if (_statsDiaKey(l) === selKey) return true;
        if (selSig && _statsExerciseSignature(l) === selSig) return true;
        return false;
      })
      .sort((a, b) => new Date(a.fecha) - new Date(b.fecha)) // viejo → nuevo
      .slice(-8);

    const chain = [...prevSessions, selected]; // para el badge
    const curVol = volMap(selected);
    // Eje X: unión de ejercicios de TODAS las sesiones comparables (no solo la actual)
    const labels = [];
    const pushName = (raw) => {
      const name = String(raw || '').trim() || 'Ejercicio';
      if (name && !labels.includes(name)) labels.push(name);
    };
    chain.forEach(log => {
      (log.sets || []).forEach(s => {
        pushName(s.ejercicioNombre || s.ejercicio || s.nombre || s.exercise_nombre || s.exercise_name);
      });
    });
    // Fallback: ejercicios del día en la rutina actual
    if (!labels.length && ejerciciosRutinaDia && ejerciciosRutinaDia.length) {
      ejerciciosRutinaDia.forEach(ej => {
        if (!ej.esEntradaEnCalor) pushName(ej.nombre);
      });
    }
    if (!labels.length) labels.push('Sin series');

    // seriesList: cada sesión es una línea
    // Colores tipo gráfico clásico (azul actual + naranja/verde/etc. anteriores)
    const prevColors = ['#f97316', '#a78bfa', '#34d399', '#f472b6', '#eab308', '#22d3ee', '#fb7185', '#94a3b8'];
    let prevColorIdx = 0;
    const seriesList = chain.map((log) => {
      const isCurrent = log.id === selected.id;
      const vm = volMap(log);
      const values = labels.map(n => Math.round(vm[n] || 0));
      let fechaTxt = '';
      try {
        fechaTxt = new Date(log.fecha).toLocaleDateString('es-AR', { day: '2-digit', month: 'short' });
      } catch (_) {}
      let color = '#3b82f6';
      if (!isCurrent) {
        color = prevColors[prevColorIdx % prevColors.length];
        prevColorIdx++;
      }
      return {
        id: log.id,
        label: isCurrent ? 'Este' : fechaTxt,
        isCurrent,
        color,
        values
      };
    });

    // Compat con el drawer viejo del canvas
    const seriesA = seriesList.find(s => s.isCurrent)?.values || labels.map(() => 0);
    const seriesB = null;

    let compareHint = 'Cada línea es un entrenamiento. Azul = el que elegiste. Más arriba = más volumen (reps × kg).';
    if (chain.length < 2) {
      compareHint = 'Primera vez de este estímulo: línea azul con el volumen de cada ejercicio. Cuando lo repitas, vas a ver las líneas grises de antes.';
    } else if (matchType === 'nombre') {
      compareHint = `Comparando ${chain.length} sesiones · mismo día (${selected.diaNombre || ''}). Azul = actual.`;
    } else if (matchType === 'ejercicios' || matchType === 'similares') {
      compareHint = `Comparando ${chain.length} sesiones · mismos / similares ejercicios. Azul = actual.`;
    }

    const chartPayload = encodeURIComponent(JSON.stringify({ labels, seriesList }));

    // Calendario
    const now = new Date();
    const offset = Number(appState.statsMonthOffset) || 0;
    const viewDate = new Date(now.getFullYear(), now.getMonth() + offset, 1);
    const y = viewDate.getFullYear();
    const m = viewDate.getMonth();
    const lastDay = new Date(y, m + 1, 0).getDate();
    let startPad = new Date(y, m, 1).getDay() - 1;
    if (startPad < 0) startPad = 6;
    const trained = new Set();
    list.forEach(l => {
      const d = new Date(l.fecha);
      if (d.getFullYear() === y && d.getMonth() === m) trained.add(d.getDate());
    });
    let trainedCount = 0;
    for (let d = 1; d <= lastDay; d++) if (trained.has(d)) trainedCount++;
    const rate = (trainedCount / lastDay * 7).toFixed(1);
    const monthLabel = viewDate.toLocaleDateString('es-AR', { month: 'long', year: 'numeric' });
    let calCells = '';
    for (let i = 0; i < startPad; i++) calCells += '<div class="stats-cal-cell empty"></div>';
    for (let d = 1; d <= lastDay; d++) {
      calCells += `<div class="stats-cal-cell${trained.has(d) ? ' trained' : ''}"></div>`;
    }


    return `
      <div class="stats-page">
        <h2 class="stats-title">Estadísticas</h2>
        <p class="stats-sub">Elegí un entrenamiento y mirá distribución, progreso y constancia.</p>

        <section class="stats-card">
          <label class="stats-label" for="statsSelectRutina">Rutina</label>
          <select id="statsSelectRutina" class="stats-select">${optionsRutina}</select>
          <label class="stats-label" for="statsSelectDia" style="margin-top:12px">Día de la rutina</label>
          <select id="statsSelectDia" class="stats-select">${optionsDia}</select>
          <p class="stats-hint" style="margin-top:10px">Última sesión de este día: <strong style="color:#fff">${_statsFormatFecha(selected.fecha)}</strong> · ${selected.diaNombre || ''}</p>
          <p class="stats-hint">${compareHint}</p>
        </section>

        <section class="stats-card">
          <div class="stats-card-head">
            <h3>Distribución muscular</h3>
            <span class="stats-badge">${muscleFuente === 'rutina' ? 'Según rutina' : 'Última sesión'}${muscleDist.length ? ' · ' + muscleDist.length + ' grupos' : ''}</span>
          </div>
          <p class="stats-hint">${muscleFuente === 'rutina'
            ? 'Se calcula con los ejercicios actuales de este día en la rutina (se actualiza al editarla).'
            : 'No se encontró el día en la rutina; se usa la última sesión registrada.'}</p>
          <div class="stats-muscle-bars">${muscleHtml}</div>
        </section>

        <section class="stats-card">
          <div class="stats-card-head">
            <h3>Comparación</h3>
            <span class="stats-badge">${chain.length > 1 ? chain.length + ' sesiones' : 'Solo este'}</span>
          </div>
          <p class="stats-hint">${compareHint}</p>
          <div class="stats-chart-wrap">
            <canvas id="statsLineChart" width="640" height="280" data-chart="${chartPayload}"></canvas>
          </div>
          <div class="stats-legend">
            ${seriesList.map(s => `<span><i style="background:${s.color}"></i> ${s.isCurrent ? 'Este' : s.label}</span>`).join('')}
          </div>
        </section>

        <section class="stats-card">
          <div class="stats-card-head">
            <h3>Constancia</h3>
            <div class="stats-month-nav">
              <button type="button" class="stats-icon-btn" id="statsPrevMonth">‹</button>
              <span>${monthLabel}</span>
              <button type="button" class="stats-icon-btn" id="statsNextMonth">›</button>
            </div>
          </div>
          <p class="stats-hint">${trainedCount}/${lastDay} días · ~${rate}×/semana</p>
          <div class="stats-cal-weekdays"><span>L</span><span>M</span><span>X</span><span>J</span><span>V</span><span>S</span><span>D</span></div>
          <div class="stats-cal-grid">${calCells}</div>
          <div class="stats-cal-legend">
            <span><i class="on"></i> Entrenó</span>
            <span><i class="off"></i> Descanso</span>
          </div>
        </section>
      </div>
    `;
  }

  function _drawStatsLineChart(canvas) {
    if (!canvas) return;
    let payload = null;
    try {
      payload = JSON.parse(decodeURIComponent(canvas.getAttribute('data-chart') || '') || 'null');
    } catch (_) { return; }
    if (!payload || !payload.labels) return;
    const labels = payload.labels;
    let seriesList = Array.isArray(payload.seriesList) ? payload.seriesList : [];
    if (!seriesList.length && payload.seriesA) {
      seriesList = [{ values: payload.seriesA, isCurrent: true, color: '#3b82f6' }];
      if (payload.seriesB) seriesList.unshift({ values: payload.seriesB, isCurrent: false, color: 'rgba(148,163,184,0.55)' });
    }

    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    // En celu a veces clientWidth es 0 en el primer paint
    const parentW = canvas.parentElement ? canvas.parentElement.clientWidth : 0;
    const cssW = Math.max(canvas.clientWidth || parentW || 320, 260);
    const cssH = 220;
    canvas.style.width = '100%';
    canvas.width = Math.floor(cssW * dpr);
    canvas.height = Math.floor(cssH * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const W = cssW, H = cssH;
    const pad = { t: 22, r: 12, b: 44, l: 40 };
    const plotW = W - pad.l - pad.r;
    const plotH = H - pad.t - pad.b;
    ctx.clearRect(0, 0, W, H);

    const allVals = [];
    seriesList.forEach(s => (s.values || []).forEach(v => allVals.push(Number(v) || 0)));
    const maxRaw = allVals.length ? Math.max(...allVals) : 0;
    const maxY = Math.max(10, maxRaw) * 1.2;

    // Grid
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = pad.t + (plotH * i) / 4;
      ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(W - pad.r, y); ctx.stroke();
      const val = Math.round(maxY * (1 - i / 4));
      ctx.fillStyle = '#6b7280';
      ctx.font = '9px system-ui, sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText(String(val), pad.l - 6, y + 3);
    }

    const n = Math.max(1, labels.length);
    function xAt(i) {
      if (n <= 1) return pad.l + plotW / 2;
      return pad.l + (plotW * i) / (n - 1);
    }
    function yAt(v) { return pad.t + plotH - (Math.max(0, Number(v) || 0) / maxY) * plotH; }

    function drawLine(values, color, thick, isCurrent) {
      if (!values || !values.length) return;
      const pts = values.map((v, i) => ({ x: xAt(i), y: yAt(v), v }));
      const baseY = pad.t + plotH;
      ctx.beginPath();
      if (pts.length === 1) {
        // Sube desde abajo hasta el valor (no una raya horizontal aislada)
        const p = pts[0];
        const xL = Math.max(pad.l, p.x - plotW * 0.22);
        const xR = Math.min(W - pad.r, p.x + plotW * 0.22);
        ctx.moveTo(xL, baseY);
        ctx.quadraticCurveTo(xL, p.y, p.x, p.y);
        ctx.quadraticCurveTo(xR, p.y, xR, baseY);
      } else if (pts.length === 2) {
        ctx.moveTo(pts[0].x, baseY);
        ctx.quadraticCurveTo(pts[0].x, pts[0].y, pts[0].x, pts[0].y);
        ctx.quadraticCurveTo((pts[0].x + pts[1].x) / 2, (pts[0].y + pts[1].y) / 2, pts[1].x, pts[1].y);
      } else {
        // Curva suave entre ejercicios
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 0; i < pts.length - 1; i++) {
          const p0 = pts[i];
          const p1 = pts[i + 1];
          const cx = (p0.x + p1.x) / 2;
          ctx.quadraticCurveTo(p0.x, p0.y, cx, (p0.y + p1.y) / 2);
          ctx.quadraticCurveTo(p1.x, p1.y, p1.x, p1.y);
        }
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = thick;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.stroke();
      pts.forEach(p => {
        ctx.beginPath();
        ctx.arc(p.x, p.y, isCurrent ? 5 : 3.5, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        if (isCurrent) {
          ctx.beginPath();
          ctx.arc(p.x, p.y, 2, 0, Math.PI * 2);
          ctx.fillStyle = '#0a0a0c';
          ctx.fill();
          ctx.fillStyle = '#e5e7eb';
          ctx.font = '10px system-ui, sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText(String(Math.round(p.v)), p.x, p.y - 10);
        }
      });
    }

    // Anteriores atrás, actual arriba (como gráfico de varias series)
    seriesList.filter(s => !s.isCurrent).forEach(s => drawLine(s.values, s.color || '#94a3b8', 2.4, false));
    seriesList.filter(s => s.isCurrent).forEach(s => drawLine(s.values, s.color || '#3b82f6', 3.2, true));

    // Labels X (ejercicios)
    ctx.fillStyle = '#8b8b96';
    ctx.font = '9px system-ui, sans-serif';
    ctx.textAlign = 'center';
    labels.forEach((lab, i) => {
      const short = lab.length > 10 ? lab.slice(0, 9) + '…' : lab;
      ctx.fillText(short, xAt(i), H - 14);
    });
  }

  function bindStatsEvents(logs) {
    const list = logs || [];
    document.getElementById('statsSelectRutina')?.addEventListener('change', (e) => {
      appState.statsSelectedRutinaId = e.target.value;
      appState.statsSelectedDiaKey = null; // reset día al cambiar rutina
      renderApp();
    });
    document.getElementById('statsSelectDia')?.addEventListener('change', (e) => {
      appState.statsSelectedDiaKey = e.target.value;
      renderApp();
    });
    document.getElementById('statsPrevMonth')?.addEventListener('click', () => {
      appState.statsMonthOffset = (Number(appState.statsMonthOffset) || 0) - 1;
      renderApp();
    });
    document.getElementById('statsNextMonth')?.addEventListener('click', () => {
      appState.statsMonthOffset = (Number(appState.statsMonthOffset) || 0) + 1;
      renderApp();
    });
    const draw = () => _drawStatsLineChart(document.getElementById('statsLineChart'));
    requestAnimationFrame(() => requestAnimationFrame(draw));
    // Redibujar al rotar / cambiar tamaño (celu)
    if (!window._statsChartResizeBound) {
      window._statsChartResizeBound = true;
      window.addEventListener('resize', () => {
        if (appState.tabCliente === 'stats') draw();
      });
    }
  }

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
                   style="display:${tieneRegistros ? 'block' : 'none'}; padding:10px 0 0">
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
                            ${permitirEdicion ? `
                              <div style="display:flex; gap:6px; flex-wrap:wrap; justify-content:flex-end">
                                ${store.puedeEditarseEntrenamiento(log) ? `
                                  <button class="btn btn-secondary btn-sm btn-editar-entrenamiento-click" data-log-id="${log.id}" style="border-color:var(--yellow-warning); color:var(--yellow-warning); padding:4px 10px; font-size:0.75rem">✏️ Editar</button>
                                ` : ''}
                                <button class="btn btn-secondary btn-sm btn-borrar-entrenamiento-click" data-log-id="${log.id}" style="border-color:var(--red-primary); color:var(--red-primary); padding:4px 10px; font-size:0.75rem">🗑️ Borrar</button>
                              </div>
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
                            const setsArr = log.sets || [];
                            if (!setsArr.length) {
                              return `<div style="font-size:0.82rem; color:var(--text-gray); padding:8px 0">
                                Sin detalle de series guardado para este entrenamiento.
                                (Los nuevos entrenamientos sí guardan series, reps y pesos.)
                              </div>`;
                            }
                            const ejMap = {};
                            setsArr.forEach(s => {
                              const key = s.ejercicioNombre || s.ejercicio || s.nombre || 'Ejercicio';
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
                                    Serie ${s.setNumero != null ? s.setNumero : ''}: <strong>${s.repsRealizadas != null ? s.repsRealizadas : (s.reps || '—')} reps</strong>
                                    con <strong>${s.pesoUtilizado != null ? s.pesoUtilizado : (s.peso || '—')}</strong>
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
      const cursorPos = e.target.selectionStart;
      appState.busquedaProfesor = e.target.value;
      renderApp();
      const newInputSearch = document.getElementById('inputSearchProf');
      if (newInputSearch) {
        newInputSearch.focus();
        newInputSearch.setSelectionRange(cursorPos, cursorPos);
      }
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

console.log("🔎 DEBUG CREAR RUTINA - alumnoSeleccionadoId:", {
    alumnoId,
    appStateId: appState.alumnoSeleccionadoId
});

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

            <div class="rf-section-header">
              <h4 class="rf-section-title">Días y ejercicios</h4>
              <button type="button" class="rf-text-btn" id="btnAddDay">+ Día</button>
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

  // --- Autocompletado de video por nombre de ejercicio (solo formulario, no toca Supabase) ---
  const CATALOGO_VIDEOS_EJERCICIOS = [
    { nombre: "Pull over en polea con barra", videoUrl: "https://www.youtube.com/shorts/5cqIDziQ5Ko", alias: ["Pull over en polea con barra", "pull over en polea con barra", "pullover en polea con barra", "pull over polea barra", "pullover polea barra", "pull-over en polea con barra"] },
    { nombre: "Pull over en polea con soga", videoUrl: "https://www.youtube.com/shorts/oOmDvbqJj-Q", alias: ["Pull over en polea con soga", "pull over en polea con soga", "pullover en polea con soga", "pull over polea soga", "pullover polea soga", "pull-over en polea con soga", "pull over en polea con cuerda"] },
    { nombre: "Press de hombro en maquina", videoUrl: "https://www.youtube.com/shorts/BqdJeb6jHko", alias: ["Press de hombro en maquina", "Press de hombro en máquina", "press de hombro en maquina", "press de hombro en máquina", "press hombro maquina", "press hombro máquina", "press de hombros en maquina", "shoulder press maquina"] },
    { nombre: "Patada de gluteo en polea", videoUrl: "https://www.youtube.com/shorts/FclsfZvytqM", alias: ["Patada de gluteo en polea", "patada de gluteo en polea", "patada de glúteo en polea", "patada gluteo polea", "patada glúteo polea", "glute kickback polea", "patadas de gluteo en polea"] },
    { nombre: "Patada de gluteo en maquina", videoUrl: "https://www.youtube.com/shorts/HlrLyKsrV78", alias: ["Patada de gluteo en maquina", "Patada de gluteo en máquina", "patada de gluteo en maquina", "patada de gluteo en máquina", "patada de glúteo en maquina", "patada gluteo maquina", "patada glúteo máquina", "glute kickback maquina"] },
    { nombre: "Patada de gluteo en polea con banco", videoUrl: "https://www.youtube.com/shorts/BNOfVprH6DI", alias: ["Patada de gluteo en polea con banco", "patada de gluteo en polea con banco", "patada de glúteo en polea con banco", "patada gluteo polea banco", "patada gluteo en polea banco", "glute kickback polea banco"] },
    { nombre: "Abduccion sentado en maquina", videoUrl: "https://www.youtube.com/shorts/xlp6FYwBFLU", alias: ["Abduccion sentado en maquina", "Abduccion sentado en máquina", "abduccion sentado en maquina", "abduccion sentado en máquina"] },
    { nombre: "Abs bolitas", videoUrl: "https://www.youtube.com/shorts/Wlw3wvJdhBc", alias: ["Abs bolitas", "abs bolitas"] },
    { nombre: "Abs rectos con peso", videoUrl: "https://www.youtube.com/shorts/BFTJUFmiwHM", alias: ["Abs rectos con peso", "abs rectos con peso"] },
    { nombre: "Abs rectos con piernas a 45°", videoUrl: "https://www.youtube.com/shorts/4rttpgLuJR8", alias: ["Abs rectos con piernas a 45°", "abs rectos con piernas a 45°"] },
    { nombre: "Aduccion sentado en maquina", videoUrl: "https://www.youtube.com/shorts/vlViIgtkvh4", alias: ["Aduccion sentado en maquina", "Aduccion sentado en máquina", "aduccion sentado en maquina", "aduccion sentado en máquina"] },
    { nombre: "Apertura con empuje en banco plano", videoUrl: "https://www.youtube.com/shorts/Fc1UgcryhrA", alias: ["Apertura con empuje en banco plano", "apertura con empuje en banco plano"] },
    { nombre: "Apertura en banco inclinado", videoUrl: "https://www.youtube.com/shorts/CQx4FhzelMU", alias: ["Apertura en banco inclinado", "apertura en banco inclinado"] },
    { nombre: "Apertura en banco plano", videoUrl: "https://www.youtube.com/shorts/26TsSvfg28U", alias: ["Apertura en banco plano", "apertura en banco plano"] },
    { nombre: "Apertura en polea", videoUrl: "https://www.youtube.com/shorts/QEW6RO0O-ak", alias: ["Apertura en polea", "apertura en polea"] },
    { nombre: "Arranque a 1 brazo", videoUrl: "https://www.youtube.com/shorts/IVIrE_x5FtE", alias: ["Arranque a 1 brazo", "arranque a 1 brazo"] },
    { nombre: "Arranque con barra", videoUrl: "https://www.youtube.com/shorts/-7mUZ2RFAw4", alias: ["Arranque con barra", "arranque con barra"] },
    { nombre: "Biceps con barra", videoUrl: "https://www.youtube.com/shorts/B3Feq30xwpo", alias: ["Biceps con barra", "biceps con barra", "bíceps con barra"] },
    { nombre: "Biceps con barra en polea", videoUrl: "https://www.youtube.com/shorts/oJGSW0z5Hew", alias: ["Biceps con barra en polea", "biceps con barra en polea", "bíceps con barra en polea"] },
    { nombre: "Biceps con mancuerna banco inclinado", videoUrl: "https://www.youtube.com/shorts/4LQ0p0ni39Y", alias: ["Biceps con mancuerna banco inclinado", "Biceps con mancuernas banco inclinado", "biceps con mancuerna banco inclinado", "biceps con mancuernas banco inclinado", "bíceps con mancuerna banco inclinado"] },
    { nombre: "Biceps con mancuernas", videoUrl: "https://www.youtube.com/shorts/WrpQYs_n_Pw", alias: ["Biceps con mancuerna", "Biceps con mancuernas", "biceps con mancuerna", "biceps con mancuernas", "bíceps con mancuernas"] },
    { nombre: "Biceps con soga en polea", videoUrl: "https://www.youtube.com/shorts/dj99CeV_UUY", alias: ["Biceps con soga en polea", "biceps con soga en polea", "bíceps con soga en polea"] },
    { nombre: "Biceps en banco scott", videoUrl: "https://www.youtube.com/shorts/Zj0P6gFb9MY", alias: ["Biceps en banco scott", "biceps en banco scott", "bíceps en banco scott"] },
    { nombre: "Biceps en banco scott con mancuernas", videoUrl: "https://www.youtube.com/shorts/L4AQh3lTICk", alias: ["Biceps en banco scott con mancuerna", "Biceps en banco scott con mancuernas", "biceps en banco scott con mancuerna", "biceps en banco scott con mancuernas", "bíceps en banco scott con mancuernas"] },
    { nombre: "Biceps martillo", videoUrl: "https://www.youtube.com/shorts/QdEY-VZcPMU", alias: ["Biceps martillo", "biceps martillo", "bíceps martillo"] },
    { nombre: "Bicho muerto", videoUrl: "https://www.youtube.com/shorts/_o23Ghklahc", alias: ["Bicho muerto", "bicho muerto"] },
    { nombre: "Bisagras oblicuas", videoUrl: "https://www.youtube.com/shorts/EExl_U2GGEk", alias: ["Bisagras oblicuas", "bisagras oblicuas"] },
    { nombre: "Camilla de isquios", videoUrl: "https://www.youtube.com/shorts/B6t8MvbTtew", alias: ["Camilla de isquios", "Camilla isquios", "camilla de isquios", "camilla isquios"] },
    { nombre: "Camilla de isquios 1 pp", videoUrl: "https://www.youtube.com/shorts/Ix7wiKrC7bQ", alias: ["Camilla de isquios 1 pierna", "Camilla de isquios 1 pp", "Camilla de isquios a un pie", "Camilla de isquios unilateral", "Camilla isquios 1 pp", "camilla de isquios 1 pierna", "camilla de isquios 1 pp", "camilla de isquios a un pie", "camilla de isquios unilateral", "camilla isquios 1 pp"] },
    { nombre: "Cargada", videoUrl: "https://www.youtube.com/shorts/7KMYH9gyeEM", alias: ["Cargada", "cargada"] },
    { nombre: "Cargada + segundo tiempo", videoUrl: "https://www.youtube.com/shorts/MrG8DIttWVA", alias: ["Cargada + segundo tiempo", "cargada + segundo tiempo"] },
    { nombre: "Cuadricera", videoUrl: "https://www.youtube.com/shorts/iNvPzf15KKA", alias: ["Cuadricera", "cuadricera"] },
    { nombre: "Cuadricera 1 pp", videoUrl: "https://www.youtube.com/shorts/OhHvfoomEfY", alias: ["Cuadricera 1 pierna", "Cuadricera 1 pp", "Cuadricera a un pie", "Cuadricera unilateral", "cuadricera 1 pierna", "cuadricera 1 pp", "cuadricera a un pie", "cuadricera unilateral"] },
    { nombre: "Elevacion cadera en fitball", videoUrl: "https://www.youtube.com/shorts/p4Bwnapg03c", alias: ["Elevacion cadera en fitball", "elevacion cadera en fitball"] },
    { nombre: "Encogimiento con barra", videoUrl: "https://www.youtube.com/shorts/xgLOVCSFTAc", alias: ["Encogimiento con barra", "encogimiento con barra"] },
    { nombre: "Encogimiento con mancuernas", videoUrl: "https://www.youtube.com/shorts/0-KrI1Hqpk4", alias: ["Encogimiento con mancuerna", "Encogimiento con mancuernas", "encogimiento con mancuerna", "encogimiento con mancuernas"] },
    { nombre: "Estocadas fijas en smith", videoUrl: "https://www.youtube.com/shorts/sEE7Qrlf4j4", alias: ["Estocadas fijas en en smith", "Estocadas fijas en smith", "Estocadas fijas smith", "estocada fijas en smith", "estocadas fijas en en smith", "estocadas fijas en smith", "estocadas fijas smith", "zancadas fijas en smith"] },
    { nombre: "Estocadas hacia adelante", videoUrl: "https://www.youtube.com/shorts/IIJA6XbIdyI", alias: ["Estocadas hacia adelante", "estocada hacia adelante", "estocadas hacia adelante", "zancadas hacia adelante"] },
    { nombre: "Estocadas hacia atras", videoUrl: "https://www.youtube.com/shorts/pckiYC8Rnsc", alias: ["Estocadas hacia atras", "estocada hacia atras", "estocadas hacia atras", "zancadas hacia atras"] },
    { nombre: "Face pull", videoUrl: "https://www.youtube.com/shorts/5Yu8DTe4BAQ", alias: ["Face pull", "face pull"] },
    { nombre: "Fondos en banco", videoUrl: "https://www.youtube.com/shorts/wN_9d37DO4M", alias: ["Fondos en banco", "fondos en banco"] },
    { nombre: "Fondos en paralelas", videoUrl: "https://www.youtube.com/shorts/s5BLhbKWD3E", alias: ["Fondos en paralelas", "fondos en paralelas"] },
    { nombre: "Hip thrust", videoUrl: "https://www.youtube.com/shorts/zaSzxo6xleY", alias: ["Hip thrust", "empuje de cadera", "hip thrust", "hipthrust"] },
    { nombre: "Inferiores carrito", videoUrl: "https://www.youtube.com/shorts/62-5TombKfU", alias: ["Inferiores carrito", "inferiores carrito"] },
    { nombre: "Inferiores con peso", videoUrl: "https://www.youtube.com/shorts/zMJ6Hqv8-sM", alias: ["Inferiores con peso", "inferiores con peso"] },
    { nombre: "Inferiores en paralelas", videoUrl: "https://www.youtube.com/watch?v=fX6JwyyW16o", alias: ["Inferiores en paralelas", "inferiores en paralelas"] },
    { nombre: "Isquios sentado en maquina", videoUrl: "https://www.youtube.com/shorts/6IvQvWZmEsw", alias: ["Isquios sentado en maquina", "Isquios sentado en máquina", "isquios sentado en maquina", "isquios sentado en máquina"] },
    { nombre: "Isquios sentado en maquina 1 pp", videoUrl: "https://www.youtube.com/shorts/UNc9k9WBXj8", alias: ["Isquios sentado en maquina 1 pierna", "Isquios sentado en maquina 1 pp", "Isquios sentado en maquina a un pie", "Isquios sentado en maquina unilateral", "Isquios sentado en máquina 1 pp", "isquios sentado en maquina 1 pierna", "isquios sentado en maquina 1 pp", "isquios sentado en maquina a un pie", "isquios sentado en maquina unilateral", "isquios sentado en máquina 1 pp"] },
    { nombre: "Jalon dorsal 1 brazo", videoUrl: "https://www.youtube.com/shorts/rudpTb4A0X8", alias: ["Jalon dorsal 1 brazo", "jalon dorsal 1 brazo", "jalón dorsal 1 brazo"] },
    { nombre: "Jalon dorsal neutro", videoUrl: "https://www.youtube.com/shorts/Yie3dzpYNtQ", alias: ["Jalon dorsal neutro", "jalon dorsal neutro", "jalón dorsal neutro"] },
    { nombre: "Jalon dorsal prono amplio", videoUrl: "https://www.youtube.com/shorts/sAYU5EvtXSo", alias: ["Jalon dorsal prono amplio", "jalon al pecho", "jalon dorsal prono amplio", "jalon dorsalera", "jalón al pecho", "jalón dorsal prono amplio"] },
    { nombre: "Jalon dorsal supino", videoUrl: "https://www.youtube.com/shorts/Q4e_Ya9BnlM", alias: ["Jalon dorsal supino", "jalon dorsal supino", "jalón dorsal supino"] },
    { nombre: "Peso muerto", videoUrl: "https://www.youtube.com/shorts/WdADxet2RQc", alias: ["Peso muerto", "deadlift", "peso muerto"] },
    { nombre: "Peso muerto 1 pp", videoUrl: "https://www.youtube.com/shorts/Z3TRkamr5jA", alias: ["Peso muerto 1 pierna", "Peso muerto 1 pp", "Peso muerto a un pie", "Peso muerto unilateral", "deadlift 1 pp", "peso muerto 1 pierna", "peso muerto 1 pp", "peso muerto a un pie", "peso muerto unilateral"] },
    { nombre: "Plancha frontal", videoUrl: "https://www.youtube.com/shorts/XCOq6lfsFAk", alias: ["Plancha frontal", "plancha frontal"] },
    { nombre: "Plancha frontal 3 apoyos", videoUrl: "https://www.youtube.com/shorts/umPWS5gofGE", alias: ["Plancha frontal 3 apoyos", "plancha frontal 3 apoyos"] },
    { nombre: "Plancha frontal subo y bajo", videoUrl: "https://www.youtube.com/shorts/1X1cn0XqaKw", alias: ["Plancha frontal subo y bajo", "plancha frontal subo y bajo"] },
    { nombre: "Plancha frontal toco hombro", videoUrl: "https://www.youtube.com/shorts/auypDs3TVeM", alias: ["Plancha frontal toco hombro", "plancha frontal toco hombro"] },
    { nombre: "Plancha lateral", videoUrl: "https://www.youtube.com/shorts/fNsxKTKfMNI", alias: ["Plancha lateral", "plancha lateral"] },
    { nombre: "Prensa en 45°", videoUrl: "https://www.youtube.com/shorts/NYa0tZCW4fk", alias: ["Prensa en 45°", "prensa en 45°"] },
    { nombre: "Prensa horizontal", videoUrl: "https://www.youtube.com/shorts/W7bL6i1sJo4", alias: ["Prensa horizontal", "prensa horizontal"] },
    { nombre: "Prensa horizontal a 1 pp", videoUrl: "https://www.youtube.com/shorts/O6VCiyKvM3c", alias: ["Prensa horizontal a 1 pierna", "Prensa horizontal a 1 pp", "Prensa horizontal a a un pie", "Prensa horizontal a unilateral", "prensa horizontal a 1 pierna", "prensa horizontal a 1 pp", "prensa horizontal a a un pie", "prensa horizontal a unilateral"] },
    { nombre: "Prensa sumo", videoUrl: "https://www.youtube.com/shorts/SguVlooAwcA", alias: ["Prensa sumo", "prensa sumo"] },
    { nombre: "Press de banca a 1 brazo con mancuerna", videoUrl: "https://www.youtube.com/watch?v=N_BzPe7kmdk", alias: ["Press banca a 1 brazo con mancuerna", "Press de banca a 1 brazo con mancuerna", "Press de banca a 1 brazo con mancuernas", "press banca a 1 brazo con mancuerna", "press de banca a 1 brazo con mancuerna", "press de banca a 1 brazo con mancuernas"] },
    { nombre: "Press de banca declinado", videoUrl: "https://www.youtube.com/shorts/NEOBG2KgVyA", alias: ["Press banca declinado", "Press de banca declinado", "press banca declinado", "press de banca declinado"] },
    { nombre: "Press de banca inclinado con barra", videoUrl: "https://www.youtube.com/shorts/g99l4KwY-vo", alias: ["Press banca inclinado con barra", "Press de banca inclinado con barra", "press banca inclinado con barra", "press de banca inclinado con barra"] },
    { nombre: "Press de banca inclinado con mancuernas", videoUrl: "https://www.youtube.com/shorts/tcw2c5dtqD4", alias: ["Press banca inclinado con mancuernas", "Press de banca inclinado con mancuernas", "press banca inclinado con mancuernas", "press de banca inclinado con mancuernas"] },
    { nombre: "Press de banca inclinado en smith", videoUrl: "https://www.youtube.com/shorts/XwjuCBcFXQQ", alias: ["Press banca inclinado en smith", "Press de banca inclinado en en smith", "Press de banca inclinado en smith", "Press de banca inclinado smith", "press banca inclinado en smith", "press de banca inclinado en en smith", "press de banca inclinado en smith", "press de banca inclinado smith"] },
    { nombre: "Press de banca plano con barra", videoUrl: "https://www.youtube.com/shorts/HzkHpIIo4IA", alias: ["Press banca plano con barra", "Press de banca plano con barra", "press banca plano con barra", "press de banca plano con barra", "press plano con barra"] },
    { nombre: "Press de banca plano con mancuernas", videoUrl: "https://www.youtube.com/shorts/qW519gsE2M8", alias: ["Press banca plano con mancuernas", "Press de banca plano con mancuerna", "Press de banca plano con mancuernas", "press banca plano con mancuernas", "press de banca plano con mancuerna", "press de banca plano con mancuernas", "press plano con mancuernas"] },
    { nombre: "Press de banca plano en smith", videoUrl: "https://www.youtube.com/shorts/9_tbUqJ45QU", alias: ["Press banca plano en smith", "Press de banca plano en en smith", "Press de banca plano en smith", "Press de banca plano smith", "press banca plano en smith", "press de banca plano en en smith", "press de banca plano en smith", "press de banca plano smith", "press plano en smith"] },
    { nombre: "Press de hombro 1 brazo", videoUrl: "https://www.youtube.com/shorts/i5cvgQveFbY", alias: ["Press de hombro 1 brazo", "Press hombro 1 brazo", "press de hombro 1 brazo", "press hombro 1 brazo"] },
    { nombre: "Press de hombro con barra", videoUrl: "https://www.youtube.com/shorts/z_-74FMv5Jg", alias: ["Press de hombro con barra", "Press hombro con barra", "press de hombro con barra", "press hombro con barra"] },
    { nombre: "Press de hombro con barra sentado", videoUrl: "https://www.youtube.com/shorts/AmcpSwUNPYc", alias: ["Press de hombro con barra sentado", "Press hombro con barra sentado", "press de hombro con barra sentado", "press hombro con barra sentado"] },
    { nombre: "Press de hombro con mancuernas", videoUrl: "https://www.youtube.com/shorts/96C2nPejfY4", alias: ["Press de hombro con mancuerna", "Press de hombro con mancuernas", "Press hombro con mancuernas", "press de hombro con mancuerna", "press de hombro con mancuernas", "press hombro con mancuernas"] },
    { nombre: "Press de hombro con mancuernas sentado", videoUrl: "https://www.youtube.com/shorts/R0f2Of6Sl2A", alias: ["Press de hombro con mancuerna sentado", "Press de hombro con mancuernas sentado", "Press hombro con mancuernas sentado", "press de hombro con mancuerna sentado", "press de hombro con mancuernas sentado", "press hombro con mancuernas sentado"] },
    { nombre: "Press de pecho en maquina sentado", videoUrl: "https://www.youtube.com/shorts/88kSaeQG21Y", alias: ["Press de pecho en maquina sentado", "Press de pecho en máquina sentado", "Press pecho en maquina sentado", "press de pecho en maquina sentado", "press de pecho en máquina sentado", "press pecho en maquina sentado"] },
    { nombre: "Press de pecho inclinado en maquina", videoUrl: "https://www.youtube.com/shorts/YS6DsKrY8T0", alias: ["Press de pecho inclinado en maquina", "Press de pecho inclinado en máquina", "Press pecho inclinado en maquina", "press de pecho inclinado en maquina", "press de pecho inclinado en máquina", "press pecho inclinado en maquina"] },
    { nombre: "Press frances con barra", videoUrl: "https://www.youtube.com/watch?v=gY-CqZD0Ktc", alias: ["Press frances con barra", "press frances con barra"] },
    { nombre: "Press frances con barra W", videoUrl: "https://www.youtube.com/shorts/CAUWI4sNPKk", alias: ["Press frances con barra W", "press frances con barra w"] },
    { nombre: "Press frances con mancuerna", videoUrl: "https://www.youtube.com/shorts/FgN0vyx8jNE", alias: ["Press frances con mancuerna", "Press frances con mancuernas", "press frances con mancuerna", "press frances con mancuernas"] },
    { nombre: "Press frances en polea", videoUrl: "https://www.youtube.com/shorts/wNVVttuAGnM", alias: ["Press frances en polea", "press frances en polea"] },
    { nombre: "Remo con barra", videoUrl: "https://www.youtube.com/shorts/b8FgtZlyEd4", alias: ["Remo con barra", "remo con barra"] },
    { nombre: "Remo en barra T", videoUrl: "https://www.youtube.com/shorts/uLr8HcW_7ig", alias: ["Remo en barra T", "remo en barra t"] },
    { nombre: "Remo en landmine", videoUrl: "https://www.youtube.com/watch?v=25lFwuWjKSM", alias: ["Remo en ladmine", "Remo en landmine", "remo en ladmine", "remo en landmine"] },
    { nombre: "Remo en polea baja 1 brazo", videoUrl: "https://www.youtube.com/shorts/Ol37ocDBdAU", alias: ["Remo en polea baja 1 brazo", "remo en polea baja 1 brazo"] },
    { nombre: "Remo en polea baja neutro", videoUrl: "https://www.youtube.com/shorts/soxtqUNRt6E", alias: ["Remo en polea baja neutro", "remo en polea baja neutro"] },
    { nombre: "Remo en polea baja prono", videoUrl: "https://www.youtube.com/watch?v=Vm6E-2tq0bU", alias: ["Remo en polea baja prono", "remo en polea baja prono"] },
    { nombre: "Remo en polea baja supino", videoUrl: "https://www.youtube.com/shorts/GTb5tId5HG4", alias: ["Remo en polea baja supino", "remo en polea baja supino"] },
    { nombre: "Remo en smith", videoUrl: "https://www.youtube.com/shorts/lTQJFDyQq0s", alias: ["Remo en en smith", "Remo en smith", "Remo smith", "remo en en smith", "remo en smith", "remo smith"] },
    { nombre: "Ruedita abdominal", videoUrl: "https://www.youtube.com/shorts/knjliGWvGa4", alias: ["Ruedita abdominal", "ruedita abdominal"] },
    { nombre: "Segundo tiempo", videoUrl: "https://www.youtube.com/shorts/fWQbTvolNqA", alias: ["Segundo tiempo", "segundo tiempo"] },
    { nombre: "Sentadilla barra hexagonal", videoUrl: "https://www.youtube.com/shorts/JfhNkNz59lI", alias: ["Sentadilla barra exagonal", "Sentadilla barra hexagonal", "Sentadilla hex bar", "senatdilla barra hexagonal", "sentadilla barra exagonal", "sentadilla barra hexagonal", "sentadilla hex bar", "sentadillas barra hexagonal"] },
    { nombre: "Sentadilla bulgaras", videoUrl: "https://www.youtube.com/shorts/cytfxsIK_Hk", alias: ["Sentadilla bulgaras", "senatdilla bulgaras", "sentadilla bulgaras", "sentadillas bulgaras"] },
    { nombre: "Sentadilla con barra", videoUrl: "https://www.youtube.com/shorts/7xeLHxobaWs", alias: ["Sentadilla con barra", "senatdilla con barra", "sentadilla con barra", "sentadillas con barra"] },
    { nombre: "Sentadilla con polea", videoUrl: "https://www.youtube.com/shorts/0vz9HwV4UKg", alias: ["Sentadilla con polea", "senatdilla con polea", "sentadilla con polea", "sentadillas con polea"] },
    { nombre: "Sentadilla en smith", videoUrl: "https://www.youtube.com/shorts/eFY7gyLFUcU", alias: ["Sentadilla en en smith", "Sentadilla en smith", "Sentadilla smith", "senatdilla en smith", "sentadilla en en smith", "sentadilla en smith", "sentadilla smith", "sentadillas en smith"] },
    { nombre: "Sentadilla goblet", videoUrl: "https://www.youtube.com/shorts/3wCp6MN2Z_Q", alias: ["Sentadilla globet", "Sentadilla goblet", "senatdilla goblet", "sentadilla globet", "sentadilla goblet", "sentadillas goblet"] },
    { nombre: "Sentadilla maquina hack", videoUrl: "https://www.youtube.com/shorts/jXZyJ3KNbWw", alias: ["Sentadilla maquina hack", "Sentadilla máquina hack", "senatdilla maquina hack", "sentadilla maquina hack", "sentadilla máquina hack", "sentadillas maquina hack"] },
    { nombre: "Sentadilla sumo", videoUrl: "https://www.youtube.com/shorts/rbKBfqqmmwY", alias: ["Sentadilla sumo", "senatdilla sumo", "sentadilla sumo", "sentadillas sumo"] },
    { nombre: "Tiron al menton", videoUrl: "https://www.youtube.com/shorts/2SAyFkFCoFs", alias: ["Tiron al menton", "tiron al menton"] },
    { nombre: "Triceps en polea con barra", videoUrl: "https://www.youtube.com/shorts/sU9snn0qTEs", alias: ["Triceps en polea con barra", "triceps en polea con barra", "tríceps en polea con barra"] },
    { nombre: "Triceps en polea con soga", videoUrl: "https://www.youtube.com/shorts/W7bQVLg3NWA", alias: ["Triceps en polea con soga", "triceps en polea con soga", "tríceps en polea con soga"] },
    { nombre: "Triceps polea 1 brazo", videoUrl: "https://www.youtube.com/shorts/hip11n3QXzU", alias: ["Triceps polea 1 brazo", "triceps polea 1 brazo", "tríceps polea 1 brazo"] },
    { nombre: "Twist", videoUrl: "https://www.youtube.com/shorts/vq1FICbQC4Q", alias: ["Twist", "twist"] },
    { nombre: "Vitalizaciones", videoUrl: "https://www.youtube.com/shorts/gGIo7i-xnQA", alias: ["Vitalizaciones", "vitalizaciones"] },
    { nombre: "Vuelos frontales con barra", videoUrl: "https://www.youtube.com/shorts/QeJ7INwGgaE", alias: ["Vuelos frontales con barra", "vuelos frontales con barra"] },
    { nombre: "Vuelos frontales con disco", videoUrl: "https://www.youtube.com/shorts/WMCftjiDQW4", alias: ["Vuelos frontales con disco", "vuelos frontales con disco"] },
    { nombre: "Vuelos frontales con mancuernas", videoUrl: "https://www.youtube.com/shorts/ErPdiYXDeTw", alias: ["Vuelos frontales con mancuerna", "Vuelos frontales con mancuernas", "vuelos frontales con mancuerna", "vuelos frontales con mancuernas"] },
    { nombre: "Vuelos frontales con polea", videoUrl: "https://www.youtube.com/shorts/AJ147wzeIfQ", alias: ["Vuelos frontales con polea", "vuelos frontales con polea"] },
    { nombre: "Vuelos laterales con mancuernas", videoUrl: "https://www.youtube.com/shorts/dd9xo-_ahCg", alias: ["Vuelos laterales con mancuerna", "Vuelos laterales con mancuernas", "vuelos laterales con mancuerna", "vuelos laterales con mancuernas"] },
    { nombre: "Vuelos laterales en polea", videoUrl: "https://www.youtube.com/shorts/V98wql8IfVA", alias: ["Vuelos laterales en polea", "vuelos laterales en polea"] },

    { nombre: "Remo con mancuernas", videoUrl: "https://www.youtube.com/shorts/5QYQqPw_WgA", alias: ["Remo con mancuernas", "remo con mancuernas", "remo mancuernas", "remo con mancuerna", "dumbbell row"] },
    { nombre: "Press arnold", videoUrl: "https://www.youtube.com/shorts/Kg8JD8l6ezw", alias: ["Press arnold", "press arnold", "arnold press", "press de arnold"] },
    { nombre: "Wall ball", videoUrl: "https://www.youtube.com/shorts/SDT1KrcO8ac", alias: ["Wall ball", "wall ball", "wallball", "wall balls"] },
    { nombre: "Desplazamiento lateral con banda elastica", videoUrl: "https://www.youtube.com/shorts/N28Hpdezg7Q", alias: ["Desplazamiento lateral con banda elastica", "Desplazamiento lateral con banda elástica", "desplazamiento lateral con banda elastica", "desplazamiento lateral con banda elástica", "desplazamiento lateral banda", "lateral band walk"] },
    { nombre: "Sit up", videoUrl: "https://www.youtube.com/shorts/V3MFEeDYYaE", alias: ["Sit up", "sit up", "sit-up", "situps", "sit ups"] },
    { nombre: "Burpee", videoUrl: "https://www.youtube.com/shorts/EkK3oVBA__Q", alias: ["Burpee", "burpee", "burpi", "burpees"] },
    { nombre: "Medio burpee", videoUrl: "https://www.youtube.com/shorts/FH0hjFVDhu8", alias: ["Medio burpee", "medio burpee", "medio burpi", "half burpee"] },
    { nombre: "Burpee con press", videoUrl: "https://www.youtube.com/shorts/2_UZ-E5qHUA", alias: ["Burpee con press", "burpee con press", "burpi con press", "burpee press"] },
    { nombre: "Press pallof", videoUrl: "https://www.youtube.com/shorts/iNn_sNA6TbU", alias: ["Press pallof", "press pallof", "pallof press", "press de pallof"] },
    { nombre: "Rotacion de hombro con banda", videoUrl: "https://www.youtube.com/watch?v=fljC5LoRqxY", alias: ["Rotacion de hombro con banda", "Rotación de hombro con banda", "rotacion de hombro con banda", "rotación de hombro con banda", "rotacion hombro banda", "rotaciones de hombro con banda"] },
    { nombre: "Rotacion externa de hombro 90", videoUrl: "https://www.youtube.com/shorts/iNn_sNA6TbU", alias: ["Rotacion externa de hombro 90", "Rotación externa de hombro 90°", "Rotacion externa de hombro 90°", "rotacion externa de hombro 90", "rotacion externa hombro 90", "rotacion externa 90", "external rotation 90"] },
  ];

  function normalizarNombreEjercicio(str) {
    return String(str || '')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .trim()
      .replace(/\s+/g, ' ');
  }

  function buscarVideoPorNombreEjercicio(nombre) {
    const norm = normalizarNombreEjercicio(nombre);
    if (!norm) return null;
    const match = CATALOGO_VIDEOS_EJERCICIOS.find(item =>
      item.alias.some(a => normalizarNombreEjercicio(a) === norm) ||
      normalizarNombreEjercicio(item.nombre) === norm
    );
    return match ? match.videoUrl : null;
  }

  function buscarEjerciciosSugeridos(query, limit = 12) {
    const norm = normalizarNombreEjercicio(query);
    if (!norm || norm.length < 2) return [];
    const scored = [];
    for (const item of CATALOGO_VIDEOS_EJERCICIOS) {
      const nom = normalizarNombreEjercicio(item.nombre);
      let score = 0;
      if (nom === norm) score = 100;
      else if (nom.startsWith(norm)) score = 90;
      else if ((' ' + nom).includes(' ' + norm)) score = 75; // inicio de palabra
      else if (nom.includes(norm)) score = 40;
      else {
        for (const a of item.alias) {
          const an = normalizarNombreEjercicio(a);
          if (an === norm) { score = 95; break; }
          if (an.startsWith(norm)) { score = Math.max(score, 85); }
          else if ((' ' + an).includes(' ' + norm)) { score = Math.max(score, 70); }
          else if (an.includes(norm)) { score = Math.max(score, 35); }
        }
      }
      if (score >= 70) scored.push({ ...item, score }); // solo matches de calidad
    }
    scored.sort((a, b) => b.score - a.score || a.nombre.localeCompare(b.nombre));
    const seen = new Set();
    const out = [];
    for (const s of scored) {
      if (seen.has(s.videoUrl)) continue;
      seen.add(s.videoUrl);
      out.push(s);
      if (out.length >= limit) break;
    }
    return out;
  }

  window.onEjercicioNombreInput = (diaIdx, ejIdx, val) => {
    const ej = currentFormDays[diaIdx].ejercicios[ejIdx];
    // No escribir ej.nombre en cada tecla: solo al elegir del catálogo o al blur.
    // Si no, al tocar "+ Ejercicio" un change/blur con "press" pisa "Press banca…".
    ej._typingDraft = val;
    ej._catalogPick = false;
    if (!ej.videoUrl || ej.videoUrlAuto === true) {
      const videoAuto = buscarVideoPorNombreEjercicio(val);
      if (videoAuto) {
        ej.videoUrl = videoAuto;
        ej.videoUrlAuto = true;
        const videoInput = document.querySelector(`[data-video-input="${diaIdx}-${ejIdx}"]`);
        if (videoInput) videoInput.value = videoAuto;
      }
    }
    const box = document.getElementById(`ej-suggest-${diaIdx}-${ejIdx}`);
    if (!box) return;
    const sugeridos = buscarEjerciciosSugeridos(val);
    if (!sugeridos.length) {
      box.hidden = true;
      box.innerHTML = '';
      return;
    }
    box.dataset.diaIdx = String(diaIdx);
    box.dataset.ejIdx = String(ejIdx);
    box.innerHTML = sugeridos.map((s, i) => {
      const nom = String(s.nombre).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;');
      const url = String(s.videoUrl).replace(/&/g,'&amp;').replace(/"/g,'&quot;');
      return `<button type="button" class="ej-suggest-item" data-suggest-idx="${i}" data-nombre="${nom}" data-url="${url}"><span class="ej-suggest-name">${nom}</span></button>`;
    }).join('');
    box.hidden = false;
  };

  window.seleccionarEjercicioCatalogo = (diaIdx, ejIdx, nombre, videoUrl) => {
    if (!currentFormDays[diaIdx] || !currentFormDays[diaIdx].ejercicios[ejIdx]) return;
    const ej = currentFormDays[diaIdx].ejercicios[ejIdx];
    ej.nombre = nombre;
    ej.videoUrl = videoUrl;
    ej.videoUrlAuto = true;
    ej._catalogPick = true;
    ej._typingDraft = nombre;
    const box = document.getElementById(`ej-suggest-${diaIdx}-${ejIdx}`);
    if (box) { box.hidden = true; box.innerHTML = ''; }
    const wrap = box && box.parentElement;
    const inp = wrap && wrap.querySelector('.ej-nombre-input');
    if (inp) inp.value = nombre;
    // Ignorar el blur/change que puede dispararse al re-render
    window._ignoreNombreCommit = true;
    renderFormDays();
    setTimeout(() => { window._ignoreNombreCommit = false; }, 100);
  };

  window.ocultarSugerenciasEjercicio = (diaIdx, ejIdx) => {
    setTimeout(() => {
      const box = document.getElementById(`ej-suggest-${diaIdx}-${ejIdx}`);
      if (box) box.hidden = true;
    }, 220);
  };

  // Delegación: un solo listener global (evita romper HTML con comillas en onclick)
  if (!window._ejSuggestDelegated) {
    window._ejSuggestDelegated = true;
    document.addEventListener('mousedown', (e) => {
      const btn = e.target.closest && e.target.closest('.ej-suggest-item');
      if (!btn) return;
      const box = btn.closest('.ej-suggest-box');
      if (!box) return;
      e.preventDefault();
      e.stopPropagation();
      const diaIdx = parseInt(box.dataset.diaIdx, 10);
      const ejIdx = parseInt(box.dataset.ejIdx, 10);
      const nombre = btn.getAttribute('data-nombre');
      const videoUrl = btn.getAttribute('data-url');
      if (nombre && window.seleccionarEjercicioCatalogo) {
        window.seleccionarEjercicioCatalogo(diaIdx, ejIdx, nombre, videoUrl);
      }
    }, true);
  }


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
          videoUrl: e.videoUrl || "",
          esEntradaEnCalor: !!e.esEntradaEnCalor
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
        ejercicios: [{ nombre: "Nuevo Ejercicio", series: 3, repeticiones: "12", peso: "10 kg", notaProfesor: "", videoUrl: "", esEntradaEnCalor: false }]
      });
      renderFormDays();
    });
  }

  function renderFormDays() {
    const container = document.getElementById('daysContainer');
    if (!container) return;

    container.innerHTML = currentFormDays.map((dia, diaIdx) => `
      <div class="rf-day">
        <div class="rf-day-header">
          <input type="text" class="form-input rf-day-name" value="${dia.nombre}" onchange="window.updateFormDayName(${diaIdx}, this.value)" placeholder="Nombre del día">
          <div class="rf-day-actions">
            <button type="button" class="rf-icon-btn" onclick="window.moveFormDayUp(${diaIdx})" title="Subir día">↑</button>
            <button type="button" class="rf-icon-btn" onclick="window.moveFormDayDown(${diaIdx})" title="Bajar día">↓</button>
            <button type="button" class="rf-text-btn" onclick="window.addFormExercise(${diaIdx})">+ Ejercicio</button>
            <button type="button" class="rf-text-btn rf-warmup-btn" onclick="window.addFormWarmupExercise(${diaIdx})">+ Entrada en calor</button>
            ${currentFormDays.length > 1 ? `<button type="button" class="rf-icon-btn rf-danger" onclick="window.removeFormDay(${diaIdx})" title="Eliminar día">×</button>` : ''}
          </div>
        </div>

        <div class="rf-exercises">
        ${dia.ejercicios.map((ej, ejIdx) => `
          <div class="rf-exercise${ej.esEntradaEnCalor ? ' rf-exercise-warmup' : ''}">
            <div class="rf-exercise-top">
              <div class="rf-field rf-field-grow">
                <label class="rf-label">${ej.esEntradaEnCalor ? '🔥 Entrada en calor' : 'Ejercicio'}</label>
                <div class="ej-suggest-wrap">
                  <input type="text" class="form-input ej-nombre-input" value="${String(ej.nombre || '').replace(/"/g, '&quot;')}"
                    data-dia-idx="${diaIdx}" data-ej-idx="${ejIdx}"
                    oninput="window.onEjercicioNombreInput(${diaIdx}, ${ejIdx}, this.value)"
                    onchange="window.updateFormExercise(${diaIdx}, ${ejIdx}, 'nombre', this.value)"
                    onblur="window.ocultarSugerenciasEjercicio(${diaIdx}, ${ejIdx})"
                    autocomplete="off"
                    placeholder="Nombre del ejercicio">
                  <div class="ej-suggest-box" id="ej-suggest-${diaIdx}-${ejIdx}" hidden></div>
                </div>
              </div>
              <div class="rf-exercise-actions">
                <button type="button" class="rf-icon-btn" onclick="window.moveFormExerciseUp(${diaIdx}, ${ejIdx})" title="Subir">↑</button>
                <button type="button" class="rf-icon-btn" onclick="window.moveFormExerciseDown(${diaIdx}, ${ejIdx})" title="Bajar">↓</button>
                ${dia.ejercicios.length > 1 ? `<button type="button" class="rf-icon-btn rf-danger" onclick="window.removeFormExercise(${diaIdx}, ${ejIdx})" title="Quitar">×</button>` : ''}
              </div>
            </div>

            <div class="rf-metrics">
              <div class="rf-field">
                <label class="rf-label">Series</label>
                <input type="number" class="form-input" value="${ej.series}" onchange="window.updateFormExercise(${diaIdx}, ${ejIdx}, 'series', this.value)">
              </div>
              <div class="rf-field">
                <label class="rf-label">Reps</label>
                <input type="text" class="form-input" value="${ej.repeticiones}" onchange="window.updateFormExercise(${diaIdx}, ${ejIdx}, 'repeticiones', this.value)">
              </div>
              <div class="rf-field">
                <label class="rf-label">Peso</label>
                <input type="text" class="form-input" value="${ej.peso}" onchange="window.updateFormExercise(${diaIdx}, ${ejIdx}, 'peso', this.value)">
              </div>
            </div>

            <div class="rf-field">
              <label class="rf-label">Nota</label>
              <input type="text" class="form-input" placeholder="Opcional" value="${ej.notaProfesor || ''}" onchange="window.updateFormExercise(${diaIdx}, ${ejIdx}, 'notaProfesor', this.value)">
            </div>

            <div class="rf-field">
              <label class="rf-label">Video</label>
              <input type="url" class="form-input" data-video-input="${diaIdx}-${ejIdx}" placeholder="Se completa solo al elegir ejercicio" value="${ej.videoUrl || ''}" onchange="window.updateFormExercise(${diaIdx}, ${ejIdx}, 'videoUrl', this.value)">
            </div>
          </div>
        `).join('')}
        </div>
      </div>
    `).join('');
  }

  window.updateFormDayName = (diaIdx, val) => { currentFormDays[diaIdx].nombre = val; };
  window.addFormExercise = (diaIdx) => {
    // Si estaba tipeando a mano (sin elegir del catálogo), guardar el borrador del input activo
    try {
      const active = document.activeElement;
      if (active && active.classList && active.classList.contains('ej-nombre-input')) {
        const d = parseInt(active.getAttribute('data-dia-idx'), 10);
        const e = parseInt(active.getAttribute('data-ej-idx'), 10);
        if (!isNaN(d) && !isNaN(e) && currentFormDays[d] && currentFormDays[d].ejercicios[e]) {
          const ej = currentFormDays[d].ejercicios[e];
          if (!ej._catalogPick && active.value) {
            ej.nombre = active.value;
            ej._typingDraft = active.value;
          }
        }
      }
    } catch (_) {}
    // Bloquear commits de nombre mientras se hace blur (evita que "press" pise el nombre completo)
    window._ignoreNombreCommit = true;
    try {
      const active = document.activeElement;
      if (active && active.classList && active.classList.contains('ej-nombre-input')) {
        active.blur();
      }
    } catch (_) {}
    currentFormDays[diaIdx].ejercicios.push({ nombre: "Nuevo Ejercicio", series: 3, repeticiones: "12", peso: "10 kg", notaProfesor: "", videoUrl: "", esEntradaEnCalor: false });
    renderFormDays();
    setTimeout(() => { window._ignoreNombreCommit = false; }, 100);
  };

  window.addFormWarmupExercise = (diaIdx) => {
    window._ignoreNombreCommit = true;
    try {
      const active = document.activeElement;
      if (active && active.classList && active.classList.contains('ej-nombre-input')) {
        active.blur();
      }
    } catch (_) {}
    const ejs = currentFormDays[diaIdx].ejercicios;
    ejs.unshift({
      nombre: "Entrada en calor",
      series: 2,
      repeticiones: "12",
      peso: "S/D",
      notaProfesor: "",
      videoUrl: "",
      esEntradaEnCalor: true
    });
    renderFormDays();
    setTimeout(() => { window._ignoreNombreCommit = false; }, 100);
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
    if (!currentFormDays[diaIdx] || !currentFormDays[diaIdx].ejercicios[ejIdx]) return;
    const ej = currentFormDays[diaIdx].ejercicios[ejIdx];

    if (field === 'nombre') {
      if (window._ignoreNombreCommit) return;
      const incoming = String(val == null ? '' : val);
      const actual = String(ej.nombre || '');
      // Prefijo de un nombre ya elegido del catálogo → no pisar
      if (
        actual &&
        incoming.length < actual.length &&
        actual.toLowerCase().startsWith(incoming.toLowerCase()) &&
        (ej._catalogPick || ej.videoUrlAuto)
      ) {
        return;
      }
      if (incoming === actual) return;
      ej._catalogPick = false;
      ej._typingDraft = incoming;
      ej.nombre = incoming;
      if (!ej.videoUrl || ej.videoUrlAuto === true) {
        const videoAuto = buscarVideoPorNombreEjercicio(incoming);
        if (videoAuto) {
          ej.videoUrl = videoAuto;
          ej.videoUrlAuto = true;
        }
      }
      return;
    }

    ej[field] = val;

    if (field === 'videoUrl') {
      ej.videoUrlAuto = false;
    }
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
      ejercicios: [...d.ejercicios].sort((a, b) => (b.esEntradaEnCalor ? 1 : 0) - (a.esEntradaEnCalor ? 1 : 0)).map((e, idx) => ({
        id: crypto.randomUUID(),
        nombre: e.nombre,
        seriesTarget: Number(e.series) || 3,
        repeticionesTarget: e.repeticiones || "12",
        pesoSugerido: e.peso || "S/D",
        notaProfesor: e.notaProfesor || "",
        profesorNotaAutor: esModoAlumnoPropio ? `${usuarioActualData.nombre} (vos)` : usuarioActualData.nombre,
        videoUrl: e.videoUrl || "",
        esEntradaEnCalor: !!e.esEntradaEnCalor
      }))
    }));

    if (esModoAlumnoPropio) {
      try {
        if (appState.modalActivo === 'editar_rutina_propia' && appState.rutinaEnEdicionId) {
          const resultado = await store.editarRutinaPropia({
            rutinaId: appState.rutinaEnEdicionId,
            alumnoId: usuarioActualData.id,
            titulo,
            duracionDias: duracion,
            dias: formattedDays
          });
          if (resultado && resultado.ok) {
            alert("✅ Rutina propia actualizada correctamente.");
          } else {
            alert("❌ No se pudo guardar la rutina: " + ((resultado && resultado.error) || "error desconocido") + ". Los cambios no se aplicaron, probá de nuevo.");
          }
        } else {
          await store.crearRutinaPropia({
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

    document.getElementById('navHistorial')?.addEventListener('click', async () => {
      appState.tabCliente = 'historial';
      appState.mostrarDrawerNotifs = false;
      renderApp();
      // Re-sync para traer series completas desde Supabase
      if (appState.usuarioActual?.rol === 'alumno' && window.gymStore) {
        try {
          await window.gymStore.syncWithSupabase(appState.usuarioActual.data.id);
          renderApp();
        } catch (_) {}
      }
    });

    document.getElementById('navStats')?.addEventListener('click', async () => {
      appState.tabCliente = 'stats';
      appState.mostrarDrawerNotifs = false;
      if (appState.statsMonthOffset == null) appState.statsMonthOffset = 0;
      renderApp();
      if (appState.usuarioActual?.rol === 'alumno' && window.gymStore && window.supabaseEngine) {
        try {
          const alumnoId = appState.usuarioActual.data.id;
          await window.gymStore.syncWithSupabase(alumnoId);
          // Recargar SOLO series por id (no pisar el resto del log)
          if (typeof window.supabaseEngine.enriquecerSeriesDeLogs === 'function') {
            await window.supabaseEngine.enriquecerSeriesDeLogs(window.gymStore.data.workoutLogs);
            window.gymStore.saveData();
          }
          renderApp();
        } catch (err) {
          console.warn('Stats refresh:', err);
        }
      }
    });
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
      // Candado: evita doble toque / re-entrada mientras guarda
      if (appState.finalizandoEntrenamiento) return;
      appState.finalizandoEntrenamiento = true;

      const dia = appState.diaActivoEntrenamiento;
      const alumno = appState.usuarioActual.data;
      const rutinaActiva = store.getRutinaPorId(appState.rutinaSeleccionadaId) || store.getRutinaActiva(alumno.id);

      const setsLogArr = [];
      Object.keys(appState.workoutDraftSets).forEach(ejId => {
        const ejData = appState.workoutDraftSets[ejId];
        ejData.sets.forEach(s => {
          setsLogArr.push({
            ejercicioId:       ejId,
            ejercicioNombre:   ejData.nombre,
            setNumero:         s.setNumero,
            repsRealizadas:    s.reps,
            pesoUtilizado:     s.peso,
            comentarioAlumno:  s.comentarioSet || ''
          });
        });
      });

      if (!rutinaActiva) {
        appState.finalizandoEntrenamiento = false;
        alert('❌ No tienes una rutina activa asignada.\n\nContacta a tu profesor para que te asigne una rutina de entrenamiento.');
        renderApp();
        return;
      }

      const btn = e.currentTarget;
      if (btn) {
        btn.disabled = true;
        btn.textContent = '⏳ Guardando...';
      }

      try {
        const logGuardado = await store.guardarEntrenamientoReal({
          alumnoId:         alumno.id,
          rutinaId:         rutinaActiva.id,
          diaId:            dia.id,
          diaNombre:        dia.nombre,
          diaNumero:        dia.diaNumero || 1,
          setsLog:          setsLogArr,
          comentarioGeneral: appState.workoutGeneralComment || ''
        });

        const puntosConfirmadosPorServidor = logGuardado?.puntosConfirmadosPorServidor === true;

        if (!puntosConfirmadosPorServidor) {
          alert('⚠️ Entrenamiento guardado en tu historial, pero no se pudieron confirmar los puntos en el servidor.\n\nSi el problema persiste, contactá al profesor.');
        } else if (logGuardado?.yaHuboEntrenamientoHoy) {
          alert('🏆 ¡Entrenamiento completado y guardado en tu historial!\nYa sumaste puntos hoy con otro entrenamiento — este quedó en el historial, pero no otorga puntos adicionales (solo una vez por día).');
        } else {
          const puntosGanados = Math.round((logGuardado?.puntos || 0));
          const bonusTexto = logGuardado?.bonusRacha ? ` (incluye +${logGuardado.bonusRacha} 🔥 bonus por racha)` : '';
          alert(`🏆 ¡Entrenamiento completado y guardado en tu historial!\n+${puntosGanados} puntos ganados${bonusTexto}`);
        }

        clearWorkoutDraft();
        appState.diaActivoEntrenamiento = null;
        appState.tabCliente = 'historial';
      } catch (err) {
        console.error('Error al finalizar entrenamiento:', err);
        alert('❌ No se pudo guardar el entrenamiento: ' + ((err && err.message) || 'error desconocido'));
        if (btn) {
          btn.disabled = false;
          btn.textContent = '✅ Finalizar Entrenamiento';
        }
      } finally {
        appState.finalizandoEntrenamiento = false;
        renderApp();
      }
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

    document.getElementById('btnConfirmarBorrarEntrenamiento')?.addEventListener('click', async () => {
      const alumno = appState.usuarioActual && appState.usuarioActual.data;
      const logId = appState.logABorrarId;
      if (!alumno || !logId) {
        appState.modalActivo = null;
        appState.logABorrarId = null;
        renderApp();
        return;
      }
      const btn = document.getElementById('btnConfirmarBorrarEntrenamiento');
      if (btn) { btn.disabled = true; btn.textContent = 'Borrando…'; }
      try {
        await store.eliminarEntrenamiento({ logId, alumnoId: alumno.id });
        alert('✅ Entrenamiento borrado.');
      } catch (err) {
        alert('❌ No se pudo borrar: ' + (err.message || err));
      }
      appState.modalActivo = null;
      appState.logABorrarId = null;
      renderApp();
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
                    const idx = gymStore.data.workoutLogs.findIndex(w => String(w.id) === String(sbLog.id));
                    const remoteSets = Array.isArray(sbLog.sets) ? sbLog.sets : [];
                    if (idx >= 0) {
                      const local = gymStore.data.workoutLogs[idx];
                      const localSets = Array.isArray(local.sets) ? local.sets : [];
                      const sets = remoteSets.length > 0 ? remoteSets : localSets;
                      gymStore.data.workoutLogs[idx] = { ...local, ...sbLog, sets };
                    } else {
                      gymStore.data.workoutLogs.push(sbLog);
                    }
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

            <div class="rf-section-header">
              <h4 class="rf-section-title">Días y ejercicios</h4>
              <button type="button" class="rf-text-btn" id="btnAddDay">+ Día</button>
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

  // --- Autocompletado de video por nombre de ejercicio (solo formulario, no toca Supabase) ---
  const CATALOGO_VIDEOS_EJERCICIOS = [
    { nombre: "Pull over en polea con barra", videoUrl: "https://www.youtube.com/shorts/5cqIDziQ5Ko", alias: ["Pull over en polea con barra", "pull over en polea con barra", "pullover en polea con barra", "pull over polea barra", "pullover polea barra", "pull-over en polea con barra"] },
    { nombre: "Pull over en polea con soga", videoUrl: "https://www.youtube.com/shorts/oOmDvbqJj-Q", alias: ["Pull over en polea con soga", "pull over en polea con soga", "pullover en polea con soga", "pull over polea soga", "pullover polea soga", "pull-over en polea con soga", "pull over en polea con cuerda"] },
    { nombre: "Press de hombro en maquina", videoUrl: "https://www.youtube.com/shorts/BqdJeb6jHko", alias: ["Press de hombro en maquina", "Press de hombro en máquina", "press de hombro en maquina", "press de hombro en máquina", "press hombro maquina", "press hombro máquina", "press de hombros en maquina", "shoulder press maquina"] },
    { nombre: "Patada de gluteo en polea", videoUrl: "https://www.youtube.com/shorts/FclsfZvytqM", alias: ["Patada de gluteo en polea", "patada de gluteo en polea", "patada de glúteo en polea", "patada gluteo polea", "patada glúteo polea", "glute kickback polea", "patadas de gluteo en polea"] },
    { nombre: "Patada de gluteo en maquina", videoUrl: "https://www.youtube.com/shorts/HlrLyKsrV78", alias: ["Patada de gluteo en maquina", "Patada de gluteo en máquina", "patada de gluteo en maquina", "patada de gluteo en máquina", "patada de glúteo en maquina", "patada gluteo maquina", "patada glúteo máquina", "glute kickback maquina"] },
    { nombre: "Patada de gluteo en polea con banco", videoUrl: "https://www.youtube.com/shorts/BNOfVprH6DI", alias: ["Patada de gluteo en polea con banco", "patada de gluteo en polea con banco", "patada de glúteo en polea con banco", "patada gluteo polea banco", "patada gluteo en polea banco", "glute kickback polea banco"] },
    { nombre: "Abduccion sentado en maquina", videoUrl: "https://www.youtube.com/shorts/xlp6FYwBFLU", alias: ["Abduccion sentado en maquina", "Abduccion sentado en máquina", "abduccion sentado en maquina", "abduccion sentado en máquina"] },
    { nombre: "Abs bolitas", videoUrl: "https://www.youtube.com/shorts/Wlw3wvJdhBc", alias: ["Abs bolitas", "abs bolitas"] },
    { nombre: "Abs rectos con peso", videoUrl: "https://www.youtube.com/shorts/BFTJUFmiwHM", alias: ["Abs rectos con peso", "abs rectos con peso"] },
    { nombre: "Abs rectos con piernas a 45°", videoUrl: "https://www.youtube.com/shorts/4rttpgLuJR8", alias: ["Abs rectos con piernas a 45°", "abs rectos con piernas a 45°"] },
    { nombre: "Aduccion sentado en maquina", videoUrl: "https://www.youtube.com/shorts/vlViIgtkvh4", alias: ["Aduccion sentado en maquina", "Aduccion sentado en máquina", "aduccion sentado en maquina", "aduccion sentado en máquina"] },
    { nombre: "Apertura con empuje en banco plano", videoUrl: "https://www.youtube.com/shorts/Fc1UgcryhrA", alias: ["Apertura con empuje en banco plano", "apertura con empuje en banco plano"] },
    { nombre: "Apertura en banco inclinado", videoUrl: "https://www.youtube.com/shorts/CQx4FhzelMU", alias: ["Apertura en banco inclinado", "apertura en banco inclinado"] },
    { nombre: "Apertura en banco plano", videoUrl: "https://www.youtube.com/shorts/26TsSvfg28U", alias: ["Apertura en banco plano", "apertura en banco plano"] },
    { nombre: "Apertura en polea", videoUrl: "https://www.youtube.com/shorts/QEW6RO0O-ak", alias: ["Apertura en polea", "apertura en polea"] },
    { nombre: "Arranque a 1 brazo", videoUrl: "https://www.youtube.com/shorts/IVIrE_x5FtE", alias: ["Arranque a 1 brazo", "arranque a 1 brazo"] },
    { nombre: "Arranque con barra", videoUrl: "https://www.youtube.com/shorts/-7mUZ2RFAw4", alias: ["Arranque con barra", "arranque con barra"] },
    { nombre: "Biceps con barra", videoUrl: "https://www.youtube.com/shorts/B3Feq30xwpo", alias: ["Biceps con barra", "biceps con barra", "bíceps con barra"] },
    { nombre: "Biceps con barra en polea", videoUrl: "https://www.youtube.com/shorts/oJGSW0z5Hew", alias: ["Biceps con barra en polea", "biceps con barra en polea", "bíceps con barra en polea"] },
    { nombre: "Biceps con mancuerna banco inclinado", videoUrl: "https://www.youtube.com/shorts/4LQ0p0ni39Y", alias: ["Biceps con mancuerna banco inclinado", "Biceps con mancuernas banco inclinado", "biceps con mancuerna banco inclinado", "biceps con mancuernas banco inclinado", "bíceps con mancuerna banco inclinado"] },
    { nombre: "Biceps con mancuernas", videoUrl: "https://www.youtube.com/shorts/WrpQYs_n_Pw", alias: ["Biceps con mancuerna", "Biceps con mancuernas", "biceps con mancuerna", "biceps con mancuernas", "bíceps con mancuernas"] },
    { nombre: "Biceps con soga en polea", videoUrl: "https://www.youtube.com/shorts/dj99CeV_UUY", alias: ["Biceps con soga en polea", "biceps con soga en polea", "bíceps con soga en polea"] },
    { nombre: "Biceps en banco scott", videoUrl: "https://www.youtube.com/shorts/Zj0P6gFb9MY", alias: ["Biceps en banco scott", "biceps en banco scott", "bíceps en banco scott"] },
    { nombre: "Biceps en banco scott con mancuernas", videoUrl: "https://www.youtube.com/shorts/L4AQh3lTICk", alias: ["Biceps en banco scott con mancuerna", "Biceps en banco scott con mancuernas", "biceps en banco scott con mancuerna", "biceps en banco scott con mancuernas", "bíceps en banco scott con mancuernas"] },
    { nombre: "Biceps martillo", videoUrl: "https://www.youtube.com/shorts/QdEY-VZcPMU", alias: ["Biceps martillo", "biceps martillo", "bíceps martillo"] },
    { nombre: "Bicho muerto", videoUrl: "https://www.youtube.com/shorts/_o23Ghklahc", alias: ["Bicho muerto", "bicho muerto"] },
    { nombre: "Bisagras oblicuas", videoUrl: "https://www.youtube.com/shorts/EExl_U2GGEk", alias: ["Bisagras oblicuas", "bisagras oblicuas"] },
    { nombre: "Camilla de isquios", videoUrl: "https://www.youtube.com/shorts/B6t8MvbTtew", alias: ["Camilla de isquios", "Camilla isquios", "camilla de isquios", "camilla isquios"] },
    { nombre: "Camilla de isquios 1 pp", videoUrl: "https://www.youtube.com/shorts/Ix7wiKrC7bQ", alias: ["Camilla de isquios 1 pierna", "Camilla de isquios 1 pp", "Camilla de isquios a un pie", "Camilla de isquios unilateral", "Camilla isquios 1 pp", "camilla de isquios 1 pierna", "camilla de isquios 1 pp", "camilla de isquios a un pie", "camilla de isquios unilateral", "camilla isquios 1 pp"] },
    { nombre: "Cargada", videoUrl: "https://www.youtube.com/shorts/7KMYH9gyeEM", alias: ["Cargada", "cargada"] },
    { nombre: "Cargada + segundo tiempo", videoUrl: "https://www.youtube.com/shorts/MrG8DIttWVA", alias: ["Cargada + segundo tiempo", "cargada + segundo tiempo"] },
    { nombre: "Cuadricera", videoUrl: "https://www.youtube.com/shorts/iNvPzf15KKA", alias: ["Cuadricera", "cuadricera"] },
    { nombre: "Cuadricera 1 pp", videoUrl: "https://www.youtube.com/shorts/OhHvfoomEfY", alias: ["Cuadricera 1 pierna", "Cuadricera 1 pp", "Cuadricera a un pie", "Cuadricera unilateral", "cuadricera 1 pierna", "cuadricera 1 pp", "cuadricera a un pie", "cuadricera unilateral"] },
    { nombre: "Elevacion cadera en fitball", videoUrl: "https://www.youtube.com/shorts/p4Bwnapg03c", alias: ["Elevacion cadera en fitball", "elevacion cadera en fitball"] },
    { nombre: "Encogimiento con barra", videoUrl: "https://www.youtube.com/shorts/xgLOVCSFTAc", alias: ["Encogimiento con barra", "encogimiento con barra"] },
    { nombre: "Encogimiento con mancuernas", videoUrl: "https://www.youtube.com/shorts/0-KrI1Hqpk4", alias: ["Encogimiento con mancuerna", "Encogimiento con mancuernas", "encogimiento con mancuerna", "encogimiento con mancuernas"] },
    { nombre: "Estocadas fijas en smith", videoUrl: "https://www.youtube.com/shorts/sEE7Qrlf4j4", alias: ["Estocadas fijas en en smith", "Estocadas fijas en smith", "Estocadas fijas smith", "estocada fijas en smith", "estocadas fijas en en smith", "estocadas fijas en smith", "estocadas fijas smith", "zancadas fijas en smith"] },
    { nombre: "Estocadas hacia adelante", videoUrl: "https://www.youtube.com/shorts/IIJA6XbIdyI", alias: ["Estocadas hacia adelante", "estocada hacia adelante", "estocadas hacia adelante", "zancadas hacia adelante"] },
    { nombre: "Estocadas hacia atras", videoUrl: "https://www.youtube.com/shorts/pckiYC8Rnsc", alias: ["Estocadas hacia atras", "estocada hacia atras", "estocadas hacia atras", "zancadas hacia atras"] },
    { nombre: "Face pull", videoUrl: "https://www.youtube.com/shorts/5Yu8DTe4BAQ", alias: ["Face pull", "face pull"] },
    { nombre: "Fondos en banco", videoUrl: "https://www.youtube.com/shorts/wN_9d37DO4M", alias: ["Fondos en banco", "fondos en banco"] },
    { nombre: "Fondos en paralelas", videoUrl: "https://www.youtube.com/shorts/s5BLhbKWD3E", alias: ["Fondos en paralelas", "fondos en paralelas"] },
    { nombre: "Hip thrust", videoUrl: "https://www.youtube.com/shorts/zaSzxo6xleY", alias: ["Hip thrust", "empuje de cadera", "hip thrust", "hipthrust"] },
    { nombre: "Inferiores carrito", videoUrl: "https://www.youtube.com/shorts/62-5TombKfU", alias: ["Inferiores carrito", "inferiores carrito"] },
    { nombre: "Inferiores con peso", videoUrl: "https://www.youtube.com/shorts/zMJ6Hqv8-sM", alias: ["Inferiores con peso", "inferiores con peso"] },
    { nombre: "Inferiores en paralelas", videoUrl: "https://www.youtube.com/watch?v=fX6JwyyW16o", alias: ["Inferiores en paralelas", "inferiores en paralelas"] },
    { nombre: "Isquios sentado en maquina", videoUrl: "https://www.youtube.com/shorts/6IvQvWZmEsw", alias: ["Isquios sentado en maquina", "Isquios sentado en máquina", "isquios sentado en maquina", "isquios sentado en máquina"] },
    { nombre: "Isquios sentado en maquina 1 pp", videoUrl: "https://www.youtube.com/shorts/UNc9k9WBXj8", alias: ["Isquios sentado en maquina 1 pierna", "Isquios sentado en maquina 1 pp", "Isquios sentado en maquina a un pie", "Isquios sentado en maquina unilateral", "Isquios sentado en máquina 1 pp", "isquios sentado en maquina 1 pierna", "isquios sentado en maquina 1 pp", "isquios sentado en maquina a un pie", "isquios sentado en maquina unilateral", "isquios sentado en máquina 1 pp"] },
    { nombre: "Jalon dorsal 1 brazo", videoUrl: "https://www.youtube.com/shorts/rudpTb4A0X8", alias: ["Jalon dorsal 1 brazo", "jalon dorsal 1 brazo", "jalón dorsal 1 brazo"] },
    { nombre: "Jalon dorsal neutro", videoUrl: "https://www.youtube.com/shorts/Yie3dzpYNtQ", alias: ["Jalon dorsal neutro", "jalon dorsal neutro", "jalón dorsal neutro"] },
    { nombre: "Jalon dorsal prono amplio", videoUrl: "https://www.youtube.com/shorts/sAYU5EvtXSo", alias: ["Jalon dorsal prono amplio", "jalon al pecho", "jalon dorsal prono amplio", "jalon dorsalera", "jalón al pecho", "jalón dorsal prono amplio"] },
    { nombre: "Jalon dorsal supino", videoUrl: "https://www.youtube.com/shorts/Q4e_Ya9BnlM", alias: ["Jalon dorsal supino", "jalon dorsal supino", "jalón dorsal supino"] },
    { nombre: "Peso muerto", videoUrl: "https://www.youtube.com/shorts/WdADxet2RQc", alias: ["Peso muerto", "deadlift", "peso muerto"] },
    { nombre: "Peso muerto 1 pp", videoUrl: "https://www.youtube.com/shorts/Z3TRkamr5jA", alias: ["Peso muerto 1 pierna", "Peso muerto 1 pp", "Peso muerto a un pie", "Peso muerto unilateral", "deadlift 1 pp", "peso muerto 1 pierna", "peso muerto 1 pp", "peso muerto a un pie", "peso muerto unilateral"] },
    { nombre: "Plancha frontal", videoUrl: "https://www.youtube.com/shorts/XCOq6lfsFAk", alias: ["Plancha frontal", "plancha frontal"] },
    { nombre: "Plancha frontal 3 apoyos", videoUrl: "https://www.youtube.com/shorts/umPWS5gofGE", alias: ["Plancha frontal 3 apoyos", "plancha frontal 3 apoyos"] },
    { nombre: "Plancha frontal subo y bajo", videoUrl: "https://www.youtube.com/shorts/1X1cn0XqaKw", alias: ["Plancha frontal subo y bajo", "plancha frontal subo y bajo"] },
    { nombre: "Plancha frontal toco hombro", videoUrl: "https://www.youtube.com/shorts/auypDs3TVeM", alias: ["Plancha frontal toco hombro", "plancha frontal toco hombro"] },
    { nombre: "Plancha lateral", videoUrl: "https://www.youtube.com/shorts/fNsxKTKfMNI", alias: ["Plancha lateral", "plancha lateral"] },
    { nombre: "Prensa en 45°", videoUrl: "https://www.youtube.com/shorts/NYa0tZCW4fk", alias: ["Prensa en 45°", "prensa en 45°"] },
    { nombre: "Prensa horizontal", videoUrl: "https://www.youtube.com/shorts/W7bL6i1sJo4", alias: ["Prensa horizontal", "prensa horizontal"] },
    { nombre: "Prensa horizontal a 1 pp", videoUrl: "https://www.youtube.com/shorts/O6VCiyKvM3c", alias: ["Prensa horizontal a 1 pierna", "Prensa horizontal a 1 pp", "Prensa horizontal a a un pie", "Prensa horizontal a unilateral", "prensa horizontal a 1 pierna", "prensa horizontal a 1 pp", "prensa horizontal a a un pie", "prensa horizontal a unilateral"] },
    { nombre: "Prensa sumo", videoUrl: "https://www.youtube.com/shorts/SguVlooAwcA", alias: ["Prensa sumo", "prensa sumo"] },
    { nombre: "Press de banca a 1 brazo con mancuerna", videoUrl: "https://www.youtube.com/watch?v=N_BzPe7kmdk", alias: ["Press banca a 1 brazo con mancuerna", "Press de banca a 1 brazo con mancuerna", "Press de banca a 1 brazo con mancuernas", "press banca a 1 brazo con mancuerna", "press de banca a 1 brazo con mancuerna", "press de banca a 1 brazo con mancuernas"] },
    { nombre: "Press de banca declinado", videoUrl: "https://www.youtube.com/shorts/NEOBG2KgVyA", alias: ["Press banca declinado", "Press de banca declinado", "press banca declinado", "press de banca declinado"] },
    { nombre: "Press de banca inclinado con barra", videoUrl: "https://www.youtube.com/shorts/g99l4KwY-vo", alias: ["Press banca inclinado con barra", "Press de banca inclinado con barra", "press banca inclinado con barra", "press de banca inclinado con barra"] },
    { nombre: "Press de banca inclinado con mancuernas", videoUrl: "https://www.youtube.com/shorts/tcw2c5dtqD4", alias: ["Press banca inclinado con mancuernas", "Press de banca inclinado con mancuernas", "press banca inclinado con mancuernas", "press de banca inclinado con mancuernas"] },
    { nombre: "Press de banca inclinado en smith", videoUrl: "https://www.youtube.com/shorts/XwjuCBcFXQQ", alias: ["Press banca inclinado en smith", "Press de banca inclinado en en smith", "Press de banca inclinado en smith", "Press de banca inclinado smith", "press banca inclinado en smith", "press de banca inclinado en en smith", "press de banca inclinado en smith", "press de banca inclinado smith"] },
    { nombre: "Press de banca plano con barra", videoUrl: "https://www.youtube.com/shorts/HzkHpIIo4IA", alias: ["Press banca plano con barra", "Press de banca plano con barra", "press banca plano con barra", "press de banca plano con barra", "press plano con barra"] },
    { nombre: "Press de banca plano con mancuernas", videoUrl: "https://www.youtube.com/shorts/qW519gsE2M8", alias: ["Press banca plano con mancuernas", "Press de banca plano con mancuerna", "Press de banca plano con mancuernas", "press banca plano con mancuernas", "press de banca plano con mancuerna", "press de banca plano con mancuernas", "press plano con mancuernas"] },
    { nombre: "Press de banca plano en smith", videoUrl: "https://www.youtube.com/shorts/9_tbUqJ45QU", alias: ["Press banca plano en smith", "Press de banca plano en en smith", "Press de banca plano en smith", "Press de banca plano smith", "press banca plano en smith", "press de banca plano en en smith", "press de banca plano en smith", "press de banca plano smith", "press plano en smith"] },
    { nombre: "Press de hombro 1 brazo", videoUrl: "https://www.youtube.com/shorts/i5cvgQveFbY", alias: ["Press de hombro 1 brazo", "Press hombro 1 brazo", "press de hombro 1 brazo", "press hombro 1 brazo"] },
    { nombre: "Press de hombro con barra", videoUrl: "https://www.youtube.com/shorts/z_-74FMv5Jg", alias: ["Press de hombro con barra", "Press hombro con barra", "press de hombro con barra", "press hombro con barra"] },
    { nombre: "Press de hombro con barra sentado", videoUrl: "https://www.youtube.com/shorts/AmcpSwUNPYc", alias: ["Press de hombro con barra sentado", "Press hombro con barra sentado", "press de hombro con barra sentado", "press hombro con barra sentado"] },
    { nombre: "Press de hombro con mancuernas", videoUrl: "https://www.youtube.com/shorts/96C2nPejfY4", alias: ["Press de hombro con mancuerna", "Press de hombro con mancuernas", "Press hombro con mancuernas", "press de hombro con mancuerna", "press de hombro con mancuernas", "press hombro con mancuernas"] },
    { nombre: "Press de hombro con mancuernas sentado", videoUrl: "https://www.youtube.com/shorts/R0f2Of6Sl2A", alias: ["Press de hombro con mancuerna sentado", "Press de hombro con mancuernas sentado", "Press hombro con mancuernas sentado", "press de hombro con mancuerna sentado", "press de hombro con mancuernas sentado", "press hombro con mancuernas sentado"] },
    { nombre: "Press de pecho en maquina sentado", videoUrl: "https://www.youtube.com/shorts/88kSaeQG21Y", alias: ["Press de pecho en maquina sentado", "Press de pecho en máquina sentado", "Press pecho en maquina sentado", "press de pecho en maquina sentado", "press de pecho en máquina sentado", "press pecho en maquina sentado"] },
    { nombre: "Press de pecho inclinado en maquina", videoUrl: "https://www.youtube.com/shorts/YS6DsKrY8T0", alias: ["Press de pecho inclinado en maquina", "Press de pecho inclinado en máquina", "Press pecho inclinado en maquina", "press de pecho inclinado en maquina", "press de pecho inclinado en máquina", "press pecho inclinado en maquina"] },
    { nombre: "Press frances con barra", videoUrl: "https://www.youtube.com/watch?v=gY-CqZD0Ktc", alias: ["Press frances con barra", "press frances con barra"] },
    { nombre: "Press frances con barra W", videoUrl: "https://www.youtube.com/shorts/CAUWI4sNPKk", alias: ["Press frances con barra W", "press frances con barra w"] },
    { nombre: "Press frances con mancuerna", videoUrl: "https://www.youtube.com/shorts/FgN0vyx8jNE", alias: ["Press frances con mancuerna", "Press frances con mancuernas", "press frances con mancuerna", "press frances con mancuernas"] },
    { nombre: "Press frances en polea", videoUrl: "https://www.youtube.com/shorts/wNVVttuAGnM", alias: ["Press frances en polea", "press frances en polea"] },
    { nombre: "Remo con barra", videoUrl: "https://www.youtube.com/shorts/b8FgtZlyEd4", alias: ["Remo con barra", "remo con barra"] },
    { nombre: "Remo en barra T", videoUrl: "https://www.youtube.com/shorts/uLr8HcW_7ig", alias: ["Remo en barra T", "remo en barra t"] },
    { nombre: "Remo en landmine", videoUrl: "https://www.youtube.com/watch?v=25lFwuWjKSM", alias: ["Remo en ladmine", "Remo en landmine", "remo en ladmine", "remo en landmine"] },
    { nombre: "Remo en polea baja 1 brazo", videoUrl: "https://www.youtube.com/shorts/Ol37ocDBdAU", alias: ["Remo en polea baja 1 brazo", "remo en polea baja 1 brazo"] },
    { nombre: "Remo en polea baja neutro", videoUrl: "https://www.youtube.com/shorts/soxtqUNRt6E", alias: ["Remo en polea baja neutro", "remo en polea baja neutro"] },
    { nombre: "Remo en polea baja prono", videoUrl: "https://www.youtube.com/watch?v=Vm6E-2tq0bU", alias: ["Remo en polea baja prono", "remo en polea baja prono"] },
    { nombre: "Remo en polea baja supino", videoUrl: "https://www.youtube.com/shorts/GTb5tId5HG4", alias: ["Remo en polea baja supino", "remo en polea baja supino"] },
    { nombre: "Remo en smith", videoUrl: "https://www.youtube.com/shorts/lTQJFDyQq0s", alias: ["Remo en en smith", "Remo en smith", "Remo smith", "remo en en smith", "remo en smith", "remo smith"] },
    { nombre: "Ruedita abdominal", videoUrl: "https://www.youtube.com/shorts/knjliGWvGa4", alias: ["Ruedita abdominal", "ruedita abdominal"] },
    { nombre: "Segundo tiempo", videoUrl: "https://www.youtube.com/shorts/fWQbTvolNqA", alias: ["Segundo tiempo", "segundo tiempo"] },
    { nombre: "Sentadilla barra hexagonal", videoUrl: "https://www.youtube.com/shorts/JfhNkNz59lI", alias: ["Sentadilla barra exagonal", "Sentadilla barra hexagonal", "Sentadilla hex bar", "senatdilla barra hexagonal", "sentadilla barra exagonal", "sentadilla barra hexagonal", "sentadilla hex bar", "sentadillas barra hexagonal"] },
    { nombre: "Sentadilla bulgaras", videoUrl: "https://www.youtube.com/shorts/cytfxsIK_Hk", alias: ["Sentadilla bulgaras", "senatdilla bulgaras", "sentadilla bulgaras", "sentadillas bulgaras"] },
    { nombre: "Sentadilla con barra", videoUrl: "https://www.youtube.com/shorts/7xeLHxobaWs", alias: ["Sentadilla con barra", "senatdilla con barra", "sentadilla con barra", "sentadillas con barra"] },
    { nombre: "Sentadilla con polea", videoUrl: "https://www.youtube.com/shorts/0vz9HwV4UKg", alias: ["Sentadilla con polea", "senatdilla con polea", "sentadilla con polea", "sentadillas con polea"] },
    { nombre: "Sentadilla en smith", videoUrl: "https://www.youtube.com/shorts/eFY7gyLFUcU", alias: ["Sentadilla en en smith", "Sentadilla en smith", "Sentadilla smith", "senatdilla en smith", "sentadilla en en smith", "sentadilla en smith", "sentadilla smith", "sentadillas en smith"] },
    { nombre: "Sentadilla goblet", videoUrl: "https://www.youtube.com/shorts/3wCp6MN2Z_Q", alias: ["Sentadilla globet", "Sentadilla goblet", "senatdilla goblet", "sentadilla globet", "sentadilla goblet", "sentadillas goblet"] },
    { nombre: "Sentadilla maquina hack", videoUrl: "https://www.youtube.com/shorts/jXZyJ3KNbWw", alias: ["Sentadilla maquina hack", "Sentadilla máquina hack", "senatdilla maquina hack", "sentadilla maquina hack", "sentadilla máquina hack", "sentadillas maquina hack"] },
    { nombre: "Sentadilla sumo", videoUrl: "https://www.youtube.com/shorts/rbKBfqqmmwY", alias: ["Sentadilla sumo", "senatdilla sumo", "sentadilla sumo", "sentadillas sumo"] },
    { nombre: "Tiron al menton", videoUrl: "https://www.youtube.com/shorts/2SAyFkFCoFs", alias: ["Tiron al menton", "tiron al menton"] },
    { nombre: "Triceps en polea con barra", videoUrl: "https://www.youtube.com/shorts/sU9snn0qTEs", alias: ["Triceps en polea con barra", "triceps en polea con barra", "tríceps en polea con barra"] },
    { nombre: "Triceps en polea con soga", videoUrl: "https://www.youtube.com/shorts/W7bQVLg3NWA", alias: ["Triceps en polea con soga", "triceps en polea con soga", "tríceps en polea con soga"] },
    { nombre: "Triceps polea 1 brazo", videoUrl: "https://www.youtube.com/shorts/hip11n3QXzU", alias: ["Triceps polea 1 brazo", "triceps polea 1 brazo", "tríceps polea 1 brazo"] },
    { nombre: "Twist", videoUrl: "https://www.youtube.com/shorts/vq1FICbQC4Q", alias: ["Twist", "twist"] },
    { nombre: "Vitalizaciones", videoUrl: "https://www.youtube.com/shorts/gGIo7i-xnQA", alias: ["Vitalizaciones", "vitalizaciones"] },
    { nombre: "Vuelos frontales con barra", videoUrl: "https://www.youtube.com/shorts/QeJ7INwGgaE", alias: ["Vuelos frontales con barra", "vuelos frontales con barra"] },
    { nombre: "Vuelos frontales con disco", videoUrl: "https://www.youtube.com/shorts/WMCftjiDQW4", alias: ["Vuelos frontales con disco", "vuelos frontales con disco"] },
    { nombre: "Vuelos frontales con mancuernas", videoUrl: "https://www.youtube.com/shorts/ErPdiYXDeTw", alias: ["Vuelos frontales con mancuerna", "Vuelos frontales con mancuernas", "vuelos frontales con mancuerna", "vuelos frontales con mancuernas"] },
    { nombre: "Vuelos frontales con polea", videoUrl: "https://www.youtube.com/shorts/AJ147wzeIfQ", alias: ["Vuelos frontales con polea", "vuelos frontales con polea"] },
    { nombre: "Vuelos laterales con mancuernas", videoUrl: "https://www.youtube.com/shorts/dd9xo-_ahCg", alias: ["Vuelos laterales con mancuerna", "Vuelos laterales con mancuernas", "vuelos laterales con mancuerna", "vuelos laterales con mancuernas"] },
    { nombre: "Vuelos laterales en polea", videoUrl: "https://www.youtube.com/shorts/V98wql8IfVA", alias: ["Vuelos laterales en polea", "vuelos laterales en polea"] },

    { nombre: "Remo con mancuernas", videoUrl: "https://www.youtube.com/shorts/5QYQqPw_WgA", alias: ["Remo con mancuernas", "remo con mancuernas", "remo mancuernas", "remo con mancuerna", "dumbbell row"] },
    { nombre: "Press arnold", videoUrl: "https://www.youtube.com/shorts/Kg8JD8l6ezw", alias: ["Press arnold", "press arnold", "arnold press", "press de arnold"] },
    { nombre: "Wall ball", videoUrl: "https://www.youtube.com/shorts/SDT1KrcO8ac", alias: ["Wall ball", "wall ball", "wallball", "wall balls"] },
    { nombre: "Desplazamiento lateral con banda elastica", videoUrl: "https://www.youtube.com/shorts/N28Hpdezg7Q", alias: ["Desplazamiento lateral con banda elastica", "Desplazamiento lateral con banda elástica", "desplazamiento lateral con banda elastica", "desplazamiento lateral con banda elástica", "desplazamiento lateral banda", "lateral band walk"] },
    { nombre: "Sit up", videoUrl: "https://www.youtube.com/shorts/V3MFEeDYYaE", alias: ["Sit up", "sit up", "sit-up", "situps", "sit ups"] },
    { nombre: "Burpee", videoUrl: "https://www.youtube.com/shorts/EkK3oVBA__Q", alias: ["Burpee", "burpee", "burpi", "burpees"] },
    { nombre: "Medio burpee", videoUrl: "https://www.youtube.com/shorts/FH0hjFVDhu8", alias: ["Medio burpee", "medio burpee", "medio burpi", "half burpee"] },
    { nombre: "Burpee con press", videoUrl: "https://www.youtube.com/shorts/2_UZ-E5qHUA", alias: ["Burpee con press", "burpee con press", "burpi con press", "burpee press"] },
    { nombre: "Press pallof", videoUrl: "https://www.youtube.com/shorts/iNn_sNA6TbU", alias: ["Press pallof", "press pallof", "pallof press", "press de pallof"] },
    { nombre: "Rotacion de hombro con banda", videoUrl: "https://www.youtube.com/watch?v=fljC5LoRqxY", alias: ["Rotacion de hombro con banda", "Rotación de hombro con banda", "rotacion de hombro con banda", "rotación de hombro con banda", "rotacion hombro banda", "rotaciones de hombro con banda"] },
    { nombre: "Rotacion externa de hombro 90", videoUrl: "https://www.youtube.com/shorts/iNn_sNA6TbU", alias: ["Rotacion externa de hombro 90", "Rotación externa de hombro 90°", "Rotacion externa de hombro 90°", "rotacion externa de hombro 90", "rotacion externa hombro 90", "rotacion externa 90", "external rotation 90"] },
  ];

  function normalizarNombreEjercicio(str) {
    return String(str || '')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .trim()
      .replace(/\s+/g, ' ');
  }

  function buscarVideoPorNombreEjercicio(nombre) {
    const norm = normalizarNombreEjercicio(nombre);
    if (!norm) return null;
    const match = CATALOGO_VIDEOS_EJERCICIOS.find(item =>
      item.alias.some(a => normalizarNombreEjercicio(a) === norm) ||
      normalizarNombreEjercicio(item.nombre) === norm
    );
    return match ? match.videoUrl : null;
  }

  function buscarEjerciciosSugeridos(query, limit = 12) {
    const norm = normalizarNombreEjercicio(query);
    if (!norm || norm.length < 2) return [];
    const scored = [];
    for (const item of CATALOGO_VIDEOS_EJERCICIOS) {
      const nom = normalizarNombreEjercicio(item.nombre);
      let score = 0;
      if (nom === norm) score = 100;
      else if (nom.startsWith(norm)) score = 90;
      else if ((' ' + nom).includes(' ' + norm)) score = 75; // inicio de palabra
      else if (nom.includes(norm)) score = 40;
      else {
        for (const a of item.alias) {
          const an = normalizarNombreEjercicio(a);
          if (an === norm) { score = 95; break; }
          if (an.startsWith(norm)) { score = Math.max(score, 85); }
          else if ((' ' + an).includes(' ' + norm)) { score = Math.max(score, 70); }
          else if (an.includes(norm)) { score = Math.max(score, 35); }
        }
      }
      if (score >= 70) scored.push({ ...item, score }); // solo matches de calidad
    }
    scored.sort((a, b) => b.score - a.score || a.nombre.localeCompare(b.nombre));
    const seen = new Set();
    const out = [];
    for (const s of scored) {
      if (seen.has(s.videoUrl)) continue;
      seen.add(s.videoUrl);
      out.push(s);
      if (out.length >= limit) break;
    }
    return out;
  }

  window.onEjercicioNombreInput = (diaIdx, ejIdx, val) => {
    const ej = currentFormDays[diaIdx].ejercicios[ejIdx];
    // No escribir ej.nombre en cada tecla: solo al elegir del catálogo o al blur.
    // Si no, al tocar "+ Ejercicio" un change/blur con "press" pisa "Press banca…".
    ej._typingDraft = val;
    ej._catalogPick = false;
    if (!ej.videoUrl || ej.videoUrlAuto === true) {
      const videoAuto = buscarVideoPorNombreEjercicio(val);
      if (videoAuto) {
        ej.videoUrl = videoAuto;
        ej.videoUrlAuto = true;
        const videoInput = document.querySelector(`[data-video-input="${diaIdx}-${ejIdx}"]`);
        if (videoInput) videoInput.value = videoAuto;
      }
    }
    const box = document.getElementById(`ej-suggest-${diaIdx}-${ejIdx}`);
    if (!box) return;
    const sugeridos = buscarEjerciciosSugeridos(val);
    if (!sugeridos.length) {
      box.hidden = true;
      box.innerHTML = '';
      return;
    }
    box.dataset.diaIdx = String(diaIdx);
    box.dataset.ejIdx = String(ejIdx);
    box.innerHTML = sugeridos.map((s, i) => {
      const nom = String(s.nombre).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;');
      const url = String(s.videoUrl).replace(/&/g,'&amp;').replace(/"/g,'&quot;');
      return `<button type="button" class="ej-suggest-item" data-suggest-idx="${i}" data-nombre="${nom}" data-url="${url}"><span class="ej-suggest-name">${nom}</span></button>`;
    }).join('');
    box.hidden = false;
  };

  window.seleccionarEjercicioCatalogo = (diaIdx, ejIdx, nombre, videoUrl) => {
    if (!currentFormDays[diaIdx] || !currentFormDays[diaIdx].ejercicios[ejIdx]) return;
    const ej = currentFormDays[diaIdx].ejercicios[ejIdx];
    ej.nombre = nombre;
    ej.videoUrl = videoUrl;
    ej.videoUrlAuto = true;
    ej._catalogPick = true;
    ej._typingDraft = nombre;
    const box = document.getElementById(`ej-suggest-${diaIdx}-${ejIdx}`);
    if (box) { box.hidden = true; box.innerHTML = ''; }
    const wrap = box && box.parentElement;
    const inp = wrap && wrap.querySelector('.ej-nombre-input');
    if (inp) inp.value = nombre;
    // Ignorar el blur/change que puede dispararse al re-render
    window._ignoreNombreCommit = true;
    renderFormDays();
    setTimeout(() => { window._ignoreNombreCommit = false; }, 100);
  };

  window.ocultarSugerenciasEjercicio = (diaIdx, ejIdx) => {
    setTimeout(() => {
      const box = document.getElementById(`ej-suggest-${diaIdx}-${ejIdx}`);
      if (box) box.hidden = true;
    }, 220);
  };

  // Delegación: un solo listener global (evita romper HTML con comillas en onclick)
  if (!window._ejSuggestDelegated) {
    window._ejSuggestDelegated = true;
    document.addEventListener('mousedown', (e) => {
      const btn = e.target.closest && e.target.closest('.ej-suggest-item');
      if (!btn) return;
      const box = btn.closest('.ej-suggest-box');
      if (!box) return;
      e.preventDefault();
      e.stopPropagation();
      const diaIdx = parseInt(box.dataset.diaIdx, 10);
      const ejIdx = parseInt(box.dataset.ejIdx, 10);
      const nombre = btn.getAttribute('data-nombre');
      const videoUrl = btn.getAttribute('data-url');
      if (nombre && window.seleccionarEjercicioCatalogo) {
        window.seleccionarEjercicioCatalogo(diaIdx, ejIdx, nombre, videoUrl);
      }
    }, true);
  }


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
          videoUrl: e.videoUrl || "",
          esEntradaEnCalor: !!e.esEntradaEnCalor
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
        ejercicios: [{ nombre: "Nuevo Ejercicio", series: 3, repeticiones: "12", peso: "10 kg", notaProfesor: "", videoUrl: "", esEntradaEnCalor: false }]
      });
      renderFormDays();
    });
  }

  function renderFormDays() {
    const container = document.getElementById('daysContainer');
    if (!container) return;

    container.innerHTML = currentFormDays.map((dia, diaIdx) => `
      <div class="rf-day">
        <div class="rf-day-header">
          <input type="text" class="form-input rf-day-name" value="${dia.nombre}" onchange="window.updateFormDayName(${diaIdx}, this.value)" placeholder="Nombre del día">
          <div class="rf-day-actions">
            <button type="button" class="rf-icon-btn" onclick="window.moveFormDayUp(${diaIdx})" title="Subir día">↑</button>
            <button type="button" class="rf-icon-btn" onclick="window.moveFormDayDown(${diaIdx})" title="Bajar día">↓</button>
            <button type="button" class="rf-text-btn" onclick="window.addFormExercise(${diaIdx})">+ Ejercicio</button>
            <button type="button" class="rf-text-btn rf-warmup-btn" onclick="window.addFormWarmupExercise(${diaIdx})">+ Entrada en calor</button>
            ${currentFormDays.length > 1 ? `<button type="button" class="rf-icon-btn rf-danger" onclick="window.removeFormDay(${diaIdx})" title="Eliminar día">×</button>` : ''}
          </div>
        </div>

        <div class="rf-exercises">
        ${dia.ejercicios.map((ej, ejIdx) => `
          <div class="rf-exercise${ej.esEntradaEnCalor ? ' rf-exercise-warmup' : ''}">
            <div class="rf-exercise-top">
              <div class="rf-field rf-field-grow">
                <label class="rf-label">${ej.esEntradaEnCalor ? '🔥 Entrada en calor' : 'Ejercicio'}</label>
                <div class="ej-suggest-wrap">
                  <input type="text" class="form-input ej-nombre-input" value="${String(ej.nombre || '').replace(/"/g, '&quot;')}"
                    data-dia-idx="${diaIdx}" data-ej-idx="${ejIdx}"
                    oninput="window.onEjercicioNombreInput(${diaIdx}, ${ejIdx}, this.value)"
                    onchange="window.updateFormExercise(${diaIdx}, ${ejIdx}, 'nombre', this.value)"
                    onblur="window.ocultarSugerenciasEjercicio(${diaIdx}, ${ejIdx})"
                    autocomplete="off"
                    placeholder="Nombre del ejercicio">
                  <div class="ej-suggest-box" id="ej-suggest-${diaIdx}-${ejIdx}" hidden></div>
                </div>
              </div>
              <div class="rf-exercise-actions">
                <button type="button" class="rf-icon-btn" onclick="window.moveFormExerciseUp(${diaIdx}, ${ejIdx})" title="Subir">↑</button>
                <button type="button" class="rf-icon-btn" onclick="window.moveFormExerciseDown(${diaIdx}, ${ejIdx})" title="Bajar">↓</button>
                ${dia.ejercicios.length > 1 ? `<button type="button" class="rf-icon-btn rf-danger" onclick="window.removeFormExercise(${diaIdx}, ${ejIdx})" title="Quitar">×</button>` : ''}
              </div>
            </div>

            <div class="rf-metrics">
              <div class="rf-field">
                <label class="rf-label">Series</label>
                <input type="number" class="form-input" value="${ej.series}" onchange="window.updateFormExercise(${diaIdx}, ${ejIdx}, 'series', this.value)">
              </div>
              <div class="rf-field">
                <label class="rf-label">Reps</label>
                <input type="text" class="form-input" value="${ej.repeticiones}" onchange="window.updateFormExercise(${diaIdx}, ${ejIdx}, 'repeticiones', this.value)">
              </div>
              <div class="rf-field">
                <label class="rf-label">Peso</label>
                <input type="text" class="form-input" value="${ej.peso}" onchange="window.updateFormExercise(${diaIdx}, ${ejIdx}, 'peso', this.value)">
              </div>
            </div>

            <div class="rf-field">
              <label class="rf-label">Nota</label>
              <input type="text" class="form-input" placeholder="Opcional" value="${ej.notaProfesor || ''}" onchange="window.updateFormExercise(${diaIdx}, ${ejIdx}, 'notaProfesor', this.value)">
            </div>

            <div class="rf-field">
              <label class="rf-label">Video</label>
              <input type="url" class="form-input" data-video-input="${diaIdx}-${ejIdx}" placeholder="Se completa solo al elegir ejercicio" value="${ej.videoUrl || ''}" onchange="window.updateFormExercise(${diaIdx}, ${ejIdx}, 'videoUrl', this.value)">
            </div>
          </div>
        `).join('')}
        </div>
      </div>
    `).join('');
  }

  window.updateFormDayName = (diaIdx, val) => { currentFormDays[diaIdx].nombre = val; };
  window.addFormExercise = (diaIdx) => {
    // Si estaba tipeando a mano (sin elegir del catálogo), guardar el borrador del input activo
    try {
      const active = document.activeElement;
      if (active && active.classList && active.classList.contains('ej-nombre-input')) {
        const d = parseInt(active.getAttribute('data-dia-idx'), 10);
        const e = parseInt(active.getAttribute('data-ej-idx'), 10);
        if (!isNaN(d) && !isNaN(e) && currentFormDays[d] && currentFormDays[d].ejercicios[e]) {
          const ej = currentFormDays[d].ejercicios[e];
          if (!ej._catalogPick && active.value) {
            ej.nombre = active.value;
            ej._typingDraft = active.value;
          }
        }
      }
    } catch (_) {}
    // Bloquear commits de nombre mientras se hace blur (evita que "press" pise el nombre completo)
    window._ignoreNombreCommit = true;
    try {
      const active = document.activeElement;
      if (active && active.classList && active.classList.contains('ej-nombre-input')) {
        active.blur();
      }
    } catch (_) {}
    currentFormDays[diaIdx].ejercicios.push({ nombre: "Nuevo Ejercicio", series: 3, repeticiones: "12", peso: "10 kg", notaProfesor: "", videoUrl: "", esEntradaEnCalor: false });
    renderFormDays();
    setTimeout(() => { window._ignoreNombreCommit = false; }, 100);
  };

  window.addFormWarmupExercise = (diaIdx) => {
    window._ignoreNombreCommit = true;
    try {
      const active = document.activeElement;
      if (active && active.classList && active.classList.contains('ej-nombre-input')) {
        active.blur();
      }
    } catch (_) {}
    const ejs = currentFormDays[diaIdx].ejercicios;
    ejs.unshift({
      nombre: "Entrada en calor",
      series: 2,
      repeticiones: "12",
      peso: "S/D",
      notaProfesor: "",
      videoUrl: "",
      esEntradaEnCalor: true
    });
    renderFormDays();
    setTimeout(() => { window._ignoreNombreCommit = false; }, 100);
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
    if (!currentFormDays[diaIdx] || !currentFormDays[diaIdx].ejercicios[ejIdx]) return;
    const ej = currentFormDays[diaIdx].ejercicios[ejIdx];

    if (field === 'nombre') {
      if (window._ignoreNombreCommit) return;
      const incoming = String(val == null ? '' : val);
      const actual = String(ej.nombre || '');
      // Prefijo de un nombre ya elegido del catálogo → no pisar
      if (
        actual &&
        incoming.length < actual.length &&
        actual.toLowerCase().startsWith(incoming.toLowerCase()) &&
        (ej._catalogPick || ej.videoUrlAuto)
      ) {
        return;
      }
      if (incoming === actual) return;
      ej._catalogPick = false;
      ej._typingDraft = incoming;
      ej.nombre = incoming;
      if (!ej.videoUrl || ej.videoUrlAuto === true) {
        const videoAuto = buscarVideoPorNombreEjercicio(incoming);
        if (videoAuto) {
          ej.videoUrl = videoAuto;
          ej.videoUrlAuto = true;
        }
      }
      return;
    }

    ej[field] = val;

    if (field === 'videoUrl') {
      ej.videoUrlAuto = false;
    }
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
      ejercicios: [...d.ejercicios].sort((a, b) => (b.esEntradaEnCalor ? 1 : 0) - (a.esEntradaEnCalor ? 1 : 0)).map((e, idx) => ({
        id: crypto.randomUUID(),
        nombre: e.nombre,
        seriesTarget: Number(e.series) || 3,
        repeticionesTarget: e.repeticiones || "12",
        pesoSugerido: e.peso || "S/D",
        notaProfesor: e.notaProfesor || "",
        profesorNotaAutor: esModoAlumnoPropio ? `${usuarioActualData.nombre} (vos)` : usuarioActualData.nombre,
        videoUrl: e.videoUrl || "",
        esEntradaEnCalor: !!e.esEntradaEnCalor
      }))
    }));

    if (esModoAlumnoPropio) {
      try {
        if (appState.modalActivo === 'editar_rutina_propia' && appState.rutinaEnEdicionId) {
          const resultado = await store.editarRutinaPropia({
            rutinaId: appState.rutinaEnEdicionId,
            alumnoId: usuarioActualData.id,
            titulo,
            duracionDias: duracion,
            dias: formattedDays
          });
          if (resultado && resultado.ok) {
            alert("✅ Rutina propia actualizada correctamente.");
          } else {
            alert("❌ No se pudo guardar la rutina: " + ((resultado && resultado.error) || "error desconocido") + ". Los cambios no se aplicaron, probá de nuevo.");
          }
        } else {
          await store.crearRutinaPropia({
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

    document.getElementById('navHistorial')?.addEventListener('click', async () => {
      appState.tabCliente = 'historial';
      appState.mostrarDrawerNotifs = false;
      renderApp();
      // Re-sync para traer series completas desde Supabase
      if (appState.usuarioActual?.rol === 'alumno' && window.gymStore) {
        try {
          await window.gymStore.syncWithSupabase(appState.usuarioActual.data.id);
          renderApp();
        } catch (_) {}
      }
    });

    document.getElementById('navStats')?.addEventListener('click', async () => {
      appState.tabCliente = 'stats';
      appState.mostrarDrawerNotifs = false;
      if (appState.statsMonthOffset == null) appState.statsMonthOffset = 0;
      renderApp();
      if (appState.usuarioActual?.rol === 'alumno' && window.gymStore && window.supabaseEngine) {
        try {
          const alumnoId = appState.usuarioActual.data.id;
          await window.gymStore.syncWithSupabase(alumnoId);
          // Recargar SOLO series por id (no pisar el resto del log)
          if (typeof window.supabaseEngine.enriquecerSeriesDeLogs === 'function') {
            await window.supabaseEngine.enriquecerSeriesDeLogs(window.gymStore.data.workoutLogs);
            window.gymStore.saveData();
          }
          renderApp();
        } catch (err) {
          console.warn('Stats refresh:', err);
        }
      }
    });
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
      // Candado: evita doble toque / re-entrada mientras guarda
      if (appState.finalizandoEntrenamiento) return;
      appState.finalizandoEntrenamiento = true;

      const dia = appState.diaActivoEntrenamiento;
      const alumno = appState.usuarioActual.data;
      const rutinaActiva = store.getRutinaPorId(appState.rutinaSeleccionadaId) || store.getRutinaActiva(alumno.id);

      const setsLogArr = [];
      Object.keys(appState.workoutDraftSets).forEach(ejId => {
        const ejData = appState.workoutDraftSets[ejId];
        ejData.sets.forEach(s => {
          setsLogArr.push({
            ejercicioId:       ejId,
            ejercicioNombre:   ejData.nombre,
            setNumero:         s.setNumero,
            repsRealizadas:    s.reps,
            pesoUtilizado:     s.peso,
            comentarioAlumno:  s.comentarioSet || ''
          });
        });
      });

      if (!rutinaActiva) {
        appState.finalizandoEntrenamiento = false;
        alert('❌ No tienes una rutina activa asignada.\n\nContacta a tu profesor para que te asigne una rutina de entrenamiento.');
        renderApp();
        return;
      }

      const btn = e.currentTarget;
      if (btn) {
        btn.disabled = true;
        btn.textContent = '⏳ Guardando...';
      }

      try {
        const logGuardado = await store.guardarEntrenamientoReal({
          alumnoId:         alumno.id,
          rutinaId:         rutinaActiva.id,
          diaId:            dia.id,
          diaNombre:        dia.nombre,
          diaNumero:        dia.diaNumero || 1,
          setsLog:          setsLogArr,
          comentarioGeneral: appState.workoutGeneralComment || ''
        });

        const puntosConfirmadosPorServidor = logGuardado?.puntosConfirmadosPorServidor === true;

        if (!puntosConfirmadosPorServidor) {
          alert('⚠️ Entrenamiento guardado en tu historial, pero no se pudieron confirmar los puntos en el servidor.\n\nSi el problema persiste, contactá al profesor.');
        } else if (logGuardado?.yaHuboEntrenamientoHoy) {
          alert('🏆 ¡Entrenamiento completado y guardado en tu historial!\nYa sumaste puntos hoy con otro entrenamiento — este quedó en el historial, pero no otorga puntos adicionales (solo una vez por día).');
        } else {
          const puntosGanados = Math.round((logGuardado?.puntos || 0));
          const bonusTexto = logGuardado?.bonusRacha ? ` (incluye +${logGuardado.bonusRacha} 🔥 bonus por racha)` : '';
          alert(`🏆 ¡Entrenamiento completado y guardado en tu historial!\n+${puntosGanados} puntos ganados${bonusTexto}`);
        }

        clearWorkoutDraft();
        appState.diaActivoEntrenamiento = null;
        appState.tabCliente = 'historial';
      } catch (err) {
        console.error('Error al finalizar entrenamiento:', err);
        alert('❌ No se pudo guardar el entrenamiento: ' + ((err && err.message) || 'error desconocido'));
        if (btn) {
          btn.disabled = false;
          btn.textContent = '✅ Finalizar Entrenamiento';
        }
      } finally {
        appState.finalizandoEntrenamiento = false;
        renderApp();
      }
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

    document.getElementById('btnConfirmarBorrarEntrenamiento')?.addEventListener('click', async () => {
      const alumno = appState.usuarioActual && appState.usuarioActual.data;
      const logId = appState.logABorrarId;
      if (!alumno || !logId) {
        appState.modalActivo = null;
        appState.logABorrarId = null;
        renderApp();
        return;
      }
      const btn = document.getElementById('btnConfirmarBorrarEntrenamiento');
      if (btn) { btn.disabled = true; btn.textContent = 'Borrando…'; }
      try {
        await store.eliminarEntrenamiento({ logId, alumnoId: alumno.id });
        alert('✅ Entrenamiento borrado.');
      } catch (err) {
        alert('❌ No se pudo borrar: ' + (err.message || err));
      }
      appState.modalActivo = null;
      appState.logABorrarId = null;
      renderApp();
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
                    const idx = gymStore.data.workoutLogs.findIndex(w => String(w.id) === String(sbLog.id));
                    const remoteSets = Array.isArray(sbLog.sets) ? sbLog.sets : [];
                    if (idx >= 0) {
                      const local = gymStore.data.workoutLogs[idx];
                      const localSets = Array.isArray(local.sets) ? local.sets : [];
                      const sets = remoteSets.length > 0 ? remoteSets : localSets;
                      gymStore.data.workoutLogs[idx] = { ...local, ...sbLog, sets };
                    } else {
                      gymStore.data.workoutLogs.push(sbLog);
                    }
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