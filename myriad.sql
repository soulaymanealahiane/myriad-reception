-- =====================================================================
-- MyRiad: Riad Safir Marrakech (CSC 3326, PostgreSQL 14 or later)
-- As database owner, run the whole file in a NEW database via pgAdmin (F5)
-- or: psql -X -v ON_ERROR_STOP=1 -d myriad -f myriad.sql
-- Like Atlas: parents, children, rules, data, and a final count check.
-- Re-running this file on an installed database stops without replacing data.
-- =====================================================================

BEGIN;
CREATE SCHEMA myriad;
CREATE SCHEMA myriad_internal;
SET LOCAL search_path TO myriad, pg_catalog;

-- ---------- 1. Parent tables ----------
CREATE TABLE guest (
    guest_id       integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    first_name     varchar(80)  NOT NULL CHECK (btrim(first_name) <> ''),
    last_name      varchar(80)  NOT NULL CHECK (btrim(last_name) <> ''),
    email          varchar(254),
    phone          varchar(40),
    nationality    varchar(80),
    id_doc_number  varchar(40)
);

CREATE TABLE room_type (
    room_type_id   integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    type_name      varchar(80) NOT NULL UNIQUE CHECK (btrim(type_name) <> ''),
    bed_config     varchar(100) NOT NULL CHECK (btrim(bed_config) <> ''),
    max_occupancy  smallint NOT NULL CHECK (max_occupancy > 0),
    has_balcony    boolean NOT NULL DEFAULT FALSE,
    description    text,
    CONSTRAINT double_room_capacity CHECK (lower(btrim(type_name)) <> 'double room' OR max_occupancy = 2)
);

-- Use the riad's business date rather than the server or browser time zone.
CREATE FUNCTION business_today() RETURNS date
LANGUAGE sql STABLE SET search_path = pg_catalog
AS $$ SELECT (CURRENT_TIMESTAMP AT TIME ZONE 'Africa/Casablanca')::date $$;

-- ---------- 2. Rooms, historical rates, and reservations ----------
CREATE TABLE room (
    room_id       integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    room_type_id  integer NOT NULL REFERENCES room_type (room_type_id)
                  ON UPDATE RESTRICT ON DELETE RESTRICT,
    room_no       varchar(12) NOT NULL UNIQUE CHECK (btrim(room_no) <> ''),
    room_name     varchar(80),
    floor_level   smallint
);

CREATE TABLE room_rate (
    room_type_id      integer REFERENCES room_type (room_type_id)
                      ON UPDATE RESTRICT ON DELETE RESTRICT,
    rate_start_date   date NOT NULL CHECK (isfinite(rate_start_date)),
    nightly_rate_mad  numeric(10,2) NOT NULL
                      CHECK (nightly_rate_mad > 0 AND nightly_rate_mad < 'Infinity'::numeric),
    PRIMARY KEY (room_type_id, rate_start_date)
);

CREATE TABLE reservation (
    res_id             integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    guest_id           integer NOT NULL REFERENCES guest (guest_id)
                       ON UPDATE RESTRICT ON DELETE RESTRICT,
    booking_date       date NOT NULL DEFAULT business_today() CHECK (isfinite(booking_date)),
    check_in_date      date NOT NULL CHECK (isfinite(check_in_date)),
    check_out_date     date NOT NULL CHECK (isfinite(check_out_date)),
    status             varchar(12) NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'confirmed', 'checked-in', 'checked-out', 'cancelled')),
    channel            varchar(60) NOT NULL CHECK (btrim(channel) <> ''),
    special_requests   text,
    CONSTRAINT reservation_stay_dates CHECK (check_out_date > check_in_date),
    CONSTRAINT booking_before_stay CHECK (booking_date <= check_in_date)
);

-- ---------- 3. M:N bridge: one allocated room per reservation ----------
CREATE TABLE room_reservation (
    res_id           integer REFERENCES reservation (res_id)
                     ON UPDATE RESTRICT ON DELETE RESTRICT,
    room_id          integer REFERENCES room (room_id)
                     ON UPDATE RESTRICT ON DELETE RESTRICT,
    num_guests       smallint NOT NULL CHECK (num_guests > 0),
    agreed_rate_mad  numeric(10,2) NOT NULL
                     CHECK (agreed_rate_mad > 0 AND agreed_rate_mad < 'Infinity'::numeric),
    PRIMARY KEY (res_id, room_id)
);

-- ---------- 4. Payments and total, disjoint specialization ----------
CREATE TABLE payment (
    payment_id      integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    res_id          integer NOT NULL REFERENCES reservation (res_id)
                    ON UPDATE RESTRICT ON DELETE RESTRICT,
    payment_date    date NOT NULL DEFAULT business_today() CHECK (isfinite(payment_date)),
    amount_mad      numeric(10,2) NOT NULL CHECK (amount_mad > 0 AND amount_mad < 'Infinity'::numeric),
    payment_method  varchar(8) NOT NULL CHECK (payment_method IN ('CARD', 'CASH', 'TRANSFER'))
);

CREATE TABLE card_payment (
    payment_id  integer PRIMARY KEY REFERENCES payment (payment_id)
                ON UPDATE RESTRICT ON DELETE RESTRICT,
    card_brand  varchar(40) NOT NULL CHECK (btrim(card_brand) <> ''),
    card_last4  varchar(4) NOT NULL CHECK (card_last4 ~ '^[0-9]{4}$'),
    auth_code   varchar(40) NOT NULL CHECK (btrim(auth_code) <> '')
);

CREATE TABLE cash_payment (
    payment_id          integer PRIMARY KEY REFERENCES payment (payment_id)
                        ON UPDATE RESTRICT ON DELETE RESTRICT,
    currency_code       varchar(3) NOT NULL CHECK (currency_code IN ('MAD', 'EUR')),
    amount_in_currency  numeric(10,2) NOT NULL
                        CHECK (amount_in_currency > 0 AND amount_in_currency < 'Infinity'::numeric),
    receipt_no          varchar(40) NOT NULL CHECK (btrim(receipt_no) <> '')
);

CREATE TABLE transfer_payment (
    payment_id    integer PRIMARY KEY REFERENCES payment (payment_id)
                  ON UPDATE RESTRICT ON DELETE RESTRICT,
    bank_name     varchar(80) NOT NULL CHECK (btrim(bank_name) <> ''),
    transfer_ref  varchar(80) NOT NULL CHECK (btrim(transfer_ref) <> '')
);

CREATE INDEX room_by_type ON room (room_type_id);
CREATE INDEX reservation_by_guest ON reservation (guest_id);
CREATE INDEX reservation_confirmed_arrivals ON reservation (check_in_date) WHERE status = 'confirmed';
CREATE INDEX allocation_by_room ON room_reservation (room_id, res_id);
CREATE INDEX payment_by_reservation ON payment (res_id);

-- ---------- 5. Reusable calculations ----------
CREATE FUNCTION rate_for_date(p_room_type_id integer, p_date date) RETURNS numeric
LANGUAGE sql STABLE SET search_path = myriad, pg_catalog AS $$
    SELECT nightly_rate_mad
    FROM room_rate
    WHERE room_type_id = p_room_type_id AND rate_start_date <= p_date
    ORDER BY rate_start_date DESC
    LIMIT 1
$$;

-- Group each 1:M branch first. Joining raw room and payment rows would fan out both totals.
CREATE VIEW reservation_financials AS
WITH room_charges AS (
    SELECT res_id, COUNT(*)::integer AS room_count, SUM(agreed_rate_mad) AS per_night
    FROM room_reservation GROUP BY res_id
), receipts AS (
    SELECT res_id, SUM(amount_mad) AS amount_paid_mad FROM payment GROUP BY res_id
), totals AS (
    SELECT r.res_id, r.check_out_date - r.check_in_date AS nights,
           COALESCE(c.room_count, 0) AS room_count,
           (r.check_out_date - r.check_in_date) * COALESCE(c.per_night, 0) AS charge_mad,
           COALESCE(p.amount_paid_mad, 0) AS paid_mad
    FROM reservation r
    LEFT JOIN room_charges c USING (res_id)
    LEFT JOIN receipts p USING (res_id)
)
SELECT totals.*, CEIL(charge_mad * 30) / 100 AS deposit_required_mad,
       GREATEST(charge_mad - paid_mad, 0) AS balance_due_mad,
       GREATEST(paid_mad - charge_mad, 0) AS credit_mad
FROM totals;

-- ---------- 6. Transactional business rules ----------
-- A technical one-row write gate serializes this small riad's writes, including
-- direct SQL. Its UPDATE also makes stale repeatable-read transactions retry.
-- Reads never acquire this lock. All 10 business tables remain in myriad.
CREATE TABLE myriad_internal.write_gate (
    singleton boolean PRIMARY KEY CHECK (singleton)
);
INSERT INTO myriad_internal.write_gate VALUES (TRUE);

CREATE FUNCTION myriad_internal.lock_writes() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
    UPDATE myriad_internal.write_gate SET singleton = TRUE WHERE singleton;
    RETURN NULL;
END
$$;

CREATE FUNCTION myriad_internal.reject_write() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
    RAISE EXCEPTION '% is disabled for % to preserve booking and payment history.',
        TG_OP, TG_TABLE_NAME USING ERRCODE = '23514';
END
$$;

DO $$
DECLARE
    table_name text;
BEGIN
    FOREACH table_name IN ARRAY ARRAY[
        'guest', 'room_type', 'room', 'room_rate', 'reservation', 'room_reservation',
        'payment', 'card_payment', 'cash_payment', 'transfer_payment'
    ] LOOP
        EXECUTE format('CREATE TRIGGER a_lock_writes BEFORE INSERT OR UPDATE OR DELETE ON myriad.%I
                        FOR EACH STATEMENT EXECUTE FUNCTION myriad_internal.lock_writes()', table_name);
        EXECUTE format('CREATE TRIGGER protect_truncate BEFORE TRUNCATE ON myriad.%I
                        FOR EACH STATEMENT EXECUTE FUNCTION myriad_internal.reject_write()', table_name);
    END LOOP;

    FOREACH table_name IN ARRAY ARRAY['room_rate', 'payment', 'card_payment', 'cash_payment', 'transfer_payment'] LOOP
        EXECUTE format('CREATE TRIGGER keep_history BEFORE UPDATE OR DELETE ON myriad.%I
                        FOR EACH ROW EXECUTE FUNCTION myriad_internal.reject_write()', table_name);
    END LOOP;
END
$$;

CREATE FUNCTION guard_reservation() RETURNS trigger
LANGUAGE plpgsql SET search_path = myriad, pg_catalog AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.status <> 'pending' THEN
            RAISE EXCEPTION 'A reservation starts as pending.' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
    END IF;

    IF NEW.booking_date IS DISTINCT FROM OLD.booking_date THEN
        RAISE EXCEPTION 'The original booking date is fixed.' USING ERRCODE = '23514';
    END IF;
    IF OLD.status <> 'pending' AND ROW(NEW.guest_id, NEW.check_in_date, NEW.check_out_date)
        IS DISTINCT FROM ROW(OLD.guest_id, OLD.check_in_date, OLD.check_out_date) THEN
        RAISE EXCEPTION 'Lead guest and stay dates can only change on a pending reservation.'
            USING ERRCODE = '23514';
    END IF;

    IF NEW.status IS DISTINCT FROM OLD.status THEN
        IF NOT (
            (OLD.status = 'pending' AND NEW.status IN ('confirmed', 'cancelled')) OR
            (OLD.status = 'confirmed' AND NEW.status IN ('checked-in', 'cancelled')) OR
            (OLD.status = 'checked-in' AND NEW.status = 'checked-out')
        ) THEN
            RAISE EXCEPTION 'A reservation cannot move from % to %.', OLD.status, NEW.status
                USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NEW;
END
$$;

CREATE FUNCTION guard_room_category() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
    IF NEW.room_type_id IS DISTINCT FROM OLD.room_type_id THEN
        RAISE EXCEPTION 'A physical room keeps its room type.' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END
$$;

CREATE TRIGGER fixed_room_category BEFORE UPDATE ON room
FOR EACH ROW EXECUTE FUNCTION guard_room_category();

CREATE FUNCTION guard_allocation() RETURNS trigger
LANGUAGE plpgsql SET search_path = myriad, pg_catalog AS $$
DECLARE
    booking reservation%ROWTYPE;
    catalogue_rate numeric;
BEGIN
    IF TG_OP = 'UPDATE' AND ROW(OLD.res_id, OLD.room_id, OLD.agreed_rate_mad)
        IS DISTINCT FROM ROW(NEW.res_id, NEW.room_id, NEW.agreed_rate_mad) THEN
        RAISE EXCEPTION 'Allocation keys and agreed nightly prices are fixed.'
            USING ERRCODE = '23514';
    END IF;

    SELECT * INTO booking FROM reservation
    WHERE res_id = CASE WHEN TG_OP = 'DELETE' THEN OLD.res_id ELSE NEW.res_id END;

    IF booking.status IS DISTINCT FROM 'pending' THEN
        RAISE EXCEPTION 'Room allocations can only change on a pending reservation.'
            USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;

    IF TG_OP = 'INSERT' THEN
        SELECT rate_for_date(r.room_type_id, booking.booking_date) INTO catalogue_rate
        FROM room r WHERE r.room_id = NEW.room_id;
        IF catalogue_rate IS NULL THEN
            RAISE EXCEPTION 'Room % has no rate effective on the booking date.', NEW.room_id
                USING ERRCODE = '23514';
        END IF;
        IF NEW.agreed_rate_mad IS NOT NULL AND NEW.agreed_rate_mad IS DISTINCT FROM catalogue_rate THEN
            RAISE EXCEPTION 'The agreed rate must equal the room rate on the booking date.'
                USING ERRCODE = '23514';
        END IF;
        NEW.agreed_rate_mad := catalogue_rate;
    END IF;
    RETURN NEW;
END
$$;

CREATE TRIGGER price_and_protect_allocation BEFORE INSERT OR UPDATE OR DELETE ON room_reservation
FOR EACH ROW EXECUTE FUNCTION guard_allocation();

CREATE FUNCTION guard_payment() RETURNS trigger
LANGUAGE plpgsql SET search_path = myriad, pg_catalog AS $$
DECLARE
    booking reservation%ROWTYPE;
BEGIN
    SELECT * INTO booking FROM reservation WHERE res_id = NEW.res_id;
    IF booking.status IN ('cancelled', 'checked-out') THEN
        RAISE EXCEPTION 'Payments are closed for % reservations.', booking.status
            USING ERRCODE = '23514';
    END IF;
    IF NEW.payment_date < booking.booking_date OR NEW.payment_date > business_today() THEN
        RAISE EXCEPTION 'Payment date must be between the booking date and today.'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END
$$;

CREATE TRIGGER keep_payment_date BEFORE INSERT ON payment
FOR EACH ROW EXECUTE FUNCTION guard_payment();

CREATE FUNCTION assert_reservation(p_res_id integer, p_status varchar) RETURNS void
LANGUAGE plpgsql SET search_path = myriad, pg_catalog AS $$
DECLARE
    finance reservation_financials%ROWTYPE;
    conflicting_room varchar;
BEGIN
    SELECT * INTO finance FROM reservation_financials WHERE res_id = p_res_id;
    IF NOT FOUND THEN
        RETURN;
    END IF;
    IF finance.room_count = 0 THEN
        RAISE EXCEPTION 'Reservation % requires at least one room.', p_res_id USING ERRCODE = '23514';
    END IF;

    IF p_status IN ('confirmed', 'checked-in') THEN
        SELECT physical.room_no INTO conflicting_room
        FROM room_reservation chosen
        JOIN reservation stay ON stay.res_id = chosen.res_id
        JOIN room physical ON physical.room_id = chosen.room_id
        JOIN room_reservation other ON other.room_id = chosen.room_id AND other.res_id <> chosen.res_id
        JOIN reservation occupied ON occupied.res_id = other.res_id
        WHERE chosen.res_id = p_res_id
          AND occupied.status IN ('confirmed', 'checked-in')
          AND occupied.check_in_date < stay.check_out_date
          AND occupied.check_out_date > stay.check_in_date
        ORDER BY physical.room_no
        LIMIT 1;

        IF FOUND THEN
            RAISE EXCEPTION 'Room % is held by an overlapping reservation.', conflicting_room
                USING ERRCODE = '23P01';
        END IF;
        IF finance.paid_mad < finance.deposit_required_mad THEN
            RAISE EXCEPTION 'Confirmation requires a deposit of % MAD. Received: % MAD.',
                round(finance.deposit_required_mad, 2), round(finance.paid_mad, 2)
                USING ERRCODE = '23514';
        END IF;
    END IF;

    IF p_status IN ('checked-in', 'checked-out') AND finance.balance_due_mad > 0 THEN
        RAISE EXCEPTION 'Collect the outstanding % MAD before check-in.',
            round(finance.balance_due_mad, 2) USING ERRCODE = '23514';
    END IF;
END
$$;

CREATE TRIGGER guard_reservation_lifecycle BEFORE INSERT OR UPDATE ON reservation
FOR EACH ROW EXECUTE FUNCTION guard_reservation();
CREATE TRIGGER keep_reservation_history BEFORE DELETE ON reservation
FOR EACH ROW EXECUTE FUNCTION myriad_internal.reject_write();

CREATE FUNCTION validate_status_transition() RETURNS trigger
LANGUAGE plpgsql SET search_path = myriad, pg_catalog AS $$
BEGIN
    -- Check the after-image now as well as at commit, so confirmation
    -- cannot run before the room allocations and deposit exist.
    PERFORM assert_reservation(NEW.res_id, NEW.status);
    RETURN NULL;
END
$$;

CREATE TRIGGER validate_status_transition AFTER UPDATE ON reservation
FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
EXECUTE FUNCTION validate_status_transition();

CREATE FUNCTION validate_reservation() RETURNS trigger
LANGUAGE plpgsql SET search_path = myriad, pg_catalog AS $$
DECLARE
    booking_id integer;
    current_status varchar;
BEGIN
    booking_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.res_id ELSE NEW.res_id END;
    SELECT status INTO current_status FROM reservation WHERE res_id = booking_id;
    PERFORM assert_reservation(booking_id, current_status);
    RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER reservation_at_least_one_room AFTER INSERT OR UPDATE ON reservation
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_reservation();
CREATE CONSTRAINT TRIGGER allocation_keeps_reservation_valid AFTER INSERT OR UPDATE OR DELETE ON room_reservation
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_reservation();

CREATE FUNCTION validate_room_type() RETURNS trigger
LANGUAGE plpgsql SET search_path = myriad, pg_catalog AS $$
DECLARE
    type_id integer;
    capacity smallint;
BEGIN
    type_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.room_type_id ELSE NEW.room_type_id END;
    SELECT max_occupancy INTO capacity FROM room_type WHERE room_type_id = type_id;
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    IF NOT EXISTS (SELECT FROM room WHERE room_type_id = type_id) THEN
        RAISE EXCEPTION 'Room type % requires at least one physical room.', type_id USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (SELECT FROM room_rate WHERE room_type_id = type_id) THEN
        RAISE EXCEPTION 'Room type % requires at least one rate.', type_id USING ERRCODE = '23514';
    END IF;
    IF EXISTS (
        SELECT FROM room_reservation allocation JOIN room r USING (room_id)
        WHERE r.room_type_id = type_id AND allocation.num_guests > capacity
    ) THEN
        RAISE EXCEPTION 'The guest count exceeds the room type capacity of %.', capacity USING ERRCODE = '23514';
    END IF;
    IF TG_TABLE_NAME = 'room_rate' AND EXISTS (
        SELECT FROM room_reservation allocation
        JOIN reservation stay USING (res_id)
        JOIN room r USING (room_id)
        WHERE r.room_type_id = type_id
          AND allocation.agreed_rate_mad IS DISTINCT FROM rate_for_date(type_id, stay.booking_date)
    ) THEN
        RAISE EXCEPTION 'This rate would change the effective rate of an existing booking.'
            USING ERRCODE = '23514';
    END IF;
    RETURN NULL;
END
$$;

CREATE FUNCTION validate_allocation_capacity() RETURNS trigger
LANGUAGE plpgsql SET search_path = myriad, pg_catalog AS $$
DECLARE
    capacity smallint;
    occupants smallint;
BEGIN
    SELECT rt.max_occupancy, allocation.num_guests INTO capacity, occupants
    FROM room_reservation allocation JOIN room r USING (room_id) JOIN room_type rt USING (room_type_id)
    WHERE allocation.res_id = NEW.res_id AND allocation.room_id = NEW.room_id;
    IF occupants > capacity THEN
        RAISE EXCEPTION 'The guest count exceeds the room type capacity of %.', capacity USING ERRCODE = '23514';
    END IF;
    RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER room_type_required_children AFTER INSERT OR UPDATE ON room_type
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_room_type();
CREATE CONSTRAINT TRIGGER room_type_keeps_room AFTER INSERT OR DELETE ON room
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_room_type();
CREATE CONSTRAINT TRIGGER room_type_keeps_rate AFTER INSERT ON room_rate
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_room_type();
CREATE CONSTRAINT TRIGGER room_allocation_capacity AFTER INSERT OR UPDATE ON room_reservation
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_allocation_capacity();

CREATE FUNCTION validate_payment_subtype() RETURNS trigger
LANGUAGE plpgsql SET search_path = myriad, pg_catalog AS $$
DECLARE
    receipt record;
BEGIN
    SELECT p.amount_mad, p.payment_method, c.payment_id IS NOT NULL AS card,
           k.payment_id IS NOT NULL AS cash, t.payment_id IS NOT NULL AS transfer,
           k.currency_code, k.amount_in_currency
    INTO receipt
    FROM payment p
    LEFT JOIN card_payment c USING (payment_id)
    LEFT JOIN cash_payment k USING (payment_id)
    LEFT JOIN transfer_payment t USING (payment_id)
    WHERE p.payment_id = NEW.payment_id;

    IF receipt.card IS DISTINCT FROM (receipt.payment_method = 'CARD')
       OR receipt.cash IS DISTINCT FROM (receipt.payment_method = 'CASH')
       OR receipt.transfer IS DISTINCT FROM (receipt.payment_method = 'TRANSFER') THEN
        RAISE EXCEPTION 'Payment % must have exactly one matching method record.', NEW.payment_id
            USING ERRCODE = '23514';
    END IF;
    IF receipt.cash AND receipt.currency_code = 'MAD' AND receipt.amount_in_currency <> receipt.amount_mad THEN
        RAISE EXCEPTION 'For MAD cash, the original and booked amounts must match.'
            USING ERRCODE = '23514';
    END IF;
    RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER payment_requires_subtype AFTER INSERT ON payment
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_payment_subtype();
CREATE CONSTRAINT TRIGGER payment_card_matches AFTER INSERT ON card_payment
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_payment_subtype();
CREATE CONSTRAINT TRIGGER payment_cash_matches AFTER INSERT ON cash_payment
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_payment_subtype();
CREATE CONSTRAINT TRIGGER payment_transfer_matches AFTER INSERT ON transfer_payment
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_payment_subtype();

-- ---------- 7. Reception operations ----------
CREATE FUNCTION create_reservation(
    p_guest_id integer, p_check_in date, p_check_out date, p_channel text,
    p_special_requests text, p_rooms jsonb, p_booking_date date DEFAULT business_today()
) RETURNS integer LANGUAGE plpgsql SET search_path = myriad, pg_catalog AS $$
DECLARE
    booking_id integer;
BEGIN
    IF jsonb_typeof(p_rooms) IS DISTINCT FROM 'array' OR p_rooms = '[]'::jsonb THEN
        RAISE EXCEPTION 'Add at least one room.' USING ERRCODE = '23514';
    END IF;

    INSERT INTO reservation (guest_id, booking_date, check_in_date, check_out_date, channel, special_requests)
    VALUES (p_guest_id, p_booking_date, p_check_in, p_check_out, p_channel, p_special_requests)
    RETURNING res_id INTO booking_id;

    INSERT INTO room_reservation (res_id, room_id, num_guests)
    SELECT booking_id, rooms.room_id, rooms.num_guests
    FROM jsonb_to_recordset(p_rooms) AS rooms(room_id integer, num_guests smallint);
    RETURN booking_id;
END
$$;

CREATE FUNCTION record_payment(
    p_res_id integer, p_payment_date date, p_amount_mad numeric, p_method text, p_details jsonb
) RETURNS integer LANGUAGE plpgsql SET search_path = myriad, pg_catalog AS $$
DECLARE
    new_payment_id integer;
BEGIN
    INSERT INTO payment (res_id, payment_date, amount_mad, payment_method)
    VALUES (p_res_id, p_payment_date, p_amount_mad, p_method)
    RETURNING payment_id INTO new_payment_id;

    CASE p_method
        WHEN 'CARD' THEN
            INSERT INTO card_payment (payment_id, card_brand, card_last4, auth_code)
            VALUES (new_payment_id, p_details->>'card_brand', p_details->>'card_last4', p_details->>'auth_code');
        WHEN 'CASH' THEN
            INSERT INTO cash_payment (payment_id, currency_code, amount_in_currency, receipt_no)
            VALUES (new_payment_id, p_details->>'currency_code',
                    (p_details->>'amount_in_currency')::numeric, p_details->>'receipt_no');
        WHEN 'TRANSFER' THEN
            INSERT INTO transfer_payment (payment_id, bank_name, transfer_ref)
            VALUES (new_payment_id, p_details->>'bank_name', p_details->>'transfer_ref');
    END CASE;
    RETURN new_payment_id;
END
$$;

CREATE FUNCTION set_reservation_status(p_res_id integer, p_status varchar) RETURNS varchar
LANGUAGE plpgsql SET search_path = myriad, pg_catalog AS $$
DECLARE
    updated_status varchar;
BEGIN
    UPDATE reservation SET status = p_status WHERE res_id = p_res_id
    RETURNING status INTO updated_status;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Reservation % was not found.', p_res_id USING ERRCODE = 'P0002';
    END IF;
    RETURN updated_status;
END
$$;

CREATE FUNCTION add_room_type(
    p_name text, p_beds text, p_capacity smallint, p_balcony boolean, p_description text,
    p_room_no text, p_room_name text, p_floor smallint, p_rate_start date, p_rate numeric
) RETURNS integer LANGUAGE plpgsql SET search_path = myriad, pg_catalog AS $$
DECLARE
    new_type_id integer;
BEGIN
    INSERT INTO room_type (type_name, bed_config, max_occupancy, has_balcony, description)
    VALUES (p_name, p_beds, p_capacity, p_balcony, p_description)
    RETURNING room_type_id INTO new_type_id;
    INSERT INTO room (room_type_id, room_no, room_name, floor_level)
    VALUES (new_type_id, p_room_no, p_room_name, p_floor);
    INSERT INTO room_rate (room_type_id, rate_start_date, nightly_rate_mad)
    VALUES (new_type_id, p_rate_start, p_rate);
    RETURN new_type_id;
END
$$;

-- ---------- 8. Reception queries ----------
CREATE FUNCTION rooms_available(p_check_in date, p_check_out date, p_type integer DEFAULT NULL)
RETURNS TABLE (
    room_id integer, room_no varchar, room_name varchar, room_type_id integer,
    type_name varchar, max_occupancy smallint, has_balcony boolean, nightly_rate_mad numeric
)
LANGUAGE plpgsql STABLE SET search_path = myriad, pg_catalog AS $$
BEGIN
    IF p_check_in IS NULL OR p_check_out IS NULL OR NOT isfinite(p_check_in)
       OR NOT isfinite(p_check_out) OR p_check_out <= p_check_in THEN
        RAISE EXCEPTION 'Choose a check-out date after check-in.' USING ERRCODE = '22023';
    END IF;
    RETURN QUERY
    SELECT r.room_id, r.room_no, r.room_name, rt.room_type_id, rt.type_name,
           rt.max_occupancy, rt.has_balcony, rate_for_date(rt.room_type_id, business_today())
    FROM room r JOIN room_type rt ON rt.room_type_id = r.room_type_id
    WHERE (p_type IS NULL OR r.room_type_id = p_type)
      AND NOT EXISTS (
          SELECT FROM room_reservation a JOIN reservation s ON s.res_id = a.res_id
          WHERE a.room_id = r.room_id
            AND s.status IN ('confirmed', 'checked-in')
            AND s.check_in_date < p_check_out AND s.check_out_date > p_check_in
      )
    ORDER BY r.room_no;
END
$$;

CREATE FUNCTION expected_arrivals(p_date date DEFAULT business_today())
RETURNS TABLE (res_id integer, guest_name text, check_in_date date, check_out_date date,
               rooms text, balance_due_mad numeric)
LANGUAGE sql STABLE SET search_path = myriad, pg_catalog AS $$
    SELECT s.res_id, concat_ws(' ', g.first_name, g.last_name), s.check_in_date, s.check_out_date,
           a.rooms, f.balance_due_mad
    FROM reservation s
    JOIN guest g USING (guest_id)
    JOIN reservation_financials f USING (res_id)
    JOIN LATERAL (
        SELECT string_agg(r.room_no || ' · ' || t.type_name, ', ' ORDER BY r.room_no) AS rooms
        FROM room_reservation allocation
        JOIN room r USING (room_id)
        JOIN room_type t USING (room_type_id)
        WHERE allocation.res_id = s.res_id
    ) a ON TRUE
    WHERE s.check_in_date = p_date AND s.status = 'confirmed'
    ORDER BY g.last_name, g.first_name, s.res_id
$$;

-- ---------- 9. Fictional reception data relative to the install date ----------
-- Room inventory, names, and transactions below are illustrative. Addresses
-- use reserved .test domains and phone and identity references are masked.
INSERT INTO room_type (type_name, bed_config, max_occupancy, has_balcony, description) VALUES
    ('Double Room', '1 double bed', 2, FALSE, 'Patio-facing rooms with tadelakt walls and a private shower.'),
    ('Twin Room', '2 single beds', 2, FALSE, 'Two single beds, carved cedar shutters, and a private shower.'),
    ('King Suite with Balcony', '1 king bed + 1 single daybed', 3, TRUE, 'Upper-floor suite with a private balcony overlooking the patio.');

INSERT INTO room (room_type_id, room_no, room_name, floor_level) VALUES
    (1, '101', 'Jasmin', 1),
    (1, '102', 'Fleur d’oranger', 1),
    (1, '103', 'Cèdre de l’Atlas', 1),
    (2, '201', 'Menthe', 2),
    (2, '202', 'Safran', 2),
    (3, '203', 'Imlil', 2),
    (3, '204', 'Terrasse du Safir', 2);

INSERT INTO room_rate (room_type_id, rate_start_date, nightly_rate_mad) VALUES
    (1, business_today() - 120, 520),
    (1, business_today() -  60, 550),
    (1, business_today() -  20, 620),
    (1, business_today() +  14, 680),
    (1, business_today() +  65, 590),
    (2, business_today() - 120, 630),
    (2, business_today() -  45, 690),
    (2, business_today() +  14, 740),
    (2, business_today() +  65, 690),
    (3, business_today() - 120, 910),
    (3, business_today() -  70, 980),
    (3, business_today() -  20, 1100),
    (3, business_today() +  14, 1250),
    (3, business_today() +  65, 1100);

INSERT INTO guest (first_name, last_name, email, phone, nationality, id_doc_number) VALUES
    ('Amine',   'Bennani',       'amine.bennani@menaramail.test',      '+212 6 61 •• •• 74', 'Moroccan',  'CIN BE••4107'),
    ('Leïla',   'Mansouri',      'leila.mansouri@rivepost.test',       '+33 6 42 •• •• 18',  'French',    'Passport 21••7462'),
    ('Sofia',   'Leroy',         's.leroy@courrierrhone.test',         '+33 7 58 •• •• 32',  'French',    'Passport 23••6018'),
    ('Nora',    'Haddad',        NULL,                               '+212 6 72 •• •• 93', 'Moroccan',  NULL),
    ('Daniel',  'Ruiz',          'daniel.ruiz@correoalba.test',        '+34 6 73 •• •• 26',  'Spanish',   'Passport PA••9054'),
    ('Maya',    'Laurent',       'maya.laurent@courrierrhone.test',    NULL,                 'French',    'Passport 20••4386'),
    ('Karim',   'El Idrissi',    'karim.elidrissi@darmail.test',       '+212 6 64 •• •• 12', 'Moroccan',  NULL),
    ('Inès',    'Dubois',        'ines.dubois@bruxcourrier.test',      '+32 4 76 •• •• 55',  'Belgian',   NULL),
    ('Youssef', 'Amrani',        NULL,                               '+212 6 70 •• •• 24', 'Moroccan',  'CIN AB••8295'),
    ('Salma',   'Aït Lahcen',    'salma.aitlahcen@menaramail.test',    '+212 6 62 •• •• 49', 'Moroccan',  'CIN HA••6517'),
    ('Hugo',    'Martin',        'hugo.martin@rivepost.test',          '+33 6 83 •• •• 71',  'French',    'Passport 19••3206'),
    ('Marta',   'Beltrán',       'marta.beltran@correoalba.test',      NULL,                 'Spanish',   'Passport PC••4761'),
    ('Rachid',  'El Fassi',      'rachid.elfassi@darmail.test',        '+212 6 65 •• •• 08', 'Moroccan',  'CIN CD••8133'),
    ('Johanna', 'Keller',        'johanna.keller@rheinpostfach.test',  '+49 151 •••• 0176',  'German',    'Passport C7••2909'),
    ('Hajar',   'Berrada',       'hajar.berrada@menaramail.test',      '+212 6 68 •• •• 52', 'Moroccan',  'CIN EE••5421'),
    ('Nabil',   'Benjelloun',    'n.benjelloun@darmail.test',          '+212 6 63 •• •• 86', 'Moroccan',  'CIN BK••1930'),
    ('Lina',    'Rodrigues',     'lina.rodrigues@caixatejo.test',      '+351 9 16 •• •• 67', 'Portuguese',NULL),
    ('Imane',   'Slaoui',        'imane.slaoui@menaramail.test',       '+212 6 77 •• •• 38', 'Moroccan',  NULL),
    ('Farid',   'Azzouzi',       NULL,                               '+212 6 75 •• •• 92', 'Moroccan',  NULL),
    ('Elena',   'Costa',         'elena.costa@postaverde.test',        '+39 3 34 •• •• 09',  'Italian',   NULL),
    ('Ghita',   'Alaoui',        'ghita.alaoui@darmail.test',          '+212 6 66 •• •• 40', 'Moroccan',  'CIN AD••4072'),
    ('Samir',   'Tazi',          NULL,                               '+212 6 69 •• •• 73', 'Moroccan',  'CIN FJ••6025'),
    ('Amina',   'Touzani',       'amina.touzani@menaramail.test',      '+212 6 78 •• •• 13', 'Moroccan',  NULL),
    ('Alejandro','Moreno',       'alejandro.moreno@correoalba.test',   NULL,                 'Spanish',   NULL);

DO $$
DECLARE
    today date := business_today();
    stay record;
    receipt record;
    booking integer;
BEGIN
    -- One row per booking. Date offsets are measured from installation day.
    FOR stay IN
        SELECT * FROM (VALUES
            (1,   1,  -9,   0,  2, 'Direct',      'Arrivée vers 16 h. Deux chambres proches si possible.',       'confirmed',
                '[{"room_id":1,"num_guests":2},{"room_id":4,"num_guests":1}]'),
            (2,   2, -12,   0,  3, 'Booking.com', 'Arrivée depuis la gare. Acompte remis par une proche.',       'confirmed',
                '[{"room_id":6,"num_guests":2}]'),
            (3,   3, -16,  -2,  0, 'Direct',      'Laisser les bagages à la réception après le départ.',         'checked-in',
                '[{"room_id":2,"num_guests":2}]'),
            (4,   4,  -1,   1,  3, 'Direct',      'Arrivée tardive après le train de Casablanca.',                'pending',
                '[{"room_id":1,"num_guests":1}]'),
            (5,   5, -10,   1,  2, 'Booking.com', 'Please send walking directions from Bab Aylan.',              'confirmed',
                '[{"room_id":3,"num_guests":2}]'),
            (6,   6, -40,  -8, -5, 'Direct',      'Chambre calme, si possible à l’écart de l’escalier.',         'checked-out',
                '[{"room_id":3,"num_guests":1}]'),
            (7,   7,  -5,   3,  6, 'Phone',       NULL,                                                         'cancelled',
                '[{"room_id":5,"num_guests":2}]'),
            (8,   8,   0,   4,  7, 'Direct',      'Une chambre twin et une suite pour la même famille.',          'pending',
                '[{"room_id":5,"num_guests":1},{"room_id":6,"num_guests":2}]'),
            (9,   9,  -3,   2,  4, 'Phone',       'Arrivée après la fermeture du souk.',                          'confirmed',
                '[{"room_id":2,"num_guests":1}]'),
            (10, 10, -42, -35,-32, 'Direct',      'Séjour en couple pour un mariage dans la médina.',             'checked-out',
                '[{"room_id":2,"num_guests":2}]'),
            (11, 11, -35, -19,-15, 'Booking.com', 'Deux lits séparés. Dépôt des valises avant l’arrivée.',        'checked-out',
                '[{"room_id":4,"num_guests":2}]'),
            (12, 12, -23, -12,-10, 'Email',       'We will be arriving from Essaouira by coach.',               'checked-out',
                '[{"room_id":6,"num_guests":2}]'),
            (13, 13, -11,  -6, -3, 'Direct',      'Regrouper les deux chambres sur la même réservation.',        'checked-out',
                '[{"room_id":1,"num_guests":2},{"room_id":5,"num_guests":1}]'),
            (14, 14, -15,  -7, -4, 'Booking.com', 'Late departure from Marrakech. Luggage storage requested.',  'checked-out',
                '[{"room_id":2,"num_guests":2}]'),
            (15, 15, -20,   5,  7, 'Phone',       'Prévenir à l’avance si le véhicule ne peut pas approcher.',   'confirmed',
                '[{"room_id":3,"num_guests":2}]'),
            (16, 16,  -3,   8, 10, 'Direct',      'Famille de cinq. Préparer le lit d’appoint de la suite.',    'confirmed',
                '[{"room_id":4,"num_guests":2},{"room_id":6,"num_guests":3}]'),
            (17, 17,  -2,  12, 15, 'Email',       'Arrival after a guided walk in the Atlas foothills.',         'confirmed',
                '[{"room_id":5,"num_guests":2}]'),
            (18, 18,  -1,  15, 18, 'Phone',       'Dates à confirmer après réservation du train.',             'pending',
                '[{"room_id":2,"num_guests":2}]'),
            (19, 19,  -6,   6,  7, 'Direct',      NULL,                                                         'cancelled',
                '[{"room_id":1,"num_guests":1}]'),
            (20, 20,   0,  20, 22, 'Booking.com', 'Can we leave our bags before a walk to the souks?',           'pending',
                '[{"room_id":6,"num_guests":2}]'),
            (21,  1, -14,  -4, -2, 'Direct',      'Un premier passage avant le séjour en famille.',             'checked-out',
                '[{"room_id":3,"num_guests":1}]'),
            (22, 21,  -7,   3,  6, 'Email',       'Séjour à deux avec lits séparés.',                            'confirmed',
                '[{"room_id":4,"num_guests":2}]'),
            (23, 22,  -2,   9, 11, 'Phone',       'Arrivée de Rabat en voiture. Demande d’indications de stationnement.', 'confirmed',
                '[{"room_id":1,"num_guests":2}]'),
            (24, 23,  -1,  10, 12, 'Direct',      NULL,                                                         'pending',
                '[{"room_id":2,"num_guests":1}]')
        ) AS stays(seed_ref, guest_id, booked, arrive, depart, channel, requests, final_status, rooms)
        ORDER BY seed_ref
    LOOP
        booking := create_reservation(stay.guest_id, today + stay.arrive, today + stay.depart,
            stay.channel, stay.requests, stay.rooms::jsonb, today + stay.booked);

        -- Receipts by booking reference. Include deposits, split settlements,
        -- MAD and EUR cash, and the three payment-method subtypes.
        FOR receipt IN
            SELECT * FROM (VALUES
                (1,  -8,  500.00, 'CARD',     '{"card_brand":"Visa","card_last4":"0142","auth_code":"681247"}'),
                (1,  -2,  400.00, 'TRANSFER', '{"bank_name":"CIH Bank","transfer_ref":"CIH-VIR-842716"}'),
                (2, -11, 1100.00, 'CASH',     '{"currency_code":"EUR","amount_in_currency":100,"receipt_no":"RS-CA-0194"}'),
                (3,  -2, 1240.00, 'CASH',     '{"currency_code":"MAD","amount_in_currency":1240,"receipt_no":"RS-CA-0211"}'),
                (5,  -4,  200.00, 'TRANSFER', '{"bank_name":"Attijariwafa bank","transfer_ref":"AWB-VIR-521486"}'),
                (6,  -8, 1650.00, 'CARD',     '{"card_brand":"Mastercard","card_last4":"5030","auth_code":"253108"}'),
                (9,  -1,  420.00, 'CARD',     '{"card_brand":"Visa","card_last4":"0673","auth_code":"721593"}'),
                (10,-40,  750.00, 'TRANSFER', '{"bank_name":"Banque Populaire","transfer_ref":"BP-VIR-236874"}'),
                (10,-35,  900.00, 'CASH',     '{"currency_code":"MAD","amount_in_currency":900,"receipt_no":"RS-CA-0158"}'),
                (11,-32,  830.00, 'CARD',     '{"card_brand":"Visa","card_last4":"2804","auth_code":"683952"}'),
                (11,-19, 1930.00, 'TRANSFER', '{"bank_name":"Crédit Agricole du Maroc","transfer_ref":"CAM-VIR-638170"}'),
                (12,-12, 1100.00, 'CASH',     '{"currency_code":"EUR","amount_in_currency":100,"receipt_no":"RS-CA-0190"}'),
                (12,-12,  860.00, 'CASH',     '{"currency_code":"MAD","amount_in_currency":860,"receipt_no":"RS-CA-0191"}'),
                (13,-10, 1600.00, 'TRANSFER', '{"bank_name":"Bank of Africa","transfer_ref":"BOA-VIR-357942"}'),
                (13, -6, 2330.00, 'CARD',     '{"card_brand":"Mastercard","card_last4":"6418","auth_code":"329071"}'),
                (14, -7, 1860.00, 'CARD',     '{"card_brand":"Visa","card_last4":"4916","auth_code":"432507"}'),
                (15,-18,  400.00, 'CARD',     '{"card_brand":"Visa","card_last4":"7382","auth_code":"864120"}'),
                (16, -2, 1100.00, 'TRANSFER', '{"bank_name":"Attijariwafa bank","transfer_ref":"AWB-VIR-624310"}'),
                (17, -1,  660.00, 'CASH',     '{"currency_code":"EUR","amount_in_currency":60,"receipt_no":"RS-CA-0217"}'),
                (18,  0,  200.00, 'CASH',     '{"currency_code":"MAD","amount_in_currency":200,"receipt_no":"RS-CA-0220"}'),
                (21,-11,  620.00, 'CARD',     '{"card_brand":"Visa","card_last4":"0142","auth_code":"531887"}'),
                (21, -4,  620.00, 'CASH',     '{"currency_code":"MAD","amount_in_currency":620,"receipt_no":"RS-CA-0206"}'),
                (22, -6,  715.00, 'TRANSFER', '{"bank_name":"CIH Bank","transfer_ref":"CIH-VIR-786143"}'),
                (23, -1,  450.00, 'CASH',     '{"currency_code":"MAD","amount_in_currency":450,"receipt_no":"RS-CA-0218"}')
            ) AS receipts(seed_ref, paid_offset, amount_mad, method, details)
            WHERE receipts.seed_ref = stay.seed_ref
            ORDER BY paid_offset, method, amount_mad DESC
        LOOP
            PERFORM record_payment(booking, today + receipt.paid_offset, receipt.amount_mad,
                receipt.method, receipt.details::jsonb);
        END LOOP;

        IF stay.final_status IN ('confirmed', 'checked-in', 'checked-out') THEN
            PERFORM set_reservation_status(booking, 'confirmed');
        END IF;
        IF stay.final_status IN ('checked-in', 'checked-out') THEN
            PERFORM set_reservation_status(booking, 'checked-in');
        END IF;
        IF stay.final_status IN ('checked-out', 'cancelled') THEN
            PERFORM set_reservation_status(booking, stay.final_status);
        END IF;
    END LOOP;
END
$$;

-- Save the search path in this database so new Query Tool tabs can use short
-- table names. Quote the database name to support names such as "MyRiad".
DO $$
BEGIN
    EXECUTE format('ALTER DATABASE %I SET search_path TO myriad, public', current_database());
END
$$;

COMMIT;

-- Make short names work in the connection that ran the installer too.
SET search_path TO myriad, public;

-- ---------- 10. Quick check: one row per business table ----------
SELECT 'guest' AS table_name, COUNT(*) AS row_count FROM guest
UNION ALL SELECT 'room_type', COUNT(*) FROM room_type
UNION ALL SELECT 'room', COUNT(*) FROM room
UNION ALL SELECT 'room_rate', COUNT(*) FROM room_rate
UNION ALL SELECT 'reservation', COUNT(*) FROM reservation
UNION ALL SELECT 'room_reservation', COUNT(*) FROM room_reservation
UNION ALL SELECT 'payment', COUNT(*) FROM payment
UNION ALL SELECT 'card_payment', COUNT(*) FROM card_payment
UNION ALL SELECT 'cash_payment', COUNT(*) FROM cash_payment
UNION ALL SELECT 'transfer_payment', COUNT(*) FROM transfer_payment;

-- Try these in pgAdmin or psql after installation:
-- SELECT * FROM payment;
-- SELECT * FROM rooms_available(business_today(), business_today() + 2);
-- SELECT * FROM expected_arrivals();
-- SELECT * FROM reservation_financials WHERE res_id = 1;
