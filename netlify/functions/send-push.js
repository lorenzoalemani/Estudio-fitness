// NETLIFY SERVERLESS FUNCTION FOR VAPID WEB PUSH NOTIFICATIONS
// Env Vars requeridas en Netlify:
// - VAPID_PUBLIC_KEY
// - VAPID_PRIVATE_KEY
// - VAPID_SUBJECT (ej: 'mailto:admin@estudiofitness.com')

const webpush = require('web-push');

exports.handler = async (event, context) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const { subscription, payload } = JSON.parse(event.body);

    const vapidPublicKey = process.env.VAPID_PUBLIC_KEY;
    const vapidPrivateKey = process.env.VAPID_PRIVATE_KEY;
    const vapidSubject = process.env.VAPID_SUBJECT || 'mailto:carlos@estudiofitness.com';

    if (!vapidPublicKey || !vapidPrivateKey) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: 'Faltan variables de entorno VAPID_PUBLIC_KEY y VAPID_PRIVATE_KEY en Netlify.' })
      };
    }

    webpush.setVapidDetails(
      vapidSubject,
      vapidPublicKey,
      vapidPrivateKey
    );

    await webpush.sendNotification(subscription, JSON.stringify(payload));

    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, message: 'Push enviado con éxito.' })
    };
  } catch (error) {
    console.error('Error enviando Push:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message })
    };
  }
};
