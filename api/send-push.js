// VERCEL SERVERLESS FUNCTION FOR VAPID WEB PUSH NOTIFICATIONS
// Env Vars requeridas en Vercel / Netlify:
// - VAPID_PUBLIC_KEY
// - VAPID_PRIVATE_KEY
// - VAPID_SUBJECT (ej: 'mailto:admin@estudiofitness.com')

const webpush = require('web-push');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const { subscription, payload } = req.body || (typeof req.body === 'string' ? JSON.parse(req.body) : {});

    const vapidPublicKey = process.env.VAPID_PUBLIC_KEY;
    const vapidPrivateKey = process.env.VAPID_PRIVATE_KEY;
    const vapidSubject = process.env.VAPID_SUBJECT || 'mailto:admin@estudiofitness.com';

    if (!vapidPublicKey || !vapidPrivateKey) {
      return res.status(500).json({
        error: 'Faltan variables de entorno VAPID_PUBLIC_KEY y VAPID_PRIVATE_KEY.'
      });
    }

    webpush.setVapidDetails(
      vapidSubject,
      vapidPublicKey,
      vapidPrivateKey
    );

    await webpush.sendNotification(subscription, JSON.stringify(payload));

    return res.status(200).json({ success: true, message: 'Push enviado con éxito.' });
  } catch (error) {
    console.error('Error enviando Push Vercel:', error);
    return res.status(500).json({ error: error.message });
  }
};
