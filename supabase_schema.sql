-- ====================================================================
-- ESTUDIO FITNESS - SCHEMA DEFINITIVO CORREGIDO Y BLINDADO SUPABASE
-- ====================================================================

-- 0. LIMPIEZA DE TABLAS, POLICIES Y TRIGGERS PREVIOS
DROP TRIGGER IF EXISTS tr_protect_profile_fields ON profiles;
DROP TRIGGER IF EXISTS tr_check_profile_authorization ON profiles;
DROP TRIGGER IF EXISTS tr_authorize_existing_profiles ON authorized_dnis;
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;

DROP TABLE IF EXISTS push_subscriptions CASCADE;
DROP TABLE IF EXISTS notifications CASCADE;
DROP TABLE IF EXISTS workout_log_sets CASCADE;
DROP TABLE IF EXISTS workout_logs CASCADE;
DROP TABLE IF EXISTS exercise_goals CASCADE;
DROP TABLE IF EXISTS routine_days CASCADE;
DROP TABLE IF EXISTS routines CASCADE;
DROP TABLE IF EXISTS profiles CASCADE;
DROP TABLE IF EXISTS authorized_dnis CASCADE;

-- 1. TABLA DE DNI AUTORIZADOS POR EL GIMNASIO (Solo modificable por Profesores)
CREATE TABLE authorized_dnis (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dni TEXT UNIQUE NOT NULL,
  nombre TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. TABLA DE PERFILES (VINCULADA A auth.users DE SUPABASE AUTH)
CREATE TABLE profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  dni TEXT UNIQUE NOT NULL,
  nombre TEXT NOT NULL,
  telefono TEXT,
  rol TEXT NOT NULL CHECK (rol IN ('profesor', 'alumno')),
  estado_autorizacion TEXT NOT NULL DEFAULT 'pendiente' CHECK (estado_autorizacion IN ('autorizado', 'pendiente')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. TABLA DE RUTINAS (CON FK REAL DE PROFESOR Y ALUMNO)
CREATE TABLE routines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  alumno_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  profesor_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
  profesor_creador_nombre TEXT NOT NULL,
  titulo TEXT NOT NULL,
  duracion_dias INT NOT NULL DEFAULT 30,
  fecha_inicio DATE NOT NULL DEFAULT CURRENT_DATE,
  fecha_vencimiento DATE NOT NULL,
  estado TEXT NOT NULL DEFAULT 'activa' CHECK (estado IN ('activa', 'completada', 'expirada')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. TABLA DE DÍAS DE ENTRENAMIENTO
CREATE TABLE routine_days (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  routine_id UUID NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
  dia_numero INT NOT NULL,
  nombre TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 5. TABLA DE EJERCICIOS (OBJETIVO DEL PROFESOR)
CREATE TABLE exercise_goals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  day_id UUID NOT NULL REFERENCES routine_days(id) ON DELETE CASCADE,
  orden INT NOT NULL DEFAULT 1,
  nombre TEXT NOT NULL,
  series_target INT NOT NULL DEFAULT 3,
  repeticiones_target TEXT NOT NULL DEFAULT '12',
  peso_sugerido TEXT NOT NULL DEFAULT 'S/D',
  nota_profesor TEXT,
  profesor_nota_autor TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 6. TABLA DE REGISTROS DE ENTRENAMIENTO (RESULTADO REAL ALUMNO)
CREATE TABLE workout_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  alumno_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  routine_id UUID NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
  dia_numero INT NOT NULL DEFAULT 1,
  dia_nombre TEXT NOT NULL,
  comentario_general TEXT,
  estado TEXT NOT NULL DEFAULT 'completado' CHECK (estado IN ('en_progreso', 'completado')),
  fecha_entrenamiento TIMESTAMPTZ DEFAULT NOW()
);

-- 7. TABLA DE SERIES REGISTRADAS REALES POR EJERCICIO
CREATE TABLE workout_log_sets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workout_log_id UUID NOT NULL REFERENCES workout_logs(id) ON DELETE CASCADE,
  exercise_goal_id UUID REFERENCES exercise_goals(id) ON DELETE SET NULL,
  exercise_nombre TEXT NOT NULL,
  set_numero INT NOT NULL,
  reps_realizadas INT NOT NULL,
  peso_utilizado TEXT NOT NULL,
  comentario_alumno TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 8. TABLA DE NOTIFICACIONES
CREATE TABLE notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  destinatario_rol TEXT NOT NULL CHECK (destinatario_rol IN ('profesor', 'alumno')),
  alumno_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
  mensaje TEXT NOT NULL,
  ruta_destino TEXT DEFAULT 'rutina',
  leido BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 9. TABLA DE SUSCRIPCIONES WEB PUSH (MULTIDISPOSITIVO POR USUARIO)
CREATE TABLE push_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  subscription_json JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT unique_user_subscription UNIQUE(user_id, subscription_json)
);

-- ====================================================================
-- ÍNDICES PARA ALTO RENDIMIENTO
-- ====================================================================
CREATE INDEX idx_profiles_dni ON profiles(dni);
CREATE INDEX idx_routines_alumno ON routines(alumno_id);
CREATE INDEX idx_routines_profesor ON routines(profesor_id);
CREATE INDEX idx_routines_estado ON routines(estado);
CREATE INDEX idx_routine_days_routine ON routine_days(routine_id);
CREATE INDEX idx_exercise_goals_day ON exercise_goals(day_id);
CREATE INDEX idx_workout_logs_alumno ON workout_logs(alumno_id);
CREATE INDEX idx_workout_log_sets_log ON workout_log_sets(workout_log_id);
CREATE INDEX idx_notifications_alumno ON notifications(alumno_id);
CREATE INDEX idx_push_subs_user ON push_subscriptions(user_id);

-- ====================================================================
-- FUNCIONES HELPER RLS BLINDADAS
-- ====================================================================
CREATE OR REPLACE FUNCTION is_profesor()
RETURNS BOOLEAN AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM public.profiles 
    WHERE id = auth.uid() AND rol = 'profesor'
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION is_alumno_autorizado()
RETURNS BOOLEAN AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM public.profiles 
    WHERE id = auth.uid() AND rol = 'alumno' AND estado_autorizacion = 'autorizado'
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ====================================================================
-- TRIGGERS DE PROTECCIÓN INMUTABLE DE PERFILES Y DNI AUTORIZACIÓN
-- ====================================================================

-- Trigger de protección inmutable: Impide modificar rol, estado_autorizacion o id desde UPDATE no autorizados
CREATE OR REPLACE FUNCTION fn_protect_profile_fields()
RETURNS TRIGGER AS $$
BEGIN
  -- Impedir alterar id
  IF NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'No está permitido modificar el ID de usuario.';
  END IF;

  -- Si NO es profesor (o si es alumno intentando alterar rol/autorizacion)
  IF NOT is_profesor() THEN
    IF NEW.rol IS DISTINCT FROM OLD.rol THEN
      RAISE EXCEPTION 'No tienes permiso para modificar tu rol de usuario.';
    END IF;
    IF NEW.estado_autorizacion IS DISTINCT FROM OLD.estado_autorizacion THEN
      RAISE EXCEPTION 'No tienes permiso para alterar el estado de autorización.';
    END IF;
  ELSE
    -- Profesores tampoco pueden autoconvertirse o promover usuarios a profesor arbitrariamente
    IF NEW.rol IS DISTINCT FROM OLD.rol THEN
      RAISE EXCEPTION 'El cambio de rol requiere intervención de administración.';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE TRIGGER tr_protect_profile_fields
BEFORE UPDATE ON profiles
FOR EACH ROW EXECUTE FUNCTION fn_protect_profile_fields();

-- Auto-autorizar perfiles si el DNI figura en authorized_dnis
CREATE OR REPLACE FUNCTION fn_check_profile_authorization()
RETURNS TRIGGER AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.authorized_dnis WHERE dni = NEW.dni) THEN
    NEW.estado_autorizacion := 'autorizado';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE TRIGGER tr_check_profile_authorization
BEFORE INSERT OR UPDATE ON profiles
FOR EACH ROW EXECUTE FUNCTION fn_check_profile_authorization();

-- Autorizar cuentas pendientes cuando un profesor inserta un DNI en authorized_dnis
CREATE OR REPLACE FUNCTION fn_authorize_existing_profiles()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE public.profiles
  SET estado_autorizacion = 'autorizado'
  WHERE dni = NEW.dni;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE TRIGGER tr_authorize_existing_profiles
AFTER INSERT ON authorized_dnis
FOR EACH ROW EXECUTE FUNCTION fn_authorize_existing_profiles();

-- ====================================================================
-- HABILITACIÓN DE ROW LEVEL SECURITY (RLS)
-- ====================================================================
ALTER TABLE authorized_dnis ENABLE ROW LEVEL SECURITY;
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE routines ENABLE ROW LEVEL SECURITY;
ALTER TABLE routine_days ENABLE ROW LEVEL SECURITY;
ALTER TABLE exercise_goals ENABLE ROW LEVEL SECURITY;
ALTER TABLE workout_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE workout_log_sets ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;

-- ====================================================================
-- POLÍTICAS RLS BLINDADAS (POLICIES)
-- ====================================================================

-- --- 1. POLICIES: authorized_dnis ---
CREATE POLICY "Profesores pueden gestionar DNI autorizados"
ON authorized_dnis FOR ALL TO authenticated
USING (is_profesor())
WITH CHECK (is_profesor());

CREATE POLICY "Alumnos pueden consultar exclusivamente su propio DNI"
ON authorized_dnis FOR SELECT TO authenticated
USING (
  dni = (SELECT dni FROM public.profiles WHERE id = auth.uid())
);

-- --- 2. POLICIES: profiles ---
CREATE POLICY "Usuarios leen su propio perfil y Profesores leen perfiles de alumnos"
ON profiles FOR SELECT TO authenticated
USING (id = auth.uid() OR is_profesor());

CREATE POLICY "Usuarios pueden insertar su propio perfil en registro"
ON profiles FOR INSERT TO authenticated
WITH CHECK (id = auth.uid());

CREATE POLICY "Usuarios actualizan sus datos y Profesores editan perfiles autorizados"
ON profiles FOR UPDATE TO authenticated
USING (id = auth.uid() OR is_profesor())
WITH CHECK (id = auth.uid() OR is_profesor());

-- --- 3. POLICIES: routines ---
CREATE POLICY "Alumnos autorizados y Profesores pueden consultar rutinas"
ON routines FOR SELECT TO authenticated
USING (
  (alumno_id = auth.uid() AND is_alumno_autorizado()) OR is_profesor()
);

CREATE POLICY "Profesores pueden gestionar rutinas"
ON routines FOR ALL TO authenticated
USING (is_profesor())
WITH CHECK (is_profesor());

-- --- 4. POLICIES: routine_days ---
CREATE POLICY "Alumnos autorizados y Profesores pueden ver dias"
ON routine_days FOR SELECT TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM routines r 
    WHERE r.id = routine_days.routine_id 
    AND ((r.alumno_id = auth.uid() AND is_alumno_autorizado()) OR is_profesor())
  )
);

CREATE POLICY "Profesores pueden gestionar dias de entrenamiento"
ON routine_days FOR ALL TO authenticated
USING (is_profesor())
WITH CHECK (is_profesor());

-- --- 5. POLICIES: exercise_goals ---
CREATE POLICY "Alumnos autorizados y Profesores pueden ver ejercicios indicados"
ON exercise_goals FOR SELECT TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM routine_days rd
    JOIN routines r ON r.id = rd.routine_id
    WHERE rd.id = exercise_goals.day_id
    AND ((r.alumno_id = auth.uid() AND is_alumno_autorizado()) OR is_profesor())
  )
);

CREATE POLICY "Profesores pueden gestionar objetivos de ejercicios"
ON exercise_goals FOR ALL TO authenticated
USING (is_profesor())
WITH CHECK (is_profesor());

-- --- 6. POLICIES: workout_logs ---
CREATE POLICY "Alumnos autorizados pueden gestionar sus registros de entrenamiento reales"
ON workout_logs FOR ALL TO authenticated
USING (alumno_id = auth.uid() AND is_alumno_autorizado())
WITH CHECK (alumno_id = auth.uid() AND is_alumno_autorizado());

CREATE POLICY "Profesores pueden consultar entrenamientos realizados"
ON workout_logs FOR SELECT TO authenticated
USING (is_profesor());

-- --- 7. POLICIES: workout_log_sets ---
CREATE POLICY "Alumnos autorizados pueden gestionar sus series reales"
ON workout_log_sets FOR ALL TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM workout_logs wl
    WHERE wl.id = workout_log_sets.workout_log_id
    AND wl.alumno_id = auth.uid()
    AND is_alumno_autorizado()
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1 FROM workout_logs wl
    WHERE wl.id = workout_log_sets.workout_log_id
    AND wl.alumno_id = auth.uid()
    AND is_alumno_autorizado()
  )
);

CREATE POLICY "Profesores pueden consultar series realizadas por alumnos"
ON workout_log_sets FOR SELECT TO authenticated
USING (is_profesor());

-- --- 8. POLICIES: notifications ---
CREATE POLICY "Usuarios leen notificaciones destinadas"
ON notifications FOR SELECT TO authenticated
USING (
  (alumno_id = auth.uid()) OR (destinatario_rol = 'profesor' AND is_profesor())
);

CREATE POLICY "Usuarios pueden marcar leidas sus notificaciones"
ON notifications FOR UPDATE TO authenticated
USING (alumno_id = auth.uid() OR is_profesor());

CREATE POLICY "Insercion de notificaciones restringida a profesores o aviso de alumno a su profesor"
ON notifications FOR INSERT TO authenticated
WITH CHECK (
  is_profesor() OR 
  (is_alumno_autorizado() AND alumno_id = auth.uid() AND destinatario_rol = 'profesor')
);

-- --- 9. POLICIES: push_subscriptions ---
CREATE POLICY "Usuarios leen y gestionan sus propias suscripciones push"
ON push_subscriptions FOR ALL TO authenticated
USING (user_id = auth.uid())
WITH CHECK (user_id = auth.uid());

CREATE POLICY "Profesores pueden leer suscripciones para envio de push"
ON push_subscriptions FOR SELECT TO authenticated
USING (is_profesor());


-- ====================================================================
-- HABILITACIÓN DE SUPABASE REALTIME
-- ====================================================================
ALTER PUBLICATION supabase_realtime ADD TABLE routines;
ALTER PUBLICATION supabase_realtime ADD TABLE routine_days;
ALTER PUBLICATION supabase_realtime ADD TABLE exercise_goals;
ALTER PUBLICATION supabase_realtime ADD TABLE workout_logs;
ALTER PUBLICATION supabase_realtime ADD TABLE workout_log_sets;
ALTER PUBLICATION supabase_realtime ADD TABLE notifications;

-- ====================================================================
-- FUNCIONES RPC: HISTORIAL DE ENTRENAMIENTOS
-- CORRECCIÓN: Error original 42883 "function pg_catalog.extract(unknown, integer)"
-- causado porque la función anterior llamaba EXTRACT() con un argumento de tipo
-- incorrecto (entero en vez de timestamp/timestamptz). Reescritura completa
-- usando subquery JSONB sin EXTRACT para evitar el problema de tipos.
-- APLICAR EN: Supabase Dashboard > SQL Editor > Pegar y ejecutar este bloque.
-- ====================================================================

CREATE OR REPLACE FUNCTION obtener_historial_alumno(p_alumno_id UUID)
RETURNS TABLE (
  id                 UUID,
  alumno_id          UUID,
  routine_id         UUID,
  dia_numero         INT,
  dia_nombre         TEXT,
  comentario_general TEXT,
  estado             TEXT,
  fecha_entrenamiento TIMESTAMPTZ,
  sets               JSONB
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Solo el propio alumno o un profesor puede consultar
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;
  IF auth.uid() <> p_alumno_id THEN
    IF NOT EXISTS (
      SELECT 1 FROM profiles WHERE id = auth.uid() AND rol = 'profesor'
    ) THEN
      RAISE EXCEPTION 'Sin autorización para ver este historial';
    END IF;
  END IF;

  RETURN QUERY
  SELECT
    wl.id,
    wl.alumno_id,
    wl.routine_id,
    wl.dia_numero,
    wl.dia_nombre,
    wl.comentario_general,
    wl.estado,
    wl.fecha_entrenamiento,
    COALESCE(
      (
        SELECT jsonb_agg(
          jsonb_build_object(
            'id',                s.id,
            'exercise_goal_id',  s.exercise_goal_id,
            'exercise_nombre',   s.exercise_nombre,
            'set_numero',        s.set_numero,
            'reps_realizadas',   s.reps_realizadas,
            'peso_utilizado',    s.peso_utilizado,
            'comentario_alumno', s.comentario_alumno
          ) ORDER BY s.set_numero
        )
        FROM workout_log_sets s
        WHERE s.workout_log_id = wl.id
      ),
      '[]'::jsonb
    ) AS sets
  FROM workout_logs wl
  WHERE wl.alumno_id = p_alumno_id
  ORDER BY wl.fecha_entrenamiento DESC;
END;
$$;

CREATE OR REPLACE FUNCTION obtener_historial_para_profesor(
  p_alumno_id   UUID,
  p_profesor_id UUID
)
RETURNS TABLE (
  id                 UUID,
  alumno_id          UUID,
  routine_id         UUID,
  dia_numero         INT,
  dia_nombre         TEXT,
  comentario_general TEXT,
  estado             TEXT,
  fecha_entrenamiento TIMESTAMPTZ,
  sets               JSONB
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;
  IF auth.uid() <> p_profesor_id THEN
    RAISE EXCEPTION 'El llamante no coincide con el profesor indicado';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = auth.uid() AND rol = 'profesor'
  ) THEN
    RAISE EXCEPTION 'Solo profesores pueden consultar historial de alumnos';
  END IF;

  RETURN QUERY
  SELECT
    wl.id,
    wl.alumno_id,
    wl.routine_id,
    wl.dia_numero,
    wl.dia_nombre,
    wl.comentario_general,
    wl.estado,
    wl.fecha_entrenamiento,
    COALESCE(
      (
        SELECT jsonb_agg(
          jsonb_build_object(
            'id',                s.id,
            'exercise_goal_id',  s.exercise_goal_id,
            'exercise_nombre',   s.exercise_nombre,
            'set_numero',        s.set_numero,
            'reps_realizadas',   s.reps_realizadas,
            'peso_utilizado',    s.peso_utilizado,
            'comentario_alumno', s.comentario_alumno
          ) ORDER BY s.set_numero
        )
        FROM workout_log_sets s
        WHERE s.workout_log_id = wl.id
      ),
      '[]'::jsonb
    ) AS sets
  FROM workout_logs wl
  WHERE wl.alumno_id = p_alumno_id
  ORDER BY wl.fecha_entrenamiento DESC;
END;
$$;
