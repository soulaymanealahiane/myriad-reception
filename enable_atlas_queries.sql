-- Run as database owner in Query Tool on an already installed MyRiad database.
-- This sets the default schema search order for the current and future tabs.
-- Existing tables and records are preserved.

BEGIN;

DO $$
BEGIN
    IF pg_catalog.to_regclass('myriad.payment') IS NULL
       OR pg_catalog.to_regclass('myriad.reservation') IS NULL THEN
        RAISE EXCEPTION 'Open Query Tool on the database where MyRiad is installed.';
    END IF;

    EXECUTE pg_catalog.format(
        'ALTER DATABASE %I SET search_path TO myriad, public',
        pg_catalog.current_database()
    );
END
$$;

COMMIT;

SET search_path TO myriad, public;

SELECT current_database() AS database_name, current_schema() AS default_schema,
       to_regclass('payment') = 'myriad.payment'::regclass AS short_table_names_enabled;

-- Try: SELECT * FROM payment;
