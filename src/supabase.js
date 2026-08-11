// ESTUDIO FITNESS - SUPABASE REALTIME & BACKEND CLIENT ENGINE

// Configuración por defecto o mediante variables globales/entorno
const SUPABASE_CONFIG = {
  url: window.ENV_SUPABASE_URL || 'https://estudio-fitness.supabase.co',
  anonKey: window.ENV_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.dummy_anon_key',
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
        .subscribe((status) => {
          if (status === 'SUBSCRIBED') {
            this.isRealtimeConnected = true;
            console.log("🟢 Conectado a Supabase Realtime WebSocket");
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
