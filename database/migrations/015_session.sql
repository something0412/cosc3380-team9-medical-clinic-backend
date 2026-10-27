-- logins (sessions) saved in the database instead of the server's memory,
-- so they survive restarts and work when Vercel runs several copies of the backend
-- the columns are the ones connect-pg-simple expects
-- waiting for review, so it hasn't been run on Supabase yet

BEGIN;

CREATE TABLE public.session (
    sid varchar NOT NULL PRIMARY KEY,
    sess json NOT NULL,
    expire timestamp(6) NOT NULL
);

-- expired logins are found and deleted by this column
CREATE INDEX idx_session_expire ON public.session (expire);

-- like every other table, so Supabase's public API roles can't read or change it
ALTER TABLE public.session ENABLE ROW LEVEL SECURITY;

-- Supabase also grants those roles access to new tables, so take it back.
-- The loop skips roles that only exist on Supabase.
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
