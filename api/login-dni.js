// VERCEL SERVERLESS FUNCTION — LOGIN POR DNI (Supabase Auth real, sin password)
//
// Flujo:
//   1. Busca profiles por dni (service_role, bypassa RLS).
//   2. Si profiles.auth_user_id existe → lo usa tal cual (NO se toca).
//      Si es NULL → crea un usuario en Supabase Auth (sin password) y lo
//      guarda en profiles.auth_user_id (primera vez que ese DNI entra).
//      No modifica profiles.id ni ninguna otra columna/FK.
//   3. Pide a Supabase Auth Admin un magic link para ese usuario
//      (auth/v1/admin/generate_link) — NO envía ningún email real, solo
//      devuelve el token — y lo pasa al frontend.
//   4. El frontend canjea ese hashed_token por una sesión REAL con
//      supabase.auth.verifyOtp({ token_hash, type: 'magiclink' }).
//
// No fabrica JWT manualmente, no usa SUPABASE_JWT_SECRET.
// El rol NUNCA se decide acá — profiles.rol es la única fuente de verdad,
// y el frontend lo consulta después de autenticarse.
//
// Env Vars requeridas (ya configuradas en Vercel para send-push.js):
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const body = req.body || (typeof req.body === 'string' ? JSON.parse(req.body) : {});
    const dni = body.dni ? String(body.dni).trim() : '';

    if (!dni) {
      return res.status(400).json({ error: 'Falta dni en el cuerpo de la petición.' });
    }

    const supabaseUrl = process.env.SUPABASE_URL;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !serviceRoleKey) {
      return res.status(500).json({ error: 'Faltan SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY.' });
    }

    const adminHeaders = {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      'Content-Type': 'application/json'
    };

    // --- 1. Buscar el perfil por DNI ---
    const perfilRes = await fetch(
      `${supabaseUrl}/rest/v1/profiles?dni=eq.${encodeURIComponent(dni)}&select=id,rol,auth_user_id`,
      { headers: adminHeaders }
    );

    if (!perfilRes.ok) {
      const errText = await perfilRes.text();
      console.error('Error consultando profiles:', errText);
      return res.status(502).json({ error: 'Error consultando el perfil en Supabase.', detail: errText });
    }

    const perfiles = await perfilRes.json();
    const perfil = perfiles && perfiles[0];

    if (!perfil) {
      return res.status(404).json({ error: 'dni_no_encontrado' });
    }

    let authUserId = perfil.auth_user_id || null;
    let email;

    if (authUserId) {
      // --- 2a. Ya vinculado: obtener el email real del usuario existente ---
      const getUserRes = await fetch(
        `${supabaseUrl}/auth/v1/admin/users/${authUserId}`,
        { headers: adminHeaders }
      );

      if (!getUserRes.ok) {
        const errText = await getUserRes.text();
        console.error('Error obteniendo usuario de Auth existente:', errText);
        return res.status(502).json({ error: 'No se pudo obtener el usuario de Supabase Auth vinculado.', detail: errText });
      }

      const userData = await getUserRes.json();
      email = userData.email || (userData.user && userData.user.email);

      if (!email) {
        console.error('Usuario de Auth sin email en la respuesta:', userData);
        return res.status(500).json({ error: 'El usuario de Auth vinculado no tiene email.' });
      }
    } else {
      // --- 2b. Nunca vinculado: crear un usuario nuevo en Supabase Auth ---
      // Email puramente técnico (nunca se muestra, nunca decide el rol).
      // Sufijo con timestamp para no chocar con ningún email viejo huérfano.
      email = `dni_${perfil.rol}_${dni}_${Date.now()}@estudiofitness.app`;

      const createRes = await fetch(`${supabaseUrl}/auth/v1/admin/users`, {
        method: 'POST',
        headers: adminHeaders,
        body: JSON.stringify({ email, email_confirm: true })
      });

      if (!createRes.ok) {
        const errText = await createRes.text();
        console.error('Error creando usuario de Auth:', errText);
        return res.status(502).json({ error: 'No se pudo crear el usuario de Supabase Auth.', detail: errText });
      }

      const nuevoUsuario = await createRes.json();
      authUserId = nuevoUsuario.id || (nuevoUsuario.user && nuevoUsuario.user.id);

      if (!authUserId) {
        console.error('Creación de usuario sin id en la respuesta:', nuevoUsuario);
        return res.status(500).json({ error: 'La creación del usuario de Auth no devolvió un id.' });
      }

      // --- Guardar el vínculo. Solo toca profiles.auth_user_id. ---
      const patchRes = await fetch(
        `${supabaseUrl}/rest/v1/profiles?id=eq.${perfil.id}`,
        {
          method: 'PATCH',
          headers: { ...adminHeaders, Prefer: 'return=minimal' },
          body: JSON.stringify({ auth_user_id: authUserId })
        }
      );

      if (!patchRes.ok) {
        const errText = await patchRes.text();
        console.error('Error guardando auth_user_id en profiles:', errText);
        return res.status(502).json({ error: 'Se creó el usuario de Auth pero no se pudo vincular en profiles.', detail: errText });
      }
    }

    // --- 3. Generar el magic link (NO envía email, solo devuelve el token) ---
    const linkRes = await fetch(`${supabaseUrl}/auth/v1/admin/generate_link`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ type: 'magiclink', email })
    });

    if (!linkRes.ok) {
      const errText = await linkRes.text();
      console.error('Error generando magic link:', errText);
      return res.status(502).json({ error: 'No se pudo generar el link de acceso.', detail: errText });
    }

    const linkData = await linkRes.json();
    // El nombre exacto del campo puede variar según capa (REST cruda vs
    // wrapper). Se intentan ambas rutas conocidas y se loguea la respuesta
    // completa si ninguna aparece, para poder ajustar sin adivinar.
    const hashedToken = linkData.hashed_token || (linkData.properties && linkData.properties.hashed_token);

    if (!hashedToken) {
      console.error('generate_link no devolvió hashed_token. Respuesta completa:', JSON.stringify(linkData));
      return res.status(500).json({ error: 'La respuesta de Supabase no incluyó hashed_token.' });
    }

    return res.status(200).json({ hashed_token: hashedToken });

  } catch (error) {
    console.error('Error general en login-dni:', error);
    return res.status(500).json({ error: error.message });
  }
};
