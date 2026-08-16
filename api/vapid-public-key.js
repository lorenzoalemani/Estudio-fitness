// VERCEL SERVERLESS FUNCTION — EXPONE LA VAPID PUBLIC KEY AL FRONTEND
//
// La VAPID public key NO es un secreto (es la mitad pública del par de
// claves VAPID), pero tampoco queremos hardcodearla ni duplicarla en el
// frontend: este endpoint la sirve en runtime desde la misma variable de
// entorno que ya usa /api/send-push.js para enviar notificaciones, así
// hay un único origen de verdad (las env vars de Vercel).
//
// Env Var requerida en Vercel (la misma que usa send-push.js):
//   VAPID_PUBLIC_KEY

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const publicKey = process.env.VAPID_PUBLIC_KEY;

  if (!publicKey) {
    return res.status(500).json({ error: 'VAPID_PUBLIC_KEY no está configurada en el servidor.' });
  }

  // Es información pública: se puede cachear sin problema.
  res.setHeader('Cache-Control', 'public, max-age=3600');
  return res.status(200).json({ publicKey });
};