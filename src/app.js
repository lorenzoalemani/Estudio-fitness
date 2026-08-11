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
    workoutDraftSets: {} // Estado temporal del entrenamiento en progreso por serie
  };

  // Escuchar cambios de Supabase Realtime / Local Store
  window.addEventListener('gym_store_updated', () => {
    if (appState.usuarioActual && appState.usuarioActual.rol === 'alumno') {
      const alumnoActualizado = store.getAlumnoPorId(appState.usuarioActual.data.id);
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

    // Verificar si la cuenta está pendiente de autorización por el profesor
    if (alumno.estadoAutorizacion === 'pendiente') {
      appContainer.innerHTML = `
        ${renderHeader()}
        <main class="client-dashboard" style="max-width:500px; margin:40px auto">
          <div class="routine-banner" style="flex-direction:column; text-align:center; border-color:var(--yellow-warning)">
            <span class="badge badge-warning" style="font-size:1rem; padding:8px 16px">⚠️ CUENTA PENDIENTE DE AUTORIZACIÓN</span>
            <h2 style="margin-top:12px">Hola, ${alumno.nombre}</h2>
            <p style="color:var(--text-gray); font-size:0.92rem; margin-top:8px">
              Tu DNI (<strong>${alumno.dni}</strong>) aún no ha sido autorizado en el gimnasio por el profesor. 
              Por favor solicita a tu profesor de Estudio Fitness que te registre para acceder a tus rutinas.
            </p>
          </div>
        </main>
      `;
      bindHeaderEvents();
      return;
    }

    const rutinas = store.getRutinasAlumno(alumno.id);
    const historialEntrenamientos = store.getHistorialEntrenamientosReales(alumno.id);

    appContainer.innerHTML = `
      ${renderHeader()}

      <main class="client-dashboard">
        <div class="tabs-container" style="max-width:500px; margin:0 auto 20px">
          <button class="tab-btn ${appState.tabCliente === 'rutina' ? 'active' : ''}" id="tabRutina">🏋️ Mis Rutinas (${rutinas.length})</button>
          <button class="tab-btn ${appState.tabCliente === 'historial' ? 'active' : ''}" id="tabHistorial">📜 Historial Real (${historialEntrenamientos.length})</button>
        </div>

        ${appState.tabCliente === 'rutina' ? (
          appState.diaActivoEntrenamiento ? renderWorkoutSession() : (
            appState.diaSeleccionadoId ? renderDayDetailView(alumno) : (
              appState.rutinaSeleccionadaId ? renderRoutineDaysView(alumno) : renderRoutinesListView(alumno)
            )
          )
        ) : ''}

        ${appState.tabCliente === 'historial' ? renderHistorialRealAlumno(historialEntrenamientos) : ''}
      </main>
    `;

    bindHeaderEvents();

    document.getElementById('tabRutina')?.addEventListener('click', () => {
      appState.tabCliente = 'rutina';
      appState.diaActivoEntrenamiento = null;
      renderApp();
    });

    document.getElementById('tabHistorial')?.addEventListener('click', () => {
      appState.tabCliente = 'historial';
      renderApp();
    });

    // Eventos de navegación por tarjetas de rutina
    document.querySelectorAll('.routine-select-card').forEach(card => {
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

  function renderHistorialRealAlumno(historialLogs) {
    if (!historialLogs || historialLogs.length === 0) {
      return `<div style="text-align:center; color:var(--text-gray); padding:40px">Aún no has completado entrenamientos con este sistema.</div>`;
    }

    return `
      <div style="max-width:800px; margin:0 auto">
        <h3 style="margin-bottom:16px">📜 Registros de Entrenamientos Completados</h3>
        ${historialLogs.map(log => `
          <div class="history-item-card">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px">
              <div>
                <strong style="font-size:1.1rem; color:var(--green-active)">✓ ${log.diaNombre}</strong>
                <div style="font-size:0.8rem; color:var(--text-gray)">Fecha: ${new Date(log.fecha).toLocaleString()}</div>
              </div>
              <span class="badge badge-active">Completado</span>
            </div>

            ${log.comentarioGeneral ? `
              <div style="background:rgba(255,46,46,0.08); border-left:3px solid var(--red-primary); padding:8px 12px; border-radius:0 6px 6px 0; margin-bottom:10px; font-size:0.85rem">
                💬 <strong>Comentario General:</strong> "${log.comentarioGeneral}"
              </div>
            ` : ''}

            <div style="border-top:1px solid var(--border-color); padding-top:10px">
              ${log.sets.map(s => `
                <div style="font-size:0.85rem; margin-bottom:6px; background:rgba(0,0,0,0.3); padding:6px 10px; border-radius:6px">
                  <strong>${s.ejercicioNombre}</strong> — Serie ${s.setNumero}: <strong>${s.repsRealizadas} reps</strong> con <strong>${s.pesoUtilizado}</strong>
                  ${s.comentarioAlumno ? `<div style="color:var(--yellow-warning); font-size:0.8rem; margin-top:2px">💬 Serie: "${s.comentarioAlumno}"</div>` : ''}
                </div>
              `).join('')}
            </div>
          </div>
        `).join('')}
      </div>
    `;
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
    `;

    bindHeaderEvents();

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
      card.addEventListener('click', (e) => {
        const alumnoId = card.dataset.alumnoId;
        if (e.target.classList.contains('btn-historial-click')) {
          e.stopPropagation();
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
    const alumno = store.getAlumnoPorId(appState.alumnoSeleccionadoId);
    const esEdicion = modo === 'editar_rutina';
    const rutinaExistente = esEdicion ? store.getRutinaPorId(appState.rutinaEnEdicionId) : null;

    return `
      <div class="modal-overlay">
        <div class="modal-content">
          <div class="modal-header">
            <h3>${esEdicion ? '✏️ Editar Rutina' : '📝 Asignar Nueva Rutina'} — ${alumno ? alumno.nombre : ''}</h3>
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
                ${esEdicion ? '💾 Guardar Cambios en Rutina' : '🚀 Asignar Nueva Rutina'}
              </button>
            </div>
          </form>
        </div>
      </div>
    `;
  }

  function renderModalHistorialAlumno() {
    const alumno = store.getAlumnoPorId(appState.alumnoSeleccionadoId);
    const historialLogs = store.getHistorialEntrenamientosReales(alumno.id);

    return `
      <div class="modal-overlay">
        <div class="modal-content">
          <div class="modal-header">
            <h3>📜 Historial Real de Entrenamientos: ${alumno.nombre}</h3>
            <button class="close-btn" id="btnCloseModal">&times;</button>
          </div>
          ${renderHistorialRealAlumno(historialLogs)}
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
          { nombre: "Press Plano con Barra", series: 4, repeticiones: "10-12", peso: "60 kg", notaProfesor: "Controlar bajada" }
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
          notaProfesor: e.notaProfesor || ""
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
        ejercicios: [{ nombre: "Nuevo Ejercicio", series: 3, repeticiones: "12", peso: "10 kg", notaProfesor: "" }]
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
          </div>
        `).join('')}
      </div>
    `).join('');
  }

  window.updateFormDayName = (diaIdx, val) => { currentFormDays[diaIdx].nombre = val; };
  window.addFormExercise = (diaIdx) => {
    currentFormDays[diaIdx].ejercicios.push({ nombre: "Nuevo Ejercicio", series: 3, repeticiones: "12", peso: "10 kg", notaProfesor: "" });
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
    const profActual = appState.usuarioActual.data;

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
        profesorNotaAutor: profActual.nombre
      }))
    }));

    if (appState.modalActivo === 'editar_rutina' && appState.rutinaEnEdicionId) {
      store.editarRutinaExistente({
        rutinaId: appState.rutinaEnEdicionId,
        profesorNombre: profActual.nombre,
        titulo,
        duracionDias: duracion,
        dias: formattedDays
      });
      alert("✅ Rutina actualizada correctamente. El alumno recibirá una notificación con los cambios.");
    } else {
      store.crearOActualizarRutina({
        alumnoId: appState.alumnoSeleccionadoId,
        profesorNombre: profActual.nombre,
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

    document.getElementById('btnNotifBell')?.addEventListener('click', () => {
      appState.mostrarDrawerNotifs = !appState.mostrarDrawerNotifs;
      if (appState.usuarioActual) {
        store.marcarNotificacionesLeidas(
          appState.usuarioActual.rol,
          appState.usuarioActual.rol === 'alumno' ? appState.usuarioActual.data.id : null
        );
      }
      renderApp();
    });

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
            ejercicioNombre: ejData.nombre,
            setNumero: s.setNumero,
            repsRealizadas: s.reps,
            pesoUtilizado: s.peso,
            comentarioAlumno: s.comentarioSet || ''
          });
        });
      });

      store.guardarEntrenamientoReal({
        alumnoId: alumno.id,
        rutinaId: rutinaActiva ? rutinaActiva.id : 'rut-default',
        diaId: dia.id,
        diaNombre: dia.nombre,
        setsLog: setsLogArr,
        comentarioGeneral: appState.workoutGeneralComment || ''
      });

      alert("🏆 ¡Entrenamiento completado y guardado en tu historial!");
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
          body.classList.toggle('open');
        }
      });
    });
  }

  renderApp();
});
