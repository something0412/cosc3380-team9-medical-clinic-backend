-- session table for logins (connect-pg-simple), so they survive restarts and work on Vercel

BEGIN;

CREATE TABLE public.session (
    sid varchar NOT NULL PRIMARY KEY,
    sess json NOT NULL,
    expire timestamp(6) NOT NULL
);

CREATE INDEX idx_session_expire ON public.session (expire);

ALTER TABLE public.session ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
    api_role text;
BEGIN
    FOR api_role IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated') LOOP
        EXECUTE format('REVOKE ALL ON public.session FROM %I', api_role);
    END LOOP;
END;
$$;

COMMIT;
