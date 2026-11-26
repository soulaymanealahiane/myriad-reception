import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import pg from 'pg';

if (!process.env.MYRIAD_TEST_DATABASE_URL) {
  throw new Error('Set MYRIAD_TEST_DATABASE_URL to a disposable database initialized with myriad.sql.');
}
const pool = new pg.Pool({
  connectionString: process.env.MYRIAD_TEST_DATABASE_URL,
  statement_timeout: 5000,
});
after(() => pool.end());

async function inTransaction(operation) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    return await operation(client);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

async function rejectsSql(operation, code, message) {
  await assert.rejects(inTransaction(async (client) => {
    await operation(client);
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');
  }), (error) => {
    assert.equal(error.code, code);
    if (message) assert.match(error.message, message);
    return true;
  });
}

async function booking(client, room, guests = 1, offset = 22) {
  const { rows: [result] } = await client.query(`
    SELECT myriad.create_reservation(1, myriad.business_today() + $1::integer,
      myriad.business_today() + $1::integer + 1, 'Test', NULL, $2::jsonb) AS id`,
  [offset, JSON.stringify([{ room_id: room, num_guests: guests }])]);
  return result.id;
}

function receive(client, resId, amount) {
  return client.query(`SELECT myriad.record_payment($1, myriad.business_today(), $2, 'CASH',
    jsonb_build_object('currency_code', 'MAD', 'amount_in_currency', $2::numeric, 'receipt_no', 'TEST'))`, [resId, amount]);
}

function setStatus(client, resId, status) {
  return client.query('SELECT myriad.set_reservation_status($1, $2)', [resId, status]);
}

test('a new connection can query tables by name with no schema prefix', async () => {
  const { rows: [result] } = await pool.query(`
    SELECT current_schema() AS active_schema,
           (SELECT payment_id FROM payment WHERE payment_id = 1) AS payment_id,
           (SELECT res_id FROM reservation WHERE res_id = 1) AS res_id`);
  assert.deepEqual(result, { active_schema: 'myriad', payment_id: 1, res_id: 1 });
});

test('the SQL installs ten business tables and returns correct demo balances', async () => {
  const tables = await pool.query(`SELECT count(*)::int AS count FROM information_schema.tables
    WHERE table_schema = 'myriad' AND table_type = 'BASE TABLE'`);
  assert.equal(tables.rows[0].count, 10);
  const { rows: [balance] } = await pool.query('SELECT * FROM myriad.reservation_financials WHERE res_id = 1');
  assert.equal(balance.room_count, 2);
  assert.equal(Number(balance.charge_mad), 2620);
  assert.equal(Number(balance.paid_mad), 900);
  assert.equal(Number(balance.balance_due_mad), 1720);
  const { rows: [pending] } = await pool.query('SELECT * FROM myriad.reservation_financials WHERE res_id = 4');
  assert.equal(Number(pending.paid_mad), 0);
});

test('whole-stay availability, half-open dates, non-blocking requests and expected arrivals', async () => {
  const availability = await pool.query(`SELECT room_no
    FROM myriad.rooms_available(myriad.business_today(), myriad.business_today() + 2)`);
  assert.deepEqual(availability.rows.map((room) => room.room_no), ['102', '202', '204']);
  const pendingOnly = await pool.query(`SELECT room_no FROM myriad.rooms_available(
    myriad.business_today() + 4, myriad.business_today() + 5, 2)`);
  assert.equal(pendingOnly.rows.some((room) => room.room_no === '202'), true);
  const arrivals = await pool.query('SELECT res_id FROM myriad.expected_arrivals()');
  assert.deepEqual(arrivals.rows.map((item) => item.res_id), [1, 2]);
});

test('direct SQL enforces guest linkage, stay dates, unique room pairs and mandatory children', async () => {
  await rejectsSql((client) => client.query(`INSERT INTO myriad.reservation (guest_id, check_in_date, check_out_date, channel)
    VALUES (-1, myriad.business_today(), myriad.business_today() + 1, 'Test')`), '23503');
  await rejectsSql((client) => client.query(`UPDATE myriad.reservation SET check_out_date = check_in_date WHERE res_id = 4`),
    '23514', /reservation_stay_dates/);
  await rejectsSql((client) => client.query(`INSERT INTO myriad.room_reservation (res_id, room_id, num_guests)
    VALUES (4, 1, 1)`), '23505');
  await rejectsSql((client) => client.query('DELETE FROM myriad.room_reservation WHERE res_id = 4'),
    '23514', /requires at least one room/);
  await rejectsSql((client) => client.query(`INSERT INTO myriad.room_type (type_name, bed_config, max_occupancy)
    VALUES ('No room', 'Test', 1)`), '23514', /requires at least one physical room/);
  await rejectsSql(async (client) => {
    const { rows: [type] } = await client.query(`INSERT INTO myriad.room_type (type_name, bed_config, max_occupancy)
      VALUES ('No rate', 'Test', 1) RETURNING room_type_id`);
    await client.query("INSERT INTO myriad.room (room_type_id, room_no) VALUES ($1, 'T-NORATE')", [type.room_type_id]);
  }, '23514', /requires at least one rate/);
});

test('rates are effective on the booking date, prices are fixed, and capacity is checked', async () => {
  const result = await pool.query('SELECT agreed_rate_mad FROM myriad.room_reservation WHERE res_id = 6');
  assert.equal(Number(result.rows[0].agreed_rate_mad), 550);
  await rejectsSql((client) => booking(client, 1, 3), '23514', /capacity of 2/);
  await rejectsSql((client) => client.query('UPDATE myriad.room_reservation SET agreed_rate_mad = 25 WHERE res_id = 4'),
    '23514', /prices are fixed/);
  await rejectsSql((client) => client.query(`INSERT INTO myriad.room_rate
    VALUES (1, myriad.business_today() - 2, 750)`), '23514', /effective rate of an existing booking/);
  await rejectsSql((client) => client.query(`SELECT myriad.create_reservation(
    1, myriad.business_today(), myriad.business_today() + 1, 'Test', NULL,
    '[{"room_id":1,"num_guests":1}]', myriad.business_today() - 150)`), '23514', /no rate effective/);
});

test('direct SQL rejects absent, wrong and overlapping payment subtypes', async () => {
  const basePayment = `INSERT INTO myriad.payment (res_id, amount_mad, payment_method)
    VALUES (4, 100, 'CARD') RETURNING payment_id`;
  await rejectsSql((client) => client.query(basePayment), '23514', /exactly one matching method/);
  await rejectsSql(async (client) => {
    const { rows: [payment] } = await client.query(basePayment);
    await client.query("INSERT INTO myriad.transfer_payment VALUES ($1, 'Bank', 'ref')", [payment.payment_id]);
  }, '23514', /exactly one matching method/);
  await rejectsSql(async (client) => {
    const { rows: [payment] } = await client.query(basePayment);
    await client.query("INSERT INTO myriad.card_payment VALUES ($1, 'Visa', '0001', 'abc')", [payment.payment_id]);
    await client.query("INSERT INTO myriad.transfer_payment VALUES ($1, 'Bank', 'ref')", [payment.payment_id]);
  }, '23514', /exactly one matching method/);
  await rejectsSql((client) => client.query(`SELECT myriad.record_payment(4, myriad.business_today(), 100, 'CASH',
    '{"currency_code":"USD","amount_in_currency":100,"receipt_no":"TEST"}')`), '23514', /currency_code/);
  await rejectsSql((client) => client.query(`SELECT myriad.record_payment(4, myriad.business_today(), 100, 'CASH',
    '{"currency_code":"MAD","amount_in_currency":70,"receipt_no":"TEST"}')`), '23514', /amounts must match/);
});

test('confirmation requires 30%, check-in requires settlement, and overlapping stays are rejected', async () => {
  await rejectsSql(async (client) => {
    const id = await booking(client, 7);
    await receive(client, id, '329.99');
    await setStatus(client, id, 'confirmed');
  }, '23514', /requires a deposit/);

  await rejectsSql(async (client) => {
    const id = await booking(client, 7);
    await receive(client, id, '330.00');
    await setStatus(client, id, 'confirmed');
    await setStatus(client, id, 'checked-in');
  }, '23514', /before check-in/);

  await rejectsSql(async (client) => {
    await receive(client, 4, 372);
    await setStatus(client, 4, 'confirmed');
  }, '23P01', /Room 101/);

  await inTransaction(async (client) => {
    const id = await booking(client, 7);
    await receive(client, id, 1100);
    await setStatus(client, id, 'confirmed');
    await setStatus(client, id, 'checked-in');
    await setStatus(client, id, 'checked-out');
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');
  });
});

test('two concurrent confirmations for the same room cannot both commit', async () => {
  // These bookings must be visible to both clients. Use a disposable database.
  const first = await booking(pool, 7, 1, 370);
  const second = await booking(pool, 7, 1, 370);
  await receive(pool, first, 330);
  await receive(pool, second, 330);
  const client = await pool.connect();
  const competitor = await pool.connect();
  try {
    await client.query('BEGIN');
    await setStatus(client, first, 'confirmed');
    const { rows: [{ pid }] } = await competitor.query('SELECT pg_backend_pid() AS pid');
    const blocked = assert.rejects(setStatus(competitor, second, 'confirmed'), { code: '23P01' });
    let didWait = false;
    try {
      for (let attempt = 0; attempt < 20 && !didWait; attempt += 1) {
        const { rows: [activity] } = await pool.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1', [pid]);
        didWait = activity.wait_event_type === 'Lock';
        if (!didWait) await new Promise((resolve) => setTimeout(resolve, 25));
      }
    } finally {
      await client.query('COMMIT');
    }
    await blocked;
    assert.equal(didWait, true);
    const { rows } = await pool.query('SELECT status FROM myriad.reservation WHERE res_id IN ($1, $2) ORDER BY res_id', [first, second]);
    assert.deepEqual(rows.map((row) => row.status), ['confirmed', 'pending']);
    await setStatus(pool, first, 'cancelled');
    await setStatus(pool, second, 'cancelled');
  } finally {
    await client.query('ROLLBACK');
    client.release();
    competitor.release();
  }
});
