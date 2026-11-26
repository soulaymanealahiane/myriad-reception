import http from 'node:http';
import { readFile } from 'node:fs/promises';
import pg from 'pg';

const { Pool, types } = pg;
types.setTypeParser(1082, (date) => date); // Keep SQL DATE values as YYYY-MM-DD.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 5000,
});
pool.on('error', (error) => console.error('Idle database connection:', error.message));

const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
]);
const statuses = ['pending', 'confirmed', 'checked-in', 'checked-out', 'cancelled'];

class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function numberId(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > 2147483647) {
    throw new RequestError(400, `Choose a valid ${label}.`);
  }
  return number;
}

function validDate(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new RequestError(400, `Enter a valid ${label}.`);
  }
  return value;
}

function amount(value) {
  if (!/^\d{1,8}(?:\.\d{1,2})?$/.test(String(value)) || Number(value) <= 0) {
    throw new RequestError(400, 'Enter a positive amount with at most two decimal places.');
  }
  return value;
}

function optionalText(value) {
  return typeof value === 'string' ? value.trim() || null : null;
}

async function readJson(request) {
  if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] ?? '')) {
    throw new RequestError(415, 'Send the form as JSON.');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 65536) throw new RequestError(413, 'The form is too large.');
    chunks.push(chunk);
  }
  let value;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    throw new RequestError(400, 'The form contains invalid JSON.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RequestError(400, 'Send a JSON object.');
  }
  return value;
}

async function rows(sql, values = []) {
  return (await pool.query(sql, values)).rows;
}

const reservationSelect = `
  SELECT s.res_id, s.booking_date, s.check_in_date, s.check_out_date, s.status, s.channel,
         g.guest_id, concat_ws(' ', g.first_name, g.last_name) AS guest_name,
         f.room_count, f.nights, f.charge_mad, f.paid_mad, f.deposit_required_mad,
         f.balance_due_mad, f.credit_mad,
         (SELECT string_agg(r.room_no, ', ' ORDER BY r.room_no)
          FROM myriad.room_reservation a JOIN myriad.room r USING (room_id)
          WHERE a.res_id = s.res_id) AS room_numbers
  FROM myriad.reservation s
  JOIN myriad.guest g USING (guest_id)
  JOIN myriad.reservation_financials f USING (res_id)
`;

async function reservationDetail(id) {
  const [booking] = await rows(`
    SELECT b.*, s.special_requests, g.email, g.phone,
      (SELECT jsonb_agg(to_jsonb(room_line) ORDER BY room_line.room_no)
       FROM (
         SELECT r.room_no, r.room_name, rt.type_name, a.num_guests, a.agreed_rate_mad
         FROM myriad.room_reservation a
         JOIN myriad.room r USING (room_id)
         JOIN myriad.room_type rt USING (room_type_id)
         WHERE a.res_id = b.res_id
       ) room_line) AS rooms,
      (SELECT jsonb_agg(to_jsonb(receipt) ORDER BY receipt.payment_date DESC, receipt.payment_id DESC)
       FROM (
         SELECT p.payment_id, p.payment_date, p.amount_mad, p.payment_method,
                c.card_brand, c.card_last4, c.auth_code,
                k.currency_code, k.amount_in_currency, k.receipt_no, t.bank_name, t.transfer_ref
         FROM myriad.payment p
         LEFT JOIN myriad.card_payment c USING (payment_id)
         LEFT JOIN myriad.cash_payment k USING (payment_id)
         LEFT JOIN myriad.transfer_payment t USING (payment_id)
         WHERE p.res_id = b.res_id
       ) receipt) AS payments
    FROM (${reservationSelect} WHERE s.res_id = $1) b
    JOIN myriad.reservation s USING (res_id)
    JOIN myriad.guest g ON g.guest_id = b.guest_id`, [id]);
  if (!booking) throw new RequestError(404, 'Reservation not found.');
  return booking;
}

async function getApi(path, query) {
  if (path === '/api/overview') {
    const [overview] = await rows(`
      SELECT myriad.business_today() AS today,
        (SELECT COUNT(*)::integer FROM myriad.expected_arrivals()) AS arrivals,
        (SELECT COUNT(*)::integer FROM myriad.reservation WHERE status = 'checked-in') AS in_house,
        (SELECT COUNT(*)::integer FROM myriad.reservation WHERE status = 'pending') AS pending,
        (SELECT COUNT(*)::integer FROM myriad.rooms_available(myriad.business_today(), myriad.business_today() + 1)) AS available,
        (SELECT COUNT(*)::integer FROM myriad.room) AS total_rooms`);
    return overview;
  }
  if (path === '/api/catalog') {
    const [catalog] = await rows(`
      SELECT myriad.business_today() AS today,
        (SELECT jsonb_agg(to_jsonb(t) ORDER BY t.type_name)
         FROM (SELECT rt.*, myriad.rate_for_date(room_type_id, myriad.business_today()) AS current_rate
               FROM myriad.room_type rt) t) AS room_types,
        (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.room_no) FROM myriad.room r) AS rooms,
        (SELECT jsonb_agg(to_jsonb(rate) ORDER BY rate.room_type_id, rate.rate_start_date DESC)
         FROM myriad.room_rate rate) AS rates`);
    return catalog;
  }
  if (path === '/api/guests') {
    return rows('SELECT guest_id, first_name, last_name FROM myriad.guest ORDER BY last_name, first_name, guest_id');
  }
  if (path === '/api/availability') {
    const type = query.get('type');
    return rows('SELECT * FROM myriad.rooms_available($1::date, $2::date, $3::integer)', [
      validDate(query.get('check_in'), 'check-in date'),
      validDate(query.get('check_out'), 'check-out date'),
      type ? numberId(type, 'room type') : null,
    ]);
  }
  if (path === '/api/arrivals') {
    const date = query.get('date');
    return date
      ? rows('SELECT * FROM myriad.expected_arrivals($1::date)', [validDate(date, 'arrival date')])
      : rows('SELECT * FROM myriad.expected_arrivals()');
  }
  if (path === '/api/reservations') {
    const status = query.get('status') || null;
    if (status && !statuses.includes(status)) throw new RequestError(400, 'Choose a valid status.');
    const search = optionalText(query.get('q'));
    return rows(`${reservationSelect}
      WHERE ($1::varchar IS NULL OR s.status = $1)
        AND ($2::text IS NULL OR strpos(lower(concat_ws(' ', g.first_name, g.last_name)), lower($2)) > 0
             OR s.res_id::text = ltrim($2, '#'))
      ORDER BY CASE s.status WHEN 'confirmed' THEN 0 WHEN 'checked-in' THEN 1 WHEN 'pending' THEN 2 ELSE 3 END,
               CASE WHEN s.status IN ('checked-out', 'cancelled') THEN -1 ELSE 1 END *
                    (s.check_in_date - myriad.business_today()), s.res_id`, [status, search]);
  }

  const match = path.match(/^\/api\/reservations\/(\d+)$/);
  if (match) return reservationDetail(numberId(match[1], 'reservation'));
  throw new RequestError(404, 'This page was not found.');
}

async function postApi(path, body) {
  if (path === '/api/guests') {
    const [guest] = await rows(`
      INSERT INTO myriad.guest (first_name, last_name, email, phone, nationality, id_doc_number)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING guest_id`, [
      optionalText(body.first_name), optionalText(body.last_name), optionalText(body.email),
      optionalText(body.phone), optionalText(body.nationality), optionalText(body.id_doc_number),
    ]);
    return guest;
  }
  if (path === '/api/reservations') {
    if (!Array.isArray(body.rooms) || body.rooms.length === 0 ||
        body.rooms.some((room) => !room || typeof room !== 'object')) {
      throw new RequestError(400, 'Add at least one valid room.');
    }
    const rooms = body.rooms.map((room) => ({
      room_id: numberId(room.room_id, 'room'),
      num_guests: numberId(room.num_guests, 'guest count'),
    }));
    const [booking] = await rows(`
      SELECT myriad.create_reservation($1, $2, $3, $4, $5, $6::jsonb) AS res_id`, [
      numberId(body.guest_id, 'lead guest'), validDate(body.check_in_date, 'check-in date'),
      validDate(body.check_out_date, 'check-out date'), optionalText(body.channel),
      optionalText(body.special_requests), JSON.stringify(rooms),
    ]);
    return booking;
  }

  const action = path.match(/^\/api\/reservations\/(\d+)\/(status|payments)$/);
  if (action) {
    const id = numberId(action[1], 'reservation');
    if (action[2] === 'status') {
      if (!statuses.includes(body.status)) throw new RequestError(400, 'Choose a valid status.');
      const [booking] = await rows('SELECT myriad.set_reservation_status($1, $2) AS status', [id, body.status]);
      return booking;
    }
    const [payment] = await rows('SELECT myriad.record_payment($1, $2, $3, $4, $5::jsonb) AS payment_id', [
      id, validDate(body.payment_date, 'payment date'), amount(body.amount_mad),
      optionalText(body.payment_method), JSON.stringify(body.details ?? {}),
    ]);
    return payment;
  }
  if (path === '/api/room-types') {
    const [type] = await rows(`
      SELECT myriad.add_room_type($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) AS room_type_id`, [
      optionalText(body.type_name), optionalText(body.bed_config),
      numberId(body.max_occupancy, 'capacity'), body.has_balcony === true, optionalText(body.description),
      optionalText(body.room_no), optionalText(body.room_name), optionalText(body.floor_level),
      validDate(body.rate_start_date, 'rate start date'), amount(body.nightly_rate_mad),
    ]);
    return type;
  }
  if (path === '/api/rooms') {
    const [room] = await rows(`
      INSERT INTO myriad.room (room_type_id, room_no, room_name, floor_level)
      VALUES ($1,$2,$3,$4) RETURNING room_id`, [
      numberId(body.room_type_id, 'room type'), optionalText(body.room_no),
      optionalText(body.room_name), optionalText(body.floor_level),
    ]);
    return room;
  }
  if (path === '/api/rates') {
    const [rate] = await rows(`
      INSERT INTO myriad.room_rate (room_type_id, rate_start_date, nightly_rate_mad)
      VALUES ($1,$2,$3) RETURNING room_type_id, rate_start_date`, [
      numberId(body.room_type_id, 'room type'), validDate(body.rate_start_date, 'rate start date'),
      amount(body.nightly_rate_mad),
    ]);
    return rate;
  }
  throw new RequestError(404, 'This action was not found.');
}

function send(response, status, body, contentType = 'application/json; charset=utf-8') {
  response.writeHead(status, {
    'Content-Type': contentType, 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
  });
  response.end(contentType.startsWith('application/json') ? JSON.stringify(body) : body);
}

function errorResponse(error) {
  if (error instanceof RequestError) return [error.status, error.message];
  if (error.code === 'P0002') return [404, error.message];
  if (error.code === '23P01') return [409, error.message];
  if (error.code === '23505') return [409, 'That room, date, or other unique value is already recorded.'];
  if (error.code === '23503') return [409, 'A related record is missing or is still in use.'];
  if (error.code === '23502') return [400, `Enter a value for ${error.column.replaceAll('_', ' ')}.`];
  if (error.code === '23514') {
    return [422, error.constraint ? `Check the form values (${error.constraint.replaceAll('_', ' ')}).` : error.message];
  }
  if (error.code === '40001' || error.code === '40P01') return [409, 'A concurrent update was made. Try again.'];
  if (error.code?.startsWith('22')) return [400, 'Check the dates, number formats, and field lengths.'];
  console.error(error);
  return [500, 'The request could not be completed. Check the server and PostgreSQL connection.'];
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://localhost');
    const asset = assets.get(url.pathname);
    if (request.method === 'GET' && asset) {
      const [filename, contentType] = asset;
      return send(response, 200, await readFile(new URL(`public/${filename}`, import.meta.url)), contentType);
    }
    if (!url.pathname.startsWith('/api/')) throw new RequestError(404, 'This page was not found.');
    if (request.method === 'GET') return send(response, 200, await getApi(url.pathname, url.searchParams));
    if (request.method === 'POST') return send(response, 201, await postApi(url.pathname, await readJson(request)));
    throw new RequestError(405, 'This method is unavailable.');
  } catch (error) {
    const [status, message] = errorResponse(error);
    send(response, status, { error: message });
  }
});

try {
  await pool.query('SELECT 1 FROM myriad.reservation LIMIT 1');
  const host = process.env.HOST ?? '127.0.0.1';
  const port = Number(process.env.PORT ?? 3000);
  server.on('error', (error) => {
    console.error(`Could not start MyRiad: ${error.message}`);
    void pool.end();
    process.exitCode = 1;
  });
  server.listen(port, host, () => console.log(`MyRiad reception: http://${host === '0.0.0.0' ? 'localhost' : host}:${server.address().port}`));
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => server.close(() => void pool.end()));
  }
} catch (error) {
  console.error(`Cannot connect to MyRiad. Check the connection settings and install myriad.sql.\n${error.message}`);
  await pool.end();
  process.exitCode = 1;
}
