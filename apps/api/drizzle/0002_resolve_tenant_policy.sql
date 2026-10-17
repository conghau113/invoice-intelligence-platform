-- Replaces the SECURITY DEFINER lookup from 0001.
--
-- Why: `tenants` is FORCE ROW LEVEL SECURITY, which applies to the table OWNER too. A
-- SECURITY DEFINER function runs as the owner, so with any owner that is not a superuser (managed
-- or production Postgres) the policy hid every row and the lookup returned NULL for every alias.
-- It only worked in dev because the compose POSTGRES_USER is a superuser, which bypasses RLS.
--
-- Now the lookup is an ordinary SECURITY INVOKER function that runs as invoice_app and is allowed
-- by a narrow SELECT policy: a row is visible only while `app.resolve_alias` equals its alias.
-- The exposure is unchanged (you learn the id of an alias you already know), with no elevated
-- privileges. The function clears the setting again, so it never leaks into later statements of
-- the same transaction.
DROP FUNCTION app_resolve_tenant(text);
--> statement-breakpoint
CREATE POLICY tenant_resolve ON tenants FOR SELECT
  USING (alias = NULLIF(current_setting('app.resolve_alias', true), ''));
--> statement-breakpoint
CREATE FUNCTION app_resolve_tenant(p_alias text) RETURNS uuid
  LANGUAGE plpgsql
  AS $$
DECLARE
  v_id uuid;
BEGIN
  PERFORM set_config('app.resolve_alias', p_alias, true);
  SELECT id INTO v_id FROM public.tenants WHERE alias = p_alias;
  PERFORM set_config('app.resolve_alias', '', true);
  RETURN v_id;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_resolve_tenant(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_resolve_tenant(text) TO invoice_app;
