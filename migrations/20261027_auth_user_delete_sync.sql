-- A conta de acesso vive em public.usuarios e a identidade de auditoria
-- em distrilog.users. A exclusão da credencial NÃO pode apagar o usuário
-- operacional referenciado por históricos, cartões e movimentos.
-- Reconciliar usuários excluídos antes desta instalação.
CREATE OR REPLACE FUNCTION distrilog.archive_user_on_auth_removal()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
    IF TG_OP = 'DELETE'
       OR (TG_OP = 'UPDATE' AND OLD.usuario IS DISTINCT FROM NEW.usuario) THEN
        UPDATE distrilog.users AS operator
           SET is_active = FALSE,
               session_revoked_after_ns = GREATEST(
                   operator.session_revoked_after_ns,
                   (EXTRACT(EPOCH FROM clock_timestamp()) * 1000000000)::bigint
               )
         WHERE operator.username = OLD.usuario
           AND operator.is_active IS TRUE;
    END IF;
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_distrilog_auth_removed ON public.usuarios;
CREATE TRIGGER trg_distrilog_auth_removed
AFTER DELETE OR UPDATE OF usuario ON public.usuarios
FOR EACH ROW
EXECUTE FUNCTION distrilog.archive_user_on_auth_removal();

-- Migração da situação legada: desative todas as identidades sem
-- credencial (não exclua as referências nem tente adivinhar uma senha).
UPDATE distrilog.users AS operator
SET is_active = FALSE,
    session_revoked_after_ns = GREATEST(
        operator.session_revoked_after_ns,
        (EXTRACT(EPOCH FROM clock_timestamp()) * 1000000000)::bigint
    )
WHERE operator.is_active IS TRUE
  AND NOT EXISTS (
      SELECT 1 FROM public.usuarios AS credentials
      WHERE credentials.usuario = operator.username
  );
