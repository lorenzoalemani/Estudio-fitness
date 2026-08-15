// LÓGICA DE APLICACIÓN v4 - ESTUDIO FITNESS (WORKOUT LOGGER & WEB PUSH REAL)

document.addEventListener('DOMContentLoaded', () => {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js')
      .then(reg => console.log('✅ Service Worker PWA activo'))
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
    mostrarDrawerNotifs: false,
    workoutDraftSets: {},       // Estado temporal del entrenamiento en progreso por serie
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
            <span class="badge ${isProfesor ? 'badge-warning' : 'badge-active'}">
              ${isProfesor ? '⚡' : '👤'} ${user.nombre}
            </span>
          ` : ''}

          ${appState.usuarioActual ? `
            ${!pushConcedido ? `
              <button class="btn btn-secondary btn-sm" id="btnEnablePush" style="border-color:var(--yellow-warning); color:var(--yellow-warning)">
                🔔 Activar Push
              </button>
            ` : ''}

            <button class="btn btn-secondary btn-icon" id="btnNotifBell" title="Notificaciones" style="position:relative">
              🔔
              ${unreadCount > 0 ? `<span style="position:absolute; top:-4px; right:-4px; background:var(--red-primary); color:#fff; border-radius:50%; width:18px; height:18px; font-size:0.7rem; font-weight:800; display:flex; align-items:center; justify-content:center">${unreadCount}</span>` : ''}
            </button>
            <button class="btn btn-secondary btn-sm" id="btnLogout">Salir 🚪</button>
          ` : ''}
        </div>
      </header>

      ${appState.mostrarDrawerNotifs ? renderNotifDrawer(notifs) : ''}
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
        <p class="login-subtitle">Ingreso único por DNI y Contraseña</p>

        <form id="formLoginUnico">
          <div class="form-group">
            <label class="form-label" for="inputDni">Número de DNI</label>
            <input type="text" id="inputDni" class="form-input" placeholder="Ingresa tu DNI" required autofocus>
          </div>

          <div class="form-group">
            <label class="form-label" for="inputPass">Contraseña</label>
            <input type="password" id="inputPass" class="form-input" placeholder="Tu Contraseña" required>
          </div>

          <button type="submit" class="btn btn-primary" style="width:100%">Iniciar Sesión 🚀</button>
        </form>

        <div style="margin-top:16px; border-top:1px solid var(--border-color); padding-top:14px">
          <button class="btn btn-secondary btn-sm" id="btnToggleRegister" style="width:100%">¿Eres alumno nuevo? Crear Cuenta 👤</button>
        </div>

        <div class="demo-hints">
          <div style="font-weight:800; color:#fff; margin-bottom:6px">🔐 Credenciales de prueba:</div>
          <div>👤 <strong>Juan (Alumno Autorizado):</strong> DNI <code>12345678</code> | Pass: <code>123</code></div>
          <div>⚠️ <strong>Lucas (Vence 24h):</strong> DNI <code>11223344</code> | Pass: <code>123</code></div>
          <div>⚡ <strong>Prof. Carlos:</strong> DNI <code>99001122</code> | Pass: <code>123</code></div>
          <div>⚡ <strong>Prof. Franco:</strong> DNI <code>88001122</code> | Pass: <code>123</code></div>
        </div>
      </div>
    `;

    document.getElementById('formLoginUnico').addEventListener('submit', (e) => {
      e.preventDefault();
      const dni = document.getElementById('inputDni').value;
      const pass = document.getElementById('inputPass').value;

      const res = store.login(dni, pass);
      if (res) {
        appState.usuarioActual = res;

        if (res.rol === 'alumno' && res.data && res.data.id) {
          // --- SESIÓN ALUMNO ---
          window._sessionAlumnoId = res.data.id;
          window._sessionProfesorId = null;
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
        } else {
          window._sessionAlumnoId = null;
          window._sessionProfesorId = null;
        }

        appState.historialProfesorLogs = null; // limpiar caché al cambiar de sesión
        renderApp();
      } else {
        alert("❌ DNI o Contraseña incorrectos. Verifica tus datos.");
      }

    });

    document.getElementById('btnToggleRegister')?.addEventListener('click', () => {
      renderRegisterScreen();
    });
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
            <label class="form-label">Contraseña deseada *</label>
            <input type="password" id="regPass" class="form-input" placeholder="Crea tu clave" required>
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

    document.getElementById('btnBackToLogin')?.addEventListener('click', () => renderLoginScreen());

    document.getElementById('formRegisterAlumno')?.addEventListener('submit', (e) => {
      e.preventDefault();
      try {
        const dni = document.getElementById('regDni').value;
        const pass = document.getElementById('regPass').value;
        const nombre = document.getElementById('regNombre').value;
        const tel = document.getElementById('regTel').value;

        const alumno = store.registrarseAlumno({ dni, password: pass, nombre, telefono: tel });
        appState.usuarioActual = { rol: 'alumno', data: alumno };
        renderApp();
      } catch (err) {
        alert("❌ Error: " + err.message);
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

        ${appState.tabCliente === 'rutina' ? (
          appState.diaActivoEntrenamiento ? renderWorkoutSession() : (
            appState.diaSeleccionadoId ? renderDayDetailView(alumno) : (
              appState.rutinaSeleccionadaId ? renderRoutineDaysView(alumno) : renderRoutinesListView(alumno)
            )
          )
        ) : ''}

        ${appState.tabCliente === 'mis_rutinas' ? renderMisRutinasView(alumno) : ''}
        ${appState.tabCliente === 'ranking' ? renderRankingView() : ''}
        ${appState.tabCliente === 'historial' ? renderHistorialAgrupado(historialEntrenamientos, store.data.rutinas) : ''}
      </main>

      ${(appState.modalActivo === 'crear_rutina_propia' || appState.modalActivo === 'editar_rutina_propia') ? renderModalFormularioRutina(appState.modalActivo) : ''}

      ${renderBottomNav()}
    `;

    bindHeaderEvents();
    bindBottomNavEvents();
    bindMisRutinasEvents(alumno);

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

        // Reutiliza el mismo flujo de días/ejercicios/entrenamiento que las rutinas asignadas
        appState.rutinaSeleccionadaId = rId;
        appState.diaSeleccionadoId = null;
        appState.tabCliente = 'rutina';
        renderApp();
      });
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
      <button class="nav-breadcrumb-btn" id="btnBackToRoutines">⬅️ Volver a Mis Rutinas</button>

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
    }
  };

  window.updateGeneralComment = (val) => {
    appState.workoutGeneralComment = val;
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
  function renderHistorialAgrupado(logs, rutinas) {
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
                          <span class="badge badge-active">Completado</span>
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
                    <div style="font-size:1.15rem; font-weight:800">${alumno.nombre}</div>
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
                  ${rutinasAlumno.length > 0 ? rutinasAlumno.map(r => `
                    <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid rgba(255,255,255,0.06); padding:6px 0">
                      <div>
                        <div style="color:#fff; font-weight:700">💪 ${r.titulo}</div>
                        <div style="font-size:0.72rem; color:var(--text-muted)">Vence: ${r.fechaVencimiento} | ${r.dias ? r.dias.length : 0} días</div>
                      </div>
                      <button class="btn btn-secondary btn-sm btn-editar-rutina-click" data-alumno-id="${alumno.id}" data-rutina-id="${r.id}" style="border-color:var(--yellow-warning); color:var(--yellow-warning); padding:4px 10px; font-size:0.78rem">✏️ Editar</button>
                    </div>
                  `).join('') : `
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

      ${renderBottomNav()}
    `;

    bindHeaderEvents();
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

  function saveRoutineFromForm() {
    const titulo = document.getElementById('routineTitle').value;
    const duracion = document.getElementById('routineDuration').value;
    const usuarioActualData = appState.usuarioActual.data;
    const esModoAlumnoPropio = appState.modalActivo === 'crear_rutina_propia' || appState.modalActivo === 'editar_rutina_propia';

    const formattedDays = currentFormDays.map((d, dIdx) => ({
      id: "dia-" + Date.now() + "-" + dIdx,
      diaNumero: dIdx + 1,
      nombre: d.nombre,
      ejercicios: d.ejercicios.map((e, idx) => ({
        id: "ej-" + Date.now() + "-" + idx,
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
      store.editarRutinaExistente({
        rutinaId: appState.rutinaEnEdicionId,
        profesorNombre: usuarioActualData.nombre,
        titulo,
        duracionDias: duracion,
        dias: formattedDays
      });
      alert("✅ Rutina actualizada correctamente. El alumno recibirá una notificación con los cambios.");
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
      appState.mostrarDrawerNotifs = false;
      renderApp();
    });

    document.getElementById('navRanking')?.addEventListener('click', () => {
      appState.tabCliente = 'ranking';
      appState.mostrarDrawerNotifs = false;
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
    document.getElementById('btnLogout')?.addEventListener('click', () => {
      appState.usuarioActual = null;
      renderApp();
    });

    document.getElementById('btnHeaderHome')?.addEventListener('click', () => renderApp());

    document.getElementById('btnEnablePush')?.addEventListener('click', () => {
      if ('Notification' in window) {
        Notification.requestPermission().then(permission => {
          if (permission === 'granted') {
            if ('serviceWorker' in navigator && window.supabaseEngine) {
              navigator.serviceWorker.ready.then(async reg => {
                try {
                  let sub = await reg.pushManager.getSubscription();
                  if (!sub) {
                    const vapidKey = window.ENV_VAPID_PUBLIC_KEY || 'BEl62iUYgUivxIkv69yViEuiBIa-m9GYv50D2nE85-dummy-public-key';
                    sub = await reg.pushManager.subscribe({
                      userVisibleOnly: true,
                      applicationServerKey: urlBase64ToUint8Array(vapidKey)
                    });
                  }
                  if (sub && appState.usuarioActual) {
                    await window.supabaseEngine.registerPushSubscription(appState.usuarioActual.data.id, sub.toJSON());
                    alert("🔔 Suscripción Web Push activa y vinculada a tu cuenta correctamente.");
                  }
                } catch (e) {
                  console.warn("⚠️ Permiso concedido pero hubo una observación en la suscripción Web Push:", e);
                  alert("🔔 Notificaciones activadas en el navegador.");
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

    document.getElementById('btnNotifBell')?.addEventListener('click', toggleNotifDrawer);

    document.getElementById('btnCloseNotifs')?.addEventListener('click', () => {
      appState.mostrarDrawerNotifs = false;
      renderApp();
    });

    document.getElementById('btnCancelWorkout')?.addEventListener('click', () => {
      if (confirm("¿Deseas cancelar la sesión de entrenamiento actual?")) {
        appState.diaActivoEntrenamiento = null;
        renderApp();
      }
    });

    document.getElementById('btnFinishWorkout')?.addEventListener('click', () => {
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

      const logGuardado = store.guardarEntrenamientoReal({
        alumnoId:         alumno.id,
        rutinaId:         rutinaActiva ? rutinaActiva.id : 'rut-default',
        diaId:            dia.id,
        diaNombre:        dia.nombre,
        diaNumero:        dia.diaNumero || 1,    // número real del día en la rutina
        setsLog:          setsLogArr,
        comentarioGeneral: appState.workoutGeneralComment || ''
      });

      const puntosGanados = Math.round((logGuardado?.puntos || 0));
      const bonusTexto = logGuardado?.bonusRacha ? ` (incluye +${logGuardado.bonusRacha} 🔥 bonus por racha semanal)` : '';
      alert(`🏆 ¡Entrenamiento completado y guardado en tu historial!\n+${puntosGanados} puntos ganados${bonusTexto}`);
      appState.diaActivoEntrenamiento = null;
      appState.tabCliente = 'historial';
      renderApp();
    });

    document.getElementById('btnCloseModal')?.addEventListener('click', () => { appState.modalActivo = null; renderApp(); });
    document.getElementById('btnCancelModal')?.addEventListener('click', () => { appState.modalActivo = null; renderApp(); });

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
      formRutina.addEventListener('submit', (e) => {
        e.preventDefault();
        saveRoutineFromForm();
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

  renderApp();
});