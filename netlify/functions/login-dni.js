// NETLIFY SERVERLESS FUNCTION — LOGIN POR DNI (Supabase Auth real, sin password)
// Mirror funcional de api/login-dni.js (Vercel). Ver ese archivo para el
// detalle completo del flujo comentado.
//
// Env Vars requeridas (ya configuradas en Netlify para send-push.js):
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY

exports.handler = async (event, context) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const dni = body.dni ? String(body.dni).trim() : '';

    if (!dni) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Falta dni en el cuerpo de la petición.' }) };
    }

    const supabaseUrl = process.env.SUPABASE_URL;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !serviceRoleKey) {
      return { statusCode: 500, body: JSON.stringify({ error: 'Faltan SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY.' }) };
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
      return { statusCode: 502, body: JSON.stringify({ error: 'Error consultando el perfil en Supabase.', detail: errText }) };
    }

    const perfiles = await perfilRes.json();
    const perfil = perfiles && perfiles[0];

    if (!perfil) {
      return { statusCode: 404, body: JSON.stringify({ error: 'dni_no_encontrado' }) };
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
        return { statusCode: 502, body: JSON.stringify({ error: 'No se pudo obtener el usuario de Supabase Auth vinculado.', detail: errText }) };
      }

      const userData = await getUserRes.json();
      email = userData.email || (userData.user && userData.user.email);

      if (!email) {
        console.error('Usuario de Auth sin email en la respuesta:', userData);
        return { statusCode: 500, body: JSON.stringify({ error: 'El usuario de Auth vinculado no tiene email.' }) };
      }
    } else {
      // --- 2b. Nunca vinculado: crear un usuario nuevo en Supabase Auth ---
      email = `dni_${perfil.rol}_${dni}_${Date.now()}@estudiofitness.app`;

      const createRes = await fetch(`${supabaseUrl}/auth/v1/admin/users`, {
        method: 'POST',
        headers: adminHeaders,
        body: JSON.stringify({ email, email_confirm: true })
      });

      if (!createRes.ok) {
        const errText = await createRes.text();
        console.error('Error creando usuario de Auth:', errText);
        return { statusCode: 502, body: JSON.stringify({ error: 'No se pudo crear el usuario de Supabase Auth.', detail: errText }) };
      }

      const nuevoUsuario = await createRes.json();
      authUserId = nuevoUsuario.id || (nuevoUsuario.user && nuevoUsuario.user.id);

      if (!authUserId) {
        console.error('Creación de usuario sin id en la respuesta:', nuevoUsuario);
        return { statusCode: 500, body: JSON.stringify({ error: 'La creación del usuario de Auth no devolvió un id.' }) };
      }

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
        return { statusCode: 502, body: JSON.stringify({ error: 'Se creó el usuario de Auth pero no se pudo vincular en profiles.', detail: errText }) };
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
      return { statusCode: 502, body: JSON.stringify({ error: 'No se pudo generar el link de acceso.', detail: errText }) };
    }

    const linkData = await linkRes.json();
    const hashedToken = linkData.hashed_token || (linkData.properties && linkData.properties.hashed_token);

    if (!hashedToken) {
      console.error('generate_link no devolvió hashed_token. Respuesta completa:', JSON.stringify(linkData));
      return { statusCode: 500, body: JSON.stringify({ error: 'La respuesta de Supabase no incluyó hashed_token.' }) };
    }

    return { statusCode: 200, body: JSON.stringify({ hashed_token: hashedToken }) };

  } catch (error) {
    console.error('Error general en login-dni:', error);
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }
};
