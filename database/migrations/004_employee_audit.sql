-- Employee audit: a trigger records changes to an employee's active status,
-- employee type, and office. One row per changed field.

BEGIN;

-- no foreign key, so the audit stays even if an employee is ever deleted
CREATE TABLE IF NOT EXISTS public.employee_audit (
    audit_id integer GENERATED ALWAYS AS IDENTITY,
    employee_id integer NOT NULL,
    field_name character varying(20) NOT NULL,
    old_value character varying(20),
    new_value character varying(20),
    changed_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT employee_audit_pkey PRIMARY KEY (audit_id),
    CONSTRAINT chk_employee_audit_field CHECK (((field_name)::text = ANY ((ARRAY['is_active'::character varying, 'employee_type_id'::character varying, 'office_id'::character varying])::text[])))
);

CREATE INDEX IF NOT EXISTS idx_employee_audit_employee ON public.employee_audit (employee_id, changed_at);

-- like every other table, so Supabase's public API roles can't read or change it
ALTER TABLE public.employee_audit ENABLE ROW LEVEL SECURITY;

-- Supabase also grants those roles access to new tables, so take it back.
-- The loop skips roles that only exist on Supabase.
DO $$
DECLARE
    api_role text;
BEGIN
    FOR api_role IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated') LOOP
        EXECUTE format('REVOKE ALL ON public.employee_audit FROM %I', api_role);
    END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.record_employee_changes() RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
    IF OLD.is_active IS DISTINCT FROM NEW.is_active THEN
        INSERT INTO public.employee_audit (employee_id, field_name, old_value, new_value)
        VALUES (NEW.employee_id, 'is_active', OLD.is_active::text, NEW.is_active::text);
    END IF;

    IF OLD.employee_type_id IS DISTINCT FROM NEW.employee_type_id THEN
        INSERT INTO public.employee_audit (employee_id, field_name, old_value, new_value)
        VALUES (NEW.employee_id, 'employee_type_id', OLD.employee_type_id::text, NEW.employee_type_id::text);
    END IF;

    IF OLD.office_id IS DISTINCT FROM NEW.office_id THEN
        INSERT INTO public.employee_audit (employee_id, field_name, old_value, new_value)
        VALUES (NEW.employee_id, 'office_id', OLD.office_id::text, NEW.office_id::text);
    END IF;

    RETURN NULL;
END;
$$;

CREATE OR REPLACE TRIGGER employee_audit_trigger
    AFTER UPDATE OF is_active, employee_type_id, office_id ON public.employee
    FOR EACH ROW EXECUTE FUNCTION public.record_employee_changes();

COMMIT;
