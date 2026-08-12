// NETLIFY SERVERLESS FUNCTION FOR VAPID WEB PUSH NOTIFICATIONS
// Recibe { alumnoId, payload } desde el frontend.
// Consulta push_subscriptions en Supabase usando la SERVICE_ROLE key (servidor).
// Despacha el Web Push a todos los dispositivos suscritos del alumno.
//
// Env Vars requeridas en Netlify:
//   VAPID_PUBLIC_KEY
//   VAPID_PRIVATE_KEY
//   VAPID_SUBJECT             (ej: 'mailto:admin@estudiofitness.com')
//   SUPABASE_URL              (ej: 'https://fsvuuysjfnjjjbfjgxjj.supabase.co')
//   SUPABASE_SERVICE_ROLE_KEY

const webpush = require('web-push');

exports.handler = async (event, context) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const { alumnoId, payload } = JSON.parse(event.body || '{}');

    if (!alumnoId) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Falta alumnoId en el cuerpo de la petición.' })
      };
    }

    // --- Validar variables de entorno ---
    const vapidPublicKey  = process.env.VAPID_PUBLIC_KEY;
    const vapidPrivateKey = process.env.VAPID_PRIVATE_KEY;
    const vapidSubject    = process.env.VAPID_SUBJECT || 'mailto:admin@estudiofitness.com';
    const supabaseUrl     = process.env.SUPABASE_URL;
    const serviceRoleKey  = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!vapidPublicKey || !vapidPrivateKey) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: 'Faltan VAPID_PUBLIC_KEY y VAPID_PRIVATE_KEY.' })
      };
    }
    if (!supabaseUrl || !serviceRoleKey) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: 'Faltan SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY.' })
      };
    }

    // --- Consultar push_subscriptions con service_role (bypass RLS) ---
    const sbRes = await fetch(
      `${supabaseUrl}/rest/v1/push_subscriptions?user_id=eq.${alumnoId}&select=subscription_json`,
      {
        headers: {
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`,
          'Content-Type': 'application/json'
        }
      }
    );

    if (!sbRes.ok) {
      const errText = await sbRes.text();
      console.error('Error consultando push_subscriptions:', errText);
      return {
        statusCode: 502,
        body: JSON.stringify({ error: 'Error consultando suscripciones en Supabase.', detail: errText })
      };
    }

    const subscriptions = await sbRes.json();

    if (!subscriptions || subscriptions.length === 0) {
      console.log(`ℹ️ No hay suscripciones Web Push activas para alumno ${alumnoId}`);
      return {
        statusCode: 200,
        body: JSON.stringify({ success: true, message: 'Sin suscripciones activas.', sent: 0 })
      };
    }

    // --- Despachar push a cada dispositivo suscrito ---
    webpush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);

    let sent = 0;
    const errors = [];

    for (const item of subscriptions) {
      try {
        await webpush.sendNotification(
          item.subscription_json,
          JSON.stringify(payload || { title: 'Estudio Fitness', body: 'Tenés novedades.' })
        );
        sent++;
      } catch (pushErr) {
        console.error('Error enviando push a suscripción:', pushErr.message);
        errors.push(pushErr.message);
      }
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        message: `Push enviado a ${sent}/${subscriptions.length} dispositivo(s).`,
        sent,
        errors: errors.length > 0 ? errors : undefined
      })
    };

  } catch (error) {
    console.error('Error general en send-push:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message })
    };
  }
};
